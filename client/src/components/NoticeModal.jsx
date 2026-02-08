import { memo, useMemo, useState } from 'react';

function NoticeModal({ notices, readNoticeIds, onClose, onMarkAllRead, onShowDetail }) {
    const [filter, setFilter] = useState('all'); // all, diplomacy, management
    const [searchTerm, setSearchTerm] = useState('');

    // カテゴリ判定ヘルパー
    const getCategory = (n) => {
        const text = (n.title || "") + (n.content || "");
        const title = n.title || "";

        // 「その他」：加入、役職、中核化、設定変更など
        if (n.type === 'join_request' ||
            title.includes("加入申請") || title.includes("加入承認") || title.includes("加入拒否") ||
            title.includes("新規メンバー加入") || title.includes("メンバー脱退") || title.includes("メンバー追放") ||
            title.includes("役職変更") || title.includes("権限変更") || title.includes("盟主交代") ||
            title.includes("中核化完了") || title.includes("設定変更")
        ) return 'other';

        // 「外交」：戦争、同盟、併合、割譲、停戦、滅亡など
        if (n.type === 'diplomacy' || n.type === 'message' ||
            title.includes("開戦") || title.includes("宣戦布告") || title.includes("戦争勝利") || title.includes("戦況変化") || title.includes("戦争終結") ||
            title.includes("同盟") || title.includes("停戦") || title.includes("併合") ||
            title.includes("割譲") || title.includes("領土割譲") ||
            title.includes("滅亡") || title.includes("滅亡のお知らせ") ||
            title.includes("外交メッセージ") ||
            title.includes("ポイント通知") ||
            text.includes("戦争") || text.includes("同盟") || text.includes("併合")
        ) return 'diplomacy';

        if (n.type === 'management') return 'management';
        return 'management'; // Default fallback
    };

    const filteredNotices = useMemo(() => {
        if (!notices) return [];
        return notices.filter(n => {
            // テキスト検索
            if (searchTerm && !n.title.toLowerCase().includes(searchTerm.toLowerCase()) && !n.content?.toLowerCase().includes(searchTerm.toLowerCase())) {
                return false;
            }

            // カテゴリフィルタ
            const category = getCategory(n);

            if (filter === 'all') return true;
            return category === filter;
        });
    }, [notices, filter, searchTerm]);

    // 時間フォーマッター
    const formatTime = (isoString) => {
        if (!isoString) return '';
        const date = new Date(isoString);
        return date.toLocaleString('ja-JP', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    return (
        <div className="premium-modal-overlay" onClick={onClose}>
            <div className="premium-modal-content" onClick={e => e.stopPropagation()}>
                <button onClick={onClose} className="premium-close-btn" title="閉じる">✖</button>

                <div className="flex justify-between items-start mb-6 flex-wrap gap-4">
                    <div>
                        <h3 className="text-3xl font-bold bg-gradient-to-r from-pink-500 to-purple-500 bg-clip-text text-transparent">お知らせ一覧 (v2.1)</h3>
                    </div>

                    <div className="flex flex-col items-end gap-2" style={{ marginRight: '40px', marginTop: '10px' }}>
                        <div className="flex gap-2 items-center flex-wrap justify-end">
                            {/* 検索バー */}
                            <div className="input-group" style={{ flexDirection: 'row', alignItems: 'center', margin: 0 }}>
                                <input
                                    type="text"
                                    className="input"
                                    placeholder="検索..."
                                    value={searchTerm}
                                    onChange={e => setSearchTerm(e.target.value)}
                                    style={{ padding: '6px 10px', fontSize: '0.9rem', width: '160px' }}
                                />
                            </div>

                            {/* フィルタ */}
                            <select
                                className="input"
                                style={{ width: 'auto', padding: '6px 20px 6px 10px' }}
                                value={filter}
                                onChange={e => setFilter(e.target.value)}
                            >
                                <option value="all">すべて</option>
                                <option value="diplomacy">外交</option>
                                <option value="management">運営</option>
                                <option value="other">その他</option>
                            </select>
                        </div>

                        {/* 一括既読 (検索/フィルタの下段・右寄せ) */}
                        <button
                            onClick={onMarkAllRead}
                            className="btn btn-secondary notice-all-read-btn"
                            style={{ alignSelf: 'flex-end', padding: '4px 12px', fontSize: '0.8rem' }}
                        >
                            全既読
                        </button>
                    </div>
                </div>

                <div className="activity-log-scroll-area pr-2 space-y-3">
                    {filteredNotices.length === 0 ? (
                        <div className="text-center py-20 opacity-40 italic text-sm">お知らせはありません</div>
                    ) : (
                        filteredNotices.map(n => {
                            const isRead = readNoticeIds.includes(n.id);
                            const category = getCategory(n);
                            let accentColor = '#a855f7'; // Default: Management (Purple)
                            let categoryLabel = '運営';

                            if (category === 'diplomacy') {
                                accentColor = '#3b82f6'; // Diplomacy (Blue)
                                categoryLabel = '外交';
                            } else if (category === 'other') {
                                accentColor = '#f97316'; // Other (Orange) - e.g. Join Request
                                categoryLabel = 'その他';
                            }

                            return (
                                <div
                                    key={n.id}
                                    onClick={() => {
                                        onShowDetail(n);
                                    }}
                                    className="p-4 rounded-r-xl transition-all hover:bg-white hover:bg-opacity-5 cursor-pointer relative"
                                    style={{
                                        background: 'rgba(255, 255, 255, 0.03)',
                                        borderLeft: `6px solid ${isRead ? '#555' : accentColor}`,
                                        opacity: isRead ? 0.7 : 1,
                                        boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                                    }}
                                >
                                    <div className="flex justify-between items-start gap-4">
                                        <div className="flex-1">
                                            <div className="text-sm font-bold text-gray-100 mb-1 flex items-center gap-2">
                                                 {category === 'diplomacy' ? '📜' : category === 'other' ? '📝' : '📢'} {n.title}
                                                 {!isRead && <span className="bg-red-500 w-2 h-2 rounded-full animate-pulse"></span>}
                                            </div>
                                            <div className="text-xs text-gray-400">
                                                {formatTime(n.date)}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        </div>
    );
}

export default memo(NoticeModal);
