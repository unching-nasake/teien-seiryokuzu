import React, { useState } from 'react';
import { createPortal } from 'react-dom';

function NoticePopup({ notice, onClose, onAccept, onReject, onAction, currentUser, onUpdateUser }) {
  const [isBlocking, setIsBlocking] = useState(false);

  if (!notice) return null;

  const noticeActions = notice.options?.actions || [];
  const hasActions = noticeActions.length > 0;

  const noticeText = notice.content || "";

  const isRequest = hasActions ||
                    noticeText.includes("同盟要請が届きました") ||
                    noticeText.includes("同盟加入申請が届きました") ||
                    noticeText.includes("併合要請が届きました") ||
                    noticeText.includes("停戦要請が届きました") ||
                    noticeText.includes("領土割譲の提案が届きました") ||
                    noticeText.includes("参戦提案が届きました") ||
                    notice.title === "参戦提案" ||
                    notice.title === "領土割譲の提案";

  // 送信者IDの取得 (外交メッセージの場合)
  const senderId = notice.data?.senderId || notice.senderId;
  const canBlock = senderId && currentUser && currentUser.id !== senderId;

  // ブロック処理
  const handleBlockUser = async () => {
    if (!window.confirm("このユーザーをブロックしますか？\n今後このユーザーからのメッセージ通知は届かなくなります。")) return;

    setIsBlocking(true);
    try {
        const currentBlocked = currentUser.blockedPlayerIds || [];
        // 既にブロック済みなら何もしない
        if (currentBlocked.includes(senderId)) {
            alert("既にブロックしています");
            return;
        }

        const newBlocked = [...currentBlocked, senderId];

        const res = await fetch('/api/me/diplomacy/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                blockedPlayerIds: newBlocked
            }),
            credentials: 'include'
        });
        const data = await res.json();
        if (data.success) {
            if (onUpdateUser) {
                onUpdateUser(prev => ({
                    ...prev,
                    blockedPlayerIds: data.blockedPlayerIds
                }));
            }
            alert("ブロックしました");
            onClose(); // 閉じる
        } else {
            alert(data.error || "ブロックに失敗しました");
        }
    } catch (e) {
        console.error(e);
        alert("通信エラー");
    } finally {
        setIsBlocking(false);
    }
  };

  // 画像URLを抽出して埋め込み表示用に処理
  const imageUrlMatch = notice.content?.match(/📍 割譲対象マップ: (.+)/);
  const imageUrl = imageUrlMatch ? imageUrlMatch[1].trim() : null;
  const contentWithoutImageUrl = imageUrl
    ? notice.content.replace(/📍 割譲対象マップ: .+/, '').trim()
    : notice.content;

  // URLをリンクに変換する関数
  const renderContentWithLinks = (content) => {
    if (!content) return null;
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = content.split(urlRegex);

    return parts.map((part, i) => {
      if (part.match(urlRegex)) {
        return (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', textDecoration: 'underline' }}>
            {part}
          </a>
        );
      }
      return part;
    });
  };

  return createPortal(
    <div className="modal-overlay" style={{ zIndex: 1000000 }}>
      {/* クリックで閉じる (Overlay) */}
      <div className="absolute inset-0" onClick={onClose}></div>

      <div className="modal-content relative" style={{ maxWidth: '500px', width: '90%' }} onClick={e => e.stopPropagation()}>

        {/* ブロックボタン (右上) */}
        {canBlock && (
            <button
                onClick={handleBlockUser}
                disabled={isBlocking}
                className="absolute top-2 right-12 text-gray-500 hover:text-red-500 text-sm border border-gray-700 hover:border-red-500 px-2 py-1 rounded transition-colors"
                title="このユーザーをブロック"
            >
                🚫 ブロック
            </button>
        )}

        <div className="modal-header" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
          <h2 style={{ margin: 0, fontSize: '1.2rem', paddingRight: '60px' }}>{notice.title}</h2>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {new Date(notice.date).toLocaleString('ja-JP')}
          </div>
        </div>
        <div className="modal-body" style={{ maxHeight: '60vh', overflowY: 'auto', whiteSpace: 'pre-wrap', lineHeight: '1.6' }}>
          {renderContentWithLinks(contentWithoutImageUrl)}
          {imageUrl && (
            <div style={{ marginTop: '15px', textAlign: 'center' }}>
              <img
                src={imageUrl}
                alt="割譲対象マップ"
                style={{
                  maxWidth: '100%',
                  border: '2px solid #FFD700',
                  borderRadius: '4px',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.3)'
                }}
              />
            </div>
          )}
          {isRequest && (
              <div style={{ marginTop: '15px', padding: '10px', background: 'rgba(255,255,255,0.05)', borderRadius: '5px', fontSize: '0.9rem' }}>
                  ※この要請には下のボタンから回答できます。
              </div>
          )}
        </div>
        <div className="modal-footer" style={{ justifyContent: 'flex-end', gap: '10px' }}>
          {/* Specific Legacy Handlers (if provided) */}
          {isRequest && onAccept && !hasActions && (
              <button className="btn btn-primary" onClick={() => { onAccept(); }}>承認する</button>
          )}
          {isRequest && onReject && !hasActions && (
              <button className="btn btn-danger" onClick={() => { onReject(); }}>拒否する</button>
          )}

          {/* Standardized Actions (Season 2 style) */}
          {hasActions && noticeActions.map((action, idx) => (
              <button
                  key={idx}
                  className={`btn btn-${action.style || 'primary'}`}
                  onClick={() => {
                      if (onAction) {
                          onAction(notice.id, action.action, action);
                      }
                  }}
              >
                  {action.label}
              </button>
          ))}

          <button className="btn btn-secondary" style={{ background: '#555' }} onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default React.memo(NoticePopup);
