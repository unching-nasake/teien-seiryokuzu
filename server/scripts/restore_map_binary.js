const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// 設定
const MAP_SIZE = 500;
const TILE_BYTE_SIZE = 24;
const DATA_DIR = path.join(__dirname, "../data");
const HISTORY_DIR = path.join(DATA_DIR, "history");
const FACTIONS_PATH = path.join(DATA_DIR, "factions.json");
const PLAYERS_PATH = path.join(DATA_DIR, "players.json");
const ALLIANCES_PATH = path.join(DATA_DIR, "alliances.json");
const WARS_PATH = path.join(DATA_DIR, "wars.json");
const TRUCES_PATH = path.join(DATA_DIR, "truces.json");
const NAMED_CELLS_PATH = path.join(DATA_DIR, "named_cells.json");
const FACTION_NOTICES_PATH = path.join(DATA_DIR, "faction_notices.json");
const GAME_IDS_PATH = path.join(DATA_DIR, "game_ids.json");
const CEDE_REQUESTS_PATH = path.join(DATA_DIR, "cede_requests.json");
const ACTIVITY_LOG_PATH = path.join(DATA_DIR, "activity_log.json");
const DB_PATH = path.join(DATA_DIR, "game.db");
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
  console.log("=== Map Data Restoration Script (SQLite & Binary & JSON) ===");

  // 1. SQLite へのインポート
  console.log(`Connecting to database at ${DB_PATH}...`);
  const db = new Database(DB_PATH);

  console.log("Loading factions and players from backup JSON...");
  const factionsData = loadJSON(FACTIONS_PATH, { factions: {} });
  const playersData = loadJSON(PLAYERS_PATH, { players: {} });

  // トランザクションで高速一括処理
  const importFactions = db.transaction((factions) => {
    const upsert = db.prepare(
      "INSERT OR REPLACE INTO factions (id, data) VALUES (?, ?)",
    );
    for (const [id, data] of Object.entries(factions)) {
      upsert.run(id, JSON.stringify(data));
    }
  });

  const importPlayers = db.transaction((players) => {
    const upsert = db.prepare(
      "INSERT OR REPLACE INTO players (id, factionId, data) VALUES (?, ?, ?)",
    );
    for (const [id, data] of Object.entries(players)) {
      upsert.run(id, data.factionId || null, JSON.stringify(data));
    }
  });

  const fCount = Object.keys(factionsData.factions || {}).length;
  const pCount = Object.keys(playersData.players || {}).length;

  if (fCount > 0) {
    console.log(`Importing ${fCount} factions into DB...`);
    importFactions(factionsData.factions);
  }

  if (pCount > 0) {
    console.log(`Importing ${pCount} players into DB...`);
    importPlayers(playersData.players);
  }

  // 追加の全 JSON 同期
  const kvsFiles = [
    { path: ALLIANCES_PATH, table: "alliances", key: "alliances" },
    { path: WARS_PATH, table: "wars", key: "wars" },
    { path: TRUCES_PATH, table: "truces", key: "truces" },
    { path: NAMED_CELLS_PATH, table: "named_cells" },
    { path: GAME_IDS_PATH, table: "game_ids" },
    { path: CEDE_REQUESTS_PATH, table: "cede_requests", key: "requests" },
  ];

  for (const item of kvsFiles) {
    const data = loadJSON(item.path);
    const entries = item.key ? data[item.key] || {} : data || {};
    const count = Object.keys(entries).length;
    if (count > 0) {
      console.log(`Importing ${count} items into ${item.table}...`);
      db.transaction((items) => {
        const upsert = db.prepare(
          `INSERT OR REPLACE INTO ${item.table} (id, data) VALUES (?, ?)`,
        );
        for (const [id, val] of Object.entries(items)) {
          upsert.run(id, JSON.stringify(val));
        }
      })(entries);
    }
  }

  // Faction Notices (Array structure)
  const noticesData = loadJSON(FACTION_NOTICES_PATH);
  if (Object.keys(noticesData).length > 0) {
    console.log("Importing faction notices into DB...");
    db.transaction((noticesMap) => {
      db.prepare("DELETE FROM faction_notices").run();
      const insert = db.prepare(
        "INSERT INTO faction_notices (id, factionId, userId, isRead, createdAt, data) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const [key, list] of Object.entries(noticesMap)) {
        const parts = key.split(":");
        const type = parts[0];
        const val = parts[1];
        const fId = type === "faction" ? val : null;
        const uId = type === "user" ? val : null;
        if (!Array.isArray(list)) continue;
        for (const n of list) {
          if (!n.id) continue;
          insert.run(
            n.id,
            fId,
            uId,
            n.isRead ? 1 : 0,
            n.date || n.createdAt || new Date().toISOString(),
            JSON.stringify(n),
          );
        }
      }
    })(noticesData);
  }

  // Activity Logs
  const activityData = loadJSON(ACTIVITY_LOG_PATH);
  const logEntries = activityData.entries || [];
  if (logEntries.length > 0) {
    console.log(`Importing ${logEntries.length} activity logs into DB...`);
    db.transaction((logs) => {
      db.prepare("DELETE FROM activity_logs").run();
      const insert = db.prepare(
        "INSERT INTO activity_logs (type, date, factionId, data) VALUES (?, ?, ?, ?)",
      );
      for (const log of logs) {
        insert.run(
          log.type,
          log.date,
          log.factionId || null,
          JSON.stringify(log),
        );
      }
    })(logEntries);
  }

  // 2. マッピングの再構築 (DB から最新情報を取得)
  console.log("Rebuilding mappings from SQLite IDs...");
  const allFactionIds = db
    .prepare("SELECT id FROM factions")
    .all()
    .map((r) => r.id)
    .sort();
  const allPlayerIds = db
    .prepare("SELECT id FROM players")
    .all()
    .map((r) => r.id)
    .sort();

  const factionIdToIndex = new Map();
  allFactionIds.forEach((fid, idx) => {
    factionIdToIndex.set(fid, idx + 1); // 1-based
  });

  const playerIdsMap = new Map();
  allPlayerIds.forEach((pid, idx) => {
    playerIdsMap.set(pid, idx + 1); // 1-based
  });

  console.log(
    `Mapped ${factionIdToIndex.size} factions and ${playerIdsMap.size} players from DB.`,
  );

  // 3. 最新の有効な履歴ファイルを特定
  console.log(`Searching for latest history file in ${HISTORY_DIR}...`);
  if (!fs.existsSync(HISTORY_DIR)) {
    console.error("History directory not found.");
    db.close();
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
    .filter((f) => f.stat.size > 1024)
    .sort((a, b) => b.name.localeCompare(a.name));

  if (files.length === 0) {
    console.error("No valid history JSON files found.");
    db.close();
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

  // 4. バイナリ構築
  console.log("Constructing binary buffer...");
  const bufferSize = MAP_SIZE * MAP_SIZE * TILE_BYTE_SIZE;
  const buffer = Buffer.alloc(bufferSize, 0);

  // 初期化 (無し = 65535)
  for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
    buffer.writeUInt16LE(65535, i * TILE_BYTE_SIZE);
    buffer.writeUInt32LE(0xffffff, i * TILE_BYTE_SIZE + 2);
  }

  for (const [key, tile] of Object.entries(tiles)) {
    const parts = key.split("_");
    const x = parseInt(parts[0], 10);
    const y = parseInt(parts[1], 10);
    if (x < 0 || x >= MAP_SIZE || y < 0 || y >= MAP_SIZE) continue;

    const offset = (y * MAP_SIZE + x) * TILE_BYTE_SIZE;

    const fid = tile.factionId || tile.faction;
    const fidIdx = factionIdToIndex.get(fid) || 65535;
    buffer.writeUInt16LE(fidIdx, offset + 0);

    const colorStr = tile.customColor || tile.color || "#ffffff";
    const colorInt = parseInt(colorStr.replace("#", ""), 16) || 0xffffff;
    buffer.writeUInt32LE(colorInt, offset + 2);

    const pid = tile.paintedBy;
    const pidIdx = playerIdsMap.get(pid) || 0;
    buffer.writeUInt32LE(pidIdx, offset + 6);

    buffer.writeUInt8(tile.overpaint || 0, offset + 10);

    let flags = 0;
    if (tile.core) flags |= 1;
    if (tile.coreificationUntil) flags |= 2;
    buffer.writeUInt8(flags, offset + 11);

    let exp = 0;
    if (tile.core) exp = new Date(tile.core.expiresAt || 0).getTime();
    else if (tile.coreificationUntil)
      exp = new Date(tile.coreificationUntil).getTime();
    if (isNaN(exp)) exp = 0;
    buffer.writeDoubleLE(exp, offset + 12);

    const pAt = tile.paintedAt
      ? Math.floor(new Date(tile.paintedAt).getTime() / 1000)
      : 0;
    buffer.writeUInt32LE(pAt, offset + 20);
  }

  // 5. 保存
  const timestamp = Date.now();
  if (fs.existsSync(OUTPUT_BIN_PATH)) {
    fs.copyFileSync(OUTPUT_BIN_PATH, `${OUTPUT_BIN_PATH}.bak_${timestamp}`);
  }
  if (fs.existsSync(OUTPUT_JSON_PATH)) {
    fs.copyFileSync(OUTPUT_JSON_PATH, `${OUTPUT_JSON_PATH}.bak_${timestamp}`);
  }

  fs.writeFileSync(OUTPUT_BIN_PATH, buffer);
  fs.writeFileSync(OUTPUT_JSON_PATH, JSON.stringify(historyData, null, 2));

  db.close();
  console.log("\n[SUCCESS] Restoration and DB Import complete!");
  console.log("--------------------------------------------------");
  console.log("IMPORTANT: Restart the server NOW");
  console.log("Command: pm2 restart teien-server");
  console.log("--------------------------------------------------");
}

restore().catch((err) => {
  console.error("Restoration failed:", err);
  process.exit(1);
});
