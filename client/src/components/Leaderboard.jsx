import { memo } from 'react';

// ... (imports)

function Leaderboard({ items, onHover, activeFactionId }) {
  // 1件あたりの高さ目安: padding(4*2) + text(~18px) + gap(4) = ~30px
  // 10件固定表示

  return (
    <div className="leaderboard-container">
      <div
          className="leaderboard-list"
          style={{
              display: 'flex',
              flexDirection: 'column'
          }}
      >
          <div style={{ fontSize: '0.8rem', color: '#334155', fontWeight: 'bold', marginBottom: '8px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '4px', flexShrink: 0 }}>
              勢力トップ10
          </div>

          {items.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#666', fontSize: '0.8rem', padding: '10px' }}>勢力なし</div>
          ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {items.slice(0, 10).map((item) => {
                        const isActive = activeFactionId === item.id;
                        const getRankBG = (rank) => {
                            if (isActive) return 'rgba(255, 255, 255, 0.2)';
                            if (rank === 1) return 'linear-gradient(90deg, rgba(251, 191, 36, 0.2) 0%, rgba(251, 191, 36, 0.05) 100%)'; // Gold
                            if (rank === 2) return 'linear-gradient(90deg, rgba(209, 213, 219, 0.2) 0%, rgba(209, 213, 219, 0.05) 100%)'; // Silver
                            if (rank === 3) return 'linear-gradient(90deg, rgba(205, 127, 50, 0.2) 0%, rgba(205, 127, 50, 0.05) 100%)'; // Bronze
                            return 'rgba(255,255,255,0.05)';
                        };

                        return (
                          <div
                              key={item.id}
                              title={item.name} /* フルネームツールチップ */
                              onMouseEnter={() => onHover && onHover(item.id)}
                              onMouseLeave={() => onHover && onHover(null)}
                              onClick={(e) => {
                                  e.stopPropagation();
                                  if (onHover) onHover(item.id);
                              }}
                              style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  fontSize: '0.85rem',
                                  padding: '6px 8px',
                                  borderRadius: '4px',
                                  background: getRankBG(item.rank),
                                  cursor: 'pointer',
                                  transition: 'all 0.2s',
                                  border: isActive ? '1px solid rgba(255, 255, 255, 0.3)' : (item.rank <= 3 ? `1px solid rgba(${item.rank===1?'251,191,36':item.rank===2?'209,213,219':'205,127,50'}, 0.2)` : '1px solid transparent')
                              }}
                          >
                            <div
                                style={{
                                    width: '24px',
                                    textAlign: 'center',
                                    fontWeight: 'bold',
                                    color: item.rank <= 3 ? '#fbbf24' : '#1e293b',
                                    marginRight: '8px',
                                    fontSize: item.rank <= 3 ? '1.1rem' : '0.85rem'
                                }}
                            >
                                {item.rank}
                            </div>
                            <div
                                style={{
                                    width: '12px',
                                    height: '12px',
                                    borderRadius: '50%',
                                    background: item.color,
                                    marginRight: '8px',
                                    border: '1px solid rgba(255,255,255,0.3)',
                                    flexShrink: 0
                                }}
                            />
                            <div
                                style={{
                                    flex: 1,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis'
                                }}
                            >
                                {item.name}
                            </div>
                            <div style={{ fontSize: '0.8rem', color: '#ccc', marginLeft: '8px', flexShrink: 0 }}>
                                {item.count}
                            </div>
                        </div>
                      );
                  })}
              </div>
          )}
      </div>
    </div>
  );
}

export default memo(Leaderboard);
