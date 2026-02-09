import { memo, useEffect, useMemo, useState } from 'react';

function NoticeModal({ notices, readNoticeIds, lastNoticeReadAllTime = 0, onClose, onMarkAllRead, onShowDetail, currentUser, onUpdateUser, onClearHistory }) {
    const [filter, setFilter] = useState('all'); // all, diplomacy, management
    const [searchTerm, setSearchTerm] = useState('');
    const [showSettings, setShowSettings] = useState(false);

    // 設定用ステート
    const [allowMessages, setAllowMessages] = useState(true);
    const [blockedIds, setBlockedIds] = useState([]);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        if (currentUser) {
            setAllowMessages(currentUser.diplomacySettings?.allowMessages ?? true);
            setBlockedIds(currentUser.blockedPlayerIds || []);
        }
    }, [currentUser]);

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

    // 設定保存
    const handleSaveSettings = async (newAllow, newBlocked) => {
        setIsSaving(true);
        try {
            const res = await fetch('/api/me/diplomacy/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    diplomacySettings: { allowMessages: newAllow },
                    blockedPlayerIds: newBlocked
                }),
                credentials: 'include'
            });
            const data = await res.json();
            if (data.success) {
                // 親コンポーネントの状態を更新
                if (onUpdateUser) {
                    onUpdateUser(prev => ({
                        ...prev,
                        diplomacySettings: data.diplomacySettings,
                        blockedPlayerIds: data.blockedPlayerIds
                    }));
                }
                setAllowMessages(data.diplomacySettings.allowMessages);
                setBlockedIds(data.blockedPlayerIds);
                // alert('設定を保存しました');
            } else {
                alert(data.error || '保存に失敗しました');
            }
        } catch (e) {
            console.error(e);
            alert('通信エラー');
        } finally {
            setIsSaving(false);
        }
    };

    const handleUnblock = (targetId) => {
        if (!window.confirm('ブロックを解除しますか？')) return;
        const nextBlocked = blockedIds.filter(id => id !== targetId);
        handleSaveSettings(allowMessages, nextBlocked);
    };

    const handleToggleAllow = () => {
        const nextAllow = !allowMessages;
        handleSaveSettings(nextAllow, blockedIds);
    };

    if (showSettings) {
        return (
            <div className="premium-modal-overlay" onClick={onClose}>
                <div className="premium-modal-content" onClick={e => e.stopPropagation()}>
                    {/* 戻るボタン (修正版: div を使用してボタン特有のスタイルを回避) */}
                    <div
                        onClick={() => setShowSettings(false)}
                        className="absolute top-6 left-6 text-gray-400 hover:text-white transition-colors flex items-center gap-2 font-bold z-10 cursor-pointer"
                        style={{ width: 'max-content', background: 'none', border: 'none', padding: '4px' }}
                        title="戻る"
                    >
                        <span className="text-xl">←</span> 戻る
                    </div>

                    <button onClick={onClose} className="premium-close-btn" title="閉じる">✖</button>

                    <h3 className="text-2xl font-bold mb-8 text-center text-gray-100 mt-2">外交通知設定</h3>

                    <div className="space-y-6 px-4 overflow-y-auto" style={{ maxHeight: 'calc(80vh - 100px)' }}>
                        {/* 受信設定 (カード化) */}
                        <div className="bg-gray-800 bg-opacity-40 p-6 rounded-xl shadow-lg border border-gray-700/50 backdrop-blur-sm">
                            <h4 className="text-lg font-bold mb-4 text-blue-300 border-b border-gray-700 pb-2">メッセージ受信設定</h4>

                            <div
                                className={`premium-toggle ${allowMessages ? 'active' : ''}`}
                                onClick={!isSaving ? handleToggleAllow : undefined}
                                style={{ opacity: isSaving ? 0.7 : 1 }}
                            >
                                <span className="premium-toggle-label text-gray-200">他勢力からの外交メッセージを受け取る</span>
                                <div className="premium-toggle-switch">
                                    <div className="premium-toggle-knob"></div>
                                </div>
                            </div>

                            <p className="text-xs text-gray-500 mt-3 ml-1">
                                ※OFFにすると、相手には送信エラー等は表示されず、通知だけが届かなくなります。
                            </p>
                        </div>

                        {/* ブロックリスト (カード化) */}
                        <div className="bg-gray-800 bg-opacity-40 p-6 rounded-xl shadow-lg border border-gray-700/50 backdrop-blur-sm">
                            <h4 className="text-lg font-bold mb-4 text-red-400 border-b border-gray-700 pb-2">
                                ブロック済みユーザー <span className="text-sm font-normal text-gray-400 ml-2">({blockedIds.length})</span>
                            </h4>

                            <div className="max-h-60 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                                {blockedIds.length === 0 ? (
                                    <div className="text-center text-gray-500 py-6 bg-black bg-opacity-20 rounded-lg">
                                        ブロックしているユーザーはいません
                                    </div>
                                ) : (
                                    blockedIds.map(uid => (
                                        <div key={uid} className="flex justify-between items-center bg-black bg-opacity-30 p-3 rounded-lg border border-gray-700/30 hover:bg-opacity-40 transition-colors">
                                            <div className="flex items-center gap-3">
                                                <span className="w-2 h-2 rounded-full bg-red-500"></span>
                                                <span className="font-mono text-sm text-gray-300">{uid}</span>
                                            </div>
                                            <button
                                                onClick={() => handleUnblock(uid)}
                                                disabled={isSaving}
                                                className="text-xs bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded transition-colors shadow-sm"
                                            >
                                                解除
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="premium-modal-overlay" onClick={onClose}>
            <div className="premium-modal-content" onClick={e => e.stopPropagation()}>
                <button onClick={onClose} className="premium-close-btn" title="閉じる">✖</button>
                <button
                    onClick={() => setShowSettings(true)}
                    className="absolute top-6 left-6 transition-all z-10 shadow-lg hover:scale-110"
                    style={{
                        width: '40px',
                        height: '40px',
                        borderRadius: '50%',
                        backgroundColor: '#374151',
                        border: '1px solid rgba(255,255,255,0.2)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'white',
                        fontSize: '20px',
                        cursor: 'pointer'
                    }}
                    title="通知設定"
                >
                    ⚙️
                </button>

                {/* タイトルエリア */}
                <div className="text-center mb-6 mt-2 px-12">
                    <h3 className="text-3xl font-bold bg-gradient-to-r from-pink-500 to-purple-500 bg-clip-text text-transparent inline-block">お知らせ一覧 (v2.1)</h3>
                </div>

                {/* ツールバーエリア */}
                <div className="flex justify-end items-center gap-2 mb-4 flex-wrap px-2">
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

                    {/* 一括既読 */}
                <div className="flex gap-2">
                    <button
                        onClick={onMarkAllRead}
                        className="btn btn-blue notice-all-read-btn border-none"
                        style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                    >
                        全既読
                    </button>
                    {/* [NEW] 履歴消去ボタン */}
                    <button
                        onClick={onClearHistory}
                        className="btn btn-yellow border-none"
                        style={{ padding: '4px 12px', fontSize: '0.8rem', backgroundColor: '#f59e0b', color: '#fff' }}
                        title="現在の通知をすべて非表示にします"
                    >
                        履歴消去
                    </button>
                </div>
            </div>

                <div className="activity-log-scroll-area pr-2 space-y-3">
                    {filteredNotices.length === 0 ? (
                        <div className="text-center py-20 opacity-40 italic text-sm">お知らせはありません</div>
                    ) : (
                        filteredNotices.map(n => {
                            const isRead = readNoticeIds.includes(n.id) || (new Date(n.date).getTime() <= lastNoticeReadAllTime);
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
