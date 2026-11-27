import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError } from '../shared/api';
import {
  AdminDebugAccount,
  PALETTE_HEX,
  SeasonPhase,
  UserProfile,
} from '../shared/protocol';

interface DebugPanelProps {
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

export function DebugPanel({
  currentUser,
  currentPhase,
  devMode,
  maxAp,
  wsConnected,
  onSwitchUser,
  onRefresh,
  onDisableMode,
  onOpenAdmin,
  onToast,
}: DebugPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [accounts, setAccounts] = useState<AdminDebugAccount[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);

  // 非同期操作の同期的な多重実行防止とアンマウント後状態更新・リクエスト世代競合を防止する
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const accountsSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadAccounts = useCallback(async () => {
    const seq = ++accountsSeqRef.current;
    if (mountedRef.current) {
      setLoadingAccounts(true);
    }
    try {
      const res = await api.adminDebugListAccounts();
      if (!mountedRef.current || seq !== accountsSeqRef.current) return;
      setAccounts(res.accounts);
      setAuthExpired(false);
    } catch (err) {
      if (!mountedRef.current || seq !== accountsSeqRef.current) return;
      // 401 認証エラーのみ管理者セッション切れと判定する
      if (err instanceof ApiError && err.status === 401) {
        setAuthExpired(true);
      }
    } finally {
      if (mountedRef.current && seq === accountsSeqRef.current) {
        setLoadingAccounts(false);
      }
    }
  }, []);

  useEffect(() => {
    // 初回・パネル展開時・ユーザー/勢力切替時のみアカウント一覧を取得（AP変化ごとの再取得を抑制）
    if (!collapsed) {
      void loadAccounts();
    }
  }, [loadAccounts, collapsed, currentUser?.id, currentUser?.faction_id]);

  const handleImpersonate = async (account: AdminDebugAccount) => {
    if (devMode === false || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await api.adminDebugImpersonate(account.id);
      const switchedUserOrFaction =
        currentUser?.id !== res.user.id ||
        currentUser?.faction_id !== res.user.faction_id;
      // パネルがアンマウント済みでも、Cookie切替済みの認証状態を親側へ必ず同期する
      onSwitchUser(res.user);
      onToast(`操作アカウントを「${res.user.username}」に切り替えました`, 'success');
      // ユーザーまたは勢力が変化した場合は useEffect 側で一覧が再取得されるため二重送信を避ける
      if (mountedRef.current && !switchedUserOrFaction) {
        await loadAccounts();
      }
    } catch (err) {
      if (mountedRef.current && err instanceof ApiError && err.status === 401) {
        setAuthExpired(true);
      }
      onToast((err as Error).message, 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  };

  const handleGrantAp = async (
    userId: number | null,
    amount: number,
    mode: 'set' | 'add' = 'set'
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await api.adminDebugGrantAp({ user_id: userId, amount, mode });
      // WS 接続中かつ対象が自分に含まれる場合は ap_granted イベント側でトーストが出るため重複を防ぐ
      const willReceiveWsToast =
        wsConnected !== false &&
        currentUser !== null &&
        (userId === null || userId === currentUser.id);
      if (!willReceiveWsToast) {
        if (userId === null) {
          const deltaText = res.delta ?? amount;
          onToast(
            mode === 'add'
              ? `全プレイヤー (${res.updated_count}人) に +${deltaText} AP を追加しました`
              : `全プレイヤー (${res.updated_count}人) のAPを ${res.ap ?? amount} に設定しました`,
            'success'
          );
        } else {
          onToast(
            mode === 'add'
              ? `+${amount} AP を追加しました（現在 ${res.ap ?? '?'} AP）`
              : `APを ${res.ap ?? amount} に更新しました`,
            'success'
          );
        }
      }
      await onRefresh();
      if (mountedRef.current) {
        await loadAccounts();
      }
    } catch (err) {
      if (mountedRef.current && err instanceof ApiError && err.status === 401) {
        setAuthExpired(true);
      }
      onToast((err as Error).message, 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  };

  const effectiveMaxAp = currentUser?.max_ap ?? maxAp ?? 100;

  const handleQuickSeed = async () => {
    if (devMode === false) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await api.adminDebugSeedFactions({
        faction_count: 2,
        members_per_faction: 1,
        initial_ap: effectiveMaxAp,
        place_initial_core: true,
      });
      onToast(
        `${res.created_count} 勢力を追加しました（初期中核 ${res.placed_cores} 配置）`,
        'success'
      );
      await onRefresh();
      if (mountedRef.current) {
        await loadAccounts();
      }
    } catch (err) {
      if (mountedRef.current && err instanceof ApiError && err.status === 401) {
        setAuthExpired(true);
      }
      onToast((err as Error).message, 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  };

  const handleSetPhase = async (phase: 'preparation' | 'active' | 'frozen') => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await api.adminSetPhase(phase);
      if (wsConnected === false || currentPhase === phase) {
        onToast(`フェーズを「${phase}」に変更しました`, 'success');
      }
      await onRefresh();
    } catch (err) {
      if (mountedRef.current && err instanceof ApiError && err.status === 401) {
        setAuthExpired(true);
      }
      onToast((err as Error).message, 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  };

  const handleTick = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await api.adminTriggerTick();
      if (wsConnected === false) {
        onToast(
          `手動ティック実行 (#${res.tick_number}): 中核昇格 ${res.promoted_cores}`,
          'success'
        );
      }
      await onRefresh();
      if (mountedRef.current) {
        await loadAccounts();
      }
    } catch (err) {
      if (mountedRef.current && err instanceof ApiError && err.status === 401) {
        setAuthExpired(true);
      }
      onToast((err as Error).message, 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  };

  if (collapsed) {
    return (
      <aside class="debug-panel debug-panel-collapsed">
        <span class="debug-badge">デバッグ</span>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          {currentUser ? `${currentUser.username} (AP:${currentUser.ap})` : '未ログイン'}
        </span>
        <button class="btn btn-sm" onClick={() => setCollapsed(false)}>
          展開
        </button>
        <button class="btn btn-sm" disabled={busy} onClick={onDisableMode} title="パネルモードをOFFにする">
          ×
        </button>
      </aside>
    );
  }

  return (
    <aside class="debug-panel">
      <div class="debug-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span class="debug-badge">管理者デバッグ</span>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {accounts.length}人
          </span>
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            class="btn btn-sm"
            disabled={busy || loadingAccounts}
            onClick={() => void loadAccounts()}
            title="一覧を再読込"
          >
            更新
          </button>
          <button class="btn btn-sm" onClick={() => setCollapsed(true)}>
            最小化
          </button>
          <button class="btn btn-sm" disabled={busy} onClick={onDisableMode} title="パネル表示モードを終了">
            終了
          </button>
        </div>
      </div>

      {authExpired ? (
        <div style={{ fontSize: '12px', color: '#fca5a5', padding: '6px 0' }}>
          <p style={{ marginBottom: '8px' }}>管理者セッションが切れています。</p>
          <button class="btn btn-primary btn-sm" onClick={onOpenAdmin}>
            管理者画面で再ログイン
          </button>
        </div>
      ) : (
        <>
          {/* 現在のプレイヤーとAP操作 */}
          <div class="debug-section">
            <div class="debug-label">
              操作中:{' '}
              <strong>
                {currentUser ? `${currentUser.username} (AP ${currentUser.ap}/${currentUser.max_ap})` : '観戦（未ログイン）'}
              </strong>
            </div>
            <div class="debug-btn-row">
              {currentUser && (
                <>
                  <button
                    class="btn btn-sm"
                    disabled={busy}
                    onClick={() => void handleGrantAp(currentUser.id, 10, 'add')}
                  >
                    +10 AP
                  </button>
                  <button
                    class="btn btn-sm"
                    disabled={busy}
                    onClick={() => void handleGrantAp(currentUser.id, 30, 'add')}
                  >
                    +30 AP
                  </button>
                  <button
                    class="btn btn-primary btn-sm"
                    disabled={busy}
                    onClick={() => void handleGrantAp(currentUser.id, effectiveMaxAp, 'set')}
                  >
                    MAX({effectiveMaxAp})
                  </button>
                </>
              )}
              <button
                class="btn btn-gold btn-sm"
                disabled={busy || accounts.length === 0}
                onClick={() => void handleGrantAp(null, effectiveMaxAp, 'set')}
                title={`全プレイヤーのAPを${effectiveMaxAp}にします`}
              >
                全員MAX
              </button>
            </div>
          </div>

          {/* プレイヤー切替リスト */}
          <div class="debug-section">
            <div class="debug-label">アカウント切替（クリックで即切替）</div>
            {accounts.length === 0 ? (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '4px 0' }}>
                プレイヤーがいません。「+2勢力誕生」または管理者コンソールから作成してください。
              </div>
            ) : (
              <div class="debug-account-list">
                {accounts.map((acc) => {
                  const isCurrent = currentUser?.id === acc.id;
                  return (
                    <button
                      key={acc.id}
                      type="button"
                      disabled={busy || devMode === false}
                      title={devMode === false ? '本番モード (dev_mode: false) ではアカウント切替は無効です' : undefined}
                      class={`debug-account-item ${isCurrent ? 'active' : ''}`}
                      onClick={() => void handleImpersonate(acc)}
                    >
                      <span class="debug-account-main">
                        {acc.faction_id > 0 ? (
                          <span
                            class="color-dot"
                            style={{ background: PALETTE_HEX[acc.faction_color_id] }}
                          />
                        ) : (
                          <span class="color-dot" style={{ background: '#64748b' }} />
                        )}
                        <span class="debug-account-name">{acc.username}</span>
                        {acc.is_leader && <span class="debug-role-tag">長</span>}
                      </span>
                      <span class="debug-account-meta">
                        <span>{acc.faction_id > 0 ? acc.faction_name : '無所属'}</span>
                        <span class="debug-ap-tag">AP {acc.ap}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* クイック操作 */}
          <div class="debug-section" style={{ borderBottom: 'none', paddingBottom: 0 }}>
            <div class="debug-label">クイック操作（フェーズ: {currentPhase}）</div>
            <div class="debug-btn-row">
              <button
                class="btn btn-sm"
                disabled={busy || devMode === false}
                title={devMode === false ? '本番モード (dev_mode: false) では無効です' : undefined}
                onClick={() => void handleQuickSeed()}
              >
                +2勢力誕生
              </button>
              <button
                class={`btn btn-sm ${currentPhase === 'preparation' ? 'btn-primary' : ''}`}
                disabled={busy}
                onClick={() => void handleSetPhase('preparation')}
              >
                準備
              </button>
              <button
                class={`btn btn-sm ${currentPhase === 'active' ? 'btn-primary' : ''}`}
                disabled={busy}
                onClick={() => void handleSetPhase('active')}
              >
                開催
              </button>
              <button
                class={`btn btn-sm ${currentPhase === 'frozen' ? 'btn-gold' : ''}`}
                disabled={busy}
                onClick={() => void handleSetPhase('frozen')}
              >
                凍結
              </button>
              <button
                class="btn btn-sm"
                disabled={busy || currentPhase !== 'active'}
                title={currentPhase !== 'active' ? '開催フェーズ中のみ実行できます' : undefined}
                onClick={() => void handleTick()}
              >
                ティック実行
              </button>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
