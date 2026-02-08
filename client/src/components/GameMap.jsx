import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMultiRenderWorker } from '../hooks/useMultiRenderWorker';

// マップ定数
const MAP_SIZE = 500;
const TILE_SIZE = 16;
const VIEWPORT_PADDING = 50;
// 特別タイル: 中央50×50 (225～274)
const SPECIAL_TILE_MIN = 225;
const SPECIAL_TILE_MAX = 274;
const MAX_POINTS = 10;
const MIN_POINTS = 1;
const GRADIENT_STEP = 5;
const NAMED_CELL_BONUS = 20;

const isSpecialTile = (x, y) => x >= SPECIAL_TILE_MIN && x <= SPECIAL_TILE_MAX && y >= SPECIAL_TILE_MIN && y <= SPECIAL_TILE_MAX;

// グラデーションポイント計算
const getTilePoints = (x, y, namedCells = null) => {
  let basePoints;

  if (isSpecialTile(x, y)) {
    basePoints = MAX_POINTS;
  } else {
    const distX = x < SPECIAL_TILE_MIN ? SPECIAL_TILE_MIN - x : x > SPECIAL_TILE_MAX ? x - SPECIAL_TILE_MAX : 0;
    const distY = y < SPECIAL_TILE_MIN ? SPECIAL_TILE_MIN - y : y > SPECIAL_TILE_MAX ? y - SPECIAL_TILE_MAX : 0;
    const distance = Math.max(distX, distY);
    const reduction = Math.floor(distance / GRADIENT_STEP);
    basePoints = Math.max(MIN_POINTS, 9 - reduction);
  }

  // ネームドセルボーナス
  if (namedCells) {
    const key = `${x}_${y}`;
    if (namedCells[key]) {
      basePoints += NAMED_CELL_BONUS;
    }
  }

  return basePoints;
};

// クライアント側支配チェック
const checkClientDomination = (cx, cy, level, factionId, getTileFunc) => {
    const radius = level;
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
             const tx = cx + dx;
             const ty = cy + dy;
             if (tx < 0 || tx >= MAP_SIZE || ty < 0 || ty >= MAP_SIZE) return false;
             const t = getTileFunc(tx, ty);
             if (!t || (t.factionId || t.faction) !== factionId) return false;
        }
    }
    return true;
};

function GameMap({
  tileData, // [NEW] SharedArrayBuffer based data
  factions,
  selectedTiles,
  onTileClick,
  playerFactionId,
  showTooltip = true,
  mapJumpCoord,
  // Season 2 props
  alliances = {},
  onNamedCellClick = null,
  onManageNamedTile = null,
  showFactionNames = true,
  showAllianceNames = true,
  namedCells = {},
  brushToggleMode = false,
  allianceDisplayMode = false,
  onShowFactionDetails = null,
  showSpecialBorder = true,
  highlightCoreOnly = false,
  showNamedTileNames = true, // Added defaulting to true
  hoverFactionId = null,
  onHoverFactionChange = null,
  skipConfirmation, // New prop
  tilePopup,
  setTilePopup,
  playerData,
  mapColorMode = 'faction', // New Prop (replaced playerColorMode/allianceDisplayMode)
  blankTileColor = '#ffffff',
  playerNames = {}, // [NEW]
  onZoomChange = null, // [NEW] ズームレベル変更コールバック
  workerPool = null, // [NEW] 共有WorkerPoolを受け取る
  version,
}) {


  const baseCanvasRef = useRef(null); // Used for compatibility, points to first layer
  const overlayCanvasRef = useRef(null);
  const canvasContainerRef = useRef(null); // [NEW] Container for multi-layers
  const canvasRef = overlayCanvasRef; // 互換性のため

  const [viewport, setViewport] = useState(() => {
    try {
      const saved = localStorage.getItem('teien_map_viewport');
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
             ...parsed,
             zoom: Math.max(0.1, parsed.zoom)
        };
      }
      return { x: 125, y: 125, zoom: 4 };
    } catch (e) {
      return { x: 125, y: 125, zoom: 4 };
    }
  });
  const [canvasDimensions, setCanvasDimensions] = useState({ width: 0, height: 0 });

  // [NEW] Map Version for Worker Cache Optimization
  // Hash calculation in worker is O(N), so we use a version number O(1)
  const mapVersion = version;

  // [NEW] SharedArrayBufferからタイル情報を読み取るヘルパー
  // DataViewをキャッシュしてGCを抑制
  const sabView = useMemo(() => {
      if (tileData && tileData.sab) return new DataView(tileData.sab);
      return null;
  }, [tileData]);

  // 高速なFactionID取得 (オブジェクト生成なし)
  const getFactionIdRaw = useCallback((x, y) => {
    if (!sabView) return null;
    if (x < 0 || x >= MAP_SIZE || y < 0 || y >= MAP_SIZE) return null; // MAP_SIZE constant
    const offset = (y * MAP_SIZE + x) * 24;
    const fidIdx = sabView.getUint16(offset + 0, true);
    return fidIdx === 65535 ? null : (tileData.factionsList ? tileData.factionsList[fidIdx] : null);
  }, [sabView, tileData]);

  const getTile = useCallback((x, y) => {
    if (!sabView) return null;
    if (x < 0 || x >= MAP_SIZE || y < 0 || y >= MAP_SIZE) return null;

    const offset = (y * MAP_SIZE + x) * 24; // TILE_BYTE_SIZE = 24

    const fidIdx = sabView.getUint16(offset + 0, true);
    const colorInt = sabView.getUint32(offset + 2, true);
    const paintedByIdx = sabView.getUint32(offset + 6, true);
    const overpaint = sabView.getUint8(offset + 10);
    const flags = sabView.getUint8(offset + 11);
    // offset 12-19 float64
    const exp = sabView.getFloat64(offset + 12, true); // [FIX] Offset 12
    const pAtSec = sabView.getUint32(offset + 20, true);

    const factionId = fidIdx === 65535 ? null : (tileData.factionsList ? tileData.factionsList[fidIdx] : null);
    const color = factionId ? `#${colorInt.toString(16).padStart(6, "0")}` : (blankTileColor || "#ffffff");
    const paintedBy = paintedByIdx === 0 ? null : (tileData.playersList ? tileData.playersList[paintedByIdx - 1] : null);

    const tile = {
      x, y, factionId, faction: factionId, color, paintedBy, overpaint
    };

    const safeISOString = (ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
      try {
        return new Date(ms).toISOString();
      } catch (e) {
        return null;
      }
    };

    if (flags & 1) {
      tile.core = { factionId, expiresAt: safeISOString(exp) };
    }
    if (flags & 2) {
      tile.coreificationUntil = safeISOString(exp);
      tile.coreificationFactionId = factionId;
    }

    return tile;
  }, [sabView, tileData, blankTileColor]);

  // [NEW] Multi-Threaded Render Worker Hook
  // Debounce tile updates to avoid excessive transfers
  const [debouncedTileData, setDebouncedTileData] = useState(tileData);
  useEffect(() => {
     setDebouncedTileData(tileData);
     // setMapVersion(v => v + 1); // useWorldStateのversionを使用
  }, [tileData]);

  const {
      initWorkers,
      updateTiles: updateWorkerTiles,
      resize: resizeWorker,
      render: renderAllWorkers,
      workerReady,
      workerCount
  } = useMultiRenderWorker(
      debouncedTileData,
      factions,
      alliances,
      playerNames,
      {
          blankTileColor,
          highlightCoreOnly,
          mapColorMode,
          mapVersion // Pass version to worker
      }
  );

  // Canvas Refs for multi-layer are managed inside container
  // Double Buffering is handled inside useMultiRenderWorker

  // Initialize Canvases and Workers
  useEffect(() => {
      if (!canvasContainerRef.current) return;
      if (workerReady) return;

      console.log(`[GameMap] Initializing ${workerCount} layers with true double buffering`);

      // initWorkersにコンテナを渡す（キャンバス作成はhook内部で行う）
      initWorkers(canvasContainerRef.current);

  }, [initWorkers, workerCount, workerReady]);

  // Update Tiles when data changes
  // Update Tiles when data changes
  useEffect(() => {
     if (!workerReady) return;

     // Trigger worker update
     updateWorkerTiles(debouncedTileData, true);

     // [FIX] データ更新後、即座に再描画をリクエスト
     const { width, height } = canvasDimensions;
     if (width > 0 && height > 0) {
         // スロットリングを無視して強制描画したいが、render関数はスロットリングされている。
         // しかし、ユーザー操作によるデータ更新なので、スロットリングされても数ms後には描画されるはず。
         // 念のため少し遅延させるか、そのまま呼ぶ。
         renderAllWorkers(viewport, width, height);
     }
  }, [debouncedTileData, updateWorkerTiles, workerReady, renderAllWorkers, viewport, canvasDimensions]);

  // Helper refs
  const isZoomingRef = useRef(false);
  const zoomTimeoutRef = useRef(null);
  const lastRenderTimeRef = useRef(0);
  const renderReqRef = useRef(null);
  const viewportRef = useRef(viewport);
  const wheelTimeoutRef = useRef(null);


  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  // [NEW] Trigger Worker Rendering on viewport/canvas changes
  useEffect(() => {
    if (!workerReady) return;

    const { width, height } = canvasDimensions;
    if (width === 0 || height === 0) return;

    // Throttle rendering
    const now = performance.now();
    if (now - lastRenderTimeRef.current < 8) return; // ~120fps cap
    lastRenderTimeRef.current = now;

    renderAllWorkers(viewport, width, height);
  }, [viewport, canvasDimensions, workerReady, renderAllWorkers]);

  // ... (zoom logic)

  // プレイヤーカラー生成 (名前のハッシュ)
  const playerColors = useMemo(() => {
    const colors = {};
    if (mapColorMode !== 'player') return colors;

    // [NEW] Use playerNames prop instead of scanning tiles
    if (playerNames) {
        Object.keys(playerNames).forEach(pid => {
            let hash = 0;
            const pname = playerNames[pid] || "Unknown";
            for (let i = 0; i < pname.length; i++) {
                hash = pname.charCodeAt(i) + ((hash << 5) - hash);
            }
            const c = (hash & 0x00ffffff).toString(16).toUpperCase();
            colors[pid] = "#" + "00000".substring(0, 6 - c.length) + c;
        });
    }
    return colors;
  }, [playerNames, mapColorMode]);

  // 事前に検索用Setを作成 (O(1) lookup) - Top level
  const selectedKeys = useMemo(() => {
      const set = new Set();
      selectedTiles.forEach(t => set.add(`${t.x}_${t.y}`));
      return set;
  }, [selectedTiles]);

  // ツールチップ位置追跡用
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  // viewportが変わったら保存
  useEffect(() => {
    localStorage.setItem('teien_map_viewport', JSON.stringify(viewport));
  }, [viewport]);

  // ズームレベル変更時にコールバック
  useEffect(() => {
    if (onZoomChange) {
      onZoomChange(viewport.zoom);
    }
  }, [viewport.zoom, onZoomChange]);

  // 外部からのジャンプ要求を監視
  useEffect(() => {
    if (mapJumpCoord) {
      setViewport(prev => ({ ...prev, x: mapJumpCoord.x, y: mapJumpCoord.y }));
    }
  }, [mapJumpCoord]);

  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });  // Ref化して同期的アクセスを保証
  const clickStart = useRef({ x: 0, y: 0 }); // Ref化して同期的アクセスを保証
  const [hoverTile, setHoverTile] = useState(null);
  const lastSelectedRef = useRef(null); // ブラシモード中の重複選択防止
  const labelRegionsRef = useRef([]); // ラベル領域保存用Ref



  // ピンチズーム・誤操作防止用State
  const touchState = useRef({
    mode: 'none',   // 'none', 'drag', 'pinch'
    startDist: 0,
    startZoom: 1,
    wasPinching: false, // 一度でもピンチ操作が入ったらクリック無効
    lastPinchCenter: null
  });

  const getDistance = (p1, p2) => {
    return Math.sqrt(Math.pow(p1.clientX - p2.clientX, 2) + Math.pow(p1.clientY - p2.clientY, 2));
  };

  // 勢力の中心点（重心）を計算 - Worker Pool使用
  // const { calculateClusters, calculateEdges } = useMapWorkerPool(); // Removed
  const calculateClusters = workerPool ? workerPool.calculateClusters : null;
  const calculateEdges = workerPool ? workerPool.calculateEdges : null;

  // Worker関数の参照を保持して不要な再計算を防ぐ (念のため)
  const calculateClustersRef = useRef(calculateClusters);
  useEffect(() => { calculateClustersRef.current = calculateClusters; }, [calculateClusters]);

  const [factionCenters, setFactionCenters] = useState({});

  useEffect(() => {
    // タイルデータが空なら計算しない
    if (!tileData || !tileData.sab) return;

    let isMounted = true;

    if (typeof calculateClustersRef.current !== 'function') return;

    // [OPTIMIZED] Pass mapVersion to avoid hashing in worker
    calculateClustersRef.current(tileData, mapVersion)
      .then(clusterMap => {
        if (!isMounted) return;

        const centers = {};
        Object.entries(clusterMap).forEach(([fid, clusters]) => {
          const coreClusters = clusters.filter(c => c.hasCore);
          let targetCluster = null;

          if (coreClusters.length > 0) {
            targetCluster = coreClusters.reduce((prev, curr) => (curr.count > prev.count ? curr : prev), coreClusters[0]);
          } else if (clusters.length > 0) {
            targetCluster = clusters.reduce((prev, curr) => (curr.count > prev.count ? curr : prev), clusters[0]);
          }

          if (targetCluster) {
            centers[fid] = {
              x: targetCluster.x,
              y: targetCluster.y,
              count: targetCluster.count
            };
          }
        });

        setFactionCenters(centers);
      })
      .catch(err => {
        console.error("Worker calculation failed:", err);
      });

    return () => { isMounted = false; };
  }, [tileData, mapVersion]);

  // LOD描画用: チャンク単位の代表色を差分更新で計算
  // 変更があったチャンクのみ再計算し、リアルタイム更新時の負荷を軽減
  // [REMOVED] LOD logic removed per user request



  // 点滅アニメーション用
  const [blinkAlpha, setBlinkAlpha] = useState(1);
  const [tapHighlight, setTapHighlight] = useState(null); // タップした瞬間の一時的なハイライト用

  // ハイライト対象の計算 (メモ化)
  const activeFactionId = useMemo(() => {
    if (hoverFactionId) return hoverFactionId;
    if (tilePopup) {
      const t = getTile(tilePopup.x, tilePopup.y);
      if (t) return t.factionId || t.faction;
    }
    return null;
  }, [hoverFactionId, tilePopup, getTile]);

  // ハイライト対象勢力の境界線（エッジ）をWorkerで非同期計算
  const [activeFactionEdges, setActiveFactionEdges] = useState([]);

  useEffect(() => {
    if (!activeFactionId || mapColorMode === 'alliance') {
      setActiveFactionEdges([]);
      return;
    }

    let isMounted = true;

    // [OPTIMIZED] Pass SharedArrayBuffer to Edge Calculation if needed,
    // or use getTile based loop in worker (which we already updated in mapWorker)
    calculateEdges(tileData, activeFactionId, mapVersion)
      .then(edges => {
        if (isMounted) {
          setActiveFactionEdges(edges);
        }
      })
      .catch(err => {
        console.error("Worker edge calculation failed:", err);
        setActiveFactionEdges([]);
      });

    return () => { isMounted = false; };
  }, [activeFactionId, tileData, mapColorMode, calculateEdges, mapVersion]);

  useEffect(() => {
      let rafId;
      // アニメーション条件: 特定勢力ホバー中 OR ポップアップ表示中 OR タップハイライト中
      if (activeFactionId || tapHighlight) {
          const animate = () => {
              const alpha = 0.5 + 0.5 * Math.sin(Date.now() / 150);
              setBlinkAlpha(alpha);
              rafId = requestAnimationFrame(animate);
          };
          animate();
      } else {
          setBlinkAlpha(1);
      }
      return () => {
          if (rafId) cancelAnimationFrame(rafId);
      };
  }, [activeFactionId, tapHighlight]);

  // tilePopupのスタイル計算 (スマート配置)
  const popupStyle = useMemo(() => {
    if (!tilePopup) return {};

    // モバイル表示 (768px未満)
    if (window.innerWidth < 768) {
        // 画面の高さ
        const h = window.innerHeight;
        // タップ位置 (screenY) が画面中央より下なら、ポップアップは上に。上なら下に。
        const isBottomHalf = tilePopup.screenY > h / 2;

        // ベーススタイル
        const style = {
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)', // 横は中央寄せ
            width: '90%', // 幅広に
            maxWidth: '350px',
            zIndex: 100 // 前面に
        };

        if (isBottomHalf) {
            // タップ位置より上に表示 (Bottom配置)
            style.bottom = `${h - tilePopup.screenY + 20}px`;
            style.top = 'auto';
        } else {
            // タップ位置より下に表示 (Top配置)
            style.top = `${tilePopup.screenY + 20}px`;
            style.bottom = 'auto';
        }
        return style;
    }

    // PC表示: スマート配置 (可変高さ対応)
    const h = window.innerHeight;
    const spaceBelow = h - tilePopup.screenY;
    const spaceAbove = tilePopup.screenY;

    // 下のスペースが狭い(450px未満)場合は上に表示
    // ただし、上のスペースの方が狭い場合は、広い方を選ぶ
    const showAbove = spaceBelow < 450 && spaceAbove > spaceBelow;

    // X軸: 基本は右、はみ出るなら左
    const cardWidth = 320;
    let left = tilePopup.screenX + 20;
    if (left + cardWidth > window.innerWidth) {
        left = tilePopup.screenX - cardWidth - 20;
    }
    // 左端ガード
    if (left < 10) left = 10;

    const style = {
        position: 'absolute',
        left: `${left}px`,
        zIndex: 10000,
        width: 'auto',
        maxWidth: '350px',
        overflowY: 'auto',
    };

    if (showAbove) {
        // 上に表示 (Bottom基準)
        // bottom = 下からの距離 = spaceBelow + マージン
        style.bottom = `${spaceBelow + 10}px`;
        style.top = 'auto';
        // Max height is space above - margin
        style.maxHeight = `${spaceAbove - 30}px`;
    } else {
        // 下に表示 (Top基準)
        style.top = `${tilePopup.screenY + 20}px`;
        style.bottom = 'auto';
        // Max height is space below - margin
        style.maxHeight = `${spaceBelow - 30}px`;
    }

    return style;

    return style;
  }, [tilePopup]);

  // 1. ベースレイヤー描画 (背景 + タイル) - 重い処理
  // [OPTIMIZED] requestAnimationFrameベースのスロットリングで連続ズーム時のカクつきを防止


  // 2. オーバーレイ描画 (ハイライト、文字、枠線) - 軽い処理 (60fps対応)
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    const tileSize = TILE_SIZE * viewport.zoom;
    const centerX = width / 2;
    const centerY = height / 2;
    const showGrid = viewport.zoom > 1.0;

    // クリア
    ctx.clearRect(0, 0, width, height);

    // 表示範囲計算
    const tilesX = Math.ceil(width / tileSize) + 2;
    const tilesY = Math.ceil(height / tileSize) + 2;

    const startX = Math.floor(viewport.x - tilesX / 2);
    const startY = Math.floor(viewport.y - tilesY / 2);
    const endX = Math.ceil(viewport.x + tilesX / 2);
    const endY = Math.ceil(viewport.y + tilesY / 2);

    // 表示範囲内のタイルを取得 (重なり判定などでの活用を想定)
    // [OPTIMIZED] visibleTiles配列の生成を削除
    // const visibleTiles = [];
    // for (let x = Math.max(0, startX); x <= Math.min(MAP_SIZE - 1, endX); x++) {
    //   for (let y = Math.max(0, startY); y <= Math.min(MAP_SIZE - 1, endY); y++) {
    //       const key = `${x}_${y}`;
    //       // タイルデータが存在しなくても、座標情報として追加（選択枠描画などのため）
    //       visibleTiles.push({ x, y, tile: tiles[key] || null });
    //   }
    // }

    // 金枠 (50x50センターエリア)
    // 座標: SPECIAL_TILE_MIN〜SPECIAL_TILE_MAX
    if (showSpecialBorder) {
        const goldStart = SPECIAL_TILE_MIN;
        const goldRectX = centerX + (goldStart - viewport.x) * tileSize;
        const goldRectY = centerY + (goldStart - viewport.y) * tileSize;
        const goldRectSize = (SPECIAL_TILE_MAX - SPECIAL_TILE_MIN + 1) * tileSize;

        ctx.strokeStyle = '#FFD700'; // Gold
        ctx.lineWidth = 3;
        ctx.strokeRect(goldRectX, goldRectY, goldRectSize, goldRectSize);
    }

    // ネームドマス描画
    Object.values(namedCells).forEach(cell => {
        // 表示範囲外はスキップ (ZOC表示のために少し広めにチェックすべきだが、簡易的に本体基準)
        if (cell.x < startX - 5 || cell.x > endX + 5 || cell.y < startY - 5 || cell.y > endY + 5) return;

        const screenX = centerX + (cell.x - viewport.x) * tileSize;
        const screenY = centerY + (cell.y - viewport.y) * tileSize;

        // ZOC描画 (設定がオンの場合に表示)
        // 自勢力含め全てのネームドマスのZOCを表示する
        if (showNamedTileNames) {
             const zocRadius = 5;
             const zocPixelSize = (zocRadius * 2 + 1) * tileSize;
             const zocScreenX = screenX - zocRadius * tileSize;
             const zocScreenY = screenY - zocRadius * tileSize;

             ctx.save();
             ctx.strokeStyle = 'rgba(255, 50, 50, 0.4)';
             ctx.lineWidth = 2;
             ctx.setLineDash([4, 4]); // 点線
             ctx.strokeRect(zocScreenX, zocScreenY, zocPixelSize, zocPixelSize);

             // 範囲内を薄く赤くする
             ctx.fillStyle = 'rgba(255, 0, 0, 0.03)';
             ctx.fillRect(zocScreenX, zocScreenY, zocPixelSize, zocPixelSize);
             ctx.restore();
        }

        if (cell.x < startX || cell.x > endX || cell.y < startY || cell.y > endY) return;

        // [FIX] factionId is removed from namedCells, so look up from map tiles
        const cellTile = getTile(cell.x, cell.y);
        const cellFactionId = cellTile ? (cellTile.factionId || cellTile.faction) : null;
        const cellFaction = factions[cellFactionId];
        const borderColor = cellFaction ? cellFaction.color : '#aaaaaa';
        const level = cell.level || 1;

        if (viewport.zoom > 0.4) {
            ctx.strokeStyle = borderColor;
            ctx.lineWidth = 2 + (level * 0.5);
            ctx.strokeRect(screenX, screenY, tileSize, tileSize);
        } else if (viewport.zoom > 0.1) {
            // ズームアウト時は枠ではなく塗りつぶしで表現（または枠線のみ軽量描画）
            ctx.fillStyle = borderColor;
            ctx.fillRect(screenX, screenY, tileSize, tileSize);
        }

        // ★マーカー（ズームレベルに関わらず一定サイズで表示）
        if (viewport.zoom > 0.15) {
            // マーカーサイズは固定（ズームに依存しない）
            const markerSize = 14; // 固定サイズ
            ctx.fillStyle = '#FFD700'; // 金色で統一
            ctx.font = `bold ${markerSize}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 2;
            ctx.fillText("★", screenX + tileSize/2, screenY + tileSize/2);
            ctx.shadowBlur = 0;
        }

        // 名前ラベル（ズームアウト時に肥大化しないようスケーリングを調整）
        if (showNamedTileNames && viewport.zoom > 0.15) {
             const labelSize = Math.max(8, 10 * viewport.zoom); // ズームに合わせて最小8pxまで縮小
             ctx.font = `bold ${labelSize}px sans-serif`;
             ctx.textAlign = 'center';
             ctx.textBaseline = 'bottom';

             const textWidth = ctx.measureText(cell.name).width;
             const padding = 2;
             const bgWidth = textWidth + padding * 2;
             const bgHeight = labelSize + padding;

             // 金色の背景を描画
             ctx.fillStyle = '#FFD700';
             ctx.fillRect((screenX + tileSize/2) - bgWidth/2, (screenY - 2) - bgHeight, bgWidth, bgHeight);

             // 黒い文字で名前を描画
             ctx.fillStyle = '#000000';
             ctx.fillText(cell.name, screenX + tileSize/2, screenY - 2);
        }
    });

    // 事前に検索用Setを作成 (O(1) lookup)
    // 事前に検索用Setを作成 (O(1) lookup) - Use top-level memo
    // const selectedKeys = ... (moved to top level)

    // 1. 選択枠 & 2. ホバー枠 (LOD適用：超広域表示時は描画しない)
    if (viewport.zoom > 0.15) {
        // [OPTIMIZED] visibleTiles配列生成ループを削除し、必要な時だけ直接座標計算

        // 選択タイルの描画
        if (selectedTiles.length > 0) {
             ctx.strokeStyle = '#7c3aed';
             ctx.lineWidth = 2;
             selectedTiles.forEach(t => {
                // 画面外カリング
                if (t.x < startX || t.x > endX || t.y < startY || t.y > endY) return;

                const screenX = centerX + (t.x - viewport.x) * tileSize;
                const screenY = centerY + (t.y - viewport.y) * tileSize;
                ctx.strokeRect(screenX + 1, screenY + 1, tileSize - 3, tileSize - 3);
             });
        }

        // ホバータイルの描画
        if (hoverTile && showGrid && !tilePopup && viewport.zoom > 0.2) {
             const hx = hoverTile.x;
             const hy = hoverTile.y;
             if (hx >= startX && hx <= endX && hy >= startY && hy <= endY) {
                 const screenX = centerX + (hx - viewport.x) * tileSize;
                 const screenY = centerY + (hy - viewport.y) * tileSize;
                 ctx.fillStyle = 'rgba(124, 58, 237, 0.3)';
                 ctx.fillRect(screenX, screenY, tileSize - 1, tileSize - 1);
             }
        }
    }

    // 3. 勢力ハイライト (最適化：事前計算済みエッジをバッチ描画)
    if (activeFactionId && activeFactionEdges.length > 0) {
        const alpha = blinkAlpha;
        ctx.save();

        // A. 領域内のタイルを一括で薄く光らせる (LOD: 広域ではスキップ)
        // [OPTIMIZED] 全タイル走査をやめて、エッジ情報からバウンディングボックスを使って描くか、
        // あるいはactiveFactionIdのタイルリストを持っているならそれを使うべきだが、
        // ここではtiles全体走査が重いため、簡易的に「画面内のタイル」を走査するループを復活させるが、
        // 条件付き（activeIdがある時だけ）にする。

        if (viewport.zoom > 0.3) {
            ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.2})`;
            // 画面内ループ (SABから直接読み取り、オブジェクト生成なし)
            for (let x = Math.max(0, startX); x <= Math.min(MAP_SIZE - 1, endX); x++) {
                for (let y = Math.max(0, startY); y <= Math.min(MAP_SIZE - 1, endY); y++) {
                    const fid = getFactionIdRaw(x, y);
                    if (fid === activeFactionId) {
                        const screenX = centerX + (x - viewport.x) * tileSize;
                        const screenY = centerY + (y - viewport.y) * tileSize;
                        ctx.fillRect(screenX, screenY, tileSize, tileSize);
                    }
                }
            }
        }

        // B. 境界線の描画 (赤と白の二重線)
        ctx.lineCap = 'square';

        const drawBatchEdges = (width, color, offset) => {
            ctx.beginPath();
            ctx.lineWidth = width;
            ctx.strokeStyle = color;
            activeFactionEdges.forEach(e => {
                // 画面外エッジの簡易カリング
                if (e.x1 < startX - 1 && e.x2 < startX - 1) return;
                if (e.x1 > endX + 1 && e.x2 > endX + 1) return;
                if (e.y1 < startY - 1 && e.y2 < startY - 1) return;
                if (e.y1 > endY + 1 && e.y2 > endY + 1) return;

                const sx1 = centerX + (e.x1 - viewport.x) * tileSize;
                const sy1 = centerY + (e.y1 - viewport.y) * tileSize;
                const sx2 = centerX + (e.x2 - viewport.x) * tileSize;
                const sy2 = centerY + (e.y2 - viewport.y) * tileSize;

                // オフセット（枠線を少し内側に寄せる）
                let dx1 = 0, dy1 = 0, dx2 = 0, dy2 = 0;
                if (offset !== 0) {
                    if (e.type === 'top') { dy1 = dy2 = offset; }
                    else if (e.type === 'bottom') { dy1 = dy2 = -offset; }
                    else if (e.type === 'left') { dx1 = dx2 = offset; }
                    else if (e.type === 'right') { dx1 = dx2 = -offset; }
                }

                ctx.moveTo(sx1 + dx1, sy1 + dy1);
                ctx.lineTo(sx2 + dx2, sy2 + dy2);
            });
            ctx.stroke();
        };

        // 外側（赤）
        drawBatchEdges(2, `rgba(255, 0, 0, ${alpha})`, 1);

        // 内側（白） LOD: 拡大時のみ描画
        if (viewport.zoom > 0.4) {
            drawBatchEdges(1, `rgba(255, 255, 255, ${alpha})`, 3);
        }

        ctx.restore();
    }

    // 勢力名/同盟名ラベル描画 (共通ロジック：重なり回避あり)
    // 条件: showFactionNames（またはshowAllianceNames）がオンの場合
    const shouldDrawLabels = showFactionNames;

    if (shouldDrawLabels) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';

      const labels = [];
      ctx.font = 'bold 12px sans-serif';

      Object.entries(factionCenters).forEach(([id, center]) => {
        const faction = factions[id];
        if (!faction) return;

        let name = faction.name;

        // 同盟モードなら同盟名を使用、非同盟はスキップ
        if (mapColorMode === 'alliance') {
            if (faction.allianceId && alliances[faction.allianceId]) {
                name = alliances[faction.allianceId].name;
            } else {
                // return; // 非同盟は表示しない -> 黒塗りなのでラベルも非表示でOK
                return;
            }
        } else if (mapColorMode === 'player') {
            // Player mode: Show Faction Name (same as normal)
            name = faction.name;
        } else if (mapColorMode === 'overpaint') {
            // 塗装数モード: ラベル非表示（または塗装数を表示してもいいが、今回は非表示）
            return;
        }

        const count = center.count;
        let sizeBase = Math.min(128, Math.max(8, Math.sqrt(count) * 4 + 4));

        // Dynamic Font Sizing: 文字数に応じて縮小
        if (name.length > 5) {
             sizeBase = sizeBase * (6.0 / name.length);
        }

        const fontSize = Math.max(8, sizeBase * viewport.zoom);

        name = name.trim().replace(/\s+/g, ' ');
        if (name.length > 30) name = name.substring(0, 27) + '...';

        ctx.font = `bold ${fontSize}px sans-serif`;
        const metrics = ctx.measureText(name);

        const screenX = centerX + (center.x - viewport.x) * tileSize;
        const screenY = centerY + (center.y - viewport.y) * tileSize;

        if (screenX < -200 || screenX > width + 200 || screenY < -200 || screenY > height + 200) return;

        labels.push({
          id,
          name,
          fontSize,
          x: screenX,
          y: screenY,
          targetX: screenX,
          targetY: screenY,
          w: metrics.width,
          h: fontSize,
          color: '#ffffff',
          count: count
        });
      });

      // 位置調整 (ラベル重なり回避)
      const iterations = 3; // 10 -> 3
      const padding = 2;
      for (let i = 0; i < iterations; i++) {
          for (let j = 0; j < labels.length; j++) {
              for (let k = j + 1; k < labels.length; k++) {
                  const l1 = labels[j];
                  const l2 = labels[k];
                  const dx = l1.x - l2.x;
                  const dy = l1.y - l2.y;
                  const distX = Math.abs(dx);
                  const distY = Math.abs(dy);
                  const minW = (l1.w + l2.w) / 2 + padding;
                  const minH = (l1.h + l2.h) / 2 + padding;
                  if (distX < minW && distY < minH) {
                      const overlapX = minW - distX;
                      const overlapY = minH - distY;
                      if (overlapX < overlapY) {
                          const move = overlapX / 2;
                          const sign = dx > 0 ? 1 : -1;
                          l1.x += move * sign;
                          l2.x -= move * sign;
                      } else {
                          const move = overlapY / 2;
                          const sign = dy > 0 ? 1 : -1;
                          l1.y += move * sign;
                          l2.y -= move * sign;
                      }
                  }
              }
          }
          for (let j = 0; j < labels.length; j++) {
              const l = labels[j];
              l.x += (l.targetX - l.x) * 0.1;
              l.y += (l.targetY - l.y) * 0.1;
          }
      }

      // ラベル領域保存
      labelRegionsRef.current = labels.map(l => ({
          id: l.id,
          x: l.x - l.w / 2,
          y: l.y - l.h / 2,
          w: l.w,
          h: l.h
      }));

      // ラベル描画
      labels.forEach(l => {
        ctx.font = `bold ${l.fontSize}px sans-serif`;
        ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
        ctx.shadowBlur = 4;
        ctx.strokeStyle = '#000000';
        ctx.fillStyle = l.color;
        ctx.lineWidth = 3;

        ctx.strokeText(l.name, l.x, l.y);
        ctx.fillText(l.name, l.x, l.y);
      });
      ctx.restore();
    } else {
      labelRegionsRef.current = [];
    }

  }, [viewport, version, factions, selectedTiles, hoverTile, activeFactionId, activeFactionEdges, tilePopup, mapColorMode, blinkAlpha, namedCells, factionCenters, alliances, playerFactionId, showAllianceNames, showFactionNames, showSpecialBorder, canvasDimensions]);



  // ウィンドウサイズ変更対応 (ResizeObserver)
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const resize = () => {
        const width = parent.clientWidth;
        const height = parent.clientHeight;

        if (overlayCanvasRef.current) {
            overlayCanvasRef.current.width = width;
            overlayCanvasRef.current.height = height;
        }
        setCanvasDimensions({ width, height });

        // Worker側のリサイズは useMultiRenderWorker 側で検知して実行されるか、
        // ここで明示的に呼ぶ必要がある場合は resizeWorker(width, height) を呼ぶ
        // useMultiRenderWorkerのresizeはuseEffectでcanvasDimensionsを監視しているか、
        // あるいは親コンポーネントからresizeを呼ぶ設計か確認が必要。
        // 現在の構成では GameMap 内で resizeWorker を受け取っているので、ここで呼ぶのが確実。
        if (resizeWorker) {
             resizeWorker(width, height);
        }
    };

    // 初期化
    resize();

    // ResizeObserverで親要素のサイズ変更を監視
    const observer = new ResizeObserver(() => {
        resize();
    });
    observer.observe(parent);

    return () => {
        observer.disconnect();
    };
  }, [resizeWorker]); // useOffscreenCanvas依存を削除

  // スクリーン座標からタイル座標へ変換
  const screenToTile = useCallback((screenX, screenY) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const width = canvas.width;
    const height = canvas.height;
    const tileSize = TILE_SIZE * viewport.zoom;
    const centerX = width / 2;
    const centerY = height / 2;
    const tileX = Math.floor((screenX - centerX) / tileSize + viewport.x);
    const tileY = Math.floor((screenY - centerY) / tileSize + viewport.y);
    return { x: tileX, y: tileY };
  }, [viewport]);

  // マウスイベント (ラベルホバー追加)
  const handleMouseDown = (e) => {
    if (e.button === 0) {
      setIsDragging(true);
      dragStart.current = { x: e.clientX, y: e.clientY };
      clickStart.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseMove = (e) => {
    // ツールチップ座標更新
    setTooltipPos({ x: e.clientX, y: e.clientY });

    if (!canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const tile = screenToTile(x, y);
    // タイルホバー
    if (tile.x >= 0 && tile.x < MAP_SIZE && tile.y >= 0 && tile.y < MAP_SIZE) {
      setHoverTile(tile);
    } else {
      setHoverTile(null);
    }

    // 勢力ホバー判定 (PCのみ): 負荷軽減のため処理を間引く (5フレームに1回)
    if (!isDragging) {
        // Simple skipping could be done with a ref counter, but here let's just do it.
        // Or better, only do it if the tile coords changed significantly or use a requestAnimationFrame throttle?
        // Let's use a simple counter ref.

        // This part was causing heavy load on every pixel move.
        // We can check if tile changed first.

        let foundId = null;

        // 1. マウス下のタイルが勢力のものか確認
        if (tile.x >= 0 && tile.x < MAP_SIZE && tile.y >= 0 && tile.y < MAP_SIZE) {
             const t = getTile(tile.x, tile.y);
             if (t && (t.faction || t.factionId)) {
                 foundId = t.faction || t.factionId;
             }
        }

        // 2. タイルで見つからなければラベルを確認 (ここが重い可能性)
        if (!foundId && labelRegionsRef.current.length > 0) {
            // ラベル判定も少し重いので、マウスが動いている間は頻度を下げるべきだが、
            // UX的にラベルは即座に反応してほしい。
            // 改善策: labelRegionsRefのループはそこまで重くないはず (勢力数による)。
            // しかし、DOMイベントごとの実行は多い。

            for (const l of labelRegionsRef.current) {
                if (x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h) {
                    foundId = l.id;
                    break;
                }
            }
        }

        if (hoverFactionId !== foundId) {
             if (onHoverFactionChange) onHoverFactionChange(foundId);
        }
    }

    if (isDragging) {
        if (brushToggleMode) { // use prop
             if (tile.x >= 0 && tile.x < MAP_SIZE && tile.y >= 0 && tile.y < MAP_SIZE) {
                  const currentKey = `${tile.x}_${tile.y}`;
                  if (lastSelectedRef.current !== currentKey) {
                      onTileClick(tile.x, tile.y); // Drag Paint
                      lastSelectedRef.current = currentKey;
                  }
             }
        } else {
             const dx = (e.clientX - dragStart.current.x) / (TILE_SIZE * viewport.zoom);
             const dy = (e.clientY - dragStart.current.y) / (TILE_SIZE * viewport.zoom);
             setViewport(prev => ({
                 ...prev,
                 x: Math.max(0, Math.min(MAP_SIZE - 1, prev.x - dx)),
                 y: Math.max(0, Math.min(MAP_SIZE - 1, prev.y - dy))
             }));
             dragStart.current = { x: e.clientX, y: e.clientY };
        }
    }
  };

  const handleMouseUp = (e) => {
    if (isDragging) {
      setIsDragging(false);
      // クリック判定
      const dist = Math.sqrt(Math.pow(e.clientX - clickStart.current.x, 2) + Math.pow(e.clientY - clickStart.current.y, 2));

      if (dist < 5) {
        // クリック
        if (brushToggleMode) {
             // ブラシモードならクリックでも塗る
             if (hoverTile) {
                 onTileClick(hoverTile.x, hoverTile.y);
             }
        } else {
            // 通常モード
            if (hoverTile) {
                if (skipConfirmation) {
                    // 確認なしモード：即座にトグル
                    onTileClick(hoverTile.x, hoverTile.y);
                    setTilePopup(null); // ポップアップは出さない
                    setTapHighlight(null); // タップハイライト解除
                } else {
                    // ポップアップ表示
                    const tData = getTile(hoverTile.x, hoverTile.y);
                    const fName = tData?.factionId ? (factions[tData.factionId]?.name || '不明') : null;
                    const pName = tData?.paintedByName || (tData?.paintedBy ? playerNames[tData.paintedBy] || tData.paintedBy : null);
                    const coreData = tData?.core || null;

                    setTilePopup(prev => {
                      // 同じ場所なら更新だけ
                      if (prev && prev.x === hoverTile.x && prev.y === hoverTile.y) {
                          return {
                              ...prev,
                              factionName: fName,
                              painterName: pName,
                              factionId: tData?.faction || tData?.factionId,
                              core: coreData,
                              screenX: e.clientX, // 位置更新
                              screenY: e.clientY
                          };
                      }
                        return {
                          x: hoverTile.x,
                          y: hoverTile.y,
                          screenX: e.clientX,
                          screenY: e.clientY,
                          factionName: fName,
                          factionId: tData?.factionId,
                          paintedBy: tData?.paintedBy, // [FIX] IDを保存
                          painterName: pName,
                          core: coreData
                        };
                    });
                    // タップ位置のハイライトセット
                    setTapHighlight({ x: hoverTile.x, y: hoverTile.y });
                }
            }
        }
      }
    }
    // ドラッグ終了時はハイライト消す? いや、ポップアップ中は残したい
    // setTapHighlight(null); // ここで消すとポップアップ出てるのに消える
    lastSelectedRef.current = null;
  };



  // Additional Data Sync is handled by the hook's internal effects

  // Optimize resize handling
  const lastDimensionsRef = useRef({ width: 0, height: 0 });

  // Resize handler
  const updateCanvasSize = useCallback((entry) => {
      // Use canvasContainerRef for reliable sizing (it's the parent of worker canvases)
      const container = canvasContainerRef.current;
      if (!container) return;

      // [OPTIMIZATION] Cap pixel ratio to 2 to prevent excessive rendering load on high-DPI screens
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

      const width = container.clientWidth; // Use container.clientWidth for actual CSS size
      const height = container.clientHeight; // Use container.clientHeight for actual CSS size

      const displayWidth = Math.floor(width * pixelRatio);
      const displayHeight = Math.floor(height * pixelRatio);

      // Avoid redundant updates
      // This check is important to prevent unnecessary re-renders and worker resizes
      // if the effective resolution hasn't changed (e.g., due to minor sub-pixel changes in clientWidth/Height)
      if (
        lastDimensionsRef.current.width !== displayWidth ||
        lastDimensionsRef.current.height !== displayHeight
      ) {
         lastDimensionsRef.current = { width: displayWidth, height: displayHeight };

         setCanvasDimensions({ width: displayWidth, height: displayHeight });

         // Update CSS size to match display size (for correct scaling)
         if (canvasContainerRef.current) {
             // canvas style is handled by CSS (width: 100%, height: 100%)
             // but internal resolution is set here.
         }

         if (overlayCanvasRef.current) {
            overlayCanvasRef.current.width = displayWidth;
            overlayCanvasRef.current.height = displayHeight;
         }

         // Resize workers
         if (resizeWorker) { // Ensure resizeWorker is available
             resizeWorker(displayWidth, displayHeight);
         }

         // Trigger render (throttled) - assuming renderAllWorkers is available in scope
         // renderAllWorkers(viewport, displayWidth, displayHeight); // This line was not in the original context, assuming it's part of a larger change.
      }

  }, [resizeWorker]);

  // Initial setup and resize observer
  useEffect(() => {
      const container = canvasContainerRef.current;
      if (!container) {
          console.log('[GameMap] ResizeObserver: container not found');
          return;
      }

      console.log('[GameMap] Setting up ResizeObserver');
      updateCanvasSize();

      const observer = new ResizeObserver(() => {
          updateCanvasSize();
      });
      observer.observe(container);

      return () => {
          observer.disconnect();
      };
  }, [updateCanvasSize]);

  // タッチイベント
  const handleTouchStart = useCallback((e) => {
    const currentViewport = viewportRef.current;
    if (e.touches.length === 2) {
      // e.preventDefault(); // allow default for now, handle in specific cases? Chrome warns if passive.
      // With passive: false, we CAN prevent default.
      // e.preventDefault();

      const dist = getDistance(e.touches[0], e.touches[1]);
      touchState.current.mode = 'pinch';
      touchState.current.startDist = dist;
      touchState.current.startZoom = currentViewport.zoom;
      touchState.current.wasPinching = true;
      setIsDragging(false);
    } else if (e.touches.length === 1) {
      if (touchState.current.mode !== 'pinch') {
        // e.preventDefault(); // Don't prevent default on start to allow click? But we want to prevent scroll...
        // touch-action: none handles scroll prevention.

        const touch = e.touches[0];
        setIsDragging(true);
        dragStart.current = { x: touch.clientX, y: touch.clientY };
        clickStart.current = { x: touch.clientX, y: touch.clientY };
        lastSelectedRef.current = null;

        if (brushToggleMode) { // use prop
             const canvas = canvasRef.current;
             if(canvas) {
                 const rect = canvas.getBoundingClientRect();
                 const x = touch.clientX - rect.left;
                 const y = touch.clientY - rect.top;

                 // need screenToTile inside strict mode or refactored?
                 // screenToTile depends on viewport. We need internal logic here.
                 const width = canvas.width;
                 const height = canvas.height;
                 const tileSize = TILE_SIZE * currentViewport.zoom;
                 const centerX = width / 2;
                 const centerY = height / 2;
                 const tileX = Math.floor((x - centerX) / tileSize + currentViewport.x);
                 const tileY = Math.floor((y - centerY) / tileSize + currentViewport.y);
                 const tile = { x: tileX, y: tileY };

                 const currentKey = `${tile.x}_${tile.y}`;
                 if (tile.x >= 0 && tile.x < MAP_SIZE && tile.y >= 0 && tile.y < MAP_SIZE) {
                     if (lastSelectedRef.current !== currentKey) {
                         onTileClick(tile.x, tile.y);
                         lastSelectedRef.current = currentKey;
                     }
                 }
             }
        }
        touchState.current.mode = 'drag';
        touchState.current.wasPinching = false;
      }
    }
  }, [brushToggleMode, onTileClick]); // viewport removed from deps

  const handleTouchMove = useCallback((e) => {
    // e.preventDefault(); // Required to prevent browser zoom/scroll if touch-action not enough, or for other gestures
    // Since we use passive: false, checking cancelable is good practice but preventDefault is main goal.
    if (e.cancelable) e.preventDefault();

    if (e.touches.length > 0) {
        setTooltipPos({ x: e.touches[0].clientX, y: e.touches[0].clientY });
    }

    const currentViewport = viewportRef.current;

    if (e.touches.length === 2 && touchState.current.mode === 'pinch') {
      const dist = getDistance(e.touches[0], e.touches[1]);
      const lastDist = touchState.current.startDist;
      if (lastDist > 0) {
        const ratio = dist / lastDist;
        const minZoom = 0.1;
        setViewport(prev => ({
          ...prev,
          zoom: Math.max(minZoom, Math.min(4, touchState.current.startZoom * ratio))
        }));
      }
    } else if (e.touches.length === 1 && isDragging && !touchState.current.wasPinching) {
      const touch = e.touches[0];
      if (brushToggleMode) { // touch move paint
           const canvas = canvasRef.current;
           if (!canvas) return;
           const rect = canvas.getBoundingClientRect();
           const x = touch.clientX - rect.left;
           const y = touch.clientY - rect.top;

           const width = canvas.width;
           const height = canvas.height;
           const tileSize = TILE_SIZE * currentViewport.zoom;
           const centerX = width / 2;
           const centerY = height / 2;
           const tileX = Math.floor((x - centerX) / tileSize + currentViewport.x);
           const tileY = Math.floor((y - centerY) / tileSize + currentViewport.y);
           const tile = { x: tileX, y: tileY };

           const currentKey = `${tile.x}_${tile.y}`;
           if (tile.x >= 0 && tile.x < MAP_SIZE && tile.y >= 0 && tile.y < MAP_SIZE) {
               if (lastSelectedRef.current !== currentKey) {
                   onTileClick(tile.x, tile.y);
                   lastSelectedRef.current = currentKey;
               }
           }
      } else {
          const dx = (touch.clientX - dragStart.current.x) / (TILE_SIZE * currentViewport.zoom);
          const dy = (touch.clientY - dragStart.current.y) / (TILE_SIZE * currentViewport.zoom);
          setViewport(prev => ({
            ...prev,
            x: Math.max(0, Math.min(MAP_SIZE - 1, prev.x - dx)),
            y: Math.max(0, Math.min(MAP_SIZE - 1, prev.y - dy))
          }));
          dragStart.current = { x: touch.clientX, y: touch.clientY };
          if (tilePopup) setTilePopup(null);
      }
    }

    // Mobile hover simulation for Tooltip
    if (!isDragging && e.touches.length === 1) {
          const touch = e.touches[0];
          const canvas = canvasRef.current;
          if (canvas) {
             const rect = canvas.getBoundingClientRect();
             const x = touch.clientX - rect.left;
             const y = touch.clientY - rect.top;

             const tSize = TILE_SIZE * currentViewport.zoom;
             const cX = canvas.width / 2;
             const cY = canvas.height / 2;

             const tileX = Math.floor((x - cX) / tSize + currentViewport.x);
             const tileY = Math.floor((y - cY) / tSize + currentViewport.y);

             if (tileX >= 0 && tileX < MAP_SIZE && tileY >= 0 && tileY < MAP_SIZE) {
                 setHoverTile({ x: tileX, y: tileY });
             }
          }
    }
  }, [isDragging, brushToggleMode, onTileClick, tilePopup]);

  const handleTouchEnd = useCallback((e) => {
    // e.preventDefault(); // prevent mouse emulation?
    if (e.cancelable) e.preventDefault();

    const currentViewport = viewportRef.current;

    if (e.touches.length === 0) {
        if (isDragging && !touchState.current.wasPinching) {
             if (!brushToggleMode && e.changedTouches.length === 1) {
                 const touch = e.changedTouches[0];
                 const dist = Math.sqrt(Math.pow(touch.clientX - clickStart.current.x, 2) + Math.pow(touch.clientY - clickStart.current.y, 2));

                 if (dist < 20) {
                     // タッチクリック: ポップアップ
                     const canvas = canvasRef.current;
                     if (!canvas) return;
                      const rect = canvas.getBoundingClientRect();
                      const x = touch.clientX - rect.left;
                      const y = touch.clientY - rect.top;

                      // タップハイライト用の座標計算 (画面外判定などは後続のロジックで行うが、
                      // ここで temporary に highlight を更新するのもありだが、
                      // 実際の描画更新は requestAnimationFrame や state 依存なので
                      // handleTouchEnd で確定させるのが無難。
                      // ただし「押している間」のフィードバックならここで…
                      // いや、GameMapは mouseUp/touchEnd でアクション確定なので
                      // touchStart/Move ではドラッグかどうかの判定のみ。
                      // touchEnd で popUp or select.

                     const width = canvas.width;
                     const height = canvas.height;
                     const tileSize = TILE_SIZE * currentViewport.zoom;
                     const centerX = width / 2;
                     const centerY = height / 2;
                     const tileX = Math.floor((x - centerX) / tileSize + currentViewport.x);
                     const tileY = Math.floor((y - centerY) / tileSize + currentViewport.y);
                     const tile = { x: tileX, y: tileY };

                     if (tile.x >= 0 && tile.x < MAP_SIZE && tile.y >= 0 && tile.y < MAP_SIZE) {
                        const key = `${tile.x}_${tile.y}`;
                        {
                             const tData = getTile(tile.x, tile.y);
                             const fName = tData?.faction ? (factions[tData.faction]?.name || '不明') : null;
                             const pName = playerNames[tData?.paintedBy] || tData?.paintedBy || null;
                             const coreData = tData?.core || null;

                             setTilePopup(prev => {
                               if (prev && prev.x === tile.x && prev.y === tile.y) {
                                   return {
                                       ...prev,
                                       factionName: fName,
                                       painterName: pName,
                                       factionId: tData?.faction || tData?.factionId,
                                       core: coreData
                                   };
                               }
                               return {
                                   x: tile.x,
                                   y: tile.y,
                                   screenX: touch.clientX,
                                   screenY: touch.clientY,
                                   factionName: fName,
                                   painterName: pName,
                                   paintedBy: tData?.paintedBy, // [FIX] IDを保存
                                   factionId: tData?.faction || tData?.factionId,
                                   core: coreData
                               };
                             });
                        }
                     }
                 } else {
                     setTilePopup(null);
                 }
             }
        }
       setIsDragging(false);
       touchState.current.mode = 'none';
    }
  }, [isDragging, brushToggleMode, getTile, factions, namedCells, onNamedCellClick, playerNames]); // viewport removed

  const handleWheel = useCallback((e) => {
    e.preventDefault();
    if (wheelTimeoutRef.current) return;

    wheelTimeoutRef.current = setTimeout(() => {
        wheelTimeoutRef.current = null;
    }, 16);

    const minZoom = 0.1;
    // const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setViewport(prev => {
        const currentZoom = prev.zoom;
        let step = 0.25;
        if (currentZoom < 0.2) {
            step = 0.01;
        } else if (currentZoom < 0.5) {
            step = 0.05;
        }

        let newZoom = currentZoom;
        if (e.deltaY > 0) {
            // Zoom Out
            newZoom -= step;
        } else {
            // Zoom In
            newZoom += step;
        }
        return {
            ...prev,
            zoom: Math.max(minZoom, Math.min(4, newZoom))
        };
    });
  }, []);

  // 手動イベントリスナー登録 (Passive: false)
  useEffect(() => {
      const canvas = overlayCanvasRef.current;
      if (!canvas) return;

      const opts = { passive: false };

      canvas.addEventListener('wheel', handleWheel, opts);
      canvas.addEventListener('touchstart', handleTouchStart, opts);
      canvas.addEventListener('touchmove', handleTouchMove, opts);
      canvas.addEventListener('touchend', handleTouchEnd, opts);

      return () => {
          canvas.removeEventListener('wheel', handleWheel);
          canvas.removeEventListener('touchstart', handleTouchStart);
          canvas.removeEventListener('touchmove', handleTouchMove);
          canvas.removeEventListener('touchend', handleTouchEnd);
      };
  }, [handleWheel, handleTouchStart, handleTouchMove, handleTouchEnd]);

  return (
    <>
      {/* Container for dynamically created worker canvases */}
      <div
        ref={canvasContainerRef}
        style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            zIndex: 1
        }}
      />
      {/* Overlay canvas for UI elements */}
      <canvas
        ref={overlayCanvasRef}
        style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            cursor: isDragging ? 'grabbing' : 'grab',
            touchAction: 'none',
            zIndex: 2
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          setIsDragging(false);
          setHoverTile(null);
        }}
        // onWheel, onTouch... removed from here (Handled by useEffect with passive:false)
      />

      {hoverTile && !tilePopup && showTooltip && window.innerWidth >= 768 && (() => {
        const tileData = getTile(hoverTile.x, hoverTile.y);
        const factionName = tileData?.factionId ? (factions[tileData.factionId]?.name || '不明') : null;
        const painterName = playerNames[tileData?.paintedBy] || tileData?.paintedBy || null;

        // モバイル等の場合、指の右側に少しずらす
        const offsetX = 20;
        const offsetY = 20;

        return (
          <div
            className="tooltip"
            style={{
                position: 'fixed',
                top: (tooltipPos.y + offsetY) + 'px',
                left: (tooltipPos.x + offsetX) + 'px',
                transform: 'none', // CSSでの配置を上書き
                pointerEvents: 'none'
            }}
          >
            <div>座標: ({hoverTile.x}, {hoverTile.y})</div>
            <div>ポイント: {getTilePoints(hoverTile.x, hoverTile.y, namedCells)}pt</div>
            {factionName && <div>勢力: {factionName}</div>}
            {painterName && painterName !== 'Unknown' && <div>塗った人: {painterName}</div>}
           </div>
        );
      })()}

      {tilePopup && createPortal(
        <>
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 10000,
              background: 'transparent'
            }}
            onClick={() => setTilePopup(null)}
          />
          <div
          className={`mobile-popup-card is-x-centered`}
          style={{
              ...popupStyle,
              background: 'rgba(20, 20, 35, 0.95)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              backdropFilter: 'blur(10px)',
              padding: '12px',
              borderRadius: '8px',
              color: '#fff',
              boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
              zIndex: 10001,
              // 動的位置調整
              left: tilePopup.screenX,
              top: (typeof window !== 'undefined' && window.innerHeight - tilePopup.screenY < 350) ? 'auto' : tilePopup.screenY + 10,
              bottom: (typeof window !== 'undefined' && window.innerHeight - tilePopup.screenY < 350) ? (window.innerHeight - tilePopup.screenY + 10) : 'auto',
              maxHeight: (typeof window !== 'undefined' && window.innerHeight - tilePopup.screenY < 350)
                ? `${tilePopup.screenY - 20}px`
                : `${window.innerHeight - tilePopup.screenY - 20}px`,
              overflowY: 'auto'
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
          >
            <div className="popup-inner">
              <div className="popup-coords">座標: ({tilePopup.x}, {tilePopup.y})</div>
              <div className="popup-detail highlight-points">ポイント: {getTilePoints(tilePopup.x, tilePopup.y, namedCells)}pt</div>
              {tilePopup.factionName && (
                <div
                  className="popup-detail clickable-faction"
                  onClick={() => {
                    if (onShowFactionDetails) onShowFactionDetails(tilePopup.factionId);
                    setTilePopup(null);
                  }}
                  title="勢力詳細を見る"
                  style={{ cursor: 'pointer', color: '#60a5fa', textDecoration: 'underline' }}
                >
                  勢力: {tilePopup.factionName}
                </div>
              )}
              {(() => {
                const pName = tilePopup.painterName || (playerNames[tilePopup.paintedBy] || tilePopup.paintedBy);
                if (!pName || pName === 'Unknown') return null;
                return (
                  <div className="popup-detail">
                    塗った人: {pName}
                  </div>
                );
              })()}

              {/* Overpaint & Named Tile Info */}
              {(() => {
                  const tData = getTile(tilePopup.x, tilePopup.y);
                  if (!tData) return null;
                  const key = `${tilePopup.x}_${tilePopup.y}`;
                  const cell = namedCells[key];

                  return (
                      <>
                          <div className="popup-detail" style={{ color: '#fbbf24', fontWeight: 'bold' }}>
                              塗装回数: {(tData.overpaint || 0) + 1}回
                          </div>
                          {cell && (
                               <div className="popup-detail" style={{
                                   border: '1px solid #8b5cf6',
                                   background: 'rgba(139, 92, 246, 0.1)',
                                   marginTop: '4px',
                                   padding: '4px',
                                   borderRadius: '4px'
                               }}>
                                   <div style={{ fontWeight: 'bold', color: '#a78bfa' }}>★ {cell.name}</div>

                                    {tData.namedData?.cooldownUntil && new Date(tData.namedData.cooldownUntil) > new Date() && (
                                        <div style={{ fontSize: '0.8rem', color: '#f87171' }}>
                                            🛡️ 陥落クールダウン中 (残り {Math.ceil((new Date(tData.namedData.cooldownUntil).getTime() - Date.now()) / 60000)}分)
                                        </div>
                                    )}
                               </div>
                          )}
                      </>
                  );
              })()}

            {/* Core Tile Info */}
            {tilePopup.core && factions[tilePopup.core.factionId] && (
               <div className="popup-detail" style={{
                   marginTop: '4px',
                   color: tilePopup.core.factionId === tilePopup.factionId ? '#ffd700' : '#ffff00',
                   fontWeight: 'bold',
                   border: '1px solid currentColor',
                   padding: '2px',
                   borderRadius: '4px',
                   fontSize: '0.8rem'
               }}>
                  {tilePopup.core.factionId === tilePopup.factionId
                    ? `★ ${factions[tilePopup.core.factionId].name}の中核`
                    : `⚠ ${factions[tilePopup.core.factionId].name}の中核 (奪取)`
                  }
                  {tilePopup.core.expiresAt && (
                      <div style={{ fontSize: '0.7rem', fontWeight: 'normal' }}>
                         失効: {new Date(tilePopup.core.expiresAt).toLocaleString()}
                      </div>
                  )}
               </div>
            )}

            {/* Coreification Info (Only if not already an active core of self) */}
            {!tilePopup.core && tilePopup.coreificationUntil && (
               <div className="popup-detail" style={{
                   marginTop: '4px',
                   color: '#60a5fa',
                   fontWeight: 'bold',
                   border: '1px solid #60a5fa',
                   padding: '4px',
                   borderRadius: '4px',
                   fontSize: '0.8rem',
                   background: 'rgba(96, 165, 250, 0.1)'
               }}>
                   <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                       <span>⏳ 中核化進行中...</span>
                   </div>
                   <div style={{ fontSize: '0.7rem', fontWeight: 'normal', marginTop: '2px' }}>
                       予定: {new Date(tilePopup.coreificationUntil).toLocaleString()}
                   </div>
               </div>
            )}

            {/* ネームドマス作成・レベルアップボタン */}
            {(() => {
                const key = `${tilePopup.x}_${tilePopup.y}`;
                const tileData = getTile(tilePopup.x, tilePopup.y);
                const namedCell = namedCells[key];


                return null;
            })()}


            <button
              className="popup-action-btn"
              onClick={() => {
                onTileClick(tilePopup.x, tilePopup.y, true);
                setTilePopup(null);
              }}
            >
              {selectedTiles.some(t => t.x === tilePopup.x && t.y === tilePopup.y)
                ? '選択解除'
                : '選択する'}
            </button>
            <button
              className="popup-close-btn"
              onClick={() => setTilePopup(null)}
            >
              閉じる
            </button>
          </div>
        </div>,
        </>,
        document.body
      )}
    </>
  );
}

export default memo(GameMap);

// Helper Component for Debounced Color Picking
function DebouncedColorPicker({ initialColor, x, y }) {
    const [color, setColor] = useState(initialColor);
    const [status, setStatus] = useState(''); // '', 'saving', 'saved', 'error'

    // Update local state immediately for UI responsiveness
    const handleChange = (newColor) => {
        setColor(newColor);
        setStatus('typing');
    };

    useEffect(() => {
        // Skip initial render or if status is not 'typing'
        if (status !== 'typing') return;

        const timer = setTimeout(async () => {
            setStatus('saving');
            try {
                const res = await fetch('/api/tiles/color', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ x, y, color })
                });
                const d = await res.json();
                if (d.success) {
                    setStatus('saved');
                    // Reset to saved after a moment
                    setTimeout(() => setStatus(''), 2000);
                } else {
                    setStatus('error');
                    console.error(d.error);
                }
            } catch (e) {
                setStatus('error');
            }
        }, 600); // 600ms debounce

        return () => clearTimeout(timer);
    }, [color, x, y, status]);

    return (
        <div className="popup-detail" style={{ marginTop: '8px', borderTop: '1px solid rgba(255,255,255,0.2)', paddingTop: '4px' }}>
            <div style={{ fontSize: '0.8rem', marginBottom: '4px', display: 'flex', justifyContent: 'space-between' }}>
                <span>🎨 カスタム色 (包囲限定)</span>
                {status === 'saving' && <span style={{color: '#fbbf24'}}>保存中...</span>}
                {status === 'saved' && <span style={{color: '#34d399'}}>保存完了</span>}
                {status === 'error' && <span style={{color: '#f87171'}}>エラー</span>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                    type="color"
                    value={color}
                    onChange={(e) => handleChange(e.target.value)}
                    style={{ cursor: 'pointer', flexShrink: 0 }}
                />
                <input
                    type="text"
                    value={color}
                    onChange={(e) => handleChange(e.target.value)}
                    maxLength={7}
                    style={{
                        flex: 1,
                        width: '80px',
                        padding: '4px',
                        fontSize: '0.9rem',
                        borderRadius: '4px',
                        border: '1px solid rgba(255,255,255,0.3)',
                        background: 'rgba(0,0,0,0.5)',
                        color: '#fff',
                        fontFamily: 'monospace'
                    }}
                />
            </div>
        </div>
    );
}
