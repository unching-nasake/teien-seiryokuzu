import { memo, useEffect, useMemo, useState } from 'react';
import { LOG_TYPES, getLogCategory, getLogMessageText } from '../utils/logFormatter';
import './ActivityLogModal.css';

function ActivityLogModal({ activityLog, onClose, onJumpTo, factions, onLoadMore, onSearch }) {
  const [filter, setFilter] = useState('all');
  const [factionFilter, setFactionFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [isLoadingMore, setIsLoadingMore] = useState(false); // [NEW]

  // Server-side Search Debounce
  useEffect(() => {
     if (!onSearch) return;
     const timer = setTimeout(() => {
         onSearch(searchTerm);
     }, 500); // 500ms debounce
     return () => clearTimeout(timer);
  }, [searchTerm, onSearch]);

  // メッセージ内の座標をリンクに変換してレンダリング
  const renderLogMessage = (log) => {
      // アイコン付きテキスト取得（アイコンは別途表示するのでテキストのみ抽出したいが、
      // getLogWithIconはアイコン込みの文字列を返す。
      // ここでは既存ロジックを活かしつつ、アイコンを分離して表示するために
      // メッセージ本体のパースに注力する。
      const rawText = getLogMessageText(log);
      if (!rawText) return null;

      // 正規表現で (x, y) を検索
      const regex = /\((\d+),\s*(\d+)\)/g;
      const parts = [];
      let lastIndex = 0;
      let match;

      while ((match = regex.exec(rawText)) !== null) {
          // マッチ前のテキストを追加
          if (match.index > lastIndex) {
              parts.push(rawText.substring(lastIndex, match.index));
          }

          const x = parseInt(match[1], 10);
          const y = parseInt(match[2], 10);
          const coordText = match[0];

          // リンク（ボタン）として追加
          parts.push(
              <button
                  key={`coord-${match.index}`}
                  className="coord-link"
                  onClick={(e) => {
                      e.stopPropagation();
                      if (onJumpTo) {
                           onJumpTo(x, y);
                           onClose(); // モーダルを閉じる
                      }
                  }}
                  title={`座標 (${x}, ${y}) へジャンプ`}
              >
                  📍 {coordText}
              </button>
          );

          lastIndex = match.index + match[0].length;
      }

      // 残りのテキストを追加
      if (lastIndex < rawText.length) {
          parts.push(rawText.substring(lastIndex));
      }

      return <>{parts}</>;
  };

  // 時間フォーマッター
  const formatTime = (isoString) => {
      if (!isoString) return '';
      const date = new Date(isoString);
      return date.toLocaleString('ja-JP', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
      });
  };

  // フィルタリングロジック
  const filteredLog = useMemo(() => {
    if (!activityLog) return [];

    return activityLog.filter(log => {
      const msg = getLogMessageText(log);
      if (!msg) return false;
      const category = getLogCategory(log);

      // テキスト検索
      if (searchTerm && !msg.toLowerCase().includes(searchTerm.toLowerCase())) {
          return false;
      }

      // 勢力フィルタ
      if (factionFilter !== 'all') {
          const logFid = log.data?.factionId || log.factionId;
          if (logFid !== factionFilter) return false;
      }

      // カテゴリフィルタ
      if (filter === 'all') return true;
      if (filter === 'diplomacy') {
          return category === 'diplomacy';
      }
      return category === filter;
    });
  }, [activityLog, filter, factionFilter, searchTerm]);

  return (
    <div className="premium-modal-overlay">
      <div
        className="premium-modal-content wide-modal activity-log-modal"
        onClick={e => e.stopPropagation()}
      >
        {/* Close Button Header */}
        <button onClick={onClose} className="close-button-absolute" title="閉じる">✖</button>

        <div className="activity-log-header">
            <h3 className="activity-log-title">
                <span>📜</span> アクティビティログ
            </h3>

            <div className="activity-log-controls">
                {/* 検索バー */}
                <div className="material-input-group">
                    <input
                        type="text"
                        className="material-input"
                        placeholder="キーワード検索..."
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                    />
                </div>

                {/* 勢力フィルタ */}
                {factions && (
                    <div className="material-input-group select-wrapper">
                        <select
                            className="material-select"
                            value={factionFilter}
                            onChange={e => setFactionFilter(e.target.value)}
                        >
                            <option value="all">全勢力</option>
                            {Object.values(factions).map(f => (
                                <option key={f.id} value={f.id}>{f.name}</option>
                            ))}
                        </select>
                    </div>
                )}

                {/* カテゴリフィルタ */}
                <div className="material-input-group select-wrapper">
                    <select
                        className="material-select"
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                    >
                        <option value="all">全てのカテゴリ</option>
                        <option value="war">戦闘</option>
                        <option value="diplomacy">外交</option>
                        <option value="faction">勢力動向</option>
                        <option value="system">システム</option>
                        <option value="other">その他</option>
                    </select>
                </div>
            </div>
        </div>

        <div className="activity-log-scroll-area">
            {(!filteredLog || filteredLog.length === 0) ? (
                <div className="empty-state">
                    <p>表示できるログがありません</p>
                </div>
            ) : (
                filteredLog.map((log, index) => {
                    const messageContent = renderLogMessage(log);
                    const time = formatTime(log.time || log.timestamp);
                    const category = getLogCategory(log);
                    const style = LOG_TYPES[category] || LOG_TYPES.other;

                    return (
                        <div key={index} className="log-card">
                            <div className="log-card-indicator" style={{ background: style.color }}></div>

                            <div className="log-icon-container" style={{ color: style.color }}>
                                {style.icon}
                            </div>

                            <div className="log-content">
                                <div className="log-message">
                                    {messageContent}
                                </div>
                                <div className="log-meta">
                                     <span
                                        className="log-tag"
                                        style={{ color: style.color, background: `${style.color}20` }}
                                     >
                                        {style.label}
                                     </span>
                                     <span className="log-time">{time}</span>
                                </div>
                            </div>
                        </div>
                    );
                })
            )}


            {/* Load More Button */}
            {onLoadMore && filteredLog.length > 0 && (
                <div style={{ padding: '10px', textAlign: 'center' }}>
                    <button
                        className="btn btn-secondary"
                        style={{ width: '100%', padding: '8px' }}
                        disabled={isLoadingMore}
                        onClick={async () => {
                            if (isLoadingMore) return;
                            setIsLoadingMore(true);
                            // Get the oldest ID currently loaded
                            // Note: filteredLog might apply filters, so we should probably look at the full activityLog
                            // But usually users want to load more of *filtered* stuff? No, API loads chronologically.
                            // We should use the oldest ID from the *full* list.
                            const lastEntry = activityLog[activityLog.length - 1];
                            if (lastEntry) {
                                const count = await onLoadMore(lastEntry.id);
                                if (count === 0) {
                                    alert("これ以上古いログはありません");
                                }
                            }
                            setIsLoadingMore(false);
                        }}
                    >
                        {isLoadingMore ? '読み込み中...' : 'さらに読み込む'}
                    </button>
                </div>
            )}
        </div>
      </div>
    </div>
  );
}

export default memo(ActivityLogModal);
