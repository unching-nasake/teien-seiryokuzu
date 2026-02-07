/**
 * マップ計算用 Web Worker
 * 重い計算をメインスレッドから分離してUIブロッキングを防止
 */

const MAP_SIZE = 500;

// [NEW] キャッシュシステム
const cache = {
  clusters: { hash: null, result: null },
  edges: new Map(), // factionId -> { hash, result }
};

// [NEW] 高速ハッシュ関数 (djb2)
function hashTiles(tiles) {
  const keys = Object.keys(tiles).sort();
  let hash = 5381;
  for (const key of keys) {
    const t = tiles[key];
    const fid = t.factionId || t.faction || "";
    const str = `${key}:${fid}`;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) + hash + str.charCodeAt(i);
      hash = hash >>> 0; // 32bit unsigned
    }
  }
  return hash;
}

// [NEW] SharedArrayBufferからタイルデータをデコード (ゼロコピー)
function decodeTilesFromSharedBuffer(buffer) {
  if (!buffer || !(buffer instanceof SharedArrayBuffer)) {
    return null;
  }

  const view = new Int32Array(buffer);
  const count = view[0];
  const tiles = {};

  let index = 1;
  for (let i = 0; i < count; i++) {
    const xy = view[index++];
    const factionNum = view[index++];

    const x = (xy >> 16) & 0xffff;
    const y = xy & 0xffff;
    const key = `${x}_${y}`;

    tiles[key] = {
      factionId: factionNum > 0 ? `f_${factionNum}` : null,
    };
  }

  return tiles;
}

// 隣接タイルの方向
const DIRECTIONS = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

/**
 * 勢力ごとのタイルを集計
 */
function aggregateFactionTiles(tiles) {
  const factionTiles = {};

  Object.entries(tiles).forEach(([key, tile]) => {
    const factionId = tile.factionId || tile.faction;
    if (!factionId) return;

    if (!factionTiles[factionId]) {
      factionTiles[factionId] = {
        tiles: [],
        count: 0,
        sumX: 0,
        sumY: 0,
      };
    }

    const [x, y] = key.split("_").map(Number);
    factionTiles[factionId].tiles.push({ key, x, y, tile });
    factionTiles[factionId].count++;
    factionTiles[factionId].sumX += x;
    factionTiles[factionId].sumY += y;
  });

  // 重心を計算
  Object.values(factionTiles).forEach((data) => {
    if (data.count > 0) {
      data.centerX = Math.floor(data.sumX / data.count);
      data.centerY = Math.floor(data.sumY / data.count);
    }
  });

  return factionTiles;
}

/**
 * 隣接タイルを取得
 */
function getNeighbors(x, y, tiles) {
  const neighbors = [];

  for (const [dx, dy] of DIRECTIONS) {
    const nx = x + dx;
    const ny = y + dy;

    if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) continue;

    const key = `${nx}_${ny}`;
    const tile = tiles[key];

    neighbors.push({
      key,
      x: nx,
      y: ny,
      tile: tile || null,
    });
  }

  return neighbors;
}

/**
 * 勢力ラベルの位置を計算
 */
function calculateFactionLabels(tiles, factions) {
  const factionTiles = aggregateFactionTiles(tiles);
  const labels = [];

  Object.entries(factionTiles).forEach(([factionId, data]) => {
    if (data.count < 5) return; // 5タイル未満はラベル表示しない

    const faction = factions[factionId];
    if (!faction) return;

    labels.push({
      factionId,
      name: faction.name,
      x: data.centerX,
      y: data.centerY,
      count: data.count,
      color: faction.color,
    });
  });

  return labels;
}

/**
 * ビューポート内のタイルを抽出
 */
function getViewportTiles(tiles, viewport) {
  const { startX, startY, endX, endY } = viewport;
  const result = {};

  for (let x = Math.max(0, startX); x <= Math.min(MAP_SIZE - 1, endX); x++) {
    for (let y = Math.max(0, startY); y <= Math.min(MAP_SIZE - 1, endY); y++) {
      const key = `${x}_${y}`;
      if (tiles[key]) {
        result[key] = tiles[key];
      }
    }
  }

  return result;
}

/**
 * 境界タイル（他勢力と隣接）を検出
 */
function findBorderTiles(tiles, factionId) {
  const borders = [];

  Object.entries(tiles).forEach(([key, tile]) => {
    const tileFaction = tile.factionId || tile.faction;
    if (tileFaction !== factionId) return;

    const [x, y] = key.split("_").map(Number);
    const neighbors = getNeighbors(x, y, tiles);

    const isBorder = neighbors.some((n) => {
      if (!n.tile) return true; // 空タイルと隣接 = 境界
      const nFaction = n.tile.factionId || n.tile.faction;
      return nFaction !== factionId;
    });

    if (isBorder) {
      borders.push({ key, x, y });
    }
  });

  return borders;
}

/**
 * 勢力の境界線（エッジ）を計算
 */
function calculateFactionEdges(tiles, factionId) {
  if (!factionId) return [];

  const edges = [];
  const keys = Object.keys(tiles);

  // 勢力に属するタイルを抽出
  const factionTileKeys = keys.filter((key) => {
    const t = tiles[key];
    return (t.factionId || t.faction) === factionId;
  });

  factionTileKeys.forEach((key) => {
    const [x, y] = key.split("_").map(Number);

    const checkNeighbor = (nx, ny) => {
      if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) return false;
      const nTile = tiles[`${nx}_${ny}`];
      return nTile && (nTile.factionId || nTile.faction) === factionId;
    };

    // 上下左右の境界をチェック
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
 * 勢力ごとのクラスタリングと重心計算 (重い処理)
 */
function calculateClusters(tiles) {
  // 1. 勢力ごとにタイルを分類
  const factionTilesMap = {};
  Object.entries(tiles).forEach(([key, tile]) => {
    const fid = tile.factionId || tile.faction;
    if (!fid) return;
    if (!factionTilesMap[fid]) factionTilesMap[fid] = [];
    factionTilesMap[fid].push(key);
  });

  const result = {};

  // 2. 各勢力でクラスタリング (BFS)
  Object.entries(factionTilesMap).forEach(([fid, tileKeys]) => {
    const keysSet = new Set(tileKeys);
    const visited = new Set();
    const clusters = [];

    tileKeys.forEach((startKey) => {
      if (visited.has(startKey)) return;

      const cluster = [];
      const queue = [startKey];
      visited.add(startKey);
      let hasCore = false;

      while (queue.length > 0) {
        const current = queue.shift();
        cluster.push(current);

        const tile = tiles[current];
        if (tile && tile.core) hasCore = true;

        const [tx, ty] = current.split("_").map(Number);
        // 8近傍チェック
        const neighbors = [
          [0, 1],
          [0, -1],
          [1, 0],
          [-1, 0],
          [1, 1],
          [1, -1],
          [-1, 1],
          [-1, -1],
        ];
        for (const [dx, dy] of neighbors) {
          const nk = `${tx + dx}_${ty + dy}`;
          if (keysSet.has(nk) && !visited.has(nk)) {
            visited.add(nk);
            queue.push(nk);
          }
        }
      }

      if (cluster.length > 0) {
        clusters.push({ keys: cluster, hasCore });
      }
    });

    // 3. 各クラスタの重心計算
    result[fid] = clusters.map((cluster) => {
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      cluster.keys.forEach((k) => {
        const [x, y] = k.split("_").map(Number);
        sumX += x;
        sumY += y;
        count++;
      });
      return {
        x: count > 0 ? sumX / count : 0,
        y: count > 0 ? sumY / count : 0,
        count: count,
        hasCore: cluster.hasCore,
      };
    });
  });

  return result;
}

/**
 * 軽量タイルデータを展開 (並列ロード用)
 */
function processLiteChunk(liteTiles) {
  const processed = {};
  Object.keys(liteTiles).forEach((key) => {
    const t = liteTiles[key];
    processed[key] = {
      faction: t.f,
      factionId: t.f,
      color: t.c,
      paintedBy: t.p,
      paintedByName: t.pn,
      overpaint: t.o || 0,
      x: Number(t.x),
      y: Number(t.y),
    };
    if (t.cc) {
      processed[key].customColor = t.c;
    }
    if (t.core) {
      processed[key].core = {
        factionId: t.core.fid,
        expiresAt: t.core.exp,
      };
    }
    if (t.coreUntil) {
      processed[key].coreificationUntil = t.coreUntil;
      processed[key].coreificationFactionId = t.coreFid;
    }
  });
  return processed;
}

// メッセージハンドラ
self.onmessage = async function (e) {
  const { type, data, id } = e.data;

  try {
    let result;

    switch (type) {
      case "LOAD_MAP_DATA_BINARY":
        {
          const response = await fetch(data.url);
          if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

          const arrayBuffer = await response.arrayBuffer();
          const view = new DataView(arrayBuffer);
          let offset = 0;

          // Magic Check
          const magic = String.fromCharCode(
            view.getUint8(offset++),
            view.getUint8(offset++),
            view.getUint8(offset++),
            view.getUint8(offset++),
          );
          if (magic !== "TMAP") throw new Error("Invalid Binary Map Magic");

          const formatVersion = view.getUint8(offset++);
          const mapVersion = view.getUint32LE(offset); // Actually getFloat64 but let's just use it as timestamp
          offset += 8;

          // Factions
          const factionCount = view.getUint16LE(offset);
          offset += 2;
          const factionsList = [];
          const decoder = new TextDecoder();

          for (let i = 0; i < factionCount; i++) {
            const idLen = view.getUint16LE(offset);
            offset += 2;
            const id = decoder.decode(
              new Uint8Array(arrayBuffer, offset, idLen),
            );
            offset += idLen;
            factionsList.push(id);
          }

          // Players
          const playerCount = view.getUint32LE(offset);
          offset += 4;
          const playerNames = {};
          for (let i = 0; i < playerCount; i++) {
            const idLen = view.getUint16LE(offset);
            offset += 2;
            const id = decoder.decode(
              new Uint8Array(arrayBuffer, offset, idLen),
            );
            offset += idLen;

            const nameLen = view.getUint16LE(offset);
            offset += 2;
            const name = decoder.decode(
              new Uint8Array(arrayBuffer, offset, nameLen),
            );
            offset += nameLen;
            playerNames[id] = name;
          }

          // Tiles
          const tileCount = view.getUint32LE(offset);
          offset += 4;
          const tiles = {};

          for (let i = 0; i < tileCount; i++) {
            const x = view.getInt16LE(offset);
            offset += 2;
            const y = view.getInt16LE(offset);
            offset += 2;
            const fidIdx = view.getUint16LE(offset);
            offset += 2;
            const colorInt = view.getUint32LE(offset);
            offset += 4;
            const flags = view.getUint8(offset++);
            const exp = view.getFloat64LE(offset);
            offset += 8;
            offset += 1; // reserved

            const key = `${x}_${y}`;
            const factionId = fidIdx === 65535 ? null : factionsList[fidIdx];
            const color = `#${colorInt.toString(16).padStart(6, "0")}`;

            const tile = {
              x,
              y,
              factionId,
              faction: factionId,
              color,
              overpaint: 0,
            };

            if (flags & 1) {
              tile.core = {
                factionId,
                expiresAt: exp > 0 ? new Date(exp).toISOString() : null,
              };
            }
            if (flags & 2) {
              tile.coreificationUntil = new Date(exp).toISOString();
              tile.coreificationFactionId = factionId;
            }

            tiles[key] = tile;
          }

          result = {
            tiles,
            version: mapVersion,
            playerNames,
          };
        }
        break;

      case "AGGREGATE_FACTIONS":
        result = aggregateFactionTiles(data.tiles);
        break;

      case "GET_NEIGHBORS":
        result = getNeighbors(data.x, data.y, data.tiles);
        break;

      case "CALCULATE_LABELS":
        result = calculateFactionLabels(data.tiles, data.factions);
        break;

      case "GET_VIEWPORT_TILES":
        result = getViewportTiles(data.tiles, data.viewport);
        break;

      case "FIND_BORDERS":
        result = findBorderTiles(data.tiles, data.factionId);
        break;

      case "CALCULATE_CLUSTERS":
        {
          // [OPTIMIZED] キャッシュチェック (Versionベース)
          // mapVersionが渡されていなければハッシュ計算 (互換性)
          const version = data.mapVersion;
          let useCache = false;

          if (version !== undefined) {
            if (cache.clusters.version === version && cache.clusters.result) {
              useCache = true;
            }
          } else {
            // Fallback to hash
            const tilesHash = hashTiles(data.tiles);
            if (cache.clusters.hash === tilesHash && cache.clusters.result) {
              useCache = true;
            }
            // Store hash for next comparison if version not used
            if (!useCache) cache.clusters.hash = tilesHash;
          }

          if (useCache) {
            result = cache.clusters.result;
          } else {
            result = calculateClusters(data.tiles);
            cache.clusters.result = result;
            if (version !== undefined) cache.clusters.version = version;
          }
        }
        break;

      case "CALCULATE_EDGES":
        {
          // [OPTIMIZED] 勢力ごとのキャッシュ (Versionベース)
          const version = data.mapVersion;
          const cacheKey = data.factionId;
          const cached = cache.edges.get(cacheKey);
          let useCache = false;

          // Re-implementing for scope clarity
          let tilesHash = null;
          if (version === undefined) {
            tilesHash = hashTiles(data.tiles);
            if (cached && cached.hash === tilesHash) {
              useCache = true;
            }
          } else {
            if (cached && cached.version === version) {
              useCache = true;
            }
          }

          if (useCache && cached) {
            result = cached.result;
          } else {
            result = calculateFactionEdges(data.tiles, data.factionId);

            // Update Cache
            const newCache = { result };
            if (version !== undefined) {
              newCache.version = version;
            } else {
              newCache.hash = tilesHash;
            }

            cache.edges.set(cacheKey, newCache);

            // キャッシュサイズ制限 (最大50勢力)
            if (cache.edges.size > 50) {
              const firstKey = cache.edges.keys().next().value;
              cache.edges.delete(firstKey);
            }
          }
        }
        break;

      case "PROCESS_LITE_CHUNK":
        result = processLiteChunk(data.tiles);
        break;

      default:
        throw new Error(`Unknown task type: ${type}`);
    }

    self.postMessage({ id, success: true, result });
  } catch (error) {
    self.postMessage({ id, success: false, error: error.message });
  }
};
