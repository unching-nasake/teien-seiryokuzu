import { memo, useState } from 'react';
import { createPortal } from 'react-dom';

function AccountModal({ playerData, gardenMode, gardenAuthKey, onClose, onAuthUpdate }) {
  const [displayName, setDisplayName] = useState(playerData?.displayName || '');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const handleUpdateDisplayName = async () => {
    if (!displayName.trim()) return;
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch('/api/player/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName }),
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setSuccess('ユーザー名を更新しました');
        onAuthUpdate(); // Refresh state in App.jsx
      } else {
        setError(data.error || '更新に失敗しました');
      }
    } catch (err) {
      setError('通信エラーが発生しました');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdatePassword = async () => {
    if (password.length < 4) {
      setError('パスワードは4文字以上にしてください');
      return;
    }
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch('/api/player/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setSuccess('パスワードを更新しました');
        setPassword('');
      } else {
        setError(data.error || '更新に失敗しました');
      }
    } catch (err) {
      setError('通信エラーが発生しました');
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <div className="premium-modal-overlay fadeIn" onClick={onClose}>
      <div
        className="premium-modal-content premium-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '95%',
          maxWidth: '450px',
          padding: '24px',
          animation: 'modal-pop-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
          position: 'relative',
          background: 'rgba(26, 46, 33, 0.98)',
          backdropFilter: 'blur(20px)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.6)',
          maxHeight: '90vh',
          overflowY: 'auto'
        }}
      >
        <button className="premium-close-btn" onClick={onClose} style={{ top: '16px', right: '16px', width: '32px', height: '32px' }}>×</button>

        <h2 style={{
          margin: '0 0 20px 0',
          fontSize: '1.5rem',
          fontWeight: '700',
          background: 'linear-gradient(135deg, var(--accent), #34d399)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          textAlign: 'center'
        }}>
          アカウント設定
        </h2>

        {(error || success) && (
          <div style={{
            background: error ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)',
            border: `1px solid ${error ? 'var(--error)' : 'var(--success)'}`,
            color: error ? 'var(--error)' : 'var(--success)',
            padding: '12px',
            borderRadius: '8px',
            fontSize: '0.85rem',
            marginBottom: '16px',
            textAlign: 'center'
          }}>
            {error || success}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Garden Mode Auth Key Info */}
          {gardenMode && (playerData?.gardenAuthKey || gardenAuthKey) && (
            <div style={{
              background: 'rgba(236, 72, 153, 0.1)',
              border: '1px solid rgba(236, 72, 153, 0.3)',
              borderRadius: '12px',
              padding: '16px',
              textAlign: 'center',
              cursor: 'pointer'
            }}
            onClick={() => {
                const key = playerData?.gardenAuthKey || gardenAuthKey;
                if (key) {
                   navigator.clipboard.writeText(key).then(() => alert("認証キーをコピーしました"));
                }
            }}
            title="クリックしてコピー"
            >
              <div style={{ fontSize: '0.8rem', color: 'var(--accent)', fontWeight: 'bold', marginBottom: '8px' }}>
                🌸 庭園モード認証キー (本日有効)
              </div>
              <div style={{
                fontSize: '1.8rem',
                fontWeight: '900',
                letterSpacing: '4px',
                color: '#fff',
                textShadow: '0 0 10px rgba(236, 72, 153, 0.5)'
              }}>
                {playerData?.gardenAuthKey || gardenAuthKey}
              </div>
              <div style={{
                marginTop: '12px',
                padding: '4px 12px',
                borderRadius: '99px',
                fontSize: '0.85rem',
                fontWeight: 'bold',
                display: 'inline-block',
                background: playerData?.gardenIsAuthorized ? 'rgba(52, 211, 153, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                color: playerData?.gardenIsAuthorized ? '#10b981' : '#ef4444',
                border: `1px solid ${playerData?.gardenIsAuthorized ? '#10b981' : '#ef4444'}`
              }}>
                {playerData?.gardenIsAuthorized ? '✓ 認証済み' : '✗ 未認証'}
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '8px' }}>
                このキーを掲示板の名前に含めて書き込んでください。<br/>
                日付が変わると再発行されます。(クリックでコピー)
              </p>
            </div>
          )}

          {/* Display Name Section */}
          <div className="input-group">
            <label className="input-label">ユーザー名 (最大20文字)</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                className="input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="新しいユーザー名"
                maxLength={20}
                style={{ flex: 1, background: 'rgba(0,0,0,0.2)' }}
              />
              <button
                className="btn btn-primary"
                onClick={handleUpdateDisplayName}
                disabled={loading || !displayName.trim() || displayName === playerData?.displayName}
                style={{ padding: '0 16px', fontSize: '0.9rem' }}
              >
                変更
              </button>
            </div>
          </div>

          {/* Password Section */}
          <div className="input-group">
            <label className="input-label">パスワード変更</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="4文字以上"
                style={{ flex: 1, background: 'rgba(0,0,0,0.2)' }}
              />
              <button
                className="btn btn-warning"
                onClick={handleUpdatePassword}
                disabled={loading || password.length < 4}
                style={{ padding: '0 16px', fontSize: '0.9rem' }}
              >
                更新
              </button>
            </div>
          </div>

          <div style={{
            marginTop: '8px',
            padding: '12px',
            background: 'rgba(255,255,255,0.03)',
            borderRadius: '8px',
            fontSize: '0.8rem',
            color: 'var(--text-secondary)'
          }}>
            <div style={{ marginBottom: '4px' }}>ユーザーID: <code style={{ color: '#fff' }}>{playerData?.id}</code></div>
            <div>登録日: {playerData?.createdAt ? new Date(playerData.createdAt).toLocaleDateString() : '不明'}</div>
          </div>

          <button
            className="btn btn-secondary"
            onClick={onClose}
            style={{ width: '100%' }}
          >
            閉じる
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default memo(AccountModal);
