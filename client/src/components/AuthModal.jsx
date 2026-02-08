import { memo, useState } from 'react';
import { createPortal } from 'react-dom';

function AuthModal({ onClose, onAuth }) {
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authKey, setAuthKey] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setAuthKey(null);

    const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/signup';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        credentials: 'include'
      });

      const data = await res.json();

      if (res.ok && data.success) {
        onAuth(data);
        onClose();
      } else {
        if (data.error === 'garden_auth_required' && data.authKey) {
            setAuthKey(data.authKey);
        }
        setError(data.message || data.error || (mode === 'login' ? 'ログインに失敗しました' : '登録に失敗しました'));
      }
    } catch (err) {
      console.error(err);
      setError('サーバーとの通信に失敗しました');
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
          width: '90%',
          maxWidth: '400px',
          padding: '32px',
          animation: 'modal-pop-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
          position: 'relative',
          background: 'rgba(26, 46, 33, 0.95)',
          backdropFilter: 'blur(20px)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
        }}
      >
        <button className="premium-close-btn" onClick={onClose} style={{ top: '16px', right: '16px', width: '32px', height: '32px' }}>×</button>

        <h2 style={{
          margin: '0 0 8px 0',
          fontSize: '1.5rem',
          fontWeight: '700',
          background: 'linear-gradient(135deg, var(--accent), #34d399)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          textAlign: 'center'
        }}>
          {mode === 'login' ? 'ログイン' : '新規アカウント作成'}
        </h2>
        <p style={{
          textAlign: 'center',
          color: 'var(--text-secondary)',
          fontSize: '0.9rem',
          marginBottom: '24px'
        }}>
          {mode === 'login'
            ? 'おかえりなさい！ログインしてプレイを再開しましょう。'
            : 'ユーザー名とパスワードを設定して、庭園の世界へ。'}
        </p>

        {error && (
          <div style={{
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid var(--error)',
            color: 'var(--error)',
            padding: '12px',
            borderRadius: '8px',
            fontSize: '0.85rem',
            marginBottom: '16px',
            textAlign: 'center'
          }}>
            {error}
          </div>
        )}

        {authKey && (
          <div style={{
            background: 'rgba(236, 72, 153, 0.15)',
            border: '2px solid rgba(236, 72, 153, 0.4)',
            borderRadius: '12px',
            padding: '16px',
            textAlign: 'center',
            marginBottom: '20px',
            animation: 'pulse-glow 2s infinite ease-in-out'
          }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--accent)', fontWeight: 'bold', marginBottom: '8px' }}>
              🌸 認証キー
            </div>
            <div style={{
              fontSize: '2rem',
              fontWeight: '900',
              letterSpacing: '4px',
              color: '#fff',
              textShadow: '0 0 15px rgba(236, 72, 153, 0.6)'
            }}>
              {authKey}
            </div>
            <p style={{ fontSize: '0.75rem', color: '#fda4af', marginTop: '8px', fontWeight: 'bold' }}>
              このキーを掲示板の名前に含めて書き込んだ後、<br/>再度ボタンを押してください。
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="input-group">
            <label className="input-label">ユーザー名 (日本語可)</label>
            <input
              type="text"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="例: 庭園太郎"
              required
              autoFocus
              style={{
                background: 'rgba(0, 0, 0, 0.2)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                padding: '12px 16px'
              }}
            />
          </div>

          <div className="input-group">
            <label className="input-label">パスワード</label>
            <input
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="4文字以上"
              required
              minLength={4}
              style={{
                background: 'rgba(0, 0, 0, 0.2)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                padding: '12px 16px'
              }}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading}
            style={{
              marginTop: '8px',
              padding: '14px',
              fontSize: '1rem',
              boxShadow: '0 4px 12px rgba(236, 72, 153, 0.3)'
            }}
          >
            {loading ? '処理中...' : (mode === 'login' ? 'ログイン' : 'アカウント作成')}
          </button>
        </form>

        <div style={{
          marginTop: '24px',
          textAlign: 'center',
          fontSize: '0.9rem',
          color: 'var(--text-secondary)'
        }}>
          {mode === 'login' ? 'まだアカウントをお持ちでないですか？' : '既にアカウントをお持ちですか？'}
          <button
            onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent)',
              fontWeight: '600',
              cursor: 'pointer',
              marginLeft: '8px',
              padding: '4px 8px'
            }}
          >
            {mode === 'login' ? '新規登録' : 'ログイン'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default memo(AuthModal);
