
const WarCard = ({ war, factions, currentFactionId, onShowMemberList }) => {
  if (!war || !war.attackerSide || !war.defenderSide) return null;

  const getFactionName = (fid) => factions[fid]?.name || fid;
  const getSideTiles = (side) => {
    if (!side || !side.factions) return 0;
    return side.factions.reduce((sum, fid) => sum + (factions[fid]?.tileCount || 0), 0);
  };

  const attackerTiles = getSideTiles(war.attackerSide);
  const defenderTiles = getSideTiles(war.defenderSide);
  const totalCombinedTiles = attackerTiles + defenderTiles;
  const attackerPct = totalCombinedTiles > 0 ? (attackerTiles / totalCombinedTiles) * 100 : 50;

  const isMyWar = currentFactionId && (
    war.attackerSide.factions.includes(currentFactionId) ||
    war.defenderSide.factions.includes(currentFactionId)
  );

  return (
    <div style={{
      background: 'rgba(50, 20, 20, 0.6)',
      border: isMyWar ? '2px solid #ffaa00' : '1px solid #ff4444',
      borderRadius: '8px',
      padding: '15px',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      marginBottom: '10px'
    }}>
      {/* War Header with Bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
         <div style={{ flex: 1, textAlign: 'right', fontWeight: 'bold', color: '#ff4444' }}>
            攻撃側 ({war.attackerSide.factions.length})
         </div>
         <div style={{ fontWeight: 'bold', color: '#fff', fontSize: '1.2rem' }}>VS</div>
         <div style={{ flex: 1, textAlign: 'left', fontWeight: 'bold', color: '#4444ff' }}>
            防衛側 ({war.defenderSide.factions.length})
         </div>
      </div>

      {/* Dominance Bar */}
      <div style={{ height: '12px', background: '#333', borderRadius: '6px', overflow: 'hidden', display: 'flex' }}>
        <div style={{ width: `${attackerPct}%`, background: '#ff4444', transition: 'width 0.5s' }} />
        <div style={{ flex: 1, background: '#4444ff', transition: 'width 0.5s' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: '#ccc' }}>
        <span>総タイル数: {attackerTiles}</span>
        <span>総タイル数: {defenderTiles}</span>
      </div>

      {/* Faction Lists */}
      <div style={{ display: 'flex', gap: '10px' }}>
        <div style={{ flex: 1, background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '4px' }}>
           {war.attackerSide.factions.map(fid => (
               <div key={fid} style={{ fontSize: '0.9rem', color: '#eee', display: 'flex', alignItems: 'center', gap: '4px' }}>
                   {war.attackerSide.leaderId === fid && <span title="主戦国">👑</span>}
                   <span
                     onClick={() => onShowMemberList?.(fid)}
                     style={{
                       fontWeight: fid === currentFactionId ? 'bold' : 'normal',
                       color: fid === currentFactionId ? '#ffaa00' : 'inherit',
                       cursor: 'pointer',
                       textDecoration: 'underline'
                     }}
                   >
                     ・{getFactionName(fid)}
                   </span>
               </div>
           ))}
        </div>
        <div style={{ flex: 1, background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '4px' }}>
           {war.defenderSide.factions.map(fid => (
               <div key={fid} style={{ fontSize: '0.9rem', color: '#eee', display: 'flex', alignItems: 'center', gap: '4px' }}>
                   {war.defenderSide.leaderId === fid && <span title="主戦国">👑</span>}
                   <span
                     onClick={() => onShowMemberList?.(fid)}
                     style={{
                       fontWeight: fid === currentFactionId ? 'bold' : 'normal',
                       color: fid === currentFactionId ? '#ffaa00' : 'inherit',
                       cursor: 'pointer',
                       textDecoration: 'underline'
                     }}
                   >
                     ・{getFactionName(fid)}
                   </span>
               </div>
           ))}
        </div>
      </div>

      <div style={{ fontSize: '0.8rem', color: '#888', textAlign: 'right' }}>
        開戦: {new Date(war.startTime).toLocaleString()}
      </div>
    </div>
  );
};

export default WarCard;
