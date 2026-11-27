import {
  ACTION_RESULT_HEADER_BYTES,
  CELL_BYTES,
  CELL_DIFF_HEADER_BYTES,
  DEFAULT_BOARD_SIZE,
  encodeClientAction,
  FALLBACK_PATCH_STRIDE,
  OP_CLIENT_PING,
  OP_SERVER_ACTION_RESULT,
  OP_SERVER_CELL_DIFF,
  OP_SERVER_EVENT_JSON,
  OP_SERVER_PONG,
  OP_SERVER_TICK_SYNC,
  packAllCellsToRgba8ui,
  packCellToRgba8ui,
  phaseFromCode,
} from '../shared/protocol';
import { MAX_BOARD_SIZE, sabBeginWrite, sabEndWrite } from '../shared/sab';

interface InitMsg {
  type: 'init';
  boardSize: number;
  sabEnabled: boolean;
  rawCellsBuffer?: SharedArrayBuffer;
  gpuTexBuffer?: SharedArrayBuffer;
  ctrlBuffer?: SharedArrayBuffer;
  snapshotUrl: string;
  wsUrl: string;
  bufferGen?: number;
  wsGen: number;
}

interface ResizeBuffersMsg {
  type: 'resizeBuffers';
  boardSize: number;
  sabEnabled: boolean;
  rawCellsBuffer?: SharedArrayBuffer;
  gpuTexBuffer?: SharedArrayBuffer;
  ctrlBuffer?: SharedArrayBuffer;
  snapshotUrl: string;
  bufferGen?: number;
}

interface ReconnectMsg {
  type: 'reconnect';
  wsUrl: string;
  wsGen: number;
}

interface ReloadSnapshotMsg {
  type: 'reloadSnapshot';
  snapshotUrl: string;
}

interface ActionMsg {
  type: 'sendAction';
  actionId: number;
  x: number;
  y: number;
  mode: 0 | 1;
  colorId: number;
  confirmWar: boolean;
  wsGen?: number;
}

type WorkerInbound =
  | InitMsg
  | ResizeBuffersMsg
  | ReconnectMsg
  | ReloadSnapshotMsg
  | ActionMsg;

let boardSize = DEFAULT_BOARD_SIZE;
let sabEnabled = false;
let rawCells: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
let gpuTex: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
let ctrl: Int32Array | undefined;
let ws: WebSocket | null = null;
let currentWsUrl = '';
let currentSnapshotUrl = '';
let shouldResyncOnOpen = false;
let reconnectTimer: number | null = null;
let snapshotRetryTimer: number | null = null;
let snapshotRetryAttempt = 0;
let pingTimer: number | null = null;
let pongTimer: number | null = null;
let reconnectAttempt = 0;
const MAX_PENDING_DIFF_COUNT = 256;
const MAX_PENDING_DIFF_BYTES = 4 * 1024 * 1024;

let snapshotGen = 0;
let currentBufferGen = 0;
let currentWsGen = 0;
let bufferReady = false;
let isFetchingSnapshot = false;
let snapshotFloorVersion: bigint | null = null;
let lastDiffVersion: bigint | null = null;
let pendingDiffsDuringSnapshot: ArrayBuffer[] = [];
let pendingDiffBytes = 0;
let pendingDiffOverflow = false;
let snapshotAbort: AbortController | null = null;
const decoder = new TextDecoder();

type FetchSnapshotResult = 'ok' | 'sizeMismatch' | 'aborted' | 'error';

/** X-Snapshot-Version ヘッダを u64 BigInt としてパースする（不正時は null） */
function parseSnapshotVersion(raw: string | null): bigint | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

async function fetchSnapshot(url: string): Promise<FetchSnapshotResult> {
  const gen = ++snapshotGen;
  const myBufGen = currentBufferGen;
  isFetchingSnapshot = true;
  // リクエスト開始前に蓄積されていた古い差分やオーバーフロー状態を破棄する
  pendingDiffsDuringSnapshot = [];
  pendingDiffBytes = 0;
  pendingDiffOverflow = false;

  if (snapshotAbort) {
    snapshotAbort.abort();
  }
  const controller = new AbortController();
  snapshotAbort = controller;

  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (gen !== snapshotGen || myBufGen !== currentBufferGen) return 'aborted';
    if (!res.ok) {
      self.postMessage({ type: 'error', message: `盤面取得失敗: HTTP ${res.status}` });
      return 'error';
    }
    const snapshotVersion = parseSnapshotVersion(res.headers.get('x-snapshot-version'));
    const rawHeaderSize = res.headers.get('x-board-size');
    let headerSize = 0;
    if (rawHeaderSize !== null && rawHeaderSize.trim() !== '') {
      const parsed = Number(rawHeaderSize);
      if (!Number.isInteger(parsed) || parsed < 16 || parsed > MAX_BOARD_SIZE) {
        self.postMessage({
          type: 'error',
          message: `盤面ヘッダサイズ異常: ${rawHeaderSize}`,
        });
        return 'error';
      }
      headerSize = parsed;
    }

    const buf = await res.arrayBuffer();
    if (gen !== snapshotGen || myBufGen !== currentBufferGen) return 'aborted';
    const bytes = new Uint8Array(buf);
    const inferredSize =
      headerSize > 0 ? headerSize : Math.round(Math.sqrt(bytes.byteLength / CELL_BYTES));

    if (
      !Number.isInteger(inferredSize) ||
      inferredSize < 16 ||
      inferredSize > MAX_BOARD_SIZE ||
      inferredSize * inferredSize * CELL_BYTES !== bytes.byteLength
    ) {
      self.postMessage({
        type: 'error',
        message: `盤面データサイズ異常: ${bytes.byteLength}`,
      });
      return 'error';
    }

    if (inferredSize !== boardSize) {
      // バッファサイズがサーバーの実盤面サイズと異なるため、旧サイズバッファへの誤適用を防ぐべく状態をリセットし再確保を依頼する
      clearSnapshotRetryTimer();
      bufferReady = false;
      isFetchingSnapshot = false;
      pendingDiffsDuringSnapshot = [];
      pendingDiffBytes = 0;
      pendingDiffOverflow = false;
      snapshotFloorVersion = null;
      lastDiffVersion = null;
      self.postMessage({ type: 'sizeMismatch', boardSize: inferredSize });
      return 'sizeMismatch';
    }

    sabBeginWrite(ctrl);
    try {
      rawCells.set(bytes);
      packAllCellsToRgba8ui(rawCells, gpuTex, boardSize);
    } finally {
      sabEndWrite(ctrl);
    }

    if (sabEnabled) {
      self.postMessage({ type: 'snapshotReady', boardSize, bufferGen: myBufGen });
    } else {
      const rawCopy = rawCells.slice();
      const gpuCopy = gpuTex.slice();
      self.postMessage(
        {
          type: 'snapshotReady',
          boardSize,
          bufferGen: myBufGen,
          rawBytes: rawCopy.buffer,
          gpuBytes: gpuCopy.buffer,
        },
        [rawCopy.buffer, gpuCopy.buffer]
      );
    }

    // スナップショット読込完了後に保留中の差分をバージョン検証しつつ順番に適用する
    clearSnapshotRetryTimer();
    const overflowed = pendingDiffOverflow;
    const queued = pendingDiffsDuringSnapshot;
    pendingDiffsDuringSnapshot = [];
    pendingDiffBytes = 0;
    pendingDiffOverflow = false;
    isFetchingSnapshot = false;

    if (overflowed) {
      // 取得中に差分キューが溢れた場合は bufferReady を立てず、バックオフ付きで再取得する
      bufferReady = false;
      scheduleSnapshotRetry(url, myBufGen, gen);
      return 'ok';
    }

    snapshotFloorVersion = snapshotVersion;
    lastDiffVersion = null;
    bufferReady = true;

    snapshotRetryAttempt = 0;
    if (queued.length > 0) {
      for (const frame of queued) {
        if (myBufGen !== currentBufferGen || isFetchingSnapshot || !bufferReady) break;
        if (snapshotVersion !== null && frame.byteLength >= CELL_DIFF_HEADER_BYTES) {
          const diffVersion = new DataView(frame).getBigUint64(1, true);
          if (diffVersion <= snapshotVersion) continue;
        }
        handleBinaryMessage(frame);
      }
    }
    return 'ok';
  } catch (err) {
    if (controller.signal.aborted || gen !== snapshotGen) return 'aborted';
    self.postMessage({ type: 'error', message: `盤面取得エラー: ${String(err)}` });
    return 'error';
  } finally {
    if (gen === snapshotGen) {
      isFetchingSnapshot = false;
      // 既に盤面ロード済みの状態で再同期に失敗した場合は、溜まった差分を適用して最新化を試みる
      if (bufferReady) {
        if (pendingDiffOverflow) {
          // オーバーフロー時は未準備状態へ戻し、呼び出し元のエラーリトライへ委ねる
          bufferReady = false;
          pendingDiffsDuringSnapshot = [];
          pendingDiffBytes = 0;
          pendingDiffOverflow = false;
        } else if (pendingDiffsDuringSnapshot.length > 0) {
          const queued = pendingDiffsDuringSnapshot;
          pendingDiffsDuringSnapshot = [];
          pendingDiffBytes = 0;
          pendingDiffOverflow = false;
          for (const frame of queued) {
            if (myBufGen !== currentBufferGen || isFetchingSnapshot || !bufferReady) break;
            if (snapshotFloorVersion !== null && frame.byteLength >= CELL_DIFF_HEADER_BYTES) {
              const diffVersion = new DataView(frame).getBigUint64(1, true);
              if (diffVersion <= snapshotFloorVersion) continue;
            }
            handleBinaryMessage(frame);
          }
        }
      }
    }
    if (snapshotAbort === controller) {
      snapshotAbort = null;
    }
  }
}

function clearSnapshotRetryTimer(): void {
  if (snapshotRetryTimer !== null) {
    clearTimeout(snapshotRetryTimer);
    snapshotRetryTimer = null;
  }
}

function fetchSnapshotWithRetry(url: string, expectedBufGen: number): void {
  const startedGen = snapshotGen + 1;
  void fetchSnapshot(url).then((result) => {
    // 進行中の fetchSnapshot が後続の再同期に置き換わっていた場合は古いエラーリトライを無視する
    if (expectedBufGen !== currentBufferGen || startedGen !== snapshotGen) return;
    if (result === 'error') {
      scheduleSnapshotRetry(url, expectedBufGen, startedGen);
    }
  });
}

function scheduleSnapshotRetry(
  url: string,
  expectedBufGen: number,
  expectedSnapshotGen = snapshotGen
): void {
  clearSnapshotRetryTimer();
  // 1s 〜 15s の指数バックオフでスナップショット取得を再試行する
  const delay = Math.min(15000, 1000 * Math.pow(2, snapshotRetryAttempt));
  snapshotRetryAttempt++;
  snapshotRetryTimer = setTimeout(() => {
    snapshotRetryTimer = null;
    if (expectedBufGen !== currentBufferGen || expectedSnapshotGen !== snapshotGen) return;
    fetchSnapshotWithRetry(url, expectedBufGen);
  }, delay) as unknown as number;
}

function clearWsTimers(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pingTimer !== null) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (pongTimer !== null) {
    clearTimeout(pongTimer);
    pongTimer = null;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null || !currentWsUrl) return;
  // 1.5s 〜 30s の指数バックオフ + ジッター
  const baseDelay = Math.min(30000, 1500 * Math.pow(2, reconnectAttempt));
  const jitter = Math.random() * 500;
  const delay = Math.round(baseDelay + jitter);
  reconnectAttempt++;
  const expectedWsGen = currentWsGen;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (currentWsUrl && expectedWsGen === currentWsGen) {
      shouldResyncOnOpen = true;
      connectWs(currentWsUrl, expectedWsGen);
    }
  }, delay) as unknown as number;
}

function connectWs(url: string, wsGen: number = currentWsGen): void {
  currentWsUrl = url;
  clearWsTimers();

  if (ws) {
    const oldWs = ws;
    oldWs.onopen = null;
    oldWs.onmessage = null;
    oldWs.onerror = null;
    oldWs.onclose = null;
    ws = null;
    try {
      oldWs.close();
    } catch {
      // 既に閉じている場合の例外は無視
    }
  }
  // 既存ソケットの状態や世代切替に関わらず、新ソケットの接続確立前は必ず未接続状態を通知する
  self.postMessage({ type: 'wsStatus', connected: false, wsGen });

  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  socket.binaryType = 'arraybuffer';
  ws = socket;

  socket.onopen = () => {
    if (socket !== ws || wsGen !== currentWsGen) return;
    reconnectAttempt = 0;
    self.postMessage({ type: 'wsStatus', connected: true, wsGen });
    // 切断後の自動再接続時は、切断中の差分欠落を防ぐためスナップショットを再取得する
    if (shouldResyncOnOpen && currentSnapshotUrl) {
      shouldResyncOnOpen = false;
      clearSnapshotRetryTimer();
      fetchSnapshotWithRetry(currentSnapshotUrl, currentBufferGen);
    }
    pingTimer = setInterval(() => {
      if (socket !== ws || wsGen !== currentWsGen || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(new Uint8Array([OP_CLIENT_PING]));
        if (pongTimer !== null) {
          clearTimeout(pongTimer);
        }
        // PING 送信後 10 秒以内に PONG が返らなければタイムアウトとして即座に切断・再接続
        pongTimer = setTimeout(() => {
          pongTimer = null;
          if (socket !== ws || wsGen !== currentWsGen) return;
          socket.onopen = null;
          socket.onmessage = null;
          socket.onerror = null;
          socket.onclose = null;
          ws = null;
          clearWsTimers();
          try {
            socket.close();
          } catch {
            // 無視
          }
          self.postMessage({ type: 'wsStatus', connected: false, wsGen });
          scheduleReconnect();
        }, 10000) as unknown as number;
      } catch {
        try {
          socket.close();
        } catch {
          // 無視
        }
      }
    }, 20000) as unknown as number;
  };

  socket.onmessage = (ev: MessageEvent) => {
    if (socket !== ws || wsGen !== currentWsGen) return;
    if (!(ev.data instanceof ArrayBuffer)) return;
    handleBinaryMessage(ev.data, wsGen);
  };

  socket.onclose = () => {
    if (socket !== ws || wsGen !== currentWsGen) return;
    ws = null;
    self.postMessage({ type: 'wsStatus', connected: false, wsGen });
    clearWsTimers();
    scheduleReconnect();
  };

  socket.onerror = () => {
    if (socket !== ws || wsGen !== currentWsGen) return;
    try {
      socket.close();
    } catch {
      // 無視
    }
  };
}

function handleBinaryMessage(buf: ArrayBuffer, wsGen: number = currentWsGen): void {
  const bytes = new Uint8Array(buf);
  if (bytes.length === 0) return;
  const view = new DataView(buf);
  const op = bytes[0];

  switch (op) {
    case OP_SERVER_CELL_DIFF: {
      if (!bufferReady || isFetchingSnapshot) {
        // スナップショット取得中または未反映の間に届いた差分は保留し、完了後にバージョン検証して適用する
        if (!pendingDiffOverflow) {
          if (
            pendingDiffsDuringSnapshot.length < MAX_PENDING_DIFF_COUNT &&
            pendingDiffBytes + buf.byteLength <= MAX_PENDING_DIFF_BYTES
          ) {
            pendingDiffsDuringSnapshot.push(buf);
            pendingDiffBytes += buf.byteLength;
          } else {
            pendingDiffOverflow = true;
          }
        }
        return;
      }
      if (bytes.length < CELL_DIFF_HEADER_BYTES) return;
      const boardVersion = view.getBigUint64(1, true);
      const count = view.getUint32(9, true);
      if (bytes.length < CELL_DIFF_HEADER_BYTES + count * 12) return;
      if (
        (snapshotFloorVersion !== null && boardVersion <= snapshotFloorVersion) ||
        (lastDiffVersion !== null && boardVersion < lastDiffVersion)
      ) {
        // スナップショット以前、または適用済み最新差分より古いバージョンのみ破棄する（同一バージョンの後続チャンクは許可）
        return;
      }
      const baseVer = lastDiffVersion ?? snapshotFloorVersion;
      if (baseVer !== null && boardVersion > baseVer + 1n) {
        // 差分バージョンの欠落（ギャップ）を検知したため適用せずスナップショットを再同期する
        bufferReady = false;
        lastDiffVersion = null;
        clearSnapshotRetryTimer();
        if (currentSnapshotUrl) {
          fetchSnapshotWithRetry(currentSnapshotUrl, currentBufferGen);
        }
        return;
      }

      let minX = boardSize;
      let minY = boardSize;
      let maxX = -1;
      let maxY = -1;
      let appliedCount = 0;
      let hasTerritoryLogChange = false;

      const patchBuf = !sabEnabled ? new ArrayBuffer(count * FALLBACK_PATCH_STRIDE) : null;
      const patchView = patchBuf ? new DataView(patchBuf) : null;
      const patchU8 = patchBuf ? new Uint8Array(patchBuf) : null;

      sabBeginWrite(ctrl);
      try {
        let offset = CELL_DIFF_HEADER_BYTES;
        for (let i = 0; i < count; i++) {
          const cellOffset = offset;
          offset += 12;
          const x = view.getUint16(cellOffset, true);
          const y = view.getUint16(cellOffset + 2, true);
          if (x >= boardSize || y >= boardSize) {
            continue;
          }
          const cellIdx = y * boardSize + x;
          const rawOff = cellIdx * CELL_BYTES;

          // 色変更(Recolor)のみの差分で不要な行動ログ再取得が走らないよう、勢力・層数・中核の変化を検出する
          if (!hasTerritoryLogChange) {
            const newLayers = bytes[cellOffset + 4 + 2];
            const newFlagsCore = bytes[cellOffset + 4 + 3] & 1;
            const newFacLo = bytes[cellOffset + 4 + 4];
            const newFacHi = bytes[cellOffset + 4 + 5];
            if (
              rawCells[rawOff + 2] !== newLayers ||
              (rawCells[rawOff + 3] & 1) !== newFlagsCore ||
              rawCells[rawOff + 4] !== newFacLo ||
              rawCells[rawOff + 5] !== newFacHi
            ) {
              hasTerritoryLogChange = true;
            }
          }

          for (let b = 0; b < CELL_BYTES; b++) {
            rawCells[rawOff + b] = bytes[cellOffset + 4 + b];
          }
          packCellToRgba8ui(rawCells, cellIdx, gpuTex);

          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;

          if (patchView && patchU8) {
            const pOff = appliedCount * FALLBACK_PATCH_STRIDE;
            patchView.setUint16(pOff, x, true);
            patchView.setUint16(pOff + 2, y, true);
            patchU8.set(rawCells.subarray(rawOff, rawOff + CELL_BYTES), pOff + 4);
            patchU8.set(gpuTex.subarray(cellIdx * 4, cellIdx * 4 + 4), pOff + 12);
          }
          appliedCount++;
        }
      } finally {
        sabEndWrite(ctrl);
      }

      lastDiffVersion = boardVersion;

      if (appliedCount > 0 && maxX >= minX && maxY >= minY) {
        if (sabEnabled) {
          self.postMessage({
            type: 'dirtyRect',
            boardSize,
            bufferGen: currentBufferGen,
            minX,
            minY,
            maxX,
            maxY,
            hasTerritoryLogChange,
          });
        } else if (patchBuf) {
          const transferBuf =
            appliedCount === count
              ? patchBuf
              : patchBuf.slice(0, appliedCount * FALLBACK_PATCH_STRIDE);
          self.postMessage(
            {
              type: 'dirtyRectFallback',
              boardSize,
              bufferGen: currentBufferGen,
              minX,
              minY,
              maxX,
              maxY,
              count: appliedCount,
              patchBytes: transferBuf,
              hasTerritoryLogChange,
            },
            [transferBuf]
          );
        }
      }
      break;
    }

    case OP_SERVER_ACTION_RESULT: {
      if (bytes.length < ACTION_RESULT_HEADER_BYTES) return;
      const status = bytes[1];
      const ap = view.getUint16(2, true);
      const targetFaction = view.getUint16(4, true);
      const costAp = view.getUint16(6, true);
      const msgLen = view.getUint16(8, true);
      if (bytes.length < ACTION_RESULT_HEADER_BYTES + msgLen) return;
      const message = decoder.decode(
        bytes.subarray(ACTION_RESULT_HEADER_BYTES, ACTION_RESULT_HEADER_BYTES + msgLen)
      );
      self.postMessage({
        type: 'actionResult',
        status,
        ap,
        targetFaction,
        costAp,
        message,
        wsGen,
      });
      break;
    }

    case OP_SERVER_TICK_SYNC: {
      if (bytes.length < 22) return;
      const phase = phaseFromCode(bytes[1]);
      const tickNumber = view.getUint16(2, true);
      const ap = view.getUint16(4, true);
      const nextTickUnix = Number(view.getBigInt64(6, true));
      const seasonId = Number(view.getBigInt64(14, true));
      self.postMessage({
        type: 'tickSync',
        phase,
        tickNumber,
        ap,
        nextTickUnix,
        seasonId,
        wsGen,
      });
      break;
    }

    case OP_SERVER_EVENT_JSON: {
      const text = decoder.decode(bytes.subarray(1));
      try {
        const event = JSON.parse(text);
        if (event && (event.type === 'map_regenerated' || event.type === 'season_reset')) {
          // 新盤面の差分が旧サイズバッファへ誤適用されるのを防ぎ、進行中の旧スナップショット取得・再試行も即座に中断する
          bufferReady = false;
          snapshotGen++;
          if (snapshotAbort) {
            snapshotAbort.abort();
            snapshotAbort = null;
          }
          clearSnapshotRetryTimer();
          pendingDiffsDuringSnapshot = [];
          pendingDiffBytes = 0;
          pendingDiffOverflow = false;
          snapshotFloorVersion = null;
          lastDiffVersion = null;
        }
        self.postMessage({ type: 'serverEvent', event, wsGen });
        if (event && event.type === 'resync_required' && currentSnapshotUrl) {
          clearSnapshotRetryTimer();
          fetchSnapshotWithRetry(currentSnapshotUrl, currentBufferGen);
        }
      } catch {
        // 不正JSONは無視
      }
      break;
    }

    case OP_SERVER_PONG:
      if (pongTimer !== null) {
        clearTimeout(pongTimer);
        pongTimer = null;
      }
      break;
  }
}

function bindBuffers(
  nextSize: number,
  useSab: boolean,
  rawBuf?: SharedArrayBuffer,
  gpuBuf?: SharedArrayBuffer,
  ctrlBuf?: SharedArrayBuffer
): boolean {
  clearSnapshotRetryTimer();
  snapshotRetryAttempt = 0;
  bufferReady = false;
  isFetchingSnapshot = false;
  snapshotFloorVersion = null;
  lastDiffVersion = null;
  pendingDiffsDuringSnapshot = [];
  pendingDiffBytes = 0;
  pendingDiffOverflow = false;

  if (!Number.isInteger(nextSize) || nextSize < 16 || nextSize > MAX_BOARD_SIZE) {
    self.postMessage({
      type: 'error',
      message: `不正な盤面バッファサイズです: ${String(nextSize)}`,
    });
    return false;
  }

  boardSize = nextSize;
  const total = boardSize * boardSize;
  const expectedRawBytes = total * CELL_BYTES;
  const expectedGpuBytes = total * 4;
  const hasValidSab =
    Boolean(useSab && rawBuf && gpuBuf) &&
    rawBuf!.byteLength >= expectedRawBytes &&
    gpuBuf!.byteLength >= expectedGpuBytes &&
    (!ctrlBuf || (ctrlBuf.byteLength >= 4 && ctrlBuf.byteLength % 4 === 0));

  if (useSab && rawBuf && gpuBuf && !hasValidSab) {
    self.postMessage({
      type: 'error',
      message: '共有バッファのバイト長が不足しているため非 SAB モードへフォールバックします',
    });
  }

  sabEnabled = hasValidSab;
  if (sabEnabled && rawBuf && gpuBuf) {
    rawCells = new Uint8Array(rawBuf);
    gpuTex = new Uint8Array(gpuBuf);
    ctrl = ctrlBuf ? new Int32Array(ctrlBuf) : undefined;
  } else {
    rawCells = new Uint8Array(expectedRawBytes);
    gpuTex = new Uint8Array(expectedGpuBytes);
    ctrl = undefined;
  }
  return true;
}

self.onmessage = (ev: MessageEvent<WorkerInbound>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': {
      currentSnapshotUrl = msg.snapshotUrl;
      currentWsUrl = msg.wsUrl;
      shouldResyncOnOpen = false;
      const initBufGen = msg.bufferGen ?? currentBufferGen + 1;
      currentBufferGen = initBufGen;
      const initWsGen = msg.wsGen ?? currentWsGen + 1;
      currentWsGen = initWsGen;
      if (
        !bindBuffers(
          msg.boardSize,
          msg.sabEnabled,
          msg.rawCellsBuffer,
          msg.gpuTexBuffer,
          msg.ctrlBuffer
        )
      ) {
        break;
      }
      // スナップショット取得と並行して WebSocket 接続を開始し、取得中の差分はキューへ保留する
      connectWs(msg.wsUrl, initWsGen);
      fetchSnapshotWithRetry(msg.snapshotUrl, initBufGen);
      break;
    }
    case 'resizeBuffers': {
      currentSnapshotUrl = msg.snapshotUrl;
      // 直後にスナップショットを取得するため、reconnect 由来の二重取得を防ぐ
      shouldResyncOnOpen = false;
      const nextBufGen = msg.bufferGen ?? currentBufferGen + 1;
      currentBufferGen = nextBufGen;
      if (
        !bindBuffers(
          msg.boardSize,
          msg.sabEnabled,
          msg.rawCellsBuffer,
          msg.gpuTexBuffer,
          msg.ctrlBuffer
        )
      ) {
        break;
      }
      // WS 接続済みの resizeBuffers で失敗した場合は自動リトライし、bufferReady=false 張り付きを防ぐ
      fetchSnapshotWithRetry(msg.snapshotUrl, nextBufGen);
      break;
    }
    case 'reconnect': {
      // 接続切り替え間のセル差分欠落を防ぐため常に再同期する
      shouldResyncOnOpen = true;
      const nextWsGen = msg.wsGen ?? currentWsGen + 1;
      currentWsGen = nextWsGen;
      connectWs(msg.wsUrl, nextWsGen);
      break;
    }
    case 'reloadSnapshot': {
      currentSnapshotUrl = msg.snapshotUrl;
      fetchSnapshotWithRetry(msg.snapshotUrl, currentBufferGen);
      break;
    }
    case 'sendAction': {
      if (msg.wsGen !== undefined && msg.wsGen !== currentWsGen) {
        self.postMessage({
          type: 'actionSendFailed',
          actionId: msg.actionId,
          wsGen: msg.wsGen,
          message: 'セッションが切り替わりました。再度お試しください',
        });
        break;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount > 1_048_576) {
          // ローカル送信失敗は actionResult ではなく専用イベントで通知し、先行リクエストのキュー整合性を保つ
          self.postMessage({
            type: 'actionSendFailed',
            actionId: msg.actionId,
            wsGen: currentWsGen,
            message: '送信バッファが混雑しています。少し待ってから再試行してください',
          });
          break;
        }
        try {
          ws.send(encodeClientAction(msg.x, msg.y, msg.mode, msg.colorId, msg.confirmWar));
        } catch (err) {
          self.postMessage({
            type: 'actionSendFailed',
            actionId: msg.actionId,
            wsGen: currentWsGen,
            message: `操作送信エラー: ${String(err)}`,
          });
        }
      } else {
        self.postMessage({
          type: 'actionSendFailed',
          actionId: msg.actionId,
          wsGen: currentWsGen,
          message: 'サーバーとの WebSocket 接続が確立されていません',
        });
      }
      break;
    }
  }
};
