import React, { useCallback, useEffect, useRef, useState } from 'react';
import AccountModal from './components/AccountModal';
import AlliancePanel from './components/AlliancePanel';
import AuthModal from './components/AuthModal';
import CreateFactionModal from './components/CreateFactionModal';
import FactionDetailsModal from './components/FactionDetailsModal';
import GameMap from './components/GameMap';
import Leaderboard from './components/Leaderboard';
import LoadingOverlay from './components/LoadingOverlay';
import NoticeModal from './components/NoticeModal';
import NoticePopup from './components/NoticePopup';
import RoleSettingsModal from './components/RoleSettingsModal';
import Sidebar from './components/Sidebar';
import TimelapseViewer from './components/TimelapseViewer';
import useAuth from './hooks/useAuth';
import useFactionData from './hooks/useFactionData';
import useMapWorkerPool from './hooks/useMapWorkerPool';
import useNotifications from './hooks/useNotifications';
import useSettings from './hooks/useSettings';
import socket from './socket';

// プレミアムトースト通知コンポーネント (メモ化して不要な再レンダリング防止)
const NotificationStack = React.memo(({ notifications, onRemove }) => {
  return (
    <div className="notification-container">
      {notifications.map((n) => (
        <div key={n.id} className={`toast ${n.removing ? 'removing' : ''}`}>
          <div className="toast-content">
            {n.title && <span className="toast-title">{n.title}</span>}
            <span className="toast-message">{n.message}</span>
          </div>
          <button className="toast-close" onClick={() => onRemove(n.id)}>✖</button>
        </div>
      ))}
    </div>
  );
});

const getTodayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function App() {
  // Worker Pool (Parallel Loading & Calculations)
  const mapWorkerPool = useMapWorkerPool();

  // ===== カスタムフックによる状態管理の抽出 =====
  const {
    skipConfirmation, setSkipConfirmation,
    isSidebarOpen, setIsSidebarOpen,
    showLeaderboard, setShowLeaderboard,
    blankTileColor, setBlankTileColor,
    showNamedTileNames, setShowNamedTileNames,
    highlightCoreOnly, setHighlightCoreOnly,
    showFactionNames, setShowFactionNames,

    mapColorMode, setMapColorMode,
    showSpecialBorder, setShowSpecialBorder
  } = useSettings();

  const {
    notifications,
    apUpdated,
    addNotification,
    removeNotification,
    triggerApEffect
  } = useNotifications();

  const {
    factions, setFactions, factionsRef,
    alliances, setAlliances, alliancesRef,
    wars, setWars, warsRef,
    truces, setTruces,
    fetchFactions, fetchAlliances, fetchWars, fetchTruces,
    playerIsAllianceLeader,
    leaderboardItems
  } = useFactionData();

  const {
    authStatus,
    setAuthStatus,
    playerData,
    setPlayerData,
    enrichedPlayerData,
    refreshAuthStatus
  } = useAuth(factions, addNotification, triggerApEffect);

  // ===== 残存するローカル状態 =====
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [mapTiles, setMapTiles] = useState({});
  const [playerNames, setPlayerNames] = useState({});
  const [namedCells, setNamedCells] = useState({});
  const [mapMode, setMapMode] = useState('normal');
  const [connected, setConnected] = useState(false);
  const [showCreateFaction, setShowCreateFaction] = useState(false);
  const [selectedTiles, setSelectedTiles] = useState([]);
  const [brushToggleMode, setBrushToggleMode] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(4);
  const [allianceDisplayMode, setAllianceDisplayMode] = useState(false);
  const [factionSortBy, setFactionSortBy] = useState('score');
  const [pendingOrigin, setPendingOrigin] = useState(null);
  const [joiningFaction, setJoiningFaction] = useState(null);
  const [showTimelapse, setShowTimelapse] = useState(false);
  const [activityLog, setActivityLog] = useState([]);
  const [showMemberFactionId, setShowMemberFactionId] = useState(null);
  const [mapJumpCoord, setMapJumpCoord] = useState(null);
  const [notices, setNotices] = useState([]);
  const [activeNotice, setActiveNotice] = useState(null);
  const [showNoticePopup, setShowNoticePopup] = useState(false);
  const [showNoticeList, setShowNoticeList] = useState(false);
  const [readNoticeIds, setReadNoticeIds] = useState(() => {
    try {
      const saved = localStorage.getItem('teien_read_notices');
      return saved ? JSON.parse(saved) : [];
    } catch(e) { return []; }
  });

  const [pendingMergeRequest, setPendingMergeRequest] = useState(null);
  const [pendingAllianceRequest, setPendingAllianceRequest] = useState(null);
  const [isProcessingJoin, setIsProcessingJoin] = useState(false);
  const [tilePopup, setTilePopup] = useState(null);
  const [hoveredFactionId, setHoveredFactionId] = useState(null);

  // マップロード状態
  const [mapLoading, setMapLoading] = useState(false);
  const [mapLoadProgress, setMapLoadProgress] = useState(0);
  const [mapLoadTotal, setMapLoadTotal] = useState(0);
  const [mapLoadMessage, setMapLoadMessage] = useState("");

  const [showMapOptionsCard, setShowMapOptionsCard] = useState(false);
  const [selectedNamedCell, setSelectedNamedCell] = useState(null);
  const [showAlliancePanel, setShowAlliancePanel] = useState(false);
  const [showRoleSettingsModal, setShowRoleSettingsModal] = useState(false);
  const [namedCellModalMode, setNamedCellModalMode] = useState(null);

  // 補助的なRef
  const playerDataRef = useRef(playerData);
  const readNoticeIdsRef = useRef([]);
  const loadedDateRef = useRef(getTodayStr());
  const addNotificationRef = useRef(addNotification);
  const isFirstConnectRef = useRef(true);
  // [FIX] Missing ref for global notices
  const processedNoticeIdsRef = useRef(new Set());

  // プレイヤーデータの変更をRefに同期（Socket通信時のクロージャ対策）
  useEffect(() => { playerDataRef.current = playerData; }, [playerData]);
  useEffect(() => { readNoticeIdsRef.current = readNoticeIds; }, [readNoticeIds]);
  useEffect(() => { addNotificationRef.current = addNotification; }, [addNotification]);





  // 定期的な日付変更チェック (00:00跨ぎ対応)
  useEffect(() => {
    const timer = setInterval(() => {
      const currentToday = getTodayStr();
      if (loadedDateRef.current !== currentToday) {
        console.log("日付変更を検知しました (Midnight Check)");

        // 庭園モードなら通知してリフレッシュ、通常ならリロード
        if (authStatus.gardenMode) {
          alert("日付が変わりました。庭園認証キーが新しくなりましたので、アカウント設定から確認してください。");
          refreshAuthStatus();
          loadedDateRef.current = currentToday; // 日付を更新して重複発火防止
        } else {
          console.log("全リロードを実行します");
          window.location.reload();
        }
      }
    }, 60 * 1000); // 1分ごとにチェック
    return () => clearInterval(timer);
  }, [authStatus.gardenMode, refreshAuthStatus]);

  // 自動選択機能 (AP分だけランダムに隣接タイルを選択 - コスト考慮)
  const handleAutoSelect = useCallback(() => {
    if (!playerData || !playerData.factionId || !playerData.ap) return;

    const MAP_SIZE = 500;
    const directions = [
      [0, 1], [0, -1], [1, 0], [-1, 0]
    ];

    // コスト計算用パラメータ
    const occupiedCount = Object.keys(mapTiles).length;
    const blankPercent = ((MAP_SIZE * MAP_SIZE - occupiedCount) / (MAP_SIZE * MAP_SIZE)) * 100;
    const overwriteCost = blankPercent < 20 ? 2 : 1;

    const myTiles = Object.entries(mapTiles).filter(([k, t]) => t.factionId === playerData.factionId);

    // 候補リスト: { key, type: 'blank'|'enemy', cost }
    const candidates = [];
    const seen = new Set();

    // 自分の勢力タイルから隣接する空白or敵タイルを探す
    myTiles.forEach(([key, tile]) => {
        const [x, y] = key.split('_').map(Number);
        directions.forEach(([dx, dy]) => {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < MAP_SIZE && ny >= 0 && ny < MAP_SIZE) {
                const nKey = `${nx}_${ny}`;
                if (seen.has(nKey)) return;

                const nTile = mapTiles[nKey];
                const nFid = nTile ? nTile.factionId : null;

                // 自勢力・同盟勢力は除外
                if (nFid === playerData.factionId) {
                    seen.add(nKey);
                    return;
                }

                // 同盟チェック
                if (nFid && factions[playerData.factionId]?.alliances?.includes(nFid)) {
                     seen.add(nKey);
                     return;
                }
                // 保護チェック（サーバー側でも検証されるが、クライアント側でも簡易的に「明らかに塗れない」ものを除外）

                let cost = 1;
                let type = 'blank';

                if (nFid) {
                    type = 'enemy';
                    cost = overwriteCost;

                    // 中核マス防衛補正
                    if (nTile.core && nTile.core.factionId === nFid) {
                         // 期限切れチェック
                         const now = Date.now();
                         if (!nTile.core.expiresAt || new Date(nTile.core.expiresAt).getTime() > now) {
                             cost += 1;
                         }
                    }
                }

                candidates.push({ key: nKey, type, cost });
                seen.add(nKey);
            }
        });
    });

    if (candidates.length === 0) return;

    // シャッフル（ランダム性を持たせる）
    // 領土拡大を優先するため、コストが低い（空白マスなど）順にソートし、同コスト内ではランダムにする

    const shuffled = candidates.sort((a, b) => {
        if (a.cost !== b.cost) return a.cost - b.cost;
        return Math.random() - 0.5;
    });

    const selectedKeys = [];
    let currentAp = playerData.ap;

    for (const cand of shuffled) {
        if (currentAp >= cand.cost) {
            selectedKeys.push(cand.key);
            currentAp -= cand.cost;
        }
        if (currentAp <= 0) break;
    }

    // selectedTilesに追加 (重複なし)
    setSelectedTiles(prev => {
        const next = [...prev];
        selectedKeys.forEach(key => {
            if (!next.includes(key)) next.push(key);
        });
        return next;
    });
  }, [playerData, mapTiles, factions, namedCells]);

  // マップ画像出力
  const handleExportMap = useCallback(() => {
    const MAP_SIZE = 250;
    const TILE_RES = 4; // 高解像度化
    const canvas = document.createElement('canvas');
    canvas.width = MAP_SIZE * TILE_RES;
    canvas.height = MAP_SIZE * TILE_RES;
    const ctx = canvas.getContext('2d');

    // 背景 (白背景)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 同盟カラーマップを作成（同盟モード用）
    const allianceColors = {};
    if (mapColorMode === 'alliance') {
      Object.values(factions).forEach(f => {
        if (f.allianceId && factions[f.allianceId]) {
          allianceColors[f.id] = factions[f.allianceId].color;
        }
      });
    }

    // 重心計算用
    const centers = {};
    const allianceCenters = {};

    // タイル描画 & 重心データ集計
    Object.entries(mapTiles).forEach(([key, tile]) => {
      const [x, y] = key.split('_').map(Number);
      const fid = tile.faction || tile.factionId;
      if (fid && factions[fid]) {
        // 同盟モードの場合は同盟の色を使用
        let color;
        if (mapColorMode === 'alliance') {
          color = allianceColors[fid] || factions[fid].color;
        } else {
          color = factions[fid].color;
        }
        ctx.fillStyle = color;
        ctx.fillRect(x * TILE_RES, y * TILE_RES, TILE_RES, TILE_RES);

        // 勢力の重心計算
        if (!centers[fid]) centers[fid] = { sumX: 0, sumY: 0, count: 0 };
        centers[fid].sumX += x;
        centers[fid].sumY += y;
        centers[fid].count++;

        // 同盟の重心計算（同盟モードの場合）
        if (mapColorMode === 'alliance') {
          const allianceId = factions[fid]?.allianceId;
          if (allianceId && factions[allianceId]) {
            if (!allianceCenters[allianceId]) allianceCenters[allianceId] = { sumX: 0, sumY: 0, count: 0 };
            allianceCenters[allianceId].sumX += x;
            allianceCenters[allianceId].sumY += y;
            allianceCenters[allianceId].count++;
          }
        }
      }
    });

    // 名前の描画
    if (showFactionNames) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = '#ffffff'; // 白縁取り
      ctx.fillStyle = '#000000';   // 黒文字
      ctx.lineWidth = 3;

      if (mapColorMode === 'alliance') {
        // 同盟モード：同盟名を表示
        Object.entries(allianceCenters).forEach(([allianceId, data]) => {
          const alliance = factions[allianceId];
          if (!alliance) return;

          const avgX = (data.sumX / data.count) * TILE_RES;
          const avgY = (data.sumY / data.count) * TILE_RES;

          const fontSize = Math.min(60, Math.max(12, Math.sqrt(data.count) * 2));
          ctx.font = `bold ${fontSize}px "Noto Sans JP", sans-serif`;

          ctx.strokeText(alliance.name, avgX, avgY);
          ctx.fillText(alliance.name, avgX, avgY);
        });

        // 同盟に属さない勢力は通常通り勢力名を表示
        Object.entries(centers).forEach(([fid, data]) => {
          const faction = factions[fid];
          if (!faction || faction.allianceId) return; // 同盟所属勢力はスキップ

          const avgX = (data.sumX / data.count) * TILE_RES;
          const avgY = (data.sumY / data.count) * TILE_RES;

          const fontSize = Math.min(60, Math.max(12, Math.sqrt(data.count) * 2));
          ctx.font = `bold ${fontSize}px "Noto Sans JP", sans-serif`;

          ctx.strokeText(faction.name, avgX, avgY);
          ctx.fillText(faction.name, avgX, avgY);
        });
      } else {
        // 勢力モード：勢力名を表示
        Object.entries(centers).forEach(([fid, data]) => {
          const faction = factions[fid];
          if (!faction) return;

          const avgX = (data.sumX / data.count) * TILE_RES;
          const avgY = (data.sumY / data.count) * TILE_RES;

          const fontSize = Math.min(60, Math.max(12, Math.sqrt(data.count) * 2));
          ctx.font = `bold ${fontSize}px "Noto Sans JP", sans-serif`;

          ctx.strokeText(faction.name, avgX, avgY);
          ctx.fillText(faction.name, avgX, avgY);
        });
      }
    }

    // 画像としてダウンロード (setTimeoutで非同期にしてUIスレッドのブロックを最小限にする)
    setTimeout(() => {
      const link = document.createElement('a');
      const dateStr = new Date().toISOString().split('T')[0];
      const modeSuffix = mapColorMode === 'alliance' ? '-alliance' : '';
      link.download = `teien-map-${dateStr}${modeSuffix}.png`;
      link.href = canvas.toDataURL('image/png');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }, 0);
  }, [mapTiles, factions, showFactionNames, mapColorMode]);


  const [onlineUsers, setOnlineUsers] = useState(0);
  const [lastCheckedDate, setLastCheckedDate] = useState(new Date().getDate());

  // リロードタイマーの代わりにバケット分散での更新待機を使用
  // フェイルセーフとして定期的なステータス確認のみ維持
  useEffect(() => {
    // 予備的な定期チェック (リロードはしない)
    const timer = setInterval(() => {
        if (!document.hidden && connected) {
            console.log("定期ステータスチェック");
            fetch('/api/auth/status', { credentials: 'include' })
            .then(res => res.ok ? res.json() : Promise.reject('Status: ' + res.status))
            .then(data => {
                if(data.authenticated && data.player) {
                    setPlayerData(data.player);
                }
            })
            .catch(e => console.error("Periodic check error:", e));
        }
    }, 10 * 60 * 1000); // 10分おき
    return () => clearInterval(timer);
  }, [connected]);

  const handleJumpTo = useCallback((x, y) => {
    setMapJumpCoord({ x, y, timestamp: Date.now() });
  }, []);

  // 併合・同盟要請の同期 (再接続・リロード対策)
  useEffect(() => {
    if (!playerData?.factionId || !factions[playerData.factionId]) {
      setPendingMergeRequest(null);
      setPendingAllianceRequest(null);
      return;
    }

    const myFaction = factions[playerData.factionId];
    if (myFaction.kingId !== playerData.id) {
      setPendingMergeRequest(null);
      setPendingAllianceRequest(null);
      return;
    }

    // 併合要請の同期
    if (myFaction.mergeRequests && myFaction.mergeRequests.length > 0) {
      const rid = myFaction.mergeRequests[0];
      const reqF = factions[rid];
      if (!pendingMergeRequest || pendingMergeRequest.requesterFactionId !== rid) {
        console.log("Merge Request Detected:", rid);
        const requestData = {
          targetFactionId: playerData.factionId,
          targetKingId: playerData.id,
          requesterFactionId: rid,
          requesterFactionName: reqF?.name || "不明な勢力"
        };
        setPendingMergeRequest(requestData);
        // お知らせポップアップのアクティブなお知らせがマージリクエストの場合、最新のデータを反映
        const noticeText = (activeNotice?.title || "") + (activeNotice?.content || "");
        if (showNoticePopup && noticeText.includes("併合要請")) {
             // 既にポップアップが出ている場合は、データが同期されるのを待つ
        }
      }
    } else if (pendingMergeRequest) {
      setPendingMergeRequest(null);
    }

    // 同盟要請の同期
    if (myFaction.allianceRequests && myFaction.allianceRequests.length > 0) {
      const rawReq = myFaction.allianceRequests[0];
      const rid = (typeof rawReq === 'object' && rawReq !== null) ? rawReq.id : rawReq;
      const reqF = factions[rid];
      if (!pendingAllianceRequest || pendingAllianceRequest.requesterFactionId !== rid) {
        console.log("Alliance Request Detected:", rid);
        const requestData = {
          targetFactionId: playerData.factionId,
          targetKingId: playerData.id,
          requesterFactionId: rid,
          requesterFactionName: reqF?.name || "不明な勢力"
        };
        setPendingAllianceRequest(requestData);
      }
    } else if (pendingAllianceRequest) {
      setPendingAllianceRequest(null);
    }
  }, [factions, playerData, pendingMergeRequest, pendingAllianceRequest, activeNotice, showNoticePopup]);

  const markNoticeAsRead = useCallback((noticeId) => {
    if (readNoticeIds.includes(noticeId)) return;

    // サーバー側の既読ステータス管理はパフォーマンス最適化のため廃止
    // fetch(`/api/notices/${noticeId}/read`, { method: 'POST', credentials: 'include' })
    //   .catch(e => console.error("既読マークエラー:", e));

    const next = [...readNoticeIds, noticeId];
    setReadNoticeIds(next);
    // ローカルストレージに保存して、オフライン時や次回起動時の既読状態を維持
    localStorage.setItem('teien_read_notices', JSON.stringify(next));
  }, [readNoticeIds]);

  const handleShowNotice = useCallback((notice) => {
    setActiveNotice(notice);
    setShowNoticePopup(true);
    // 既読にするタイミング変更: 閉じた時 or 操作時
    // markNoticeAsRead(notice.id);
  }, []);

  // 一括既読
  const handleMarkAllNoticesRead = useCallback(() => {
    const allIds = notices.map(n => n.id);
    const next = Array.from(new Set([...readNoticeIds, ...allIds]));

    // Server logic
    // サーバー側の既読管理はパフォーマンス上の理由で廃止済み
    /*
    fetch('/api/notices/read-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ noticeIds: allIds }),
      credentials: 'include'
    }).catch(e => console.error("All read mark error:", e));
    */

    setReadNoticeIds(next);
    localStorage.setItem('teien_read_notices', JSON.stringify(next));
  }, [notices, readNoticeIds]);




  // 初期データ取得
  useEffect(() => {
    if (!authStatus.authenticated) return;



    // マップ状態取得 (IndexedDBキャッシュ + 軽量API)
    const loadMapData = async () => {
      setMapLoading(true);
      setMapLoadMessage("キャッシュを確認中...");
      setMapLoadProgress(0);
      setMapLoadTotal(0);

      // IndexedDB操作ヘルパー
      const openMapDB = () => {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open('TeienMapCache', 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
          request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('tiles')) {
              db.createObjectStore('tiles');
            }
          };
        });
      };

      const getCachedTiles = async () => {
        try {
          const db = await openMapDB();
          return new Promise((resolve) => {
            const tx = db.transaction('tiles', 'readonly');
            const store = tx.objectStore('tiles');
            const request = store.get('mapData');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
          });
        } catch {
          return null;
        }
      };

      const setCachedTiles = async (tiles, version) => {
        try {
          const db = await openMapDB();
          return new Promise((resolve) => {
            const tx = db.transaction('tiles', 'readwrite');
            const store = tx.objectStore('tiles');
            store.put({ tiles, version }, 'mapData');
            tx.oncomplete = () => resolve();
          });
        } catch {
          // キャッシュ失敗は無視
        }
      };

      try {
        // 1. キャッシュから読み込み（即座に表示）
        const cached = await getCachedTiles();
        if (cached && cached.tiles && Object.keys(cached.tiles).length > 0) {
          setMapTiles(cached.tiles);
          setMapLoadMessage("最新データを確認中...");
        }

        // 2. 軽量APIからデータ取得
        setMapLoadMessage("ワールドデータをダウンロード中...");
        const response = await fetch('/api/map/lite', { credentials: 'include' });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const contentLength = response.headers.get('Content-Length');
        const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
        setMapLoadTotal(totalBytes);

        const reader = response.body.getReader();
        let receivedLength = 0;
        let chunks = [];

        while(true) {
          const { done, value } = await reader.read();
          if (done) break;

          chunks.push(value);
          receivedLength += value.length;
          setMapLoadProgress(receivedLength);
        }

        setMapLoadMessage("データを展開中...");

        // Combine chunks
        const chunksAll = new Uint8Array(receivedLength);
        let position = 0;
        for(let chunk of chunks) {
          chunksAll.set(chunk, position);
          position += chunk.length;
        }

        const text = new TextDecoder("utf-8").decode(chunksAll);
        const data = JSON.parse(text);

        // 3. データ展開 (並列処理)
        const liteTiles = data?.tiles || {};
        const tileKeys = Object.keys(liteTiles);
        const totalTiles = tileKeys.length;

        setMapLoadTotal(totalTiles);
        setMapLoadProgress(0);
        setMapLoadMessage("並列処理で展開中 (" + mapWorkerPool.poolSize + " cores)...");

        // キーをチャンクに分割
        const CHUNK_SIZE = Math.ceil(totalTiles / (mapWorkerPool.poolSize || 4));
        const keyChunks = [];
        for (let i = 0; i < totalTiles; i += CHUNK_SIZE) {
            keyChunks.push(tileKeys.slice(i, i + CHUNK_SIZE));
        }

        // 各チャンクの処理用データを作成
        // liteTiles全体を渡すと重いので、各チャンクに必要な部分だけ抽出... したいが、
        // 抽出自体が重くなる可能性がある。
        // ここは「キーのリスト」と「liteTiles全体」を渡すより、
        // メインスレッドで分割して渡すのがセオリーだが、分割コストがかかる。
        // しかしliteTilesは単一オブジェクト。
        // メインスレッドで部分オブジェクトを作るのが最も確実。

        const tasks = [];
        for (const keys of keyChunks) {
            const chunkData = {};
            for (const key of keys) {
                chunkData[key] = liteTiles[key];
            }
            tasks.push({
                type: "PROCESS_LITE_CHUNK",
                data: { tiles: chunkData }
            });
        }

        // WorkerPoolで並列実行
        const results = await mapWorkerPool.sendParallelTasks(tasks);

        // 結果を結合
        let processedTiles = {};
        for (const res of results) {
            Object.assign(processedTiles, res);
        }

        setMapLoadProgress(totalTiles);



        if (data.playerNames) {
          setPlayerNames(data.playerNames);
        }

        setMapTiles(processedTiles);
        setMapLoading(false);

        // 4. キャッシュに保存（バックグラウンド）
        setCachedTiles(processedTiles, data.version);

      } catch(e) {
        console.error("Map fetch error:", e);
        setMapLoading(false);
      }
    };


    loadMapData();

    refreshAuthStatus();
    fetchNotices();

    // ===== Season 2: 初期データ取得 =====
    // ネームドマス取得
    fetch('/api/named-cells', { credentials: 'include' })
      .then(res => res.ok ? res.json() : Promise.reject('Status: ' + res.status))
      .then(data => setNamedCells(data.namedCells || {}))
      .catch(e => console.error("Named cells fetch error:", e));

  }, [authStatus.authenticated]);

  const fetchNotices = useCallback(() => {
    fetch('/api/notices', { credentials: 'include' })
      .then(res => res.ok ? res.json() : Promise.reject('Status: ' + res.status))
      .then(data => {
        let list = data.notices || [];

        // 勢力主以外には要請通知（一覧含む）を表示しない
        const currentP = playerDataRef.current;
        const currentFactions = factionsRef.current;
        if (currentP && currentP.factionId && currentFactions[currentP.factionId]) {
             const myFaction = currentFactions[currentP.factionId];
             const isKing = myFaction.kingId === currentP.id;

             // 役職権限の取得
             let myPermissions = {};
             if (myFaction.memberRoles && myFaction.memberRoles[currentP.id]) {
                 const roleId = myFaction.memberRoles[currentP.id];
                 const role = myFaction.roles ? myFaction.roles.find(r => r.id === roleId) : null;
                 if (role && role.permissions) {
                     myPermissions = role.permissions;
                 }
             }

             list = list.filter(n => {
                 // 1. requiredPermissionがある場合: 権限チェック
                 if (n.requiredPermission) {
                     if (n.requiredPermission === 'king') return isKing;
                     if (n.requiredPermission === 'canManageAlliance') return isKing || myPermissions.canManageAlliance || myPermissions.canDiplomacy;
                     if (n.requiredPermission === 'canDiplomacy') return isKing || myPermissions.canDiplomacy;
                     if (n.requiredPermission === 'canManageMembers') return isKing || myPermissions.canManageMembers;

                     // 既知の権限キーでない場合は安全のため勢力主のみ
                     return isKing;
                 }

                 // 2. 旧仕様: テキスト判定
                 if (!isKing) {
                     const text = (n.title || "") + (n.content || "");
                     const isRequest = text.includes("同盟要請が届きました") || text.includes("併合要請が届きました");
                     return !isRequest;
                 }

                 return true;
             });
        }

        // Server-side read status check is deprecated.
        // We trust localStorage.

        setNotices(list);
        if (list.length > 0) {
          const latest = list[0];
          // Use server read status instead of local lastSeenId
          // However, we want to show popup ONLY if it hasn't been read.
          // Note: data.readNoticeIds might be empty on first load if we don't sync properly.
          // But we just set it.

          // If latest notice is NOT in the read list (local state), show it.
          const isRead = readNoticeIdsRef.current.includes(latest.id);

          if (!isRead) {
            // [Fix] 支援物資通知(support)はポップアップしない
            if (!latest.id.startsWith('notice-support-')) {
                setActiveNotice(latest);
                setShowNoticePopup(true);
            }
            // 閉じた時またはアクション時に既読にするため、ここでは何もしない
          }
        }
      })
      .catch(e => console.error("Notices fetch error:", e));
  }, [markNoticeAsRead]);


  // Socket.io イベント


  useEffect(() => {
    socket.on('connect', () => {
        setConnected(true);

        // 再接続判定
        if (!isFirstConnectRef.current) {
            console.log("再接続を検知しました (リロードなし)");
            // window.location.reload(); // 廃止
            // return; // 廃止: そのまま最新情報取得へ進む
        }
        isFirstConnectRef.current = false;

        // 再接続時に日付が変わっていたらリロード
        const currentToday = getTodayStr();
        if (loadedDateRef.current !== currentToday) {
            console.log("日付変更を検知したためリロードします (Reconnection)");
            window.location.reload();
            return;
        }

        // 再接続時に最新情報を取得
        console.log("再接続: 最新情報を取得します");
        fetch('/api/auth/status', { credentials: 'include' })
            .then(res => res.ok ? res.json() : Promise.reject('Status: ' + res.status))
            .then(data => {
                if (data.authenticated && data.player) {
                    setPlayerData(data.player);
                    // 再接続時に補充されていたらアラート
                    if (data.player.refilledAmount > 0) {
                      addNotification(`再接続中に APが ${data.player.refilledAmount} 補充されました！`, "AP補充");
                      setApUpdated(true);
                      setTimeout(() => setApUpdated(false), 1000);
                    }
                }
            })
            .catch(e => console.error("再接続時更新エラー", e?.message || String(e)));

        // 再接続時にマップ情報を最新化（データの不整合を防止）
        fetch('/api/map', { credentials: 'include' })
            .then(res => res.json())
            .then(data => {
                const loadedTiles = data?.tiles || {};
                Object.values(loadedTiles).forEach(t => {
                   if (t && t.factionId && !t.faction) t.faction = t.factionId;
                });
                setMapTiles(loadedTiles);
            })
            .catch(e => console.error("Reconnect Map fetch error:", e));

        // 再接続時に勢力・戦争・同盟情報を再取得（リアルタイム通知対応）
        fetch('/api/factions', { credentials: 'include' })
            .then(res => res.json())
            .then(data => {
                if (data.factions) {
                    // 再接続中の変化を検知
                    const myPid = playerDataRef.current?.id;
                    const myFid = playerDataRef.current?.factionId;
                    if (myPid && myFid) {
                        const oldF = factionsRef.current[myFid];
                        const newF = data.factions[myFid];
                        if (oldF && newF) {
                            // 役職変更
                            const oldR = oldF.memberRoles?.[myPid];
                            const newR = newF.memberRoles?.[myPid];
                            if (oldR !== newR) {
                                const r = newF.roles?.find(rd => rd.id === newR);
                                addNotificationRef.current(`再接続中に役職が「${r ? r.name : '役職なし'}」に変更されました`, "役職変更");
                            }
                            // 同盟状態
                            if (oldF.allianceId !== newF.allianceId) {
                                if (newF.allianceId) addNotificationRef.current(`再接続中に同盟に加盟しました`, "同盟加盟");
                                else addNotificationRef.current(`再接続中に同盟から離脱しました`, "同盟脱退");
                            }
                        }
                    }
                    setFactions(data.factions);
                    factionsRef.current = data.factions;
                }
            })
            .catch(e => console.error("Reconnect Factions fetch error:", e));

        fetch('/api/wars', { credentials: 'include' })
            .then(res => res.json())
            .then(data => {
                if (data.success && data.wars) {
                    const myFid = playerDataRef.current?.factionId;
                    if (myFid) {
                        const oldWars = warsRef.current;
                        const newWars = data.wars;
                        Object.keys(newWars).forEach(wid => {
                            if (!oldWars[wid]) {
                                const war = newWars[wid];
                                if (war.attackerSide.factions.includes(myFid) || war.defenderSide.factions.includes(myFid)) {
                                    addNotificationRef.current(`再接続中に自勢力が関わる新しい戦争が開始されました`, "開戦通知");
                                }
                            }
                        });
                    }
                    setWars(data.wars);
                    warsRef.current = data.wars;
                }
            })
            .catch(e => console.error("Reconnect Wars fetch error:", e));

        fetch('/api/alliances', { credentials: 'include' })
            .then(res => res.json())
            .then(data => {
                if (data.success && data.alliances) {
                    setAlliances(data.alliances);
                    alliancesRef.current = data.alliances;
                }
            })
            .catch(e => console.error("Reconnect Alliances fetch error:", e));
    });
    socket.on('disconnect', () => setConnected(false));

    socket.on('system:settings_updated', (newSettings) => {
      setAuthStatus((prev) => ({
        ...prev,
        gardenMode: !!newSettings.gardenMode,
        apSettings: newSettings.apSettings,
        isMergeEnabled: newSettings.isMergeEnabled,
        isGameStopped: newSettings.isGameStopped,
      }));
    });

    socket.on('online:count', (count) => {
      setOnlineUsers(count);
    });

    socket.on('player:updated', (updatedPlayer) => {
      if (updatedPlayer && updatedPlayer.id === playerDataRef.current?.id) {
          setPlayerData(updatedPlayer);
      }
    });

    // タイル情報のバッファ更新（Socket.js側でスロットリングされた更新を受信）
    socket.on('tile:buffered', (updatedTiles) => {
      setMapTiles(prev => {
        const next = { ...prev };
        Object.entries(updatedTiles).forEach(([key, t]) => {
          if (t === null) {
            delete next[key];
          } else {
            if (t.factionId && !t.faction) t.faction = t.factionId;
            next[key] = t;
          }
        });
        return next;
      });
    });

    socket.on('war:started', (war) => {
        setWars(prev => ({ ...prev, [war.id]: war }));
        fetchNotices(); // 通知リストを再取得
    });
    socket.on('war:updated', (war) => {
        setWars(prev => ({ ...prev, [war.id]: war }));
        fetchNotices(); // 通知リストを再取得
    });
    socket.on('war:ended', ({ warId }) => {
        setWars(prev => {
            const next = { ...prev };
            delete next[warId];
            return next;
        });
    });

    socket.on('factions:update', (factionsList) => {
      const next = {};
      if (Array.isArray(factionsList)) {
        factionsList.forEach(f => {
          if (f && f.id) next[f.id] = f;
        });
        setFactions(next);
        factionsRef.current = next;
      }
    });

    socket.on('faction:created', ({ factionId, faction }) => {
      setFactions(prev => {
        const next = { ...prev, [factionId]: faction };
        factionsRef.current = next;
        return next;
      });
    });

    socket.on('faction:updated', ({ factionId, faction }) => {
      setFactions(prev => {
        const next = faction === null ? { ...prev } : { ...prev, [factionId]: faction };
        if (faction === null) delete next[factionId];
        factionsRef.current = next;
        return next;
      });
    });

    socket.on('ap:bucket_check', ({ bucket, type }) => {
      // 自分のIDからバケットを計算
      if (!playerData || !playerData.id) return;

      // プレイヤーIDの末尾文字列からランダムな数値を算出してバケットを決定
      const idPart = playerData.id.replace('game-', '');
      // 単純に文字列の文字コードの総和をとる
      let sum = 0;
      for (let i = 0; i < idPart.length; i++) {
        sum += idPart.charCodeAt(i);
      }

      // 1-5分（または1-4分）の範囲にマッピングして取得タイミングを分散させる
      let myBucket;
      if (type === 'random_30') {
        // 30, 31, 32, 33 の4分間に分散
        myBucket = (sum % 4) + 1;
      } else {
        // 01-05 の5分間に分散
        myBucket = (sum % 5) + 1;
      }

      console.log(`Bucket Check received: Server=${bucket}, Me=${myBucket} (Type: ${type})`);

      if (bucket === myBucket) {
        console.log("Bucket Matched! Fetching status...");
        fetch('/api/auth/status', { credentials: 'include' })
        .then(res => res.json())
        .then(data => {
            if (data.authenticated && data.player) {
               setPlayerData(data.player);

               // アラート表示
               if (data.player.refilledAmount > 0) {
                  addNotification(`APが ${data.player.refilledAmount} 補充されました！`, "AP補充");
                  setApUpdated(true);
                  setTimeout(() => setApUpdated(false), 1000);
               }
            } else if (res.status === 401) {
                // 認証切れならリロードまたはログイン画面へ
                console.log("Bucket Check: Auth failed (401). No reload.");
                // window.location.reload(); // 廃止
            }
        })
        .catch(e => console.error("Bucket Update Error", e));
      }
    });

    socket.on('ap:refresh', () => {
      // 従来の更新シグナル（後方互換および全体の強制更新用）
      fetch('/api/player', { credentials: 'include' })
        .then(res => {
          if (res.status === 401 || res.status === 403) {
            handleAuthError(res.status);
            return null;
          }
          return res.json();
        })
        .then(data => {
          if (data && data.player) {
            setPlayerData(data.player);
            // AP補充アラート (bucket_checkと同等のロジックを追加)
            if (data.player.refilledAmount > 0) {
               addNotification(`APが ${data.player.refilledAmount} 補充されました！`, "AP補充");
               setApUpdated(true);
               setTimeout(() => setApUpdated(false), 1000);
            }
          }
        })
        .catch(() => {});
    });

    socket.on('faction:destroyed', ({ factionId }) => {
      // 自分の勢力が滅亡した場合のみアラートを表示
      setPlayerData(prev => {
        if (prev && prev.factionId === factionId) {
          addNotification('所属していた勢力が滅亡しました。\n新たな勢力を作成するか、他の勢力参加してください。', '勢力滅亡');
          document.cookie = "game2_factionId=; max-age=0; path=/";
          return { ...prev, factionId: null };
        }
        return prev;
      });
    });

    // 併合要請受信
    socket.on('merge:request', (data) => {
      const currentP = playerDataRef.current;
      if (!currentP || data.targetFactionId !== currentP.factionId) return;

      const myFac = factionsRef.current[currentP.factionId];
      if (!myFac) return;

      const isKing = myFac.kingId === currentP.id;
      let hasDiplomacyPerm = false;
      if (myFac.memberRoles && myFac.memberRoles[currentP.id]) {
          const roleId = myFac.memberRoles[currentP.id];
          const role = myFac.roles ? myFac.roles.find(r => r.id === roleId) : null;
          if (role?.permissions?.canDiplomacy) hasDiplomacyPerm = true;
      }

      if (isKing || hasDiplomacyPerm) {
          setPendingMergeRequest(data);
          fetchFactions(); // 勢力データを更新して要請リストを同期
          setTimeout(fetchNotices, 500); // 勢力データ反映を待ってから通知取得
      }
    });

    // 併合要請取り消し
    socket.on('merge:canceled', (data) => {
      const currentP = playerDataRef.current;
      if (!currentP || data.targetFactionId !== currentP.factionId) return;

      const myFac = factionsRef.current[currentP.factionId];
      if (!myFac) return;

      const isKing = myFac.kingId === currentP.id;
      let hasDiplomacyPerm = false;
      if (myFac.memberRoles && myFac.memberRoles[currentP.id]) {
          const roleId = myFac.memberRoles[currentP.id];
          const role = myFac.roles ? myFac.roles.find(r => r.id === roleId) : null;
          if (role?.permissions?.canDiplomacy) hasDiplomacyPerm = true;
      }

      if (isKing || hasDiplomacyPerm) {
          setPendingMergeRequest(prev => (prev && prev.requesterFactionId === data.requesterFactionId) ? null : prev);
          fetchFactions();
          fetchNotices();
      }
    });

    socket.on('alliance:request', (data) => {
      const currentP = playerDataRef.current;
      if (!currentP || data.targetFactionId !== currentP.factionId) return;

      const myFac = factionsRef.current[currentP.factionId];
      if (!myFac) return;

      const isKing = myFac.kingId === currentP.id;
      let hasDiplomacyPerm = false;
      if (myFac.memberRoles && myFac.memberRoles[currentP.id]) {
          const roleId = myFac.memberRoles[currentP.id];
          const role = myFac.roles ? myFac.roles.find(r => r.id === roleId) : null;
          if (role?.permissions?.canDiplomacy) hasDiplomacyPerm = true;
      }

      if (isKing || hasDiplomacyPerm) {
          setPendingAllianceRequest(data);
          fetchFactions();
          setTimeout(fetchNotices, 500);
          addNotification(`勢力「${data.requesterFactionName}」から同盟加盟申請が届きました。`, '同盟要請');
      }
    });

    // ===== Season 2: Socket イベント =====

    // ネームドマス
    socket.on('namedCell:created', ({ tileKey, namedCell }) => {
      setNamedCells(prev => ({ ...prev, [tileKey]: namedCell }));
    });
    socket.on('namedCell:updated', ({ tileKey, namedCell }) => {
      setNamedCells(prev => ({ ...prev, [tileKey]: namedCell }));
    });
    socket.on('namedCell:destroyed', ({ tileKey }) => {
      setNamedCells(prev => {
        const next = { ...prev };
        delete next[tileKey];
        return next;
      });
    });

    // 同盟
    socket.on('alliance:created', ({ allianceId, alliance }) => {
      setAlliances(prev => ({ ...prev, [allianceId]: alliance }));
    });
    socket.on('alliance:updated', (data) => {
      setAlliances(prev => ({ ...prev, [data.allianceId]: data.alliance }));
      fetchNotices(); // 外交状況が変わった可能性があるため通知再取得
    });
    socket.on('alliance:memberJoined', ({ allianceId, alliance }) => {
      setAlliances(prev => ({ ...prev, [allianceId]: alliance }));
    });
    socket.on('alliance:memberLeft', ({ allianceId, alliance }) => {
      setAlliances(prev => ({ ...prev, [allianceId]: alliance }));
    });
    socket.on('alliance:memberKicked', ({ allianceId, alliance }) => {
      setAlliances(prev => ({ ...prev, [allianceId]: alliance }));
    });
    socket.on('alliance:disbanded', ({ allianceId }) => {
      setAlliances(prev => {
        const next = { ...prev };
        delete next[allianceId];
        return next;
      });
    });

    // 停戦
    socket.on('truce:established', ({ truceKey, truce }) => {
      setTruces(prev => ({ ...prev, [truceKey]: truce }));
      const currentP = playerDataRef.current;
      if (currentP && (currentP.factionId === truce.factionA || currentP.factionId === truce.factionB)) {
          addNotification(`${truce.factionAName} と ${truce.factionBName} の間で24時間の停戦が合意されました。`, '停戦合意');
      }
    });

    socket.on('truce:ended', ({ factionAName, factionBName, factionA, factionB }) => {
       const currentP = playerDataRef.current;
       if (currentP && (currentP.factionId === factionA || currentP.factionId === factionB)) {
           addNotification(`${factionAName} と ${factionBName} の停戦期間が終了しました。`, '停戦終了');
       }
       fetchFactions(); // 状態更新
    });

    socket.on('truce:request', ({ requesterFactionId, requesterFactionName, targetFactionId }) => {
        const currentP = playerDataRef.current;
        if (!currentP || currentP.factionId !== targetFactionId) return;

        const myFac = factionsRef.current[currentP.factionId];
        if (!myFac) return;

        const isKing = myFac.kingId === currentP.id;
        let hasDiplomacyPerm = false;
        if (myFac.memberRoles && myFac.memberRoles[currentP.id]) {
            const roleId = myFac.memberRoles[currentP.id];
            const role = myFac.roles ? myFac.roles.find(r => r.id === roleId) : null;
            if (role?.permissions?.canDiplomacy) hasDiplomacyPerm = true;
        }

        if (isKing || hasDiplomacyPerm) {
            addNotification(`勢力「${requesterFactionName}」から停戦要請が届きました。`, '停戦要請');
            fetchFactions(); // 受け取った要請リストを更新するために取得
            fetchNotices(); // お知らせリスト（パッチ用）を更新
        }
    });

    socket.on('truce:rejected', ({ requesterFactionId, targetFactionId, targetFactionName }) => {
        const currentP = playerDataRef.current;
        if (!currentP || currentP.factionId !== requesterFactionId) return;

        const myFac = factionsRef.current[currentP.factionId];
        if (!myFac) return;

        const isKing = myFac.kingId === currentP.id;
        let hasDiplomacyPerm = false;
        if (myFac.memberRoles && myFac.memberRoles[currentP.id]) {
            const roleId = myFac.memberRoles[currentP.id];
            const role = myFac.roles ? myFac.roles.find(r => r.id === roleId) : null;
            if (role?.permissions?.canDiplomacy) hasDiplomacyPerm = true;
        }

        if (isKing || hasDiplomacyPerm) {
            addNotification(`勢力「${targetFactionName}」に停戦を拒否されました。`, '停戦拒否');
            fetchFactions(); // 送った要請リストを更新するために取得
        }
    });

    socket.on('truce:expired', ({ requesterFactionId, requesterFactionName, targetFactionId, targetFactionName, expiresAt }) => {
         const currentP = playerDataRef.current;
         if (!currentP) return;

         // 対象: 申請元、または申請先
         const isRequester = currentP.factionId === requesterFactionId;
         const isTarget = currentP.factionId === targetFactionId;

         if (!isRequester && !isTarget) return;

         const myFac = factionsRef.current[currentP.factionId];
         if (!myFac) return;

         const isKing = myFac.kingId === currentP.id;
         let hasDiplomacyPerm = false;
         if (myFac.memberRoles && myFac.memberRoles[currentP.id]) {
            const roleId = myFac.memberRoles[currentP.id];
            const role = myFac.roles ? myFac.roles.find(r => r.id === roleId) : null;
            if (role?.permissions?.canDiplomacy) hasDiplomacyPerm = true;
         }

         if (isKing || hasDiplomacyPerm) {
             if (isRequester) {
                 addNotification(`勢力「${targetFactionName}」への停戦申請が、期限直前(5分前)になっても承認されなかったため無効化されました。`, '停戦申請無効化');
             } else {
                 addNotification(`勢力「${requesterFactionName}」からの停戦要請が、期限直前(5分前)になっても承認されなかったため無効化されました。`, '停戦要請期限切れ');
             }
             fetchFactions();
             fetchNotices();
         }
    });

    // アクティビティログ受信（ネームドマスの防衛成功・失敗など）
    socket.on('activity', (data) => {
         if (data.type === 'named_tile_resist') {
             const currentP = playerDataRef.current;
             if (currentP) {
                 const isDefender = data.targetFactionId === currentP.factionId;
                 const isAttacker = data.factionId === currentP.factionId;

                 if (isDefender) {
                     addNotification(`自勢力のネームドマス「${data.tileName}」が攻撃を防ぎました！(ボーナス: ${data.bonusNext})`, "防衛成功");
                 } else if (isAttacker) {
                     addNotification(`ネームドマス「${data.tileName}」の攻略に失敗しました...(ボーナス: ${data.bonusNext})`, "攻略失敗");
                 }
             }
        }
    });

    // 同盟締結通知
    socket.on('alliance:formed', (data) => {
        const currentP = playerDataRef.current;
        if (currentP && data.factions.includes(currentP.factionId)) {
            addNotification(`${data.names[0]} と ${data.names[1]} が同盟を締結しました。`, '同盟成立');
            fetchFactions();
            fetchNotices();
        }
    });

    // 同盟解除通知
    socket.on('alliance:broken', (data) => {
        const currentP = playerDataRef.current;
        if (currentP && data.factions.includes(currentP.factionId)) {
            addNotification(`${data.names[0]} と ${data.names[1]} の同盟が解消されました。`, '同盟解消');
            fetchFactions();
            fetchNotices();
        }
    });

    socket.on('alliance:created', () => {
        fetchAlliances();
        fetchFactions();
    });

    socket.on('alliance:updated', () => {
        fetchAlliances();
    });

    socket.on('alliance:disbanded', () => {
        fetchAlliances();
        fetchFactions();
        refreshAuthStatus();
    });

    socket.on('alliance:memberJoined', () => {
        fetchAlliances();
        fetchFactions();
        refreshAuthStatus();
    });

    socket.on('alliance:memberLeft', () => {
        fetchAlliances();
        fetchFactions();
        refreshAuthStatus();
    });

    socket.on('alliance:memberKicked', () => {
        fetchAlliances();
        fetchFactions();
        refreshAuthStatus();
    });

    socket.on('alliance:requestReceived', () => {
        fetchAlliances();
    });

    // 汎用トースト通知
    socket.on('notification:toast', (data) => {
        const title = data.title || "お知らせ";
        const message = data.message || "";
        addNotification(message, title);

        // AP関連の場合はエフェクトも出す?
        if (message.includes("AP")) {
            setApUpdated(true);
            setTimeout(() => setApUpdated(false), 1000);
        }
    });

    // 戦争のリアルタイム更新
    socket.on('war:update', (data) => {
      console.log('[Socket] war:update', data);
      setWars(data);
    });

    // 勢力滅亡通知 (個別に受信)
    socket.on('faction:destroyed_notification', (data) => {
        const virtualNotice = {
            id: 'defeat-' + Date.now(),
            title: '勢力滅亡のお知らせ',
            content: `あなたの所属していた勢力「${data.factionName}」は、${data.destroyedBy} によって滅亡させられました。`,
            date: new Date().toISOString()
        };
        setActiveNotice(virtualNotice);
        setShowNoticePopup(true);
        refreshAuthStatus(); // 無所属状態の反映
        fetchFactions();   // 勢力一覧の更新
    });

    // お知らせのリアルタイム更新
    socket.on('faction:notice', (data) => {
        const currentP = playerDataRef.current;
        // data は { factionId, notice } の形式
        if (currentP && data.factionId === currentP.factionId) {
            console.log("Real-time notice received!", data.notice);

            // 権限チェック
            const myFaction = factionsRef.current[currentP.factionId];
            if (myFaction && data.notice.requiredPermission) {
                const isKing = myFaction.kingId === currentP.id;
                let myPermissions = {};
                if (myFaction.memberRoles && myFaction.memberRoles[currentP.id]) {
                    const roleId = myFaction.memberRoles[currentP.id];
                    const role = myFaction.roles ? myFaction.roles.find(r => r.id === roleId) : null;
                    if (role && role.permissions) myPermissions = role.permissions;
                }

                let hasPerm = isKing;
                const reqP = data.notice.requiredPermission;
                if (reqP === 'canDiplomacy') hasPerm = isKing || myPermissions.canDiplomacy;
                else if (reqP === 'canManageAlliance') hasPerm = isKing || myPermissions.canDiplomacy || myPermissions.canManageAlliance;
                else if (reqP === 'canManageMembers') hasPerm = isKing || myPermissions.canManageMembers;
                else if (reqP === 'king') hasPerm = isKing;

                if (!hasPerm) {
                    console.log("Notice blocked due to lack of permission:", reqP);
                    return;
                }
            }

            // 通知リストを更新してポップアップを表示
            setNotices(prev => {
                if (prev.some(n => n.id === data.notice.id)) return prev;
                return [data.notice, ...prev];
            });

            // 即座にポップアップ表示 (支援物資以外)
            if (!data.notice.id.startsWith('notice-support-')) {
                setActiveNotice(data.notice);
                setShowNoticePopup(true);
            }

            // トースト通知も出す (視認性向上)
            addNotificationRef.current(data.notice.content, data.notice.title || "お知らせ");
        }
    });

    // [NEW] グローバルお知らせのリアルタイム更新 (運営通知など)
    // 重複防止用のRef (useEffect外で定義されていることを想定、なければ追加が必要だがここではスコープ内変数として追加できないため、既存のRefを利用するか新規追加が必要。
    // 今回は安全のため、関数外ではなくコンポーネント内Refを利用する前提で修正するが、
    // useEffect内で完結させるために簡単なSetを使用(ただし再レンダリングで消える)。
    // 永続化が必要なため、useEffectの外（コンポーネントレベル）にRefがあるべき。
    // ここでは socket.on のコールバック内修正にとどめ、Refは別途追加する。

    socket.on('notice:global', (notice) => {
        console.log("Global real-time notice received!", notice);

        // 既に処理済みのIDなら何もしない (processedNoticeIdsRef はこの後追加)
        if (processedNoticeIdsRef.current.has(notice.id)) {
            console.log("Duplicate global notice ignored:", notice.id);
            return;
        }
        processedNoticeIdsRef.current.add(notice.id);

        // IDリストが肥大化した場合は一旦リセット
        if (processedNoticeIdsRef.current.size > 100) {
            // 単純に全クリア（稀なケース）
            processedNoticeIdsRef.current.clear();
            processedNoticeIdsRef.current.add(notice.id);
        }

        // 通知リストを更新（重複排除）
        setNotices(prev => {
            if (prev.some(n => n.id === notice.id)) return prev;
            return [notice, ...prev];
        });

        // 即座にポップアップ表示
        setActiveNotice(notice);
        setShowNoticePopup(true);

        // トースト通知
        addNotificationRef.current(notice.content, notice.title || "運営からのお知らせ");
    });

    // アクティビティログのリアルタイム更新
    socket.on('activity:new', (entry) => {
        setActivityLog(prev => {
            if (prev.some(e => e.id === entry.id)) return prev;
            const updated = [entry, ...prev];
            return updated.slice(0, 1000);
        });
    });

    // 併合による勢力変更通知
    socket.on('player:factionChanged', (data) => {
        const currentP = playerDataRef.current;
        if (currentP && data.playerId === currentP.id) {
            setPlayerData(prev => ({
                ...prev,
                factionId: data.newFactionId,
            }));
            // Cookie更新
            document.cookie = `game2_factionId=${data.newFactionId}; path=/; max-age=604800`;
            addNotification(`新しい所属勢力：${data.newFactionName}`, '勢力併合');
        }
    });

    // 自分の役職変更をリアルタイム検知
    socket.on('faction:memberRoleUpdated', async (data) => {
        console.log("Debug: faction:memberRoleUpdated received", data);
        const currentP = playerDataRef.current;
        console.log("Debug: currentP when receiving role update", currentP);
        if (currentP && data.memberId === currentP.id && data.factionId === currentP.factionId) {
            console.log("Your role has been updated confirmed!", data.roleId);
            await fetchFactions(); // 勢力情報を最新にする

            // fetchFactions完了後にstateから最新のロール情報を取得
            setTimeout(() => {
                const f = factionsRef.current[data.factionId];
                if (f) {
                    // ID比較をStringで行う
                    const role = f.roles ? f.roles.find(r => String(r.id) === String(data.roleId)) : null;
                    const roleName = role ? role.name : (f.kingId === currentP.id ? (f.kingRoleName || "勢力主") : "メンバー");
                    addNotification(`あなたの役職が「${roleName}」に変更されました。`, "役職変更");

                    // ポップアップでも通知
                    setActiveNotice({
                        id: `role-upd-${Date.now()}`,
                        title: "役職変更",
                        content: `あなたの役職が「${roleName}」に変更されました。権限が更新されました。`,
                        date: new Date().toISOString()
                    });
                    setShowNoticePopup(true);
                }
            }, 100);
        }
    });

    // 役職自体の権限が更新された場合
    socket.on('faction:roleUpdated', (data) => {
        const currentP = playerDataRef.current;
        console.log("Debug: faction:roleUpdated received", data, currentP);
        if (currentP && currentP.factionId === data.factionId) {
            const myRoleId = factionsRef.current[currentP.factionId]?.memberRoles?.[currentP.id];

            console.log(`Debug: MyRoleID: ${myRoleId} (Type: ${typeof myRoleId}), TargetRoleID: ${data.roleId} (Type: ${typeof data.roleId})`);

            // ID比較は型違い(String vs Number)を考慮して緩い比較(==)にするか、String変換して比較
            if (String(myRoleId) === String(data.roleId)) {
                console.log("Your role permissions have been updated!");
                fetchFactions(); // 最新の権限を反映
                addNotification(`あなたの役職「${data.role.name}」の権限設定が更新されました。`, "権限変更");

                setActiveNotice({
                    id: `role-perm-upd-${Date.now()}`,
                    title: "権限変更",
                    content: `あなたの役職「${data.role.name}」の権限設定が更新されました。`,
                    date: new Date().toISOString()
                });
                setShowNoticePopup(true);
            }
        }
    });

    // 勢力主が譲渡されたときの通知
    socket.on('player:kingReceived', (data) => {
        const currentP = playerDataRef.current;
        if (currentP && data.playerId === currentP.id) {
            addNotification(`${data.fromPlayerName} さんから勢力「${data.factionName}」の勢力主に任命されました。`, '勢力主任命');
        }
    });

    // 停戦関連のリアルタイム更新
    socket.on('truce:established', () => {
        fetchFactions();
        fetchTruces();
    });
    socket.on('truce:rejected', () => {
        fetchFactions();
        fetchTruces();
    });
    socket.on('truce:request', () => {
        fetchFactions();
    });

    return () => {
      console.log("Cleaning up socket listeners...");
      socket.removeAllListeners();
    };
  }, []);

  // アクティビティログ初期取得
  useEffect(() => {
    if (!authStatus.authenticated) return;
    fetch('/api/activity-log', { credentials: 'include' })
      .then(res => res.json())
      .then(data => setActivityLog(data.entries || []))
      .catch(() => {});
  }, [authStatus.authenticated]);

  // [NEW] ログ検索用State
  const [logSearchTerm, setLogSearchTerm] = useState('');

  // [NEW] 過去ログ取得 (検索状態を考慮)
  const loadMoreLogs = useCallback(async (lastId) => {
      try {
          const query = new URLSearchParams({
              beforeId: lastId,
              limit: 100
          });
          if (logSearchTerm) {
              query.append('search', logSearchTerm);
          }

          const res = await fetch(`/api/activity-log?${query.toString()}`, { credentials: 'include' });
          const data = await res.json();
          if (data.entries && data.entries.length > 0) {
              setActivityLog(prev => [...prev, ...data.entries]);
              return data.entries.length;
          }
          return 0;
      } catch (e) {
          console.error("Failed to load more logs:", e);
          return 0;
      }
  }, [logSearchTerm]);

  // [NEW] ログ検索実行
  const handleLogSearch = useCallback(async (term) => {
      setLogSearchTerm(term);
      try {
          const query = new URLSearchParams({ limit: 300 }); // 検索時は300件取得
          if (term) query.append('search', term);

          const res = await fetch(`/api/activity-log?${query.toString()}`, { credentials: 'include' });
          const data = await res.json();
          setActivityLog(data.entries || []);
      } catch (e) {
          console.error("Search failed:", e);
      }
  }, []);


  // Season 2 Multi-Overpaint
  const [overpaintTargetCount, setOverpaintTargetCount] = useState(1);



  // タイルクリックハンドラ
  const handleTileClick = useCallback((x, y) => {
    // 勢力作成モード（起点選択中）
    if (pendingOrigin !== null) {
      setPendingOrigin({ x, y });
      setShowCreateFaction(true);
      return;
    }

    const key = `${x}_${y}`;

    // タイル塗りモード
    if (!playerData) return;

    // クリックされたタイルに勢力があるか確認
    const targetTile = mapTiles[key];

    if (targetTile && targetTile.faction) {
        // 自分が無所属なら参加確認ポップアップ
        if (!playerData.factionId) {
            const targetFaction = factions[targetTile.faction];
            if (targetFaction) {
                if (targetFaction.joinPolicy === 'closed') {
                    // 募集停止中なら表示しない、あるいはトーストで通知
                    addNotification('参加不可', 'この勢力は現在メンバーを募集していません。', 'error');
                    return;
                }
                setJoiningFaction(targetFaction);
            }
            return;
        } else {
            // [Check] 既に所属済みの場合、他勢力参加はできない（脱退してから）
            // ポップアップを出さない。
            // ただし、他勢力のタイルでも選択（上書き）可能にするためリターンしない
        }
        // 所属済みなら、他勢力のタイルでも選択（上書き）可能にするためリターンしない
    }

    if (!playerData.factionId) return;

    // 既に選択済みか確認
    if (selectedTiles.some(t => t.x === x && t.y === y)) {
      setSelectedTiles(prev => prev.filter(t => !(t.x === x && t.y === y)));
    } else {
      setSelectedTiles(prev => [...prev, { x, y }]);
    }
  }, [pendingOrigin, playerData, selectedTiles, mapTiles, factions]);

  // 認証エラーハンドリング
  const handleAuthError = useCallback((status) => {
    if (status === 401 || status === 403) {
      setAuthStatus((prev) => ({ ...prev, authenticated: false, isGuest: true }));
      setPlayerData(null);
      setShowAuthModal(true);
    }
  }, []);

  // タイル塗り実行
  // タイル塗り実行 (引数で対象タイルを指定可能に)
  // タイル塗り実行
  // タイル塗り実行 (引数で対象タイルを指定可能に)
  const handlePaint = useCallback(async (overrideTiles = null, action = 'paint') => {
    if (!playerData) {
      handleAuthError(401);
      return;
    }
    const isOverride = Array.isArray(overrideTiles);
    const targetTiles = isOverride ? overrideTiles : selectedTiles;
    if (!targetTiles || targetTiles.length === 0) return;

    // 事前チェック: APコスト計算と滅亡確認
    let cost = 0;
    // クラスタ検出 (コスト計算用)
    const myFid = playerData.factionId;
    const targetSet = new Set(targetTiles.map(t => `${t.x}_${t.y}`));
    const visited = new Set();
    const clusters = [];

    // 1. targetTiles からクラスタ（隣接するタイルの塊）を生成
    for (const t of targetTiles) {
        const key = `${t.x}_${t.y}`;
        if (visited.has(key)) continue;

        const cluster = [];
        const queue = [t];
        visited.add(key);

        while (queue.length > 0) {
            const current = queue.shift();
            cluster.push(current);

            const neighbors = [
                { x: current.x, y: current.y - 1 },
                { x: current.x, y: current.y + 1 },
                { x: current.x - 1, y: current.y },
                { x: current.x + 1, y: current.y }
            ];

            for (const n of neighbors) {
                const nKey = `${n.x}_${n.y}`;
                if (targetSet.has(nKey) && !visited.has(nKey)) {
                    visited.add(nKey);
                    queue.push(n);
                }
            }
        }
        clusters.push(cluster);
    }

    // 2. クラスタごとの AP コスト算出
    for (const cluster of clusters) {
        let isConnectedToSelf = false;

        // クラスタ内のいずれかのタイルが、既に自分の領土に隣接しているか確認
        for (const t of cluster) {
             const neighbors = [
                { x: t.x, y: t.y - 1 },
                { x: t.x, y: t.y + 1 },
                { x: t.x - 1, y: t.y },
                { x: t.x + 1, y: t.y }
            ];

            for (const n of neighbors) {
                // If neighbor is NOT in target set (already handled by clustering), check mapTiles
                const nKey = `${n.x}_${n.y}`;
                if (!targetSet.has(nKey)) {
                    const mapTile = mapTiles[nKey];
                    if (mapTile && (mapTile.factionId === myFid || mapTile.faction === myFid)) {
                        isConnectedToSelf = true;
                        break;
                    }
                }
            }
            if (isConnectedToSelf) break;
        }

        // コスト適用
        for (const t of cluster) {
            const tKey = `${t.x}_${t.y}`;
            const tileOnMap = mapTiles[tKey];
            const isEnemy = tileOnMap && (tileOnMap.factionId || tileOnMap.faction) && (tileOnMap.factionId !== myFid && tileOnMap.faction !== myFid);
            const isBlank = !tileOnMap || (!tileOnMap.factionId && !tileOnMap.faction);

            let tileCost = 1;

            // 敵陣または空白地への侵攻ロジック
            if (isEnemy || isBlank) {
                // 自領土に直接接続されていない（同盟領土経由など）場合は、飛び地ペナルティとしてコスト増加(+1)
                if (!isConnectedToSelf) {
                    tileCost += 1;
                }
            }
            // 重ね塗りなどの特殊コストロジックはサーバー側の検証に準拠（ここでは見積もりを算出）

            cost += tileCost;
        }
    }

    // 共有AP考慮
    const myFaction = factions[playerData.factionId];
    const sharedAP = (myFaction && typeof myFaction.sharedAP === 'number') ? myFaction.sharedAP : 0;
    const useShared = !!playerData.autoConsumeSharedAp;
    const availableAP = (playerData.ap || 0) + (useShared ? sharedAP : 0);

    if (availableAP < cost) {
      alert(`APが足りません (必要: ${cost}AP, 所持: ${availableAP}AP)`);
      return;
    }

    if (action === 'overpaint' && !isOverride) {
        if (!window.confirm(`選択した${targetTiles.length}マスを重ね塗り(強化)しますか？\n指定回数: ${overpaintTargetCount}回\n消費AP: ${cost}`)) {
            return;
        }
    }

    try {
      const res = await fetch('/api/tiles/paint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          tiles: targetTiles,
          action,
          overpaintCount: action === 'overpaint' ? overpaintTargetCount : 1
        })
      });

      if (res.status === 401) {
        handleAuthError(res.status);
        return;
      }

      if (res.status === 403) {
          const errorData = await res.json();
          // ZOCエラーや宣戦布告エラーなどは通知のみ
          addNotification(errorData.error || 'アクセス権限がありません', "権限エラー");
          return;
      }

      if (res.status === 503) {
          const errorData = await res.json();
          addNotification(errorData.error || '現在この操作は利用できません（メンテナンス中または休憩時間）', "制限中");
          return;
      }

      const data = await res.json();

      if (data.success) {
        if (!isOverride) setSelectedTiles([]); // 選択モードのみクリア
        setPlayerData(prev => ({ ...prev, ap: data.remainingAP }));
        if (data.refilledAmount > 0) {
          addNotification(`APが ${data.refilledAmount} 補充されました！`, "AP補充");
          setApUpdated(true);
          setTimeout(() => setApUpdated(false), 1000);
        }
      } else {
        addNotification(data.error || '塗りに失敗しました', "エラー");
      }
    } catch (e) {
      addNotification('通信エラーが発生しました', "エラー");
    }
  }, [selectedTiles, handleAuthError, playerData, mapTiles, factions, overpaintTargetCount]);

  // タイル消去
  const handleErase = useCallback(async () => {
    if (selectedTiles.length === 0) return;

    try {
      const res = await fetch('/api/tiles/erase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ tiles: selectedTiles })
      });

      if (res.status === 401 || res.status === 403) {
        handleAuthError(res.status);
        return;
      }

      const data = await res.json();

      if (data.success) {
        setSelectedTiles([]);
        alert(`${data.erasedCount}マス消去しました`);
      } else {
        alert(data.error || '消去に失敗しました');
      }
    } catch (e) {
      alert('エラーが発生しました');
    }
  }, [selectedTiles, handleAuthError]);

  const handleAttackNamedTile = useCallback((tileKey) => {
    if (!tileKey) return;
    const [x, y] = tileKey.split('_').map(Number);
    // 攻撃は通常の塗り処理(paint)として実行

    // overrideTilesを使って、選択状態に関わらず対象タイルのみを塗る
    handlePaint([{x, y}], 'paint');
  }, [handlePaint]);

  // ネームドマス作成
  const handleCreateNamedTile = useCallback(async (providedName) => {
    if (selectedTiles.length === 0) return;
    const t = selectedTiles[0];

    let name = providedName;
    if (typeof name !== 'string') {
        name = window.prompt("ネームドマスの名前を入力してください");
        if (!name || !name.trim()) return;
    }

    try {
      const res = await fetch('/api/tiles/named/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ x: t.x, y: t.y, name })
      });

      if (res.status === 401 || res.status === 403) {
        handleAuthError(res.status);
        return;
      }

      const data = await res.json();
      if (data.success) {
          alert("ネームドマスを作成しました！");
          setSelectedTiles([]);
          setPlayerData(prev => ({ ...prev, ap: data.remainingAP }));
      } else {
          alert(data.error || "作成に失敗しました");
      }
    } catch(e) {
        alert("エラーが発生しました: " + e.message);
    }
  }, [selectedTiles, handleAuthError]);

  // ネームドマス名前変更
  const handleRenameNamedTile = useCallback(async (tileKey, newName) => {
    // tileKey is "x_y"
    const [x, y] = tileKey.split('_').map(Number);
    try {
        const res = await fetch('/api/tiles/named/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ x, y, name: newName })
        });
        const data = await res.json();
        if (data.success) {
            alert('名前を変更しました');
            // Socketで更新されるのでstate更新は必須ではないが、即時反映のため
            setNamedCells(prev => {
                if(prev[tileKey]) {
                    return { ...prev, [tileKey]: { ...prev[tileKey], name: data.name }};
                }
                return prev;
            });
            return { message: '変更しました' };
        } else {
            return { error: data.error || '変更に失敗しました' };
        }
    } catch (e) {
        return { error: '通信エラー' };
    }
  }, []);

  // ネームドマス削除
  const handleDeleteNamedTile = useCallback(async (tileKey) => {
    if (!window.confirm("本当にこのネームドマスを削除しますか？\n（タイル自体は残りますが、名前と座標情報は消去されます）")) return;

    const [x, y] = tileKey.split('_').map(Number);
    try {
        const res = await fetch('/api/tiles/named/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ x, y })
        });
        const data = await res.json();
        if (data.success) {
            alert('削除しました');
            setNamedCells(prev => {
                const next = { ...prev };
                delete next[tileKey];
                return next;
            });
            return { success: true };
        } else {
            alert(data.error || '削除に失敗しました');
            return { error: data.error };
        }
    } catch (e) {
        alert('通信エラー');
        return { error: '通信エラー' };
    }
  }, []);

  // 表示名変更
  const handleDisplayNameChange = useCallback(async (displayName) => {
    try {
      const res = await fetch('/api/player/name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ displayName })
      });

      const data = await res.json();
      if (data.success) {
        if (data.player) {
           setPlayerData(data.player);
        } else {
           // 万が一playerオブジェクトがない場合は名前だけ更新してステート崩壊を防ぐ
           setPlayerData(prev => prev ? { ...prev, displayName: data.displayName } : prev);
        }
        alert('表示名を変更しました');
      } else {
        alert(data.error || '変更に失敗しました');
      }
    } catch (e) {
      alert('エラーが発生しました');
    }
  }, []);


  // 勢力設定変更 (王様用)
  const handleFactionSettingsChange = useCallback(async ({ name, color }) => {
    if (!playerData?.factionId) return;

    try {
      const res = await fetch(`/api/factions/${playerData.factionId}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name, color })
      });

      const data = await res.json();
      if (data.success) {
        alert('勢力設定を変更しました');
        // 勢力データは socket経由で更新されるはず
      } else {
        alert(data.error || '変更に失敗しました');
      }
    } catch (e) {
      alert('エラーが発生しました');
    }
  }, [playerData?.factionId]);

  // 勢力主譲渡
  const handleTransferKing = useCallback(async (newKingId) => {
    if (!playerData?.factionId) return;
    if (!window.confirm('本当に勢力主を譲渡しますか？\n譲渡後は一般メンバーに戻ります。')) return;

    try {
      const res = await fetch(`/api/factions/${playerData.factionId}/transfer-king`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ newKingId })
      });

      const data = await res.json();
      if (data.success) {
        alert('勢力主を譲渡しました');
        // socketで更新されるのでローカルstate更新は不要だが、念のため再取得してもよい
      } else {
        alert(data.error || '譲渡に失敗しました');
      }
    } catch (e) {
      alert('エラーが発生しました');
    }
  }, [playerData?.factionId]);

  // 勢力併合要請
  const handleMergeRequest = useCallback(async (targetFactionId) => {
    try {
      const res = await fetch('/api/factions/merge/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ targetFactionId })
      });
      const data = await res.json();
      if (data.success) {
        // alert('併合要請を送信しました');
      } else {
        alert(data.error || '要請に失敗しました');
      }
    } catch (e) {
      alert('通信エラー');
    }
  }, []);

  // 併合回答
  const handleMergeRespond = useCallback(async (requesterFactionId, accept) => {
    try {
      const res = await fetch('/api/factions/merge/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ requesterFactionId, accept })
      });
      const data = await res.json();
      if (data.success) {
        // alert(data.message);
        setPendingMergeRequest(null);
        fetchNotices();
      } else {
        alert(data.error || '処理に失敗しました');
      }
    } catch (e) {
      alert('通信エラー');
    }
  }, [fetchNotices]);

  // 併合要請取り消し
  const handleMergeCancel = useCallback(async () => {
    try {
      const res = await fetch('/api/factions/merge/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      const data = await res.json();
      if (data.success) {
        // alert('併合要請を取り消しました');
      } else {
        alert(data.error || '取り消しに失敗しました');
      }
    } catch (e) {
      alert('通信エラー');
    }
  }, []);

  // 同盟要請 (勢力主のみ)
  const handleAllianceRequest = useCallback(async (targetFactionId) => {
    try {
      const res = await fetch('/api/factions/alliance/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ targetFactionId })
      });
      const data = await res.json();
      if (!data.success) {
        alert(data.error || '送信に失敗しました');
      }
    } catch (e) {
      alert('通信エラー');
    }
  }, []);

  // 同盟加盟申請 (勢力主のみ)
  const handleAllianceJoinRequest = useCallback(async (targetFactionId) => {
    try {
      const res = await fetch('/api/factions/alliance/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ targetFactionId })
      });
      const data = await res.json();
      if (data.success) {
        return { message: '加盟申請を送信しました' };
      } else {
        return { error: data.error || '送信に失敗しました' };
      }
    } catch (e) {
      return { error: '通信エラー' };
    }
  }, []);

  // 同盟回答
  const handleAllianceRespond = useCallback(async (requesterFactionId, accept) => {
    try {
      const res = await fetch('/api/factions/alliance/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ requesterFactionId, accept })
      });
      const data = await res.json();
      if (data.success) {
        setPendingAllianceRequest(null);
        // if (accept) alert('同盟を締結しました！');
        fetchNotices();
      } else {
        alert(data.error || '回答に失敗しました');
      }
    } catch (e) {
      alert('通信エラー');
    }
  }, [fetchNotices]);

  // 同盟解除
  const handleAllianceBreak = useCallback(async (targetFactionId) => {
    try {
      const res = await fetch('/api/factions/alliance/break', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ targetFactionId })
      });
      const data = await res.json();
      if (data.success) {
        // alert('同盟を解消しました');
      } else {
        alert(data.error || '解消に失敗しました');
      }
    } catch (e) {
      alert('通信エラー');
    }
  }, []);

  // Season 2 Handlers
  const handleDonateAP = useCallback(async (amount) => {
      if (!playerData?.factionId) return;
      try {
          const res = await fetch(`/api/factions/${playerData.factionId}/shared-ap/donate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ amount })
          });
          const d = await res.json();
          if(d.success) {
              alert(`共有APに ${amount} AP寄付しました`);
              refreshAuthStatus(); // 自分のAP更新
              fetchFactions();   // 勢力のSharedAP更新
          } else {
              alert(d.error || '寄付に失敗しました');
          }
      } catch(e) { alert('通信エラー'); }
  }, [playerData?.factionId]);

  const handleToggleAutoSharedAp = useCallback(async (enabled) => {
      try {
          const res = await fetch('/api/player/settings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ autoConsumeSharedAp: enabled })
          });
          const d = await res.json();
          if (d.success) {
              setPlayerData(prev => ({ ...prev, autoConsumeSharedAp: d.autoConsumeSharedAp }));
          } else {
              alert(d.error || '設定変更に失敗しました');
          }
      } catch(e) { alert('通信エラー'); }
  }, []);


  const handleJoinPolicyChange = useCallback(async (policy) => {
      try {
          const res = await fetch('/api/factions/settings/policy', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ joinPolicy: policy })
          });
          const d = await res.json();
          if(d.success) {
              alert('加入ポリシーを変更しました');
              fetchFactions();
          } else {
              alert(d.error || '変更に失敗しました');
          }
      } catch(e) { alert('通信エラー'); }
  }, []);

  // 割譲回答
  const handleCedeRespond = useCallback(async (requestId, accept) => {
    try {
      const res = await fetch('/api/tiles/cede/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ requestId, accept })
      });
      const data = await res.json();
      if (data.success || (!accept && !data.error)) {
        fetchNotices();
      } else {
        alert(data.error || '回答に失敗しました');
      }
    } catch (e) {
      alert('通信エラー');
    }
  }, [fetchNotices]);

  // メンバー一覧表示
  const handleShowMemberList = useCallback((fid) => {
    setShowMemberFactionId(fid);
  }, []);

  // 勢力作成開始
  const startCreateFaction = () => {
    if (!playerData) {
      handleAuthError(401);
      return;
    }
    setPendingOrigin({ x: -1, y: -1 }); // 仮の値、マップクリック待ち
    alert(
      "勢力の拠点を決めてください。 (作成後3時間は再操作が制限されます)",
    );
  };

  // 勢力作成完了
  const handleFactionCreated = (faction) => {
    setShowCreateFaction(false);
    setPendingOrigin(null);
    // Cookieに保存
    document.cookie = `game2_factionId=${faction.id}; max-age=${60*60*24*30}; path=/`;

    // プレイヤー情報再取得
    fetch('/api/player', { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        if (data.player) setPlayerData(data.player);
      });
  };

  // 勢力参加
  const handleJoinFaction = async (factionId) => {
    if (isProcessingJoin) return;
    setIsProcessingJoin(true);

    try {
      const res = await fetch(`/api/factions/${factionId}/join`, {
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json();

      if (data.success) {
        // Cookieに保存
        document.cookie = `game2_factionId=${factionId}; max-age=${60 * 60 * 24 * 30}; path=/`;

        fetch('/api/player', { credentials: 'include' })
          .then(res => res.json())
          .then(data => {
            if (data.player) setPlayerData(data.player);
          });

        if (data.applied) {
          addNotification(data.message || '加入申請を送信しました', '申請完了');
        }
      } else {
        alert(data.error || '参加に失敗しました');
      }
    } catch (e) {
      alert('エラーが発生しました');
    } finally {
      setIsProcessingJoin(false);
    }
  };

  // 勢力脱退
  const handleLeaveFaction = async (options = {}) => {
    if (!playerData) return;

    // 脱退時の AP コスト確認は廃止済み（現在は無料）

    try {
      const res = await fetch('/api/factions/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options), // isIndependence, newFactionName, etc.
        credentials: 'include'
      });
      const data = await res.json();

      if (data.success) {
        // Cookie削除
        document.cookie = "game2_factionId=; max-age=0; path=/";
        // プレイヤー情報再取得
        fetch('/api/player', { credentials: 'include' })
          .then(res => res.json())
          .then(data => {
            if (data.player) setPlayerData(data.player);
          });
        alert('勢力を脱退しました。');
      } else {
        alert(data.error || '脱退に失敗しました');
      }
    } catch (e) {
      alert('エラーが発生しました');
    }
  };


  // 役職設定モーダルを開く
  const handleOpenRoleSettings = () => {
    setShowRoleSettingsModal(true);
  };

  // skipConfirmation トグル
  const handleToggleSkipConfirmation = () => {
    setSkipConfirmation(prev => !prev);
  };

  // 共有AP自動消費トグル (修正版)
  const handleToggleAutoSharedApAction = useCallback(async (newValue) => {
      try {
          console.log('[App] Toggling Auto Shared AP:', newValue);
          // 即時反映 (楽観的更新)
          setPlayerData(prev => ({ ...prev, autoConsumeSharedAp: newValue }));

          const res = await fetch('/api/player/settings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ autoConsumeSharedAp: newValue }),
              credentials: 'include'
          });
          const data = await res.json();
          if (!data.success) {
              console.error('[App] Failed to toggle shared AP setting:', data.error);
              // 失敗したら戻す
              setPlayerData(prev => ({ ...prev, autoConsumeSharedAp: !newValue }));
          }
      } catch (e) {
          console.error('[App] Error toggling shared AP setting:', e);
          setPlayerData(prev => ({ ...prev, autoConsumeSharedAp: !newValue }));
      }
  }, []);

  // 役職管理
  const handleCreateRole = async (factionId, roleData) => {
      try {
          const res = await fetch(`/api/factions/${factionId}/roles`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify(roleData)
          });
          const d = await res.json();
          if (d.success) {
              fetchFactions();
              return d;
          } else {
              throw new Error(d.error || '作成に失敗しました');
          }
      } catch (e) {
          console.error('handleCreateRole error:', e);
          throw e;
      }
  };

  const handleUpdateRole = async (factionId, roleId, roleData) => {
      try {
          console.log('[handleUpdateRole] Sending request:', { factionId, roleId, roleData });
          const res = await fetch(`/api/factions/${factionId}/roles/${roleId}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify(roleData)
          });
          console.log('[handleUpdateRole] Response status:', res.status);

          if (!res.ok) {
              const errorText = await res.text();
              console.error('[handleUpdateRole] Server error:', errorText);
              try {
                  const errorJson = JSON.parse(errorText);
                  throw new Error(errorJson.error || `サーバーエラー (${res.status})`);
              } catch {
                  throw new Error(`サーバーエラー (${res.status}): ${errorText.substring(0, 100)}`);
              }
          }

          const d = await res.json();
          console.log('[handleUpdateRole] Response data:', d);
          if (d.success) {
              fetchFactions();
              return d;
          } else {
              throw new Error(d.error || '更新に失敗しました');
          }
      } catch (e) {
          console.error('[handleUpdateRole] Error:', e);
          throw e;
      }
  };

  const handleDeleteRole = async (factionId, roleId) => {
      try {
          const res = await fetch(`/api/factions/${factionId}/roles/${roleId}`, {
              method: 'DELETE',
              credentials: 'include'
          });
          const d = await res.json();
          if (d.success) {
              fetchFactions();
              return d;
          } else {
              throw new Error(d.error || '削除に失敗しました');
          }
      } catch (e) {
          console.error('handleDeleteRole error:', e);
          throw e;
      }
  };

  const handleAssignRole = async (pid, roleId) => {
      if (!playerData?.factionId) return;
      try {
          const res = await fetch(`/api/factions/${playerData.factionId}/members/${pid}/role`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ roleId })
          });
          const d = await res.json();
          if (d.success) {
              fetchFactions();
          } else {
              alert(d.error || '役職の割り当てに失敗しました');
          }
      } catch (e) { alert('通信エラー'); }
  };

  // 同盟作成
  const handleCreateAlliance = useCallback(async (name, color) => {
    try {
        const res = await fetch('/api/alliances/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, color })
        });
        const data = await res.json();
        if (data.error) return { error: data.error };
        return { message: "同盟を作成しました" };
    } catch (e) {
        console.error(e);
        return { error: "通信エラー" };
    }
  }, []);

  // 他勢力へのメッセージ送信 (ポイント通知)
  const handleSendFactionMessage = useCallback(async (targetFactionId, message) => {
    try {
      const res = await fetch(`/api/factions/${targetFactionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        credentials: 'include'
      });
      const data = await res.json();
      return data;
    } catch (e) {
      console.error(e);
      return { error: '通信エラーが発生しました' };
    }
  }, []);

  // 同盟への参戦要請 (Call to Arms)
  const handleCallToArms = useCallback(async (warId) => {
    try {
        const res = await fetch('/api/alliances/war/call-to-arms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ warId }),
            credentials: 'include'
        });
        const data = await res.json();
        return data; // { success, message, error }
    } catch (e) {
        console.error(e);
        return { error: '通信エラーが発生しました' };
    }
  }, []);

  const handleAllianceAcceptRequest = useCallback(async (allianceId, targetFactionId) => {
      try {
          const res = await fetch(`/api/alliances/${allianceId}/accept`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ factionId: targetFactionId })
          });
          const data = await res.json();
          if (data.error) return { error: data.error };
          return { message: "加盟を承認しました" };
      } catch (e) {
          console.error(e);
          return { error: "通信エラー" };
      }
  }, []);

  const handleAllianceLeave = useCallback(async () => {
      try {
          const res = await fetch('/api/alliances/leave', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
          });
          const data = await res.json();
          if (data.error) return { error: data.error };
          return { message: data.message };
      } catch (e) {
          console.error(e);
          return { error: "通信エラー" };
      }
  }, []);

  const handleKickMember = useCallback(async (fid, targetId) => {
      try {
          const res = await fetch(`/api/factions/kick`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ factionId: fid, targetId })
          });
          const data = await res.json();
          if (data.error) alert(data.error);
          else alert("メンバーを追放しました");
      } catch (e) {
          console.error(e);
          alert("通信エラー");
      }
  }, []);

  const handleAllianceKick = useCallback(async (allianceId, targetFactionId) => {
      try {
          const res = await fetch(`/api/alliances/${allianceId}/kick`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ factionId: targetFactionId })
          });
          const data = await res.json();
          if (data.error) return { error: data.error };
          return { message: "メンバーを追放しました" };
      } catch (e) {
          console.error(e);
          return { error: "通信エラー" };
      }
  }, []);

  const handleAllianceDisband = useCallback(async (allianceId) => {
      try {
          const res = await fetch(`/api/alliances/${allianceId}/disband`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
          });
          const data = await res.json();
          if (data.error) return { error: data.error };
          return { message: data.message };
      } catch (e) {
          console.error(e);
          return { error: "通信エラー" };
      }
  }, []);

  const handleTruceRequest = useCallback(async (targetFid, expiresAt) => {
      try {
          const res = await fetch('/api/truces/request', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ targetFactionId: targetFid, expiresAt })
          });
          const data = await res.json();
          if (data.error) return { error: data.error };
          return { message: data.message };
      } catch (e) {
          console.error(e);
          return { error: "通信エラー" };
      }
  }, []);

  const handleTruceAccept = useCallback(async (targetFid) => {
      try {
          const res = await fetch('/api/truces/accept', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ requesterFactionId: targetFid })
          });
          const data = await res.json();
          if (data.error) return { error: data.error };
          return { message: "停戦を承認しました" };
      } catch (e) {
          console.error(e);
          return { error: "通信エラー" };
      }
  }, []);

  const handleTruceReject = useCallback(async (targetFid) => {
      try {
          const res = await fetch('/api/truces/reject', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ requesterFactionId: targetFid })
          });
          const data = await res.json();
          if (data.error) return { error: data.error };
          return { message: data.message };
      } catch (e) {
          console.error(e);
          return { error: "通信エラー" };
      }
  }, []);

  // お知らせアクション処理 (Season 2 標準化)
  const handleNoticeAction = useCallback(async (noticeId, actionKey, actionData) => {
    // Standardized Diplomacy Actions
    const rid = activeNotice?.data?.requesterFactionId;

    switch (actionKey) {
        case 'alliance:accept':
            if (window.confirm("この勢力からの同盟加入申請を承認しますか？")) {
                await handleAllianceRespond(rid, true);
            }
            break;
        case 'alliance:reject':
            if (window.confirm("この勢力からの同盟加入申請を拒否しますか？")) {
                await handleAllianceRespond(rid, false);
            }
            break;
        case 'merge:accept':
            if (window.confirm("【重要】本当に勢力の併合（吸収）を承認しますか？\n承認すると相手の勢力は消滅し、領土とメンバーがあなたの勢力に吸収されます。")) {
                await handleMergeRespond(rid, true);
            }
            break;
        case 'merge:reject':
            if (window.confirm("この勢力からの併合要請を拒否しますか？")) {
                await handleMergeRespond(rid, false);
            }
            break;
        case 'truce:accept':
            if (window.confirm("この勢力からの停戦要請を承認しますか？")) {
                await handleTruceAccept(rid);
            }
            break;
        case 'truce:reject':
            alert("停戦要請を拒否しました（非表示にしました）");
            break;
        case 'cede:accept':
            if (window.confirm("領土割譲の提案を承認しますか？")) {
                const requestId = actionData?.requestId;
                if (!requestId) return;
                fetch('/api/tiles/cede/respond', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ requestId, accept: true })
                })
                .then(res => res.json())
                .then(data => {
                    if (data.success) alert('領土割譲を承認しました');
                    else alert(data.error || 'エラーが発生しました');
                    fetchFactions();
                })
                .catch(() => alert('通信エラー'));
            }
            break;
        case 'cede:reject':
            if (window.confirm("領土割譲の提案を拒否しますか？")) {
                const requestId = actionData?.requestId;
                if (!requestId) return;
                fetch('/api/tiles/cede/respond', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ requestId, accept: false })
                })
                .then(res => res.json())
                .then(data => {
                    if (data.success) alert('領土割譲を拒否しました');
                    else alert(data.error || 'エラーが発生しました');
                })
                .catch(() => alert('通信エラー'));
            }
            break;
        case 'approve':
        case 'reject':
        case 'accept': // Legacy fallback
            if (!playerData?.factionId) return;
            try {
                const res = await fetch(`/api/factions/notices/${noticeId}/respond`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: actionKey === 'accept' ? 'approve' : actionKey }),
                    credentials: 'include'
                });
                const data = await res.json();
                if (data.success) {
                    alert('処理しました');
                    setNotices(prev => prev.map(n =>
                        n.id === noticeId
                        ? { ...n, processedBy: { name: playerData.displayName || '自分' }, result: actionKey }
                        : n
                    ));
                    setShowNoticePopup(false);
                } else {
                    alert(data.error || 'エラーが発生しました');
                }
            } catch (e) { alert('通信エラー'); }
            break;
        default:
            console.warn("Unknown action key:", actionKey);
    }
  }, [activeNotice, handleAllianceRespond, handleMergeRespond, handleTruceAccept, fetchFactions, playerData, notices]);


  // ローディング中
  if (authStatus.loading) {
    return (
      <div className="auth-container">
        <div className="loading">読み込み中...</div>
      </div>
    );
  }

  // 未認証

  return (
    <div className="app-container">


      {/* モバイル用メニューボタン */}



      <div className="game-canvas">
        <GameMap
          tiles={mapTiles}
          factions={factions}
          selectedTiles={selectedTiles}
          onTileClick={(x, y) => {
              handleTileClick(x, y);
          }}

          playerFactionId={playerData?.factionId}
          playerData={playerData}
          mapJumpCoord={mapJumpCoord}
          // Season 2 Props
          showNamedTileNames={showNamedTileNames}
          namedCells={namedCells}
          brushToggleMode={brushToggleMode}
          alliances={alliances}
          showFactionNames={showFactionNames}
          showAllianceNames={showFactionNames} // 勢力名表示設定に統合
          showSpecialBorder={showSpecialBorder}
          highlightCoreOnly={highlightCoreOnly}
          blankTileColor={blankTileColor}
          hoverFactionId={hoveredFactionId}
          onShowFactionDetails={setShowMemberFactionId}
          // onNamedCellClick removed
          tilePopup={tilePopup}
          setTilePopup={setTilePopup}
          mapColorMode={mapColorMode} // New Unified Prop
          playerNames={playerNames} // [NEW]

          onZoomChange={setZoomLevel} // [NEW] ズームレベル更新
          workerPool={mapWorkerPool} // [NEW] 共有WorkerPool
        />

        {/* マップモード切り替えボタン & オプション */}
        <div className="map-controls-group">
            {/* Menu Toggle */}
           <button
             className="mobile-menu-btn"
             onClick={() => setIsSidebarOpen(!isSidebarOpen)}
             title="メニュー"
           >
             ☰
           </button>


           <button
             className={`map-mini-btn ${showMapOptionsCard ? 'active' : ''}`}
             onClick={() => setShowMapOptionsCard(!showMapOptionsCard)}
             title="マップ表示設定"
           >
             ⚙️
           </button>

           <button
             className="map-mini-btn"
             onClick={() => setShowNoticeList(true)}
             title="お知らせ"
             style={{ position: 'relative' }}
           >
             ✉️
             {notices.filter(n => !readNoticeIds.includes(n.id)).length > 0 && (
               <span style={{
                 position: 'absolute',
                 top: -4,
                 right: -4,
                 width: 12,
                 height: 12,
                 background: '#ef4444',
                 borderRadius: '50%',
                 border: '2px solid rgba(26, 46, 33, 1)'
               }}></span>
             )}
           </button>

           <button
             className={`map-mini-btn ${brushToggleMode ? 'active' : ''}`}
             onClick={() => setBrushToggleMode(!brushToggleMode)}
             title={brushToggleMode ? "選択モード (確認なし)" : "通常モード"}
           >
             {brushToggleMode ? '🪥' : '🖊️'}
           </button>
        </div>

        {/* マップオプションカード */}
        {showMapOptionsCard && (
          <>
            {/* 透明オーバーレイ：外部クリックで閉じる */}
            <div
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 1999
              }}
              onClick={() => setShowMapOptionsCard(false)}
            />
             <div className="map-options-card" style={{ zIndex: 2000 }}>
               <h4>マップ表示設定</h4>

              <div
                className={`premium-toggle ${showFactionNames ? 'active' : ''}`}
                onClick={() => {
                  const next = !showFactionNames;
                  setShowFactionNames(next);
                  localStorage.setItem('teien_show_faction_names', JSON.stringify(next));
                }}
              >
                <span className="premium-toggle-label">勢力・同盟名を表示</span>
                <div className="premium-toggle-switch">
                  <div className="premium-toggle-knob"></div>
                </div>
              </div>

               <div style={{ padding: '0 16px', marginBottom: '16px' }}>
                 <label style={{ display: 'block', marginBottom: '8px', color: '#ccc', fontSize: '14px' }}>表示モード</label>
                 <div className="custom-select-wrapper">
                    <select
                        value={mapColorMode}
                        onChange={(e) => setMapColorMode(e.target.value)}
                        className="custom-select-dropdown"
                        style={{
                            width: '100%',
                            padding: '10px',
                            background: '#2a2a40',
                            border: '1px solid #444',
                            borderRadius: '8px',
                            color: '#fff',
                            fontSize: '16px',
                            outline: 'none',
                            cursor: 'pointer',
                            appearance: 'none', // Remove default arrow
                        }}
                    >
                        <option value="faction">勢力単位 (Faction)</option>
                        <option value="alliance">同盟単位 (Alliance)</option>
                        <option value="player">プレイヤー単位 (Player)</option>
                        <option value="overpaint">塗装数 (Density)</option>
                    </select>
                </div>
               </div>

              <div
                className={`premium-toggle ${showSpecialBorder ? 'active' : ''}`}
                onClick={() => {
                  const next = !showSpecialBorder;
                  setShowSpecialBorder(next);
                  localStorage.setItem('teien_show_special_border', JSON.stringify(next));
                }}
              >
                <span className="premium-toggle-label">特別タイル枠を表示</span>
                <div className="premium-toggle-switch">
                  <div className="premium-toggle-knob"></div>
                </div>
              </div>

              <div
                className={`premium-toggle ${showLeaderboard ? 'active' : ''}`}
                onClick={() => {
                  const next = !showLeaderboard;
                  setShowLeaderboard(next);
                  localStorage.setItem('teien_show_leaderboard', JSON.stringify(next));
                }}
              >
                <span className="premium-toggle-label">ランキングを表示</span>
                <div className="premium-toggle-switch">
                  <div className="premium-toggle-knob"></div>
                </div>
              </div>

               <div
                 className={`premium-toggle ${highlightCoreOnly ? 'active' : ''}`}
                 onClick={() => {
                   const next = !highlightCoreOnly;
                   setHighlightCoreOnly(next);
                   localStorage.setItem('teien_highlight_core_only', JSON.stringify(next));
                 }}
               >
                 <span className="premium-toggle-label">中核マスのみ強調</span>
                   <div className="premium-toggle-switch">
                   <div className="premium-toggle-knob"></div>
                 </div>
               </div>

               <div style={{ padding: '0 16px', marginBottom: '16px' }}>
                 <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: '#ccc', fontSize: '14px' }}>
                    空白マスの色
                    <input
                      type="color"
                      value={blankTileColor}
                      onChange={(e) => setBlankTileColor(e.target.value)}
                      style={{
                        border: 'none',
                        width: '32px',
                        height: '24px',
                        padding: 0,
                        background: 'none',
                        cursor: 'pointer'
                      }}
                    />
                 </label>
               </div>

               <div
                className={`premium-toggle ${showNamedTileNames ? 'active' : ''}`}
                onClick={() => {
                  const next = !showNamedTileNames;
                  setShowNamedTileNames(next);
                  // useEffect handles saving, but explicit save ensures sync if needed
                  // localStorage.setItem('teien_show_named_tile_names', JSON.stringify(next));
                }}
              >
                <span className="premium-toggle-label">ネームドマス名を表示</span>
                <div className="premium-toggle-switch">
                  <div className="premium-toggle-knob"></div>
                </div>
              </div>





            </div>
          </>
        )}


        {showLeaderboard && (
          <Leaderboard
              items={leaderboardItems}
              isVisible={showLeaderboard}
              onToggle={() => setShowLeaderboard(!showLeaderboard)}
              onHover={setHoveredFactionId}
              activeFactionId={hoveredFactionId}
          />
        )}

        {/* ステータスバー */}
        <div className="status-bar">
          <div className="status-item">
             <span className="status-label">参加:</span>
             <span className="status-value">{onlineUsers}人</span>
          </div>
          <div className="status-divider">|</div>
          <div className="status-item">
            <span className={`status-indicator ${connected ? 'connected' : 'disconnected'}`}></span>
            <span>{connected ? '接続中' : '切断'}</span>
          </div>
          <div className="status-divider">|</div>
          <div className="status-item">
            <span>ZL:{zoomLevel.toFixed(2)}</span>
          </div>
        </div>
      </div>

      <Sidebar
        socket={socket}
        playerData={enrichedPlayerData}
        gardenMode={authStatus.gardenMode}
        gardenAuthKey={authStatus.gardenAuthKey}
        factions={factions}
        alliances={alliances}
        wars={wars}
        truces={truces}
        mapTiles={mapTiles}
        selectedTiles={selectedTiles}
        onPaint={handlePaint}
        onErase={handleErase}
        onCreateFaction={startCreateFaction}
        onJoinFaction={handleJoinFaction}
        onLeaveFaction={handleLeaveFaction}
        onClearSelection={() => setSelectedTiles([])}
        onExportMap={handleExportMap}
        onTimelapse={() => setShowTimelapse(true)}
        onDisplayNameChange={handleDisplayNameChange}
        onFactionSettingsChange={handleFactionSettingsChange}
        onShowMemberList={handleShowMemberList}
        onOpenRoleSettings={() => setShowRoleSettingsModal(true)}
        onCreateNamedTile={handleCreateNamedTile}
        onLoadMoreLogs={loadMoreLogs} // [NEW] Pagination
        onSearchLogs={handleLogSearch} // [NEW] Server-side Search
        activityLog={activityLog}
        notices={notices}
        onShowNotice={handleShowNotice}
        onTransferKing={handleTransferKing}
        onMergeRequest={handleMergeRequest}
        onMergeCancel={handleMergeCancel}
        onAllianceRequest={handleAllianceRequest}
        onAllianceBreak={handleAllianceBreak}
        mergeRequest={pendingMergeRequest}
        onMergeRespond={handleMergeRespond}
        allianceRequest={pendingAllianceRequest}
        onAllianceRespond={handleAllianceRespond}


        isMergeEnabled={authStatus.isMergeEnabled ?? true}
        apSettings={authStatus.apSettings} // [NEW] 設定渡し
        gardenRefillCost={authStatus.gardenRefillCost || 30}
        gardenRefillAmount={authStatus.gardenRefillAmount || 50}
        className={isSidebarOpen ? 'open' : ''}
        onClose={() => setIsSidebarOpen(false)}
        onJumpTo={handleJumpTo}
        onAutoSelect={handleAutoSelect}
        namedCells={namedCells}
        showNamedTileNames={showNamedTileNames}
        onToggleNamedTileNames={() => setShowNamedTileNames(prev => !prev)}
        // Season 2 Props
        onOpenAlliancePanel={() => setShowAlliancePanel(true)}
        brushToggleMode={brushToggleMode}
        onToggleBrushMode={() => setBrushToggleMode(p => !p)}
        allianceDisplayMode={allianceDisplayMode}
        onToggleAllianceDisplay={() => setAllianceDisplayMode(p => !p)}
        factionSortBy={factionSortBy}
        onSetFactionSortBy={setFactionSortBy}
        onDonateAP={handleDonateAP}
        onToggleAutoSharedAp={handleToggleAutoSharedApAction}
        onJoinPolicyChange={handleJoinPolicyChange}
        isPopupOpen={!!tilePopup}
        skipConfirmation={skipConfirmation}
        onToggleSkipConfirmation={handleToggleSkipConfirmation}
        trucesData={{ truces }}
        warsData={wars}
        overpaintTargetCount={overpaintTargetCount}
        onSetOverpaintTargetCount={setOverpaintTargetCount}
        onRenameNamedTile={handleRenameNamedTile}
        onDeleteNamedTile={handleDeleteNamedTile}
        onOpenAccountSettings={() => setShowAccountModal(true)}
        onLoginClick={() => setShowAuthModal(true)}
      />

      {mapLoading && (
        <LoadingOverlay
          progress={mapLoadProgress}
          total={mapLoadTotal}
          message={mapLoadMessage}
        />
      )}




      {showCreateFaction && pendingOrigin && (
        <CreateFactionModal
          origin={pendingOrigin}
          onClose={() => {
            setShowCreateFaction(false);
            setPendingOrigin(null);
          }}
          onCreated={handleFactionCreated}
        />
      )}



      {/* 同盟/外交/停戦パネル */}
      {showAlliancePanel && (
          <AlliancePanel
              playerData={enrichedPlayerData}
              factions={factions}
              alliances={alliances}
              truces={truces}
              wars={wars}
              onClose={() => setShowAlliancePanel(false)}
              onCreateAlliance={handleCreateAlliance}
              onJoinRequest={handleAllianceJoinRequest}
              onAcceptRequest={handleAllianceAcceptRequest}
              onLeaveAlliance={handleAllianceLeave}
              onKickMember={handleAllianceKick}
              onDisbandAlliance={handleAllianceDisband}
              onRequestTruce={handleTruceRequest}
              onAcceptTruce={handleTruceAccept}
              onRejectTruce={handleTruceReject}
            onCallToArms={handleCallToArms}
            onShowFactionDetails={setShowMemberFactionId}
          />
      )}

      {showRoleSettingsModal && enrichedPlayerData?.factionId && (
          <RoleSettingsModal
              factionId={enrichedPlayerData.factionId}
              roles={factions[enrichedPlayerData.factionId]?.roles || []}
              memberRoles={factions[enrichedPlayerData.factionId]?.memberRoles || {}}
              onCreateRole={handleCreateRole}
              onUpdateRole={handleUpdateRole}
              onDeleteRole={handleDeleteRole}
              kingRoleName={factions[enrichedPlayerData.factionId]?.kingRoleName || '勢力主'}
              onUpdateKingRole={async (name) => {
                  try {
                      const res = await fetch(`/api/factions/${enrichedPlayerData.factionId}/king-role`, {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ name })
                      });
                      const data = await res.json();
                      if (data.error) throw new Error(data.error);
                      return data;
                  } catch (e) {
                      console.error(e);
                      throw e;
                  }
              }}
              members={factions[enrichedPlayerData.factionId]?.members || []}
              onAssignRole={handleAssignRole}
              currentPlayerId={enrichedPlayerData.id}
              onClose={() => setShowRoleSettingsModal(false)}
          />
      )}

      {joiningFaction && (
        <div className="modal-overlay" onClick={() => setJoiningFaction(null)}>
          <div className="join-faction-card" onClick={e => e.stopPropagation()}>
            <h3>勢力に参加しますか？</h3>
            <p className="auth-message">この勢力の陣地を拡大できるようになります。</p>
            <div className="faction-preview">
              <div className="faction-color" style={{ background: joiningFaction.color }}></div>
              <span className="faction-name">{joiningFaction.name}</span>
            </div>
            <div className="actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  handleJoinFaction(joiningFaction.id);
                  setJoiningFaction(null);
                }}
              >
                {joiningFaction.joinPolicy === 'approval' ? '加入申請を送る' : '参加する'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setJoiningFaction(null)}
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 勢力詳細ポップアップ (New Component) */}
      {showMemberFactionId && (
        <FactionDetailsModal
            factionId={showMemberFactionId}
            factions={factions}
            playerData={enrichedPlayerData}
            alliances={alliances}
            truces={truces}
            wars={wars}
            onClose={() => setShowMemberFactionId(null)}
            onJoinFaction={handleJoinFaction}
            onKickMember={(pid) => {
                if(window.confirm('本当にこのメンバーを追放しますか？')) {
                    handleKickMember(showMemberFactionId, pid);
                }
            }}
            onAllianceRequest={async (targetFid) => {
                const f = factions[targetFid];
                if (window.confirm(`${f.name} に同盟を申し込みますか？`)) {
                    await handleAllianceRequest(targetFid);
                }
            }}
            onTruceRequest={async (targetFid, expiresAt) => {
               const f = factions[targetFid];
               const msg = expiresAt ? `\n期限: ${new Date(expiresAt).toLocaleString()} まで` : '';
               if (window.confirm(`${f.name} に停戦を申し込みますか？${msg}`)) {
                   await handleTruceRequest(targetFid, expiresAt);
               }
            }}
            onSendMessage={handleSendFactionMessage}
            onAllianceInvite={async (targetFid) => {
                const f = factions[targetFid];
                const myAllianceName = alliances[factions[playerData.factionId]?.allianceId]?.name || '自同盟';
                if (window.confirm(`${f.name} をあなたの同盟「${myAllianceName}」に招待しますか？`)) {
                    await handleAllianceRequest(targetFid);
                }
            }}
        />
      )}



      {showTimelapse && (
        <TimelapseViewer
          factions={factions}
          onClose={() => setShowTimelapse(false)}
          showFactionNames={showFactionNames}
          allianceDisplayMode={allianceDisplayMode}
          workerPool={mapWorkerPool}
        />
      )}

      {/* お知らせリストモーダル */}
      {showNoticeList && (
        <NoticeModal
          notices={notices}
          readNoticeIds={readNoticeIds}
          onClose={() => setShowNoticeList(false)}
          onMarkAllRead={handleMarkAllNoticesRead}
          onShowDetail={(notice) => {
            handleShowNotice(notice);
            setShowNoticeList(false);
          }}
        />
      )}

      {/* お知らせポップアップ */}
      {showNoticePopup && (
        <NoticePopup
          notice={activeNotice}
          onAction={handleNoticeAction}
          onClose={() => {
            if (activeNotice) {
                markNoticeAsRead(activeNotice.id); // 閉じたタイミングで既読
            }
            setShowNoticePopup(false);
            if (activeNotice && notices.length > 0 && activeNotice.id === notices[0].id) {
              localStorage.setItem('teien_last_seen_notice_id', activeNotice.id);
            }
          }}
          onAccept={
            (() => {
              const noticeText = (activeNotice?.title || "") + (activeNotice?.content || "");
              if (noticeText.includes("同盟加入申請が届きました") || noticeText.includes("同盟要請が届きました")) {
                return () => {
                   const reqs = factions[playerData?.factionId]?.allianceRequests || [];
                   const req = reqs[0];
                   const rid = activeNotice?.data?.requesterFactionId || pendingAllianceRequest?.requesterFactionId || (typeof req === 'string' ? req : req?.id);

                   // Check if request exists in live data
                   const exists = reqs.some(r => (typeof r === 'string' ? r : r.id) === rid);
                   if (!exists) {
                       alert("この申請は既に処理されているか、無効になっています。");
                       return;
                   }

                   if (!window.confirm("この勢力からの同盟加入申請（または要請）を承認しますか？")) return;

                   console.log("Notice Accept (Alliance): rid =", rid);
                   if (rid) {
                     handleAllianceRespond(rid, true);
                   } else {
                     alert("要請の詳細が見つかりません。");
                   }
                };
              }
              if (noticeText.includes("併合要請が届きました")) {
                return () => {
                   const reqs = factions[playerData?.factionId]?.mergeRequests || [];
                   const req = reqs[0];
                   const rid = activeNotice?.data?.requesterFactionId || pendingMergeRequest?.requesterFactionId || (typeof req === 'string' ? req : req?.id);

                   // Check if request exists in live data
                   const exists = reqs.some(r => (typeof r === 'string' ? r : r.id) === rid);
                   if (!exists) {
                       alert("この申請は既に処理されているか、無効になっています。");
                       return;
                   }

                   if (!window.confirm("【重要】本当に併合（吸収）を承認しますか？\n承認すると相手の勢力は消滅し、全ての領土とメンバーがあなたの勢力に吸収されます。この操作は取り消せません。")) return;

                   console.log("Notice Accept (Merge): rid =", rid);
                   if (rid) {
                     handleMergeRespond(rid, true);
                   } else {
                     alert("要請の詳細が見つかりません。");
                   }
                };
              }
              if (noticeText.includes("停戦要請が届きました")) {
                return () => {
                   const rid = activeNotice?.data?.requesterFactionId;
                   const reqs = factions[playerData?.factionId]?.truceRequestsReceived || [];

                   // Check if request exists in live data
                   const exists = reqs.some(r => (typeof r === 'string' ? r : r.id) === rid);
                   if (!exists) {
                       alert("この申請は既に処理されているか、無効になっています。");
                       return;
                   }

                   if (!window.confirm("この勢力からの停戦要請を承認しますか？")) return;

                   console.log("Notice Accept (Truce): rid =", rid);
                   if (rid) {
                     handleTruceAccept(rid);
                   } else {
                     alert("要請の詳細が見つかりません。");
                   }
                };
              }
              // 領土割譲の提案
              if (noticeText.includes("領土割譲の提案") || activeNotice?.title === "領土割譲の提案") {
                return () => {
                   if (!window.confirm("この領土割譲の提案を承認しますか？")) return;
                  const requestId = activeNotice?.options?.requestId;
                  console.log("Notice Accept (Cession): requestId =", requestId);
                  if (requestId) {
                    fetch('/api/tiles/cede/respond', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      credentials: 'include',
                      body: JSON.stringify({ requestId, accept: true })
                    })
                    .then(res => res.json())
                    .then(data => {
                      if (data.success) {
                        alert('領土割譲を承認しました');
                      } else {
                        alert(data.error || 'エラーが発生しました');
                      }
                    })
                    .catch(() => alert('通信エラー'));
                  } else {
                    alert("要請の詳細が見つかりません。");
                  }
                };
              }
              if (noticeText.includes("参戦提案") || activeNotice?.title === "参戦提案") {
                return () => {
                   if (!window.confirm("この戦争への参戦要請を承認しますか？")) return;
                  const warId = activeNotice?.options?.warId;
                  const side = activeNotice?.options?.side;
                  console.log("Notice Accept (War Participation): warId =", warId, "side =", side);
                  if (warId && side) {
                    fetch('/api/alliances/accept-participation', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      credentials: 'include',
                      body: JSON.stringify({ warId, side, accept: true })
                    })
                    .then(res => res.json())
                    .then(data => {
                      if (data.success) {
                        addNotification("戦争に参戦しました", "参戦完了");
                      } else {
                        addNotification(data.error || '参戦に失敗しました', "エラー");
                      }
                    })
                    .catch(() => addNotification('通信エラーが発生しました', "エラー"));
                  } else {
                    alert("要請の詳細が見つかりません。");
                  }
                };
              }
              return null;
            })()
          }
          onReject={
            (() => {
              const noticeText = (activeNotice?.title || "") + (activeNotice?.content || "");
              if (noticeText.includes("同盟加入申請が届きました") || noticeText.includes("同盟要請が届きました")) {
                return () => {
                   const reqs = factions[playerData?.factionId]?.allianceRequests || [];
                   const req = reqs[0];
                   const rid = activeNotice?.data?.requesterFactionId || pendingAllianceRequest?.requesterFactionId || (typeof req === 'string' ? req : req?.id);

                   // Check if request exists in live data
                   const exists = reqs.some(r => (typeof r === 'string' ? r : r.id) === rid);
                   if (!exists) {
                        alert("この申請は既に処理されているか、無効になっています。");
                        return;
                   }

                   if (!window.confirm("同盟加入申請を拒否しますか？")) return;
                   if (rid) handleAllianceRespond(rid, false);
                };
              }
              if (noticeText.includes("参戦提案") || activeNotice?.title === "参戦提案") {
                return () => {
                    const warId = activeNotice?.options?.warId;
                    const side = activeNotice?.options?.side;
                    const requesterId = activeNotice?.options?.requesterId;

                    // 戦争の場合は、戦争自体が終わっているか、自分が既に参加しているかを確認する
                    // (データ構造が複雑なため、ここではサーバーの応答に任せるか、warsステートが利用可能ならチェックする)
                    // ここでは簡易的に、warIdが存在するかだけチェック
                    if (wars && warId && !wars[warId]) {
                         alert("この戦争は既に終了しているか、無効です。");
                         return;
                    }

                   if (!window.confirm("この戦争への参戦要請を拒否しますか？")) return;

                  if (warId && side) {
                    fetch('/api/alliances/accept-participation', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      credentials: 'include',
                      body: JSON.stringify({ warId, side, accept: false, requesterId })
                    })
                    .then(res => res.json())
                    .then(data => {
                      if (data.success) {
                        addNotification("参戦要請を拒否しました", "拒否完了");
                      }
                    });
                  }
                };
              }
              if (noticeText.includes("併合要請が届きました")) {
                return () => {
                   const reqs = factions[playerData?.factionId]?.mergeRequests || [];
                   const req = reqs[0];
                   const rid = activeNotice?.data?.requesterFactionId || pendingMergeRequest?.requesterFactionId || (typeof req === 'string' ? req : req?.id);

                   // Check if request exists in live data
                   const exists = reqs.some(r => (typeof r === 'string' ? r : r.id) === rid);
                   if (!exists) {
                       alert("この申請は既に処理されているか、無効になっています。");
                       return;
                   }

                   if (!window.confirm("併合要請を拒否しますか？")) return;
                   if (rid) handleMergeRespond(rid, false);
                };
              }
              if (noticeText.includes("停戦要請が届きました")) {
                return () => {
                   const rid = activeNotice?.data?.requesterFactionId;
                   const reqs = factions[playerData?.factionId]?.truceRequestsReceived || [];

                   // Check if request exists in live data
                   const exists = reqs.some(r => (typeof r === 'string' ? r : r.id) === rid);
                   if (!exists) {
                       alert("この申請は既に処理されているか、無効になっています。");
                       return;
                   }

                   if (!window.confirm("停戦要請を拒否しますか？")) return;
                   if (rid) handleTruceReject(rid);
                };
              }
              // 領土割譲の提案
              if (noticeText.includes("領土割譲の提案") || activeNotice?.title === "領土割譲の提案") {
                return () => {
                  if (!window.confirm("この領土割譲の提案を拒否しますか？")) return;
                  const requestId = activeNotice?.options?.requestId;
                  console.log("Notice Reject (Cession): requestId =", requestId);
                  if (requestId) {
                    fetch('/api/tiles/cede/respond', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      credentials: 'include',
                      body: JSON.stringify({ requestId, accept: false })
                    })
                    .then(res => res.json())
                    .then(data => {
                      if (data.success !== undefined) {
                        alert('領土割譲を拒否しました');
                      } else {
                        alert(data.error || 'エラーが発生しました');
                      }
                    })
                    .catch(() => alert('通信エラー'));
                  } else {
                    alert("要請の詳細が見つかりません。");
                  }
                };
              }
              return null;
            })()
          }
        />
      )}



      {showAuthModal && (
        <AuthModal
          onClose={() => setShowAuthModal(false)}
          onAuth={() => window.location.reload()}
        />
      )}
      {showAccountModal && (
        <AccountModal
          playerData={playerData}
          gardenMode={authStatus.gardenMode}
          gardenAuthKey={authStatus.gardenAuthKey}
          onClose={() => setShowAccountModal(false)}
          onAuthUpdate={() => {
            // Re-fetch status to update player data globally
            fetch('/api/auth/status', { credentials: 'include' })
              .then(res => res.json())
              .then(data => {
                if (data.player) setPlayerData(data.player);
              });
          }}
        />
      )}
    </div>
  );
}

export default App;
