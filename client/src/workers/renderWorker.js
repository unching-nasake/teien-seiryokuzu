/**
 * マップ描画用 Web Worker (OffscreenCanvas)
 * ベースキャンバスの描画をオフスレッドで実行
 * [NEW] True Double Buffering: フロント/バックの2つのキャンバスを持つ
 */

// 定数
const MAP_SIZE = 500;
const TILE_SIZE = 16;
const CHUNK_SIZE = 8;

// OffscreenCanvas参照 (単一キャンバスモード用 - 互換性維持)
let canvas = null;
let ctx = null;

// [NEW] Dual Canvas Mode (True Double Buffering)
let frontCanvas = null;
let frontCtx = null;
let backCanvas = null;
let backCtx = null;
let isDualMode = false;

// [Stateful Worker] データキャッシュ
let cachedTiles = {}; // 互換性のため維持 (部分更新用)
// [NEW] フラット配列: インデックス = y * MAP_SIZE + x
// 要素: Tile Object (参照)
const tilesFlatArray = new Array(MAP_SIZE * MAP_SIZE).fill(null);

let cachedFactions = {};
let cachedAlliances = {};
let cachedPlayerColors = {};
let cachedTheme = {
  blankTileColor: "#ffffff",
  highlightCoreOnly: false,
  mapColorMode: "faction",
};
// 最後に描画したViewport (不要な再描画防止用)
let lastViewport = null;

// [NEW] Parallel Processing Settings
let workerIndex = 0;
let totalWorkers = 1;

// [NEW] Unified Rendering Mode (Returns ImageBitmap)
let internalCanvas = null;
let internalCtx = null;

/**
 * 初期化: OffscreenCanvasを受け取る (単一キャンバスモード)
 */
function init(offscreenCanvas) {
  canvas = offscreenCanvas;
  ctx = canvas.getContext("2d");
  isDualMode = false;
  console.log(
    `[RenderWorker ${workerIndex}/${totalWorkers}] Initialized (single mode):`,
    canvas.width,
    "x",
    canvas.height,
  );
}

/**
 * [NEW] 初期化: 内部描画用バッファのみをセットアップ (DOM不要)
 */
function initInternal(width, height) {
  if (
    !internalCanvas ||
    internalCanvas.width !== width ||
    internalCanvas.height !== height
  ) {
    internalCanvas = new OffscreenCanvas(width, height);
    internalCtx = internalCanvas.getContext("2d");
    internalCtx.imageSmoothingEnabled = false;
  }
}

/**
 * [NEW] キャンバスサイズを更新 (内部バッファ用)
 */
function resizeInternal(width, height) {
  if (internalCanvas) {
    internalCanvas.width = width;
    internalCanvas.height = height;
    if (internalCtx) internalCtx.imageSmoothingEnabled = false;
  }
}

/**
 * チャンク単位で描画 (LODモード)
 */
function renderChunks(data) {
  const { viewport, chunkColors, blankTileColor, width, height } = data;

  if (!ctx || !canvas) return;

  const tileSize = TILE_SIZE * viewport.zoom;
  const centerX = width / 2;
  const centerY = height / 2;

  // クリア (担当領域のみクリアすべきだが、透明Canvasなので全クリアでOK)
  ctx.clearRect(0, 0, width, height);
  // 背景色はWorker 0のみが描画、または全Workerが描画しない（MainThreadのContainerで背景色を持つ）
  // 以前のロジック: ctx.fillStyle = blankTileColor || "#ffffff"; ctx.fillRect(0, 0, width, height);
  // マルチレイヤーの場合、最下層以外は透明である必要がある。
  // 今回は一旦、全Workerでクリアし、背景色は描画しない（GameMap側で背景divを持つ想定）
  // または、workerIndex === 0 のみ背景を描画する。
  if (workerIndex === 0) {
    ctx.fillStyle = blankTileColor || "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }

  // 表示範囲計算
  const tilesX = Math.ceil(width / tileSize) + 2;
  const tilesY = Math.ceil(height / tileSize) + 2;
  const startX = Math.floor(viewport.x - tilesX / 2);
  const startY = Math.floor(viewport.y - tilesY / 2);
  const endX = Math.ceil(viewport.x + tilesX / 2);
  const endY = Math.ceil(viewport.y + tilesY / 2);

  const chunkPixelSize = CHUNK_SIZE * tileSize;
  const startChunkX = Math.floor(Math.max(0, startX) / CHUNK_SIZE);
  const startChunkY = Math.floor(Math.max(0, startY) / CHUNK_SIZE);
  const endChunkX = Math.ceil(Math.min(MAP_SIZE, endX + 1) / CHUNK_SIZE);
  const endChunkY = Math.ceil(Math.min(MAP_SIZE, endY + 1) / CHUNK_SIZE);

  // 色ごとにバッチング
  const batchDraws = new Map();

  for (let cx = startChunkX; cx < endChunkX; cx++) {
    for (let cy = startChunkY; cy < endChunkY; cy++) {
      // [PARALLEL] Interleaved based on chunk Y (or X+Y)
      // Chunks are large, so row interleaving on chunks is fine.
      if (cy % totalWorkers !== workerIndex) continue;

      const color = chunkColors[`${cx}_${cy}`] || blankTileColor;
      const screenX = centerX + (cx * CHUNK_SIZE - viewport.x) * tileSize;
      const screenY = centerY + (cy * CHUNK_SIZE - viewport.y) * tileSize;

      if (!batchDraws.has(color)) batchDraws.set(color, []);
      batchDraws
        .get(color)
        .push({ x: screenX, y: screenY, w: chunkPixelSize, h: chunkPixelSize });
    }
  }

  // まとめて描画
  batchDraws.forEach((rects, color) => {
    ctx.beginPath();
    for (const r of rects) {
      ctx.rect(r.x, r.y, r.w, r.h);
    }
    ctx.fillStyle = color;
    ctx.fill();
  });
}

/**
 * タイル単位で描画 (通常モード)
 */
function renderTiles(data) {
  // [Stateful] データが渡されなければキャッシュを使用
  // RENDER_TILES メッセージでは viewport は必須
  const viewport = data.viewport || lastViewport;
  if (!viewport) return; // 表示範囲がなければ描画できない
  lastViewport = viewport;

  const width = data.width || canvas.width;
  const height = data.height || canvas.height;

  // データ更新（もし渡されていればキャッシュも更新）
  if (data.tiles) {
    // updateTiles logic is handled in UPDATE_TILES message usually,
    // but if passed here, we need to sync flat array too.
    // For simplicity/performance, assume main update comes via UPDATE_TILES.
    // If data.tiles provided here, we process it.
    const tiles = data.tiles;
    Object.assign(cachedTiles, tiles);
    // Sync flat array
    Object.values(tiles).forEach((t) => {
      if (t.x >= 0 && t.x < MAP_SIZE && t.y >= 0 && t.y < MAP_SIZE) {
        tilesFlatArray[t.y * MAP_SIZE + t.x] = t;
      }
    });
  }
  if (data.factions) cachedFactions = data.factions;
  if (data.alliances) cachedAlliances = data.alliances;
  if (data.playerColors) cachedPlayerColors = data.playerColors;

  // テーマ設定更新
  if (data.blankTileColor) cachedTheme.blankTileColor = data.blankTileColor;
  if (data.highlightCoreOnly !== undefined)
    cachedTheme.highlightCoreOnly = data.highlightCoreOnly;
  if (data.mapColorMode) cachedTheme.mapColorMode = data.mapColorMode;

  // 描画に使用するデータ (Use Flat Array for iteration)
  // const tiles = cachedTiles; // Unused for iteration now
  const factions = cachedFactions;
  const alliances = cachedAlliances;
  const playerColors = cachedPlayerColors;
  const { blankTileColor, highlightCoreOnly, mapColorMode } = cachedTheme;

  if (!ctx || !canvas) return;

  const tileSize = TILE_SIZE * viewport.zoom;
  const centerX = width / 2;
  const centerY = height / 2;
  const showGrid = viewport.zoom > 2.0; // [REVERTED] User requested grid from 2.0

  // キャンバス全体をクリア (背景塗りつぶしはメインスレッドに移譲して縞々を防ぐ)
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height);

  // 表示範囲計算
  const tilesX = Math.ceil(width / tileSize) + 2;
  const tilesY = Math.ceil(height / tileSize) + 2;
  const startX = Math.floor(viewport.x - tilesX / 2);
  const startY = Math.floor(viewport.y - tilesY / 2);
  const endX = Math.ceil(viewport.x + tilesX / 2);
  const endY = Math.ceil(viewport.y + tilesY / 2);

  // 色ごとにバッチング (フラット配列: [x, y, w, h, ...])
  // Map<color, number[]>
  const batchDraws = new Map();
  const factionBorderRects = [];

  // 最適化: ズームが小さい場合は境界線計算をスキップ
  const skipBorders = mapColorMode === "overpaint" && viewport.zoom < 0.5;

  for (let x = Math.max(0, startX); x <= Math.min(MAP_SIZE - 1, endX); x++) {
    for (let y = Math.max(0, startY); y <= Math.min(MAP_SIZE - 1, endY); y++) {
      // [PARALLEL] Interleaved based on Y
      if (y % totalWorkers !== workerIndex) continue;

      // [OPTIMIZED] Use Flat Array Access
      const tile = tilesFlatArray[y * MAP_SIZE + x];

      // 最適化: タイルがない場合は背景色(blankTileColor)と同じならスキップ
      // デフォルト背景は #1a1a2e
      if (!tile) {
        // 背景色と同じなら描画しない（クリア済みだから）
        if ((blankTileColor || "#ffffff") === "#1a1a2e") continue;
      }

      // [OPTIMIZED] Snap to pixels to avoid anti-aliasing gaps
      const rawX = centerX + (x - viewport.x) * tileSize;
      const rawY = centerY + (y - viewport.y) * tileSize;

      // Use logical coordinates for calculations but snap for rendering
      const screenX = Math.floor(rawX);
      const screenY = Math.floor(rawY);

      // [FIX] 縦横個別にサイズを計算して隙間を完全に埋める
      let drawW, drawH;
      if (showGrid) {
        drawW = drawH = Math.max(1, tileSize - 1);
      } else {
        // 次のタイルの開始ピクセルを計算し、その差分をサイズとする(+1pxの保険)
        const nextScreenX = Math.floor(
          centerX + (x + 1 - viewport.x) * tileSize,
        );
        const nextScreenY = Math.floor(
          centerY + (y + 1 - viewport.y) * tileSize,
        );
        drawW = nextScreenX - screenX + 1;
        drawH = nextScreenY - screenY + 1;
      }
      let color = blankTileColor || "#ffffff";

      if (tile) {
        const fid = tile.factionId || tile.faction;
        const f = factions ? factions[fid] : null;
        const factionColor = f?.color || "#aaaaaa";
        color = tile.customColor || factionColor;

        if (mapColorMode === "player") {
          if (tile.paintedBy && playerColors) {
            color = playerColors[tile.paintedBy] || "#cccccc";
          } else {
            color = "#cccccc";
          }
        } else if (mapColorMode === "overpaint") {
          const count = Math.min(4, Math.max(0, tile.overpaint || 0));
          const ratio = count / 4;
          const hue = 240 + ratio * 60;
          const saturation = 60 + ratio * 40;
          const lightness = 45 + ratio * 30;
          color = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
        } else if (mapColorMode === "alliance") {
          if (f && f.allianceId && alliances && alliances[f.allianceId]) {
            color = alliances[f.allianceId].color;
          } else {
            color = "#111111";
          }
        } else {
          color = tile.customColor || tile.color || "#ffffff";
        }

        // 塗装数モード時の外縁境界線 (低ズーム時はスキップ)
        // [OPTIMIZED] Flat array neighbor check needed?
        // Since we are iterating x,y, we can easily check neighbors in flat array
        // NOTE: For borders to work seamlessly across worker boundaries,
        // each worker needs access to neighbor data (which they do via full `tilesFlatArray`).
        // Accessing nY which might be handled by another worker is fine for READ.
        // We only DRAW the border if it belongs to THIS tile (which we own).
        if (!skipBorders && f && mapColorMode === "overpaint") {
          const checkBorder = (dx, dy, type) => {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) return;

            const nt = tilesFlatArray[ny * MAP_SIZE + nx];
            const nfid = nt ? nt.factionId || nt.faction : null;
            if (nfid !== fid) {
              factionBorderRects.push(
                screenX,
                screenY,
                drawSize,
                drawSize,
                type === "top"
                  ? 0
                  : type === "bottom"
                    ? 1
                    : type === "left"
                      ? 2
                      : 3,
              );
            }
          };
          checkBorder(0, -1, "top");
          checkBorder(0, 1, "bottom");
          checkBorder(-1, 0, "left");
          checkBorder(1, 0, "right");
        }

        // 中核マス強調モード
        if (highlightCoreOnly) {
          const currentFid = tile.factionId || tile.faction;
          const isCore = tile.core && tile.core.factionId === currentFid;
          if (!isCore) {
            color = "#222233";
          }
        }
      }

      if (!batchDraws.has(color)) {
        batchDraws.set(color, []);
      }
      // フラット配列に追加
      const arr = batchDraws.get(color);
      arr.push(screenX, screenY, drawW, drawH);
    }
  }

  // まとめて描画 (Flat Array)
  batchDraws.forEach((rects, color) => {
    ctx.beginPath();
    // i += 4 でループ
    for (let i = 0; i < rects.length; i += 4) {
      ctx.rect(rects[i], rects[i + 1], rects[i + 2], rects[i + 3]);
    }
    ctx.fillStyle = color;
    ctx.fill();
  });

  // 塗装数モード時の勢力境界線
  if (factionBorderRects.length > 0) {
    ctx.strokeStyle = "rgba(0, 0, 0, 0.4)"; // [OPTIMIZED] Lighter borders

    ctx.lineWidth = 1;
    ctx.beginPath();
    // Flat Array: [x, y, w, h, type] type: 0=top, 1=bottom, 2=left, 3=right
    for (let i = 0; i < factionBorderRects.length; i += 5) {
      const x = factionBorderRects[i];
      const y = factionBorderRects[i + 1];
      const w = factionBorderRects[i + 2];
      const h = factionBorderRects[i + 3];
      const type = factionBorderRects[i + 4];

      if (type === 0) {
        // top
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y);
      } else if (type === 1) {
        // bottom
        ctx.moveTo(x, y + h);
        ctx.lineTo(x + w, y + h);
      } else if (type === 2) {
        // left
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + h);
      } else if (type === 3) {
        // right
        ctx.moveTo(x + w, y);
        ctx.lineTo(x + w, y + h);
      }
    }
    ctx.stroke();
  }
}

/**
 * [NEW] デュアルモード用描画関数 - 指定されたバッファに描画
 */
function renderTilesDual(data) {
  const { targetBuffer, renderId } = data;

  // 描画先のキャンバス/コンテキストを選択
  let targetCanvas, targetCtx;
  if (targetBuffer === "back") {
    targetCanvas = backCanvas;
    targetCtx = backCtx;
  } else {
    targetCanvas = frontCanvas;
    targetCtx = frontCtx;
  }

  if (!targetCanvas || !targetCtx) {
    console.warn("[RenderWorker] Target canvas not available for dual mode");
    return renderId;
  }

  // 一時的にctxを差し替えて既存のrenderTiles関数を再利用
  const origCtx = ctx;
  const origCanvas = canvas;
  ctx = targetCtx;
  canvas = targetCanvas;

  renderTiles(data);

  // 元に戻す
  ctx = origCtx;
  canvas = origCanvas;

  return renderId;
}

// メッセージハンドラ
self.onmessage = function (e) {
  const { type, data } = e.data;

  try {
    if (type === "SETUP_WORKER") {
      workerIndex = data.workerIndex;
      totalWorkers = data.totalWorkers;
      // console.log(`[RenderWorker] Setup: Index=${workerIndex}, Total=${totalWorkers}`);
    } else if (type === "INIT") {
      init(data.canvas);
      self.postMessage({ type: "INIT_COMPLETE", success: true });
    } else if (type === "INIT_DUAL") {
      // [NEW] デュアルキャンバス初期化
      initDual(data.frontCanvas, data.backCanvas);
      self.postMessage({ type: "INIT_COMPLETE", success: true });
    } else if (type === "RESIZE") {
      resize(data.width, data.height);
      self.postMessage({ type: "RESIZE_COMPLETE", success: true });
    } else if (type === "RESIZE_DUAL") {
      // [NEW] デュアルモードリサイズ
      resizeDual(data.width, data.height);
      self.postMessage({ type: "RESIZE_COMPLETE", success: true });
    } else if (type === "UPDATE_TILES") {
      // [Stateful] タイルデータ更新
      const { tiles, replace } = data;
      if (replace) {
        cachedTiles = tiles || {};
        // Full Reset Flat Array
        tilesFlatArray.fill(null);
        if (tiles) {
          Object.values(tiles).forEach((t) => {
            if (t.x >= 0 && t.x < MAP_SIZE && t.y >= 0 && t.y < MAP_SIZE) {
              tilesFlatArray[t.y * MAP_SIZE + t.x] = t;
            }
          });
        }
      } else if (tiles) {
        Object.assign(cachedTiles, tiles);
        // Partial Update Flat Array
        Object.values(tiles).forEach((t) => {
          if (t.x >= 0 && t.x < MAP_SIZE && t.y >= 0 && t.y < MAP_SIZE) {
            tilesFlatArray[t.y * MAP_SIZE + t.x] = t;
          }
        });
      }
    } else if (type === "UPDATE_DATA") {
      // [Stateful] その他データ更新
      const d = data;
      if (d.factions) cachedFactions = d.factions;
      if (d.alliances) cachedAlliances = d.alliances;
      if (d.playerColors) cachedPlayerColors = d.playerColors;
      if (d.theme) Object.assign(cachedTheme, d.theme);
    } else if (type === "RENDER_CHUNKS") {
      renderChunks(data);
      self.postMessage({ type: "RENDER_COMPLETE", success: true });
    } else if (type === "RENDER_TILES") {
      renderTiles(data); // 内部でキャッシュ使用＆描画
      self.postMessage({ type: "RENDER_COMPLETE", success: true });
    } else if (type === "RENDER_IMAGE_BITMAP") {
      // [NEW] 統合描画モード: ImageBitmapを返却
      const { width, height, viewport, renderId } = data;

      // 内部バッファの準備
      initInternal(width, height);

      // 一時的に描画先を内部バッファに切替
      const origCtx = ctx;
      const origCanvas = canvas;
      ctx = internalCtx;
      canvas = internalCanvas;

      // 描画実行
      renderTiles(data);

      // ImageBitmapの取得と返却
      const bitmap = internalCanvas.transferToImageBitmap();

      // 元に戻す
      ctx = origCtx;
      canvas = origCanvas;

      // メインスレッドへ転送 (transferable)
      self.postMessage(
        {
          type: "RENDER_BITMAP_COMPLETE",
          renderId,
          bitmap,
          workerIndex,
        },
        [bitmap],
      );
    } else if (type === "RENDER_TILES_DUAL") {
      // [NEW] デュアルモード描画
      const renderId = renderTilesDual(data);
      self.postMessage({ type: "RENDER_COMPLETE", success: true, renderId });
    } else if (type === "RENDER_CHUNKS_DUAL") {
      // [NEW] デュアルモードチャンク描画 (将来用)
      // 現時点ではRENDER_TILES_DUALと同様に処理
      const renderId = renderTilesDual(data);
      self.postMessage({ type: "RENDER_COMPLETE", success: true, renderId });
    } else {
      console.warn("[RenderWorker] Unknown message type:", type);
    }
  } catch (error) {
    console.error("[RenderWorker] Error:", error);
    self.postMessage({ type: "ERROR", error: error.message });
  }
};
