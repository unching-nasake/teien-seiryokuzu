import { memo, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import './RoleSettingsModal.css';

const PERMISSION_LABELS = {
  canManageSettings: "基本設定",
  canUseSharedAp: "共有AP利用",
  canDiplomacy: "外交",
  canDeclareWar: "開戦",
  canManageMembers: "⚠人事"
};

const PERMISSION_DESCRIPTIONS = {
  canManageSettings: "勢力名・色の変更、ネームドマスの作成・破壊、およびマス消しができます。",
  canManageMembers: "役職の管理やメンバーの役職変更ができます。他人の権限を変更できる強力な権限のため、付与には注意が必要です。",
  canDiplomacy: "同盟申請、停戦申請、およびそれらの承認・破棄ができます。",
  canUseSharedAp: "自身のAPが不足した際、不足分を共有APから自動で消費して行動できます。",
  canDeclareWar: "戦争状態にない他勢力の領土を攻撃し、即座に戦争を開始できます。権限がない場合、非交戦勢力の領土への上書きは制限されます。"
};

function RoleSettingsModal({
  onClose,
  factionId,
  roles,
  memberRoles,
  members = [],
  onCreateRole,
  onUpdateRole,
  onDeleteRole,
  kingRoleName,
  onUpdateKingRole,
  onAssignRole = () => {},
  currentPlayerId
}) {
  const [activeTab, setActiveTab] = useState('roles'); // 'roles' | 'members'

  // Roles Tab State
  const [editingRole, setEditingRole] = useState(null); // null means creating new
  const [kingName, setKingName] = useState(kingRoleName || '勢力主');
  const [name, setName] = useState('');
  const [rank, setRank] = useState(2);
  const [permissions, setPermissions] = useState(
    Object.keys(PERMISSION_LABELS).reduce((acc, key) => ({ ...acc, [key]: false }), {})
  );

  const [isProcessing, setIsProcessing] = useState(false);
  const [hoveredPerm, setHoveredPerm] = useState(null);

  // メンバー割り当て用フィルタ
  const [memberFilter, setMemberFilter] = useState('');

  // 新規作成モードにリセット
  const resetForm = () => {
    setEditingRole(null);
    setName('');
    setRank(2);
    setPermissions(Object.keys(PERMISSION_LABELS).reduce((acc, key) => ({ ...acc, [key]: false }), {}));
  };

  // 編集モード開始
  const handleEdit = (role) => {
    setEditingRole(role);
    setName(role.name);
    setRank(role.rank || 2);

    // 以前の権限キーとの互換性マッピングも含める
    const newPerms = { ...role.permissions };
    if (newPerms.canEditSettings) newPerms.canManageSettings = true;
    if (newPerms.canManageAlliance || newPerms.canRequestTruce) newPerms.canDiplomacy = true;
    // canManageRoles があれば canManageMembers を有効に
    if (newPerms.canManageRoles) newPerms.canManageMembers = true;

    // [NEW] 統合・廃止された権限のマッピング
    if (newPerms.canInvite || newPerms.canKick) newPerms.canManageMembers = true;
    if (newPerms.canManageNamedTiles || newPerms.canErase) newPerms.canManageSettings = true;

    // UI用のstateに反映
    const nextPermissions = {};
    Object.keys(PERMISSION_LABELS).forEach(key => {
        nextPermissions[key] = !!newPerms[key];
    });
    setPermissions(nextPermissions);
  };

  // 保存処理
  const handleSave = async () => {
    if (!name.trim()) return;

    // ランクの重複チェック (自分自身は除外)
    const rankInt = parseInt(rank);
    const isDuplicate = roles.some(r => r.rank === rankInt && (!editingRole || r.id !== editingRole.id));
    if (isDuplicate) {
        alert("その序列数値は既に使用されています。別の数値を指定してください。");
        return;
    }

    setIsProcessing(true);
    try {
      if (editingRole) {
        await onUpdateRole(factionId, editingRole.id, { name, rank: parseInt(rank), permissions });
        // 保存後も編集モードを維持する (resetFormしない)
        alert("更新しました");
      } else {
        await onCreateRole(factionId, { name, rank: parseInt(rank), permissions });
        resetForm(); // 新規作成時はリセットでOK
        alert("作成しました");
      }
    } catch (e) {
      alert("エラーが発生しました: " + e.message);
    } finally {
      setIsProcessing(false);
    }
  };

  // 削除処理
  const handleDelete = async (roleId) => {
    if (!confirm("本当に役職を削除しますか？\n設定されているメンバーは権限を失います。")) return;
    setIsProcessing(true);
    try {
      await onDeleteRole(factionId, roleId);
      if (editingRole && editingRole.id === roleId) resetForm();
    } catch (e) {
      alert("エラーが発生しました: " + e.message);
    } finally {
      setIsProcessing(false);
    }
  };

  // 役職割り当て
  const handleRoleAssign = async (memberId, roleId) => {
      // roleId can be string "null" from select
      const targetRoleId = roleId === "null" ? null : roleId;
      setIsProcessing(true);
      try {
          await onAssignRole(memberId, targetRoleId);
      } catch(e) {
          console.error(e);
      } finally {
          setIsProcessing(false);
      }
  };

  // 初期化
  useEffect(() => {
    resetForm();
  }, []);

  // 自分のランクを取得
    const getMyRank = () => {
        // 勢力主なら最強(1相当)
        // currentPlayerId が正しく渡されていることを確認
        if (!currentPlayerId) return 9999;

        const me = members.find(m => m.id === currentPlayerId);
        // isKing フラグをチェック
        if (me?.isKing) return 1;

        // 次に役職によるランクをチェック
        const myRoleId = memberRoles[currentPlayerId];
        if (!myRoleId) return 9999; // 平メンバー

        const myRole = roles.find(r => r.id === myRoleId);
        return myRole ? (myRole.rank || 9999) : 9999;
    };
  const myRank = getMyRank();

  return createPortal(
    <div className="role-modal-overlay">
      <div className="role-modal-container">

        {/* Header */}
        <div className="role-modal-header">
            <div className="role-modal-title">
                役職・権限設定
                <span className="role-modal-subtitle">権限とメンバー管理</span>
            </div>

            <div className="role-tabs">
                <button
                    onClick={() => setActiveTab('roles')}
                    className={`role-tab ${activeTab === 'roles' ? 'active' : ''}`}
                >
                    役職設定
                </button>
                <button
                    onClick={() => setActiveTab('members')}
                    className={`role-tab ${activeTab === 'members' ? 'active' : ''}`}
                >
                    メンバー割り当て
                </button>
            </div>

            <button onClick={onClose} className="role-modal-close" title="閉じる">✖</button>
        </div>

        {/* Content */}
        <div className="role-content">

            {/* --- ROLES TAB --- */}
            {activeTab === 'roles' && (
                <>
                    {/* Sidebar List */}
                    <div className="role-sidebar">
                        <div className="sidebar-header">
                            <span className="sidebar-label">役職一覧</span>
                            <button onClick={resetForm} className="add-role-btn">＋ 新規作成</button>
                        </div>

                        <div className="role-list custom-scrollbar">
                           {/* King Setting Item */}
                           <div
                               onClick={() => setEditingRole('KING')}
                               className={`role-item ${editingRole === 'KING' ? 'active' : ''}`}
                           >
                               <div className="role-info">
                                   <div className="role-rank-badge" style={{color: '#f59e0b'}}>主</div>
                                   <div className="role-name" style={{color: editingRole === 'KING' ? '#f59e0b' : ''}}>
                                       {kingName}
                                       <div style={{fontSize: '0.65rem', opacity: 0.7}}>SPECIAL ROLE</div>
                                   </div>
                               </div>
                           </div>

                            {roles
                                .sort((a,b) => a.rank - b.rank)
                                .map(role => (
                                <div
                                    key={role.id}
                                    onClick={() => handleEdit(role)}
                                    className={`role-item ${editingRole?.id === role.id ? 'active' : ''}`}
                                >
                                    <div className="role-info">
                                        <div className="role-rank-badge">{role.rank}</div>
                                        <div className="role-name">
                                            {role.name}
                                            <div style={{fontSize: '0.65rem', opacity: 0.5}}>{Object.keys(PERMISSION_LABELS).filter(k => role.permissions?.[k]).length} 権限</div>
                                        </div>
                                    </div>
                                    {/* 削除ボタンもランク制限 */}
                                    {(myRank === 1 || (role.rank > myRank)) && (
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleDelete(role.id); }}
                                            style={{background: 'transparent', border:'none', color:'#ef4444', cursor:'pointer', fontWeight:'bold', fontSize:'1.2rem'}}
                                            title="削除"
                                        >
                                            ×
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Main Form */}
                    <div className="role-main-panel custom-scrollbar">
                        <div className="panel-card">
                            {editingRole === 'KING' ? (
                                <div className="animate-fade-in">
                                    <h3 style={{fontSize: '1.2rem', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom:'10px'}}>
                                        👑 勢力主設定
                                    </h3>

                                    <div className="form-group">
                                        <label className="form-label">勢力主の表示名</label>
                                        <input
                                             type="text"
                                             className="form-input"
                                             value={kingName}
                                             onChange={(e) => setKingName(e.target.value)}
                                             maxLength={10}
                                             placeholder="勢力主"
                                             disabled={myRank !== 1} // 勢力主のみ変更可
                                        />
                                        <p style={{fontSize: '0.8rem', color: '#64748b', marginTop: '8px'}}>
                                            ※ 全権限を持ち、削除やランク変更は不可。
                                        </p>
                                    </div>

                                    {myRank === 1 && (
                                        <div className="modal-actions">
                                             <button
                                                className="btn-save"
                                                disabled={isProcessing || !kingName.trim()}
                                                onClick={async () => {
                                                    if (!kingName.trim()) return;
                                                    setIsProcessing(true);
                                                    try {
                                                        await onUpdateKingRole(kingName);
                                                        alert("勢力主名を保存しました");
                                                    } catch (e) {
                                                        alert("エラー: " + e.message);
                                                    } finally {
                                                        setIsProcessing(false);
                                                    }
                                                }}
                                             >
                                                {isProcessing ? '保存中...' : '保存'}
                                             </button>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div>
                                    <h3 style={{fontSize: '1.2rem', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom:'10px'}}>
                                        {editingRole ? '役職を編集' : '役職を新規作成'}
                                    </h3>

                                    {/* 編集権限チェック */}
                                    {/* 勢力主(rank:1)は常に編集可能。それ以外は自分より上位・同格は不可 */}
                                    {/* 追加: 勢力主以外は自分自身の役職も編集不可 */}
                                    {(editingRole && (myRank > 1 && editingRole.rank <= myRank)) || (editingRole && myRank > 1 && memberRoles[currentPlayerId] === editingRole.id) ? (
                                        <div style={{color:'#ef4444', padding:'20px', textAlign:'center', background:'rgba(239,68,68,0.1)', borderRadius:'4px'}}>
                                            ⚠ {editingRole && myRank > 1 && memberRoles[currentPlayerId] === editingRole.id ? '自分自身の役職は編集できません。' : 'あなたより上位、または同格の役職のため編集できません。'}
                                        </div>
                                    ) : (
                                        <>
                                            <div className="grid-2">
                                                <div className="form-group">
                                                    <label className="form-label">役職名</label>
                                                    <input
                                                        type="text"
                                                        className="form-input"
                                                        value={name}
                                                        onChange={(e) => setName(e.target.value)}
                                                        maxLength={10}
                                                        placeholder="防衛隊長..."
                                                    />
                                                </div>
                                                <div className="form-group">
                                                    <label className="form-label">序列 (2-99)</label>
                                                    <input
                                                        type="number"
                                                        className="form-input"
                                                        value={rank}
                                                        onChange={(e) => setRank(e.target.value)}
                                                        min="2"
                                                        max="99"
                                                    />
                                                    <span style={{fontSize: '0.7rem', color:'#6b7280'}}>数字が小さいほど上位</span>
                                                </div>
                                            </div>

                                            <div className="form-group">
                                                <label className="form-label" style={{marginBottom: '12px'}}>権限設定</label>
                                                <div className="permissions-grid">
                                                    {Object.entries(PERMISSION_LABELS).map(([key, label]) => (
                                                        <div
                                                          key={key}
                                                          className={`permission-item ${permissions[key] ? 'active' : ''}`}
                                                          onClick={() => setPermissions(prev => ({ ...prev, [key]: !prev[key] }))}
                                                          onMouseEnter={() => setHoveredPerm(key)}
                                                          onMouseLeave={() => setHoveredPerm(null)}
                                                        >
                                                            <span
                                                                className="perm-label"
                                                                style={{
                                                                    color: key === 'canManageMembers' ? '#ef4444' : 'inherit',
                                                                    fontWeight: key === 'canManageMembers' ? 'bold' : 'normal'
                                                                }}
                                                            >
                                                                {label}
                                                            </span>
                                                            <div className={`switch ${permissions[key] ? 'checked' : ''}`}>
                                                                <div className="switch-knob"></div>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                                {hoveredPerm && (
                                                    <div style={{marginTop: '8px', fontSize: '0.8rem', color: '#a5b4fc'}}>
                                                        ℹ️ {PERMISSION_DESCRIPTIONS[hoveredPerm]}
                                                    </div>
                                                )}
                                            </div>

                                            <div className="modal-actions">
                                                {editingRole && (
                                                    <button onClick={resetForm} className="btn-cancel">
                                                        キャンセル
                                                    </button>
                                                )}
                                                <button
                                                    className="btn-save"
                                                    onClick={handleSave}
                                                    disabled={isProcessing || !name.trim()}
                                                >
                                                    {isProcessing ? '処理中...' : (editingRole ? '更新' : '作成')}
                                                </button>
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </>
            )}

            {/* --- MEMBERS TAB --- */}
            {activeTab === 'members' && (
                <div className="role-main-panel custom-scrollbar">
                    <div className="panel-card" style={{maxWidth: '100%'}}>
                        <div style={{display:'flex', justifyContent:'space-between', marginBottom:'20px'}}>
                            <h3>メンバーリスト</h3>
                            <input
                                type="text"
                                placeholder="検索..."
                                className="form-input"
                                style={{width: '200px', padding: '8px 12px', fontSize: '0.85rem'}}
                                value={memberFilter}
                                onChange={(e) => setMemberFilter(e.target.value)}
                            />
                        </div>

                        <table className="member-table">
                            <thead>
                                <tr>
                                    <th>序列</th>
                                    <th>メンバー</th>
                                    <th>現在の役職</th>
                                    <th style={{textAlign: 'right'}}>役職変更</th>
                                </tr>
                            </thead>
                            <tbody>
                                {members
                                    .filter(m => {
                                        const name = m.displayName || m.shortId || (m.id || "").replace(/^game-/, '').substring(0, 8);
                                        return name.toLowerCase().includes(memberFilter.toLowerCase());
                                    })
                                    .sort((a,b) => {
                                        // 1. King
                                        if (a.isKing) return -1;
                                        if (b.isKing) return 1;

                                        // 2. Rank (Ascending)
                                        const roleA = roles.find(r => r.id === memberRoles[a.id]);
                                        const roleB = roles.find(r => r.id === memberRoles[b.id]);
                                        const rankA = roleA ? roleA.rank : 9999;
                                        const rankB = roleB ? roleB.rank : 9999;

                                        return rankA - rankB;
                                    })
                                    .map(m => {
                                        const roleId = memberRoles[m.id];
                                        const role = roles.find(r => r.id === roleId);

                                        // 編集可否判定:
                                        // 1. 相手が勢力主なら不可
                                        // 2. 自分が勢力主以外の場合:
                                        //    - 相手のランク <= 自分のランク なら不可
                                        //    - 自分自身の変更も不可 (勢力主以外)

                                        let targetRank = 9999;
                                        if (m.isKing) targetRank = 1;
                                        else if (role) targetRank = role.rank;

                                        const isSelf = m.id === currentPlayerId;

                                        // isEditable determines if the dropdown is enabled
                                        const isEditable = !m.isKing && (
                                            myRank === 1 ||
                                            (!isSelf && targetRank > myRank)
                                        );

                                        const displayName = m.displayName || m.shortId || (m.id || "").replace(/^game-/, '').substring(0, 8);

                                        return (
                                            <tr key={m.id} className="hover:bg-white/5 transition-colors">
                                                <td className="px-6 py-4">
                                                    {m.isKing ? (
                                                        <span className="text-amber-500 font-bold text-sm">主</span>
                                                    ) : role ? (
                                                        <span className="text-blue-300 text-sm">{role.rank}</span>
                                                    ) : (
                                                        <span className="text-gray-500 text-sm">-</span>
                                                    )}
                                                </td>
                                                <td className="px-6 py-4">
                                                    <div className="text-sm font-medium text-white">
                                                        {displayName}
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4">
                                                    {m.isKing ? (
                                                        <span className="text-amber-500 font-bold text-sm">{kingRoleName || '勢力主'}</span>
                                                    ) : role ? (
                                                        <span className="text-purple-400 font-bold text-sm">{role.name}</span>
                                                    ) : (
                                                        <span className="text-gray-500 text-sm">メンバー (役職なし)</span>
                                                    )}
                                                </td>
                                                <td className="px-6 py-4 text-right">
                                                    {isEditable ? (
                                                        <select
                                                            className="member-select"
                                                            value={roleId || "null"}
                                                            onChange={(e) => handleRoleAssign(m.id, e.target.value)}
                                                            disabled={isProcessing}
                                                        >
                                                            <option value="null">メンバー (なし)</option>
                                                            {roles.map(r => {
                                                                // マッピング候補の制限
                                                                // 自分より上位(ランク値が小さい)または同格への変更は不可
                                                                const canAssignToThisRank = myRank === 1 || (r.rank > myRank);

                                                                return (
                                                                    <option key={r.id} value={r.id} disabled={!canAssignToThisRank}>
                                                                        {r.name} {(!canAssignToThisRank) ? '(権限不足)' : ''}
                                                                    </option>
                                                                );
                                                            })}

                                                        </select>
                                                    ) : (
                                                        <span className="text-xs text-gray-600 italic px-2">変更不可</span>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

        </div>
      </div>
    </div>,
    document.body
  );
}

export default memo(RoleSettingsModal);
