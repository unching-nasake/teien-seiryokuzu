import { useEffect, useState } from 'react';
import FactionList from './FactionList';

function FactionListModal({ factions, playerData, onJoinFaction, onShowMemberList, onClose }) {
  const [sortBy, setSortBy] = useState(() => {
    try {
        return localStorage.getItem('teien_faction_list_sort') || 'members';
    } catch { return 'members'; }
  });

  useState(() => {
      // Just a side effect for saving whenever it changes, using useEffect is better but let's stick to standard patterns
  });

  // Effect for persistence
  useEffect(() => {
      localStorage.setItem('teien_faction_list_sort', sortBy);
  }, [sortBy]);

  return (
    <div className="premium-modal-overlay" onClick={onClose}>
      <div
        className="premium-modal-content"
        onClick={e => e.stopPropagation()}
      >
        <button onClick={onClose} className="premium-close-btn" title="閉じる">✖</button>
        {/* Removed the top close button as it was redundant */}

        <div className="flex justify-between items-center mb-6"> {/* Removed pr-12 */}
            <div>
                <h3 className="text-3xl font-bold bg-gradient-to-r from-emerald-400 to-teal-400 bg-clip-text text-transparent">勢力一覧</h3>
                <p className="text-xs text-gray-500 uppercase tracking-widest mt-1">勢力一覧</p>
            </div>
        </div>

        {/* ソート等のコントロール */}
        <div className="flex items-center gap-3 mb-6 p-3 bg-white bg-opacity-5 rounded-2xl border border-white border-opacity-5">
            <span className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-2">並び替え:</span>
            <select
                className="input flex-1 py-1.5 text-sm"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
            >
                <option value="members">👥 人数順</option>
                <option value="tiles">🧱 タイル数順</option>
                <option value="points">💎 ポイント順</option>
                <option value="name">🔤 名前順</option>
            </select>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 min-h-0">
             <FactionList
                factions={factions}
                playerData={playerData}
                onJoinFaction={onJoinFaction}
                onShowMemberList={onShowMemberList}
                sortBy={sortBy}
             />
        </div>


      </div>
    </div>
  );
}

export default FactionListModal;
