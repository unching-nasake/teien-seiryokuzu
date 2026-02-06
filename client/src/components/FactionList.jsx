import React, { useState } from 'react';

function FactionList({ factions, playerData, onJoinFaction, onShowMemberList, sortBy = 'members' }) {
  const [tooltip, setTooltip] = useState({ name: '', x: 0, y: 0, visible: false });

  // ソートロジック
  const sortedFactions = Object.entries(factions).sort(([, a], [, b]) => {
    switch (sortBy) {
      case 'members':
        return (b.members?.length || 0) - (a.members?.length || 0);
      case 'tiles':
        return (b.tileCount || 0) - (a.tileCount || 0);
      case 'points':
        return (b.totalPoints || 0) - (a.totalPoints || 0);
      case 'name':
        return a.name.localeCompare(b.name, 'ja');
      default:
        return 0;
    }
  });

  return (
    <div className="faction-list-container">
      {Object.keys(factions).length === 0 ? (
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          まだ勢力がありません
        </p>
      ) : (
        <div className="faction-list">
          {sortedFactions.map(([id, faction]) => (
            <div
              key={id}
              className="faction-item"
              onClick={() => onShowMemberList?.(id)}
              style={{ cursor: 'pointer', padding: '8px' }}
            >
              <div className="faction-color" style={{ background: faction.color, width: '12px', height: '12px', borderRadius: '50%', flexShrink: 0 }} />
              <div style={{ flex: 1, overflow: 'hidden', marginLeft: '8px' }}>
                  <span
                    className="faction-name"
                    style={{
                      display: 'block',
                      fontWeight: 'bold',
                      fontSize: '0.9rem',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}
                  >
                    {faction.name}
                  </span>
                  <div style={{ display: 'flex', gap: '8px', fontSize: '0.75rem', color: '#aaa', marginTop: '2px' }}>
                      <span title="人数(アクティブ)">👥 {faction.members?.length || 0} <span style={{fontSize: '0.9em', color: '#bbb'}}>({faction.activeMemberCount || 0})</span></span>
                      <span title="タイル数">🧱 {faction.tileCount || 0}</span>
                  </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', fontSize: '0.8rem' }}>
                  <div style={{ color: '#fbbf24', fontWeight: 'bold' }}>💎 {faction.totalPoints || 0} pt</div>

              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default React.memo(FactionList);
