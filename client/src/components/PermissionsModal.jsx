
const PermissionsModal = ({ onClose, permissions, roleName }) => {
    // 権限リストの定義 (キーと表示名)
    const PERMISSION_LABELS = {
        canManageSettings: "基本設定",
        canUseSharedAp: "共有AP利用",
        canDiplomacy: "外交",
        canDeclareWar: "開戦",
        canManageMembers: "人事"
    };

    return (
        <div className="modal-overlay" onClick={onClose} style={{ zIndex: 4000 }}>
            <div
                className="modal-content"
                onClick={e => e.stopPropagation()}
                style={{
                    width: '90%',
                    maxWidth: '400px',
                    background: 'rgba(20, 20, 30, 0.95)',
                    border: '1px solid #4ade80',
                    borderRadius: '12px',
                    padding: '20px',
                    color: '#fff'
                }}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <h3 style={{ margin: 0, color: '#4ade80' }}>🔑 自分の権限一覧</h3>
                    <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#aaa', fontSize: '1.5rem', cursor: 'pointer' }}>×</button>
                </div>

                <div style={{ marginBottom: '16px', fontSize: '0.95rem', color: '#ccc' }}>
                    現在の役職: <span style={{ fontWeight: 'bold', color: '#fff' }}>{roleName}</span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {Object.entries(PERMISSION_LABELS).map(([key, label]) => {
                        const hasPerm = permissions && permissions[key];
                        return (
                            <div key={key} style={{
                                display: 'flex', alignItems: 'center', gap: '10px',
                                padding: '8px',
                                background: hasPerm ? 'rgba(74, 222, 128, 0.1)' : 'rgba(255, 255, 255, 0.05)',
                                borderRadius: '6px',
                                border: hasPerm ? '1px solid rgba(74, 222, 128, 0.3)' : '1px solid transparent'
                            }}>
                                <span style={{ fontSize: '1.2rem' }}>{hasPerm ? '✅' : '❌'}</span>
                                <span style={{ color: hasPerm ? '#fff' : '#888' }}>{label}</span>
                            </div>
                        );
                    })}
                </div>

                <div style={{ marginTop: '20px', textAlign: 'center' }}>
                    <button className="btn btn-secondary" onClick={onClose} style={{ width: '100%' }}>閉じる</button>
                </div>
            </div>
        </div>
    );
};

export default PermissionsModal;
