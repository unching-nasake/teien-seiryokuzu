const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.resolve(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "game.db");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let db;

function getDB() {
  if (!db) {
    db = new Database(DB_PATH, {
      // verbose: console.log
    });
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL"); // 安全性と速度のバランス
    initDB();
  }
  return db;
}

function initDB() {
  const db = getDB();

  // 1. Players
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      factionId TEXT,
      data TEXT NOT NULL
    )
  `);
  // インデックス: 勢力ごとの検索を高速化
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_players_factionId ON players(factionId)`,
  );

  // 2. Factions
  db.exec(`
    CREATE TABLE IF NOT EXISTS factions (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )
  `);

  // 3. Faction Notices
  db.exec(`
    CREATE TABLE IF NOT EXISTS faction_notices (
      id TEXT PRIMARY KEY,
      factionId TEXT,
      userId TEXT,
      isRead INTEGER DEFAULT 0,
      createdAt TEXT,
      data TEXT NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_notices_factionId ON faction_notices(factionId)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_notices_userId ON faction_notices(userId)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_notices_createdAt ON faction_notices(createdAt)`,
  );

  // 4. Activity Logs
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      date TEXT,
      factionId TEXT,
      data TEXT NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_logs_date ON activity_logs(date DESC)`,
  );

  // 5. Wars (KVS like)
  db.exec(`
    CREATE TABLE IF NOT EXISTS wars (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )
  `);

  // 6. Alliances (KVS like)
  db.exec(`
    CREATE TABLE IF NOT EXISTS alliances (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )
  `);

  // 7. Truces (KVS like)
  db.exec(`
    CREATE TABLE IF NOT EXISTS truces (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )
  `);

  // 8. Game IDs (KVS like)
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_ids (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )
  `);

  // 9. Named Cells (KVS like)
  db.exec(`
    CREATE TABLE IF NOT EXISTS named_cells (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )
  `);

  // 10. Cede Requests (KVS like)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cede_requests (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )
  `);

  console.log("[DB] Database initialized and schema ensured.");
}

module.exports = {
  getDB,
  initDB,
};
