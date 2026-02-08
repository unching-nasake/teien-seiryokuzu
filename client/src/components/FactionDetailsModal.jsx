import { memo, useState } from 'react';
import { createPortal } from 'react-dom';
import WarCard from './WarCard';

const FactionDetailsModal = ({
  factionId,
  factions,
  playerData,
  alliances,
  truces,
  wars,
  onClose,
  onJoinFaction,
  onKickMember,
  onAllianceRequest,
  onTruceRequest,
  onAllianceInvite,
  onSendMessage,
  apSettings = {}
}) => {
  const [activeTab, setActiveTab] = useState('members'); // members, diplomacy, wars
  const [selectedTruceDuration, setSelectedTruceDuration] = useState(1);

  const calculateExpiry = (hours) => {
    const now = new Date();
    const target = new Date(now);
    target.setMinutes(0, 0, 0);
    target.setHours(target.getHours() + parseInt(hours));
    return target;
  };

  const getDurationLabel = (hours) => {
      const expiry = calculateExpiry(hours);
      return `${hours}h後 (${expiry.getMonth()+1}/${expiry.getDate()} ${expiry.getHours()}:00)`;
  };

  if (!factionId || !factions[factionId]) return null;
  const faction = factions[factionId];

  // Tab Styles
  const getTabStyle = (tabName) => ({
    padding: '10px 15px',
    cursor: 'pointer',
    borderBottom: activeTab === tabName ? `2px solid ${faction.color}` : '2px solid transparent',
    color: activeTab === tabName ? '#fff' : '#aaa',
    fontWeight: activeTab === tabName ? 'bold' : 'normal',
    flex: 1,
    textAlign: 'center',
    transition: 'all 0.2s',
    background: activeTab === tabName ? 'rgba(255,255,255,0.05)' : 'transparent'
  });

  const contentHelpers = {
    getFactionName: (fid) => factions[fid]?.name || fid,
    getAllianceName: (aid) => alliances?.[aid]?.name || aid,
    playerIsAllianceLeader: (() => {
        if (!playerData?.factionId || !alliances) return false;
        const myFaction = factions[playerData.factionId];
        if (!myFaction?.allianceId) return false;
        const alliance = alliances[myFaction.allianceId];
        return alliance?.leaderId === playerData.factionId;
    })()
  };

  // Logic for Members Tab (Sorting)
  const getSortedMembers = () => {
    const members = faction.members || faction.memberInfo;
    if (!members) return [];

    return [...members].sort((a, b) => {
        if (a.isKing) return -1;
        if (b.isKing) return 1;

        const roleA = faction.roles?.find(r => r.id === a.role);
        const roleB = faction.roles?.find(r => r.id === b.role);
        const rankA = roleA ? roleA.rank : 999;
        const rankB = roleB ? roleB.rank : 999;

        if (rankA !== rankB) return rankA - rankB;
        return (b.tileCount || 0) - (a.tileCount || 0);
    });
  };

  // Logic for Diplomacy Tab
  const getAllianceData = () => {
      if (!faction.allianceId || !alliances) return null;
      return alliances[faction.allianceId];
  };

  const getTruceList = () => {
      if (!truces) return [];
      return Object.values(truces).filter(t => t.factions && t.factions.includes(factionId));
  };

  // Logic for Wars Tab
  const getActiveWars = () => {
      if (!wars) return [];
      return Object.values(wars).filter(w =>
          w.attackerSide?.factions?.includes(factionId) ||
          w.defenderSide?.factions?.includes(factionId)
      );
  };

  const checkWarWith = (fid1, fid2) => {
    if (!wars) return false;
    const f1 = String(fid1);
    const f2 = String(fid2);
    return Object.values(wars).some(w => {
      const attackers = w.attackerSide?.factions || [];
      const defenders = w.defenderSide?.factions || [];
      return (
        (attackers.includes(f1) && defenders.includes(f2)) ||
        (defenders.includes(f1) && attackers.includes(f2))
      );
    });
  };

  return createPortal(
    <div className="modal-overlay faction-details-overlay" onClick={onClose}>
      {/* Mobile-friendly container */}
      <div
        className="modal-content"
        onClick={e => e.stopPropagation()}
        style={{
          width: '95%',
          maxWidth: '600px',
          maxHeight: '90vh',
          zIndex: 11005, // 最前面に表示
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          background: 'rgba(20, 20, 30, 0.95)',
          borderRadius: '12px',
          overflow: 'hidden',
          border: `1px solid ${faction.color}66`
        }}
      >

        {/* Header Section (Fixed) */}
        <div style={{ padding: '16px', background: 'rgba(0,0,0,0.3)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
             <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '40px', height: '40px', borderRadius: '8px', background: faction.color, border: '1px solid rgba(255,255,255,0.2)' }} />
                <div>
                    <h2 style={{ margin: 0, fontSize: '1.4rem', lineHeight: 1.2 }}>{faction.name}</h2>
                    <div style={{ fontSize: '0.8rem', color: '#aaa', display: 'flex', gap: '8px', marginTop: '4px' }}>
                        {faction.allianceId && <span style={{ color: '#66aaff' }}>🛡️ {contentHelpers.getAllianceName(faction.allianceId)} (同盟)</span>}
                    </div>
                </div>
             </div>
             <button onClick={onClose} className="btn-close" style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '1.5rem', cursor: 'pointer', padding: '0 8px' }}>×</button>
          </div>

          <div style={{ display: 'flex', gap: '16px', marginTop: '16px', padding: '10px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', justifyContent: 'space-around' }}>
              <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '0.75rem', color: '#aaa' }}>メンバー</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 'bold' }}>
                      {faction.members?.length || 0}
                      <span style={{ fontSize: '0.8rem', fontWeight: 'normal', color: '#888', marginLeft: '4px' }}>
                          ({faction.activeMemberCount || 0})
                      </span>
                  </div>
              </div>
              <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '0.75rem', color: '#aaa' }}>タイル</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 'bold' }}>{faction.tileCount || 0}</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '0.75rem', color: '#aaa' }}>ポイント</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#fbbf24' }}>{faction.totalPoints || 0}</div>
              </div>
          </div>
        </div>

        {/* Tabs Navigation */}
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
            <div style={getTabStyle('members')} onClick={() => setActiveTab('members')}>👥 メンバー</div>
            <div style={getTabStyle('diplomacy')} onClick={() => setActiveTab('diplomacy')}>🕊️ 外交</div>
            <div style={getTabStyle('wars')} onClick={() => setActiveTab('wars')}>⚔️ 戦争</div>
        </div>

        {/* Tab Content (Scrollable) */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>

            {/* MEMBERS TAB */}
            {activeTab === 'members' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {getSortedMembers().map((m, i) => (
                        <div key={i} style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px',
                            borderLeft: m.isKing ? '3px solid #ffd700' : '3px solid transparent'
                        }}>
                             <div>
                                 <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                     {m.isActive && (
                                         <span style={{
                                             width: '8px', height: '8px', borderRadius: '50%',
                                             background: '#4ade80', display: 'inline-block',
                                             boxShadow: '0 0 4px #4ade80'
                                         }} title="24時間以内に活動あり" />
                                     )}
                                     {m.isKing && <span>👑</span>}
                                     <span style={{ fontWeight: m.isKing ? 'bold' : 'normal', color: m.isKing ? '#ffd700' : '#fff' }}>
                                         {m.displayName}
                                     </span>
                                 </div>
                                 <div style={{ fontSize: '0.75rem', color: '#aaa', marginTop: '2px' }}>
                                     {(() => {
                                         const rId = m.role;
                                         const rName = faction.roles?.find(r => r.id === rId)?.name;
                                         return rName || (m.isKing ? faction.kingRoleName || '勢力主' : 'Member');
                                     })()}
                                 </div>
                             </div>
                             <div style={{ textAlign: 'right' }}>
                                 <div style={{ fontSize: '0.9rem', fontWeight: 'bold' }}>{m.tileCount || 0} <span style={{ fontSize: '0.7rem', fontWeight: 'normal' }}>マス</span></div>
                                 <div style={{ fontSize: '0.8rem', color: '#fbbf24' }}>{m.points || 0} pt</div>

                                 {/* Kick Button logic */}
                                 {(() => {
                                     if (playerData?.factionId !== factionId) return null;
                                     if (playerData.id === m.id) return null; // 自分は追放不可
                                     if (m.isKing) return null; // 勢力主は追放不可

                                     // 自分の情報を取得
                                     const meAsMember = faction.members?.find(mem => mem.id === playerData.id);
                                     if (!meAsMember) return null;

                                     const myRank = meAsMember.isKing ? 1 : (meAsMember.rank || 99);
                                     const targetRank = m.isKing ? 1 : (m.rank || 99);

                                     // 権限チェック (勢力主、または追放権限あり)
                                     const hasPermission = meAsMember.isKing || (playerData.permissions?.canKick);
                                     if (!hasPermission) return null;

                                     // ランクチェック (自分より下位の rank > myRank の場合のみ表示)
                                     if (!meAsMember.isKing && targetRank <= myRank) return null;

                                     return (
                                         <button
                                            onClick={(e) => { e.stopPropagation(); onKickMember(m.id); }}
                                            style={{
                                                background: 'rgba(255, 68, 68, 0.2)', border: '1px solid #ff4444',
                                                color: '#ff8888', fontSize: '0.7rem', padding: '2px 8px',
                                                borderRadius: '4px', marginTop: '4px', cursor: 'pointer'
                                            }}
                                         >
                                             追放
                                         </button>
                                     );
                                 })()}
                             </div>
                        </div>
                    ))}
                </div>
            )}

            {/* DIPLOMACY TAB */}
            {activeTab === 'diplomacy' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    {/* Alliance Section */}
                    <div>
                        <h4 style={{ margin: '0 0 10px 0', borderBottom: '1px solid #444', paddingBottom: '4px' }}>🛡️ 同盟関係</h4>
                        {faction.allianceId ? (
                            (() => {
                                const alliance = getAllianceData();
                                if (!alliance) return <div style={{ color: '#aaa', fontSize: '0.9rem' }}>データ取得中...</div>;
                                return (
                                    <div style={{ background: 'rgba(50, 80, 150, 0.2)', border: `1px solid ${alliance.color || '#48f'}`, padding: '12px', borderRadius: '8px' }}>
                                        <div style={{ fontWeight: 'bold', color: alliance.color || '#48f', fontSize: '1.1rem' }}>{alliance.name}</div>
                                        <div style={{ fontSize: '0.8rem', color: '#ccc', margin: '4px 0' }}>盟主: {contentHelpers.getFactionName(alliance.leaderId)}</div>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                                            {alliance.members.map(mid => (
                                                <span key={mid} style={{
                                                    background: 'rgba(0,0,0,0.3)', padding: '2px 8px', borderRadius: '4px', fontSize: '0.8rem',
                                                    color: mid === factionId ? '#fff' : '#ccc', border: mid === factionId ? '1px solid #fff' : 'none'
                                                }}>
                                                    {contentHelpers.getFactionName(mid)}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })()
                        ) : (
                            <div style={{ color: '#aaa', fontSize: '0.9rem', fontStyle: 'italic' }}>同盟には所属していません。</div>
                        )}
                    </div>

                    {/* Truces Section */}
                    <div>
                        <h4 style={{ margin: '0 0 10px 0', borderBottom: '1px solid #444', paddingBottom: '4px' }}>🤝 停戦協定</h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {getTruceList().length > 0 ? getTruceList().map((t, i) => {
                                const partnerId = t.factions ? t.factions.find(id => id !== factionId) : null;
                                return (
                                <div key={i} style={{ background: 'rgba(20, 80, 40, 0.2)', border: '1px solid #4f8', padding: '10px', borderRadius: '8px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
                                        <span>vs {contentHelpers.getFactionName(partnerId)}</span>
                                        <span style={{ color: '#4f8' }}>有効</span>
                                    </div>
                                    <div style={{ fontSize: '0.75rem', color: '#aaa', marginTop: '4px' }}>
                                        期限: {new Date(t.expiresAt).toLocaleString()}
                                    </div>
                                </div>
                                );
                            }) : (
                                <div style={{ color: '#aaa', fontSize: '0.9rem', fontStyle: 'italic' }}>進行中の停戦はありません。</div>
                            )}
                        </div>
                    </div>

                    {/* Actions (If not self) */}
                    {playerData?.factionId && playerData.factionId !== factionId && (
                        <div style={{ marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                            {playerData.permissions?.canManageAlliance && contentHelpers.playerIsAllianceLeader && !faction.allianceId && !checkWarWith(playerData.factionId, factionId) && (
                                <button
                                    className="btn btn-primary" style={{ flex: 1, background: '#ec4899', borderColor: '#ec4899' }}
                                    onClick={() => onAllianceInvite(factionId)}
                                >
                                    📩 同盟招待
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* [NEW] Message Section */}
            {activeTab === 'diplomacy' && playerData?.factionId && playerData.factionId !== factionId && (
                <div style={{ margin: '0 16px 16px', padding: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', border: '1px solid rgba(251, 191, 36, 0.3)' }}>
                    <h4 style={{ margin: '0 0 10px 0', fontSize: '0.9rem', color: '#fbbf24' }}>📧 ポイント通知 (メッセージ送信 / {apSettings?.messageCost || 5}AP)</h4>
                    <div style={{ display: 'flex', gap: '8px', flexDirection: 'column' }}>
                        <textarea
                            placeholder="勢力主・外交権限者にメッセージを送ります（200文字以内）"
                            maxLength={200}
                            style={{
                                width: '100%', minHeight: '60px', background: '#000', color: '#fff',
                                border: '1px solid #444', borderRadius: '4px', padding: '8px',
                                fontSize: '0.85rem', resize: 'vertical'
                            }}
                            id="faction-message-input"
                        />
                        <button
                            className="btn btn-primary"
                            style={{ background: '#fbbf24', color: '#000', border: 'none', fontWeight: 'bold' }}
                            onClick={async () => {
                                const input = document.getElementById('faction-message-input');
                                const message = input.value?.trim();
                                if (!message) {
                                    alert('メッセージを入力してください');
                                    return;
                                }
                                if (window.confirm(`${apSettings?.messageCost || 5}APを消費してメッセージを送信しますか？`)) {
                                    const res = await onSendMessage(factionId, message);
                                    if (res.success) {
                                        alert('送付しました');
                                        input.value = '';
                                    } else {
                                        alert(res.error || '送信に失敗しました');
                                    }
                                }
                            }}
                        >
                            メッセージを送信する ({apSettings?.messageCost || 5}AP)
                        </button>
                    </div>
                </div>
            )}

            {/* WARS TAB */}
            {activeTab === 'wars' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {getActiveWars().length > 0 ? getActiveWars().map(war => (
                        <WarCard
                            key={war.id}
                            war={war}
                            factions={factions}
                            currentFactionId={playerData?.factionId} // Highlight user's side
                        />
                    )) : (
                        <div style={{ padding: '20px', textAlign: 'center', color: '#aaa', fontStyle: 'italic' }}>
                            <div>現在、戦争状態ではありません。</div>
                            <div style={{ fontSize: '3rem', marginTop: '10px' }}>☮️</div>
                        </div>
                    )}
                </div>
            )}
        </div>

        {/* Footer Actions (Join / Leave) */}
        {!playerData?.factionId && (
            <div style={{ padding: '16px', borderTop: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.2)' }}>
                {faction.joinPolicy === 'closed' ? (
                     <button className="btn btn-secondary" disabled style={{ width: '100%', opacity: 0.6 }}>募集停止中</button>
                ) : (
                     <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => onJoinFaction(factionId)}>
                         {'加入申請を送る'}
                     </button>
                )}
            </div>
        )}
      </div>
    </div>,
    document.body
  );
};

export default memo(FactionDetailsModal);
