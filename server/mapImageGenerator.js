/**
 * マップ画像生成モジュール (node-canvas版)
 * Puppeteerを使わず、サーバーサイドでCanvas描画を行う
 */
const { createCanvas } = require("canvas");
const path = require("path");
const fs = require("fs");

// 定数
const MAP_SIZE = 500; // 500x500タイル
const TILE_SIZE = 2; // 1タイルあたり2px
const PADDING = 150; // 左右上下の余白 (150px)
const IMAGE_SIZE = MAP_SIZE * TILE_SIZE + PADDING * 2; // = 1300px

// パス設定
const DATA_DIR = path.join(__dirname, "data");
const OUTPUT_DIR = path.join(DATA_DIR, "map_images");
const MAP_STATE_PATH = path.join(DATA_DIR, "map_state.json");
const FACTIONS_PATH = path.join(DATA_DIR, "factions.json");

// 出力ディレクトリの作成
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/**
 * JSON読み込みヘルパー
 */
function loadJSON(filePath, defaultValue = {}) {
  if (!fs.existsSync(filePath)) return defaultValue;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error(`[MapImageGenerator] JSON parse error: ${filePath}`, e);
    return defaultValue;
  }
}

/**
 * 勢力の重心を計算
 */
function calculateFactionCenters(tiles, factions) {
  const centers = {};

  Object.entries(tiles).forEach(([key, tile]) => {
    const fid = tile.factionId || tile.faction;
    if (!fid || !factions[fid]) return;

    if (!centers[fid]) {
      centers[fid] = { sumX: 0, sumY: 0, count: 0 };
    }

    const [x, y] = key.split("_").map(Number);
    centers[fid].sumX += x;
    centers[fid].sumY += y;
    centers[fid].count++;
  });

  // 重心座標を計算
  const result = {};
  Object.entries(centers).forEach(([fid, data]) => {
    if (data.count > 0) {
      result[fid] = {
        x: data.sumX / data.count,
        y: data.sumY / data.count,
        count: data.count,
      };
    }
  });

  return result;
}

/**
 * マップ画像を生成
 * @param {string} mode - 'faction_full' (ラベル付き) or 'faction_simple' (色のみ)
 */
async function generateMapImage(mode = "faction_full") {
  console.log(`[MapImageGenerator] Generating ${mode}...`);

  const showNames = mode === "faction_full";

  // データ読み込み
  const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });
  const factionsData = loadJSON(FACTIONS_PATH, { factions: {} });
  const tiles = mapState.tiles || {};
  const factions = factionsData.factions || {};

  // Canvas作成
  const canvas = createCanvas(IMAGE_SIZE, IMAGE_SIZE);
  const ctx = canvas.getContext("2d");

  // 背景色 (白)
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, IMAGE_SIZE, IMAGE_SIZE);

  // 1. タイル描画 (色ごとにバッチング) - 勢力タイルのみ描画
  const batchDraws = new Map();

  for (let x = 0; x < MAP_SIZE; x++) {
    for (let y = 0; y < MAP_SIZE; y++) {
      const key = `${x}_${y}`;
      const tile = tiles[key];

      // 空白タイルは描画しない（背景の白が見える）
      if (!tile) continue;

      const fid = tile.factionId || tile.faction;
      const faction = factions[fid];
      const color = tile.customColor || (faction ? faction.color : "#aaaaaa");

      if (!batchDraws.has(color)) {
        batchDraws.set(color, []);
      }
      batchDraws.get(color).push({ x, y });
    }
  }

  // 色ごとにまとめて描画
  batchDraws.forEach((coords, color) => {
    ctx.fillStyle = color;
    coords.forEach(({ x, y }) => {
      ctx.fillRect(
        PADDING + x * TILE_SIZE,
        PADDING + y * TILE_SIZE,
        TILE_SIZE + 0.5,
        TILE_SIZE + 0.5,
      );
    });
  });

  // 2. 勢力名ラベル描画 (詳細モードのみ)
  if (showNames) {
    const factionCenters = calculateFactionCenters(tiles, factions);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    Object.entries(factionCenters).forEach(([fid, center]) => {
      const faction = factions[fid];
      if (!faction) return;

      let name = faction.name || "不明";
      name = name.trim().replace(/\s+/g, " ");
      if (name.length > 30) name = name.substring(0, 27) + "...";

      // フォントサイズ: 領土サイズに応じてスケーリング
      let sizeBase = Math.min(
        128,
        Math.max(8, Math.sqrt(center.count) * 4 + 4),
      );

      // 文字数による調整
      if (name.length > 5) {
        sizeBase = sizeBase * (6.0 / name.length);
      }

      // TILE_SIZEでスケール（0.11相当のズームをシミュレート）
      const fontSize = Math.max(6, sizeBase * TILE_SIZE * 0.5);

      const screenX = PADDING + center.x * TILE_SIZE;
      const screenY = PADDING + center.y * TILE_SIZE;

      // 袋文字 (読みやすくするため)
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.shadowColor = "rgba(0, 0, 0, 0.8)";
      ctx.shadowBlur = 4;
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 3;
      ctx.fillStyle = "#ffffff";

      ctx.strokeText(name, screenX, screenY);
      ctx.fillText(name, screenX, screenY);
    });

    ctx.shadowBlur = 0;
  }

  // 3. PNG出力
  const filename = `${mode}.png`;
  const outputPath = path.join(OUTPUT_DIR, filename);
  const tempPath = outputPath + ".tmp";

  try {
    const buffer = canvas.toBuffer("image/png");
    fs.writeFileSync(tempPath, buffer);

    // Atomic write
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    fs.renameSync(tempPath, outputPath);

    console.log(`[MapImageGenerator] Saved: ${outputPath}`);
    return { success: true, path: outputPath };
  } catch (e) {
    console.error(`[MapImageGenerator] Save error:`, e);
    return { success: false, error: e.message };
  }
}

/**
 * 全パターンの画像を生成
 */
async function generateAllMapImages() {
  const results = [];
  results.push(await generateMapImage("faction_full"));
  results.push(await generateMapImage("faction_simple"));
  return results;
}

module.exports = {
  generateMapImage,
  generateAllMapImages,
  OUTPUT_DIR,
};

// 直接実行時
if (require.main === module) {
  generateAllMapImages()
    .then((results) => {
      console.log("[MapImageGenerator] All captures completed:", results);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[MapImageGenerator] Fatal error:", err);
      process.exit(1);
    });
}
