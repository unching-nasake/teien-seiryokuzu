const fs = require("fs");
const path = require("path");
const { getDB } = require("../db");

const DATA_DIR = path.resolve(__dirname, "../data");
const PLAYERS_PATH = path.join(DATA_DIR, "players.json");
const FACTIONS_PATH = path.join(DATA_DIR, "factions.json");
const FACTION_NOTICES_PATH = path.join(DATA_DIR, "faction_notices.json");
const ACTIVITY_LOG_PATH = path.join(DATA_DIR, "activity_log.json");
const WARS_PATH = path.join(DATA_DIR, "wars.json");
const ALLIANCES_PATH = path.join(DATA_DIR, "alliances.json");
const TRUCES_PATH = path.join(DATA_DIR, "truces.json");
const GAME_IDS_PATH = path.join(DATA_DIR, "game_ids.json");
const NAMED_CELLS_PATH = path.join(DATA_DIR, "named_cells.json");

function loadJSON(filePath, defaultValue = {}) {
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Error reading ${filePath}:`, e);
    return defaultValue;
  }
}

function migrate() {
  console.log("Starting migration to SQLite...");
  const db = getDB();

  // 1. Migrate Players
  const playersData = loadJSON(PLAYERS_PATH, { players: {} });
  const players = playersData.players || {};
  const playerIds = Object.keys(players);

  const insertPlayer = db.prepare(
    "INSERT OR REPLACE INTO players (id, factionId, data) VALUES (?, ?, ?)",
  );
  const infoPlayers = db.transaction((pList) => {
    let count = 0;
    for (const pid of pList) {
      const p = players[pid];
      insertPlayer.run(pid, p.factionId || null, JSON.stringify(p));
      count++;
    }
    return count;
  })(playerIds);
  console.log(`Migrated ${infoPlayers} players.`);

  // 2. Migrate Factions
  const factionsData = loadJSON(FACTIONS_PATH, { factions: {} });
  const factions = factionsData.factions || {};
  const factionIds = Object.keys(factions);

  const insertFaction = db.prepare(
    "INSERT OR REPLACE INTO factions (id, data) VALUES (?, ?)",
  );
  const infoFactions = db.transaction((fList) => {
    let count = 0;
    for (const fid of fList) {
      const f = factions[fid];
      insertFaction.run(fid, JSON.stringify(f));
      count++;
    }
    return count;
  })(factionIds);
  console.log(`Migrated ${infoFactions} factions.`);

  // 3. Migrate Notices
  // faction_notices.json: { "user:xxx": [...], "faction:yyy": [...] }
  const noticesData = loadJSON(FACTION_NOTICES_PATH, {});

  const insertNotice = db.prepare(
    "INSERT OR REPLACE INTO faction_notices (id, factionId, userId, isRead, createdAt, data) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const infoNotices = db.transaction((nData) => {
    let count = 0;
    for (const key in nData) {
      // key format: "user:ID" or "faction:ID" or "all"(unused?)
      let userId = null;
      let factionId = null;

      if (key.startsWith("user:")) {
        userId = key.split(":")[1];
      } else if (key.startsWith("faction:")) {
        factionId = key.split(":")[1];
      } else {
        // console.warn(`Skipping unknown notice key: ${key}`);
        continue;
      }

      const notices = nData[key];
      if (Array.isArray(notices)) {
        for (const notice of notices) {
          // notice: { id, title, content, date, type, isRead, metadata }
          // generate ID if missing (unlikely)
          const nid = notice.id || `migrated-${Date.now()}-${Math.random()}`;
          const isRead = notice.isRead ? 1 : 0;
          const createdAt = notice.date || new Date().toISOString();

          insertNotice.run(
            nid,
            factionId,
            userId,
            isRead,
            createdAt,
            JSON.stringify(notice),
          );
          count++;
        }
      }
    }
    return count;
  })(noticesData);
  console.log(`Migrated ${infoNotices} notices.`);

  // 4. Migrate Activity Logs
  const logData = loadJSON(ACTIVITY_LOG_PATH, { entries: [] });
  const logs = logData.entries || [];

  const insertLog = db.prepare(
    "INSERT INTO activity_logs (type, date, factionId, data) VALUES (?, ?, ?, ?)",
  );
  const infoLogs = db.transaction((lList) => {
    let count = 0;
    for (const log of lList) {
      // log: { type, content, factionId, date, ... }
      insertLog.run(
        log.type,
        log.date,
        log.factionId || null,
        JSON.stringify(log),
      );
      count++;
    }
    return count;
  })(logs);
  console.log(`Migrated ${infoLogs} activity logs.`);

  // 5. Migrate Wars
  const warsData = loadJSON(WARS_PATH, {});
  const warIds = Object.keys(warsData);

  const insertWar = db.prepare(
    "INSERT OR REPLACE INTO wars (id, data) VALUES (?, ?)",
  );
  const infoWars = db.transaction((wList) => {
    let count = 0;
    for (const wid of wList) {
      insertWar.run(wid, JSON.stringify(warsData[wid]));
      count++;
    }
    return count;
  })(warIds);
  console.log(`Migrated ${infoWars} wars.`);

  // 6. Migrate Alliances
  const alliancesData = loadJSON(ALLIANCES_PATH, {});
  const allianceIds = Object.keys(alliancesData);

  const insertAlliance = db.prepare(
    "INSERT OR REPLACE INTO alliances (id, data) VALUES (?, ?)",
  );
  const infoAlliances = db.transaction((aList) => {
    let count = 0;
    for (const aid of aList) {
      insertAlliance.run(aid, JSON.stringify(alliancesData[aid]));
      count++;
    }
    return count;
  })(allianceIds);
  console.log(`Migrated ${infoAlliances} alliances.`);

  // 7. Migrate Truces
  const trucesData = loadJSON(TRUCES_PATH, {});
  const truceIds = Object.keys(trucesData);

  const insertTruce = db.prepare(
    "INSERT OR REPLACE INTO truces (id, data) VALUES (?, ?)",
  );
  const infoTruces = db.transaction((tList) => {
    let count = 0;
    for (const tid of tList) {
      insertTruce.run(tid, JSON.stringify(trucesData[tid]));
      count++;
    }
    return count;
  })(truceIds);
  console.log(`Migrated ${infoTruces} truces.`);

  // 8. Migrate Game IDs
  const gameIdsData = loadJSON(GAME_IDS_PATH, {});
  const gameKeyIds = Object.keys(gameIdsData);

  const insertGameId = db.prepare(
    "INSERT OR REPLACE INTO game_ids (id, data) VALUES (?, ?)",
  );
  const infoGameIds = db.transaction((gkList) => {
    let count = 0;
    for (const gk of gkList) {
      insertGameId.run(gk, JSON.stringify(gameIdsData[gk]));
      count++;
    }
    return count;
  })(gameKeyIds);
  console.log(`Migrated ${infoGameIds} game IDs.`);

  // 9. Migrate Named Cells
  if (fs.existsSync(NAMED_CELLS_PATH)) {
    const namedCellsData = loadJSON(NAMED_CELLS_PATH, {});
    const cellIds = Object.keys(namedCellsData);

    const insertNamedCell = db.prepare(
      "INSERT OR REPLACE INTO named_cells (id, data) VALUES (?, ?)",
    );
    const infoNamedCells = db.transaction((ids) => {
      let count = 0;
      for (const cid of ids) {
        insertNamedCell.run(cid, JSON.stringify(namedCellsData[cid]));
        count++;
      }
      return count;
    })(cellIds);
    console.log(`Migrated ${infoNamedCells} named cells.`);
  } else {
    console.log("No named_cells.json found, skipping.");
  }

  console.log("Migration completed successfully.");
}

if (require.main === module) {
  migrate();
}

module.exports = migrate;
