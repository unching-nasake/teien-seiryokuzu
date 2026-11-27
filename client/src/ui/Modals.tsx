import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError } from '../shared/api';
import {
  copyTextToClipboard,
  downloadTextFile,
  formatLogsAsCsv,
  formatLogsAsText,
} from '../shared/logExport';
import {
  DiplomacyState,
  FactionSummary,
  NotificationItem,
  PALETTE_HEX,
  PlayerLogCategory,
  PlayerLogEntry,
  PlayerLogScope,
  SeasonPhase,
  SeasonStatus,
  UserProfile,
} from '../shared/protocol';

interface DiplomacyModalProps {
  user: UserProfile | null;
  factions: FactionSummary[];
  diplomacy: DiplomacyState;
  phase: SeasonPhase;
  wsConnected?: boolean;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onCeasefireAcceptStart?: (fromFactionId: number) => number | null;
  onCeasefireAcceptCancel?: (token: number | null) => void;
  onCeasefireAcceptConfirmed?: (
    token: number | null,
    fallbackMessage?: string,
    immediate?: boolean
  ) => void;
  onCeasefireResponded?: (fromFactionId: number, accept: boolean) => void;
  onToast: (msg: string, kind?: 'info' | 'success' | 'error' | 'war') => void;
}

export function DiplomacyModal({
  user,
  factions,
  diplomacy,
  phase,
  wsConnected,
  onClose,
  onRefresh,
  onCeasefireAcceptStart,
  onCeasefireAcceptCancel,
  onCeasefireAcceptConfirmed,
  onCeasefireResponded,
  onToast,
}: DiplomacyModalProps) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const isFrozen = phase === 'frozen';
  const fMap = new Map(factions.map((f) => [f.id, f]));
  const myFid = user?.faction_id ?? 0;

  const renderFactionLabel = (fid: number) => {
    const f = fMap.get(fid);
    if (!f) return `勢力 #${fid}`;
    return (
      <span>
        <span class="color-dot" style={{ background: PALETTE_HEX[f.color_id] }} />
        {f.name}
      </span>
    );
  };

  const myWars = diplomacy.wars.filter(
    (w) => w.faction_a === myFid || w.faction_b === myFid
  );
  const incomingProposals = diplomacy.ceasefire_proposals.filter(
    (p) => p.to_faction_id === myFid
  );
  const outgoingProposals = diplomacy.ceasefire_proposals.filter(
    (p) => p.from_faction_id === myFid
  );

  const handlePropose = async (targetFid: number) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await api.proposeCeasefire(targetFid);
      onToast('停戦提案を送信しました', 'info');
      await onRefresh();
    } catch (err) {
      onToast((err as Error).message, 'error');
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        void onRefresh().catch(() => {});
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  };

  const handleRespond = async (proposalId: number, accept: boolean) => {
    if (busyRef.current) return;
    const target = incomingProposals.find((p) => p.id === proposalId);
    // HTTP レスポンスより先に WS の ceasefire_accepted が到着するレースに備え送信前に登録する
    const acceptToken =
      accept && target ? (onCeasefireAcceptStart?.(target.from_faction_id) ?? null) : null;
    busyRef.current = true;
    setBusy(true);
    try {
      await api.respondCeasefire(proposalId, accept);
      if (target) {
        onCeasefireResponded?.(target.from_faction_id, accept);
      }
      // 停戦成立時は WS の ceasefire_accepted ブロードキャストでも通知されるため二重トーストを防ぐ（未接続・遅延時はフォールバック）
      if (!accept) {
        onToast('停戦提案を却下しました', 'info');
      } else if (wsConnected === false) {
        if (acceptToken !== null) {
          onCeasefireAcceptConfirmed?.(
            acceptToken,
            '停戦が成立しました（不可侵状態）',
            true
          );
        } else {
          onToast('停戦が成立しました（不可侵状態）', 'success');
        }
      } else {
        onCeasefireAcceptConfirmed?.(acceptToken, '停戦が成立しました（不可侵状態）');
      }
      await onRefresh();
    } catch (err) {
      if (acceptToken !== null) {
        onCeasefireAcceptCancel?.(acceptToken);
      }
      onToast((err as Error).message, 'error');
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        if (target) {
          onCeasefireResponded?.(target.from_faction_id, false);
        }
        void onRefresh().catch(() => {});
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  };

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>外交・戦争・停戦</h2>
          <button class="btn btn-sm" onClick={onClose}>
            閉じる
          </button>
        </div>

        {isFrozen && (
          <div
            style={{
              padding: '8px 12px',
              marginBottom: '10px',
              borderRadius: '8px',
              background: 'rgba(239,68,68,0.14)',
              border: '1px solid rgba(239,68,68,0.35)',
              color: '#fca5a5',
              fontSize: '12px',
            }}
          >
            現在は凍結（結果発表）フェーズのため、停戦提案・承認などの外交操作はできません。
          </div>
        )}

        {myFid > 0 && (
          <div>
            <div class="section-title">自勢力宛ての停戦提案</div>
            {incomingProposals.length === 0 ? (
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                届いている停戦提案はありません。
              </p>
            ) : (
              incomingProposals.map((p) => (
                <div
                  key={p.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 10px',
                    background: 'rgba(16,185,129,0.12)',
                    borderRadius: '8px',
                    marginBottom: '6px',
                  }}
                >
                  <div>{renderFactionLabel(p.from_faction_id)} からの停戦提案</div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      class="btn btn-primary btn-sm"
                      disabled={busy || isFrozen || !user?.permissions.can_ceasefire}
                      onClick={() => handleRespond(p.id, true)}
                    >
                      承認（停戦成立）
                    </button>
                    <button
                      class="btn btn-danger btn-sm"
                      disabled={busy || isFrozen || !user?.permissions.can_ceasefire}
                      onClick={() => handleRespond(p.id, false)}
                    >
                      却下
                    </button>
                  </div>
                </div>
              ))
            )}

            <div class="section-title">交戦中の勢力</div>
            {myWars.length === 0 ? (
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                現在、交戦中の勢力はありません（全勢力と不可侵状態）。
              </p>
            ) : (
              myWars.map((w) => {
                const enemyId = w.faction_a === myFid ? w.faction_b : w.faction_a;
                const alreadyProposed = outgoingProposals.some(
                  (p) => p.to_faction_id === enemyId
                );
                return (
                  <div
                    key={`${w.faction_a}-${w.faction_b}`}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '8px 10px',
                      background: 'rgba(239,68,68,0.14)',
                      borderRadius: '8px',
                      marginBottom: '6px',
                    }}
                  >
                    <div>
                      <span class="mini-badge badge-war" style={{ marginRight: '8px' }}>
                        交戦中
                      </span>
                      {renderFactionLabel(enemyId)}
                    </div>
                    <button
                      class="btn btn-sm"
                      disabled={busy || isFrozen || alreadyProposed || !user?.permissions.can_ceasefire}
                      onClick={() => handlePropose(enemyId)}
                    >
                      {alreadyProposed ? '停戦提案済み' : '停戦を提案'}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}

        <div class="section-title">全勢力の交戦状況</div>
        <div class="table-scroll">
        <table class="list-table">
          <thead>
            <tr>
              <th>勢力 A</th>
              <th>勢力 B</th>
              <th>開戦時刻</th>
            </tr>
          </thead>
          <tbody>
            {diplomacy.wars.map((w) => (
              <tr key={`${w.faction_a}-${w.faction_b}`}>
                <td>{renderFactionLabel(w.faction_a)}</td>
                <td>{renderFactionLabel(w.faction_b)}</td>
                <td style={{ color: 'var(--text-muted)' }}>
                  {new Date(w.started_at).toLocaleString('ja-JP')}
                </td>
              </tr>
            ))}
            {diplomacy.wars.length === 0 && (
              <tr>
                <td colSpan={3} style={{ color: 'var(--text-muted)' }}>
                  現在、盤面全体で発生している戦争はありません。
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

interface RankingModalProps {
  factions: FactionSummary[];
  phase: SeasonPhase;
  seasonId: number;
  onHighlightFaction?: (factionId: number) => void;
  onClose: () => void;
}

export function RankingModal({
  factions,
  phase,
  seasonId,
  onHighlightFaction,
  onClose,
}: RankingModalProps) {
  const [search, setSearch] = useState('');

  // 全勢力の領土合計と上位10勢力＋その他の占有率を算出する
  const totalTerritory = factions.reduce((sum, f) => sum + f.territory_count, 0);
  const topFactions = factions.slice(0, 10).filter((f) => f.territory_count > 0);
  const otherTerritory = factions.slice(10).reduce((sum, f) => sum + f.territory_count, 0);

  // 検索フィルタ適用時も元の全体順位を保持する
  const query = search.trim().toLowerCase();
  const rankedFactions = factions
    .map((faction, idx) => ({ faction, rank: idx + 1 }))
    .filter(({ faction }) => !query || faction.name.toLowerCase().includes(query));

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>
            {phase === 'frozen'
              ? `シーズン #${seasonId} 最終結果発表`
              : `シーズン #${seasonId} 勢力ランキング`}
          </h2>
          <button class="btn btn-sm" onClick={onClose}>
            閉じる
          </button>
        </div>

        {totalTerritory > 0 && (
          <div class="ranking-share-bar" aria-label="勢力別領土占有率">
            {topFactions.map((f) => {
              const pct = (f.territory_count / totalTerritory) * 100;
              return (
                <div
                  key={f.id}
                  class="ranking-share-seg"
                  style={{ width: `${pct}%`, background: PALETTE_HEX[f.color_id] }}
                  title={`${f.name}: ${pct.toFixed(1)}%`}
                />
              );
            })}
            {otherTerritory > 0 && (
              <div
                class="ranking-share-seg"
                style={{
                  width: `${(otherTerritory / totalTerritory) * 100}%`,
                  background: '#64748b',
                }}
                title={`その他: ${((otherTerritory / totalTerritory) * 100).toFixed(1)}%`}
              />
            )}
          </div>
        )}

        <div class="ranking-search-row">
          <input
            class="input"
            type="search"
            placeholder="勢力名で検索..."
            value={search}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="table-scroll">
        <table class="list-table">
          <thead>
            <tr>
              <th>順位</th>
              <th>勢力名</th>
              <th>領土数</th>
              <th>中核ドット</th>
              <th>メンバー</th>
              <th>状態</th>
            </tr>
          </thead>
          <tbody>
            {rankedFactions.map(({ faction: f, rank }) => (
              <tr
                key={f.id}
                tabIndex={onHighlightFaction ? 0 : undefined}
                style={onHighlightFaction ? { cursor: 'pointer' } : undefined}
                title={onHighlightFaction ? 'クリックでマップ上の領土を点滅ハイライト' : undefined}
                onClick={() => {
                  if (onHighlightFaction) {
                    onHighlightFaction(f.id);
                    onClose();
                  }
                }}
                onKeyDown={(e) => {
                  if (!onHighlightFaction) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onHighlightFaction(f.id);
                    onClose();
                  }
                }}
              >
                <td style={{ fontWeight: 700, color: rank <= 3 ? '#fde047' : undefined }}>
                  #{rank}
                </td>
                <td>
                  <span
                    class="color-dot"
                    style={{ background: PALETTE_HEX[f.color_id] }}
                  />
                  {f.name}
                </td>
                <td style={{ fontWeight: 700 }}>{f.territory_count.toLocaleString()}</td>
                <td style={{ color: '#fde047' }}>{f.core_count.toLocaleString()}</td>
                <td>{f.member_count}</td>
                <td>
                  {f.is_extinct ? (
                    <span class="mini-badge badge-enclave">滅亡（亡命）</span>
                  ) : (
                    <span class="mini-badge badge-art">存続</span>
                  )}
                </td>
              </tr>
            ))}
            {rankedFactions.length === 0 && (
              <tr>
                <td colSpan={6} style={{ color: 'var(--text-muted)' }}>
                  {factions.length === 0
                    ? 'まだ勢力が登録されていません。'
                    : '一致する勢力が見つかりません。'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

interface AuthModalProps {
  onClose: () => void;
  onAuthSuccess: (user: UserProfile) => void;
  onToast: (msg: string, kind?: 'info' | 'success' | 'error' | 'war') => void;
}

export function AuthModal({ onClose, onAuthSuccess, onToast }: AuthModalProps) {
  const [isRegister, setIsRegister] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const submittingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = isRegister
        ? await api.register(username, password)
        : await api.login(username, password);
      // 認証成功後はアンマウント済みでもセッション状態と WebSocket 再接続を必ず反映する
      onAuthSuccess(res.user);
      onToast(
        isRegister ? `アカウントを作成しました（初期 ${res.user.ap} AP）` : 'ログインしました',
        'success'
      );
      if (mountedRef.current) {
        onClose();
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (mountedRef.current) {
        setErrorMsg(msg);
      } else {
        onToast(msg, 'error');
      }
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  };

  return (
    <div class="modal-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <div class="modal-card" role="dialog" aria-modal="true" style={{ maxWidth: '400px' }} onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>{isRegister ? '新規アカウント作成' : 'ログイン'}</h2>
          <button type="button" class="btn btn-sm" onClick={onClose} disabled={busy}>
            閉じる
          </button>
        </div>

        <form onSubmit={submit}>
          <div class="form-field">
            <label>ユーザー名（2〜20文字）</label>
            <input
              class="input"
              required
              autoFocus
              autoComplete="username"
              minLength={2}
              maxLength={20}
              disabled={busy}
              value={username}
              onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="form-field">
            <label>{isRegister ? 'パスワード（8〜128文字）' : 'パスワード'}</label>
            <input
              class="input"
              type="password"
              required
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              minLength={isRegister ? 8 : undefined}
              maxLength={128}
              disabled={busy}
              value={password}
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            />
          </div>
          {errorMsg && (
            <div class="form-error" role="alert">
              {errorMsg}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '14px' }}>
            <button
              type="button"
              class="btn btn-sm"
              disabled={busy}
              onClick={() => {
                if (busy) return;
                setIsRegister(!isRegister);
                setErrorMsg(null);
              }}
            >
              {isRegister ? 'ログインへ切替' : '新規登録へ切替'}
            </button>
            <button type="submit" class="btn btn-primary" disabled={busy}>
              {isRegister ? '登録して開始' : 'ログイン'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface WarConfirmModalProps {
  targetFactionName: string;
  targetColorId: number;
  x: number;
  y: number;
  costAp: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export function WarConfirmModal({
  targetFactionName,
  targetColorId,
  x,
  y,
  costAp,
  onCancel,
  onConfirm,
}: WarConfirmModalProps) {
  return (
    <div class="modal-backdrop" onClick={onCancel}>
      <div class="modal-card" role="dialog" aria-modal="true" style={{ maxWidth: '440px' }} onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2 style={{ color: '#fca5a5' }}>開戦警告</h2>
          <button class="btn btn-sm" onClick={onCancel}>
            閉じる
          </button>
        </div>
        <p style={{ fontSize: '13px', lineHeight: 1.7, marginBottom: '16px' }}>
          非戦争状態の勢力{' '}
          <strong>
            <span
              class="color-dot"
              style={{ background: PALETTE_HEX[targetColorId] }}
            />
            {targetFactionName}
          </strong>{' '}
          の領土 <code>({x}, {y})</code> を上書きしようとしています。
          <br />
          実行すると<strong>即座に開戦状態</strong>になります（消費コスト: {costAp} AP）。
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button class="btn" onClick={onCancel}>
            キャンセル
          </button>
          <button class="btn btn-danger" onClick={onConfirm}>
            宣戦布告して上書き
          </button>
        </div>
      </div>
    </div>
  );
}

interface JoinFactionConfirmModalProps {
  faction: FactionSummary;
  user: UserProfile;
  onCancel: () => void;
  onOpenFactionModal: () => void;
  onRefresh: () => Promise<void>;
  onToast: (msg: string, kind?: 'info' | 'success' | 'error' | 'war') => void;
}

/** 勢力未参加プレイヤーが既存勢力マスをクリック/タップしたときの参加確認モーダル */
export function JoinFactionConfirmModal({
  faction,
  user,
  onCancel,
  onOpenFactionModal,
  onRefresh,
  onToast,
}: JoinFactionConfirmModalProps) {
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  const submittingRef = useRef(false);
  const isApprovalOnly = faction.join_policy === 1;
  const hasRequested =
    user.outgoing_join_request_faction_ids?.includes(faction.id) ?? false;
  const needsRequest = isApprovalOnly;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleConfirm = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    try {
      if (needsRequest) {
        await api.requestJoinFaction(faction.id);
        onToast(`「${faction.name}」へ参加申請を送信しました`, 'success');
      } else {
        await api.joinFaction(faction.id);
        onToast(`勢力「${faction.name}」に参加しました`, 'success');
      }
      await onRefresh();
      // 別勢力向けに開き直された確認モーダルを誤って閉じないようマウント中のみ閉じる
      if (mountedRef.current) {
        onCancel();
      }
    } catch (err) {
      onToast((err as Error).message, 'error');
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        void onRefresh().catch(() => {});
      }
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  };

  return (
    <div class="modal-backdrop" onClick={() => { if (!busy) onCancel(); }}>
      <div
        class="modal-card"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: '440px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal-header">
          <h2>勢力への参加確認</h2>
          <button class="btn btn-sm" onClick={onCancel} disabled={busy}>
            閉じる
          </button>
        </div>
        <div style={{ fontSize: '13px', lineHeight: 1.7, marginBottom: '16px' }}>
          <p style={{ marginBottom: '10px' }}>
            選択した領土の勢力{' '}
            <strong>
              <span
                class="color-dot"
                style={{ background: PALETTE_HEX[faction.color_id] }}
              />
              {faction.name}
            </strong>
            {isApprovalOnly && (
              <span class="mini-badge badge-enclave" style={{ marginLeft: '6px' }}>
                参加許可制
              </span>
            )}
          </p>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>
            領土数: {faction.territory_count.toLocaleString()} マス ／ メンバー:{' '}
            {faction.member_count} 人
          </p>
          <p>
            {needsRequest
              ? hasRequested
                ? 'この勢力にはすでに参加申請を送信済みです。承認をお待ちください。'
                : 'この勢力は参加許可制です。参加申請を送信しますか？'
              : 'この勢力に参加しますか？'}
          </p>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            class="btn btn-sm"
            disabled={busy}
            onClick={onOpenFactionModal}
          >
            勢力一覧を開く
          </button>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" class="btn" onClick={onCancel} disabled={busy}>
              キャンセル
            </button>
            <button
              type="button"
              class="btn btn-primary"
              disabled={busy || (needsRequest && hasRequested)}
              onClick={() => void handleConfirm()}
            >
              {busy
                ? '処理中...'
                : needsRequest
                  ? hasRequested
                    ? '申請済み'
                    : '参加申請を送る'
                  : 'この勢力に参加する'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface LogsModalProps {
  factions: FactionSummary[];
  currentUserId?: number;
  currentFactionId?: number;
  liveSignal?: number;
  resetSignal?: number;
  onJumpToCoord?: (x: number, y: number) => void;
  onFocusFaction?: (factionId: number) => void;
  onClose: () => void;
}

const LOG_TABS: Array<{ key: PlayerLogCategory; label: string }> = [
  { key: 'all', label: 'すべて' },
  { key: 'territory', label: '領土・塗り' },
  { key: 'diplomacy', label: '外交・戦争' },
  { key: 'faction', label: '勢力' },
  { key: 'ap', label: 'AP' },
  { key: 'system', label: 'システム' },
];

const LOG_CATEGORY_LABELS: Record<Exclude<PlayerLogCategory, 'all'>, string> = {
  territory: '領土',
  diplomacy: '外交',
  faction: '勢力',
  ap: 'AP',
  system: 'システム',
};

const LOG_CATEGORY_BADGE_CLASS: Record<Exclude<PlayerLogCategory, 'all'>, string> = {
  territory: 'badge-log-territory',
  diplomacy: 'badge-log-diplomacy',
  faction: 'badge-log-faction',
  ap: 'badge-log-ap',
  system: 'badge-log-system',
};

function formatLogDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}:${ss}`;
}

function formatLogFullDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleString('ja-JP');
}

function renderLogSummary(
  summary: string,
  onJumpToCoord?: (x: number, y: number) => void
) {
  if (!onJumpToCoord) return summary;
  const re = /\((\d+),\s*(\d+)\)/g;
  const parts: Array<string | preact.JSX.Element> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(summary)) !== null) {
    if (match.index > lastIndex) {
      parts.push(summary.slice(lastIndex, match.index));
    }
    const x = Number(match[1]);
    const y = Number(match[2]);
    const coordText = match[0];
    parts.push(
      <button
        key={`${match.index}-${x}-${y}`}
        type="button"
        class="log-coord-link"
        title={`(${x}, ${y}) へマップ移動`}
        onClick={() => onJumpToCoord(x, y)}
      >
        {coordText}
      </button>
    );
    lastIndex = match.index + coordText.length;
  }
  if (lastIndex < summary.length) {
    parts.push(summary.slice(lastIndex));
  }
  return parts.length > 0 ? parts : summary;
}

const MAX_LIVE_LOGS = 500;

export function LogsModal({
  factions,
  currentUserId,
  currentFactionId,
  liveSignal = 0,
  resetSignal = 0,
  onJumpToCoord,
  onFocusFaction,
  onClose,
}: LogsModalProps) {
  const [category, setCategory] = useState<PlayerLogCategory>('all');
  const [scope, setScope] = useState<PlayerLogScope>('all');
  const [filterFactionId, setFilterFactionId] = useState<number>(0);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [logs, setLogs] = useState<PlayerLogEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [liveEnabled, setLiveEnabled] = useState(true);
  const [pendingUpdates, setPendingUpdates] = useState(false);
  const [newLogIds, setNewLogIds] = useState<number[]>([]);
  const [copiedFeedback, setCopiedFeedback] = useState(false);

  // フィルタ切替・追加読込・差分取得の競合を防ぐ世代番号と最新状態 Ref
  const fetchGenRef = useRef(0);
  const latestLogIdRef = useRef<number | null>(null);
  latestLogIdRef.current = logs.length > 0 ? logs[0].id : null;
  const filterRef = useRef({ category, scope, filterFactionId, searchQuery });
  filterRef.current = { category, scope, filterFactionId, searchQuery };
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const incrementalInFlightRef = useRef(false);
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const liveDebounceRef = useRef<number | null>(null);
  const prevLiveSignalRef = useRef(liveSignal);
  const prevResetSignalRef = useRef(resetSignal);
  const flashTimersRef = useRef<Set<number>>(new Set());
  const copyFeedbackTimerRef = useRef<number | null>(null);

  const factionMap = new Map(factions.map((f) => [f.id, f]));
  const hasFaction = (currentFactionId ?? 0) > 0;
  const isLoggedIn = currentUserId !== undefined;
  const newLogIdSet = new Set(newLogIds);
  const hasActiveFilter =
    category !== 'all' || scope !== 'all' || filterFactionId > 0 || searchQuery.length > 0;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearchQuery(searchInput.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (scope === 'mine' && !isLoggedIn) setScope('all');
    if (scope === 'faction' && !hasFaction) setScope('all');
  }, [scope, isLoggedIn, hasFaction]);

  // 選択中の勢力が管理者削除等で消えた場合は「すべての勢力」へ戻す
  useEffect(() => {
    if (filterFactionId > 0 && !factions.some((f) => f.id === filterFactionId)) {
      setFilterFactionId(0);
    }
  }, [factions, filterFactionId]);

  const fetchLogs = async (beforeId: number | null = null, silent = false) => {
    const gen = beforeId === null ? ++fetchGenRef.current : fetchGenRef.current;
    const { category: cat, scope: sc, filterFactionId: ffid, searchQuery: sq } = filterRef.current;
    if (beforeId === null) {
      if (!silent) {
        setLoading(true);
        setLoadingMore(false);
        setError(null);
        setLoadMoreError(null);
      }
      setPendingUpdates(false);
    } else {
      setLoadingMore(true);
      setLoadMoreError(null);
    }
    try {
      const res = await api.getPlayerLogs(cat, 100, {
        before_id: beforeId,
        scope: sc,
        faction_id: sc === 'all' && ffid > 0 ? ffid : null,
        q: sq || undefined,
      });
      if (gen !== fetchGenRef.current) return;
      if (beforeId === null) {
        setLogs(res.logs);
        setHasMore(Boolean(res.has_more));
        setNextBeforeId(res.next_before_id ?? null);
      } else {
        setLogs((prev) => {
          const seen = new Set(prev.map((item) => item.id));
          const appended = res.logs.filter((item) => !seen.has(item.id));
          return [...prev, ...appended];
        });
        setHasMore(Boolean(res.has_more));
        setNextBeforeId(res.next_before_id ?? null);
      }
    } catch (err) {
      if (gen !== fetchGenRef.current) return;
      const msg = err instanceof Error ? err.message : '行動ログの取得に失敗しました';
      if (beforeId === null) {
        if (!silent) {
          setLogs([]);
          setHasMore(false);
          setNextBeforeId(null);
          setError(msg);
        }
      } else {
        setLoadMoreError(msg);
      }
    } finally {
      if (gen === fetchGenRef.current) {
        if (beforeId === null) {
          if (!silent) {
            setLoading(false);
          }
        } else {
          setLoadingMore(false);
        }
      }
    }
  };

  const fetchIncremental = async (force = false) => {
    if (incrementalInFlightRef.current) return;
    // 下へスクロールして過去ログを閲覧中の場合は、読み位置がズレないよう新着バナーに保留する
    if (!force && tableWrapRef.current && tableWrapRef.current.scrollTop > 24) {
      setPendingUpdates(true);
      return;
    }
    const latestId = latestLogIdRef.current;
    if (latestId === null) {
      incrementalInFlightRef.current = true;
      try {
        await fetchLogs(null, true);
      } finally {
        incrementalInFlightRef.current = false;
      }
      return;
    }
    const gen = fetchGenRef.current;
    const { category: cat, scope: sc, filterFactionId: ffid, searchQuery: sq } = filterRef.current;
    incrementalInFlightRef.current = true;
    try {
      const res = await api.getPlayerLogs(cat, 100, {
        after_id: latestId,
        scope: sc,
        faction_id: sc === 'all' && ffid > 0 ? ffid : null,
        q: sq || undefined,
      });
      if (gen !== fetchGenRef.current) return;
      if (res.has_more) {
        await fetchLogs(null, true);
        return;
      }
      setPendingUpdates(false);
      if (res.logs.length === 0) return;

      const incomingIds = res.logs.map((item) => item.id);
      let trimmedTailId: number | null = null;
      setLogs((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        const prepended = res.logs.filter((item) => !seen.has(item.id));
        if (prepended.length === 0) return prev;
        const merged = [...prepended, ...prev];
        if (merged.length > MAX_LIVE_LOGS) {
          const trimmed = merged.slice(0, MAX_LIVE_LOGS);
          trimmedTailId = trimmed[trimmed.length - 1]?.id ?? null;
          return trimmed;
        }
        return merged;
      });
      if (trimmedTailId !== null) {
        setHasMore(true);
        setNextBeforeId(trimmedTailId);
      }
      setNewLogIds((prev) => Array.from(new Set([...prev, ...incomingIds])));
      const timerId = window.setTimeout(() => {
        flashTimersRef.current.delete(timerId);
        const dropSet = new Set(incomingIds);
        setNewLogIds((prev) => prev.filter((id) => !dropSet.has(id)));
      }, 2500);
      flashTimersRef.current.add(timerId);
    } catch {
      // 差分更新の一時失敗は既存一覧を保持し、次回シグナルまたは手動更新で再同期する
    } finally {
      incrementalInFlightRef.current = false;
    }
  };

  useEffect(() => {
    if (liveDebounceRef.current !== null) {
      window.clearTimeout(liveDebounceRef.current);
      liveDebounceRef.current = null;
    }
    setPendingUpdates(false);
    setNewLogIds([]);
    void fetchLogs(null);
  }, [category, scope, filterFactionId, searchQuery, currentUserId, currentFactionId]);

  // WebSocket からの更新シグナルに応じたリアルタイム差分取得
  useEffect(() => {
    if (liveSignal === prevLiveSignalRef.current) return;
    prevLiveSignalRef.current = liveSignal;
    if (!liveEnabled) {
      setPendingUpdates(true);
      return;
    }
    if (liveDebounceRef.current !== null) {
      window.clearTimeout(liveDebounceRef.current);
    }
    liveDebounceRef.current = window.setTimeout(() => {
      liveDebounceRef.current = null;
      if (!loadingRef.current) {
        void fetchIncremental(false);
      }
    }, 400);
  }, [liveSignal, liveEnabled]);

  // マップ再生成・シーズンリセット時は先頭から再取得
  useEffect(() => {
    if (resetSignal === prevResetSignalRef.current) return;
    prevResetSignalRef.current = resetSignal;
    setNewLogIds([]);
    void fetchLogs(null);
  }, [resetSignal]);

  // LIVE ON 中の定期フォールバック同期間隔（15秒）
  useEffect(() => {
    if (!liveEnabled) return;
    const id = window.setInterval(() => {
      if (!document.hidden && !loadingRef.current) {
        void fetchIncremental(false);
      }
    }, 15000);
    return () => window.clearInterval(id);
  }, [liveEnabled]);

  useEffect(() => {
    return () => {
      fetchGenRef.current++;
      if (liveDebounceRef.current !== null) {
        window.clearTimeout(liveDebounceRef.current);
      }
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
      for (const t of flashTimersRef.current) {
        window.clearTimeout(t);
      }
      flashTimersRef.current.clear();
    };
  }, []);

  const handleResetFilters = () => {
    setCategory('all');
    setScope('all');
    setFilterFactionId(0);
    setSearchInput('');
    setSearchQuery('');
  };

  const handleCopyText = async () => {
    if (logs.length === 0) return;
    const ok = await copyTextToClipboard(formatLogsAsText(logs, factionMap));
    if (!ok) return;
    setCopiedFeedback(true);
    if (copyFeedbackTimerRef.current !== null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      copyFeedbackTimerRef.current = null;
      setCopiedFeedback(false);
    }, 1800);
  };

  const handleDownloadCsv = () => {
    if (logs.length === 0) return;
    const csv = formatLogsAsCsv(logs, factionMap);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadTextFile(`teien-logs-${stamp}.csv`, csv, 'text/csv;charset=utf-8');
  };

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div
        class="modal-card"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: '780px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal-header">
          <h2>プレイヤー行動ログ</h2>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <button
              type="button"
              class={`btn btn-sm logs-live-btn ${liveEnabled ? 'is-live' : ''}`}
              title={liveEnabled ? 'リアルタイム自動更新 ON（クリックで一時停止）' : 'リアルタイム自動更新 OFF（クリックで再開）'}
              onClick={() => {
                const next = !liveEnabled;
                setLiveEnabled(next);
                if (next && pendingUpdates) {
                  tableWrapRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                  void fetchIncremental(true);
                }
              }}
            >
              <span class="logs-live-dot" />
              {liveEnabled ? 'LIVE' : 'LIVE OFF'}
            </button>
            <button
              class="btn btn-sm"
              onClick={() => void fetchLogs(null)}
              disabled={loading || loadingMore}
            >
              更新
            </button>
            <button class="btn btn-sm" onClick={onClose}>
              閉じる
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
          {LOG_TABS.map((tab) => (
            <button
              key={tab.key}
              class={`btn btn-sm ${category === tab.key ? 'btn-primary' : ''}`}
              onClick={() => setCategory(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div class="logs-filter-bar">
          <div class="logs-scope-group">
            <button
              type="button"
              class={`btn btn-sm ${scope === 'all' ? 'btn-primary' : ''}`}
              onClick={() => setScope('all')}
            >
              全体
            </button>
            <button
              type="button"
              class={`btn btn-sm ${scope === 'faction' ? 'btn-primary' : ''}`}
              disabled={!hasFaction}
              title={hasFaction ? '自勢力が関わる行動ログのみ表示' : '勢力未所属のため利用できません'}
              onClick={() => setScope('faction')}
            >
              自勢力のみ
            </button>
            <button
              type="button"
              class={`btn btn-sm ${scope === 'mine' ? 'btn-primary' : ''}`}
              disabled={!isLoggedIn}
              title={isLoggedIn ? '自分の行動ログのみ表示' : 'ログインすると利用できます'}
              onClick={() => setScope('mine')}
            >
              自分のみ
            </button>
          </div>

          {scope === 'all' && (
            <select
              class="input logs-faction-select"
              aria-label="勢力で絞り込み"
              value={String(filterFactionId)}
              onChange={(e) => setFilterFactionId(Number((e.target as HTMLSelectElement).value) || 0)}
            >
              <option value="0">すべての勢力</option>
              {factions.map((f) => (
                <option key={f.id} value={String(f.id)}>
                  {f.name}
                </option>
              ))}
            </select>
          )}

          <div class="logs-search-wrap">
            <input
              type="search"
              class="input logs-search-input"
              placeholder="プレイヤー名・内容で検索..."
              value={searchInput}
              onInput={(e) => setSearchInput((e.target as HTMLInputElement).value)}
            />
            {searchInput && (
              <button
                type="button"
                class="btn btn-sm"
                onClick={() => {
                  setSearchInput('');
                  setSearchQuery('');
                }}
              >
                クリア
              </button>
            )}
          </div>
        </div>

        <div class="logs-status-bar">
          <span>
            {loading
              ? '読み込み中...'
              : `${logs.length}件表示中${hasMore ? '（さらに過去のログあり）' : ''}`}
          </span>
          <div class="logs-status-actions">
            {hasActiveFilter && (
              <button type="button" class="btn btn-sm" onClick={handleResetFilters}>
                条件リセット
              </button>
            )}
            <button
              type="button"
              class="btn btn-sm"
              disabled={logs.length === 0}
              onClick={() => void handleCopyText()}
            >
              {copiedFeedback ? 'コピー済み' : 'テキストコピー'}
            </button>
            <button
              type="button"
              class="btn btn-sm"
              disabled={logs.length === 0}
              onClick={handleDownloadCsv}
            >
              CSV保存
            </button>
          </div>
        </div>

        {pendingUpdates && (
          <div class="logs-pending-banner">
            <span>新しい行動ログがあります</span>
            <button
              type="button"
              class="btn btn-sm btn-primary"
              onClick={() => {
                tableWrapRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                void fetchIncremental(true);
              }}
            >
              最新を読み込む
            </button>
          </div>
        )}

        <div
          ref={tableWrapRef}
          class="logs-table-wrap"
          onScroll={() => {
            if (
              tableWrapRef.current &&
              tableWrapRef.current.scrollTop <= 24 &&
              liveEnabled &&
              pendingUpdates
            ) {
              void fetchIncremental(true);
            }
          }}
        >
          {loading ? (
            <div style={{ padding: '16px', fontSize: '12px', color: 'var(--text-muted)' }}>
              読み込み中...
            </div>
          ) : error && logs.length === 0 ? (
            <div style={{ padding: '16px', fontSize: '12px', color: '#fca5a5', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <span>行動ログの取得に失敗しました: {error}</span>
              <button class="btn btn-sm" onClick={() => void fetchLogs(null)}>
                再試行
              </button>
            </div>
          ) : logs.length === 0 ? (
            <div style={{ padding: '16px', fontSize: '12px', color: 'var(--text-muted)' }}>
              該当する行動ログはまだありません。
            </div>
          ) : (
            <div class="table-scroll">
            <table class="list-table">
              <thead>
                <tr>
                  <th>日時</th>
                  <th>種別</th>
                  <th>プレイヤー</th>
                  <th>行動内容</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const fac = log.faction_id > 0 ? factionMap.get(log.faction_id) : undefined;
                  const timeStr = formatLogDateTime(log.created_at);
                  const fullTimeStr = formatLogFullDateTime(log.created_at);
                  const isMe = currentUserId !== undefined && log.user_id === currentUserId;
                  const isNew = newLogIdSet.has(log.id);
                  const badgeCls = LOG_CATEGORY_BADGE_CLASS[log.category] ?? 'badge-art';
                  return (
                    <tr
                      key={log.id}
                      class={isNew ? 'log-row-new' : undefined}
                      style={isMe ? { background: 'rgba(16, 185, 129, 0.08)' } : undefined}
                    >
                      <td
                        title={fullTimeStr}
                        style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}
                      >
                        {timeStr}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <span class={`mini-badge ${badgeCls}`}>
                          {LOG_CATEGORY_LABELS[log.category] ?? log.category}
                        </span>
                        {log.faction_only && (
                          <span
                            class="mini-badge badge-log-private"
                            title="自勢力メンバーにのみ表示されるログです"
                          >
                            勢力限定
                          </span>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {fac && (
                          onFocusFaction ? (
                            <button
                              type="button"
                              class="log-faction-btn"
                              title={`「${fac.name}」の領土へマップ移動`}
                              onClick={() => onFocusFaction(fac.id)}
                            >
                              <span
                                class="color-dot"
                                style={{ background: PALETTE_HEX[fac.color_id] }}
                              />
                            </button>
                          ) : (
                            <span
                              class="color-dot"
                              style={{ background: PALETTE_HEX[fac.color_id] }}
                              title={fac.name}
                            />
                          )
                        )}
                        <strong>{log.username}</strong>
                      </td>
                      <td style={{ fontSize: '12px' }}>
                        {renderLogSummary(log.summary, onJumpToCoord)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {loadMoreError && (
              <div class="logs-load-more-error">
                <span>追加読込に失敗しました: {loadMoreError}</span>
                {nextBeforeId !== null && (
                  <button
                    type="button"
                    class="btn btn-sm"
                    disabled={loadingMore}
                    onClick={() => void fetchLogs(nextBeforeId)}
                  >
                    再試行
                  </button>
                )}
              </div>
            )}
            {hasMore && nextBeforeId !== null && (
              <div class="logs-load-more-row">
                <button
                  type="button"
                  class="btn btn-sm"
                  disabled={loadingMore}
                  onClick={() => void fetchLogs(nextBeforeId)}
                >
                  {loadingMore ? '読み込み中...' : 'さらに読み込む'}
                </button>
              </div>
            )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface HelpModalProps {
  season: SeasonStatus;
  onClose: () => void;
}

type HelpTab = 'basics' | 'controls' | 'ap' | 'rules';

/** 現在の環境がスマホ・タブレット（タッチ主体）か PC かを判定する */
function detectTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  const narrow = window.innerWidth <= 768;
  const touchUa =
    typeof navigator !== 'undefined' &&
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  return coarse || narrow || (touchUa && (navigator.maxTouchPoints ?? 0) > 0);
}

export function HelpModal({ season, onClose }: HelpModalProps) {
  const [tab, setTab] = useState<HelpTab>('basics');
  const [isTouchDevice, setIsTouchDevice] = useState<boolean>(detectTouchDevice);
  const apCfg = season.ap_config;
  const costCfg = season.cost_config;
  const rulesCfg = season.game_rules;

  useEffect(() => {
    const update = () => setIsTouchDevice(detectTouchDevice());
    const mq = window.matchMedia?.('(pointer: coarse)');
    mq?.addEventListener?.('change', update);
    window.addEventListener('resize', update);
    return () => {
      mq?.removeEventListener?.('change', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div
        class="modal-card"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: '680px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal-header">
          <h2>遊び方・ゲームルール</h2>
          <button class="btn btn-sm" onClick={onClose}>
            閉じる
          </button>
        </div>

        <div class="help-tabs">
          <button
            class={`btn btn-sm ${tab === 'basics' ? 'btn-primary' : ''}`}
            onClick={() => setTab('basics')}
          >
            基本の流れ
          </button>
          <button
            class={`btn btn-sm ${tab === 'controls' ? 'btn-primary' : ''}`}
            onClick={() => setTab('controls')}
          >
            {isTouchDevice ? '操作方法 (スマホ)' : '操作方法 (PC)'}
          </button>
          <button
            class={`btn btn-sm ${tab === 'ap' ? 'btn-primary' : ''}`}
            onClick={() => setTab('ap')}
          >
            AP・コスト
          </button>
          <button
            class={`btn btn-sm ${tab === 'rules' ? 'btn-primary' : ''}`}
            onClick={() => setTab('rules')}
          >
            中核・重ね塗り・外交
          </button>
        </div>

        <div class="help-body">
          {tab === 'basics' && (
            <>
              <div class="help-section">
                <h3>庭園勢力図とは？</h3>
                <p>
                  週末48時間限定のオンライン陣取り＆ドット絵ストラテジーゲームです。勢力を作って領土を広げたり、64色のカラーで自国を彩りながらランキング上位を目指します。
                </p>
              </div>
              <div class="help-section">
                <h3>はじめかた（4ステップ）</h3>
                <ol class="help-list">
                  <li>
                    <strong>ログイン / 新規登録</strong>: 画面右上のボタンからアカウントを作成します。
                  </li>
                  <li>
                    <strong>勢力を設立または参加</strong>: 上部の「勢力」ボタンから新しい勢力を作るか、既存勢力へ参加・参加申請します。
                  </li>
                  <li>
                    <strong>空き地を塗る</strong>: 陸地（砂色）のマスを選んで自分の勢力領土にします。最初はどこでも塗れます。
                  </li>
                  <li>
                    <strong>領土拡大・防衛・アート制作</strong>: 隣接マスを広げたり、重ね塗りで防衛力を高めたり、AP消費なしの<strong>マス色変更</strong>でドット絵を描けます。
                  </li>
                </ol>
              </div>
              <div class="help-section">
                <h3>表示モードの切替（マップ設定）</h3>
                <ul class="help-list">
                  <li><strong>標準</strong>: 各マスに塗られたドット絵の色をそのまま表示します。</li>
                  <li><strong>勢力色</strong>: 各勢力の代表色で統一して表示し、勢力図を見やすくします。</li>
                  <li><strong>重ね塗り層数</strong>: 重ね塗り（防御力）の高さをヒートマップで表示します。</li>
                  <li><strong>中核/同化</strong>: 中核マス（金）・同化進行中（水色）・旧中核履歴（紫）を確認できます。</li>
                  <li><strong>外交</strong>: 自勢力（緑）・戦争中（赤）・その他（灰）で色分け表示します。</li>
                </ul>
              </div>
            </>
          )}

          {tab === 'controls' && (
            <>
              {!isTouchDevice ? (
                <>
                  <div class="help-section">
                    <h3>PC での操作</h3>
                    <ul class="help-list">
                      <li><strong>マップ移動</strong>: マップ上を左ドラッグ</li>
                      <li><strong>拡大 / 縮小</strong>: マウスホイール、または画面右下の <code>＋</code> / <code>－</code> / <code>全体</code> ボタン</li>
                      <li><strong>マス・勢力の確認</strong>: カーソルを合わせると、対象マスがアクション色で光り、その勢力の領土全体が点滅ハイライトされます。</li>
                      <li><strong>アクション実行</strong>: マスを左クリック（誤クリックを防ぎたい場合は下部の「確認操作」モードをONにすると、クリック選択→実行ボタンの2段階にできます）。</li>
                      <li><strong>右クリックスポイト</strong>: マップ上のマスを右クリックすると、そのマスの色をカラーパレットに取得できます。</li>
                    </ul>
                  </div>
                  <div class="help-section">
                    <h3>キーボードショートカット (PC)</h3>
                    <ul class="help-list">
                      <li><code>1〜5</code>: 表示モード切替（1:標準 / 2:勢力色 / 3:重ね塗り層数 / 4:中核・同化 / 5:外交）</li>
                      <li><code>M</code>: 塗る / マス色変更の切替</li>
                      <li><code>I</code>: スポイトモード切替</li>
                      <li><code>H</code>: 自勢力へ移動</li>
                      <li><code>C</code>: 確認操作のON / OFF切替</li>
                      <li><code>F</code>: 全体表示</li>
                      <li><code>↑↓←→</code> / <code>+</code> <code>-</code>: マップ移動 / 拡大・縮小（タイムラプス中は <code>←</code><code>→</code> でコマ送り）</li>
                      <li><code>Esc</code>: モーダルを閉じる / 選択・スポイト解除</li>
                    </ul>
                  </div>
                </>
              ) : (
                <div class="help-section">
                  <h3>スマホ・タブレットでの操作</h3>
                  <ul class="help-list">
                    <li><strong>マップ移動</strong>: 1本指でドラッグ</li>
                    <li><strong>拡大 / 縮小</strong>: 2本指でピンチイン / ピンチアウト、または画面右端の <code>＋</code> / <code>－</code> ボタン</li>
                    <li><strong>マス選択 &amp; 実行</strong>: マスを1回タップするとそのマスと所属勢力が点滅ハイライトされ、下部に詳細と消費APが表示されます。<strong>下部の実行ボタンをタップ</strong>（または同じマスをもう一度タップ）で確定実行されます。</li>
                  </ul>
                </div>
              )}
              <div class="help-section">
                <h3>便利機能（ミニマップ・座標共有）</h3>
                <ul class="help-list">
                  <li><strong>ミニマップ</strong>: 画面右上のミニマップをクリックまたはドラッグすると、指定位置へ素早くカメラを移動できます。</li>
                  <li><strong>座標クリック共有</strong>: 画面下部の座標表示をクリックすると、現在の座標リンクをクリップボードにコピーして共有できます。</li>
                </ul>
              </div>
              <div class="help-section">
                <h3>ハイライト色の見方</h3>
                <div class="help-legend">
                  <span><i class="legend-dot" style={{ background: '#10b981' }} />空き地を塗る</span>
                  <span><i class="legend-dot" style={{ background: '#3b82f6' }} />重ね塗り</span>
                  <span><i class="legend-dot" style={{ background: '#ef4444' }} />戦争中の相手領土を奪う</span>
                  <span><i class="legend-dot" style={{ background: '#f59e0b' }} />非戦争勢力（要開戦確認）</span>
                  <span><i class="legend-dot" style={{ background: '#e2e8f0' }} />勢力全体点滅（注目中の勢力）</span>
                </div>
              </div>
            </>
          )}

          {tab === 'ap' && (
            <>
              <div class="help-section">
                <h3>現在の AP 設定</h3>
                <ul class="help-list">
                  <li>
                    <strong>初期 AP / 上限</strong>: 初期{' '}
                    <strong>
                      {(apCfg?.initial_ap_min ?? 30) === (apCfg?.initial_ap_max ?? 30)
                        ? `${apCfg?.initial_ap_min ?? 30} AP`
                        : `${apCfg?.initial_ap_min ?? 30}〜${apCfg?.initial_ap_max ?? 30} AP（ランダム）`}
                    </strong>{' '}
                    / 最大 <strong>{apCfg?.max_ap ?? 100} AP</strong>
                  </li>
                  <li>
                    <strong>定期補充</strong>:{' '}
                    <strong>
                      {(() => {
                        const refillMin = apCfg?.refill_interval_minutes ?? 60;
                        const tickMin = Math.max(1, season.game_rules?.tick_interval_minutes ?? 30);
                        return refillMin % tickMin === 0
                          ? `${refillMin / tickMin} Tickごと（${refillMin}分）`
                          : `${refillMin}分ごと`;
                      })()}
                    </strong>
                    に <strong>{apCfg?.refill_min ?? 6}〜{apCfg?.refill_max ?? 12} AP</strong> が自動付与されます。
                  </li>
                  <li>
                    <strong>AP消費なしの操作</strong>: <strong>マス色変更</strong>・勢力設立・外交などは AP を消費しません。
                  </li>
                </ul>
              </div>
              <div class="help-section">
                <h3>基本消費コスト &amp; 飛び地ペナルティ</h3>
                {(() => {
                  const claimCost = costCfg?.claim_cost ?? 1;
                  const reinforceCost = costCfg?.reinforce_cost ?? 1;
                  const enemyNormMult = costCfg?.enemy_normal_multiplier ?? 1;
                  const enemyCoreMult = costCfg?.enemy_core_multiplier ?? 2;
                  const enclaveBase = costCfg?.enclave_base_multiplier ?? 3;
                  const enclaveStep = Math.max(1, costCfg?.enclave_distance_step ?? 10);
                  const enclaveRate = costCfg?.enclave_distance_rate ?? 0.5;

                  const formatCaptureFormula = (mult: number): string => {
                    const unit = Number((claimCost * mult).toFixed(4));
                    const ex1 = Math.max(1, Math.ceil(1 * claimCost * mult - 1e-9));
                    if (unit === 1) {
                      return `層数 AP（1層=${ex1} AP）`;
                    }
                    if (Number.isInteger(unit)) {
                      return `層数 × ${unit} AP（1層=${ex1} AP）`;
                    }
                    return `⌈層数 × ${claimCost} × ${mult}⌉ AP（切り上げ・1層=${ex1} AP）`;
                  };

                  const enclaveD0 = Math.max(1, Math.round(claimCost * enclaveBase));
                  const enclaveDStep = Math.max(1, Math.round(claimCost * (enclaveBase + enclaveRate)));

                  return (
                    <ul class="help-list">
                      <li><strong>塗り基本コスト（空き地・8近傍隣接）</strong>: {claimCost} AP</li>
                      <li><strong>重ね塗り</strong>: {reinforceCost} AP</li>
                      <li>
                        <strong>相手マスを奪う</strong>: 通常 <code>{formatCaptureFormula(enemyNormMult)}</code> ／ 中核 <code>{formatCaptureFormula(enemyCoreMult)}</code>
                      </li>
                      <li>
                        <strong>飛び地コスト</strong>:{' '}
                        {enclaveRate > 0 ? (
                          <>
                            縦横斜めに自勢力がないマスは{' '}
                            <code>
                              基本コスト × ({enclaveBase} + 距離 ÷ {enclaveStep} × {enclaveRate})
                            </code>{' '}
                            （四捨五入・例: 空き地隣接なし距離0={enclaveD0} AP、{enclaveStep}マス離れ={enclaveDStep} AP）
                          </>
                        ) : (
                          <>
                            縦横斜めに自勢力がないマスは{' '}
                            <code>基本コスト × {enclaveBase}</code>（四捨五入・空き地={enclaveD0} AP）
                          </>
                        )}
                      </li>
                    </ul>
                  );
                })()}
              </div>
            </>
          )}

          {tab === 'rules' && (
            <>
              <div class="help-section">
                <h3>重ね塗り（防御強化）</h3>
                <p>
                  自勢力マスをもう一度塗ると層数が +1 され、最大 <strong>{rulesCfg?.max_layers ?? 10} 層</strong>まで積み増せます。相手が奪う際の必要 AP が層数に比例して増加します。
                </p>
              </div>
              <div class="help-section">
                <h3>中核ドット・自然中核化（同化）・旧中核</h3>
                <ul class="help-list">
                  <li>
                    <strong>初期中核枠</strong>: 各勢力は最初の <strong>{rulesCfg?.initial_core_quota ?? 30} マス</strong>まで空き地を塗ると即座に中核マスになります。
                  </li>
                  <li>
                    <strong>自然中核化（同化）</strong>: 自勢力の中核マスに隣接した通常領土を連続{' '}
                    <strong>
                      {rulesCfg?.assimilation_required_ticks ?? 10}{' '}
                      {(rulesCfg?.tick_interval_minutes ?? 30) === 60
                        ? 'Tick（時間）'
                        : `Tick（${rulesCfg?.tick_interval_minutes ?? 30}分/Tick）`}
                    </strong>
                    維持すると、自動で中核に昇格します。
                  </li>
                  <li>
                    <strong>旧中核履歴</strong>: 中核マスを奪われても <strong>{rulesCfg?.old_core_ttl_ticks ?? 10} Tick</strong> 以内に奪還すれば、即座に中核として復活します。
                  </li>
                </ul>
              </div>
              <div class="help-section">
                <h3>外交・権限・自動塗り</h3>
                <ul class="help-list">
                  <li><strong>開戦・停戦</strong>: 非戦争状態の勢力マスを奪うと開戦確認ダイアログが出て宣戦布告となります（開戦権限が必要）。停戦は「外交」画面から提案・受諾できます。</li>
                  <li><strong>自動塗り</strong>: 勢力主が許可している場合、勢力管理画面で ON と消費割合（%）を設定しておくと、毎 Tick で自動的に空き地や戦争中の相手領土を拡大します（未開戦勢力へ勝手に開戦しません）。</li>
                </ul>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface NotificationsModalProps {
  user: UserProfile | null;
  factions: FactionSummary[];
  diplomacy: DiplomacyState;
  phase: SeasonPhase;
  wsConnected?: boolean;
  notifications: NotificationItem[];
  browserNotifEnabled: boolean;
  browserNotifUnsupported?: boolean;
  onToggleBrowserNotif: () => void;
  onMarkAllRead: () => void;
  onClearHistory: () => void;
  onCeasefireAcceptStart?: (fromFactionId: number) => number | null;
  onCeasefireAcceptCancel?: (token: number | null) => void;
  onCeasefireAcceptConfirmed?: (
    token: number | null,
    fallbackMessage?: string,
    immediate?: boolean
  ) => void;
  onCeasefireResponded?: (fromFactionId: number, accept: boolean) => void;
  onJoinRequestResolved?: (applicantUserId: number) => void;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onToast: (msg: string, kind?: 'info' | 'success' | 'error' | 'war') => void;
}

/** 開戦・停戦・参加申請などをまとめて確認・操作できる通知モーダル */
export function NotificationsModal({
  user,
  factions,
  diplomacy,
  phase,
  wsConnected,
  notifications,
  browserNotifEnabled,
  browserNotifUnsupported = false,
  onToggleBrowserNotif,
  onMarkAllRead,
  onClearHistory,
  onCeasefireAcceptStart,
  onCeasefireAcceptCancel,
  onCeasefireAcceptConfirmed,
  onCeasefireResponded,
  onJoinRequestResolved,
  onClose,
  onRefresh,
  onToast,
}: NotificationsModalProps) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const onMarkAllReadRef = useRef(onMarkAllRead);
  onMarkAllReadRef.current = onMarkAllRead;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 開いている間に届いた新着も含め、通知センターを閉じた時点で一括既読にする
      onMarkAllReadRef.current();
    };
  }, []);
  const isFrozen = phase === 'frozen';
  const fMap = new Map(factions.map((f) => [f.id, f]));
  const myFid = user?.faction_id ?? 0;

  const incomingCeasefires = diplomacy.ceasefire_proposals.filter(
    (p) => myFid > 0 && p.to_faction_id === myFid
  );
  const incomingJoinRequests = user?.permissions.can_manage_members
    ? (user.incoming_join_requests ?? [])
    : [];

  const handleRespondCeasefire = async (proposalId: number, accept: boolean) => {
    if (busyRef.current) return;
    const target = incomingCeasefires.find((p) => p.id === proposalId);
    // HTTP レスポンスより先に WS の ceasefire_accepted が到着するレースに備え送信前に登録する
    const acceptToken =
      accept && target ? (onCeasefireAcceptStart?.(target.from_faction_id) ?? null) : null;
    busyRef.current = true;
    setBusy(true);
    try {
      await api.respondCeasefire(proposalId, accept);
      if (target) {
        onCeasefireResponded?.(target.from_faction_id, accept);
      }
      // 停戦成立時は WS の ceasefire_accepted ブロードキャストでも通知されるため二重トーストを防ぐ（未接続・遅延時はフォールバック）
      if (!accept) {
        onToast('停戦提案を却下しました', 'info');
      } else if (wsConnected === false) {
        if (acceptToken !== null) {
          onCeasefireAcceptConfirmed?.(acceptToken, '停戦協定が成立しました', true);
        } else {
          onToast('停戦協定が成立しました', 'success');
        }
      } else {
        onCeasefireAcceptConfirmed?.(acceptToken, '停戦協定が成立しました');
      }
      await onRefresh();
    } catch (err) {
      if (acceptToken !== null) {
        onCeasefireAcceptCancel?.(acceptToken);
      }
      onToast((err as Error).message, 'error');
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        if (target) {
          onCeasefireResponded?.(target.from_faction_id, false);
        }
        void onRefresh().catch(() => {});
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  };

  const handleJoinRequest = async (reqId: number, accept: boolean) => {
    if (busyRef.current || !myFid) return;
    const target = incomingJoinRequests.find((r) => r.id === reqId);
    busyRef.current = true;
    setBusy(true);
    try {
      if (accept) {
        await api.acceptJoinRequest(myFid, reqId);
        if (target) {
          onJoinRequestResolved?.(target.user_id);
        }
        onToast('参加申請を承認しました', 'success');
      } else {
        await api.rejectJoinRequest(myFid, reqId);
        if (target) {
          onJoinRequestResolved?.(target.user_id);
        }
        onToast('参加申請を拒否しました', 'info');
      }
      await onRefresh();
    } catch (err) {
      onToast((err as Error).message, 'error');
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        if (target) {
          onJoinRequestResolved?.(target.user_id);
        }
        void onRefresh().catch(() => {});
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  };

  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  const kindLabel = (kind: NotificationItem['kind']) => {
    switch (kind) {
      case 'war':
        return '開戦';
      case 'ceasefire':
        return '停戦';
      case 'join_request':
        return '参加申請';
      case 'faction':
        return '勢力';
      default:
        return '通知';
    }
  };

  const hasActionItems =
    incomingCeasefires.length > 0 ||
    incomingJoinRequests.length > 0;

  const notifSupported =
    typeof window !== 'undefined' &&
    'Notification' in window &&
    typeof Notification === 'function' &&
    !browserNotifUnsupported;
  const notifPerm = notifSupported ? Notification.permission : 'denied';
  const isDesktopOn = notifSupported && notifPerm === 'granted' && browserNotifEnabled;

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal-card modal-wide" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>🔔 通知センター</h2>
          <button class="btn btn-sm" onClick={onClose}>
            閉じる
          </button>
        </div>
        <div class="modal-body">
          {isFrozen && (
            <div
              style={{
                padding: '8px 12px',
                marginBottom: '10px',
                borderRadius: '8px',
                background: 'rgba(239,68,68,0.14)',
                border: '1px solid rgba(239,68,68,0.35)',
                color: '#fca5a5',
                fontSize: '12px',
              }}
            >
              現在は凍結（結果発表）フェーズのため、停戦・参加承認などの操作はできません。
            </div>
          )}
          <div class="notif-inline-box" style={{ marginTop: 0, marginBottom: '12px' }}>
            <div class="notif-inline-row">
              <span>🖥 ブラウザ通知（タブ非表示時に開戦・侵攻・停戦などをデスクトップ通知）</span>
              <button
                type="button"
                class={`btn btn-sm ${isDesktopOn ? 'btn-primary' : ''}`}
                disabled={!notifSupported}
                onClick={onToggleBrowserNotif}
              >
                {!notifSupported ? '非対応' : isDesktopOn ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
          <div class="section-title">要対応の通知</div>
          {!hasActionItems ? (
            <div class="muted-note">現在対応が必要な停戦提案・参加申請はありません。</div>
          ) : (
            <div class="notif-list">
              {incomingCeasefires.map((p) => {
                const from = fMap.get(p.from_faction_id);
                return (
                  <div key={`cf-${p.id}`} class="notif-card notif-card-ceasefire">
                    <div class="notif-card-main">
                      <span class="mini-badge badge-ceasefire">停戦提案</span>
                      <span>
                        {from && (
                          <span
                            class="color-dot"
                            style={{ background: PALETTE_HEX[from.color_id] }}
                          />
                        )}
                        <strong>{from?.name ?? `勢力 #${p.from_faction_id}`}</strong> から停戦提案が届いています
                      </span>
                    </div>
                    <div class="notif-card-actions">
                      <button
                        class="btn btn-sm btn-primary"
                        disabled={busy || isFrozen || !user?.permissions.can_ceasefire}
                        title={user?.permissions.can_ceasefire ? '' : '停戦権限がありません'}
                        onClick={() => void handleRespondCeasefire(p.id, true)}
                      >
                        停戦を受諾
                      </button>
                      <button
                        class="btn btn-sm"
                        disabled={busy || isFrozen || !user?.permissions.can_ceasefire}
                        title={user?.permissions.can_ceasefire ? '' : '停戦権限がありません'}
                        onClick={() => void handleRespondCeasefire(p.id, false)}
                      >
                        却下
                      </button>
                    </div>
                  </div>
                );
              })}

              {incomingJoinRequests.map((req) => (
                <div key={`jr-${req.id}`} class="notif-card notif-card-join">
                  <div class="notif-card-main">
                    <span class="mini-badge badge-join">参加申請</span>
                    <span>
                      <strong>{req.username}</strong> があなたの勢力への参加を申請しています
                    </span>
                  </div>
                  <div class="notif-card-actions">
                    <button
                      class="btn btn-sm btn-primary"
                      disabled={busy || isFrozen || !user?.permissions.can_manage_members}
                      title={user?.permissions.can_manage_members ? '' : 'メンバー管理権限がありません'}
                      onClick={() => void handleJoinRequest(req.id, true)}
                    >
                      承認
                    </button>
                    <button
                      class="btn btn-sm"
                      disabled={busy || isFrozen || !user?.permissions.can_manage_members}
                      title={user?.permissions.can_manage_members ? '' : 'メンバー管理権限がありません'}
                      onClick={() => void handleJoinRequest(req.id, false)}
                    >
                      拒否
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div
            class="section-title"
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <span>受信した通知履歴 ({notifications.length})</span>
            {notifications.length > 0 && (
              <button class="btn btn-sm" onClick={onClearHistory}>
                履歴をクリア
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <div class="muted-note">開戦・停戦・参加申請などの通知はまだありません。</div>
          ) : (
            <div class="notif-list">
              {notifications.map((n) => (
                <div key={n.id} class={`notif-card notif-card-${n.kind}`}>
                  <div class="notif-card-main">
                    <div class="notif-meta">
                      <span class={`mini-badge notif-badge-${n.kind}`}>{kindLabel(n.kind)}</span>
                      <span class="notif-time">{formatTime(n.createdAt)}</span>
                      {!n.read && <span class="notif-unread-dot" title="未読" />}
                    </div>
                    <div class="notif-title">{n.title}</div>
                    <div class="notif-desc">{n.message}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
