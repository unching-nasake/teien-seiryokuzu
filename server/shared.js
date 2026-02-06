const fs = require("fs");
const path = require("path");

// ===== Constants =====
const MAP_SIZE = 500;
// 特別タイル: 中央50×50 (225～274)
const SPECIAL_TILE_MIN = 225;
const SPECIAL_TILE_MAX = 274;

const MAX_POINTS = 10;
const MIN_POINTS = 1;
const GRADIENT_STEP = 5; // 5タイルごとにポイント減少
const NAMED_CELL_BONUS = 20;

const NAMED_CELL_CREATE_COST = 100;

// ===== Helper Functions =====
function isSpecialTile(x, y) {
  return (
    x >= SPECIAL_TILE_MIN &&
    x <= SPECIAL_TILE_MAX &&
    y >= SPECIAL_TILE_MIN &&
    y <= SPECIAL_TILE_MAX
  );
}

/**
 * タイルのポイントを計算（グラデーション制）
 * @param {number} x - タイルX座標
 * @param {number} y - タイルY座標
 * @param {Object} namedCells - ネームドセルデータ（オプション）
 * @returns {number} ポイント（1～10、ネームドセルは+20）
 */
function getTilePoints(x, y, namedCells = null) {
  let basePoints;

  if (isSpecialTile(x, y)) {
    // 特別タイル内は最大ポイント
    basePoints = MAX_POINTS;
  } else {
    // 特別タイル範囲からの距離を計算
    const distX =
      x < SPECIAL_TILE_MIN
        ? SPECIAL_TILE_MIN - x
        : x > SPECIAL_TILE_MAX
          ? x - SPECIAL_TILE_MAX
          : 0;
    const distY =
      y < SPECIAL_TILE_MIN
        ? SPECIAL_TILE_MIN - y
        : y > SPECIAL_TILE_MAX
          ? y - SPECIAL_TILE_MAX
          : 0;
    const distance = Math.max(distX, distY);

    // 5タイルごとに1ポイント減少（特別タイル外は9ptからスタート）
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

    // 1. プロセス内での排他制御 (同一プロセス内の複数リクエストの衝突をメモリ上で解決)
    // これにより、プロセス内での無駄な mkdirSync 試行を回避し、高速化する。
    while (inProcessLocks.get(key)) {
      if (Date.now() - start > timeout) return false;
      await inProcessLocks.get(key);
    }

    // 自プロセスがロックを取得したことを示すPromise
    let resolveLock;
    const lockPromise = new Promise((res) => {
      resolveLock = res;
    });
    inProcessLocks.set(key, lockPromise);
    lockPromise.resolve = resolveLock;

    try {
      // 2. ファイルシステム（プロセス間）での排他制御
      if (fs.existsSync(lockDir)) {
        try {
          const stats = fs.statSync(lockDir);
          const age = Date.now() - stats.mtimeMs;
          if (age > 60000) {
            console.warn(
              `[LockManager] Stale lock found for ${path.basename(key)}. Removing...`,
            );
            try {
              fs.rmdirSync(lockDir);
            } catch {
              // ignore rmdir error
            }
          }
        } catch {
          // ignore stat error
        }
      }

      while (Date.now() - start < timeout) {
        try {
          fs.mkdirSync(lockDir);
          return true;
        } catch (e) {
          if (e.code === "EEXIST") {
            await new Promise((r) => setTimeout(r, 25 + Math.random() * 25));
            continue;
          }
          throw e; // システムエラー
        }
      }

      // タイムアウト時はメモリ上のロックを解放して失敗を返す
      const ourLockPromise = inProcessLocks.get(key);
      if (ourLockPromise === lockPromise) {
        inProcessLocks.delete(key);
        lockPromise.resolve();
      }
      return false;
    } catch (e) {
      // 予期せぬエラー時も同様に解放
      const ourLockPromise = inProcessLocks.get(key);
      if (ourLockPromise === lockPromise) {
        inProcessLocks.delete(key);
        lockPromise.resolve();
      }
      throw e;
    }
  }

  static release(key) {
    const lockDir = `${key}.lock`;
    try {
      if (fs.existsSync(lockDir)) {
        fs.rmdirSync(lockDir);
      }
    } catch (e) {
      console.error(`[LockManager] Release error for ${key}:`, e);
    } finally {
      // プロセス内のロックを解放
      const lockPromise = inProcessLocks.get(key);
      if (lockPromise) {
        inProcessLocks.delete(key);
        lockPromise.resolve();
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

module.exports = {
  MAP_SIZE,
  SPECIAL_TILE_MIN,
  SPECIAL_TILE_MAX,
  MAX_POINTS,
  MIN_POINTS,
  GRADIENT_STEP,
  NAMED_CELL_BONUS,
  NAMED_CELL_CREATE_COST,
  isSpecialTile,
  getTilePoints,
  LockManager,
  calculateFactionPoints,
};

function calculateFactionPoints(factionId, mapState) {
  let territoryPoints = 0;
  for (const key in mapState.tiles) {
    const tile = mapState.tiles[key];
    if ((tile.factionId || tile.faction) === factionId) {
      const [x, y] = key.split("_").map(Number);
      territoryPoints += getTilePoints(x, y);
    }
  }
  return territoryPoints;
}
