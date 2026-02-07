/**
 * マップ描画用 Web Worker (OffscreenCanvas)
 * ベースキャンバスの描画をオフスレッドで実行
 */

// 定数
const MAP_SIZE = 500;
const TILE_SIZE = 16;
const CHUNK_SIZE = 8;

// OffscreenCanvas参照
let canvas = null;
let ctx = null;

// [Stateful Worker] データキャッシュ
let cachedTiles = {};
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

/**
 * 初期化: OffscreenCanvasを受け取る
 */
function init(offscreenCanvas) {
  canvas = offscreenCanvas;
  ctx = canvas.getContext("2d");
  console.log(
    "[RenderWorker] Initialized with canvas:",
    canvas.width,
    "x",
    canvas.height,
  );
}

/**
 * キャンバスサイズを更新
 */
function resize(width, height) {
  if (canvas) {
    canvas.width = width;
    canvas.height = height;
    console.log("[RenderWorker] Resized to:", width, "x", height);
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

  // クリア
  ctx.fillStyle = blankTileColor || "#ffffff";
  ctx.fillRect(0, 0, width, height);

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
  if (data.tiles) cachedTiles = data.tiles;
  if (data.factions) cachedFactions = data.factions;
  if (data.alliances) cachedAlliances = data.alliances;
  if (data.playerColors) cachedPlayerColors = data.playerColors;

  // テーマ設定更新
  if (data.blankTileColor) cachedTheme.blankTileColor = data.blankTileColor;
  if (data.highlightCoreOnly !== undefined)
    cachedTheme.highlightCoreOnly = data.highlightCoreOnly;
  if (data.mapColorMode) cachedTheme.mapColorMode = data.mapColorMode;

  // 描画に使用するデータ
  const tiles = cachedTiles;
  const factions = cachedFactions;
  const alliances = cachedAlliances;
  const playerColors = cachedPlayerColors;
  const { blankTileColor, highlightCoreOnly, mapColorMode } = cachedTheme;

  if (!ctx || !canvas) return;

  const tileSize = TILE_SIZE * viewport.zoom;
  const centerX = width / 2;
  const centerY = height / 2;
  const showGrid = viewport.zoom > 2.0;

  // クリア (宇宙色)
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, width, height);

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
      const tileKey = `${x}_${y}`;
      const tile = tiles[tileKey];

      // 最適化: タイルがない場合は背景色(blankTileColor)と同じならスキップ
      // デフォルト背景は #1a1a2e
      if (!tile) {
        // 背景色と同じなら描画しない（クリア済みだから）
        if ((blankTileColor || "#ffffff") === "#1a1a2e") continue;
      }

      const screenX = centerX + (x - viewport.x) * tileSize;
      const screenY = centerY + (y - viewport.y) * tileSize;

      const drawSize = showGrid
        ? Math.max(1, tileSize - 1)
        : Math.ceil(tileSize) + 0.5;
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
        if (!skipBorders && f && mapColorMode === "overpaint") {
          const checkBorder = (dx, dy, type) => {
            const nk = `${x + dx}_${y + dy}`;
            const nt = tiles[nk];
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
      arr.push(screenX, screenY, drawSize, drawSize);
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
    ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
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

// メッセージハンドラ
// メッセージハンドラ
self.onmessage = function (e) {
  const { type, data } = e.data;

  try {
    if (type === "INIT") {
      init(data.canvas);
      self.postMessage({ type: "INIT_COMPLETE", success: true });
    } else if (type === "RESIZE") {
      resize(data.width, data.height);
      self.postMessage({ type: "RESIZE_COMPLETE", success: true });
    } else if (type === "UPDATE_TILES") {
      // [Stateful] タイルデータ更新
      const { tiles, replace } = data;
      if (replace) {
        cachedTiles = tiles || {};
      } else if (tiles) {
        Object.assign(cachedTiles, tiles);
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
    } else {
      console.warn("[RenderWorker] Unknown message type:", type);
    }
  } catch (error) {
    console.error("[RenderWorker] Error:", error);
    self.postMessage({ type: "ERROR", error: error.message });
  }
};
