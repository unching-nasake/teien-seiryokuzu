const express = require("express");
const compression = require("compression");
const http = require("http");
const { Server } = require("socket.io");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const shared = require("./shared");
const {
  LockManager,
  MAP_SIZE,
  getTilePoints,
  getTop3AllianceIds,
  isWeakFactionUnified,
  calculateFactionSharedAPLimit,
  NAMED_CELL_CREATE_COST,
} = shared;

// --------------------------------------------------------------------------
// パス定義 (先頭に移動)
const DATA_DIR = path.resolve(__dirname, "data");
const MAP_STATE_PATH = path.join(DATA_DIR, "map_state.json");
const MAP_STATE_BIN_PATH = path.join(DATA_DIR, "map_state.bin");
const FACTIONS_PATH = path.join(DATA_DIR, "factions.json");
const PLAYERS_PATH = path.join(DATA_DIR, "players.json");
const GAME_IDS_PATH = path.join(DATA_DIR, "game_ids.json");
const ADMIN_ID_PATH = path.resolve(DATA_DIR, "admin-id.txt");
const ACTIVITY_LOG_PATH = path.join(DATA_DIR, "activity_log.json");
const SYSTEM_NOTICES_PATH = path.join(DATA_DIR, "system_notices.json");
const FACTION_NOTICES_PATH = path.join(DATA_DIR, "faction_notices.json");
const SYSTEM_SETTINGS_PATH = path.join(DATA_DIR, "system_settings.json");
const ALLIANCES_PATH = path.join(DATA_DIR, "alliances.json");
const TRUCES_PATH = path.join(DATA_DIR, "truces.json");
const WARS_PATH = path.join(DATA_DIR, "wars.json");
const NAMED_CELLS_PATH = path.join(DATA_DIR, "named_cells.json");
const DUPLICATE_IP_PATH = path.join(DATA_DIR, "duplicate_ip.json");

const TILE_BYTE_SIZE = 24; // shared.TILE_BYTE_SIZE (Always 24)

// [NEW] SharedArrayBuffer による一括メモリ管理 (25万タイル x 20バイト = 5MB)
// 各 Worker と共有することで、プロセス全体のメモリ消費を劇的に削減
const sharedMapSAB = new SharedArrayBuffer(
  MAP_SIZE * MAP_SIZE * TILE_BYTE_SIZE,
);
const sharedMapView = new DataView(sharedMapSAB);

// [INIT] 全タイルの勢力IDを 65535 (無し) で初期化
for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
  const offset = i * TILE_BYTE_SIZE;
  sharedMapView.setUint16(offset, 65535, true); // faction
  sharedMapView.setUint32(offset + 2, 0xffffff, true); // color
  sharedMapView.setUint32(offset + 6, 0, true); // paintedBy
  sharedMapView.setUint8(offset + 10, 0); // overpaint
  sharedMapView.setUint8(offset + 11, 0); // flags
  sharedMapView.setFloat64(offset + 12, 0, true); // expiry (unaligned but safe)
  sharedMapView.setUint32(offset + 20, 0, true); // paintedAt
}

// IDマッピングテーブル (Memory-only, for converting strings to indexes in SAB)
const factionIdToIndex = new Map(); // factionId (string) -> index (number)
const indexToFactionId = [""]; // 0 is reserved/empty

// [NEW] ZOC Map SAB (500x500 Uint16) - Stores factionIndex
const sharedZocMapSAB = new SharedArrayBuffer(
  MAP_SIZE * MAP_SIZE * 2, // 2 bytes per tile (Uiunt16)
);
const sharedZocMapView = new Uint16Array(sharedZocMapSAB);

// [NEW] Faction Stats SAB
// Structure: [tileCount, coreCount, apLimit, currentAp, ..., ..., ...] per faction
// each faction gets 16 integers (64 bytes) reserved space
const MAX_FACTIONS_LIMIT = 2000;
const STATS_INTS_PER_FACTION = 16;
const factionStatsSAB = new SharedArrayBuffer(
  MAX_FACTIONS_LIMIT * STATS_INTS_PER_FACTION * 4,
);
const factionStatsView = new Int32Array(factionStatsSAB);
// Stats Offsets:
// 0: tileCount
// 1: coreCount
// 2: apLimit
// 3: currentAp (not fully realtime yet, but reserved)

// [NEW] Player ID Mapping
const playerIds = []; // index -> id (1-based, 0 is null)
const playerIdsMap = new Map(); // id -> index

// [NEW] 勢力・プレイヤーのインデックスマッピングを安定化（再起動しても順序が変わらないようにする）
function rebuildStableMappings(factionsData, playersData) {
  // 勢力
  const sortedFids = Object.keys(factionsData?.factions || {}).sort();
  factionIdToIndex.clear();
  indexToFactionId.length = 0;
  sortedFids.forEach((fid, idx) => {
    factionIdToIndex.set(fid, idx);
    indexToFactionId.push(fid);
  });

  // プレイヤー
  const sortedPids = Object.keys(playersData?.players || {}).sort();
  playerIdsMap.clear();
  playerIds.length = 0;
  sortedPids.forEach((pid, idx) => {
    const internalIdx = idx + 1; // 1-based
    playerIdsMap.set(pid, internalIdx);
    playerIds.push(pid);
  });

  console.log(
    `[Init] Mappings rebuilt: ${indexToFactionId.length} factions, ${playerIds.length} players`,
  );
}

function getFactionIdx(fid) {
  if (!fid) return 65535;
  if (factionIdToIndex.has(fid)) return factionIdToIndex.get(fid);
  // 起動時にマップされているはずだが、新規勢力の場合は動的に追加（基本は安定化関数で作成）
  const idx = indexToFactionId.length;
  factionIdToIndex.set(fid, idx);
  indexToFactionId.push(fid);
  return idx;
}

function getFactionIdFromIdx(idx) {
  if (idx === 65535) return null;
  return indexToFactionId[idx] || null;
}

function getPlayerIdx(pid) {
  if (!pid) return 0;
  if (playerIdsMap.has(pid)) return playerIdsMap.get(pid);
  const idx = playerIds.length + 1;
  playerIds.push(pid);
  playerIdsMap.set(pid, idx);
  return idx;
}

// [NEW] 勢力間の戦争状態を判定するヘルパー (Helper to check if two factions are at war)
function isAtWarWith(fid1, fid2, warsData) {
  if (!warsData || !warsData.wars) return false;
  const f1 = String(fid1);
  const f2 = String(fid2);
  return Object.values(warsData.wars).some((w) => {
    if (!w.attackerSide || !w.defenderSide) return false;
    const attackers = w.attackerSide.factions.map(String);
    const defenders = w.defenderSide.factions.map(String);
    return (
      (attackers.includes(f1) && defenders.includes(f2)) ||
      (defenders.includes(f1) && attackers.includes(f2))
    );
  });
}

// [NEW] SharedArrayBuffer と JSONマップの同期
function syncSABWithJSON(mapState) {
  if (!mapState || !mapState.tiles) return;

  const size = 500;

  // [NEW] Clear new SABs
  sharedZocMapView.fill(0); // 0 = no ZOC (or index 0 which is empty)
  // factionStatsView is processed below
  // 不正な0データによる占領を防ぐ
  for (let i = 0; i < size * size; i++) {
    const offset = i * TILE_BYTE_SIZE;
    sharedMapView.setUint16(offset, 65535, true); // factionIndex
    sharedMapView.setUint32(offset + 2, 0xffffff, true); // colorInt
    sharedMapView.setUint32(offset + 6, 0, true); // paintedByIndex (0 = none)
    sharedMapView.setUint8(offset + 10, 0); // overpaint
    sharedMapView.setUint8(offset + 11, 0); // flags
    // offset 12-19 expiry
    sharedMapView.setFloat64(offset + 12, 0, true);
    // offset 20-23 paintedAt
    sharedMapView.setUint32(offset + 20, 0, true);
  }

  for (const key in mapState.tiles) {
    const tile = mapState.tiles[key];
    const [x, y] = key.split("_").map(Number);
    if (x >= 0 && x < size && y >= 0 && y < size) {
      const offset = (y * size + x) * TILE_BYTE_SIZE;

      // [Structure Update: 24 bytes / 8-byte alignment]
      let fid = tile.factionId || tile.faction;
      // [CLEANUP] 存在しない勢力IDの場合はクリアする
      if (fid && !factionIdToIndex.has(fid)) {
        // console.warn(`[Sync] Found invalid factionId: ${fid} at ${key}. Clearing tile.`);
        fid = null;
      }

      const fidIdx = getFactionIdx(fid);
      sharedMapView.setUint16(offset + 0, fidIdx, true);

      const colorStr = tile.customColor || tile.color || "#ffffff";
      let colorInt = parseInt(colorStr.replace("#", ""), 16);
      if (Number.isNaN(colorInt)) colorInt = 0xffffff;
      sharedMapView.setUint32(offset + 2, colorInt, true);

      const pIdx = getPlayerIdx(tile.paintedBy);
      sharedMapView.setUint32(offset + 6, pIdx, true);

      sharedMapView.setUint8(offset + 10, tile.overpaint || 0);

      let flags = 0;
      let exp = 0;
      if (tile.core) {
        flags |= 1;
        exp = new Date(tile.core.expiresAt || 0).getTime();
      }
      if (tile.coreificationUntil) {
        flags |= 2;
        exp = new Date(tile.coreificationUntil).getTime();
      }
      if (Number.isNaN(exp)) exp = 0; // Prevent NaN in SAB

      sharedMapView.setUint8(offset + 11, flags);
      // offset 12-15 padding
      // offset 12-19 expiry
      sharedMapView.setFloat64(offset + 12, exp, true);

      // [NEW] paintedAt (seconds) - offset 20 (4 bytes)
      const pAt = tile.paintedAt
        ? Math.floor(new Date(tile.paintedAt).getTime() / 1000)
        : 0;
      sharedMapView.setUint32(offset + 20, pAt, true);
    }
  }

  // [NEW] Rebuild Faction Stats & ZOC
  factionStatsView.fill(0);
  // sharedZocMapView.fill(0); // Already cleared at start

  // Load named cells for point calculation
  const namedCells = loadJSON(NAMED_CELLS_PATH, {});

  for (let i = 0; i < size * size; i++) {
    const offset = i * TILE_BYTE_SIZE;
    const fidIdx = sharedMapView.getUint16(offset, true);
    if (fidIdx !== 65535 && fidIdx < MAX_FACTIONS_LIMIT) {
      const parsedIdx = fidIdx * STATS_INTS_PER_FACTION;
      Atomics.add(factionStatsView, parsedIdx + 0, 1); // tileCount

      // Points
      const x = i % size;
      const y = Math.floor(i / size);
      const points = getTilePoints(x, y, namedCells);
      Atomics.add(factionStatsView, parsedIdx + 4, points); // totalPoints (Offset 4)

      const flags = sharedMapView.getUint8(offset + 11);
      if (flags & 1) {
        const exp = sharedMapView.getFloat64(offset + 12, true);
        if (exp === 0 || exp > Date.now()) {
          Atomics.add(factionStatsView, parsedIdx + 1, 1); // coreCount
        }
      }
    }
  }

  // [NEW] Recalculate ZOC SAB
  const factionsData = loadJSON(FACTIONS_PATH, { factions: {} });
  recalculateZocSAB(namedCells, factionsData);
}

// [NEW] ZOC SAB Recalculation
const ZOC_RADIUS = 5;
function recalculateZocSAB(namedCells, factionsData) {
  sharedZocMapView.fill(0); // 0 = no ZOC owner

  if (!namedCells) return;
  const size = 500;
  const multiIdx = 65534; // Conflict

  Object.values(namedCells).forEach((cell) => {
    const fid = cell.factionId;
    if (!fid || !factionsData.factions[fid]) return;
    const idx = getFactionIdx(fid);
    if (!idx) return;

    if (!cell || !cell.key) return; // [FIX] Add safety check
    const [cx, cy] = cell.key.split("_").map(Number);
    // Chebyshev Distance 5
    for (let dy = -ZOC_RADIUS; dy <= ZOC_RADIUS; dy++) {
      for (let dx = -ZOC_RADIUS; dx <= ZOC_RADIUS; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;

        const offset = ny * size + nx;
        const current = sharedZocMapView[offset];

        if (current === 0) {
          sharedZocMapView[offset] = idx;
        } else if (current !== idx && current !== multiIdx) {
          sharedZocMapView[offset] = multiIdx;
        }
      }
    }
  });
}
const FILE_CACHE = new Map(); // filePath -> { data, mtimeMs, lastStatTime }
const writeQueue = new Map(); // filePath -> { pendingData: any, isWriting: boolean }

// [FIX] Windows環境でのアトミックな書き換え (rename) 競合を防ぐための再試行ロジック
async function safeRename(oldPath, newPath, retries = 5, delay = 100) {
  for (let i = 0; i < retries; i++) {
    try {
      await fs.promises.rename(oldPath, newPath);
      return;
    } catch (err) {
      if (err.code === "EPERM" || err.code === "EBUSY") {
        const isLast = i === retries - 1;
        if (!isLast) {
          await new Promise((resolve) =>
            setTimeout(resolve, delay * Math.pow(2, i)),
          );
          continue;
        }
      }
      throw err;
    }
  }
}

// メモリ更新 & ディスク保存 (非同期Worker版 - 非ブロッキング順序保証)
async function saveJSON(filePath, data, options = {}) {
  if (!filePath) {
    console.error("saveJSON called without filePath");
    return;
  }

  // 1. メインスレッドのキャッシュを即座に更新して、後続の読み込みが最新を参照できるようにする
  // これにより、ディスク書き込みを待たずにロックを解放可能になる
  const stats = { mtimeMs: Date.now() };
  FILE_CACHE.set(filePath, {
    data,
    mtimeMs: stats.mtimeMs,
    lastStatTime: stats.mtimeMs,
  });

  // [NEW] マップデータの更新を SAB にも即時反映 (差分のみ)
  if (filePath === MAP_STATE_PATH && data && data.tiles) {
    syncSABWithJSON(data);
    saveMapBinary(); // 引数は不要（内部でグローバル SAB を使用）
  } else if (filePath === NAMED_CELLS_PATH && data) {
    // [NEW] Recalculate ZOC when named cells change
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    recalculateZocSAB(data, factions);
  }

  // 2. 書き込みキューの管理
  if (!writeQueue.has(filePath)) {
    writeQueue.set(filePath, {
      pendingData: null,
      isWriting: false,
      waiters: [],
      skipLock: false,
    });
  }

  const queue = writeQueue.get(filePath);
  queue.pendingData = data; // 常に最新の状態を「次回の書き込み」としてセット
  if (options.skipLock) queue.skipLock = true; // バッチ内に一つでも skipLock があれば適用

  // 完了待機用のPromiseを作成
  const writePromise = new Promise((resolve) => {
    queue.waiters.push(resolve);
  });

  if (!queue.isWriting) {
    processWriteQueue(filePath);
  }

  return writePromise;
}

async function processWriteQueue(filePath) {
  const queue = writeQueue.get(filePath);
  if (!queue || (queue.pendingData === null && queue.waiters.length === 0)) {
    if (queue) queue.isWriting = false;
    return;
  }

  queue.isWriting = true;
  const dataToSave = queue.pendingData;
  const currentWaiters = [...queue.waiters];
  const skipLock = queue.skipLock;

  queue.pendingData = null; // キューから取り出す
  queue.waiters = [];
  queue.skipLock = false;

  try {
    if (dataToSave !== null) {
      const dataString = JSON.stringify(dataToSave, null, 2);
      if (dataString.length < 1024 * 1024) {
        const saveOp = async () => {
          const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
          await fs.promises.writeFile(tempPath, dataString, "utf-8");
          await safeRename(tempPath, filePath);
        };

        if (skipLock) {
          await saveOp();
        } else {
          await LockManager.withLock(filePath, saveOp);
        }
      } else {
        await runWorkerTask("SAVE_JSON", {
          filePath,
          data: dataToSave,
          skipLock,
        });
      }
    }

    // [FIX] Update cache mtime after successful write to prevent reload
    if (dataToSave !== null) {
      try {
        const stats = await fs.promises.stat(filePath);
        const cached = FILE_CACHE.get(filePath);
        if (cached) {
          cached.mtimeMs = stats.mtimeMs;
          cached.lastStatTime = Date.now();
        }
      } catch {
        // ignore
      }
    }

    currentWaiters.forEach((resolve) => resolve());
  } catch (err) {
    console.error(`[processWriteQueue] Error saving ${filePath}:`, err);
    currentWaiters.forEach((resolve) => resolve());
  }

  setImmediate(() => processWriteQueue(filePath));
}

function loadJSON(filePath, defaultValue = {}, ignoreCache = false) {
  try {
    if (!fs.existsSync(filePath)) {
      return defaultValue;
    }

    const cached = FILE_CACHE.get(filePath);
    const now = Date.now();

    const stats = fs.statSync(filePath);
    if (!ignoreCache && cached && cached.mtimeMs >= stats.mtimeMs) {
      cached.lastStatTime = now;
      return cached.data;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw.trim()) {
      return cached ? cached.data : defaultValue;
    }

    const data = JSON.parse(raw);
    FILE_CACHE.set(filePath, {
      data,
      mtimeMs: stats.mtimeMs,
      lastStatTime: now,
    });

    /* [FIX] Redundant Sync moved to explicit initialization
    if (filePath === MAP_STATE_PATH) {
      // console.log("[Init] Syncing SAB with JSON map data...");
      // syncSABWithJSON(data);
    }
    */

    return data;
  } catch (e) {
    if (!ignoreCache && FILE_CACHE.has(filePath)) {
      return FILE_CACHE.get(filePath).data;
    }
    console.error(
      `[Persistence] Error reading ${path.basename(filePath)}:`,
      e.message,
    );
    return defaultValue;
  }
}

// [NEW] バイナリマップの保存
async function saveMapBinary() {
  const buffer = Buffer.from(sharedMapSAB);
  const tempPath = `${MAP_STATE_BIN_PATH}.tmp.${process.pid}.${Date.now()}`;
  await fs.promises.writeFile(tempPath, buffer);
  await safeRename(tempPath, MAP_STATE_BIN_PATH);
  console.log(`[BinaryMap] Persisted binary map to ${MAP_STATE_BIN_PATH}`);
}

// [NEW] バイナリマップのロード (Unused, removed to fix lint)
// function loadMapBinary() { ... }

// [NEW] Merger Settings Defaults
const DEFAULT_MERGER_SETTINGS = {
  prohibitedRank: 0, // Top N factions cannot merge (be absorbed)
};

// 設定ロード (with defaults)
const initialSettings = loadJSON(SYSTEM_SETTINGS_PATH, DEFAULT_MERGER_SETTINGS);
if (!initialSettings.prohibitedRank) {
  initialSettings.prohibitedRank = 5;
  saveJSON(SYSTEM_SETTINGS_PATH, initialSettings);
}

// [NEW] ランキングキャッシュ (Global)
let cachedFactionRanks = [];

function loadSystemSettings() {
  const settings = loadJSON(SYSTEM_SETTINGS_PATH, {});
  if (!settings.mergerSettings)
    settings.mergerSettings = { ...DEFAULT_MERGER_SETTINGS };
  settings.mergerSettings = {
    ...DEFAULT_MERGER_SETTINGS,
    ...settings.mergerSettings,
  };
  return settings;
}

// [NEW] ランキング定期更新ループ (Worker版)
async function updateRankingCache() {
  try {
    console.log("[Rank] Offloading full ranking calculation to Worker...");
    const result = await runWorkerTask("CALCULATE_RANKS", {
      filePaths: {
        mapState: MAP_STATE_PATH,
        factions: FACTIONS_PATH,
        players: PLAYERS_PATH,
        settings: SYSTEM_SETTINGS_PATH,
        gameIds: GAME_IDS_PATH,
        alliances: ALLIANCES_PATH,
        namedCells: NAMED_CELLS_PATH,
      },
    });

    if (result.success && result.results && result.results.ranks) {
      cachedFactionRanks = result.results.ranks;
      console.log(
        `[Rank] Ranking cache updated. Count: ${cachedFactionRanks.length}`,
      );

      const updates = cachedFactionRanks.map((r) => ({
        id: r.id,
        rank: r.rank,
        isWeak: r.isWeak,
        points: r.points,
      }));

      if (updates.length > 0) {
        if (typeof io !== "undefined" && io)
          io.emit("ranking:updated", updates);
      }
    } else if (!result.success) {
      console.error("[Rank] Worker calculation failed:", result.error);
    }
  } catch (err) {
    console.error("Failed to update ranking cache:", err);
  }
}
setInterval(updateRankingCache, 15 * 1000); // 15秒ごとに更新

// [OPTIMIZATION] 中核化維持・確定・自動拡大処理 (Worker完全オフロード版)
async function runCoreMaintenanceFull() {
  try {
    // console.log("[Maintenance] Running consolidated core maintenance via Worker...");
    const result = await runWorkerTask("CORE_MAINTENANCE_FULL", {
      filePaths: {
        mapState: MAP_STATE_PATH,
        factions: FACTIONS_PATH,
        players: PLAYERS_PATH,
        settings: SYSTEM_SETTINGS_PATH,
        gameIds: GAME_IDS_PATH,
        alliances: ALLIANCES_PATH,
        namedCells: NAMED_CELLS_PATH,
      },
    });

    if (result.success) {
      // ログなど必要なら
      if (result.results && result.results.coreStatus) {
        // console.log("[Maintenance] Core updated:", result.results.coreStatus);
      }
    } else {
      console.error(
        "[Maintenance] Worker reported failure:",
        result.error || "Unknown error",
      );
    }
  } catch (e) {
    console.error("[Maintenance] Error in core maintenance process:", e);
  }
}

console.log(`[Init] DATA_DIR resolved to: ${DATA_DIR}`);

// 残留一時ファイルおよびロックのクリーンアップ
function cleanupTempFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    let count = 0;
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        if (file.endsWith(".lock")) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          count++;
        } else {
          cleanupTempFiles(fullPath);
        }
      } else if (file.includes(".tmp")) {
        fs.unlinkSync(fullPath);
        count++;
      }
    }
    if (count > 0) {
      console.log(
        `[Init] Cleanup removed ${count} residual temp files or locks in ${dir}`,
      );
    }
  } catch (e) {
    console.error(`[Init] Cleanup error in ${dir}:`, e.message);
  }
}

cleanupTempFiles(DATA_DIR);
// --------------------------------------------------------------------------

const app = express();
const server = http.createServer(app);

// [OPTIMIZATION] HTTP Compression
app.use(compression());

// [NEW] SharedArrayBuffer有効化のためのCross-Origin-Isolation (COOP/COEP) ヘッダー
// メインスレッドとWebWorker間でSharedArrayBufferを使用するために必要
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
});

// ワーカープールの初期化
const { Worker } = require("worker_threads");
const numCPUs = require("os").cpus().length;
// [OPTIMIZATION] APIレスポンスとSocket.ioの安定性のために、論理コア数 - 1 のWorkerを使用
const numWorkers = numCPUs >= 2 ? numCPUs - 1 : 1;
const isPM2 = process.env.NODE_APP_INSTANCE !== undefined;

const workers = [];
const workerTasks = new Map();
let taskIdCounter = 0;
// 負荷分散 (ロードバランシング)
const workerLoad = new Array(numWorkers).fill(0);

console.log(
  `[Init] Starting Worker Pool with ${numWorkers} workers... (PM2: ${isPM2})`,
);

for (let i = 0; i < numWorkers; i++) {
  const worker = new Worker(path.join(__dirname, "worker.js"), {
    workerData: {
      sharedMapSAB,
      sharedZocMapSAB,
      factionStatsSAB,
      MAX_FACTIONS_LIMIT,
      STATS_INTS_PER_FACTION,
    },
    resourceLimits: {
      maxOldGenerationSizeMb: 512, // 個別のWorkerをより厳しく制限
    },
  });
  worker.on("message", (msg) => {
    if (msg.taskId !== undefined && workerTasks.has(msg.taskId)) {
      const { resolve } = workerTasks.get(msg.taskId);
      workerTasks.delete(msg.taskId);
      // 論理的なエラー（success: false）であっても常にメッセージ全体でresolveする
      // システムエラーの場合のみrejectするが、ここではワーカーからのメッセージを有効な応答として扱う
      resolve(msg);
    }
  });
  worker.on("error", (err) => {
    console.error(`[Worker ${i}] Error:`, err);
  });
  workers.push(worker);
}

function runWorkerTask(type, data) {
  return new Promise((resolve, reject) => {
    const taskId = taskIdCounter++;
    workerTasks.set(taskId, { resolve, reject });

    // 最小保留タスク戦略（Least Pending Tasks）
    let minLoad = Infinity;
    let workerId = 0;
    for (let i = 0; i < numWorkers; i++) {
      if (workerLoad[i] < minLoad) {
        minLoad = workerLoad[i];
        workerId = i;
      }
    }

    // タスクを割り当て
    workerLoad[workerId]++;
    // console.log(`[WorkerPool] Assigning task ${taskId} to Worker ${workerId} (Load: ${workerLoad[workerId]})`);

    const worker = workers[workerId];

    // 完了時に負荷を減らすためにresolve/rejectをラップする
    const originalResolve = resolve;
    const originalReject = reject;

    const cleanup = () => {
      worker.off("error", errorHandler);
      worker.off("exit", exitHandler);
    };

    const errorHandler = (err) => {
      cleanup();
      workerLoad[workerId]--;
      originalReject(err);
    };

    const exitHandler = (code) => {
      cleanup();
      if (code !== 0) {
        workerLoad[workerId]--;
        originalReject(new Error(`Worker stopped with exit code ${code}`));
      }
    };

    worker.on("error", errorHandler);
    worker.on("exit", exitHandler);

    workerTasks.set(taskId, {
      resolve: (val) => {
        cleanup();
        workerLoad[workerId]--;
        originalResolve(val);
      },
      reject: (err) => {
        cleanup();
        workerLoad[workerId]--;
        originalReject(err);
      },
    });

    let injectedData = { ...data };

    // パス情報を注入 (ワーカーが自力でロードできるように)
    injectedData.filePaths = {
      ...(injectedData.filePaths || {}), // 既存のパス（gameIds等）を保持
      mapState: MAP_STATE_PATH,
      factions: FACTIONS_PATH,
      players: PLAYERS_PATH,
      alliances: ALLIANCES_PATH,
      truces: TRUCES_PATH,
      wars: WARS_PATH,
      namedCells: NAMED_CELLS_PATH,
    };

    // [NEW] SharedArrayBuffer を Worker に共有 (メモリ節約の要)
    injectedData.mapSAB = sharedMapSAB;
    injectedData.indexToFactionId = indexToFactionId;
    injectedData.playerIds = playerIds; // [NEW] Player ID Mapping for Worker

    // [NEW] システム設定を注入 (CoreTile設定などWorkerが必要とするため)
    // 毎回ロードするのは少しコストだが、設定変更を即時反映させるため
    try {
      const settings = loadJSON(SYSTEM_SETTINGS_PATH, {
        isGameStopped: false,
      });
      if (settings.coreTileSettings) {
        injectedData.coreTileSettings = settings.coreTileSettings;
      }
      // 必要なら他の設定もここで注入可能
      if (settings.namedTileSettings) {
        injectedData.namedTileSettings = settings.namedTileSettings;
      }
      if (settings.enclaveSettings) {
        injectedData.enclaveSettings = settings.enclaveSettings;
      }
    } catch (e) {
      console.error("[WorkerDispatch] Failed to load settings for worker:", e);
    }

    worker.postMessage({
      taskId,
      workerId,
      type,
      data: injectedData,
    });
  });
}

/**
 * [OPTIMIZATION] 複数のWorkerに並列でタスクを分散し、結果をマージして返す
 * @param {string} type - タスクタイプ
 * @param {Object} baseData - すべてのWorkerに共通で渡すデータ
 * @param {Array} chunks - 各Workerに分割して渡すタイルチャンク配列
 * @param {Function} mergeResults - 結果をマージする関数
 * @returns {Promise<Object>} マージされた結果
 */
async function runParallelWorkerTasks(type, baseData, chunks, mergeResults) {
  const tasks = chunks.map((chunk, index) => {
    return runWorkerTask(type, {
      ...baseData,
      tiles: chunk,
      chunkIndex: index,
    });
  });

  const results = await Promise.all(tasks);

  // エラーチェック
  for (const result of results) {
    if (!result.success) {
      return result; // 最初のエラーを返す
    }
  }

  // 結果をマージ
  return mergeResults(results);
}

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      return callback(null, true);
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// ユーザー名生成

// --- [NEW] ソケット管理の最適化 ---
const playerSocketMap = new Map(); // playerId -> Set<Socket> (1人複数タブ対応)

// --- [NEW] 非ブロッキング順次書き込みキュー ---

// --- [NEW] Dynamic Cookie Helper ---
const getCookieName = (req, baseName) => {
  // reqがなければデフォルトを返す（稀なケース）
  if (!req || !req.headers || !req.headers.host) return baseName;

  const host = req.headers.host.split(":")[0]; // remove port
  const parts = host.split(".");

  // localhost (parts=1) or example.com (parts=2) -> no prefix
  // sub.localhost (parts=2) -> check localhost
  // sub.example.com (parts=3) -> prefix = sub

  // 簡易的な判定:
  // localhostの場合: ドットが1つ以上あればサブドメインあり
  // それ以外(IP除く): ドットが2つ以上あればサブドメインありとみなす

  let subdomain = null;
  if (host === "localhost") {
    // localhost has no subdomain by itself
  } else if (host.endsWith("localhost")) {
    // e.g. sub.localhost
    if (parts.length >= 2) {
      subdomain = parts[0];
    }
  } else {
    // e.g. sub.teien-seiryokuzu.com -> parts.length=3
    // ip address (1.2.3.4) -> parts.length=4 but all numbers... skip IP check for now as usually domain is used
    if (parts.length >= 3) {
      subdomain = parts[0];
    }
  }

  if (subdomain) {
    return `${subdomain}_${baseName}`;
  }
  return baseName;
};

// [NEW] 管理者IDの読み込み
let currentAdminIdGlobal = null;
function loadAdminId() {
  try {
    if (fs.existsSync(ADMIN_ID_PATH)) {
      currentAdminIdGlobal = fs.readFileSync(ADMIN_ID_PATH, "utf-8").trim();
      console.log(`[Admin] Loaded Admin ID: ${currentAdminIdGlobal}`);
    } else {
      currentAdminIdGlobal = null;
    }
  } catch (e) {
    console.error("[Admin] Failed to load admin-id.txt:", e);
    currentAdminIdGlobal = null;
  }
}

// 初期読み込みと監視
loadAdminId();
if (fs.existsSync(DATA_DIR)) {
  fs.watch(DATA_DIR, (eventType, filename) => {
    if (filename === "admin-id.txt") {
      loadAdminId();
    }
  });
}

// [OPTIMIZATION] Persistence Throttling & Buffering
let playerSaveTimer = null;
let factionSaveTimer = null;
let pendingActivityLogs = [];
let activityLogSaveTimer = null;
const PLAYER_SAVE_INTERVAL = 30 * 1000; // 30 seconds
const FACTION_SAVE_INTERVAL = 30 * 1000; // 30 seconds
const LOG_SAVE_INTERVAL = 30 * 1000; // 30 seconds
const LOG_BUFFER_THRESHOLD = 50;

// プレイヤーデータの遅延保存
function queuePlayerSave() {
  if (playerSaveTimer) return;
  playerSaveTimer = setTimeout(() => {
    persistPlayerState();
  }, PLAYER_SAVE_INTERVAL);
}

async function persistPlayerState() {
  if (playerSaveTimer) {
    clearTimeout(playerSaveTimer);
    playerSaveTimer = null;
  }
  const playersEntry = FILE_CACHE.get(PLAYERS_PATH);
  if (playersEntry && playersEntry.data) {
    await saveJSON(PLAYERS_PATH, playersEntry.data);
    // [DEBUG] Log saved AP for debugging
    const pIds = Object.keys(playersEntry.data.players || {});
    if (pIds.length > 0) {
      const samplePid = pIds[0];
      console.log(
        `[IO] Persisted players.json. Sample ${samplePid} AP: ${playersEntry.data.players[samplePid].ap}`,
      );
    } else {
      console.log(`[IO] Persisted players.json (0 players)`);
    }
  } else {
    console.warn("[IO] persistPlayerState called but no data in cache");
  }
}

// 勢力データの遅延保存
function queueFactionSave() {
  if (factionSaveTimer) return;
  factionSaveTimer = setTimeout(() => {
    persistFactionState();
  }, FACTION_SAVE_INTERVAL);
}

async function persistFactionState() {
  if (factionSaveTimer) {
    clearTimeout(factionSaveTimer);
    factionSaveTimer = null;
  }
  const factionsEntry = FILE_CACHE.get(FACTIONS_PATH);
  if (factionsEntry && factionsEntry.data) {
    await saveJSON(FACTIONS_PATH, factionsEntry.data);
    console.log("[IO] Persisted factions.json (Throttled)");
  }
}

// アクティビティログの遅延保存
async function persistActivityLogs() {
  if (activityLogSaveTimer) {
    clearTimeout(activityLogSaveTimer);
    activityLogSaveTimer = null;
  }
  if (pendingActivityLogs.length === 0) return;

  const logsToPersist = [...pendingActivityLogs];
  pendingActivityLogs = [];

  let log = loadJSON(ACTIVITY_LOG_PATH, { entries: [] });
  if (!log || typeof log !== "object") log = { entries: [] };
  if (!Array.isArray(log.entries)) log.entries = [];

  // 前方に挿入 (新しいものが先)
  // pendingActivityLogs は push されているので [oldest, ..., newest]
  // ここでは新しい順に prepend したいので reverse するか、slice して unshift する
  log.entries.unshift(...logsToPersist.reverse());
  if (log.entries.length > 10000) {
    log.entries = log.entries.slice(0, 10000);
  }

  await saveJSON(ACTIVITY_LOG_PATH, log);
  console.log(
    `[IO] Persisted activity_log.json (${logsToPersist.length} entries buffered)`,
  );
}

let tileUpdateBuffer = {};
let batchTimer = null;
let activityLogBuffer = [];
let activityLogTimer = null;

function batchEmitTileUpdate(updates) {
  Object.assign(tileUpdateBuffer, updates);
  if (!batchTimer) {
    batchTimer = setTimeout(async () => {
      const keys = Object.keys(tileUpdateBuffer);
      if (keys.length > 0) {
        // [Phase 7] Ensure SAB is up-to-date before serialization (Worker or Main)
        if (sharedMapView) {
          keys.forEach((key) => {
            const tile = tileUpdateBuffer[key];
            if (!tile) return; // Should not happen
            const [x, y] = key.split("_").map(Number);
            const tileOffset = (y * MAP_SIZE + x) * TILE_BYTE_SIZE;

            // Map strings to indices
            const fidIdx = getFactionIdx(tile.factionId || tile.faction);
            const pIdx = getPlayerIdx(tile.paintedBy);

            // Color
            const colorStr = tile.customColor || tile.color || "#ffffff";
            const colorInt =
              parseInt(colorStr.replace("#", ""), 16) || 0xffffff;

            // Flags/Expiry
            let flags = 0;
            let exp = 0;
            if (tile.core) {
              flags |= 1;
              exp = new Date(tile.core.expiresAt || 0).getTime();
            }
            if (tile.coreificationUntil) {
              flags |= 2;
              exp = new Date(tile.coreificationUntil).getTime();
            }

            // paintedAt
            const pAtVal = tile.paintedAt
              ? Math.floor(new Date(tile.paintedAt).getTime() / 1000)
              : 0;

            // Write to SAB (24 bytes)
            // 0-1: fidIdx
            sharedMapView.setUint16(tileOffset + 0, fidIdx, true);
            // 2-5: color
            sharedMapView.setUint32(tileOffset + 2, colorInt, true);
            // 6-9: pidIdx
            sharedMapView.setUint32(tileOffset + 6, pIdx, true);
            // 10: overpaint
            sharedMapView.setUint8(tileOffset + 10, tile.overpaint || 0);
            // 11: flags
            sharedMapView.setUint8(tileOffset + 11, flags);
            // 12-19: expiry (unaligned but safe - fixes overlap with paintedAt)
            sharedMapView.setFloat64(tileOffset + 12, exp, true);
            // 20-23: paintedAt
            sharedMapView.setUint32(tileOffset + 20, pAtVal, true);
          });
        }

        // [OPTIMIZATION] 大規模な更新（500枚以上）の場合は Worker へシリアライズをオフロード
        if (keys.length >= 500 && numWorkers > 0) {
          try {
            const currentUpdates = { ...tileUpdateBuffer };
            tileUpdateBuffer = {}; // 送信用コピーを取ったのでクリア

            const result = await runWorkerTask("SERIALIZE_TILE_UPDATES", {
              tileUpdateBuffer: currentUpdates,
            });

            if (result.success && result.results && result.results.binary) {
              io.emit("tile:update:bin", result.results.binary);
            } else {
              throw new Error("Worker serialization failed");
            }
          } catch (e) {
            console.error("[SocketOffload] Failed:", e);
            // フォールバックはバッファがクリアされているため、再試行はしない（次のバッチで送られるか、整合性チェックで直る）
          }
        } else {
          // 少量の場合はメインスレッドで高速処理
          // 少量の場合はメインスレッドで高速処理 (SAB直接読み取り版 - Phase 7)
          const PACKET_SIZE = 28;
          const totalSize = 2 + keys.length * PACKET_SIZE;
          const buffer = Buffer.allocUnsafe(totalSize);

          let offset = 0;
          buffer.writeUInt16LE(keys.length, offset);
          offset += 2;

          keys.forEach((key) => {
            const [x, y] = key.split("_").map(Number);

            // Write Coords
            buffer.writeUInt16LE(x, offset);
            buffer.writeUInt16LE(y, offset + 2);

            // direct read from SAB (24 bytes)
            if (sharedMapView) {
              const tileOffset = (y * MAP_SIZE + x) * TILE_BYTE_SIZE;

              const fidIdx = sharedMapView.getUint16(tileOffset + 0, true);
              const color = sharedMapView.getUint32(tileOffset + 2, true);
              const pidIdx = sharedMapView.getUint32(tileOffset + 6, true);
              const over = sharedMapView.getUint8(tileOffset + 10);
              const flags = sharedMapView.getUint8(tileOffset + 11);
              const exp = sharedMapView.getFloat64(tileOffset + 12, true);
              const pAt = sharedMapView.getUint32(tileOffset + 20, true);

              buffer.writeUInt16LE(fidIdx, offset + 4);
              buffer.writeUInt32LE(color, offset + 6);
              buffer.writeUInt32LE(pidIdx, offset + 10);
              buffer.writeUInt8(over, offset + 14);
              buffer.writeUInt8(flags, offset + 15);
              buffer.writeDoubleLE(exp, offset + 16);
              buffer.writeUInt32LE(pAt, offset + 24);
            } else {
              buffer.fill(0, offset + 4, offset + 28);
            }

            offset += PACKET_SIZE;
          });

          io.emit("tile:update:bin", buffer);
          tileUpdateBuffer = {};
        }
      }
      batchTimer = null;
    }, 100);
  }
}

function batchEmitActivityLog(entry) {
  activityLogBuffer.push(entry);
  if (!activityLogTimer) {
    activityLogTimer = setTimeout(() => {
      if (activityLogBuffer.length > 0) {
        // 大量にある場合は最新10件程度に絞るか、そのまま送る
        const toSend = activityLogBuffer.slice(-20);
        toSend.forEach((log) => io.emit("activity:new", log));
        activityLogBuffer = [];
      }
      activityLogTimer = null;
    }, 500); // ログは少し長めのスパンで
  }
}

let lastOnlineCount = 0;
let lastOnlineEmitTime = 0;
let onlineCountTimer = null;

let apBucketBuffer = [];
let apBucketTimer = null;

let factionUpdateTimer = null;

function batchEmitFactionsUpdate(immediate = false) {
  const run = () => {
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const enrichedFactions = Object.keys(factions.factions).map((fid) =>
      getEnrichedFaction(fid, factions, players),
    );
    io.emit("factions:update", enrichedFactions);
    factionUpdateTimer = null;
  };

  if (immediate) {
    if (factionUpdateTimer) {
      clearTimeout(factionUpdateTimer);
      factionUpdateTimer = null;
    }
    run();
    return;
  }

  if (!factionUpdateTimer) {
    factionUpdateTimer = setTimeout(run, 500);
  }
}

function batchEmitAPBucketCheck(data) {
  apBucketBuffer.push(data);
  if (!apBucketTimer) {
    apBucketTimer = setTimeout(() => {
      if (apBucketBuffer.length > 0) {
        // 最新の状態だけ送れば良いので、最後の一つを取得
        const latest = apBucketBuffer[apBucketBuffer.length - 1];
        io.emit("ap:bucket_check", latest);
        apBucketBuffer = [];
      }
      apBucketTimer = null;
    }, 100);
  }
}

function throttledUpdateOnlineCount() {
  const now = Date.now();
  const COOLDOWN = 5000;

  if (now - lastOnlineEmitTime < COOLDOWN) {
    // クールダウン中なら、後で実行するようにスケジュール(trailing edge)
    if (!onlineCountTimer) {
      const delay = COOLDOWN - (now - lastOnlineEmitTime);
      onlineCountTimer = setTimeout(() => {
        onlineCountTimer = null;
        throttledUpdateOnlineCount();
      }, delay + 100);
    }
    return;
  }

  // タイマーがあればキャンセル（今実行するため）
  if (onlineCountTimer) {
    clearTimeout(onlineCountTimer);
    onlineCountTimer = null;
  }

  const uniqueIps = new Set();
  if (io && io.sockets && io.sockets.sockets) {
    io.sockets.sockets.forEach((s) => {
      const key = s.playerId || s.handshake.address;
      uniqueIps.add(key);
    });
  }

  if (uniqueIps.size !== lastOnlineCount) {
    lastOnlineCount = uniqueIps.size;
    lastOnlineEmitTime = now;
    io.emit("online:count", lastOnlineCount);
  }
}

// 権限チェックヘルパー

// --------------------------------------------------------------------------

// ミドルウェア
// origin: true は認証情報に必要なリクエストオリジンを許可します
app.use(cors({ origin: true, credentials: true }));
app.use(compression({ level: 1 })); // CPU負荷軽減のためレベルを最低に設定
app.use(express.json({ limit: "50mb" }));
app.use(cookieParser());

// キャッシュ無効化ミドルウェア (開発用)
app.use((req, res, next) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});

// 静的ファイル配信 (プロダクション用)
app.use(express.static(path.join(__dirname, "../client/dist")));
app.use("/admin", express.static(path.join(__dirname, "../admin")));
app.use("/temp", express.static(path.join(__dirname, "../temp"))); // 割譲マップ画像用
app.set("trust proxy", true);

// データファイルパス
// データファイルパス
// ファイル先頭に移動済み
try {
  fs.writeFileSync(
    path.join(DATA_DIR, "write_test.txt"),
    `Server started at ${new Date().toISOString()}`,
  );
  console.log(
    `[Init] Write test successful: ${path.join(DATA_DIR, "write_test.txt")}`,
  );
} catch (e) {
  console.error(`[Init] Write test FAILED:`, e);
}

// ヘルパー関数: In-Memory DB
// [REFRACTOR] MEMORY_DBは削除されました。直接ディスクアクセスを使用します。
// const MEMORY_DB = {};
// const DIRTY_FLAGS = new Set();

// RAMキャッシュ対象外のファイル（認証データと履歴データ）
// 読み込み・書き込み時に常にディスクを直接参照する

// 初期ロード (同期) - サーバー起動時に呼び出す・または初回アクセス時にロード

// [REFRACTOR] メモリキャッシュ付きダイレクトディスクアクセスモード
// 今後の方針: ディスクチェックによる手動編集を常にサポートする
// 最適化: パース済みのオブジェクトをキャッシュし、冗長な JSON.parse() を回避

// 1. 各種データのロード
const factions = loadJSON(FACTIONS_PATH, { factions: {} });
const players = loadJSON(PLAYERS_PATH, {});
const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });

// 2. マッピングの再構築（IDソートにより順序を固定）
rebuildStableMappings(factions, players);

// 3. SAB の同期 (バイナリからのロードよりも JSON (Truth) を優先して一度クリーンアップ)
syncSABWithJSON(mapState);
saveMapBinary(); // JSON の内容でバイナリファイルを即座に更新

// [FIX] Initialize Ranking Cache Immediately
updateRankingCache();

const syncCount = Object.keys(mapState.tiles || {}).length;
console.log(
  `[Init] Map data initialized and synced from JSON. Total tiles: ${syncCount}, TILE_BYTE_SIZE: ${TILE_BYTE_SIZE}`,
);

// game_ids.json の変更を監視してホットリロードする
if (fs.existsSync(GAME_IDS_PATH)) {
  let fsWait = false;
  const targetFile = path.basename(GAME_IDS_PATH);
  // Windowsでの安定性のために、ファイル本体ではなく親ディレクトリを監視する。
  // これによりアトミックなファイル置換（rename）も確実に検知できる。
  fs.watch(DATA_DIR, (event, filename) => {
    if (filename !== targetFile) return;
    if (fsWait) return;
    fsWait = setTimeout(() => {
      fsWait = false;
    }, 500);

    // [FIX] Windowsでのアトミックrename完了待ちのためのディレイ
    setTimeout(() => {
      console.log(`[Watcher] ${targetFile} changed (${event}). Reloading...`);
      try {
        loadJSON(GAME_IDS_PATH, {}, true); // ignoreCache=trueで強制リロード
        loadJSON(GAME_IDS_PATH, {}, true); // ignoreCache=trueで強制リロード
        // processSecretTriggersはWorker経由で周期的（5分）に行われるようになった
        // しかし、ファイルの変更時は即時反映のために一度実行する
        processSecretTriggers(false).catch((e) =>
          console.error("[Watcher] SecretTrigger Check Error:", e),
        );
      } catch (e) {
        console.error(`[Watcher] Reload error:`, e.message);
      }
    }, 200);
  });
}

// JSON更新ヘルパー (ロック付き)

async function updateJSON(filePath, updateFn, defaultValue = {}) {
  // [OPTIMIZATION] マップ状態の更新はメモリ上で行い、ディスク保存を遅延させる
  // [OPTIMIZATION RESTORED] マップ状態の更新はメモリ上で行い、ディスク保存を遅延させる (CPU負荷対策)
  // 以前の巻き戻りバグは ignoreCache=true や race condition が原因であり、それらは修正済み。
  // 安全のため、閾値を下げて (30秒 or 100変更) 運用する。
  if (filePath === MAP_STATE_PATH) {
    return LockManager.withLock(filePath, async () => {
      // メモリ上の最新データを取得 (ディスク読み込みをスキップ)
      // loadJSONはメモリキャッシュ(FILE_CACHE)を返す(false指定)
      let data = loadJSON(filePath, defaultValue, false);

      // 更新関数実行
      const result = await updateFn(data);

      // 変更を保留
      // updateJSON呼び出し元は「保存完了」を期待している場合があるが、マップ塗りは遅延でOK。
      queueMapUpdateInternal(); // 内部保存トリガー (pendingChanges更新 & タイマーセット)

      return result;
    });
  }

  return LockManager.withLock(filePath, async () => {
    // ディスクから最新を取得 (ignoreCache=false に変更し、メモリキャッシュを正とする)
    // メモリ上の変更(paintなど)がディスクに未保存の場合、ディスクから読み直すと巻き戻ってしまうため
    const data = loadJSON(filePath, defaultValue, false);

    // 更新関数実行
    const result = await updateFn(data);

    // 変更を保存 (ディスクへの書き込み完了を待機)
    // デッドロック回避のため skipLock: true を指定 (メインスレッドで既にロックを保持しているため)
    await saveJSON(filePath, data, { skipLock: true });

    return result;
  });
}

// [NEW] Single Tile SAB Update Helper
function updateTileSAB(x, y, tile, namedCells) {
  if (!sharedMapView) return;
  const size = 500;
  if (x < 0 || x >= size || y < 0 || y >= size) return;

  const offset = (y * size + x) * TILE_BYTE_SIZE;

  let fid = tile.factionId || tile.faction;
  if (fid && !factionIdToIndex.has(fid)) fid = null;

  const fidIdx = getFactionIdx(fid);
  const oldFidIdx = sharedMapView.getUint16(offset, true);

  // Stats Update (Incremental)
  if (oldFidIdx !== fidIdx) {
    // Decrement old
    if (oldFidIdx !== 65535 && oldFidIdx < MAX_FACTIONS_LIMIT) {
      const oldIdx = oldFidIdx * STATS_INTS_PER_FACTION;
      Atomics.sub(factionStatsView, oldIdx + 0, 1);
      const points = getTilePoints(x, y, namedCells);
      Atomics.sub(factionStatsView, oldIdx + 4, points);
    }
    // Increment new
    if (fidIdx !== 65535 && fidIdx < MAX_FACTIONS_LIMIT) {
      const newIdx = fidIdx * STATS_INTS_PER_FACTION;
      Atomics.add(factionStatsView, newIdx + 0, 1);
      const points = getTilePoints(x, y, namedCells);
      Atomics.add(factionStatsView, newIdx + 4, points);
    }
  }

  sharedMapView.setUint16(offset + 0, fidIdx, true);

  const colorStr = tile.customColor || tile.color || "#ffffff";
  let colorInt = parseInt(colorStr.replace("#", ""), 16);
  if (Number.isNaN(colorInt)) colorInt = 0xffffff;
  sharedMapView.setUint32(offset + 2, colorInt, true);

  const pIdx = getPlayerIdx(tile.paintedBy);
  sharedMapView.setUint32(offset + 6, pIdx, true);

  sharedMapView.setUint8(offset + 10, tile.overpaint || 0);

  let flags = 0;
  let exp = 0;
  if (tile.core) {
    flags |= 1;
    exp = new Date(tile.core.expiresAt || 0).getTime();
  }
  if (tile.coreificationUntil) {
    flags |= 2;
    exp = new Date(tile.coreificationUntil).getTime();
  }
  if (Number.isNaN(exp)) exp = 0;

  sharedMapView.setUint8(offset + 11, flags);
  sharedMapView.setFloat64(offset + 12, exp, true);

  const pAt = tile.paintedAt
    ? Math.floor(new Date(tile.paintedAt).getTime() / 1000)
    : 0;
  sharedMapView.setUint32(offset + 20, pAt, true);
}

// 管理者設定によるゲーム停止チェックミドルウェア
// 休憩時間中かどうかを判定
function isBreakTime() {
  const settings = loadJSON(SYSTEM_SETTINGS_PATH, {});
  const breakSettings = settings.breakTime;
  if (!breakSettings || !breakSettings.enabled) return false;

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const [startH, startM] = breakSettings.startTime.split(":").map(Number);
  const [endH, endM] = breakSettings.endTime.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  // 日をまたぐ場合(例: 23:00 ~ 07:00)
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
  // 同日内の場合(例: 01:00 ~ 06:00)
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

function checkGameStatus(req, res, next) {
  const settings = loadJSON(SYSTEM_SETTINGS_PATH, { isGameStopped: false });
  if (settings.isGameStopped) {
    return res.status(503).json({
      error: "現在、ゲームの進行は一時的に停止されています（メンテナンス中）",
      code: "GAME_STOPPED",
    });
  }
  next();
}

/**
 * 内部的な保存トリガー (updateJSON経由など)
 */
function queueMapUpdateInternal() {
  // 具体的な変更内容は不明だが、変更があったことだけ記録して保存を促す
  // キーとしてダミーまたは全保存フラグを立てる
  pendingChanges.set("__FULL_SAVE_REQUIRED__", true);
  // [FIX] Ensure timer is set
  if (!mapSaveTimer) {
    mapSaveTimer = setTimeout(() => {
      persistMapState();
    }, MAP_SAVE_INTERVAL);
  }
  checkSaveCondition();
}

// [OPTIMIZATION] マップ変更のバッチ処理用
const pendingChanges = new Map();
let lastMapSaveTime = Date.now();
let mapSaveTimer = null;
const MAP_SAVE_INTERVAL = 20 * 1000; // 20秒 (定期フル保存) - 負荷対策しつつ、データロストを最小限に。30秒指定だが余裕を持って20秒。
const MAP_SAVE_THRESHOLD = 50; // 変更件数閾値 (これを超えたら即保存)

function checkSaveCondition() {
  const now = Date.now();
  if (
    pendingChanges.size >= MAP_SAVE_THRESHOLD ||
    now - lastMapSaveTime >= MAP_SAVE_INTERVAL
  ) {
    persistMapState();
  }
}

async function persistMapState() {
  try {
    if (mapSaveTimer) {
      clearTimeout(mapSaveTimer);
      mapSaveTimer = null;
    }

    // メモリ上の最新データを保存
    // loadJSONはメモリキャッシュ(FILE_CACHE)を返す(false指定)
    const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} }, false);

    // pendingChanges の内容を mapState にマージ (念のため)
    pendingChanges.forEach((tile, key) => {
      if (key === "__FULL_SAVE_REQUIRED__") return;
      if (!mapState.tiles) mapState.tiles = {};

      if (tile === null) {
        delete mapState.tiles[key];
      } else {
        mapState.tiles[key] = tile;
      }
    });

    // pendingChanges をクリアしてから保存 (保存中に新しい変更が来るのを防ぐロックが必要だが、JSはシングルスレッドなのでOK)
    // ただし await saveJSON 中に他の処理が入る可能性はある。
    // 理想的には pendingChanges をローカルにコピーしてクリアだが、
    // 今回は saveJSON 呼び出し時にデータを渡すので、その時点のスナップショットが保存される。
    pendingChanges.clear(); // ここでクリアしてしまうと、saveJSON失敗時にデータロストするリスクがあるが、簡易実装とする

    // saveJSON は LockManager を使うので安全
    await saveJSON(MAP_STATE_PATH, mapState, { skipLock: false });

    // [NEW] バイナリ形式でも保存
    await saveMapBinary();

    lastMapSaveTime = Date.now();
    console.log(`[MapSave] Map state saved successfully (JSON & Binary).`);
  } catch (e) {
    console.error(`[MapSave] Failed to save map state:`, e);
    // 失敗した場合はログに出すのみ (リトライロジックは今回省略)
  }
}

// 定期的な保存チェック (1分ごと)
setInterval(() => {
  checkSaveCondition();
}, 60 * 1000);

// --------------------------------------------------------------------------
// Worker Thread Management
// --------------------------------------------------------------------------

// [NEW] 強制保存API
app.post("/api/admin/save", authenticate, (req, res) => {
  // Direct Disk Mode: 特になにもしないが、成功レスポンスを返す
  res.json({
    success: true,
    message: "Direct Disk Mode: データは常に保存されています。",
  });
});

// 管理者パスワード照合ヘルパー
async function verifyAdminPassword(inputPassword, settings) {
  if (!settings.adminPassword) {
    // パスワードが未設定の場合は "admin" をデフォルトとする
    const hash = await bcrypt.hash("admin", 10);
    settings.adminPassword = hash;
    saveJSON(SYSTEM_SETTINGS_PATH, settings);
    return inputPassword === "admin";
  }

  // もしパスワードがハッシュ化されていない（bcrypt形式でない）場合はハッシュ化して保存（移行用）
  if (!settings.adminPassword.startsWith("$2")) {
    const hash = await bcrypt.hash(settings.adminPassword, 10);
    const oldPassword = settings.adminPassword;
    settings.adminPassword = hash;
    saveJSON(SYSTEM_SETTINGS_PATH, settings);
    return inputPassword === oldPassword;
  }

  return await bcrypt.compare(inputPassword, settings.adminPassword);
}

// Admin認証ミドルウェア
function requireAdminAuth(req, res, next) {
  if (req.cookies.admin_auth === "authenticated") {
    return next();
  }
  return res.status(401).json({ error: "認証が必要です" });
}

// Admin ログインエンドポイント
app.post("/api/admin/login", async (req, res) => {
  const { password } = req.body;
  const settings = loadJSON(SYSTEM_SETTINGS_PATH, { adminPassword: null });

  if (!(await verifyAdminPassword(password, settings))) {
    // 簡易的なブルートフォース対策として遅延を入れる
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return res.status(401).json({ error: "パスワードが違います" });
  }

  // Cookie設定(セッション有効期限: 24時間)
  res.cookie("admin_auth", "authenticated", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: "strict",
  });

  res.json({ success: true });
});

// Admin 認証チェックエンドポイント
app.get("/api/admin/check-auth", (req, res) => {
  if (req.cookies.admin_auth === "authenticated") {
    return res.json({ authenticated: true });
  }
  return res.status(401).json({ authenticated: false });
});

// [NEW] データリセットAPI
app.post(
  "/api/admin/reset-data",
  authenticate,
  requireAdminAuth,
  async (req, res) => {
    console.log("[Admin] Data Reset Requested...");

    try {
      // 1. Reset JSON files to default
      // 保存すべきファイル以外をリセット
      const excludeFiles = [
        "system_settings.json",
        "admin-id.txt",
        "write_test.txt",
      ];
      // 注意: DATA_DIR は外部スコープで定義されています
      const files = fs.readdirSync(DATA_DIR);

      for (const file of files) {
        if (excludeFiles.includes(file)) continue;

        const fullPath = path.join(DATA_DIR, file);
        // Skip if file doesn't exist (race condition?)
        if (!fs.existsSync(fullPath)) continue;

        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          // ディレクトリは削除 (history, notice, map_images)
          fs.rmSync(fullPath, { recursive: true, force: true });
          console.log(`[Reset] Deleted directory: ${file}`);
        } else if (file.endsWith(".json")) {
          // JSONファイルは空の初期値で上書き (構造依存)
          let defaultData = {};
          if (file === "activity_log.json") defaultData = [];
          if (file === "map_state.json") defaultData = { tiles: {} };
          if (file === "factions.json") defaultData = { factions: {} };
          if (file === "players.json") defaultData = { players: {} };
          if (file === "alliances.json") defaultData = { alliances: {} };
          if (file === "truces.json") defaultData = { truces: {} };
          if (file === "wars.json") defaultData = { wars: {} };
          if (file === "game_ids.json") defaultData = {};

          // Use fs.writeFileSync to bypass async queue for immediate reset
          fs.writeFileSync(fullPath, JSON.stringify(defaultData, null, 2));
          console.log(`[Reset] Reset JSON file: ${file}`);

          // Clear from cache
          FILE_CACHE.delete(fullPath);
        } else if (file.endsWith(".png")) {
          // Other files (.png etc) -> delete
          fs.unlinkSync(fullPath);
          console.log(`[Reset] Deleted file: ${file}`);
        }
      }

      // Clear Memory Cache
      FILE_CACHE.clear();

      // Re-create necessary directories
      if (!fs.existsSync(path.join(DATA_DIR, "map_images")))
        fs.mkdirSync(path.join(DATA_DIR, "map_images"));
      if (!fs.existsSync(path.join(DATA_DIR, "history")))
        fs.mkdirSync(path.join(DATA_DIR, "history"));
      if (!fs.existsSync(path.join(DATA_DIR, "notice")))
        fs.mkdirSync(path.join(DATA_DIR, "notice"));

      // Emit event to clients to reload or disconnect
      io.emit("system:reset", {
        message:
          "サーバーデータがリセットされました。ページを再読み込みしてください。",
      });

      res.json({ success: true, message: "データをリセットしました" });
    } catch (e) {
      console.error("[Reset] Error:", e);
      res.status(500).json({ error: "リセット中にエラーが発生しました" });
    }
  },
);

app.get("/api/admin/debug/memory", authenticate, (req, res) => {
  // Direct Disk Mode: メモリキャッシュは使用されていません
  res.json({
    message: "Direct Disk Mode is active. Memory cache is not used.",
    keys: [],
    dirty: [],
  });
});

app.get("/api/admin/settings", requireAdminAuth, (req, res) => {
  const settings = loadJSON(SYSTEM_SETTINGS_PATH, { isGameStopped: false });
  let adminId = "";
  if (fs.existsSync(ADMIN_ID_PATH)) {
    adminId = fs.readFileSync(ADMIN_ID_PATH, "utf-8").trim();
  }
  res.json({
    isGameStopped: !!settings.isGameStopped,
    isMergeEnabled: settings.isMergeEnabled !== false, // Default true
    gardenMode: !!settings.gardenMode,
    apSettings: settings.apSettings || {},
    namedTileSettings: settings.namedTileSettings || {
      cost: 100,
      intervalHours: 0,
      fallApBonusMin: 10,
      fallApBonusMax: 50,
      zocMultiplier: 2.0,
      zocReducedMultiplier: 1.5,
      namedTileCost: 1000,
    },
    accountSettings: settings.accountSettings || {
      maxAccountsPerIp: 2,
      excludedIps: "",
    },
    mapImageSettings: settings.mapImageSettings || { intervalMinutes: 1 },
    adminId: adminId,
    scheduledAction: settings.scheduledAction || null,
    breakTime: settings.breakTime || {
      enabled: false,
      startTime: "01:00",
      endTime: "06:00",
    },
    coreTileSettings: settings.coreTileSettings || {
      attackCostMultiplier: 1.5,
      instantCoreThreshold: 400,
      maxCoreTiles: 2500,
    },
    mergerSettings: settings.mergerSettings || { prohibitedRank: 0 },
  });
});

// 廃止されたデバッグエンドポイント（プレースホルダーとして保持）
/*
app.get("/api/admin/debug/memory", authenticate, (req, res) => {
  res.json({
    keys: [],
    dirty: [],
  });
});
*/

// 勢力基本設定変更 (名前・色)
app.post(
  "/api/factions/settings",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const { name, color } = req.body;

    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const player = players.players[req.playerId];

    if (!player.factionId) {
      return res.status(400).json({ error: "勢力に所属していません" });
    }

    const faction = factions.factions[player.factionId];
    if (!faction) {
      return res.status(400).json({ error: "勢力データが見つかりません" });
    }

    // 権限チェック: 勢力主または基本設定変更権限が必要
    const hasPermission =
      faction.kingId === req.playerId ||
      (faction.memberRoles &&
        faction.memberRoles[req.playerId] &&
        faction.roles &&
        faction.roles.find(
          (r) =>
            r.id === faction.memberRoles[req.playerId] &&
            r.permissions &&
            r.permissions.canManageSettings,
        ));

    if (!hasPermission) {
      return res.status(403).json({ error: "権限がありません" });
    }

    const oldName = faction.name;
    const oldColor = faction.color;
    let nameChanged = false;
    let colorChanged = false;

    // 勢力名変更
    if (name !== undefined && name !== null) {
      // 名前バリデーション
      const trimmedName = name.trim();
      if (trimmedName.replace(/[\s\u200B-\u200D\uFEFF]/g, "").length === 0) {
        return res
          .status(400)
          .json({ error: "勢力名には有効な文字を含めてください" });
      }
      if (trimmedName.length > 20) {
        return res
          .status(400)
          .json({ error: "勢力名は20文字以内で入力してください" });
      }

      // 重複チェック (自分以外の勢力)
      for (const [fid, f] of Object.entries(factions.factions)) {
        if (fid !== player.factionId && f.name === trimmedName) {
          return res
            .status(400)
            .json({ error: "この勢力名は既に使用されています" });
        }
      }

      if (trimmedName !== oldName) {
        faction.name = trimmedName;
        nameChanged = true;
      }
    }

    // 勢力カラー変更
    if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
      if (color.toLowerCase() === "#ffffff") {
        return res
          .status(400)
          .json({ error: "白色(#ffffff)は勢力色として使用できません" });
      }
      if (color !== oldColor) {
        faction.color = color;
        colorChanged = true;
      }
    }

    if (!nameChanged && !colorChanged) {
      return res.json({ success: true, message: "変更はありませんでした" });
    }

    saveJSON(FACTIONS_PATH, factions);

    // アクティビティログ
    if (nameChanged) {
      logActivity("faction_renamed", {
        factionId: player.factionId,
        oldName,
        newName: faction.name,
        changedBy: player.displayName || toShortId(req.playerId),
      });
    }

    if (colorChanged) {
      logActivity("faction_color_changed", {
        factionId: player.factionId,
        factionName: faction.name,
        oldColor,
        newColor: faction.color,
        changedBy: player.displayName || toShortId(req.playerId),
      });
    }

    // リアルタイム更新通知
    // リアルタイム更新通知 (所属メンバーのみ)
    const enriched = getEnrichedFaction(player.factionId, factions, players);
    io.to(`faction:${player.factionId}`).emit("faction:updated", {
      factionId: player.factionId,
      faction: enriched,
    });

    res.json({ success: true, faction: enriched });
  },
);

// 加入ポリシー変更
app.post("/api/admin/settings", requireAdminAuth, async (req, res) => {
  const { isGameStopped } = req.body;
  const settings = loadJSON(SYSTEM_SETTINGS_PATH, {
    isGameStopped: false,
    adminPassword: null,
    mergerSettings: { prohibitedRank: 0 },
  });

  if (typeof isGameStopped === "boolean") {
    settings.isGameStopped = isGameStopped;
  }

  if (typeof req.body.isMergeEnabled === "boolean") {
    settings.isMergeEnabled = req.body.isMergeEnabled;
  }

  if (typeof req.body.gardenMode === "boolean") {
    settings.gardenMode = req.body.gardenMode;
  }

  // apSettingsの保存
  if (req.body.apSettings && typeof req.body.apSettings === "object") {
    // 数値型への変換とバリデーション
    const newAp = { ...req.body.apSettings };
    if (newAp.tulipRefillIntervalHours !== undefined) {
      newAp.tulipRefillIntervalHours = parseFloat(
        newAp.tulipRefillIntervalHours,
      );
      if (
        isNaN(newAp.tulipRefillIntervalHours) ||
        newAp.tulipRefillIntervalHours < 0
      ) {
        newAp.tulipRefillIntervalHours = 3;
      }
    }
    settings.apSettings = newAp;
  }

  // mapImageSettingsの保存
  if (
    req.body.mapImageSettings &&
    typeof req.body.mapImageSettings === "object"
  ) {
    settings.mapImageSettings = req.body.mapImageSettings;
    // スケジューラーの更新をトリガー
    updateMapImageScheduler(settings.mapImageSettings.intervalMinutes || 1);
  }

  // [NEW] namedTileSettingsの保存
  if (
    req.body.namedTileSettings &&
    typeof req.body.namedTileSettings === "object"
  ) {
    const nt = { ...req.body.namedTileSettings };
    // バリデーションとデフォルト値設定
    if (nt.cost === undefined) nt.cost = 100;
    if (nt.intervalHours === undefined) nt.intervalHours = 0;
    if (nt.fallApBonusMin === undefined) nt.fallApBonusMin = 10;
    if (nt.fallApBonusMax === undefined) nt.fallApBonusMax = 50;
    if (nt.zocMultiplier === undefined) nt.zocMultiplier = 2.0;

    settings.namedTileSettings = nt;
  }

  // [NEW] Merger Settingsの保存
  if (req.body.mergerSettings && typeof req.body.mergerSettings === "object") {
    settings.mergerSettings = {
      prohibitedRank: parseInt(req.body.mergerSettings.prohibitedRank) || 0,
    };
  }

  // [NEW] Account Settingsの保存
  if (
    req.body.accountSettings &&
    typeof req.body.accountSettings === "object"
  ) {
    if (req.body.accountSettings.maxAccountsPerIp !== undefined) {
      const val = parseInt(req.body.accountSettings.maxAccountsPerIp, 10);
      if (!isNaN(val) && val >= 1) {
        if (!settings.accountSettings) settings.accountSettings = {};
        settings.accountSettings.maxAccountsPerIp = val;
      }
    }
  }

  // [NEW] coreTileSettingsの保存
  if (
    req.body.coreTileSettings &&
    typeof req.body.coreTileSettings === "object"
  ) {
    const ct = { ...req.body.coreTileSettings };
    // バリデーションとデフォルト値
    if (ct.attackCostMultiplier === undefined) ct.attackCostMultiplier = 1.5;
    if (ct.instantCoreThreshold === undefined) ct.instantCoreThreshold = 400;
    if (ct.maxCoreTiles === undefined) ct.maxCoreTiles = 2500;
    settings.coreTileSettings = ct;
  }

  // アカウント設定の保存
  if (
    req.body.accountSettings &&
    typeof req.body.accountSettings === "object"
  ) {
    settings.accountSettings = req.body.accountSettings;
  }

  // 休憩時間設定の保存
  if (req.body.breakTime && typeof req.body.breakTime === "object") {
    settings.breakTime = req.body.breakTime;
  }

  // [NEW] マップ画像生成設定の保存
  if (
    req.body.mapImageSettings &&
    typeof req.body.mapImageSettings === "object"
  ) {
    if (!settings.mapImageSettings) settings.mapImageSettings = {};

    // バリデーション
    if (req.body.mapImageSettings.intervalMinutes !== undefined) {
      const min = parseInt(req.body.mapImageSettings.intervalMinutes, 10);
      if (!isNaN(min) && min > 0) {
        settings.mapImageSettings.intervalMinutes = min;

        // スケジュール変更があった場合、インターバルを即時更新するために
        // mapWorkerやタイマーをリセットする必要があるが、
        // 簡易的には generateFullMapImageTask が次回呼ばれるまで待つか、
        // もしくは FullMapImage scheduler 変数 (server.js上部) を更新する。
        // ここでは mapImageSettings を保存するだけとする（server.jsのschedulerがこれを参照している必要がある）

        // 既存の mapImageIntervalId をクリアして再スケジューリング
        if (typeof updateMapImageScheduler === "function") {
          updateMapImageScheduler(min);
        }
      }
    }
  }

  // [NEW] 勢力併合設定の保存
  if (req.body.mergerSettings && typeof req.body.mergerSettings === "object") {
    const ms = { ...req.body.mergerSettings };
    if (ms.prohibitedRank === undefined) ms.prohibitedRank = 0;
    settings.mergerSettings = ms;
  }

  // Admin IDの保存
  let currentAdminIdLocal = "";
  try {
    if (fs.existsSync(ADMIN_ID_PATH)) {
      currentAdminIdLocal = fs.readFileSync(ADMIN_ID_PATH, "utf-8").trim();
    }
    // eslint-disable-next-line no-unused-vars
  } catch (_e) {
    // Ignore errors when reading admin ID file
  }

  if (typeof req.body.adminId === "string") {
    currentAdminIdLocal = req.body.adminId.trim();
    fs.writeFileSync(ADMIN_ID_PATH, currentAdminIdLocal, "utf-8");
  }

  // スケジュール設定の保存
  if (req.body.scheduledAction) {
    if (req.body.scheduledAction.type === "cancel") {
      settings.scheduledAction = null;
    } else if (
      (req.body.scheduledAction.type === "stop" ||
        req.body.scheduledAction.type === "start") &&
      req.body.scheduledAction.time
    ) {
      settings.scheduledAction = {
        type: req.body.scheduledAction.type,
        time: req.body.scheduledAction.time,
      };
    }
  }

  saveJSON(SYSTEM_SETTINGS_PATH, settings);

  // [NEW] 設定変更を全クライアントに通知
  io.emit("system:settings_updated", {
    isGameStopped: settings.isGameStopped,
    isMergeEnabled: settings.isMergeEnabled,
    gardenMode: settings.gardenMode || false,
    apSettings: {
      ...(settings.apSettings || {}),
      namedTileSettings: settings.namedTileSettings || {
        cost: 100,
        intervalHours: 0,
      },
      coreTileSettings: settings.coreTileSettings || {
        attackCostMultiplier: 1.5,
        instantCoreThreshold: 400,
        maxCoreTiles: 2500,
      },
    },
    mapImageSettings: settings.mapImageSettings || { intervalMinutes: 1 },
    scheduledAction: settings.scheduledAction || null,
    mergerSettings: settings.mergerSettings || { prohibitedRank: 0 },
  });

  res.json({
    success: true,
    isGameStopped: settings.isGameStopped,
    isMergeEnabled: settings.isMergeEnabled,
    gardenMode: settings.gardenMode || false,
    apSettings: settings.apSettings || {},
    mapImageSettings: settings.mapImageSettings || { intervalMinutes: 1 },
    adminId: currentAdminIdLocal,
    scheduledAction: settings.scheduledAction || null,
    namedTileSettings: settings.namedTileSettings || {
      cost: 100,
      intervalHours: 0,
    },
    coreTileSettings: settings.coreTileSettings || {
      attackCostMultiplier: 1.5,
      instantCoreThreshold: 400,
      maxCoreTiles: 2500,
    },
    accountSettings: settings.accountSettings || {
      maxAccountsPerIp: 2,
      excludedIps: "",
    },
    breakTime: settings.breakTime || {
      enabled: false,
      startTime: "01:00",
      endTime: "06:00",
    },
    mergerSettings: settings.mergerSettings || { prohibitedRank: 0 },
  });
});

// [NEW] スケジュール実行チェック機能
function checkScheduledAction() {
  const settings = loadJSON(SYSTEM_SETTINGS_PATH, {
    isGameStopped: false,
    mergerSettings: { prohibitedRank: 0 },
  });
  if (settings.scheduledAction && settings.scheduledAction.time) {
    const scheduledTime = new Date(settings.scheduledAction.time).getTime();
    if (Date.now() >= scheduledTime) {
      const type = settings.scheduledAction.type;
      console.log(`[Scheduler] Executing scheduled action: ${type}`);

      if (type === "stop") {
        settings.isGameStopped = true;
      } else if (type === "start") {
        settings.isGameStopped = false;
      }

      // 実行後にスケジュールをクリア
      settings.scheduledAction = null;
      saveJSON(SYSTEM_SETTINGS_PATH, settings);

      // ログ出力
      logActivity("system_message", {
        message: `[システム] 予約されたスケジュールによりゲームが${type === "stop" ? "停止" : "再開"}されました。`,
      });

      // クライアントへ通知
      io.emit("system:settings_updated", {
        isGameStopped: settings.isGameStopped,
        scheduledAction: null,
      });
    }
  }
}

// 1分ごとにスケジュールをチェック
setInterval(checkScheduledAction, 60 * 1000);

// --------------------------------------------------------------------------
// 整合性チェック (Consistency Check)
// --------------------------------------------------------------------------
function checkFactionConsistency() {
  console.log("[Maintenance] Checking faction consistency...");
  const factionsData = loadJSON(FACTIONS_PATH, { factions: {} });
  const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });
  const validFactionIds = new Set(Object.keys(factionsData.factions));
  let changed = false;
  let removedCount = 0;

  Object.entries(mapState.tiles).forEach(([key, tile]) => {
    const fid = tile.factionId || tile.faction;
    if (fid && !validFactionIds.has(fid)) {
      delete mapState.tiles[key];
      removedCount++;
      changed = true;
    }
    // [REFACTOR] 自動マイグレーション: faction (旧) が存在し factionId (新) がない場合、移行する。
    // もし faction と factionId が両方存在する場合、古い faction を削除して整理する。
    if (tile.faction) {
      if (!tile.factionId) {
        tile.factionId = tile.faction;
      }
      delete tile.faction;
      changed = true;
    }
  });

  if (changed) {
    saveJSON(MAP_STATE_PATH, mapState);
    console.log(`[Maintenance] Removed ${removedCount} invalid tiles.`);
  } else {
    console.log("[Maintenance] No invalid tiles found.");
  }
}

// サーバー起動時に実行
checkFactionConsistency();

// ===== Season 2 定数 (shared.js参照) =====
// MAP_SIZE, NORMAL_TILE_POINTS, SPECIAL_TILE_POINTS 等は shared.js からインポート

// ===== Season 2: ネームドマス定数 =====

// NAMED_CELL_CREATE_COST は shared.js に移動しました

const NAMED_CELL_MIN_DISTANCE = 11; // 他のネームドマスからの最小距離

// ネームドマス作成時の距離チェック関数
function isValidNamedCellLocation(x, y, namedCells) {
  for (const key in namedCells) {
    const [cx, cy] = key.split("_").map(Number);
    const dist = Math.sqrt(Math.pow(x - cx, 2) + Math.pow(y - cy, 2));
    if (dist < NAMED_CELL_MIN_DISTANCE) {
      return false;
    }
  }
  return true;
}

// ===== Season 2: 同盟・停戦定数 =====
// パスは先頭に移動しました
const ALLIANCE_LOCK_HOURS = 12; // 作成/加入から解散/脱退不可の時間
const TRUCE_DURATION_HOURS = 12; // 停戦の継続時間

// ===== Season 2: APシステム定数 =====
const AP_MAX_LIMIT = 50; // AP上限のデフォルト値 (100から50に修正)
// const SHARED_AP_LIMIT = 100; // 共有AP上限 (動的計算に変更: 50 + 50*人数)

const FACTION_ACTION_COST = 0; // 勢力作成・脱退コスト (無料化)
const FACTION_COOLDOWN_HOURS = 3; // 建国・脱退・独立の制限時間
const FACTION_COOLDOWN_MS = FACTION_COOLDOWN_HOURS * 60 * 60 * 1000;

// 勢力のタイル数を取得

// 新しい弱小勢力判定 (ランキングと人数に基づく)
// factionsデータと、事前計算されたランキング情報が必要

// 互換性のためのラップ関数

// 勢力ランキングを一括計算するヘルパー

// 弱小勢力判定 (統一ロジック)
// shared.js に移動しました

// 互換性ラッパー：使用箇所を置き換えるまで維持
const isWeakFaction = isWeakFactionUnified; // 移行用エイリアス

// [NEW] 共有AP上限計算 & クラ
// 共有AP上限計算のヘルパー関数
// shared.js に移動しました

// 共有APを上限内に収めるヘルパー (変更があった場合に呼び出す)
async function clampFactionSharedAP(
  factionId,
  factionsData,
  playersJson = null,
) {
  const faction = factionsData.factions[factionId];
  if (!faction) return false;

  const settings = loadJSON(SYSTEM_SETTINGS_PATH, {
    apSettings: {},
    mergerSettings: { prohibitedRank: 0 },
  });
  const players = playersJson || loadJSON(PLAYERS_PATH, { players: {} });

  // [FIX] activeMembers を計算して渡す
  const now = Date.now();
  const oneWeek = 7 * 24 * 60 * 60 * 1000;
  const activeMembers = (faction.members || []).filter((mid) => {
    const p = players.players?.[mid];
    if (!p) return false;
    const lastActive = p.lastActive ? new Date(p.lastActive).getTime() : 0;
    return now - lastActive < oneWeek;
  });

  const { limit } = calculateFactionSharedAPLimit(
    faction,
    players,
    settings,
    activeMembers,
  );

  if ((faction.sharedAP || 0) > limit) {
    console.log(
      `[SharedAP Clamp] Faction ${faction.name} (ID:${factionId}) AP ${faction.sharedAP} -> ${limit}`,
    );
    faction.sharedAP = limit;
    return true; // Changed
  }
  return false;
}

// シークレットトリガーの処理
async function processSecretTriggers(isScheduled = false) {
  if (!isScheduled) {
    console.log(
      `[SecretTrigger] Starting periodic check (Worker - Parallel)...`,
    );
  }

  try {
    const gameIds = loadJSON(GAME_IDS_PATH, {});
    const keys = Object.keys(gameIds).filter(
      (k) => gameIds[k].secretTriggers && gameIds[k].secretTriggers.length > 0,
    );

    if (keys.length === 0) {
      if (!isScheduled)
        console.log(`[SecretTrigger] No secret triggers found in gameIds.`);
      return;
    }

    const chunks = Array.from({ length: numWorkers }, () => []);
    keys.forEach((key, i) => chunks[i % numWorkers].push(key));

    const results = await runParallelWorkerTasks(
      "CHECK_SECRET_TRIGGERS",
      {
        filePaths: {
          gameIds: GAME_IDS_PATH,
          players: PLAYERS_PATH,
          factions: FACTIONS_PATH,
          mapState: MAP_STATE_PATH,
        },
      },
      chunks.map((keysChunk) => ({ gameKeys: keysChunk })),
      (workerResults) => {
        const mergedTriggers = [];
        let mergedRanksMap = {};
        workerResults.forEach((res) => {
          if (res.results) {
            if (res.results.appliedTriggers) {
              mergedTriggers.push(...res.results.appliedTriggers);
            }
            if (res.results.ranksMap) {
              Object.assign(mergedRanksMap, res.results.ranksMap);
            }
          }
        });
        return {
          appliedTriggers: mergedTriggers,
          ranksMap: mergedRanksMap,
        };
      },
    );

    const { appliedTriggers, ranksMap } = results;

    if (!appliedTriggers || appliedTriggers.length === 0) {
      if (!isScheduled)
        console.log(`[SecretTrigger] No new triggers to apply.`);
      return;
    }

    // 表示用にランク情報をキャッシュから取得
    const ranks = cachedFactionRanks.length > 0 ? cachedFactionRanks : [];
    // 弱小判定のために最新の勢力ポイントをキャッシュから逆引き用マップに変換
    const factionPoints = {};
    cachedFactionRanks.forEach((r) => (factionPoints[r.id] = r.points));

    // メインスレッドの状態に適用 & 永続化
    let triggersCount = 0;

    await updateJSON(PLAYERS_PATH, async (playersData) => {
      await updateJSON(FACTIONS_PATH, async (factionsData) => {
        // 弱小判定のために同盟データをロード
        const alliancesData = loadJSON(ALLIANCES_PATH, { alliances: {} });
        // トップ3の計算
        const top3Alliances = getTop3AllianceIds(
          alliancesData.alliances,
          factionsData,
          { factionPoints },
        );

        appliedTriggers.forEach((action) => {
          const { playerId, factionId, triggerHash, kingId, memberRoles } =
            action;
          const player = playersData.players[playerId];
          const faction = factionsData.factions[factionId];

          if (!player || !faction) return;

          // 競合状態を防ぐための二重チェック
          if (!player.appliedSecretTriggers) player.appliedSecretTriggers = [];
          if (player.appliedSecretTriggers.includes(triggerHash)) return;

          // AP付与 (弱小勢力限定)
          // 弱小勢力定義: ランク6位以下 かつ アクティブメンバー3人以下
          // (サーバーサイドで厳密にチェック)
          const now = Date.now();
          const factionRank = ranksMap[factionId] || 999;

          // [UPDATED] 統一AP計算ロジックを使用
          const settings = loadJSON(SYSTEM_SETTINGS_PATH, {
            apSettings: {},
            mergerSettings: { prohibitedRank: 0 },
          });
          const { limit: sharedLimit, activeMemberCount } =
            calculateFactionSharedAPLimit(faction, playersData, settings);

          const isWeak = isWeakFactionUnified(
            factionRank,
            activeMemberCount,
            factionId,
            faction.allianceId,
            top3Alliances,
          );

          if (isWeak) {
            const refillAmount = settings.apSettings?.gardenRefillAmount ?? 50;

            const cooldownHours =
              settings.apSettings?.tulipRefillIntervalHours ?? 3;
            const cooldownMs = cooldownHours * 60 * 60 * 1000;

            if (
              cooldownHours > 0 &&
              faction.lastRefillTime &&
              now - faction.lastRefillTime < cooldownMs
            ) {
              console.log(
                `[SecretTrigger] Refill rejected for ${faction.name} (Cooldown active)`,
              );
              return; // Skip logic
            }

            if (!faction.sharedAP) faction.sharedAP = 0;

            // [UPDATED] 上限を適用
            faction.sharedAP = Math.min(
              sharedLimit,
              faction.sharedAP + refillAmount,
            );

            // ログ (適用された場合のみ)
            const playerDisplayName = player.displayName || playerId;
            let roleName = "";
            if (kingId === playerId) {
              roleName = "勢力主";
            } else if (memberRoles && memberRoles[playerId]) {
              const roleId = memberRoles[playerId];
              const role = faction.roles
                ? faction.roles.find((r) => r.id === roleId)
                : null;
              if (role) roleName = role.name;
            }
            const roleDisplay = roleName ? `(${roleName})` : "";

            logActivity("TULIP_REPLENISH", {
              message: `${playerDisplayName}${roleDisplay}が${faction.name}に🌷で共有APを50チャージしました`,
              playerId: playerId,
              factionId: factionId,
            });
          } else {
            // 弱小勢力でない場合はログのみ、または何もしない？
            // ユーザーが誤って送った場合の救済措置はないが、悪用防止のため付与はしない
            // ここではログに残さずスルーする (トリガーは消費済み扱いになる)
            console.log(
              `[SecretTrigger] Refused AP replenish for strong faction ${faction.name} (Rank:${factionRank}, Members:${faction.members?.length || 0}, Active:${activeMemberCount})`,
            );
          }

          // 適用済みとしてマーク (再試行ループを防ぐため常に適用済みとみなす)
          player.appliedSecretTriggers.push(triggerHash);

          triggersCount++;

          // ソケット更新
          io.to(`faction:${factionId}`).emit("faction:updated", {
            factionId: factionId,
            faction: getEnrichedFaction(factionId, factionsData, playersData, {
              ranks,
            }),
          });
        });

        return factionsData;
      });
      return playersData;
    });

    console.log(
      `[SecretTrigger] Processed ${triggersCount} triggers via Worker.`,
    );
  } catch (e) {
    console.error(`[SecretTrigger] Error in worker processing:`, e);
  }
}

// 定期的シークレットトリガーチェック (5分)
setInterval(
  () => {
    processSecretTriggers(false).catch((e) =>
      console.error("[Periodic] SecretTrigger Check Error:", e),
    );
  },
  5 * 60 * 1000,
);

// ネームドマスの攻撃コスト

// ネームドマスのレベルアップコスト

// ネームドマスのレベルアップ成功率

// 保護タイル判定 (廃止されたが、ZOC判定などで呼び出しが残っているためダミーを復帰)

// 勢力のタイルをクラスタ（連結成分）に分ける
function getClusters(factionId, mapState) {
  const factionTiles = new Set();
  Object.entries(mapState.tiles).forEach(([key, t]) => {
    if (
      (t.factionId || t.faction) === factionId ||
      (t.core && t.core.factionId === factionId)
    ) {
      factionTiles.add(key);
    }
  });

  const clusters = [];
  const visited = new Set();

  for (const key of factionTiles) {
    if (visited.has(key)) continue;

    const cluster = [];
    const queue = [key];
    visited.add(key);

    while (queue.length > 0) {
      const current = queue.shift();
      cluster.push(current);
      const [x, y] = current.split("_").map(Number);

      // 上下左右斜め
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nk = `${x + dx}_${y + dy}`;
          if (factionTiles.has(nk) && !visited.has(nk)) {
            visited.add(nk);
            queue.push(nk);
          }
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

// [NEW] Helper: コアを含むかどうかを識別しつつクラスタを取得する (検証用)
// 連結領域の計算 (DFS最適化版)

// ヘルパー: その勢力のコア定義を含むクラスタを取得する
function getCoreClusters(factionId, mapState) {
  const clusters = getClusters(factionId, mapState);
  return clusters.filter((cluster) => {
    return cluster.some((key) => {
      const t = mapState.tiles[key];
      // コアがあり、それがこの勢力のものであるかを確認
      // Note: 実効的なコアチェックは通常 tile.core.factionId === factionId を意味する
      return t && t.core && t.core.factionId === factionId;
    });
  });
}

// ヘルパー: 2つのクラスタが隣接しているか確認 (8近傍)
function areClustersAdjacent(clusterA, clusterB) {
  const setB = new Set(clusterB); // 検索最適化
  for (const keyA of clusterA) {
    const [x, y] = keyA.split("_").map(Number);
    const neighbors = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
      [x + 1, y + 1],
      [x + 1, y - 1],
      [x - 1, y + 1],
      [x - 1, y - 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (setB.has(`${nx}_${ny}`)) return true;
    }
  }
  return false;
}

// 指定座標が「自勢力の中核マス（またはその周囲8マス）」に該当するか判定 (併合条件用)

// 勢力消滅時に中核設定を削除するヘルパー
function cleanUpFactionCores(factionId, mapState) {
  Object.values(mapState.tiles).forEach((tile) => {
    if (tile.core && tile.core.factionId === factionId) {
      // 中核設定を削除
      delete tile.core;
    }
  });
}

// データディレクトリ作成
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 初期データ作成
async function initializeData() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(GAME_IDS_PATH)) {
    saveJSON(GAME_IDS_PATH, {});
  }
  if (!fs.existsSync(MAP_STATE_PATH)) {
    saveJSON(MAP_STATE_PATH, { tiles: {} });
  }
  if (!fs.existsSync(FACTIONS_PATH)) {
    saveJSON(FACTIONS_PATH, { factions: {} });
  }
  if (!fs.existsSync(PLAYERS_PATH)) {
    saveJSON(PLAYERS_PATH, { players: {} });
  }
  if (!fs.existsSync(FACTION_NOTICES_PATH)) {
    saveJSON(FACTION_NOTICES_PATH, {});
  }
  if (!fs.existsSync(NAMED_CELLS_PATH)) {
    saveJSON(NAMED_CELLS_PATH, {});
  }
  if (!fs.existsSync(ALLIANCES_PATH)) {
    console.log("[Init] ALLIANCES_PATH not found, initializing...");
    saveJSON(ALLIANCES_PATH, { alliances: {} });
  } else {
    const check = loadJSON(ALLIANCES_PATH, { alliances: {} });
    console.log(
      `[Init] ALLIANCES_PATH exists. Current count: ${Object.keys(check.alliances || {}).length}`,
    );
  }
  if (!fs.existsSync(TRUCES_PATH)) {
    saveJSON(TRUCES_PATH, { truces: {} });
  }
  if (!fs.existsSync(SYSTEM_SETTINGS_PATH)) {
    saveJSON(SYSTEM_SETTINGS_PATH, {
      isGameStopped: false,
      adminPassword:
        "$2b$10$vo24P/c5vT0DX6Sl8E8/DOsMsTfhhrrPo9.Hzx8Tyew1G8ESJJXsu", // admin
      mergerSettings: { prohibitedRank: 0 },
    });
  }

  // 過去データへの互換性対応
  try {
    await updateJSON(
      FACTIONS_PATH,
      (data) => {
        let updated = false;
        Object.values(data.factions || {}).forEach((f) => {
          if (!f.alliances) {
            f.alliances = [];
            updated = true;
          }
          if (!f.allianceRequests) {
            f.allianceRequests = [];
            updated = true;
          }
        });
        return updated;
      },
      {},
    );
  } catch (e) {
    console.error("初期化エラー (factions):", e);
  }

  // 明示的なメモリロード（ALLIANCES_PATHは常にディスクから読み込むので除外）
  loadJSON(GAME_IDS_PATH, {});
  loadJSON(MAP_STATE_PATH, { tiles: {} });
  loadJSON(FACTIONS_PATH, { factions: {} });
  loadJSON(PLAYERS_PATH, { players: {} });
  loadJSON(NAMED_CELLS_PATH, {});
  loadJSON(TRUCES_PATH, { truces: {} });
}

(async () => {
  try {
    await initializeData();
    console.log("データを初期化しました。");
    // 中核マスの整合性チェック
    await recalculateAllFactionCores();
    // 全勢力のポイント再計算 (領土ポイントの整合性を確保)
    recalculateAllFactionPoints();

    // レガシー形式の戦争エントリをクリーンアップ (factionA_factionB 形式)
    const warsData = loadJSON(WARS_PATH, { wars: {} });
    let legacyRemoved = 0;
    Object.keys(warsData.wars).forEach((key) => {
      // レガシー形式はキーに '_' を含み、UUIDではない（faction-xxx_faction-yyy）
      if (key.includes("faction-") && key.includes("_")) {
        delete warsData.wars[key];
        legacyRemoved++;
      }
    });
    if (legacyRemoved > 0) {
      saveJSON(WARS_PATH, warsData);
      console.log(`[WarCleanup] Removed ${legacyRemoved} legacy war entries.`);
    }
  } catch (e) {
    console.error("致命的な初期化エラー:", e);
  }
})();

// ユーザーIDの短縮形式 (game-xxxxxxxxxx -> xxxxxxxx)
function toShortId(pid) {
  if (!pid) return "";
  return pid.startsWith("game-") ? pid.substring(5, 13) : pid.substring(0, 8);
}

// アクティビティログ記録
function logActivity(type, data = {}) {
  // dataが文字列の場合はメッセージとして扱う
  if (typeof data === "string") {
    data = { message: data };
  }

  // プレイヤー関連のデータがあれば短縮IDを付与
  if (data && data.playerId && !data.playerShortId) {
    data.playerShortId = toShortId(data.playerId);
  }
  if (data.newLeaderId && !data.newLeaderShortId) {
    data.newLeaderShortId = toShortId(data.newLeaderId);
  }

  const entry = {
    id: Date.now(),
    type,
    data,
    timestamp: new Date().toISOString(),
  };

  // バッファに追加
  pendingActivityLogs.push(entry);

  // タイマー設定 (まだなければ)
  if (!activityLogSaveTimer) {
    activityLogSaveTimer = setTimeout(() => {
      persistActivityLogs();
    }, LOG_SAVE_INTERVAL);
  }

  // しきい値を超えたら即時保存（非同期）
  if (pendingActivityLogs.length >= LOG_BUFFER_THRESHOLD) {
    persistActivityLogs();
  }

  // Socketでリアルタイム配信
  batchEmitActivityLog(entry);
}

// 領土割譲マップ画像生成（割譲地域にズーム）
async function generateCessionMapImage(tiles, factions, highlightTiles) {
  if (!highlightTiles || highlightTiles.length === 0) {
    return null;
  }
  // Workerにオフロード (tilesは巨大なのでファイルパスを渡してWorker側でロードさせるのが良いが、
  // メモリ上の最新状態を反映するためここでは渡す。重すぎる場合は最適化検討)
  // 今回は最適化のため tiles: null とし、filePathsを渡す
  const result = await runWorkerTask("GENERATE_CESSION_IMAGE", {
    tiles: null,
    filePaths: { mapState: MAP_STATE_PATH },
    factions,
    highlightTiles,
    tempDir: path.join(__dirname, "../temp/cession_maps"),
  });

  if (!result.success) {
    console.error("Worker failed to generate cession map:", result.error);
    return null;
  }
  return result.results;
}

// AP補充計算 (ハイブリッド方式 - 改修版)
// 毎時05分に一括処理: 書き込み数 + ランダム + (弱小) + 共有AP
function handleApRefill(player, players, playerId, saveToDisk = true) {
  if (!player || !playerId) return { player, refilledAmount: 0 };
  const now = new Date();
  const nowMs = now.getTime();
  const INTERVAL_MS = 5 * 60 * 1000; // 5分刻み

  // 個人通知用のヘルパー（関数内でのみ使用）
  const addPersonalNotice = (pid, title, content, type = "info") => {
    // トースト通知のみ送信 (保存しない)
    io.to(`user:${pid}`).emit("notification:toast", {
      title,
      message: content,
      type,
    });
  };

  // 設定読み込み
  const settings = loadJSON(SYSTEM_SETTINGS_PATH, {
    apSettings: {},
    mergerSettings: { prohibitedRank: 0 },
  });
  const apConfig = settings.apSettings || {
    apPerPost: 10,
    maxApFromPosts: 10,
    random: { min: 0, max: 10 },
    smallFactionBonus: { min: 0, max: 10 },
    limits: { individual: 100, sharedBase: 50 },
  };

  // 最後のアウトボーン(補充)通過点
  const lastUpdateMs =
    player.lastApAutoUpdate || player.lastApUpdate || Date.now();
  let checkTime = new Date(lastUpdateMs);

  // 次のチェックポイントを算出
  const lastMin = checkTime.getMinutes();
  const remainder = lastMin % 5;
  const minutesToAdd = 5 - remainder;
  checkTime.setSeconds(0, 0);
  checkTime.setMinutes(checkTime.getMinutes() + minutesToAdd);

  // 未来の時刻になっていないか確認
  if (checkTime.getTime() <= lastUpdateMs) {
    checkTime.setTime(checkTime.getTime() + INTERVAL_MS);
  }
  checkTime.setSeconds(0, 0);

  let totalRefilled = 0;
  let lastSuccessTime = null;

  // 補充タイミング: 毎時05分のみ
  const replenishmentMinutes = [5];

  while (checkTime.getTime() <= nowMs) {
    const min = checkTime.getMinutes();
    let processedThisStep = false;

    if (replenishmentMinutes.includes(min)) {
      // 毎時05分: 全種別の補充を一括で行う

      // 1. 書き込み数ベース補充
      // キャッシュ無効化して読み直し
      const updatedGameIds = loadJSON(GAME_IDS_PATH, {}, true);

      // [NEW] 認証済みユーザー判定用のセット作成 (このタイミングで一括生成)
      const authenticatedUserIds = new Set();
      if (settings.gardenMode) {
        Object.values(updatedGameIds).forEach((entry) => {
          if (entry.id) authenticatedUserIds.add(entry.id);
        });
      }

      // checkTime(05分)の1時間前〜直前までの書き込みを集計したいが、
      // 簡易的に「checkTime - 60分」のターゲット日付/時間を見る（前時のデータ）
      // 例: 10:05に実行 -> Update for 09:xx posts?
      // 元ロジックでは checkTime - 60*1000 (1分前) の日付/時間を取っていた。
      // つまり 10:00 の実行で 09:59 時点の「時」=9時台 のデータを参照。
      // 10:05に実行する場合、10:04の「時」=10時台になってしまうとまずい。
      // なので、10:05実行でも「9時台」のポストを見たいなら、checkTime - 10分 くらいにして前の時間を指すようにする。
      const lookupTime = new Date(checkTime.getTime() - 15 * 60 * 1000); // 15分前 (xx:50 of prev hour or xx:xx-15)
      // 10:05 - 15m = 09:50 -> Hour 9. Correct.

      const targetDate = `${lookupTime.getFullYear()}/${String(
        lookupTime.getMonth() + 1,
      ).padStart(2, "0")}/${String(lookupTime.getDate()).padStart(2, "0")}`;
      const targetHour = String(lookupTime.getHours());

      let hourlyPosts = 0;
      const targetIds = new Set();
      if (player.knownPostIds) {
        player.knownPostIds.forEach((id) => {
          if (!id) return;
          targetIds.add(id);
          targetIds.add(String(id).replace(/^ch-/, ""));
        });
      }
      targetIds.add(playerId);
      const cleanPlayerId = String(playerId).replace(/^game-/, "");
      targetIds.add(cleanPlayerId);

      const countedSessions = new Set();

      for (const [sessionKey, entry] of Object.entries(updatedGameIds)) {
        const internalId = entry.id;
        const cleanSessionKey = sessionKey
          .replace(/^game-/, "")
          .replace(/^ch-/, "");

        const isMatch =
          targetIds.has(sessionKey) ||
          targetIds.has(cleanSessionKey) ||
          (internalId &&
            (targetIds.has(internalId) ||
              targetIds.has(internalId.replace(/^ch-/, ""))));

        if (isMatch) {
          if (countedSessions.has(sessionKey)) continue;
          countedSessions.add(sessionKey);

          // count > 0 の場合のみ加算
          if (entry.counts && entry.counts[targetDate]) {
            const count = entry.counts[targetDate][targetHour] || 0;
            if (count > 0) {
              hourlyPosts += count;
            }
          }
        }
      }

      const apPerPost = apConfig.apPerPost || 10;
      const maxApFromPosts = apConfig.maxApFromPosts || 10;
      const postAp = Math.min(hourlyPosts * apPerPost, maxApFromPosts);

      // 2. ランダム補充
      const rMin = apConfig.random?.min ?? 0;
      const rMax = apConfig.random?.max ?? 10;
      // max < min の場合のガード
      const safeRMax = Math.max(rMin, rMax);
      let randomAp = 0;
      if (safeRMax > 0 || rMin > 0) {
        randomAp = Math.floor(Math.random() * (safeRMax - rMin + 1)) + rMin;
      }

      // 3. 弱小勢力ボーナス (個人APへの加算)
      // ユーザー要望: "ランダム量補充の...個人と中小ボーナスで分けて設定できるように"
      // ここでは、弱小勢力所属なら追加でランダム付与とする
      let smallFactionBonusAp = 0;
      const fMin = apConfig.smallFactionBonus?.min ?? 0;
      const fMax = apConfig.smallFactionBonus?.max ?? 10;
      const safeFMax = Math.max(fMin, fMax);

      const factionsData = loadJSON(FACTIONS_PATH, { factions: {} }); // 内側でロード
      if (player.factionId && (safeFMax > 0 || fMin > 0)) {
        // 弱小判定
        const rankData = cachedFactionRanks.find(
          (r) => r.id === player.factionId,
        );
        const rank = rankData ? rankData.rank : 999;
        const faction = factionsData.factions[player.factionId];
        const memberCount = faction?.members?.length || 0;

        if (isWeakFaction(rank, memberCount)) {
          smallFactionBonusAp =
            Math.floor(Math.random() * (safeFMax - fMin + 1)) + fMin;
        }
      }

      totalRefilled += postAp + randomAp + smallFactionBonusAp;
      processedThisStep = true;

      console.log(
        `[AP Detail] Player: ${playerId}, Time: ${checkTime.toLocaleString()}, Post: ${postAp} (${hourlyPosts}x${apPerPost}), Random: ${randomAp}, Bonus: ${smallFactionBonusAp}, Total: ${totalRefilled}`,
      );

      // 通知メッセージ構築
      const parts = [];
      if (postAp > 0) parts.push(`投稿: +${postAp}`);
      if (randomAp > 0) parts.push(`定期: +${randomAp}`);
      if (smallFactionBonusAp > 0) parts.push(`支援: +${smallFactionBonusAp}`);
      const msg = parts.length > 0 ? parts.join(", ") : "なし";

      if (totalRefilled > 0) {
        addPersonalNotice(playerId, "AP補充", `APが補充されました (${msg})`);
      }

      // 4. 共有AP補充 (同タイミングで実施)
      if (player.factionId) {
        const faction = factionsData.factions[player.factionId];
        if (faction) {
          const checkTimeMs = checkTime.getTime();
          if (
            !faction.lastSharedApRefill ||
            faction.lastSharedApRefill < checkTimeMs
          ) {
            // ランク情報の取得
            const rankData = cachedFactionRanks.find(
              (r) => r.id === player.factionId,
            );
            const rank = rankData ? rankData.rank : 999;
            const memberCount = faction.members ? faction.members.length : 0;

            // 共有AP上限: Base * Active
            const { limit: sharedCap, activeMemberCount: activeMembers } =
              calculateFactionSharedAPLimit(faction, players, settings);

            // 弱小勢力なら補充 (+50固定)
            if (isWeakFaction(rank, memberCount)) {
              const sharedBonus = 50;
              if (typeof faction.sharedAP !== "number") faction.sharedAP = 0;
              faction.sharedAP = Math.min(
                sharedCap,
                faction.sharedAP + sharedBonus,
              );

              // 通知
              io.to(`faction:${player.factionId}`).emit("faction:updated", {
                factionId: player.factionId,
                faction: getEnrichedFaction(
                  player.factionId,
                  factionsData,
                  players,
                  { ranks: cachedFactionRanks },
                ),
              });
              console.log(
                `[SharedAP] Refilled +${sharedBonus} for ${faction.name} (Rank:${rank}, Active:${activeMembers}, Cap:${sharedCap})`,
              );
            }

            faction.lastSharedApRefill = checkTimeMs;
            queueFactionSave();
          }
        }
      }
    }

    if (processedThisStep) {
      lastSuccessTime = checkTime.getTime();
    }
    checkTime.setTime(checkTime.getTime() + INTERVAL_MS);
  }

  let refilledAmount = null;

  // 個人AP上限の計算（スコープ外へ移動）
  let indLimit = apConfig.limits?.individual ?? 50;
  if (settings.gardenMode) {
    // 庭園モードON時、一度も認証(lastAuthenticated)が行われていないユーザーの上限は半分
    // (期限切れでも過去に成功していればペナルティなし)
    if (!player.lastAuthenticated) {
      indLimit = Math.floor(indLimit / 2);
    }
  }

  if (lastSuccessTime !== null) {
    const oldAp = player.ap || 0;
    // 上限(indLimit)は計算済み
    player.ap = Math.min((player.ap || 0) + totalRefilled, indLimit);
    refilledAmount = player.ap - oldAp;

    player.lastApAutoUpdate = lastSuccessTime;
    if (saveToDisk) queuePlayerSave();

    console.log(
      `[AP Refill Final] Player: ${playerId}, TotalAdd: ${totalRefilled}, NewAP: ${player.ap}/${indLimit}`,
    );
  } else {
    // [NEW] 補充が発生しなくても、現在値が上限を超えている場合は切り詰める (設定変更やペナルティ適用時など)
    if ((player.ap || 0) > indLimit) {
      console.log(
        `[AP Cap] Player: ${playerId} AP capped from ${player.ap} to ${indLimit}`,
      );
      player.ap = indLimit;
      if (saveToDisk) queuePlayerSave();
    }

    if (!player.lastApAutoUpdate) {
      // 初回設定
      const initialMark = new Date(now);
      const min = initialMark.getMinutes();
      const flooredMin = Math.floor(min / 10) * 10;
      initialMark.setMinutes(flooredMin, 0, 0);
      player.lastApAutoUpdate = initialMark.getTime();
      if (saveToDisk) queuePlayerSave();
    }
  }

  return { player, refilledAmount };
}

// 統計情報を利用して個別の勢力情報をリッチ化する (整合性修復ロジック含む)
function getEnrichedFaction(fid, factions, players, preCalcStats = null) {
  const f = factions.factions[fid];
  if (!f) return null;

  // 勢力主がいない、もしくはメンバーから外れている場合の整合性修復
  if (!f.kingId || !f.members.includes(f.kingId)) {
    if (f.members && f.members.length > 0) {
      f.kingId = f.members[0];
      queueFactionSave();
    } else {
      f.kingId = null;
    }
  }

  // メンバーリストの整合性チェックと自動修復
  // プレイヤーデータ上でこの勢力に所属していないメンバーを除外する
  let memberListChanged = false;
  f.members = f.members.filter((pid) => {
    const p = players.players[pid];
    // プレイヤーが存在しない、または所属IDが一致しない場合は除外
    // (意図的な脱退処理漏れや競合による不整合をここで自動回収する)
    if (!p || p.factionId !== fid) {
      memberListChanged = true;
      return false;
    }
    return true;
  });

  if (memberListChanged) {
    console.log(`[AutoRepair] Removed invalid members from faction ${fid}`);
    queueFactionSave();
  }

  let factionTileCount = 0;
  let factionTotalPoints = 0;
  let playerTileCounts = {};
  let playerTilePoints = {};

  if (preCalcStats && preCalcStats.factions && preCalcStats.factions[fid]) {
    factionTileCount = preCalcStats.factions[fid].tileCount;
    factionTotalPoints = preCalcStats.factions[fid].totalPoints;
    playerTileCounts = preCalcStats.factions[fid].playerTileCounts || {};
    playerTilePoints = preCalcStats.factions[fid].playerTilePoints || {};
  } else {
    // フォールバック: 引数で統計が渡されない場合は計算(互換用)
    const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });
    Object.entries(mapState.tiles).forEach(([key, t]) => {
      const tileFactionId = t.factionId || t.faction;
      if (tileFactionId === fid) {
        const parts = key.split("_");
        if (parts.length < 2) return;
        const points = getTilePoints(parseInt(parts[0]), parseInt(parts[1]));
        factionTileCount++;
        factionTotalPoints += points;
        const pid = t.paintedBy;
        if (pid) {
          playerTileCounts[pid] = (playerTileCounts[pid] || 0) + 1;
          playerTilePoints[pid] = (playerTilePoints[pid] || 0) + points;
        }
      }
    });
  }

  const roleMap = {};
  if (f.roles) {
    f.roles.forEach((r) => {
      roleMap[r.id] = r.rank || 99;
    });
  }

  // アクティブメンバー数の算出 (24時間以内に lastApAction があるユーザー)
  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  let activeMemberCount = 0;
  const activeMemberIds = [];

  const memberInfo = (f.members || [])
    .filter((pid) => pid != null)
    .map((pid) => {
      const p = players.players[pid];
      const shortId = toShortId(pid);

      const isActive = p?.lastApAction && now - p.lastApAction < ONE_DAY_MS;
      if (isActive) {
        activeMemberCount++;
        activeMemberIds.push(pid);
      }

      return {
        id: pid,
        displayName: p?.displayName || shortId,
        shortId: shortId,
        isKing: f.kingId === pid,
        isActive: !!isActive, // フロントエンド表示用
        tileCount: playerTileCounts[pid] || 0,
        points: playerTilePoints[pid] || 0,
        role:
          f.memberRoles?.[pid] ||
          (f.kingId === pid ? f.kingRoleName || "勢力主" : "Member"),
        rank:
          f.kingId === pid
            ? 1
            : roleMap[f.memberRoles?.[pid]] ||
              (f.memberRoles?.[pid] === "Member" ? 99 : 50),
      };
    });

  memberInfo.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.displayName.localeCompare(b.displayName, "ja");
  });

  // 弱小勢力判定
  let isWeak = false;
  // [NEW] 管理者が所属している勢力は弱小勢力扱いしない（ボーナス無効）
  // adminId.txt に記載されたIDと一致するプレイヤーがメンバーにいるか確認
  let hasAdmin = false;
  if (
    currentAdminIdGlobal &&
    f.members &&
    f.members.includes(currentAdminIdGlobal)
  ) {
    hasAdmin = true;
  }

  // 統計情報がある場合はそれからランクを取得、なければメモリ内のキャッシュから取得
  const rankData = preCalcStats?.ranks
    ? preCalcStats.ranks.find((r) => r.id === fid)
    : cachedFactionRanks.find((r) => r.id === fid);

  const rank = rankData ? rankData.rank : 999;

  // Top 3 Alliance Check
  let top3Alliances = [];
  const alliancesData = loadJSON(ALLIANCES_PATH, { alliances: {} });
  if (preCalcStats) {
    top3Alliances = getTop3AllianceIds(
      alliancesData.alliances,
      factions,
      preCalcStats,
    );
  }

  if (hasAdmin) {
    isWeak = false;
  } else {
    // 総人数ではなくアクティブ人数で判定 (preCalcStats の有無に関わらず実行)
    const isWeakResult = isWeakFactionUnified(
      rank,
      activeMemberCount,
      fid,
      f.allianceId,
      top3Alliances,
    );
    if (isWeakResult) {
      isWeak = true;
    }
  }

  // Debug log for weak faction determination (Can be removed after fix)
  if (fid.includes("faction-")) {
    console.log(
      `[WeakCheck] fid=${fid}, rank=${rank}, active=${activeMemberCount}, isWeak=${isWeak}, cacheSize=${cachedFactionRanks.length}`,
    );
  }

  // [NEW] 共有AP上限の付与
  // 毎回計算は少し重いが、頻繁に変わる(Active人数ベース)ためここで計算する
  const settings = loadJSON(SYSTEM_SETTINGS_PATH, {
    apSettings: {},
    mergerSettings: { prohibitedRank: 0 },
  });
  const { limit: sharedLimit } = calculateFactionSharedAPLimit(
    f,
    players,
    settings,
    activeMemberIds,
  );

  return {
    ...f,
    id: fid,
    rank,
    tileCount: factionTileCount,
    totalPoints: factionTotalPoints,
    playerTileCounts,
    playerTilePoints,
    members: memberInfo,
    activeMemberCount, // 追加
    isWeak,
    adminId: currentAdminIdGlobal,
    sharedAPLimit: sharedLimit, // [NEW] クライアント側で表示に使用
  };
}

// 勢力へのお知らせを追加 (拡張版)
async function addFactionNotice(
  factionId,
  title,
  content,
  requiredPermission = null,
  metadata = {},
  options = null, // { actions: [{ label, action, style }] }
  type = "info", // "info", "join_request", etc.
  requesterId = null,
) {
  const notice = {
    id: `fn-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    title,
    content,
    requiredPermission,
    date: new Date().toISOString(),
    isFactionNotice: !factionId.startsWith("user:"), // ユーザー宛の場合は勢力通知フラグをオフ
    data: metadata,
    options,
    type,
    requesterId,
    processedBy: null, // { playerId, name, at }
    result: null, // "approved" (承認済み), "rejected" (却下)
  };

  await updateJSON(FACTION_NOTICES_PATH, (notices) => {
    if (!notices[factionId]) notices[factionId] = [];
    notices[factionId].unshift(notice);

    // 最大50件保持
    if (notices[factionId].length > 50) {
      notices[factionId] = notices[factionId].slice(0, 50);
    }
    return notices;
  });

  console.log(`[Notice] Added to ${factionId}: ${title} (ID: ${notice.id})`);

  // リアルタイム通知
  if (requiredPermission) {
    // 権限が必要な場合は個別に送信
    const roomName = `faction:${factionId}`;
    const sockets = await io.in(roomName).fetchSockets();
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const faction = factions.factions[factionId];

    for (const socket of sockets) {
      // socket.playerId は接続ハンドラで設定される（実装されていれば）
      // または見つける必要がある。カスタマイズされた接続ハンドラが socket.playerId を設定する。
      if (
        socket.playerId &&
        hasPermission(faction, socket.playerId, requiredPermission)
      ) {
        socket.emit("faction:notice", {
          factionId,
          notice,
        });
      }
    }
  } else {
    // 制限なしなら一斉送信
    io.to(`faction:${factionId}`).emit("faction:notice", {
      factionId,
      notice,
    });
  }

  return notice;
}

// [DELETED] cleanupOldPlayers has been deprecated and abandoned due to data loss risk.
// Automatic player deletion is now disabled.

// マップ履歴ディレクトリ
const HISTORY_DIR = path.join(DATA_DIR, "history");
if (!fs.existsSync(HISTORY_DIR)) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

// マップスナップショット保存
function saveMapSnapshot() {
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(
    2,
    "0",
  )}${String(now.getDate()).padStart(2, "0")}`;
  const timeStr = `${String(now.getHours()).padStart(2, "0")}${String(
    now.getMinutes(),
  ).padStart(2, "0")}`;
  const filename = `map_${dateStr}_${timeStr}.json`;
  const filePath = path.join(HISTORY_DIR, filename);

  const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });
  const factions = loadJSON(FACTIONS_PATH, { factions: {} });

  // 履歴にはタイル情報と勢力情報の両方を保存する
  saveJSON(filePath, {
    tiles: structuredClone(mapState.tiles),
    factions: structuredClone(factions.factions),
  });
  console.log(`Saved map snapshot: ${filename}`);
}

// 定期実行スケジューラー (1分ごとに実行)
function startScheduler() {
  const now = new Date();
  // 次の「00秒」を計算
  const nextTime = new Date(now);
  nextTime.setMinutes(now.getMinutes() + 1, 0, 0);

  const delay = nextTime.getTime() - now.getTime();
  // console.log(`Next scheduled task in ${Math.round(delay / 1000)} seconds.`);

  setTimeout(async () => {
    await runScheduledTasks();
    // 1分ごとに定期実行
    setInterval(async () => {
      try {
        await runScheduledTasks();
      } catch (e) {
        console.error("Error in scheduled tasks:", e);
      }
    }, 60 * 1000);
  }, delay);
}

async function runScheduledTasks() {
  const now = new Date();
  const min = now.getMinutes();
  console.log(`Running scheduled tasks... min: ${min}`);

  // ===== 1分間隔の並列整合性・中核チェック =====
  // 統合された Worker タスクにより整合性チェックと中核管理を行う
  await runCoreMaintenanceFull();

  // 2. 滅亡判定 & ポイント再計算
  // 整合性チェック後に中核を失った勢力を判定し、滅亡させる
  await recalculateAllFactionPoints();

  // 3. 同盟・戦争の整合性チェック
  checkAllianceAndWarIntegrity();

  // ===== 既存の分散タスク =====

  // 1. バケット分散通知 (00, 20, 30, 40, 50分の補充に対する通知)
  // 各補充タイミングから5分後までの間に分散
  const scheduledMinutes = [
    { start: 5, end: 9, base: 4, type: "game_ids_00" },
    { start: 25, end: 29, base: 24, type: "random_20" },
    { start: 35, end: 39, base: 34, type: "random_30" },
    { start: 45, end: 49, base: 44, type: "random_40" },
    { start: 55, end: 59, base: 54, type: "random_50" },
  ];

  const currentSchedule = scheduledMinutes.find(
    (s) => min >= s.start && min <= s.end,
  );

  if (currentSchedule || (min >= 36 && min <= 39)) {
    // 互換性のための既存の random_30 も含む (重複するが bucket 計算が異なる場合があるため)
    if (currentSchedule) {
      const bucket = min - currentSchedule.base;
      // バッチ配信 (io.emitのオーバーヘッド削減)
      batchEmitAPBucketCheck({ bucket, type: currentSchedule.type });
    } else if (min >= 36 && min <= 39) {
      // 既存ロジック (フォールバック)
      const bucket = min - 35;
      batchEmitAPBucketCheck({ bucket, type: "random_30" });
    }
  }

  // 2. マップ保存 (15分ごと)
  if (min % 15 === 0) {
    saveMapSnapshot();
    // ID解決も15分ごと
    resolvePlayerIds();
  }

  // 00分, 30分の特別なサーバー処理があればここに書く
  // 現状は遅延評価なので、クライアントからのアクセスを待つだけで良い。
  // 強制的な処理は不要。

  // 4. 秘密トリガーチェック (毎分チェック / ユーザー要望)
  await processSecretTriggers(true);
}

// プレイヤーの knownPostIds にある Game Key を 内部ID に置換・統合する (並列版)
async function resolvePlayerIds() {
  try {
    const playersData = loadJSON(PLAYERS_PATH, { players: {} });
    const pids = Object.keys(playersData.players);
    if (pids.length === 0) return;

    const chunks = Array.from({ length: numWorkers }, () => []);
    pids.forEach((pid, i) => chunks[i % numWorkers].push(pid));

    const tasks = chunks.map((chunk) =>
      runWorkerTask("RESOLVE_PLAYER_IDS", {
        playerIds: chunk,
        filePaths: {
          players: PLAYERS_PATH,
          gameIds: GAME_IDS_PATH,
        },
      }),
    );

    const results = await Promise.all(tasks);
    const allUpdatedPlayers = {};
    let anyChanged = false;

    results.forEach((res) => {
      if (res.success && res.results.changed) {
        anyChanged = true;
        Object.assign(allUpdatedPlayers, res.results.updatedPlayers);
      }
    });

    if (anyChanged) {
      await updateJSON(PLAYERS_PATH, (data) => {
        Object.entries(allUpdatedPlayers).forEach(([pid, p]) => {
          data.players[pid] = p;
        });
        return data;
      });
      console.log(
        `[ResolveID] Parallel resolution completed. Updated ${Object.keys(allUpdatedPlayers).length} players.`,
      );
    }

    // [NEW] 定期的なWorkerキャッシュパージ
    console.log("[Core] Broadcating CLEAR_CACHE to all workers...");
    for (let i = 0; i < workers.length; i++) {
      runWorkerTask("CLEAR_CACHE", { workerId: i }).catch((e) =>
        console.error(
          `[Core] Failed to clear cache for Worker ${i}:`,
          e.message,
        ),
      );
    }
  } catch (e) {
    console.error("Error in resolvePlayerIds:", e);
  }
}

/**
 * 個別プレイヤーの同期ロジック (内部用: players.players[id] オブジェクトを直接操作)
 * @returns {boolean} 変更があったかどうか
 */
function syncPlayerWithGameIdsInternal(player, currentAuthKey, gameIds) {
  let updated = false;

  // Helper
  const isGameKey = (k) => k && /^(game-)?[0-9a-f]{8}$/i.test(k);

  // 1. 現在の認証キーを履歴追加
  if (isGameKey(currentAuthKey)) {
    if (!player.authHistory) player.authHistory = [];
    if (!player.authHistory.includes(currentAuthKey)) {
      player.authHistory.push(currentAuthKey);
      updated = true;
    }
  }

  // 2. knownPostIds 内の認証キーを内部IDに置換、または補完
  if (player.knownPostIds && Array.isArray(player.knownPostIds)) {
    const originalIds = [...player.knownPostIds];
    const newKnownIds = new Set(player.knownPostIds);

    for (const id of originalIds) {
      if (isGameKey(id)) {
        const entry = gameIds[id];
        if (entry && entry.id) {
          const internalId = entry.id;
          if (!newKnownIds.has(internalId)) {
            newKnownIds.add(internalId);
            updated = true;
          }
          if (newKnownIds.has(id)) {
            newKnownIds.delete(id);
            updated = true;
          }
          // 履歴へ移動
          if (!player.authHistory) player.authHistory = [];
          if (!player.authHistory.includes(id)) {
            player.authHistory.push(id);
            updated = true;
          }
        }
      }
    }
    if (updated) {
      player.knownPostIds = Array.from(newKnownIds);
    }
  }

  // 3. 現在の認証キーに対応するIDの補完 (knownPostIdsが空などの場合)
  if (currentAuthKey && gameIds[currentAuthKey]) {
    const internalId = gameIds[currentAuthKey].id;
    if (internalId) {
      if (!player.knownPostIds) player.knownPostIds = [];
      if (!player.knownPostIds.includes(internalId)) {
        player.knownPostIds.push(internalId);
        updated = true;
      }
    }
  }

  return updated;
}

/**
 * プレイヤーの認証状態（庭園モード等）を同期する。
 * (updateJSON ブロック内での使用を想定)
 */
async function syncPlayerWithGameIds(player, req, gameIds = null) {
  if (!player) return;

  const settings = loadJSON(SYSTEM_SETTINGS_PATH, {
    gardenMode: false,
    mergerSettings: { prohibitedRank: 0 },
  });
  if (!settings.gardenMode) return;

  if (!gameIds) {
    gameIds = loadJSON(GAME_IDS_PATH, {});
  }

  // 認証キーの生成 (cookieになければ生成)
  const authKey = generateGardenAuthKey(
    req,
    player.displayName || player.username,
  );
  const today = getTodayString();
  const isGameKey = (k) => k && /^(game-)?[0-9a-f]{8}$/i.test(k);

  let isAuthorized = false;
  // 直接の認証キーでの照合
  if (isGameKey(authKey) && gameIds[authKey]) {
    isAuthorized = true;
  }
  // 紐付け済みIDでの照合
  if (!isAuthorized && player.knownPostIds && player.knownPostIds.length > 0) {
    isAuthorized = true;
  }

  // [NEW] 認証履歴に追加 (まだない場合)
  if (isAuthorized) {
    player.lastAuthenticated = today;
  }

  // 内部的な紐付け処理
  syncPlayerWithGameIdsInternal(player, authKey, gameIds);
}

// 初回起動時のチェック: もし起動直後が00分なら AP補充すべきだが、
// 複雑になるのでスケジューラーに任せる。
// ただし、サーバー再起動でスキップされるリスクはある。
// (今回は簡易的な実装とする)

startScheduler();

// 日付ヘルパー
function getTodayString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

// ネットワークヘルパー
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = forwarded ? forwarded.split(",")[0] : req.socket.remoteAddress;
  return ip;
}

// [NEW] 庭園認証キー生成 (アカウント > Cookie > IP)
function generateGardenAuthKey(req, username = null) {
  const today = getTodayString();
  let seedBase = "";

  if (username) {
    seedBase = `user:${username.trim().toLowerCase()}`;
  } else {
    const cookieName = getCookieName(req, "persistentId");
    const persistentId = req.cookies && req.cookies[cookieName];
    if (persistentId) {
      seedBase = `cookie:${persistentId}`;
    } else {
      seedBase = `ip:${getClientIp(req)}`;
    }
  }

  const seed = seedBase + today;
  return crypto
    .createHash("sha256")
    .update(seed)
    .digest("hex")
    .substring(0, 8)
    .toUpperCase();
}

function recordPlayerIp(players, currentPlayerId, ip) {
  if (!ip || !players[currentPlayerId]) return;
  const player = players[currentPlayerId];
  if (!player.lastIps) player.lastIps = [];

  // 直近のIPと同じなら記録しない (生IP)
  if (player.lastIps[0] === ip) return;

  // 全てのアカウントを対象にIPの所有状況をチェック
  const associatedAccounts = [];
  for (const [pid, p] of Object.entries(players)) {
    if (p.lastIps && p.lastIps.includes(ip)) {
      associatedAccounts.push({
        id: pid,
        displayName: p.displayName || p.username,
      });
    }
  }
  // 今回アクセスしている自分もリストに追加（重複判定と記録のため）
  if (!associatedAccounts.some((a) => a.id === currentPlayerId)) {
    associatedAccounts.push({
      id: currentPlayerId,
      displayName: player.displayName || player.username,
    });
  }

  // 1人より多い（＝自分以外にもそのIPを使っている人がいる）場合、一元管理ファイルに記録
  if (associatedAccounts.length > 1) {
    let duplicates = {};
    if (fs.existsSync(DUPLICATE_IP_PATH)) {
      try {
        duplicates = JSON.parse(fs.readFileSync(DUPLICATE_IP_PATH, "utf8"));
      } catch {
        duplicates = {};
      }
    }

    duplicates[ip] = {
      lastDetectedAt: new Date().toISOString(),
      accounts: associatedAccounts,
    };

    try {
      fs.writeFileSync(DUPLICATE_IP_PATH, JSON.stringify(duplicates, null, 2));
    } catch (e) {
      console.error("Failed to write duplicate_ip.json:", e);
    }
  }

  player.lastIps.unshift(ip);
  if (player.lastIps.length > 3) {
    player.lastIps = player.lastIps.slice(0, 3);
  }
}

// 認証ミドルウェア
// 認証ミドルウェア (ゲストアクセス対応)
function authenticate(req, res, next) {
  const persistentId =
    req.cookies && req.cookies[getCookieName(req, "persistentId")];

  if (!persistentId) {
    req.isGuest = true;
    req.playerId = null;
    return next();
  }

  const playersWrapper = loadJSON(PLAYERS_PATH, { players: {} });
  const player = playersWrapper.players[persistentId];

  if (!player) {
    req.isGuest = true;
    req.playerId = null;
    return next();
  }

  // 認証成功
  req.playerId = persistentId;
  req.isGuest = false;
  req.player = player;
  next();
}

// 認証必須ミドルウェア (重要アクション用)
function requireAuth(req, res, next) {
  if (req.isGuest || !req.playerId) {
    return res.status(401).json({
      error: "login_required",
      message: "このアクションにはログインが必要です",
    });
  }
  next();
}

// システム通知の追加 (管理画面用)
app.post("/api/admin/notices", requireAdminAuth, async (req, res) => {
  try {
    const { title, content } = req.body;

    if (!title || !content) {
      return res.status(400).json({ error: "タイトルと本文は必須です" });
    }

    const newNotice = {
      id: "sys-" + Date.now(),
      title,
      content,
      date: new Date().toISOString(),
    };

    await updateJSON(
      SYSTEM_NOTICES_PATH,
      (data) => {
        if (!data.notices) data.notices = [];
        data.notices.unshift(newNotice);
        // 上限100件
        if (data.notices.length > 100) {
          data.notices = data.notices.slice(0, 100);
        }
        return data;
      },
      { notices: [] },
    );

    // リアルタイム通知
    io.emit("system:notice", {
      ...newNotice,
      body: newNotice.content, // クライアント互換性
      type: "system_info",
    });

    res.json({ success: true, notice: newNotice });
  } catch (e) {
    console.error("Add Notice Error:", e);
    res.status(500).json({ error: "通知の追加に失敗しました" });
  }
});

// システム通知の削除 (管理画面用)
app.post("/api/admin/notices/delete", requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.body;

    await updateJSON(
      SYSTEM_NOTICES_PATH,
      (data) => {
        if (!data.notices) return data;
        data.notices = data.notices.filter((n) => n.id !== id);
        return data;
      },
      { notices: [] },
    );

    res.json({ success: true });
  } catch (e) {
    console.error("Delete Notice Error:", e);
    res.status(500).json({ error: "通知の削除に失敗しました" });
  }
});

// 管理者パスワード変更API
app.post("/api/admin/change-password", requireAdminAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const settings = loadJSON(SYSTEM_SETTINGS_PATH, {
      adminPassword: null,
      mergerSettings: { prohibitedRank: 0 },
    });

    if (!(await verifyAdminPassword(currentPassword, settings))) {
      return res.status(403).json({ error: "現在のパスワードが違います" });
    }

    if (!newPassword || newPassword.length < 4) {
      return res
        .status(400)
        .json({ error: "新しいパスワードは4文字以上で設定してください" });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    settings.adminPassword = hash;
    saveJSON(SYSTEM_SETTINGS_PATH, settings);

    res.json({ success: true, message: "パスワードを変更しました" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "内部サーバーエラー" });
  }
});

// ===== API エンドポイント =====

// 認証キー発行（IPベース管理）
// 新機能：サインアップ (ユーザー名/パスワード)
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || username.trim().length === 0) {
      return res.status(400).json({ error: "ユーザー名を入力してください" });
    }
    if (!password || password.length < 4) {
      return res
        .status(400)
        .json({ error: "パスワードは4文字以上で入力してください" });
    }

    // 庭園モードチェック (アカウント作成時はスキップし、作成後に認証状を表示する)
    const settings = loadJSON(SYSTEM_SETTINGS_PATH, {
      gardenMode: false,
      mergerSettings: { prohibitedRank: 0 },
    });
    /*
    if (settings.gardenMode) {
      const today = getTodayString();
      const gameIds = loadJSON(GAME_IDS_PATH, {});
      // 簡易化のため、gameIds の中に、このユーザー名+日付から生成されるキーが存在するかチェック
      const seed = username.trim().toLowerCase() + today;
      const expectedKey = crypto
        .createHash("sha256")
        .update(seed)
        .digest("hex")
        .substring(0, 8)
        .toUpperCase();

      const isAuthorized =
        gameIds[expectedKey] &&
        gameIds[expectedKey].counts &&
        gameIds[expectedKey].counts[today];

      if (!isAuthorized) {
        return res.status(403).json({
          error: "garden_auth_required",
          message: "掲示板での認証が必要です。指定のキーを書き込んでください。",
          authKey: expectedKey,
        });
      }
    }
    */

    const ip = getClientIp(req);
    const accountSettings = settings.accountSettings || {
      maxAccountsPerIp: 2,
      excludedIps: "",
    };

    // IP制限のチェック
    if (ip) {
      const excludedIps = (accountSettings.excludedIps || "")
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      if (!excludedIps.includes(ip)) {
        const playersData = loadJSON(PLAYERS_PATH, { players: {} });
        let counts = 0;
        for (const p of Object.values(playersData.players || {})) {
          if (p.lastIps && p.lastIps.includes(ip)) {
            counts++;
          }
        }

        const max = parseInt(accountSettings.maxAccountsPerIp) || 2;
        if (counts >= max) {
          return res.status(403).json({
            error: "IP_LIMIT_EXCEEDED",
            message: `このIPアドレスからはこれ以上アカウントを作成できません（上限: ${max}）`,
          });
        }
      }
    }

    const trimmedUsername = username.trim();

    const result = await updateJSON(
      PLAYERS_PATH,
      async (data) => {
        if (!data.players) data.players = {};

        // 重複チェック (大文字小文字を区別しない) - username と displayName 両方をチェック
        const exists = Object.values(data.players).some(
          (p) =>
            p.username?.toLowerCase() === trimmedUsername.toLowerCase() ||
            p.displayName?.toLowerCase() === trimmedUsername.toLowerCase(),
        );
        if (exists) {
          throw new Error("このユーザー名は既に使用されています");
        }

        const playerId = `u-${crypto.randomBytes(8).toString("hex")}`;
        const passwordHash = await bcrypt.hash(password, 10);
        const ip = getClientIp(req);

        data.players[playerId] = {
          id: playerId,
          username: trimmedUsername,
          displayName: trimmedUsername,
          passwordHash: passwordHash,
          ap: settings.apSettings?.initialAp ?? 10, // 初期AP
          lastApUpdate: Date.now(),
          createdAt: new Date().toISOString(),
          lastIps: [],
        };
        if (ip) {
          recordPlayerIp(data.players, playerId, ip);
        }

        return { playerId, players: data };
      },
      { players: {} },
    );

    // Cookie セット
    res.cookie(getCookieName(req, "persistentId"), result.playerId, {
      httpOnly: false,
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });

    res.json({ success: true, playerId: result.playerId });
  } catch (e) {
    console.error("Signup error:", e);
    res.status(400).json({ error: e.message || "登録に失敗しました" });
  }
});

// 新機能：ログイン (ユーザー名/パスワード)
app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "ユーザー名とパスワードを入力してください" });
    }

    const playersWrapper = loadJSON(PLAYERS_PATH, { players: {} });
    const playerEntry = Object.entries(playersWrapper.players).find(
      ([, p]) =>
        (p.displayName || p.username)?.toLowerCase() ===
        username.trim().toLowerCase(),
    );

    if (!playerEntry) {
      return res
        .status(401)
        .json({ error: "ユーザー名またはパスワードが正しくありません" });
    }

    const [playerId, player] = playerEntry;
    const match = await bcrypt.compare(password, player.passwordHash);

    if (!match) {
      return res
        .status(401)
        .json({ error: "ユーザー名またはパスワードが正しくありません" });
    }

    // 庭園モードチェック (ログイン時も日替わり認証を求める) -> 廃止: 警告のみにするため削除
    // const settings = loadJSON(SYSTEM_SETTINGS_PATH, { gardenMode: false });

    // Cookie セット
    res.cookie(getCookieName(req, "persistentId"), playerId, {
      httpOnly: false,
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });

    res.json({ success: true, playerId });
  } catch (e) {
    console.error("Login error:", e);
    res.status(500).json({ error: "サーバーエラーが発生しました" });
  }
});

// 旧互換用エンドポイント
app.post("/api/auth/key", async (req, res) => {
  res.status(410).json({
    error: "gone",
    message:
      "この認証方式は廃止されました。ユーザー名とパスワードでログインしてください。",
  });
});

// 新機能：ステータス取得 (ゲスト対応)
app.get("/api/auth/status", authenticate, async (req, res) => {
  try {
    const settings = loadJSON(SYSTEM_SETTINGS_PATH, {
      gardenMode: false,
      mergerSettings: { prohibitedRank: 0 },
    });
    const isGardenMode = settings.gardenMode || false;
    const today = getTodayString();
    const gameIds = loadJSON(GAME_IDS_PATH, {});

    const getAuthStatus = (key) => {
      const entry = gameIds[key];
      return !!(entry && entry.counts && entry.counts[today]);
    };

    if (req.isGuest) {
      const guestKey = generateGardenAuthKey(req);
      return res.json({
        authenticated: false,
        isGuest: true,
        player: null,
        gardenMode: isGardenMode,
        gardenAuthKey: guestKey,
        gardenIsAuthorized: getAuthStatus(guestKey),
        mergerSettings: settings.mergerSettings || { prohibitedRank: 0 }, // [NEW] send to client
        namedTileSettings: {
          maxNamedTiles: 50,
          ...(settings.namedTileSettings || {}),
        }, // [FIX] Merge defaults
      });
    }

    const playerId = req.playerId;
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });

    let responseData = {
      authenticated: true,
      isGuest: false,
      player: null,
    };

    await updateJSON(
      PLAYERS_PATH,
      async (players) => {
        const player = players.players[playerId];
        if (player) {
          // IP記録
          recordPlayerIp(players.players, playerId, getClientIp(req));

          // 認証状態の同期 (handleApRefill の前に行う)
          await syncPlayerWithGameIds(player, req, gameIds);

          // 勢力生存チェック
          if (player.factionId && !factions.factions[player.factionId]) {
            player.factionId = null;
          }

          // AP補充
          const { player: updatedPlayer, refilledAmount } = handleApRefill(
            player,
            players,
            playerId,
            false,
          );

          responseData.player = {
            ...updatedPlayer,
            id: playerId,
            refilledAmount,
          };
        }
        return players;
      },
      { players: {} },
    );

    // 庭園モードなら認証情報を付与
    if (isGardenMode && responseData.player) {
      const authKey = generateGardenAuthKey(
        req,
        responseData.player.displayName || responseData.player.username,
      );
      responseData.player.gardenAuthKey = authKey;
      responseData.player.gardenIsAuthorized = getAuthStatus(authKey);
    }

    responseData.gardenMode = isGardenMode;
    responseData.gardenRefillCost = settings.apSettings?.gardenRefillCost ?? 30;
    responseData.gardenRefillAmount =
      settings.apSettings?.gardenRefillAmount ?? 50;
    responseData.namedTileSettings = {
      maxNamedTiles: 50,
      ...(settings.namedTileSettings || {}),
    }; // [FIX] Merge defaults

    // [NEW] AP設定情報を返す
    responseData.apSettings = {
      limits: settings.apSettings?.limits || {
        individual: 100,
        sharedBase: 50,
      },
      gardenMode: isGardenMode,
      namedTileSettings: settings.namedTileSettings || {
        cost: 100,
        intervalHours: 0,
      },
    };

    return res.json(responseData);
  } catch (e) {
    console.error("Error in /api/auth/status:", e);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// プレイヤー情報取得 (認証必須)
// [NEW] プレイヤー名一覧取得 (ID -> Name マッピング)
app.get("/api/player/names", (req, res) => {
  try {
    const playersData = loadJSON(PLAYERS_PATH, { players: {} });
    const nameMap = {};
    if (playersData && playersData.players) {
      Object.keys(playersData.players).forEach((pid) => {
        const p = playersData.players[pid];
        nameMap[pid] = p.displayName || p.username || "Unknown";
      });
    }
    res.json(nameMap);
  } catch (e) {
    console.error("Error fetching player names:", e);
    res.status(500).json({ error: "名鑑の取得に失敗しました" });
  }
});

// ログインユーザー情報取得
app.get("/api/player", authenticate, async (req, res) => {
  try {
    const playerId = req.playerId;

    if (req.isGuest || !playerId) {
      return res.json({ player: null, isGuest: true });
    }

    // [REMOVED] updateJSON ブロック内で同期するように変更
    // await syncPlayerWithGameIds(playerId, authKey);

    let responseData = { player: null };

    // 2. プレイヤーデータに関わる全処理を updateJSON 内で行う (アトミック)
    await updateJSON(
      PLAYERS_PATH,
      async (players) => {
        let player = players.players[playerId];

        // 勢力生存チェック
        if (player && player.factionId) {
          const factions = loadJSON(FACTIONS_PATH, { factions: {} });
          if (!factions.factions[player.factionId]) {
            player.factionId = null;
          }
        }

        // プレイヤーデータの新規作成または引継ぎ
        if (!player) {
          const prevKey =
            req.cookies && req.cookies[getCookieName(req, "prevAuthKey")];
          let initialAp = 20;
          let inheritedFactionId = null;

          if (prevKey && players.players[prevKey]) {
            const prevPlayer = players.players[prevKey];
            initialAp = prevPlayer.ap || 20;
            inheritedFactionId = prevPlayer.factionId;

            if (inheritedFactionId) {
              await updateJSON(FACTIONS_PATH, async (factions) => {
                const f = factions.factions[inheritedFactionId];
                if (f) {
                  f.members = f.members.filter((m) => m !== prevKey);
                  if (!f.members.includes(playerId)) {
                    f.members.push(playerId);
                  }
                }
                return factions;
              });
            }
            console.log(
              `Inherited data from ${prevKey} to ${playerId}: AP=${initialAp}, Faction=${inheritedFactionId}`,
            );
          }

          player = {
            id: playerId,
            ap: initialAp,
            factionId: inheritedFactionId,
            lastApUpdate: Date.now(),
            lastApAutoUpdate: Date.now(),
            // lastAuthenticated は syncPlayerWithGameIds 内で正しく判定されるため、ここでは初期化しない
            lastAuthenticated: null,
          };
          players.players[playerId] = player;
        } else {
          // 既存プレイヤー: lastAuthenticated の更新は syncPlayerWithGameIds 内で行うためここでは行わない
        }

        // [FIX] knownPostIds が破壊されるのを防ぎつつ、認証キーの紐付けを行う
        // handleApRefill の直前に行うことで、最新の認証状態を適用させる
        await syncPlayerWithGameIds(player, req);

        const { player: updatedPlayer, refilledAmount } = handleApRefill(
          player,
          players,
          playerId,
          false,
        );

        responseData.player = {
          ...updatedPlayer,
          id: playerId,
          refilledAmount,
        };

        return players;
      },
      { players: {} },
    );

    res.json(responseData);
  } catch (e) {
    console.error("Error in /api/player:", e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// [NEW] ログ検索用のテキストを生成するヘルパー (クライアント側の logFormatter.js と同期)
function getLogSearchableText(log) {
  if (typeof log !== "object" || !log) return "";
  if (typeof log.content === "string" && log.content) return log.content;
  if (log.message) return log.message;

  const data = log.data || {};
  const type = log.type;

  switch (type) {
    case "new_user":
      return `新規ユーザー (${data.key || log.key || "???"}) が登録されました`;
    case "faction_joined_via_approval":
      return `${data.playerName || data.playerId || "不明"} が承認により「${data.factionName || data.factionId || "???"}」に加入しました (承認者: ${data.approverName || data.approvedBy || "不明"})`;
    case "faction_created":
      return `新勢力「${data.factionName}」が誕生しました (創設者: ${data.creatorName || data.playerShortId || "不明"})`;
    case "faction_joined":
      return `${data.playerName || "不明"} が「${data.factionName || "???"}」に加入しました`;
    case "faction_left":
      return `${data.playerName || "不明"} が「${data.factionName || "???"}」から脱退しました`;
    case "faction_kicked":
      return `${data.targetName || "不明"} が「${data.factionName || "???"}」から追放されました (追放者: ${data.kickerName || "不明"})`;
    case "faction_destroyed": {
      const destroyedName =
        data.destroyedFactionName || data.targetFactionName || "ある勢力";
      const destroyerName = data.destroyerName || "不明";
      const destroyerFaction = data.destroyerFactionName || "ある勢力";
      if (data.destroyerName) {
        return `${destroyerName}[${destroyerFaction}] が ${destroyedName} を滅亡させました`;
      }
      return data.message || `${destroyedName} が滅亡しました`;
    }
    case "faction_merged":
      return `「${data.sourceFactionName || data.absorbedFactionName || "ある勢力"}」が「${data.targetFactionName || data.absorbingFactionName || "別の勢力"}」に吸収合併されました`;
    case "faction_renamed":
      return `「${data.oldName || "???"}」が勢力名を「${data.newName || "???"}」に変更しました`;
    case "faction_independence":
      return `${data.playerName || "不明"} が「${data.oldFactionName || "???"}」から独立し、新たな勢力「${data.newFactionName || "???"}」を立ち上げました`;
    case "alliance_formed":
    case "alliance_created":
      return `同盟結成: 「${data.leaderFactionName || (data.names && data.names[0]) || "不明"}」が同盟「${data.allianceName || "???"}」を結成しました`;
    case "alliance_request_sent":
      if (data.isInvitation) {
        return `同盟招待: 同盟「${data.allianceName || "???"}」（盟主：${data.leaderFactionName || "不明"}）が ${data.targetFactionName || "不明"} に招待を送りました`;
      }
      return `同盟加盟申請: 「${data.sourceFactionName || "不明"}」が同盟「${data.allianceName || "???"}」（盟主：${data.leaderFactionName || "不明"}）に加盟申請を送りました`;
    case "alliance_broken":
      return `同盟解消: 「${(data.names && data.names[0]) || "?"}」と「${(data.names && data.names[1]) || "?"}」の同盟が解消されました`;
    case "alliance_joined":
      return `同盟加盟: ${data.factionName || "不明"} が 同盟「${data.allianceName || "???"}」（盟主：${data.leaderFactionName || "不明"}）に加盟しました`;
    case "alliance_disbanded":
      return `同盟解散: 同盟「${data.allianceName || "???"}」が解散しました`;
    case "named_cell_created":
    case "named_tile_created": {
      const role =
        data.roleName && data.roleName !== "Member" ? `(${data.roleName})` : "";
      const faction = data.factionName ? `[${data.factionName}]` : "";
      return `${data.creatorName || data.playerName || "不明"}${role}${faction} が 「${data.name || data.cellName || "???"}」 を建設しました`;
    }
    case "named_cell_levelup":
      return `「${data.cellName || "???"}」がレベル${data.newLevel || "?"}にアップグレードされました`;
    case "named_cell_destroyed":
    case "named_cell_deleted": {
      const cellName = data.name || data.cellName || "不明なネームドマス";
      const role = data.roleName ? `(${data.roleName})` : "";
      const faction = data.factionName ? `[${data.factionName}]` : "";
      return `${data.playerName || "不明"}${role}${faction}がネームドマス「${cellName}」を燃やしました`;
    }
    case "named_tile_renamed":
      return `「${data.oldName || "???"}」が「${data.newName || "???"}」に改名されました (変更者: ${data.playerName || "不明"})`;
    case "truce_established":
      return `「${data.factionAName || "?"}」と「${data.factionBName || "?"}」の間で停戦協定が結ばれました`;
    case "war_started":
      return `${data.attackerName || "攻撃側"} が ${data.defenderName || "防衛側"} に侵攻開始`;
    case "shared_ap_donated": {
      const rolePart = data.roleName ? `(${data.roleName})` : "";
      return `${data.playerName || "不明"}${rolePart} が ${data.factionName || "勢力"} に共有APを ${data.amount || 0} 寄付しました`;
    }
    case "shared_ap_withdrawn":
      return `${data.playerName || "不明"} が共有APを ${data.amount || 0} 引き出しました`;
    case "faction_leader_transferred":
    case "faction_leader_changed":
      return `「${data.factionName || "???"}」の盟主が交代しました`;
    case "faction_policy_changed": {
      const policies = {
        open: "誰でも加入可",
        approval: "承認制",
        closed: "募集停止",
      };
      return `「${data.factionName || "自勢力"}」の加入設定が「${policies[data.joinPolicy] || data.joinPolicy}」に変更されました`;
    }
    case "faction_name_changed":
      return `勢力名が「${data.newName || "???"}」に変更されました (変更者: ${data.changedByName || "不明"})`;
    case "faction_color_changed":
      return `「${data.factionName || "???"}」のイメージカラーが変更されました (変更者: ${data.changedByName || "不明"})`;
    case "faction_settings_changed":
      return `「${data.factionName || "???"}」の方針・設定が変更されました`;
    case "tiles_painted": {
      const role =
        data.roleName && data.roleName !== "Member"
          ? ` (${data.roleName})`
          : "";
      const faction = data.factionName ? ` [${data.factionName}]` : "";
      const actionText = data.action === "overpaint" ? "重ね塗り" : "拡張";
      return `${data.painterName || data.playerName || "不明"}${role}${faction} が領土を ${data.count || 0} マス${actionText}しました (${data.x}, ${data.y})${data.destruction ? " (※敵対勢力消滅)" : ""}`;
    }
    case "tiles_invaded": {
      const rName =
        data.roleName && data.roleName !== "Member" ? `(${data.roleName})` : "";
      return `${data.playerName || "不明"}${rName}[${data.factionName || "不明"}] が ${data.targetFactionName || "不明"} から ${data.count || 0} マス奪いました`;
    }
    case "named_tile_resist": {
      const rName =
        data.roleName && data.roleName !== "Member" ? `(${data.roleName})` : "";
      return `[攻撃失敗] ${data.playerName || "不明"}${rName}[${data.factionName || "不明"}] が ${data.targetFactionName || "不明"} のネームドマス「${data.tileName || "???"}」への攻撃に失敗しました`;
    }
    case "named_tile_fallen": {
      const rName =
        data.roleName && data.roleName !== "Member" ? `(${data.roleName})` : "";
      return `ネームドマス「${data.tileName || "???"}」が ${data.playerName || "不明"}${rName}[${data.factionName || "不明"}] によって陥落しました！ (${data.x}, ${data.y})`;
    }
    case "overpaint": {
      const rName =
        data.roleName && data.roleName !== "Member" ? `(${data.roleName})` : "";
      return `${data.playerName || "不明"}${rName}[${data.factionName || "不明"}] が ${data.count || 0} マス重ね塗りしました`;
    }
    case "core_expanded":
      return `「${data.factionName || "不明"}」が支配領土 ${data.totalTiles || "?"}マスで新たに中核マスを獲得しました (${data.x}, ${data.y})`;
    case "alliance_renamed":
      return `同盟「${data.oldName || "???"}」が「${data.newName || "???"}」に同盟名を変更`;
    case "alliance_updated":
      return (
        data.message ||
        `同盟「${data.allianceName || "???"}」の状態が更新されました`
      );
    default:
      return (
        log.message ||
        (data.message
          ? data.message
          : `[${type || "info"}] ${JSON.stringify(data).substring(0, 50)}`)
      );
  }
}

app.get("/api/activity-log", authenticate, (req, res) => {
  const log = loadJSON(ACTIVITY_LOG_PATH, { entries: [] });
  const limit = parseInt(req.query.limit) || 300;
  const beforeId = parseFloat(req.query.beforeId);
  const search = req.query.search; // [NEW] Search keyword

  let entries = Array.isArray(log.entries) ? log.entries : [];

  // 検索フィルタ (全履歴検索)
  if (search) {
    const lowerSearch = search.toLowerCase();
    entries = entries.filter((e) => {
      // 最終的に表示されるメッセージテキストも検索対象に含める
      const fullTextMatch = getLogSearchableText(e)
        .toLowerCase()
        .includes(lowerSearch);
      if (fullTextMatch) return true;

      // 各フィールドの直接検索 (フォールバック・互換性維持)
      const typeMatch = e.type && e.type.toLowerCase().includes(lowerSearch);
      const playerMatch =
        e.data &&
        e.data.playerName &&
        e.data.playerName.toLowerCase().includes(lowerSearch);
      const factionMatch =
        e.data &&
        e.data.factionName &&
        e.data.factionName.toLowerCase().includes(lowerSearch);
      const messageMatch =
        e.data &&
        e.data.message &&
        e.data.message.toLowerCase().includes(lowerSearch);

      // 汎用JSONダンプ検索（フォールバック）
      if (!typeMatch && !playerMatch && !factionMatch && !messageMatch) {
        return JSON.stringify(e).toLowerCase().includes(lowerSearch);
      }
      return typeMatch || playerMatch || factionMatch || messageMatch;
    });
  }

  if (beforeId) {
    entries = entries.filter((e) => e.id < beforeId);
  }

  // クライアントには指定件数のみ返す
  res.json({ entries: entries.slice(0, limit) });
});

// 表示名変更
app.post("/api/player/name", authenticate, async (req, res) => {
  const { displayName } = req.body;

  // ゼロ幅スペース等を含む高度な空白除去バリデーション
  const cleanName = (displayName || "").replace(/[\s\u200B-\u200D\uFEFF]/g, "");

  if (!displayName || cleanName.length === 0) {
    return res.status(400).json({ error: "ユーザー名を入力してください" });
  }
  if (displayName.length > 20) {
    return res
      .status(400)
      .json({ error: "ユーザー名は20文字以内にしてください" });
  }

  try {
    const newName = displayName.trim();

    // [NEW] 重複チェック
    const playersData = loadJSON(PLAYERS_PATH, { players: {} });
    const isDuplicate = Object.entries(playersData.players).some(
      ([pid, p]) => pid !== req.playerId && p.displayName === newName,
    );
    if (isDuplicate) {
      return res.status(400).json({ error: "既に使用済みです" });
    }

    // 1. プレイヤーデータの更新
    await updateJSON(PLAYERS_PATH, (data) => {
      const player = data.players[req.playerId];
      if (!player) throw new Error("プレイヤーが見つかりません");
      player.displayName = newName;
      return data;
    });

    // 2. マップデータ（塗った人名）の同期
    await updateJSON(MAP_STATE_PATH, (mapData) => {
      const updatedTiles = {};
      // [UPDATE] paintedByName廃止のため、タイル側の更新は不要になりました。
      // マップ上の名前表示は playerNames 参照で動的に解決されます。
      if (Object.keys(updatedTiles).length > 0) {
        batchEmitTileUpdate(updatedTiles);
      }
      return mapData;
    });

    // 併合完了通知など

    // 3. アクティビティログの同期
    await updateJSON(ACTIVITY_LOG_PATH, (log) => {
      if (!log.entries) return log;
      log.entries.forEach((entry) => {
        if (entry.data) {
          // data.playerId が一致する場合、関連する名前フィールドをすべて更新
          if (
            entry.data.playerId === req.playerId ||
            entry.data.painterId === req.playerId
          ) {
            const nameKeys = [
              "playerName",
              "painterName",
              "creatorName",
              "changedByName",
              "fromPlayerName",
              "acceptedBy",
              "canceledBy",
              "requestedBy",
              "brokenBy",
            ];
            nameKeys.forEach((key) => {
              if (entry.data[key]) entry.data[key] = newName;
            });
          }
          // 特殊なケース
          if (
            entry.data.destroyerId === req.playerId &&
            entry.data.destroyerName
          ) {
            entry.data.destroyerName = newName;
          }
          if (
            entry.data.newLeaderId === req.playerId &&
            entry.data.newLeaderName
          ) {
            entry.data.newLeaderName = newName;
          }
        }
      });
      return log;
    });

    const updatedPlayers = loadJSON(PLAYERS_PATH, { players: {} });
    const updatedPlayer = updatedPlayers.players[req.playerId];

    res.json({
      success: true,
      displayName: newName,
      playerId: req.playerId,
      player: updatedPlayer,
    });
  } catch (e) {
    console.error("Error updating display name:", e);
    res.status(500).json({ error: e.message || "更新に失敗しました" });
  }
});

// パスワード設定・変更
app.post("/api/player/password", authenticate, async (req, res) => {
  const { password } = req.body;

  if (!password || password.length < 4) {
    return res
      .status(400)
      .json({ error: "パスワードは4文字以上で入力してください" });
  }

  try {
    const hash = await bcrypt.hash(password, 10);

    await updateJSON(PLAYERS_PATH, async (players) => {
      const player = players.players[req.playerId];
      if (!player) return players;
      player.passwordHash = hash;
      return players;
    });

    res.json({ success: true, message: "パスワードを設定しました" });
  } catch (e) {
    console.error("Error setting password:", e);
    res.status(500).json({ error: "サーバーエラーが発生しました" });
  }
});

// 共有AP引き出し
// 共有AP引き出し (廃止: 自動消費へ移行)
// エンドポイント削除

// 加入ポリシー変更
app.post(
  "/api/factions/settings/policy",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const { joinPolicy } = req.body; // 'open', 'approval', 'closed'
    if (!["open", "approval", "closed"].includes(joinPolicy))
      return res.json({ error: "無効な設定です" });

    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const player = loadJSON(PLAYERS_PATH, { players: {} }).players[
      req.playerId
    ];

    if (!player.factionId) return res.json({ error: "勢力に所属していません" });
    const faction = factions.factions[player.factionId];

    if (faction.kingId !== req.playerId)
      return res.json({ error: "権限がありません" });

    faction.joinPolicy = joinPolicy;
    saveJSON(FACTIONS_PATH, factions);

    logActivity("faction_policy_changed", {
      playerId: req.playerId,
      factionId: player.factionId,
      factionName: faction.name,
      joinPolicy: joinPolicy,
    });

    res.json({ success: true, joinPolicy });
  },
);

// 共有AP寄付
app.post(
  "/api/factions/ap/shared/donate",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.json({ error: "不正な値です" });

    let finalPlayerAp = 0;
    let finalSharedAp = 0;

    await updateJSON(PLAYERS_PATH, async (players) => {
      const player = players.players[req.playerId];
      if (!player) return players;
      if (!player.factionId) return players;

      if ((player.ap || 0) < amount) return players;

      await updateJSON(FACTIONS_PATH, async (factions) => {
        const faction = factions.factions[player.factionId];
        if (!faction) return factions;

        // Execute changes safely inside locks
        player.ap = (player.ap || 0) - amount;
        player.lastApAction = Date.now();
        faction.sharedAP = (faction.sharedAP || 0) + amount;

        finalPlayerAp = player.ap;
        finalSharedAp = faction.sharedAP;

        return factions;
      });

      return players;
    });

    res.json({
      success: true,
      playerAp: finalPlayerAp,
      sharedAP: finalSharedAp,
    });
  },
);

// 勢力一覧取得 (メンバー情報を含む)
app.get("/api/factions", authenticate, async (req, res) => {
  try {
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });

    // [OPTIMIZATION] 全タイルの統計計算をWorkerへオフロード・並列化 (O(N_tiles))
    const tileKeys = Object.keys(mapState.tiles);
    const chunkSize = Math.ceil(tileKeys.length / numWorkers);
    const tasks = [];
    for (let i = 0; i < numWorkers; i++) {
      const chunkKeys = tileKeys.slice(i * chunkSize, (i + 1) * chunkSize);
      if (chunkKeys.length > 0) {
        tasks.push(
          runWorkerTask("GET_MAP_STATS_PARTIAL", {
            tileKeys: chunkKeys,
          }),
        );
      }
    }

    const results = await Promise.all(tasks);

    // 結果をマージ
    const stats = { factions: {} };
    results.forEach((res) => {
      if (!res.success || !res.results || !res.results.stats) return;
      const s = res.results.stats;
      Object.keys(s.factions).forEach((fid) => {
        if (!stats.factions[fid]) {
          stats.factions[fid] = {
            tileCount: 0,
            totalPoints: 0,
            playerTileCounts: {},
            playerTilePoints: {},
          };
        }
        const m = stats.factions[fid];
        const r = s.factions[fid];
        m.tileCount += r.tileCount;
        m.totalPoints += r.totalPoints;

        Object.keys(r.playerTileCounts).forEach((pid) => {
          m.playerTileCounts[pid] =
            (m.playerTileCounts[pid] || 0) + r.playerTileCounts[pid];
        });
        Object.keys(r.playerTilePoints).forEach((pid) => {
          m.playerTilePoints[pid] =
            (m.playerTilePoints[pid] || 0) + r.playerTilePoints[pid];
        });
      });
    });

    // [OPTIMIZATION] ランキング計算はWorkerで定期実行されたキャッシュを使用
    stats.ranks = cachedFactionRanks || [];

    const enrichedFactions = {};
    for (const fid of Object.keys(factions.factions)) {
      enrichedFactions[fid] = getEnrichedFaction(fid, factions, players, stats);
    }
    res.json({ factions: enrichedFactions });
  } catch (e) {
    console.error("Error in /api/factions:", e);
    res
      .status(500)
      .json({ error: e.message || "サーバーエラーが発生しました" });
  }
});

// マップ状態取得 (認証なしでも基本情報は閲覧可能にする)
app.get("/api/map", (req, res) => {
  const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });
  res.json({ tiles: mapState.tiles });
});

// [NEW] バイナリ版マップAPI (究極の高速化)
app.get("/api/map/binary", async (req, res) => {
  try {
    // [NEW] SharedArrayBuffer をベースにした高速・正確なバイナリ配信
    // 安定化されたマッピング（ID順ソート済）を使用することで再起動時の不整合を防止

    const tileCount = MAP_SIZE * MAP_SIZE;
    const factionList = indexToFactionId;
    const playerList = playerIds;

    // ヘッダー計算
    let factionNamesSize = 0;
    factionList.forEach((f) => {
      factionNamesSize += 2 + Buffer.from(f).length;
    });

    let playerIdsSize = 0;
    playerList.forEach((pid) => {
      playerIdsSize += 2 + Buffer.from(pid).length;
    });

    const headerSize = 4 + 1 + 8 + 4 + 2 + factionNamesSize + 4 + playerIdsSize;
    const tilesStartOffset = headerSize + 4;
    const totalSize = tilesStartOffset + tileCount * TILE_BYTE_SIZE; // Uses fixed 24B

    const buffer = Buffer.allocUnsafe(totalSize);
    let offset = 0;

    // Header (TMAP)
    buffer.write("TMAP", offset);
    offset += 4;
    buffer.writeUInt8(1, offset);
    offset += 1;
    buffer.writeDoubleLE(Date.now(), offset);
    offset += 8;

    // Factions
    buffer.writeUInt16LE(factionList.length, offset);
    offset += 2;
    factionList.forEach((f) => {
      const b = Buffer.from(f);
      buffer.writeUInt16LE(b.length, offset);
      offset += 2;
      b.copy(buffer, offset);
      offset += b.length;
    });

    // Players
    buffer.writeUInt32LE(playerList.length, offset);
    offset += 4;
    playerList.forEach((pid) => {
      const b = Buffer.from(pid);
      buffer.writeUInt16LE(b.length, offset);
      offset += 2;
      b.copy(buffer, offset);
      offset += b.length;
    });

    // Tile count
    buffer.writeUInt32LE(tileCount, offset);
    offset += 4;

    // Copy entire SAB data
    const sabBuffer = Buffer.from(sharedMapSAB);
    sabBuffer.copy(buffer, offset);

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
  } catch (e) {
    console.error(`Binary map export error: ${e.message}`);
    res.status(500).send("Error exporting binary map");
  }
});

// マップ履歴一覧取得
app.get("/api/map/history", authenticate, (req, res) => {
  if (!fs.existsSync(HISTORY_DIR)) {
    return res.json({ history: [] });
  }

  try {
    const files = fs
      .readdirSync(HISTORY_DIR)
      .filter((file) => file.startsWith("map_") && file.endsWith(".json"))
      .sort(); // 日付順ソート (ファイル名が日付形式なので文字列ソートでOK)
    res.json({ history: files });
  } catch (e) {
    console.error("Error reading history dir:", e);
    res.status(500).json({ error: "履歴の取得に失敗しました" });
  }
});

// 過去のマップデータ取得
app.get("/api/map/history/:filename", authenticate, (req, res) => {
  const filename = req.params.filename;
  // パス走査対策: ファイル名に使用できる文字を制限
  if (!/^[a-zA-Z0-9_]+\.json$/.test(filename)) {
    return res.status(400).json({ error: "不正なファイル名です" });
  }

  const filePath = path.join(HISTORY_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "データが見つかりません" });
  }

  try {
    const historyData = loadJSON(filePath, { tiles: {}, factions: {} });
    res.json({
      tiles: historyData.tiles,
      factions: historyData.factions,
    });
  } catch (e) {
    console.error("Error reading history file:", e);
    res.status(500).json({ error: "データの読み込みに失敗しました" });
  }
});

// プレイヤー設定変更（autoConsumeSharedAp または displayName）
app.post(
  "/api/player/settings",
  authenticate,
  requireAuth,
  async (req, res) => {
    const { autoConsumeSharedAp, displayName } = req.body;

    // 両方とも指定されていない場合はエラー
    if (
      typeof autoConsumeSharedAp !== "boolean" &&
      typeof displayName !== "string"
    ) {
      return res.json({ error: "有効な設定値が指定されていません" });
    }

    // displayName のバリデーション
    if (typeof displayName === "string") {
      const cleanName = displayName.replace(/[\s\u200B-\u200D\uFEFF]/g, "");
      if (!displayName.trim() || cleanName.length === 0) {
        return res.status(400).json({ error: "ユーザー名を入力してください" });
      }
      if (displayName.length > 20) {
        return res
          .status(400)
          .json({ error: "ユーザー名は20文字以内にしてください" });
      }
    }

    try {
      let updatedPlayer = null;
      let nameChanged = false;
      let newName = "";

      await updateJSON(PLAYERS_PATH, (data) => {
        const p = data.players[req.playerId];
        if (!p) throw new Error("Player not found");

        // autoConsumeSharedAp の更新
        if (typeof autoConsumeSharedAp === "boolean") {
          p.autoConsumeSharedAp = autoConsumeSharedAp;
        }

        // displayName の更新
        if (typeof displayName === "string" && displayName.trim()) {
          const trimmed = displayName.trim();
          if (p.displayName !== trimmed) {
            // 他のユーザーとの重複チェック
            const exists = Object.entries(data.players).some(
              ([pid, other]) =>
                pid !== req.playerId &&
                (other.username?.toLowerCase() === trimmed.toLowerCase() ||
                  other.displayName?.toLowerCase() === trimmed.toLowerCase()),
            );
            if (exists) {
              throw new Error("この名前は既に他のユーザーに使用されています");
            }

            p.displayName = trimmed;
            p.username = trimmed; // usernameも同期して統合
            nameChanged = true;
            newName = trimmed;
          }
        }

        updatedPlayer = { ...p };
        return data;
      });

      // [NEW] duplicate_ip.json の同期更新
      if (nameChanged && newName) {
        // 非同期で実行し、レスポンスをブロックしない（エラーログは出す）
        updateJSON(
          DUPLICATE_IP_PATH,
          (data) => {
            if (!data) return data;

            Object.values(data).forEach((entry) => {
              if (entry.accounts && Array.isArray(entry.accounts)) {
                entry.accounts.forEach((acc) => {
                  if (acc.id === req.playerId) {
                    acc.displayName = newName;
                    // 後方互換性のため古いプロパティを削除するか検討したが、
                    // ユーザーの要望に合わせ displayName への移行とする
                    delete acc.username;
                  }
                });
              }
            });
            return data;
          },
          {},
        ).catch((e) =>
          console.error("[Sync] Error updating duplicate_ip.json:", e),
        );
      }

      res.json({
        success: true,
        autoConsumeSharedAp: updatedPlayer?.autoConsumeSharedAp,
        displayName: updatedPlayer?.displayName,
        player: updatedPlayer,
      });
    } catch (e) {
      console.error("Error updating player settings:", e);
      res.status(500).json({ error: "設定の更新に失敗しました" });
    }
  },
);

// 過去のマップデータ取得

// お知らせ一覧取得
app.get("/api/notices", authenticate, (req, res) => {
  try {
    // 必要なデータを冒頭で一括読み込み (ReferenceError防止)
    const allFactionNotices = loadJSON(FACTION_NOTICES_PATH, {});
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const player = players.players[req.playerId];

    // システム通知 (JSON)
    const systemNoticesData = loadJSON(SYSTEM_NOTICES_PATH, {
      notices: [],
    });
    let publicNotices = systemNoticesData.notices || [];

    // 日付順ソート (降順)
    publicNotices.sort((a, b) => new Date(b.date) - new Date(a.date));

    // 最大50件
    publicNotices = publicNotices.slice(0, 50);

    // 勢力別のお知らせを取得
    // 勢力別のお知らせ（外交・勢力通知）
    let factionNotices = [];
    if (player && player.factionId) {
      const rawFactionNotices = allFactionNotices[player.factionId] || [];
      const myFaction = factions.factions[player.factionId];

      factionNotices = rawFactionNotices
        .filter((n) => {
          if (n.requiredPermission) {
            return hasPermission(myFaction, req.playerId, n.requiredPermission);
          }
          return true;
        })
        .map((n) => ({
          ...n,
          type: n.type || "diplomacy",
        }));
    }

    // [NEW] 永続化されたグローバルお知らせを取得
    let globalNotices = (allFactionNotices.global || []).map((n) => ({
      ...n,
      type: "management",
    }));

    // [Fix 1] 個人宛のお知らせを取得 (滅亡通知など)
    const personalKey = `user:${req.playerId}`;
    const personalNotices = (allFactionNotices[personalKey] || []).map((n) => ({
      ...n,
      type: n.type || "personal", // 'personal' type for frontend if needed
    }));

    const typedPublicNotices = publicNotices.map((n) => ({
      ...n,
      type: "management",
    }));

    // Merge global, faction, personal, and public notices (use Map to unique by ID/Content)
    const uniqueNotices = new Map();

    // まずファイルからのお知らぜをセット
    typedPublicNotices.forEach((n) => {
      uniqueNotices.set(n.id, n);
    });

    // 次にJSON（永続化済み）からのお知らぜをセット（ファイルにないものも含まれる）
    // 同一IDがあれば上書きされるが、同一内容（タイトル+本文）の重複も防ぐ
    globalNotices.forEach((n) => {
      // IDが一致するか、内容が一致する既存の通知を探す
      let exists = uniqueNotices.has(n.id);
      if (!exists) {
        for (const existing of uniqueNotices.values()) {
          if (existing.title === n.title && existing.content === n.content) {
            exists = true;
            break;
          }
        }
      }

      if (!exists) {
        uniqueNotices.set(n.id, n);
      }
    });

    const finalManagementNotices = Array.from(uniqueNotices.values()).sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );

    const merged = [
      ...factionNotices,
      ...personalNotices,
      ...finalManagementNotices,
    ]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 1000);

    // [DEPRECATED] 既読情報は client の localStorage で管理するように移行
    const readNoticeIds = [];

    res.json({ notices: merged, readNoticeIds });
  } catch (e) {
    console.error("Error reading notices:", e);
    res.status(500).json({ error: "お知らせの取得に失敗しました" });
  }
});

// お知らせ一括既読化 API
app.post("/api/notices/:id/read", authenticate, async (req, res) => {
  try {
    // [DEPRECATED] 既読情報は client の localStorage で管理するように移行するため
    // サーバー側の players.json への保存は廃止
    res.json({ success: true });
  } catch (e) {
    console.error("Error marking notice as read:", e);
    res.status(500).json({ error: "既読処理に失敗しました" });
  }
});

// お知らせ一括既読化 API (すべて)
app.post("/api/notices/read-all", authenticate, async (req, res) => {
  const { noticeIds } = req.body;
  if (!Array.isArray(noticeIds)) {
    return res.status(400).json({ error: "noticeIds must be an array" });
  }

  try {
    // [DEPRECATED] 既読情報は client の localStorage で管理するように移行するため
    // サーバー側の players.json への保存は廃止
    res.json({ success: true });
  } catch (e) {
    console.error("Error marking all notices as read:", e);
    res.status(500).json({ error: "一括既読処理に失敗しました" });
  }
});

// 勢力作成
app.post(
  "/api/factions",
  authenticate,
  requireAuth,
  checkGameStatus,
  async (req, res) => {
    const { name, color, origin } = req.body;

    if (!name || !color || origin === undefined) {
      return res.status(400).json({ error: "必要な情報が不足しています" });
    }

    // 名前バリデーション
    if (name.replace(/[\s\u200B-\u200D\uFEFF]/g, "").length === 0) {
      return res
        .status(400)
        .json({ error: "勢力名には有効な文字を含めてください" });
    }
    if (name.length > 20) {
      return res
        .status(400)
        .json({ error: "勢力名は20文字以内で入力してください" });
    }

    if (color.toLowerCase() === "#ffffff") {
      return res
        .status(400)
        .json({ error: "白色(#ffffff)は勢力色として使用できません" });
    }

    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });

    // 勢力名の重複チェック
    const trimmedName = name.trim();
    for (const faction of Object.values(factions.factions)) {
      if (faction.name === trimmedName) {
        return res
          .status(400)
          .json({ error: "この勢力名は既に使用されています" });
      }
    }

    const player = players.players[req.playerId];
    if (player.factionId) {
      return res.status(400).json({ error: "既に勢力に所属しています" });
    }

    // コストチェック (後で距離判定などでコストが変わる可能性があるため、ここでは仮チェック)
    // クールダウンチェック（3時間制限）
    const now = Date.now();
    if (player.lastFactionLeft) {
      const elapsed = now - player.lastFactionLeft;
      if (elapsed < FACTION_COOLDOWN_MS) {
        const remainingMs = FACTION_COOLDOWN_MS - elapsed;
        const remainingHours = (remainingMs / (1000 * 60 * 60)).toFixed(1);
        return res.status(400).json({
          error: `直近の勢力操作から${FACTION_COOLDOWN_HOURS}時間経過するまで、新しく勢力を建国することはできません（残り約 ${remainingHours} 時間）`,
        });
      }
    }

    /*
  const originKey = `${origin.x},${origin.y}`;
  */
    /*
  const originKeyStr = `${origin.x}_${origin.y}`;
  */
    const originKeyStr = `${origin.x}_${origin.y}`;
    const existingTile = mapState.tiles[originKeyStr];

    if (existingTile && (existingTile.faction || existingTile.factionId)) {
      return res.status(400).json({
        error:
          "既に他の勢力の領土となっている場所には、新しく勢力を立てることはできません",
      });
    }

    // 確定コストチェック
    if (player.ap < FACTION_ACTION_COST) {
      return res.status(400).json({
        error: `APが不足しています（必要: ${FACTION_ACTION_COST}）`,
      });
    }

    // 距離制限削除のため、以下のループチェックは削除
    /*
  for (const f of Object.values(factions.factions)) {
    const dist =
      Math.abs(f.origin.x - origin.x) + Math.abs(f.origin.y - origin.y);
    if (dist < 21) {
      return res
        .status(400)
        .json({ error: "他の勢力に近すぎます（21マス以上離してください）" });
    }
  }
  */

    // マップ端チェック
    if (
      origin.x < 0 ||
      origin.x >= MAP_SIZE ||
      origin.y < 0 ||
      origin.y >= MAP_SIZE
    ) {
      return res.status(400).json({ error: "起点座標が無効です" });
    }

    const factionId = `faction-${Date.now()}`;
    const playerDisplayName = player.displayName || toShortId(req.playerId);
    const newFaction = {
      id: factionId,
      name,
      color,
      origin,
      members: [req.playerId],
      kingId: req.playerId, // 作成者が勢力主
      createdAt: new Date(Date.now() + 9 * 60 * 60 * 1000)
        .toISOString()
        .replace("Z", "+09:00"),
      roles: [],
      memberRoles: {},
      territoryPoints: 1,
      totalPoints: 1,
      sharedAP: 0,
      alliances: [],
      allianceRequests: [],
    };

    // 3. アトミックなDB更新
    try {
      await updateJSON(
        FACTIONS_PATH,
        async (fData) => {
          fData.factions[factionId] = newFaction;
        },
        { factions: {} },
      );

      await updateJSON(
        PLAYERS_PATH,
        async (pData) => {
          pData.players[req.playerId].factionId = factionId;
          pData.players[req.playerId].lastFactionCreated = now;
          pData.players[req.playerId].ap -= FACTION_ACTION_COST;
          pData.players[req.playerId].lastApAction = now;
        },
        { players: {} },
      );

      await updateJSON(
        MAP_STATE_PATH,
        async (mData) => {
          mData.tiles[originKeyStr] = {
            faction: factionId,
            factionId: factionId,
            color: color,
            paintedBy: req.playerId,
            paintedAt: new Date().toISOString(),
            core: {
              factionId: factionId,
              expiresAt: null,
            },
          };
        },
        { tiles: {} },
      );

      // アクティビティログ
      logActivity("faction_created", {
        playerId: req.playerId,
        factionId,
        factionName: name,
        creatorName: playerDisplayName,
        x: origin.x,
        y: origin.y,
        origin,
      });

      // ルームに参加させる
      joinFactionRoom(req.playerId, factionId);

      // クライアント同期
      batchEmitFactionsUpdate(true); // Faction作成は即時
      batchEmitTileUpdate({
        [originKeyStr]: loadJSON(MAP_STATE_PATH).tiles[originKeyStr],
      });
      io.emit("ap:refresh");

      const enriched = getEnrichedFaction(
        factionId,
        loadJSON(FACTIONS_PATH),
        loadJSON(PLAYERS_PATH),
      );
      res.json({ success: true, faction: enriched });
    } catch (e) {
      console.error("[CreateFaction] Critical Error:", e);
      // 可能であれば状態を戻す（任意だが複雑）
      res.status(500).json({
        error: "勢力作成中にサーバーエラーが発生しました: " + e.message,
      });
    }
  },
);

// 勢力参加
app.post(
  "/api/factions/:id/join",
  authenticate,
  requireAuth,
  checkGameStatus,
  async (req, res) => {
    try {
      const factionId = req.params.id;
      const now = Date.now();

      const joinResult = await updateJSON(
        FACTIONS_PATH,
        async (fData) => {
          const faction = fData.factions[factionId];
          if (!faction) throw new Error("勢力が見つかりません");

          return await updateJSON(
            PLAYERS_PATH,
            async (pData) => {
              const player = pData.players[req.playerId];
              if (!player) throw new Error("プレイヤーが見つかりません");
              if (player.factionId) throw new Error("既に勢力に所属しています");

              // 加入制限チェックなどは既に行われている前提
              if (faction.joinPolicy === "closed") {
                throw new Error("この勢力には直接加入できません");
              }

              if (faction.joinPolicy === "approval") {
                // 加入申請の重複チェック
                const noticesData = loadJSON(FACTION_NOTICES_PATH, {});
                const factionNotices = noticesData[factionId] || [];
                const existingRequest = factionNotices.find(
                  (n) =>
                    n.type === "join_request" &&
                    n.requesterId === req.playerId &&
                    !n.processedBy,
                );

                if (existingRequest) {
                  return {
                    applied: true,
                    message:
                      "既にこの勢力に加入申請を送信済みです。承認をお待ちください。",
                  };
                }

                // 申請を作成
                await addFactionNotice(
                  factionId,
                  "加入申請",
                  `${player.displayName || toShortId(req.playerId)} から加入申請が届きました。`,
                  "canManageMembers",
                  { candidateId: req.playerId },
                  {
                    actions: [
                      {
                        label: "承認",
                        action: "approve",
                        style: "success",
                      },
                      { label: "拒否", action: "reject", style: "danger" },
                    ],
                  },
                  "join_request",
                  req.playerId,
                );

                return { applied: true };
              }

              if (!faction.members.includes(req.playerId)) {
                faction.members.push(req.playerId);
              }
              player.factionId = factionId;
              player.lastFactionLeft = now;
              return { success: true };
            },
            { players: {} },
          );
        },
        { factions: {} },
      );

      if (joinResult && joinResult.applied) {
        return res.json({
          success: true,
          message:
            joinResult.message ||
            "加入申請を送信しました。承認をお待ちください。",
          applied: true,
        });
      }

      logActivity("faction_joined", {
        playerId: req.playerId,
        playerName:
          loadJSON(PLAYERS_PATH).players[req.playerId].displayName ||
          toShortId(req.playerId),
        factionId,
        factionName: loadJSON(FACTIONS_PATH).factions[factionId].name,
      });

      // ルームに参加させる
      joinFactionRoom(req.playerId, factionId);

      // クライアント同期
      batchEmitFactionsUpdate(true); // 加入も即時

      const enriched = getEnrichedFaction(
        factionId,
        loadJSON(FACTIONS_PATH),
        loadJSON(PLAYERS_PATH),
      );
      io.to(`faction:${factionId}`).emit("faction:updated", {
        factionId,
        faction: enriched,
      });
      io.to(`faction:${factionId}`).emit("faction:member_joined", {
        factionId,
        memberId: req.playerId,
      });

      res.json({ success: true, faction: enriched });
    } catch (e) {
      // ユーザー向けのバリデーションエラー（名前、所属、ポリシー、申請済み等）は簡潔な警告ログに留める
      const validationErrors = [
        "勢力が見つかりません",
        "プレイヤーが見つかりません",
        "既に勢力に所属しています",
        "この勢力には直接加入できません",
        "既にこの勢力に加入申請を送信済みです。",
      ];

      if (validationErrors.includes(e.message)) {
        console.warn(
          `[JoinFaction] Validation Error: ${e.message} (Player: ${req.playerId})`,
        );
      } else {
        console.error("[JoinFaction] Unexpected Error:", e);
      }
      res.status(400).json({ error: e.message });
    }
  },
);

// 通知への応答 (承認/拒否など)
app.post(
  "/api/factions/notices/:noticeId/respond",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const { noticeId } = req.params;
    const { action } = req.body; // 'approve' | 'reject'

    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const player = players.players[req.playerId];
    const factionId = player.factionId;

    if (!factionId)
      return res.status(400).json({ error: "勢力に所属していません" });

    const noticesData = loadJSON(FACTION_NOTICES_PATH, {});
    const factionNotices = noticesData[factionId];
    if (!factionNotices)
      return res.status(404).json({ error: "通知が見つかりません" });

    const notice = factionNotices.find((n) => n.id === noticeId);
    if (!notice) return res.status(404).json({ error: "通知が見つかりません" });

    // 既に処理済みかチェック
    if (notice.processedBy) {
      return res.status(400).json({ error: "この通知は既に処理されています" });
    }

    // 権限チェック
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const faction = factions.factions[factionId];
    const hasPerm =
      faction.kingId === req.playerId ||
      hasPermission(
        faction,
        req.playerId,
        notice.requiredPermission || "canManageMembers",
      );

    if (!hasPerm) {
      return res.status(403).json({ error: "権限がありません" });
    }

    // 処理実行
    if (notice.type === "join_request") {
      const candidateId = notice.data?.candidateId;
      if (!candidateId)
        return res.status(400).json({ error: "申請者データが不正です" });

      const candidate = players.players[candidateId];

      if (action === "approve") {
        if (candidate) {
          if (candidate.factionId) {
            // 他の勢力に既に参加している場合
            await updateJSON(FACTION_NOTICES_PATH, (noticesData) => {
              const factionNotices = noticesData[factionId];
              const noticeToUpdate = factionNotices.find(
                (n) => n.id === noticeId,
              );
              if (noticeToUpdate) {
                noticeToUpdate.processedBy = {
                  playerId: req.playerId,
                  name: player.displayName || toShortId(req.playerId),
                  at: new Date().toISOString(),
                };
                noticeToUpdate.result = "rejected_due_to_other_faction";
              }
              return noticesData;
            });

            return res.status(400).json({
              error: "申請者は既に他の勢力に所属しています。",
              result: "ignore",
            });
          }

          // 加入処理
          if (!faction.members.includes(candidateId)) {
            await updateJSON(FACTIONS_PATH, (factionsData) => {
              const f = factionsData.factions[factionId];
              if (f && !f.members.includes(candidateId))
                f.members.push(candidateId);
              return factionsData;
            });

            await updateJSON(PLAYERS_PATH, (playersData) => {
              const c = playersData.players[candidateId];
              if (c) {
                c.factionId = factionId;
                c.lastFactionLeft = Date.now();
              }
              return playersData;
            });

            logActivity("faction_joined_via_approval", {
              playerId: candidateId,
              factionId,
              approvedBy: req.playerId,
              playerName: candidate.displayName || toShortId(candidateId),
              factionName: faction.name,
              approverName: player.displayName || toShortId(req.playerId),
            });

            addFactionNotice(
              factionId,
              "新規メンバー加入",
              `${candidate.displayName || toShortId(candidateId)} が承認により加入しました！`,
              null,
              { memberId: candidateId },
              null,
              "member_joined",
              candidateId,
            );

            // 申請者に通知 (トースト)
            io.to(`user:${candidateId}`).emit("notification:toast", {
              title: "加入承認",
              message: `${faction.name} への加入が承認されました！`,
              type: "success",
            });
          }

          await updateJSON(FACTION_NOTICES_PATH, (noticesData) => {
            const factionNotices = noticesData[factionId];
            const noticeToUpdate = factionNotices.find(
              (n) => n.id === noticeId,
            );
            if (noticeToUpdate) {
              noticeToUpdate.processedBy = {
                playerId: req.playerId,
                name: player.displayName || toShortId(req.playerId),
                at: new Date().toISOString(),
              };
              noticeToUpdate.result = "approved";
            }
            return noticesData;
          });

          const enriched = getEnrichedFaction(factionId, factions, players);
          joinFactionRoom(candidateId, factionId);
          io.to(`faction:${factionId}`).emit("faction:updated", {
            factionId,
            faction: enriched,
          });

          return res.json({
            success: true,
            message: "加入申請を承認しました。",
          });
        }
      } else {
        // 拒否
        await updateJSON(FACTION_NOTICES_PATH, (noticesData) => {
          const factionNotices = noticesData[factionId];
          const noticeToUpdate = factionNotices.find((n) => n.id === noticeId);
          if (noticeToUpdate) {
            noticeToUpdate.processedBy = {
              playerId: req.playerId,
              name: player.displayName || toShortId(req.playerId),
              at: new Date().toISOString(),
            };
            noticeToUpdate.result = "rejected";
          }
          return noticesData;
        });

        // 申請者に通知 (トースト)
        io.to(`user:${candidateId}`).emit("notification:toast", {
          title: "加入拒否",
          message: `${faction.name} への加入申請が拒否されました。`,
          type: "warning",
        });

        return res.json({
          success: true,
          message: "加入申請を拒否しました。",
        });
      }
    } else if (notice.type === "merge_request") {
      // 合併申請処理
      const requesterFactionId = notice.data?.requesterFactionId;
      const requesterFaction = factions.factions[requesterFactionId];

      if (!requesterFaction) {
        return res.status(400).json({ error: "申請元勢力が見つかりません" });
      }

      if (action === "approve") {
        // 合併実行: 申請元の勢力 -> ターゲット勢力 (自勢力)
        // 1. メンバー移動
        const membersToMove = [...requesterFaction.members];
        membersToMove.forEach((mid) => {
          const p = players.players[mid];
          if (p) {
            p.factionId = factionId;
            // 重複チェック
            if (!faction.members.includes(mid)) {
              faction.members.push(mid);
            }
          }
        });

        // 2. タイル移譲 (Worker Offloading)
        // [NEW] 勢力合併の重い処理をWorkerにオフロード (PROCESS_MERGE)
        try {
          const result = await runWorkerTask("PROCESS_MERGE", {
            filePaths: { mapState: MAP_STATE_PATH },
            requesterFactionId,
            targetFactionId: factionId,
            targetColor: faction.color,
          });

          if (result.success) {
            const { updatedTiles, count } = result.results;
            console.log(
              `[Merge] Worker processed ${count} tiles for merge validation.`,
            );

            // メインスレッドのキャッシュを更新
            // loadJSONは参照を返すので、そこに統合する
            const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });
            Object.assign(mapState.tiles, updatedTiles);

            // 保存と配信
            saveJSON(MAP_STATE_PATH, mapState);
            io.emit("tile:update", updatedTiles);
          } else {
            console.error("[Merge] Worker failed:", result.error);
            // エラー時でもメンバー移動は完了しているため、リトライ不可能ならログだけ残す
            // (本来はトランザクションが必要)
          }
        } catch (e) {
          console.error("[Merge] Error calling worker:", e);
        }

        // 3. 旧勢力の削除
        cleanupDestroyedFaction(requesterFactionId);
        delete factions.factions[requesterFactionId];
        queueFactionSave();
        queuePlayerSave();

        // 4. ログ
        logActivity("faction_merged", {
          factionId: factionId,
          absorbedFactionId: requesterFactionId,
          absorbedFactionName: requesterFaction.name,
          factionName: faction.name,
        });

        io.emit("faction:destroyed", { factionId: requesterFactionId });
        io.emit("faction:updated", {
          factionId: factionId,
          faction: getEnrichedFaction(factionId, factions, players),
        });

        addFactionNotice(
          factionId,
          "勢力合併",
          `${requesterFaction.name} を吸収合併しました。`,
          null,
          {},
          null,
          "info",
        );
      }
    }

    // 通知更新（処理済みマーク）
    await updateJSON(FACTION_NOTICES_PATH, (noticesData) => {
      const factionNotices = noticesData[factionId];
      const noticeToUpdate = factionNotices.find((n) => n.id === noticeId);
      if (noticeToUpdate) {
        noticeToUpdate.processedBy = {
          id: req.playerId,
          name: player.displayName || toShortId(req.playerId),
          at: new Date().toISOString(),
        };
        noticeToUpdate.result = action; // 'approve' or 'reject'

        // [NEW] 同盟拒否時のクールダウン設定 (1時間)
        if (action === "reject" && noticeToUpdate.type === "alliance_request") {
          const reqFid = noticeToUpdate.data?.requesterFactionId;
          if (reqFid && factions.factions[reqFid]) {
            const rFaction = factions.factions[reqFid];
            if (!rFaction.rejectedCooldowns) rFaction.rejectedCooldowns = {};
            if (!rFaction.rejectedCooldowns.alliance)
              rFaction.rejectedCooldowns.alliance = {};

            const cd = Date.now() + 60 * 60 * 1000;
            rFaction.rejectedCooldowns.alliance[factionId] = new Date(
              cd,
            ).toISOString();
            // factionsの保存は後続の処理で行われるか確認が必要だが、
            // ここで明示的に保存しても良い。
            // ただし existing code 3757 で faction:updated emit しているが saveJSON(FACTIONS_PATH) が見当たらない。
            // line 3539 で loadJSON しているが、更新があるなら saveJSON 必要。
            // reject時はしていないかもしれない。ここで保存する。
            queueFactionSave();
          }
        }
      }
      return noticesData;
    });

    // 通知更新をブロードキャスト
    // 通知更新をブロードキャスト (ターゲット限定)
    io.to(`faction:${factionId}`).emit("faction:noticeUpdated", {
      factionId,
      notice,
    });

    // 勢力データも更新されている可能性があるためemit
    if (action === "approve") {
      io.to(`faction:${factionId}`).emit("faction:updated", {
        factionId,
        faction: getEnrichedFaction(factionId, factions, players),
      });
    }
    // [NEW] 拒否時でもクールダウン情報更新のためemitすべきか？
    // 申請者に対してemitする必要があるが、申請元勢力の更新通知はここではないかもしれない。
    // しかし申請元側に関わるデータ変更なので、念のため。
    if (action === "reject" && notice.type === "alliance_request") {
      const reqFid = notice.data?.requesterFactionId;
      if (reqFid) {
        io.emit("faction:updated", {
          factionId: reqFid,
          faction: getEnrichedFaction(reqFid, factions, players),
        });
      }
    }

    res.json({ success: true, notice });
  },
);

// [NEW] 他勢力へのメッセージ送信 (ポイント通知) - 5AP消費
app.post(
  "/api/factions/:factionId/message",
  authenticate,
  requireAuth,
  checkGameStatus,
  async (req, res) => {
    try {
      const { factionId } = req.params;
      const { message } = req.body;

      if (!message || message.trim().length === 0) {
        return res.status(400).json({ error: "メッセージを入力してください" });
      }
      if (message.length > 200) {
        return res
          .status(400)
          .json({ error: "メッセージは200文字以内で入力してください" });
      }

      const settings = loadJSON(SYSTEM_SETTINGS_PATH, {});
      const MESSAGE_COST = settings.apSettings?.messageCost || 5;

      const players = loadJSON(PLAYERS_PATH, { players: {} });
      const factions = loadJSON(FACTIONS_PATH, { factions: {} });

      const player = players.players[req.playerId];
      if (!player) {
        return res.status(404).json({ error: "プレイヤーが見つかりません" });
      }

      if (player.ap < MESSAGE_COST) {
        return res
          .status(400)
          .json({ error: `APが足りません (必要: ${MESSAGE_COST}AP)` });
      }

      const targetFaction = factions.factions[factionId];
      if (!targetFaction) {
        return res.status(404).json({ error: "送信先の勢力が見つかりません" });
      }

      if (player.factionId === factionId) {
        return res.status(400).json({ error: "自分の勢力には送信できません" });
      }

      const myFaction = player.factionId
        ? factions.factions[player.factionId]
        : null;
      const senderName = player.displayName || player.name || "不明";
      const senderFactionName = myFaction ? myFaction.name : "放浪者";

      // Shared AP Permission Check
      const hasSharedApPerm =
        myFaction &&
        (myFaction.kingId === req.playerId ||
          hasPermission(myFaction, req.playerId, "canUseSharedAp"));

      // AP Check & Consumption
      const apConsumeResult = attemptApConsumption(
        player,
        myFaction,
        MESSAGE_COST,
        req.playerId,
        hasSharedApPerm,
        false, // actual consumption
      );

      if (!apConsumeResult.success) {
        return res
          .status(400)
          .json({ error: `APが足りません (必要: ${MESSAGE_COST}AP)` });
      }

      queuePlayerSave();
      if (apConsumeResult.usedSharedAp > 0) {
        queueFactionSave();
        io.emit("faction:updated", {
          factionId: myFaction.id,
          faction: getEnrichedFaction(myFaction.id, factions, players),
        });
      }

      // 通知の作成
      const noticeTitle = "ポイント通知 (メッセージ)";
      const noticeContent = `【差出人】${senderFactionName}：${senderName}\n\n${message}`;

      await addFactionNotice(
        factionId,
        noticeTitle,
        noticeContent,
        "canDiplomacy", // 外交権限者または主のみ
        { senderId: req.playerId, senderFactionId: player.factionId },
        null,
        "message",
        req.playerId,
      );

      // 自分のAP更新を通知
      io.to(`user:${req.playerId}`).emit("player:updated", player);

      res.json({
        success: true,
        message: "メッセージを送信しました",
        newAp: player.ap,
      });
    } catch (e) {
      console.error("Error in /api/factions/message:", e);
      res.status(500).json({ error: "メッセージ送信中にエラーが発生しました" });
    }
  },
);

// 勢力脱退
app.post(
  "/api/factions/leave",
  authenticate,
  requireAuth,
  checkGameStatus,
  async (req, res) => {
    try {
      const { isIndependence, newFactionName, newFactionColor } = req.body;
      const now = Date.now();

      // 独立時カラーのデバッグログ
      if (isIndependence) {
        console.log(
          `[Independence] Request: Name=${newFactionName}, Color=${newFactionColor}`,
        );
      }

      // 1. 独立の場合の事前バリデーション
      if (isIndependence) {
        if (!newFactionName || !newFactionName.trim()) {
          return res.status(400).json({ error: "勢力名を入力してください" });
        }
        if (newFactionName.trim().length > 20) {
          return res
            .status(400)
            .json({ error: "勢力名は20文字以内で入力してください" });
        }
        if (!newFactionColor || newFactionColor.toLowerCase() === "#ffffff") {
          return res.status(400).json({ error: "無効な勢力カラーです" });
        }

        // 勢力名重複チェック (現在のメモリから簡易チェック)
        const currentFactions = loadJSON(FACTIONS_PATH, { factions: {} });
        for (const f of Object.values(currentFactions.factions)) {
          if (f.name === newFactionName.trim()) {
            return res
              .status(400)
              .json({ error: "その勢力名は既に使用されています" });
          }
        }

        // 独立に必要な条件のチェック
        const playersData = loadJSON(PLAYERS_PATH, { players: {} });
        const player = playersData.players[req.playerId];
        if (!player || !player.factionId) {
          return res
            .status(400)
            .json({ error: "勢力に所属していないため、独立できません" });
        }
        const oldFactionId = player.factionId;

        const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });
        let hasCoreTile = false;

        for (const tile of Object.values(mapState.tiles)) {
          // 自勢力の領土 かつ 自分が塗装したマス
          if (
            (tile.factionId || tile.faction) === oldFactionId &&
            tile.paintedBy === req.playerId
          ) {
            // かつ 現在中核であるもの
            if (tile.core && tile.core.factionId === oldFactionId) {
              hasCoreTile = true;
              break;
            }
          }
        }

        if (!hasCoreTile) {
          // [MODIFIED] 中核マスを持っていなくても、自分が塗ったマスがあれば独立可能とする
          // バリデーションとしては「自分が塗ったマスが1つ以上あること」だけチェックすれば良い
          // ここでのチェックは実質不要（クライアント側でフィルタリングされている前提だが、念のため）
          let hasPaintedTile = false;
          for (const tile of Object.values(mapState.tiles)) {
            if (
              (tile.factionId || tile.faction) === oldFactionId &&
              tile.paintedBy === req.playerId
            ) {
              hasPaintedTile = true;
              break;
            }
          }

          if (!hasPaintedTile) {
            return res.status(400).json({
              error:
                "独立するためには、自分が塗装したマスを少なくとも1つ保持している必要があります。",
            });
          }
        }
      }

      // 2. プレイヤーデータの更新 (ロック付き)
      // 勢力IDの取得とクールダウンチェック
      let oldFactionId = null;
      let newFactionId = null; // 独立時に生成
      let playerDisplayName = null;

      await updateJSON(
        PLAYERS_PATH,
        async (players) => {
          if (!players.players) players.players = {};
          const player = players.players[req.playerId];
          if (!player) throw new Error("プレイヤーが見つかりません");

          if (!player.factionId) {
            throw new Error("勢力に所属していません");
          }

          // クールダウンチェック（3時間制限：独立・脱退・建国後に適用）
          if (player.lastFactionLeft) {
            const elapsed = now - player.lastFactionLeft;
            if (elapsed < FACTION_COOLDOWN_MS) {
              const remainingMs = FACTION_COOLDOWN_MS - elapsed;
              const remainingHours = (remainingMs / (1000 * 60 * 60)).toFixed(
                1,
              );
              throw new Error(
                `前回の勢力操作から${FACTION_COOLDOWN_HOURS}時間経過するまで、脱退や独立はできません（残り約 ${remainingHours} 時間）`,
              );
            }
          }

          oldFactionId = player.factionId;
          playerDisplayName = player.displayName || toShortId(req.playerId);

          // 独立の場合の勢力作成前処理
          if (isIndependence) {
            // 独立（新規作成）にはコストが必要？
            // "脱退のAP消費を廃止" -> 独立は脱退+作成。
            // 作成コストは別途あるべきだが、ここでは既存ロジックが統合されていた。
            // ユーザー要望に従い、ここでの「脱退に伴うコスト」は無しとする。
            // もし作成コストが必要なら別途定義すべきだが、一旦「脱退」アクションとして無料化する。
            // 文脈的に「自由に出入りしたい」要望なので、独立も無料または低コストが望ましいかもしれない。
            // ここでは安全に、既存の脱退コストロジックを削除する方針で統一。
            newFactionId = `faction-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
          }

          if (isIndependence) {
            player.factionId = newFactionId; // 新勢力へ移動
            player.lastFactionCreated = now; // 独立（建国）タイムスタンプ更新
          } else {
            player.factionId = null; // 無所属へ
          }
          player.lastFactionLeft = now; // 脱退タイムスタンプ更新

          return { success: true };
        },
        { players: {} },
      );

      if (!oldFactionId) {
        return res.status(400).json({ error: "処理に失敗しました" });
      }

      // 3. 勢力データの更新 (新勢力作成 & 旧勢力脱退処理)
      let oldFactionName = "不明な勢力";
      let factionDestroyed = false;
      let newFactionObj = null;

      await updateJSON(
        FACTIONS_PATH,
        async (factions) => {
          if (!factions.factions) factions.factions = {};
          // --- A. 新勢力作成 (独立時) ---
          if (isIndependence && newFactionId) {
            newFactionObj = {
              id: newFactionId,
              name: newFactionName.trim(),
              color: newFactionColor,
              kingId: req.playerId,
              members: [req.playerId],
              memberRoles: {},
              roles: [],
              createdAt: new Date(Date.now() + 9 * 60 * 60 * 1000)
                .toISOString()
                .replace("Z", "+09:00"),
              lastActive: new Date().toISOString(),
              ap: 0,
              sharedAP: 0,
              tiles: 0,
              alliances: [],
              allianceRequests: [],
            };
            factions.factions[newFactionId] = newFactionObj;
          }

          // --- B. 旧勢力からの削除 ---
          const oldFaction = factions.factions[oldFactionId];
          if (oldFaction) {
            oldFactionName = oldFaction.name;
            // メンバーから削除
            oldFaction.members = oldFaction.members.filter(
              (id) => id !== req.playerId,
            );

            // [NEW] メンバー減少に伴う共有AP上限チェック
            // ここは updateJSON のコールバック内なので、clampFactionSharedAP を直接呼んで
            // factions オブジェクト（参照）を変更してもらう
            // プレイヤー情報は別途ロードする必要があるが、updateJSONのスコープ外なので関数内でロードしてもらう
            if (oldFaction.sharedAP > 0) {
              // clampFactionSharedAPはasyncだが中でloadJSON(sync)を使っている前提ならawaitでいける
              // ただしここは非同期コールバックなのでawait可能
              await clampFactionSharedAP(oldFactionId, factions);
            }

            // memberRoles からも削除
            if (
              oldFaction.memberRoles &&
              oldFaction.memberRoles[req.playerId]
            ) {
              delete oldFaction.memberRoles[req.playerId];
            }

            // 勢力主の継承ロジック
            if (oldFaction.kingId === req.playerId) {
              if (oldFaction.members.length > 0) {
                // 次のリーダー選出
                const nextKing =
                  oldFaction.members[
                    Math.floor(Math.random() * oldFaction.members.length)
                  ];
                oldFaction.kingId = nextKing;

                logActivity("faction_leader_changed", {
                  factionName: oldFaction.name,
                  oldKingName: playerDisplayName,
                  newKingId: nextKing,
                });
              } else {
                // メンバー不在
                oldFaction.kingId = null;
                factionDestroyed = false; // 滅亡させない仕様
                logActivity("faction_leader_changed", {
                  message: `構成員がいなくなったため、${oldFaction.name} は無人の勢力となりました`,
                  factionName: oldFaction.name,
                  newKingId: null,
                });
              }
            }
          }
          return factions;
        },
        { factions: {} },
      );

      // 4. 領土移譲 (独立時のみ)
      if (isIndependence && newFactionId) {
        await updateJSON(
          MAP_STATE_PATH,
          async (mapState) => {
            if (!mapState.tiles) mapState.tiles = {};
            let hasValidCore = false;
            let possibleCoreTiles = [];

            Object.entries(mapState.tiles).forEach(([key, tile]) => {
              // 旧勢力所有 かつ 自分が塗ったマス
              const ownerId = tile.factionId || tile.faction;
              if (ownerId === oldFactionId && tile.paintedBy === req.playerId) {
                tile.factionId = newFactionId;
                delete tile.faction;
                tile.color = newFactionColor;

                // 中核マス判定
                if (tile.core && tile.core.factionId === oldFactionId) {
                  tile.core.factionId = newFactionId;
                  hasValidCore = true;
                } else if (!tile.core) {
                  // 通常マスの場合、中核候補リストに追加
                  possibleCoreTiles.push(key);
                }
              }
            });

            // 中核マスを一つも持っていない場合、通常マスの中から一つを昇格させる
            if (!hasValidCore && possibleCoreTiles.length > 0) {
              // 最初の候補を中核マスにする
              const targetKey = possibleCoreTiles[0];
              const [tx, ty] = targetKey.split("_").map(Number);

              if (mapState.tiles[targetKey]) {
                mapState.tiles[targetKey].core = {
                  factionId: newFactionId,
                  x: tx,
                  y: ty,
                  health: 100,
                  maxHealth: 100,
                  level: 1,
                  createdAt: new Date().toISOString(),
                };
                // 独立ボーナスとして即時中核化
                mapState.tiles[targetKey].isCorePending = false;
                mapState.tiles[targetKey].coreTime = null;
                hasValidCore = true;

                console.log(
                  `[Independence] Auto-assigned new core tile at ${targetKey} for ${newFactionId}`,
                );
              }
            } else if (!hasValidCore) {
              console.warn(
                `[Independence] FAILED to auto-assign core for ${newFactionId}: No suitable tiles found.`,
              );
            }
            return mapState;
          },
          { tiles: {} },
        );
      }

      // 5. 中核設定のクリーンアップ (旧勢力が滅亡した場合)
      if (factionDestroyed) {
        await updateJSON(
          MAP_STATE_PATH,
          async (mapData) => {
            cleanUpFactionCores(oldFactionId, mapData);
            return mapData;
          },
          { tiles: {} },
        );
      }

      // 6. 戦争開始 (独立時のみ)
      if (isIndependence && newFactionId) {
        const warId = crypto.randomUUID();
        let newWar = null;

        await updateJSON(
          WARS_PATH,
          async (warsData) => {
            if (!warsData.wars) warsData.wars = {};
            newWar = {
              id: warId,
              attackerSide: {
                leaderId: newFactionId,
                factions: [newFactionId],
                tilesTaken: 0,
                tilesLost: 0,
              },
              defenderSide: {
                leaderId: oldFactionId, // 旧勢力がリーダー
                factions: [oldFactionId],
                tilesTaken: 0,
                tilesLost: 0,
              },
              startTime: now,
              lastActive: now,
            };
            warsData.wars[warId] = newWar;
            return warsData;
          },
          { wars: {} },
        );

        // 戦争開始イベント通知
        if (newWar) {
          io.emit("war:started", newWar);
        }

        logActivity("war_started", {
          message: `${newFactionName.trim()} が ${oldFactionName} に対して独立戦争を起こしました`,
          attackerName: newFactionName.trim(),
          defenderName: oldFactionName,
        });
      }

      // 7. ログ出力と通知
      logActivity(isIndependence ? "faction_independence" : "faction_left", {
        playerId: req.playerId,
        oldFactionId: oldFactionId,
        newFactionId: newFactionId,
        factionName: oldFactionName, // 互換性のために追加
        oldFactionName: oldFactionName,
        newFactionName: isIndependence ? newFactionName.trim() : null,
        playerName: playerDisplayName,
      });

      // 最新状態を配信
      // (独立時は新勢力・旧勢力両方の更新が必要なので、全更新扱いか、個別更新)
      const factions = loadJSON(FACTIONS_PATH, { factions: {} });
      const players = loadJSON(PLAYERS_PATH, { players: {} });

      // 旧勢力更新通知
      if (factionDestroyed) {
        io.emit("faction:destroyed", { factionId: oldFactionId });
        io.to(`faction:${oldFactionId}`).emit("faction:updated", {
          factionId: oldFactionId,
          faction: null,
        });
      } else {
        io.to(`faction:${oldFactionId}`).emit("faction:updated", {
          factionId: oldFactionId,
          faction: getEnrichedFaction(oldFactionId, factions, players),
        });
      }

      // 脱退通知
      io.to(`faction:${oldFactionId}`).emit("faction:member_left", {
        factionId: oldFactionId,
        memberId: req.playerId,
      });

      // ルームから退出
      joinFactionRoom(req.playerId, null);

      // 新勢力更新通知 (独立時)
      if (isIndependence && newFactionId) {
        // 新勢力ルーム参加
        joinFactionRoom(req.playerId, newFactionId);

        const newF = getEnrichedFaction(newFactionId, factions, players);
        io.emit("faction:created", {
          factionId: newFactionId,
          faction: newF,
        });

        // タイル更新 (全体)
        const mapState = loadJSON(MAP_STATE_PATH);
        const updatedTiles = {};
        Object.entries(mapState.tiles).forEach(([k, t]) => {
          if ((t.factionId || t.faction) === newFactionId) {
            updatedTiles[k] = t;
          }
        });
        io.emit("tile:update", updatedTiles);
      }

      io.emit("ap:refresh");

      res.json({ success: true, newFactionId });
    } catch (e) {
      if (e.code === "COOLDOWN" || e.message.includes("制限期間中")) {
        return res.status(400).json({ error: e.message });
      }
      console.error("Error in /api/factions/leave:", e);
      const msg = e.message;
      if (msg === "勢力に所属していません" || msg.includes("APが必要です")) {
        return res.status(400).json({ error: msg });
      }
      res.status(500).json({ error: "脱退処理に失敗しました" });
    }
  },
);

// タイル塗り
app.post(
  "/api/tiles/paint",
  authenticate,
  requireAuth,
  checkGameStatus,
  async (req, res) => {
    const { tiles, action } = req.body; // action: 'paint' | 'overpaint'
    console.log(
      `[PaintRequest] Player: ${req.playerId}, Tiles: ${tiles?.length}`,
    );

    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const alliancesData = loadJSON(ALLIANCES_PATH, { alliances: {} });
    const alliances = alliancesData.alliances || {};
    const namedCells = loadJSON(NAMED_CELLS_PATH, {});

    const player = players.players[req.playerId];
    if (!player) {
      console.log(`[PaintError] Player not found: ${req.playerId}`);
      return res.status(401).json({ error: "ユーザーが見つかりません" });
    }
    if (!player.factionId) {
      console.log(`[PaintError] Player ${req.playerId} has no faction`);
      return res.status(400).json({ error: "勢力に所属していません" });
    }
    const faction = factions.factions[player.factionId];

    // [DEBUG] AP Trace Start
    console.log(
      `[AP_TRACE] Start Paint. Player: ${player.id}, AP: ${player.ap}, ReqID: ${req.playerId}`,
    );
    if (!faction) {
      console.log(`[PaintError] Faction not found for ID: ${player.factionId}`);
      return res.status(400).json({ error: "勢力データが破損しています" });
    }

    // --- [REFACTOR] バリデーションとコスト計算を Worker Pool にオフロード ---
    let response;
    try {
      response = await runWorkerTask("PREPARE_PAINT", {
        tiles,
        player,
        action,
        overpaintCount: req.body.overpaintCount || 1,
        namedTileSettings: loadJSON(SYSTEM_SETTINGS_PATH, {}).namedTileSettings,
      });
    } catch (e) {
      console.error("[PaintProcessing] Worker Error:", e);
      return res.status(500).json({
        error:
          "サーバー内部エラーが発生しました(Worker Crash)。時間を置いて再試行してください。",
      });
    }

    if (!response.success) {
      return res
        .status(response.code === "ZOC_BLOCK" ? 403 : 400)
        .json({ error: response.error });
    }

    const {
      cost,
      destructionInvolved,

      targetFactionName,
      needsWarDeclaration,
    } = response.results;

    // --- 休憩時間チェック（他勢力上書き時のみ） ---
    // 他勢力のマスを塗る場合（=攻撃行為）のみ休憩時間で制限
    const hasEnemyTiles = tiles.some((t) => {
      const existing = mapState.tiles[`${t.x}_${t.y}`];
      return (
        existing &&
        existing.factionId &&
        existing.factionId !== player.factionId
      );
    });

    if (hasEnemyTiles && isBreakTime()) {
      const settings = loadJSON(SYSTEM_SETTINGS_PATH, {});
      const breakSettings = settings.breakTime;
      return res.status(503).json({
        error: `休憩時間中です（${breakSettings.startTime} ～ ${breakSettings.endTime}）。この間は他勢力への攻撃ができません。`,
        code: "BREAK_TIME",
      });
    }

    // --- [NEW] 戦争権限チェック ---
    if (needsWarDeclaration) {
      const canDeclareWar = hasPermission(
        faction,
        req.playerId,
        "canDeclareWar",
      );
      if (!canDeclareWar) {
        return res.status(403).json({
          error: `勢力「${targetFactionName || "不明"}」への攻撃には宣戦布告が必要ですが、あなたには外交権限がありません。`,
        });
      }
    }

    console.log(
      `[PaintProcessing] Player: ${req.playerId}, AP: ${player.ap}, Cost: ${cost}, Destruction: ${destructionInvolved}`,
    );

    // --- [REFACTOR] APチェック (ドライラン) ---
    // 'hasSharedApPerm' を定義する
    const hasSharedApPerm =
      faction.kingId === req.playerId ||
      hasPermission(faction, req.playerId, "canUseSharedAp");

    // 1. Dry Run: Check if AP is sufficient WITHOUT consuming
    const apCheck = attemptApConsumption(
      player,
      faction,
      cost,
      req.playerId,
      hasSharedApPerm,
      true, // dryRun = true (消費しない)
    );

    if (!apCheck.success) {
      return res.status(400).json({
        error: apCheck.error || `APが不足しています（必要: ${cost}）`,
      });
    }

    const playerDisplayName = player.displayName || toShortId(req.playerId);

    // 役職名取得
    let roleName = "Member";
    if (faction.kingId === req.playerId) {
      roleName = faction.kingRoleName || "勢力主";
    } else if (faction.memberRoles && faction.memberRoles[req.playerId]) {
      const rid = faction.memberRoles[req.playerId];
      const r = faction.roles
        ? faction.roles.find((ro) => ro.id === rid)
        : null;
      if (r) roleName = r.name;
    }

    try {
      // [FIX] Removed aggressive refresh from disk. Memory state is the source of truth.
      // Trying to reload from disk here causes rollback to previous save state (throttled).
      // We rely on the `player` object reference being up-to-date in memory.

      // const freshPlayers = loadJSON(PLAYERS_PATH, { players: {} }, true);
      // ... (removed)

      // --- [NEW] ジャイアントキリング判定 (AP消費前) ---
      // 条件: 攻撃対象（同盟含む）のポイントが自勢力（同盟含む）の2.0倍以上

      // 実効ポイント（同盟合計または勢力合計）を計算するヘルパー
      const getEffectivePoints = (fid) => {
        const f = factions.factions[fid];
        if (!f) return 0;
        if (f.allianceId && alliances[f.allianceId]) {
          const alliance = alliances[f.allianceId];
          return alliance.members.reduce((sum, memberFid) => {
            return sum + (factions.factions[memberFid]?.totalPoints || 0);
          }, 0);
        }
        return f.totalPoints || 0;
      };

      const attackerEffectivePoints = getEffectivePoints(player.factionId);
      let isGiantKilling = false;

      // 強奪対象がいるかチェック
      const giantKillingCandidates = [];
      const tempStolenCounts = new Map();

      // コスト計算＆予備判定
      for (const rawT of tiles) {
        const t = { ...rawT, x: Number(rawT.x), y: Number(rawT.y) };
        const key = `${t.x}_${t.y}`;
        const oldTile = mapState.tiles[key];
        const oldFactionId = oldTile
          ? oldTile.faction || oldTile.factionId
          : null;

        if (oldFactionId && oldFactionId !== player.factionId) {
          tempStolenCounts.set(
            oldFactionId,
            (tempStolenCounts.get(oldFactionId) || 0) + 1,
          );
        }
      }

      if (tempStolenCounts.size > 0 && attackerEffectivePoints > 0) {
        tempStolenCounts.forEach((count, targetFid) => {
          const targetEffectivePoints = getEffectivePoints(targetFid);

          // 判定: 敵（同盟）ポイント >= 自（同盟）ポイント * 2.0
          if (targetEffectivePoints >= attackerEffectivePoints * 2.0) {
            // 候補としてカウント (名称は勢力名でOK)
            const targetName = factions.factions[targetFid]?.name || "Unknown";
            giantKillingCandidates.push(targetName);
            console.log(
              `[GiantKilling] Candidate found: ${targetName} (Target: ${targetEffectivePoints} vs Attacker: ${attackerEffectivePoints})`,
            );
          }
        });
      }

      // ジャイアントキリング発動判定
      if (giantKillingCandidates.length > 0) {
        // 25%の確率でAP消費なし
        if (Math.random() < 0.25) {
          isGiantKilling = true;
          console.log(
            `[GiantKilling] Triggered for ${req.playerId}! Cost reduced to 0.`,
          );
        }
      }

      // --- [NEW] AP消費 (確定) ---
      // ジャイアントキリング発動時はコスト0
      const actualCost = isGiantKilling ? 0 : cost;

      // AP消費はマップ更新の後に行う

      const stolenCounts = new Map(); // fid -> count
      const updatedTiles = {};

      // Apply Changes
      // 適用処理
      // [FIX] 結果変数を外側で宣言して、後で共有APチェックに使う
      let resultApConsumption = null;

      await updateJSON(MAP_STATE_PATH, async (mapData) => {
        // [FIX] マップトランザクション内でAPを消費し、ただ乗りを防ぐ
        // 消費に失敗した場合はスローしてマップ更新を中止する
        resultApConsumption = attemptApConsumption(
          player,
          faction,
          actualCost,
          req.playerId,
          hasSharedApPerm,
          false, // dryRun = false (実行コミット)
        );

        if (!resultApConsumption.success) {
          throw new Error(
            `AP consumption failed: ${resultApConsumption.error || "Unknown error"}`,
          );
        }

        // [DEBUG] AP Trace After Consumption
        console.log(
          `[AP_TRACE] After Consumption. Player: ${player.id}, AP: ${player.ap}, SharedUsed: ${resultApConsumption.usedSharedAp}`,
        );

        // [DEBUG] AP Trace After Consumption
        console.log(
          `[AP_TRACE] After Consumption/MapLock. Player: ${player.id}, AP: ${player.ap}, SharedUsed: ${resultApConsumption.usedSharedAp}`,
        );

        if (resultApConsumption.usedSharedAp > 0) {
          queueFactionSave(); // [FIX] 共有AP消費を保存
        }
        console.log(
          `[Paint] Queueing player save. AP: ${player.ap}, LastAction: ${player.lastApAction}`,
        );
        queuePlayerSave(); // [FIX] 個人AP消費を保存

        // Notify Giant Killing
        if (isGiantKilling) {
          io.to(`user:${req.playerId}`).emit("notification:toast", {
            title: "ジャイアントキリング発動！",
            message: "格上勢力への攻撃により、AP消費なしで行動できました！",
            type: "success",
          });
        }

        // --- トークンカウント開始 ---
        // 事前に勢力ごとのタイル数と中核数をカウント
        const currentFactionStats = {}; // fid -> { tiles, cores }
        if (sharedMapView) {
          // [OPTIMIZATION] SAB 走査により JSON 全走査を回避
          const size = 500;
          const nowMs = Date.now();
          for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
              const offset = (y * size + x) * TILE_BYTE_SIZE;
              const fidIdx = sharedMapView.getUint16(offset, true);
              if (fidIdx === 65535) continue;

              const actualFid = getFactionIdFromIdx(fidIdx);

              if (actualFid) {
                if (!currentFactionStats[actualFid])
                  currentFactionStats[actualFid] = { tiles: 0, cores: 0 };
                currentFactionStats[actualFid].tiles++;

                const flags = sharedMapView.getUint8(offset + 11);
                if (flags & 1) {
                  // CORE flag
                  const exp = sharedMapView.getFloat64(offset + 12, true);
                  if (exp === 0 || exp > nowMs) {
                    currentFactionStats[actualFid].cores++;
                  }
                }
              }
            }
          }
        } else {
          // フォールバック
          Object.values(mapData.tiles).forEach((t) => {
            const fid = t.faction || t.factionId;
            if (fid) {
              if (!currentFactionStats[fid])
                currentFactionStats[fid] = { tiles: 0, cores: 0 };
              currentFactionStats[fid].tiles++;
              if (t.core) {
                const coreFid = t.core.factionId;
                if (!currentFactionStats[coreFid])
                  currentFactionStats[coreFid] = { tiles: 0, cores: 0 };
                const nowMs = Date.now();
                if (
                  coreFid === fid &&
                  (!t.core.expiresAt ||
                    new Date(t.core.expiresAt).getTime() > nowMs)
                ) {
                  currentFactionStats[coreFid].cores++;
                }
              }
            }
          });
        }

        for (const rawT of tiles) {
          // [FIX] "100-1" のような文字列結合バグを防ぐため、座標を数値に変換
          const t = { ...rawT, x: Number(rawT.x), y: Number(rawT.y) };
          const key = `${t.x}_${t.y}`;
          const oldTile = mapData.tiles[key];

          // 既存のタイルが他勢力のものであれば、強奪数としてカウント
          const oldFactionId = oldTile
            ? oldTile.faction || oldTile.factionId
            : null;
          if (oldFactionId && oldFactionId !== player.factionId) {
            stolenCounts.set(
              oldFactionId,
              (stolenCounts.get(oldFactionId) || 0) + 1,
            );
          }

          console.log(
            `[PaintDebug] Key: ${key}, Action: ${action}, OldOverpaint: ${oldTile ? oldTile.overpaint : "null"}`,
          );

          // 自勢力の塗り直し（メンテナンス、模様替え）の場合は所有者を上書きしない
          // ただし overpaint の場合は処理が異なる

          if (action === "overpaint") {
            if (!oldTile) continue; // コスト計算を通過していれば存在しているはず

            // [Fix] 安全な数値型を保証
            let current =
              typeof oldTile.overpaint === "number" ? oldTile.overpaint : 0;

            // [Fix] 自動補正: 4（最大値）を超える場合（ユーザーからの報告で9や5などがあった）、4に補正して保存対象にする
            // 既存データが不正に大きい場合、4（最大値）に補正して保存対象にする
            if (current > 4) {
              console.log(
                `[PaintDebug] Auto-correcting tile ${key} overpaint from ${current} to 4`,
              );
              current = 4;
              oldTile.overpaint = 4;
              updatedTiles[key] = oldTile; // これ以上塗れなくても、修正を永続化する
              // ここではまだ続行しない（すでに4なのでこれ以上は追加できない）
            } else {
              // 内部オブジェクトがロジックと一致することを確認（undefinedだった場合など）
              oldTile.overpaint = current;
            }

            // すでに最大レベル（4が最大、表示上は5）ならスキップ
            if (current >= 4) {
              console.log(
                `[PaintDebug] Skipping tile ${key}, already at max overpaint (${current})`,
              );
              // 自動補正により updatedTiles に追加済みの場合は問題なし
              continue;
            }

            // [Fix] 入力を厳密にパース
            let targetCount = parseInt(req.body.overpaintCount || 1, 10);
            if (isNaN(targetCount) || targetCount < 1) targetCount = 1;

            const remaining = 4 - current;
            const add = Math.min(targetCount, remaining);

            if (add > 0) {
              oldTile.overpaint = current + add;
              // [Paranoid Safety] オーバーフローの可能性を完全に防ぐため、明示的に再度4に制限
              if (oldTile.overpaint > 4) oldTile.overpaint = 4;

              console.log(
                `[PaintDebug] Added ${add} overpaint levels. New: ${oldTile.overpaint}`,
              );
              // 所有者は変更しない
              updatedTiles[key] = oldTile;
            }
            continue; // 重ね塗りの場合はここで終了
          }

          // --- 通常の塗り（所有権の変更またはメンテナンス） ---
          const isSelfOwn = oldFactionId === player.factionId;

          // Named Tile Combat
          if (oldTile && oldTile.namedData && !isSelfOwn) {
            // Siege Logic
            // Siege Logic
            const wars = loadJSON(WARS_PATH, { wars: {} });
            const alliances = loadJSON(ALLIANCES_PATH, { alliances: {} });

            // Defender's Allies
            const defenderAlliedFids = new Set([oldFactionId]);
            if (
              factions.factions[oldFactionId] &&
              factions.factions[oldFactionId].allianceId &&
              alliances.alliances[factions.factions[oldFactionId].allianceId]
            ) {
              alliances.alliances[
                factions.factions[oldFactionId].allianceId
              ].members.forEach((m) => defenderAlliedFids.add(m));
            }

            let isSieged = true;
            const surrounding = [
              [0, 1],
              [0, -1],
              [1, 0],
              [-1, 0],
              [1, 1],
              [1, -1],
              [-1, 1],
              [-1, -1],
            ];
            for (const [dx, dy] of surrounding) {
              const tx = Number(t.x);
              const ty = Number(t.y);
              const nx = tx + dx;
              const ny = ty + dy;
              const nKey = `${nx}_${ny}`;

              // マップ範囲外チェック（壁は味方扱い＝包囲を助ける -> 安全地帯）
              if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) {
                isSieged = false;
                break;
              }

              const nTile = mapData.tiles[nKey];
              const nFid = nTile ? nTile.faction || nTile.factionId : null;

              // 1. 隣接マスが防衛側に対して友好的（自勢力、同盟、または空白）かチェック
              if (!nFid || defenderAlliedFids.has(nFid)) {
                isSieged = false;
                break;
              }

              // 2. 隣接マスが同盟でない場合 => 防衛側にとって「戦争中の敵」であるかチェック
              let isAtWar = false;
              if (wars && wars.wars) {
                const defFidStr = String(oldFactionId);
                const neighborFidStr = String(nFid);
                Object.values(wars.wars).forEach((w) => {
                  if (w.attackerSide && w.defenderSide) {
                    const attackers = w.attackerSide.factions.map(String);
                    const defenders = w.defenderSide.factions.map(String);
                    if (
                      (attackers.includes(defFidStr) &&
                        defenders.includes(neighborFidStr)) ||
                      (defenders.includes(defFidStr) &&
                        attackers.includes(neighborFidStr))
                    ) {
                      isAtWar = true;
                    }
                  }
                });
              }

              if (!isAtWar) {
                isSieged = false;
                break;
              }
            }

            // [UPDATE] 攻撃ロジック: 初期10% / 包囲時30% (固定)
            const baseRate = isSieged ? 0.3 : 0.1;
            const totalRate = baseRate;

            // クールダウン中のチェック (念のためAPIレベルでも弾くが、念入りに)
            const now = Date.now();
            if (
              oldTile.namedData.cooldownUntil &&
              oldTile.namedData.cooldownUntil > now
            ) {
              const waitMin = Math.ceil(
                (oldTile.namedData.cooldownUntil - now) / 60000,
              );
              // 特殊なエラーメッセージにして、catch側で判別可能にする
              const err = new Error(
                `拠点「${oldTile.namedData.name}」は防衛直後のため攻撃できません (残り${waitMin}分)`,
              );
              err.isExpected = true;
              throw err;
            }

            const isFall = Math.random() < totalRate;

            if (isFall) {
              // 陥落！
              // [UPDATE] 陥落後のクールダウン: 通常60分 / 包囲時30分 (攻撃失敗時と同じ)
              const cdMinutes = isSieged ? 30 : 60;
              oldTile.namedData.cooldownUntil =
                Date.now() + cdMinutes * 60 * 1000;

              // siegeBonus reset removed
              oldTile.overpaint = 0; // Reset defense

              logActivity("named_tile_fallen", {
                playerId: req.playerId,
                playerName: playerDisplayName, // プレイヤー名
                roleName: roleName, // 役職名
                factionId: player.factionId,
                factionName: faction.name,
                targetFactionId: oldFactionId,
                targetFactionName:
                  factions.factions[oldFactionId]?.name || "無所属",
                tileName: oldTile.namedData.name,
                x: t.x,
                y: t.y,
              });

              // [FIX] 更新データの同期 (ZOC / 表示色用)
              if (namedCells[key]) {
                // [UPDATE] 整合性チェックのために namedCells の factionId も同期する
                // [Fix] 陥落時に named_cells.json も即時更新して永続化する
                // これにより、Workerの整合性チェックなどによる巻き戻りを防ぐ
                const updatedNamedCell = {
                  ...namedCells[key],
                  factionId: player.factionId,
                  // delete cooldownUntil if exists (reset on fall)
                };
                delete updatedNamedCell.cooldownUntil;

                // メモリ上のキャッシュも更新
                namedCells[key] = updatedNamedCell;

                // ディスクへ保存
                await updateJSON(NAMED_CELLS_PATH, (nData) => {
                  if (nData[key]) {
                    nData[key].factionId = player.factionId;
                    delete nData[key].cooldownUntil;
                  }
                  return nData;
                });

                const settings = loadJSON(SYSTEM_SETTINGS_PATH, {});
                const ntSettings = settings.namedTileSettings || {};
                const minBonus = ntSettings.fallApBonusMin ?? 10;
                const maxBonus = ntSettings.fallApBonusMax ?? 50;
                const bonusRange = Math.max(1, maxBonus - minBonus + 1); // Ensure positive range
                const apBonus =
                  Math.floor(Math.random() * bonusRange) + minBonus;
                player.ap = Math.min(AP_MAX_LIMIT, (player.ap || 0) + apBonus);

                io.to(`user:${req.playerId}`).emit("notification:toast", {
                  title: "ネームドマス陥落ボーナス！",
                  message: `拠点を陥落させたボーナスとして、APを ${apBonus} 獲得しました！`,
                  type: "success",
                });
                io.emit("namedCell:updated", {
                  tileKey: key,
                  namedCell: updatedNamedCell,
                });
              }
            } else {
              // 抵抗！
              // [UPDATE] クールダウン: 通常60分 / 包囲時30分
              const cdMinutes = isSieged ? 30 : 60;
              oldTile.namedData.cooldownUntil =
                Date.now() + cdMinutes * 60 * 1000;

              // siegeBonus accumulation removed

              updatedTiles[key] = {
                ...oldTile,
                paintedByName: playerDisplayName,
              };

              logActivity("named_tile_resist", {
                playerId: req.playerId,
                playerName: playerDisplayName,
                roleName: roleName,
                factionId: player.factionId,
                factionName: faction.name,
                targetFactionId: oldFactionId,
                targetFactionName:
                  factions.factions[oldFactionId]?.name || "無所属",
                tileName: oldTile.namedData.name,
                x: t.x,
                y: t.y,
              });

              continue; // 陥落しなかった場合は以降の所有権更新をスキップ
            }
          }

          // 所有権変更の適用 (標準)
          let tileToUpdate = oldTile;
          if (!tileToUpdate) {
            tileToUpdate = { x: t.x, y: t.y };
            mapData.tiles[key] = tileToUpdate;
          }

          tileToUpdate.factionId = player.factionId;
          delete tileToUpdate.faction;
          tileToUpdate.color = faction.color;

          if (!isSelfOwn || !tileToUpdate.paintedBy) {
            tileToUpdate.paintedBy = req.playerId;
            // tileToUpdate.paintedByName = playerDisplayName; // 削除済み -> updatedTiles 経由で送信
          }

          if (isSelfOwn) {
            // 自勢力地なら paintedAt, overpaint, customColor は維持
            if (tileToUpdate.overpaint === undefined)
              tileToUpdate.overpaint = 0;
            if (tileToUpdate.consecutiveHours === undefined)
              tileToUpdate.consecutiveHours = 0;
          } else {
            // 他勢力地または空白地ならリセット
            tileToUpdate.paintedAt = new Date().toISOString();
            tileToUpdate.overpaint = 0;
            tileToUpdate.consecutiveHours = 0;
            delete tileToUpdate.customColor; // 占領時はカスタム色を解除する
            delete tileToUpdate.isCorePending;
            delete tileToUpdate.coreTime;
          }

          // 中核タイルのロジック
          if (tileToUpdate.core) {
            if (tileToUpdate.core.factionId !== player.factionId) {
              // 敵の中核を奪った: 占領時間から12時間後を期限に
              const expireTime = Date.now() + 12 * 60 * 60 * 1000;
              tileToUpdate.core.expiresAt = new Date(expireTime).toISOString();
            } else {
              // 自勢力の中核奪還: 恒久化
              tileToUpdate.core.expiresAt = null;
            }
          }

          // --- [REFINED] 中核化ロジック (500タイル以下の自動中核化) ---
          if (!tileToUpdate.core) {
            const fid = player.factionId;
            if (!currentFactionStats[fid])
              currentFactionStats[fid] = { tiles: 0, cores: 0 };
            const myStats = currentFactionStats[fid];

            // 弱小勢力用デバッグログ
            const isSmall = myStats.tiles < 600;

            if (myStats.cores < 2500) {
              // 即時中核化判定 (400タイル以下)
              if (myStats.tiles + 1 <= 400) {
                let isConnectedToCore = false;
                if (myStats.tiles === 0 && myStats.cores === 0) {
                  isConnectedToCore = true;
                  if (isSmall)
                    console.log(`[CoreDebug] First tile core for ${fid}`);
                } else {
                  const directions = [
                    [-1, -1],
                    [0, -1],
                    [1, -1],
                    [-1, 0],
                    [1, 0],
                    [-1, 1],
                    [0, 1],
                    [1, 1],
                  ];
                  for (const [dx, dy] of directions) {
                    const nKey = `${t.x + dx}_${t.y + dy}`;
                    const neighbor = mapData.tiles[nKey];
                    if (
                      neighbor &&
                      neighbor.factionId === fid &&
                      neighbor.core
                    ) {
                      isConnectedToCore = true;
                      if (isSmall)
                        console.log(
                          `[CoreDebug] Connected to core at ${nKey} for ${t.x},${t.y}`,
                        );
                      break;
                    }
                  }
                }
                if (isConnectedToCore) {
                  tileToUpdate.core = { factionId: fid, expiresAt: null };
                  myStats.cores++;
                  console.log(
                    `[CoreDebug] Tile ${t.x},${t.y} became CORE. Stats: ${myStats.tiles}/${myStats.cores}`,
                  );
                }
              }
            } else {
              if (isSmall)
                console.log(
                  `[CoreDebug] Tile ${t.x},${t.y} limit reached. Stats: ${myStats.tiles}/${myStats.cores}`,
                );
            }
            myStats.tiles++;
          }

          updatedTiles[key] = {
            ...tileToUpdate,
            paintedByName: playerDisplayName,
          };
        }

        // --- [NEW] 接続済み飛び地の即時中核化スイープ (Worker分散版) ---
        // 400マス以下の勢力限定: Workerで計算して結果だけ受け取る
        const fid = player.factionId;
        const myStats = currentFactionStats[fid];
        if (myStats && myStats.tiles <= 400) {
          // [OPTIMIZATION] Workerに計算を依頼。
          // Note: ここでawaitすると結果的にメインスレッドのイベントループが止まるわけではないが、
          // レスポンスを待つことになる。UXとしては「塗った直後の中核化反映」は即時が望ましいため待つ。
          // ただし計算自体は別スレッドなので他ユーザーへの影響は軽減される。

          // 最適化: 自分の勢力のタイルキーだけ渡した方が早いが、
          // getFactionClusterInfoWorker は mapState 全体も見る必要がある(隣接など)
          // server.js 側で正確なリストを作るのもコストがかかるため、
          // updateJSON内で更新された factionTiles キャッシュがあればそれを使うなどの工夫が可能だが、
          // ここではシンプルに Worker に任せる。
          // ただし、mapState は重いので Worker 側で読む (filePaths渡し)
          const result = await runWorkerTask("CALCULATE_CLUSTERS", {
            filePaths: {
              mapState: MAP_STATE_PATH,
              factions: FACTIONS_PATH, // 多分不要だが念のため
            },
            factionId: fid,
            tilesInMapKeys: [], // Worker側で全検索させる (または必要なら最適化)
          });

          if (
            result &&
            result.success &&
            result.results &&
            result.results.tilesToCoreify &&
            result.results.tilesToCoreify.length > 0
          ) {
            result.results.tilesToCoreify.forEach((tKey) => {
              const t = mapData.tiles[tKey]; // ここで再度参照 (updateJSON内なので safe)
              if (t && !t.core) {
                t.core = { factionId: fid, expiresAt: null };
                updatedTiles[tKey] = t;
              }
            });
          }
        }

        // [MODIFIED] カスタムカラー復帰ロジックを削除 (周囲が塗られても色を維持)
        /*
        const directions = [
          [-1, -1],
          [0, -1],
          [1, -1],
          [-1, 0],
          [1, 0],
          [-1, 1],
          [0, 1],
          [1, 1],
        ];
        const checkedNeighbors = new Set();

        tiles.forEach((t) => {
          directions.forEach(([dx, dy]) => {
            const nx = t.x + dx;
            const ny = t.y + dy;
            const nKey = `${nx}_${ny}`;

            if (checkedNeighbors.has(nKey)) return;
            checkedNeighbors.add(nKey);

            const neighbor = mapData.tiles[nKey];
            if (neighbor && neighbor.customColor) {
              const nFid = neighbor.faction || neighbor.factionId;
              let isSurrounded = true;

              for (const [ddx, ddy] of directions) {
                const nnx = nx + ddx;
                const nny = ny + ddy;
                const nnKey = `${nnx}_${nny}`;
                const nnTile = mapData.tiles[nnKey];
                const nnFid = nnTile
                  ? nnTile.faction || nnTile.factionId
                  : null;

                if (nnFid !== nFid) {
                  isSurrounded = false;
                  break;
                }
              }

              if (!isSurrounded) {
                delete neighbor.customColor;
                updatedTiles[nKey] = neighbor; // emit対象に追加
              }
            }
          });
        });
        */

        // [FIX] Update mapData and SAB (Critical for persistence & sync)
        Object.keys(updatedTiles).forEach((key) => {
          const t = updatedTiles[key];
          mapData.tiles[key] = t; // Merge into JSON state (for saveJSON)

          // Update SAB (for Binary Map & Worker)
          const [x, y] = key.split("_").map(Number);
          updateTileSAB(x, y, t, namedCells);
        });

        return mapData;
      });

      // [MOVED] AP consumption is now done inside updateJSON.

      // 通知（ジャイアントキリング発動時）
      if (isGiantKilling) {
        io.to(`user:${req.playerId}`).emit("notification:toast", {
          title: "ジャイアントキリング発動！",
          message: "格上勢力への攻撃により、AP消費なしで行動できました！",
          type: "success",
        });
      }

      console.log(
        `[PaintDebug] UpdatedTiles Keys count: ${Object.keys(updatedTiles).length}`,
      );
      // [WAR SYSTEM V2] Trigger War Logic - 影響を受ける勢力ごとに1回だけ実行
      for (const [defFid, count] of stolenCounts) {
        handleWarUpdate(player.factionId, defFid, count);
      }

      // mapData is already saved by updateJSON

      // マップデータを再確認 (滅亡判定のため)
      // Multi-core Stats Calculation (Worker)
      let factionStats = {};
      const destroyedFactions = [];

      try {
        const affectedFactionIds = Array.from(
          new Set([player.factionId, ...stolenCounts.keys()]),
        );

        const validationResult = await runWorkerTask("CALCULATE_STATS", {
          affectedFactionIds,
        });

        if (validationResult.success) {
          factionStats = validationResult.results.factionStats;

          // Update Points in Memory
          Object.entries(validationResult.results.pointUpdates).forEach(
            ([fid, points]) => {
              if (factions.factions[fid]) {
                factions.factions[fid].territoryPoints = points;
                factions.factions[fid].totalPoints =
                  points + (factions.factions[fid].bonusPoints || 0);
              }
            },
          );
        } else {
          console.error("[Worker] Calculation failed:", validationResult.error);
        }
      } catch (err) {
        console.error("[Worker] Stats Task Error:", err);
      }

      // Alliance data is already loaded at handler start
      let allianceUpdated = false;

      for (const targetFactionId of stolenCounts.keys()) {
        const stats = factionStats[targetFactionId] || {
          tiles: 0,
          cores: 0,
        };
        let isDestroyed = false;
        if (stats.cores === 0) {
          isDestroyed = true;
        }

        if (isDestroyed) {
          destroyedFactions.push({
            id: targetFactionId,
            name: factions.factions[targetFactionId]?.name || "Unknown",
            members: factions.factions[targetFactionId]?.members || [],
          });

          const destroyedFaction = factions.factions[targetFactionId];
          if (destroyedFaction) {
            // 1. Remove members from faction
            if (destroyedFaction.members) {
              destroyedFaction.members.forEach((memberId) => {
                if (players.players[memberId]) {
                  players.players[memberId].factionId = null;
                }
                // [NEW] Notify member about destruction
                io.to(`user:${memberId}`).emit(
                  "faction:destroyed_notification",
                  {
                    factionName: destroyedFaction.name,
                    destroyedBy: faction.name,
                  },
                );

                // [FIX] 以前ここにあった addFactionNotice (勢力滅亡) は、
                // 下部の「所属勢力の滅亡」に統合されたため削除
              });
            }

            // 2. Alliance Check
            if (
              destroyedFaction.allianceId &&
              alliances[destroyedFaction.allianceId]
            ) {
              const aid = destroyedFaction.allianceId;
              const alliance = alliances[aid];

              // Remove from members
              alliance.members = alliance.members.filter(
                (mId) => mId !== targetFactionId,
              );

              if (alliance.members.length <= 1) {
                // 自動解散 (1勢力以下)
                const remainingFid = alliance.members[0];
                if (remainingFid && factions.factions[remainingFid]) {
                  factions.factions[remainingFid].allianceId = null;
                }

                delete alliances[aid];
                logActivity("alliance_broken", {
                  message: `構成勢力が減少したため、同盟「${alliance.name}」は解散しました`,
                  allianceName: alliance.name,
                });
                io.emit("alliance:disbanded", { allianceId: aid });
              } else {
                // 盟主継承 (ポイント最大勢力へ)
                if (alliance.leaderId === targetFactionId) {
                  let bestFid = alliance.members[0];
                  let maxPoints = -1;

                  alliance.members.forEach((mFid) => {
                    const f = factions.factions[mFid];
                    if (f && (f.totalPoints || 0) > maxPoints) {
                      maxPoints = f.totalPoints || 0;
                      bestFid = mFid;
                    }
                  });

                  alliance.leaderId = bestFid;
                  const newLeaderName =
                    factions.factions[bestFid]?.name || "Unknown";

                  logActivity("alliance_updated", {
                    message: `盟主勢力消滅に伴い、同盟「${alliance.name}」の盟主が ${newLeaderName} に変更されました`,
                    allianceId: aid,
                    newLeaderId: bestFid,
                  });
                }
                io.emit("alliance:updated", { allianceId: aid, alliance });
              }
              allianceUpdated = true;
            }

            // 3. Clear all tiles previously belonging to this faction
            const keysToDelete = [];
            Object.entries(mapState.tiles).forEach(([key, t]) => {
              const tfid = t.faction || t.factionId;
              if (tfid === targetFactionId) {
                keysToDelete.push(key);
              }
            });

            keysToDelete.forEach((key) => {
              // updatedTilesに削除を反映
              delete mapState.tiles[key];
              const [tx, ty] = key.split("_").map(Number);
              updatedTiles[key] = { x: tx, y: ty }; // Reset to empty
            });

            // 実際に削除
            keysToDelete.forEach((key) => {
              delete mapState.tiles[key];
            });

            // [Core Belligerent]
            handleFactionDestructionInWar(targetFactionId);
            cleanupDestroyedFaction(targetFactionId);
            delete factions.factions[targetFactionId];
          }
        }
      }

      if (destroyedFactions.length > 0) {
        queueFactionSave();
        queuePlayerSave();
        if (allianceUpdated) {
          saveJSON(ALLIANCES_PATH, alliancesData);
        }

        destroyedFactions.forEach(({ id: fId, name: destroyedFactionName }) => {
          // const destroyedF = factions.factions[fId]; // Deleted above
          logActivity("faction_destroyed", {
            message: `${faction.name} が ${destroyedFactionName} を滅亡させました`,
            factionId: fId,
            targetFactionName: destroyedFactionName,
            destroyedFactionName: destroyedFactionName, // 互換性のために追加
            destroyedByFaction: player.factionId,
            destroyerName: playerDisplayName,
            destroyerRoleName: roleName,
            destroyerFactionName: faction.name,
          });
          io.emit("faction:destroyed", { factionId: fId });
          io.emit("faction:updated", { factionId: fId, faction: null });
        });

        // [Fix 1] 滅亡した勢力のメンバーに通知を保存 (addFactionNoticeを使うように統一)
        destroyedFactions.forEach(
          ({ name: destroyedFactionName, members: oldMembers }) => {
            if (oldMembers && Array.isArray(oldMembers)) {
              oldMembers.forEach((mid) => {
                addFactionNotice(
                  `user:${mid}`,
                  "所属勢力の滅亡",
                  `${faction.name} との戦争により、所属していた勢力 ${destroyedFactionName} は滅亡しました。`,
                  null,
                  {
                    destroyedBy: faction.name,
                    destroyedFaction: destroyedFactionName,
                  },
                  null,
                  "system",
                ).catch((err) =>
                  console.error(
                    `[DestructionNoticeError2] Failed for ${mid}:`,
                    err,
                  ),
                );
              });
            }
          },
        );
      }

      // 2. 攻撃ログ (勢力ごと)
      logActivity("tiles_painted", {
        playerId: req.playerId,
        playerShortId: toShortId(req.playerId),
        playerName: playerDisplayName,
        roleName: roleName,
        factionId: player.factionId,
        factionName: faction.name,
        painterName: playerDisplayName,
        count: tiles.length,
        destruction: destructionInvolved,
        x: tiles[0].x,
        y: tiles[0].y,
        action: action, // [NEW] paint or overpaint
      });

      // --- [REMOVED] 旧ジャイアントキリング報酬ロジック ---
      // 仕様変更に伴い削除: AP消費前の確率コスト0化に移行済み。

      // 2. 攻撃ログ (勢力ごと)
      if (stolenCounts.size > 0) {
        stolenCounts.forEach((count, targetFid) => {
          // ターゲット勢力名取得 (削除された可能性もあるので注意)
          // `factions` object check?
          // `factions` is explicitly loaded at start of handler.
          // But if removed in `destroyedFactions` logic?
          // It might be gone if destroyed.
          // destroyedFactions loop handles "faction_destroyed" log.
          // Here we want "tiles_invaded" log.
          // If destroyed, maybe we don't need invaded log? Or we do?
          // User wants "Multiple simultaneous attacks...".
          // Let's log 'tiles_invaded' for each target.
          // Check if destroyed.
          // Check if destroyed.
          const isDestroyed = destroyedFactions.find(
            (d) => String(d.id) === String(targetFid),
          );
          let targetName = "Unknown";
          if (factions.factions[targetFid])
            targetName = factions.factions[targetFid].name;
          else if (isDestroyed) targetName = isDestroyed.name;

          logActivity("tiles_invaded", {
            playerId: req.playerId,
            playerShortId: toShortId(req.playerId),
            playerName: playerDisplayName,
            roleName: roleName,
            factionId: player.factionId,
            factionName: faction.name,
            targetFactionId: targetFid,
            targetFactionName: targetName,
            count: count,
            x: tiles[0].x,
            y: tiles[0].y,
          });
        });
      }

      // Add overpaint activity log -> Suppressed by user request
      /*
      if (action === "overpaint" && tiles.length > 0) {
        const roleStr =
          roleName && roleName !== "Member" ? `(${roleName})` : "";
        logActivity("overpaint", {
          playerId: req.playerId,
          playerName: playerDisplayName,
          roleName: roleName,
          factionId: player.factionId,
          factionName: faction.name,
          count: tiles.length,
          x: tiles[0].x,
          y: tiles[0].y,
        });
      }
      */

      // --- [NEW] UIリアルタイム更新用ブロードキャスト ---
      const affectedFactionIds = new Set([
        player.factionId,
        ...stolenCounts.keys(),
      ]);
      affectedFactionIds.forEach((fid) => {
        io.emit("faction:updated", {
          factionId: fid,
          faction: getEnrichedFaction(fid, factions, players),
        });
      });

      batchEmitTileUpdate(updatedTiles);

      // Build rankData for V2 check using worker stats (Array-based for isWeakFactionV2)

      // 弱気救済のAP返還 -> 廃止しました

      console.log(
        `[PaintSuccess] Player: ${req.playerId}, AP remaining: ${player.ap}`,
      );

      // (AP消費は処理の冒頭に移動しました)
      // Save changes (Player AP and Faction Shared AP)
      queuePlayerSave();
      if (faction && resultApConsumption?.usedSharedAp > 0) {
        queueFactionSave();
        io.emit("faction:updated", {
          factionId: faction.id,
          faction: getEnrichedFaction(faction.id, factions, players),
        });
      }

      res.json({
        success: true,
        remainingAP: player.ap,
        refilledAmount: player.refilledAmount,
        destroyedFactions,
      });
    } catch (e) {
      if (e.isExpected) {
        return res.status(403).json({ error: e.message });
      }
      console.error("[PaintError] Critical failure:", e);
      res.status(500).json({ error: "サーバー内部でエラーが発生しました" });
    }
  },
);
// 合併申請 (Merge Request)
app.post(
  "/api/factions/merge",
  authenticate,
  requireAuth,
  checkGameStatus,
  (req, res) => {
    const { targetFactionId } = req.body;
    const settings = loadJSON(SYSTEM_SETTINGS_PATH, {
      isMergeEnabled: true,
    });

    if (settings.isMergeEnabled === false) {
      return res
        .status(403)
        .json({ error: "現在、合併機能は無効化されています" });
    }

    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });

    const player = players.players[req.playerId];
    if (!player || !player.factionId)
      return res.status(400).json({ error: "勢力に所属していません" });

    const myFaction = factions.factions[player.factionId];
    const targetFaction = factions.factions[targetFactionId];

    if (!targetFaction)
      return res.status(404).json({ error: "対象勢力が見つかりません" });

    // 権限チェック (申請側はKing必須)
    if (myFaction.kingId !== req.playerId) {
      return res.status(403).json({ error: "合併申請は勢力主のみが行えます" });
    }

    if (myFaction.id === targetFactionId) {
      return res.status(400).json({ error: "自勢力には申請できません" });
    }

    // [NEW] 上位勢力による併合申請制限 (上位3勢力が吸収されるのは不可)
    // User Request: "上位3勢力への併合申請は制限しないで、上位3勢力が申請して吸収されるのを禁止にして"
    if (cachedFactionRanks && cachedFactionRanks.length > 0) {
      const myRankData = cachedFactionRanks.find((r) => r.id === myFaction.id);
      if (myRankData) {
        const MERGE_RANK_LIMIT = 3; // 1位〜3位は併合申請不可 (吸収される側になれない)
        if (myRankData.rank <= MERGE_RANK_LIMIT) {
          return res.status(403).json({
            error: `上位${MERGE_RANK_LIMIT}勢力は自ら吸収合併を申し込むことはできません (Your Rank: ${myRankData.rank})`,
          });
        }
      }
    }

    // 隣接チェック: 自勢力のタイルが、対象勢力の「中核マス」に隣接または近接しているか？
    // Find all Target Cores
    const targetCores = [];
    Object.values(mapState.tiles).forEach((t) => {
      if (t.core && t.core.factionId === targetFactionId) {
        targetCores.push(t);
      }
    });

    if (targetCores.length === 0) {
      return res
        .status(400)
        .json({ error: "対象勢力には中核マスがありません" });
    }

    // Check if any of my tiles are within 1 tile of any target core
    let isAdjacent = false;
    const offsets = [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];

    for (const core of targetCores) {
      for (const [dx, dy] of offsets) {
        const key = `${core.x + dx}_${core.y + dy}`;
        const t = mapState.tiles[key];
        if (t && (t.faction || t.factionId) === myFaction.id) {
          isAdjacent = true;
          break;
        }
      }
      if (isAdjacent) break;
    }

    if (!isAdjacent) {
      return res.status(400).json({
        error: "合併申請を行うには、対象勢力の中核マスに隣接する領土が必要です",
      });
    }

    // 申請そのものの重複チェック
    const allNotices = loadJSON(FACTION_NOTICES_PATH, {});
    const targetNotices = allNotices[targetFactionId] || [];
    const existingReq = targetNotices.find(
      (n) =>
        n.type === "merge_request" &&
        n.data?.requesterFactionId === myFaction.id &&
        !n.processedBy,
    );

    if (existingReq) {
      return res.status(400).json({ error: "既に合併申請を行っています" });
    }

    // Send Request
    addFactionNotice(
      targetFactionId,
      "吸収合併の提案",
      `${myFaction.name} から吸収合併の申し入れがありました。\n承諾すると、${myFaction.name} の全メンバーと領土が自勢力に統合されます。`,
      "king", // Only King can approve
      {
        requesterFactionId: myFaction.id,
        requesterFactionName: myFaction.name,
      },
      {
        actions: [
          { label: "承諾する", action: "approve", style: "primary" },
          { label: "拒否する", action: "reject", style: "danger" },
        ],
      },
      "merge_request",
      req.playerId,
    );

    res.json({ success: true, message: "合併申請を送りました" });
  },
);

// --- [NEW] ネームドマス作成API ---
app.post(
  "/api/tiles/named/create",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const { x, y, name } = req.body;

    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !name ||
      typeof name !== "string"
    ) {
      return res.status(400).json({ error: "Invalid parameters" });
    }

    if (name.length > 15) {
      return res
        .status(400)
        .json({ error: "名前は15文字以内で指定してください" });
    }

    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const namedCells = loadJSON(NAMED_CELLS_PATH, {});

    const player = players.players[req.playerId];
    if (!player || !player.factionId) {
      return res.status(400).json({ error: "勢力に所属していません" });
    }

    const faction = factions.factions[player.factionId];
    if (!faction) {
      return res.status(400).json({ error: "勢力が存在しません" });
    }

    // [NEW] 建造インターバルチェック
    const settings = loadJSON(SYSTEM_SETTINGS_PATH, {});
    const ntSettings = settings.namedTileSettings || {
      cost: 100,
      intervalHours: 0,
      maxNamedTiles: 50,
    };

    // [NEW] 最大数チェック
    const maxNamedTiles = ntSettings.maxNamedTiles ?? 50;
    if (maxNamedTiles > 0) {
      const currentCount = Object.keys(namedCells).length;
      if (currentCount >= maxNamedTiles) {
        return res.status(400).json({
          error: `ネームドマスの最大数(${maxNamedTiles})に達しているため、これ以上作成できません。`,
        });
      }
    }

    if (ntSettings.intervalHours > 0 && faction.lastNamedTileCreated) {
      const lastCreated = new Date(faction.lastNamedTileCreated).getTime();
      const now = Date.now();
      const elapsedHours = (now - lastCreated) / (1000 * 60 * 60);

      if (elapsedHours < ntSettings.intervalHours) {
        const remaining = ntSettings.intervalHours - elapsedHours;
        return res.status(400).json({
          error: `建造インターバル中です。あと ${remaining.toFixed(1)} 時間待つ必要があります。`,
        });
      }
    }

    // 権限チェック
    if (
      faction.kingId !== req.playerId &&
      !hasPermission(faction, req.playerId, "canManageNamedTiles")
    ) {
      return res
        .status(403)
        .json({ error: "ネームドマスを作成する権限がありません" });
    }

    // APチェック (共有AP自動消費)
    const COST = ntSettings.cost || 100;
    const hasSharedApPerm =
      faction.kingId === req.playerId ||
      hasPermission(faction, req.playerId, "canUseSharedAp");

    // 1. ドライランチェック
    const apCheck = attemptApConsumption(
      player,
      faction,
      COST,
      req.playerId,
      hasSharedApPerm,
      true, // dryRun
    );

    if (!apCheck.success) {
      return res.status(400).json({ error: `APが足りません (必要: ${COST})` });
    }

    // タイルバリデーション
    const key = `${x}_${y}`;
    const tile = mapState.tiles[key];
    if (!tile || (tile.faction || tile.factionId) !== player.factionId) {
      return res.status(400).json({ error: "自勢力の土地ではありません" });
    }

    if (tile.namedData) {
      return res.status(400).json({ error: "既にネームドマスです" });
    }

    // 距離チェック (11マスルール)
    for (const [nKey] of Object.entries(namedCells)) {
      const [nx, ny] = nKey.split("_").map(Number);
      const dist = Math.max(Math.abs(x - nx), Math.abs(y - ny));
      if (dist < 11) {
        return res.status(400).json({
          error: "既存のネームドマスから近すぎます (11マス以上離してください)",
        });
      }
    }

    try {
      // マップデータ更新
      await updateJSON(MAP_STATE_PATH, (mData) => {
        const t = mData.tiles[key];
        if (t) {
          t.namedData = {
            name: name,
            createdAt: Date.now(),
            owner: req.playerId,
          };
        }
        return { [key]: t };
      });

      // ネームドマスキャッシュ更新
      await updateJSON(NAMED_CELLS_PATH, (nData) => {
        nData[key] = {
          name: name,
          x: x,
          y: y,
        };
        return { [key]: nData[key] };
      });

      // 2. AP消費 (実行)
      // [FIX] データ更新成功の後にAP消費を実行する
      const consumeResult = attemptApConsumption(
        player,
        faction,
        COST,
        req.playerId,
        hasSharedApPerm,
        false, // actual
      );

      // [NEW] 勢力単位の建造制限を更新
      faction.lastNamedTileCreated = new Date().toISOString();

      // AP変更と建造時刻を保存
      saveJSON(PLAYERS_PATH, players);
      // 共有AP消費時、または建造時刻更新のために常に勢力情報を保存する
      saveJSON(FACTIONS_PATH, factions);

      if (consumeResult.usedSharedAp > 0) {
        // 常に放出する（インターバル更新通知のため）
        io.emit("faction:updated", {
          factionId: faction.id,
          faction: getEnrichedFaction(faction.id, factions, players),
        });
      }

      // ログ
      let roleName = "Member";
      if (faction.memberRoles && faction.memberRoles[req.playerId]) {
        const rId = faction.memberRoles[req.playerId];
        const role = (faction.roles || []).find((r) => r.id === rId);
        if (role) roleName = role.name;
      }

      logActivity("named_tile_created", {
        playerId: req.playerId,
        creatorName: player.displayName,
        roleName: roleName,
        factionId: player.factionId,
        factionName: faction.name,
        x,
        y,
        name,
      });

      io.emit("ap:refresh");
      // タイル更新
      const updatedTileForEmit = {
        ...tile,
        namedData: { name, createdAt: Date.now() },
      };

      // [FIX] 通知漏れ修正: namedCellsのステートも全クライアントで更新する
      io.emit("namedCell:created", {
        tileKey: key,
        namedCell: {
          name: name,
          x: x,
          y: y,
        },
      });

      io.emit("tile:update", { [key]: updatedTileForEmit });

      res.json({ success: true, remainingAP: player.ap });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "作成に失敗しました" });
    }
  },
);

// --- [NEW] ネームドマス改名API ---
app.post(
  "/api/tiles/named/rename",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const { x, y, name } = req.body;

    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !name ||
      typeof name !== "string"
    ) {
      return res.status(400).json({ error: "Invalid parameters" });
    }

    const trimmedName = name.trim();
    if (trimmedName.length === 0 || trimmedName.length > 15) {
      return res.status(400).json({
        error: "名前は1〜15文字で指定してください（空白のみ不可）",
      });
    }
    if (trimmedName.replace(/[\u200B-\u200D\uFEFF]/g, "").length === 0) {
      return res.status(400).json({ error: "無効な文字が含まれています" });
    }

    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const namedCellsData = loadJSON(NAMED_CELLS_PATH, {});

    const player = players.players[req.playerId];
    if (!player || !player.factionId) {
      return res.status(400).json({ error: "勢力に所属していません" });
    }

    const faction = factions.factions[player.factionId];
    if (!faction) {
      return res.status(400).json({ error: "勢力が存在しません" });
    }

    const key = `${x}_${y}`;
    const tile = mapState.tiles[key];
    const namedCell = namedCellsData[key];

    // 対象が存在し、かつ自勢力のものであること
    if (!tile?.namedData && !namedCell) {
      return res
        .status(404)
        .json({ error: "指定されたネームドマスが存在しません" });
    }

    const tileFid = tile?.faction || tile?.factionId || namedCell?.factionId;
    if (tileFid !== player.factionId) {
      return res
        .status(403)
        .json({ error: "自勢力のネームドマスではありません" });
    }

    // 権限チェック: 勢力主 OR ネームドマス管理権限 OR 作成者
    const isKing = faction.kingId === req.playerId;
    const hasPerm = hasPermission(faction, req.playerId, "canManageNamedTiles");
    const isCreator =
      tile?.namedData?.owner === req.playerId ||
      tile?.paintedBy === req.playerId ||
      namedCell?.owner === req.playerId;

    if (!isKing && !hasPerm && !isCreator) {
      return res
        .status(403)
        .json({ error: "ネームドマスを編集する権限がありません" });
    }

    try {
      const oldName =
        tile?.namedData?.name || namedCell?.name || "不明なネームドマス";

      // マップデータ更新
      await updateJSON(MAP_STATE_PATH, (mData) => {
        let t = mData.tiles[key];
        if (!t) {
          t = {
            x,
            y,
            faction: player.factionId,
            factionId: player.factionId,
            color: faction.color,
          };
          mData.tiles[key] = t;
        }
        if (!t.namedData) {
          t.namedData = {
            ...(namedCell || {}),
            name: trimmedName,
            x,
            y,
            factionId: player.factionId,
            owner: namedCell?.owner || player.id,
            createdAt: namedCell?.createdAt || Date.now(),
          };
        } else {
          t.namedData.name = trimmedName;
        }
      });

      // ネームドマスキャッシュ更新
      const updatedNamedCell = {
        ...(namedCell || {}),
        name: trimmedName,
        x,
        y,
        // factionId: player.factionId, // REMOVED
        // owner: namedCell?.owner || player.id, // REMOVED
        // createdAt: namedCell?.createdAt || Date.now(), // REMOVED
      };

      // 既存のプロパティを削除 (クリーンアップ)
      delete updatedNamedCell.factionId;
      delete updatedNamedCell.owner;
      delete updatedNamedCell.createdAt;
      delete updatedNamedCell.level; // [NEW] 削除済み (REMOVED)

      await updateJSON(NAMED_CELLS_PATH, (nData) => {
        nData[key] = updatedNamedCell;
      });

      // 更新をブロードキャスト
      const latestMapState = loadJSON(MAP_STATE_PATH, { tiles: {} });
      const newTile = latestMapState.tiles[key];
      if (newTile) {
        io.emit("tile:update", { [key]: newTile });
      }

      io.emit("namedCell:updated", {
        tileKey: key,
        namedCell: updatedNamedCell,
      });

      // ログ
      let roleName = "Member";
      if (isKing) roleName = faction.kingRoleName || "勢力主";
      else {
        const rId = faction.memberRoles?.[req.playerId];
        if (rId && faction.roles) {
          const role = faction.roles.find((r) => r.id === rId);
          if (role) roleName = role.name;
        }
      }

      io.emit("log:new", {
        type: "info",
        factionId: player.factionId,
        message: `${roleName} ${player.displayName} がネームドマス (${x}, ${y}) の名前を "${oldName}" から "${trimmedName}" に変更しました`,
      });

      return res.json({ success: true, name: trimmedName });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

// --- [NEW] ネームドマス削除API ---
app.post(
  "/api/tiles/named/delete",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const { x, y } = req.body;

    if (typeof x !== "number" || typeof y !== "number") {
      return res.status(400).json({ error: "Invalid parameters" });
    }

    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const namedCellsData = loadJSON(NAMED_CELLS_PATH, {});

    const player = players.players[req.playerId];
    if (!player || !player.factionId) {
      return res.status(400).json({ error: "勢力に所属していません" });
    }

    const faction = factions.factions[player.factionId];
    if (!faction) {
      return res.status(400).json({ error: "勢力が存在しません" });
    }

    const key = `${x}_${y}`;
    const tile = mapState.tiles[key];
    const namedCell = namedCellsData[key];

    if (!tile?.namedData && !namedCell) {
      return res
        .status(404)
        .json({ error: "指定されたネームドマスが存在しません" });
    }

    const tileFid = tile?.faction || tile?.factionId || namedCell?.factionId;
    if (tileFid !== player.factionId) {
      return res
        .status(403)
        .json({ error: "自勢力のネームドマスではありません" });
    }

    // 権限チェック: 勢力主 OR ネームドマス管理権限
    const isKing = faction.kingId === req.playerId;
    const hasPerm = hasPermission(faction, req.playerId, "canManageNamedTiles");
    if (!isKing && !hasPerm) {
      return res
        .status(403)
        .json({ error: "ネームドマスを削除する権限がありません" });
    }

    try {
      const oldName =
        tile?.namedData?.name || namedCell?.name || "不明なネームドマス";

      // マップデータ更新
      await updateJSON(MAP_STATE_PATH, (mData) => {
        const t = mData.tiles[key];
        if (t && t.namedData) {
          delete t.namedData;
        }
      });

      // ネームドマスキャッシュ更新
      await updateJSON(NAMED_CELLS_PATH, (nData) => {
        if (nData[key]) {
          delete nData[key];
        }
      });

      // タイル更新をブロードキャスト (namedDataをクリア)
      if (tile) {
        const updatedTile = { ...tile };
        delete updatedTile.namedData;
        io.emit("tile:update", { [key]: updatedTile });
      } else {
        // もし mapState にタイル自体がない場合は、空のタイル(無所属)として通知するか、何もしない
        // ここでは念のため null で通知してクライアント側のキャッシュを消す(必要なら)
        // ただし通常は tile が存在しない＝描画対象外
      }

      // ネームドマス削除をサイドバー/ラベルに通知
      io.emit("namedCell:destroyed", { tileKey: key });

      // ログ
      let roleName = "Member";
      if (isKing) roleName = faction.kingRoleName || "勢力主";
      else {
        const rId = faction.memberRoles?.[req.playerId];
        if (rId && faction.roles) {
          const role = faction.roles.find((r) => r.id === rId);
          if (role) roleName = role.name;
        }
      }

      io.emit("log:new", {
        type: "info",
        factionId: player.factionId,
        message: `${roleName} ${player.displayName} がネームドマス "${oldName}" (${x}, ${y}) を削除しました`,
      });

      return res.json({ success: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);
app.post(
  "/api/tiles/estimate",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const { tiles, action } = req.body; // action: 'paint' | 'overpaint'
    if (!tiles || !Array.isArray(tiles))
      return res.status(400).json({ error: "Invalid tiles" });

    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const player = players.players[req.playerId];
    if (!player || !player.factionId)
      return res.status(400).json({ error: "User not valid" });

    // 休憩時間チェック（他勢力上書き時のみ）
    const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });
    const hasEnemyTiles = tiles.some((t) => {
      const existing = mapState.tiles[`${t.x}_${t.y}`];
      return (
        existing &&
        existing.factionId &&
        existing.factionId !== player.factionId
      );
    });

    let breakTimeError = null;
    if (hasEnemyTiles && isBreakTime()) {
      const settings = loadJSON(SYSTEM_SETTINGS_PATH, {});
      const breakSettings = settings.breakTime;
      breakTimeError = `休憩時間中です（${breakSettings.startTime} ～ ${breakSettings.endTime}）。この間は他勢力への攻撃ができません。`;
    }

    // --- [OPTIMIZATION] 見積もりをWorker Poolにオフロード ---
    try {
      const response = await runWorkerTask("PREPARE_PAINT", {
        tiles,
        player,
        action,
        overpaintCount: req.body.overpaintCount || 1,
        namedTileSettings: loadJSON(SYSTEM_SETTINGS_PATH, {}).namedTileSettings,
      });

      if (!response.success) {
        return res.status(400).json({ error: response.error });
      }
      // 休憩時間エラーをレスポンスに含める
      res.json({ ...response.results, breakTimeError });
    } catch (error) {
      console.error("[EstimateError]", error);
      res.status(500).json({ error: "見積もり計算中にエラーが発生しました" });
    }
  },
);

// AP消費計算ヘルパー (個人AP -> 共有AP)
function attemptApConsumption(
  player,
  faction,
  cost,
  playerId,
  hasSharedApPerm,
  dryRun = false,
) {
  let usedSharedAp = 0;
  let remainingCost = cost;

  // ドライラン予測用にオブジェクトを複製し、副作用を防ぐ
  const simPlayer = dryRun ? { ...player } : player;
  const simFaction = dryRun ? { ...faction } : faction;

  // 1. 最初に個人APを消費
  if (simPlayer.ap >= remainingCost) {
    simPlayer.ap -= remainingCost;
    remainingCost = 0;
  } else {
    remainingCost -= simPlayer.ap;
    simPlayer.ap = 0;
  }

  // 2. 有効かつ許可されていれば共有APを消費
  if (remainingCost > 0) {
    if (simPlayer.autoConsumeSharedAp && hasSharedApPerm) {
      const currentShared = simFaction.sharedAP || 0;
      if (currentShared >= remainingCost) {
        simFaction.sharedAP = currentShared - remainingCost;
        usedSharedAp = remainingCost;
        remainingCost = 0;
      } else {
        // Not enough shared AP
        return {
          success: false,
          error: `共有APが足りません (不足: ${remainingCost}, 共有AP: ${currentShared})`,
        };
      }
    } else {
      // Shared AP not enabled or not permitted
      return {
        success: false,
        error: `APが足りません (不足: ${remainingCost})`,
      };
    }
  }

  if (!dryRun) {
    player.lastApAction = Date.now();
  }

  return { success: true, usedSharedAp };
}

// カスタム色設定 (Custom Tile Color)
app.post(
  "/api/tiles/color",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const { tiles, x, y, color } = req.body;
    // tiles配列がない場合、旧仕様(x,y)があれば配列に変換して対応
    let targetTiles = tiles;
    if (!targetTiles && typeof x === "number" && typeof y === "number") {
      targetTiles = [{ x, y }];
    }

    if (
      !targetTiles ||
      !Array.isArray(targetTiles) ||
      targetTiles.length === 0
    ) {
      return res.status(400).json({ error: "タイルを指定してください" });
    }

    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const player = players.players[req.playerId];

    if (!player.factionId) {
      return res.status(400).json({ error: "勢力に所属していません" });
    }
    const faction = factions.factions[player.factionId];

    // 1. 権限チェック (King or canManageSettings)
    let canManage = faction.kingId === req.playerId;
    if (
      !canManage &&
      faction.memberRoles &&
      faction.memberRoles[req.playerId]
    ) {
      const rId = faction.memberRoles[req.playerId];
      const role = faction.roles?.find((r) => r.id === rId);
      if (role?.permissions?.canManageSettings) canManage = true;
    }

    if (!canManage) {
      return res.status(403).json({ error: "権限がありません" });
    }

    // 2. タイル所有 & 包囲条件チェック & 更新
    const updatedTiles = {};
    let successCount = 0;

    await updateJSON(
      MAP_STATE_PATH,
      async (mapState) => {
        const directions = [
          [-1, -1],
          [0, -1],
          [1, -1],
          [-1, 0],
          [1, 0],
          [-1, 1],
          [0, 1],
          [1, 1],
        ];

        for (const t of targetTiles) {
          const key = `${t.x}_${t.y}`;
          const tile = mapState.tiles[key];

          // 自勢力タイルか？
          const tileFid = tile ? tile.factionId || tile.faction : null;
          if (!tileFid || String(tileFid) !== String(player.factionId)) {
            continue; // Skip invalid tiles
          }

          // 8方向包囲チェック
          let isSurrounded = true;
          for (const [dx, dy] of directions) {
            const nKey = `${t.x + dx}_${t.y + dy}`;
            const nTile = mapState.tiles[nKey];
            const nFid = nTile ? nTile.factionId || nTile.faction : null;
            if (!nFid || String(nFid) !== String(player.factionId)) {
              isSurrounded = false;
              break;
            }
          }

          if (!isSurrounded) {
            continue; // Skip not surrounded tiles
          }

          // 3. 色適用
          if (!tile.customColor) tile.customColor = "";
          tile.customColor = color;
          updatedTiles[key] = tile;
          successCount++;
        }

        return updatedTiles; // updateJSON will merge these changes
      },
      true,
    ); // forceReload

    // 通知 (一括送信)
    if (Object.keys(updatedTiles).length > 0) {
      io.emit("tile:update", updatedTiles);
    }

    if (successCount === 0) {
      return res.status(400).json({
        error:
          "条件を満たすタイルがありませんでした（自勢力かつ周囲8マスが自勢力のタイルのみ変更可能です）",
      });
    }

    res.json({ success: true, count: successCount });
  },
);

// タイル消去 (自分が塗ったタイルのみ、AP消費なし)
app.post(
  "/api/tiles/erase",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const { tiles } = req.body;
    console.log(
      `[EraseRequest] Player: ${req.playerId}, Tiles: ${tiles?.length}`,
    );

    if (!tiles || tiles.length === 0) {
      return res.status(400).json({ error: "タイルを指定してください" });
    }

    try {
      const players = loadJSON(PLAYERS_PATH, { players: {} });
      const factions = loadJSON(FACTIONS_PATH, { factions: {} });

      const player = players.players[req.playerId];
      if (!player)
        return res.status(401).json({ error: "ユーザーが見つかりません" });
      if (!player.factionId) {
        return res.status(400).json({ error: "勢力に所属していません" });
      }

      const erasedKeys = [];
      const customColorRemovedTiles = {};

      const faction = factions.factions[player.factionId];

      await updateJSON(MAP_STATE_PATH, async (mapData) => {
        for (const t of tiles) {
          const key = `${t.x}_${t.y}`;
          const existingTile = mapData.tiles[key];

          if (existingTile) {
            const tileFid = existingTile.faction || existingTile.factionId;
            if (tileFid === player.factionId) {
              const isSelfPainted = existingTile.paintedBy === req.playerId;
              const hasErasePerm = hasPermission(
                faction,
                req.playerId,
                "canErase",
              );

              if (isSelfPainted || hasErasePerm) {
                // delete mapData.tiles[key]; // 古い仕様: オブジェクトごと削除

                // 新仕様: 所有権/視覚データのみ削除し、メタデータは保持する
                const t = mapData.tiles[key];
                delete t.faction;
                delete t.factionId;
                delete t.color;
                delete t.overpaint;
                delete t.paintedBy;
                // delete t.paintedByName; // REMOVED
                delete t.customColor;

                // メタデータが残っていなければ、削除して容量を節約できる
                const hasMetadata =
                  t.core || t.namedData || t.isCorePending || t.coreTime;
                if (!hasMetadata) {
                  delete mapData.tiles[key];
                }

                erasedKeys.push(key);
              }
            }
          }
        }

        // [MODIFIED] カスタムカラー復帰ロジック (Erase版) を削除
        /*
        if (erasedKeys.length > 0) {
          const directions = [
            [-1, -1],
            [0, -1],
            [1, -1],
            [-1, 0],
            [1, 0],
            [-1, 1],
            [0, 1],
            [1, 1],
          ];
          const checkedNeighbors = new Set();

          erasedKeys.forEach((key) => {
            const [ex, ey] = key.split("_").map(Number);
            directions.forEach(([dx, dy]) => {
              const nx = ex + dx;
              const ny = ey + dy;
              const nKey = `${nx}_${ny}`;

              if (checkedNeighbors.has(nKey)) return;
              checkedNeighbors.add(nKey);

              const neighbor = mapData.tiles[nKey];
              // カスタムカラー設定がある場合のみチェック
              if (neighbor && neighbor.customColor) {
                const nFid = neighbor.faction || neighbor.factionId;
                let isSurrounded = true;

                for (const [ddx, ddy] of directions) {
                  const nnx = nx + ddx;
                  const nny = ny + ddy;
                  const nnKey = `${nnx}_${nny}`;
                  const nnTile = mapData.tiles[nnKey];
                  const nnFid = nnTile
                    ? nnTile.faction || nnTile.factionId
                    : null;

                  if (nnFid !== nFid) {
                    isSurrounded = false;
                    break;
                  }
                }

                if (!isSurrounded) {
                  delete neighbor.customColor;
                  customColorRemovedTiles[nKey] = neighbor; // 更新通知用に保存
                }
              }
            });
          });
        }
        */

        return mapData;
      });

      if (erasedKeys.length === 0) {
        return res.status(400).json({ error: "消去できるタイルがありません" });
      }

      const tilesUpdate = {};
      // 削除された（中立化された）タイル
      const latestMap = loadJSON(MAP_STATE_PATH, { tiles: {} });
      erasedKeys.forEach((k) => {
        // nullを送信するとクライアント側で完全に消去される可能性があるため、
        // サーバー側の最新状態（所有権なし、メタデータあり）を送信する
        tilesUpdate[k] = latestMap.tiles[k] || null;
      });
      // カスタムカラーが解除されたタイル
      Object.assign(tilesUpdate, customColorRemovedTiles);

      io.emit("tile:update", tilesUpdate);
      console.log(
        `[EraseSuccess] Player: ${req.playerId}, Tiles: ${erasedKeys.length}`,
      );

      // --- [NEW] Start Destruction Check ---
      // 勢力のタイル数が0になったかチェック
      const currentMap = loadJSON(MAP_STATE_PATH, { tiles: {} });
      let hasTiles = false;
      for (const t of Object.values(currentMap.tiles)) {
        if ((t.faction || t.factionId) === player.factionId) {
          hasTiles = true;
          break;
        }
      }

      let destroyedDetails = null;

      if (!hasTiles) {
        console.log(`[SelfDestruct] Faction ${player.factionId} has 0 tiles.`);

        // 勢力削除処理
        await updateJSON(FACTIONS_PATH, async (factionsData) => {
          const f = factionsData.factions[player.factionId];
          if (!f) return factionsData;

          // 1. メンバー解放
          const playersData = loadJSON(PLAYERS_PATH, { players: {} });
          if (f.members) {
            f.members.forEach((mid) => {
              if (playersData.players[mid])
                playersData.players[mid].factionId = null;
            });
            saveJSON(PLAYERS_PATH, playersData);
          }

          // 2. 同盟処理 (Alliance Cleanup)
          if (f.allianceId) {
            const alliancesData = loadJSON(ALLIANCES_PATH, {
              alliances: {},
            });
            const alliance = (alliancesData.alliances || {})[f.allianceId];

            if (alliance) {
              // メンバーから削除
              alliance.members = alliance.members.filter(
                (mid) => mid !== player.factionId,
              );

              // 残りメンバー数チェック
              // 「同盟がその勢力しかいなかったら」-> つまり残り0 or 1になったら解散？
              // 通常、同盟は2勢力以上で成立。1勢力だけ残っても同盟の意味がないので解散とするのが一般的。
              // ユーザー要望: "同盟がその勢力しかいなかったらその同盟も削除" -> 残り0人の場合？あるいは1人？
              // "その勢力しか" = 自分以外誰もいない状態 = 残り0人
              // しかし、自分が消えた後、残りが1人なら同盟としては機能しないので解散させるべき。

              if (alliance.members.length <= 1) {
                if (alliancesData.alliances) {
                  delete alliancesData.alliances[f.allianceId];
                }
                logActivity("alliance_disbanded", {
                  message: `構成勢力が消滅したため、同盟「${alliance.name}」は解散しました`,
                  allianceName: alliance.name,
                });
                io.emit("alliance:disbanded", { allianceId: f.allianceId });
              } else {
                // まだ残っている場合
                // もし消滅した勢力が盟主だったら委譲
                if (alliance.leaderFactionId === player.factionId) {
                  const newLeader = alliance.members[0]; // 簡易的に最初の人
                  alliance.leaderFactionId = newLeader;
                  logActivity("alliance_updated", {
                    message: `盟主勢力消滅に伴い、同盟「${alliance.name}」の盟主が変更されました`,
                    allianceId: f.allianceId,
                    newLeaderId: newLeader,
                  });
                }
                io.emit("alliance:updated", {
                  allianceId: f.allianceId,
                  alliance,
                });
              }
              saveJSON(ALLIANCES_PATH, alliancesData);
            }
          }

          // 削除実行

          // [Core Belligerent] Handle War Logic before deletion
          handleFactionDestructionInWar(player.factionId);
          delete factionsData.factions[player.factionId];

          // ログ
          logActivity("faction_destroyed", {
            message: `領土をすべて失ったため、${f.name} は消滅しました (自滅)`,
            factionName: f.name,
            destroyedFactionName: f.name, // 追加
            factionId: player.factionId,
            destroyerName: "自滅", // or System
          });

          destroyedDetails = { id: player.factionId, name: f.name };
          return factionsData;
        });
      }

      if (destroyedDetails) {
        io.emit("faction:destroyed", { factionId: destroyedDetails.id });
        io.emit("faction:updated", {
          factionId: destroyedDetails.id,
          faction: null,
        });
        io.emit("ap:refresh");
      }
      // --- End Destruction Check ---

      if (!destroyedDetails && erasedKeys.length > 0) {
        // [Fix] Erase時にポイント再計算と通知を行う
        await updateRankingCache();
        const rankData = cachedFactionRanks.find(
          (r) => r.id === player.factionId,
        );

        if (rankData && factions.factions[player.factionId]) {
          const currentFaction = factions.factions[player.factionId];
          // メモリ上の値を更新 (getEnrichedFactionが参照するため)
          currentFaction.totalPoints = rankData.points;

          io.emit("faction:updated", {
            factionId: player.factionId,
            faction: getEnrichedFaction(player.factionId, factions, players),
          });

          // ポイントだけの軽量更新も送る
          io.emit("faction:pointsUpdated", {
            factionId: player.factionId,
            points: rankData.points,
            rank: rankData.rank,
          });
        }
      }

      res.json({
        success: true,
        erasedCount: erasedKeys.length,
        destroyed: !!destroyedDetails,
      });
    } catch (e) {
      console.error("[EraseError] Critical failure:", e);
      res.status(500).json({ error: "サーバー内部でエラーが発生しました" });
    }
  },
);

// ===== Season 2: ネームドマス API =====

// ネームドマス一覧取得
app.get("/api/named-cells", (req, res) => {
  const namedCells = loadJSON(NAMED_CELLS_PATH, {});
  res.json({ success: true, namedCells });
});

// ネームドマス作成
app.post(
  "/api/named-cells/create",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const { x, y, name } = req.body;

    if (typeof x !== "number" || typeof y !== "number") {
      return res.status(400).json({ error: "座標が無効です" });
    }

    if (!name || name.trim().length === 0 || name.length > 15) {
      return res
        .status(400)
        .json({ error: "名称は1〜15文字で入力してください" });
    }

    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });
    const namedCells = loadJSON(NAMED_CELLS_PATH, {});
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });

    const player = players.players[req.playerId];
    if (!player.factionId) {
      return res.status(400).json({ error: "勢力に所属していません" });
    }
    const faction = factions.factions[player.factionId];

    // タイル所有チェック
    const tileKey = `${x}_${y}`;
    const tile = mapState.tiles[tileKey];
    if (!tile || (tile.faction || tile.factionId) !== player.factionId) {
      return res
        .status(400)
        .json({ error: "自勢力のタイルにのみネームドマスを作成できます" });
    }

    // 既存のネームドマスチェック
    if (namedCells[tileKey]) {
      return res
        .status(400)
        .json({ error: "このタイルには既にネームドマスがあります" });
    }

    // 距離チェック
    if (!isValidNamedCellLocation(x, y, namedCells)) {
      return res.status(400).json({
        error: `他のネームドマスから${NAMED_CELL_MIN_DISTANCE}マス以上離れている必要があります`,
      });
    }

    // APチェック (DryRun)
    const hasSharedApPerm =
      faction &&
      (faction.kingId === req.playerId ||
        hasPermission(faction, req.playerId, "canUseSharedAp"));
    const apCheck = attemptApConsumption(
      player,
      faction,
      NAMED_CELL_CREATE_COST,
      req.playerId,
      hasSharedApPerm,
      true, // dryRun
    );

    if (!apCheck.success) {
      return res.status(400).json({
        error: `APが足りません（必要: ${NAMED_CELL_CREATE_COST}）`,
      });
    }

    // 2. Consume AP (Actual)
    const consumeResult = attemptApConsumption(
      player,
      faction,
      NAMED_CELL_CREATE_COST,
      req.playerId,
      hasSharedApPerm,
      false, // actual
    );

    // Save changes (AP deducted)
    saveJSON(PLAYERS_PATH, players);
    if (consumeResult.usedSharedAp > 0) {
      saveJSON(FACTIONS_PATH, factions);
      io.emit("faction:updated", {
        factionId: faction.id,
        faction: getEnrichedFaction(faction.id, factions, players),
      });
    }

    // 支配チェック撤廃: 追加要件により削除
    // if (!checkDomination(x, y, 1, player.factionId, mapState.tiles)) { ... }

    // AP消費 (ヘルパーによって既に消費済み)
    // player.ap -= NAMED_CELL_CREATE_COST;
    // saveJSON(PLAYERS_PATH, players); // 上部で保存済み

    // 確率判定 (廃止: 確定作成)
    // if (Math.random() > NAMED_CELL_CREATE_CHANCE) { ... }

    // 作成成功
    const newNamedCell = {
      name: name.trim(),
      level: 1,
      owner: req.playerId,
      factionId: player.factionId,
      createdAt: new Date(Date.now() + 9 * 60 * 60 * 1000)
        .toISOString()
        .replace("Z", "+09:00"),
    };

    namedCells[tileKey] = newNamedCell;
    saveJSON(NAMED_CELLS_PATH, namedCells);

    logActivity("named_cell_created", {
      tileKey,
      name: newNamedCell.name,
      playerId: req.playerId,
      factionId: player.factionId,
      factionName: faction ? faction.name : "Unknown",
    });

    io.emit("namedCell:created", { tileKey, namedCell: newNamedCell });
    io.emit("ap:refresh");

    res.json({ success: true, namedCell: newNamedCell });
  },
);

// ネームドマス名称変更
app.post(
  "/api/named-cells/:key/rename",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const { key } = req.params;
    const { name } = req.body;

    if (!name || name.trim().length === 0 || name.length > 15) {
      return res
        .status(400)
        .json({ error: "名称は1〜15文字で入力してください" });
    }

    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const namedCells = loadJSON(NAMED_CELLS_PATH, {});

    const namedCell = namedCells[key];
    if (!namedCell) {
      return res.status(404).json({ error: "ネームドマスが見つかりません" });
    }

    const faction = factions.factions[namedCell.factionId];

    // 権限チェック: タイル主または勢力主
    const isOwner = namedCell.owner === req.playerId;
    const isKing = faction && faction.kingId === req.playerId;

    if (!isOwner && !isKing) {
      return res
        .status(403)
        .json({ error: "タイル主または勢力主のみが名称を変更できます" });
    }

    namedCell.name = name.trim();
    saveJSON(NAMED_CELLS_PATH, namedCells);

    io.emit("namedCell:updated", { tileKey: key, namedCell });

    res.json({ success: true, namedCell });
  },
);

// ネームドマス攻撃
app.post(
  "/api/named-cells/:key/attack",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const { key } = req.params;

    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const namedCells = loadJSON(NAMED_CELLS_PATH, {});
    const factions = loadJSON(FACTIONS_PATH, { factions: {} }); // Load factions

    const namedCell = namedCells[key];
    if (!namedCell) {
      return res.status(404).json({ error: "ネームドマスが見つかりません" });
    }

    const player = players.players[req.playerId];
    const faction = factions.factions[player.factionId]; // Get faction
    const hasSharedApPerm = hasPermission(
      faction,
      req.playerId,
      "canUseSharedAp",
    );

    // 自勢力は攻撃不可
    if (namedCell.factionId === player.factionId) {
      return res
        .status(400)
        .json({ error: "自勢力のネームドマスは攻撃できません" });
    }

    // 包囲判定 helper (戦争状態の敵のみが包囲判定となる)
    const checkBesieged = (cx, cy, fId, tiles, warsData, alliancesData) => {
      const offsets = [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ];

      // 自分の同盟IDを取得
      const myFactionData = factions.factions[fId];
      const myAllianceId = myFactionData ? myFactionData.allianceId : null;
      let myAllies = new Set([fId]);
      if (
        myAllianceId &&
        alliancesData.alliances &&
        alliancesData.alliances[myAllianceId]
      ) {
        alliancesData.alliances[myAllianceId].members.forEach((m) =>
          myAllies.add(m),
        );
      }

      for (const [dx, dy] of offsets) {
        const nx = cx + dx;
        const ny = cy + dy;
        // マップ端は「壁」として味方扱い（包囲されない）
        if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) return false;

        const t = tiles[`${nx}_${ny}`];
        const tFid = t ? t.factionId || t.faction : null;

        // 1. 空白地なら包囲されていない
        if (!tFid) return false;

        // 2. 自勢力または同盟勢力なら包囲されていない
        if (myAllies.has(tFid)) return false;

        // 3. 他勢力だが戦争状態でないなら包囲されていない
        // 戦争チェック
        let isAtWar = false;
        const myFidStr = String(fId);
        const targetFidStr = String(tFid);
        if (warsData && warsData.wars) {
          Object.values(warsData.wars).forEach((w) => {
            if (w.attackerSide && w.defenderSide) {
              const attackers = w.attackerSide.factions.map(String);
              const defenders = w.defenderSide.factions.map(String);
              if (
                (attackers.includes(myFidStr) &&
                  defenders.includes(targetFidStr)) ||
                (defenders.includes(myFidStr) &&
                  attackers.includes(targetFidStr))
              ) {
                isAtWar = true;
              }
            }
          });
        }
        if (!isAtWar) return false;
      }
      return true; // 全周囲が戦争状態の敵、または壁以外の要素で塞がれていることはない（壁はfalseで抜ける）
      // 修正: 全ての隣接マスを確認し、一つでも「非敵対」があれば false。ループを抜けずに最後まで来たら true。
    };

    const wars = loadJSON(WARS_PATH, { wars: {} });
    const alliances = loadJSON(ALLIANCES_PATH, { alliances: {} });

    const isBesieged = checkBesieged(
      namedCell.x || parseInt(key.split("_")[0]),
      namedCell.y || parseInt(key.split("_")[1]),
      namedCell.factionId,
      loadJSON(MAP_STATE_PATH, { tiles: {} }).tiles,
      wars,
      alliances,
    );

    // クールダウンチェック
    // 基本: 60分, 包囲時: 30分 (ユーザー要望により変更)
    const cooldownMs = isBesieged ? 30 * 60 * 1000 : 60 * 60 * 1000;
    const now = Date.now();
    if (
      namedCell.lastAttackedAt &&
      now - namedCell.lastAttackedAt < cooldownMs
    ) {
      const remainingMin = Math.ceil(
        (cooldownMs - (now - namedCell.lastAttackedAt)) / 60000,
      );
      return res.status(400).json({
        error: `攻撃できません。再攻撃まであと${remainingMin}分です`,
      });
    }

    // コスト計算: 基本塗りコスト + 5 AP
    // calculatePaintCost相当のロジック (簡易実装: 自分の領土なら1, 他人の領土なら2, ここでは「攻撃」なので常に他人の領土扱い=基本2とするか、仕様通り「そのマスを塗るコスト」に準拠)
    // 通常、敵地を塗るコストは 2 (所有権あり) または 1 (中立)。ネームドマスは所有権があるので2。
    // 手動でベースコスト = 2 (敵地標準) + 5 = 7 と仮定する。
    const basePaintCost = 2;
    const cost = basePaintCost + 5;

    // ... AP check (existing) ...

    // ...
    // APチェック (ドライラン)
    const apCheck = attemptApConsumption(
      player,
      faction,
      cost,
      req.playerId,
      hasSharedApPerm,
      true, // dryRun
    );

    if (!apCheck.success) {
      return res.status(400).json({ error: `APが足りません（必要: ${cost}）` });
    }

    // 2. AP消費 (実行)
    const consumeResult = attemptApConsumption(
      player,
      faction,
      cost,
      req.playerId,
      hasSharedApPerm,
      false, // actual
    );

    // 変更を即時保存
    saveJSON(PLAYERS_PATH, players);
    if (consumeResult.usedSharedAp > 0) {
      saveJSON(FACTIONS_PATH, factions);
      io.emit("faction:updated", {
        factionId: faction.id,
        faction: getEnrichedFaction(faction.id, factions, players),
      });
    }

    // 攻撃実行 (= 試行) なのでここでCooldown更新
    namedCell.lastAttackedAt = now;
    saveJSON(NAMED_CELLS_PATH, namedCells);

    // 陥落判定
    // 基本: 10%, 包囲時: 30% (固定)
    const fallChance = isBesieged ? 0.3 : 0.1;
    if (Math.random() > fallChance) {
      io.emit("ap:refresh");
      return res.json({
        success: false,
        message: `攻撃は失敗しました（陥落確率: ${Math.round(fallChance * 100)}%）`,
      });
    }

    // 陥落成功 - ネームドマスを破壊
    const destroyedCell = { ...namedCell };
    delete namedCells[key];
    saveJSON(NAMED_CELLS_PATH, namedCells);

    // [NEW] 破壊時のAPボーナス (10〜50 AP)
    const addedAp = Math.floor(Math.random() * 41) + 10;
    player.ap = Math.min(AP_MAX_LIMIT, (player.ap || 0) + addedAp);
    saveJSON(PLAYERS_PATH, players);

    // 役職情報の取得
    let roleName = "Member";
    const attackerFaction = factions.factions[player.factionId];
    if (attackerFaction) {
      if (attackerFaction.kingId === req.playerId) {
        roleName = attackerFaction.kingRoleName || "勢力主";
      } else {
        const rId = attackerFaction.memberRoles?.[req.playerId];
        if (rId && attackerFaction.roles) {
          const role = attackerFaction.roles.find((r) => r.id === rId);
          if (role) roleName = role.name;
        }
      }
    }

    logActivity("named_cell_destroyed", {
      tileKey: key,
      name: destroyedCell.name,
      level: destroyedCell.level,
      destroyedBy: req.playerId,
      playerName: player.displayName || toShortId(req.playerId),
      roleName: roleName,
      factionId: player.factionId,
      factionName: attackerFaction ? attackerFaction.name : "無所属",
      originalFaction: destroyedCell.factionId,
      bonusAp: addedAp,
    });

    io.emit("namedCell:destroyed", { tileKey: key });
    io.emit("ap:refresh");

    res.json({
      success: true,
      message: `ネームドマス「${destroyedCell.name}」を破壊しました`,
    });
  },
);

// ネームドマス削除（タイル主または勢力主）
app.post(
  "/api/named-cells/:key/delete",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const { key } = req.params;

    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const namedCells = loadJSON(NAMED_CELLS_PATH, {});

    const namedCell = namedCells[key];
    if (!namedCell) {
      return res.status(404).json({ error: "ネームドマスが見つかりません" });
    }

    const player = players.players[req.playerId];
    const faction = factions.factions[namedCell.factionId];

    // 権限チェック
    const isOwner = namedCell.owner === req.playerId;
    const isKing = faction && faction.kingId === req.playerId;

    if (!isOwner && !isKing) {
      return res
        .status(403)
        .json({ error: "タイル主または勢力主のみが削除できます" });
    }

    const deletedCell = { ...namedCell };
    delete namedCells[key];
    saveJSON(NAMED_CELLS_PATH, namedCells);

    // 役職情報の取得
    let roleName = "Member";
    const deleterFaction = factions.factions[player.factionId];
    if (deleterFaction) {
      if (deleterFaction.kingId === req.playerId) {
        roleName = deleterFaction.kingRoleName || "勢力主";
      } else {
        const rId = deleterFaction.memberRoles?.[req.playerId];
        if (rId && deleterFaction.roles) {
          const role = deleterFaction.roles.find((r) => r.id === rId);
          if (role) roleName = role.name;
        }
      }
    }

    logActivity("named_cell_deleted", {
      tileKey: key,
      name: deletedCell.name,
      deletedBy: req.playerId,
      playerName: player.displayName || toShortId(req.playerId),
      roleName: roleName,
      factionId: player.factionId,
      factionName: deleterFaction ? deleterFaction.name : "無所属",
    });

    io.emit("namedCell:destroyed", { tileKey: key });

    res.json({
      success: true,
      message: `ネームドマス「${deletedCell.name}」を削除しました`,
    });
  },
);

// ===== Season 2: 同盟 API =====

// 同盟一覧取得
app.get("/api/alliances", (req, res) => {
  const alliancesData = loadJSON(ALLIANCES_PATH, { alliances: {} });
  const detail = req.query.detail === "true";

  if (!detail) {
    return res.json({
      success: true,
      alliances: alliancesData.alliances || {},
    });
  }

  // 詳細情報 (勢力名など) を付加
  const factions = loadJSON(FACTIONS_PATH, { factions: {} });
  const enrichedAlliances = {};

  Object.entries(alliancesData.alliances || {}).forEach(([id, alliance]) => {
    const enrichedMembers = (alliance.members || []).map((fid) => {
      const f = factions.factions[fid];
      return {
        id: fid,
        name: f ? f.name : "不明な勢力",
        color: f ? f.color : "#666666",
      };
    });

    const leaderFaction = factions.factions[alliance.leaderId];
    enrichedAlliances[id] = {
      ...alliance,
      leaderName: leaderFaction ? leaderFaction.name : "不明",
      membersInfo: enrichedMembers, // 名前付きメンバーリスト
    };
  });

  res.json({ success: true, alliances: enrichedAlliances });
});

// 同盟作成・設定変更 (勢力主のみ)
app.post(
  "/api/alliances/create",
  authenticate,
  requireAuth,
  checkGameStatus,
  (req, res) => {
    const { name, color } = req.body;

    if (!name || name.trim().length === 0 || name.length > 20) {
      return res
        .status(400)
        .json({ error: "名称は1〜20文字で入力してください" });
    }

    if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return res
        .status(400)
        .json({ error: "有効なカラーコードを指定してください" });
    }

    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const alliances = loadJSON(ALLIANCES_PATH, { alliances: {} });
    if (!alliances.alliances) alliances.alliances = {};

    const player = players.players[req.playerId];
    if (!player.factionId) {
      return res.status(400).json({ error: "勢力に所属していません" });
    }

    const faction = factions.factions[player.factionId];
    if (!faction || faction.kingId !== req.playerId) {
      return res
        .status(403)
        .json({ error: "勢力主のみが同盟を作成・編集できます" });
    }

    // 既に同盟に加盟しているかチェック
    if (faction.allianceId) {
      // 既存同盟があり、かつ自分がその盟主であれば「設定変更」として扱う
      const currentAlliance = alliances.alliances[faction.allianceId];
      if (currentAlliance && currentAlliance.leaderId === player.factionId) {
        const oldName = currentAlliance.name;
        const oldColor = currentAlliance.color;

        currentAlliance.name = name.trim();
        currentAlliance.color = color;
        saveJSON(ALLIANCES_PATH, alliances);

        // 名前が変更された場合
        if (oldName !== currentAlliance.name) {
          logActivity("alliance_renamed", {
            allianceId: currentAlliance.id,
            oldName: oldName,
            newName: currentAlliance.name,
            changedBy: player.displayName || req.playerId,
            leaderFactionId: player.factionId,
          });
        } else if (oldColor !== currentAlliance.color) {
          // 色のみ変更の場合
          logActivity("alliance_updated", {
            allianceId: currentAlliance.id,
            message: `同盟「${currentAlliance.name}」のカラーが変更されました`,
            newColor: currentAlliance.color,
            leaderFactionId: player.factionId,
          });
        }

        io.emit("alliance:updated", {
          allianceId: currentAlliance.id,
          alliance: currentAlliance,
        });
        return res.json({
          success: true,
          alliance: currentAlliance,
          message: "同盟設定を変更しました",
        });
      }

      return res.status(400).json({ error: "既に同盟に加盟しています" });
    }

    // 同盟作成の制限期間（クールダウン）は撤廃されました。

    // 同盟作成
    const allianceId = `alliance-${Date.now()}`;
    const now = new Date().toISOString();

    const newAlliance = {
      id: allianceId,
      name: name.trim(),
      color: color,
      leaderId: player.factionId,
      members: [player.factionId],
      memberJoinedAt: { [player.factionId]: now },
      createdAt: now,
    };

    alliances.alliances[allianceId] = newAlliance;
    faction.allianceId = allianceId;

    saveJSON(ALLIANCES_PATH, alliances);
    saveJSON(FACTIONS_PATH, factions);

    // デバッグログ: 同盟保存確認
    console.log(
      `[Alliance] Created alliance: ${allianceId}, saved to disk. Total alliances: ${Object.keys(alliances.alliances).length}`,
    );
    logActivity("alliance_created", {
      allianceId,
      allianceName: newAlliance.name,
      leaderFactionId: player.factionId,
      leaderFactionName: faction.name,
    });

    io.emit("alliance:created", { allianceId, alliance: newAlliance });

    res.json({ success: true, alliance: newAlliance });
  },
);

// 同盟加盟申請
app.post(
  "/api/alliances/:id/request",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const allianceId = req.params.id;

    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const alliances = loadJSON(ALLIANCES_PATH, { alliances: {} });

    const player = players.players[req.playerId];
    if (!player.factionId) {
      return res.status(400).json({ error: "勢力に所属していません" });
    }

    const faction = factions.factions[player.factionId];
    if (!faction || faction.kingId !== req.playerId) {
      return res
        .status(403)
        .json({ error: "勢力主のみが同盟加盟を申請できます" });
    }

    if (faction.allianceId) {
      return res.status(400).json({ error: "既に同盟に加盟しています" });
    }

    const alliance = alliances.alliances[allianceId];
    if (!alliance) {
      return res.status(404).json({ error: "同盟が見つかりません" });
    }

    // 申請リストに追加
    if (!alliance.pendingRequests) {
      alliance.pendingRequests = [];
    }

    if (alliance.pendingRequests.includes(player.factionId)) {
      return res.status(400).json({ error: "既に申請済みです" });
    }

    alliance.pendingRequests.push(player.factionId);
    saveJSON(ALLIANCES_PATH, alliances);

    // 盟主に通知
    // 役職名取得

    // 勢力主のプレイヤー名が必要だが、スコープの複雑さを避けるためここでは省略
    // 申請リストに追加するのみとする

    io.emit("alliance:requestReceived", {
      allianceId,
      requesterFactionId: player.factionId,
      requesterFactionName: faction.name,
    });

    logActivity("alliance_join_request", {
      factionId: player.factionId,
      factionName: faction.name,
      allianceId: allianceId,
      allianceName: alliance.name,
      message: `勢力「${faction.name}」が同盟「${alliance.name}」への加盟を申請しました`,
    });

    res.json({ success: true, message: "加盟申請を送信しました" });
  },
);

// 同盟加盟承認 (盟主のみ)
app.post(
  "/api/alliances/:id/accept",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const allianceId = req.params.id;
    const { factionId: targetFactionId } = req.body;

    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const alliances = loadJSON(ALLIANCES_PATH, { alliances: {} });

    const alliance = alliances.alliances[allianceId];

    if (!alliance) {
      return res.status(404).json({ error: "同盟が見つかりません" });
    }

    const leaderFaction = factions.factions[alliance.leaderId];
    if (!leaderFaction || leaderFaction.kingId !== req.playerId) {
      return res.status(403).json({ error: "盟主の勢力主のみが承認できます" });
    }

    if (
      !alliance.pendingRequests ||
      !alliance.pendingRequests.includes(targetFactionId)
    ) {
      return res.status(400).json({ error: "該当する申請が見つかりません" });
    }

    const targetFaction = factions.factions[targetFactionId];
    if (!targetFaction) {
      return res.status(404).json({ error: "申請元の勢力が見つかりません" });
    }

    if (targetFaction.allianceId && targetFaction.allianceId !== allianceId) {
      return res
        .status(400)
        .json({ error: "対象の勢力は既に他の同盟に加盟しています" });
    }

    // [NEW] 承認直前の戦争チェック
    const wars = loadJSON(WARS_PATH, { wars: {} });
    // 同盟メンバーを取得
    let mySideFactionIds = alliance.members;
    // 相互に戦争状態がないかチェック
    for (const myFid of mySideFactionIds) {
      if (isAtWarWith(myFid, targetFactionId, wars)) {
        return res
          .status(400)
          .json({ error: "その勢力とは戦争中のため、加盟を承認できません" });
      }
    }

    // 申請を承認
    alliance.pendingRequests = alliance.pendingRequests.filter(
      (id) => id !== targetFactionId,
    );
    alliance.members.push(targetFactionId);
    if (!alliance.memberJoinedAt) alliance.memberJoinedAt = {};
    alliance.memberJoinedAt[targetFactionId] = new Date().toISOString();

    targetFaction.allianceId = allianceId;

    saveJSON(ALLIANCES_PATH, alliances);
    saveJSON(FACTIONS_PATH, factions);

    // --- 戦争解除/自動参戦ロジック ---
    // wars is already loaded above
    const newMemberId = targetFactionId;

    // 1. 同盟内勢力との戦争を解除
    if (alliance.members) {
      alliance.members.forEach((memberId) => {
        if (memberId === newMemberId) return;
        const [id1, id2] = [newMemberId, memberId].sort();
        // 既存のすべての戦争を走査して解除
        Object.keys(wars.wars).forEach((wid) => {
          const war = wars.wars[wid];
          if (
            (war.attackerSide.factions.includes(id1) &&
              war.defenderSide.factions.includes(id2)) ||
            (war.attackerSide.factions.includes(id2) &&
              war.defenderSide.factions.includes(id1))
          ) {
            terminateWar(wid, wars, factions, "alliance_formed");
          }
        });
      });
    }

    // 2. 同盟メンバーが防衛側で参加している戦争に自動参戦 (防衛側)
    Object.values(wars.wars).forEach((war) => {
      if (!war.attackerSide || !war.defenderSide) return;

      // 同盟メンバー（自分以外）が防衛側にいるかチェック
      const hasAllyInDefender = alliance.members.some(
        (mid) => mid !== newMemberId && war.defenderSide.factions.includes(mid),
      );

      if (hasAllyInDefender) {
        if (!war.defenderSide.factions.includes(newMemberId)) {
          war.defenderSide.factions.push(newMemberId);
          console.log(
            `[WarAutoJoin] Faction ${newMemberId} joined war ${war.id} as defender (Alliance support)`,
          );
        }
      }
    });

    saveJSON(WARS_PATH, wars);
    // -----------------------
    // リアルタイム更新の通知
    io.emit("war:update", wars.wars);
    io.emit("alliance:updated", {
      allianceId,
      alliance: alliance,
    });

    addFactionNotice(
      targetFactionId,
      "同盟加盟承認",
      `同盟「${alliance.name}」への加盟が承認されました`,
    );

    logActivity("alliance_joined", {
      allianceId,
      allianceName: alliance.name,
      factionId: targetFactionId,
      factionName: targetFaction.name,
      leaderFactionName: leaderFaction ? leaderFaction.name : "不明",
    });

    io.emit("alliance:memberJoined", {
      allianceId,
      factionId: targetFactionId,
      alliance: alliance,
    });

    res.json({ success: true, alliance });
  },
);

// 同盟脱退 (勢力主のみ、制限あり)
app.post(
  "/api/alliances/leave",
  authenticate,
  requireAuth,
  checkGameStatus,
  (req, res) => {
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const alliances = loadJSON(ALLIANCES_PATH, { alliances: {} });

    const player = players.players[req.playerId];
    if (!player.factionId) {
      return res.status(400).json({ error: "勢力に所属していません" });
    }

    const faction = factions.factions[player.factionId];
    if (!faction || faction.kingId !== req.playerId) {
      return res.status(403).json({ error: "勢力主のみが同盟を脱退できます" });
    }

    if (!faction.allianceId) {
      return res.status(400).json({ error: "同盟に加盟していません" });
    }

    const alliance = alliances.alliances[faction.allianceId];
    if (!alliance) {
      faction.allianceId = null;
      saveJSON(FACTIONS_PATH, factions);
      return res.json({
        success: true,
        message: "同盟データが見つかりませんでしたが、加盟状態を解除しました",
      });
    }

    // 24時間制限チェック
    const joinedAt = alliance.memberJoinedAt?.[player.factionId];
    if (joinedAt) {
      const joinedTime = new Date(joinedAt).getTime();
      const now = Date.now();
      const hoursSinceJoin = (now - joinedTime) / (1000 * 60 * 60);
      if (hoursSinceJoin < ALLIANCE_LOCK_HOURS) {
        const remainingHours = Math.ceil(ALLIANCE_LOCK_HOURS - hoursSinceJoin);
        return res.status(400).json({
          error: `加盟から${ALLIANCE_LOCK_HOURS}時間経過するまで脱退できません（残り約${remainingHours}時間）`,
        });
      }
    }

    // 盟主の場合は解散または継承
    if (alliance.leaderId === player.factionId) {
      if (alliance.members.length > 1) {
        // 次の盟主を選出
        const nextLeaderId = alliance.members.find(
          (id) => id !== player.factionId,
        );
        alliance.leaderId = nextLeaderId;
        addFactionNotice(
          nextLeaderId,
          "盟主継承",
          `同盟「${alliance.name}」の盟主に就任しました`,
        );
      } else {
        // 同盟解散
        delete alliances.alliances[faction.allianceId];
        faction.allianceId = null;
        saveJSON(ALLIANCES_PATH, alliances);
        saveJSON(FACTIONS_PATH, factions);

        io.emit("alliance:disbanded", { allianceId: faction.allianceId });

        return res.json({ success: true, message: "同盟が解散されました" });
      }
    }

    // メンバーから削除
    alliance.members = alliance.members.filter((id) => id !== player.factionId);
    if (alliance.memberJoinedAt) {
      delete alliance.memberJoinedAt[player.factionId];
    }

    const allianceId = faction.allianceId;
    faction.allianceId = null;

    // [不具合修正] レガシーな alliances 配列のクリーンアップ
    if (faction.alliances) faction.alliances = [];
    // 他のメンバーの alliances 配列からも自分を削除
    alliance.members.forEach((mid) => {
      const f = factions.factions[mid];
      if (f && f.alliances) {
        f.alliances = f.alliances.filter((id) => id !== player.factionId);
      }
    });

    saveJSON(ALLIANCES_PATH, alliances);
    saveJSON(FACTIONS_PATH, factions);

    // 全メンバー（脱退者含む）に通知して状態を同期
    io.emit("alliance:memberLeft", {
      allianceId,
      factionId: player.factionId,
      alliance: alliance,
    });

    // 双方の勢力情報を更新してブロードキャスト
    io.emit("faction:updated", {
      factionId: player.factionId,
      faction: getEnrichedFaction(player.factionId, factions, players),
    });
    alliance.members.forEach((mid) => {
      io.emit("faction:updated", {
        factionId: mid,
        faction: getEnrichedFaction(mid, factions, players),
      });
    });

    res.json({ success: true, message: "同盟を脱退しました" });
  },
);

// 同盟追放 (盟主のみ、制限あり)
app.post("/api/alliances/:id/kick", authenticate, requireAuth, (req, res) => {
  const allianceId = req.params.id;
  const { factionId: targetFactionId } = req.body;

  const players = loadJSON(PLAYERS_PATH, { players: {} });
  const factions = loadJSON(FACTIONS_PATH, { factions: {} });
  const alliances = loadJSON(ALLIANCES_PATH, { alliances: {} });

  const alliance = alliances.alliances[allianceId];

  if (!alliance) {
    return res.status(404).json({ error: "同盟が見つかりません" });
  }

  const leaderFaction = factions.factions[alliance.leaderId];
  if (!leaderFaction || leaderFaction.kingId !== req.playerId) {
    return res.status(403).json({ error: "盟主の勢力主のみが追放できます" });
  }

  if (targetFactionId === alliance.leaderId) {
    return res.status(400).json({ error: "盟主は追放できません" });
  }

  if (!alliance.members.includes(targetFactionId)) {
    return res.status(400).json({ error: "該当する勢力が見つかりません" });
  }

  // 制限チェック (盟主は自身の勢力を追放できないので、targetの加入時間をチェック)
  const joinedAt = alliance.memberJoinedAt?.[targetFactionId];
  if (joinedAt) {
    const joinedTime = new Date(joinedAt).getTime();
    const now = Date.now();
    const hoursSinceJoin = (now - joinedTime) / (1000 * 60 * 60);
    if (hoursSinceJoin < ALLIANCE_LOCK_HOURS) {
      const remainingHours = Math.ceil(ALLIANCE_LOCK_HOURS - hoursSinceJoin);
      return res.status(400).json({
        error: `加盟から${ALLIANCE_LOCK_HOURS}時間経過するまで追放できません（残り約${remainingHours}時間）`,
      });
    }
  }

  const targetFaction = factions.factions[targetFactionId];
  if (targetFaction) {
    targetFaction.allianceId = null;
    // [不具合修正] レガシーな alliances 配列のクリーンアップ
    if (targetFaction.alliances) targetFaction.alliances = [];

    addFactionNotice(
      targetFactionId,
      "同盟追放",
      `同盟「${alliance.name}」から追放されました`,
    );
  }

  alliance.members = alliance.members.filter((id) => id !== targetFactionId);
  if (alliance.memberJoinedAt) {
    delete alliance.memberJoinedAt[targetFactionId];
  }

  // 他のメンバー（盟主含む）の alliances 配列からも対象を削除
  alliance.members.forEach((mid) => {
    const f = factions.factions[mid];
    if (f && f.alliances) {
      f.alliances = f.alliances.filter((id) => id !== targetFactionId);
    }
  });

  saveJSON(ALLIANCES_PATH, alliances);
  saveJSON(FACTIONS_PATH, factions);

  // 全員に追放を通知
  io.emit("alliance:memberKicked", {
    allianceId,
    factionId: targetFactionId,
    alliance: alliance,
  });

  // 双方の勢力情報を更新してブロードキャスト
  io.emit("faction:updated", {
    factionId: targetFactionId,
    faction: getEnrichedFaction(targetFactionId, factions, players),
  });
  alliance.members.forEach((mid) => {
    io.emit("faction:updated", {
      factionId: mid,
      faction: getEnrichedFaction(mid, factions, players),
    });
  });

  res.json({ success: true, alliance });
});

// 同盟解散 (盟主のみ、24時間制限あり)
app.post(
  "/api/alliances/:id/disband",
  authenticate,
  requireAuth,
  (req, res) => {
    const allianceId = req.params.id;

    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const alliances = loadJSON(ALLIANCES_PATH, { alliances: {} });

    const alliance = alliances.alliances[allianceId];

    if (!alliance) {
      return res.status(404).json({ error: "同盟が見つかりません" });
    }

    const leaderFaction = factions.factions[alliance.leaderId];
    if (!leaderFaction || leaderFaction.kingId !== req.playerId) {
      return res.status(403).json({ error: "盟主の勢力主のみが解散できます" });
    }

    // 制限チェック
    const createdAt = new Date(alliance.createdAt).getTime();
    const now = Date.now();
    const hoursSinceCreate = (now - createdAt) / (1000 * 60 * 60);
    if (hoursSinceCreate < ALLIANCE_LOCK_HOURS) {
      const remainingHours = Math.ceil(ALLIANCE_LOCK_HOURS - hoursSinceCreate);
      return res.status(400).json({
        error: `作成から${ALLIANCE_LOCK_HOURS}時間経過するまで解散できません（残り約${remainingHours}時間）`,
      });
    }

    // 全メンバーの所属を解除
    const memberIds = alliance.members || [];
    memberIds.forEach((mid) => {
      const f = factions.factions[mid];
      if (f) {
        f.allianceId = null;
        addFactionNotice(
          mid,
          "同盟解散",
          `所属していた同盟「${alliance.name}」が解散されました`,
        );
      }
    });

    delete alliances.alliances[allianceId];
    saveJSON(ALLIANCES_PATH, alliances);
    saveJSON(FACTIONS_PATH, factions);

    logActivity("alliance_disbanded", {
      allianceId,
      allianceName: alliance.name,
      leaderFactionId: alliance.leaderId,
    });

    io.emit("alliance:disbanded", { allianceId, members: memberIds });

    res.json({ success: true, message: "同盟を解散しました" });
  },
);

// 同盟内への参戦要請 (Call to Arms - 攻撃中または防衛中の戦争への参加を全メンバーに呼びかける)
app.post(
  "/api/alliances/call-to-arms",
  authenticate,
  requireAuth,
  (req, res) => {
    const { warId } = req.body;
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const alliances = loadJSON(ALLIANCES_PATH, { alliances: {} });
    const wars = loadJSON(WARS_PATH, { wars: {} });

    const player = players.players[req.playerId];
    const factionId = player.factionId;
    const faction = factions.factions[factionId];

    if (!faction || !faction.allianceId) {
      return res.status(400).json({ error: "同盟に加盟していません" });
    }

    const perms = getPlayerPermissions(faction, req.playerId);
    if (!perms.canDiplomacy) {
      return res.status(403).json({ error: "外交権限がありません" });
    }

    const war = wars.wars[warId];
    if (!war) {
      return res.status(404).json({ error: "該当する戦争が見つかりません" });
    }

    // 自分がその戦争の参加者かチェック
    const isAttacker = war.attackerSide.factions.includes(factionId);
    const isDefender = war.defenderSide.factions.includes(factionId);

    if (!isAttacker && !isDefender) {
      return res.status(400).json({ error: "この戦争の当事者ではありません" });
    }

    const alliance = alliances.alliances[faction.allianceId];
    if (!alliance) {
      return res.status(404).json({ error: "同盟が見つかりません" });
    }

    // 同盟メンバー（自分以外）に通知を送る
    const targetFactions = alliance.members.filter((id) => id !== factionId);

    targetFactions.forEach((targetId) => {
      // 既に参戦していないかチェック
      if (
        war.attackerSide.factions.includes(targetId) ||
        war.defenderSide.factions.includes(targetId)
      ) {
        return;
      }

      addFactionNotice(
        targetId,
        "参戦提案",
        `同盟勢力「${faction.name}」から戦争への参戦提案(Call to Arms)が届いています。`,
        "canDiplomacy",
        null,
        {
          type: "propose_war_participation",
          warId: warId,
          requesterId: factionId,
          side: isAttacker ? "attacker" : "defender",
        },
        "participation_proposal",
      );
    });

    res.json({
      success: true,
      message: "同盟メンバーに参戦要請を送信しました",
    });
  },
);

// 個別の参戦提案
app.post(
  "/api/alliances/propose-participation",
  authenticate,
  requireAuth,
  (req, res) => {
    const { warId, targetFactionId } = req.body;
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const wars = loadJSON(WARS_PATH, { wars: {} });

    const player = players.players[req.playerId];
    const factionId = player.factionId;
    const faction = factions.factions[factionId];

    if (!faction) {
      return res.status(400).json({ error: "勢力に所属していません" });
    }

    const perms = getPlayerPermissions(faction, req.playerId);
    if (!perms.canDiplomacy) {
      return res.status(403).json({ error: "外交権限がありません" });
    }

    const war = wars.wars[warId];
    if (!war) {
      return res.status(404).json({ error: "該当する戦争が見つかりません" });
    }

    // 自分の陣営を特定
    const isAttacker = war.attackerSide.factions.includes(factionId);
    const isDefender = war.defenderSide.factions.includes(factionId);

    if (!isAttacker && !isDefender) {
      return res.status(400).json({ error: "この戦争の当事者ではありません" });
    }

    const targetFaction = factions.factions[targetFactionId];
    if (!targetFaction) {
      return res.status(404).json({ error: "対象の勢力が見つかりません" });
    }

    // 同じ同盟かチェック
    if (faction.allianceId !== targetFaction.allianceId) {
      return res
        .status(400)
        .json({ error: "同じ同盟の勢力にのみ提案できます" });
    }

    // 既に参戦していないかチェック
    if (
      war.attackerSide.factions.includes(targetFactionId) ||
      war.defenderSide.factions.includes(targetFactionId)
    ) {
      return res
        .status(400)
        .json({ error: "対象は既にこの戦争に参戦しています" });
    }

    addFactionNotice(
      targetFactionId,
      "参戦提案",
      `勢力「${faction.name}」から戦争への参戦提案が届いています。`,
      "canDiplomacy",
      null,
      {
        type: "propose_war_participation",
        warId: warId,
        requesterId: factionId,
        side: isAttacker ? "attacker" : "defender",
      },
      "participation_proposal",
    );

    res.json({ success: true, message: "参戦提案を送信しました" });
  },
);

// 参戦要請の受諾・拒否
app.post(
  "/api/alliances/accept-participation",
  authenticate,
  requireAuth,
  (req, res) => {
    const { warId, side, accept, requesterId } = req.body; // accept: true/false
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const wars = loadJSON(WARS_PATH, { wars: {} });

    const player = players.players[req.playerId];
    const factionId = player.factionId;
    const faction = factions.factions[factionId];

    if (!faction) {
      return res.status(400).json({ error: "勢力に所属していません" });
    }

    // 勢力主または外交権限が必要
    const perms = getPlayerPermissions(faction, req.playerId);
    if (!perms.canDiplomacy && faction.kingId !== req.playerId) {
      return res.status(403).json({ error: "外交権限がありません" });
    }

    const war = wars.wars[warId];
    if (!war) {
      return res.status(404).json({ error: "該当する戦争が見つかりません" });
    }

    if (accept === false) {
      if (requesterId) {
        addFactionNotice(
          requesterId,
          "参戦拒否",
          `勢力「${faction.name}」が参戦要請を拒否しました。`,
          null,
          null,
          null,
          "warning",
        );
      }
      return res.json({ success: true, message: "参戦要請を拒否しました" });
    }

    // 既に参戦していないかチェック
    if (
      war.attackerSide.factions.includes(factionId) ||
      war.defenderSide.factions.includes(factionId)
    ) {
      return res.status(400).json({ error: "既にこの戦争に参戦しています" });
    }

    // 相手側の主戦国との停戦チェック
    const otherSideLeaderId =
      side === "attacker"
        ? war.defenderSide.leaderId
        : war.attackerSide.leaderId;
    if (isInTruce(factionId, otherSideLeaderId)) {
      return res.status(403).json({
        error: `相手側の主戦国「${factions.factions[otherSideLeaderId]?.name || "不明"}」と停戦中のため、参戦できません`,
      });
    }

    if (side === "attacker") {
      war.attackerSide.factions.push(factionId);
    } else if (side === "defender") {
      war.defenderSide.factions.push(factionId);
    } else {
      return res.status(400).json({ error: "無効な陣営指定です" });
    }

    saveJSON(WARS_PATH, wars);
    io.emit("war:update", wars.wars);

    addFactionNotice(
      factionId,
      "参戦通知",
      `戦争に「${side === "attacker" ? "攻撃側" : "防衛側"}」として参戦しました。`,
    );

    res.json({ success: true, message: "戦争に参戦しました" });
  },
);

// 盟主交代 (盟主のみ)
app.post(
  "/api/alliances/:id/transfer-leader",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const allianceId = req.params.id;
    const { targetFactionId } = req.body;

    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const alliances = loadJSON(ALLIANCES_PATH, { alliances: {} });

    const alliance = alliances.alliances[allianceId];

    if (!alliance) {
      return res.status(404).json({ error: "同盟が見つかりません" });
    }

    const leaderFaction = factions.factions[alliance.leaderId];
    if (!leaderFaction || leaderFaction.kingId !== req.playerId) {
      return res
        .status(403)
        .json({ error: "盟主の勢力主のみが盟主を交代できます" });
    }

    if (!targetFactionId) {
      return res.status(400).json({ error: "新しい盟主の勢力IDが必要です" });
    }

    if (targetFactionId === alliance.leaderId) {
      return res.status(400).json({ error: "指定された勢力は既に盟主です" });
    }

    if (!alliance.members.includes(targetFactionId)) {
      return res
        .status(400)
        .json({ error: "指定された勢力は同盟メンバーではありません" });
    }

    const targetFaction = factions.factions[targetFactionId];
    if (!targetFaction) {
      return res.status(404).json({ error: "指定された勢力が見つかりません" });
    }

    const oldLeaderId = alliance.leaderId;
    alliance.leaderId = targetFactionId;

    saveJSON(ALLIANCES_PATH, alliances);

    addFactionNotice(
      targetFactionId,
      "盟主就任",
      `同盟「${alliance.name}」の盟主に就任しました`,
    );
    addFactionNotice(
      oldLeaderId,
      "盟主交代",
      `同盟「${alliance.name}」の盟主を「${targetFaction.name}」に譲渡しました`,
    );

    logActivity("alliance_leader_transferred", {
      allianceId,
      allianceName: alliance.name,
      oldLeader: oldLeaderId,
      newLeader: targetFactionId,
      transferredBy: req.playerId,
    });

    io.emit("alliance:leaderTransferred", {
      allianceId,
      newLeaderId: targetFactionId,
      alliance: alliance,
    });

    res.json({ success: true, message: "盟主を交代しました", alliance });
  },
);

// 領土の割譲申請 (勢力主・外交権限者のみ)
app.post(
  "/api/tiles/cede/request",
  authenticate,
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const { tiles, targetFactionId } = req.body;
    if (
      !tiles ||
      !Array.isArray(tiles) ||
      tiles.length === 0 ||
      !targetFactionId
    ) {
      return res
        .status(400)
        .json({ error: "有効なマスリストと対象勢力IDが必要です" });
    }

    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const mapData = loadJSON(MAP_STATE_PATH, { tiles: {} });

    const player = players.players[req.playerId];
    const myFactionId = player.factionId;
    const myFaction = factions.factions[myFactionId];

    if (!myFaction)
      return res.status(403).json({ error: "勢力に所属していません" });
    if (myFactionId === targetFactionId)
      return res
        .status(400)
        .json({ error: "自分自身の勢力には割譲できません" });

    // 権限チェック
    const isLeader = myFaction.kingId === req.playerId;
    const hasDiplomaticRights = hasPermission(
      myFaction,
      req.playerId,
      "canDiplomacy",
    );
    if (!isLeader && !hasDiplomaticRights) {
      return res.status(403).json({ error: "外交権限がありません" });
    }

    const targetFaction = factions.factions[targetFactionId];
    if (!targetFaction)
      return res.status(404).json({ error: "対象勢力が見つかりません" });

    // [New Phase 8] 戦争状態チェック
    const wars = loadJSON(WARS_PATH, { wars: {} });
    if (isAtWarWith(myFactionId, targetFactionId, wars)) {
      return res.status(400).json({
        error: "戦争状態にある勢力との間で割譲を行うことはできません",
      });
    }

    // 1. 保有チェック & 全マス割譲禁止チェック
    // [OPTIMIZATION] 全走査を避け、SAB または factions.factions からタイル数を取得
    let myTotalTiles = 0;
    if (sharedMapView) {
      const targetFidIdx = getFactionIdx(myFactionId);
      const size = 500;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const offset = (y * size + x) * TILE_BYTE_SIZE;
          if (sharedMapView.getUint16(offset, true) === targetFidIdx) {
            myTotalTiles++;
          }
        }
      }
    } else {
      myTotalTiles = Object.values(mapData.tiles).filter(
        (t) => (t.faction || t.factionId) === myFactionId,
      ).length;
    }

    if (tiles.length >= myTotalTiles) {
      return res.status(400).json({
        error:
          "全ての領土を割譲することはできません。最低1マスは残す必要があります。",
      });
    }

    for (const t of tiles) {
      const key = `${t.x}_${t.y}`;
      const tile = mapData.tiles[key];
      if (!tile || (tile.faction || tile.factionId) !== myFactionId) {
        return res.status(400).json({
          error: `マス (${t.x}, ${t.y}) はあなたの勢力の領土ではありません`,
        });
      }
    }

    // 2. 隣接・地続きバリデーション
    // 割譲対象マスのうち少なくとも1マスが、対象勢力の領土に隣接している必要がある
    const isAdjacentToTarget = tiles.some((t) => {
      const directions = [
        [0, 1],
        [0, -1],
        [1, 0],
        [0, -1],
        [1, 0],
        [-1, 0],
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ];
      return directions.some(([dx, dy]) => {
        const nx = t.x + dx;
        const ny = t.y + dy;
        if (nx < 0 || nx >= 500 || ny < 0 || ny >= 500) return false;

        if (sharedMapView) {
          const offset = (ny * 500 + nx) * TILE_BYTE_SIZE;
          const fidIdx = sharedMapView.getUint16(offset, true);
          return fidIdx === getFactionIdx(targetFactionId);
        } else {
          const nKey = `${nx}_${ny}`;
          const nTile = mapData.tiles[nKey];
          return (
            nTile && (nTile.faction || nTile.factionId) === targetFactionId
          );
        }
      });
    });

    if (!isAdjacentToTarget) {
      return res.status(400).json({
        error: "割譲するマスは対象勢力の領土に隣接している必要があります",
      });
    }

    // 申請ID作成
    const requestId = crypto.randomUUID();
    const cedeRequests = loadJSON(
      SYSTEM_SETTINGS_PATH + "_cede_requests.json",
      { requests: {} },
    );

    cedeRequests.requests[requestId] = {
      id: requestId,
      fromFactionId: myFactionId,
      toFactionId: targetFactionId,
      tiles: tiles,
      requestedBy: req.playerId,
      requestedAt: new Date().toISOString(),
    };
    saveJSON(SYSTEM_SETTINGS_PATH + "_cede_requests.json", cedeRequests);

    // マップ画像生成
    // const cessionMapData = loadJSON(MAP_STATE_PATH, { tiles: {} }); // 削除済み (REMOVED): Worker内で読み込む
    const imageUrl = await generateCessionMapImage(
      null, // cessionMapData.tiles,
      factions.factions,
      tiles,
    );

    // 対象勢力に通知
    addFactionNotice(
      targetFactionId,
      "領土割譲の提案",
      `勢力「${myFaction.name}」から ${tiles.length} マスの領土割譲が提案されました。\n\n📍 割譲対象マップ: ${imageUrl}`,
      "canDiplomacy",
      null,
      {
        actions: [
          {
            label: "承認する",
            action: "cede:accept",
            style: "primary",
            requestId: requestId,
          },
          {
            label: "拒否する",
            action: "cede:reject",
            style: "danger",
            requestId: requestId,
          },
        ],
      },
      "info",
    );

    res.json({
      success: true,
      message: "割譲申請を送信しました。相手の承認を待っています。",
    });
  },
);

// 領土割譲の承認/拒否
app.post(
  "/api/tiles/cede/respond",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    // 非同期処理を追加 (async added)
    const { requestId, accept } = req.body;
    if (!requestId)
      return res.status(400).json({ error: "リクエストIDが必要です" });

    const cedeRequests = loadJSON(
      SYSTEM_SETTINGS_PATH + "_cede_requests.json",
      { requests: {} },
    );
    const request = cedeRequests.requests[requestId];
    if (!request)
      return res
        .status(404)
        .json({ error: "申請が見つからないか、既に処理されています" });

    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const player = players.players[req.playerId];

    const myFactionId = player.factionId;
    const myFaction = factions.factions[myFactionId];

    if (myFactionId !== request.toFactionId) {
      return res
        .status(403)
        .json({ error: "あなたはこの申請の対象者ではありません" });
    }

    // 権限チェック
    const isLeader = myFaction.kingId === req.playerId;
    const hasDiplomaticRights = hasPermission(
      myFaction,
      req.playerId,
      "canDiplomacy",
    );
    if (!isLeader && !hasDiplomaticRights) {
      return res.status(403).json({ error: "外交権限がありません" });
    }

    if (accept) {
      // 承認処理: Workerにて実行
      const fromFactionId = request.fromFactionId;

      try {
        const workerResult = await runWorkerTask("PROCESS_CESSION", {
          request: request,
          fromFactionId: fromFactionId,
          toFactionId: myFactionId,
          filePaths: {
            mapState: MAP_STATE_PATH,
            factions: FACTIONS_PATH,
            // players: PLAYERS_PATH // ここでは厳密には不要 (not strictly needed)
          },
        });

        if (!workerResult.success) {
          console.error(
            "Worker failed to process cession:",
            workerResult.error,
          );
          return res
            .status(500)
            .json({ error: "処理中にエラーが発生しました" });
        }

        const { updatedTiles, pointUpdates, fromFactionName, toFactionName } =
          workerResult.results;

        // メインスレッドでのデータ更新と保存
        // マップデータの更新 (差分マージだが、メモリ上のmapStateを更新する必要があるためロード)
        // [OPTIMIZATION] 全ロードせずとも、updatedTilesだけio.emitすればクライアントは更新されるが
        // サーバー再起動時のために保存は必須。
        const mapData = loadJSON(MAP_STATE_PATH, { tiles: {} });
        Object.entries(updatedTiles).forEach(([key, tile]) => {
          mapData.tiles[key] = tile;
        });
        saveJSON(MAP_STATE_PATH, mapData);

        // ポイントと勢力データの更新
        Object.entries(pointUpdates).forEach(([fid, points]) => {
          if (factions.factions[fid]) {
            factions.factions[fid].territoryPoints = points;
            factions.factions[fid].totalPoints =
              (points || 0) + (factions.factions[fid].bonusPoints || 0);
          }
        });
        saveJSON(FACTIONS_PATH, factions);

        // ログと通知
        addLog(
          "diplomacy",
          `🤝 領土割譲: 勢力「${fromFactionName || "(不明)"}」から勢力「${toFactionName || "(不明)"}」へ ${request.tiles.length} マスの領土が譲渡されました。`,
          null,
        );

        addFactionNotice(
          fromFactionId,
          "割譲成立",
          `提案していた ${request.tiles.length} マスの割譲が、勢力「${myFaction.name}」によって承認されました。`,
          null,
          null,
          null,
          "success",
        );

        // クライアントへマップ更新通知
        io.emit("tile:update", updatedTiles);

        // 勢力情報更新(ポイント変化)の通知
        [fromFactionId, myFactionId].forEach((fid) => {
          io.to(`faction:${fid}`).emit("faction:updated", {
            factionId: fid,
            faction: getEnrichedFaction(fid, factions, players),
          });
        });
      } catch (e) {
        console.error("Cession Process Error:", e);
        return res.status(500).json({ error: "内部エラーが発生しました" });
      }
    } else {
      // 拒否通知
      addFactionNotice(
        request.fromFactionId,
        "割譲拒否",
        `提案していた割譲が、勢力「${myFaction.name}」によって拒否されました。`,
        null,
        null,
        null,
        "warning",
      );
    }

    // リクエスト削除
    delete cedeRequests.requests[requestId];
    saveJSON(SYSTEM_SETTINGS_PATH + "_cede_requests.json", cedeRequests);

    res.json({
      success: accept,
      message: accept ? "割譲を承認しました" : "割譲を拒否しました",
    });
  },
);

// 同盟設定変更 (盟主のみ)
app.post(
  "/api/alliances/:id/settings",
  authenticate,
  requireAuth,
  (req, res) => {
    const allianceId = req.params.id;
    const { name, color } = req.body;

    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const alliances = loadJSON(ALLIANCES_PATH, { alliances: {} });

    const alliance = alliances.alliances[allianceId];

    if (!alliance) {
      return res.status(404).json({ error: "同盟が見つかりません" });
    }

    const leaderFaction = factions.factions[alliance.leaderId];
    if (!leaderFaction || leaderFaction.kingId !== req.playerId) {
      return res
        .status(403)
        .json({ error: "盟主の勢力主のみが設定を変更できます" });
    }

    let changed = false;
    if (name && name.trim().length > 0 && name.length <= 20) {
      alliance.name = name.trim();
      changed = true;
    }
    if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
      if (color.toLowerCase() === "#ffffff") {
        return res
          .status(400)
          .json({ error: "白色(#ffffff)は同盟色として使用できません" });
      }
      alliance.color = color;
      changed = true;
    }

    if (!changed) {
      return res.status(400).json({ error: "変更する値がありません" });
    }

    saveJSON(ALLIANCES_PATH, alliances);

    io.emit("alliance:updated", { allianceId, alliance });

    res.json({ success: true, alliance });
  },
);

// ===== Season 2: 停戦 API =====

// 停戦一覧取得
app.get("/api/truces", (req, res) => {
  const truces = loadJSON(TRUCES_PATH, { truces: {} });

  // 期限切れの停戦を削除
  const now = Date.now();
  let changed = false;
  Object.entries(truces.truces).forEach(([key, truce]) => {
    if (new Date(truce.expiresAt).getTime() < now) {
      delete truces.truces[key];
      changed = true;
    }
  });
  if (changed) {
    saveJSON(TRUCES_PATH, truces);
    io.emit("truce:update", truces.truces);
  }

  const factions = loadJSON(FACTIONS_PATH, { factions: {} });
  const enrichedTruces = {};

  Object.entries(truces.truces).forEach(([key, truce]) => {
    const enrichedTruce = { ...truce };
    enrichedTruce.factionNames = truce.factions.map((fid) => {
      const f = factions.factions[fid];
      return f
        ? f.name
        : truce.factionNames
          ? truce.factionNames[truce.factions.indexOf(fid)]
          : "不明な勢力";
    });
    enrichedTruces[key] = enrichedTruce;
  });

  res.json({ success: true, truces: enrichedTruces });
});

// [NEW] 戦争一覧取得
app.get("/api/wars", (req, res) => {
  const wars = loadJSON(WARS_PATH, { wars: {} });
  res.json({ success: true, wars: wars.wars || {} });
});

// 毎分メンテナンス
setInterval(async () => {
  // 停戦期限切れチェック (Worker オフロード)
  checkTruceExpiration();
}, 60 * 1000);

// [NEW] 停戦期限切れチェック (Worker オフロード)
async function checkTruceExpiration() {
  try {
    const trucesData = loadJSON(TRUCES_PATH, { truces: {} });
    const result = await runWorkerTask("CHECK_TRUCE_PARTIAL", {
      truces: trucesData.truces,
      now: Date.now(),
    });

    if (result.success && result.results.expiredKeys.length > 0) {
      await updateJSON(TRUCES_PATH, (data) => {
        result.results.expiredKeys.forEach((key) => {
          delete data.truces[key];
        });
        return data;
      });
      io.emit("truce:update", trucesData.truces);
      console.log(
        `[TruceExpired] Removed ${result.results.expiredKeys.length} truces.`,
      );
    }
  } catch (e) {
    console.error("[TruceCheck] Failed:", e);
  }
}

// 中核マスの維持期限判定 (毎分実行)

// 1分ごとにチェック (Existing call)
// 1分ごとにチェック (Existing call) - 廃止: runScheduledTasksに統合
// setInterval(() => {
//   checkCoreExpiration();
// }, 60 * 1000);

// 停戦要請
app.post(
  "/api/truces/request",
  authenticate,
  requireAuth,
  checkGameStatus,
  (req, res) => {
    const { targetFactionId, expiresAt } = req.body;

    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const truces = loadJSON(TRUCES_PATH, { truces: {} });

    const player = players.players[req.playerId];
    if (!player.factionId) {
      return res.status(400).json({ error: "勢力に所属していません" });
    }

    const myFaction = factions.factions[player.factionId];
    if (!myFaction || myFaction.kingId !== req.playerId) {
      return res.status(403).json({ error: "勢力主のみが停戦を要請できます" });
    }

    if (player.factionId === targetFactionId) {
      return res.status(400).json({ error: "自勢力とは停戦できません" });
    }

    const targetFaction = factions.factions[targetFactionId];
    if (!targetFaction) {
      return res.status(404).json({ error: "対象の勢力が見つかりません" });
    }

    // 既に停戦中かチェック
    const truceKey = [player.factionId, targetFactionId].sort().join("_");
    if (truces.truces[truceKey]) {
      return res.status(400).json({ error: "既に停戦中です" });
    }

    // [NEW] 拒否クールダウンチェック (停戦)
    if (
      myFaction.rejectedCooldowns &&
      myFaction.rejectedCooldowns.truce &&
      myFaction.rejectedCooldowns.truce[targetFactionId]
    ) {
      const cooldown = new Date(
        myFaction.rejectedCooldowns.truce[targetFactionId],
      ).getTime();
      const now = Date.now();
      if (cooldown > now) {
        const remainingMin = Math.ceil((cooldown - now) / 60000);
        return res.status(400).json({
          error: `以前拒否されたため、あと ${remainingMin} 分間は申請できません`,
        });
      } else {
        // 時間切れなら削除
        delete myFaction.rejectedCooldowns.truce[targetFactionId];
      }
    }

    // 停戦要請リストに追加
    if (!myFaction.truceRequests) myFaction.truceRequests = [];
    if (!targetFaction.truceRequestsReceived)
      targetFaction.truceRequestsReceived = [];

    // 配列であることを保証
    if (!Array.isArray(myFaction.truceRequests)) myFaction.truceRequests = [];
    if (!Array.isArray(targetFaction.truceRequestsReceived))
      targetFaction.truceRequestsReceived = [];

    // [MOD] 既に申請済みでもエラーにせず、再通知を可能にする (配列への重複追加は防ぐ)
    // Object形式 { id, expiresAt } で保存
    // 既存のエントリがあれば更新、なければ追加
    const updateRequestList = (list, id, expiresAt) => {
      const idx = list.findIndex((entry) =>
        typeof entry === "string" ? entry === id : entry.id === id,
      );
      if (idx >= 0) {
        // 更新 (文字列の場合はオブジェクトに変換)
        list[idx] = { id, expiresAt };
      } else {
        // 追加
        list.push({ id, expiresAt });
      }
    };

    updateRequestList(myFaction.truceRequests, targetFactionId, expiresAt);
    updateRequestList(
      targetFaction.truceRequestsReceived,
      player.factionId,
      expiresAt,
    );

    saveJSON(FACTIONS_PATH, factions);

    addFactionNotice(
      targetFactionId,
      "停戦要請",
      `勢力「${myFaction.name}」から停戦要請が届きました`,
      null,
      { requesterFactionId: player.factionId },
      {
        actions: [
          { label: "承認する", action: "truce:accept", style: "primary" },
          { label: "拒否する", action: "truce:reject", style: "danger" },
        ],
      },
    );

    io.emit("truce:request", {
      requesterFactionId: player.factionId,
      requesterFactionName: myFaction.name,
      targetFactionId,
    });

    res.json({ success: true, message: "停戦要請を送信しました" });
  },
);

// 停戦承諾
app.post(
  "/api/truces/accept",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const { requesterFactionId } = req.body;

    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const truces = loadJSON(TRUCES_PATH, { truces: {} });

    const player = players.players[req.playerId];
    if (!player.factionId) {
      return res.status(400).json({ error: "勢力に所属していません" });
    }

    const myFaction = factions.factions[player.factionId];
    if (
      !myFaction ||
      (myFaction.kingId !== req.playerId &&
        !hasPermission(myFaction, req.playerId, "canDiplomacy"))
    ) {
      return res.status(403).json({ error: "外交権限がありません" });
    }

    if (!myFaction.truceRequestsReceived) myFaction.truceRequestsReceived = [];

    // 強制的に文字列比較または存在チェックを強化
    const requestEntry =
      Array.isArray(myFaction.truceRequestsReceived) &&
      myFaction.truceRequestsReceived.find((entry) => {
        const id = typeof entry === "string" ? entry : entry.id;
        return String(id) === String(requesterFactionId);
      });

    if (!requestEntry) {
      return res
        .status(400)
        .json({ error: "該当する停戦要請が見つかりません" });
    }

    // [NEW] 期限切れチェック (5分以内は期限切れ扱い)
    if (
      requestEntry &&
      typeof requestEntry === "object" &&
      requestEntry.expiresAt
    ) {
      const expiryTime = new Date(requestEntry.expiresAt).getTime();
      const threshold = expiryTime - 5 * 60 * 1000;
      if (Date.now() > threshold) {
        return res.status(400).json({ error: "期限切れです" });
      }
    }

    const requesterFaction = factions.factions[requesterFactionId];
    if (!requesterFaction) {
      return res.status(404).json({ error: "要請元の勢力が見つかりません" });
    }

    // 停戦を締結
    const truceKey = [player.factionId, requesterFactionId].sort().join("_");
    // 申請された期限を使用 (無ければデフォルト)
    let expiresAt = null;
    if (
      requestEntry &&
      typeof requestEntry === "object" &&
      requestEntry.expiresAt
    ) {
      expiresAt = requestEntry.expiresAt;
    } else {
      expiresAt = new Date(
        Date.now() + TRUCE_DURATION_HOURS * 60 * 60 * 1000,
      ).toISOString();
    }

    truces.truces[truceKey] = {
      factions: [player.factionId, requesterFactionId],
      factionNames: [myFaction.name, requesterFaction.name],
      startedAt: new Date().toISOString(),
      expiresAt,
    };

    // 要請リストをクリア
    const filterRequests = (list, removeId) => {
      if (!list) return [];
      return list.filter((entry) => {
        const id = typeof entry === "string" ? entry : entry.id;
        return id !== removeId;
      });
    };

    myFaction.truceRequestsReceived = filterRequests(
      myFaction.truceRequestsReceived,
      requesterFactionId,
    );
    requesterFaction.truceRequests = filterRequests(
      requesterFaction.truceRequests,
      player.factionId,
    );

    saveJSON(TRUCES_PATH, truces);
    io.emit("truce:update", truces.truces);
    saveJSON(FACTIONS_PATH, factions);

    // --- 戦争連動ロジック (主戦国判定・共戦国離脱) ---
    const wars = loadJSON(WARS_PATH, { wars: {} });
    let warUpdated = false;

    // 既存戦争を走査
    Object.keys(wars.wars).forEach((wid) => {
      const war = wars.wars[wid];
      if (!war.attackerSide || !war.defenderSide) return;

      const myId = player.factionId;
      const partnerId = requesterFactionId;

      // 役割判定関数 (primary | co | null)
      const getRole = (fid, side) => {
        if (side.leaderId === fid) return "primary";
        if (side.factions.includes(fid)) return "co";
        return null; // 不参加
      };

      // 自分の役割
      const myRoleAtk = getRole(myId, war.attackerSide);
      const myRoleDef = getRole(myId, war.defenderSide);
      const mySide = myRoleAtk ? "attacker" : myRoleDef ? "defender" : null;
      const myRole = myRoleAtk || myRoleDef;

      // 相手の役割
      const partnerRoleAtk = getRole(partnerId, war.attackerSide);
      const partnerRoleDef = getRole(partnerId, war.defenderSide);
      const partnerSide = partnerRoleAtk
        ? "attacker"
        : partnerRoleDef
          ? "defender"
          : null;
      const partnerRole = partnerRoleAtk || partnerRoleDef;

      // どちらかが不参加、または同じサイドなら何もしない (敵対関係のみ処理)
      if (!mySide || !partnerSide || mySide === partnerSide) return;

      // Case 1: 両者が主戦国 -> 戦争終結
      if (myRole === "primary" && partnerRole === "primary") {
        terminateWar(wid, wars, factions, "truce");
        // terminateWar は wars オブジェクトを変更する想定
        warUpdated = true;
      }
      // Case 2/3: どちらかが共戦国 -> 共戦国は離脱 (Case 2/3: Either is a co-belligerent -> co-belligerent leaves)
      else {
        // 自分が共戦国なら離脱
        if (myRole === "co") {
          const sideObj =
            mySide === "attacker" ? war.attackerSide : war.defenderSide;
          sideObj.factions = sideObj.factions.filter((id) => id !== myId);
          warUpdated = true;
          addFactionNotice(
            myId,
            "戦争離脱",
            `停戦締結により、戦争から離脱しました。`,
          );
        }
        // 相手が共戦国なら離脱
        if (partnerRole === "co") {
          const sideObj =
            partnerSide === "attacker" ? war.attackerSide : war.defenderSide;
          sideObj.factions = sideObj.factions.filter((id) => id !== partnerId);
          warUpdated = true;
          addFactionNotice(
            partnerId,
            "戦争離脱",
            `停戦締結により、戦争から離脱しました。`,
          );
        }
      }
    });

    if (warUpdated) {
      saveJSON(WARS_PATH, wars);
      io.emit("war:update", wars.wars);
    }
    // -----------------------

    addFactionNotice(
      requesterFactionId,
      "停戦締結",
      `勢力「${myFaction.name}」との停戦が締結されました`,
    );
    addFactionNotice(
      player.factionId,
      "停戦締結",
      `勢力「${requesterFaction.name}」との停戦が締結されました`,
    );

    logActivity("truce_established", {
      factionA: player.factionId,
      factionAName: myFaction.name,
      factionB: requesterFactionId,
      factionBName: requesterFaction.name,
      expiresAt,
    });

    io.emit("truce:established", {
      truceKey,
      truce: truces.truces[truceKey],
    });

    res.json({ success: true, truce: truces.truces[truceKey] });
  },
);

// 停戦拒否
app.post(
  "/api/truces/reject",
  authenticate,
  requireAuth,
  checkGameStatus,
  (req, res) => {
    const { requesterFactionId } = req.body;

    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const requesterFaction = factions.factions[requesterFactionId];

    const player = players.players[req.playerId];
    if (!player.factionId) {
      return res.status(400).json({ error: "勢力に所属していません" });
    }

    const myFaction = factions.factions[player.factionId];
    if (
      !myFaction ||
      (myFaction.kingId !== req.playerId &&
        !hasPermission(myFaction, req.playerId, "canDiplomacy"))
    ) {
      return res.status(403).json({ error: "外交権限がありません" });
    }

    if (!myFaction.truceRequestsReceived) {
      return res.status(400).json({ error: "停戦要請がありません" });
    }

    // 拒否通知
    addFactionNotice(
      requesterFactionId,
      "停戦拒否",
      `勢力「${myFaction.name}」が停戦要請を拒否しました。`,
      null,
      null,
      null,
      "warning",
    );

    // [NEW] 期限切れチェック (5分以内は期限切れ扱い)
    const requestEntry =
      Array.isArray(myFaction.truceRequestsReceived) &&
      myFaction.truceRequestsReceived.find((entry) => {
        const id = typeof entry === "string" ? entry : entry.id;
        return String(id) === String(requesterFactionId);
      });

    if (
      requestEntry &&
      typeof requestEntry === "object" &&
      requestEntry.expiresAt
    ) {
      const expiryTime = new Date(requestEntry.expiresAt).getTime();
      const threshold = expiryTime - 5 * 60 * 1000;
      if (Date.now() > threshold) {
        return res.status(400).json({ error: "期限切れです" });
      }
    }

    myFaction.truceRequestsReceived = myFaction.truceRequestsReceived.filter(
      (entry) => {
        const id = typeof entry === "string" ? entry : entry.id;
        return id !== requesterFactionId;
      },
    );

    if (requesterFaction && requesterFaction.truceRequests) {
      requesterFaction.truceRequests = requesterFaction.truceRequests.filter(
        (entry) => {
          const id = typeof entry === "string" ? entry : entry.id;
          return id !== player.factionId;
        },
      );
      // [NEW] 拒否クールダウン設定 (1時間)
      if (!requesterFaction.rejectedCooldowns)
        requesterFaction.rejectedCooldowns = {};
      if (!requesterFaction.rejectedCooldowns.truce)
        requesterFaction.rejectedCooldowns.truce = {};

      const cooldownUntil = Date.now() + 60 * 60 * 1000;
      requesterFaction.rejectedCooldowns.truce[player.factionId] = new Date(
        cooldownUntil,
      ).toISOString();
    }

    saveJSON(FACTIONS_PATH, factions);

    io.emit("truce:rejected", {
      requesterFactionId,
      targetFactionId: player.factionId,
      targetFactionName: myFaction.name,
    });

    res.json({ success: true, message: "停戦要請を拒否しました" });
  },
);

// 停戦中かチェックするヘルパー関数
function isInTruce(factionIdA, factionIdB) {
  const truces = loadJSON(TRUCES_PATH, { truces: {} });
  const truceKey = [factionIdA, factionIdB].sort().join("_");
  const truce = truces.truces[truceKey];
  if (!truce) return false;
  return new Date(truce.expiresAt).getTime() > Date.now();
}

// ===== Season 2: 役職・権限管理 =====

// デフォルト権限
const DEFAULT_PERMISSIONS = {
  canPaint: true,
  canErase: false, // マス消し
  canManageMembers: false, // メンバー管理 (招待/追放/役職/承認)
  canManageSettings: false, // 基本設定 (名前/カラー)
  canDiplomacy: false, // 外交 (同盟/停戦/整合)
  canUseSharedAp: false, // 共有AP利用 (自動消費)
  canDeclareWar: false, // 開戦権限
  canManageNamedTiles: false, // ネームドマス管理 (作成/破壊)
};

// 勢力主権限（全て許可）
const KING_PERMISSIONS = {
  canPaint: true,
  canErase: true,
  canManageMembers: true,
  canManageSettings: true,
  canDiplomacy: true,
  canUseSharedAp: true,
  canDeclareWar: true,
  canManageNamedTiles: true,
};

// プレイヤーの権限を取得
function getPlayerPermissions(faction, playerId) {
  if (!faction) return DEFAULT_PERMISSIONS;

  // 勢力主は全権限
  if (faction.kingId === playerId) {
    return KING_PERMISSIONS;
  }

  // ロールから権限を取得
  if (faction.roles && faction.memberRoles && faction.memberRoles[playerId]) {
    const roleId = faction.memberRoles[playerId];
    const role = faction.roles.find((r) => r.id === roleId);
    if (role && role.permissions) {
      return { ...DEFAULT_PERMISSIONS, ...role.permissions };
    }
  }

  return DEFAULT_PERMISSIONS;
}

// 戦争を終結させる共通ヘルパー
function terminateWar(warId, warsData, factionsData, reason = "peace") {
  const war = warsData.wars[warId];
  if (!war) return;

  const attackerLeader = factionsData.factions[war.attackerSide.leaderId];
  const defenderLeader = factionsData.factions[war.defenderSide.leaderId];
  const attackerName = attackerLeader ? attackerLeader.name : "不明な勢力";
  const defenderName = defenderLeader ? defenderLeader.name : "不明な勢力";

  // 全参加者に通知
  const allParticipants = [
    ...war.attackerSide.factions,
    ...war.defenderSide.factions,
  ];
  allParticipants.forEach((fid) => {
    addFactionNotice(
      fid,
      "戦争終結",
      `戦争が終結しました。(${attackerName} vs ${defenderName})`,
      "war_ended",
    );
  });

  // アクティビティログ
  logActivity("war_ended", {
    warId: warId,
    message: `🤝${attackerName}・${defenderName}戦争が終結`,
    reason: reason,
    attackerName: attackerName,
    defenderName: defenderName,
  });

  // データ削除とブロードキャスト
  delete warsData.wars[warId];
  io.emit("war:ended", { warId: warId, reason: reason });
  io.emit("war:update", warsData.wars);
}

// 権限チェックヘルパー
function hasPermission(faction, playerId, permissionKey) {
  const permissions = getPlayerPermissions(faction, playerId);

  // 権限統合 (エイリアス)
  if (permissionKey === "canKick" || permissionKey === "canInvite") {
    return permissions.canManageMembers === true;
  }
  if (permissionKey === "canManageNamedTiles" || permissionKey === "canErase") {
    return permissions.canManageSettings === true;
  }

  return permissions[permissionKey] === true;
}

// ===== 戦争システム V2 ヘルパー (War System V2 Helper) =====
function handleWarUpdate(
  attackerFactionId,
  defenderFactionId,
  tilesTakenCount = 1,
) {
  const warsData = loadJSON(WARS_PATH, { wars: {} });
  const alliancesData = loadJSON(ALLIANCES_PATH, { alliances: {} });
  const factionsData = loadJSON(FACTIONS_PATH, { factions: {} });

  const attackerFaction = factionsData.factions[attackerFactionId];
  const defenderFaction = factionsData.factions[defenderFactionId];

  if (!attackerFaction || !defenderFaction) return;

  // --- [NEW] 同盟グループチェック (Alliance Group Check) ---
  // 同盟グループ内での戦争発生を防止
  if (
    attackerFaction.allianceId &&
    defenderFaction.allianceId &&
    attackerFaction.allianceId === defenderFaction.allianceId
  ) {
    console.log(
      `[WarSystem] Blocked war update between alliance members: ${attackerFaction.name} (${attackerFactionId}) vs ${defenderFaction.name} (${defenderFactionId})`,
    );
    return;
  }

  // 1. これら勢力間で戦争が既に存在するかチェック
  let existingWarId = null;
  let isAttackerSide = false; // 現在の攻撃者が戦争の攻撃側にいるかどうか？

  for (const [wid, war] of Object.entries(warsData.wars)) {
    // レガシーチェック除去（必要に応じて行うが、UUIDを使うなら移行は厳密には不要と仮定）
    if (!war.attackerSide || !war.defenderSide) continue;

    const attackers = war.attackerSide.factions || [];
    const defenders = war.defenderSide.factions || [];

    if (
      attackers.includes(attackerFactionId) &&
      defenders.includes(defenderFactionId)
    ) {
      existingWarId = wid;
      isAttackerSide = true;
      break;
    } else if (
      defenders.includes(attackerFactionId) &&
      attackers.includes(defenderFactionId)
    ) {
      existingWarId = wid;
      isAttackerSide = false;
      break;
    }
  }

  if (existingWarId) {
    // 既存の戦争を更新
    const war = warsData.wars[existingWarId];
    war.lastActive = Date.now();
    if (isAttackerSide) {
      war.attackerSide.tilesTaken += tilesTakenCount;
      war.defenderSide.tilesLost += tilesTakenCount;
    } else {
      // 現在の「攻撃勢力」は実際にはこの戦争の防衛側（反撃）
      war.defenderSide.tilesTaken += tilesTakenCount;
      war.attackerSide.tilesLost += tilesTakenCount;
    }
    saveJSON(WARS_PATH, warsData);
    io.emit("war:update", warsData.wars);
  } else {
    // 新しい戦争を開始
    const newWarId = crypto.randomUUID();

    // 自動参加ロジック: 防衛側の同盟
    const defenderAllies = [defenderFactionId];
    if (defenderFaction.allianceId) {
      const alliance = (alliancesData.alliances || {})[
        defenderFaction.allianceId
      ];
      if (alliance) {
        defenderAllies.push(
          ...alliance.members.filter((mid) => mid !== defenderFactionId),
        );
      }
    }
    // 念のため重複を排除
    const uniqueDefenders = [...new Set(defenderAllies)];

    const newWar = {
      id: newWarId,
      attackerSide: {
        leaderId: attackerFactionId, // [主戦国 (Core Belligerent)]
        factions: [attackerFactionId],
        tilesTaken: tilesTakenCount,
        tilesLost: 0,
      },
      defenderSide: {
        leaderId: defenderFactionId, // [主戦国 (Core Belligerent)]
        factions: uniqueDefenders,
        tilesTaken: 0,
        tilesLost: tilesTakenCount,
      },
      startTime: Date.now(),
      lastActive: Date.now(),
    };

    warsData.wars[newWarId] = newWar;
    saveJSON(WARS_PATH, warsData);
    io.emit("war:update", warsData.wars);

    // 通知
    io.emit("war:started", newWar);

    // [New] 開戦アクティビティログの記録 (復元)
    const getName = (fid) => factionsData.factions[fid]?.name || "不明な勢力";
    const attackerName = getName(attackerFactionId);
    const defenderName = getName(defenderFactionId);

    logActivity("war_started", {
      attackerFactionId,
      defenderFactionId,
      attackerName,
      defenderName,
      message: `${attackerName} が ${defenderName} への侵攻を開始しました！`,
    });

    // [New] 全体への通知 (ポップアップ/トースト) (復元)
    io.emit("notification:toast", {
      title: "開戦通知",
      message: `${attackerName} が ${defenderName} に侵攻を開始しました！`,
      type: "error",
    });

    // 通知 (個別)
    // 攻撃者へ
    addFactionNotice(
      attackerFactionId,
      "開戦",
      `勢力「${getName(defenderFactionId)}」との戦争が開始されました。`,
    );
    // 防衛者へ
    uniqueDefenders.forEach((fid) => {
      addFactionNotice(
        fid,
        "宣戦布告",
        `勢力「${getName(attackerFactionId)}」から攻撃を受けました。戦争状態に突入します。`,
        "canDiplomacy",
        null,
        null, // No actions needed for now
        "war_declared",
      );
    });
  }
}

// [主戦国] 勢力消滅ハンドラ ([Core Belligerent] Faction Destruction Handler)
// 勢力が消滅する直前に呼び出し、戦争における役割を引き継ぐか戦争を終わらせる
function handleFactionDestructionInWar(factionId) {
  const warsData = loadJSON(WARS_PATH, { wars: {} });
  const factionsData = loadJSON(FACTIONS_PATH, { factions: {} });
  let updated = false;

  for (const [wid, war] of Object.entries(warsData.wars)) {
    if (!war.attackerSide || !war.defenderSide) continue;

    const sides = [
      {
        side: war.attackerSide,
        type: "攻撃側",
        otherSide: war.defenderSide,
      },
      {
        side: war.defenderSide,
        type: "防衛側",
        otherSide: war.attackerSide,
      },
    ];

    let warEnded = false;
    for (const item of sides) {
      const { side, type, otherSide } = item;
      if (side.factions.includes(factionId)) {
        // Remove from list
        side.factions = side.factions.filter((id) => id !== factionId);
        updated = true;

        // If Leader
        if (side.leaderId === factionId) {
          if (side.factions.length > 0) {
            // Inherit (Point-based)
            let bestFid = side.factions[0];
            let maxPoints = -1;

            side.factions.forEach((mFid) => {
              const f = factionsData.factions[mFid];
              if (f && (f.totalPoints || 0) > maxPoints) {
                maxPoints = f.totalPoints || 0;
                bestFid = mFid;
              }
            });

            side.leaderId = bestFid;
            const newLeaderName =
              factionsData.factions[bestFid]?.name || "不明";

            // Notify
            side.factions.forEach((fid) => {
              addFactionNotice(
                fid,
                "主戦国交代",
                `${type}主戦国が滅亡したため、${newLeaderName} が新たな主戦国となりました。`,
              );
            });
            otherSide.factions.forEach((fid) => {
              addFactionNotice(
                fid,
                "戦況変化",
                `敵軍(${type})の主戦国が交代しました。新主戦国: ${newLeaderName}`,
              );
            });
          } else {
            // End War (This side wiped out)
            const reason =
              type === "攻撃側" ? "attacker_wiped_out" : "defender_wiped_out";

            terminateWar(wid, warsData, factionsData, reason);
            warEnded = true;
            break;
          }
        }
      }
    }
    if (warEnded) continue;
  }

  if (updated) {
    saveJSON(WARS_PATH, warsData);
    io.emit("war:update", warsData.wars);
  }
}

// 参戦要請 (Call to Arms)
app.post(
  "/api/alliances/war/call-to-arms",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const { warId } = req.body;
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const alliances = loadJSON(ALLIANCES_PATH, { alliances: {} });
    const wars = loadJSON(WARS_PATH, { wars: {} }); // Note: Using mutable load for consistency if saving later

    const player = players.players[req.playerId];
    if (!player.factionId)
      return res.status(400).json({ error: "勢力に所属していません" });

    const myFaction = factions.factions[player.factionId];
    if (!myFaction.allianceId)
      return res.status(400).json({ error: "同盟に所属していません" });

    const alliance = alliances.alliances[myFaction.allianceId];
    if (!alliance)
      return res.status(404).json({ error: "同盟が見つかりません" });

    // Check permissions (Diplomacy or King)
    if (
      !hasPermission(myFaction, req.playerId, "canDiplomacy") &&
      myFaction.kingId !== req.playerId
    ) {
      return res.status(403).json({ error: "権限がありません" });
    }

    const war = wars.wars[warId];
    if (!war) return res.status(404).json({ error: "戦争が見つかりません" });

    // Determine which side I am on
    let mySide = null;
    let enemySide = null;

    if (war.attackerSide.factions.includes(player.factionId)) {
      mySide = war.attackerSide;
      enemySide = war.defenderSide;
    } else if (war.defenderSide.factions.includes(player.factionId)) {
      mySide = war.defenderSide;
      enemySide = war.attackerSide;
    } else {
      return res.status(400).json({ error: "この戦争には参加していません" });
    }

    // Add all alliance members to my side if not already there
    let addedCount = 0;
    alliance.members.forEach((memberId) => {
      // Cannot be on enemy side (hopefully not, logic prevents this mostly but worth checking?)
      if (enemySide.factions.includes(memberId)) return; // Already enemy?!

      if (!mySide.factions.includes(memberId)) {
        mySide.factions.push(memberId);
        addedCount++;

        // Notify the joined faction
        addFactionNotice(
          memberId,
          "参戦要請",
          `同盟「${alliance.name}」の要請により、戦争に参加しました。`,
          "canDiplomacy",
        );
      }
    });

    if (addedCount > 0) {
      saveJSON(WARS_PATH, wars);
      io.emit("war:update", wars.wars);
      // Clean up legacy wars? Optional.

      io.emit("war:updated", war); // General update
      res.json({
        success: true,
        message: `${addedCount}勢力が参戦しました`,
      });
    } else {
      res.json({ success: true, message: "既に全員参戦済みです" });
    }
  },
);

// ロール一覧取得
app.get("/api/factions/:id/roles", authenticate, (req, res) => {
  const factionId = req.params.id;
  const factions = loadJSON(FACTIONS_PATH, { factions: {} });

  const faction = factions.factions[factionId];
  if (!faction) {
    return res.status(404).json({ error: "勢力が見つかりません" });
  }

  res.json({
    success: true,
    roles: faction.roles || [],
    memberRoles: faction.memberRoles || {},
  });
});

// ロール作成 (勢力主のみ)
app.post(
  "/api/factions/:factionId/roles",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const { factionId } = req.params;
    const { name, rank, permissions } = req.body;

    if (!name || name.trim().length === 0 || name.length > 20) {
      return res
        .status(400)
        .json({ error: "役職名は1〜20文字で入力してください" });
    }

    try {
      const result = await updateJSON(
        FACTIONS_PATH,
        (factions) => {
          const faction = factions.factions[factionId];
          if (!faction) throw new Error("勢力が見つかりません");
          if (
            faction.kingId !== req.playerId &&
            !hasPermission(faction, req.playerId, "canManageMembers")
          )
            throw new Error("権限がありません");

          if (!faction.roles) faction.roles = [];
          if (faction.roles.length >= 10)
            throw new Error("役職は最大10個までです");

          const newRole = {
            id: `role-${Date.now()}`,
            name: name.trim(),
            rank: typeof rank === "number" ? rank : faction.roles.length + 1,
            permissions: { ...DEFAULT_PERMISSIONS, ...(permissions || {}) },
          };

          faction.roles.push(newRole);
          return { newRole, roles: faction.roles, factions };
        },
        { factions: {} },
      );

      io.emit("faction:rolesUpdated", {
        factionId,
        roles: result.roles,
      });

      res.json({
        success: true,
        role: result.newRole,
        roles: result.roles,
      });
    } catch (e) {
      console.error("Error creating role:", e);
      res.status(500).json({ error: e.message || "作成に失敗しました" });
    }
  },
);

// ロール更新 (勢力主のみ)
app.put(
  "/api/factions/:factionId/roles/:roleId",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const { factionId, roleId } = req.params;
    const { name, rank, permissions } = req.body;

    console.log(
      `[RoleUpdate] Player: ${req.playerId}, Faction: ${factionId}, Role: ${roleId}`,
    );
    console.log(`[RoleUpdate] Data:`, { name, rank, permissions });

    try {
      const result = await updateJSON(
        FACTIONS_PATH,
        (factions) => {
          const faction = factions.factions[factionId];
          if (!faction) throw new Error("勢力が見つかりません");
          if (
            faction.kingId !== req.playerId &&
            !hasPermission(faction, req.playerId, "canManageMembers")
          )
            throw new Error("権限がありません");

          if (!faction.roles) throw new Error("役職が見つかりません");

          const roleIndex = faction.roles.findIndex((r) => r.id === roleId);
          if (roleIndex === -1) throw new Error("役職が見つかりません");

          const role = faction.roles[roleIndex];

          // [New Restriction] 自分自身の役職編集の制限 (勢力主以外)
          if (
            faction.kingId !== req.playerId &&
            faction.memberRoles &&
            faction.memberRoles[req.playerId] === roleId
          ) {
            throw new Error("自分自身の役職は編集できません");
          }

          // [Rank Restriction]
          if (faction.kingId !== req.playerId) {
            const myRoleId = faction.memberRoles
              ? faction.memberRoles[req.playerId]
              : null;
            const myRole = myRoleId
              ? faction.roles.find((r) => r.id === myRoleId)
              : null;
            const myRank = myRole ? myRole.rank || 9999 : 9999;
            const targetRank = role.rank || 9999;

            // 自分より上位、または同格の役職は変更不可
            // また、自分の役職を変更することも不可 (権限昇格防止)
            if (targetRank <= myRank) {
              throw new Error("あなたより上位または同格の役職は変更できません");
            }
            if (roleId === myRoleId) {
              throw new Error("自分の役職は変更できません");
            }
          }
          if (name && name.trim().length > 0 && name.length <= 20) {
            role.name = name.trim();
          }
          if (typeof rank === "number") {
            role.rank = rank;
          }
          if (permissions && typeof permissions === "object") {
            role.permissions = { ...DEFAULT_PERMISSIONS, ...permissions };
          }

          return { role, roles: faction.roles, factions };
        },
        { factions: {} },
      );

      console.log(`[RoleUpdate] Success:`, result.role);
      console.log(
        `[RoleUpdate] Emitting faction:roleUpdated to ${factionId}, roleId: ${roleId}`,
      );
      io.emit("faction:roleUpdated", {
        factionId,
        roleId: roleId,
        role: result.role,
      });

      // 権限変更通知のため faction:updated も発行
      const players = loadJSON(PLAYERS_PATH, { players: {} });
      const enriched = getEnrichedFaction(factionId, result.factions, players);
      io.emit("faction:updated", { factionId, faction: enriched });

      res.json({ success: true, role: result.role, roles: result.roles });
    } catch (e) {
      console.error("[RoleUpdate] Error:", e.message);
      res.status(500).json({ error: e.message || "更新に失敗しました" });
    }
  },
);

// 勢力主の役職名変更 (勢力主のみ)
app.put(
  "/api/factions/:factionId/king-role",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const { factionId } = req.params;
    const { name } = req.body;

    if (!name || name.trim().length === 0 || name.trim().length > 10) {
      return res
        .status(400)
        .json({ error: "役職名は1〜10文字である必要があります" });
    }

    try {
      const result = await updateJSON(FACTIONS_PATH, (factions) => {
        const faction = factions.factions[factionId];
        if (!faction) throw new Error("勢力が見つかりません");
        if (faction.kingId !== req.playerId)
          throw new Error("勢力主のみが役職名を変更できます");

        console.log(
          `Updating kingRoleName for faction ${factionId} to: ${name.trim()}`,
        );
        faction.kingRoleName = name.trim();
        return { faction, factions };
      });

      const players = loadJSON(PLAYERS_PATH, { players: {} });
      // 勢力情報更新通知 (リッチ化されたデータを送る)
      const enriched = getEnrichedFaction(factionId, result.factions, players);
      io.emit("faction:updated", { factionId, faction: enriched });

      console.log(`Successfully updated and emitted faction: ${factionId}`);
      res.json({
        success: true,
        kingRoleName: result.faction.kingRoleName,
        faction: enriched,
      });
    } catch (e) {
      console.error("Error updating king role:", e);
      res
        .status(
          e.message === "勢力が見つかりません"
            ? 404
            : e.message.includes("権限")
              ? 403
              : 500,
        )
        .json({ error: e.message });
    }
  },
);

// ロール削除 (勢力主のみ)
app.delete(
  "/api/factions/:factionId/roles/:roleId",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const { factionId, roleId } = req.params;

    try {
      const result = await updateJSON(
        FACTIONS_PATH,
        (factions) => {
          const faction = factions.factions[factionId];
          if (!faction) throw new Error("勢力が見つかりません");
          if (
            faction.kingId !== req.playerId &&
            !hasPermission(faction, req.playerId, "canManageMembers")
          )
            throw new Error("権限がありません");

          if (!faction.roles) throw new Error("役職が見つかりません");

          faction.roles = faction.roles.filter((r) => r.id !== roleId);

          // このロールを持つメンバーのロールを解除
          if (faction.memberRoles) {
            Object.keys(faction.memberRoles).forEach((memberId) => {
              if (faction.memberRoles[memberId] === roleId) {
                delete faction.memberRoles[memberId];
              }
            });
          }

          return { roles: faction.roles, factions };
        },
        { factions: {} },
      );

      io.emit("faction:rolesUpdated", {
        factionId,
        roles: result.roles,
      });

      // 権限変更通知のため faction:updated も発行
      const players = loadJSON(PLAYERS_PATH, { players: {} });
      const enriched = getEnrichedFaction(factionId, result.factions, players);
      io.emit("faction:updated", { factionId, faction: enriched });

      res.json({ success: true, roles: result.roles });
    } catch (e) {
      console.error("Error deleting role:", e);
      res.status(500).json({ error: e.message || "削除に失敗しました" });
    }
  },
);

// メンバーにロール割り当て (勢力主のみ)
app.post(
  "/api/factions/:factionId/members/:memberId/role",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const { factionId, memberId } = req.params;
    const { roleId } = req.body;
    const players = loadJSON(PLAYERS_PATH, { players: {} });

    try {
      const result = await updateJSON(FACTIONS_PATH, (factions) => {
        const faction = factions.factions[factionId];
        if (!faction) throw new Error("勢力が見つかりません");
        if (
          faction.kingId !== req.playerId &&
          !hasPermission(faction, req.playerId, "canManageMembers")
        )
          throw new Error("権限がありません");

        if (!faction.members.includes(memberId))
          throw new Error("メンバーが見つかりません");
        if (memberId === faction.kingId)
          throw new Error("勢力主にはロールを割り当てられません");

        if (!faction.memberRoles) faction.memberRoles = {};

        if (roleId === null || roleId === undefined) {
          // 解除の場合も対象のランクチェックが必要
          if (memberId !== faction.kingId && faction.kingId !== req.playerId) {
            const myRoleId = faction.memberRoles
              ? faction.memberRoles[req.playerId]
              : null;
            const myRole = myRoleId
              ? (faction.roles || []).find((r) => r.id === myRoleId)
              : null;
            const myRank = myRole ? myRole.rank || 9999 : 9999;

            const targetRoleId = faction.memberRoles[memberId];
            const targetRole = targetRoleId
              ? (faction.roles || []).find((r) => r.id === targetRoleId)
              : null;
            const targetRank = targetRole ? targetRole.rank || 9999 : 9999;

            if (targetRank <= myRank) {
              throw new Error(
                "あなたより上位または同格のメンバーの役職は変更できません",
              );
            }
          }
          delete faction.memberRoles[memberId];
        } else {
          const newRole = (faction.roles || []).find((r) => r.id === roleId);
          if (!newRole) {
            throw new Error("指定されたロールが存在しません");
          }

          if (memberId !== faction.kingId && faction.kingId !== req.playerId) {
            const myRoleId = faction.memberRoles
              ? faction.memberRoles[req.playerId]
              : null;
            const myRole = myRoleId
              ? (faction.roles || []).find((r) => r.id === myRoleId)
              : null;
            const myRank = myRole ? myRole.rank || 9999 : 9999;

            // 1. ターゲットの現在のランクチェック
            const targetRoleId = faction.memberRoles[memberId];
            const targetRole = targetRoleId
              ? (faction.roles || []).find((r) => r.id === targetRoleId)
              : null;
            const targetRank = targetRole ? targetRole.rank || 9999 : 9999;

            if (targetRank <= myRank) {
              throw new Error(
                "あなたより上位または同格のメンバーの役職は変更できません",
              );
            }

            // 2. 付与しようとしているランクチェック
            const newRank = newRole.rank || 9999;
            if (newRank <= myRank) {
              throw new Error(
                "あなたより上位または同格の役職を付与することはできません",
              );
            }
          }

          faction.memberRoles[memberId] = roleId;
        }
        return { faction, factions };
      });

      // クライアント側の更新を促す
      console.log(
        `[RoleAssign] Emitting faction:memberRoleUpdated to member ${memberId} in faction ${factionId}`,
      );
      io.emit("faction:memberRoleUpdated", { factionId, memberId, roleId });

      // 全体更新通知を送ることでリロード不要にする
      const enriched = getEnrichedFaction(factionId, result.factions, players);
      io.emit("faction:updated", { factionId, faction: enriched });

      res.json({ success: true, memberRoles: result.faction.memberRoles });
    } catch (e) {
      console.error("Error assigning role:", e);
      res.status(500).json({ error: e.message || "割り当てに失敗しました" });
    }
  },
);

// 勢力メンバー追放 (Kick)
app.post(
  "/api/factions/kick",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const { factionId, targetId } = req.body;

    try {
      const result = await updateJSON(FACTIONS_PATH, (factions) => {
        const faction = factions.factions[factionId];
        if (!faction) throw new Error("勢力が見つかりません");

        // 権限チェック: 勢力主または canManageMembers 権限
        if (
          faction.kingId !== req.playerId &&
          !hasPermission(faction, req.playerId, "canManageMembers")
        ) {
          throw new Error("権限がありません");
        }

        // 基本バリデーション
        if (!targetId) throw new Error("対象が指定されていません");
        if (targetId === req.playerId)
          throw new Error("自分自身を追放することはできません");
        if (!faction.members || !faction.members.includes(targetId))
          throw new Error("対象は勢力メンバーではありません");

        // ランク制限: 自分より上位または同格のメンバーは追放不可
        if (faction.kingId !== req.playerId) {
          const myRoleId = faction.memberRoles
            ? faction.memberRoles[req.playerId]
            : null;
          const targetRoleId = faction.memberRoles
            ? faction.memberRoles[targetId]
            : null;

          const myRole = (faction.roles || []).find((r) => r.id === myRoleId);
          const targetRole = (faction.roles || []).find(
            (r) => r.id === targetRoleId,
          );

          const myRank = myRole ? myRole.rank || 9999 : 9999;
          const targetRank = targetRole ? targetRole.rank || 9999 : 9999;

          if (targetRank <= myRank) {
            throw new Error("あなたより上位または同格の役職者は追放できません");
          }
        }

        // 追放実行: Factionsデータの更新
        faction.members = faction.members.filter((m) => m !== targetId);
        if (faction.memberRoles && faction.memberRoles[targetId]) {
          delete faction.memberRoles[targetId];
        }

        return { faction, factions };
      });

      // 追放実行: Playersデータの更新 (factionId = null)
      await updateJSON(PLAYERS_PATH, (players) => {
        if (players.players[targetId]) {
          players.players[targetId].factionId = null;
        }
        return players;
      });

      // ログ出力
      const players = loadJSON(PLAYERS_PATH, { players: {} });
      const targetName =
        players.players[targetId]?.displayName || toShortId(targetId);
      const kickerName =
        players.players[req.playerId]?.displayName || toShortId(req.playerId);

      logActivity("faction_kicked", {
        factionId,
        factionName: result.faction.name,
        targetId,
        targetName,
        kickerId: req.playerId,
        kickerName,
      });

      // Socket.io 通知
      io.emit("faction:updated", {
        factionId,
        faction: getEnrichedFaction(factionId, result.factions, players),
      });

      io.emit("player:updated", {
        playerId: targetId,
        player: players.players[targetId],
      });

      res.json({ success: true, message: "メンバーを追放しました" });
    } catch (e) {
      console.error("Error kicking member:", e);
      res.status(e.message === "権限がありません" ? 403 : 500).json({
        error: e.message || "追放に失敗しました",
      });
    }
  },
);

// 加入ポリシー取得
app.get("/api/factions/:id/join-policy", (req, res) => {
  const factionId = req.params.id;
  const factions = loadJSON(FACTIONS_PATH, { factions: {} });

  const faction = factions.factions[factionId];
  if (!faction) {
    return res.status(404).json({ error: "勢力が見つかりません" });
  }

  res.json({
    success: true,
    joinPolicy: faction.joinPolicy || "approval", // デフォルトは承認制
  });
});

// 加入ポリシー設定 (勢力主のみ)
app.post(
  "/api/factions/:id/join-policy",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const factionId = req.params.id;
    const { policy } = req.body;

    if (!["open", "approval", "closed"].includes(policy)) {
      return res.status(400).json({
        error: "無効なポリシーです (open, approval, closed のいずれか)",
      });
    }

    const factions = loadJSON(FACTIONS_PATH, { factions: {} });

    const faction = factions.factions[factionId];

    if (!faction) {
      return res.status(404).json({ error: "勢力が見つかりません" });
    }

    if (faction.kingId !== req.playerId) {
      return res
        .status(403)
        .json({ error: "勢力主のみがポリシーを変更できます" });
    }

    faction.joinPolicy = policy;
    saveJSON(FACTIONS_PATH, factions);

    io.emit("faction:updated", {
      factionId,
      faction: faction,
    });

    res.json({ success: true, joinPolicy: faction.joinPolicy });
  },
);

// 通知取得 (勢力メンバーのみ)
app.get(
  "/api/factions/:id/notices",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const factionId = req.params.id;
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });

    const player = players.players[req.playerId];
    if (!player || player.factionId !== factionId) {
      return res
        .status(403)
        .json({ error: "この勢力の通知を見る権限がありません" });
    }

    const faction = factions.factions[factionId];
    if (!faction) {
      return res.status(404).json({ error: "勢力が見つかりません" });
    }

    const noticesData = loadJSON(FACTION_NOTICES_PATH, {});
    const factionNotices = noticesData[factionId] || [];

    // [NEW] 権限によるフィルタリング
    // requiredPermission がある場合、その権限を持っていないと見れない
    const filteredNotices = factionNotices.filter((notice) => {
      if (!notice.requiredPermission) return true;
      return hasPermission(faction, req.playerId, notice.requiredPermission);
    });

    res.json({ success: true, notices: filteredNotices });
  },
);

// ===== Season 2: 共有AP API =====

// 共有AP情報取得
app.get("/api/factions/:id/shared-ap", authenticate, (req, res) => {
  const factionId = req.params.id;
  const factions = loadJSON(FACTIONS_PATH, { factions: {} });

  const faction = factions.factions[factionId];
  if (!faction) {
    return res.status(404).json({ error: "勢力が見つかりません" });
  }

  res.json({
    success: true,
    sharedAP: faction.sharedAP || 0,
  });
});

// 個人AP → 共有APへ寄付
app.post(
  "/api/factions/:id/shared-ap/donate",
  authenticate,
  async (req, res) => {
    const factionId = req.params.id;
    const { amount } = req.body;

    if (!amount || typeof amount !== "number" || amount < 1) {
      return res.status(400).json({ error: "1以上の数値を指定してください" });
    }

    try {
      // プレイヤーデータの更新
      let donateAmount = 0;
      let remainingAP = 0;

      const playerUpdate = await updateJSON(PLAYERS_PATH, (players) => {
        const player = players.players[req.playerId];
        if (!player) throw new Error("プレイヤーが見つかりません");
        if (!player.factionId || player.factionId !== factionId) {
          throw new Error("この勢力に所属していません");
        }

        const factions = loadJSON(FACTIONS_PATH, { factions: {} });
        const faction = factions.factions[factionId];
        if (!faction) throw new Error("勢力が見つかりません");

        const settings = loadJSON(SYSTEM_SETTINGS_PATH, { apSettings: {} });
        const currentShared = faction.sharedAP || 0;

        // [UPDATED] Helper利用
        const { limit: sharedApLimit } = calculateFactionSharedAPLimit(
          faction,
          players,
          settings,
        );

        const maxDonate = Math.min(
          amount,
          player.ap,
          sharedApLimit - currentShared,
        );
        donateAmount = Math.min(amount, player.ap, maxDonate);

        if (donateAmount < 1) {
          if (maxDonate <= 0) {
            return {
              donateAmount: 0,
              remainingAP: player.ap,
              message: `共有APが上限(${sharedApLimit})に達しています(現在:${currentShared})`,
            };
          }
          return {
            donateAmount: 0,
            remainingAP: player.ap,
            message: `寄付できません。個人AP不足の可能性があります (所持:${player.ap}, 要求:${amount})`,
          };
        }

        player.ap -= donateAmount;
        player.lastApAction = Date.now();
        remainingAP = player.ap;
        return { donateAmount, remainingAP };
      });

      // 勢力データの更新
      let factionUpdate = { sharedAP: 0 };
      if (playerUpdate.donateAmount > 0) {
        factionUpdate = await updateJSON(FACTIONS_PATH, (factions) => {
          const faction = factions.factions[factionId];
          if (!faction) throw new Error("勢力が見つかりません");
          if (!faction.sharedAP) faction.sharedAP = 0;
          faction.sharedAP += playerUpdate.donateAmount;
          return { sharedAP: faction.sharedAP };
        });
      } else {
        const factions = loadJSON(FACTIONS_PATH, { factions: {} });
        factionUpdate.sharedAP = factions.factions[factionId]?.sharedAP || 0;
      }

      // プレイヤー情報の取得（ログ用）
      const pData = loadJSON(PLAYERS_PATH, { players: {} });
      const fData = loadJSON(FACTIONS_PATH, { factions: {} });
      const player = pData.players[req.playerId];
      const faction = fData.factions[factionId];

      if (playerUpdate.donateAmount > 0 && player && faction) {
        let roleName = "";
        if (faction.kingId === req.playerId) {
          roleName = "勢力主";
        } else if (faction.memberRoles && faction.memberRoles[req.playerId]) {
          // 個人AP → 共有APへ寄付
          // アロケーションにより共有APは勢力データへ移管されるが、
          // プレイヤーのAPも減らす必要がある
          const roleId = faction.memberRoles[req.playerId];
          const role = faction.roles
            ? faction.roles.find((r) => r.id === roleId)
            : null;
          if (role) roleName = role.name;
        }

        logActivity("shared_ap_donated", {
          playerId: req.playerId,
          playerName: player.displayName || toShortId(req.playerId),
          roleName: roleName,
          factionId,
          factionName: faction.name,
          amount: playerUpdate.donateAmount,
        });
      }

      io.to(`faction:${factionId}`).emit("faction:sharedAPUpdated", {
        factionId,
        sharedAP: factionUpdate.sharedAP,
      });
      io.to(`user:${req.playerId}`).emit("ap:refresh");

      res.json({
        success: true,
        donatedAmount: playerUpdate.donateAmount,
        remainingAP: playerUpdate.remainingAP,
        sharedAP: factionUpdate.sharedAP,
        message: playerUpdate.message,
      });
    } catch (e) {
      console.error("Error donating AP:", e);
      res.status(500).json({ error: e.message || "寄付に失敗しました" });
    }
  },
);

// 共有AP → 個人APへ引き出し (勢力主のみ)
app.post(
  "/api/factions/:id/shared-ap/withdraw",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const factionId = req.params.id;
    const { amount, targetPlayerId } = req.body;

    if (!amount || typeof amount !== "number" || amount < 1) {
      return res.status(400).json({ error: "1以上の数値を指定してください" });
    }

    try {
      let actualAmount = 0;
      let targetId = targetPlayerId || req.playerId;

      // 勢力データの更新 (SharedAPの減算)
      const factionUpdate = await updateJSON(FACTIONS_PATH, (factions) => {
        const faction = factions.factions[factionId];
        if (!faction) throw new Error("勢力が見つかりません");
        if (faction.kingId !== req.playerId)
          throw new Error("勢力主のみが共有APを引き出せます");

        const availableShared = faction.sharedAP || 0;
        if (availableShared < 1) throw new Error("共有APがありません");

        const players = loadJSON(PLAYERS_PATH, { players: {} });
        const targetPlayer = players.players[targetId];

        if (!targetPlayer || !faction.members.includes(targetId)) {
          throw new Error("対象のプレイヤーが見つかりません");
        }

        const maxReceive = AP_MAX_LIMIT - (targetPlayer.ap || 0);
        actualAmount = Math.min(amount, availableShared, maxReceive);

        if (actualAmount < 1) {
          if (maxReceive <= 0)
            throw new Error("対象のAPが上限(60)に達しています");
          throw new Error("引き出し可能なAPがありません");
        }

        faction.sharedAP -= actualAmount;
        return { actualAmount: actualAmount, sharedAP: faction.sharedAP };
      });

      // プレイヤーデータの更新 (APの加算)
      const playerUpdate = await updateJSON(PLAYERS_PATH, (players) => {
        const targetPlayer = players.players[targetId];
        if (!targetPlayer) throw new Error("プレイヤーが見つかりません");
        targetPlayer.ap = (targetPlayer.ap || 0) + factionUpdate.actualAmount;
        return { ap: targetPlayer.ap };
      });

      logActivity("shared_ap_withdrawn", {
        playerId: req.playerId,
        targetPlayerId: targetId,
        factionId,
        amount: factionUpdate.actualAmount,
      });

      io.to(`faction:${factionId}`).emit("faction:sharedAPUpdated", {
        factionId,
        sharedAP: factionUpdate.sharedAP,
      });
      io.to(`user:${req.playerId}`).emit("ap:refresh");

      res.json({
        success: true,
        withdrawnAmount: factionUpdate.actualAmount,
        sharedAP: factionUpdate.sharedAP,
        targetPlayerAP: playerUpdate.ap,
      });
    } catch (e) {
      console.error("Error withdrawing AP:", e);
      res.status(500).json({ error: e.message || "引き出しに失敗しました" });
    }
  },
);

// 勢力設定変更 (王様のみ)
app.post(
  "/api/factions/:id/settings",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const factionId = req.params.id;
    const { name, color } = req.body;

    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const players = loadJSON(PLAYERS_PATH, { players: {} });

    const faction = factions.factions[factionId];
    if (!faction) {
      return res.status(404).json({ error: "勢力が見つかりません" });
    }

    const player = players.players[req.playerId];
    if (
      faction.kingId !== req.playerId &&
      !hasPermission(faction, req.playerId, "canManageSettings")
    ) {
      return res.status(403).json({ error: "権限がありません" });
    }

    let changed = false;
    if (name !== undefined) {
      const trimmed = name.trim();
      if (trimmed.length > 0 && trimmed.length <= 20) {
        if (trimmed.replace(/[\s\u200B-\u200D\uFEFF]/g, "").length === 0) {
          return res
            .status(400)
            .json({ error: "勢力名には有効な文字を含めてください" });
        }
        faction.name = trimmed;
        changed = true;
      } else if (name.length > 20) {
        return res
          .status(400)
          .json({ error: "勢力名は20文字以内で入力してください" });
      } else if (name.length > 0) {
        // 空文字以外で条件満たさない場合（長さオーバーなど）
        // 長さ0は無視（変更なし扱い）だが、長さオーバーはエラー返すべき？
        // 既存ロジックは無視していたが、明示的にエラーにするならここ。
        // 今回はゼロ幅チェックが主眼なので、既存の振る舞い（無視）は維持しつつ、
        // 明らかに「改名しようとしているが無効」なケースを弾く。
        // ただし user requirement is "alert error".
        // Let's be strict if name is provided.
      }
    }
    if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
      if (color.toLowerCase() === "#ffffff") {
        return res
          .status(400)
          .json({ error: "白色(#ffffff)は勢力色として使用できません" });
      }
      faction.color = color;
      changed = true;
    }

    if (!changed) {
      return res.status(400).json({ error: "変更する値がありません" });
    }

    saveJSON(FACTIONS_PATH, factions);

    // [OPTIMIZATION] マップ上のタイルの色更新 (SABベース & JSON 差分反映)
    const updatedTiles = {};
    if (sharedMapView) {
      const size = 500;
      const targetFidIdx = getFactionIdx(factionId);
      const newColorInt = parseInt(faction.color.replace("#", ""), 16);

      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const offset = (y * size + x) * TILE_BYTE_SIZE;
          const fidIdx = sharedMapView.getUint16(offset, true);

          if (fidIdx === targetFidIdx) {
            // 色を更新
            sharedMapView.setUint32(offset + 2, newColorInt, true);

            // JSON側も更新が必要（saveMapState で保存される）
            const key = `${x}_${y}`;
            const tile = mapState.tiles[key];
            if (tile) {
              tile.color = faction.color;
              updatedTiles[key] = tile;
            }
          }
        }
      }
      // 変更を即時反映（ディスク保存は queueMapUpdate 経由）
      queueMapUpdateInternal();
    } else {
      // フォールバック: 旧来の JSON ロード方式
      // (通常は here には来ないが、SAB が何らかの理由で無効な場合のため)
      for (const [key, tile] of Object.entries(mapState.tiles)) {
        if ((tile.faction || tile.factionId) === factionId) {
          tile.color = faction.color;
          updatedTiles[key] = tile;
        }
      }
      saveJSON(MAP_STATE_PATH, mapState);
    }

    const changedByName = player.displayName || req.playerId.substring(0, 8);
    if (name && name !== faction.name) {
      logActivity("faction_name_changed", {
        factionId,
        oldName: faction.name,
        newName: name,
        changedByName: changedByName,
      });
    }
    if (color && color !== faction.color) {
      logActivity("faction_color_changed", {
        factionId,
        factionName: name || faction.name,
        newColor: color,
        changedByName: changedByName,
      });
    }

    const enriched = getEnrichedFaction(factionId, factions, players);
    io.emit("faction:updated", { factionId, faction: enriched });
    io.emit("tile:update", updatedTiles);

    res.json({ success: true, faction: enriched });
  },
);

// 勢力主譲渡 (勢力主のみ)
app.post(
  "/api/factions/:id/transfer-king",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const factionId = req.params.id;
    const { newKingId } = req.body;

    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const players = loadJSON(PLAYERS_PATH, { players: {} });

    const faction = factions.factions[factionId];
    if (!faction) {
      return res.status(404).json({ error: "勢力が見つかりません" });
    }

    const player = players.players[req.playerId];
    if (faction.kingId !== req.playerId) {
      return res.status(403).json({ error: "権限がありません" });
    }

    if (!newKingId || !faction.members.includes(newKingId)) {
      return res.status(400).json({
        error: "指定されたメンバーは存在しないか、この勢力に所属していません",
      });
    }

    if (newKingId === req.playerId) {
      return res.status(400).json({ error: "自分自身には譲渡できません" });
    }

    faction.kingId = newKingId;
    saveJSON(FACTIONS_PATH, factions);

    const newKingPlayer = players.players[newKingId];
    const newKingName = newKingPlayer?.displayName || toShortId(newKingId);

    logActivity("faction_leader_transferred", {
      factionId,
      factionName: faction.name,
      oldLeaderId: req.playerId,
      oldLeaderName: player.displayName || req.playerId.substring(0, 8),
      newLeaderId: newKingId,
      newLeaderName: newKingName,
    });

    const enriched = getEnrichedFaction(factionId, factions, players);
    io.emit("faction:updated", { factionId, faction: enriched });

    // 新しい王様への通知
    io.emit("player:kingReceived", {
      playerId: newKingId,
      factionId,
      factionName: faction.name,
      fromPlayerName: player.displayName || toShortId(req.playerId),
    });

    res.json({ success: true, faction: enriched });
  },
);

// 勢力併合要請 (勢力主のみ)
// 併合候補取得 (中核隣接フィルタ)
app.get(
  "/api/factions/merge/candidates",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });
    const player = players.players[req.playerId];

    if (!player || !player.factionId) {
      return res.json({ candidates: [] });
    }

    const myFactionId = player.factionId;
    const myFaction = factions.factions[myFactionId];
    if (!myFaction) {
      return res.json({ candidates: [] });
    }

    const candidates = Object.values(factions.factions)
      .filter((f) => f.id !== myFactionId) // 自分以外
      .filter((f) => {
        // [NEW] 自勢力よりポイントが少ない勢力は除外
        if ((f.totalPoints || 0) < (myFaction.totalPoints || 0)) return false;
        return true;
      })
      .filter((f) => {
        // [New Phase 8] 戦争中の勢力は除外
        const wars = loadJSON(WARS_PATH, { wars: {} });
        if (isAtWarWith(myFactionId, f.id, wars)) return false;
        return true;
      })
      .filter((f) => {
        // Core Cluster Adjacency Check
        // 1. Get My Core Clusters
        const myCoreClusters = getCoreClusters(myFactionId, mapState);
        if (myCoreClusters.length === 0) return false; // if I have no core, cannot merge? (Design choice: require core)

        // 2. Get Target Core Clusters
        const targetCoreClusters = getCoreClusters(f.id, mapState);
        if (targetCoreClusters.length === 0) return false; // if target has no core, not eligible

        // 3. Check if ANY of my core clusters is adjacent to ANY of target core clusters
        for (const myC of myCoreClusters) {
          for (const tgtC of targetCoreClusters) {
            if (areClustersAdjacent(myC, tgtC)) return true;
          }
        }
        return false;
      })
      .map((f) => ({
        id: f.id,
        name: f.name,
        color: f.color,
        points: f.totalPoints,
        memberCount: (f.members || []).length,
      }));

    res.json({ candidates });
  },
);

// 併合要請の送信 (勢力主のみ)
app.post(
  "/api/factions/merge/request",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const { targetFactionId } = req.body;
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const players = loadJSON(PLAYERS_PATH, { players: {} });

    const player = players.players[req.playerId];
    if (!player) return res.status(401).json({ error: "認証エラー" });
    const myFactionId = player.factionId;

    if (!myFactionId)
      return res.status(400).json({ error: "勢力に所属していません" });
    const myFaction = factions.factions[myFactionId];
    if (
      myFaction.kingId !== req.playerId &&
      !hasPermission(myFaction, req.playerId, "canDiplomacy")
    ) {
      return res.status(403).json({ error: "外交権限がありません" });
    }

    // [NEW] 上位勢力制限: 設定されたランク以内の勢力は「吸収される側」になれない
    const settings = loadSystemSettings(); // Use helper to ensure defaults
    if (settings.isMergeEnabled === false) {
      return res
        .status(403)
        .json({ error: "現在、併合機能は無効化されています" });
    }

    if (myFactionId === targetFactionId)
      return res
        .status(400)
        .json({ error: "自分の勢力には併合要請できません" });

    const targetFaction = factions.factions[targetFactionId];
    if (!targetFaction)
      return res.status(404).json({ error: "対象の勢力が見つかりません" });

    // [New Phase 8] 戦争状態チェック
    const wars = loadJSON(WARS_PATH, { wars: {} });
    if (isAtWarWith(myFactionId, targetFactionId, wars)) {
      return res.status(400).json({
        error: "戦争状態にある勢力に対して併合を要請することはできません",
      });
    }

    // ポイントバリデーション
    if ((targetFaction.totalPoints || 0) < (myFaction.totalPoints || 0)) {
      return res.status(400).json({
        error: `自分よりポイントの少ない勢力(${targetFaction.name})には併合要請できません`,
      });
    }

    // Rank Restriction
    const prohibitedRank = settings.mergerSettings?.prohibitedRank ?? 0;

    // 0の場合は制限なし
    if (prohibitedRank > 0) {
      const allFactions = Object.values(factions.factions);
      allFactions.sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0));
      // Get top N IDs
      const topIds = allFactions
        .slice(0, prohibitedRank)
        .map((f) => f.id)
        .filter((id) => id);

      // 自分が上位ランクに入っている場合、他所への併合申請（＝吸収されること）は不可
      if (topIds.includes(myFactionId)) {
        return res.status(400).json({
          error: `ランキング上位${prohibitedRank}勢力は、他の勢力に併合申請（吸収）を行うことはできません。威厳を保ってください！`,
        });
      }
    }

    // --------------------------------------------------------------------------
    // 重複リクエストのチェック用ID
    const requesterId = myFactionId;
    // --------------------------------------------------------------------------
    // データ構造のマイグレーション
    if (targetFaction.mergeRequests && targetFaction.mergeRequests.length > 0) {
      targetFaction.mergeRequests = targetFaction.mergeRequests.map((req) => {
        if (typeof req === "string")
          return { id: req, requestedAt: Date.now() };
        return req;
      });
    }
    // --------------------------------------------------------------------------

    if (!targetFaction.mergeRequests) targetFaction.mergeRequests = [];

    // 既存のリクエストを確認
    const existingIndex = targetFaction.mergeRequests.findIndex(
      (req) => req.id === requesterId,
    );

    if (existingIndex !== -1) {
      // 既に申請済みの場合はタイムスタンプ更新
      targetFaction.mergeRequests[existingIndex].requestedAt = Date.now();
    } else {
      // 新規申請
      targetFaction.mergeRequests.push({
        id: myFactionId,
        requestedAt: Date.now(),
      });
    }

    // 送信元にターゲットを記録（取り消し用）
    myFaction.pendingMergeTarget = targetFactionId;

    saveJSON(FACTIONS_PATH, factions);

    // 通知とお知らせ
    // 役職名
    let roleName = "Member";
    if (myFaction.kingId === req.playerId) {
      roleName = myFaction.kingRoleName || "勢力主";
    } else if (myFaction.memberRoles && myFaction.memberRoles[req.playerId]) {
      const rid = myFaction.memberRoles[req.playerId];
      const r = myFaction.roles
        ? myFaction.roles.find((ro) => ro.id === rid)
        : null;
      if (r) roleName = r.name;
    }
    const pName = player.displayName || toShortId(req.playerId);

    addFactionNotice(
      targetFactionId,
      "併合要請が届きました",
      `${myFaction.name}から併合要請が届きました。（${pName}[${roleName}]）`,
      "canDiplomacy",
      { requesterFactionId: myFactionId },
      {
        actions: [
          { label: "承認する", action: "merge:accept", style: "primary" },
          { label: "拒否する", action: "merge:reject", style: "danger" },
        ],
      },
    );

    // 通知: ターゲット勢力の「勢力主」と「外交権限持ち」のみに送信
    // ターゲット勢力のメンバーを取得
    const targetMembers = Object.values(players.players).filter(
      (p) => p.factionId === targetFactionId,
    );

    // 通知対象IDリスト
    const notifyPlayerIds = targetMembers
      .filter((p) => {
        // 勢力主
        if (targetFaction.kingId === p.id) return true;
        // 権限チェック (ロール確認)
        const rid = targetFaction.memberRoles
          ? targetFaction.memberRoles[p.id]
          : null;
        if (rid) {
          const role = targetFaction.roles
            ? targetFaction.roles.find((r) => r.id === rid)
            : null;
          if (role && role.permissions && role.permissions.canDiplomacy)
            return true;
        }
        return false;
      })
      .map((p) => p.id);

    // Socket.IOで特定ユーザーにのみ送る実装が必要だが、room分けしていない場合は
    // 全員に送ってクライアントサイドでフィルタリングするか、個別にemitする
    // ここでは "merge:request" イベントに targetPlayerIds を含めてクライアントで判断させる

    io.emit("merge:request", {
      targetFactionId,
      targetKingId: targetFaction.kingId,
      notifyPlayerIds, // 通知対象
      requesterFactionId: myFactionId,
      requesterFactionName: myFaction.name,
    });

    res.json({ success: true });
  },
);

// 併合要請の取り消し (勢力主のみ)
app.post(
  "/api/factions/merge/cancel",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const player = players.players[req.playerId];
    const myFactionId = player.factionId;

    if (!myFactionId)
      return res.status(400).json({ error: "勢力に所属していません" });
    const myFaction = factions.factions[myFactionId];
    if (myFaction.kingId !== req.playerId)
      return res.status(403).json({ error: "権限がありません" });

    const targetFactionId = myFaction.pendingMergeTarget;
    if (!targetFactionId)
      return res.status(400).json({ error: "送信中の併合要請はありません" });

    const targetFaction = factions.factions[targetFactionId];
    // --------------------------------------------------------------------------
    // データ構造のマイグレーション
    if (targetFaction.mergeRequests && targetFaction.mergeRequests.length > 0) {
      targetFaction.mergeRequests = targetFaction.mergeRequests.map((req) => {
        if (typeof req === "string")
          return { id: req, requestedAt: Date.now() };
        return req;
      });
    }
    // --------------------------------------------------------------------------

    if (targetFaction && targetFaction.mergeRequests) {
      targetFaction.mergeRequests = targetFaction.mergeRequests.filter(
        (r) => r.id !== myFactionId,
      );
    }

    delete myFaction.pendingMergeTarget;
    saveJSON(FACTIONS_PATH, factions);

    // 通知とお知らせ
    addFactionNotice(
      targetFactionId,
      "併合要請が取り消されました",
      `勢力「${myFaction.name}」からの併合要請が取り消されました。`,
    );

    io.emit("merge:canceled", {
      targetFactionId,
      targetKingId: targetFaction ? targetFaction.kingId : null,
      requesterFactionId: myFactionId,
    });

    logActivity("merge_canceled", {
      sourceFactionId: myFactionId,
      sourceFactionName: myFaction.name,
      targetFactionId,
      targetFactionName: targetFaction?.name || "Unknown",
      canceledBy: player.displayName || toShortId(req.playerId),
    });

    res.json({ success: true, message: "要請を取り消しました" });
  },
);

// 同盟要請 (勢力主のみ)
app.post(
  "/api/factions/alliance/request",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const { targetFactionId } = req.body;
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const player = players.players[req.playerId];
    const myFactionId = player.factionId;

    if (!myFactionId)
      return res.status(400).json({ error: "勢力に所属していません" });
    const myFaction = factions.factions[myFactionId];
    if (
      myFaction.kingId !== req.playerId &&
      !hasPermission(myFaction, req.playerId, "canDiplomacy")
    ) {
      return res.status(403).json({ error: "外交権限がありません" });
    }

    const targetFaction = factions.factions[targetFactionId];
    if (!targetFaction)
      return res.status(404).json({ error: "要請先の勢力が存在しません" });

    // 同盟重複チェック
    const alliancesData = loadJSON(ALLIANCES_PATH, { alliances: {} });
    const alliances = alliancesData.alliances || {};

    // 自分が既に同盟に加盟しているかチェック
    const joinedAllianceId = Object.keys(alliances).find((key) =>
      alliances[key].members.includes(myFactionId),
    );

    if (joinedAllianceId) {
      const myAlliance = alliances[joinedAllianceId];
      // 自分が盟主（Season2形式: leaderId一致, 旧形式: key一致）でない場合はエラー
      const isActuallyLeader =
        myAlliance.leaderId === myFactionId || joinedAllianceId === myFactionId;

      if (!isActuallyLeader) {
        return res.status(400).json({ error: "既に同盟に加盟しています" });
      }
    }

    // 3. 相手と戦争状態でないかチェック
    const wars = loadJSON(WARS_PATH, { wars: {} });

    // 自分の同盟メンバーを取得 (自分が同盟に入っていればそのメンバー、入っていなければ自分のみ)
    let mySideFactionIds = [myFactionId];
    if (myFaction.allianceId && alliances[myFaction.allianceId]) {
      mySideFactionIds = alliances[myFaction.allianceId].members;
    }

    // 相手の同盟メンバーを取得 (相手が同盟に入っていればそのメンバー、入っていなければ相手のみ)
    let targetSideFactionIds = [targetFactionId];
    if (targetFaction.allianceId && alliances[targetFaction.allianceId]) {
      targetSideFactionIds = alliances[targetFaction.allianceId].members;
    }

    // 相互に戦争状態がないかチェック
    // Case 1: 自分の同盟(私) vs 相手の同盟(彼ら)
    for (const myFid of mySideFactionIds) {
      if (isAtWarWith(myFid, targetFactionId, wars)) {
        return res
          .status(400)
          .json({ error: "相手の勢力と戦争中のため、要請を送れません" });
      }
      // 相手が同盟持ちの場合もチェック
      for (const targetFid of targetSideFactionIds) {
        if (isAtWarWith(myFid, targetFid, wars)) {
          return res.status(400).json({
            error: "相手の同盟勢力と戦争中のため、要請を送れません",
          });
        }
      }
    }

    // --------------------------------------------------------------------------
    // データ構造のマイグレーション
    if (
      targetFaction.allianceRequests &&
      targetFaction.allianceRequests.length > 0
    ) {
      targetFaction.allianceRequests = targetFaction.allianceRequests.map(
        (req) => {
          if (typeof req === "string")
            return { id: req, requestedAt: Date.now() };
          return req;
        },
      );
    }
    // --------------------------------------------------------------------------

    if (!targetFaction.allianceRequests) targetFaction.allianceRequests = [];

    // 既存チェック & 更新
    const existingIndex = targetFaction.allianceRequests.findIndex(
      (r) => r.id === myFactionId,
    );
    if (existingIndex !== -1) {
      targetFaction.allianceRequests[existingIndex].requestedAt = Date.now();
    } else {
      targetFaction.allianceRequests.push({
        id: myFactionId,
        requestedAt: Date.now(),
      });
    }

    saveJSON(FACTIONS_PATH, factions);

    // お知らせ追加
    // 役職名
    let roleName = "Member";
    if (myFaction.kingId === req.playerId) {
      roleName = myFaction.kingRoleName || "勢力主";
    } else if (myFaction.memberRoles && myFaction.memberRoles[req.playerId]) {
      const rid = myFaction.memberRoles[req.playerId];
      const r = myFaction.roles
        ? myFaction.roles.find((ro) => ro.id === rid)
        : null;
      if (r) roleName = r.name;
    }
    const pName = player.displayName || toShortId(req.playerId);

    addFactionNotice(
      targetFactionId,
      "同盟加入申請が届きました",
      `${myFaction.name}から同盟加入申請が届きました。（${pName}[${roleName}]）`,
      "canDiplomacy",
      { requesterFactionId: myFactionId },
      {
        actions: [
          {
            label: "承認する",
            action: "alliance:accept",
            style: "primary",
          },
          { label: "拒否する", action: "alliance:reject", style: "danger" },
        ],
      },
    );

    io.emit("alliance:request", {
      targetFactionId,
      targetKingId: targetFaction.kingId,
      requesterFactionId: myFactionId,
      requesterFactionName: myFaction.name,
    });

    // 同盟情報の取得
    let targetAllianceName = "不明な同盟";
    let targetAllianceLeaderName = "不明";

    // A: 自分が同盟に加盟している場合（招待） -> 自分の同盟情報をログに残す
    if (joinedAllianceId) {
      const myAlliance = alliances[joinedAllianceId];
      targetAllianceName = myAlliance.name || "不明な同盟";
      const leaderF = factions.factions[myAlliance.leaderId];
      targetAllianceLeaderName = leaderF ? leaderF.name : "不明";
    }
    // B: 相手が同盟に加盟している場合（加盟申請） -> 相手の同盟情報をログに残す
    else if (targetFaction.allianceId && alliances[targetFaction.allianceId]) {
      const targetAlliance = alliances[targetFaction.allianceId];
      targetAllianceName = targetAlliance.name;
      const leaderF = factions.factions[targetAlliance.leaderId]; // プロパティ名修正
      targetAllianceLeaderName = leaderF ? leaderF.name : "不明";
    }

    logActivity("alliance_request_sent", {
      sourceFactionId: myFactionId,
      sourceFactionName: myFaction.name,
      targetFactionId,
      targetFactionName: targetFaction.name,
      allianceName: targetAllianceName,
      leaderFactionName: targetAllianceLeaderName,
      requestedBy: player.displayName || toShortId(req.playerId),
      isInvitation: !!joinedAllianceId,
    });

    res.json({ success: true });
  },
);

// 同盟回答 (勢力主のみ)
app.post(
  "/api/factions/alliance/respond",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const { requesterFactionId, accept } = req.body;
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const player = players.players[req.playerId];
    const myFactionId = player.factionId;

    if (!myFactionId)
      return res.status(400).json({ error: "勢力に所属していません" });
    const myFaction = factions.factions[myFactionId];
    if (
      myFaction.kingId !== req.playerId &&
      !hasPermission(myFaction, req.playerId, "canDiplomacy")
    ) {
      return res.status(403).json({ error: "外交権限がありません" });
    }

    // --------------------------------------------------------------------------
    // データ構造のマイグレーション
    if (myFaction.allianceRequests && myFaction.allianceRequests.length > 0) {
      myFaction.allianceRequests = myFaction.allianceRequests.map((req) => {
        if (typeof req === "string")
          return { id: req, requestedAt: Date.now() };
        return req;
      });
    }
    // --------------------------------------------------------------------------

    const requestObj =
      myFaction.allianceRequests &&
      myFaction.allianceRequests.find((r) => r.id === requesterFactionId);

    if (!requestObj) {
      return res.status(400).json({ error: "有効な同盟要請がありません" });
    }

    // 期限チェック (12時間)
    const checkTime = Date.now();
    const EXPIRE_TIME = 12 * 60 * 60 * 1000;
    if (checkTime - requestObj.requestedAt > EXPIRE_TIME) {
      // 期限切れのリクエストを削除
      myFaction.allianceRequests = myFaction.allianceRequests.filter(
        (r) => r.id !== requesterFactionId,
      );
      saveJSON(FACTIONS_PATH, factions);
      return res
        .status(400)
        .json({ error: "要請の期限(24時間)が切れています" });
    }

    myFaction.allianceRequests = myFaction.allianceRequests.filter(
      (r) => r.id !== requesterFactionId,
    );

    if (!accept) {
      addFactionNotice(
        requesterFactionId,
        "同盟拒否",
        `同盟要請が、勢力「${myFaction.name}」によって拒否されました。`,
        null,
        null,
        null,
        "warning",
      );
      saveJSON(FACTIONS_PATH, factions);
      return res.json({ success: true, message: "同盟要請を拒否しました" });
    }

    const requesterFaction = factions.factions[requesterFactionId];
    if (!requesterFaction) {
      saveJSON(FACTIONS_PATH, factions);
      return res.status(404).json({ error: "要請元の勢力が見つかりません" });
    }

    const alliancesData = loadJSON(ALLIANCES_PATH, { alliances: {} });
    const alliances = alliancesData.alliances || {};

    if (accept) {
      // 両者が異なる同盟に所属している場合はエラー
      if (
        myFaction.allianceId &&
        requesterFaction.allianceId &&
        myFaction.allianceId !== requesterFaction.allianceId
      ) {
        return res.status(400).json({
          error:
            "両勢力が異なる同盟に所属しているため結成できません。一度脱退してください。",
        });
      }

      // [NEW] 承認直前の戦争チェック
      const wars = loadJSON(WARS_PATH, { wars: {} });
      // 自分の同盟メンバーを取得 (自分が同盟に入っていればそのメンバー、入っていなければ自分のみ)
      let mySideFactionIds = [myFactionId];
      if (myFaction.allianceId && alliances[myFaction.allianceId]) {
        mySideFactionIds = alliances[myFaction.allianceId].members;
      }
      // 相手の同盟メンバーを取得 (相手が同盟に入っていればそのメンバー、入っていなければ相手のみ)
      let requesterSideFactionIds = [requesterFactionId];
      if (
        requesterFaction.allianceId &&
        alliances[requesterFaction.allianceId]
      ) {
        requesterSideFactionIds =
          alliances[requesterFaction.allianceId].members;
      }
      // 相互に戦争状態がないかチェック
      for (const myFid of mySideFactionIds) {
        if (isAtWarWith(myFid, requesterFactionId, wars)) {
          return res.status(400).json({
            error: "相手の勢力と戦争中のため、要請を承認できません",
          });
        }
        for (const reqFid of requesterSideFactionIds) {
          if (isAtWarWith(myFid, reqFid, wars)) {
            return res.status(400).json({
              error: "相手の同盟勢力と戦争中のため、要請を承認できません",
            });
          }
        }
      }
    }

    // 同盟グループ作成・参加ロジック
    let allianceId = null;
    let isNewAlliance = false;
    let joiningFactionId = null;

    // 1. 相手が既に同盟グループに所属している場合
    if (requesterFaction.allianceId && alliances[requesterFaction.allianceId]) {
      allianceId = requesterFaction.allianceId;
      joiningFactionId = myFactionId;
      // 既存同盟に参加
      if (!alliances[allianceId].members.includes(myFactionId)) {
        alliances[allianceId].members.push(myFactionId);
        if (!alliances[allianceId].memberJoinedAt)
          alliances[allianceId].memberJoinedAt = {};
        alliances[allianceId].memberJoinedAt[myFactionId] =
          new Date().toISOString();
      }
    }
    // 2. 自分が既に同盟グループに所属している場合 (相手を誘う)
    else if (myFaction.allianceId && alliances[myFaction.allianceId]) {
      allianceId = myFaction.allianceId;
      joiningFactionId = requesterFactionId;
      // 既存同盟に追加
      if (!alliances[allianceId].members.includes(requesterFactionId)) {
        alliances[allianceId].members.push(requesterFactionId);
        if (!alliances[allianceId].memberJoinedAt)
          alliances[allianceId].memberJoinedAt = {};
        alliances[allianceId].memberJoinedAt[requesterFactionId] =
          new Date().toISOString();
      }
    }
    // 3. どちらも未所属 -> 新規結成
    else {
      allianceId = requesterFactionId; // 申請者を親とする
      if (!alliances[allianceId]) {
        isNewAlliance = true;
        alliances[allianceId] = {
          id: allianceId,
          name: `Alliance(${requesterFaction.name})`,
          leaderId: requesterFactionId,
          members: [requesterFactionId, myFactionId],
          createdAt: new Date().toISOString(),
          memberJoinedAt: {
            [requesterFactionId]: new Date().toISOString(),
            [myFactionId]: new Date().toISOString(),
          },
          color: requesterFaction.color || "#4488ff",
        };
      } else {
        if (!alliances[allianceId].members.includes(myFactionId)) {
          alliances[allianceId].members.push(myFactionId);
          if (!alliances[allianceId].memberJoinedAt)
            alliances[allianceId].memberJoinedAt = {};
          alliances[allianceId].memberJoinedAt[myFactionId] =
            new Date().toISOString();
        }
      }
    }

    // 双方に allianceId をセット
    myFaction.allianceId = allianceId;
    requesterFaction.allianceId = allianceId;

    // allianceId設定後、すぐに両方のJSONを保存（中断による不整合を防止）
    saveJSON(FACTIONS_PATH, factions);
    saveJSON(ALLIANCES_PATH, alliancesData);

    // --- 戦争解除ロジック ---
    const wars = loadJSON(WARS_PATH, { wars: {} });
    const memberA = myFactionId;
    const memberB = requesterFactionId;

    // 既存のすべての戦争を走査して、同盟を結んだ勢力間の戦争を解除
    Object.keys(wars.wars).forEach((wid) => {
      const war = wars.wars[wid];
      if (
        (war.attackerSide.factions.includes(memberA) &&
          war.defenderSide.factions.includes(memberB)) ||
        (war.attackerSide.factions.includes(memberB) &&
          war.defenderSide.factions.includes(memberA))
      ) {
        terminateWar(wid, wars, factions, "alliance_formed");
      }
    });
    // 2. 同盟メンバー（相手側）が防衛側で参加している戦争に自動参戦 (防衛側)
    Object.values(wars.wars).forEach((war) => {
      if (!war.attackerSide || !war.defenderSide) return;
      // myFactionId (memberA) が、requesterFaction (memberB) の勢力が防衛側で参加している戦争を助ける形
      if (war.defenderSide.factions.includes(memberB)) {
        if (!war.defenderSide.factions.includes(memberA)) {
          war.defenderSide.factions.push(memberA);
        }
      }
      // 逆に requesterFaction (memberB) が myFaction (memberA) の勢力が防衛側で参加している戦争を助ける形
      if (war.defenderSide.factions.includes(memberA)) {
        if (!war.defenderSide.factions.includes(memberB)) {
          war.defenderSide.factions.push(memberB);
        }
      }
    });

    saveJSON(WARS_PATH, wars);
    io.emit("war:update", wars.wars);
    // -----------------------
    // --------------------------------------------------------------------------

    if (!myFaction.alliances) myFaction.alliances = [];
    if (!requesterFaction.alliances) requesterFaction.alliances = [];

    if (!myFaction.alliances.includes(requesterFactionId))
      myFaction.alliances.push(requesterFactionId);
    if (!requesterFaction.alliances.includes(myFactionId))
      requesterFaction.alliances.push(myFactionId);

    // 締結日時を保存
    const now = Date.now();
    if (!myFaction.allianceTimestamps) myFaction.allianceTimestamps = {};
    if (!requesterFaction.allianceTimestamps)
      requesterFaction.allianceTimestamps = {};

    myFaction.allianceTimestamps[requesterFactionId] = now;
    requesterFaction.allianceTimestamps[myFactionId] = now;

    saveJSON(FACTIONS_PATH, factions);

    const msg = `勢力「${myFaction.name}」と「${requesterFaction.name}」の同盟が締結されました！`;
    addFactionNotice(myFactionId, "同盟成立", msg, "canDiplomacy");
    addFactionNotice(requesterFactionId, "同盟成立", msg, "canDiplomacy");

    if (isNewAlliance) {
      logActivity("alliance_formed", {
        factionA: myFactionId,
        factionAName: myFaction.name,
        factionB: requesterFactionId,
        factionBName: requesterFaction.name,
        names: [myFaction.name, requesterFaction.name],
        acceptedBy: player.displayName || toShortId(req.playerId),
        allianceName: alliances[allianceId].name,
        leaderFactionName: requesterFaction.name,
      });
    } else {
      const joiningFaction =
        joiningFactionId === myFactionId ? myFaction : requesterFaction;
      const alliance = alliances[allianceId];
      const leaderFaction = factions.factions[alliance.leaderId];

      logActivity("alliance_joined", {
        factionId: joiningFactionId,
        factionName: joiningFaction.name,
        allianceId: allianceId,
        allianceName: alliance.name,
        leaderFactionName: leaderFaction ? leaderFaction.name : "不明",
        acceptedBy: player.displayName || toShortId(req.playerId),
      });
    }

    io.emit("alliance:formed", {
      factions: [myFactionId, requesterFactionId],
      names: [myFaction.name, requesterFaction.name],
    });

    io.emit("faction:updated", {
      factionId: myFactionId,
      faction: getEnrichedFaction(myFactionId, factions, players),
    });
    io.emit("alliance:memberJoined", {
      allianceId,
      factionId: requesterFactionId,
      alliance: alliances[allianceId],
    });

    res.json({ success: true });
  },
);

// 同盟脱退 (Leave)
app.post(
  "/api/factions/alliance/break",
  authenticate,
  checkGameStatus,
  (req, res) => {
    // メモ: 'targetFactionId' はペア同盟解除で使われていました。
    // グループ同盟からの脱退では対象を指定する必要はなく、単に現在の同盟から抜けるだけです。
    // ただし、ペア同盟形式をサポートし続ける場合は残すべき？
    // ユーザーのリクエストは「同盟脱退 (Leaving)」を意味します。
    // ここではグループ同盟のロジックを優先します。

    // const { targetFactionId } = req.body; // グループ同盟脱退には不要
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const alliancesData = loadJSON(ALLIANCES_PATH, { alliances: {} });
    const alliances = alliancesData.alliances || {};

    const player = players.players[req.playerId];
    const myFactionId = player.factionId;

    if (!myFactionId)
      return res.status(400).json({ error: "勢力に所属していません" });
    const myFaction = factions.factions[myFactionId];
    if (myFaction.kingId !== req.playerId)
      return res.status(403).json({ error: "権限がありません" });

    // APチェック
    if (!player.ap || player.ap < 5) {
      return res.status(400).json({ error: "APが不足しています（必要: 5AP）" });
    }

    const aid = myFaction.allianceId;
    if (!aid || !alliances[aid]) {
      // 必要であればレガシーなペア同盟チェックにフォールバック？
      // または単にエラーを返す。
      return res.status(400).json({ error: "同盟に所属していません" });
    }

    const alliance = alliances[aid];

    // 24時間制限チェック
    if (alliance.memberJoinedAt && alliance.memberJoinedAt[myFactionId]) {
      const joinedTime = new Date(
        alliance.memberJoinedAt[myFactionId],
      ).getTime();
      const nowChecked = Date.now();
      const hoursSinceJoined = (nowChecked - joinedTime) / (1000 * 60 * 60);
      if (hoursSinceJoined < 24) {
        return res.status(400).json({
          error: `加盟から24時間経過していないため脱退できません（残り: ${(24 - hoursSinceJoined).toFixed(1)}時間）`,
        });
      }
    }

    // 自分自身を削除
    alliance.members = alliance.members.filter((mid) => mid !== myFactionId);
    myFaction.allianceId = null;

    // レガシー配列が存在する場合も削除
    if (myFaction.alliances) myFaction.alliances = [];

    // 残りの同盟状態を処理
    if (alliance.members.length <= 1) {
      // 解散
      delete alliances[aid];
      // 残ったメンバーがいればクリーンアップ
      alliance.members.forEach((mid) => {
        if (factions.factions[mid]) factions.factions[mid].allianceId = null;
      });

      logActivity("alliance_disbanded", {
        message: `メンバーが脱退したため、同盟「${alliance.name}」は解散しました`,
        allianceName: alliance.name,
      });
      io.emit("alliance:disbanded", { allianceId: aid });
    } else {
      // 必要があれば盟主を更新
      if (alliance.leaderFactionId === myFactionId) {
        alliance.leaderFactionId = alliance.members[0];
        const newLeaderName =
          factions.factions[alliance.leaderFactionId]?.name || "Unknown";
        logActivity("alliance_updated", {
          message: `盟主脱退に伴い、同盟「${alliance.name}」の盟主が ${newLeaderName} に変更されました`,
          allianceId: aid,
          newLeaderId: alliance.leaderFactionId,
        });
      }

      logActivity("alliance_broken", {
        // 'broken' (または faction_left) を使用
        message: `「${myFaction.name}」が同盟「${alliance.name}」から脱退しました`,
        factionName: myFaction.name,
        allianceName: alliance.name,
        names: [myFaction.name, alliance.name], // フォーマッタのために 'names' を保証
      });

      io.emit("alliance:updated", { allianceId: aid, alliance });
    }

    // コスト (Cost)
    player.ap -= 5;
    player.lastApAction = Date.now();

    saveJSON(PLAYERS_PATH, players);
    saveJSON(FACTIONS_PATH, factions);
    saveJSON(ALLIANCES_PATH, alliancesData);

    // [不具合修正] 双方の勢力情報を更新してブロードキャスト
    io.emit("faction:updated", {
      factionId: myFactionId,
      faction: getEnrichedFaction(myFactionId, factions, players),
    });
    // 残りのメンバー（もし解散していなければ）も更新
    if (alliancesData.alliances[aid]) {
      alliancesData.alliances[aid].members.forEach((mid) => {
        io.emit("faction:updated", {
          factionId: mid,
          faction: getEnrichedFaction(mid, factions, players),
        });
      });
    }

    res.json({ success: true, message: "同盟から脱退しました" });
  },
);

// 同盟追放 (Kick)
app.post(
  "/api/factions/alliance/kick",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const { targetFactionId } = req.body;
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const alliancesData = loadJSON(ALLIANCES_PATH, { alliances: {} });
    const alliances = alliancesData.alliances || {};

    const player = players.players[req.playerId];
    const myFactionId = player.factionId;
    const myFaction = factions.factions[myFactionId];

    if (!myFaction || myFaction.kingId !== req.playerId)
      return res.status(403).json({ error: "権限がありません" });

    const aid = myFaction.allianceId;
    if (!aid || !alliances[aid])
      return res.status(400).json({ error: "同盟に所属していません" });

    const alliance = alliances[aid];

    // 制限チェック
    if (alliance.memberJoinedAt && alliance.memberJoinedAt[myFactionId]) {
      const joinedTime = new Date(
        alliance.memberJoinedAt[myFactionId],
      ).getTime();
      const nowChecked = Date.now();
      const hoursSinceJoined = (nowChecked - joinedTime) / (1000 * 60 * 60);
      if (hoursSinceJoined < ALLIANCE_LOCK_HOURS) {
        const remainingHours = Math.ceil(
          ALLIANCE_LOCK_HOURS - hoursSinceJoined,
        );
        return res.status(400).json({
          error: `加盟から${ALLIANCE_LOCK_HOURS}時間経過していないため追放できません（残り約${remainingHours}時間）`,
        });
      }
    }

    if (alliance.leaderFactionId !== myFactionId)
      return res.status(403).json({ error: "盟主のみが追放を行えます" });

    if (!alliance.members.includes(targetFactionId))
      return res
        .status(400)
        .json({ error: "対象は同盟メンバーではありません" });

    if (targetFactionId === myFactionId)
      return res
        .status(400)
        .json({ error: "自分自身を追放することはできません" });

    // 追放実行 (Execute Kick)
    alliance.members = alliance.members.filter(
      (mid) => mid !== targetFactionId,
    );

    // 対象勢力情報を更新 (Update target faction)
    const targetFaction = factions.factions[targetFactionId];
    if (targetFaction) {
      targetFaction.allianceId = null;
      if (targetFaction.alliances) targetFaction.alliances = [];
    }

    // ログ (Logs)
    logActivity("alliance_kick", {
      message: `同盟「${alliance.name}」から「${targetFaction ? targetFaction.name : targetFactionId}」が追放されました`,
      allianceName: alliance.name,
      targetFactionName: targetFaction ? targetFaction.name : "Unknown",
      kickedBy: player.displayName || toShortId(req.playerId),
    });

    saveJSON(FACTIONS_PATH, factions);
    saveJSON(ALLIANCES_PATH, alliancesData);

    io.emit("alliance:updated", { allianceId: aid, alliance });
    // 対象にも通知？
    io.emit("faction:updated", {
      factionId: targetFactionId,
      faction: getEnrichedFaction(targetFactionId, factions, players),
    });

    res.json({ success: true, message: "追放しました" });
  },
);

// 併合回答 (勢力主のみ)
app.post(
  "/api/factions/merge/respond",
  authenticate,
  checkGameStatus,
  (req, res) => {
    const { requesterFactionId, accept } = req.body;
    const factions = loadJSON(FACTIONS_PATH, { factions: {} });
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });
    const player = players.players[req.playerId];
    const myFactionId = player.factionId;

    if (!myFactionId)
      return res.status(400).json({ error: "勢力に所属していません" });
    const myFaction = factions.factions[myFactionId];
    if (
      myFaction.kingId !== req.playerId &&
      !hasPermission(myFaction, req.playerId, "canDiplomacy")
    ) {
      return res.status(403).json({ error: "外交権限がありません" });
    }

    // 修正: 文字列とオブジェクト両方のリクエスト形式に対応 (Fix: handle both string and object requests)
    const requestObj =
      myFaction.mergeRequests &&
      myFaction.mergeRequests.find((r) => {
        const rid = typeof r === "string" ? r : r.id;
        return rid === requesterFactionId;
      });

    if (!requestObj) {
      return res.status(400).json({ error: "有効な併合要請がありません" });
    }

    myFaction.mergeRequests = myFaction.mergeRequests.filter((r) => {
      const rid = typeof r === "string" ? r : r.id;
      return rid !== requesterFactionId;
    });

    if (!accept) {
      addFactionNotice(
        requesterFactionId,
        "併合拒否",
        `併合要請が、勢力「${myFaction.name}」によって拒否されました。`,
        null,
        null,
        null,
        "warning",
      );
      saveJSON(FACTIONS_PATH, factions);
      return res.json({ success: true, message: "併合要請を拒否しました" });
    }

    const requesterFaction = factions.factions[requesterFactionId];
    if (!requesterFaction) {
      saveJSON(FACTIONS_PATH, factions);
      return res.status(404).json({ error: "要請元の勢力が見つかりません" });
    }

    const oldMembers = [...requesterFaction.members];
    const oldFactionName = requesterFaction.name;

    oldMembers.forEach((mid) => {
      const p = players.players[mid];
      if (p) {
        p.factionId = myFactionId;
        if (!myFaction.members.includes(mid)) myFaction.members.push(mid);
      }
    });

    const updatedTiles = {};

    // [New] 制限チェックのため現在の中核タイル数をカウント
    let currentCoreCount = 0;
    Object.values(mapState.tiles).forEach((t) => {
      if ((t.faction || t.factionId) === myFactionId) {
        if (t.core && t.core.factionId === myFactionId) {
          currentCoreCount++;
        }
      }
    });
    const MAX_CORE_LIMIT = 2500;

    // 1. 全タイルを取得（要請元の勢力に所属するもの）
    // メモ: mapStateはリクエストの一部として読み込まれているため直接使用
    Object.entries(mapState.tiles).forEach(([key, tile]) => {
      const tileFactionId = tile.faction || tile.factionId;
      if (tileFactionId === requesterFactionId) {
        // 併合先勢力に移管
        tile.factionId = myFactionId; // 統合 (Consolidated)
        delete tile.faction; // 削除済み (REMOVED)
        tile.color = myFaction.color;

        // もし中核があれば所有権も移管
        if (tile.core) {
          if (currentCoreCount < MAX_CORE_LIMIT) {
            tile.core.factionId = myFactionId;
            delete tile.core.expiresAt; // 併合時は期限をクリア
            currentCoreCount++;
          } else {
            // 上限到達時は通常タイル化
            delete tile.core;
          }
        }

        // 塗った人の情報は一貫性のため保持（任意だが履歴として良い）
        // [Modified] ユーザー要望: 併合後も元の塗った人の情報を保持する
        // tile.paintedBy = "system_merge";
        // tile.paintedByName = "併合"; // 削除済み (REMOVED)
        // tile.paintedAt = new Date().toISOString();
        delete tile.isCorePending;
        delete tile.coreTime;

        updatedTiles[key] = tile;
      }
    });

    // [NEW] ネームドセルメタデータの所有権移管 (Transfer named cells metadata ownership)
    const namedCells = loadJSON(NAMED_CELLS_PATH, {});
    let namedCellsChanged = false;
    Object.values(namedCells).forEach((nc) => {
      if (nc.factionId === requesterFactionId) {
        nc.factionId = myFactionId;
        namedCellsChanged = true;
      }
    });
    if (namedCellsChanged) {
      saveJSON(NAMED_CELLS_PATH, namedCells);
      io.emit("namedCell:refresher"); // クライアントにネームドセルのリロードを促す
    }

    // 2. 旧メンバーの勢力情報を更新
    oldMembers.forEach((mid) => {
      const p = players.players[mid];
      if (p) {
        p.factionId = myFactionId;
        if (!myFaction.members.includes(mid)) myFaction.members.push(mid);

        // [NEW] 勢力ルームへの動的参加
        joinFactionRoom(mid, myFactionId);
      }
    });

    // 同盟メンバーリストからの削除
    if (requesterFaction.allianceId) {
      const aid = requesterFaction.allianceId;
      const alliancesData = loadJSON(ALLIANCES_PATH, { alliances: {} });
      const alliances = alliancesData.alliances || {};
      if (alliances[aid]) {
        alliances[aid].members = (alliances[aid].members || []).filter(
          (mid) => mid !== requesterFactionId,
        );
        saveJSON(ALLIANCES_PATH, alliancesData);
      }
    }

    // [主戦国]
    handleFactionDestructionInWar(requesterFactionId);
    delete factions.factions[requesterFactionId];
    saveJSON(FACTIONS_PATH, factions);
    saveJSON(PLAYERS_PATH, players);
    saveJSON(MAP_STATE_PATH, mapState);

    const msg = `勢力「${oldFactionName}」は「${myFaction.name}」に吸収合併されました。`;
    // 併合先のお知らせに追加
    addFactionNotice(myFactionId, "勢力併合", msg, "canDiplomacy");

    logActivity("faction_merged", {
      targetFactionId: myFactionId,
      targetFactionName: myFaction.name,
      sourceFactionId: requesterFactionId,
      sourceFactionName: oldFactionName,
      acceptedBy: player.displayName || toShortId(req.playerId),
    });

    io.emit("tile:update", updatedTiles);
    io.emit("faction:deleted", { factionId: requesterFactionId });
    io.emit("faction:updated", {
      factionId: myFactionId,
      faction: getEnrichedFaction(myFactionId, factions, players),
    });
    oldMembers.forEach((mid) =>
      io.emit("player:updated", {
        playerId: mid,
        player: players.players[mid],
      }),
    );

    res.json({ success: true, message: "勢力を併合しました" });
  },
);

// Socket.io 接続管理
// Socket.io 接続管理 (統合済み)
// connectedPlayers Set Logic removed in favor of playerSocketMap Logic below

// より正確な実装: 全ソケットを走査してユニークIDを数える関数を定期実行、またはイベント駆動
// イベント駆動で実装:
io.on("connection", (socket) => {
  let playerId = null;
  try {
    // cookie-parserは使えないので手動パース
    const cookies = socket.handshake.headers.cookie;
    if (cookies) {
      const cookieName = getCookieName(socket.handshake, "persistentId");
      const match = cookies.match(new RegExp(`${cookieName}=([^;]+)`));
      if (match) playerId = match[1];
    }
  } catch {
    // Ignore integrity errors in background
  }

  if (playerId) {
    socket.playerId = playerId;
    socket.join(`user:${playerId}`);

    // playerSocketMap に登録
    if (!playerSocketMap.has(playerId)) {
      playerSocketMap.set(playerId, new Set());
    }
    playerSocketMap.get(playerId).add(socket);

    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const p = players.players[playerId];
    if (p && p.factionId) {
      socket.join(`faction:${p.factionId}`);
    }

    throttledUpdateOnlineCount();
  } else {
    throttledUpdateOnlineCount();
  }

  socket.on("disconnect", () => {
    if (socket.playerId && playerSocketMap.has(socket.playerId)) {
      const set = playerSocketMap.get(socket.playerId);
      set.delete(socket);
      if (set.size === 0) {
        playerSocketMap.delete(socket.playerId);
      }
    }
    throttledUpdateOnlineCount();
  });
});

// [NEW] 勢力ルームへの動的参加・脱退ヘルパー (高速版)
function joinFactionRoom(playerId, factionId) {
  const sockets = playerSocketMap.get(playerId);
  if (sockets) {
    sockets.forEach((s) => {
      for (const room of s.rooms) {
        if (room.startsWith("faction:") && room !== `faction:${factionId}`) {
          s.leave(room);
        }
      }
      if (factionId) {
        s.join(`faction:${factionId}`);
      }
    });
  }
}

// calculateFactionPoints は shared.js に移動しました

// 全勢力のポイントを再計算 (および中核0の勢力滅亡チェック)
async function recalculateAllFactionPoints() {
  const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });
  const factions = loadJSON(FACTIONS_PATH, { factions: {} });
  const players = loadJSON(PLAYERS_PATH, { players: {} });

  // --- [PARALLEL] チャンク分割計算 ---
  const allTileKeys = Object.keys(mapState.tiles);
  const chunks = Array.from({ length: numWorkers }, () => ({}));

  allTileKeys.forEach((key) => {
    const y = parseInt(key.split("_")[1]);
    const chunkIdx = Math.min(
      numWorkers - 1,
      Math.floor((y / MAP_SIZE) * numWorkers),
    );
    chunks[chunkIdx][key] = mapState.tiles[key];
  });

  console.log(`[Rank] Recalculating all points using ${numWorkers} workers...`);

  const results = await runParallelWorkerTasks(
    "RECALCULATE_POINTS",
    {
      filePaths: {
        mapState: MAP_STATE_PATH,
        factions: FACTIONS_PATH,
        players: PLAYERS_PATH,
      },
    },
    chunks,
    (workerResults) => {
      const mergedUpdates = {};
      const mergedDestroyedFids = new Set();
      const mergedDestroyedTileKeys = {};

      workerResults.forEach((res) => {
        if (res.results) {
          // ポイントマージ
          Object.entries(res.results.updates || {}).forEach(([fid, pts]) => {
            mergedUpdates[fid] = (mergedUpdates[fid] || 0) + pts;
          });
          // 滅亡判定はメインスレッドで最終決定 (すべての中核がなくなったか)
          // ただし、Worker側ですでに判定されている場合は収集
          if (res.results.destroyedFids) {
            res.results.destroyedFids.forEach((fid) =>
              mergedDestroyedFids.add(fid),
            );
          }
          if (res.results.destroyedTileKeys) {
            Object.assign(
              mergedDestroyedTileKeys,
              res.results.destroyedTileKeys,
            );
          }
        }
      });
      return {
        updates: mergedUpdates,
        destroyedFids: Array.from(mergedDestroyedFids),
        destroyedTileKeys: mergedDestroyedTileKeys,
      };
    },
  );

  const { updates, destroyedFids, destroyedTileKeys } = results;
  let factionsChanged = false;

  // ポイント更新を反映
  Object.entries(updates).forEach(([fid, newPoints]) => {
    const f = factions.factions[fid];
    if (f && f.territoryPoints !== newPoints) {
      f.territoryPoints = newPoints;
      f.totalPoints = (f.territoryPoints || 0) + (f.bonusPoints || 0);
      factionsChanged = true;
    }
  });

  // 滅亡処理を実行
  let mapChanged = false;
  let playersChanged = false;

  for (const fid of destroyedFids) {
    const faction = factions.factions[fid];
    if (faction) {
      console.log(
        `[DestructionCheck] Faction ${faction.name} (${fid}) has 0 cores. Destroying...`,
      );
      if (faction.members) {
        faction.members.forEach((mid) => {
          if (players.players[mid]) {
            players.players[mid].factionId = null;
            playersChanged = true;
          }
        });
      }
      addLog(
        "faction_destroyed",
        `勢力「${faction.name}」は中核マスをすべて失い、滅亡しました。`,
        fid,
      );
      io.emit("faction:destroyed", { factionId: fid, name: faction.name });

      // [OPTIMIZED] Worker から送られたタイルリストを使用して削除 (全走査を回避)
      const factionTileKeys = destroyedTileKeys[fid] || [];
      const updatedTilesForEmit = {};
      factionTileKeys.forEach((key) => {
        delete mapState.tiles[key];
        updatedTilesForEmit[key] = null;
        mapChanged = true;
      });

      delete factions.factions[fid];
      factionsChanged = true;
      io.emit("tile:update", updatedTilesForEmit);

      const noticesData = loadJSON(FACTION_NOTICES_PATH, {});
      if (faction.members) {
        faction.members.forEach((mid) => {
          const personalKey = `user:${mid}`;
          if (!noticesData[personalKey]) noticesData[personalKey] = [];
          noticesData[personalKey].push({
            id: `notice-destroy-core-${Date.now()}-${mid}`,
            title: "所属勢力の滅亡",
            content: `所属していた勢力「${faction.name}」は中核マスをすべて失い、滅亡しました。`,
            date: new Date().toISOString(),
            type: "system",
          });
        });
        saveJSON(FACTION_NOTICES_PATH, noticesData);
      }
    }
  }

  if (mapChanged) saveJSON(MAP_STATE_PATH, mapState);
  if (factionsChanged) saveJSON(FACTIONS_PATH, factions);
  if (playersChanged) saveJSON(PLAYERS_PATH, players);

  checkAllianceAndWarIntegrity();
  checkMapIntegrity();

  return { updates, destroyedFids, destroyedTileKeys };
}

// [NEW] マップ整合性チェックのバッチ実行
async function runBatchIntegrityCheck() {
  // StartY:StartY+Step ...
  const chunks = [];
  const chunkSize = Math.ceil(500 / numWorkers); // 500x500 map
  for (let i = 0; i < numWorkers; i++) {
    chunks.push({
      startY: i * chunkSize,
      endY: Math.min((i + 1) * chunkSize, 500),
      // 必要な場合はここで追加データを渡すが、WorkerはloadJSONまたはSABを使用する前提
      // mapStateは大きいので渡さない
    });
  }

  const { coreTileSettings } = loadJSON(SYSTEM_SETTINGS_PATH, {});

  console.log(
    `[Integrity] Starting parallel integrity check (Workers: ${numWorkers})...`,
  );

  try {
    const results = await runParallelWorkerTasks(
      "CHECK_INTEGRITY_PARTIAL",
      {
        filePaths: {
          mapState: MAP_STATE_PATH,
          factions: FACTIONS_PATH,
        },
        coreTileSettings,
      },
      chunks,
      (res) => {
        // res is array of { success, results: { updatedTiles, stats }, ... }
        let updates = {};
        // statsは必要ならマージするが、IntegrityCheckの結果としてはupdatedTilesが重要
        res.forEach((r) => {
          if (r.results && r.results.updatedTiles) {
            Object.assign(updates, r.results.updatedTiles);
          }
        });
        return { updatedTiles: updates };
      },
    );

    if (results && results.updatedTiles) {
      const updates = results.updatedTiles;
      const updateCount = Object.keys(updates).length;
      if (updateCount > 0) {
        console.log(`[Integrity] Found ${updateCount} tiles to update.`);
        // Apply updates to in-memory mapState and queue save
        // mapState (local var here) is stale? No, we just loaded it.
        // But queueMapUpdate expects us to update the global state or what?
        // Server.js doesn't seem to hold a global 'mapState' variable visible here?
        // Wait, loadJSON returns a new object.
        // If we update this local 'mapState', it doesn't affect the system unless we save it.
        // 'queueMapUpdate' (line 1202) takes 'updates' argument?
        // Let's check line 1202 usage.

        // If queueMapUpdate takes 'updates' (map of changes), then we just call it.
        await updateJSON(MAP_STATE_PATH, (data) => {
          Object.entries(updates).forEach(([key, tile]) => {
            if (tile === null) {
              delete data.tiles[key];
            } else {
              data.tiles[key] = tile;
            }
          });
          return true;
        });
        batchEmitTileUpdate(updates);
      } else {
        console.log("[Integrity] No integrity issues found.");
      }
    }
  } catch (err) {
    console.error("[Integrity] Batch check failed:", err);
  }
}

async function checkMapIntegrity() {
  await runBatchIntegrityCheck();
}

/**
 * [PARALLEL] マップ全体の整合性チェック (worker並列実行)
 * - 勢力色の同期
 * - カスタム色の包囲判定による解除
 * - 中核タイルの期限切れ/永続化判定
 */

// [OPTIMIZATION] 中核化維持・確定・自動拡大処理 (Worker完全オフロード版)

// 同盟と戦争の整合性チェック (定期実行)
async function checkAllianceAndWarIntegrity() {
  console.log("[Diplomacy] Offloading diplomacy validation to Worker...");
  const result = await runWorkerTask("VALIDATE_DIPLOMACY", {
    filePaths: {
      alliances: ALLIANCES_PATH,
      wars: WARS_PATH,
      factions: FACTIONS_PATH,
    },
  });

  if (!result.success) {
    console.error("[Diplomacy] Worker failed:", result.error);
    return;
  }

  const { alliances, wars, factions, allianceUpdated, warUpdated } =
    result.results;

  if (allianceUpdated) {
    console.log("[Diplomacy] Alliance updates detected.");
    await updateJSON(ALLIANCES_PATH, () => alliances);
    await updateJSON(FACTIONS_PATH, () => factions);
  }

  if (warUpdated) {
    console.log("[Diplomacy] War updates detected.");
    await updateJSON(WARS_PATH, () => wars);
  }
}

// ===== Season 2: 毎時00分の継続ボーナス処理 =====
// 勢力ごとの中核マスを拡大更新する (整合性チェック兼務)

// 全勢力の中核マスの整合性チェックと拡大
async function recalculateAllFactionCores() {
  console.log("[CoreSync] Offloading full core synchronization to Worker...");
  const result = await runWorkerTask("RECALCULATE_CORES", {
    filePaths: {
      mapState: MAP_STATE_PATH,
      factions: FACTIONS_PATH,
    },
  });

  if (result.success && result.results && result.results.changed) {
    console.log(
      "[CoreSync] Sync complete (Changes detected and saved by Worker).",
    );
    if (
      result.results.updatedTiles &&
      Object.keys(result.results.updatedTiles).length > 0
    ) {
      io.emit("tile:update", result.results.updatedTiles);
    }
  }
}

// [NEW] Process Coreification Countdowns (Workerized)

// [NEW] ログ追加ヘルパー (スケジュールタスク等でグローバルに利用可能) (Log helper available globally)
function addLog(type, content, factionId = null) {
  const logData = loadJSON(ACTIVITY_LOG_PATH, { entries: [] });
  // Ensure we have an array
  let logs = Array.isArray(logData) ? logData : logData.entries || [];

  const newLog = {
    id: Date.now(), // 既存の形式に合わせ数値ID (numeric id based on existing json)
    type,
    content, // クライアントがシステムログ専用の構造を期待している場合は調整が必要だが、サイドバーは文字列を表示するだけ。
    // 実際にはサイドバーは特定の構造を期待する場合がある？ Sidebar.jsx: getLogCategory(log) uses log.type.
    // getSidebarLogMessage uses getLogWithIcon.
    // typeが 'system' の場合、getLogWithIcon は log.content を返す。
    factionId,
    timestamp: new Date().toISOString(),
  };

  logs.unshift(newLog);
  if (logs.length > 100) logs.pop(); // ログ上限 (Limit logs)

  // 正しい形式で保存 (Save back in correct format)
  if (Array.isArray(logData)) {
    saveJSON(ACTIVITY_LOG_PATH, logs);
  } else {
    logData.entries = logs;
    saveJSON(ACTIVITY_LOG_PATH, logData);
  }

  // クライアントは通常 'entries' を期待する？
  // 他のエンドポイントがどのように更新をemitしているか確認。
  // よくあるパターン: io.emit("activity_log:update", logs);
  // クライアントが { entries: [...] } を期待するか [...] そのものを期待するか、一貫性が必要。
  // クライアントの Sidebar は activityLog prop を使用。
  // ActivityLogModal は activityLog prop を使用。
  // App.jsx で "activity_log:update" をどう処理しているか確認。

  io.emit("activity:new", newLog);
}

// 毎日00:00の特別タイルボーナス
async function processDailyBonus() {
  const settings = loadJSON(SYSTEM_SETTINGS_PATH, { lastDailyBonusDate: "" });
  const today = new Date().toLocaleDateString("ja-JP");

  if (settings.lastDailyBonusDate === today) {
    console.log("[DailyBonus] Already processed for today:", today);
    return;
  }

  const mapState = loadJSON(MAP_STATE_PATH, { tiles: {} });
  const allTileKeys = Object.keys(mapState.tiles);

  // チャンク分割 (Y座標ベース)
  const CHUNK_COUNT = 4;
  const chunks = Array.from({ length: CHUNK_COUNT }, () => ({}));
  allTileKeys.forEach((key) => {
    const y = parseInt(key.split("_")[1]);
    const chunkIdx = Math.min(
      CHUNK_COUNT - 1,
      Math.floor((y / MAP_SIZE) * CHUNK_COUNT),
    );
    chunks[chunkIdx][key] = mapState.tiles[key];
  });

  console.log(
    "[DailyBonus] Starting parallel daily bonus processing (4 workers)...",
  );

  const parallelResults = await runParallelWorkerTasks(
    "PROCESS_DAILY_BONUS",
    {
      filePaths: {
        factions: FACTIONS_PATH,
      },
    },
    chunks,
    (results) => {
      const mergedStats = {};
      const mergedUpdatedTiles = {};
      let totalResetCount = 0;
      results.forEach((res) => {
        if (res.results) {
          // statsマージ
          Object.entries(res.results.stats || {}).forEach(([fid, count]) => {
            mergedStats[fid] = (mergedStats[fid] || 0) + count;
          });
          // updatedTilesマージ
          Object.assign(mergedUpdatedTiles, res.results.updatedTiles || {});
          // resetCountマージ
          totalResetCount += res.results.resetCount || 0;
        }
      });
      return {
        stats: mergedStats,
        updatedTiles: mergedUpdatedTiles,
        resetCount: totalResetCount,
      };
    },
  );

  if (!parallelResults.success) {
    console.error(
      "[DailyBonus] Parallel processing failed:",
      parallelResults.error,
    );
    return;
  }

  const { stats, updatedTiles, resetCount } = parallelResults;

  // 1. ネームドマスのリセット反映
  if (resetCount > 0) {
    console.log(
      `[DailyBonus] Reset siege bonus for ${resetCount} named tiles.`,
    );
    await updateJSON(MAP_STATE_PATH, (map) => {
      Object.entries(updatedTiles).forEach(([key]) => {
        if (map.tiles[key]) {
          map.tiles[key].namedData.siegeBonus = 0;
        }
      });
      return map;
    });
    io.emit("tile:update", updatedTiles);
  }

  // 2. ポイント加算
  if (Object.keys(stats).length > 0) {
    await updateJSON(FACTIONS_PATH, (factionsData) => {
      Object.entries(stats).forEach(([fid, count]) => {
        if (factionsData.factions[fid]) {
          const points = count * 1; // 1タイル1ポイント
          factionsData.factions[fid].bonusPoints =
            (factionsData.factions[fid].bonusPoints || 0) + points;
          console.log(
            `[DailyBonus] Awarded ${points} bonus points to ${factionsData.factions[fid].name} (${fid})`,
          );

          // ログ記録
          addLog(
            "system",
            `📅 日次ボーナス: ${factionsData.factions[fid].name} に特別タイルボーナス ${points}pt が加算されました (保有数: ${count})`,
            fid,
          );
        }
      });
      return factionsData;
    });

    // ポイントが変わったのでランキング再計算をトリガー
    recalculateAllFactionPoints();
    io.emit("faction:pointsUpdated", {});
  } else {
    console.log("[DailyBonus] No special tiles held by any faction.");
  }

  // 3. 完了設定を保存
  await updateJSON(SYSTEM_SETTINGS_PATH, (s) => {
    s.lastDailyBonusDate = today;
    return s;
  });

  console.log("[DailyBonus] Processing complete for:", today);
}

// [NEW] 塗りコスト見積もりAPI (Worker分散化)
// [NEW] 塗りコスト見積もりAPI (Worker分散化・並列化)
app.post(
  "/api/tiles/estimate",
  authenticate,
  checkGameStatus,
  async (req, res) => {
    const { tiles, action, overpaintCount } = req.body; // action: 'paint' | 'overpaint'
    const players = loadJSON(PLAYERS_PATH, { players: {} });
    const player = players.players[req.playerId];

    if (!player) {
      return res.status(401).json({ error: "ユーザーが見つかりません" });
    }
    if (!player.factionId) {
      return res.status(400).json({ error: "勢力に所属していません" });
    }

    try {
      // [OPTIMIZATION] 大規模な塗装見積もり（300マス以上）の場合は並列化
      const threshold = 300;
      if (tiles.length >= threshold && numWorkers > 1) {
        const chunkSize = Math.ceil(tiles.length / numWorkers);
        const tasks = [];
        for (let i = 0; i < numWorkers; i++) {
          const chunk = tiles.slice(i * chunkSize, (i + 1) * chunkSize);
          if (chunk.length > 0) {
            tasks.push(
              runWorkerTask("PREPARE_PAINT_PARTIAL", {
                tiles: chunk,
                fullTiles: tiles, // クラスタ判定の一貫性のために全体を渡す
                player,
                action,
                overpaintCount: overpaintCount || 1,
              }),
            );
          }
        }

        const results = await Promise.all(tasks);

        // エラーチェック
        for (const r of results) {
          if (!r.success) {
            return res.status(200).json({
              success: false,
              error: r.error,
              code: r.code,
            });
          }
        }

        // 結果のマージ
        let totalCost = 0;
        let destructionInvolved = false;
        let needsWarDeclaration = false;
        let extraCost = 0;
        const successRates = [];
        let targetFactionName = null;
        let targetFactionId = null;

        results.forEach((r) => {
          totalCost += r.results.cost;
          if (r.results.destructionInvolved) destructionInvolved = true;
          if (r.results.needsWarDeclaration) needsWarDeclaration = true;
          extraCost += r.results.extraCost || 0;
          if (r.results.successRates)
            successRates.push(...r.results.successRates);
          if (r.results.targetFactionName)
            targetFactionName = r.results.targetFactionName;
          if (r.results.targetFactionId)
            targetFactionId = r.results.targetFactionId;
        });

        return res.json({
          success: true,
          cost: totalCost,
          destructionInvolved,
          successRates,
          targetFactionName,
          targetFactionId,
          needsWarDeclaration,
          extraCost,
        });
      }

      // 通常サイズまたは並列化不可時は既存の Worker タスクを使用
      const response = await runWorkerTask("PREPARE_PAINT", {
        tiles,
        player,
        action,
        overpaintCount: overpaintCount || 1,
      });

      if (!response.success) {
        // ZOC_BLOCKなどのエラーコードが含まれる場合はそのまま返す
        return res.status(200).json({
          success: false,
          error: response.error,
          code: response.code,
        });
      }

      // 成功時はコスト計算結果を返す
      res.json({
        success: true,
        cost: response.results.cost,
        destructionInvolved: response.results.destructionInvolved,
        successRates: response.results.successRates,
        targetFactionName: response.results.targetFactionName,
        targetFactionId: response.results.targetFactionId,
        needsWarDeclaration: response.results.needsWarDeclaration,
        extraCost: response.results.extraCost,
      });
    } catch (e) {
      console.error("[EstimateError]", e);
      res.status(500).json({ error: "見積もり計算中にエラーが発生しました" });
    }
  },
);

// 毎分のチェック (00:00を検知するため)
function scheduleDailyBonus() {
  setInterval(
    () => {
      const now = new Date();
      // 5分間隔になったため、00:00〜00:04の間であれば実行するように変更
      if (now.getHours() === 0 && now.getMinutes() < 5) {
        processDailyBonus();
      }
    },
    5 * 60 * 1000,
  ); // 5分ごとにチェック
}
// 起動時にもチェック (サーバー再起動跨ぎ対応)
setTimeout(processDailyBonus, 5000); // 起動5秒後に一度だけチェック(同日未実行なら走る)
scheduleDailyBonus();

// [REMOVED] scheduleHourlyBonus function and call removed as per user request

// 初回起動時に全勢力のポイントを計算
recalculateAllFactionPoints();

// 勢力が滅亡（吸収合併・解散）した際の外交データクリーンアップ
function cleanupDestroyedFaction(factionId) {
  console.log(
    `[Cleanup] Cleaning up diplomacy data for destroyed faction: ${factionId}`,
  );
  const factionsData = loadJSON(FACTIONS_PATH, { factions: {} });
  const alliancesData = loadJSON(ALLIANCES_PATH, { alliances: {} });
  const warsData = loadJSON(WARS_PATH, { wars: {} });
  const trucesData = loadJSON(TRUCES_PATH, { truces: {} });

  let factionsUpdated = false;
  let alliancesUpdated = false;
  let warsUpdated = false;
  let trucesUpdated = false;

  // 1. 同盟 (Alliances)
  Object.entries(alliancesData.alliances).forEach(([aid, alliance]) => {
    if (alliance.members.includes(factionId)) {
      alliance.members = alliance.members.filter((fid) => fid !== factionId);
      alliancesUpdated = true;

      // メンバーがいなくなったら解散
      if (alliance.members.length === 0) {
        delete alliancesData.alliances[aid];
        console.log(`[Cleanup] Disbanded empty alliance: ${aid}`);
      } else if (alliance.leaderId === factionId) {
        // リーダー交代
        alliance.leaderId = alliance.members[0];
        console.log(
          `[Cleanup] Transferred alliance leadership to: ${alliance.leaderId}`,
        );
      }
    }
  });

  // 各勢力の allianceId 整合性チェック
  Object.values(factionsData.factions).forEach((f) => {
    if (f.allianceId && !alliancesData.alliances[f.allianceId]) {
      f.allianceId = null;
      if (f.alliances)
        f.alliances = f.alliances.filter((aid) => alliancesData.alliances[aid]);
      factionsUpdated = true;
    }
  });

  // 2. 戦争 (Wars)
  Object.entries(warsData.wars).forEach(([wid, war]) => {
    const sides = [war.attackerSide, war.defenderSide];
    let warEnded = false;

    for (const side of sides) {
      if (side.factions.includes(factionId)) {
        side.factions = side.factions.filter((fid) => fid !== factionId);
        warsUpdated = true;

        if (side.factions.length === 0) {
          warEnded = true;
        } else if (side.leaderId === factionId) {
          side.leaderId = side.factions[0];
        }
      }
    }

    if (warEnded) {
      delete warsData.wars[wid];
      console.log(`[Cleanup] Ended war due to faction destruction: ${wid}`);
    }
  });

  // 3. 停戦 (Truces)
  Object.keys(trucesData.truces).forEach((truceKey) => {
    if (truceKey.includes(factionId)) {
      delete trucesData.truces[truceKey];
      trucesUpdated = true;
      console.log(
        `[Cleanup] Removed truce involving destroyed faction: ${truceKey}`,
      );
    }
  });

  // 保存
  if (alliancesUpdated) saveJSON(ALLIANCES_PATH, alliancesData);
  if (warsUpdated) saveJSON(WARS_PATH, warsData);
  if (trucesUpdated) {
    saveJSON(TRUCES_PATH, trucesData);
    io.emit("truce:update", trucesData.truces);
  }
  if (factionsUpdated) saveJSON(FACTIONS_PATH, factionsData);

  if (alliancesUpdated || warsUpdated || trucesUpdated) {
    // クライアント側に更新を通知 (必要に応じて)
    io.emit("diplomacy:cleanup", { factionId });
  }
}

// 同盟・戦争の定期整合性チェック (既存のvalidateAllianceIntegrityを拡張)
function validateDiplomacyIntegrity() {
  console.log("[Integrity] Validating alliance data headers...");
  const factionsData = loadJSON(FACTIONS_PATH, { factions: {} });
  const alliancesData = loadJSON(ALLIANCES_PATH, { alliances: {} });

  const factions = factionsData.factions || {};
  const alliances = alliancesData.alliances || {};

  // デバッグログ: 読み込んだ同盟データを表示
  console.log(
    `[Integrity] Loaded ${Object.keys(alliances).length} alliances from disk:`,
    Object.keys(alliances),
  );

  let fixedCount = 0;

  Object.values(factions).forEach((faction) => {
    // allianceId があるのに同盟データが存在しない場合
    if (faction.allianceId && !alliances[faction.allianceId]) {
      console.warn(
        `[Integrity] Initializing invalid allianceId for faction ${faction.name} (${faction.id}). ID: ${faction.allianceId}`,
      );

      faction.allianceId = null;
      faction.alliances = []; // 配列もクリア
      if (faction.allianceTimestamps) {
        delete faction.allianceTimestamps;
      }

      fixedCount++;
    } else if (faction.allianceId && alliances[faction.allianceId]) {
      // 同盟データはあるが、alliances配列に含まれていない場合は修復
      if (
        !Array.isArray(faction.alliances) ||
        !faction.alliances.includes(faction.allianceId)
      ) {
        console.log(
          `[Integrity] Fixing alliances array for faction ${faction.name}`,
        );
        faction.alliances = [faction.allianceId];
        fixedCount++;
      }
    }
  });

  if (fixedCount > 0) {
    console.log(
      `[Integrity] Fixed ${fixedCount} faction alliance inconsistencies.`,
    );
    saveJSON(FACTIONS_PATH, factionsData);
  } else {
    console.log("[Integrity] No alliance inconsistencies found.");
  }
}

validateDiplomacyIntegrity();

// [REFRACTOR] Direct Disk Access Mode
// Data is always on disk, so "save all" is not needed.
// function saveAllGameData() { ... } (Removed)

// シャットダウン時にメモリ上のデータをディスクに保存
async function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] ${signal} received. Saving all pending data...`);

  // [OPTIMIZATION] 未保存の全ての変更を強制保存
  const promises = [];

  // Always check for map save, regardless of declared pending count
  console.log(`[Shutdown] Saving map changes (Force)...`);
  promises.push(persistMapState());

  if (playerSaveTimer || FILE_CACHE.has(PLAYERS_PATH)) {
    console.log("[Shutdown] Saving pending player changes...");
    promises.push(persistPlayerState());
  }

  if (factionSaveTimer || FILE_CACHE.has(FACTIONS_PATH)) {
    console.log("[Shutdown] Saving pending faction changes...");
    promises.push(persistFactionState());
  }

  if (pendingActivityLogs.length > 0 || activityLogSaveTimer) {
    console.log(
      `[Shutdown] Saving ${pendingActivityLogs.length} pending activity logs...`,
    );
    promises.push(persistActivityLogs());
  }

  try {
    // [FIX] Wait for all saves to complete
    console.log(`[Shutdown] Waiting for ${promises.length} save operations...`);
    await Promise.all(promises);
    console.log("[Shutdown] All persistence promises resolved.");
  } catch (err) {
    console.error("[Shutdown] Error saving pending data:", err);
  }

  // saveAllGameData is empty, so we rely on the above persists.
  // saveAllGameData();

  console.log("[Shutdown] All data saved. Exiting...");
  process.exit(0);

  console.log("[Shutdown] All data saved. Exiting...");
  process.exit(0);
}

// シャットダウンシグナルをキャッチ
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// 予期せぬエラーのキャッチ (Emergency Save)
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION! Attempting emergency save...", err);
  gracefulShutdown("UNCAUGHT_EXCEPTION");
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION! Attempting emergency save...", reason);
  gracefulShutdown("UNHANDLED_REJECTION");
});

// Windowsでの Ctrl+C 対応
if (process.platform === "win32") {
  const rl = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

// [REFRACTOR] 冗長な強制保存ループを削除 (Continuous Force Save loop removed)

// [REFRACTOR] 定期的な中核整合性チェックループを runScheduledTasks に統合 (Periodic Core Integrity Check loop merged into runScheduledTasks)

// グローバルエラーハンドラ (Global Error Handler)
app.use((err, req, res, next) => {
  console.error("Global Error Handler Caught:", err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({
    error: "サーバー内部エラーが発生しました (Global Catch)",
    details: err.message,
  });
});

const PORT = process.env.PORT || 3001;
// [NEW] システムユーザーの存在確認と自動修復
const playersForSystem = loadJSON(PLAYERS_PATH, { players: {} });
if (!playersForSystem.players["system-capture"]) {
  console.log("[System] Creating system-capture user...");
  playersForSystem.players["system-capture"] = {
    id: "system-capture",
    username: "system-capture",
    displayName: "System Capture",
    passwordHash: "",
    ap: 9999,
    lastApUpdate: 1770000000000,
    createdAt: new Date().toISOString(),
    lastIps: ["127.0.0.1"],
    lastApAutoUpdate: 1770000000000,
    factionId: null,
    lastFactionCreated: 0,
    lastApAction: 0,
  };
  saveJSON(PLAYERS_PATH, playersForSystem);
}

// サーバー起動
server.listen(PORT, "0.0.0.0", async () => {
  console.log(`サーバー起動: http://localhost:${PORT} (PID: ${process.pid})`);

  // [NEW] 起動時整合性チェック (Worker)
  console.log("[Init] Running startup consistency check via Worker...");
  try {
    const result = await runWorkerTask("CHECK_CONSISTENCY", {
      filePaths: {
        mapState: MAP_STATE_PATH,
        factions: FACTIONS_PATH,
        namedCells: NAMED_CELLS_PATH,
      },
    });
    if (result.success) {
      if (result.results.changed) {
        console.log(
          `[Init] Consistency check completed. Reset ${result.results.resetCount} tiles, Changed: ${result.results.changed}`,
        );
        if (result.results.mapState) {
          // Workerから受け取った修正済みデータを保存
          await saveJSON(MAP_STATE_PATH, result.results.mapState);
        }
        if (result.results.namedCells) {
          // ネームドマスのクリーンアップ結果を保存
          await saveJSON(NAMED_CELLS_PATH, result.results.namedCells);
        }
      } else {
        console.log("[Init] Consistency check passed (No issues found).");
      }
    } else {
      console.error("[Init] Consistency check failed:", result.error);
    }
  } catch (e) {
    console.error("[Init] Error during consistency check:", e);
  }

  // [NEW] 起動時に全勢力の共有APをチェックして上限を超えている場合は修正
  try {
    const factionsData = loadJSON(FACTIONS_PATH, { factions: {} });
    const playersData = loadJSON(PLAYERS_PATH, { players: {} });
    let hasChanges = false;

    for (const fid in factionsData.factions) {
      const changed = await clampFactionSharedAP(
        fid,
        factionsData,
        playersData,
      );
      if (changed) hasChanges = true;
    }

    if (hasChanges) {
      saveJSON(FACTIONS_PATH, factionsData);
      console.log("[起動時チェック] 共有AP上限超過を修正しました");
    }
  } catch (err) {
    console.error("[起動時チェック] 共有APチェックエラー:", err);
  }
});

// 停戦申請の期限切れチェック
const checkTruceRequestExpirations = async () => {
  try {
    await updateJSON(FACTIONS_PATH, (data) => {
      const factions = data.factions;
      let changed = false;
      const expiredRequests = []; // { requester: id, target: id, expiry: string }

      // 全勢力の受信リクエストをチェック
      Object.values(factions).forEach((targetFaction) => {
        if (
          !targetFaction.truceRequestsReceived ||
          targetFaction.truceRequestsReceived.length === 0
        )
          return;

        const remaining = [];
        targetFaction.truceRequestsReceived.forEach((req) => {
          const reqObj = typeof req === "string" ? { id: req } : req;

          // 期限が設定されていない場合は対象外（またはデフォルト扱いだが、今回は明示されたもののみ対象とする）
          // 期限情報が無い場合はスキップ（従来通り手動拒否待ち）
          if (!reqObj.expiresAt) {
            remaining.push(req);
            return;
          }

          const expiryTime = new Date(reqObj.expiresAt).getTime();
          // 期限の5分前 (5 * 60 * 1000 ms)
          // if (now > expiry - 5min) -> expire
          const threshold = expiryTime - 5 * 60 * 1000;
          if (Date.now() > threshold) {
            // 期限切れ (無効化)
            expiredRequests.push({
              requester: reqObj.id,
              target: targetFaction.id,
              expiry: reqObj.expiresAt,
            });
            changed = true;
          } else {
            remaining.push(req);
          }
        });

        if (targetFaction.truceRequestsReceived.length !== remaining.length) {
          targetFaction.truceRequestsReceived = remaining;
        }
      });

      // 申請元の方も掃除 & 通知イベント発火
      expiredRequests.forEach((exp) => {
        const requesterFaction = factions[exp.requester];
        const targetFaction = factions[exp.target];

        if (requesterFaction && requesterFaction.truceRequests) {
          requesterFaction.truceRequests =
            requesterFaction.truceRequests.filter((req) => {
              const id = typeof req === "string" ? req : req.id;
              return id !== exp.target;
            });
          changed = true;
        }

        // 通知
        io.emit("truce:expired", {
          requesterFactionId: exp.requester,
          requesterFactionName: requesterFaction
            ? requesterFaction.name
            : "不明な勢力",
          targetFactionId: exp.target,
          targetFactionName: targetFaction ? targetFaction.name : "不明な勢力",
          expiresAt: exp.expiry,
        });
      });

      return changed ? data : null;
    });
  } catch (e) {
    console.error("Error in checkTruceRequestExpirations:", e);
  }
};

setInterval(checkTruceRequestExpirations, 60 * 1000); // 1分ごとにチェック

// ===== 全体マップ画像生成 =====
const FULL_MAP_IMAGE_DIR = path.join(DATA_DIR, "map_images");
const FULL_MAP_IMAGE_PATHS = {
  faction_full: path.join(FULL_MAP_IMAGE_DIR, "faction_full.png"),
  faction_simple: path.join(FULL_MAP_IMAGE_DIR, "faction_simple.png"),
  alliance: path.join(FULL_MAP_IMAGE_DIR, "alliance.png"),
};

// ディレクトリ作成
if (!fs.existsSync(FULL_MAP_IMAGE_DIR)) {
  fs.mkdirSync(FULL_MAP_IMAGE_DIR, { recursive: true });
}

// 全体マップ画像を生成する関数（node-canvas方式 - Workerオフロード版）
async function generateFullMapImageTask() {
  try {
    console.log("[FullMapImage] Requesting node-canvas generation (Worker)...");

    // 全モード分のタスクを並列実行
    const modes = ["faction_full", "faction_simple", "alliance"];
    const tasks = modes.map(async (mode) => {
      const filename = `${mode}.png`;
      const outputPath = path.join(DATA_DIR, "map_images", filename);

      const response = await runWorkerTask("GENERATE_FULL_MAP_IMAGE", {
        filePaths: {
          mapState: MAP_STATE_PATH,
          factions: FACTIONS_PATH,
          namedCells: NAMED_CELLS_PATH,
          alliances: ALLIANCES_PATH,
        },
        outputPath,
        mode,
      });

      return {
        success: response.success,
        path: response.success ? response.results.outputPath : null,
        error: response.success ? null : response.error,
        mode,
      };
    });

    const results = await Promise.all(tasks);

    results.forEach((result) => {
      if (result.success) {
        console.log(`[FullMapImage] Image generated: ${result.path}`);
        io.emit("map:image_updated", {
          mode: result.mode,
          timestamp: Date.now(),
        });
      } else {
        console.error(
          `[FullMapImage] Failed (${result.mode}): ${result.error}`,
        );
      }
    });
  } catch (e) {
    console.error("[FullMapImage] Generation error:", e);
  }
}

// 動的スケジューラ管理
let mapImageIntervalId = null;

function updateMapImageScheduler(intervalMinutes) {
  // 既存のインターバルをクリア
  if (mapImageIntervalId) {
    clearInterval(mapImageIntervalId);
  }

  const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
  console.log(`[FullMapImage] Scheduler updated: ${intervalMinutes} minute(s)`);

  // 新しいインターバルを設定
  mapImageIntervalId = setInterval(generateFullMapImageTask, intervalMs);
}

// 起動時に初回生成とスケジューラ設定
setTimeout(() => {
  generateFullMapImageTask();

  // 設定からインターバルを取得
  const settings = loadJSON(SYSTEM_SETTINGS_PATH, {});
  const intervalMinutes = settings.mapImageSettings?.intervalMinutes || 1;
  updateMapImageScheduler(intervalMinutes);
}, 5000);

// /map - 全体マップ画像を表示するHTMLページ（3パターン切り替え対応）
app.get("/map", (req, res) => {
  // [FIX] このページはSharedArrayBufferを使用せず、Socket.IOスクリプト(CORPなし)を読み込むため、
  // COEPを無効化してブロックを防ぐ
  res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
  res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");

  const settings = loadJSON(SYSTEM_SETTINGS_PATH, {});
  const intervalMinutes = settings.mapImageSettings?.intervalMinutes || 1;

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>庭園勢力図 - 全体マップ</title>
  <style>
    body {
      margin: 0;
      background: #1a1a2e;
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    h1 {
      color: #fff;
      margin: 20px 0;
      font-size: 1.5rem;
    }
    .info {
      color: #aaa;
      font-size: 0.9rem;
      margin-bottom: 10px;
    }
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    .tab {
      padding: 8px 16px;
      background: #2d2d44;
      color: #aaa;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.9rem;
      transition: all 0.2s;
    }
    .tab:hover {
      background: #3d3d55;
    }
    .tab.active {
      background: #4a9eff;
      color: #fff;
    }
    .map-container {
      max-width: 100%;
      padding: 10px;
    }
    img {
      max-width: 100%;
      height: auto;
      border: 2px solid #333;
      border-radius: 8px;
    }
    .back-link {
      margin-top: 20px;
      margin-bottom: 40px;
    }
    .back-link a {
      color: #60a5fa;
      text-decoration: none;
    }
    .back-link a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <h1>🗺️ 庭園勢力図 - 全体マップ</h1>
  <p class="info">${intervalMinutes}分ごとに自動更新されます。右クリックで画像を保存できます。</p>

  <div class="tabs">
    <button class="tab active" onclick="switchTab('faction_full')">勢力表示（詳細）</button>
    <button class="tab" onclick="switchTab('faction_simple')">勢力表示（シンプル）</button>
    <button class="tab" onclick="switchTab('alliance')">同盟表示</button>
  </div>

  <div class="map-container">
    <img id="mapImage" src="/map/image?mode=faction_full&t=${Date.now()}" alt="全体マップ" />
  </div>

  <div class="back-link">
    <a href="/">← ゲームに戻る</a>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();

    // システム設定更新イベント
    socket.on("system:settings_updated", (data) => {
       if (data.mapImageSettings && data.mapImageSettings.intervalMinutes) {
          const min = data.mapImageSettings.intervalMinutes;
          const infoEl = document.querySelector(".info");
          if (infoEl) {
             infoEl.textContent = \`\${min}分ごとに自動更新されます。右クリックで画像を保存できます。\`;
          }
       }
    });

    // マップ画像更新イベント
    socket.on("map:image_updated", (data) => {
       console.log("Map updated:", data);
       // 現在のアクティブなタブを特定
       const activeTab = document.querySelector(".tab.active");
       if (!activeTab) return;

       // クリックイベントの引数からモードを判定するのは難しいので、
       // 現在のimg srcから判定するか、data.modeと照合する
       // ここではシンプルに、現在のsrcに含まれるmodeパラメータと一致したらリロードする
       const img = document.getElementById("mapImage");
       const currentSrc = img.src;

       if (currentSrc.includes(\`mode=\${data.mode}\`)) {
          // 画像リロード (キャッシュバスティング)
          img.src = \`/map/image?mode=\${data.mode}&t=\${data.timestamp}\`;

          // フラッシュ効果
          img.style.opacity = "0.5";
          setTimeout(() => img.style.opacity = "1", 200);
       }
    });

    function switchTab(mode) {
      // タブのアクティブ状態を更新
      document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
      event.target.classList.add('active');

      // 画像を切り替え
      document.getElementById('mapImage').src = '/map/image?mode=' + mode + '&t=' + Date.now();
    }
  </script>
</body>
</html>`;
  res.send(html);
});

// /map/image - 画像ファイルを直接返す
app.get("/map/image", (req, res) => {
  const mode = req.query.mode || "faction_full";
  const imagePath =
    FULL_MAP_IMAGE_PATHS[mode] || FULL_MAP_IMAGE_PATHS.faction_full;

  if (fs.existsSync(imagePath)) {
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `inline; filename="${mode}.png"`);
    res.setHeader("Cache-Control", "public, max-age=60"); // 1分キャッシュ
    res.sendFile(imagePath);
  } else {
    // 画像がまだ生成されていない場合
    res
      .status(404)
      .send("マップ画像はまだ生成されていません。しばらくお待ちください。");
  }
});

// 全プレイヤーのユーザー名を表示名に強制同期 (一括マイグレーション)
async function migratePlayerNames() {
  try {
    console.log("[Migration] Syncing usernames with displayNames...");
    let changed = false;
    await updateJSON(PLAYERS_PATH, (data) => {
      if (!data || !data.players) return data;
      Object.values(data.players).forEach((p) => {
        if (p.displayName && p.username !== p.displayName) {
          console.log(
            `[Migration] Updating username for ${p.id}: ${p.username} -> ${p.displayName}`,
          );
          p.username = p.displayName;
          changed = true;
        }
      });
      return changed ? data : false;
    });

    // duplicate_ip.json のマイグレーション
    if (fs.existsSync(DUPLICATE_IP_PATH)) {
      const playersData = loadJSON(PLAYERS_PATH, { players: {} });
      await updateJSON(DUPLICATE_IP_PATH, (dipData) => {
        if (!dipData) return dipData;
        let dipChanged = false;
        Object.values(dipData).forEach((entry) => {
          if (entry.accounts && Array.isArray(entry.accounts)) {
            entry.accounts.forEach((acc) => {
              const p = playersData.players[acc.id];
              if (p && p.displayName) {
                if (acc.displayName !== p.displayName || acc.username) {
                  acc.displayName = p.displayName;
                  delete acc.username;
                  dipChanged = true;
                }
              }
            });
          }
        });
        return dipChanged ? dipData : false;
      }).catch((e) =>
        console.error("[Migration] Error updating duplicate_ip.json:", e),
      );
    }

    if (changed) {
      console.log("[Migration] Completed name synchronization.");
    }
  } catch (e) {
    console.error("[Migration] Error during name sync:", e);
  }
}
migratePlayerNames();
