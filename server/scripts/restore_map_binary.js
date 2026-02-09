const fs = require("fs");
const path = require("path");

// 設定
const MAP_SIZE = 500;
const TILE_BYTE_SIZE = 24;
const DATA_DIR = path.join(__dirname, "../data");
const HISTORY_DIR = path.join(DATA_DIR, "history");
const FACTIONS_PATH = path.join(DATA_DIR, "factions.json");
const PLAYERS_PATH = path.join(DATA_DIR, "players.json");
const OUTPUT_BIN_PATH = path.join(DATA_DIR, "map_state.bin");
const OUTPUT_JSON_PATH = path.join(DATA_DIR, "map_state.json");

function loadJSON(filePath, defaultValue = {}) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (e) {
    console.error(`[Error] Failed to load ${filePath}:`, e.message);
  }
  return defaultValue;
}

async function restore() {
  console.log("=== Map Data Restoration Script (Binary & JSON) ===");

  // 1. マッピングの再構築
  console.log("Loading factions and players for mapping...");
  const factionsData = loadJSON(FACTIONS_PATH, { factions: {} });
  const playersData = loadJSON(PLAYERS_PATH, { players: {} });

  const factionIdToIndex = new Map();
  const sortedFids = Object.keys(factionsData.factions || {}).sort();
  sortedFids.forEach((fid, idx) => {
    factionIdToIndex.set(fid, idx + 1);
  });

  const playerIdsMap = new Map();
  const sortedPids = Object.keys(playersData.players || {}).sort();
  sortedPids.forEach((pid, idx) => {
    playerIdsMap.set(pid, idx + 1);
  });

  console.log(
    `Mapped ${factionIdToIndex.size} factions and ${playerIdsMap.size} players.`,
  );

  // 2. 最新の有効な履歴ファイルを特定
  console.log(`Searching for latest history file in ${HISTORY_DIR}...`);
  if (!fs.existsSync(HISTORY_DIR)) {
    console.error("History directory not found.");
    return;
  }

  const files = fs
    .readdirSync(HISTORY_DIR)
    .filter((f) => f.startsWith("map_") && f.endsWith(".json"))
    .map((f) => ({
      name: f,
      path: path.join(HISTORY_DIR, f),
      stat: fs.statSync(path.join(HISTORY_DIR, f)),
    }))
    .filter((f) => f.stat.size > 1024) // 1KB未満は除外
    .sort((a, b) => b.name.localeCompare(a.name));

  if (files.length === 0) {
    console.error("No valid history JSON files found.");
    return;
  }

  const latestFile = files[0];
  console.log(
    `Target history file: ${latestFile.name} (${Math.round(latestFile.stat.size / 1024)} KB)`,
  );

  const historyData = loadJSON(latestFile.path, { tiles: {} });
  const tiles = historyData.tiles || {};
  const tileCount = Object.keys(tiles).length;
  console.log(`Loaded ${tileCount} tiles from history.`);

  // 3. バイナリ構築
  console.log("Constructing binary buffer...");
  const bufferSize = MAP_SIZE * MAP_SIZE * TILE_BYTE_SIZE;
  const buffer = Buffer.alloc(bufferSize, 0);

  for (const [key, tile] of Object.entries(tiles)) {
    const [x, y] = key.split("_").map(Number);
    if (x < 0 || x >= MAP_SIZE || y < 0 || y >= MAP_SIZE) continue;

    const offset = (y * MAP_SIZE + x) * TILE_BYTE_SIZE;

    // 0-1: factionId index (Uint16LE)
    const fid = tile.factionId || tile.faction;
    const fidIdx = factionIdToIndex.get(fid) || 65535;
    buffer.writeUInt16LE(fidIdx === 65535 ? 0xffff : fidIdx, offset + 0);

    // 2-5: color (Uint32LE)
    const colorStr = tile.customColor || tile.color || "#ffffff";
    const colorInt = parseInt(colorStr.replace("#", ""), 16) || 0xffffff;
    buffer.writeUInt32LE(colorInt, offset + 2);

    // 6-9: paintedBy index (Uint32LE)
    const pid = tile.paintedBy;
    const pidIdx = playerIdsMap.get(pid) || 0;
    buffer.writeUInt32LE(pidIdx, offset + 6);

    // 10: overpaint (Uint8)
    buffer.writeUInt8(tile.overpaint || 0, offset + 10);

    // 11: flags
    let flags = 0;
    if (tile.core) flags |= 1;
    if (tile.coreificationUntil) flags |= 2;
    buffer.writeUInt8(flags, offset + 11);

    // 12-19: expiry (Float64LE)
    let exp = 0;
    if (tile.core) exp = new Date(tile.core.expiresAt || 0).getTime();
    else if (tile.coreificationUntil)
      exp = new Date(tile.coreificationUntil).getTime();
    if (isNaN(exp)) exp = 0;
    buffer.writeDoubleLE(exp, offset + 12);

    // 20-23: paintedAt (Uint32LE)
    const pAt = tile.paintedAt
      ? Math.floor(new Date(tile.paintedAt).getTime() / 1000)
      : 0;
    buffer.writeUInt32LE(pAt, offset + 20);
  }

  // 4. 保存
  // バックアップ作成 (JSON & Binary)
  const timestamp = Date.now();
  if (fs.existsSync(OUTPUT_BIN_PATH)) {
    console.log(`Backing up original binary...`);
    fs.copyFileSync(OUTPUT_BIN_PATH, `${OUTPUT_BIN_PATH}.bak_${timestamp}`);
  }
  if (fs.existsSync(OUTPUT_JSON_PATH)) {
    console.log(`Backing up original JSON...`);
    fs.copyFileSync(OUTPUT_JSON_PATH, `${OUTPUT_JSON_PATH}.bak_${timestamp}`);
  }

  console.log(`Writing rebuilt binary to ${path.basename(OUTPUT_BIN_PATH)}...`);
  fs.writeFileSync(OUTPUT_BIN_PATH, buffer);

  console.log(`Writing source JSON to ${path.basename(OUTPUT_JSON_PATH)}...`);
  // Source of Truth として JSON を書き出し
  fs.writeFileSync(OUTPUT_JSON_PATH, JSON.stringify(historyData, null, 2));

  console.log("\n[SUCCESS] Restoration complete!");
  console.log("--------------------------------------------------");
  console.log("IMPORTANT: You must restart the server IMMEDIATELY");
  console.log("to apply changes and avoid overwriting with old data.");
  console.log("Command: pm2 restart teien-server");
  console.log("--------------------------------------------------");
}

restore().catch((err) => {
  console.error("Restoration failed:", err);
  process.exit(1);
});
