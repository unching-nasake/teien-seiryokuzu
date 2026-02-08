import { memo, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

function AlliancePanel({
  onClose,
  alliances,
  truces,
  wars = {}, // [Fix] Receive wars from props with default
  factions,
  playerData,
  onCreateAlliance,
  onJoinRequest,
  onAcceptRequest,
  onLeaveAlliance,
  onKickMember,
  onDisbandAlliance,
  onRequestTruce,
  onAcceptTruce,
  onRejectTruce,
  onCallToArms,
  onShowFactionDetails
}) {
  const [activeTab, setActiveTab] = useState('myAlliance'); // myAlliance, truces

  const [createName, setCreateName] = useState('');
  // Random initial color
  const [createColor, setCreateColor] = useState(() => {
    const letters = '0123456789ABCDEF';
    let color = '#';
    for (let i = 0; i < 6; i++) {
        color += letters[Math.floor(Math.random() * 16)];
    }
    return color;
  });
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('#000000');
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedTrucePartner, setSelectedTrucePartner] = useState('');
  const [selectedInviteFaction, setSelectedInviteFaction] = useState('');
  const [selectedTruceDuration, setSelectedTruceDuration] = useState(1);

  const calculateExpiry = (hours) => {
    const now = new Date();
    // Round to next hour
    const target = new Date(now);
    target.setMinutes(0, 0, 0);
    target.setHours(target.getHours() + parseInt(hours));
    // If rounded down (e.g. 16:05 -> 16:00 + 1h = 17:00), it's fine.
    // Wait, if it's 16:05, and we set minutes=0, it becomes 16:00.
    // Then +1h = 17:00.
    // If it's 16:59 -> 16:00 + 1h = 17:00. (1 min truce)
    // To ensure "at least some time", maybe we should check?
    // But adhering to the user's "17:00, 19:00..." example implies strict clock alignment.
    // If the resultant time is in the past or very close, it's the user's choice.
    // However, if target <= now, we should probably add another hour?
    // "16:37 -> 1h -> 17:00". Target > Now.
    // "16:37 -> 12h -> 04:00".
    // What if 23:59 -> 1h (24:00)? Yes.
    // The only edge case is if we select "1h" at "16:00:01". It becomes 17:00. (59m59s).
    // If we select "1h" at "16:59:59". It becomes 17:00. (1s).
    // This seems to be the spec.
    // But, if we are ALREADY past the target (e.g. somehow logic is slow),
    // calculateExpiry creates a future date anyway.
    if (target <= now) {
       // If we rounded down and it's less than now (only possible if duration=0 which isn't an option, or tight timing)
       // Actually 16:37 -> 16:00 + 1 = 17:00 > 16:37. Always future if hours >= 1.
    }
    return target;
  };

  const getDurationLabel = (hours) => {
      const expiry = calculateExpiry(hours);
      return `${hours}h後 (${expiry.getMonth()+1}/${expiry.getDate()} ${expiry.getHours()}:00)`;
  };

  // [REMOVED] Local war state (Using props for real-time update)


  const myFactionId = playerData?.factionId;
  const myFaction = factions[myFactionId];
  const myAllianceId = myFaction?.allianceId;
  const myAlliance = alliances[myAllianceId];
  const isLeader = myFaction?.kingId === playerData?.id;
  const isAllianceLeader = myAlliance?.leaderId === myFactionId;
  const canDiplomacy = isLeader || !!playerData?.permissions?.canDiplomacy || !!playerData?.permissions?.canRequestTruce;

  useEffect(() => {
    if (myAlliance) {
      setEditName(myAlliance.name);
      setEditColor(myAlliance.color);
    }
  }, [myAlliance?.id]);

  // 自勢力が参加している戦争を抽出 (Propsから計算)
  const activeWars = Object.values(wars || {}).filter(w =>
    (w.attackerSide && w.attackerSide.factions.includes(myFactionId)) ||
    (w.defenderSide && w.defenderSide.factions.includes(myFactionId))
  );

  // アクションハンドララッパー

  const handleAction = async (fn, ...args) => {
    if (!fn) return;
    setIsProcessing(true);
    try {
      const res = await fn(...args);
      if (res && res.message) alert(res.message);
      if (res && res.error) alert(res.error);
    } catch (e) {
      console.error(e);
      alert("エラーが発生しました");
    } finally {
      setIsProcessing(false);
    }
  };

  // タブ切り替え
  const renderTabs = () => (
    <div className="premium-tabs">
      <button
        className={`premium-tab-btn ${activeTab === 'myAlliance' ? 'active' : ''}`}
        onClick={() => setActiveTab('myAlliance')}
      >
        自同盟
      </button>
      <button
        className={`premium-tab-btn ${activeTab === 'truces' ? 'active' : ''}`}
        onClick={() => setActiveTab('truces')}
      >
        停戦
      </button>
    </div>
  );


  // 同盟一覧表示
  const renderList = () => (
    <>
      <div className="space-y-4 px-1 flex-1 min-h-0">
      {Object.values(alliances).length === 0 && <p className="text-gray-500 text-center py-8">同盟はまだありません</p>}

      {Object.values(alliances)
          .filter(a => {
              // [NEW] 戦争チェック: 自分の勢力と戦争中のメンバーがいる同盟は非表示
              const hasWarWithMe = a.members.some(memberId => {
                  return Object.values(wars).some(w =>
                      (w.attackerSide.factions.includes(myFactionId) && w.defenderSide.factions.includes(memberId)) ||
                      (w.attackerSide.factions.includes(memberId) && w.defenderSide.factions.includes(myFactionId))
                  );
              });
              if (hasWarWithMe) return false;
              return true;
          })
          .map(a => (
        <div key={a.id} className="premium-card relative overflow-hidden group hover:shadow-xl transition-all duration-300 border border-white/10 bg-white/5 py-4 px-5 flex items-center justify-between">
          <div className="absolute top-0 right-0 p-2 opacity-5 group-hover:opacity-10 transition-opacity pointer-events-none">
              <span className="text-4xl">🤝</span>
          </div>

          <div className="flex items-center gap-3 relative z-10 min-w-0">
             <div className="w-3 h-10 rounded-full shadow-[0_0_10px_rgba(0,0,0,0.5)]" style={{ background: a.color }}></div>
             <span className="font-bold text-xl truncate break-all drop-shadow-md" style={{ color: a.color }}>{a.name}</span>
          </div>

          {/* 加盟申請ボタン: 自分が同盟未所属かつ外交権限がある場合 */}
          {canDiplomacy && !myAllianceId && (
            <div className="relative z-10 ml-4 flex-shrink-0">
                <button
                    onClick={() => {
                        if (confirm(`「${a.name}」に加盟申請を送りますか？`)) {
                             handleAction(onJoinRequest, a.leaderId);
                        }
                    }}
                    className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg shadow-lg shadow-blue-500/20 text-xs font-bold transition-all transform hover:-translate-y-0.5 whitespace-nowrap"
                >
                    加盟申請
                </button>
            </div>
          )}
        </div>
      ))}
      </div>


    </>
  );

  // 自同盟管理
  const renderMyAlliance = () => {
    if (!myAllianceId) {
        return (
            <div className="space-y-6 px-1 flex-1">
                 <div className="mb-8">
                     <h3 className="font-bold text-lg mb-4 text-white border-b border-white/10 pb-2">既存の同盟一覧</h3>
                     {renderList()}
                 </div>

                 <div className="border-t border-white/10 pt-6">
                    <h3 className="font-bold text-lg mb-4 text-white flex items-center gap-2">
                        <span>✨</span> 新しい同盟を設立
                    </h3>

                    {canDiplomacy ? (
                        <div className="premium-card bg-gradient-to-br from-blue-900/20 to-black border-blue-500/30 shadow-lg shadow-blue-500/5">
                             <div className="space-y-4">
                                 {/* 同盟名入力欄 */}
                                 <div className="w-full">
                                    <label className="text-xs text-gray-400 block mb-2 ml-1 font-bold uppercase tracking-wider">同盟名</label>
                                    <input
                                        type="text"
                                        placeholder="同盟名を入力..."
                                        maxLength={20}
                                        value={createName}
                                        onChange={e => setCreateName(e.target.value)}
                                        className="input w-full bg-black bg-opacity-40 border-opacity-30 focus:border-blue-500 focus:bg-opacity-60 transition-all py-3 px-4 rounded-xl text-center font-bold text-lg text-white placeholder-gray-600"
                                     />
                                 </div>

                                 {/* テーマカラー欄（同盟名の下に縦並びで配置） */}
                                 <div className="w-full">
                                    <label className="text-xs text-gray-400 block mb-2 ml-1 font-bold uppercase tracking-wider">テーマカラー</label>
                                    <div className="flex flex-col gap-3 bg-black bg-opacity-40 p-3 rounded-xl border border-white border-opacity-10 transition-colors hover:border-white/20">
                                        {/* カラーピッカー */}
                                        <div className="w-full flex justify-center">
                                            <input
                                                type="color"
                                                value={createColor}
                                                onChange={e => setCreateColor(e.target.value)}
                                                className="h-12 w-full max-w-[200px] p-0 border-none rounded cursor-pointer bg-transparent block"
                                            />
                                        </div>
                                        {/* カラーコード入力欄 */}
                                        <input
                                            type="text"
                                            value={createColor}
                                            onChange={e => setCreateColor(e.target.value)}
                                            className="w-full bg-transparent text-sm font-mono text-white border border-white/20 focus:border-blue-500 outline-none py-2 px-3 rounded-lg uppercase text-center"
                                            placeholder="#RRGGBB"
                                        />
                                    </div>
                                 </div>
                             </div>

                             {/* 同盟設立ボタン（青色） */}
                             <button
                                onClick={() => handleAction(onCreateAlliance, createName, createColor)}
                                className="btn w-full py-3.5 font-bold shadow-lg shadow-blue-500/20 text-base tracking-widest rounded-xl relative overflow-hidden group mt-6 bg-blue-600 hover:bg-blue-500 text-white transition-all transform hover:-translate-y-0.5 border border-blue-400/30"
                                disabled={isProcessing || !createName.trim()}
                            >
                                <span className="relative z-10 transition-transform group-hover:scale-105 inline-block text-blue-200">
                                    {isProcessing ? '設立中...' : '同盟設立'}
                                </span>
                                <div className="absolute inset-0 bg-white opacity-0 group-hover:opacity-10 transition-opacity"></div>
                            </button>
                        </div>
                    ) : (
                         <div className="w-full p-6 bg-yellow-500 bg-opacity-10 rounded-xl border border-yellow-500 border-opacity-20 text-center text-yellow-200 text-sm flex flex-col items-center gap-3 shadow-lg">
                            <span className="text-3xl">⚠️</span>
                            <span className="font-bold">同盟の設立には勢力主または外交権限が必要です</span>
                        </div>
                    )}
                 </div>
            </div>
        );
    };

    if (activeTab === 'myAlliance' && !myAllianceId) return renderMyAlliance();

    if (!myAlliance) return <div className="text-center py-10">読み込み中...</div>;

    const lockedUntil = myAlliance.memberJoinedAt?.[myFactionId]
        ? new Date(new Date(myAlliance.memberJoinedAt[myFactionId]).getTime() + 12 * 60 * 60 * 1000)
        : null;
    const isLocked = lockedUntil && lockedUntil > new Date();

    return (
        <div className="space-y-6 flex-1 pb-10 w-full min-w-0">
            {/* Header */}
            <div className="alliance-header rounded-xl overflow-hidden relative shadow-lg" style={{ '--alliance-color': myAlliance.color }}>
                    <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"></div>
                    <div className="relative z-10 w-full block text-center px-4 py-6">
                        <h2 className="text-3xl font-black mb-2 text-white drop-shadow-lg inline-block max-w-full break-all whitespace-normal leading-normal tracking-tight">
                            {myAlliance.name}
                        </h2>
                         {/* Leader Badge */}
                         <div className="flex justify-center w-full mt-2 px-2">
                             <div className="flex items-center justify-center gap-2 text-sm text-emerald-300 bg-black bg-opacity-60 px-5 py-1.5 rounded-full border border-emerald-500 border-opacity-30 shadow-lg animate-pulse-glow max-w-[90%] mx-auto">
                                 <span className="truncate min-w-0 font-bold ml-1">　👑 盟主: {factions[myAlliance.leaderId]?.name || '不明'}</span>
                             </div>
                         </div>
                    </div>
                  </div>

                 <div className="stats-grid grid grid-cols-2 gap-4 w-full min-w-0">
                    <div className="stat-box flex flex-col items-center p-3 bg-white/5 rounded-lg border border-white/5 shadow-sm">
                        <div className="stat-value text-xl font-bold text-white">
                          {myAlliance.members.length}
                        </div>
                        <div className="text-xs text-gray-400 uppercase tracking-wider">加盟勢力数</div>
                    </div>
                    <div className="stat-box flex flex-col items-center p-3 bg-white/5 rounded-lg border border-white/5 shadow-sm">
                        <div className="stat-value text-xl font-bold text-blue-300">
                          {(() => {
                            const total = myAlliance.members.reduce((sum, mid) => sum + (factions[mid]?.members?.length || 0), 0);
                            const active = myAlliance.members.reduce((sum, mid) => sum + (factions[mid]?.activeMemberCount || 0), 0);
                            return `${total} (${active})`;
                          })()}
                        </div>
                        <div className="stat-label text-xs text-gray-400 uppercase tracking-wider">総メンバー数</div>
                    </div>
                    <div className="stat-box flex flex-col items-center p-3 bg-white/5 rounded-lg border border-white/5 shadow-sm">
                        <div className="stat-value text-xl font-bold text-amber-400">{Object.values(factions).filter(f => myAlliance.members.includes(f.id)).reduce((a, b) => a + (b.totalPoints || 0), 0)}</div>
                        <div className="stat-label text-xs text-gray-400 uppercase tracking-wider">総ポイント</div>
                    </div>
                     <div className="stat-box flex flex-col items-center p-3 bg-white/5 rounded-lg border border-white/5 shadow-sm">
                        <div className="stat-value text-xl font-bold text-blue-400">
                             {Object.values(factions).filter(f => myAlliance.members.includes(f.id)).reduce((a, b) => a + (b.tileCount || 0), 0)}
                        </div>
                        <div className="stat-label text-xs text-gray-400 uppercase tracking-wider">総領土</div>
                    </div>
                 </div>

             {/* Alliance Invitation (Leader) */}
             {isAllianceLeader && canDiplomacy && (
                 <div className="premium-card bg-emerald-500 bg-opacity-5 border-emerald-500 border-opacity-20 shadow-lg shadow-emerald-500/5 w-full min-w-0">
                     <h4 className="font-bold text-emerald-400 text-xs mb-4 uppercase tracking-widest flex items-center gap-2">
                        <span>✨</span>
                        <span>勢力を同盟に招待</span>
                     </h4>
                     <div className="flex flex-col gap-3">
                         <select
                             className="input w-full text-sm bg-black bg-opacity-40 py-3 px-4 border border-white/10 rounded-xl focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all appearance-none"
                             value={selectedInviteFaction}
                             onChange={(e) => setSelectedInviteFaction(e.target.value)}
                         >
                             <option value="" disabled>勢力を選択...</option>
                             {Object.values(factions)
                                 .filter(f => {
                                     // 基本条件: 自分以外、未所属
                                     if (f.id === myFactionId || f.allianceId) return false;

                                     // [NEW] 戦争チェック: 自分の同盟メンバーのいずれかと戦争中の勢力は除外
                                     const isAtWarWithAlliance = myAlliance.members.some(memberId => {
                                         return activeWars.some(w =>
                                             (w.attackerSide.factions.includes(memberId) && w.defenderSide.factions.includes(f.id)) ||
                                             (w.attackerSide.factions.includes(f.id) && w.defenderSide.factions.includes(memberId))
                                         );
                                     });
                                     if (isAtWarWithAlliance) return false;

                                     return true;
                                 })
                                 .sort((a,b) => (b.totalPoints || 0) - (a.totalPoints || 0))
                                 .map(f => (
                                     <option key={f.id} value={f.id}>{f.name} ({f.members?.length || 0}人)</option>
                                 ))
                             }
                         </select>
                         <div className="w-full mt-2">
                             <button
                                 className="btn w-full text-sm py-3 px-6 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold shadow-lg shadow-emerald-500/20 transition-all transform hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
                                 disabled={!selectedInviteFaction || isProcessing}
                                 onClick={() => {
                                     const target = factions[selectedInviteFaction];
                                     if (confirm(`「${target?.name}」に同盟加盟申請を送りますか？`)) {
                                         handleAction(onJoinRequest, selectedInviteFaction);
                                         setSelectedInviteFaction('');
                                     }
                                 }}
                             >
                                 招待を送る
                             </button>
                         </div>
                     </div>
                 </div>
             )}

            {/* Alliance Settings (Leader) */}
            {isAllianceLeader && canDiplomacy && (
                <div className="premium-card bg-white/5 border-white/10">
                     <details className="group">
                        <summary className="flex items-center gap-2 cursor-pointer list-none font-bold text-gray-400 text-xs uppercase tracking-widest hover:text-white transition-colors">
                            <span className="transform group-open:rotate-90 transition-transform">▶</span>
                            同盟設定・編集
                        </summary>
                        <div className="mt-4 animate-slide-down">
                            <div className="flex flex-col gap-3 mb-4">
                                <input
                                    type="text"
                                    placeholder="新同盟名"
                                    value={editName || myAlliance.name}
                                    onChange={e => setEditName(e.target.value)}
                                    className="input w-full text-sm py-3 px-4 bg-black/40 border-white/10 rounded-xl focus:border-blue-500 transition-all"
                                />
                                <div className="flex items-center justify-between gap-3 bg-black/40 p-2 rounded-xl border border-white/10 w-full min-w-[120px]">
                                     <input
                                        type="color"
                                        value={editColor}
                                        onChange={e => setEditColor(e.target.value)}
                                        className="h-10 w-10 p-0 border-none bg-transparent cursor-pointer rounded-lg flex-shrink-0"
                                    />
                                    <span className="text-xs font-mono text-gray-400">{editColor}</span>
                                </div>
                            </div>
                            <button
                                onClick={() => handleAction(onCreateAlliance, editName || myAlliance.name, editColor || myAlliance.color, true)}
                                className="btn w-full py-3 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-bold shadow-lg shadow-blue-500/20 transition-all transform hover:-translate-y-0.5"
                                disabled={isProcessing}
                            >
                                設定を保存
                            </button>
                        </div>
                     </details>
                </div>
            )}

            {/* Pending Requests */}
            {isAllianceLeader && canDiplomacy && myAlliance.pendingRequests && myAlliance.pendingRequests.length > 0 && (
                <div className="premium-card bg-yellow-500 bg-opacity-5 border-yellow-500 border-opacity-20 animate-pulse-glow">
                    <h4 className="font-bold text-yellow-500 text-xs mb-3 uppercase tracking-widest flex items-center gap-2">
                        ⚠️ 加盟申請 ({myAlliance.pendingRequests.length})
                    </h4>
                    <div className="space-y-2">
                        {myAlliance.pendingRequests.map(fid => (
                            <div key={fid} className="flex flex-col justify-between items-center bg-white bg-opacity-5 p-3 rounded-xl border border-white border-opacity-5 gap-3">
                                <span className="font-medium flex items-center gap-2">
                                    <span className="w-3 h-3 rounded-full shadow-sm" style={{ background: factions[fid]?.color }}></span>
                                    {factions[fid]?.name || fid}
                                </span>
                                <button
                                    onClick={() => {
                                        if (confirm("この勢力の加盟申請を承認しますか？")) {
                                            handleAction(onAcceptRequest, myAlliance.id, fid);
                                        }
                                    }}
                                    className="w-full px-6 py-2 bg-blue-500 text-white text-sm rounded-lg font-bold hover:bg-blue-600 transition-colors shadow-lg shadow-blue-500/20"
                                >
                                    承認
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Active Wars and Call to Arms */}
            {activeWars.length > 0 && (
                <div className="premium-card bg-red-500 bg-opacity-5 border-red-500 border-opacity-20 shadow-red-500/10 shadow-lg">
                    <h4 className="font-bold text-red-500 text-xs mb-3 uppercase tracking-widest flex items-center gap-2">
                        ⚔️ 参加中の戦争 ({activeWars.length})
                    </h4>
                    <div className="space-y-4">
                        {activeWars.map(war => {
                            const isAttacker = war.attackerSide.factions.includes(myFactionId);
                            const sideLabel = isAttacker ? "攻撃側" : "防衛側";
                            const enemyLeaderId = isAttacker ? war.defenderSide.leaderId : war.attackerSide.leaderId;
                            const enemyName = factions[enemyLeaderId]?.name || "不明";

                            return (
                                <div key={war.id} className="bg-black bg-opacity-40 p-4 rounded-xl border border-red-500 border-opacity-20 shadow-inner">
                                    <div className="flex justify-between items-center mb-4 pb-2 border-b border-white/5">
                                        <div className="font-bold text-sm text-red-100">
                                            vs {enemyName} <span className="text-[10px] text-gray-400 ml-2 bg-white/5 px-2 py-0.5 rounded">({sideLabel})</span>
                                        </div>
                                    </div>

                                    <div className="flex flex-col gap-3">
                                        {/* Call to Arms */}
                                        <button
                                            onClick={() => {
                                                if (confirm("同盟メンバー全員に参戦を呼びかけますか？")) {
                                                    handleAction(onCallToArms, war.id);
                                                }
                                            }}
                                            className="w-full py-3 bg-red-600 hover:bg-red-500 text-white border border-red-500 border-opacity-30 rounded-lg text-xs font-bold transition-all shadow-lg shadow-red-600/20"
                                        >
                                            📢 全員へ参戦要請 (Call to Arms)
                                        </button>

                                        {/* Propose to individual (Dropdown) */}
                                        <div className="flex w-full">
                                            <select
                                                id={`propose-select-${war.id}`}
                                                className="input w-full text-xs bg-black bg-opacity-60 py-2.5 px-3 border-white/10 rounded-lg focus:border-red-500 transition-all appearance-none"
                                                defaultValue=""
                                                onChange={(e) => {
                                                    const targetId = e.target.value;
                                                    if (!targetId) return;
                                                    if (confirm(`${factions[targetId]?.name}に参戦を提案しますか？`)) {
                                                        fetch('/api/alliances/propose-participation', {
                                                            method: 'POST',
                                                            headers: { 'Content-Type': 'application/json' },
                                                            body: JSON.stringify({ warId: war.id, targetFactionId: targetId })
                                                        }).then(r => r.json()).then(data => {
                                                            if (data.success) alert("提案を送信しました");
                                                            else alert(data.error || "送信に失敗しました");
                                                        }).catch(console.error);
                                                    }
                                                    e.target.value = "";
                                                }}
                                            >
                                                <option value="" disabled>特定のメンバーに参戦提案...</option>
                                                {myAlliance.members
                                                    .filter(mid => mid !== myFactionId && !war.attackerSide.factions.includes(mid) && !war.defenderSide.factions.includes(mid))
                                                    .map(mid => (
                                                        <option key={mid} value={mid}>{factions[mid]?.name}</option>
                                                    ))
                                                }
                                            </select>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Members Grid */}
            <div>
                <h4 className="font-bold text-xs mb-3 text-gray-400 uppercase tracking-widest flex items-center justify-between">
                    <span>メンバー勢力</span>
                    <span className="bg-white bg-opacity-10 px-2 py-0.5 rounded text-[10px] font-mono">{myAlliance.members.length}</span>
                </h4>
                <div className="grid grid-cols-1 gap-4 w-full min-w-0">
                    {[...myAlliance.members].sort((a, b) => {
                        if (a === myAlliance.leaderId) return -1;
                        if (b === myAlliance.leaderId) return 1;
                        return (factions[b]?.totalPoints || 0) - (factions[a]?.totalPoints || 0);
                    }).map(mid => {
                        const mFaction = factions[mid];
                        const isMe = mid === myFactionId;
                        const isMemberLeader = mid === myAlliance.leaderId;

                        return (
                            <div key={mid} className="relative bg-[#1e1e1e] rounded-xl overflow-hidden shadow-md hover:shadow-xl transition-all duration-300 group border border-white/5">
                                {/* Decorator Bar */}
                                <div className="h-1.5 w-full" style={{ background: mFaction?.color || '#fff' }}></div>

                                <div className="p-4">
                                    <div className="flex items-start gap-3">
                                        <div
                                            className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center font-bold text-black border-2 border-white/10 shadow-sm"
                                            style={{ background: mFaction?.color || '#fff' }}
                                        >
                                            {mFaction?.name?.substring(0, 1) || '?'}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1.5 mb-0.5">
                                                <button
                                                    onClick={() => onShowFactionDetails && onShowFactionDetails(mid)}
                                                    className="font-bold text-base text-white hover:text-blue-400 transition-colors truncate block max-w-full"
                                                >
                                                    {mFaction?.name}
                                                </button>
                                                {isMemberLeader && <span title="盟主" className="text-yellow-400 text-xs drop-shadow-sm flex-shrink-0">👑</span>}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Action Buttons */}
                                    {isAllianceLeader && canDiplomacy && mid !== myFactionId && (
                                         <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <button
                                                onClick={() => {
                                                    if(confirm(`${mFaction?.name}を追放しますか？`)) handleAction(onKickMember, myAlliance.id, mid);
                                                }}
                                                className="w-8 h-8 flex items-center justify-center rounded-full text-red-400 hover:bg-red-500 hover:text-white transition-all bg-black/40"
                                                title="追放"
                                            >
                                                ✕
                                            </button>
                                         </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Action Support (Disband / Leave) - Bottom Center */}
            {canDiplomacy && (
                <div className="mt-12 mb-8 flex justify-center w-full px-4 min-w-0">
                    {isAllianceLeader ? (
                         <button
                            onClick={() => {
                                if(confirm("【警告】本当に同盟を解散しますか？\nこの操作は取り消せません。")) handleAction(onDisbandAlliance, myAlliance.id);
                            }}
                            className="group relative w-full py-4 bg-red-600 text-white rounded shadow-md hover:shadow-xl hover:-translate-y-0.5 active:shadow-sm active:translate-y-0 transition-all duration-300 overflow-hidden font-bold tracking-wider text-base uppercase flex items-center justify-center gap-3"
                            disabled={isProcessing || (new Date() - new Date(myAlliance.createdAt) < 12 * 60 * 60 * 1000)}
                         >
                            <span className="absolute inset-0 w-full h-full bg-white opacity-0 group-hover:opacity-10 transition-opacity"></span>
                            <span className="text-xl">💣</span>
                            <span>同盟を解散する</span>
                         </button>
                    ) : (
                        <button
                            onClick={() => {
                                if(confirm("同盟から脱退しますか？")) handleAction(onLeaveAlliance);
                            }}
                            className="group relative w-full py-4 bg-red-600 text-white rounded shadow-md hover:shadow-xl hover:-translate-y-0.5 active:shadow-sm active:translate-y-0 transition-all duration-300 overflow-hidden font-bold tracking-wider text-base uppercase flex items-center justify-center gap-3"
                            disabled={isProcessing || isLocked}
                        >
                             <span className="absolute inset-0 w-full h-full bg-white opacity-0 group-hover:opacity-10 transition-opacity"></span>
                             <span className="text-xl">🚶</span>
                             <span>同盟を脱退する</span>
                        </button>
                    )}
                </div>
            )}
        </div>
    );
  };



  // 停戦管理
  const renderTruces = () => {
    const myTruces = Object.entries(truces).filter(([key, t]) => t.factions.includes(myFactionId));

    // 停戦申請可能な勢力（自分以外、かつ現在停戦中でない、かつ同じ同盟のメンバーではない）
    const trucePartners = Object.values(factions).filter(f => {
      if (f.id === myFactionId) return false;
      // 既に停戦中なら除外
      if (myTruces.some(([key, t]) => t.factions.includes(f.id))) return false;
      // 同じ同盟のメンバーなら除外
      if (myAlliance && myAlliance.members.includes(f.id)) return false;

      return true;
    });

    return (
        <div className="space-y-6 px-1 flex-1">
            {/* 停戦要請リスト (受信) */}
            {canDiplomacy && myFaction.truceRequestsReceived && myFaction.truceRequestsReceived.length > 0 && (
                <div className="premium-card bg-green-500 bg-opacity-5 border-green-500 border-opacity-20 animate-pulse-glow">
                    <h4 className="font-bold text-green-500 text-xs mb-3 uppercase tracking-widest flex items-center gap-2">
                        <span>📩</span> 停戦要請（受信）
                    </h4>
                    <div className="space-y-2">
                        {myFaction.truceRequestsReceived.map(entry => {
                            const fid = typeof entry === 'object' ? entry.id : entry;
                            const expiresAt = typeof entry === 'object' ? entry.expiresAt : null;
                            return (
                            <div key={fid} className="flex flex-col bg-white bg-opacity-5 p-4 rounded-xl border border-white border-opacity-10 gap-3">
                                <span className="font-bold text-lg">{factions[fid]?.name || fid}</span>
                                {expiresAt ? (
                                    <div className="text-xs text-green-300">
                                        提案期限: {new Date(expiresAt).toLocaleString()} まで
                                    </div>
                                ) : (
                                    <div className="text-xs text-gray-400">
                                        期限: デフォルト (12時間)
                                    </div>
                                )}
                                <div className="flex flex-col gap-2 w-full mt-1">
                                    <button
                                        onClick={() => {
                                            if (confirm("この停戦要請を受諾しますか？")) {
                                                handleAction(onAcceptTruce, fid);
                                            }
                                        }}
                                        className="flex-1 sm:flex-none px-4 py-2 bg-green-600 hover:bg-green-500 text-white text-sm rounded-lg font-bold shadow-lg shadow-green-500/20 transition-all"
                                    >
                                        受諾
                                    </button>
                                    <button
                                        onClick={() => handleAction(onRejectTruce, fid)}
                                        className="w-full px-4 py-3 bg-red-500 bg-opacity-10 hover:bg-opacity-20 text-red-400 text-sm rounded-lg font-bold border border-red-500 border-opacity-30 transition-all text-center"
                                    >
                                        拒否
                                    </button>
                                </div>
                            </div>
                            );
                        })}
                    </div>
                </div>
            )}

            <div>
                <h4 className="font-bold text-xs mb-3 text-gray-400 uppercase tracking-widest">有効な停戦協定</h4>
                {myTruces.length === 0 && <p className="text-gray-500 text-center py-10 text-sm italic opacity-60">現在、停戦中の勢力はありません</p>}
                <div className="grid grid-cols-1 gap-3">
                    {myTruces.map(([key, t]) => {
                        const partnerId = t.factions.find(id => id !== myFactionId);
                        const partner = factions[partnerId];
                        const timeLeft = new Date(t.expiresAt) - new Date();
                        const hoursLeft = Math.ceil(timeLeft / (1000 * 60 * 60));

                        return (
                            <div key={key} className="premium-card flex flex-col p-4 bg-gradient-to-r from-green-900/20 to-transparent border border-green-500/30 gap-3">
                                <div className="flex items-center gap-3 w-full">
                                    <div className="w-3 h-3 rounded-full bg-green-500 shadow-lg shadow-green-500/50 animate-pulse flex-shrink-0"></div>
                                    <span className="font-bold text-lg text-white truncate">{partner?.name || "不明"}</span>
                                </div>
                                <div className="text-sm bg-black bg-opacity-40 px-3 py-2 rounded-lg text-green-400 font-mono border border-green-500/30 w-full text-center">
                                    残り {hoursLeft}時間
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* 新規停戦申請 (復旧 & レスポンシブ化) */}
            {canDiplomacy && (
                <div className="mt-8 pt-6 border-t border-white border-opacity-10">
                    <h4 className="font-bold text-sm mb-4 text-gray-400 uppercase tracking-widest flex items-center gap-2">
                        <span>🕊️</span> 新規停戦申請
                    </h4>
                    <div className="space-y-3">
                        <select
                            className="input w-full text-base sm:text-sm py-3 px-4 bg-black bg-opacity-40 border border-white border-opacity-20 rounded-xl focus:border-green-500 focus:ring-1 focus:ring-green-500 transition-all appearance-none cursor-pointer"
                            value={selectedTrucePartner}
                            onChange={(e) => setSelectedTrucePartner(e.target.value)}
                            style={{ backgroundImage: 'none' }}
                        >
                            <option value="" disabled>停戦したい勢力を選択...</option>
                            {trucePartners.map(f => (
                                <option key={f.id} value={f.id}>{f.name} ({f.members?.length || 0}人)</option>
                            ))}
                        </select>
                        <select
                            className="input w-full text-base sm:text-sm py-3 px-4 bg-black bg-opacity-40 border border-white border-opacity-20 rounded-xl focus:border-green-500 focus:ring-1 focus:ring-green-500 transition-all appearance-none cursor-pointer"
                            value={selectedTruceDuration}
                            onChange={(e) => setSelectedTruceDuration(e.target.value)}
                            style={{ backgroundImage: 'none' }}
                        >
                            <option value="1">{getDurationLabel(1)}</option>
                            <option value="3">{getDurationLabel(3)}</option>
                            <option value="6">{getDurationLabel(6)}</option>
                            <option value="12">{getDurationLabel(12)}</option>
                            <option value="24">{getDurationLabel(24)}</option>
                        </select>
                        <button
                            className={`btn w-full px-6 py-3 rounded-xl font-bold shadow-lg transition-all transform hover:-translate-y-0.5 ${
                                !selectedTrucePartner || isProcessing
                                ? 'bg-gray-700 text-gray-500 cursor-not-allowed opacity-50'
                                : 'bg-green-600 text-white hover:bg-green-500 shadow-green-500/30'
                            }`}
                            disabled={!selectedTrucePartner || isProcessing}
                            onClick={() => {
                                const partner = factions[selectedTrucePartner];
                                const expiry = calculateExpiry(selectedTruceDuration);
                                if (confirm(`勢力「${partner?.name}」に停戦を申し込みますか？\n期限: ${expiry.toLocaleString()} まで`)) {
                                    handleAction(onRequestTruce, selectedTrucePartner, expiry.toISOString());
                                    setSelectedTrucePartner('');
                                }
                            }}
                        >
                            停戦を申し込む
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
  };



  // [REMOVED] Fetch wars (Already handled by props from App.jsx)


  return createPortal(
    <div className="premium-modal-overlay">
      <div className="premium-modal-content flex flex-col max-h-[85vh]">
        <button onClick={onClose} className="premium-close-btn" title="閉じる">✖</button>

        <div className="flex justify-between items-center mb-6">
            <div>
                <h3 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">同盟・外交</h3>
            </div>
        </div>

        {renderTabs()}

        <div className="flex-1 overflow-hidden flex flex-col pt-4 min-h-0">
          <div className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar pr-2">
            {activeTab === 'myAlliance' && renderMyAlliance()}
            {activeTab === 'truces' && renderTruces()}
          </div>
        </div>

      </div>
    </div>,
    document.body
  );
}

export default memo(AlliancePanel);
