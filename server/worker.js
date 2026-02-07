const { parentPort } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const { createCanvas, registerFont } = require("canvas");
const shared = require("./shared");
const { LockManager, MAP_SIZE, getTilePoints, calculateFactionPoints } = shared;

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
  if (knownFactionKeys) {
    knownFactionKeys.forEach((k) => initialFactionTiles.add(k));
  } else {
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

  // 1. 接続性判定のための中心座標の事前抽出 (呼び出しごとに1回)
  const validCoreCoords = [];
  for (const k in mapState.tiles) {
    const tile = mapState.tiles[k];
    if (tile.core && alliedFids.has(tile.core.factionId)) {
      const [cx, cy] = k.split("_").map(Number);
      validCoreCoords.push({ x: cx, y: cy });
    }
  }

  // 2. 他勢力に包囲されているかの判定 (呼び出しごとに1回)
  let isLandlocked = true;
  for (const k in mapState.tiles) {
    const tile = mapState.tiles[k];
    if (tile.factionId === factionId) {
      const [tx, ty] = k.split("_").map(Number);
      const ns = [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ];
      for (const [dx, dy] of ns) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) continue;
        const nt = mapState.tiles[`${nx}_${ny}`];
        if (!nt || !nt.factionId) {
          isLandlocked = false;
          break;
        }
      }
    }
    if (!isLandlocked) break;
  }

  // 3. クラスタ情報（提案タイルを含む）
  const clusterInfo = getFactionClusterInfo(
    factionId,
    mapState,
    tiles,
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
    const existing = mapState.tiles[key];
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
          const nTile = mapState.tiles[`${nx}_${ny}`];
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
          let coreMultiplier = 1.5;
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
            const nTile = mapState.tiles[`${nx}_${ny}`];
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

        // ZOC内（敵拠点隣接）の場合はコスト2倍 (付近に自陣営の中核がある場合は1.3倍)
        if (t.isZoc) {
          if (t.isZocReduced) {
            base = Math.round(base * 1.3);
          } else {
            base *= 2;
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

      if (minDist > 25) {
        const penalty = Math.ceil((minDist - 25) / 1);
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

  if (type === "CALCULATE_STATS") {
    try {
      const { affectedFactionIds, filePaths } = data;
      // メモリ最適化: 注入されていない場合はディスクからロード
      const mapState =
        data.mapState ||
        (filePaths?.mapState
          ? loadJSON(filePaths.mapState, { tiles: {} }, true)
          : { tiles: {} });
      if (!mapState.tiles) mapState.tiles = {};
      const factions =
        data.factions ||
        (filePaths?.factions
          ? loadJSON(filePaths.factions, { factions: {} }, true)
          : { factions: {} });
      if (!factions.factions) factions.factions = {};

      const nowMs = Date.now();
      const factionStats = {};
      const pointUpdates = {};

      // Memory Opt: for-in loop
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

      const factionsToCalc = new Set(affectedFactionIds);
      factionsToCalc.forEach((fid) => {
        if (factions.factions[fid]) {
          pointUpdates[fid] = calculateFactionPoints(fid, mapState);
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
      const { tiles, player, action, overpaintCount, filePaths } = data;

      // データが注入されていない場合はディスクから読み込む
      const mapState =
        data.mapState ||
        (filePaths?.mapState ? loadJSON(filePaths.mapState) : { tiles: {} });
      if (!mapState.tiles) mapState.tiles = {};

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

      // 1. ZOC Check
      const playerFaction = factions.factions[player.factionId];
      const alliedFids = new Set([player.factionId]);
      if (
        playerFaction &&
        playerFaction.allianceId &&
        alliances.alliances[playerFaction.allianceId]
      ) {
        alliances.alliances[playerFaction.allianceId].members.forEach((m) =>
          alliedFids.add(m),
        );
      }

      for (const t of tiles) {
        const targetTile = mapState.tiles[`${t.x}_${t.y}`];
        const targetFactionId = targetTile ? targetTile.factionId : null;
        for (const [nKey, namedData] of Object.entries(namedCells)) {
          // mapStateから所有者を取得
          const ncTile = mapState.tiles[nKey];
          const ncFactionId = ncTile ? ncTile.factionId : null;

          if (ncFactionId && ncFactionId !== player.factionId) {
            const enemyAlliedFids = new Set([ncFactionId]);
            const ncFaction = factions.factions[ncFactionId];
            if (
              ncFaction &&
              ncFaction.allianceId &&
              alliances.alliances[ncFaction.allianceId]
            ) {
              alliances.alliances[ncFaction.allianceId].members.forEach((m) =>
                enemyAlliedFids.add(m),
              );
            }

            const radius = 5; // 定数化されたZOC半径
            if (
              Math.abs(t.x - namedData.x) <= radius &&
              Math.abs(t.y - namedData.y) <= radius
            ) {
              // 簡易ZOC判定: 半径5マスの範囲 (11x11)
              // 敵勢力またはその同盟勢力が所有し、かつネームドマスそのものではない場合にZOC適用
              if (
                enemyAlliedFids.has(targetFactionId) &&
                !(t.x === namedData.x && t.y === namedData.y)
              ) {
                t.isZoc = true;

                // 攻撃側（または同盟）の中核マスがネームドマスの射程内にあればコスト軽減
                let isCoreNear = false;
                for (const k in mapState.tiles) {
                  const tile = mapState.tiles[k];
                  if (tile.core && alliedFids.has(tile.core.factionId)) {
                    const [cx, cy] = k.split("_").map(Number);
                    if (
                      Math.abs(cx - namedData.x) <= radius &&
                      Math.abs(cy - namedData.y) <= radius
                    ) {
                      isCoreNear = true;
                      break;
                    }
                  }
                }
                if (isCoreNear) {
                  t.isZocReduced = true;
                }
              }
            }
          }
        }
      }

      // 2. Diplomacy & War Check
      let needsWarDeclaration = false;
      let targetFactionIdForWar = null;
      let targetFactionNameForWar = null;

      for (const t of tiles) {
        const existing = mapState.tiles[`${t.x}_${t.y}`];
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
    // ランキング計算タスク
    const { filePaths } = data;
    try {
      const mapState = loadJSON(filePaths.mapState, { tiles: {} });
      const stats = {};

      // 全タイル走査
      Object.entries(mapState.tiles).forEach(([key, t]) => {
        const fid = t.factionId || t.faction;
        if (fid) {
          if (!stats[fid]) stats[fid] = { tiles: 0, points: 0 };
          const [x, y] = key.split("_").map(Number);
          const p = getTilePoints(x, y);
          stats[fid].tiles += 1;
          stats[fid].points += p;
        }
      });

      // 勢力データのボーナスポイントを加算
      const factions = loadJSON(filePaths.factions, { factions: {} });
      const factionPoints = {};
      Object.keys(factions.factions).forEach((fid) => {
        const f = factions.factions[fid];
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
      const ranks = sorted.map((s, i) => {
        // ポイントが前の勢力より低い場合のみランクを更新 (同点なら維持)
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

      parentPort.postMessage({
        success: true,
        taskId,
        results: { ranks, updatedStats: stats }, // 必要に応じて詳細統計も返す
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
      const mapState = loadJSON(filePaths.mapState, { tiles: {} });

      // Worker内でロジック実行
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
            const t = mapState.tiles[tKey];
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
  } else if (type === "PROCESS_COREIFICATION") {
    // 中核化維持・確定処理タスク
    const { filePaths } = data; // 判定対象の勢力IDリスト（空なら全勢力）
    try {
      const mapState = loadJSON(filePaths.mapState, { tiles: {} });
      const factionsData = loadJSON(filePaths.factions, { factions: {} });

      // ロジック実行: recalculateAllFactionCores は既にWorker内にあるが、機能拡張が必要
      // 今回は既存の recalculateAllFactionCores の内部ロジックを利用・拡張して
      // 「自動中核化（拡大）」と「期限切れ削除」の両方を行う

      const nowMs = Date.now();
      const updatedTiles = {};
      const ONE_HOUR = 60 * 60 * 1000;

      Object.values(mapState.tiles).forEach((tile) => {
        if (tile.core && tile.core.expiresAt) {
          if (new Date(tile.core.expiresAt).getTime() <= nowMs) {
            // 期限切れ
            updatedTiles[`${tile.x}_${tile.y}`] = { ...tile };
            delete updatedTiles[`${tile.x}_${tile.y}`].core;
          } else {
            // 自勢力チェック
            const fid = tile.faction || tile.factionId;
            if (fid === tile.core.factionId) {
              // 自勢力で維持されていれば恒久化(expiresAt削除)
              updatedTiles[`${tile.x}_${tile.y}`] = { ...tile };
              delete updatedTiles[`${tile.x}_${tile.y}`].core.expiresAt;
            }
          }
        }
      });

      // 2. 自動中核化 (拡大)
      const targetData = factionsData.factions;
      // 全数チェックだと重いが、Workerなのである程度許容。
      // ただし、mapStateをなめる回数を減らすため、先に勢力ごとのタイルリストを作る
      const factionTiles = {};
      Object.entries(mapState.tiles).forEach(([key, t]) => {
        const fid = t.faction || t.factionId;
        if (fid && targetData[fid]) {
          if (!factionTiles[fid]) factionTiles[fid] = [];
          factionTiles[fid].push({ key, ...t });
        }
      });

      Object.keys(targetData).forEach((fid) => {
        const tiles = factionTiles[fid] || [];
        const count = tiles.length;
        const knownKeys = tiles.map((t) => t.key);

        const clusterInfo = getFactionClusterInfoWorker(
          fid,
          mapState,
          [],
          knownKeys,
        );

        clusterInfo.clusters.forEach((cluster) => {
          if (!cluster.hasCore) return;

          cluster.tiles.forEach((key) => {
            const tile = mapState.tiles[key];
            if (!tile) return;
            if (updatedTiles[key]) return; // 既に更新対象ならスキップ(削除優先)

            // 既に自分の中核ならスキップ
            if (tile.core && tile.core.factionId === fid) return;
            // 他人の有効な中核ならスキップ
            if (tile.core && tile.core.factionId !== fid) return; // 奪取ロジックは別途あるはずだがここでは触らない

            let shouldCore = false;
            // 小規模(400以下)即時 or 大規模1時間
            if (count <= 400) {
              shouldCore = true;
            } else {
              const pTime = new Date(tile.paintedAt || 0).getTime();
              if (nowMs - pTime >= ONE_HOUR) {
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
      });

      parentPort.postMessage({
        success: true,
        taskId,
        results: { updatedTiles }, // 変更されたタイルのみを返す
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
      const { filePaths } = data;
      const mapState = loadJSON(filePaths.mapState, { tiles: {} });
      const factions = loadJSON(filePaths.factions, { factions: {} });

      const { changed, updatedTiles } = recalculateAllFactionCores(
        mapState,
        factions,
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
  } else if (type === "RECALCULATE_CORES_PARTIAL") {
    try {
      const { factionIds, startY, endY, filePaths } = data;
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
          if (expandFactionCores(fid, mapState, nowMs, updatedTiles)) {
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
      const gameIds = loadJSON(filePaths.gameIds, {}, true); // ignoreCache=true で確実に最新を取得
      const players = loadJSON(filePaths.players, { players: {} });
      const factions = loadJSON(filePaths.factions, { factions: {} });
      const mapState = loadJSON(filePaths.mapState, { tiles: {} });

      const stats = {};
      const pointsStats = {};
      // メモリ最適化: for-in ループを使用
      for (const key in mapState.tiles) {
        const t = mapState.tiles[key];
        const fid = t.faction || t.factionId;
        if (fid) {
          stats[fid] = (stats[fid] || 0) + 1; // Count tiles
          const [x, y] = key.split("_").map(Number);
          pointsStats[fid] = (pointsStats[fid] || 0) + getTilePoints(x, y); // Count points
        }
      }
      const sortedRanks = Object.entries(stats)
        .map(([id, tiles]) => ({ id, tiles }))
        .sort((a, b) => b.tiles - a.tiles)
        .map((s, i) => ({ id: s.id, rank: i + 1, tiles: s.tiles }));

      const ranksMap = {};
      sortedRanks.forEach((r) => (ranksMap[r.id] = r.rank));

      const gameKeys = Object.keys(gameIds);
      const appliedTriggers = [];

      gameKeys.forEach((authKeyInGameIds) => {
        const info = gameIds[authKeyInGameIds];
        if (!info.secretTriggers || info.secretTriggers.length === 0) return;

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
          console.log(
            `[Worker-SecretTrigger] Player ${playerId}: no factionId (player: ${!!player}, factionId: ${player?.factionId})`,
          );
          return;
        }

        const faction = factions.factions[player.factionId];
        if (!faction) {
          console.log(
            `[Worker-SecretTrigger] Player ${playerId}: faction ${player.factionId} not found`,
          );
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
          factionPoints: pointsStats,
          workerId,
        },
      });
    } catch (e) {
      parentPort.postMessage({ success: false, taskId, error: e.message });
    }
  } else if (type === "PROCESS_COREIFICATION_COUNTDOWNS") {
    try {
      const { filePaths } = data;
      // Zero-Copy: マップ状態を直接読み込み
      const mapState = loadJSON(filePaths.mapState, { tiles: {} }, true);
      const now = Date.now();
      const updates = {};
      let updatedCount = 0;

      // メモリ最適化のため for-in ループを使用
      for (const key in mapState.tiles) {
        const tile = mapState.tiles[key];

        // 中核化カウントダウンのチェック
        if (tile.coreificationUntil && tile.coreificationFactionId) {
          const coreificationTime = new Date(tile.coreificationUntil).getTime();
          const tileFactionId = tile.faction || tile.factionId;

          if (
            now >= coreificationTime &&
            tileFactionId === tile.coreificationFactionId
          ) {
            // Apply Coreification
            const newTile = { ...tile };
            delete newTile.coreificationUntil;
            delete newTile.coreificationFactionId;

            if (!newTile.core) {
              newTile.core = {
                factionId: newTile.factionId || newTile.faction,
                health: 100,
                maxHealth: 100,
                expiresAt: null, // Permanent core
              };
            }
            // Ensure faction consistency (redundant but safe)
            newTile.core.factionId = newTile.factionId || newTile.faction;

            updates[key] = newTile;
            updatedCount++;
          }
        }
      }

      parentPort.postMessage({
        success: true,
        taskId,
        results: { updates, updatedCount, workerId },
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
      const { startY, endY, filePaths } = data;

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
              if (!t.core && totalCores < 2500) {
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
  } else if (type === "GENERATE_LITE_MAP") {
    try {
      const { filePaths, playerNames } = data;
      const mapState = loadJSON(filePaths.mapState, { tiles: {} });
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
      const mapState = loadJSON(filePaths.mapState, { tiles: {} });
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
  Object.entries(mapState.tiles).forEach(([key, tile]) => {
    const [x, y] = key.split("_").map(Number);
    const fid = tile.faction || tile.factionId;
    const faction = factions[fid];

    if (faction) {
      let color = tile.customColor || faction.color || "#888888";

      // 同盟モードでは同盟ごとに色分け
      if (mode === "alliance" && factionToAlliance[fid]) {
        const alliance = alliances[factionToAlliance[fid]];
        if (alliance && alliance.color) {
          color = alliance.color;
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

function expandFactionCores(fid, mapState, nowMs, updatedTilesAccumulator) {
  const clusters = getClusters(fid, mapState);
  if (clusters.length === 0) return false;

  const validCandidates = new Set();
  const candidatesByCluster = [];
  let changed = false;

  clusters.forEach((cluster) => {
    const size = cluster.length;
    const requiredHours = Math.floor((size - 1) / 500);
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

      const tile = mapState.tiles[current];
      // Worker内では mapState がプレーンオブジェクトなのでアクセス注意
      if (tile && tile.core && tile.core.factionId === factionId) {
        hasCore = true;
      }

      const [x, y] = current.split("_").map(Number);
      for (const [dx, dy] of directions) {
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

function recalculateAllFactionCores(mapState, factions) {
  const nowMs = Date.now();
  let changed = false;
  const updatedTiles = {};

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

  Object.keys(factions.factions).forEach((fid) => {
    if (expandFactionCores(fid, mapState, nowMs, updatedTiles)) {
      changed = true;
    }
  });

  return { changed, updatedTiles };
}

async function checkAllIntegrity(filePaths) {
  let log = [];
  const mapState = loadJSON(filePaths.mapState, { tiles: {} });
  const namedCellsData = loadJSON(filePaths.namedCells, {});
  const factionsData = loadJSON(filePaths.factions, { factions: {} });

  const diffs = {
    mapState: { updates: {}, deletes: [] },
    namedCells: { updates: {}, deletes: [] },
  };

  let mapUpdated = false;
  let namedUpdated = false;

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
