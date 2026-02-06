import { useState } from 'react';
import { createPortal } from 'react-dom';

function CreateFactionModal({ origin, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(() => {
    // Generate random color on mount
    const randomColor = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
    return randomColor;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();

    const cleanName = name.replace(/[\s\u200B-\u200D\uFEFF]/g, '');
    if (cleanName.length === 0) {
      setError('勢力名には有効な文字を入力してください');
      return;
    }

    if (color.toLowerCase() === '#ffffff') {
      setError('白色(#ffffff)は勢力色として使用できません。');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/factions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: name.trim(),
          color,
          origin: { x: origin.x, y: origin.y } // 修正: オブジェクトとして送信
        })
      });

      const data = await res.json();

      if (data.success) {
        onCreated(data.faction);
      } else {
        setError(data.error || '勢力の作成に失敗しました');
      }
    } catch (e) {
      console.error(e);
      setError('エラーが発生しました: ' + (e.message || 'unknown'));
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2 className="modal-title">新規勢力を作成</h2>


        <form onSubmit={handleSubmit}>
          <div className="input-group">
            <label className="input-label">起点座標</label>
            <div style={{
              padding: '10px 14px',
              background: 'rgba(0,0,0,0.3)',
              borderRadius: '8px',
              fontSize: '0.95rem'
            }}>
              ({origin.x}, {origin.y})
            </div>
          </div>

          <div className="input-group">
            <label className="input-label">勢力名</label>
            <input
              type="text"
              className="input"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="例: 庭師同盟"
              maxLength={20}
            />
          </div>

          <div className="input-group">
            <label className="input-label">勢力カラー</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <input
                type="color"
                value={color}
                onChange={e => setColor(e.target.value)}
                style={{ height: '40px', width: '60px', border: 'none', background: 'none', cursor: 'pointer' }}
              />
              <input
                type="text"
                className="input"
                value={color}
                onChange={e => setColor(e.target.value)}
                placeholder="#RRGGBB"
                style={{ flex: 1, padding: '8px 12px' }}
              />
            </div>
          </div>

          {error && (
            <p style={{ color: 'var(--error)', fontSize: '0.9rem', marginBottom: '12px' }}>
              {error}
            </p>
          )}

          <div style={{ display: 'flex', gap: '8px', marginTop: '20px' }}>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading}
              style={{ flex: 1 }}
            >
              {loading ? '作成中...' : '勢力を作成'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              style={{ flex: 1 }}
            >
              キャンセル
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

export default CreateFactionModal;
