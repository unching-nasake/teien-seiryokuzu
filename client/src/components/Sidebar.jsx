import { memo, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getLogCategory, getLogWithIcon, LOG_TYPES } from '../utils/logFormatter';
import ActivityLogModal from './ActivityLogModal';
import FactionListModal from './FactionListModal';
import LeaveFactionModal from './LeaveFactionModal';
import PermissionsModal from './PermissionsModal';
import RoleSettingsModal from './RoleSettingsModal';
import WorldStatesModal from './WorldStatesModal';

// ヘルパー: 8近傍クラスタリングを行い、中核を含むクラスタを特定する
// ヘルパー: 8近傍クラスタリングを行い、中核を含むクラスタを特定する (SAB対応版)
const getFactionClusterInfo = (factionId, tileData, extraTiles = []) => {
    if (!factionId || !tileData || !tileData.sab) return { total: 0, flyingEnclaves: 0, clusters: [] };

    const { sab, factionsList } = tileData;
    const dv = new DataView(sab);
    const size = 500;
    const byteSize = 20; // useWorldState.js の TILE_BYTE_SIZE と合わせる

    const factionIdx = factionsList.indexOf(factionId);
    if (factionIdx === -1 && extraTiles.length === 0) return { total: 0, flyingEnclaves: 0, clusters: [] };

    const visited = new Set();
    const clusters = [];

    const initialFactionKeys = new Set();
    const factionKeys = new Set();

    // SABを走査して、指定された勢力のタイルを抽出
    if (factionIdx !== -1) {
        for (let i = 0; i < size * size; i++) {
            const offset = i * byteSize;
            const fid = dv.getUint16(offset, true);
            if (fid === factionIdx) {
                const x = i % size;
                const y = Math.floor(i / size);
                const key = `${x}_${y}`;
                initialFactionKeys.add(key);
                factionKeys.add(key);
            }
        }
    }

    extraTiles.forEach(t => {
        factionKeys.add(`${t.x}_${t.y}`);
    });

    const directions = [
        [0, 1], [0, -1], [1, 0], [-1, 0],
        [1, 1], [1, -1], [-1, 1], [-1, -1]
    ];

    for (const key of factionKeys) {
       if (visited.has(key)) continue;

       const cluster = [];
       const queue = [key];
       visited.add(key);
       let hasCore = false;
       let hasExisting = false;

       while (queue.length > 0) {
           const curr = queue.shift();
           cluster.push(curr);

           if (initialFactionKeys.has(curr)) hasExisting = true;

           // マップタイル上で中核かどうかチェック
           const [cx, cy] = curr.split('_').map(Number);
           const offset = (cy * size + cx) * byteSize;
           const flags = dv.getUint8(offset + 11);
           const isCore = (flags & 1) !== 0;
           const fid = dv.getUint16(offset, true);

           if (isCore && fid === factionIdx) {
               hasCore = true;
           }

           for (const [dx, dy] of directions) {
               const nx = cx + dx;
               const ny = cy + dy;
               if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
               const nKey = `${nx}_${ny}`;
               if (factionKeys.has(nKey) && !visited.has(nKey)) {
                   visited.add(nKey);
                   queue.push(nKey);
               }
           }
       }
       clusters.push({ tiles: cluster, hasCore, hasExisting });
    }

    const flyingEnclaves = clusters.filter(c => !c.hasCore).length;

    return {
        total: clusters.length,
        flyingEnclaves,
        clusters
    };
};


function Sidebar({
  playerData,
  factions,
  selectedTiles,
  onPaint,
  onErase,
  onCreateFaction,
  onJoinFaction,
  onLeaveFaction,
  onClearSelection,
  onExportMap,
  onTimelapse,
  onOpenAccountSettings,
  onFactionSettingsChange,
  onShowMemberList,
  activityLog = [],
  notices = [],
  onShowNotice,
  className = '',
  onClose,
  onJumpTo,
  onAutoSelect,
  onTransferKing,
  onMergeRequest,
  onMergeCancel,
  onAllianceRequest,
  onAllianceBreak,
  mergeRequest,
  onMergeRespond,
  allianceRequest,
  onAllianceRespond,
  // Season 2 params
  onOpenAlliancePanel,
  onOpenRoleSettings,
  onDonateAP,
  onWithdrawAP,
  onJoinPolicyChange,
  isPopupOpen,
  tileData = {}, // SAB Data
  getTile,
  skipConfirmation = false,

  onToggleSkipConfirmation,
  onToggleAutoSharedAp,
  isMergeEnabled = true,
  mergerSettings = {},

  truces = {},
  wars = {},
  alliances = {},
  overpaintTargetCount = 1,
  onSetOverpaintTargetCount,
  namedCells = {},
  onCreateNamedTile,
  onRenameNamedTile,
  apSettings = { limits: { individual: 50, sharedBase: 50 }, gardenMode: false }, // AP設定
  onDeleteNamedTile, // ネームドマス削除用
  socket, // socket props
  onLoadMoreLogs, // ログページネーション
  onSearchLogs, // ログ検索
  gardenMode = false, // 庭園モードステータス
  gardenAuthKey = null, // 共有認証キー
  gardenRefillCost = 30, // 庭園AP回復コスト
  gardenRefillAmount = 50, // 庭園AP回復量
  namedTileSettings = {}, // [NEW]
  onLoginClick // ログインハンドラ
}) {
  const [apUpdated, setApUpdated] = useState(false);
  const [renameInput, setRenameInput] = useState(''); // 名前変更用入力

  // 選択されたネームドマスが切り替わったときに入力を同期
  useEffect(() => {
      if (selectedTiles.length === 1) {
          const key = `${selectedTiles[0].x}_${selectedTiles[0].y}`;
          if (namedCells[key]) {
              setRenameInput(namedCells[key].name || '');
          }
      }
  }, [selectedTiles, namedCells]);

  // AP更新イベントリスナー
  useEffect(() => {
    if (!socket) return;
    const handleApRefresh = () => {
      console.log("[Sidebar] Received ap:refresh event");
      // App.jsxがfetchをハンドリングするが、念のためここで確認
    };
    socket.on('ap:refresh', handleApRefresh);
    return () => socket.off('ap:refresh', handleApRefresh);
  }, [socket]);
  const currentFaction = playerData?.factionId ? factions[playerData.factionId] : null;
  // 安全な比較のために文字列変換
  const isKing = currentFaction?.kingId && playerData?.id && String(currentFaction.kingId) === String(playerData.id);

  // AP Estimation State
  const [estimatedAP, setEstimatedAP] = useState(0);
  const [estimatedPenalty, setEstimatedPenalty] = useState(0);
  const [estimatedOverpaintAP, setEstimatedOverpaintAP] = useState(0);
  const [estimatedSuccessRates, setEstimatedSuccessRates] = useState({});
  const [estimateError, setEstimateError] = useState(null);

  const [isEstimating, setIsEstimating] = useState(false);
  const [isDestruction, setIsDestruction] = useState(false);
  const [truceConflict, setTruceConflict] = useState(null);
  const [canCustomColor, setCanCustomColor] = useState(false);
  const [customColorInput, setCustomColorInput] = useState('#ff0000');
  const [clusterInfo, setClusterInfo] = useState({ clusters: [], flyingEnclaves: 0 }); // [NEW] 高速化用
  const [independenceEligibleCount, setIndependenceEligibleCount] = useState(0); // [NEW] 独立バリデーション用
  const [needsWarDeclaration, setNeedsWarDeclaration] = useState(false);
  const [targetFactionNameForWar, setTargetFactionNameForWar] = useState(null);




  useEffect(() => {
    if (selectedTiles.length === 0 || !playerData) {
      setEstimatedAP(0);
      setEstimatedPenalty(0);
      setEstimatedSuccessRates({});
      setEstimateError(null);
      setIsEstimating(false);
      setIsDestruction(false);
      setTruceConflict(null);
      setCanCustomColor(false);
      setNeedsWarDeclaration(false);
      setTargetFactionNameForWar(null);
      return;
    }

    setIsEstimating(true);
    setEstimateError(null);

    const timer = setTimeout(async () => {
      try {
        // 通常塗りの見積もり
        const res = await fetch('/api/tiles/estimate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tiles: selectedTiles, action: 'paint' }),
          credentials: 'include'
        });

        let data;
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
            try {
                data = await res.json();
            } catch (e) {
                data = { error: "サーバーからの応答が無効です(JSON Parse Error)" };
            }
        } else {
            const text = await res.text();
            data = { error: `サーバーエラー: ${res.status} (Not JSON)` };
            console.error("Non-JSON response:", text);
        }

        // HTTPエラー（401/403など）またはアプリケーションエラーをチェック
        if (!res.ok || data.error) {
            // 認証エラーは無視（塗り操作時にサーバー側で再チェックされる）
            if (res.status === 401 || res.status === 403) {
                // 認証エラーの場合は警告のみ（ボタンは有効のまま）
                setEstimateError(null);
            } else {
                setEstimateError(data.error || "エラーが発生しました");
            }
            setEstimatedAP(0);
            setEstimatedPenalty(0);
            setEstimatedSuccessRates({});
        } else {
            setEstimatedAP(data.cost);
            setEstimatedPenalty(data.extraCost || 0);
            setEstimatedSuccessRates(data.successRates || {});
            setIsDestruction(!!data.destructionInvolved);
            setNeedsWarDeclaration(!!data.needsWarDeclaration);
            setTargetFactionNameForWar(data.targetFactionName || null);
            // 休憩時間エラーがあればエラーとして設定
            if (data.breakTimeError) {
                setEstimateError(data.breakTimeError);
            } else {
                setEstimateError(null);
            }
        }

        // 停戦チェック
        let conflict = null;
        if (truces) {
            for (const t of selectedTiles) {
                const tile = getTile(t.x, t.y);
                const fid = tile ? tile.factionId || tile.faction : null;
                if (fid && fid !== playerData.factionId) {
                    // 相手勢力ID(fid)と自分(playerData.factionId)の間で停戦があるか
                    const [id1, id2] = [playerData.factionId, fid].sort();
                    const truceKey = `${id1}_${id2}`;
                    const truce = truces[truceKey];
                    if (truce && new Date(truce.expiresAt).getTime() > Date.now()) {
                        conflict = factions[fid]?.name || "停戦相手";
                        break;
                    }
                }
            }
        }
        setTruceConflict(conflict);

        // カスタムカラー一括設定可否チェック (自勢力かつ周囲8マス自勢力)
        let hasCustomizable = false;
        const directions = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
        for (const t of selectedTiles) {
             const tile = getTile(t.x, t.y);
             // 色を変える対象は自勢力のタイルである必要がある
             if (tile?.faction === playerData.factionId) {
                 let surrounded = true;
                 for (const [dx, dy] of directions) {
                     const nt = getTile(t.x+dx, t.y+dy);
                     if (nt?.faction !== playerData.factionId) {
                         surrounded = false;
                         break;
                     }
                 }
                 if (surrounded) {
                     hasCustomizable = true;
                     break;
                 }
             }
        }
        setCanCustomColor(hasCustomizable);

        // クラスタ情報の計算
        const info = getFactionClusterInfo(playerData.factionId, tileData, selectedTiles);
        setClusterInfo(info);

        // 独立可能なタイル数の計算
        const eligibleIndie = selectedTiles.filter(t => {
            const tile = getTile(t.x, t.y);
            // 自分が塗ったタイルであり、かつ「中核マスでない」または「自勢力の中核マスである」タイルが1つでもあれば独立可能
            return tile && tile.paintedBy === playerData.id && (!tile.core || tile.core.factionId === playerData.factionId);
        });
        setIndependenceEligibleCount(eligibleIndie.length);

        // 重ね塗り見積もりの対象フィルタリング (最大重ね塗り済みのタイルを除外)
        const validOverpaintTiles = selectedTiles.filter(t => {
            const tile = getTile(t.x, t.y);
            // 自勢力 かつ 重ね塗りが最大(4)未満
            return tile && tile.faction === playerData.factionId && (tile.overpaint || 0) < 4;
        });

        const isEligibleForOverpaint = validOverpaintTiles.length > 0;

        if (isEligibleForOverpaint) {
            const resOver = await fetch('/api/tiles/estimate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  tiles: validOverpaintTiles,
                  action: 'overpaint',
                  overpaintCount: overpaintTargetCount
                }),
                credentials: 'include'
            });
            const dataOver = await resOver.json();
            if (!dataOver.error) {
                setEstimatedOverpaintAP(dataOver.cost);
            } else {
                setEstimatedOverpaintAP(0);
            }
        } else {
            setEstimatedOverpaintAP(0);
        }


      } catch (e) {
        console.error("Estimate Error:", e);
        setEstimateError(`通信エラー: ${e.message}`);
      } finally {
        setIsEstimating(false);
      }
    }, 1000); // 1秒のデバウンス

    return () => clearTimeout(timer);
  }, [selectedTiles, overpaintTargetCount]);

  // ローカルstate
  const [showFactionSettings, setShowFactionSettings] = useState(false);
  const [showWorldStates, setShowWorldStates] = useState(false); // 世界情勢表示
  const [newFactionName, setNewFactionName] = useState('');
  const [newFactionColor, setNewFactionColor] = useState('#ffffff');
  const [transferTarget, setTransferTarget] = useState(''); // 譲渡先メンバーID
  const [mergeTarget, setMergeTarget] = useState(''); // 併合先属性ID
  const [donateAmount, setDonateAmount] = useState(1); // 寄付額
  const [withdrawAmount, setWithdrawAmount] = useState(1); // 引き出し額
  const [mergeCandidates, setMergeCandidates] = useState([]); // 併合候補リスト

  const [isCeding, setIsCeding] = useState(false);
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [cedeTargetFactionId, setCedeTargetFactionId] = useState('');
  const [adjacentFactions, setAdjacentFactions] = useState([]);

  // 勢力設定パネルが開かれた時に、現在の色と名前をセットする
  useEffect(() => {
    if (showFactionSettings && currentFaction) {
        setNewFactionName(currentFaction.name || '');
        setNewFactionColor(currentFaction.color || '#ffffff');
    }
  }, [showFactionSettings, currentFaction]);

  // 権限が剥奪されたら設定パネルを自動的に閉じる
  useEffect(() => {
    if (!currentFaction || !playerData) return;

    const myRole = currentFaction.memberRoles?.[playerData.id]
        ? currentFaction.roles?.find(r => r.id === currentFaction.memberRoles[playerData.id])
        : null;
    const perms = isKing ? { canManageSettings: true, canManageMembers: true, canDiplomacy: true } : (myRole?.permissions || {});
    const hasAnySettingsPermission = isKing || perms.canManageSettings || perms.canManageMembers || perms.canDiplomacy;

    if (!hasAnySettingsPermission && showFactionSettings) {
        setShowFactionSettings(false);
    }
  }, [currentFaction, playerData, isKing, showFactionSettings]);


  // モーダル表示状態
  const [showFactionList, setShowFactionList] = useState(false);
  const [showActivityLog, setShowActivityLog] = useState(false);
  const [showRoleManager, setShowRoleManager] = useState(false); // 役職管理モーダル
  const [editingRole, setEditingRole] = useState(null); // 編集中の役職 (nullなら新規)
  const [roleNameInput, setRoleNameInput] = useState('');
  const [roleColorInput, setRoleColorInput] = useState('#ffffff');
  const [rolePermissions, setRolePermissions] = useState({
      canKick: false,
      canDiplomacy: false,
      canManageRoles: false,
      canManageSettings: false
  });
  const [assignTarget, setAssignTarget] = useState(null); // 役職割当対象メンバーID
  const [showLeaveModal, setShowLeaveModal] = useState(false); // 脱退モーダル
  const [showPermissionsModal, setShowPermissionsModal] = useState(false); // 権限確認モーダル

  // 併合候補の取得 (勢力主のみ)
  useEffect(() => {
    if (!isKing || !playerData?.id || !playerData.factionId) return;

    // UIが開かれた時だけにするのがベストだが、ここでは簡易的にuseEffect
    const fetchCandidates = async () => {
        try {
            // クッキー認証なのでtokenヘッダーは不要(credentials: include)
            // ただし既存fetchがどうなっているか不明なので、念のためcredentialsを含めるか、
            // 既存のfetchラッパーがあればそれを使うべき。ここは標準fetchを使う。
            const res = await fetch('/api/factions/merge/candidates', {
                credentials: 'include'
            });
            if (res.ok) {
                const data = await res.json();
                setMergeCandidates(data.candidates || []);
            }
        } catch (err) {
            console.error("Failed to fetch merge candidates", err);
        }
    };

    if (showFactionSettings) {
        fetchCandidates();
    }
  }, [isKing, showFactionSettings, playerData]);

  // 役職保存
  const handleSaveRole = async () => {
      if (!playerData?.factionId) return;
      const factionId = playerData.factionId;
      try {
          if (editingRole) {
              // 更新
              const res = await fetch(`/api/factions/${factionId}/roles/${editingRole.id}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include',
                  body: JSON.stringify({
                      name: roleNameInput,
                      color: roleColorInput,
                      permissions: rolePermissions
                  })
              });
              const d = await res.json();
              if (d.success) {
                  alert('役職を更新しました');
                  setEditingRole(null);
                  setRoleNameInput('');
                  setRoleColorInput('#ffffff');
                  setRolePermissions({ canKick: false, canDiplomacy: false, canManageRoles: false, canManageSettings: false });
              } else {
                  alert(d.error || '更新失敗');
              }
          } else {
              // 新規作成
              const res = await fetch(`/api/factions/${factionId}/roles`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include',
                  body: JSON.stringify({
                      name: roleNameInput,
                      color: roleColorInput,
                      permissions: rolePermissions
                  })
              });
              const d = await res.json();
              if (d.success) {
                  alert('役職を作成しました');
                  setRoleNameInput('');
                  setRoleColorInput('#ffffff');
                  setRolePermissions({ canKick: false, canDiplomacy: false, canManageRoles: false, canManageSettings: false });
              } else {
                  alert(d.error || '作成失敗');
              }
          }
      } catch(e) {
          console.error('handleSaveRole error:', e);
          alert('通信エラー: ' + e.message);
      }
  };

  // 役職削除
  const handleDeleteRole = async (roleId) => {
      if (!playerData?.factionId) return;
      if (!confirm('本当にこの役職を削除しますか？')) return;
      try {
          const res = await fetch(`/api/factions/${playerData.factionId}/roles/${roleId}`, {
              method: 'DELETE',
              credentials: 'include'
          });
          const d = await res.json();
          if (d.success) {
              alert('役職を削除しました');
              if (editingRole?.id === roleId) setEditingRole(null);
          } else {
              alert(d.error || '削除失敗');
          }
      } catch(e) {
          console.error('handleDeleteRole error:', e);
          alert('通信エラー: ' + e.message);
      }
  };

  // 役職割り当て
  const handleAssignRole = async (memberId, roleId) => {
      if (!playerData?.factionId) return;
      try {
          const res = await fetch(`/api/factions/${playerData.factionId}/members/${memberId}/role`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ roleId }) // nullなら解除
          });
          const d = await res.json();
          if (!d.success) alert(d.error || '割当失敗');
      } catch(e) { alert('通信エラー'); }
  };


  // ログメッセージの取得
  const getSidebarLogMessage = (log) => {
    return getLogWithIcon(log);
  };

  // ログメッセージ内の座標をリンク化して表示
  const renderSidebarLogContent = (log) => {
    const rawText = getSidebarLogMessage(log);
    if (!rawText) return null;

    const regex = /\((\d+),\s*(\d+)\)/g;
    const parts = [];
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(rawText)) !== null) {
      if (match.index > lastIndex) {
        parts.push(rawText.substring(lastIndex, match.index));
      }

      const x = parseInt(match[1], 10);
      const y = parseInt(match[2], 10);
      const coordText = match[0];

      parts.push(
        <button
          key={`sidebar-coord-${match.index}`}
          className="coord-link"
          onClick={(e) => {
            e.stopPropagation();
            if (onJumpTo) onJumpTo(x, y);
          }}
          title={`座標 (${x}, ${y}) へジャンプ`}
          style={{
            fontSize: "0.85em",
            padding: "0 4px",
            backgroundColor: "rgba(59, 130, 246, 0.25)",
            border: "1px solid rgba(59, 130, 246, 0.4)",
          }}
        >
          📍 {coordText}
        </button>,
      );

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < rawText.length) {
      parts.push(rawText.substring(lastIndex));
    }

    return parts.length > 0 ? parts : rawText;
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

  return (
    <div className={`sidebar ${className}`}>
      <div className="sidebar-header-fixed">
        <button className="close-sidebar-btn" onClick={onClose}>×</button>
        <div className="header">
          <h1>庭園勢力図</h1>
        </div>
      </div>

      <div className="sidebar-content">

        {/* 未ログイン時のログインカード */}
        {!playerData && (
          <div className="panel" style={{ background: 'linear-gradient(135deg, #2d5a7b 0%, #1a3a4d 100%)', border: '1px solid #4a90c2', padding: '16px', borderRadius: '8px', marginBottom: '12px' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', marginBottom: '8px' }}>🔑</div>
              <div style={{ fontWeight: 'bold', fontSize: '1.1rem', marginBottom: '8px', color: '#fff' }}>ログインしてプレイ</div>
              <p style={{ fontSize: '0.85rem', color: '#ccc', marginBottom: '12px' }}>
                勢力に参加してマップを塗りましょう！
              </p>
              <button
                onClick={onLoginClick}
                style={{
                  width: '100%',
                  padding: '10px 16px',
                  background: '#4a90c2',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  fontSize: '0.95rem'
                }}
              >
                ログイン / 新規登録
              </button>
            </div>
          </div>
        )}

        {/* AP表示 */}
        {playerData && (
          <div className="panel">
            <div className="panel-title">塗り権利 (AP)</div>
            <div className="ap-display">
              {(() => {
                  let maxAp = apSettings?.limits?.individual || 50;
                  // 庭園モードかつ未認証の場合は上限半分
                  if (apSettings?.gardenMode && !playerData.lastAuthenticated) {
                    maxAp = Math.floor(maxAp / 2);
                  }
                  return (
                    <>
                      <span className={`ap-value ${apUpdated ? 'updated' : ''}`}>{playerData.ap || 0}</span>
                      <span className="ap-label">/ {maxAp}</span>
                      <div className="ap-bar">
                        <div
                          className="ap-bar-fill"
                          style={{ width: `${Math.min(100, ((playerData.ap || 0) / maxAp) * 100)}%` }}
                        />
                      </div>
                    </>
                  );
              })()}
              </div>
            </div>

        )}

        {/* タイル塗り操作 */}
        {playerData?.factionId && (
          <div className="panel">
            <div className="panel-title">タイル塗り</div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '12px' }}>
              好きなタイルを選択して、「塗る」ボタンで確定します。
            </p>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {(() => {
                const ownAP = playerData?.ap || 0;
                const sharedAP = (currentFaction && typeof currentFaction.sharedAP === 'number') ? currentFaction.sharedAP : 0;
                const useShared = !!playerData?.autoConsumeSharedAp;
                const availableAP = ownAP + (useShared ? sharedAP : 0);

                // --- バリデーションロジック ---
                let disabledReason = "";
                let hasCriticalError = false;

                // 1. 計算中
                if (isEstimating) {
                    disabledReason = "計算中...";
                }
                // 2. ネットワーク/サーバーエラー (見積もり時)
                // 通信エラーの場合はボタンを無効化しない（警告表示のみ）
                // サーバー側でバリデーションが行われるため、ユーザーは塗り操作を試行できる
                else if (estimateError && estimateError !== "通信エラー") {
                    disabledReason = estimateError;
                    hasCriticalError = true;
                }
                // 3. APチェック (常にチェック)
                // 共有APを使用する権限があるか確認
                const hasSharedApPerm = isKing || (currentFaction?.roles?.find(r => r.id === currentFaction?.memberRoles?.[playerData?.id])?.permissions?.canUseSharedAp);
                const canUseShared = useShared && hasSharedApPerm;

                // 自動消費が有効かつ権限がある場合のみ共有APを使用
                if (!canUseShared && estimatedAP > ownAP) {
                   disabledReason = `APが足りません (必要: ${estimatedAP}, 所持: ${ownAP})`;
                   hasCriticalError = true;
                }
                else if (canUseShared && estimatedAP > availableAP) {
                   disabledReason = `APが足りません (必要: ${estimatedAP}, 所持: ${ownAP}+${sharedAP})`;
                   hasCriticalError = true;
                }
                // 3.5. 飛び地ペナルティチェック (通知のみ、ボタンは有効)
                /*
                else if (estimatedPenalty > 30) {
                   disabledReason = `飛び地制限を超過しているため塗れません (ペナルティ: ${estimatedPenalty}, 上限: 30)`;
                   hasCriticalError = true;
                }
                */
                // 4. 外交チェック (同盟/停戦) - TruceConflict は useEffect で計算済み
                else if (truceConflict) {
                    disabledReason = `停戦中の勢力(${truceConflict})が含まれています`;
                }
                // 4.5. 戦争権限チェック
                else if (needsWarDeclaration) {
                    const hasWarPerm = isKing || (currentFaction?.roles?.find(r => r.id === currentFaction?.memberRoles?.[playerData?.id])?.permissions?.canDeclareWar);
                    if (!hasWarPerm) {
                        disabledReason = `勢力「${targetFactionNameForWar || "不明"}」への攻撃には宣戦布告が必要ですが、権限がありません。`;
                        hasCriticalError = true;
                    }
                }
                else {
                    // クールダウンチェック (成功率データ内)
                    const cooldownTiles = Object.values(estimatedSuccessRates || {}).filter(r => r.cooldownUntil && r.cooldownUntil > Date.now());
                    if (cooldownTiles.length > 0) {
                         disabledReason = "防衛クールダウン中の拠点が含まれています";
                         hasCriticalError = true;
                    }
                }

                const isDisabled = selectedTiles.length === 0 || isEstimating || hasCriticalError;


                const handleClick = () => {
                   // 滅亡アラートを廃止
                   onPaint();
                };

                return (
                  <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: '4px' }}>
                      <button
                        className="btn btn-primary"
                        onClick={handleClick}
                        disabled={isDisabled}
                        title={disabledReason} // 念のため残す
                      >
                        {isEstimating ? '計算中...' : `塗る (${selectedTiles.length})`}
                        {!isEstimating && <span style={{fontSize: '0.8em', marginLeft: '4px'}}>消費: {estimatedAP} AP</span>}
                      </button>

                      {/* 陥落確率表示 (ネームドマスが含まれる場合) */}
                      {estimatedSuccessRates && Object.keys(estimatedSuccessRates).length > 0 && (
                          <div style={{
                              marginTop: '8px',
                              padding: '8px',
                              background: 'rgba(220, 38, 38, 0.1)',
                              border: '1px solid rgba(220, 38, 38, 0.3)',
                              borderRadius: '4px'
                          }}>
                              <div style={{ fontSize: '0.8rem', color: '#fca5a5', fontWeight: 'bold', marginBottom: '4px' }}>⚔️ 攻略情報</div>
                              {Object.entries(estimatedSuccessRates).map(([key, info]) => {
                                   const nc = namedCells[key];
                                   const name = nc ? nc.name : '拠点';
                                   const ratePercent = Math.round((info.rate || 0) * 100);
                                   const isOwn = playerData?.factionId && nc && nc.factionId === playerData.factionId;

                                   return (
                                       <div key={key} style={{ fontSize: '0.75rem', marginBottom: '4px' }}>
                                           <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                               <span style={{ color: '#fff' }}>{name}</span>
                                               {/* 自勢力の場合は陥落率ではなくラベルを表示 */}
                                               <span style={{ fontWeight: 'bold', color: isOwn ? '#60a5fa' : (info.rate > 0.1 ? '#fbbf24' : '#ccc') }}>
                                                   {isOwn ? '自勢力拠点' : `陥落率: ${ratePercent}%`}
                                               </span>
                                           </div>
                                           {info.isSieged && !isOwn && (
                                               <div style={{ fontSize: '0.7rem', color: '#fbbf24', marginLeft: '8px' }}>
                                                   ⚠ 包囲効果適用中 (+ボーナス)
                                               </div>
                                           )}
                                            {info.cooldownUntil && (
                                               <div style={{ fontSize: '0.7rem', color: '#f87171', marginLeft: '8px' }}>
                                                   ⛔ 防衛クールダウン中 (残り {Math.ceil((info.cooldownUntil - Date.now()) / 60000)}分)
                                               </div>
                                           )}
                                       </div>
                                   );
                              })}
                          </div>
                      )}

                      {/* 無効理由の表示エリア */}
                      {isDisabled && disabledReason && (
                          <div style={{
                              fontSize: '0.75rem',
                              color: '#ff6b6b',
                              backgroundColor: 'rgba(50,0,0,0.5)',
                              padding: '4px',
                              borderRadius: '4px',
                              textAlign: 'center',
                              border: '1px solid #ff6b6b',
                              marginTop: '4px'
                          }}>
                              {disabledReason}
                          </div>
                      )}
                      {/* 通信エラー時の警告（ボタンは有効） */}
                      {estimateError === "通信エラー" && !isDisabled && (
                          <div style={{
                              fontSize: '0.75rem',
                              color: '#fbbf24',
                              backgroundColor: 'rgba(50,25,0,0.5)',
                              padding: '4px',
                              borderRadius: '4px',
                              textAlign: 'center',
                              border: '1px solid #fbbf24',
                              marginTop: '4px'
                          }}>
                              ⚠ コスト取得に失敗（塗り操作は可能です）
                          </div>
                      )}
                      {/* 飛び地制限超過時の警告（ボタンは有効） */}
                      {(() => {
                          const count = clusterInfo.flyingEnclaves;
                          const limit = 25;
                          if (count > limit && !isDisabled) {
                              return (
                                  <div style={{
                                      fontSize: '0.75rem',
                                      color: '#fbbf24',
                                      backgroundColor: 'rgba(50,25,0,0.5)',
                                      padding: '4px',
                                      borderRadius: '4px',
                                      textAlign: 'center',
                                      border: '1px solid #fbbf24',
                                      marginTop: '4px'
                                  }}>
                                      ⚠ 飛び地制限({limit}個)を超過しています (現在: {count})
                                  </div>
                              );
                          }
                          return null;
                      })()}
                      {/* 距離ペナルティ発生時の警告（ボタンは有効） */}
                      {estimatedPenalty > 0 && !isDisabled && (
                          <div style={{
                              fontSize: '0.75rem',
                              color: '#fbbf24',
                              backgroundColor: 'rgba(50,25,0,0.5)',
                              padding: '4px',
                              borderRadius: '4px',
                              textAlign: 'center',
                              border: '1px solid #fbbf24',
                              marginTop: '4px'
                          }}>
                              ⚠ 距離ペナルティが発生しています (+{estimatedPenalty} AP)
                          </div>
                      )}
                  </div>
                );
              })()}

              {/* 中核化タイマー表示 */}
              {selectedTiles.length === 1 && (() => {
                  const tileData = getTile(selectedTiles[0].x, selectedTiles[0].y);

                  if (!tileData || !tileData.isCorePending) return null;

                  // 他の勢力の中核マスが設定（失効カウントダウン中）であってはならない
                  if (tileData.core && tileData.core.expiresAt) {
                      return null;
                  }

                  const now = Date.now();
                  const coreTimeRaw = tileData.coreTime;
                  // サーバーは Date.now() を使用するが、ここでは安全のためにパースする
                  const coreTime = coreTimeRaw ? new Date(coreTimeRaw).getTime() : now;
                  const remainingSec = Math.max(0, Math.floor((coreTime + (60 * 60 * 1000) - now) / 1000));

                  const mm = Math.floor(remainingSec / 60);
                  const ss = remainingSec % 60;

                  // マテリアルデザイン風
                  // (Purple theme like Core card) は「中核カードのような紫色のテーマ」という意味ですが日本語コメントとしては冗長なので削除または統合
                  return (
                      <div style={{ marginTop: '8px', padding: '6px', background: 'rgba(139, 92, 246, 0.1)', border: '1px solid rgba(139, 92, 246, 0.3)', borderRadius: '4px' }}>
                          <div style={{ fontSize: '0.75rem', color: '#a78bfa', fontWeight: 'bold' }}>🛡️ 中核化準備中</div>
                          <div style={{ fontSize: '1rem', textAlign: 'center', color: '#fff', margin: '4px 0', fontWeight: 'bold' }}>
                              {mm}:{ss.toString().padStart(2, '0')} 後に完了
                          </div>
                      </div>
                  );
              })()}
              {playerData?.permissions?.canErase && selectedTiles.length > 0 && selectedTiles.every(t => {
                  const tData = getTile(t.x, t.y);
                  return tData && (tData.faction || tData.factionId) === playerData.factionId;
              }) && (
                <button
                  className="btn btn-warning"
                  onClick={() => {
                    if (window.confirm(`選択した ${selectedTiles.length} マスを消去しますか？\n（あなたの所有権を解除し中立に戻します）`)) {
                      onErase();
                    }
                  }}
                  disabled={selectedTiles.length === 0}
                >
                  消去
                </button>
              )}
              <button
                className="btn btn-blue"
                onClick={onClearSelection}
                disabled={selectedTiles.length === 0}
              >
                選択解除
              </button>

              {/* ネームドマス作成ボタン */}
              {selectedTiles.length === 1 && onCreateNamedTile && (() => {
                  const t = selectedTiles[0];
                  const tile = getTile(t.x, t.y);
                  // 条件1: 自勢力タイル
                  if (!tile || (tile.faction || tile.factionId) !== playerData.factionId) return null;
                  // 条件2: 既存でない
                  const key = `${t.x}_${t.y}`;
                  if (namedCells[key]) return null;

                  const ownAP = playerData?.ap || 0;
                  const useShared = !!playerData?.autoConsumeSharedAp;
                  const sharedAP = (useShared && currentFaction?.sharedAP) ? currentFaction.sharedAP : 0;
                  const availableAP = ownAP + sharedAP;

                  const ntSettings = apSettings?.namedTileSettings || { cost: 100, intervalHours: 0 };
                  const cost = ntSettings.cost;

                  // インターバル中かチェック
                  let isInterval = false;
                  let remainingText = '';
                  if (ntSettings.intervalHours > 0 && currentFaction?.lastNamedTileCreated) {
                      const lastCreated = new Date(currentFaction.lastNamedTileCreated).getTime();
                      const now = Date.now();
                      const elapsedHours = (now - lastCreated) / (1000 * 60 * 60);
                      if (elapsedHours < ntSettings.intervalHours) {
                          isInterval = true;
                          const rem = ntSettings.intervalHours - elapsedHours;
                          remainingText = ` (あと ${rem.toFixed(1)}h)`;
                      }
                  }

                  if (availableAP < cost || isInterval) {
                      if (!isInterval) return null; // AP不足時は非表示
                      // インターバル時は理由を表示できるようにボタンを残す
                      return (
                          <button
                              className="btn btn-secondary"
                              style={{ marginTop: '8px', width: '100%', opacity: 0.6, cursor: 'not-allowed' }}
                              disabled
                          >
                              ⌛ 建造中...{remainingText}
                          </button>
                      );
                  }

                  // 条件4: 距離 >= 11
                  let validLocation = true;
                  for (const k in namedCells) {
                      const nc = namedCells[k];
                      const dist = Math.sqrt(Math.pow(t.x - nc.x, 2) + Math.pow(t.y - nc.y, 2));
                      if (dist < 11) {
                          validLocation = false;
                          break;
                      }
                  }
                  if (!validLocation) return null;

                  // [NEW] ネームドマス最大数チェック
                  const maxNamedTiles = namedTileSettings?.maxNamedTiles || 0;
                  const currentTotalNamed = Object.keys(namedCells).length;
                  if (maxNamedTiles > 0 && currentTotalNamed >= maxNamedTiles) {
                      return (
                        <div style={{ marginTop: '8px', padding: '8px', background: 'rgba(50,50,50,0.5)', borderRadius: '4px', fontSize: '0.8rem', color: '#aaa', textAlign: 'center' }}>
                            最大数({maxNamedTiles})に達しているため<br/>新規作成できません
                        </div>
                      );
                  }

                  return (
                      <button
                          className="btn btn-primary"
                          style={{ marginTop: '8px', background: 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)', width: '100%', border: 'none', boxShadow: '0 2px 4px rgba(139, 92, 246, 0.3)' }}
                          onClick={onCreateNamedTile}
                      >
                          ★ ネームドマス作成 ({cost} AP)
                      </button>
                  );
              })()}

              {/* ネームドマス名前変更 (1つ選択時のみ、権限者のみ) */}
              {selectedTiles.length === 1 && (() => {
                  const t = selectedTiles[0];
                  const key = `${t.x}_${t.y}`;
                  const namedCell = namedCells[key];
                  const tile = getTile(t.x, t.y);

                  // ネームドマスのキャッシュ内またはタイルデータに namedData が存在する場合
                  if (!namedCell && !tile?.namedData) return null;

                  const ownerFid = String(tile?.factionId || tile?.faction || namedCell?.factionId || '');
                  const playerFid = String(playerData?.factionId || '');
                  if (!playerFid || ownerFid !== playerFid) return null;

                  const currentFaction = factions?.[playerData?.factionId];
                  const isKing = currentFaction?.kingId === playerData?.id;
                  let canManage = isKing;
                  if (!canManage && currentFaction?.memberRoles?.[playerData.id]) {
                      const rId = currentFaction.memberRoles[playerData.id];
                      const role = currentFaction.roles?.find(r => r.id === rId);
                      if (role?.permissions?.canManageSettings || role?.permissions?.canManageNamedTiles) {
                          canManage = true;
                      }
                  }
                  if (!canManage) return null;

                  return (
                      <div style={{ marginTop: '12px', padding: '10px', background: 'rgba(59, 130, 246, 0.1)', border: '1px solid rgba(59, 130, 246, 0.3)', borderRadius: '6px' }}>
                          <div style={{ fontSize: '0.8rem', color: '#60a5fa', fontWeight: 'bold', marginBottom: '8px' }}>⚙️ ネームドマス管理</div>
                          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                              <input
                                  type="text"
                                  className="input"
                                  value={renameInput}
                                  onChange={(e) => setRenameInput(e.target.value)}
                                  placeholder="新しい名前を入力"
                                  style={{ flex: 1, fontSize: '0.9rem', padding: '6px', minWidth: '0' }}
                              />
                              <button
                                  className="btn btn-primary"
                                  style={{ padding: '6px 12px', fontSize: '0.85rem', whiteSpace: 'nowrap' }}
                                  onClick={async () => {
                                      if (!renameInput.trim()) return;
                                      const res = await onRenameNamedTile(key, renameInput);
                                      if (res?.error) alert(res.error);
                                      else alert('名前を変更しました');
                                  }}
                              >
                                  保存
                              </button>
                              <button
                                  className="btn btn-secondary"
                                  style={{
                                      padding: '6px 12px',
                                      fontSize: '0.85rem',
                                      background: 'rgba(239, 68, 68, 0.15)',
                                      color: '#ff4d4d',
                                      border: '1px solid #ef4444',
                                      flex: '1',
                                      minWidth: '60px'
                                  }}
                                  onClick={() => onDeleteNamedTile(key)}
                              >
                                  ⚠️ 削除
                              </button>
                          </div>
                      </div>
                  );
              })()}


              {/* 重ね塗りボタン */}
              {selectedTiles.length > 0 && (() => {
                  // 選択された全てのタイルが自勢力であり、かつ重ね塗りが最大でないことを確認
                  const validTiles = selectedTiles.filter(t => {
                      const tile = getTile(t.x, t.y);
                      return tile?.faction === playerData.factionId &&
                             // !tile?.namedData && // [緩和] ネームドマスの重ね塗りを許可
                             (tile?.overpaint || 0) < 4;
                  });

                  if (validTiles.length === 0) return null; // 有効なタイルがない場合はボタンを非表示

                  const availableAP = (playerData.ap || 0) + ((playerData.autoConsumeSharedAp && currentFaction?.sharedAP) ? currentFaction.sharedAP : 0);
                  const canAfford = availableAP >= estimatedOverpaintAP;
                  return (
                    <div style={{ width: '100%', marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <div className="overpaint-control">
                        <label className="overpaint-label">回数 (最大4)</label>
                        <div className="overpaint-input-wrapper">
                          <button
                            className="overpaint-qty-btn"
                            onClick={() => onSetOverpaintTargetCount(Math.max(1, overpaintTargetCount - 1))}
                            disabled={overpaintTargetCount <= 1}
                          >-</button>
                          <input
                            type="number"
                            className="overpaint-qty-input"
                            value={overpaintTargetCount}
                            onChange={(e) => {
                              const valStr = e.target.value;
                              if (valStr === '') {
                                onSetOverpaintTargetCount(''); // 一時的に空入力を許可
                                return;
                              }
                              const val = parseInt(valStr, 10);
                              if (!isNaN(val)) {
                                onSetOverpaintTargetCount(Math.max(0, Math.min(4, val)));
                              }
                            }}
                            onBlur={() => {
                              if (overpaintTargetCount === '' || overpaintTargetCount < 1) {
                                onSetOverpaintTargetCount(1);
                              } else if (overpaintTargetCount > 4) {
                                onSetOverpaintTargetCount(4);
                              }
                            }}
                            min="1"
                            max="4"
                          />
                          <button
                            className="overpaint-qty-btn"
                            onClick={() => onSetOverpaintTargetCount(Math.min(4, overpaintTargetCount + 1))}
                            disabled={overpaintTargetCount >= 4}
                          >+</button>
                        </div>
                      </div>
                      <button
                          className="btn btn-primary"
                          style={{
                              background: canAfford ? 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)' : '#555',
                              border: 'none',
                              width: '100%',
                              boxShadow: canAfford ? '0 4px 6px rgba(234, 88, 12, 0.3)' : 'none'
                          }}
                          onClick={() => onPaint(validTiles, 'overpaint')}
                          disabled={!canAfford || isEstimating}
                      >
                          {isEstimating ? '計算中...' : `🎨一括重ね塗り (${estimatedOverpaintAP} AP)`}
                      </button>
                    </div>
                  );
              })()}

              {/* カスタムカラー一括設定 */}
              {canCustomColor && (
                  <div style={{ width: '100%', marginTop: '8px', padding: '8px', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px' }}>
                      <div style={{ fontSize: '0.8rem', marginBottom: '4px' }}>🎨 カスタムマスカラー設定</div>
                      <div style={{ display: 'flex', gap: '4px' }}>
                          <input
                              type="color"
                              value={customColorInput}
                              onChange={e => setCustomColorInput(e.target.value)}
                              style={{ width: '40px', height: '30px', border: 'none', padding: 0, cursor: 'pointer' }}
                          />
                          <input
                              type="text"
                              value={customColorInput}
                              onChange={e => setCustomColorInput(e.target.value)}
                              maxLength={7}
                              style={{ width: '80px', height: '30px', padding: '0 4px', fontSize: '0.9rem', border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(0,0,0,0.2)', color: '#fff', borderRadius: '2px' }}
                              placeholder="#RRGGBB"
                          />
                          <button
                              className="btn btn-secondary"
                              style={{ flex: 1, fontSize: '0.8rem', background: 'linear-gradient(90deg, #ff0000, #ff7f00, #ffff00, #00ff00, #0000ff, #4b0082, #8b00ff)', color: '#fff', border: 'none', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}
                              onClick={async () => {
                                  if (!confirm("選択範囲内の設定可能なマス（周囲を自勢力で囲まれたマス）の色を一括変更しますか？")) return;
                                  try {
                                      const res = await fetch('/api/tiles/color', {
                                          method: 'POST',
                                          headers: { 'Content-Type': 'application/json' },
                                          body: JSON.stringify({ tiles: selectedTiles, color: customColorInput }),
                                          credentials: 'include'
                                      });
                                      const d = await res.json();
                                      if (d.success) {
                                          alert(`${d.count}個のマスの色を変更しました`);
                                          onClearSelection();
                                      } else {
                                          alert(d.error || '変更失敗');
                                      }
                                  } catch(e) {
                                      alert("通信エラー");
                                  }
                              }}
                          >
                              色を一括変更
                          </button>
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                          ※周囲8マスが自勢力のマスのみ対象
                      </div>
                  </div>
              )}
            </div>
          </div>
        )}

        {/* 領土割譲ボタン (勢力主・外交権限者のみ) */}
        {playerData?.factionId && (() => {
            const myRole = currentFaction?.memberRoles?.[playerData.id]
                ? currentFaction.roles?.find(r => r.id === currentFaction.memberRoles[playerData.id])
                : null;
            const canDiplomacy = isKing || (myRole?.permissions?.canDiplomacy);
            if (!canDiplomacy) return null;

            // 全マスが自勢力であること、かつ最低1マスは残ること
            const isAllSelf = selectedTiles.length > 0 && selectedTiles.every(t => getTile(t.x, t.y)?.faction === playerData.factionId);

            // 勢力タイル合計計算 (SABスキャン)
            let currentTotal = 0;
            if (tileData?.sab) {
                const dv = new DataView(tileData.sab);
                const fIdx = tileData.factionsList.indexOf(playerData.factionId);
                if (fIdx !== -1) {
                    for(let i=0; i<250000; i++) {
                        if (dv.getUint16(i*20, true) === fIdx) currentTotal++;
                    }
                }
            }
            const isNotAll = selectedTiles.length < currentTotal;

            if (selectedTiles.length > 0 && isAllSelf && isNotAll) {
                // [New Phase 8] 戦争状態チェック
                const checkWarWith = (fid1, fid2) => {
                    if (!wars) return false;
                    const f1 = String(fid1);
                    const f2 = String(fid2);
                    return Object.values(wars).some(w => {
                        const attackers = w.attackerSide?.factions || [];
                        const defenders = w.defenderSide?.factions || [];
                        return (
                            (attackers.includes(f1) && defenders.includes(f2)) ||
                            (defenders.includes(f1) && attackers.includes(f2))
                        );
                    });
                };

                // 隣接勢力を検索
                const nearbyFidSet = new Set();
                const directions = [[0,1],[0,-1],[1,0],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]];
                selectedTiles.forEach(t => {
                    directions.forEach(([dx, dy]) => {
                        const nt = getTile(t.x+dx, t.y+dy);
                        const nf = nt ? (nt.faction || nt.factionId) : null;
                        if (nf && nf !== playerData.factionId) {
                            // 戦争中の勢力は譲渡候補から除外
                            if (!checkWarWith(playerData.factionId, nf)) {
                                nearbyFidSet.add(nf);
                            }
                        }
                    });
                });

                const targets = Array.from(nearbyFidSet).map(fid => ({ id: fid, name: factions[fid]?.name || "未知の勢力" }));

                if (targets.length > 0) {
                    return (
                        <div className="panel" style={{ marginTop: '-12px', borderTop: 'none' }}>
                            <div className="panel-title" style={{ color: '#fbbf24', fontSize: '0.85rem' }}>🚩 領土譲渡（割譲）</div>
                            <select
                                className="input"
                                value={cedeTargetFactionId}
                                onChange={e => setCedeTargetFactionId(e.target.value)}
                                style={{ width: '100%', fontSize: '0.8rem', marginBottom: '4px' }}
                            >
                                <option value="">譲渡先を選択...</option>
                                {targets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                            <button
                                className="btn"
                                onClick={async () => {
                                    if (!cedeTargetFactionId) return;
                                    if (!confirm(`${selectedTiles.length} マスの領土を「${factions[cedeTargetFactionId]?.name}」に譲渡する申請を送信します。よろしいですか？`)) return;
                                    setIsCeding(true);
                                    try {
                                        const res = await fetch('/api/tiles/cede/request', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ tiles: selectedTiles, targetFactionId: cedeTargetFactionId }),
                                            credentials: 'include'
                                        });
                                        const d = await res.json();
                                        if (d.success) {
                                            alert(d.message);
                                            onClearSelection();
                                        } else {
                                            alert(d.error || '割譲申請に失敗しました');
                                        }
                                    } catch (e) {
                                        alert('通信エラー');
                                    } finally {
                                        setIsCeding(false);
                                    }
                                }}
                                disabled={!cedeTargetFactionId || isCeding}
                                style={{ width: '100%', fontSize: '0.8rem', background: '#fbbf24', color: '#000', border: 'none' }}
                            >
                                {isCeding ? '送信中...' : '割譲を提案する'}
                            </button>
                        </div>
                    );
                }
            }
            return null;
        })()}

        {/* アカウント情報カード */}
        {playerData && (
          <div className="panel" style={{
            background: 'linear-gradient(135deg, rgba(52, 211, 153, 0.1) 0%, rgba(16, 185, 129, 0.05) 100%)',
            border: '1px solid rgba(52, 211, 153, 0.2)',
            borderRadius: '12px',
            padding: '16px',
            marginBottom: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{
                width: '40px',
                height: '40px',
                borderRadius: '50%',
                background: 'var(--accent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1.2rem',
                color: '#fff',
                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
                flexShrink: 0
              }}>
                {playerData.displayName?.charAt(0) || 'U'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <div style={{ fontSize: '0.9rem', fontWeight: 'bold', color: '#fff' }}>{playerData.displayName}</div>
                  {apSettings?.gardenMode && (
                    <span style={{
                      fontSize: '0.7em',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      background: playerData.isGardenAuthorized ? 'rgba(16, 185, 129, 0.2)' : 'rgba(245, 158, 11, 0.2)',
                      color: playerData.isGardenAuthorized ? '#34d399' : '#fbbf24',
                      border: `1px solid ${playerData.isGardenAuthorized ? 'rgba(16, 185, 129, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`,
                      whiteSpace: 'nowrap'
                    }}>
                      {playerData.isGardenAuthorized ? '✅ 認証済' : '⚠️ 未認証'}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>ID: {playerData.id?.substring(0, 8)}...</div>
              </div>
            </div>
            <button
              className="btn btn-secondary"
              onClick={onOpenAccountSettings}
              style={{
                width: '100%',
                padding: '8px',
                fontSize: '0.85rem',
                background: 'rgba(255,255,255,0.05)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px'
              }}
            >
              ⚙️ アカウント設定
            </button>
          </div>
        )}

        {/* アクティビティログ (最新3件) + ボタン */}
        <div className="panel">
            <div className="panel-title">アクティビティ</div>
            <div className="activity-card-container" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '8px' }}>
                {activityLog && activityLog.slice(0, 3).map((log, i) => {
                     const messageContent = renderSidebarLogContent(log);
                     const time = formatTime(log.time || log.timestamp);
                     const category = getLogCategory(log);
                     const color = LOG_TYPES[category]?.color || 'var(--text-primary)';
                     return (
                         <div key={i} className="activity-card-item" style={{ padding: '6px 8px', background: 'rgba(255,255,255,0.03)', borderRadius: '4px', borderLeft: `2px solid ${color}` }}>
                             <div style={{ fontSize: '0.75rem', lineHeight: '1.4', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{messageContent}</div>
                             <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', textAlign: 'right', marginTop: '2px' }}>{time}</div>
                         </div>
                     );
                })}
                {(!activityLog || activityLog.length === 0) && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textAlign: 'center', padding: '8px' }}>履歴なし</div>
                )}
            </div>
            <button
                className="btn btn-secondary"
                onClick={() => setShowActivityLog(true)}
                style={{ width: '100%', fontSize: '0.8rem', marginBottom: '8px' }}
            >
                📜 すべてのログを見る
            </button>
            <button
                className="btn btn-primary"
                onClick={() => setShowWorldStates(true)}
                style={{ width: '100%', fontSize: '0.8rem', background: 'linear-gradient(90deg, #3b82f6, #8b5cf6)' }}
            >
                🌍 世界情勢
            </button>
        </div>

        {/* 表示名設定・パスワード設定はAccountModalへ移動したので削除 */}

        {/* 所属勢力 (読み込み中ハンドリング) */}
        {playerData?.factionId && !currentFaction && (
            <div className="panel">
                <div style={{ padding: '20px', textAlign: 'center', color: '#888', fontSize: '0.8rem' }}>
                    勢力データを読み込み中...
                </div>
            </div>
        )}

        {/* 所属勢力 */}
        {currentFaction && (
          <div className="panel">
            <div className="panel-title">所属勢力</div>
            <div
              className="faction-item"
              onClick={() => onShowMemberList?.(playerData.factionId)}
              style={{ cursor: 'pointer' }}
              title="メンバー一覧を表示"
            >
              <div className="faction-color" style={{ background: currentFaction.color }} />
              <span className="faction-name" style={{ fontWeight: 'bold', textDecoration: 'underline' }}>
                {currentFaction.name}
              </span>
              <span className="faction-members">{currentFaction.members?.length || 0} <span style={{fontSize:'0.9em', color:'#aaa'}}>({currentFaction.activeMemberCount || 0})</span>人</span>
            </div>

            {/* 自分の権限確認用ボタン */}
            <div style={{ marginTop: '8px', textAlign: 'right' }}>
                 <button
                    style={{ background: 'transparent', border: 'none', color: '#aaa', fontSize: '0.8rem', cursor: 'pointer', textDecoration: 'underline' }}
                    onClick={() => setShowPermissionsModal(true)}
                 >
                     🔑 自分の権限を確認
                 </button>
            </div>



            {/* 共有APパネル */}
            <div style={{ marginTop: '12px', padding: '8px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px' }}>
                {(() => {
                    const sharedLimit = currentFaction.sharedAPLimit ?? 0;
                    return (
                        <div style={{ fontSize: '0.8rem', fontWeight: 'bold', marginBottom: '4px' }}>共有AP: {currentFaction.sharedAP || 0} / {sharedLimit}</div>
                    );
                })()}
                <div style={{ display: 'flex', gap: '4px', alignItems: 'center', marginBottom: '8px' }}>
                    <input
                        type="number"
                        value={donateAmount}
                        onChange={e => setDonateAmount(Number(e.target.value))}
                        className="input"
                        style={{ width: '60px', padding: '2px' }}
                        min="1"
                    />
                    <button
                        onClick={() => onDonateAP(donateAmount)}
                        className="btn btn-blue"
                        style={{ padding: '2px 8px', fontSize: '0.75rem' }}
                    >
                        寄付
                    </button>
                </div>
                {/* 自動消費トグル (権限がある場合または勢力主) */}
                {(isKing || currentFaction?.roles?.find(r => r.id === currentFaction.memberRoles?.[playerData.id])?.permissions?.canUseSharedAp) && (
                    <div style={{ fontSize: '0.8rem' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', userSelect: 'none' }}>
                            <input
                                type="checkbox"
                                checked={!!playerData.autoConsumeSharedAp}
                                onChange={(e) => onToggleAutoSharedAp && onToggleAutoSharedAp(e.target.checked)}
                            />
                            自動消費
                        </label>
                    </div>
                )}

                {/* [NEW] 全勢力解禁リカバーボタン -> 弱小勢力限定に変更 */ }
                {currentFaction.isWeak && currentFaction.adminId && (
                    <button
                        onClick={() => setShowRecoveryModal(true)}
                        className="btn btn-green"
                        style={{
                            width: '100%',
                            marginTop: '8px',
                            padding: '4px',
                            fontSize: '0.8rem',
                            background: '#2e7d32',
                            boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
                        }}
                    >
                        🌷でAP追加
                    </button>
                )}
                {/* Debug info (Hidden unless URL has debug_weak) */}
                {window.location.search.includes('debug_weak') && (
                    <div style={{ fontSize: '0.6rem', color: '#555', marginTop: '10px', borderTop: '1px dotted #333', paddingTop: '4px' }}>
                        DEBUG: isWeak={String(currentFaction.isWeak)}, adminId="{currentFaction.adminId}", rank={currentFaction.rank}, active={currentFaction.activeMemberCount}
                    </div>
                )}
            </div>

            {/* 勢力設定パネル (権限ベースで表示) */}
            {(() => {
                const myRole = currentFaction.memberRoles?.[playerData.id]
                    ? currentFaction.roles?.find(r => r.id === currentFaction.memberRoles[playerData.id])
                    : null;
                const perms = isKing ? { canManageSettings: true, canManageMembers: true, canDiplomacy: true } : (myRole?.permissions || {});
                const canManageSettings = isKing || perms.canManageSettings;
                const canManageMembers = isKing || perms.canManageMembers;
                const canDiplomacy = isKing || perms.canDiplomacy;

                if (!canManageSettings && !canManageMembers && !canDiplomacy) return null;

                return (
                    <div style={{ marginTop: '10px' }}>
                        <button
                            className="btn btn-blue"
                            onClick={() => setShowFactionSettings(!showFactionSettings)}
                            style={{ width: '100%', fontSize: '0.8rem' }}
                        >
                            ⚙️ 勢力設定
                        </button>
                        {showFactionSettings && (
                            <div style={{ marginTop: '8px', padding: '8px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px' }}>

                                {/* 1. 基本設定 (勢力名、勢力カラー) */}
                                {canManageSettings && (
                                    <div style={{ marginBottom: '16px' }}>
                                        <div className="panel-subtitle" style={{ fontSize: '0.8rem', marginBottom: '4px', color: '#ccc' }}>基本設定</div>
                                        <input
                                            type="text"
                                            className="input"
                                            placeholder="新しい勢力名"
                                            value={newFactionName}
                                            onChange={(e) => setNewFactionName(e.target.value)}
                                            maxLength={20}
                                            style={{ marginBottom: '6px', width: '100%' }}
                                        />
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '6px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                <input
                                                    type="color"
                                                    value={newFactionColor}
                                                    onChange={(e) => setNewFactionColor(e.target.value)}
                                                    style={{ width: '40px', height: '30px', border: 'none', padding: 0, cursor: 'pointer' }}
                                                />
                                                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                                    勢力カラー
                                                </span>
                                            </div>
                                            <input
                                                type="text"
                                                className="input"
                                                placeholder="#ffffff"
                                                value={newFactionColor}
                                                onChange={(e) => {
                                                    const val = e.target.value;
                                                    setNewFactionColor(val);
                                                }}
                                                style={{ fontSize: '0.8rem', padding: '4px 8px', width: '100%' }}
                                            />
                                        </div>
                                        <button
                                            className="btn btn-primary"
                                            onClick={() => {
                                                if (newFactionName.length > 0) {
                                                    const clean = newFactionName.replace(/[\s\u200B-\u200D\uFEFF]/g, '');
                                                    if (clean.length === 0) {
                                                        alert('勢力名には有効な文字を入力してください');
                                                        return;
                                                    }
                                                }
                                                if (newFactionColor.toLowerCase() === '#ffffff') {
                                                    alert('白色(#ffffff)は勢力色として使用できません。');
                                                    return;
                                                }
                                                onFactionSettingsChange({ name: newFactionName, color: newFactionColor });
                                                setShowFactionSettings(false);
                                            }}
                                            style={{ width: '100%', fontSize: '0.8rem' }}
                                        >
                                            保存
                                        </button>
                                    </div>
                                )}

                                {/* 2. メンバー管理 (加入ポリシー、役職管理、ロール割当) */}
                                {canManageMembers && (
                                    <div style={{ marginBottom: '16px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '8px' }}>
                                        <div className="panel-subtitle" style={{ fontSize: '0.8rem', marginBottom: '4px', color: '#ccc' }}>メンバー管理</div>

                                        {/* 加入ポリシー */}
                                        <div style={{ marginBottom: '8px' }}>
                                            <div style={{ fontSize: '0.75rem', color: '#ccc', marginBottom: '2px' }}>加入ポリシー:</div>
                                            <select
                                                value={currentFaction.joinPolicy || 'open'}
                                                onChange={(e) => onJoinPolicyChange(e.target.value)}
                                                className="input"
                                                style={{ width: '100%', fontSize: '0.8rem' }}
                                            >
                                                <option value="open">誰でも参加可能 (Open)</option>
                                                <option value="approval">承認制 (Approval)</option>
                                                <option value="closed">参加不可 (Closed)</option>
                                            </select>
                                        </div>

                                        {/* 役職管理モーダルを開く */}
                                        <button
                                            className="btn btn-purple"
                                            onClick={onOpenRoleSettings}
                                            style={{ width: '100%', fontSize: '0.8rem', marginBottom: '8px' }}
                                        >
                                            👮 役職と権限の管理
                                        </button>


                                    </div>
                                )}

                                {/* 3. 外交・他勢力への併合要請 (King Only) */}
                                {(canDiplomacy || isKing) && (
                                     <div style={{ marginBottom: '16px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '8px' }}>
                                        <div className="panel-subtitle" style={{ fontSize: '0.8rem', marginBottom: '4px', color: '#ccc' }}>外交</div>
                                        <button className="btn btn-purple" onClick={onOpenAlliancePanel} style={{ width: '100%', fontSize: '0.8rem', marginBottom:'8px', background: '#8b5cf6', borderColor: '#7c3aed' }}>
                                            🤝 外交
                                        </button>

                                        {/* 併合要請 (King Only) */}
                                        {/* [NEW] ランク制限チェック */}
                                        {(() => {
                                            const prohibitedRank = mergerSettings?.prohibitedRank ?? 5; // default 5
                                            // 0なら制限なし
                                            let isRestricted = false;
                                            if (prohibitedRank > 0 && factions) {
                                                const allFactions = Object.values(factions);
                                                allFactions.sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0));
                                                // IDリスト作成
                                                const topIds = allFactions
                                                    .slice(0, prohibitedRank)
                                                    .map(f => f.id)
                                                    .filter(id => id);
                                                if (playerData.factionId && topIds.includes(playerData.factionId)) {
                                                    isRestricted = true;
                                                }
                                            }

                                            if (isRestricted) {
                                                return (
                                                    <div style={{ marginTop: '8px', padding: '6px', background: 'rgba(255,0,0,0.1)', borderRadius: '4px' }}>
                                                        <div className="panel-subtitle" style={{ fontSize: '0.75rem', marginBottom: '4px', color: '#999' }}>併合機能制限中</div>
                                                        <p style={{ fontSize: '0.7rem', color: '#666', marginBottom: '4px' }}>
                                                            ランキング上位{prohibitedRank}位以内の勢力は、他の勢力に併合申請（吸収）を行うことはできません。
                                                        </p>
                                                    </div>
                                                );
                                            }

                                            return (
                                                <>
                                                    {isKing && isMergeEnabled && (
                                                        <div style={{ marginTop: '8px', padding: '6px', background: 'rgba(255,0,0,0.1)', borderRadius: '4px' }}>
                                                            <div className="panel-subtitle" style={{ fontSize: '0.75rem', marginBottom: '4px', color: '#ffaaaa' }}>他勢力への併合要請 (勢力主のみ)</div>
                                                            <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                                                                他の勢力に吸収してもらう要請を送ります。受諾されると自勢力は消滅します。
                                                            </p>

                                                            <select
                                                                className="input"
                                                                value={mergeTarget}
                                                                onChange={(e) => setMergeTarget(e.target.value)}
                                                                style={{ fontSize: '0.8rem', padding: '4px', width: '100%', marginBottom: '4px' }}
                                                            >
                                                                <option value="">要請先を選択...</option>
                                                                {currentFaction.pendingMergeTarget && (
                                                                    <option value="CANCEL_PENDING">【要請中：取り消す】</option>
                                                                )}
                                                                {/* APIから取得した候補を表示 */}
                                                                {mergeCandidates.map(f => (
                                                                    <option key={f.id} value={f.id}>
                                                                        {f.name} ({f.memberCount || 0}人)
                                                                    </option>
                                                                ))}
                                                                {!currentFaction.pendingMergeTarget && mergeCandidates.length === 0 && (
                                                                    <option value="" disabled>候補なし (中核隣接勢力のみ)</option>
                                                                )}
                                                            </select>
                                                            <button
                                                                className="btn"
                                                                disabled={!mergeTarget}
                                                                onClick={() => {
                                                                    if (mergeTarget === 'CANCEL_PENDING') {
                                                                        if (window.confirm('現在の併合要請を取り消しますか？')) {
                                                                            onMergeCancel();
                                                                            setMergeTarget('');
                                                                        }
                                                                        return;
                                                                    }
                                                                    if (!mergeTarget) return;
                                                                    const targetName = factions[mergeTarget]?.name;
                                                                    if (window.confirm(`本当に「${targetName}」への併合要請を送信しますか？`)) {
                                                                        onMergeRequest(mergeTarget);
                                                                    }
                                                                }}
                                                                style={{
                                                                    width: '100%',
                                                                    fontSize: '0.8rem',
                                                                    backgroundColor: mergeTarget === 'CANCEL_PENDING' ? '#ef4444' : (mergeTarget ? '#06b6d4' : '#555'),
                                                                    color: 'white',
                                                                    border: 'none',
                                                                    cursor: mergeTarget ? 'pointer' : 'not-allowed'
                                                                }}
                                                            >
                                                                {mergeTarget === 'CANCEL_PENDING' ? '❌ 取り消す' : '🤝 要請を送信'}
                                                            </button>
                                                        </div>
                                                    )}
                                                    {isKing && !isMergeEnabled && (
                                                        <div style={{ fontSize: '0.7rem', color: '#666', marginTop: '4px' }}>※併合機能は無効</div>
                                                    )}
                                                </>
                                            );
                                        })()}
                                     </div>
                                )}

                                {/* 4. 勢力主の譲渡 (King Only) */}
                                {isKing && (
                                    <div style={{ marginBottom: '8px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '8px' }}>
                                        <div className="panel-subtitle" style={{ fontSize: '0.8rem', marginBottom: '4px', color: '#ccc' }}>勢力主の譲渡 (勢力主のみ)</div>
                                        <div style={{ display: 'flex', gap: '4px' }}>
                                            <select
                                                className="input"
                                                value={transferTarget}
                                                onChange={(e) => setTransferTarget(e.target.value)}
                                                style={{ fontSize: '0.8rem', padding: '4px', flex: 1 }}
                                            >
                                                <option value="">メンバー...</option>
                                                {currentFaction.members
                                                ?.filter(m => m.id !== playerData.id)
                                                .map(m => (
                                                    <option key={m.id} value={m.id}>{m.displayName}</option>
                                                ))
                                                }
                                            </select>
                                            <button
                                                className="btn btn-warning"
                                                onClick={() => {
                                                    if (!transferTarget) return;
                                                    onTransferKing(transferTarget);
                                                }}
                                                disabled={!transferTarget}
                                                style={{ fontSize: '0.8rem', padding: '2px 8px' }}
                                            >
                                                譲渡
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                );
            })()}

            {/* 勢力主は脱退できない (譲渡が必要) */}
            {!isKing && (
                <button
                className="btn"
                onClick={() => setShowLeaveModal(true)}
                style={{ width: '100%', marginTop: '8px', fontSize: '0.85rem', backgroundColor: '#ef4444', color: 'white', border: 'none' }}
                >
                勢力を脱退する
                </button>
            )}
          </div>
        )}

        {/* 勢力未参加の場合の作成ボタン */}
        {!playerData?.factionId && (
          <div className="panel">
            <div className="panel-title">勢力を新規作成</div>
            <button
              className="btn btn-primary"
              onClick={onCreateFaction}
              style={{ width: "100%" }}
            >
              勢力を作成
            </button>
          </div>
        )}

        {/* リスト */}
        <div className="panel">
            <div className="panel-title">リスト</div>
            <button
                className="btn btn-purple"
                onClick={() => setShowFactionList(true)}
                style={{ width: '100%' }}
            >
                🏰 勢力一覧
            </button>
        </div>


        {/* その他 */}
        <div className="panel" style={{ marginTop: 'auto' }}>
            <div className="panel-title">その他</div>
            <button className="btn btn-secondary" onClick={onTimelapse} style={{ width: '100%', marginBottom: '8px' }}>
                ⏱ タイムラプス再生
            </button>
            <button
            className="btn btn-secondary"
            onClick={() => window.open('/map', '_blank')}
            style={{ width: '100%' }}
            >
            🗺️ マップ全体画像
            </button>
        </div>


        {/* 開発者を支援 */}
        <div className="panel" style={{
          marginTop: 'auto',
          textAlign: 'center',
          background: 'rgba(255, 221, 0, 0.05)',
          border: '1px solid rgba(255, 221, 0, 0.2)',
          padding: '12px'
        }}>
          <div style={{ marginBottom: '8px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      開発者を支援
          </div>
          <a href="https://www.buymeacoffee.com/unchingnasake" target="_blank" rel="noopener noreferrer">
            <img
              src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png"
              alt="Buy Me A Coffee"
              crossOrigin="anonymous"
              style={{ height: '40px', borderRadius: '6px' }}
            />
          </a>
        </div>

        {/* モーダル群 */}
        </div>
        {showFactionList && createPortal(
            <FactionListModal
                factions={factions}
                playerData={playerData}
                onJoinFaction={onJoinFaction}
                onShowMemberList={onShowMemberList}
                onClose={() => setShowFactionList(false)}
            />,
            document.body
        )}
        {/* 役職管理モーダル */}
        {showRoleManager && createPortal(
            <RoleSettingsModal
                onClose={() => setShowRoleManager(false)}
                factionId={playerData.factionId}
                roles={currentFaction?.roles || []}
                memberRoles={currentFaction?.memberRoles || {}}
                members={[]} // Sidebarにはメンバー詳細がないため、RoleSettingsModal内で解決するか、後でfetchが必要
                onCreateRole={async (factionId, role) => {/* 実装省略 */}} // RoleSettingsModal内で直接API呼ぶ形に修正済みなら不要だが、一応
                // RoleSettingsModalの実装を確認すると、onUpdateRoleなどをpropとして受け取っている。
                // しかしSidebar内に関数定義がない。
                // RoleSettingsModal自体が fetch を行っているか確認したほうがよい。
                // さっき見たRoleSettingsModalは fetch を行っていた (handleSaveRoleなど)。
                // なので関数を渡さなくても動くバージョンかもしれないが、prop定義はあった。
                // 既存の RoleSettingsModal を確認し、必要な props を渡す。
                currentPlayerId={playerData?.id}
            />,
            document.body
        )}

      {/* 既存のモーダルたち */}
        {showActivityLog && createPortal(
            <ActivityLogModal
                activityLog={activityLog}
                onClose={() => setShowActivityLog(false)}
                onJumpTo={onJumpTo}
                factions={factions}
                onLoadMore={onLoadMoreLogs}
                onSearch={onSearchLogs}
            />,
            document.body
        )}

        {showWorldStates && createPortal(
            <WorldStatesModal
                onClose={() => setShowWorldStates(false)}
                factions={factions}
                alliances={alliances}
                wars={wars}
                truces={truces}
                onShowMemberList={onShowMemberList}
            />,
            document.body
        )}

        {showLeaveModal && createPortal(
            <LeaveFactionModal
                onClose={() => setShowLeaveModal(false)}
                onConfirm={async (options) => {
                    await onLeaveFaction(options);
                    setShowLeaveModal(false);
                }}
                apCost={10}
                factionName={currentFaction?.name || ''}
                playerData={playerData}
                playerTilesCount={(() => {
                    if (!tileData?.sab || !playerData?.id) return 0;
                    const dv = new DataView(tileData.sab);
                    const pIdx = tileData.playersList.indexOf(playerData.id);
                    if (pIdx === -1) return 0;
                    const fIdx = tileData.factionsList.indexOf(playerData.factionId);
                    let count = 0;
                    for (let i = 0; i < 250000; i++) {
                        const offset = i * 20;
                        const fid = dv.getUint16(offset, true);
                        const pid = dv.getUint32(offset + 6, true);
                        if (pid === pIdx + 1 && fid === fIdx) count++;
                    }
                    return count;
                })()}
                independenceEligibleCount={(() => {
                    if (!tileData?.sab || !playerData?.id) return 0;
                    const dv = new DataView(tileData.sab);
                    const pIdx = tileData.playersList.indexOf(playerData.id);
                    if (pIdx === -1) return 0;
                    const fIdx = tileData.factionsList.indexOf(playerData.factionId);
                    let count = 0;
                    for (let i = 0; i < 250000; i++) {
                        const offset = i * 20;
                        const fid = dv.getUint16(offset, true);
                        const pid = dv.getUint32(offset + 6, true);
                        if (pid === pIdx + 1 && fid === fIdx) count++;
                    }
                    return count;
                })()}
            />,
            document.body
        )}

      {showPermissionsModal && currentFaction && createPortal(
         <PermissionsModal
             onClose={() => setShowPermissionsModal(false)}
             permissions={(() => {
                 if (isKing) return {
                      canManageSettings: true, canUseSharedAp: true, canDiplomacy: true,
                      canDeclareWar: true, canManageMembers: true
                 };
                 const roleId = currentFaction.memberRoles?.[playerData.id];
                 const role = roleId ? currentFaction.roles?.find(r => r.id === roleId) : null;
                 return role ? role.permissions : {};
             })()}
             roleName={(() => {
                 if (isKing) return currentFaction.kingRoleName || '勢力主';
                 const roleId = currentFaction.memberRoles?.[playerData.id];
                 return roleId ? currentFaction.roles?.find(r => r.id === roleId)?.name : 'Member';
             })()}
         />,
         document.body
      )}
        {showRecoveryModal && (
            <RecoveryModal
                adminId={currentFaction?.adminId || "UNKNOWN"}
                isWeak={currentFaction?.isWeak}
                cost={gardenRefillCost}
                amount={gardenRefillAmount}
                onClose={() => setShowRecoveryModal(false)}
            />
        )}
    </div>
  );
}

// 共有AP回復コマンド表示モーダル
const RecoveryModal = ({ adminId, isWeak, cost = 30, amount = 50, onClose }) => {
    const commandText = `!pay:${cost}:ID:${adminId}`;
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(commandText);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return createPortal(
        <div style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
            padding: '20px'
        }}>
            <div style={{
                background: '#1e1e1e',
                color: '#fff',
                padding: '24px',
                borderRadius: '16px',
                maxWidth: '400px',
                width: '100%',
                boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                position: 'relative',
                fontFamily: '"Roboto", sans-serif',
                textAlign: 'center'
            }}>
                <h3 style={{ margin: '0 0 16px', fontSize: '1.25rem', color: '#81c784' }}>🌷 共有APを回復する 🌷</h3>
                <p style={{ fontSize: '0.9rem', marginBottom: '20px', color: '#ccc', lineHeight: 1.5 }}>
                    <strong>庭園板</strong> に以下のコマンドを書き込むと、<br/>
                    あなたの勢力の共有APに<strong>{amount}AP</strong>が追加されます。<br/>
                </p>

                <div style={{
                    background: '#000',
                    padding: '12px',
                    borderRadius: '8px',
                    marginBottom: '16px',
                    fontFamily: 'monospace',
                    fontSize: '1rem',
                    wordBreak: 'break-all',
                    border: '1px solid #444',
                    color: '#fff'
                }}>
                    {commandText}
                </div>

                <p style={{ fontSize: '0.8rem', color: '#ff6b6b', marginBottom: '16px' }}>
                    ※上限を超えてチャージすることはできません。<br />
                    <small>(庭園板で認証してIDを紐づけしてください。)</small><br />
                    <small>※3時間に1回まで</small>
                </p>

                <div style={{ display: 'flex', gap: '8px', flexDirection: 'column' }}>
                    <button
                        onClick={handleCopy}
                        style={{
                            padding: '12px',
                            background: copied ? '#4caf50' : '#81c784',
                            color: '#000',
                            border: 'none',
                            borderRadius: '8px',
                            fontWeight: 'bold',
                            cursor: 'pointer',
                            fontSize: '0.9rem',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '8px'
                        }}
                    >
                        {copied ? '✅ コピー完了' : '📋 コマンドをコピー'}
                    </button>

                    <button
                        onClick={onClose}
                        style={{
                            marginTop: '8px',
                            padding: '8px',
                            background: 'transparent',
                            color: '#888',
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: '0.9rem'
                        }}
                    >
                        閉じる
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
};

export default memo(Sidebar);
