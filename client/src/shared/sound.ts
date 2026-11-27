const SOUND_MUTED_KEY = 'teien_sound_muted';

let audioCtx: AudioContext | null = null;
let mutedCache: boolean | null = null;

/** AudioContext を遅延初期化する */
function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (audioCtx && audioCtx.state === 'closed') {
    audioCtx = null;
  }
  if (!audioCtx) {
    try {
      audioCtx = new Ctor();
    } catch {
      return null;
    }
  }
  return audioCtx;
}

function isResumableState(ctx: AudioContext): boolean {
  const state = ctx.state as AudioContextState | 'interrupted';
  return state === 'suspended' || state === 'interrupted';
}

/** サウンドのミュート状態を取得する */
export function isSoundMuted(): boolean {
  if (mutedCache !== null) return mutedCache;
  try {
    mutedCache = localStorage.getItem(SOUND_MUTED_KEY) === '1';
  } catch {
    mutedCache = false;
  }
  return mutedCache;
}

/** サウンドのミュート状態を設定し保存する */
export function setSoundMuted(muted: boolean): void {
  mutedCache = muted;
  try {
    if (muted) {
      localStorage.setItem(SOUND_MUTED_KEY, '1');
    } else {
      localStorage.removeItem(SOUND_MUTED_KEY);
    }
  } catch {
    // ストレージアクセス不可環境では無視
  }
}

/** ユーザー操作イベント内で AudioContext を事前復帰させる */
export function unlockAudio(): void {
  if (isSoundMuted()) return;
  try {
    const ctx = getAudioContext();
    if (ctx && isResumableState(ctx)) {
      void ctx.resume().catch(() => {});
    }
  } catch {
    // 無視
  }
}

/** AudioContext が running になった後に実際のオシレータを発音する */
function scheduleToneOnRunningContext(
  ctx: AudioContext,
  freq: number,
  durationSec: number,
  type: OscillatorType,
  gainPeak: number,
  delaySec: number,
  endFreq?: number
): void {
  const start = ctx.currentTime + delaySec;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (endFreq !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), start + durationSec);
  }

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(gainPeak, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + durationSec);

  osc.connect(gain);
  gain.connect(ctx.destination);
  // 再生終了時にノードを確実に切断してリソースリークを防ぐ
  osc.onended = () => {
    try {
      osc.disconnect();
      gain.disconnect();
    } catch {
      // 既に切断済みの場合は無視
    }
  };
  osc.start(start);
  osc.stop(start + durationSec + 0.01);
}

/** 指定の周波数・波形で短いトーンを再生する */
function playTone(
  freq: number,
  durationSec: number,
  type: OscillatorType = 'sine',
  gainPeak = 0.08,
  delaySec = 0,
  endFreq?: number
): void {
  if (isSoundMuted()) return;

  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    if (ctx.state === 'running') {
      scheduleToneOnRunningContext(ctx, freq, durationSec, type, gainPeak, delaySec, endFreq);
      return;
    }

    if (isResumableState(ctx)) {
      // 自動再生制限直後の初回クリックでも復帰できたら直ちに発音する（遅延しすぎた場合は破棄）
      const requestedAt = performance.now();
      void ctx
        .resume()
        .then(() => {
          if (isSoundMuted()) return;
          if (ctx.state === 'running' && performance.now() - requestedAt <= 180) {
            scheduleToneOnRunningContext(ctx, freq, durationSec, type, gainPeak, delaySec, endFreq);
          }
        })
        .catch(() => {});
    }
  } catch {
    // 自動再生制限などで失敗した場合は無視
  }
}

/** セル選択時の軽いタップ音 */
export function playSelectSound(): void {
  playTone(540, 0.045, 'triangle', 0.05, 0, 680);
}

/** 領土塗り・強化成功時の軽快な2音 */
export function playPaintSound(): void {
  playTone(523.25, 0.06, 'sine', 0.07, 0); // C5
  playTone(783.99, 0.09, 'sine', 0.07, 0.045); // G5
}

/** 色変更成功時の柔らかな音 */
export function playRecolorSound(): void {
  playTone(659.25, 0.07, 'triangle', 0.06, 0, 880);
}

/** エラー・AP不足時の短い警告音 */
export function playErrorSound(): void {
  playTone(220, 0.08, 'sawtooth', 0.045, 0, 170);
  playTone(170, 0.11, 'sawtooth', 0.04, 0.075, 130);
}

/** 宣戦布告や停戦成立などの通知音 */
export function playNoticeSound(): void {
  playTone(440, 0.08, 'triangle', 0.06, 0);
  playTone(587.33, 0.12, 'triangle', 0.06, 0.07);
}
