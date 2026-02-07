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
  const {
    viewport,
    tiles,
    factions,
    alliances,
    mapColorMode,
    blankTileColor,
    playerColors,
    highlightCoreOnly,
    width,
    height,
  } = data;

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

  // 色ごとにバッチング
  const batchDraws = new Map();
  const factionBorderRects = [];

  for (let x = Math.max(0, startX); x <= Math.min(MAP_SIZE - 1, endX); x++) {
    for (let y = Math.max(0, startY); y <= Math.min(MAP_SIZE - 1, endY); y++) {
      const screenX = centerX + (x - viewport.x) * tileSize;
      const screenY = centerY + (y - viewport.y) * tileSize;

      const tileKey = `${x}_${y}`;
      const tile = tiles[tileKey];

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

        // 塗装数モード時の外縁境界線
        if (f && mapColorMode === "overpaint") {
          const checkBorder = (dx, dy, type) => {
            const nk = `${x + dx}_${y + dy}`;
            const nt = tiles[nk];
            const nfid = nt ? nt.factionId || nt.faction : null;
            if (nfid !== fid) {
              factionBorderRects.push({
                x: screenX,
                y: screenY,
                w: drawSize,
                h: drawSize,
                type,
              });
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
      batchDraws
        .get(color)
        .push({ x: screenX, y: screenY, w: drawSize, h: drawSize });
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

  // 塗装数モード時の勢力境界線
  if (factionBorderRects.length > 0) {
    ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const r of factionBorderRects) {
      if (r.type === "top") {
        ctx.moveTo(r.x, r.y);
        ctx.lineTo(r.x + r.w, r.y);
      } else if (r.type === "bottom") {
        ctx.moveTo(r.x, r.y + r.h);
        ctx.lineTo(r.x + r.w, r.y + r.h);
      } else if (r.type === "left") {
        ctx.moveTo(r.x, r.y);
        ctx.lineTo(r.x, r.y + r.h);
      } else if (r.type === "right") {
        ctx.moveTo(r.x + r.w, r.y);
        ctx.lineTo(r.x + r.w, r.y + r.h);
      }
    }
    ctx.stroke();
  }
}

// メッセージハンドラ
self.onmessage = function (e) {
  const { type, data } = e.data;

  try {
    switch (type) {
      case "INIT":
        init(data.canvas);
        self.postMessage({ type: "INIT_COMPLETE", success: true });
        break;

      case "RESIZE":
        resize(data.width, data.height);
        self.postMessage({ type: "RESIZE_COMPLETE", success: true });
        break;

      case "RENDER_CHUNKS":
        renderChunks(data);
        self.postMessage({ type: "RENDER_COMPLETE", success: true });
        break;

      case "RENDER_TILES":
        renderTiles(data);
        self.postMessage({ type: "RENDER_COMPLETE", success: true });
        break;

      default:
        console.warn("[RenderWorker] Unknown message type:", type);
    }
  } catch (error) {
    console.error("[RenderWorker] Error:", error);
    self.postMessage({ type: "ERROR", error: error.message });
  }
};
