import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError } from '../shared/api';
import {
  FactionDetail,
  FactionSummary,
  PALETTE_HEX,
  SeasonPhase,
  UserProfile,
} from '../shared/protocol';

interface FactionModalProps {
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

const parseIntInput = (raw: string): number | '' => {
  if (raw === '') return '';
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : '';
};

export function FactionModal({
  user,
  factions,
  phase,
  refreshSeq,
  maxNameLen,
  initialCoreQuota,
  enclaveBaseMultiplier = 3,
  onClose,
  onRefresh,
  onJoinRequestResolved,
  onToast,
}: FactionModalProps) {
  const [name, setName] = useState('');
  const usedColors = new Set(factions.map((f) => f.color_id));
  const firstFreeColor = Array.from({ length: 64 }, (_, i) => i).find(
    (c) => !usedColors.has(c)
  ) ?? 0;
  const [colorId, setColorId] = useState<number>(firstFreeColor);
  const [detail, setDetail] = useState<FactionDetail | null>(null);
  const detailRef = useRef<FactionDetail | null>(null);
  detailRef.current = detail;
  const [detailLoading, setDetailLoading] = useState<boolean>((user?.faction_id ?? 0) > 0);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailGenRef = useRef(0);
  const [autoPaintEnabled, setAutoPaintEnabled] = useState<boolean>(
    user?.auto_paint_enabled ?? false
  );
  const [autoPaintPct, setAutoPaintPct] = useState<number | ''>(user?.auto_paint_pct ?? 50);
  const [factionTab, setFactionTab] = useState<'autopaint' | 'color' | 'members'>('autopaint');
  const [busy, setBusy] = useState(false);
  // Preact state の非同期反映による連打・重複送信を防ぐための同期排他フラグ
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  const myFactionId = user?.faction_id ?? 0;
  const isFrozen = phase === 'frozen';
  const isPreparation = phase === 'preparation';
  const cannotCreateFaction = isFrozen || isPreparation;

  useEffect(() => {
    setAutoPaintEnabled(Boolean(user?.auto_paint_enabled));
    setAutoPaintPct(user?.auto_paint_pct ?? 50);
  }, [user?.auto_paint_enabled, user?.auto_paint_pct]);

  // 選択中の設立カラーが他勢力に使用された場合、自動で次の空き色を選択する
  useEffect(() => {
    if (factions.some((f) => f.color_id === colorId)) {
      const used = new Set(factions.map((f) => f.color_id));
      const nextFree = Array.from({ length: 64 }, (_, i) => i).find((c) => !used.has(c));
      if (nextFree !== undefined) {
        setColorId(nextFree);
      }
    }
  }, [factions, colorId]);

  // 勢力詳細取得に世代番号を導入し、factions 更新ごとの不要な再フェッチとレース上書きを防止する
  const loadFactionDetail = useCallback(async (fid: number, silent = false) => {
    if (!mountedRef.current) return;
    const gen = ++detailGenRef.current;
    if (fid <= 0) {
      setDetail(null);
      setDetailLoading(false);
      setDetailError(null);
      return;
    }
    const showLoading = !silent || detailRef.current?.id !== fid;
    if (showLoading) {
      setDetailLoading(true);
    }
    setDetailError(null);
    try {
      const d = await api.getFactionDetail(fid);
      if (!mountedRef.current || gen !== detailGenRef.current) return;
      setDetail(d);
    } catch (err) {
      if (!mountedRef.current || gen !== detailGenRef.current) return;
      if (showLoading) {
        setDetail(null);
        setDetailError(err instanceof Error ? err.message : '勢力詳細の取得に失敗しました');
      }
    } finally {
      // 最新世代の完了時は silent 割り込み競合に関わらずローディング表示を確実に解除する
      if (mountedRef.current && gen === detailGenRef.current) {
        setDetailLoading(false);
      }
    }
  }, []);

  const prevFactionIdRef = useRef<number>(-1);
  const prevRefreshSeqRef = useRef<number>(refreshSeq);
  useEffect(() => {
    if (prevFactionIdRef.current !== myFactionId) {
      prevFactionIdRef.current = myFactionId;
      prevRefreshSeqRef.current = refreshSeq;
      void loadFactionDetail(myFactionId, false);
      return;
    }
    if (prevRefreshSeqRef.current !== refreshSeq) {
      prevRefreshSeqRef.current = refreshSeq;
      if (myFactionId > 0) {
        void loadFactionDetail(myFactionId, true);
      }
    }
  }, [loadFactionDetail, myFactionId, refreshSeq]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      detailGenRef.current++;
    };
  }, []);

  const handleCreate = async (e: Event) => {
    e.preventDefault();
    if (busyRef.current || cannotCreateFaction) return;
    if (!name.trim() || usedColors.has(colorId)) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await api.createFaction(name.trim(), colorId);
      onToast(`勢力「${name.trim()}」を設立しました`, 'success');
      if (mountedRef.current) setName('');
      await onRefresh();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleJoin = async (fid: number) => {
    if (busyRef.current || isFrozen) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await api.joinFaction(fid);
      onToast('勢力に参加しました', 'success');
      await onRefresh();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleLeave = async () => {
    if (busyRef.current || isFrozen || !myFactionId) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await api.leaveFaction(myFactionId);
      onToast('勢力から脱退しました', 'info');
      await onRefresh();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleRequestJoin = async (factionId: number) => {
    if (busyRef.current || isFrozen) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await api.requestJoinFaction(factionId);
      onToast('参加申請を送信しました', 'success');
      await onRefresh();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleAcceptJoinRequest = async (reqId: number) => {
    if (busyRef.current || isFrozen || !myFactionId) return;
    const target = user?.incoming_join_requests?.find((r) => r.id === reqId);
    busyRef.current = true;
    setBusy(true);
    try {
      try {
        await api.acceptJoinRequest(myFactionId, reqId);
        if (target) {
          onJoinRequestResolved?.(target.user_id);
        }
        onToast('参加申請を承認しました', 'success');
      } catch (err) {
        onToast((err as Error).message, 'error');
        if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
          if (target) {
            onJoinRequestResolved?.(target.user_id);
          }
          try {
            if (mountedRef.current) await loadFactionDetail(myFactionId, true);
            await onRefresh();
          } catch {
            // 再取得失敗は無視
          }
        }
        return;
      }
      try {
        if (mountedRef.current) await loadFactionDetail(myFactionId, true);
        await onRefresh();
      } catch {
        // 操作成功後の再取得失敗は操作失敗として扱わない
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleRejectJoinRequest = async (reqId: number) => {
    if (busyRef.current || isFrozen || !myFactionId) return;
    const target = user?.incoming_join_requests?.find((r) => r.id === reqId);
    busyRef.current = true;
    setBusy(true);
    try {
      try {
        await api.rejectJoinRequest(myFactionId, reqId);
        if (target) {
          onJoinRequestResolved?.(target.user_id);
        }
        onToast('参加申請を拒否しました', 'info');
      } catch (err) {
        onToast((err as Error).message, 'error');
        if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
          if (target) {
            onJoinRequestResolved?.(target.user_id);
          }
          try {
            if (mountedRef.current) await loadFactionDetail(myFactionId, true);
            await onRefresh();
          } catch {
            // 再取得失敗は無視
          }
        }
        return;
      }
      try {
        if (mountedRef.current) await loadFactionDetail(myFactionId, true);
        await onRefresh();
      } catch {
        // 操作成功後の再取得失敗は操作失敗として扱わない
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleKick = async (targetUid: number) => {
    if (busyRef.current || isFrozen || !myFactionId) return;
    busyRef.current = true;
    setBusy(true);
    try {
      try {
        await api.kickMember(myFactionId, targetUid);
        onToast('メンバーを追放しました', 'info');
      } catch (err) {
        onToast((err as Error).message, 'error');
        return;
      }
      try {
        if (mountedRef.current) await loadFactionDetail(myFactionId, true);
        await onRefresh();
      } catch {
        // 操作成功後の再取得失敗は操作失敗として扱わない
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const togglePerm = async (
    targetUid: number,
    current: {
      is_vice_leader: boolean;
      can_declare_war: boolean;
      can_ceasefire: boolean;
      can_manage_members: boolean;
    },
    field:
      | 'is_vice_leader'
      | 'can_declare_war'
      | 'can_ceasefire'
      | 'can_manage_members'
  ) => {
    if (busyRef.current || isFrozen || !myFactionId) return;
    const next = { ...current, [field]: !current[field] };
    busyRef.current = true;
    setBusy(true);
    try {
      try {
        await api.updatePermissions(myFactionId, targetUid, next);
        onToast('権限を更新しました', 'success');
      } catch (err) {
        onToast((err as Error).message, 'error');
        return;
      }
      try {
        if (mountedRef.current) await loadFactionDetail(myFactionId, true);
      } catch {
        // 操作成功後の再取得失敗は操作失敗として扱わない
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleBulkPerms = async (perms: {
    can_declare_war: boolean;
    can_ceasefire: boolean;
    can_manage_members: boolean;
  }) => {
    if (busyRef.current || isFrozen || !myFactionId) return;
    busyRef.current = true;
    setBusy(true);
    try {
      try {
        await api.bulkUpdatePermissions(myFactionId, perms);
        onToast('全メンバーの権限を一括更新しました', 'success');
      } catch (err) {
        onToast((err as Error).message, 'error');
        return;
      }
      try {
        if (mountedRef.current) await loadFactionDetail(myFactionId, true);
      } catch {
        // 操作成功後の再取得失敗は操作失敗として扱わない
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleUpdateFactionSettings = async (
    allowAuto: boolean,
    joinPolicy?: number,
    colorIdOverride?: number
  ) => {
    if (busyRef.current || isFrozen || !myFactionId) return;
    busyRef.current = true;
    setBusy(true);
    try {
      try {
        await api.updateFactionSettings(myFactionId, {
          allow_auto_paint: allowAuto,
          join_policy: joinPolicy,
          color_id: colorIdOverride,
        });
        onToast(colorIdOverride !== undefined ? '勢力カラーを変更しました' : '勢力設定を更新しました', 'success');
      } catch (err) {
        onToast((err as Error).message, 'error');
        return;
      }
      try {
        if (mountedRef.current) await loadFactionDetail(myFactionId, true);
        await onRefresh();
      } catch {
        // 操作成功後の再取得失敗は操作失敗として扱わない
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleSaveAutoPaint = async (enabled: boolean, pct: number) => {
    if (busyRef.current || isFrozen) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await api.updateAutoPaint(enabled, pct);
      if (mountedRef.current) {
        setAutoPaintEnabled(res.auto_paint_enabled);
        setAutoPaintPct(res.auto_paint_pct);
      }
      await onRefresh();
      onToast(
        res.auto_paint_enabled
          ? `自動塗りを ON（保有APの ${res.auto_paint_pct}% 消費）に設定しました`
          : '自動塗りを OFF にしました',
        'success'
      );
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const isLeader = Boolean(user?.permissions.is_leader);
  const canEditPerms = Boolean(
    user && (user.permissions.is_leader || user.permissions.is_vice_leader)
  );

  // 副主権限を失った場合に勢力色タブが開かれたまま空表示にならないよう戻す
  useEffect(() => {
    if (!canEditPerms && factionTab === 'color') {
      setFactionTab('autopaint');
    }
  }, [canEditPerms, factionTab]);

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>勢力管理</h2>
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
            現在は凍結（結果発表）フェーズのため、勢力の設立・参加・脱退・設定変更などの操作はできません。
          </div>
        )}

        {!user && (
          <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
            勢力の設立・参加にはログインが必要です。
          </p>
        )}

        {user && myFactionId > 0 && (!detail || detail.id !== myFactionId) && (
          <div style={{ padding: '16px 0', fontSize: '13px', color: 'var(--text-muted)' }}>
            {/* 初回マウント時や勢力切替直後にエラー表示が一瞬フラッシュするのを防ぐため detailError の有無で分岐 */}
            {detailLoading || !detailError ? (
              '勢力情報を読み込み中...'
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <span style={{ color: '#fca5a5' }}>
                  {detailError ?? '勢力情報の取得に失敗しました。'}
                </span>
                <button
                  type="button"
                  class="btn btn-sm"
                  onClick={() => void loadFactionDetail(myFactionId)}
                >
                  再試行
                </button>
              </div>
            )}
          </div>
        )}

        {user && myFactionId > 0 && detail && detail.id === myFactionId && (
          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '10px 12px',
                background: 'rgba(15,23,42,0.7)',
                borderRadius: '10px',
                border: '1px solid var(--border-glass)',
              }}
            >
              <div>
                <div style={{ fontSize: '16px', fontWeight: 700 }}>
                  <span
                    class="color-dot"
                    style={{ background: PALETTE_HEX[detail.color_id] }}
                  />
                  {detail.name}
                  {detail.is_extinct && (
                    <span class="mini-badge badge-enclave" style={{ marginLeft: '8px' }}>
                      亡命政府（空き地に{enclaveBaseMultiplier}倍コストで再起可能）
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  領土: {detail.territory_count.toLocaleString()} / 中核:{' '}
                  {detail.core_count.toLocaleString()} / 初期中核残り:{' '}
                  {Math.max(0, initialCoreQuota - detail.initial_core_used)} ドット
                </div>
              </div>
              <button class="btn btn-danger btn-sm" disabled={busy || isFrozen} onClick={handleLeave}>
                脱退
              </button>
            </div>

            <div class="help-tabs" style={{ marginTop: '12px' }}>
              <button
                type="button"
                class={`btn btn-sm ${factionTab === 'autopaint' ? 'btn-primary' : ''}`}
                onClick={() => setFactionTab('autopaint')}
              >
                自動塗り・方針
              </button>
              {canEditPerms && (
                <button
                  type="button"
                  class={`btn btn-sm ${factionTab === 'color' ? 'btn-primary' : ''}`}
                  onClick={() => setFactionTab('color')}
                >
                  勢力色
                </button>
              )}
              <button
                type="button"
                class={`btn btn-sm ${factionTab === 'members' ? 'btn-primary' : ''}`}
                onClick={() => setFactionTab('members')}
              >
                メンバー・権限 ({detail.members.length})
              </button>
            </div>

            {factionTab === 'autopaint' && (
              <>
            {/* 自動塗り（個人設定） */}
            <div class="section-title">自動塗り設定（Tickごとに割合消費して自動拡大）</div>
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '10px',
                background: 'rgba(15,23,42,0.55)',
                border: '1px solid var(--border-glass)',
                marginBottom: '10px',
              }}
            >
              {!detail.allow_auto_paint ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ fontSize: '12px', color: '#fca5a5' }}>
                    現在、勢力方針により自動塗り機能は無効化されています。
                  </div>
                  {(user.auto_paint_enabled || autoPaintEnabled) && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                        個人の自動塗り設定が ON のまま残っています（方針変更や移籍時に再開されます）。
                      </span>
                      <button
                        type="button"
                        class="btn btn-sm"
                        disabled={busy || isFrozen}
                        onClick={() => {
                          const pct = Math.min(100, Math.max(1, Number(autoPaintPct || 50)));
                          void handleSaveAutoPaint(false, pct);
                        }}
                      >
                        個人設定を OFF にする
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={autoPaintEnabled}
                      disabled={busy || isFrozen}
                      onChange={(e) => setAutoPaintEnabled((e.target as HTMLInputElement).checked)}
                    />
                    <span>自動塗りを有効にする</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                    <span>消費割合:</span>
                    <input
                      type="number"
                      class="input"
                      style={{ width: '64px', padding: '3px 6px', fontSize: '12px' }}
                      min={1}
                      max={100}
                      disabled={busy || isFrozen}
                      value={autoPaintPct}
                      onInput={(e) => setAutoPaintPct(parseIntInput((e.target as HTMLInputElement).value))}
                      onBlur={() =>
                        setAutoPaintPct((v) => (v === '' ? 50 : Math.min(100, Math.max(1, v))))
                      }
                    />
                    <span>%</span>
                  </label>
                  <button
                    type="button"
                    class="btn btn-primary btn-sm"
                    disabled={busy || isFrozen}
                    onClick={() => {
                      const pct = Math.min(100, Math.max(1, Number(autoPaintPct || 1)));
                      setAutoPaintPct(pct);
                      void handleSaveAutoPaint(autoPaintEnabled, pct);
                    }}
                  >
                    設定保存
                  </button>
                </div>
              )}
            </div>

            {/* 勢力方針設定（勢力主・副主のみ） */}
            {canEditPerms && (
              <>
                <div class="section-title">勢力方針設定（勢力主・副主のみ）</div>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '10px',
                    alignItems: 'center',
                    padding: '8px 12px',
                    borderRadius: '10px',
                    background: 'rgba(15,23,42,0.55)',
                    border: '1px solid var(--border-glass)',
                    marginBottom: '10px',
                    fontSize: '12px',
                  }}
                >
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={detail.allow_auto_paint}
                      disabled={busy || isFrozen}
                      onChange={(e) =>
                        void handleUpdateFactionSettings(
                          (e.target as HTMLInputElement).checked
                        )
                      }
                    />
                    <span>勢力全体で自動塗りを許可</span>
                  </label>
                  <button
                    type="button"
                    class={`btn btn-sm ${(detail.join_policy ?? 0) === 0 ? 'btn-primary' : ''}`}
                    disabled={busy || isFrozen}
                    onClick={() =>
                      void handleUpdateFactionSettings(
                        detail.allow_auto_paint,
                        0
                      )
                    }
                  >
                    参加方式: 自由参加
                  </button>
                  <button
                    type="button"
                    class={`btn btn-sm ${detail.join_policy === 1 ? 'btn-gold' : ''}`}
                    disabled={busy || isFrozen}
                    onClick={() =>
                      void handleUpdateFactionSettings(
                        detail.allow_auto_paint,
                        1
                      )
                    }
                  >
                    参加方式: 参加許可制
                  </button>
                </div>
              </>
            )}
              </>
            )}

            {factionTab === 'color' && canEditPerms && (
              <div class="form-field" style={{ marginTop: '10px' }}>
                <label>
                  勢力カラー変更（他勢力と重複不可）:{' '}
                  <span
                    class="color-dot"
                    style={{ background: PALETTE_HEX[detail.color_id] }}
                  />
                  ID #{detail.color_id}
                </label>
                <div class="field-hint" style={{ marginBottom: '8px' }}>
                  勢力カラーを変更すると、独自に色変更（マス色変更）していない自勢力マスも新しい勢力色に自動で切り替わります。
                </div>
                <div class="palette-grid">
                  {(() => {
                    // 自勢力を除外して他勢力の使用色を判定し、リスト更新遅延による旧色の誤ブロックを防ぐ
                    const otherUsedColors = new Set(
                      factions.filter((f) => f.id !== detail.id).map((f) => f.color_id)
                    );
                    return PALETTE_HEX.map((hex, idx) => {
                      const isUsedByOther = otherUsedColors.has(idx);
                      const disabled = busy || isFrozen || isUsedByOther;
                    return (
                      <button
                        key={idx}
                        type="button"
                        class={`swatch ${detail.color_id === idx ? 'selected' : ''} ${isUsedByOther ? 'used' : ''}`}
                        style={{ background: hex }}
                        disabled={disabled}
                        title={
                          isUsedByOther
                            ? `ID #${idx}（他勢力が使用中）`
                            : `ID #${idx} (${hex})`
                        }
                        onClick={() => {
                          if (idx === detail.color_id) return;
                          void handleUpdateFactionSettings(
                            detail.allow_auto_paint,
                            detail.join_policy,
                            idx
                          );
                        }}
                      />
                    );
                    });
                  })()}
                </div>
              </div>
            )}

            {factionTab === 'members' && (
              <>
                {user.permissions.can_manage_members &&
                  (user.incoming_join_requests?.length ?? 0) > 0 && (
                    <div class="notif-inline-box">
                      <div class="section-title" style={{ marginTop: 0 }}>
                        参加申請 ({user.incoming_join_requests.length})
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {user.incoming_join_requests.map((req) => (
                          <div key={req.id} class="notif-inline-row">
                            <span>
                              <strong>{req.username}</strong> からの参加申請
                            </span>
                            <div style={{ display: 'flex', gap: '6px' }}>
                              <button
                                type="button"
                                class="btn btn-sm btn-primary"
                                disabled={busy || isFrozen}
                                onClick={() => void handleAcceptJoinRequest(req.id)}
                              >
                                承認
                              </button>
                              <button
                                type="button"
                                class="btn btn-sm"
                                disabled={busy || isFrozen}
                                onClick={() => void handleRejectJoinRequest(req.id)}
                              >
                                拒否
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
            <div class="section-title">メンバー一覧と権限設定</div>
            {canEditPerms && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                <button
                  type="button"
                  class="btn btn-sm"
                  disabled={busy || isFrozen}
                  onClick={() =>
                    void handleBulkPerms({
                      can_declare_war: true,
                      can_ceasefire: true,
                      can_manage_members: true,
                    })
                  }
                >
                  全員に全権限付与
                </button>
                <button
                  type="button"
                  class="btn btn-sm"
                  disabled={busy || isFrozen}
                  onClick={() =>
                    void handleBulkPerms({
                      can_declare_war: false,
                      can_ceasefire: false,
                      can_manage_members: false,
                    })
                  }
                >
                  全員全権限剥奪
                </button>
              </div>
            )}
            <div class="table-scroll">
            <table class="list-table">
              <thead>
                <tr>
                  <th>ユーザー</th>
                  <th>副主</th>
                  <th>開戦</th>
                  <th>停戦</th>
                  <th>承認/追放</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {detail.members.map((m) => {
                  // 副主ログイン時は自分自身・他副主・副主任命欄を変更不可とし、副主行の個別権限も固定にする
                  const rowPermDisabled =
                    busy ||
                    isFrozen ||
                    m.is_leader ||
                    m.is_vice_leader ||
                    !canEditPerms ||
                    (!isLeader && m.user_id === user.id);
                  const canKickTarget =
                    !m.is_leader &&
                    m.user_id !== user.id &&
                    user.permissions.can_manage_members &&
                    (!m.is_vice_leader || isLeader);
                  return (
                  <tr key={m.user_id}>
                    <td>
                      {m.username}{' '}
                      {m.is_leader && (
                        <span class="mini-badge badge-core">勢力主</span>
                      )}
                      {!m.is_leader && m.is_vice_leader && (
                        <span class="mini-badge badge-art">副主</span>
                      )}
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={m.is_leader || m.is_vice_leader}
                        disabled={busy || isFrozen || m.is_leader || !isLeader}
                        onChange={() => togglePerm(m.user_id, m, 'is_vice_leader')}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={m.is_leader || m.is_vice_leader || m.can_declare_war}
                        disabled={rowPermDisabled}
                        onChange={() => togglePerm(m.user_id, m, 'can_declare_war')}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={m.is_leader || m.is_vice_leader || m.can_ceasefire}
                        disabled={rowPermDisabled}
                        onChange={() => togglePerm(m.user_id, m, 'can_ceasefire')}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={m.is_leader || m.is_vice_leader || m.can_manage_members}
                        disabled={rowPermDisabled}
                        onChange={() => togglePerm(m.user_id, m, 'can_manage_members')}
                      />
                    </td>
                    <td>
                      {canKickTarget && (
                          <button
                            class="btn btn-danger btn-sm"
                            disabled={busy || isFrozen}
                            onClick={() => handleKick(m.user_id)}
                          >
                            追放
                          </button>
                        )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
              </>
            )}
          </div>
        )}

        {user && myFactionId === 0 && (
          <div>
            <div class="section-title">新しい勢力を設立</div>
            {isPreparation && (
              <div
                style={{
                  padding: '8px 12px',
                  marginBottom: '10px',
                  borderRadius: '8px',
                  background: 'rgba(245,158,11,0.14)',
                  border: '1px solid rgba(245,158,11,0.35)',
                  color: '#fcd34d',
                  fontSize: '12px',
                }}
              >
                準備フェーズ中は新しい勢力を設立できません（開催開始後に設立できます）。
              </div>
            )}
            <form onSubmit={handleCreate}>
              <div class="form-field">
                <label>勢力名（1〜{maxNameLen}文字）</label>
                <input
                  class="input"
                  maxLength={maxNameLen}
                  disabled={busy || cannotCreateFaction}
                  placeholder="例: 枯山水共和国"
                  value={name}
                  onInput={(e) => setName((e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="form-field">
                <label>
                  勢力カラー選択（64色パレット / 重複不可）:{' '}
                  <span
                    class="color-dot"
                    style={{ background: PALETTE_HEX[colorId] }}
                  />
                  ID #{colorId}
                </label>
                <div class="palette-grid">
                  {PALETTE_HEX.map((hex, idx) => {
                    const isUsed = usedColors.has(idx);
                    return (
                      <button
                        key={idx}
                        type="button"
                        class={`swatch ${colorId === idx ? 'selected' : ''} ${isUsed ? 'used' : ''}`}
                        style={{ background: hex }}
                        disabled={busy || cannotCreateFaction || isUsed}
                        title={isUsed ? `ID #${idx}（他勢力が使用中）` : `ID #${idx} (${hex})`}
                        onClick={() => setColorId(idx)}
                      />
                    );
                  })}
                </div>
              </div>
              <button
                class="btn btn-primary"
                type="submit"
                disabled={busy || cannotCreateFaction || !name.trim() || usedColors.has(colorId)}
              >
                勢力を設立する
              </button>
            </form>

            <div class="section-title">既存勢力に参加</div>
            <div class="table-scroll">
            <table class="list-table">
              <thead>
                <tr>
                  <th>勢力</th>
                  <th>領土</th>
                  <th>人数</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {factions.map((f) => {
                  const isApprovalOnly = f.join_policy === 1;
                  const hasRequested =
                    user.outgoing_join_request_faction_ids?.includes(f.id) ?? false;
                  return (
                    <tr key={f.id}>
                      <td>
                        <span
                          class="color-dot"
                          style={{ background: PALETTE_HEX[f.color_id] }}
                        />
                        {f.name}
                        {isApprovalOnly && (
                          <span class="mini-badge badge-enclave" style={{ marginLeft: '6px' }}>
                            参加許可制
                          </span>
                        )}
                      </td>
                      <td>{f.territory_count}</td>
                      <td>{f.member_count}</td>
                      <td>
                        {isApprovalOnly ? (
                          <button
                            class="btn btn-sm"
                            disabled={busy || isFrozen || hasRequested}
                            onClick={() => void handleRequestJoin(f.id)}
                          >
                            {hasRequested ? '申請中' : '参加申請'}
                          </button>
                        ) : (
                          <button
                            class="btn btn-sm"
                            disabled={busy || isFrozen}
                            onClick={() => handleJoin(f.id)}
                          >
                            参加
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {factions.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ color: 'var(--text-muted)' }}>
                      まだ勢力が存在しません。最初の勢力を設立しましょう！
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
