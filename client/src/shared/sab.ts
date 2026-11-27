import { CELL_BYTES } from './protocol';

/** 許容する盤面一辺の最大サイズ */
export const MAX_BOARD_SIZE = 2048;

/** SeqLock 制御ワードのオフセット (Int32Array インデックス) */
export const CTRL_SEQ = 0;

export interface SharedBoardBuffers {
  /** 盤面の一辺サイズ */
  boardSize: number;
  /** SharedArrayBuffer によるゼロコピー共有が有効か */
  sabEnabled: boolean;
  /** boardSize^2 × 8B の生盤面バッファ */
  rawCellsBuffer: SharedArrayBuffer | ArrayBuffer;
  /** boardSize^2 × 4B の WebGL2 RGBA8UI テクスチャ用バッファ */
  gpuTexBuffer: SharedArrayBuffer | ArrayBuffer;
  /** SeqLock 同期用の共有制御バッファ (16B, SAB 有効時のみ) */
  ctrlBuffer?: SharedArrayBuffer;
  rawCells: Uint8Array;
  gpuTex: Uint8Array;
  ctrl?: Int32Array;
}

/** SeqLock 書き込み開始（奇数へ遷移） */
export function sabBeginWrite(ctrl?: Int32Array): void {
  if (ctrl) Atomics.add(ctrl, CTRL_SEQ, 1);
}

/** SeqLock 書き込み終了（偶数へ遷移） */
export function sabEndWrite(ctrl?: Int32Array): void {
  if (ctrl) Atomics.add(ctrl, CTRL_SEQ, 1);
}

/** SeqLock の現在シーケンス番号を読み取る（軽量ロード） */
export function sabLoadSeq(ctrl?: Int32Array): number {
  return ctrl ? Atomics.load(ctrl, CTRL_SEQ) : 0;
}

/** SeqLock の現在シーケンス番号を読み取る（弱順序 CPU 向けの終端フェンス兼用） */
export function sabReadSeq(ctrl?: Int32Array): number {
  return ctrl ? Atomics.add(ctrl, CTRL_SEQ, 0) : 0;
}

/** SeqLock リトライ付きスナップショット読み取り（失敗時は ok: false を返す） */
export function sabTrySnapshotRead<T>(
  ctrl: Int32Array | undefined,
  reader: () => T,
  maxRetries = 32
): { ok: true; value: T } | { ok: false } {
  if (!ctrl) return { ok: true, value: reader() };
  const retries = Number.isFinite(maxRetries) ? Math.max(1, Math.floor(maxRetries)) : 32;
  for (let i = 0; i < retries; i++) {
    let seq1 = Atomics.load(ctrl, CTRL_SEQ);
    if ((seq1 & 1) !== 0) {
      // 書き込み中（奇数）の間は軽量スピンで偶数になるのを待つ
      for (let spin = 0; spin < 1024 && (seq1 & 1) !== 0; spin++) {
        seq1 = Atomics.load(ctrl, CTRL_SEQ);
      }
      if ((seq1 & 1) !== 0) continue;
    }
    const value = reader();
    // ARM64 等の弱順序 CPU で先行ロードが seq2 より後方へリオーダリングされるのを防ぐため RMW フェンスを使用
    const seq2 = Atomics.add(ctrl, CTRL_SEQ, 0);
    if (seq1 === seq2) return { ok: true, value };
  }
  return { ok: false };
}

/** SeqLock リトライ付きスナップショット読み取り（失敗時は undefined を返す） */
export function sabSnapshotRead<T>(
  ctrl: Int32Array | undefined,
  reader: () => T,
  maxRetries = 32
): T | undefined {
  const res = sabTrySnapshotRead(ctrl, reader, maxRetries);
  return res.ok ? res.value : undefined;
}

/** COOP/COEP 有効環境では SharedArrayBuffer を、非対応環境では ArrayBuffer フォールバックを確保 */
export function createBoardBuffers(boardSize: number): SharedBoardBuffers {
  if (
    !Number.isFinite(boardSize) ||
    !Number.isInteger(boardSize) ||
    boardSize < 1 ||
    boardSize > MAX_BOARD_SIZE
  ) {
    throw new RangeError(
      `不正な盤面サイズです: ${boardSize}（1〜${MAX_BOARD_SIZE} の整数である必要があります）`
    );
  }
  const sabEnabled =
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof self !== 'undefined' &&
    Boolean((self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated);

  const total = boardSize * boardSize;
  const rawSize = total * CELL_BYTES;
  const gpuSize = total * 4;

  const rawCellsBuffer = sabEnabled ? new SharedArrayBuffer(rawSize) : new ArrayBuffer(rawSize);
  const gpuTexBuffer = sabEnabled ? new SharedArrayBuffer(gpuSize) : new ArrayBuffer(gpuSize);
  const ctrlBuffer = sabEnabled ? new SharedArrayBuffer(16) : undefined;

  return {
    boardSize,
    sabEnabled,
    rawCellsBuffer,
    gpuTexBuffer,
    ctrlBuffer,
    rawCells: new Uint8Array(rawCellsBuffer),
    gpuTex: new Uint8Array(gpuTexBuffer),
    ctrl: ctrlBuffer ? new Int32Array(ctrlBuffer) : undefined,
  };
}
