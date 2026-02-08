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

  // 描画に使用するデータ (Use Flat Array or SAB for iteration)
  const factions = cachedFactions;
  const alliances = cachedAlliances;
  const playerColors = cachedPlayerColors;
  const { blankTileColor, highlightCoreOnly, mapColorMode } = cachedTheme;

  // [NEW] SharedArrayBuffer Support
  const sab = cachedTheme.sab;
  const sabView = sab ? new DataView(sab) : null;
  const TILE_BYTE_SIZE = 24;

  if (!ctx || !canvas) return;

  const tileSize = TILE_SIZE * viewport.zoom;
  const centerX = width / 2;
  const centerY = height / 2;
  const showGrid = viewport.zoom > 2.0;

  // キャンバス全体をクリア
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height);

  // 表示範囲計算
  const tilesX = Math.ceil(width / tileSize) + 2;
  const tilesY = Math.ceil(height / tileSize) + 2;
  const startX = Math.floor(viewport.x - tilesX / 2);
  const startY = Math.floor(viewport.y - tilesY / 2);
  const endX = Math.ceil(viewport.x + tilesX / 2);
  const endY = Math.ceil(viewport.y + tilesY / 2);

  // 色ごとにバッチング
  const batchDraws = new Map();
  const factionBorderRects = [];
  const skipBorders = mapColorMode === "overpaint" && viewport.zoom < 0.5;

  for (let x = Math.max(0, startX); x <= Math.min(MAP_SIZE - 1, endX); x++) {
    for (let y = Math.max(0, startY); y <= Math.min(MAP_SIZE - 1, endY); y++) {
      if (y % totalWorkers !== workerIndex) continue;

      let tile = null;
      let fidIdx = 65535;
      let colorInt = 0xffffff;
      let flags = 0;
      let exp = 0;
      let paintedByIdx = 0;

      if (sabView) {
        // [NEW] SharedArrayBufferから直接読み取り (ゼロコピー)
        const offset = (y * MAP_SIZE + x) * TILE_BYTE_SIZE;
        fidIdx = sabView.getUint16(offset + 0, true);
        colorInt = sabView.getUint32(offset + 2, true);
        paintedByIdx = sabView.getUint32(offset + 6, true);
        // overpaint = sabView.getUint8(offset + 10);
        flags = sabView.getUint8(offset + 11);
        exp = sabView.getFloat64(offset + 12, true); // [FIX] Offset 12

        // tileオブジェクトの最小限のシミュレーション（互換性のため）
        if (fidIdx !== 65535) {
          tile = {
            factionId: cachedTheme.factionsList
              ? cachedTheme.factionsList[fidIdx]
              : null,
          };
          if (flags & 1) tile.core = { factionId: tile.factionId };
        }
      } else {
        // フォールバック: 従来Objectベース
        tile = tilesFlatArray[y * MAP_SIZE + x];
      }

      if (!tile && (blankTileColor || "#ffffff") === "#1a1a2e" && !sabView)
        continue;

      const rawX = centerX + (x - viewport.x) * tileSize;
      const rawY = centerY + (y - viewport.y) * tileSize;
      const screenX = Math.floor(rawX);
      const screenY = Math.floor(rawY);

      let drawW, drawH;
      if (showGrid) {
        drawW = drawH = Math.max(1, tileSize - 1);
      } else {
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

      if (sabView) {
        // SABモードの色計算
        const fid = tile ? tile.factionId : null;
        if (mapColorMode === "player" && cachedTheme.playersList) {
          const playerId = cachedTheme.playersList[paintedByIdx - 1];
          color =
            playerId && playerColors
              ? playerColors[playerId] || "#cccccc"
              : "#cccccc";
        } else if (mapColorMode === "overpaint") {
          // overpaintはSABから取得
          const overpaint = sabView.getUint8(
            (y * MAP_SIZE + x) * TILE_BYTE_SIZE + 10,
          );
          const count = Math.min(4, overpaint);
          const ratio = count / 4;
          color = `hsl(${240 + ratio * 60}, ${60 + ratio * 40}%, ${45 + ratio * 30}%)`;
        } else if (mapColorMode === "alliance") {
          const f = fid ? factions[fid] : null;
          if (f && f.allianceId && alliances && alliances[f.allianceId]) {
            color = alliances[f.allianceId].color;
          } else {
            color = blankTileColor || "#ffffff";
          }
        } else {
          // Faction/Custom Color (Use packed color from SAB)
          color = fid
            ? `#${colorInt.toString(16).padStart(6, "0")}`
            : blankTileColor || "#ffffff";
        }

        if (highlightCoreOnly && tile) {
          if (!(flags & 1)) color = "#222233";
        }
      } else if (tile) {
        // 従来モードの色計算
        const fid = tile.factionId || tile.faction;
        const f = factions ? factions[fid] : null;
        const factionColor = f?.color || "#aaaaaa";
        color = tile.customColor || factionColor;

        if (mapColorMode === "player") {
          color =
            tile.paintedBy && playerColors
              ? playerColors[tile.paintedBy] || "#cccccc"
              : "#cccccc";
        } else if (mapColorMode === "overpaint") {
          const count = Math.min(4, Math.max(0, tile.overpaint || 0));
          const ratio = count / 4;
          color = `hsl(${240 + ratio * 60}, ${60 + ratio * 40}%, ${45 + ratio * 30}%)`;
        } else if (mapColorMode === "alliance") {
          if (f && f.allianceId && alliances && alliances[f.allianceId]) {
            color = alliances[f.allianceId].color;
          } else {
            color = "#111111";
          }
        } else {
          color = tile.customColor || tile.color || "#ffffff";
        }

        if (highlightCoreOnly) {
          const currentFid = tile.factionId || tile.faction;
          const isCore = tile.core && tile.core.factionId === currentFid;
          if (!isCore) color = "#222233";
        }
      }

      if (!batchDraws.has(color)) batchDraws.set(color, []);
      batchDraws.get(color).push(screenX, screenY, drawW, drawH);
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
    } else if (type === "INIT") {
      // Handle both nested data (legacy) and flat (new)
      const setup = data || e.data;
      init(setup.canvas);

      if (setup.sab) sabView = new DataView(setup.sab);
      if (setup.zocSab) zocSabView = new Uint16Array(setup.zocSab);

      if (setup.isDualMode) {
        // initDualMode logic if needed
      }

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

      // [NEW] SharedArrayBuffer や リストの更新を確実に反映
      if (data.sab) cachedTheme.sab = data.sab;
      if (data.factionsList) cachedTheme.factionsList = data.factionsList;
      if (data.playersList) cachedTheme.playersList = data.playersList;
      if (data.mapVersion !== undefined)
        cachedTheme.mapVersion = data.mapVersion;
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

function renderZocFromSAB(
  ctx,
  viewport,
  tileSize,
  width,
  height,
  factions,
  factionsList,
) {
  const startX = Math.floor(viewport.x - width / tileSize / 2);
  const startY = Math.floor(viewport.y - height / tileSize / 2);
  const endX = Math.ceil(viewport.x + width / tileSize / 2);
  const endY = Math.ceil(viewport.y + height / tileSize / 2);

  const minX = Math.max(0, startX);
  const maxX = Math.min(MAP_SIZE - 1, endX);
  const minY = Math.max(0, startY);
  const maxY = Math.min(MAP_SIZE - 1, endY);

  const centerX = width / 2;
  const centerY = height / 2;

  ctx.save();
  ctx.globalAlpha = 0.3;

  // Optimize: Iterate minimal area
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const offset = y * MAP_SIZE + x;
      const zocIdx = zocSabView[offset];

      if (zocIdx !== 0) {
        let color = "#aaaaaa";

        if (zocIdx === 65534) {
          color = "#666666"; // Conflict
        } else if (zocIdx < factionsList.length) {
          const fid = factionsList[zocIdx];
          if (fid && factions[fid]) {
            color = factions[fid].color;
          }
        }

        const screenX = centerX + (x - viewport.x) * tileSize;
        const screenY = centerY + (y - viewport.y) * tileSize;

        ctx.fillStyle = color;
        ctx.fillRect(screenX, screenY, tileSize, tileSize);
      }
    }
  }
  ctx.restore();
}
