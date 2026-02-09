/**
 * マップ計算用 Web Worker (SharedArrayBuffer 対応版)
 * 重い計算をメインスレッドから分離し、バイナリデータを直接操作して高速化
 */

let MAP_SIZE = 500;
const TILE_BYTE_SIZE = 24;

// キャッシュ
let sabView = null;
let zocSabView = null; // [NEW]
let statsSabView = null; // [NEW]
let factionsList = [];
let namedCells = {}; // [NEW]

// Cache for reuse
const cache = {
  clusters: { version: -1, result: null },
  edges: new Map(), // Map<factionId, { version, result }>
};

// --- ヘルパー: SABからの値読み取り ---

function getFactionIdFromSAB(sabView, offset, factionsList) {
  const fidIdx = sabView.getUint16(offset + 0, true);
  return fidIdx === 65535 ? null : factionsList[fidIdx];
}

function getFlagsFromSAB(sabView, offset) {
  return sabView.getUint8(offset + 11);
}

function getExpiryFromSAB(sabView, offset) {
  return sabView.getFloat64(offset + 12, true);
}

/**
 * 勢力ごとのタイルを集計 & 重心計算 (SAB版)
 */
function aggregateFactionsSAB(sab, factionsList) {
  const sabView = new DataView(sab);
  const factionTiles = {};

  for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
    const offset = i * TILE_BYTE_SIZE;
    const fidIdx = sabView.getUint16(offset, true);
    if (fidIdx === 65535) continue;

    const factionId = factionsList[fidIdx];
    if (!factionId) continue;

    if (!factionTiles[factionId]) {
      factionTiles[factionId] = { count: 0, sumX: 0, sumY: 0 };
    }

    const x = i % MAP_SIZE;
    const y = Math.floor(i / MAP_SIZE);
    const data = factionTiles[factionId];
    data.count++;
    data.sumX += x;
    data.sumY += y;
  }

  // 重心を計算
  const result = {};
  Object.entries(factionTiles).forEach(([fid, data]) => {
    result[fid] = {
      centerX: Math.floor(data.sumX / data.count),
      centerY: Math.floor(data.sumY / data.count),
      count: data.count,
    };
  });

  return result;
}

/**
 * 勢力の境界線（エッジ）を計算 (SAB版)
 */
function calculateFactionEdgesSAB(sab, factionId, factionsList) {
  if (!factionId) return [];

  const sabView = new DataView(sab);
  const factionIdx = factionsList.indexOf(factionId);
  if (factionIdx === -1) return [];

  const edges = [];

  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const offset = (y * MAP_SIZE + x) * TILE_BYTE_SIZE;
      const fidIdx = sabView.getUint16(offset, true);

      if (fidIdx !== factionIdx) continue;

      const checkNeighbor = (nx, ny) => {
        if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) return false;
        const nOffset = (ny * MAP_SIZE + nx) * TILE_BYTE_SIZE;
        return sabView.getUint16(nOffset, true) === factionIdx;
      };

      // 上下左右の境界をチェック
      if (!checkNeighbor(x, y - 1))
        edges.push({ x1: x, y1: y, x2: x + 1, y2: y, type: "top" });
      if (!checkNeighbor(x, y + 1))
        edges.push({
          x1: x,
          y1: y + 1,
          x2: x + 1,
          y2: y + 1,
          type: "bottom",
        });
      if (!checkNeighbor(x - 1, y))
        edges.push({ x1: x, y1: y, x2: x, y2: y + 1, type: "left" });
      if (!checkNeighbor(x + 1, y))
        edges.push({
          x1: x + 1,
          y1: y,
          x2: x + 1,
          y2: y + 1,
          type: "right",
        });
    }
  }

  return edges;
}

/**
 * 勢力ごとのクラスタリング (SAB版)
 */
function calculateClustersSAB(sab, factionsList) {
  const sabView = new DataView(sab);
  const factionTilesMap = {};

  for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
    const offset = i * TILE_BYTE_SIZE;
    const fidIdx = sabView.getUint16(offset, true);
    if (fidIdx === 65535) continue;

    if (!factionTilesMap[fidIdx]) factionTilesMap[fidIdx] = [];
    factionTilesMap[fidIdx].push(i);
  }

  const result = {};

  Object.entries(factionTilesMap).forEach(([fidIdxStr, indices]) => {
    const fidIdx = parseInt(fidIdxStr, 10);
    const factionId = factionsList[fidIdx];
    const indexSet = new Set(indices);
    const visited = new Set();
    const clusters = [];

    indices.forEach((startIndex) => {
      if (visited.has(startIndex)) return;

      const cluster = [];
      const queue = [startIndex];
      visited.add(startIndex);
      let hasCore = false;

      while (queue.length > 0) {
        const currentIdx = queue.shift();
        cluster.push(currentIdx);

        const offset = currentIdx * TILE_BYTE_SIZE;
        if (sabView.getUint8(offset + 11) & 1) hasCore = true;

        const tx = currentIdx % MAP_SIZE;
        const ty = Math.floor(currentIdx / MAP_SIZE);

        const neighbors = [
          [0, 1],
          [0, -1],
          [1, 0],
          [-1, 0],
        ]; // 4近傍で十分
        for (const [dx, dy] of neighbors) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx >= 0 && nx < MAP_SIZE && ny >= 0 && ny < MAP_SIZE) {
            const ni = ny * MAP_SIZE + nx;
            if (indexSet.has(ni) && !visited.has(ni)) {
              visited.add(ni);
              queue.push(ni);
            }
          }
        }
      }
      clusters.push({ indices: cluster, hasCore });
    });

    result[factionId] = clusters.map((c) => {
      let sumX = 0,
        sumY = 0;
      c.indices.forEach((idx) => {
        sumX += idx % MAP_SIZE;
        sumY += Math.floor(idx / MAP_SIZE);
      });
      return {
        x: sumX / c.indices.length,
        y: sumY / c.indices.length,
        count: c.indices.length,
        hasCore: c.hasCore,
      };
    });
  });

  return result;
}

/**
 * 勢力ごとのクラスタリング (旧式 Object版 - タイムラプス用)
 */
function calculateClustersLegacy(tiles) {
  const factionTilesMap = {};

  Object.values(tiles).forEach((t) => {
    const fid = t.faction || t.factionId;
    if (!fid) return;
    if (!factionTilesMap[fid]) factionTilesMap[fid] = [];
    factionTilesMap[fid].push(t);
  });

  const result = {};

  Object.entries(factionTilesMap).forEach(([factionId, tList]) => {
    // 高速検索用のMapを作成
    const tileMap = new Map();
    tList.forEach((t) => tileMap.set(`${t.x}_${t.y}`, t));

    const visited = new Set();
    const clusters = [];

    tList.forEach((startTile) => {
      const startKey = `${startTile.x}_${startTile.y}`;
      if (visited.has(startKey)) return;

      const cluster = [];
      const queue = [startTile];
      visited.add(startKey);
      let hasCore = false;

      while (queue.length > 0) {
        const current = queue.shift();
        cluster.push(current);

        if (
          current.core &&
          current.core.factionId === (current.faction || current.factionId)
        ) {
          hasCore = true;
        }

        const neighbors = [
          [0, 1],
          [0, -1],
          [1, 0],
          [-1, 0],
        ];
        for (const [dx, dy] of neighbors) {
          const nx = current.x + dx;
          const ny = current.y + dy;
          const nk = `${nx}_${ny}`;
          const nTile = tileMap.get(nk);
          if (nTile && !visited.has(nk)) {
            visited.add(nk);
            queue.push(nTile);
          }
        }
      }
      clusters.push({ tiles: cluster, hasCore });
    });

    result[factionId] = clusters.map((c) => {
      let sumX = 0,
        sumY = 0;
      c.tiles.forEach((t) => {
        sumX += t.x;
        sumY += t.y;
      });
      return {
        x: sumX / c.tiles.length,
        y: sumY / c.tiles.length,
        count: c.tiles.length,
        hasCore: c.hasCore,
      };
    });
  });

  return result;
}

/**
 * 勢力のエッジ計算 (旧式 Object版 - タイムラプス用)
 */
function calculateFactionEdgesLegacy(tiles, factionId) {
  if (!factionId) return [];

  const fTiles = Object.values(tiles).filter(
    (t) => (t.faction || t.factionId) === factionId,
  );
  if (fTiles.length === 0) return [];

  const tileSet = new Set(fTiles.map((t) => `${t.x}_${t.y}`));
  const edges = [];

  fTiles.forEach((t) => {
    const { x, y } = t;
    const checkNeighbor = (nx, ny) => tileSet.has(`${nx}_${ny}`);

    if (!checkNeighbor(x, y - 1))
      edges.push({ x1: x, y1: y, x2: x + 1, y2: y, type: "top" });
    if (!checkNeighbor(x, y + 1))
      edges.push({ x1: x, y1: y + 1, x2: x + 1, y2: y + 1, type: "bottom" });
    if (!checkNeighbor(x - 1, y))
      edges.push({ x1: x, y1: y, x2: x, y2: y + 1, type: "left" });
    if (!checkNeighbor(x + 1, y))
      edges.push({ x1: x + 1, y1: y, x2: x + 1, y2: y + 1, type: "right" });
  });

  return edges;
}

/**
 * 自動選択候補探索 (SAB版)
 */
function findAutoSelectCandidates(
  sab,
  factionsList,
  myFactionId,
  alliances,
  overwriteCost,
) {
  const sabView = new DataView(sab);
  const myFactionIdx = factionsList.indexOf(myFactionId);
  if (myFactionIdx === -1) return [];

  const myTiles = [];
  let occupiedCount = 0;

  for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
    const offset = i * TILE_BYTE_SIZE;
    if (offset + TILE_BYTE_SIZE <= sabView.byteLength) {
      const fidIdx = sabView.getUint16(offset, true);
      if (fidIdx !== 65535) {
        occupiedCount++;
        if (fidIdx === myFactionIdx) {
          myTiles.push(i);
        }
      }
    }
  }

  const directions = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ];
  const candidates = [];
  const seen = new Set();
  const now = Date.now();

  myTiles.forEach((idx) => {
    const x = idx % MAP_SIZE;
    const y = Math.floor(idx / MAP_SIZE);

    directions.forEach(([dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < MAP_SIZE && ny >= 0 && ny < MAP_SIZE) {
        const ni = ny * MAP_SIZE + nx;
        if (seen.has(ni)) return;

        const offset = ni * TILE_BYTE_SIZE;
        if (offset + TILE_BYTE_SIZE > sabView.byteLength) return;

        const nFidIdx = sabView.getUint16(offset, true);

        if (nFidIdx === myFactionIdx) {
          seen.add(ni);
          return;
        }

        const nFid = nFidIdx === 65535 ? null : factionsList[nFidIdx];
        if (nFid && alliances && alliances.includes(nFid)) {
          seen.add(ni);
          return;
        }

        let cost = 1;
        let type = "blank";

        if (nFid) {
          type = "enemy";
          cost = overwriteCost;
          const flags = sabView.getUint8(offset + 11);
          if (flags & 1) {
            const exp = sabView.getFloat64(offset + 12, true);
            if (exp === 0 || exp > now) cost += 1;
          }
        }

        candidates.push({ key: `${nx}_${ny}`, x: nx, y: ny, type, cost });
        seen.add(ni);
      }
    });
  });

  return { candidates, occupiedCount };
}

// メッセージハンドラ
self.onmessage = async function (e) {
  const { type, data, id } = e.data;

  try {
    let result;

    // [NEW] Extract sab/zocSab directly from data for INIT
    const {
      sab,
      zocSab,
      statsSab,
      factions,
      factionsList: fList,
      namedCells: nc,
      mapSize,
    } = data;

    switch (type) {
      case "INIT":
        if (mapSize) MAP_SIZE = mapSize;
        if (sab) sabView = new DataView(sab);
        if (zocSab) zocSabView = new Uint16Array(zocSab);
        if (statsSab) statsSabView = new Int32Array(statsSab);
        if (factions) factionsList = Object.keys(factions);
        break;

      case "UPDATE_FACTIONS":
        if (fList) factionsList = fList;
        if (nc) namedCells = nc;
        break;

      case "RECALC_ZOC":
        recalculateZocLocal();
        self.postMessage({ type: "ZOC_UPDATED" });
        break;

      case "LOAD_MAP_DATA_BINARY":
        {
          const response = await fetch(data.url);
          if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

          const arrayBuffer = await response.arrayBuffer();
          const view = new DataView(arrayBuffer);
          let offset = 0;

          // Magic Check "TMAP"
          const magic = String.fromCharCode(
            view.getUint8(offset++),
            view.getUint8(offset++),
            view.getUint8(offset++),
            view.getUint8(offset++),
          );
          if (magic !== "TMAP") throw new Error("Invalid Binary Map Magic");

          offset++; // version byte (1)
          const mapVersion = view.getFloat64(offset, true); // Timestamp as version
          offset += 8;

          // Factions
          const factionCount = view.getUint16(offset, true);
          offset += 2;
          const factionsList = [];
          const decoder = new TextDecoder();

          for (let i = 0; i < factionCount; i++) {
            const idLen = view.getUint16(offset, true);
            offset += 2;
            factionsList.push(
              decoder.decode(new Uint8Array(arrayBuffer, offset, idLen)),
            );
            offset += idLen;
          }

          // Players (ID list)
          const playerCount = view.getUint32(offset, true);
          offset += 4;
          const playerIds = [];
          for (let i = 0; i < playerCount; i++) {
            const idLen = view.getUint16(offset, true);
            offset += 2;
            const pid = decoder.decode(
              new Uint8Array(arrayBuffer, offset, idLen),
            );
            playerIds.push(pid);
            offset += idLen;
          }
          // 旧互換性のために empty object を渡すが、マッピング管理は playerIds で行う
          const playerNames = {};
          playerIds.forEach((pid) => (playerNames[pid] = pid));

          // Tiles
          const tileCount = view.getUint32(offset, true);
          offset += 4;

          // [OPTIMIZATION] SAB Direct Copy
          // Server writes 24-byte tiles exactly as SAB expects. (8-byte aligned)
          // Structure: Fid(2), Col(4), Paint(4), Over(1), Flag(1), Pad(4), Exp(8), pAt(4)
          const tileDataSize = tileCount * 24;
          const sourceArray = new Uint8Array(arrayBuffer, offset, tileDataSize);
          const targetArray = new Uint8Array(data.sab);
          targetArray.set(sourceArray);

          // [MOD] 互換性のために playerNames も残すが、マッピング管理用に playerList 配列を返すようにする
          result = {
            version: mapVersion,
            playerNames,
            playerList: playerIds,
            factionsList,
          };
        }
        break;

      case "AGGREGATE_FACTIONS":
        result = aggregateFactionsSAB(
          data.sharedData.sab,
          data.sharedData.factionsList,
        );
        break;

      case "CALCULATE_CLUSTERS":
        {
          const version = data.version;
          const targetData = data.sharedData || data; // Handle both direct and nested data
          if (
            version !== undefined &&
            cache.clusters.version === version &&
            cache.clusters.result
          ) {
            result = cache.clusters.result;
          } else {
            if (targetData && targetData.sab) {
              result = calculateClustersSAB(
                targetData.sab,
                targetData.factionsList,
              );
            } else if (targetData && !targetData.sab) {
              // Tiles object case
              result = calculateClustersLegacy(targetData);
            } else {
              result = {};
            }
            cache.clusters.result = result;
            cache.clusters.version = version;
          }
        }
        break;

      case "CALCULATE_EDGES":
        {
          const version = data.version;
          const fid = data.factionId;
          const targetData = data.sharedData || data;
          const cached = cache.edges.get(fid);
          if (version !== undefined && cached && cached.version === version) {
            result = cached.result;
          } else {
            if (targetData && targetData.sab) {
              result = calculateFactionEdgesSAB(
                targetData.sab,
                fid,
                targetData.factionsList,
              );
            } else if (targetData && !targetData.sab) {
              // Tiles object case
              result = calculateFactionEdgesLegacy(targetData, fid);
            } else {
              result = [];
            }
            cache.edges.set(fid, { result, version });
            if (cache.edges.size > 100)
              cache.edges.delete(cache.edges.keys().next().value);
          }
        }
        break;

      case "AUTO_SELECT_CANDIDATES":
        result = findAutoSelectCandidates(
          data.sharedData.sab,
          data.sharedData.factionsList,
          data.myFactionId,
          data.alliances,
          data.overwriteCost,
        );
        break;

      default:
        throw new Error(`Unknown task: ${type}`);
    }

    self.postMessage({ id, success: true, result });
  } catch (error) {
    self.postMessage({ id, success: false, error: error.message });
  }
};

// --- ZOC Calculation (Local) ---
function recalculateZocLocal() {
  if (!zocSabView || !sabView || !namedCells) return;

  // Clear ZOC
  zocSabView.fill(0);

  const size = MAP_SIZE;
  const ZOC_RADIUS = 5;
  const MULTI_IDX = 65534;

  Object.values(namedCells).forEach((cell) => {
    const fid = cell.factionId;
    if (!fid) return;

    // Find faction index
    const idx = factionsList.indexOf(fid);
    if (idx === -1) return;

    // cell.key "x_y" -> x, y
    const [cx, cy] = cell.key.split("_").map(Number);

    for (let dy = -ZOC_RADIUS; dy <= ZOC_RADIUS; dy++) {
      for (let dx = -ZOC_RADIUS; dx <= ZOC_RADIUS; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;

        const offset = ny * size + nx;
        const current = zocSabView[offset];

        if (current === 0) {
          zocSabView[offset] = idx;
        } else if (current !== idx && current !== MULTI_IDX) {
          zocSabView[offset] = MULTI_IDX; // Conflict
        }
      }
    }
  });
}
