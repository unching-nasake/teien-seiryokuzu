import { memo, useEffect, useState } from 'react';
import WarCard from './WarCard';

// モダンなデザインのモーダル
const WorldStatesModal = ({ onClose, factions, alliances, wars, truces, onShowMemberList }) => {
  const [activeTab, setActiveTab] = useState('wars'); // default to wars as it's the "hottest" topic
  const [sortBy, setSortBy] = useState(localStorage.getItem('allianceSortBy') || 'name');

  // dataオブジェクトをプロップスから直接生成
  const data = {
    wars: wars || {},
    alliances: alliances || {},
    truces: truces || {}
  };

  useEffect(() => {
    localStorage.setItem('allianceSortBy', sortBy);
  }, [sortBy]);

  const loading = false; // プロップス受け取りなので常にロード済みとする

  const tabStyle = (tabName) => ({
    padding: '10px 20px',
    cursor: 'pointer',
    borderBottom: activeTab === tabName ? '2px solid #00ffff' : '2px solid transparent',
    color: activeTab === tabName ? '#fff' : '#aaa',
    fontWeight: activeTab === tabName ? 'bold' : 'normal',
    transition: 'all 0.3s'
  });

  const contentStyle = {
    flex: 1,
    overflowY: 'auto',
    padding: '20px',
    background: 'rgba(0, 0, 0, 0.2)',
    borderRadius: '0 0 12px 12px'
  };

  const getFactionName = (fid) => factions[fid]?.name || fid;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      background: 'rgba(0, 0, 0, 0.6)',
      backdropFilter: 'blur(5px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9000
    }} onClick={onClose}>
      <div style={{
        width: '90%',
        maxWidth: '800px',
        maxHeight: '85dvh',
        background: 'rgba(20, 20, 30, 0.85)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        borderRadius: '12px',
        boxShadow: '0 0 30px rgba(0, 255, 255, 0.1)',
        display: 'flex',
        flexDirection: 'column',
        backdropFilter: 'blur(10px)',
        color: '#fff',
        animation: 'fadeIn 0.3s ease-out'
      }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{
          padding: '20px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <h2 style={{
            margin: 0,
            fontSize: '1.5rem',
            background: 'linear-gradient(45deg, #00ffff, #0088ff)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            textShadow: '0 0 10px rgba(0, 0, 0, 0.3)'
          }}>
            🌍 世界情勢
          </h2>
        </div>

        <button onClick={onClose} className="premium-close-btn" title="閉じる">✖</button>

        {/* Tabs and Sort */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255, 255, 255, 0.1)', background: 'rgba(0,0,0,0.2)', paddingRight: '15px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            <div style={tabStyle('wars')} onClick={() => setActiveTab('wars')}>⚔️ 戦争一覧 ({Object.keys(data.wars || {}).length})</div>
            <div style={tabStyle('alliances')} onClick={() => setActiveTab('alliances')}>🛡️ 同盟一覧 ({Object.keys(data.alliances || {}).length})</div>
            <div style={tabStyle('truces')} onClick={() => setActiveTab('truces')}>🤝 停戦一覧 ({Object.keys(data.truces || {}).length})</div>
          </div>

          {activeTab === 'alliances' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '0.7rem', color: '#aaa', fontWeight: 'bold', textTransform: 'uppercase' }}>並び替え:</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: '#fff',
                  fontSize: '0.75rem',
                  padding: '4px 8px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  outline: 'none'
                }}
              >
                <option value="name" style={{color: 'black'}}>名前</option>
                <option value="membersCount" style={{color: 'black'}}>勢力数</option>
                <option value="totalPlayers" style={{color: 'black'}}>合計人数</option>
                <option value="points" style={{color: 'black'}}>総ポイント</option>
                <option value="territory" style={{color: 'black'}}>総領土</option>
              </select>
            </div>
          )}
        </div>

        {/* Content */}
        <div style={contentStyle}>
          {loading ? (
             <div style={{textAlign: 'center', padding: '20px'}}>Loading...</div>
          ) : (
            <>
              {/* Wars Tab */}
              {activeTab === 'wars' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '15px' }}>
                  {Object.keys(data.wars || {}).length === 0 && <div style={{color: '#aaa', padding: '10px'}}>現在、戦争状態にある勢力はありません。平和です。</div>}
                  {Object.values(data.wars || {}).map((war, i) => (
                    <WarCard
                        key={war.id || i}
                        war={war}
                        factions={factions}
                        onShowMemberList={(fid) => {
                          onShowMemberList?.(fid);
                          onClose();
                        }}
                    />
                  ))}
                </div>
              )}

              {/* Alliances Tab */}
              {activeTab === 'alliances' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '15px' }}>
                  {Object.keys(data.alliances || {}).length === 0 && <div style={{color: '#aaa', padding: '10px'}}>結成されている同盟はありません。</div>}
                  {(() => {
                    const alliancesList = Object.values(data.alliances || {}).map(a => {
                      const memberFactions = a.members.map(mid => factions[mid]).filter(Boolean);
                      return {
                        ...a,
                        totalPoints: memberFactions.reduce((sum, f) => sum + (f.totalPoints || 0), 0),
                        totalTiles: memberFactions.reduce((sum, f) => sum + (f.tileCount || 0), 0),
                        totalPlayers: memberFactions.reduce((sum, f) => sum + (f.members?.length || 0), 0),
                        totalActive: memberFactions.reduce((sum, f) => sum + (f.activeMemberCount || 0), 0)
                      };
                    });

                    alliancesList.sort((a, b) => {
                      switch (sortBy) {
                        case 'membersCount': return b.members.length - a.members.length;
                        case 'totalPlayers': return b.totalPlayers - a.totalPlayers;
                        case 'points': return b.totalPoints - a.totalPoints;
                        case 'territory': return b.totalTiles - a.totalTiles;
                        case 'name':
                        default: return a.name.localeCompare(b.name);
                      }
                    });

                    return alliancesList.map((alliance, i) => (
                      <div key={i} style={{
                        background: 'rgba(20, 30, 50, 0.6)',
                        border: `1px solid ${alliance.color || '#4488ff'}`,
                        borderRadius: '8px',
                        padding: '15px',
                        boxShadow: `0 0 10px ${alliance.color}22`,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '12px'
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <div>
                            <h3 style={{ margin: '0 0 5px 0', color: alliance.color || '#fff', fontSize: '1.2rem' }}>{alliance.name}</h3>
                            <div style={{ fontSize: '0.8rem', color: '#ccc', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                              <span>👑 盟主: {getFactionName(alliance.leaderId)}</span>
                              <span style={{ color: '#aaa' }}>|</span>
                              <span>🚩 勢力: {alliance.members.length}</span>
                              <span style={{ color: '#aaa' }}>|</span>
                               <span>👥 合計: {alliance.totalPlayers}人 <span style={{fontSize:'0.9em', color:'#aaa'}}>({alliance.totalActive})</span></span>
                            </div>
                          </div>
                        </div>

                        <div style={{
                          display: 'grid',
                          gridTemplateColumns: '1fr 1fr',
                          gap: '10px',
                          background: 'rgba(0,0,0,0.2)',
                          padding: '10px',
                          borderRadius: '6px'
                        }}>
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '0.7rem', color: '#888', textTransform: 'uppercase' }}>総ポイント</div>
                            <div style={{ fontSize: '1rem', fontWeight: 'bold', color: '#ffcc00' }}>{alliance.totalPoints.toLocaleString()} pt</div>
                          </div>
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '0.7rem', color: '#888', textTransform: 'uppercase' }}>総領土</div>
                            <div style={{ fontSize: '1rem', fontWeight: 'bold', color: '#00ccff' }}>{alliance.totalTiles.toLocaleString()} tiles</div>
                          </div>
                        </div>

                        <div style={{ fontSize: '0.75rem', color: '#bbb', display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                          {alliance.members.map(mid => (
                              <span key={mid} style={{ background: 'rgba(255,255,255,0.05)', padding: '2px 8px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.05)' }}>
                                  {getFactionName(mid)}
                              </span>
                          ))}
                        </div>
                      </div>
                    ));
                  })()}
                </div>
              )}

              {/* Truces Tab */}
              {activeTab === 'truces' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '15px' }}>
                  {Object.keys(data.truces || {}).length === 0 && <div style={{color: '#aaa', padding: '10px'}}>現在、停戦協定はありません。</div>}
                  {Object.values(data.truces || {}).map((truce, i) => (
                    <div key={i} style={{
                      background: 'rgba(20, 50, 30, 0.6)',
                      border: '1px solid #44ff88',
                      borderRadius: '8px',
                      padding: '15px'
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                        <div style={{fontWeight: 'bold', color: '#aaffaa'}}>{truce.factionNames[0]}</div>
                        <div style={{color: '#44ff88'}}>🤝</div>
                        <div style={{fontWeight: 'bold', color: '#aaffaa'}}>{truce.factionNames[1]}</div>
                      </div>
                      <div style={{ fontSize: '0.8rem', color: '#ccc' }}>
                        期限: {new Date(truce.expiresAt).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
};

export default memo(WorldStatesModal);
