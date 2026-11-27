import {
  ActionMode,
  CELL_BYTES,
  CostConfig,
  DEFAULT_BOARD_SIZE,
  FactionClusterAnchor,
  FALLBACK_PATCH_STRIDE,
  HoverInfo,
  MAX_LAYERS,
} from '../shared/protocol';
import { MAX_BOARD_SIZE, sabLoadSeq, sabTrySnapshotRead } from '../shared/sab';

const DEFAULT_COST_CONFIG: CostConfig = {
  claim_cost: 1,
  reinforce_cost: 1,
  enemy_normal_multiplier: 1.0,
  enemy_core_multiplier: 2.0,
  enclave_base_multiplier: 3.0,
  enclave_distance_step: 10,
  enclave_distance_rate: 0.5,
};

interface InitMsg {
  type: 'init';
  boardSize: number;
  rawCellsBuffer?: SharedArrayBuffer | ArrayBuffer;
  ctrlBuffer?: SharedArrayBuffer;
  skipInitialLabels?: boolean;
  labelGen?: number;
}

interface PatchFallbackMsg {
  type: 'patchFallback';
  boardSize: number;
  count: number;
  patchBytes: ArrayBuffer;
}

interface InspectMsg {
  type: 'inspect';
  requestId: number;
  x: number;
  y: number;
  myFactionId: number;
  mode: ActionMode;
  selectedColorId: number;
  warFactionIds: number[];
  canDeclareWar: boolean;
  phase: 'preparation' | 'active' | 'frozen';
  costConfig?: CostConfig;
  maxLayers?: number;
}

interface RecomputeLabelsMsg {
  type: 'recomputeLabels';
  labelGen?: number;
}

interface ComputeLabelsFromSnapshotMsg {
  type: 'computeLabelsFromSnapshot';
  boardSize: number;
  rawCellsBuffer: ArrayBuffer;
  labelGen?: number;
}

type LogicInbound =
  | InitMsg
  | PatchFallbackMsg
  | InspectMsg
  | RecomputeLabelsMsg
  | ComputeLabelsFromSnapshotMsg;

let boardSize = DEFAULT_BOARD_SIZE;
let rawCells: Uint8Array<ArrayBufferLike> | null = null;
let ctrl: Int32Array | undefined;
let cachedSnapshot = new Uint8Array(0);
let lastSnapshotSeq = -1;
let chunkIndexValid = false;
let chunkIndexSize = 0;
let chunkFactions: Array<Map<number, number>> = [];
let factionChunks = new Map<number, Set<number>>();
let cachedVisited = new Uint8Array(0);
let cachedQueue = new Int32Array(0);
const CHUNK_SIZE = 50;

/** 盤面座標が有効な整数範囲内か判定 */
function isValidCoord(x: number, y: number, sz: number = boardSize): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < sz && y < sz;
}

/** チャンクインデックスを無効化する */
function invalidateChunkIndex(): void {
  chunkIndexValid = false;
  chunkIndexSize = 0;
  chunkFactions = [];
  factionChunks.clear();
}

/** チャンク単位の勢力領土カウントを差分更新する (O(1)) */
function adjustChunkIndex(chunkId: number, fid: number, delta: number): void {
  if (fid <= 0 || chunkId < 0 || chunkId >= chunkFactions.length) return;
  const map = chunkFactions[chunkId];
  const prev = map.get(fid) ?? 0;
  const next = prev + delta;
  if (next <= 0) {
    if (prev > 0) {
      map.delete(fid);
      const set = factionChunks.get(fid);
      if (set) {
        set.delete(chunkId);
        if (set.size === 0) {
          factionChunks.delete(fid);
        }
      }
    }
  } else {
    map.set(fid, next);
    let set = factionChunks.get(fid);
    if (!set) {
      set = new Set<number>();
      factionChunks.set(fid, set);
    }
    set.add(chunkId);
  }
}

/** 未構築の場合のみ 1 パスで全チャンクの勢力領土インデックスを構築する */
function ensureChunkIndex(cells: Uint8Array<ArrayBufferLike>, sz: number): void {
  if (chunkIndexValid && chunkIndexSize === sz) return;
  const cps = Math.ceil(sz / CHUNK_SIZE);
  const totalChunks = cps * cps;
  chunkFactions = Array.from({ length: totalChunks }, () => new Map<number, number>());
  factionChunks.clear();

  for (let y = 0; y < sz; y++) {
    const cy = Math.floor(y / CHUNK_SIZE);
    const rowStart = y * sz;
    for (let x = 0; x < sz; x++) {
      const off = (rowStart + x) * CELL_BYTES;
      if ((cells[off] & 1) === 0) continue;
      const fid = cells[off + 4] | (cells[off + 5] << 8);
      if (fid === 0) continue;
      const chunkId = cy * cps + Math.floor(x / CHUNK_SIZE);
      const map = chunkFactions[chunkId];
      map.set(fid, (map.get(fid) ?? 0) + 1);
      let set = factionChunks.get(fid);
      if (!set) {
        set = new Set<number>();
        factionChunks.set(fid, set);
      }
      set.add(chunkId);
    }
  }
  chunkIndexSize = sz;
  chunkIndexValid = true;
}

/** SAB モード時は SeqLock 下でローカルバッファへスナップショットコピーを取得する（更新がなければキャッシュ再利用、失敗時は null） */
function acquireReadableCells(
  targetCells: Uint8Array<ArrayBufferLike>,
  expectedBytes: number
): Uint8Array<ArrayBufferLike> | null {
  if (targetCells.length < expectedBytes) return null;
  if (!ctrl || targetCells !== rawCells) {
    return targetCells;
  }
  const curSeq = sabLoadSeq(ctrl);
  if ((curSeq & 1) === 0 && curSeq === lastSnapshotSeq && cachedSnapshot.length === targetCells.length) {
    return cachedSnapshot;
  }
  if (cachedSnapshot.length !== targetCells.length) {
    cachedSnapshot = new Uint8Array(targetCells.length);
  }
  let capturedSeq = -1;
  const res = sabTrySnapshotRead(ctrl, () => {
    capturedSeq = sabLoadSeq(ctrl);
    cachedSnapshot.set(targetCells);
    return cachedSnapshot;
  });
  if (!res.ok) {
    lastSnapshotSeq = -1;
    return null;
  }
  lastSnapshotSeq = capturedSeq;
  chunkIndexValid = false;
  return res.value;
}

interface CellSnapshot {
  terrain: number;
  colorId: number;
  layers: number;
  isCore: boolean;
  assimilationTicks: number;
  oldCoreTtl: number;
  factionId: number;
  oldCoreFaction: number;
  isSurrounded: boolean;
  adjacent: boolean;
}

/** 対象セルと8近傍のみを軽量に読み取る（SeqLock 内での呼び出し用） */
function readCellSnapshot(
  cells: Uint8Array<ArrayBufferLike>,
  sz: number,
  x: number,
  y: number,
  myFactionId: number
): CellSnapshot | null {
  if (!isValidCoord(x, y, sz)) return null;
  const off = (y * sz + x) * CELL_BYTES;
  if (off < 0 || off + CELL_BYTES > cells.length) return null;

  const terrain = cells[off] & 0x01;
  const colorId = cells[off + 1];
  const layers = cells[off + 2];
  const flags = cells[off + 3];
  const isCore = (flags & 0x01) !== 0;
  const assimilationTicks = ((flags >> 1) & 0x07) | (((cells[off] >> 1) & 0x01) << 3);
  const oldCoreTtl = (flags >> 4) & 0x0f;
  const factionId = cells[off + 4] | (cells[off + 5] << 8);
  const oldCoreFaction = cells[off + 6] | (cells[off + 7] << 8);

  const readFid = (nx: number, ny: number): number => {
    if (!isValidCoord(nx, ny, sz)) return 0;
    const nOff = (ny * sz + nx) * CELL_BYTES;
    if (nOff < 0 || nOff + CELL_BYTES > cells.length) return 0;
    return cells[nOff + 4] | (cells[nOff + 5] << 8);
  };

  const isSurrounded =
    myFactionId > 0 &&
    x > 0 &&
    y > 0 &&
    x + 1 < sz &&
    y + 1 < sz &&
    readFid(x - 1, y) === myFactionId &&
    readFid(x + 1, y) === myFactionId &&
    readFid(x, y - 1) === myFactionId &&
    readFid(x, y + 1) === myFactionId;

  let adjacent = false;
  if (myFactionId > 0) {
    for (let dy = -1; dy <= 1 && !adjacent; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (readFid(x + dx, y + dy) === myFactionId) {
          adjacent = true;
          break;
        }
      }
    }
  }

  return {
    terrain,
    colorId,
    layers,
    isCore,
    assimilationTicks,
    oldCoreTtl,
    factionId,
    oldCoreFaction,
    isSurrounded,
    adjacent,
  };
}

/** 指定セルから最も近い自勢力マスまでのマンハッタン距離（勢力保有チャンクのみ距離順走査＋枝刈り、自勢力マスなしは -1） */
function nearestFactionDistance(
  cells: Uint8Array<ArrayBufferLike>,
  sz: number,
  x: number,
  y: number,
  fid: number
): number {
  if (fid <= 0 || cells.length < sz * sz * CELL_BYTES) return -1;
  ensureChunkIndex(cells, sz);
  const ownedChunks = factionChunks.get(fid);
  if (!ownedChunks || ownedChunks.size === 0) return -1;

  const cps = Math.ceil(sz / CHUNK_SIZE);
  const chunks: Array<{ x0: number; x1: number; y0: number; y1: number; minDist: number }> = [];

  for (const cid of ownedChunks) {
    const cyc = Math.floor(cid / cps);
    const cxc = cid % cps;
    const y0 = cyc * CHUNK_SIZE;
    const y1 = Math.min(sz, y0 + CHUNK_SIZE);
    const minDy = y < y0 ? y0 - y : y >= y1 ? y - (y1 - 1) : 0;

    const x0 = cxc * CHUNK_SIZE;
    const x1 = Math.min(sz, x0 + CHUNK_SIZE);
    const minDx = x < x0 ? x0 - x : x >= x1 ? x - (x1 - 1) : 0;
    chunks.push({ x0, x1, y0, y1, minDist: minDx + minDy });
  }

  // 対象セルに近いチャンクから順に走査し、最小距離で早期打ち切りする
  chunks.sort((a, b) => a.minDist - b.minDist);

  let best = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk.minDist >= best) break;

    for (let cy = chunk.y0; cy < chunk.y1; cy++) {
      const dy = Math.abs(cy - y);
      if (dy >= best) continue;
      const rowStart = cy * sz;
      for (let cx = chunk.x0; cx < chunk.x1; cx++) {
        const off = (rowStart + cx) * CELL_BYTES;
        if ((cells[off] & 1) === 1 && (cells[off + 4] | (cells[off + 5] << 8)) === fid) {
          const d = Math.abs(cx - x) + dy;
          if (d < best) {
            best = d;
            if (d <= 1) return d;
          }
        }
      }
    }
  }
  return best === Number.MAX_SAFE_INTEGER ? -1 : best;
}

/** 敵マス奪取時の基本コスト計算（層数 × 塗り基本コスト × 倍率、小数点切り上げ） */
function computeEnemyCaptureCost(layers: number, claimCost: number, multiplier: number): number {
  const raw = layers * claimCost * multiplier;
  return Math.max(1, Math.ceil(raw - 1e-9));
}

function computeEnclaveCost(
  cells: Uint8Array<ArrayBufferLike>,
  sz: number,
  x: number,
  y: number,
  fid: number,
  baseCost: number,
  cfg: CostConfig
): { cost: number; distance: number } {
  const nearest = nearestFactionDistance(cells, sz, x, y, fid);
  const effectiveDist = nearest >= 0 ? Math.max(0, nearest - 1) : 0;
  const step = Math.max(1, cfg.enclave_distance_step);
  const mult = cfg.enclave_base_multiplier + (effectiveDist / step) * cfg.enclave_distance_rate;
  return {
    cost: Math.min(65535, Math.max(1, Math.round(baseCost * mult))),
    distance: effectiveDist,
  };
}

type InspectCellResult =
  | { status: 'ok'; info: HoverInfo | null }
  | { status: 'busy' };

function inspectCell(msg: InspectMsg): InspectCellResult {
  if (!rawCells) return { status: 'ok', info: null };
  const { x, y, myFactionId, mode, selectedColorId, warFactionIds, canDeclareWar, phase } = msg;
  const sz = boardSize;
  if (!Number.isInteger(sz) || sz < 1 || !isValidCoord(x, y, sz)) {
    return { status: 'ok', info: null };
  }

  const cellsRef = rawCells;
  // 対象セルと8近傍のみを軽量に SeqLock 下で読み取る
  const snapRes = sabTrySnapshotRead(ctrl, () =>
    readCellSnapshot(cellsRef, sz, x, y, myFactionId)
  );
  // SeqLock 競合時は前回表示を維持するため busy として通知する
  if (!snapRes.ok) return { status: 'busy' };
  if (!snapRes.value) return { status: 'ok', info: null };

  let snap = snapRes.value;
  const cfg = msg.costConfig ?? DEFAULT_COST_CONFIG;
  let isEnclave = myFactionId > 0 && snap.factionId !== myFactionId && !snap.adjacent;

  let canExecute = false;
  let actionLabel = '閲覧のみ';
  let costAp = 0;
  let enclaveDistance = 0;
  let needsWarConfirm = false;
  let blockedReason = '';

  if (snap.terrain === 0) {
    actionLabel = '海域';
    blockedReason = '海マスは塗れません';
  } else if (phase !== 'active') {
    actionLabel = phase === 'preparation' ? '準備フェーズ' : '凍結フェーズ';
    blockedReason = phase === 'preparation' ? '開催開始まで塗れません' : 'シーズン終了・閲覧専用';
  } else if (myFactionId <= 0) {
    actionLabel = '勢力未所属';
    blockedReason = '勢力を作成または参加してください';
  } else if (mode === 1) {
    actionLabel = 'マス色変更';
    if (!Number.isInteger(selectedColorId) || selectedColorId < 0 || selectedColorId > 63) {
      blockedReason = '無効な色が選択されています';
    } else if (snap.factionId !== myFactionId) {
      blockedReason = '自勢力のマスのみ色変更可能です';
    } else if (snap.colorId === selectedColorId) {
      blockedReason = '現在と同じ色です';
    } else {
      canExecute = true;
      costAp = 0;
    }
  } else {
    if (snap.factionId === 0) {
      actionLabel = isEnclave ? '空き地を塗る（飛び地）' : '空き地を塗る';
      if (isEnclave) {
        // 飛び地距離計算は SeqLock 外のローカルスナップショット上で実行する
        const scanCells = acquireReadableCells(cellsRef, sz * sz * CELL_BYTES);
        if (!scanCells) {
          return cellsRef.length < sz * sz * CELL_BYTES
            ? { status: 'ok', info: null }
            : { status: 'busy' };
        }
        const snap2 = readCellSnapshot(scanCells, sz, x, y, myFactionId);
        if (!snap2 || snap2.terrain === 0 || snap2.factionId !== 0 || snap2.adjacent) {
          return { status: 'busy' };
        }
        snap = snap2;
        isEnclave = true;
        const res = computeEnclaveCost(scanCells, sz, x, y, myFactionId, cfg.claim_cost, cfg);
        costAp = res.cost;
        enclaveDistance = res.distance;
      } else {
        costAp = cfg.claim_cost;
      }
      canExecute = true;
    } else if (snap.factionId === myFactionId) {
      const maxLayers = msg.maxLayers ?? MAX_LAYERS;
      actionLabel = '重ね塗り';
      if (snap.layers >= maxLayers) {
        blockedReason = `最大${maxLayers}層に到達しています`;
      } else {
        costAp = cfg.reinforce_cost;
        canExecute = true;
      }
    } else {
      if (isEnclave) {
        // 飛び地距離計算は SeqLock 外のローカルスナップショット上で実行する
        const scanCells = acquireReadableCells(cellsRef, sz * sz * CELL_BYTES);
        if (!scanCells) {
          return cellsRef.length < sz * sz * CELL_BYTES
            ? { status: 'ok', info: null }
            : { status: 'busy' };
        }
        const snap2 = readCellSnapshot(scanCells, sz, x, y, myFactionId);
        if (!snap2 || snap2.terrain === 0 || snap2.factionId === 0 || snap2.factionId === myFactionId || snap2.adjacent) {
          return { status: 'busy' };
        }
        snap = snap2;
        isEnclave = true;
        const effectiveLayers = Math.max(1, snap.layers);
        const base = snap.isCore
          ? computeEnemyCaptureCost(effectiveLayers, cfg.claim_cost, cfg.enemy_core_multiplier)
          : computeEnemyCaptureCost(effectiveLayers, cfg.claim_cost, cfg.enemy_normal_multiplier);
        const res = computeEnclaveCost(scanCells, sz, x, y, myFactionId, base, cfg);
        costAp = res.cost;
        enclaveDistance = res.distance;
      } else {
        const effectiveLayers = Math.max(1, snap.layers);
        costAp = snap.isCore
          ? computeEnemyCaptureCost(effectiveLayers, cfg.claim_cost, cfg.enemy_core_multiplier)
          : computeEnemyCaptureCost(effectiveLayers, cfg.claim_cost, cfg.enemy_normal_multiplier);
      }
      const atWar = warFactionIds.includes(snap.factionId);
      actionLabel = snap.isCore ? '相手の中核を奪う' : '相手の領土を奪う';
      if (isEnclave) actionLabel += '（飛び地）';

      if (!atWar) {
        if (!canDeclareWar) {
          blockedReason = '非戦争勢力（開戦権限がありません）';
          canExecute = false;
        } else {
          needsWarConfirm = true;
          canExecute = true;
        }
      } else {
        canExecute = true;
      }
    }
  }

  return {
    status: 'ok',
    info: {
      x,
      y,
      terrain: snap.terrain,
      colorId: snap.colorId,
      layers: snap.layers,
      isCore: snap.isCore,
      assimilationTicks: snap.assimilationTicks,
      oldCoreFaction: snap.oldCoreFaction,
      oldCoreTtl: snap.oldCoreTtl,
      factionId: snap.factionId,
      isSurrounded: snap.isSurrounded,
      isEnclave,
      enclaveDistance,
      canExecute,
      actionLabel,
      costAp,
      needsWarConfirm,
      blockedReason,
    },
  };
}

/** 各勢力の最大連結クラスタ（メイン領土）の重心とサイズを算出（SeqLock 競合時は null） */
function computeFactionLabels(
  targetCells: Uint8Array<ArrayBufferLike> | null = rawCells,
  targetSize: number = boardSize
): FactionClusterAnchor[] | null {
  if (
    !targetCells ||
    !Number.isFinite(targetSize) ||
    !Number.isInteger(targetSize) ||
    targetSize <= 0 ||
    targetSize > MAX_BOARD_SIZE
  ) {
    return [];
  }
  const cells = acquireReadableCells(targetCells, targetSize * targetSize * CELL_BYTES);
  // 盤面データが存在する状態で読み取りに失敗した場合は競合として null を返す
  if (!cells) return null;
  const sz = targetSize;
  const total = sz * sz;
  if (cachedVisited.length !== total) {
    cachedVisited = new Uint8Array(total);
    cachedQueue = new Int32Array(total);
  } else {
    cachedVisited.fill(0);
  }
  const visited = cachedVisited;
  const queue = cachedQueue;
  const bestByFaction = new Map<number, FactionClusterAnchor>();

  for (let start = 0; start < total; start++) {
    if (visited[start]) continue;
    const sOff = start * CELL_BYTES;
    if ((cells[sOff] & 1) === 0) continue;
    const fid = cells[sOff + 4] | (cells[sOff + 5] << 8);
    if (fid === 0) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;

    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = sz;
    let maxX = 0;
    let minY = sz;
    let maxY = 0;

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % sz;
      const y = (idx - x) / sz;
      count++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // 左
      if (x > 0) {
        const n = idx - 1;
        if (!visited[n]) {
          const nOff = n * CELL_BYTES;
          if ((cells[nOff] & 1) === 1 && (cells[nOff + 4] | (cells[nOff + 5] << 8)) === fid) {
            visited[n] = 1;
            queue[tail++] = n;
          }
        }
      }
      // 右
      if (x + 1 < sz) {
        const n = idx + 1;
        if (!visited[n]) {
          const nOff = n * CELL_BYTES;
          if ((cells[nOff] & 1) === 1 && (cells[nOff + 4] | (cells[nOff + 5] << 8)) === fid) {
            visited[n] = 1;
            queue[tail++] = n;
          }
        }
      }
      // 上
      if (y > 0) {
        const n = idx - sz;
        if (!visited[n]) {
          const nOff = n * CELL_BYTES;
          if ((cells[nOff] & 1) === 1 && (cells[nOff + 4] | (cells[nOff + 5] << 8)) === fid) {
            visited[n] = 1;
            queue[tail++] = n;
          }
        }
      }
      // 下
      if (y + 1 < sz) {
        const n = idx + sz;
        if (!visited[n]) {
          const nOff = n * CELL_BYTES;
          if ((cells[nOff] & 1) === 1 && (cells[nOff + 4] | (cells[nOff + 5] << 8)) === fid) {
            visited[n] = 1;
            queue[tail++] = n;
          }
        }
      }
    }

    const prev = bestByFaction.get(fid);
    if (!prev || count > prev.cellCount) {
      bestByFaction.set(fid, {
        factionId: fid,
        centerX: sumX / count + 0.5,
        centerY: sumY / count + 0.5,
        cellCount: count,
        spanW: maxX - minX + 1,
        spanH: maxY - minY + 1,
      });
    }
  }

  return Array.from(bestByFaction.values());
}

let labelRetryTimer: number | null = null;
let pendingLabelGen: number | undefined;
let inspectRetryTimer: number | null = null;
let pendingInspectMsg: Extract<LogicInbound, { type: 'inspect' }> | null = null;
const MAX_SEQLOCK_RETRIES = 6;

function clearLabelRetry(): void {
  if (labelRetryTimer !== null) {
    clearTimeout(labelRetryTimer);
    labelRetryTimer = null;
  }
  pendingLabelGen = undefined;
}

function scheduleLabelRetry(labelGen: number | undefined, attempt = 1): void {
  clearLabelRetry();
  if (attempt > MAX_SEQLOCK_RETRIES) {
    self.postMessage({
      type: 'factionLabelsFailed',
      labelGen,
    });
    return;
  }
  pendingLabelGen = labelGen;
  const delay = 16 * Math.min(4, attempt);
  labelRetryTimer = setTimeout(() => {
    labelRetryTimer = null;
    const targetGen = pendingLabelGen;
    pendingLabelGen = undefined;
    const labels = computeFactionLabels();
    if (labels !== null) {
      self.postMessage({
        type: 'factionLabels',
        labels,
        labelGen: targetGen,
      });
    } else {
      scheduleLabelRetry(targetGen, attempt + 1);
    }
  }, delay) as unknown as number;
}

function clearInspectRetry(): void {
  if (inspectRetryTimer !== null) {
    clearTimeout(inspectRetryTimer);
    inspectRetryTimer = null;
  }
  pendingInspectMsg = null;
}

function scheduleInspectRetry(
  msg: Extract<LogicInbound, { type: 'inspect' }>,
  attempt = 1
): void {
  clearInspectRetry();
  if (attempt > MAX_SEQLOCK_RETRIES) return;
  pendingInspectMsg = msg;
  const delay = 16 * Math.min(4, attempt);
  inspectRetryTimer = setTimeout(() => {
    inspectRetryTimer = null;
    const targetMsg = pendingInspectMsg;
    pendingInspectMsg = null;
    if (!targetMsg) return;
    const res = inspectCell(targetMsg);
    if (res.status === 'ok') {
      self.postMessage({
        type: 'inspectResult',
        requestId: targetMsg.requestId,
        info: res.info,
      });
    } else {
      scheduleInspectRetry(targetMsg, attempt + 1);
    }
  }, delay) as unknown as number;
}

self.onmessage = (ev: MessageEvent<LogicInbound>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': {
      clearLabelRetry();
      clearInspectRetry();
      lastSnapshotSeq = -1;
      invalidateChunkIndex();
      const nextSize = msg.boardSize;
      if (
        !Number.isFinite(nextSize) ||
        !Number.isInteger(nextSize) ||
        nextSize < 1 ||
        nextSize > MAX_BOARD_SIZE
      ) {
        rawCells = null;
        ctrl = undefined;
        break;
      }
      if (
        msg.ctrlBuffer !== undefined &&
        (msg.ctrlBuffer.byteLength < 4 || msg.ctrlBuffer.byteLength % 4 !== 0)
      ) {
        rawCells = null;
        ctrl = undefined;
        break;
      }
      if (msg.rawCellsBuffer !== undefined) {
        const expectedBytes = nextSize * nextSize * CELL_BYTES;
        if (msg.rawCellsBuffer.byteLength < expectedBytes) {
          rawCells = null;
          ctrl = undefined;
          break;
        }
        boardSize = nextSize;
        ctrl = msg.ctrlBuffer ? new Int32Array(msg.ctrlBuffer) : undefined;
        rawCells = new Uint8Array(msg.rawCellsBuffer);
        // 盤面サイズ縮小時は古いキャッシュバッファを解放する
        const expectedCellsLen = nextSize * nextSize;
        if (cachedSnapshot.length > rawCells.length) {
          cachedSnapshot = new Uint8Array(0);
        }
        if (cachedVisited.length > expectedCellsLen) {
          cachedVisited = new Uint8Array(0);
        }
        if (cachedQueue.length > expectedCellsLen) {
          cachedQueue = new Int32Array(0);
        }
        if (!msg.skipInitialLabels) {
          clearLabelRetry();
          const labels = computeFactionLabels();
          if (labels !== null) {
            self.postMessage({
              type: 'factionLabels',
              labels,
              labelGen: msg.labelGen,
            });
          } else {
            scheduleLabelRetry(msg.labelGen);
          }
        }
      } else {
        // 非 SAB モードの再確保時などバッファ未指定の場合は旧盤面参照とキャッシュを破棄する
        clearLabelRetry();
        clearInspectRetry();
        boardSize = nextSize;
        ctrl = msg.ctrlBuffer ? new Int32Array(msg.ctrlBuffer) : undefined;
        rawCells = null;
        cachedSnapshot = new Uint8Array(0);
        cachedVisited = new Uint8Array(0);
        cachedQueue = new Int32Array(0);
      }
      break;
    }
    case 'patchFallback': {
      if (!rawCells || msg.boardSize !== boardSize) break;
      if (!Number.isInteger(msg.count) || msg.count <= 0) break;
      const view = new DataView(msg.patchBytes);
      const patchU8 = new Uint8Array(msg.patchBytes);
      const maxCount = Math.min(
        msg.count,
        Math.floor(msg.patchBytes.byteLength / FALLBACK_PATCH_STRIDE)
      );
      const cps = Math.ceil(boardSize / CHUNK_SIZE);
      const canUpdateIndex = chunkIndexValid && chunkIndexSize === boardSize;
      for (let i = 0; i < maxCount; i++) {
        const pOff = i * FALLBACK_PATCH_STRIDE;
        const x = view.getUint16(pOff, true);
        const y = view.getUint16(pOff + 2, true);
        if (!isValidCoord(x, y, boardSize)) continue;
        const off = (y * boardSize + x) * CELL_BYTES;
        if (off + CELL_BYTES > rawCells.length) continue;
        if (canUpdateIndex) {
          const chunkId = Math.floor(y / CHUNK_SIZE) * cps + Math.floor(x / CHUNK_SIZE);
          const oldLand = (rawCells[off] & 1) === 1;
          const oldFid = oldLand ? rawCells[off + 4] | (rawCells[off + 5] << 8) : 0;
          const newLand = (patchU8[pOff + 4] & 1) === 1;
          const newFid = newLand ? patchU8[pOff + 4 + 4] | (patchU8[pOff + 4 + 5] << 8) : 0;
          if (oldFid !== newFid) {
            if (oldFid > 0) adjustChunkIndex(chunkId, oldFid, -1);
            if (newFid > 0) adjustChunkIndex(chunkId, newFid, 1);
          }
        }
        rawCells.set(patchU8.subarray(pOff + 4, pOff + 4 + CELL_BYTES), off);
      }
      break;
    }
    case 'recomputeLabels': {
      clearLabelRetry();
      const labels = computeFactionLabels();
      if (labels !== null) {
        self.postMessage({
          type: 'factionLabels',
          labels,
          labelGen: msg.labelGen,
        });
      } else {
        scheduleLabelRetry(msg.labelGen);
      }
      break;
    }
    case 'computeLabelsFromSnapshot': {
      if (
        !msg.rawCellsBuffer ||
        !Number.isFinite(msg.boardSize) ||
        !Number.isInteger(msg.boardSize) ||
        msg.boardSize < 1 ||
        msg.boardSize > MAX_BOARD_SIZE
      ) {
        self.postMessage({
          type: 'factionLabels',
          labels: [],
          labelGen: msg.labelGen,
        });
        break;
      }
      const tmp = new Uint8Array(msg.rawCellsBuffer);
      const labels = computeFactionLabels(tmp, msg.boardSize);
      self.postMessage({
        type: 'factionLabels',
        labels: labels ?? [],
        labelGen: msg.labelGen,
      });
      break;
    }
    case 'inspect': {
      clearInspectRetry();
      const res = inspectCell(msg);
      if (res.status === 'ok') {
        self.postMessage({ type: 'inspectResult', requestId: msg.requestId, info: res.info });
      } else {
        scheduleInspectRetry(msg);
      }
      break;
    }
  }
};
