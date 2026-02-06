import { memo, useState } from 'react';

function LeaveFactionModal({ onClose, onConfirm, apCost, factionName, playerTilesCount = 0, independenceEligibleCount = 0, playerData }) {
  const [mode, setMode] = useState('leave'); // 'leave' or 'independence'
  const [newFactionName, setNewFactionName] = useState('');
  const [newFactionColor, setNewFactionColor] = useState('#ff0000');
  const [isProcessing, setIsProcessing] = useState(false);

  const handleSubmit = async () => {
    if (mode === 'independence') {
        if (!newFactionName.trim()) {
            alert('勢力名を入力してください');
            return;
        }
        if (newFactionColor.toLowerCase() === '#ffffff') {
            alert('白色は勢力色として使用できません');
            return;
        }
    }

    if (!window.confirm(
        mode === 'independence'
        ? `本当に独立しますか？\n・元の勢力「${factionName}」に対し宣戦布告を行います（戦争状態になります）\n・自分の塗った領土を引き継ぎます`
        : `本当に脱退しますか？\n・領土は放棄されます`
    )) {
        return;
    }

    setIsProcessing(true);
    await onConfirm({
        isIndependence: mode === 'independence',
        newFactionName: mode === 'independence' ? newFactionName : null,
        newFactionColor: mode === 'independence' ? newFactionColor : null
    });
    setIsProcessing(false);
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '500px' }}>
        <div className="modal-header">
          <h2>勢力からの脱退</h2>
        </div>
        <div className="modal-body">
          <p style={{marginBottom: '16px'}}>
            現在の勢力: <span style={{fontWeight:'bold'}}>{factionName}</span>
          </p>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
            <button
                className={`btn ${mode === 'leave' ? 'btn-danger' : 'btn-secondary'}`}
                style={{ flex: 1, opacity: mode === 'leave' ? 1 : 0.6 }}
                onClick={() => setMode('leave')}
            >
                単独で脱退 (放浪)
            </button>
            <button
              className={`btn ${mode === "independence" ? "btn-primary" : "btn-secondary"}`}
              style={{
                flex: 1,
                opacity: mode === "independence" ? 1 : 0.6,
              }}
              onClick={() => setMode("independence")}
            >
              領土を持って独立
            </button>
          </div>

          {/* 独立制限アラート */}
          {(() => {
            if (!playerData?.lastFactionLeft) return null;
            const elapsed = Date.now() - playerData.lastFactionLeft;
            const COOLDOWN_MS = 3 * 60 * 60 * 1000;
            if (elapsed < COOLDOWN_MS) {
              const remaining = (
                (COOLDOWN_MS - elapsed) /
                (1000 * 60 * 60)
              ).toFixed(1);
              return (
                <div
                  style={{
                    padding: "8px",
                    background: "rgba(239, 68, 68, 0.2)",
                    borderRadius: "6px",
                    border: "1px solid #ef4444",
                    fontSize: "0.85rem",
                    color: "#fecaca",
                    marginBottom: "16px",
                    textAlign: "center",
                  }}
                >
                  勢力操作（加入・脱退等）から3時間経過するまで独立はできません（残り約{" "}
                  {remaining} 時間）
                </div>
              );
            }
            return null;
          })()}

          <div style={{
              padding: '12px',
              background: 'rgba(0,0,0,0.2)',
              borderRadius: '8px',
              border: '1px solid rgba(255,255,255,0.1)',
              marginBottom: '16px'
          }}>
            {mode === 'leave' ? (
                <div>
                    <h3 style={{fontSize: '1rem', color: '#ff6b6b', marginBottom: '8px'}}>⚠ 単独脱退の注意点</h3>
                    <ul style={{fontSize: '0.9rem', paddingLeft: '20px', lineHeight: '1.5'}}>
                        <li>現在所属している勢力から抜けます。</li>
                        <li>あなたが獲得した領土は、元の勢力に残ります。</li>
                        <li>脱退後3時間は、新規建国や再度の独立が制限されます。</li>
                    </ul>
                </div>
            ) : (
                <div>
                     <h3 style={{fontSize: '1rem', color: '#60a5fa', marginBottom: '12px'}}>👑 独立・建国の設定</h3>
                     <div style={{marginBottom: '12px'}}>
                         <label style={{display:'block', fontSize:'0.85rem', marginBottom:'4px'}}>新しい勢力名</label>
                         <input
                            type="text"
                            className="input"
                            style={{width: '100%'}}
                            value={newFactionName}
                            onChange={e => setNewFactionName(e.target.value)}
                            maxLength={20}
                            placeholder="勢力名を入力..."
                         />
                     </div>
                     <div style={{marginBottom: '12px'}}>
                         <label style={{display:'block', fontSize:'0.85rem', marginBottom:'4px'}}>勢力カラー</label>
                         <div style={{display:'flex', gap:'8px', alignItems:'center'}}>
                            <input
                                type="color"
                                value={newFactionColor}
                                onChange={e => setNewFactionColor(e.target.value)}
                                style={{width:'50px', height:'30px', border:'none', padding:0, cursor:'pointer'}}
                            />
                            <input
                                type="text"
                                className="input"
                                value={newFactionColor}
                                onChange={e => setNewFactionColor(e.target.value)}
                                style={{width:'100px'}}
                            />
                         </div>
                     </div>
                     <div style={{marginTop: '12px', padding: '8px', background: 'rgba(255,0,0,0.15)', borderRadius: '4px'}}>
                        <h4 style={{fontSize: '0.9rem', color: '#f87171', marginBottom: '4px'}}>⚠ 宣戦布告について</h4>
                        <p style={{fontSize: '0.85rem'}}>
                            独立すると同時に、元の勢力に対して<span style={{fontWeight:'bold', color: '#ff4d4d'}}>自動的に宣戦布告</span>が行われます。<br/>
                            あなたが確保していた領土は新勢力のものとなりますが、即座に戦争状態となります。
                        </p>
                     </div>
                </div>
            )}
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button className="btn btn-secondary" onClick={onClose} disabled={isProcessing}>キャンセル</button>
                <button
                    className={`btn ${mode === 'leave' ? 'btn-danger' : 'btn-primary'}`}
                    onClick={handleSubmit}
                    disabled={isProcessing || (mode === 'independence' && (
                        !newFactionName.trim() ||
                        playerTilesCount === 0 ||
                        independenceEligibleCount === 0 ||
                        (playerData?.lastFactionLeft && (Date.now() - playerData.lastFactionLeft < 3 * 60 * 60 * 1000))
                    ))}
                >
                    {isProcessing ? '処理中...' : (mode === 'leave' ? '脱退する' : '独立して宣戦布告')}
                </button>
            </div>
            {mode === 'independence' && playerTilesCount > 0 && independenceEligibleCount === 0 && (
                <p style={{ color: '#ff4d4d', fontSize: '0.8rem', marginTop: '8px', textAlign: 'right', fontWeight: 'bold' }}>
                    ※持ち逃げするタイルがすべて他勢力の中核マス（奪えないマス）のため、新勢力の拠点が作れず独立できません。
                </p>
            )}
            {mode === 'independence' && playerTilesCount === 0 && (
                <p style={{ color: '#ff4d4d', fontSize: '0.8rem', marginTop: '8px', textAlign: 'right', fontWeight: 'bold' }}>
                    ※引き継げる領土（あなたが塗ったタイル）がないため、独立できません。
                </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(LeaveFactionModal);
