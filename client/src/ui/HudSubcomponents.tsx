import { ComponentType } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  ActionMode,
  DiplomacyState,
  FactionSummary,
  HoverInfo,
  NotificationItem,
  PALETTE_HEX,
  SeasonPhase,
  SeasonStatus,
  UserProfile,
} from '../shared/protocol';

// ============================================================
// 動的インポート（コード分割）ラッパー
// ============================================================

let adminPageCache: ComponentType<{ onBackToMap: () => void }> | null = null;
export function LazyAdminPage({ onBackToMap }: { onBackToMap: () => void }) {
  const [Comp, setComp] = useState<ComponentType<{ onBackToMap: () => void }> | null>(
    () => adminPageCache
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrySeq, setRetrySeq] = useState(0);

  useEffect(() => {
    if (Comp || loadError) return;
    let alive = true;
    void import('./AdminPage')
      .then((m) => {
        adminPageCache = m.AdminPage;
        if (alive) setComp(() => m.AdminPage);
      })
      .catch(() => {
        if (alive) setLoadError('管理画面の読み込みに失敗しました。通信状況を確認してください。');
      });
    return () => {
      alive = false;
    };
  }, [Comp, loadError, retrySeq]);

  if (loadError) {
    return (
      <div class="admin-shell">
        <div class="admin-login-card" style={{ textAlign: 'center' }}>
          <p style={{ marginBottom: '12px', color: '#fca5a5' }}>{loadError}</p>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
            <button
              type="button"
              class="btn btn-primary"
              onClick={() => {
                setLoadError(null);
                setRetrySeq((n) => n + 1);
              }}
            >
              再試行
            </button>
            <button type="button" class="btn" onClick={onBackToMap}>
              マップへ戻る
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!Comp) {
    return (
      <div class="admin-shell">
        <div class="admin-login-card" style={{ textAlign: 'center' }}>
          <span>管理画面を読み込み中...</span>
        </div>
      </div>
    );
  }
  return <Comp onBackToMap={onBackToMap} />;
}

export interface LazyDebugPanelProps {
  currentUser: UserProfile | null;
  currentPhase: SeasonPhase;
  devMode?: boolean;
  maxAp?: number;
  wsConnected?: boolean;
  onSwitchUser: (nextUser: UserProfile) => void;
  onRefresh: () => Promise<void>;
  onDisableMode: () => void;
  onOpenAdmin: () => void;
  onToast: (msg: string, kind?: 'info' | 'success' | 'error' | 'war') => void;
}

let debugPanelCache: ComponentType<LazyDebugPanelProps> | null = null;
export function LazyDebugPanel(props: LazyDebugPanelProps) {
  const [Comp, setComp] = useState<ComponentType<LazyDebugPanelProps> | null>(
    () => debugPanelCache
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrySeq, setRetrySeq] = useState(0);
  const onToastRef = useRef(props.onToast);
  onToastRef.current = props.onToast;

  useEffect(() => {
    if (Comp || loadError) return;
    let alive = true;
    void import('./DebugPanel')
      .then((m) => {
        debugPanelCache = m.DebugPanel;
        if (alive) setComp(() => m.DebugPanel);
      })
      .catch(() => {
        if (alive) {
          setLoadError('デバッグパネルの読み込みに失敗しました。通信状況を確認してください。');
          onToastRef.current('デバッグパネルの読み込みに失敗しました', 'error');
        }
      });
    return () => {
      alive = false;
    };
  }, [Comp, loadError, retrySeq]);

  if (loadError) {
    return (
      <aside class="debug-panel">
        <div class="debug-panel-header">
          <span class="debug-badge">管理者デバッグ</span>
          <button
            type="button"
            class="btn btn-sm"
            onClick={props.onDisableMode}
            title="パネル表示モードを終了"
          >
            終了
          </button>
        </div>
        <p style={{ margin: '8px 0 10px', fontSize: '12px', color: '#fca5a5' }}>{loadError}</p>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            onClick={() => {
              setLoadError(null);
              setRetrySeq((n) => n + 1);
            }}
          >
            再試行
          </button>
          <button type="button" class="btn btn-sm" onClick={props.onDisableMode}>
            終了
          </button>
        </div>
      </aside>
    );
  }

  if (!Comp) return null;
  return <Comp {...props} />;
}

export interface LazyFactionModalProps {
  user: UserProfile | null;
  factions: FactionSummary[];
  phase: SeasonPhase;
  refreshSeq: number;
  maxNameLen: number;
  initialCoreQuota: number;
  enclaveBaseMultiplier?: number;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onJoinRequestResolved?: (applicantUserId: number) => void;
  onToast: (msg: string, kind?: 'info' | 'success' | 'error' | 'war') => void;
}

let factionModalCache: ComponentType<LazyFactionModalProps> | null = null;
export function LazyFactionModal(props: LazyFactionModalProps) {
  const [Comp, setComp] = useState<ComponentType<LazyFactionModalProps> | null>(
    () => factionModalCache
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrySeq, setRetrySeq] = useState(0);

  useEffect(() => {
    if (Comp || loadError) return;
    let alive = true;
    void import('./FactionModal')
      .then((m) => {
        factionModalCache = m.FactionModal;
        if (alive) setComp(() => m.FactionModal);
      })
      .catch(() => {
        if (alive) setLoadError('勢力モーダルの読み込みに失敗しました。');
      });
    return () => {
      alive = false;
    };
  }, [Comp, loadError, retrySeq]);

  if (loadError) {
    return (
      <div
        class="modal-backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose();
        }}
      >
        <div class="modal-card" style={{ textAlign: 'center', padding: '24px' }}>
          <p style={{ marginBottom: '14px', color: '#fca5a5' }}>{loadError}</p>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
            <button
              type="button"
              class="btn btn-primary"
              onClick={() => {
                setLoadError(null);
                setRetrySeq((n) => n + 1);
              }}
            >
              再試行
            </button>
            <button type="button" class="btn" onClick={props.onClose}>
              閉じる
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!Comp) {
    return (
      <div
        class="modal-backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose();
        }}
      >
        <div class="modal-card" style={{ textAlign: 'center', padding: '24px' }}>
          <div style={{ marginBottom: '12px' }}>読み込み中...</div>
          <button type="button" class="btn btn-sm" onClick={props.onClose}>
            閉じる
          </button>
        </div>
      </div>
    );
  }
  return <Comp {...props} />;
}

type ModalsModule = typeof import('./Modals');
let modalsModuleCache: ModalsModule | null = null;

export function useModalsModule(enabled: boolean): {
  mod: ModalsModule | null;
  error: string | null;
  retry: () => void;
} {
  const [mod, setMod] = useState<ModalsModule | null>(() => modalsModuleCache);
  const [error, setError] = useState<string | null>(null);
  const [retrySeq, setRetrySeq] = useState(0);

  useEffect(() => {
    if (!enabled) {
      // 次回モーダルを開いたときに再取得できるようエラーをクリアする
      setError(null);
      return;
    }
    if (mod || error) return;
    let alive = true;
    void import('./Modals')
      .then((m) => {
        modalsModuleCache = m;
        if (alive) {
          setError(null);
          setMod(m);
        }
      })
      .catch(() => {
        if (alive) setError('モーダルの読み込みに失敗しました。通信状況を確認してください。');
      });
    return () => {
      alive = false;
    };
  }, [enabled, mod, error, retrySeq]);

  const retry = () => {
    setError(null);
    setRetrySeq((n) => n + 1);
  };

  return { mod, error, retry };
}

// ============================================================
// 高頻度更新を分離するサブコンポーネント
// ============================================================

// PC 用・モバイル用の複数 TickCountdown 間で 1 秒タイマーを共有する
const tickCountdownListeners = new Set<() => void>();
let tickCountdownIntervalId: number | null = null;

function subscribeTickCountdown(listener: () => void): () => void {
  tickCountdownListeners.add(listener);
  if (tickCountdownIntervalId === null) {
    tickCountdownIntervalId = window.setInterval(() => {
      for (const fn of tickCountdownListeners) {
        fn();
      }
    }, 1000);
  }
  return () => {
    tickCountdownListeners.delete(listener);
    if (tickCountdownListeners.size === 0 && tickCountdownIntervalId !== null) {
      window.clearInterval(tickCountdownIntervalId);
      tickCountdownIntervalId = null;
    }
  };
}

/** 毎秒更新の AP 補充カウントダウンを単独で再レンダリングする */
export function TickCountdown({
  phase,
  nextTickUnix,
  prefix,
  onResyncNeeded,
}: {
  phase: SeasonPhase;
  nextTickUnix: number;
  prefix: string;
  onResyncNeeded?: () => void;
}) {
  const [countdown, setCountdown] = useState('--:--');

  useEffect(() => {
    if (phase !== 'active') {
      setCountdown('--:--');
      return;
    }
    let zeroSince: number | null = null;
    let resynced = false;
    const update = () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const diff = Math.max(0, nextTickUnix - nowSec);
      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const s = diff % 60;
      setCountdown(
        h > 0
          ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
          : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      );
      if (diff === 0) {
        if (zeroSince === null) {
          zeroSince = nowSec;
        } else if (onResyncNeeded && !resynced && nowSec - zeroSince >= 5) {
          resynced = true;
          onResyncNeeded();
        }
      } else {
        zeroSince = null;
        resynced = false;
      }
    };
    update();
    return subscribeTickCountdown(update);
  }, [phase, nextTickUnix, onResyncNeeded]);

  if (phase !== 'active') return null;
  return (
    <>
      {prefix}
      {countdown}
    </>
  );
}

/** ホバー/選択セル情報から「塗る/重ね塗り/奪う」ボタンのラベルとトーンを算出 */
export function computePaintButtonInfo(
  actionMode: ActionMode,
  activeInfo: HoverInfo | null,
  availableAp: number,
  phase: SeasonPhase,
  user: UserProfile | null
): { label: string; tone: string } {
  if (actionMode !== 0) {
    return { label: '塗る', tone: '' };
  }
  if (!activeInfo || activeInfo.terrain !== 1 || phase !== 'active' || !user || user.faction_id <= 0) {
    return { label: '塗る', tone: 'active' };
  }
  const insufficientAp = activeInfo.costAp > availableAp;
  if (activeInfo.factionId === 0) {
    return { label: '塗る', tone: insufficientAp ? 'mode-btn-disabled' : 'active' };
  }
  if (activeInfo.factionId === user.faction_id) {
    if (!activeInfo.canExecute) {
      return { label: '上限', tone: 'mode-btn-disabled' };
    }
    return { label: '重ね塗り', tone: insufficientAp ? 'mode-btn-disabled' : 'mode-btn-reinforce' };
  }
  if (!activeInfo.canExecute) {
    return { label: '奪取不可', tone: 'mode-btn-disabled' };
  }
  if (activeInfo.needsWarConfirm) {
    return { label: '開戦して奪う', tone: insufficientAp ? 'mode-btn-disabled' : 'mode-btn-war' };
  }
  return {
    label: '奪う',
    tone: insufficientAp ? 'mode-btn-disabled' : 'mode-btn-attack',
  };
}

/** セル情報インスペクタ（ホバー更新を単独購読し GameView 全体の再レンダリングを防止） */
export function HoverInspectorPanel({
  subscribeInspect,
  getActiveInfo,
  selectedCell,
  factionMap,
  user,
  season,
  actionMode,
  availableAp,
  maxLayers,
  assimilationReq,
  tickUnit,
  tickShortUnit,
  enemyCoreMult,
  onCopyCoordLink,
  onClearSelection,
  onTogglePinFaction,
  onExecuteSelected,
}: {
  subscribeInspect: (cb: () => void) => () => void;
  getActiveInfo: () => HoverInfo | null;
  selectedCell: { x: number; y: number } | null;
  factionMap: Map<number, FactionSummary>;
  user: UserProfile | null;
  season: SeasonStatus;
  actionMode: ActionMode;
  availableAp: number;
  maxLayers: number;
  assimilationReq: number;
  tickUnit: string;
  tickShortUnit: string;
  enemyCoreMult: number;
  onCopyCoordLink: (x: number, y: number) => void;
  onClearSelection: () => void;
  onTogglePinFaction: (fid: number) => void;
  onExecuteSelected: (x: number, y: number, info: HoverInfo | null) => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    return subscribeInspect(() => setTick((t) => t + 1));
  }, [subscribeInspect]);

  const activeInfo = getActiveInfo();
  const hoverFaction =
    activeInfo && activeInfo.factionId > 0 ? factionMap.get(activeInfo.factionId) : undefined;
  const hoverOldCoreFaction =
    activeInfo && activeInfo.oldCoreFaction > 0
      ? factionMap.get(activeInfo.oldCoreFaction)
      : undefined;
  const paintButtonInfo = computePaintButtonInfo(
    actionMode,
    activeInfo,
    availableAp,
    season.phase,
    user
  );

  return (
    <aside
      class={`hover-panel ${selectedCell ? 'has-selection' : ''} ${!activeInfo ? 'compact-idle' : ''}`}
    >
      <div class="hover-header">
        <span>
          {selectedCell ? '選択中マス' : 'セル情報'}{' '}
          {activeInfo ? (
            <button
              type="button"
              class="coord-copy-btn"
              title="座標リンクをコピー"
              onClick={() => onCopyCoordLink(activeInfo.x, activeInfo.y)}
            >
              ({activeInfo.x}, {activeInfo.y})
            </button>
          ) : (
            '(--, --)'
          )}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {activeInfo ? (activeInfo.terrain === 1 ? '陸地' : '海域') : ''}
          </span>
          {selectedCell && (
            <button
              class="btn btn-sm"
              style={{ padding: '1px 6px' }}
              title="マス選択を解除"
              onClick={onClearSelection}
            >
              ×
            </button>
          )}
        </span>
      </div>

      {activeInfo && activeInfo.terrain === 1 && (
        <>
          <div class="hover-row">
            <span>所有勢力</span>
            <strong>
              {hoverFaction ? (
                <button
                  type="button"
                  class="faction-link-btn"
                  title="クリックでマップ上のこの勢力領土を点滅ハイライト固定"
                  onClick={() => onTogglePinFaction(hoverFaction.id)}
                >
                  <span
                    class="color-dot"
                    style={{ background: PALETTE_HEX[hoverFaction.color_id] }}
                  />
                  {hoverFaction.name}
                </button>
              ) : activeInfo.factionId > 0 ? (
                `勢力 #${activeInfo.factionId}`
              ) : (
                '空き地（中立）'
              )}
            </strong>
          </div>

          {activeInfo.factionId > 0 && (
            <div
              class="hover-row"
              title="重ね塗り層数が多いほど相手が奪うときの消費APが増えます"
            >
              <span>重ね塗り / 表示色</span>
              <strong>
                {activeInfo.layers} / {maxLayers} 層{' '}
                <span
                  class="color-dot"
                  style={{
                    background: PALETTE_HEX[activeInfo.colorId],
                    marginLeft: '4px',
                  }}
                />
              </strong>
            </div>
          )}

          {activeInfo.assimilationTicks > 0 && !activeInfo.isCore && (
            <div
              class="hover-row"
              title={`自勢力の中核に隣接したまま ${assimilationReq}${tickUnit}維持すると自動で中核になります`}
            >
              <span>自然中核化</span>
              <strong style={{ color: '#67e8f9' }}>
                {activeInfo.assimilationTicks} / {assimilationReq}
                {tickUnit}
              </strong>
            </div>
          )}

          {activeInfo.oldCoreTtl > 0 && hoverOldCoreFaction && (
            <div
              class="hover-row"
              title="この残り時間内に元の勢力が奪還すると即座に中核として復活します"
            >
              <span>旧中核履歴</span>
              <strong style={{ color: '#d8b4fe' }}>
                {hoverOldCoreFaction.name} (残 {activeInfo.oldCoreTtl}
                {tickShortUnit})
              </strong>
            </div>
          )}

          <div class="badge-list">
            {activeInfo.isCore && (
              <span
                class="mini-badge badge-core"
                title={`相手がこのマスを奪う際に必要なAPが${enemyCoreMult}倍になります`}
              >
                中核ドット (×{enemyCoreMult})
              </span>
            )}
            {activeInfo.isEnclave && (
              <span
                class="mini-badge badge-enclave"
                title="自勢力に隣接していないため距離に応じた飛び地倍率が掛かります"
              >
                飛び地
                {activeInfo.enclaveDistance > 0 ? ` (距離 ${activeInfo.enclaveDistance}マス)` : ''}
              </span>
            )}
            {activeInfo.needsWarConfirm && (
              <span
                class="mini-badge badge-war"
                title="非戦争勢力の領土です。実行すると開戦確認が表示されます"
              >
                要開戦確認
              </span>
            )}
          </div>

          <div class="hover-action-box">
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
              <span>{activeInfo.actionLabel}</span>
              {activeInfo.canExecute && activeInfo.costAp > 0 && (
                <span
                  style={{
                    color:
                      actionMode === 0 && activeInfo.costAp > availableAp ? '#fca5a5' : '#fde047',
                  }}
                >
                  {actionMode === 0 && activeInfo.costAp > availableAp
                    ? `不足 (${activeInfo.costAp} AP)`
                    : `消費 ${activeInfo.costAp} AP`}
                </span>
              )}
            </div>
            {activeInfo.blockedReason && (
              <div style={{ color: '#fca5a5', fontSize: '11px', marginTop: '2px' }}>
                {activeInfo.blockedReason}
              </div>
            )}
            {selectedCell && (() => {
              const canJoinFromSelected =
                Boolean(user) &&
                user!.faction_id <= 0 &&
                activeInfo.factionId > 0 &&
                season.phase !== 'frozen';
              return (
                <button
                  type="button"
                  class={`btn execute-selected-btn ${
                    canJoinFromSelected
                      ? 'btn-primary'
                      : actionMode === 1
                        ? 'btn-primary'
                        : paintButtonInfo.tone === 'mode-btn-attack'
                          ? 'btn-danger'
                          : paintButtonInfo.tone === 'mode-btn-war'
                            ? 'btn-gold'
                            : 'btn-primary'
                  }`}
                  disabled={
                    !canJoinFromSelected &&
                    (!activeInfo.canExecute ||
                      (actionMode === 0 && activeInfo.costAp > availableAp))
                  }
                  onClick={() => onExecuteSelected(selectedCell.x, selectedCell.y, activeInfo)}
                >
                  {canJoinFromSelected
                    ? 'この勢力に参加する'
                    : actionMode === 1
                      ? `色変更を実行 (${selectedCell.x}, ${selectedCell.y})`
                      : `${activeInfo.actionLabel} を実行${activeInfo.costAp > 0 ? ` (${activeInfo.costAp} AP)` : ''}`}
                </button>
              );
            })()}
          </div>
        </>
      )}
    </aside>
  );
}

/** 塗抹モード切替ボタン（ホバー更新を単独購読） */
export function PaintActionButton({
  subscribeInspect,
  getActiveInfo,
  actionMode,
  availableAp,
  phase,
  user,
  onSelectPaintMode,
}: {
  subscribeInspect: (cb: () => void) => () => void;
  getActiveInfo: () => HoverInfo | null;
  actionMode: ActionMode;
  availableAp: number;
  phase: SeasonPhase;
  user: UserProfile | null;
  onSelectPaintMode: () => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    return subscribeInspect(() => setTick((t) => t + 1));
  }, [subscribeInspect]);

  const paintButtonInfo = computePaintButtonInfo(
    actionMode,
    getActiveInfo(),
    availableAp,
    phase,
    user
  );

  return (
    <button
      class={`mode-btn ${actionMode === 0 ? paintButtonInfo.tone : ''}`}
      title="空き地を塗る・自勢力マスの重ね塗り・相手領土の奪取を行います"
      onClick={onSelectPaintMode}
    >
      {paintButtonInfo.label}
    </button>
  );
}

// Re-export 用の型参照（未使用警告回避）
export type { DiplomacyState, NotificationItem };
