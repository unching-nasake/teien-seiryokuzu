import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { PALETTE_RGB_FLOAT } from '../shared/protocol';
import { sabTrySnapshotRead } from '../shared/sab';

const MINIMAP_SIZE = 132;
// ミニマップ全体ピクセル再生成の最小間隔（ms）
const MINIMAP_REBUILD_INTERVAL_MS = 150;
// SeqLock 競合時の連続リトライ上限回数と最大バックオフ（ms）
const MAX_SEQ_CONFLICT_RETRIES = 8;
const MAX_SEQ_CONFLICT_DELAY_MS = 2000;

// 64色パレットを 0〜255 の整数 RGB テーブルへ事前変換
const PALETTE_RGB_U8 = (() => {
  const arr = new Uint8Array(64 * 3);
  for (let i = 0; i < 64; i++) {
    arr[i * 3 + 0] = Math.round(PALETTE_RGB_FLOAT[i * 3 + 0] * 255);
    arr[i * 3 + 1] = Math.round(PALETTE_RGB_FLOAT[i * 3 + 1] * 255);
    arr[i * 3 + 2] = Math.round(PALETTE_RGB_FLOAT[i * 3 + 2] * 255);
  }
  return arr;
})();

export interface MinimapProps {
  boardSize: number;
  getGpuTex: () => Uint8Array | null;
  getCtrl?: () => Int32Array | undefined;
  getViewport: () => { minX: number; minY: number; maxX: number; maxY: number } | null;
  onJumpTo: (bx: number, by: number) => void;
  subscribeBoardChange: (cb: () => void) => () => void;
}

/** 盤面全体を俯瞰し、現在表示範囲の確認とジャンプ操作を行うミニマップ */
export function Minimap(props: MinimapProps) {
  const { boardSize, getGpuTex, getCtrl, getViewport, onJumpTo, subscribeBoardChange } = props;

  // PC幅では展開、モバイル幅(<=768px)では折りたたみを初期状態とし、保存値があれば優先する
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('teien_minimap_collapsed');
      if (saved === '1') return true;
      if (saved === '0') return false;
    } catch {
      // ignore
    }
    return typeof window !== 'undefined' ? window.innerWidth <= 768 : false;
  });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseImageRef = useRef<ImageData | null>(null);
  const scratchImageRef = useRef<ImageData | null>(null);
  const lastVpRef = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const collapsedRef = useRef<boolean>(collapsed);
  collapsedRef.current = collapsed;
  const lastRebuildAtRef = useRef<number>(0);
  const rebuildTimerRef = useRef<number | null>(null);
  const rebuildRafRef = useRef<number | null>(null);
  const seqConflictCountRef = useRef<number>(0);
  const getGpuTexRef = useRef(getGpuTex);
  getGpuTexRef.current = getGpuTex;
  const getCtrlRef = useRef(getCtrl);
  getCtrlRef.current = getCtrl;
  const getViewportRef = useRef(getViewport);
  getViewportRef.current = getViewport;

  /** キャッシュ済みベース画像と現在ビューポート枠線をキャンバスへ描画 */
  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const base = baseImageRef.current;
    if (base) {
      ctx.putImageData(base, 0, 0);
    } else {
      ctx.fillStyle = '#122338';
      ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
    }

    const vp = getViewportRef.current();
    if (vp && boardSize > 0) {
      const scale = MINIMAP_SIZE / boardSize;
      const x = vp.minX * scale;
      const y = vp.minY * scale;
      const w = Math.max(2, (vp.maxX - vp.minX) * scale);
      const h = Math.max(2, (vp.maxY - vp.minY) * scale);

      ctx.strokeStyle = 'rgba(248, 250, 252, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, w, h);
    }
  }, [boardSize]);

  /** 予約済みのミニマップ再生成タイマーおよび rAF を解除 */
  const clearRebuildSchedule = useCallback(() => {
    if (rebuildTimerRef.current !== null) {
      window.clearTimeout(rebuildTimerRef.current);
      rebuildTimerRef.current = null;
    }
    if (rebuildRafRef.current !== null) {
      window.cancelAnimationFrame(rebuildRafRef.current);
      rebuildRafRef.current = null;
    }
  }, []);

  /** オフスクリーン ImageData の再生成をスロットル＋rAF で予約 */
  const scheduleRebuild = useCallback(
    (immediate = false, minDelayMs = 0) => {
      if (collapsedRef.current) return;
      if (rebuildTimerRef.current !== null || rebuildRafRef.current !== null) return;

      const runInRaf = () => {
        rebuildRafRef.current = window.requestAnimationFrame(() => {
          rebuildRafRef.current = null;
          if (collapsedRef.current) return;

          const gpuTex = getGpuTexRef.current();
          if (!gpuTex || boardSize <= 0 || gpuTex.byteLength < boardSize * boardSize * 4) {
            baseImageRef.current = null;
            drawFrame();
            return;
          }

          const img = scratchImageRef.current ?? new ImageData(MINIMAP_SIZE, MINIMAP_SIZE);
          scratchImageRef.current = img;
          const data = img.data;
          const ctrl = getCtrlRef.current?.();

          // SAB 有効時は非ブロッキングで少数回のみ SeqLock 読み取りを試行し、競合時はスロットル／バックオフ付きで再試行する
          const res = sabTrySnapshotRead(
            ctrl,
            () => {
              for (let py = 0; py < MINIMAP_SIZE; py++) {
                const by = Math.floor((py / MINIMAP_SIZE) * boardSize);
                const rowOffset = by * boardSize;
                for (let px = 0; px < MINIMAP_SIZE; px++) {
                  const bx = Math.floor((px / MINIMAP_SIZE) * boardSize);
                  const off = (rowOffset + bx) * 4;

                  const r = gpuTex[off];
                  const colorId = r & 0x3f;
                  const terrain = (r >> 6) & 1;
                  const facLo = gpuTex[off + 2];
                  const facHi = gpuTex[off + 3];
                  const fid = facLo | (facHi << 8);

                  const dst = (py * MINIMAP_SIZE + px) * 4;
                  if (terrain === 0) {
                    // 海色 #122338
                    data[dst + 0] = 18;
                    data[dst + 1] = 35;
                    data[dst + 2] = 56;
                  } else if (fid === 0) {
                    // 空き陸地色
                    data[dst + 0] = 203;
                    data[dst + 1] = 184;
                    data[dst + 2] = 148;
                  } else {
                    // 勢力所有マス色
                    const pOff = colorId * 3;
                    data[dst + 0] = PALETTE_RGB_U8[pOff + 0];
                    data[dst + 1] = PALETTE_RGB_U8[pOff + 1];
                    data[dst + 2] = PALETTE_RGB_U8[pOff + 2];
                  }
                  data[dst + 3] = 255;
                }
              }
            },
            2
          );

          if (!res.ok) {
            // 書き込みと競合したため既存キャッシュを保持し、現在時刻を更新した上でスロットル＋バックオフ再試行
            lastRebuildAtRef.current = performance.now();
            const failures = ++seqConflictCountRef.current;
            if (failures <= MAX_SEQ_CONFLICT_RETRIES) {
              const retryDelay = Math.min(
                MAX_SEQ_CONFLICT_DELAY_MS,
                MINIMAP_REBUILD_INTERVAL_MS * Math.pow(2, failures - 1)
              );
              scheduleRebuild(false, retryDelay);
            }
            return;
          }

          seqConflictCountRef.current = 0;
          scratchImageRef.current = baseImageRef.current;
          baseImageRef.current = img;
          lastRebuildAtRef.current = performance.now();
          drawFrame();
        });
      };

      const elapsed = performance.now() - lastRebuildAtRef.current;
      if (minDelayMs > 0) {
        const wait = Math.max(minDelayMs, MINIMAP_REBUILD_INTERVAL_MS - elapsed);
        rebuildTimerRef.current = window.setTimeout(() => {
          rebuildTimerRef.current = null;
          if (!collapsedRef.current) {
            runInRaf();
          }
        }, wait);
      } else if (immediate || baseImageRef.current === null || elapsed >= MINIMAP_REBUILD_INTERVAL_MS) {
        runInRaf();
      } else {
        const wait = Math.max(0, MINIMAP_REBUILD_INTERVAL_MS - elapsed);
        rebuildTimerRef.current = window.setTimeout(() => {
          rebuildTimerRef.current = null;
          if (!collapsedRef.current) {
            runInRaf();
          }
        }, wait);
      }
    },
    [boardSize, drawFrame]
  );

  // 展開状態・盤面サイズ変化時およびアンマウント時の初期化とクリーンアップ
  useEffect(() => {
    clearRebuildSchedule();
    seqConflictCountRef.current = 0;
    if (collapsed) {
      activePointerIdRef.current = null;
      return;
    }
    lastVpRef.current = null;
    lastRebuildAtRef.current = 0;
    scheduleRebuild(true);
    return () => {
      clearRebuildSchedule();
      activePointerIdRef.current = null;
    };
  }, [collapsed, boardSize, clearRebuildSchedule, scheduleRebuild]);

  // 盤面差分通知時は再レンダリングを伴わずスロットル付きでミニマップ再生成を予約
  useEffect(() => {
    return subscribeBoardChange(() => {
      if (collapsedRef.current) return;
      seqConflictCountRef.current = 0;
      scheduleRebuild(false);
    });
  }, [subscribeBoardChange, scheduleRebuild]);

  // 展開中のみ 100ms 間隔でビューポート変化時だけ枠線を再描画する
  useEffect(() => {
    if (collapsed) return;
    lastVpRef.current = getViewportRef.current();
    drawFrame();
    const timer = window.setInterval(() => {
      const vp = getViewportRef.current();
      const prev = lastVpRef.current;
      if (
        vp &&
        prev &&
        Math.abs(vp.minX - prev.minX) < 0.01 &&
        Math.abs(vp.minY - prev.minY) < 0.01 &&
        Math.abs(vp.maxX - prev.maxX) < 0.01 &&
        Math.abs(vp.maxY - prev.maxY) < 0.01
      ) {
        return;
      }
      lastVpRef.current = vp ? { ...vp } : null;
      drawFrame();
    }, 100);
    return () => window.clearInterval(timer);
  }, [collapsed, drawFrame]);

  const jumpFromPointer = (e: PointerEvent & { currentTarget: HTMLCanvasElement }) => {
    if (boardSize <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const ny = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    onJumpTo(nx * boardSize, ny * boardSize);
  };

  const handlePointerDown = (e: PointerEvent & { currentTarget: HTMLCanvasElement }) => {
    // マウス操作時は主ボタン（左クリック）のみを受け付ける
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // すでに別のポインターでドラッグ中ならマルチタッチ混線を防ぐため無視
    if (activePointerIdRef.current !== null && activePointerIdRef.current !== e.pointerId) return;

    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
      // キャプチャに成功した場合のみドラッグ追跡状態へ移行
      activePointerIdRef.current = e.pointerId;
    } catch {
      // キャプチャ失敗時は張り付き防止のためドラッグ状態へ移行せず単発ジャンプのみ実行
    }
    jumpFromPointer(e);
  };

  const handlePointerMove = (e: PointerEvent & { currentTarget: HTMLCanvasElement }) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    if (e.pointerType === 'mouse' && (e.buttons & 1) === 0) {
      activePointerIdRef.current = null;
      return;
    }
    jumpFromPointer(e);
  };

  const handlePointerEnd = (e: PointerEvent & { currentTarget: HTMLCanvasElement }) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    activePointerIdRef.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // 既にキャプチャが解放されている場合等の例外は無視
    }
  };

  return (
    <div class={`minimap-wrap${collapsed ? ' collapsed' : ''}`}>
      <div class="minimap-header">
        <span>全体図</span>
        <button
          type="button"
          class="btn btn-sm"
          aria-label={collapsed ? '全体図を展開' : '全体図を折りたたむ'}
          aria-expanded={!collapsed}
          onClick={() =>
            setCollapsed((v) => {
              const next = !v;
              try {
                localStorage.setItem('teien_minimap_collapsed', next ? '1' : '0');
              } catch {
                // ignore
              }
              return next;
            })
          }
        >
          {collapsed ? '▲' : '▼'}
        </button>
      </div>
      {!collapsed && (
        <canvas
          ref={canvasRef}
          class="minimap-canvas"
          width={MINIMAP_SIZE}
          height={MINIMAP_SIZE}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onLostPointerCapture={handlePointerEnd}
        />
      )}
    </div>
  );
}
