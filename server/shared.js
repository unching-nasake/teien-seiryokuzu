const fs = require("fs");
const path = require("path");

// ===== Constants =====
// ===== Constants =====
// MAP_SIZE is now dynamic, passed as argument
const TILE_BYTE_SIZE = 24;
// Special Tile Size: 50x50
const SPECIAL_TILE_HALF_WIDTH = 25;

const MAX_POINTS = 10;
const MIN_POINTS = 1;
const GRADIENT_STEP = 5; // 5 tiles step
const NAMED_CELL_BONUS = 20;

const NAMED_CELL_CREATE_COST = 100;

// ===== Helper Functions =====
function getSpecialTileRange(mapSize) {
  const center = Math.floor(mapSize / 2);
  return {
    min: center - SPECIAL_TILE_HALF_WIDTH,
    max: center + SPECIAL_TILE_HALF_WIDTH - 1,
  };
}

function isSpecialTile(x, y, mapSize = 500) {
  const { min, max } = getSpecialTileRange(mapSize);
  return x >= min && x <= max && y >= min && y <= max;
}

/**
 * Calculate tile points (Gradient system)
 * @param {number} x
 * @param {number} y
 * @param {number} mapSize
 * @param {Object} namedCells
 * @returns {number}
 */
function getTilePoints(x, y, mapSize, namedCells = null) {
  if (mapSize === undefined) {
    console.warn(
      "[shared] getTilePoints: mapSize is undefined. Defaulting to 500.",
    );
    mapSize = 500;
  }
  let basePoints;

  const { min, max } = getSpecialTileRange(mapSize);

  if (x >= min && x <= max && y >= min && y <= max) {
    // Inside special tile area
    basePoints = MAX_POINTS;
  } else {
    // Calculate distance from special tile area
    const distX = x < min ? min - x : x > max ? x - max : 0;
    const distY = y < min ? min - y : y > max ? y - max : 0;
    const distance = Math.max(distX, distY);

    // Decrease 1 point every 5 tiles
    const reduction = Math.floor(distance / GRADIENT_STEP);
    basePoints = Math.max(MIN_POINTS, 9 - reduction);
  }

  // ネームドセルボーナス
  if (namedCells) {
    const key = `${x}_${y}`;
    if (namedCells[key]) {
      basePoints += NAMED_CELL_BONUS;
    }
  }

  return basePoints;
}

// ===== Lock Manager =====
const inProcessLocks = new Map(); // key -> Promise (queue)

class LockManager {
  static async acquire(key, timeout = 20000) {
    const lockDir = `${key}.lock`;
    const start = Date.now();

    // 1. プロセス内での排他制御
    while (inProcessLocks.get(key)) {
      if (Date.now() - start > timeout) return false;
      await inProcessLocks.get(key);
    }

    let resolveLock;
    const lockPromise = new Promise((res) => {
      resolveLock = res;
    });
    inProcessLocks.set(key, lockPromise);
    lockPromise.resolve = resolveLock;

    try {
      // 親ディレクトリの存在確認 (data/ など)
      const parentDir = path.dirname(key);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      // 2. ファイルシステム（プロセス間）での排他制御
      if (fs.existsSync(lockDir)) {
        try {
          const stats = fs.statSync(lockDir);
          const age = Date.now() - stats.mtimeMs;
          // Stale lock の判定を短縮 (取得タイムアウトが20秒なので、30秒放置されていれば古いとみなす)
          if (age > 30000) {
            console.warn(
              `[LockManager] Stale lock found for ${path.basename(key)} (age: ${Math.floor(age / 1000)}s). Removing...`,
            );
            try {
              fs.rmSync(lockDir, { recursive: true, force: true });
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore
        }
      }

      while (Date.now() - start < timeout) {
        try {
          fs.mkdirSync(lockDir);
          return true;
        } catch (e) {
          if (e.code === "EEXIST") {
            // 他のプロセスが取得中。再試行
            await new Promise((r) => setTimeout(r, 25 + Math.random() * 25));
            continue;
          }
          throw e;
        }
      }

      // タイムアウト
      this._clearInProcessLock(key, lockPromise);
      return false;
    } catch (e) {
      this._clearInProcessLock(key, lockPromise);
      throw e;
    }
  }

  static _clearInProcessLock(key, lockPromise) {
    const current = inProcessLocks.get(key);
    if (current === lockPromise) {
      inProcessLocks.delete(key);
      if (lockPromise.resolve) lockPromise.resolve();
    }
  }

  static release(key) {
    const lockDir = `${key}.lock`;
    try {
      if (fs.existsSync(lockDir)) {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`[LockManager] Release error for ${key}:`, e);
    } finally {
      // プロセス内のロックを解放
      const lockPromise = inProcessLocks.get(key);
      if (lockPromise) {
        inProcessLocks.delete(key);
        if (lockPromise.resolve) lockPromise.resolve();
      }
    }
  }

  static async withLock(key, fn) {
    const start = Date.now();
    const acquired = await this.acquire(key);
    if (!acquired) {
      const waitTime = Date.now() - start;
      throw new Error(
        `Could not acquire lock for ${path.basename(key)} after ${waitTime}ms`,
      );
    }
    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }
}

// exports at the bottom

function calculateFactionPoints(
  factionId,
  mapState,
  namedCells = null,
  mapSize = 500,
) {
  let territoryPoints = 0;
  for (const key in mapState.tiles) {
    const tile = mapState.tiles[key];
    if ((tile.factionId || tile.faction) === factionId) {
      const [x, y] = key.split("_").map(Number);
      territoryPoints += getTilePoints(x, y, namedCells, mapSize);
    }
  }
  return territoryPoints;
}

function getTop3AllianceIds(alliancesDict, factionsData, preCalcStats) {
  const alliancePoints = {};
  if (!alliancesDict) return [];

  Object.keys(alliancesDict).forEach((aid) => (alliancePoints[aid] = 0));

  if (preCalcStats && preCalcStats.factions) {
    Object.keys(preCalcStats.factions).forEach((fid) => {
      const f = factionsData.factions[fid];
      const points = preCalcStats.factions[fid].totalPoints || 0;
      if (f && f.allianceId && alliancePoints[f.allianceId] !== undefined) {
        alliancePoints[f.allianceId] += points;
      }
    });
  } else if (preCalcStats && preCalcStats.factionPoints) {
    Object.keys(preCalcStats.factionPoints).forEach((fid) => {
      const f = factionsData.factions[fid];
      const points = preCalcStats.factionPoints[fid] || 0;
      if (f && f.allianceId && alliancePoints[f.allianceId] !== undefined) {
        alliancePoints[f.allianceId] += points;
      }
    });
  }

  return Object.entries(alliancePoints)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map((entry) => entry[0]);
}

function isWeakFactionUnified(
  rank,
  memberCount,
  factionId,
  allianceId,
  top3Alliances,
) {
  if (rank < 6 || rank > 500) {
    return false;
  }
  const basicWeak = memberCount <= 3;
  if (!basicWeak) return false;
  if (allianceId && top3Alliances && top3Alliances.includes(allianceId)) {
    return false;
  }
  return true;
}

function calculateFactionSharedAPLimit(
  faction,
  playersData,
  settings,
  activeMembers = [],
) {
  // Defensive check for arguments
  if (!settings) settings = {};
  if (!Array.isArray(activeMembers)) {
    // If 4th arg is missing but 3rd arg is used, activeMembers might be undefined or incorrectly passed
    activeMembers = [];
  }

  const baseShared = settings.apSettings?.limits?.sharedBase ?? 50;
  let validCount = activeMembers.length;

  if (settings.gardenMode) {
    if (!playersData || !playersData.players) {
      validCount = 0;
    } else {
      // Ensure we have an array to filter
      const membersToFilter = Array.isArray(activeMembers) ? activeMembers : [];
      const validMembers = membersToFilter.filter((mid) => {
        const p = playersData.players[mid];
        if (!p) return false;
        return !!p.lastAuthenticated;
      });
      validCount = validMembers.length;
    }
  }
  let limit = baseShared * Math.max(1, validCount);
  return {
    limit,
    activeMemberCount: activeMembers.length,
    validMemberCount: validCount,
  };
}

module.exports = {
  getSpecialTileRange,
  MAX_POINTS,
  MIN_POINTS,
  GRADIENT_STEP,
  NAMED_CELL_BONUS,
  NAMED_CELL_CREATE_COST,
  isSpecialTile,
  getTilePoints,
  LockManager,
  calculateFactionPoints,
  getTop3AllianceIds,
  isWeakFactionUnified,
  calculateFactionSharedAPLimit,
  TILE_BYTE_SIZE,
};
