const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const { createCanvas, registerFont } = require("canvas");
const shared = require("./shared");
const {
  LockManager,
  MAP_SIZE,
  getTilePoints,
  calculateFactionPoints,
  getTop3AllianceIds,
  isWeakFactionUnified,
  calculateFactionSharedAPLimit,
  isSpecialTile,
} = shared;

const TILE_BYTE_SIZE = shared.TILE_BYTE_SIZE || 24;

let fontsRegistered = false;
let emojiFontRegistered = false;
function ensureFontsRegistered() {
  if (fontsRegistered) return;

  // 日本語フォントを登録（node-canvas用）
  const fontPath = path.join(__dirname, "fonts", "NotoSansJP-Bold.ttf");
  if (fs.existsSync(fontPath)) {
    try {
      registerFont(fontPath, { family: "NotoSansJP", weight: "bold" });
      console.log("[Worker] Japanese font registered:", fontPath);
    } catch (e) {
      console.warn("[Worker] Failed to register font:", e.message);
    }
  } else {
    console.warn("[Worker] Japanese font not found at:", fontPath);
  }

  // 絵文字フォントを登録（node-canvas用）- 複数のフォールバックで試行
  const emojiFontFiles = [
    "NotoEmoji-VariableFont.ttf", // Variable Font（最も互換性が高い）
    "NotoEmoji-Bold.ttf", // Bold版
  ];

  for (const fontFile of emojiFontFiles) {
    const fontPath = path.join(__dirname, "fonts", fontFile);
    if (fs.existsSync(fontPath)) {
      try {
        registerFont(fontPath, { family: "NotoEmoji" });
        console.log("[Worker] Emoji font registered:", fontPath);
        emojiFontRegistered = true;
        break;
      } catch (e) {
        console.warn(`[Worker] Failed to register ${fontFile}:`, e.message);
      }
    }
  }
  if (!emojiFontRegistered) {
    console.warn(
      "[Worker] No emoji font could be registered. Emoji will be removed from labels.",
    );
  }
  fontsRegistered = true;
}

// 絵文字を除去するヘルパー関数（フォント登録失敗時のフォールバック用）
// Unicode絵文字範囲を除去し、テキストのみを返す
function removeEmoji(str) {
  if (!str) return str;
  // 絵文字フォントが登録されている場合はそのまま返す
  if (emojiFontRegistered) return str;
  // 絵文字（Emoji）と修飾子を除去する正規表現
  return str
    .replace(/[\u{1F600}-\u{1F64F}]/gu, "") // 顔文字
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, "") // 記号・絵文字
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, "") // 乗り物・地図記号
    .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, "") // 国旗
    .replace(/[\u{2600}-\u{26FF}]/gu, "") // その他の記号
    .replace(/[\u{2700}-\u{27BF}]/gu, "") // 装飾記号
    .replace(/[\u{1F900}-\u{1F9FF}]/gu, "") // 補助絵文字
    .replace(/[\u{1FA00}-\u{1FA6F}]/gu, "") // 拡張絵文字
    .replace(/[\u{1FA70}-\u{1FAFF}]/gu, "") // 拡張絵文字
    .replace(/[\u{231A}-\u{231B}]/gu, "") // 時計
    .replace(/[\u{23E9}-\u{23F3}]/gu, "") // その他記号
    .replace(/[\u{23F8}-\u{23FA}]/gu, "") // その他記号
    .replace(/[\u{25AA}-\u{25AB}]/gu, "") // 四角記号
    .replace(/[\u{25B6}]/gu, "") // 再生ボタン
    .replace(/[\u{25C0}]/gu, "") // 逆再生ボタン
    .replace(/[\u{25FB}-\u{25FE}]/gu, "") // 四角記号
    .replace(/[\u{FE0F}]/gu, "") // 異体字セレクタ
    .replace(/[\u{200D}]/gu, "") // ゼロ幅接合子
    .trim();
}

// ===== キャッシュシステム (Workerレベル) =====
const jsonCache = new Map();

// [OPTIMIZATION] ZOC影響範囲キャッシュ
// 構造: { version, data: Map<"x_y", { namedKey, ownerFid, alliedFids: Set }> }
let zocInfluenceCache = null;

// [OPTIMIZATION] 中核マス座標キャッシュ (勢力ID -> [{ x, y, factionId }])
// 構造: { version, data: Map<factionId, [{ x, y }]> }
let coreCoordsCache = null;

// [OPTIMIZATION] 同盟メンバーキャッシュ (allianceId -> Set<factionId>)
// 構造: { version, data: Map<allianceId, Set<factionId>> }
let allianceMembersCache = null;

// [OPTIMIZATION] 勢力ポイントキャッシュ (factionId -> points)
// 構造: { version, data: Map<factionId, number> }
let factionPointsCache = null;

// [OPTIMIZATION] 勢力別タイルインデックス (factionId -> Set<tileKey>)
// 構造: { version, data: Map<factionId, Set<tileKey>> }
let factionTileIndex = null;

// [NEW] SharedArrayBuffer 参照 (server.js から共有される)
let workerMapSAB = null;
let workerMapView = null;
let workerIndexToFactionId = [];
let workerIndexToPlayerId = [];

// [NEW] Advanced SABs
let workerZocMapSAB = null;
let workerZocMapView = null;
let workerFactionStatsSAB = null;
let workerFactionStatsView = null;
let MAX_FACTIONS_LIMIT = 2000;
let STATS_INTS_PER_FACTION = 16;

if (workerData) {
  if (workerData.sharedMapSAB) {
    workerMapSAB = workerData.sharedMapSAB;
    workerMapView = new DataView(workerMapSAB);
  }
  if (workerData.sharedZocMapSAB) {
    workerZocMapSAB = workerData.sharedZocMapSAB;
    workerZocMapView = new Uint16Array(workerZocMapSAB);
  }
  if (workerData.factionStatsSAB) {
    workerFactionStatsSAB = workerData.factionStatsSAB;
    workerFactionStatsView = new Int32Array(workerFactionStatsSAB);
    MAX_FACTIONS_LIMIT = workerData.MAX_FACTIONS_LIMIT || 2000;
    STATS_INTS_PER_FACTION = workerData.STATS_INTS_PER_FACTION || 16;
  }
}

/**
 * SABからタイルデータを読み取るヘルパー
 */
function getTileFromSAB(x, y) {
  if (!workerMapView) return null;
  const size = 500;
  if (x < 0 || x >= size || y < 0 || y >= size) return null;

  const offset = (y * size + x) * TILE_BYTE_SIZE;

  const fidIdx = workerMapView.getUint16(offset + 0, true);
  if (fidIdx === 65535) return null;

  const factionId = workerIndexToFactionId[fidIdx] || null;
  if (!factionId) return null;

  // [NEW] PaintedBy
  const pIdx = workerMapView.getUint32(offset + 6, true);
  const paintedBy = pIdx > 0 ? workerIndexToPlayerId[pIdx - 1] : null;

  // 必要な情報をオブジェクトとして構築 (互換性のため)
  return {
    x,
    y,
    factionId,
    color: `#${workerMapView
      .getUint32(offset + 2, true)
      .toString(16)
      .padStart(6, "0")}`,
    paintedBy,
    overpaint: workerMapView.getUint8(offset + 10),
    _flags: workerMapView.getUint8(offset + 11),
    _exp: workerMapView.getFloat64(offset + 12, true),
  };
}

// [OPTIMIZATION] 座標インデックス (2D配列: [y][x] -> tile)
// 高速な座標アクセスを提供し、文字列キー生成のコストを削減
let coordinateIndex = null; // Array<Array<Tile | null>>

// キャッシュバージョン (mapState変更時にインクリメント)
let cacheVersion = 0;

/**
 * 座標インデックスを構築 (2D配列)
 */
function buildCoordinateIndex(mapState) {
  // [NEW] SABがあれば座標インデックス(POJO配列)は不要
  if (workerMapView) return null;

  // MAP_SIZEはsharedから取得したいが、ここでは定数500を使用 (shared.MAP_SIZE)
  const size = 500;
  // ... (existing code for fallback)
  const index = new Array(size);
  for (let y = 0; y < size; y++) {
    index[y] = new Array(size).fill(null);
  }

  if (mapState && mapState.tiles) {
    for (const key in mapState.tiles) {
      const tile = mapState.tiles[key];
      const [x, y] = key.split("_").map(Number);
      if (x >= 0 && x < size && y >= 0 && y < size) {
        index[y][x] = tile;
      }
    }
  }
  return index;
}

/**
 * 座標からタイルを高速取得
 * @param {number} x
 * @param {number} y
 * @param {Object} mapState - フォールバック用
 * @returns {Object|null}
 */
function getTileAt(x, y, mapState) {
  // 範囲チェック
  if (x < 0 || x >= 500 || y < 0 || y >= 500) {
    return null;
  }

  // [NEW] SABがあれば最優先で使用 (最高速 & 常に最新)
  if (workerMapView) {
    return getTileFromSAB(x, y);
  }

  // インデックスがあれば使用
  if (coordinateIndex) {
    return coordinateIndex[y][x];
  }

  // フォールバック: 文字列キー生成コストがかかる
  return mapState.tiles[`${x}_${y}`] || null;
}

/**
 * 勢力別タイルインデックスを構築
 */
function buildFactionTileIndex(mapState) {
  const index = new Map();

  // [NEW] SABがあればバイナリ走査 (超高速)
  if (workerMapView) {
    const size = 500;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const offset = (y * size + x) * TILE_BYTE_SIZE;
        const fidIdx = workerMapView.getUint16(offset, true);
        if (fidIdx === 65535) continue;

        const fid = workerIndexToFactionId[fidIdx];
        if (fid) {
          if (!index.has(fid)) index.set(fid, new Set());
          index.get(fid).add(`${x}_${y}`);
        }
      }
    }
    return index;
  }

  if (!mapState || !mapState.tiles) return index;
  // ... (original fallback)
  for (const [key, tile] of Object.entries(mapState.tiles)) {
    const fid = tile.factionId || tile.faction;
    if (fid) {
      if (!index.has(fid)) {
        index.set(fid, new Set());
      }
      index.get(fid).add(key);
    }
  }
  return index;
}

/**
 * 同盟メンバーSetを取得（キャッシュ利用）
 * @param {string} factionId - 勢力ID
 * @param {Object} alliances - 同盟データ
 * @param {Object} factions - 勢力データ
 * @returns {Set<string>} 同盟関係にある勢力IDのSet（自分含む）
 */
function getAlliedFactionIds(factionId, alliances, factions) {
  const result = new Set([factionId]);

  const faction = factions?.factions?.[factionId];
  if (!faction?.allianceId) return result;

  const allianceId = faction.allianceId;

  // キャッシュチェック
  if (allianceMembersCache?.data?.has(allianceId)) {
    const cached = allianceMembersCache.data.get(allianceId);
    cached.forEach((fid) => result.add(fid));
    return result;
  }

  // キャッシュミス: 同盟メンバーをSetに追加
  const alliance = alliances?.alliances?.[allianceId];
  if (alliance?.members) {
    alliance.members.forEach((m) => result.add(m.factionId));

    // キャッシュに保存
    if (!allianceMembersCache) {
      allianceMembersCache = { version: cacheVersion, data: new Map() };
    }
    const memberSet = new Set(alliance.members.map((m) => m.factionId));
    allianceMembersCache.data.set(allianceId, memberSet);
  }

  return result;
}

/**
 * ZOC影響範囲マップを構築
 * @param {Object} mapState - マップ状態
 * @param {Object} namedCells - ネームドマス一覧
 * @param {Object} factions - 勢力一覧
 * @param {Object} alliances - 同盟一覧
 * @returns {Map<string, Object>} ZOC影響マップ (key: "x_y", value: { namedKey, ownerFid, alliedFids })
 */
function buildZocInfluenceMap(mapState, namedCells, factions, alliances) {
  const zocMap = new Map();
  const ZOC_RADIUS = 5;

  for (const [nKey, namedData] of Object.entries(namedCells)) {
    const ncTile = mapState.tiles[nKey];
    const ownerFid = ncTile ? ncTile.factionId : null;
    if (!ownerFid) continue; // 無所属のネームドマスはZOCを持たない

    // 所有者の同盟勢力を取得
    const alliedFids = new Set([ownerFid]);
    const ncFaction = factions.factions ? factions.factions[ownerFid] : null;
    if (
      ncFaction &&
      ncFaction.allianceId &&
      alliances.alliances?.[ncFaction.allianceId]
    ) {
      alliances.alliances[ncFaction.allianceId].members.forEach((m) =>
        alliedFids.add(m),
      );
    }

    // ZOC範囲内の全座標をマップに登録
    const nx = namedData.x;
    const ny = namedData.y;
    for (let dx = -ZOC_RADIUS; dx <= ZOC_RADIUS; dx++) {
      for (let dy = -ZOC_RADIUS; dy <= ZOC_RADIUS; dy++) {
        const tx = nx + dx;
        const ty = ny + dy;
        if (tx < 0 || tx >= MAP_SIZE || ty < 0 || ty >= MAP_SIZE) continue;
        // ネームドマス自体はスキップ（ZOC対象外であるため特別扱い）
        if (tx === nx && ty === ny) continue;

        const key = `${tx}_${ty}`;
        // 複数のネームドマスからの影響もあり得るが、ここでは最初の一つを記録
        // （必要に応じて配列にしてもよいが、現状の実装と整合させる）
        if (!zocMap.has(key)) {
          zocMap.set(key, {
            namedKey: nKey,
            namedX: nx,
            namedY: ny,
            ownerFid,
            alliedFids,
          });
        }
      }
    }
  }

  return zocMap;
}

/**
 * 中核マス座標マップを構築
 * @param {Object} mapState - マップ状態
 * @returns {Map<string, Array>} 勢力ID -> 中核マス座標リスト
 */
function buildCoreCoordsMap(mapState) {
  const coreMap = new Map();

  // [NEW] SABがあればバイナリ走査
  if (workerMapView) {
    const size = 500;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const offset = (y * size + x) * TILE_BYTE_SIZE;
        const flags = workerMapView.getUint8(offset + 11);
        if (flags & 1) {
          // Core flag
          const fidIdx = workerMapView.getUint16(offset, true);
          const fid = workerIndexToFactionId[fidIdx];
          if (fid) {
            if (!coreMap.has(fid)) coreMap.set(fid, []);
            coreMap.get(fid).push({ x, y });
          }
        }
      }
    }
    return coreMap;
  }

  for (const key in mapState.tiles) {
    const tile = mapState.tiles[key];
    if (tile.core && tile.core.factionId) {
      const fid = tile.core.factionId;
      const [x, y] = key.split("_").map(Number);
      if (!coreMap.has(fid)) {
        coreMap.set(fid, []);
      }
      coreMap.get(fid).push({ x, y });
    }
  }

  return coreMap;
}

/**
 * キャッシュをリフレッシュ（必要な場合のみ再構築）
 */
function ensureCachesValid(mapState, namedCells, factions, alliances) {
  // mtimeベースでバージョンチェック（jsonCacheを活用）
  const mapCached = jsonCache.get(mapState._path);
  const currentVersion = mapCached?.mtime || Date.now();

  if (!zocInfluenceCache || zocInfluenceCache.version !== currentVersion) {
    zocInfluenceCache = {
      version: currentVersion,
      data: buildZocInfluenceMap(mapState, namedCells, factions, alliances),
    };
    // console.log(`[Worker] ZOC Cache rebuilt: ${zocInfluenceCache.data.size} entries`);
  }

  if (!coreCoordsCache || coreCoordsCache.version !== currentVersion) {
    coreCoordsCache = {
      version: currentVersion,
      data: buildCoreCoordsMap(mapState),
    };
    // console.log(`[Worker] Core Coords Cache rebuilt: ${coreCoordsCache.data.size} factions`);
  }

  // 同盟キャッシュのバージョンチェック（同盟データ変更時に無効化）
  if (allianceMembersCache && allianceMembersCache.version !== currentVersion) {
    allianceMembersCache = null; // バージョン変更で無効化
  }

  // 勢力ポイントキャッシュのバージョンチェック
  if (factionPointsCache && factionPointsCache.version !== currentVersion) {
    factionPointsCache = null; // バージョン変更で無効化
  }

  // 勢力タイルインデックスの更新
  if (!factionTileIndex || factionTileIndex.version !== currentVersion) {
    factionTileIndex = {
      version: currentVersion,
      data: buildFactionTileIndex(mapState),
    };
  }

  // 座標インデックスの更新
  if (!coordinateIndex || cacheVersion !== currentVersion) {
    coordinateIndex = buildCoordinateIndex(mapState);
    cacheVersion = currentVersion; // ここでバージョン同期
  }
}

/**
 * 指定座標がネームドマスZOC範囲内で、かつ攻撃側の中核マスが近いかチェック
 * @returns {{ isZoc: boolean, isZocReduced: boolean }}
 */
function checkZocWithCache(x, y, targetFactionId, playerFactionId, alliedFids) {
  // [NEW] SAB Optimization
  if (workerZocMapView) {
    const size = 500;
    const offset = y * size + x;
    const zocIdx = workerZocMapView[offset];
    if (zocIdx === 0) return { isZoc: false, isZocReduced: false };

    if (zocIdx !== 65534 && zocIdx !== 65535) {
      // 65534=Conflict
      const zocFid = workerIndexToFactionId[zocIdx];
      if (zocFid === playerFactionId || alliedFids.has(zocFid)) {
        return { isZoc: false, isZocReduced: false };
      }
      // If Enemy ZOC, fall through to check isZocReduced
    }
  }

  if (!zocInfluenceCache || !coreCoordsCache) {
    return { isZoc: false, isZocReduced: false };
  }

  const key = `${x}_${y}`;
  const zocData = zocInfluenceCache.data.get(key);

  if (!zocData) {
    return { isZoc: false, isZocReduced: false };
  }

  // 自勢力または同盟のネームドマスからのZOCは無視
  if (zocData.alliedFids.has(playerFactionId)) {
    return { isZoc: false, isZocReduced: false };
  }

  // ターゲットタイルが敵（ネームドマス所有者または同盟）のものかチェック
  if (!zocData.alliedFids.has(targetFactionId)) {
    return { isZoc: false, isZocReduced: false };
  }

  // ZOC適用確定
  let isZocReduced = false;
  const ZOC_RADIUS = 5;

  // 攻撃側の中核マスがネームドマス射程内にあるかチェック
  for (const fid of alliedFids) {
    const cores = coreCoordsCache.data.get(fid);
    if (cores) {
      for (const core of cores) {
        if (
          Math.abs(core.x - zocData.namedX) <= ZOC_RADIUS &&
          Math.abs(core.y - zocData.namedY) <= ZOC_RADIUS
        ) {
          isZocReduced = true;
          break;
        }
      }
    }
    if (isZocReduced) break;
  }

  return { isZoc: true, isZocReduced };
}

// ヘルパー: statベースのキャッシュを使用したJSON読み込み
function loadJSON(filePath, defaultValue = {}, ignoreCache = false) {
  // 多くのタスク呼び出しにわたるパフォーマンス向上のため、Workerレベルでのキャッシュが重要
  const now = Date.now();
  const cached = jsonCache.get(filePath);

  if (!ignoreCache && cached && now - (cached.lastChecked || 0) < 2000) {
    return cached.data;
  }

  try {
    if (!fs.existsSync(filePath)) {
      return defaultValue;
    }

    const stats = fs.statSync(filePath);
    if (!ignoreCache && cached && cached.mtime === stats.mtimeMs) {
      cached.lastChecked = now;
      return cached.data;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw.trim()) {
      return defaultValue;
    }

    const data = JSON.parse(raw);
    jsonCache.set(filePath, { mtime: stats.mtimeMs, data, lastChecked: now });
    return data;
  } catch (e) {
    console.error(
      `[Worker] Error loading/parsing ${path.basename(filePath)}:`,
      e.message,
    );
    // エラー時はキャッシュがあればそれを返し、なければデフォルト値を返す
    return jsonCache.get(filePath)?.data || defaultValue;
  }
}

// クラスタ情報を取得
function getFactionClusterInfo(
  factionId,
  mapState,
  extraTiles = [],
  knownFactionKeys = null,
  alliedFids = null,
) {
  const initialFactionTiles = new Set();

  // 1. 指定されたキーがあればそれを使用
  if (knownFactionKeys) {
    knownFactionKeys.forEach((k) => initialFactionTiles.add(k));
  }
  // 2. SAB環境: インデックスがあれば高速取得
  else if (
    workerMapView &&
    typeof factionTileIndex !== "undefined" &&
    factionTileIndex?.data
  ) {
    const fidsToCheck = alliedFids || new Set([factionId]);
    fidsToCheck.forEach((fid) => {
      const keys = factionTileIndex.data.get(fid);
      if (keys) keys.forEach((k) => initialFactionTiles.add(k));
    });
  }
  // 3. SAB環境: インデックスがない場合は全走査 (フォールバック)
  else if (workerMapView) {
    const size = 500;
    const fidsToCheck = alliedFids || new Set([factionId]);
    for (let i = 0; i < size * size; i++) {
      const offset = i * TILE_BYTE_SIZE;
      const fidIdx = workerMapView.getUint16(offset, true);
      if (fidIdx === 65535) continue;
      const fid = workerIndexToFactionId[fidIdx];
      if (fidsToCheck.has(fid)) {
        const x = i % size;
        const y = Math.floor(i / size);
        initialFactionTiles.add(`${x}_${y}`);
      }
    }
  }
  // 4. JSON環境: mapStateから取得
  else {
    for (const key in mapState.tiles) {
      const t = mapState.tiles[key];
      const fid = t.factionId;
      if (alliedFids ? alliedFids.has(fid) : fid === factionId) {
        initialFactionTiles.add(key);
      }
    }
  }

  const factionTiles = new Set(initialFactionTiles);
  extraTiles.forEach((t) => factionTiles.add(`${t.x}_${t.y}`));

  const clusters = [];
  const visited = new Set();
  const directions = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  for (const key of factionTiles) {
    if (visited.has(key)) continue;
    const cluster = [];
    const queue = [key];
    visited.add(key);
    let hasCore = false;
    let hasExisting = false;
    while (queue.length > 0) {
      const current = queue.pop();
      cluster.push(current);
      if (initialFactionTiles.has(current)) hasExisting = true;
      const tile = mapState.tiles[current];
      if (tile && tile.core && tile.core.factionId === factionId)
        hasCore = true;
      const [x, y] = current.split("_").map(Number);
      for (const [dx, dy] of directions) {
        const nk = `${x + dx}_${y + dy}`;
        if (factionTiles.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          queue.push(nk);
        }
      }
    }
    clusters.push({ tiles: cluster, hasCore, hasExisting });
  }
  return {
    total: clusters.length,
    flyingEnclaves: clusters.filter((c) => !c.hasCore).length,
    clusters,
  };
}

// 塗装コスト計算
function calculatePaintCost(
  player,
  tiles,
  mapState,
  factions,
  alliances = {},
  wars = {}, // 戦争状態のチェック用
  action = "paint",
  overpaintCount = 1,
  namedTileSettings = {}, // [NEW] 設定受け取り
  coreTileSettings = {}, // [NEW] CoreTile設定
  enclaveSettings = {}, // [NEW] 飛び地制限設定
  extraTilesForClusters = null, // [NEW] 並列化用: クラスタ判定に使用する全タイルリスト
) {
  const factionId = player.factionId;
  const faction = (factions.factions || {})[factionId];
  if (!faction) return { error: "Faction not found" };

  let totalCost = 0;
  let totalPenalty = 0;
  const successRates = {};

  // --- 勢力コンテキストの事前計算 ---
  const alliedFids = new Set([factionId]);
  if (
    faction.allianceId &&
    alliances.alliances?.[faction.allianceId]?.members
  ) {
    alliances.alliances[faction.allianceId].members.forEach((id) =>
      alliedFids.add(id),
    );
  }

  // [NEW] 接続性判定のための中心座標の事前抽出 (SAB 優先)
  const validCoreCoords = [];
  if (workerMapView) {
    const size = 500;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const offset = (y * size + x) * TILE_BYTE_SIZE;
        const flags = workerMapView.getUint8(offset + 11);
        if (flags & 1) {
          // CORE flag
          const fidIdx = workerMapView.getUint16(offset, true);
          const fid = workerIndexToFactionId[fidIdx];
          if (fid && alliedFids.has(fid)) {
            validCoreCoords.push({ x, y });
          }
        }
      }
    }
  } else {
    for (const k in mapState.tiles) {
      const tile = mapState.tiles[k];
      if (tile.core && alliedFids.has(tile.core.factionId)) {
        const [cx, cy] = k.split("_").map(Number);
        validCoreCoords.push({ x: cx, y: cy });
      }
    }
  }

  // 2. 他勢力に包囲されているかの判定
  let isLandlocked = true;

  // [FIX] Landlocked Check Implementation
  if (workerMapView && workerIndexToFactionId) {
    const size = 500;
    // Full scan of SAB (250k items) - fast enough
    for (let i = 0; i < size * size; i++) {
      const offset = i * TILE_BYTE_SIZE;
      const fidIdx = workerMapView.getUint16(offset, true);
      // Skip if not my faction (using raw index check if possible, or mapping)
      // optimization: we need to know my faction's index.
      // Mapping back fid -> index is slow if linear.
      // But we can map index -> fid.
      const tFid = workerIndexToFactionId[fidIdx];

      if (tFid === factionId) {
        const y = Math.floor(i / size);
        const x = i % size;
        const neighbors = [
          [0, 1],
          [0, -1],
          [1, 0],
          [-1, 0],
        ];
        for (const [dx, dy] of neighbors) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
            const nOffset = (ny * size + nx) * TILE_BYTE_SIZE;
            const nFidIdx = workerMapView.getUint16(nOffset, true);
            if (nFidIdx === 65535) {
              // Empty
              isLandlocked = false;
              break;
            }
            const nFid = workerIndexToFactionId[nFidIdx];
            if (!nFid || alliedFids.has(nFid)) {
              isLandlocked = false;
              break;
            }
          } else {
            // Edge of map -> Not landlocked? Depends on rules. Usually edges are walls.
            // If rules say edges are NOT blocks, then set false.
            // Assuming edges are walls (neutral blocks), so keep searching.
          }
        }
      }
      if (!isLandlocked) break;
    }
  } else {
    // Fallback to JSON
    // Note: If mapState.tiles is empty (SAB mode but failed?), this will result in isLandlocked=true (default)
    // which is wrong if we have tiles. But we handled SAB above.
    const tilesToCheck = Object.values(mapState.tiles).filter(
      (t) => t.factionId === factionId || t.faction === factionId,
    );
    for (const t of tilesToCheck) {
      const neighbors = [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
      ];
      for (const [dx, dy] of neighbors) {
        const nx = Number(t.x) + dx;
        const ny = Number(t.y) + dy;
        const nKey = `${nx}_${ny}`;
        if (nx >= 0 && nx < MAP_SIZE && ny >= 0 && ny < MAP_SIZE) {
          const nTile = mapState.tiles[nKey];
          const nFid = nTile ? nTile.factionId || nTile.faction : null;
          if (!nFid || alliedFids.has(nFid)) {
            isLandlocked = false;
            break;
          }
        }
      }
      if (!isLandlocked) break;
    }
  }

  // 3. クラスタ情報（提案タイルを含む）
  const clusterInfo = getFactionClusterInfo(
    factionId,
    mapState,
    extraTilesForClusters || tiles, // [MOD] 並列化対応: 全体のタイルリストがあればそれを使用
    null,
    alliedFids,
  );

  const connectivityMap = {};
  for (let i = 0; i < clusterInfo.clusters.length; i++) {
    const cluster = clusterInfo.clusters[i];
    for (let j = 0; j < cluster.tiles.length; j++) {
      const tKey = cluster.tiles[j];
      connectivityMap[tKey] = cluster;
    }
  }

  // --- メインループ: 各タイルの処理 ---
  for (const t of tiles) {
    const key = `${t.x}_${t.y}`;
    // [FIX] SAB 対応: getTileAt を使用してタイル情報を取得
    const existing = getTileAt(t.x, t.y, mapState);
    const existingFid = existing ? existing.factionId : null;

    if (action === "overpaint") {
      if (existingFid !== factionId)
        return { error: "自勢力の土地以外は重ね塗りできません" };
      const currentOverpaint = existing ? existing.overpaint || 0 : 0;
      if (currentOverpaint >= 4) continue;
      const actualOverpaintTimes = Math.min(
        overpaintCount,
        4 - currentOverpaint,
      );
      totalCost += actualOverpaintTimes;
    } else {
      // 自勢力のネームドマスに対する状況確認
      if (existingFid === factionId && existing && existing.namedData) {
        // 自勢力のネームドマスに対する包囲判定 (戦争敵による完全包囲のみ)
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
          const nx = Number(t.x) + dx;
          const ny = Number(t.y) + dy;
          if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) {
            isSieged = false; // 壁は味方
            break;
          }
          // [FIX] SAB 対応: getTileAt を使用してタイル情報を取得
          const nTile = getTileAt(nx, ny, mapState);
          const nFid = nTile ? nTile.factionId : null;

          // 1. 空白、自勢力、同盟 は安全
          if (!nFid || alliedFids.has(nFid)) {
            isSieged = false;
            break;
          }

          // 2. 他勢力の場合は戦争チェック
          let isAtWar = false;
          if (wars && wars.wars) {
            // calculatePaintCostに渡されるwarsを使用
            const myFidStr = String(factionId);
            const targetFidStr = String(nFid);
            Object.values(wars.wars).forEach((w) => {
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

          if (!isAtWar) {
            isSieged = false;
            break;
          }
        }

        const now = Date.now();
        if (
          existing.namedData.cooldownUntil &&
          existing.namedData.cooldownUntil > now
        ) {
          successRates[key] = {
            rate: null, // 自勢力のマスは攻撃対象外
            isSieged: isSieged,
            bonus: 0,
            cooldownUntil: existing.namedData.cooldownUntil,
          };
        } else {
          // クールダウン中でなくても状態を表示するために追加
          successRates[key] = {
            rate: null,
            isSieged: isSieged,
            bonus: 0,
            cooldownUntil: 0,
          };
        }
      }

      if (existingFid !== factionId) {
        let base = 1;
        // 重ね塗りレベルを最大4に制限
        const overpaintLevel = Math.min(
          existing ? existing.overpaint || 0 : 0,
          4,
        );
        base += overpaintLevel;

        if (
          existing &&
          existing.core &&
          existing.core.factionId === existingFid
        ) {
          const enemyFaction = factions.factions[existingFid];
          let coreMultiplier = coreTileSettings.attackCostMultiplier ?? 1.5;
          if (enemyFaction) {
            const factionAgeHours =
              (Date.now() - new Date(enemyFaction.createdAt).getTime()) /
              3600000;
            const territoryPoints = enemyFaction.territoryPoints || 0;
            if (territoryPoints < 50 && factionAgeHours < 3)
              coreMultiplier *= 3;
          }
          base = Math.round(base * coreMultiplier);
        }

        if (existing && existing.namedData) {
          const now = Date.now();
          if (
            existing.namedData.cooldownUntil &&
            existing.namedData.cooldownUntil > now
          ) {
            // クールダウン中は successRates に情報を入れてクライアント側で表示
            successRates[key] = {
              rate: 0, // 攻撃不可
              isSieged: false,
              bonus: 0,
              cooldownUntil: existing.namedData.cooldownUntil,
            };
            // ここでエラー終了せず、ループを継続する
            continue;
          }
          base += 5;
          // Defender's Allies
          const defenderFaction = factions.factions[existingFid];
          const defenderAlliedFids = new Set([existingFid]);
          if (
            defenderFaction &&
            defenderFaction.allianceId &&
            alliances.alliances[defenderFaction.allianceId]
          ) {
            alliances.alliances[defenderFaction.allianceId].members.forEach(
              (m) => defenderAlliedFids.add(m),
            );
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
            const nx = Number(t.x) + dx;
            const ny = Number(t.y) + dy;
            if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) {
              isSieged = false; // Wall is safe
              break;
            }
            // [FIX] SAB 対応: getTileAt を使用してタイル情報を反映
            const nTile = getTileAt(nx, ny, mapState);
            const nFid = nTile ? nTile.factionId : null;

            // 1. Check if neighbor is Friendly to Defender (Self, Ally, or Empty)
            // Empty is technically safe for now (not blocked by enemy)
            if (!nFid || defenderAlliedFids.has(nFid)) {
              isSieged = false;
              break;
            }

            // 2. Neighbor is not ally => Check if it is a WAR ENEMY to Defender
            // If neighbor is NOT at war with Defender, then it doesn't count as siege
            let isAtWar = false;
            if (wars && wars.wars) {
              const defFidStr = String(existingFid);
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
          const baseRate = isSieged ? 0.3 : 0.1;
          const totalRate = Math.min(1.0, baseRate);
          successRates[key] = {
            rate: totalRate,
            isSieged,
            bonus: 0,
          };
        }

        // ZOC内（敵拠点隣接）の場合はコスト増加 (設定値使用)
        if (t.isZoc) {
          if (t.isZocReduced) {
            const mult = namedTileSettings.zocReducedMultiplier ?? 1.5;
            base = Math.round(base * mult);
          } else {
            const mult = namedTileSettings.zocMultiplier ?? 2.0;
            base = Math.round(base * mult);
          }
        }

        totalCost += base;
      }
    }

    const myCluster = connectivityMap[key];
    const hasCore = myCluster ? myCluster.hasCore : false;
    const hasExisting = myCluster ? myCluster.hasExisting : false;

    if (!hasCore && validCoreCoords.length > 0) {
      let minDist = Infinity;
      for (const core of validCoreCoords) {
        const d = Math.max(Math.abs(t.x - core.x), Math.abs(t.y - core.y));
        if (d < minDist) minDist = d;
      }
      if (action !== "overpaint" && !existingFid) {
        if (isLandlocked)
          return {
            error:
              "領土が他勢力に完全に包囲されているため、空白地への飛び地作成はできません",
          };
      }

      // 敵勢力への攻撃バリデーション
      // 既存の領土に繋がっていない状態での他勢力への攻撃を禁止（飛び地攻撃の防止）
      if (existingFid && existingFid !== factionId && !hasExisting) {
        return {
          error:
            "他勢力の領土を攻撃するには、自分の領土からの接続が必要です（飛び地攻撃の禁止）",
        };
      }

      const limit = enclaveSettings.distanceLimit ?? 25;
      const unit = enclaveSettings.penaltyUnit ?? 1;

      if (minDist > limit) {
        // [MOD] 飛び地ペナルティの計算 (単位あたり1コスト増加)
        // デフォルト: (距離 - 25) / 1
        const distOver = minDist - limit;
        const penalty = Math.ceil(distOver / unit);

        if (penalty > 0) {
          totalCost += penalty;
          totalPenalty += penalty;
        }
      }
    }
  }

  // --- 後処理: 勢力滅亡の検知 ---
  let destructionInvolved = false;
  const factionTileCounts = {};
  for (const k in mapState.tiles) {
    const tile = mapState.tiles[k];
    const fid = tile.factionId;
    if (fid) factionTileCounts[fid] = (factionTileCounts[fid] || 0) + 1;
  }

  const tilesToPaintByFaction = {};
  for (const t of tiles) {
    const existing = mapState.tiles[`${t.x}_${t.y}`];
    const efid = existing ? existing.factionId : null;
    if (efid && efid !== factionId) {
      tilesToPaintByFaction[efid] = (tilesToPaintByFaction[efid] || 0) + 1;
    }
  }

  for (const [fid, count] of Object.entries(tilesToPaintByFaction)) {
    if (factionTileCounts[fid] && factionTileCounts[fid] - count <= 0) {
      destructionInvolved = true;
      break;
    }
  }

  return {
    cost: totalCost,
    destructionInvolved,
    extraCost: totalPenalty,
    successRates,
  };
}

// Handler
parentPort.on("message", async (msg) => {
  const { type, data, taskId, workerId } = msg;

  // [NEW] SharedArrayBuffer の共有 (server.js から送られてくる)
  if (data.mapSAB) {
    workerMapSAB = data.mapSAB;
    workerMapView = new DataView(workerMapSAB);
  }
  if (data.indexToFactionId) {
    workerIndexToFactionId = data.indexToFactionId;
  }
  if (data.playerIds) {
    workerIndexToPlayerId = data.playerIds;
  }

  if (type === "CALCULATE_STATS") {
    try {
      const { affectedFactionIds, filePaths } = data;

      // [NEW] SharedArrayBuffer がある場合は、巨大な JSON のロードを完全にスキップ
      const mapState = workerMapView
        ? { tiles: {} }
        : data.mapState ||
          (filePaths?.mapState
            ? loadJSON(filePaths.mapState, { tiles: {} }, true)
            : { tiles: {} });

      const factions =
        data.factions ||
        (filePaths?.factions
          ? loadJSON(filePaths.factions, { factions: {} }, true)
          : { factions: {} });

      const namedCells =
        data.namedCells ||
        (filePaths?.namedCells ? loadJSON(filePaths.namedCells, {}, true) : {});

      const nowMs = Date.now();
      const factionStats = {};
      const pointUpdates = {};

      if (workerFactionStatsView) {
        // [NEW] Use FactionStatsSAB (O(F)) - Ultra fast
        // Iterate all potential faction indices
        for (let i = 1; i < MAX_FACTIONS_LIMIT; i++) {
          const fid = workerIndexToFactionId[i];
          if (!fid) continue;
          const idx = i * STATS_INTS_PER_FACTION;
          const tiles = Atomics.load(workerFactionStatsView, idx + 0);
          const cores = Atomics.load(workerFactionStatsView, idx + 1);
          if (tiles > 0 || cores > 0) {
            factionStats[fid] = { tiles, cores };
          }
        }
      } else if (workerMapView) {
        // [NEW] バイナリ走査による統計計算 (超低メモリ)
        const size = 500;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const offset = (y * size + x) * TILE_BYTE_SIZE;
            const fidIdx = workerMapView.getUint16(offset, true);
            if (fidIdx === 65535) continue;

            const fid = workerIndexToFactionId[fidIdx];
            if (fid) {
              if (!factionStats[fid])
                factionStats[fid] = { tiles: 0, cores: 0 };
              factionStats[fid].tiles++;

              const flags = workerMapView.getUint8(offset + 11);
              if (flags & 1) {
                // CORE flag
                const exp = workerMapView.getFloat64(offset + 12, true);
                if (exp === 0 || exp > nowMs) {
                  factionStats[fid].cores++;
                }
              }
            }
          }
        }
      } else {
        // フォールバック: JSON走査
        for (const key in mapState.tiles) {
          const t = mapState.tiles[key];
          const fid = t.factionId || t.faction;
          if (fid) {
            if (!factionStats[fid]) factionStats[fid] = { tiles: 0, cores: 0 };
            factionStats[fid].tiles++;
            if (t.core) {
              const coreFid = t.core.factionId;
              if (!factionStats[coreFid])
                factionStats[coreFid] = { tiles: 0, cores: 0 };
              if (
                coreFid === fid &&
                (!t.core.expiresAt ||
                  new Date(t.core.expiresAt).getTime() > nowMs)
              )
                factionStats[coreFid].cores++;
            }
          }
        }
      }

      const factionsToCalc = new Set(affectedFactionIds);
      factionsToCalc.forEach((fid) => {
        if (factions.factions[fid]) {
          // [NEW] ポイント計算も SAB を優先
          const calculateFactionPointsLocal = (factionId) => {
            // 勢力別タイルインデックスを利用 (これは SAB 同期済み)
            if (factionTileIndex?.data?.has(factionId)) {
              let points = 0;
              const tiles = factionTileIndex.data.get(factionId);
              for (const key of tiles) {
                const [x, y] = key.split("_").map(Number);
                points += getTilePoints(x, y, namedCells);
              }
              return points;
            }
            return shared.calculateFactionPoints(
              factionId,
              mapState,
              namedCells,
            );
          };
          pointUpdates[fid] = calculateFactionPointsLocal(fid);
        }
      });

      parentPort.postMessage({
        success: true,
        taskId,
        results: { factionStats, pointUpdates, workerId },
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "PREPARE_PAINT") {
    try {
      const {
        tiles,
        player,
        action,
        overpaintCount,
        filePaths,
        namedTileSettings,
        coreTileSettings, // [NEW] dataから展開
        enclaveSettings, // [NEW]
      } = data;

      // [NEW] SharedArrayBuffer がある場合は JSON ロードをスキップ
      const mapState = workerMapView
        ? { tiles: {} }
        : data.mapState ||
          (filePaths?.mapState ? loadJSON(filePaths.mapState) : { tiles: {} });

      const factions =
        data.factions ||
        (filePaths?.factions ? loadJSON(filePaths.factions) : { factions: {} });
      if (!factions.factions) factions.factions = {};

      const alliances =
        data.alliances ||
        (filePaths?.alliances
          ? loadJSON(filePaths.alliances)
          : { alliances: {} });
      if (!alliances.alliances) alliances.alliances = {};

      const truces =
        data.truces ||
        (filePaths?.truces ? loadJSON(filePaths.truces) : { truces: {} });
      if (!truces.truces) truces.truces = {};

      const wars =
        data.wars ||
        (filePaths?.wars ? loadJSON(filePaths.wars) : { wars: {} });
      if (!wars.wars) wars.wars = {};

      const namedCells =
        data.namedCells ||
        (filePaths?.namedCells ? loadJSON(filePaths.namedCells) : {});

      // 1. ZOC Check [OPTIMIZED] キャッシュベースの高速版
      // [OPTIMIZED] 同盟メンバーSetをキャッシュから取得
      const alliedFids = getAlliedFactionIds(
        player.factionId,
        alliances,
        factions,
      );

      // キャッシュを更新/構築
      ensureCachesValid(mapState, namedCells, factions, alliances);

      // [OPTIMIZED] キャッシュベースのZOC判定 - O(tiles) instead of O(tiles × namedCells × mapTiles)
      for (const t of tiles) {
        // [FIX] SAB 対応: getTileAt を使用してタイル情報を取得
        const targetTile = getTileAt(t.x, t.y, mapState);
        const targetFactionId = targetTile ? targetTile.factionId : null;

        const { isZoc, isZocReduced } = checkZocWithCache(
          t.x,
          t.y,
          targetFactionId,
          player.factionId,
          alliedFids,
        );

        if (isZoc) {
          t.isZoc = true;
          if (isZocReduced) {
            t.isZocReduced = true;
          }
        }
      }

      // 2. Diplomacy & War Check
      let needsWarDeclaration = false;
      let targetFactionIdForWar = null;
      let targetFactionNameForWar = null;

      for (const t of tiles) {
        // [FIX] SAB 対応: getTileAt を使用してタイル情報を取得
        const existing = getTileAt(t.x, t.y, mapState);
        const efid = existing ? existing.factionId : null;
        if (efid && efid !== player.factionId) {
          const enemyFaction = factions.factions[efid];
          if (enemyFaction) {
            if (
              factions.factions[player.factionId].allianceId &&
              enemyFaction.allianceId ===
                factions.factions[player.factionId].allianceId
            ) {
              return parentPort.postMessage({
                success: false,
                taskId,
                error: "同盟勢力の領土は奪えません",
              });
            }
            const [id1, id2] = [player.factionId, efid].sort();
            const truce = truces.truces[`${id1}_${id2}`];
            if (truce && new Date(truce.expiresAt).getTime() > Date.now()) {
              return parentPort.postMessage({
                success: false,
                taskId,
                error: `勢力「${enemyFaction.name}」とは停戦中のため攻撃できません`,
              });
            }
            // War check logic
            let isAtWar = false;
            const myFidStr = String(player.factionId);
            const targetFidStr = String(efid);
            Object.values(wars.wars).forEach((w) => {
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

            if (!isAtWar) {
              // さらに念入りに同盟チェック (既に上で一部行われているが、needsWarDeclaration の判定においても同盟なら拒否する)
              if (
                factions.factions[player.factionId].allianceId &&
                enemyFaction.allianceId ===
                  factions.factions[player.factionId].allianceId
              ) {
                return parentPort.postMessage({
                  success: false,
                  taskId,
                  error: "同盟勢力の領土は奪えません",
                });
              }

              needsWarDeclaration = true;
              targetFactionIdForWar = efid;
              targetFactionNameForWar = enemyFaction.name;
            }
          }
        }
      }

      // 3. Cost Calculation
      const costResult = calculatePaintCost(
        player,
        tiles,
        mapState,
        factions,
        alliances,
        wars, // [NEW] Pass wars
        action,
        overpaintCount,
        overpaintCount,
        namedTileSettings, // [NEW] Pass settings
        coreTileSettings, // [NEW] Pass core settings
        enclaveSettings, // [NEW] Pass enclave settings
      );
      if (costResult.error)
        return parentPort.postMessage({
          success: false,
          taskId,
          error: costResult.error,
        });

      parentPort.postMessage({
        success: true,
        taskId,
        results: {
          ...costResult,
          needsWarDeclaration,
          targetFactionId: targetFactionIdForWar,
          targetFactionName: targetFactionNameForWar,
          workerId,
        },
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "CALCULATE_RANKS") {
    // 勢力ランキング計算タスク (並列対応)
    const { filePaths, tiles, preCalculatedStats } = data; // tiles があればチャンク処理
    try {
      const factionsData = loadJSON(filePaths.factions, { factions: {} });
      let stats = preCalculatedStats || {};

      if (!preCalculatedStats) {
        // [OPTIMIZATION] SharedArrayBuffer がある場合は JSON ロードをスキップ
        const hasSAB = !!workerMapView;
        const namedCells = loadJSON(filePaths.namedCells, {});

        if (hasSAB) {
          if (workerFactionStatsView) {
            // [NEW] Use FactionStatsSAB (O(F))
            for (let i = 1; i < MAX_FACTIONS_LIMIT; i++) {
              const fid = workerIndexToFactionId[i];
              if (!fid || !factionsData.factions[fid]) continue;

              const idx = i * STATS_INTS_PER_FACTION;
              const tiles = Atomics.load(workerFactionStatsView, idx + 0);
              const points = Atomics.load(workerFactionStatsView, idx + 4); // Offset 4 is totalPoints

              if (tiles > 0 || points > 0) {
                stats[fid] = { id: fid, tiles, points };
              }
            }
          } else {
            // バイナリ走査 (超高速)
            const size = 500;
            for (let y = 0; y < size; y++) {
              for (let x = 0; x < size; x++) {
                const offset = (y * size + x) * TILE_BYTE_SIZE;
                const fidIdx = workerMapView.getUint16(offset, true);
                if (fidIdx === 65535) continue;

                const fid = workerIndexToFactionId[fidIdx];
                if (fid && factionsData.factions[fid]) {
                  if (!stats[fid])
                    stats[fid] = { id: fid, points: 0, tiles: 0 };
                  stats[fid].tiles++;
                  stats[fid].points += getTilePoints(x, y, namedCells);
                }
              }
            }
          }
        } else {
          // タイル走査 (チャンクまたはフル) - JSONベース
          const mapData = tiles
            ? { tiles }
            : loadJSON(filePaths.mapState, { tiles: {} });

          Object.entries(mapData.tiles).forEach(([key, tile]) => {
            const fid = tile.faction || tile.factionId;
            if (fid && factionsData.factions[fid]) {
              if (!stats[fid]) stats[fid] = { id: fid, points: 0, tiles: 0 };
              const [x, y] = key.split("_").map(Number);
              stats[fid].tiles++;
              stats[fid].points += getTilePoints(x, y, namedCells);
            }
          });
        }

        // チャンク処理 (並列) の場合はここで中間結果を返す
        if (tiles) {
          parentPort.postMessage({
            success: true,
            taskId,
            results: { stats },
            workerId,
          });
          return;
        }
      }

      // 勢力データのボーナスポイントを加算 (シングルタスク / マージ後の最終処理用)
      const players = loadJSON(filePaths.players, { players: {} });
      const settings = loadJSON(filePaths.settings, { apSettings: {} });
      const alliances = loadJSON(filePaths.alliances, { alliances: {} });

      const factionPoints = {};
      Object.keys(factionsData.factions).forEach((fid) => {
        const f = factionsData.factions[fid];
        const basePoints = stats[fid] ? stats[fid].points : 0;
        const totalPoints = basePoints + (f.bonusPoints || 0);
        factionPoints[fid] = {
          id: fid,
          tiles: stats[fid] ? stats[fid].tiles : 0,
          points: totalPoints,
        };
      });

      const sorted = Object.values(factionPoints).sort(
        (a, b) => b.points - a.points,
      );

      let currentRank = 1;
      const preliminaryRanks = sorted.map((s, i) => {
        if (i > 0 && s.points < sorted[i - 1].points) {
          currentRank = i + 1;
        }
        return {
          id: s.id,
          rank: currentRank,
          tiles: s.tiles,
          points: s.points,
        };
      });

      // エンリッチメント処理 (shared.js の関数を使用)
      const preCalcStats = {
        factionPoints: Object.fromEntries(
          preliminaryRanks.map((r) => [r.id, r.points]),
        ),
      };
      const top3Alliances = getTop3AllianceIds(
        alliances.alliances,
        factionsData,
        preCalcStats,
      );

      const finalRanks = preliminaryRanks.map((r) => {
        const faction = factionsData.factions[r.id];
        if (!faction) return r;

        // アクティブメンバーの取得 (handleApRefillと同じ1週間基準)
        const now = Date.now();
        const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
        const activeMembers = (
          Array.isArray(faction.members) ? faction.members : []
        ).filter((mid) => {
          const p = players.players[mid];
          return p && now - new Date(p.lastActive || 0).getTime() <= ONE_WEEK;
        });

        const { activeMemberCount, validMemberCount } =
          calculateFactionSharedAPLimit(
            faction,
            players,
            settings,
            activeMembers,
          );

        const isWeak = isWeakFactionUnified(
          r.rank,
          activeMemberCount,
          r.id,
          faction.allianceId,
          top3Alliances,
        );

        return {
          ...r,
          isWeak,
          activeMemberCount,
          validMemberCount,
        };
      });

      parentPort.postMessage({
        success: true,
        taskId,
        results: { ranks: finalRanks, updatedStats: stats },
        workerId,
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "PROCESS_DAILY_BONUS") {
    // 毎日0時のボーナス集計タスク (並列対応)
    const { filePaths, tiles } = data;
    try {
      const mapData = tiles
        ? { tiles }
        : loadJSON(filePaths.mapState, { tiles: {} });
      const factionsData = loadJSON(filePaths.factions, { factions: {} });
      const stats = {};
      const updatedTiles = {};
      let resetCount = 0;

      // 全タイル走査
      Object.entries(mapData.tiles).forEach(([key, tile]) => {
        // 1. ネームドマスの累積ボーナスリセット
        if (tile.namedData && tile.namedData.siegeBonus > 0) {
          tile.namedData.siegeBonus = 0;
          updatedTiles[key] = tile;
          resetCount++;
        }

        // 2. 特別タイル (100-149) の集計
        const [x, y] = key.split("_").map(Number);
        if (isSpecialTile(x, y)) {
          const fid = tile.faction || tile.factionId;
          if (fid && factionsData.factions[fid]) {
            stats[fid] = (stats[fid] || 0) + 1;
          }
        }
      });

      // チャンク処理 (並列) の場合はここで中間結果を返す
      if (tiles) {
        parentPort.postMessage({
          success: true,
          taskId,
          results: { stats, updatedTiles, resetCount },
          workerId,
        });
        return;
      }

      // シングルタスク / マージ後の最終処理用
      parentPort.postMessage({
        success: true,
        taskId,
        results: { stats, updatedTiles, resetCount },
        workerId,
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "CALCULATE_CLUSTERS") {
    // 即時中核化のためのクラスタ計算タスク
    const { filePaths, factionId, tilesInMapKeys } = data;
    // tilesInMapKeys: メインスレッドから渡された対象勢力のタイルキーリスト (高速化用)
    try {
      // [OPTIMIZATION] SAB がある場合は JSON ロードをスキップ
      const mapState = workerMapView
        ? { tiles: {} }
        : loadJSON(filePaths.mapState, { tiles: {} });

      // Worker内でロジック実行
      // sharedUtils.getFactionClusterInfoWorker は、内部で getTileAt を使っているため、
      // getTileAt が SAB 対応していれば、mapState.tiles が空でも動作する。
      const clusterInfo = getFactionClusterInfoWorker(
        factionId,
        mapState,
        [],
        tilesInMapKeys,
      );

      // 新たに中核化すべきタイルのリスト抽出
      const tilesToCoreify = [];
      clusterInfo.clusters.forEach((cluster) => {
        if (cluster.hasCore) {
          cluster.tiles.forEach((tKey) => {
            // [FIX] SAB 対応: getTileAt を使用してタイル情報を取得
            const [x, y] = tKey.split("_").map(Number);
            const t = getTileAt(x, y, mapState);

            if (t && !t.core) {
              const paintedTime = new Date(t.paintedAt || 0).getTime();
              // 5分ルール (Worker側で判定)
              if (Date.now() - paintedTime >= 5 * 60 * 1000) {
                tilesToCoreify.push(tKey);
              }
            }
          });
        }
      });

      parentPort.postMessage({
        success: true,
        taskId,
        results: { tilesToCoreify },
        workerId,
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "GET_MAP_STATS_PARTIAL") {
    // マップ統計計算の並列化用
    try {
      const { tileKeys, filePaths } = data;
      const mapState =
        data.mapState ||
        (filePaths?.mapState
          ? loadJSON(filePaths.mapState, { tiles: {} })
          : { tiles: {} });
      const stats = { factions: {} };

      const targetKeys = tileKeys || Object.keys(mapState.tiles);

      if (workerMapView) {
        // [NEW] バイナリ走査
        for (const key of targetKeys) {
          const [x, y] = key.split("_").map(Number);
          const offset = (y * 500 + x) * TILE_BYTE_SIZE;
          const fidIdx = workerMapView.getUint16(offset, true);
          if (fidIdx === 65535) continue;

          const fid = workerIndexToFactionId[fidIdx];
          if (!fid) continue;

          if (!stats.factions[fid]) {
            stats.factions[fid] = {
              tileCount: 0,
              totalPoints: 0,
              playerTileCounts: {},
              playerTilePoints: {},
            };
          }
          const points = getTilePoints(x, y);
          stats.factions[fid].tileCount++;
          stats.factions[fid].totalPoints += points;
          // Note: paintedBy (PID) は現在 SAB に格納していないため、
          // もし pid が必要な場合は mapState から引くか、SAB 構造を拡張する必要がある。
          // ひとまず mapState から引く (mapState はここでは空か partial なので注意)
          const t = mapState.tiles[key];
          const pid = t ? t.paintedBy : null;
          if (pid) {
            stats.factions[fid].playerTileCounts[pid] =
              (stats.factions[fid].playerTileCounts[pid] || 0) + 1;
            stats.factions[fid].playerTilePoints[pid] =
              (stats.factions[fid].playerTilePoints[pid] || 0) + points;
          }
        }
      } else {
        // フォールバック
        for (const key of targetKeys) {
          const t = mapState.tiles[key];
          if (!t) continue;
          const fid = t.faction || t.factionId;
          if (!fid) continue;

          if (!stats.factions[fid]) {
            stats.factions[fid] = {
              tileCount: 0,
              totalPoints: 0,
              playerTileCounts: {},
              playerTilePoints: {},
            };
          }
          const [x, y] = key.split("_").map(Number);
          const points = getTilePoints(x, y);
          stats.factions[fid].tileCount++;
          stats.factions[fid].totalPoints += points;

          const pid = t.paintedBy;
          if (pid) {
            stats.factions[fid].playerTileCounts[pid] =
              (stats.factions[fid].playerTileCounts[pid] || 0) + 1;
            stats.factions[fid].playerTilePoints[pid] =
              (stats.factions[fid].playerTilePoints[pid] || 0) + points;
          }
        }
      }

      parentPort.postMessage({
        success: true,
        taskId,
        results: { stats, workerId },
        workerId,
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "GENERATE_LITE_MAP_PARTIAL") {
    // 軽量マップ生成の並列化用
    try {
      const { tileKeys, filePaths, playerNames } = data;
      const mapState =
        data.mapState ||
        (filePaths?.mapState
          ? loadJSON(filePaths.mapState, { tiles: {} })
          : { tiles: {} });
      const liteTiles = {};

      const targetKeys = tileKeys || Object.keys(mapState.tiles);

      if (workerMapView) {
        // [NEW] バイナリ走査
        for (const key of targetKeys) {
          const [x, y] = key.split("_").map(Number);
          const offset = (y * 500 + x) * TILE_BYTE_SIZE;
          const fidIdx = workerMapView.getUint16(offset, true);
          if (fidIdx === 65535) continue;

          const fid = workerIndexToFactionId[fidIdx];
          if (!fid) continue;

          // 最小限の情報を生成 (mapStateに一部依存)
          const t = mapState.tiles[key] || {};
          const playerId = t.paintedBy;
          liteTiles[key] = {
            f: fid,
            c: `#${workerMapView
              .getUint32(offset + 2, true)
              .toString(16)
              .padStart(6, "0")}`,
            p: playerId,
            pn: playerId ? playerNames[playerId] || null : null,
            o: workerMapView.getUint8(offset + 6),
            x,
            y,
          };
          const flags = workerMapView.getUint8(offset + 7);
          if (flags & 1) {
            // Core
            liteTiles[key].core = {
              fid: fid,
              exp: workerMapView.getFloat64(offset + 8, true) || null,
            };
          }
        }
      } else {
        // フォールバック
        for (const key of targetKeys) {
          const tile = mapState.tiles[key];
          if (!tile) continue;
          const [x, y] = key.split("_").map(Number);
          const playerId = tile.paintedBy;
          liteTiles[key] = {
            f: tile.faction || tile.factionId,
            c: tile.customColor || tile.color,
            cc: !!tile.customColor,
            p: playerId,
            pn: playerId ? playerNames[playerId] || null : null,
            o: tile.overpaint || 0,
            x,
            y,
          };
          if (tile.core) {
            liteTiles[key].core = {
              fid: tile.core.factionId,
              exp: tile.core.expiresAt || null,
            };
          }
          if (tile.coreificationUntil) {
            liteTiles[key].coreUntil = tile.coreificationUntil;
            liteTiles[key].coreFid = tile.coreificationFactionId;
          }
        }
      }

      parentPort.postMessage({
        success: true,
        taskId,
        results: { liteTiles, workerId },
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "GENERATE_BINARY_MAP_PARTIAL") {
    // バイナリマップ生成の並列化用 (タイルデータのみ生成。ヘッダーはメインで結合)
    try {
      const { tileKeys, filePaths, factionMap } = data;
      const mapState =
        data.mapState ||
        (filePaths?.mapState
          ? loadJSON(filePaths.mapState, { tiles: {} })
          : { tiles: {} });
      const targetKeys = tileKeys || Object.keys(mapState.tiles);
      const tileCount = targetKeys.length;
      const TILE_DATA_SIZE = TILE_BYTE_SIZE;

      const buffer = Buffer.allocUnsafe(tileCount * TILE_DATA_SIZE);
      let offset = 0;

      for (const key of targetKeys) {
        const tile = mapState.tiles[key];
        if (!tile) continue;
        const [x, y] = key.split("_").map(Number);
        const fid = tile.faction || tile.factionId;
        const fidIdx = fid ? (factionMap[fid] ?? 65535) : 65535;

        buffer.writeInt16LE(x, offset);
        offset += 2;
        buffer.writeInt16LE(y, offset);
        offset += 2;
        buffer.writeUInt16LE(fidIdx, offset);
        offset += 2;

        const colorStr = tile.customColor || tile.color || "#ffffff";
        const colorInt = parseInt(colorStr.replace("#", ""), 16) || 0xffffff;
        buffer.writeUInt32LE(colorInt, offset);
        offset += 4;

        let flags = 0;
        if (tile.core) flags |= 1;
        if (tile.coreificationUntil) flags |= 2;
        buffer.writeUInt8(flags, offset);
        offset += 1;

        const exp = tile.core
          ? new Date(tile.core.expiresAt || 0).getTime()
          : tile.coreificationUntil
            ? new Date(tile.coreificationUntil).getTime()
            : 0;
        buffer.writeDoubleLE(exp, offset);
        offset += 8;

        buffer.writeUInt8(0, offset);
        offset += 1;
      }

      parentPort.postMessage(
        {
          success: true,
          taskId,
          results: { binary: buffer, workerId },
        },
        [buffer.buffer],
      );
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "PREPARE_PAINT_PARTIAL") {
    // 塗装見積もりの並列化用
    try {
      const {
        tiles, // チャンク
        fullTiles, // 全体
        player,
        action,
        overpaintCount,
        filePaths,
        namedTileSettings,
        coreTileSettings,
        enclaveSettings,
      } = data;

      const mapState = data.mapState || loadJSON(filePaths.mapState);
      const factions = data.factions || loadJSON(filePaths.factions);
      const alliances = data.alliances || loadJSON(filePaths.alliances);
      const wars = data.wars || loadJSON(filePaths.wars);
      const namedCells = data.namedCells || loadJSON(filePaths.namedCells);

      // ZOC判定 (チャンクに対して実行)
      ensureCachesValid(mapState, namedCells, factions, alliances);
      const alliedFids = getAlliedFactionIds(
        player.factionId,
        alliances,
        factions,
      );

      tiles.forEach((t) => {
        const targetTile = mapState.tiles[`${t.x}_${t.y}`];
        const targetFactionId = targetTile ? targetTile.factionId : null;
        const { isZoc, isZocReduced } = checkZocWithCache(
          t.x,
          t.y,
          targetFactionId,
          player.factionId,
          alliedFids,
        );
        if (isZoc) {
          t.isZoc = true;
          if (isZocReduced) t.isZocReduced = true;
        }
      });

      // コスト計算 (チャンクに対して実行)
      // Note: getFactionClusterInfo 内で fullTiles を使用することで一貫性を保つ
      const costResult = calculatePaintCost(
        player,
        tiles,
        mapState,
        factions,
        alliances,
        wars,
        action,
        overpaintCount,
        namedTileSettings,
        coreTileSettings,
        enclaveSettings,
        fullTiles, // calculatePaintCost を拡張して fullTiles を受け取れるようにする
      );

      parentPort.postMessage({
        success: true,
        taskId,
        results: { ...costResult, workerId },
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "PROCESS_COREIFICATION") {
    // 中核化維持・確定処理タスク (並列対応)
    const { filePaths, coreTileSettings, tiles, factionIds } = data;
    try {
      // JSONロードを回避 (SABがある場合)
      const factionsData = loadJSON(filePaths.factions, { factions: {} });
      const nowMs = Date.now();
      const updatedTiles = {};
      const canUseSAB = !!workerMapView;

      // 1. 期限切れチェック & カウントダウン完了 & 恒久化
      if (canUseSAB) {
        // SAB走査
        const size = 500;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const offset = (y * size + x) * TILE_BYTE_SIZE;
            const flags = workerMapView.getUint8(offset + 11);

            // Flag 1: Core, Flag 2: Coreification
            if (flags & 3) {
              const exp = workerMapView.getFloat64(offset + 12, true);
              const fidIdx = workerMapView.getUint16(offset, true);
              const fid = workerIndexToFactionId[fidIdx];

              const key = `${x}_${y}`;

              // (A) Core Expiry (Flag 1)
              if (flags & 1) {
                if (exp > 0 && exp <= nowMs) {
                  // Expired
                  // Retrieve full tile to update
                  const currentTile = getTileFromSAB(x, y);
                  updatedTiles[key] = { ...currentTile };
                  delete updatedTiles[key].core;
                } else if (fid) {
                  // Check permanence (ownership match) - THIS LOGIC IS COMPLEX IN BINARY
                  // In binary we store 'exp'. If 'exp' is > 0 and owner matches core faction,
                  // we usually clear 'exp' in JSON processing?
                  // Wait, original logic checks: if (fid === tile.core.factionId) -> expiresAt deleted.
                  // In SAB, 'exp' is just a number. We need to check who owns the CORE.
                  // But SAB doesn't store Core Owner separately from Tile Owner?
                  // Wait! JSON stores `tile.core = { factionId, expiresAt }`.
                  // If tile owner != core owner, it's a "captured" core? Or invalid?
                  // Usually Core Owner == Tile Owner for valid cores.
                  // If tile is taken by enemy, Core is usually destroyed immediately or persists?
                  // If persist, we need Core Owner ID.
                  // SAB doesn't seem to store Core Owner ID separately!
                  // It only stores 'fidIdx' (Tile Owner).
                  // Assumption: Valid Cores are owned by Tile Owner.
                  // If Tile Owner != Core Owner, it's an anomaly or the core logic removes it?
                  // Original: if (fid === tile.core.factionId) -> Permanence.
                  // This means if I own the tile and I own the core, it becomes permanent.
                  // This runs EVERY minute.
                  // If valid, we set exp = 0 (Permanent).
                  if (exp > 0) {
                    // Check if we should make it permanent?
                    // If tile owner matches, we set exp=0 in JSON.
                    // In SAB, we can't update SAB here (Worker is Read-Only usually? Or we return updates?)
                    // We return updatedTiles.
                    // But we assume Core Owner == Tile Owner if exp > 0?
                    // Let's assume yes for now.
                    // We post update to Main Thread to save JSON.
                    const currentTile = getTileFromSAB(x, y);
                    // If standard core logic implies CoreOwner == TileOwner
                    updatedTiles[key] = {
                      ...currentTile,
                      core: { factionId: fid, expiresAt: null },
                    };
                  }
                }
              }

              // (B) Coreification Countdown (Flag 2)
              if (flags & 2) {
                if (exp <= nowMs) {
                  // Countdown Complete
                  const currentTile = getTileFromSAB(x, y);
                  // Need coreificationFactionId? It's not in SAB!
                  // We need to verify if tile owner is still the one who started coreification.
                  // If not in SAB, we cannot fully verify in pure Binary?
                  // But wait, if Tile Owner changed, the 'flags' might still be set?
                  // Or checks on main thread?
                  // If we don't have coreificationFactionId, we might need fallback or assume Tile Owner.
                  // BUT, if Tile changed hands, coreification should have been cancelled?
                  // If it wasn't cancelled in SAB, then we have a problem.
                  // Assuming Tile Owner is the candidate.
                  if (fid) {
                    updatedTiles[key] = {
                      ...currentTile,
                      core: { factionId: fid, expiresAt: null },
                      coreificationUntil: null,
                      coreificationFactionId: null,
                    };
                  }
                }
              }
            }
          }
        }
      } else {
        // Fallback to JSON
        const mapData = tiles
          ? { tiles }
          : loadJSON(filePaths.mapState, { tiles: {} });

        // ... (Original Code for A & B)
        Object.entries(mapData.tiles).forEach(([key, tile]) => {
          // ... (Same as original)
          // (A) 期限切れチェック & 恒久化
          if (tile.core && tile.core.expiresAt) {
            if (new Date(tile.core.expiresAt).getTime() <= nowMs) {
              updatedTiles[key] = { ...tile };
              delete updatedTiles[key].core;
            } else {
              const fid = tile.faction || tile.factionId;
              if (fid === tile.core.factionId) {
                updatedTiles[key] = { ...tile };
                delete updatedTiles[key].core.expiresAt;
              }
            }
          }

          // (B) [NEW] 中核化カウントダウン完了のチェック
          if (
            !updatedTiles[key] &&
            tile.coreificationUntil &&
            new Date(tile.coreificationUntil).getTime() <= nowMs &&
            tile.coreificationFactionId
          ) {
            const fid = tile.faction || tile.factionId;
            if (fid === tile.coreificationFactionId) {
              updatedTiles[key] = {
                ...tile,
                core: { factionId: fid, expiresAt: null },
                coreificationUntil: null,
                coreificationFactionId: null,
              };
            }
          }
        });
      }

      // 2. 自動中核化 (拡大)
      const targetFids = factionIds || Object.keys(factionsData.factions);

      // Cluster info needs map state logic.
      // If SAB, getFactionClusterInfoWorker uses SAB/Index.
      // We iterate targetFids.

      const fullMapState = canUseSAB
        ? { tiles: {} }
        : tiles
          ? { tiles }
          : loadJSON(filePaths.mapState, { tiles: {} });

      // Build factionTiles map if needed for expansion
      // If SAB, we can use buildFactionTileIndex() or just rely on cluster info?
      // getFactionClusterInfoWorker takes 'factionId'.
      // It iterates 'knownFactionKeys' or 'factionTileIndex'.
      // So we should build/ensure factionTileIndex is ready!

      if (
        canUseSAB &&
        (!factionTileIndex || factionTileIndex.version !== cacheVersion)
      ) {
        factionTileIndex = {
          version: cacheVersion,
          data: buildFactionTileIndex(null),
        };
      }

      targetFids.forEach((fid) => {
        // Use Index to check count
        // If expansion skipped if too small/large?
        if (canUseSAB) {
          const fKeys = factionTileIndex?.data?.get(fid);
          if (!fKeys || fKeys.size === 0) return;

          // We pass 'knownFactionKeys' (Set or Array) to cluster worker
          // getFactionClusterInfoWorker handles it.
          const clusterInfo = getFactionClusterInfoWorker(fid, null, [], fKeys); // mapState null ok if tiles provided

          clusterInfo.clusters.forEach((cluster) => {
            if (!cluster.hasCore) return;

            cluster.tiles.forEach((key) => {
              // Check logic for each tile in cluster
              // We need to read Tile from SAB or Index.
              // getTileFromSAB(x, y)
              if (updatedTiles[key]) return;

              const [tx, ty] = key.split("_").map(Number);
              const offset = (ty * 500 + tx) * TILE_BYTE_SIZE;

              // Check existing Core
              const flags = workerMapView.getUint8(offset + 11);
              // If Core (bit 0) exists, skip (unless we want to verify ownership, but cluster logic handles ownership?)
              // Wait, Cluster logic includes tiles of the faction.
              // If I have a core, I skip.
              if (flags & 1) return;
              // If different core owner? (Anomaly). SAB doesn't store Core Owner.
              // Assuming Tile Owner == Core Owner.

              let shouldCore = false;
              const instantThreshold =
                coreTileSettings?.instantCoreThreshold ?? 400;
              if (fKeys.size <= instantThreshold) {
                shouldCore = true;
              } else {
                // Check paintedAt
                const paintedAtSec = workerMapView.getUint32(offset + 20, true);
                const pTime = paintedAtSec * 1000;
                if (nowMs - pTime >= 60 * 60 * 1000) {
                  shouldCore = true;
                }
              }

              if (shouldCore) {
                const t = getTileFromSAB(tx, ty);
                updatedTiles[key] = {
                  ...t,
                  core: { factionId: fid, expiresAt: null },
                  coreificationUntil: null,
                  coreificationFactionId: null,
                };
              }
            });
          });
        } else {
          // Fallback to JSON logic (existing)
          // ... (Omitted for brevity in thought, but included in implementation)
          // I will invoke the Original JSON loop logic here.
          const fTiles = []; // Need to populate from fullMapState
          Object.entries(fullMapState.tiles).forEach(([k, t]) => {
            const tfid = t.faction || t.factionId;
            if (tfid === fid) fTiles.push({ key: k, ...t });
          });

          if (fTiles.length === 0) return;
          const knownKeys = fTiles.map((t) => t.key);
          const clusterInfo = getFactionClusterInfoWorker(
            fid,
            fullMapState,
            [],
            knownKeys,
          );
          // ... (Process clusters same as before)
          // (Copy pasting logic)
          clusterInfo.clusters.forEach((cluster) => {
            if (!cluster.hasCore) return;

            cluster.tiles.forEach((key) => {
              const tile = fullMapState.tiles[key];
              if (!tile) return;
              if (updatedTiles[key]) return;

              if (tile.core && tile.core.factionId === fid) return;
              if (tile.core && tile.core.factionId !== fid) return;

              let shouldCore = false;
              const instantThreshold =
                coreTileSettings?.instantCoreThreshold ?? 400;
              if (fTiles.length <= instantThreshold) {
                shouldCore = true;
              } else {
                const pTime = new Date(tile.paintedAt || 0).getTime();
                if (nowMs - pTime >= 60 * 60 * 1000) {
                  shouldCore = true;
                }
              }

              if (shouldCore) {
                updatedTiles[key] = {
                  ...tile,
                  core: { factionId: fid, expiresAt: null },
                  coreificationUntil: null,
                  coreificationFactionId: null,
                };
              }
            });
          });
        }
      });

      parentPort.postMessage({
        success: true,
        taskId,
        results: { updatedTiles },
        workerId,
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "RECALCULATE_POINTS") {
    try {
      const mapState =
        data.mapState ||
        (data.filePaths?.mapState
          ? loadJSON(data.filePaths.mapState, { tiles: {} }, true)
          : { tiles: {} });
      if (!mapState.tiles) mapState.tiles = {};
      const factions =
        data.factions ||
        (data.filePaths?.factions
          ? loadJSON(data.filePaths.factions, { factions: {} }, true)
          : { factions: {} });
      if (!factions.factions) factions.factions = {};
      const nowMs = Date.now();

      const factionStats = {};
      const factionTerritoryPoints = {};
      const factionTiles = {}; // fid -> [keys]

      Object.keys(factions.factions).forEach((fid) => {
        factionStats[fid] = { tiles: 0, cores: 0 };
        factionTerritoryPoints[fid] = 0;
        factionTiles[fid] = [];
      });

      // メモリ最適化: Object.entries/values の代わりに for-in ループを使用
      for (const key in mapState.tiles) {
        const t = mapState.tiles[key];
        const tileFid = t.factionId || t.faction;
        if (tileFid && factionStats[tileFid]) {
          factionStats[tileFid].tiles++;
          factionTiles[tileFid].push(key);
          const [x, y] = key.split("_").map(Number);
          factionTerritoryPoints[tileFid] += getTilePoints(x, y);
        }
        if (t.core) {
          const coreFid = t.core.factionId;
          if (factionStats[coreFid]) {
            if (
              coreFid === tileFid &&
              (!t.core.expiresAt ||
                new Date(t.core.expiresAt).getTime() > nowMs)
            ) {
              factionStats[coreFid].cores++;
            }
          }
        }
      }

      const destroyedFids = [];
      const updates = {};
      const destroyedTileKeys = {}; // fid -> [keys]

      Object.keys(factions.factions).forEach((fid) => {
        const stats = factionStats[fid];
        if (stats.cores === 0) {
          destroyedFids.push(fid);
          destroyedTileKeys[fid] = factionTiles[fid] || [];
        } else {
          const newPoints = factionTerritoryPoints[fid] || 0;
          updates[fid] = newPoints;
        }
      });

      parentPort.postMessage({
        success: true,
        taskId,
        results: { updates, destroyedFids, destroyedTileKeys, workerId },
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "GENERATE_CESSION_IMAGE") {
    try {
      const { tiles, factions, highlightTiles, tempDir } = data;
      const filePaths = data.filePaths || {};

      ensureFontsRegistered();
      // tilesが渡されていない場合はファイルからロード
      let mapTiles = tiles;
      if (!mapTiles && filePaths.mapState) {
        const mapState = loadJSON(filePaths.mapState, { tiles: {} });
        mapTiles = mapState.tiles;
      }

      const resultPath = generateCessionMapImage(
        mapTiles,
        factions,
        highlightTiles,
        tempDir,
      );
      parentPort.postMessage({ success: true, taskId, results: resultPath });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "RECALCULATE_CORES") {
    try {
      const { filePaths, coreTileSettings } = data;
      const mapState = loadJSON(filePaths.mapState, { tiles: {} });
      const factions = loadJSON(filePaths.factions, { factions: {} });

      const { changed, updatedTiles } = recalculateAllFactionCores(
        mapState,
        factions,
        coreTileSettings,
      );

      if (changed) {
        // 保存はWorkerで行い、メインプロセスには完了通知のみ送る
        // async/await を使用して確実に保存してからレスポンスを返す
        await saveJSONInternal(filePaths.mapState, mapState);
      }

      parentPort.postMessage({
        success: true,
        taskId,
        results: { changed, updatedTiles, workerId },
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "CORE_MAINTENANCE_FULL") {
    // メンテナンス全般をWorker内で一括処理
    const { filePaths, coreTileSettings } = data;
    try {
      const mapData = loadJSON(filePaths.mapState, { tiles: {} });
      const factionsData = loadJSON(filePaths.factions, { factions: {} });
      const nowMs = Date.now();
      const updatedTiles = {};

      // 1. 期限切れ・恒久化チェック (全タイル)
      Object.entries(mapData.tiles).forEach(([key, tile]) => {
        if (tile.core && tile.core.expiresAt) {
          if (new Date(tile.core.expiresAt).getTime() <= nowMs) {
            updatedTiles[key] = { ...tile };
            delete updatedTiles[key].core;
          } else {
            const fid = tile.faction || tile.factionId;
            if (fid === tile.core.factionId) {
              updatedTiles[key] = { ...tile };
              delete updatedTiles[key].core.expiresAt;
            }
          }
        }
      });

      // [OPTIMIZATION] マップデータのインデックス化 (高速化のため)
      coordinateIndex = buildCoordinateIndex(mapData);

      // 2. 自動中核化 (全勢力)
      const targetFids = Object.keys(factionsData.factions);
      const factionTiles = {};
      Object.entries(mapData.tiles).forEach(([key, t]) => {
        const fid = t.faction || t.factionId;
        if (fid) {
          if (!factionTiles[fid]) factionTiles[fid] = [];
          factionTiles[fid].push({ key, ...t });
        }
      });

      targetFids.forEach((fid) => {
        const fTiles = factionTiles[fid] || [];
        if (fTiles.length === 0) return;

        const knownKeys = fTiles.map((t) => t.key);
        const clusterInfo = getFactionClusterInfoWorker(
          fid,
          mapData,
          [],
          knownKeys,
        );

        clusterInfo.clusters.forEach((cluster) => {
          if (!cluster.hasCore) return;
          cluster.tiles.forEach((key) => {
            const tile = mapData.tiles[key];
            if (!tile || updatedTiles[key]) return;
            if (tile.core && tile.core.factionId === fid) return;
            if (tile.core && tile.core.factionId !== fid) return;

            const paintedTime = new Date(tile.paintedAt || 1).getTime();
            const heldTime = nowMs - paintedTime;
            const threshold = coreTileSettings?.instantCoreThreshold ?? 400;
            const requiredMs =
              Math.floor((cluster.tiles.length - 1) / threshold) * 3600000;

            if (heldTime >= requiredMs) {
              updatedTiles[key] = { ...tile, core: { factionId: fid } };
            }
          });
        });
      });

      parentPort.postMessage({
        success: true,
        taskId,
        results: { updatedTiles },
        workerId,
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "RECALCULATE_CORES_PARTIAL") {
    try {
      const { factionIds, startY, endY, filePaths, coreTileSettings } = data;
      // Zero-Copy: ディスクから直接読み込み
      const mapState = loadJSON(filePaths.mapState, { tiles: {} }, true);
      // Factions data is needed for expansion logic
      // Note: We only need factionIds list for expansion, but expandFactionCores might need faction properties?
      // Actually expandFactionCores only needs mapState and fid. It calls getClusters.
      // So checking existence of faction might be good but maybe not strictly required if we trust input factionIds.
      // However, to be safe and consistent with logic, let's load factions to check if they exist?
      // server.js logic passes Object.keys(factions).
      // Let's assume input factionIds are valid.

      const nowMs = Date.now();
      let changed = false;
      const updatedTiles = {};

      // 1. 期限切れチェック (部分範囲スキャン)
      // 指定された Y 座標の範囲内を走査
      for (let y = startY; y <= endY; y++) {
        for (let x = 0; x < MAP_SIZE; x++) {
          const key = `${x}_${y}`;
          const tile = mapState.tiles[key];
          if (!tile) continue;

          if (tile.core && tile.core.expiresAt) {
            if (new Date(tile.core.expiresAt).getTime() <= nowMs) {
              delete tile.core;
              changed = true;
              updatedTiles[key] = tile;
            } else {
              const fid = tile.faction || tile.factionId;
              if (fid === tile.core.factionId) {
                delete tile.core.expiresAt;
                changed = true;
                updatedTiles[key] = tile;
              }
            }
          }
        }
      }

      // 2. 拡大チェック (部分勢力リスト)
      if (factionIds && factionIds.length > 0) {
        factionIds.forEach((fid) => {
          if (
            expandFactionCores(
              fid,
              mapState,
              nowMs,
              updatedTiles,
              coreTileSettings,
            )
          ) {
            changed = true;
          }
        });
      }

      parentPort.postMessage({
        success: true,
        taskId,
        results: { changed, updatedTiles, workerId },
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "CHECK_SECRET_TRIGGERS") {
    try {
      const { filePaths } = data;
      // Zero-Copy: Workerレベルのキャッシュを使用してディスクから直接取得
      const gameIds = loadJSON(filePaths.gameIds, {}, true);
      const players = loadJSON(filePaths.players, { players: {} });
      const factions = loadJSON(filePaths.factions, { factions: {} });
      const namedCells = loadJSON(filePaths.namedCells, {});

      const stats = {};
      const pointsStats = {};

      if (workerMapView) {
        const size = 500;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const offset = (y * size + x) * TILE_BYTE_SIZE;
            const fidIdx = workerMapView.getUint16(offset, true);
            if (fidIdx === 65535) continue;
            const fid = workerIndexToFactionId[fidIdx];
            if (fid) {
              stats[fid] = (stats[fid] || 0) + 1;
              pointsStats[fid] =
                (pointsStats[fid] || 0) + getTilePoints(x, y, namedCells);
            }
          }
        }
      } else {
        const mapState = loadJSON(filePaths.mapState, { tiles: {} });
        for (const key in mapState.tiles) {
          const t = mapState.tiles[key];
          const fid = t.faction || t.factionId;
          if (fid) {
            stats[fid] = (stats[fid] || 0) + 1;
            const [x, y] = key.split("_").map(Number);
            pointsStats[fid] =
              (pointsStats[fid] || 0) + getTilePoints(x, y, namedCells);
          }
        }
      }
      const sortedRanks = Object.entries(stats)
        .map(([id, tiles]) => ({ id, tiles }))
        .sort((a, b) => b.tiles - a.tiles)
        .map((s, i) => ({ id: s.id, rank: i + 1, tiles: s.tiles }));

      const ranksMap = {};
      sortedRanks.forEach((r) => (ranksMap[r.id] = r.rank));

      const gameKeys = data.gameKeys || Object.keys(gameIds);
      const appliedTriggers = [];

      gameKeys.forEach((authKeyInGameIds) => {
        const info = gameIds[authKeyInGameIds];
        if (!info || !info.secretTriggers || info.secretTriggers.length === 0)
          return;

        // プレイヤーの特定
        let playerId = authKeyInGameIds;
        let player = players.players[playerId];

        if (!player && info.id) {
          const possibleId = "game-" + info.id;
          if (players.players[possibleId]) {
            playerId = possibleId;
            player = players.players[playerId];
          }
        }
        if (!player) {
          const entry = Object.entries(players.players).find(
            ([, p]) =>
              p.authHistory && p.authHistory.includes(authKeyInGameIds),
          );
          if (entry) {
            playerId = entry[0];
            player = entry[1];
          }
        }

        if (!player || !player.factionId) {
          return;
        }

        const faction = factions.factions[player.factionId];
        if (!faction) {
          return;
        }

        const playerApplied = player.appliedSecretTriggers || [];

        info.secretTriggers.forEach((hash) => {
          if (playerApplied.includes(hash)) return;

          // Found new trigger
          appliedTriggers.push({
            playerId,
            factionId: player.factionId,
            triggerHash: hash,
            factionName: faction.name, // For logs
            kingId: faction.kingId, // For logs
            memberRoles: faction.memberRoles, // For logs
          });
        });
      });

      parentPort.postMessage({
        success: true,
        taskId,
        results: {
          appliedTriggers,
          ranksMap,
          workerId,
        },
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "RESOLVE_PLAYER_IDS") {
    // プレイヤーリストの同期処理を並列化
    try {
      const { filePaths, playerIds } = data;
      const playersData = loadJSON(filePaths.players, { players: {} });
      const gameIds = loadJSON(filePaths.gameIds, {});

      const updatedPlayers = {};
      let changed = false;

      const targetIds = playerIds || Object.keys(playersData.players);

      targetIds.forEach((pid) => {
        const player = playersData.players[pid];
        if (!player) return;

        // server.js の syncPlayerWithGameIdsInternal と同等のロジックを実行
        let playerUpdated = false;

        const isGameKey = (k) => k && /^(game-)?[0-9a-f]{8}$/i.test(k);

        // knowPostIds 内の認証キーを内部IDに置換
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
                  playerUpdated = true;
                }
                if (newKnownIds.has(id)) {
                  newKnownIds.delete(id);
                  playerUpdated = true;
                }
                // 履歴へ移動
                if (!player.authHistory) player.authHistory = [];
                if (!player.authHistory.includes(id)) {
                  player.authHistory.push(id);
                  playerUpdated = true;
                }
              }
            }
          }
          if (playerUpdated) {
            player.knownPostIds = Array.from(newKnownIds);
          }
        }

        if (playerUpdated) {
          updatedPlayers[pid] = player;
          changed = true;
        }
      });

      parentPort.postMessage({
        success: true,
        taskId,
        results: {
          changed,
          updatedPlayers,
          workerId,
        },
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "CHECK_INTEGRITY") {
    try {
      const { filePaths } = data;
      const result = await checkAllIntegrity(filePaths);
      parentPort.postMessage({
        success: true,
        taskId,
        results: { ...result, workerId },
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "CHECK_INTEGRITY_PARTIAL") {
    try {
      const { startY, endY, filePaths, coreTileSettings } = data;

      // データが注入されていない場合はディスクからロード
      const mapState =
        data.mapState ||
        (filePaths?.mapState ? loadJSON(filePaths.mapState) : { tiles: {} });
      if (!mapState.tiles) mapState.tiles = {};

      const factions =
        data.factions ||
        (filePaths?.factions ? loadJSON(filePaths.factions) : { factions: {} });
      if (!factions.factions) factions.factions = {};

      const updatedTiles = {};
      let changed = false;

      // グローバル統計の算出
      const stats = {};
      // メモリ最適化: for-in を使用して算出
      for (const key in mapState.tiles) {
        const t = mapState.tiles[key];
        const fid = t.faction || t.factionId;
        if (fid) {
          if (!stats[fid]) stats[fid] = { tiles: 0, cores: 0 };
          stats[fid].tiles++;
          // const nowMs = Date.now(); // defined outside
          const nowMs = Date.now();
          if (t.core) {
            const coreFid = t.core.factionId;
            if (!stats[coreFid]) stats[coreFid] = { tiles: 0, cores: 0 };
            if (
              coreFid === fid &&
              (!t.core.expiresAt ||
                new Date(t.core.expiresAt).getTime() > nowMs)
            ) {
              stats[coreFid].cores++;
            }
          }
        }
      }

      // 2. Process assigned range
      const directions = [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ];

      // Iterate ONLY over tiles in range OR tiles that are in mapState within range
      // Since mapState.tiles is a dict "x_y", iterating all keys is slow if we only want Y range.
      // Optimized: Iterate x=0..MAP_SIZE, y=startY..endY
      for (let y = startY; y <= endY; y++) {
        for (let x = 0; x < MAP_SIZE; x++) {
          const key = `${x}_${y}`;
          const t = mapState.tiles[key];

          // If tile doesn't exist, nothing to check (unless we want to fill holes? No, integrity check acts on existing tiles/cores)
          if (!t) continue;

          const fid = t.faction || t.factionId;

          // [Logic 1] Remove Orphaned Tile (Ghost Faction)
          // If tile belongs to a faction that doesn't exist, remove it.
          if (fid && !factions.factions[fid]) {
            changed = true;
            updatedTiles[key] = null; // Signal to delete
            continue;
          }

          // [Logic 2] Remove Orphaned Core (Ghost Core Faction)
          if (t.core) {
            if (!factions.factions[t.core.factionId]) {
              delete t.core;
              changed = true;
              updatedTiles[key] = t;
              // If the tile itself is also ghost, Logic 1 would have caught it.
              // Here we handle case where tile owner exists but core owner doesn't.
            }
          }

          if (fid) {
            const faction = factions.factions[fid];
            if (faction) {
              // [NEW] 勢力色との同期 (カスタム色がない場合)
              if (
                !t.customColor &&
                faction.color &&
                t.color !== faction.color
              ) {
                t.color = faction.color;
                changed = true;
                updatedTiles[key] = t;
              }

              // [NEW] カスタム色の包囲判定チェック
              if (t.customColor) {
                let isSurrounded = true;
                for (const [dx, dy] of directions) {
                  const nx = x + dx;
                  const ny = y + dy;
                  if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) {
                    isSurrounded = false;
                    break;
                  }
                  const nKey = `${nx}_${ny}`;
                  const nt = mapState.tiles[nKey];
                  const nFid = nt ? nt.factionId || nt.faction : null;
                  if (String(nFid) !== String(fid)) {
                    isSurrounded = false;
                    break;
                  }
                }

                if (!isSurrounded) {
                  // 包囲が崩れたためカスタム色を解除
                  delete t.customColor;
                  if (faction.color) t.color = faction.color;
                  changed = true;
                  updatedTiles[key] = t;
                }
              }
            }

            // [Logic 3] Core Expiration / Permanent Check
            const nowMs = Date.now();
            if (t.core && t.core.expiresAt) {
              if (fid === t.core.factionId) {
                delete t.core.expiresAt; // Make permanent
                changed = true;
                updatedTiles[key] = t;
              } else if (new Date(t.core.expiresAt).getTime() <= nowMs) {
                delete t.core; // Expired
                changed = true;
                updatedTiles[key] = t;
              }
            }
          }

          // [Logic 2] Core Formation Check
          if (t.core && t.core.factionId === fid) continue; // Already own core

          const isSmall = (stats[fid]?.tiles || 0) <= 400;
          const totalCores = stats[fid]?.cores || 0;

          let neighborsCore = false;
          // Check connection
          for (const [dx, dy] of directions) {
            const nKey = `${x + dx}_${y + dy}`;
            const nt = mapState.tiles[nKey];
            if (nt && nt.core && nt.core.factionId === fid) {
              neighborsCore = true;
              break;
            }
          }

          if (neighborsCore) {
            if (isSmall) {
              // Instant
              if (!t.core) {
                t.core = { factionId: fid, expiresAt: null };
                delete t.isCorePending;
                delete t.coreTime;
                changed = true;
                updatedTiles[key] = t;
              }
            } else {
              // Timer
              const limit = coreTileSettings?.maxCoreTiles ?? 2500;
              if (!t.core && totalCores < limit) {
                if (!t.isCorePending) {
                  t.isCorePending = true;
                  t.coreTime = Date.now();
                  changed = true;
                  updatedTiles[key] = t;
                } else {
                  const elapsed = Date.now() - (t.coreTime || Date.now());
                  if (elapsed >= 60 * 60 * 1000) {
                    t.core = { factionId: fid, expiresAt: null };
                    delete t.isCorePending;
                    delete t.coreTime;
                    changed = true;
                    updatedTiles[key] = t;
                  }
                }
              }
            }
          } else {
            // Not connected
            if (t.isCorePending) {
              delete t.isCorePending;
              delete t.coreTime;
              changed = true;
              updatedTiles[key] = t;
            }
          }
        } // end x
      } // end y
      parentPort.postMessage({
        success: true,
        taskId,
        results: { changed, updatedTiles, workerId },
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }

    // [NEW] 勢力一括合併処理 (PROCESS_MERGE)
    // 申請元勢力の全タイルを吸収先勢力に移譲し、色などを更新
  } else if (type === "PROCESS_MERGE") {
    const { filePaths, requesterFactionId, targetFactionId, targetColor } =
      data;
    try {
      const mapState = loadJSON(filePaths.mapState, { tiles: {} });
      const updatedTiles = {};
      let count = 0;
      // [OPTIMIZATION] 全タイル走査 (O(N))
      // SABが利用可能な場合は、SABを走査して対象勢力のタイルを特定する (高速 & メモリ効率良)
      // JSONの Object.entries を使うと、巨大な配列が生成されGC負荷が高い。
      if (workerMapView) {
        const size = 500;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const offset = (y * size + x) * TILE_BYTE_SIZE;
            const fidIdx = workerMapView.getUint16(offset, true);
            if (fidIdx === 65535) continue;

            const fid = workerIndexToFactionId[fidIdx];
            if (fid === requesterFactionId) {
              const key = `${x}_${y}`;

              // マップデータ(JSON用)を構築
              // mapState.tiles[key] が存在しない場合もあるため、SABから復元するか、
              // そもそも mapState がロードされている前提か？
              // server.js からは filePaths.mapState が渡されるので loadJSON でロード済み。
              // ただし SAB モードでは loadJSON をスキップしている可能性がある (line 1064 logic)
              // line 2865: const mapState = loadJSON(...)
              // ここでは常にロードしている(SAB checkがない)。
              // なので mapState.tiles[key] は存在するはず。

              const t = mapState.tiles[key];
              if (!t) {
                // SABにはあるがJSONにない？同期ズレの可能性。
                // 安全のためスキップ、またはSABから再生成が必要。
                // ここではスキップするが、通常は同期されているはず。
                continue;
              }

              // 所有権移転
              t.factionId = targetFactionId;
              delete t.faction;

              if (!t.customColor && targetColor) {
                t.color = targetColor;
              }

              if (t.core) {
                t.core.factionId = targetFactionId;
              } else {
                t.paintedAt = new Date().toISOString();
              }

              updatedTiles[key] = t;
              count++;
            }
          }
        }
      } else {
        // Fallback: Legacy JSON Scan
        Object.entries(mapState.tiles).forEach(([key, t]) => {
          const fid = t.faction || t.factionId;
          if (fid === requesterFactionId) {
            // 所有権移転
            t.factionId = targetFactionId;
            delete t.faction;

            // 色更新 (カスタムカラーがない場合のみ)
            if (!t.customColor && targetColor) {
              t.color = targetColor;
            }

            // 中核タイルのハンドリング
            if (t.core) {
              // 元々中核だったマスだけ中核を継承
              t.core.factionId = targetFactionId;
            } else {
              // 中核でなかったマスは、即座に自動中核化されるのを防ぐため、塗装時間を現在時刻に更新
              t.paintedAt = new Date().toISOString();
            }

            updatedTiles[key] = t;
            count++;
          }
        });
      }

      // インデックスの更新 (同期)
      if (factionTileIndex) {
        if (factionTileIndex.data.has(requesterFactionId)) {
          factionTileIndex.data.delete(requesterFactionId);
        }
        if (!factionTileIndex.data.has(targetFactionId)) {
          factionTileIndex.data.set(targetFactionId, new Set());
        }
        Object.keys(updatedTiles).forEach((key) => {
          factionTileIndex.data.get(targetFactionId).add(key);
        });
      }

      parentPort.postMessage({
        success: true,
        taskId,
        results: { updatedTiles, count },
        workerId,
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }

    // [NEW] 起動時整合性チェック (CHECK_CONSISTENCY)
    // 存在しない勢力のタイル削除や、旧プロパティの移行
  } else if (type === "CHECK_CONSISTENCY") {
    const { filePaths } = data;
    try {
      const factionsData = loadJSON(filePaths.factions, { factions: {} });
      const validFactionIds = new Set(Object.keys(factionsData.factions));
      let changed = false;
      let removedCount = 0;

      // [NEW] CHECK_CONSISTENCY で mapState.tiles に直接アクセスしているため
      // これは JSON メンテナンス用タスクとしてそのまま残すが、
      // 巨大すぎてメモリ制限にかかる場合は SAB スキャンで ID チェックのみ行う形に将来的に移行可能。
      // 現状はデータのクリーンアップ(削除/移行)を行う唯一の場所なので JSON をロードする。
      const mapState = loadJSON(filePaths.mapState, { tiles: {} });

      Object.entries(mapState.tiles).forEach(([key, tile]) => {
        // 1. 不正な勢力IDチェック
        const fid = tile.factionId || tile.faction;
        if (fid && !validFactionIds.has(fid)) {
          // ゴースト勢力タイル削除
          delete mapState.tiles[key];
          removedCount++;
          changed = true;
        }

        // 2. 自動マイグレーション (faction -> factionId)
        if (tile.faction) {
          if (!tile.factionId) {
            tile.factionId = tile.faction;
          }
          delete tile.faction;
          changed = true;
        }
      });

      // 変更があった場合のみマップデータを返却 (Server側で保存してもらう)
      // データ量が大きいため、mapStateそのものを返すか、差分を返すか。
      // ここではServer側で上書き保存する前提で mapState を返す。
      // もし変更がなければ null を返す。

      parentPort.postMessage({
        success: true,
        taskId,
        results: {
          mapState: changed ? mapState : null,
          removedCount,
          changed,
        },
        workerId,
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "GENERATE_LITE_MAP") {
    try {
      const { filePaths, playerNames } = data;
      const mapState = workerMapView
        ? { tiles: {} }
        : loadJSON(filePaths.mapState, { tiles: {} });
      const liteData = generateLiteMap(mapState, playerNames || {});

      // Inject playerNames into the result
      liteData.playerNames = playerNames || {};

      // JSON文字列化をWorkerで行う
      const jsonString = JSON.stringify(liteData);

      parentPort.postMessage({
        success: true,
        taskId,
        results: { jsonString },
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "GENERATE_BINARY_MAP") {
    try {
      const { filePaths, playerNames } = data;
      const mapState = workerMapView
        ? { tiles: {} }
        : loadJSON(filePaths.mapState, { tiles: {} });

      const factionsSet = new Set();

      // [NEW] 勢力一覧の抽出 (SAB 優先)
      if (workerMapView) {
        const size = 500;
        for (let i = 0; i < size * size; i++) {
          const offset = i * 20;
          const fidIdx = workerMapView.getUint16(offset, true);
          if (fidIdx === 65535) continue;
          const fid = workerIndexToFactionId[fidIdx];
          if (fid) factionsSet.add(fid);
        }
      } else {
        Object.values(mapState.tiles).forEach((t) => {
          const fid = t.faction || t.factionId;
          if (fid) factionsSet.add(fid);
        });
      }

      const factionList = Array.from(factionsSet);
      const factionMap = new Map(factionList.map((f, i) => [f, i]));

      // [OPTIMIZATION] tileCount は 25万固定 (SAB時) または現在のJSONエントリ数
      const tileCount = workerMapView
        ? 500 * 500
        : Object.keys(mapState.tiles).length;

      let factionNamesSize = 0;
      factionList.forEach((f) => {
        factionNamesSize += 2 + Buffer.from(f).length; // ID (2 length + body)
      });

      // Player names mapping
      const pEntries = Object.entries(playerNames || {});
      let playerNamesSize = 0;
      pEntries.forEach(([id, name]) => {
        playerNamesSize +=
          2 + Buffer.from(id).length + 2 + Buffer.from(name).length;
      });

      const headerSize =
        4 + 1 + 8 + 4 + 2 + factionNamesSize + 4 + playerNamesSize;
      const TILE_DATA_SIZE = 20;
      const totalSize = headerSize + tileCount * TILE_DATA_SIZE;

      const buffer = Buffer.allocUnsafe(totalSize);
      let offset = 0;

      // Header
      buffer.write("TMAP", offset);
      offset += 4;
      buffer.writeUInt8(1, offset);
      offset += 1;
      buffer.writeDoubleLE(Date.now(), offset);
      offset += 8; // Version as timestamp

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
      buffer.writeUInt32LE(pEntries.length, offset);
      offset += 4;
      pEntries.forEach(([id, name]) => {
        const bid = Buffer.from(id);
        const bname = Buffer.from(name);
        buffer.writeUInt16LE(bid.length, offset);
        offset += 2;
        bid.copy(buffer, offset);
        offset += bid.length;

        buffer.writeUInt16LE(bname.length, offset);
        offset += 2;
        bname.copy(buffer, offset);
        offset += bname.length;
      });

      // Tiles
      buffer.writeUInt32LE(tileCount, offset);
      offset += 4;

      if (workerMapView) {
        // [OPTIMIZATION] SAB Direct Copy
        const sabBuffer = Buffer.from(workerMapSAB);
        sabBuffer.copy(buffer, offset);
        offset += sabBuffer.length;
      } else {
        // Fallback (JSONから構築)
        const size = 500;
        for (let i = 0; i < size * size; i++) {
          const x = i % size;
          const y = Math.floor(i / size);
          const key = `${x}_${y}`;
          const t = mapState.tiles[key];

          if (!t) {
            // Empty
            buffer.writeUInt16LE(65535, offset + 0); // Fid
            buffer.writeUInt32LE(0xffffff, offset + 2); // Color
            buffer.writeUInt32LE(0, offset + 6); // PaintedBy
            buffer.writeUInt8(0, offset + 10); // Over
            buffer.writeUInt8(0, offset + 11); // Flags
            buffer.writeDoubleLE(0, offset + 12); // Exp
          } else {
            // Fid
            let fidIdx = 65535;
            const fid = t.faction || t.factionId;
            if (fid && factionMap.has(fid)) fidIdx = factionMap.get(fid);
            buffer.writeUInt16LE(fidIdx, offset + 0);

            // Color
            const colorStr = t.customColor || t.color || "#ffffff";
            const colorInt =
              parseInt(colorStr.replace("#", ""), 16) || 0xffffff;
            buffer.writeUInt32LE(colorInt, offset + 2);

            // PaintedBy
            let pIdx = 0;
            // JSONモードでは解決困難なので0
            buffer.writeUInt32LE(pIdx, offset + 6);

            // Over
            buffer.writeUInt8(t.overpaint || 0, offset + 10);

            // Flags & Exp
            let flags = 0;
            let exp = 0;
            if (t.core) {
              flags |= 1;
              exp = new Date(t.core.expiresAt || 0).getTime();
            }
            if (t.coreificationUntil) {
              flags |= 2;
              exp = new Date(t.coreificationUntil).getTime();
            }
            buffer.writeUInt8(flags, offset + 11);
            buffer.writeDoubleLE(exp, offset + 12);
          }
          offset += TILE_DATA_SIZE;
        }
      }

      parentPort.postMessage(
        {
          success: true,
          taskId,
          results: { binary: buffer },
        },
        [buffer.buffer],
      );
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "CLEAR_CACHE") {
    try {
      const { workerId } = data;
      const beforeSize = jsonCache.size;
      jsonCache.clear();
      console.log(
        `[Worker ${workerId}] Cache cleared. (Items removed: ${beforeSize})`,
      );
      parentPort.postMessage({
        success: true,
        taskId,
        results: { workerId, clearedItems: beforeSize },
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "PROCESS_CESSION") {
    try {
      const { request, filePaths, fromFactionId, toFactionId } = data;

      const mapState = loadJSON(filePaths.mapState, { tiles: {} });
      const factions = loadJSON(filePaths.factions, { factions: {} });

      const fromFaction = factions.factions[fromFactionId];
      const toFaction = factions.factions[toFactionId];

      if (!fromFaction || !toFaction) {
        throw new Error("Invalid factions involved in cession");
      }

      const updatedTiles = {};

      request.tiles.forEach((t) => {
        const key = `${t.x}_${t.y}`;
        const tile = mapState.tiles[key];
        if (tile && tile.factionId === fromFactionId) {
          tile.factionId = toFactionId;
          delete tile.faction; // legacy
          tile.color = toFaction.color;

          // 中核設定の処理
          if (tile.core) {
            // 割譲元の中核だった場合：中核失効カウントダウンを発動（12時間後に失効）
            if (tile.core.factionId === fromFactionId) {
              const expireTime = Date.now() + 12 * 60 * 60 * 1000;
              tile.core.expiresAt = new Date(expireTime).toISOString();
            }
            // 受け取り側の中核だった場合（奪還）：恒久化
            else if (tile.core.factionId === toFactionId) {
              tile.core.expiresAt = null;
            }
          }

          // Reset pending core status for the new owner
          delete tile.isCorePending;
          delete tile.coreTime;

          // 中核化カウントダウンを発動（割譲されたマスを受け取り側の中核候補に）
          // 12時間後に中核化完了
          const coreificationTime = Date.now() + 12 * 60 * 60 * 1000;
          tile.coreificationUntil = new Date(coreificationTime).toISOString();
          tile.coreificationFactionId = toFactionId;

          updatedTiles[key] = tile;

          // [OPTIMIZATION] インデックスの同期更新
          if (factionTileIndex) {
            if (factionTileIndex.data.has(fromFactionId)) {
              factionTileIndex.data.get(fromFactionId).delete(key);
            }
            if (!factionTileIndex.data.has(toFactionId)) {
              factionTileIndex.data.set(toFactionId, new Set());
            }
            factionTileIndex.data.get(toFactionId).add(key);
          }
        }
      });

      // ポイント再計算
      const pointUpdates = {};
      [fromFactionId, toFactionId].forEach((fid) => {
        if (factions.factions[fid]) {
          pointUpdates[fid] = calculateFactionPoints(fid, mapState);
        }
      });

      parentPort.postMessage({
        success: true,
        taskId,
        results: {
          updatedTiles,
          pointUpdates,
          fromFactionName: fromFaction.name,
          toFactionName: toFaction.name,
        },
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "GENERATE_FULL_MAP_IMAGE") {
    // 全体マップ画像生成タスク（3パターンモード対応）
    try {
      const { filePaths, outputPath, mode } = data;
      // [OPTIMIZATION] SABがある場合は mapState (JSON) のロードをスキップ
      // generateFullMapImage 内で SAB (workerMapView) を参照する
      const mapState = workerMapView
        ? { tiles: {} }
        : loadJSON(filePaths.mapState, { tiles: {} });

      const factions = loadJSON(filePaths.factions, { factions: {} });
      const namedCells = loadJSON(filePaths.namedCells, {});
      const alliances = loadJSON(filePaths.alliances, { alliances: {} });

      ensureFontsRegistered();
      const imageBuffer = generateFullMapImage(
        mapState,
        factions.factions,
        namedCells,
        alliances.alliances || {},
        mode || "faction_full",
      );

      // 画像ファイルに保存
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      fs.writeFileSync(outputPath, imageBuffer);

      parentPort.postMessage({
        success: true,
        taskId,
        results: { outputPath, size: imageBuffer.length },
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "SAVE_JSON") {
    // 大規模ファイルの保存ハンドラ (502エラー対策)
    try {
      const { filePath, data: dataToSave } = data;
      const jsonString = JSON.stringify(dataToSave, null, 2);
      const tempPath = `${filePath}.tmp.${Date.now()}`;

      fs.writeFileSync(tempPath, jsonString, "utf-8");
      fs.renameSync(tempPath, filePath);

      parentPort.postMessage({
        success: true,
        taskId,
        results: { saved: true, size: jsonString.length },
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "VALIDATE_DIPLOMACY") {
    // 同盟・戦争の整合性チェックタスク
    const { filePaths } = data;
    try {
      const alliances = loadJSON(filePaths.alliances, { alliances: {} });
      const wars = loadJSON(filePaths.wars, { wars: {} });
      const factions = loadJSON(filePaths.factions, { factions: {} });

      let allianceUpdated = false;
      let warUpdated = false;

      // 1. 同盟チェック
      Object.keys(alliances.alliances).forEach((aid) => {
        const alliance = alliances.alliances[aid];
        if (!alliance.members || alliance.members.length < 2) {
          alliance.members.forEach((m) => {
            if (factions.factions[m.factionId]) {
              factions.factions[m.factionId].allianceId = null;
            }
          });
          delete alliances.alliances[aid];
          allianceUpdated = true;
        }
      });

      // 2. 戦争チェック
      Object.keys(wars.wars).forEach((wid) => {
        const war = wars.wars[wid];
        let warShouldEnd = false;
        if (!war.attackerSide || !war.defenderSide) warShouldEnd = true;
        else if (
          war.attackerSide.factions.length === 0 ||
          war.defenderSide.factions.length === 0
        )
          warShouldEnd = true;

        if (warShouldEnd) {
          delete wars.wars[wid];
          warUpdated = true;
        }
      });

      parentPort.postMessage({
        success: true,
        taskId,
        results: {
          alliances,
          wars,
          factions,
          allianceUpdated,
          warUpdated,
        },
        workerId,
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "SERIALIZE_TILE_UPDATES") {
    // Socket.io 送信用のバイナリバッファ作成をオフロード
    try {
      const { tileUpdateBuffer } = data;
      const keys = Object.keys(tileUpdateBuffer);
      // count(2) + N * (x(2)+y(2)+tile(24))
      // tile(24) = fid(2)+color(4)+pid(4)+over(1)+flags(1)+exp(8)+paintedAt(4)
      const PACKET_SIZE = 28;
      const totalSize = 2 + keys.length * PACKET_SIZE;

      const buffer = Buffer.allocUnsafe(totalSize);
      let offset = 0;
      buffer.writeUInt16LE(keys.length, offset);
      offset += 2;

      const size = 500; // MAP_SIZE
      const sabMap = workerMapView; // Global

      keys.forEach((key) => {
        const [x, y] = key.split("_").map(Number);

        // Write Coords
        buffer.writeUInt16LE(x, offset);
        buffer.writeUInt16LE(y, offset + 2);

        if (sabMap) {
          const tileOffset = (y * size + x) * TILE_BYTE_SIZE;

          // Reading from SAB (24 bytes)
          const fidIdx = sabMap.getUint16(tileOffset + 0, true);
          const color = sabMap.getUint32(tileOffset + 2, true);
          const pidIdx = sabMap.getUint32(tileOffset + 6, true);
          const over = sabMap.getUint8(tileOffset + 10);
          const flags = sabMap.getUint8(tileOffset + 11);
          const exp = sabMap.getFloat64(tileOffset + 12, true);
          const pAt = sabMap.getUint32(tileOffset + 20, true);

          // Writing to Buffer (24 bytes payload)
          buffer.writeUInt16LE(fidIdx, offset + 4);
          buffer.writeUInt32LE(color, offset + 6);
          buffer.writeUInt32LE(pidIdx, offset + 10);
          buffer.writeUInt8(over, offset + 14);
          buffer.writeUInt8(flags, offset + 15);
          buffer.writeDoubleLE(exp, offset + 16);
          buffer.writeUInt32LE(pAt, offset + 24);
        } else {
          buffer.fill(0, offset + 4, offset + 28);
          const tile = tileUpdateBuffer[key];
          if (tile) {
            const colorStr = tile.customColor || tile.color || "#ffffff";
            const colorInt =
              parseInt(colorStr.replace("#", ""), 16) || 0xffffff;
            buffer.writeUInt32LE(colorInt, offset + 6);
          }
        }

        offset += PACKET_SIZE;
      });

      parentPort.postMessage(
        {
          success: true,
          taskId,
          results: { binary: buffer, workerId },
        },
        [buffer.buffer],
      );
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "CHECK_TRUCE_PARTIAL") {
    // 停戦期限切れチェックのオフロード
    try {
      const { truces, now } = data;
      const expiredKeys = [];
      Object.entries(truces).forEach(([key, t]) => {
        if (t.expiresAt && new Date(t.expiresAt).getTime() <= now) {
          expiredKeys.push(key);
        }
      });
      parentPort.postMessage({
        success: true,
        taskId,
        results: { expiredKeys, workerId },
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "SAVE_MAP_SNAPSHOT") {
    // マップのスナップショット保存タスク (巨大データのクローン回避)
    const { sourcePath, targetPath } = data;
    try {
      // メインスレッドから巨大なオブジェクトを受け取るのではなく、
      // ファイルから読み込んで別名で保存する (あるいはファイルコピー)
      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, targetPath);
        parentPort.postMessage({ success: true, taskId, workerId });
      } else {
        throw new Error("Source file not found: " + sourcePath);
      }
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  }
});

// 全体マップ画像生成関数 (3パターンモード対応)
// mode: "faction_full" (勢力名+ネームドマス), "faction_simple" (なし), "alliance" (同盟名)
function generateFullMapImage(mapState, factions, namedCells, alliances, mode) {
  const TILE_SIZE = 2; // 500x500タイルの場合、2pxで1000px
  const isSimple = mode === "faction_simple";
  const curPaddingX = isSimple ? 0 : 100; // 左右100pxに縮小
  const curPaddingY = isSimple ? 0 : 25; // 上下25px
  const mapWidth = MAP_SIZE * TILE_SIZE;
  const mapHeight = MAP_SIZE * TILE_SIZE;
  const canvasWidth = mapWidth + curPaddingX * 2;
  const canvasHeight = mapHeight + curPaddingY * 2;

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d");

  // 背景（黒）
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // マップ領域（白）
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(curPaddingX, curPaddingY, mapWidth, mapHeight);

  // 同盟モードの場合、勢力→同盟IDマッピングを作成
  const factionToAlliance = {};
  if (mode === "alliance") {
    Object.entries(alliances).forEach(([allianceId, alliance]) => {
      if (alliance.members) {
        alliance.members.forEach((memberId) => {
          factionToAlliance[memberId] = allianceId;
        });
      }
    });
  }

  // タイル描画
  // [OPTIMIZATION] SABが利用可能な場合は、SABを走査して描画 (高速 & メモリ削減)
  if (workerMapView) {
    const size = 500;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const offset = (y * size + x) * TILE_BYTE_SIZE;
        const fidIdx = workerMapView.getUint16(offset, true);
        if (fidIdx === 65535) continue; // 無所属

        const fid = workerIndexToFactionId[fidIdx];
        const faction = factions[fid];
        if (faction) {
          let color = faction.color || "#888888";

          // カスタムカラー (SABからは取れないため、faction colorを優先、または必要なら別途管理)
          // 現状のSAB構造: offset+2 に colorInt がある
          const colorInt = workerMapView.getUint32(offset + 2, true);
          // colorInt から #RRGGBB を復元
          const hex = colorInt.toString(16).padStart(6, "0");
          color = `#${hex}`;

          // 同盟モードのオーバーライド
          if (mode === "alliance") {
            const allianceId = factionToAlliance[fid];
            if (allianceId) {
              const alliance = alliances[allianceId];
              if (alliance && alliance.color) {
                color = alliance.color;
              }
            } else {
              color = "#888888"; // 未加入は灰色
            }
          }

          ctx.fillStyle = color;
          ctx.fillRect(
            curPaddingX + x * TILE_SIZE,
            curPaddingY + y * TILE_SIZE,
            TILE_SIZE,
            TILE_SIZE,
          );
        }
      }
    }
  } else {
    // Fallback: Legacy JSON Scan
    Object.entries(mapState.tiles).forEach(([key, tile]) => {
      const [x, y] = key.split("_").map(Number);
      const fid = tile.faction || tile.factionId;
      const faction = factions[fid];

      if (faction) {
        let color = tile.customColor || faction.color || "#888888";

        if (mode === "alliance") {
          const allianceId = factionToAlliance[fid];
          if (allianceId) {
            const alliance = alliances[allianceId];
            if (alliance && alliance.color) {
              color = alliance.color;
            }
          } else {
            color = "#888888";
          }
        }

        ctx.fillStyle = color;
        ctx.fillRect(
          curPaddingX + x * TILE_SIZE,
          curPaddingY + y * TILE_SIZE,
          TILE_SIZE,
          TILE_SIZE,
        );
      }
    });
  }

  // 金枠（50x50センターエリア: 225～274）
  ctx.strokeStyle = "#FFD700";
  ctx.lineWidth = 2;
  ctx.strokeRect(
    curPaddingX + 225 * TILE_SIZE,
    curPaddingY + 225 * TILE_SIZE,
    50 * TILE_SIZE,
    50 * TILE_SIZE,
  );

  // 勢力の中心点を計算
  const factionCenters = {};
  Object.entries(mapState.tiles).forEach(([key, tile]) => {
    const fid = tile.faction || tile.factionId;
    if (!fid) return;

    const [x, y] = key.split("_").map(Number);
    if (!factionCenters[fid]) {
      factionCenters[fid] = { sumX: 0, sumY: 0, count: 0 };
    }
    factionCenters[fid].sumX += x;
    factionCenters[fid].sumY += y;
    factionCenters[fid].count++;
  });

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // faction_full または alliance モードでラベル描画
  if (mode === "faction_full" || mode === "alliance") {
    if (mode === "alliance") {
      // 同盟ラベルを描画（同盟の中心を計算）
      const allianceCenters = {};
      Object.entries(factionCenters).forEach(([fid, center]) => {
        const allianceId = factionToAlliance[fid];
        if (!allianceId) return;

        if (!allianceCenters[allianceId]) {
          allianceCenters[allianceId] = { sumX: 0, sumY: 0, count: 0 };
        }
        allianceCenters[allianceId].sumX += center.sumX;
        allianceCenters[allianceId].sumY += center.sumY;
        allianceCenters[allianceId].count += center.count;
      });

      Object.entries(allianceCenters).forEach(([allianceId, center]) => {
        if (center.count < 10) return; // 小さい同盟はラベルを表示しない

        const alliance = alliances[allianceId];
        if (!alliance) return;

        const centerX = curPaddingX + (center.sumX / center.count) * TILE_SIZE;
        const centerY = curPaddingY + (center.sumY / center.count) * TILE_SIZE;

        const fontSize = Math.min(
          28,
          Math.max(14, Math.floor(Math.sqrt(center.count) * 1.5)),
        );
        ctx.font = `bold ${fontSize}px NotoSansJP, NotoEmoji, sans-serif`;

        const displayName = removeEmoji(alliance.name);

        // [MODIFIED] High Contrast Label (Black Outline + White Text)
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#000000"; // Black outline
        ctx.strokeText(displayName, centerX, centerY);

        ctx.fillStyle = "#ffffff"; // White text
        ctx.fillText(displayName, centerX, centerY);
      });
    } else {
      // 勢力名ラベルを描画（faction_fullモード）- 重なり回避付き
      console.log(
        `[FullMapImage] Drawing faction labels, ${Object.keys(factionCenters).length} factions found`,
      );

      // 配置済みラベルの矩形リスト（衝突検出用）
      const placedLabels = [];

      // ラベル矩形の衝突判定
      function isOverlapping(rect1, rect2) {
        return !(
          rect1.right < rect2.left ||
          rect1.left > rect2.right ||
          rect1.bottom < rect2.top ||
          rect1.top > rect2.bottom
        );
      }

      // 衝突を回避するための位置調整 (より積極的なオフセット)
      function findNonOverlappingPosition(x, y, width, height, placed) {
        const offsets = [
          { dx: 0, dy: 0 },
          { dx: 0, dy: -height * 1.5 },
          { dx: 0, dy: height * 1.5 },
          { dx: width * 0.8, dy: 0 },
          { dx: -width * 0.8, dy: 0 },
          { dx: width * 0.7, dy: -height * 1.0 },
          { dx: -width * 0.7, dy: -height * 1.0 },
          { dx: width * 0.7, dy: height * 1.0 },
          { dx: -width * 0.7, dy: height * 1.0 },
          { dx: 0, dy: -height * 2.5 },
          { dx: 0, dy: height * 2.5 },
          { dx: width * 1.2, dy: 0 },
          { dx: -width * 1.2, dy: 0 },
        ];

        for (const offset of offsets) {
          const testX = x + offset.dx;
          const testY = y + offset.dy;
          const testRect = {
            left: testX - width / 2,
            right: testX + width / 2,
            top: testY - height / 2,
            bottom: testY + height / 2,
          };

          let hasCollision = false;
          for (const p of placed) {
            if (isOverlapping(testRect, p)) {
              hasCollision = true;
              break;
            }
          }

          if (!hasCollision) {
            return { x: testX, y: testY };
          }
        }
        return { x, y };
      }

      // タイル数の多い順にソート（大きな勢力を優先配置）
      // 最小タイル数を5に引き上げて小さな勢力のラベルを省略
      const sortedFactions = Object.entries(factionCenters)
        .filter(([fid, center]) => center.count >= 5 && factions[fid])
        .sort((a, b) => b[1].count - a[1].count);

      sortedFactions.forEach(([fid, center]) => {
        const faction = factions[fid];

        const baseCenterX =
          curPaddingX + (center.sumX / center.count) * TILE_SIZE;
        const baseCenterY =
          curPaddingY + (center.sumY / center.count) * TILE_SIZE;

        // フォントサイズを縮小（最大6、最大12）
        const fontSize = Math.min(
          12,
          Math.max(6, Math.floor(Math.sqrt(center.count) * 1.2)),
        );
        ctx.font = `bold ${fontSize}px NotoSansJP, NotoEmoji, sans-serif`;

        const displayName = removeEmoji(faction.name);
        const textMetrics = ctx.measureText(displayName);
        const textWidth = textMetrics.width;
        const textHeight = fontSize;

        const { x: centerX, y: centerY } = findNonOverlappingPosition(
          baseCenterX,
          baseCenterY,
          textWidth,
          textHeight,
          placedLabels,
        );

        placedLabels.push({
          left: centerX - textWidth / 2,
          right: centerX + textWidth / 2,
          top: centerY - textHeight / 2,
          bottom: centerY + textHeight / 2,
        });

        // [MODIFIED] High Contrast Label (Black Outline + White Text)
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#000000"; // Black outline
        ctx.strokeText(displayName, centerX, centerY);

        ctx.fillStyle = "#ffffff"; // White text
        ctx.fillText(displayName, centerX, centerY);
      });
    }
  }

  // ネームドセルのラベルを描画（faction_fullモードのみ）
  if (mode === "faction_full") {
    ctx.font = "bold 10px NotoSansJP, NotoEmoji, sans-serif";
    Object.values(namedCells).forEach((cell) => {
      const screenX = curPaddingX + cell.x * TILE_SIZE + TILE_SIZE / 2;
      const screenY = curPaddingY + cell.y * TILE_SIZE + TILE_SIZE / 2;

      // ★マーカー
      ctx.fillStyle = "#FFD700";
      ctx.fillText("★", screenX, screenY - 8);

      // 名前ラベル（小さめ + 縁取り）
      if (cell.name) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#000000";
        ctx.strokeText(cell.name, screenX, screenY + 8);

        ctx.fillStyle = "#ffffff";
        ctx.fillText(cell.name, screenX, screenY + 8);
      }
    });
  }

  return canvas.toBuffer("image/png");
}

function generateLiteMap(mapState, playerNames = {}) {
  const liteTiles = {};
  Object.entries(mapState.tiles).forEach(([key, tile]) => {
    const [x, y] = key.split("_").map(Number);
    const playerId = tile.paintedBy;
    liteTiles[key] = {
      f: tile.faction || tile.factionId,
      c: tile.customColor || tile.color,
      cc: !!tile.customColor,
      p: playerId,
      pn: playerId ? playerNames[playerId] || null : null,
      o: tile.overpaint || 0,
      x,
      y,
    };
    if (tile.core) {
      liteTiles[key].core = {
        fid: tile.core.factionId,
        exp: tile.core.expiresAt || null,
      };
    }
    if (tile.coreificationUntil) {
      liteTiles[key].coreUntil = tile.coreificationUntil;
      liteTiles[key].coreFid = tile.coreificationFactionId;
    }
  });
  return { tiles: liteTiles, version: Date.now() };
}

// ===== New Helper Functions ported from server.js =====

// 領土割譲マップ画像生成
function generateCessionMapImage(tiles, factions, highlightTiles, tempDir) {
  if (!highlightTiles || highlightTiles.length === 0) {
    return null;
  }

  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  highlightTiles.forEach((t) => {
    if (t.x < minX) minX = t.x;
    if (t.x > maxX) maxX = t.x;
    if (t.y < minY) minY = t.y;
    if (t.y > maxY) maxY = t.y;
  });

  const PADDING = 10;
  minX = Math.max(0, minX - PADDING);
  maxX = Math.min(249, maxX + PADDING);
  minY = Math.max(0, minY - PADDING);
  maxY = Math.min(249, maxY + PADDING);

  const viewWidth = maxX - minX + 1;
  const viewHeight = maxY - minY + 1;

  const TILE_SIZE = 8;
  const canvasWidth = viewWidth * TILE_SIZE;
  const canvasHeight = viewHeight * TILE_SIZE;

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  Object.entries(tiles).forEach(([key, tile]) => {
    const [x, y] = key.split("_").map(Number);
    if (x < minX || x > maxX || y < minY || y > maxY) return;

    const fid = tile.faction || tile.factionId;
    const faction = factions[fid];

    if (faction) {
      ctx.fillStyle = faction.color || "#888888";
      const drawX = (x - minX) * TILE_SIZE;
      const drawY = (y - minY) * TILE_SIZE;
      ctx.fillRect(drawX, drawY, TILE_SIZE, TILE_SIZE);
    }
  });

  highlightTiles.forEach((t) => {
    const drawX = (t.x - minX) * TILE_SIZE;
    const drawY = (t.y - minY) * TILE_SIZE;

    ctx.fillStyle = "rgba(255, 215, 0, 0.4)";
    ctx.fillRect(drawX, drawY, TILE_SIZE, TILE_SIZE);

    ctx.strokeStyle = "#FFD700";
    ctx.lineWidth = 2;
    ctx.strokeRect(drawX + 1, drawY + 1, TILE_SIZE - 2, TILE_SIZE - 2);
  });

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const filename = `cession_${Date.now()}.png`;
  const filepath = path.join(tempDir, filename);
  const buffer = canvas.toBuffer("image/png");
  fs.writeFileSync(filepath, buffer);

  return `/temp/cession_maps/${filename}`;
}

// 勢力のタイルをクラスタ（連結成分）に分ける
function getClusters(factionId, mapState) {
  const factionTiles = new Set();
  Object.entries(mapState.tiles).forEach(([key, t]) => {
    if (
      (t.faction || t.factionId) === factionId ||
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

function expandFactionCores(
  fid,
  mapState,
  nowMs,
  updatedTilesAccumulator,
  coreTileSettings = {},
) {
  const clusters = getClusters(fid, mapState);
  if (clusters.length === 0) return false;

  const validCandidates = new Set();
  const candidatesByCluster = [];
  let changed = false;

  clusters.forEach((cluster) => {
    const size = cluster.length;
    const threshold = coreTileSettings.instantCoreThreshold ?? 400;
    const requiredHours = Math.floor((size - 1) / threshold);
    const requiredMs = requiredHours * 60 * 60 * 1000;

    cluster.forEach((key) => {
      const tile = mapState.tiles[key];
      if (!tile) return;
      if (tile.core && tile.core.factionId !== fid) return;

      const paintedTime = new Date(tile.paintedAt || new Date()).getTime();
      const heldTime = nowMs - paintedTime;

      if (heldTime >= requiredMs) {
        validCandidates.add(key);
      }
    });
    candidatesByCluster.push({ size, keys: cluster });
  });

  let activeCores = new Set();
  Object.entries(mapState.tiles).forEach(([key, tile]) => {
    if (
      (tile.faction || tile.factionId) === fid &&
      tile.core &&
      (tile.core.factionId === fid ||
        (tile.core.expiresAt &&
          new Date(tile.core.expiresAt).getTime() > nowMs))
    ) {
      activeCores.add(key);
    }
  });

  if (activeCores.size === 0) return false;

  if (activeCores.size > 0 && validCandidates.size > 0) {
    const queue = Array.from(activeCores);
    const processed = new Set(activeCores);
    const directions8 = [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];

    while (queue.length > 0) {
      const currentKey = queue.shift();
      const [cx, cy] = currentKey.split("_").map(Number);

      for (const [dx, dy] of directions8) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) continue;

        const nKey = `${nx}_${ny}`;
        if (!processed.has(nKey) && validCandidates.has(nKey)) {
          const nTile = mapState.tiles[nKey];
          if (nTile && (nTile.faction || nTile.factionId) === fid) {
            if (!nTile.core) {
              nTile.core = { factionId: fid, expiresAt: null };
              changed = true;
              updatedTilesAccumulator[nKey] = nTile;
            }
            processed.add(nKey);
            queue.push(nKey);
          }
        }
      }
    }
  }
  return changed;
}

// Worker専用のヘルパー関数 (server.js からの移植・適合)
function getFactionClusterInfoWorker(
  factionId,
  mapState,
  extraTiles = [],
  knownFactionKeys = null,
) {
  const factionTiles = new Set();

  if (knownFactionKeys) {
    knownFactionKeys.forEach((k) => factionTiles.add(k));
  } else if (factionTileIndex?.data?.has(factionId)) {
    // [NEW] インデックスがあればそれを使用 (SAB経由で構築済み)
    factionTileIndex.data.get(factionId).forEach((k) => factionTiles.add(k));
  } else {
    Object.entries(mapState.tiles).forEach(([key, t]) => {
      if (
        (t.factionId || t.faction) === factionId ||
        (t.core && t.core.factionId === factionId)
      ) {
        factionTiles.add(key);
      }
    });
  }

  extraTiles.forEach((t) => factionTiles.add(`${t.x}_${t.y}`));

  const clusters = [];
  const visited = new Set();
  const directions = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  for (const key of factionTiles) {
    if (visited.has(key)) continue;

    const cluster = [];
    const queue = [key];
    visited.add(key);
    let hasCore = false;

    while (queue.length > 0) {
      const current = queue.pop();
      cluster.push(current);

      let tile = mapState.tiles[current];
      // [OPTIMIZATION] 座標インデックスを使用して高速取得を試みる
      if (!tile) {
        const [cx, cy] = current.split("_").map(Number);
        tile = getTileAt(cx, cy, mapState);
      }

      // Worker内では mapState がプレーンオブジェクトの場合は tile.core アクセス
      // SABからの場合は tile._flags アクセス
      if (tile) {
        if (tile.core && tile.core.factionId === factionId) {
          hasCore = true;
        } else if (
          tile._flags !== undefined &&
          tile._flags & 1 &&
          tile.factionId === factionId
        ) {
          hasCore = true;
        }
      }

      const [x, y] = current.split("_").map(Number);
      for (const [dx, dy] of directions) {
        // [OPTIMIZATION] 文字列キー生成の前に座標範囲チェックとインデックス確認を行いたいが
        // ここでは set.has(stringKey) で判定しているため文字列生成は必須。
        // ただし、coordinateIndexがあれば set.has の代わりに index[y][x] チェックができる可能性があるが
        // factionTiles は Set<String> なのでこのままにする。
        // 将来的に factionTiles も Set<Int> (y*1000+x) などにするとさらに高速化可能。

        const nk = `${x + dx}_${y + dy}`;
        if (factionTiles.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          queue.push(nk);
        }
      }
    }
    clusters.push({ tiles: cluster, hasCore });
  }
  return { clusters };
}

function recalculateAllFactionCores(mapState, factions, coreTileSettings = {}) {
  const nowMs = Date.now();
  let changed = false;
  const updatedTiles = {};

  if (workerMapView) {
    const size = 500;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const offset = (y * size + x) * TILE_BYTE_SIZE;
        const flags = workerMapView.getUint8(offset + 7);
        if (flags & 1) {
          // Core
          const exp = workerMapView.getFloat64(offset + 8, true);
          const fidIdx = workerMapView.getUint16(offset, true);
          const fid = workerIndexToFactionId[fidIdx];

          if (exp > 0 && exp <= nowMs) {
            // 期限切れ
            changed = true;
            updatedTiles[`${x}_${y}`] = getTileFromSAB(x, y);
            delete updatedTiles[`${x}_${y}`].core; // 破棄
          } else if (fid) {
            // expiresAt がある場合は削除 (既存ロジック互換)
            if (exp > 0) {
              changed = true;
              updatedTiles[`${x}_${y}`] = getTileFromSAB(x, y);
              delete updatedTiles[`${x}_${y}`].core.expiresAt;
            }
          }
        }
      }
    }
  } else {
    Object.values(mapState.tiles).forEach((tile) => {
      if (tile.core && tile.core.expiresAt) {
        if (new Date(tile.core.expiresAt).getTime() <= nowMs) {
          delete tile.core;
          changed = true;
          updatedTiles[`${tile.x}_${tile.y}`] = tile;
        } else {
          const fid = tile.faction || tile.factionId;
          if (fid === tile.core.factionId) {
            delete tile.core.expiresAt;
            changed = true;
            updatedTiles[`${tile.x}_${tile.y}`] = tile;
          }
        }
      }
    });
  }

  Object.keys(factions.factions).forEach((fid) => {
    if (
      expandFactionCores(fid, mapState, nowMs, updatedTiles, coreTileSettings)
    ) {
      changed = true;
    }
  });

  return { changed, updatedTiles };
}

async function checkAllIntegrity(filePaths) {
  let log = [];
  const mapState = workerMapView
    ? { tiles: {} }
    : loadJSON(filePaths.mapState, { tiles: {} });
  const namedCellsData = loadJSON(filePaths.namedCells, {});
  const factionsData = loadJSON(filePaths.factions, { factions: {} });

  const diffs = {
    mapState: { updates: {}, deletes: [] },
    namedCells: { updates: {}, deletes: [] },
  };

  let mapUpdated = false;
  let namedUpdated = false;

  if (workerMapView) {
    // SAB 走査によるチェック
    const size = 500;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const key = `${x}_${y}`;
        const offset = (y * size + x) * TILE_BYTE_SIZE;
        const fidIdx = workerMapView.getUint16(offset, true);
        const mapFid = fidIdx === 65535 ? null : workerIndexToFactionId[fidIdx];

        // NamedCell との整合性
        const nCell = namedCellsData[key];
        if (nCell) {
          if (mapFid && factionsData.factions[mapFid]) {
            if (nCell.factionId !== mapFid) {
              diffs.namedCells.updates[key] = { ...nCell, factionId: mapFid };
              namedUpdated = true;
            }
          } else if (
            nCell.factionId &&
            factionsData.factions[nCell.factionId]
          ) {
            // マップ反映 (復元) は SAB への書き込みが必要だが、Worker では行わない (diffs で返す)
            diffs.mapState.updates[key] = {
              x,
              y,
              factionId: nCell.factionId,
              faction: nCell.factionId,
            };
            mapUpdated = true;
          }
        }
      }
    }
  } else {
    for (const [key, nCell] of Object.entries(namedCellsData)) {
      const tile = mapState.tiles[key];
      if (!tile) continue;

      // マップの状態を正とする (所有権の同期)
      // マップ上の占領状態を正とし、namedCellsData 側を更新する
      const mapFid = tile.faction || tile.factionId;
      const namedFid = nCell.factionId;

      if (mapFid && factionsData.factions[mapFid]) {
        // マップ上に有効な所有者がいる場合
        if (namedFid !== mapFid) {
          // nCell.factionId = mapFid; // update local
          diffs.namedCells.updates[key] = { ...nCell, factionId: mapFid };
          namedUpdated = true;
        }
      } else if (namedFid && factionsData.factions[namedFid]) {
        // マップ上は無所属だが、NamedCellに情報がある場合 -> マップに反映 (復元)
        diffs.mapState.updates[key] = {
          ...tile,
          factionId: namedFid,
          faction: namedFid,
        };
        mapUpdated = true;
      } else {
        // どちらも無効 -> 削除
        diffs.namedCells.deletes.push(key);
        namedUpdated = true;
        if (tile.namedData) {
          // delete tile.namedData;
          const newTile = { ...tile };
          delete newTile.namedData;
          diffs.mapState.updates[key] = newTile;
          mapUpdated = true;
        }
        log.push(`Removed orphaned named cell at ${key}`);
        continue;
      }

      // 名前情報の同期
      if (!tile.namedData || tile.namedData.name !== nCell.name) {
        // tile.namedData = { ...nCell };
        const newTile = diffs.mapState.updates[key] || { ...tile };
        newTile.namedData = { ...(diffs.namedCells.updates[key] || nCell) };
        diffs.mapState.updates[key] = newTile;
        mapUpdated = true;
      }
    }
  }

  for (const [key, tile] of Object.entries(mapState.tiles)) {
    if (tile.namedData && !namedCellsData[key]) {
      const ownerFid = tile.faction || tile.factionId;
      if (factionsData.factions[ownerFid]) {
        diffs.namedCells.updates[key] = {
          ...tile.namedData,
          x: tile.x,
          y: tile.y,
          factionId: ownerFid,
        };
        namedUpdated = true;
        log.push(`Added missing ${key} to named_cells.json`);
      } else {
        // delete tile.namedData;
        const newTile = diffs.mapState.updates[key] || { ...tile };
        delete newTile.namedData;
        diffs.mapState.updates[key] = newTile;
        mapUpdated = true;
        log.push(`Removed invalid namedData at ${key}`);
      }
    }
  }

  // 3. マップの整合性チェック (範囲外タイルの削除)
  Object.keys(mapState.tiles).forEach((key) => {
    const [x, y] = key.split("_").map(Number);
    if (x >= MAP_SIZE || y >= MAP_SIZE) {
      // delete mapState.tiles[key];
      diffs.mapState.deletes.push(key);
      mapUpdated = true;
      log.push(`Removed out-of-bounds tile ${key}`);
    }
  });

  // [CHECK] No SAVE_JSON here. Return diffs to main thread.

  return { mapUpdated, namedUpdated, log, diffs };
}

async function saveJSONInternal(filePath, data) {
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const dataToWrite = JSON.stringify(data, null, 2);
  try {
    await LockManager.withLock(filePath, async () => {
      fs.writeFileSync(tempPath, dataToWrite, "utf-8");
      fs.renameSync(tempPath, filePath);
      // Workerキャッシュの更新
      const stats = fs.statSync(filePath);
      jsonCache.set(filePath, { mtime: stats.mtimeMs, data: data });
    });
  } catch (e) {
    if (fs.existsSync(tempPath))
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // unlinkエラーは無視
      }
    throw e;
  }
}
