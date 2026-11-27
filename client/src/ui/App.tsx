import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { BoardGLRenderer } from '../renderer/glRenderer';
import {
  api,
  ApiError,
  getAdminDebugMode,
  setAdminDebugMode,
} from '../shared/api';
import {
  ActionMode,
  CELL_BYTES,
  DEFAULT_BOARD_SIZE,
  DiplomacyState,
  FactionClusterAnchor,
  FactionSummary,
  FALLBACK_PATCH_STRIDE,
  HoverInfo,
  NotificationItem,
  OverlayMode,
  packAllCellsToRgba8ui,
  PALETTE_HEX,
  PALETTE_RGB_FLOAT,
  SeasonPhase,
  SeasonStatus,
  STATUS_ERROR,
  STATUS_OK,
  STATUS_WAR_CONFIRM,
  TimelapseFrameMeta,
  UserProfile,
} from '../shared/protocol';
import {
  createBoardBuffers,
  MAX_BOARD_SIZE,
  sabReadSeq,
  sabTrySnapshotRead,
  SharedBoardBuffers,
} from '../shared/sab';
import {
  isSoundMuted,
  playErrorSound,
  playNoticeSound,
  playPaintSound,
  playRecolorSound,
  playSelectSound,
  setSoundMuted,
  unlockAudio,
} from '../shared/sound';
import {
  HoverInspectorPanel,
  LazyAdminPage,
  LazyDebugPanel,
  LazyFactionModal,
  PaintActionButton,
  TickCountdown,
  useModalsModule,
} from './HudSubcomponents';
import { Minimap } from './Minimap';

interface ToastItem {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error' | 'war';
  title?: string;
  clickable?: boolean;
}

interface PendingWarAction {
  x: number;
  y: number;
  mode: ActionMode;
  colorId: number;
  targetFactionId: number;
  costAp: number;
}

const PHASE_LABELS: Record<SeasonPhase, string> = {
  preparation: '準備フェーズ',
  active: '開催中',
  frozen: '凍結・結果発表',
};

/** 現在のシーズン設定と経過Tickから、フェーズバッジに表示するラベルを組み立てる */
function formatPhaseBadgeLabel(season: SeasonStatus): string {
  if (season.phase !== 'active') {
    return PHASE_LABELS[season.phase];
  }
  const remainingTicks = Math.max(0, season.max_ticks - season.tick_number);
  const tickMinutes = Math.max(1, season.game_rules?.tick_interval_minutes ?? 30);
  const byMaxTicks = remainingTicks * tickMinutes;
  const elapsedByTicks = season.tick_number * tickMinutes;
  // 自然スケジュールは48時間（2880分）で凍結するため、48時間未満の残余では上限を2880分以内に抑える
  const totalMinutes =
    elapsedByTicks < 2880 ? Math.min(byMaxTicks, 2880 - elapsedByTicks) : byMaxTicks;
  if (totalMinutes <= 0) {
    return '開催中 (残り 0m)';
  }
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours > 0 && mins > 0) {
    return `開催中 (残り ${hours}h${mins}m)`;
  }
  if (hours > 0) {
    return `開催中 (残り ${hours}h)`;
  }
  return `開催中 (残り ${mins}m)`;
}

/** APピル用の補充頻度ツールチップ文字列を生成する */
function formatApRefillTooltip(season: SeasonStatus, maxAp: number): string {
  const cfg = season.ap_config;
  if (!cfg) {
    return `定期補充（上限 ${maxAp}）`;
  }
  const refillMin = cfg.refill_interval_minutes;
  const tickMin = Math.max(1, season.game_rules?.tick_interval_minutes ?? 30);
  const freq =
    refillMin % tickMin === 0
      ? `${refillMin / tickMin} Tickごと（${refillMin}分）`
      : `${refillMin}分ごと`;
  return `${freq}に ${cfg.refill_min}〜${cfg.refill_max} AP付与（上限 ${maxAp}）`;
}

const OVERLAY_LABELS: Array<{ mode: OverlayMode; label: string; desc: string }> = [
  { mode: 0, label: '標準', desc: 'ドット絵の塗装色をそのまま表示' },
  { mode: 1, label: '勢力色', desc: '各勢力の代表色で領土を統一表示' },
  { mode: 2, label: '重ね塗り層数', desc: '防御力（層数）をヒートマップ表示' },
  { mode: 3, label: '中核/同化', desc: '中核(金)・同化中(水)・旧中核(紫)を表示' },
  { mode: 4, label: '外交', desc: '自国(緑)・戦争中(赤)・その他(灰)を表示' },
];

function isAdminPath(): boolean {
  return window.location.pathname.startsWith('/admin');
}

function clearUserFactionMembership(prev: UserProfile): UserProfile {
  return {
    ...prev,
    faction_id: 0,
    faction_allow_auto_paint: false,
    permissions: {
      is_leader: false,
      is_vice_leader: false,
      can_declare_war: false,
      can_ceasefire: false,
      can_manage_members: false,
    },
    incoming_join_requests: [],
  };
}

function loadBoolPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    // ストレージアクセス不可環境では初期値を使用
  }
  return fallback;
}

function saveBoolPref(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // ignore
  }
}

function loadRecentColorsPref(): number[] {
  try {
    const raw = localStorage.getItem('teien_recent_colors');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 64)
      .slice(0, 8);
  } catch {
    return [];
  }
}

export function App() {
  const [routeAdmin, setRouteAdmin] = useState<boolean>(isAdminPath);

  useEffect(() => {
    const onPop = () => setRouteAdmin(isAdminPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigateTo = useCallback((path: '/' | '/admin') => {
    if (window.location.pathname !== path) {
      window.history.pushState({}, '', path);
    }
    setRouteAdmin(path === '/admin');
  }, []);

  if (routeAdmin) {
    return <LazyAdminPage onBackToMap={() => navigateTo('/')} />;
  }

  return <GameView onOpenAdmin={() => navigateTo('/admin')} />;
}

function GameView({ onOpenAdmin }: { onOpenAdmin: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const rendererRef = useRef<BoardGLRenderer | null>(null);
  const buffersRef = useRef<SharedBoardBuffers | null>(null);
  const netWorkerRef = useRef<Worker | null>(null);
  const logicWorkerRef = useRef<Worker | null>(null);
  const nextInspectReqIdRef = useRef(0);
  const hoverInspectReqIdRef = useRef(0);
  const selectInspectReqIdRef = useRef(0);
  const nextActionIdRef = useRef(0);
  const bufferGenRef = useRef(0);
  const labelGenRef = useRef(0);
  const refreshActiveInspectRef = useRef<() => void>(() => {});
  const lastMouseClientRef = useRef<{ x: number; y: number } | null>(null);
  const refreshHoverFromLastMouseRef = useRef<() => void>(() => {});
  const factionLabelsRef = useRef<FactionClusterAnchor[]>([]);
  const labelDirtyRef = useRef(true);
  const labelsStaleRef = useRef(false);
  const boardLabelVersionRef = useRef(0);
  const inFlightLabelBoardVersionRef = useRef(0);
  const labelRecomputeInFlightRef = useRef(false);
  const pendingFocusFactionRef = useRef<number | null>(null);
  const focusFactionAnchorRef = useRef<(fid: number) => void>(() => {});
  const recomputeTimerRef = useRef<number | null>(null);
  const initialUrlFocusedRef = useRef(false);
  const fxListRef = useRef<
    Array<{ x: number; y: number; text: string; color: string; startedAt: number }>
  >([]);
  const hoverInfoRef = useRef<HoverInfo | null>(null);
  const selectedInfoRef = useRef<HoverInfo | null>(null);
  const inspectListenersRef = useRef<Set<() => void>>(new Set());
  const minimapListenersRef = useRef<Set<() => void>>(new Set());

  const [season, setSeason] = useState<SeasonStatus>({
    season_id: 1,
    phase: 'active',
    tick_number: 0,
    max_ticks: 100,
    next_tick_unix: Math.floor(Date.now() / 1000) + 3600,
    online_count: 1,
    dev_mode: false,
    board_size: DEFAULT_BOARD_SIZE,
    map_params: {
      size: DEFAULT_BOARD_SIZE,
      continent_count: 1,
      island_count: 6,
      land_ratio_pct: 40,
      seed: 0,
    },
    size_limits: [],
  });
  const [boardSize, setBoardSize] = useState<number>(DEFAULT_BOARD_SIZE);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [factions, setFactions] = useState<FactionSummary[]>([]);
  const [factionRefreshSeq, setFactionRefreshSeq] = useState<number>(0);
  const [diplomacy, setDiplomacy] = useState<DiplomacyState>({
    wars: [],
    ceasefire_proposals: [],
  });
  const [overlayMode, setOverlayMode] = useState<OverlayMode>(0);
  const [showCoreMarker, setShowCoreMarker] = useState<boolean>(() =>
    loadBoolPref('teien_show_core_marker', true)
  );
  const [showFactionNames, setShowFactionNames] = useState<boolean>(() =>
    loadBoolPref('teien_show_faction_names', true)
  );
  const [mapSettingsOpen, setMapSettingsOpen] = useState<boolean>(false);
  const mapMenuRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const [actionMode, setActionMode] = useState<ActionMode>(0);
  const [selectedColorId, setSelectedColorId] = useState<number>(0);
  const [eyedropperActive, setEyedropperActive] = useState<boolean>(false);
  const [recentColors, setRecentColors] = useState<number[]>(loadRecentColorsPref);
  const [boardLoaded, setBoardLoaded] = useState<boolean>(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState<boolean>(false);
  const [selectedCell, setSelectedCell] = useState<{ x: number; y: number } | null>(null);
  const [pinnedFactionId, setPinnedFactionId] = useState<number>(0);
  const [confirmTapMode, setConfirmTapMode] = useState<boolean>(() =>
    loadBoolPref('teien_confirm_tap_mode', false)
  );
  const [soundMuted, setSoundMutedState] = useState<boolean>(isSoundMuted);
  const [browserNotifEnabled, setBrowserNotifEnabled] = useState<boolean>(() =>
    loadBoolPref('teien_browser_notif_enabled', false)
  );
  const browserNotifEnabledRef = useRef<boolean>(browserNotifEnabled);
  browserNotifEnabledRef.current = browserNotifEnabled;
  const [browserNotifUnsupported, setBrowserNotifUnsupported] = useState<boolean>(false);
  const browserNotifUnsupportedRef = useRef<boolean>(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [logoutConfirm, setLogoutConfirm] = useState<boolean>(false);
  const logoutConfirmTimerRef = useRef<number | null>(null);
  const [timelapseMode, setTimelapseMode] = useState<boolean>(false);
  const [timelapseFrames, setTimelapseFrames] = useState<TimelapseFrameMeta[]>([]);
  const [timelapseIndex, setTimelapseIndex] = useState<number>(0);
  const [timelapsePlaying, setTimelapsePlaying] = useState<boolean>(false);
  const [timelapseSpeed, setTimelapseSpeed] = useState<number>(1);
  const [timelapseLoading, setTimelapseLoading] = useState<boolean>(false);
  const [timelapseLoadFailed, setTimelapseLoadFailed] = useState<boolean>(false);
  const [timelapseRetrySeq, setTimelapseRetrySeq] = useState<number>(0);
  const [timelapseLoadedState, setTimelapseLoadedState] = useState<{
    key: string;
    startedAt: number;
  } | null>(null);
  const timelapseCacheRef = useRef<
    Map<number, { gpu: Uint8Array; raw: Uint8Array; boardSize: number }>
  >(new Map());
  const timelapseModeRef = useRef<boolean>(false);
  timelapseModeRef.current = timelapseMode;
  const [actionSeq, setActionSeq] = useState(0);
  const [logsLiveSignal, setLogsLiveSignal] = useState(0);
  const [logsResetSignal, setLogsResetSignal] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const hasWsConnectedOnceRef = useRef(false);
  const wsDisconnectToastShownRef = useRef(false);
  const wsDisconnectTimerRef = useRef<number | null>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastTimersRef = useRef<Map<number, number>>(new Map());
  const nextToastIdRef = useRef(0);
  const nextNotifIdRef = useRef(0);
  const notifSeqRef = useRef(0);
  const notifSeqMapRef = useRef<Map<string, number>>(new Map());
  // 解決済み参加申請の通知シーケンスを記録し、遅延 getMe() による幽霊通知を防ぐ
  const resolvedJoinReqSeqRef = useRef<Map<string, number>>(new Map());
  const joinPermRevokedSeqRef = useRef(0);
  const nextSelfAcceptTokenRef = useRef(0);
  const browserNotifBusyRef = useRef(false);
  const openNotificationsModalRef = useRef<() => void>(() => {});
  const unmountedRef = useRef(false);
  const activeBrowserNotifsRef = useRef<Set<Notification>>(new Set());
  const seasonInitializedRef = useRef(false);
  const recentSelfAcceptedCeasefireRef = useRef<
    Array<{
      token: number;
      fromFactionId: number;
      toFactionId: number;
      at: number;
      fallbackTimerId?: number;
      fallbackShown?: boolean;
    }>
  >([]);
  const prevUserFactionIdRef = useRef<number>(0);
  const timelapseAbortRef = useRef<AbortController | null>(null);
  const timelapseOpeningRef = useRef(false);
  const timelapseGenRef = useRef(0);
  const timelapsePendingBoardSizeRef = useRef<number | null>(null);
  const lastTimelapseGpuRef = useRef<{ gpu: Uint8Array; boardSize: number } | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const lastRefreshAtRef = useRef(0);
  const refreshGenRef = useRef(0);
  const seasonStatusGenRef = useRef(0);
  const userGenRef = useRef(0);
  const appliedUserGenRef = useRef(0);
  const listFactionsGenRef = useRef(0);
  const diplomacyGenRef = useRef(0);
  const inFlightRefreshRef = useRef<Promise<void> | null>(null);
  const pendingRefreshRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  const listFactionsTimerRef = useRef<number | null>(null);
  const diplomacyTimerRef = useRef<number | null>(null);
  const jitteredTickRefreshTimerRef = useRef<number | null>(null);
  const wsGenRef = useRef(1);

  const [modal, setModal] = useState<
    null | 'auth' | 'faction' | 'diplomacy' | 'ranking' | 'logs' | 'notifications' | 'help'
  >(null);
  const modalRef = useRef(modal);
  modalRef.current = modal;
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [pendingWar, setPendingWar] = useState<PendingWarAction | null>(null);
  const [pendingJoinFactionId, setPendingJoinFactionId] = useState<number | null>(null);
  // 送信アクションとサーバー応答 (STATUS_WAR_CONFIRM / OK / ERROR) のレースを防ぐ FIFO キュー
  const sentActionQueueRef = useRef<
    Array<{
      id: number;
      x: number;
      y: number;
      mode: ActionMode;
      colorId: number;
      costAp: number;
      costKnown: boolean;
    }>
  >([]);
  const [adminDebugMode, setAdminDebugModeState] = useState<boolean>(
    () => getAdminDebugMode()
  );

  // マウント時に管理者デバッグモードが有効な場合はセッション有効性を確認する
  useEffect(() => {
    if (!getAdminDebugMode()) return;
    api.adminMe().catch((err) => {
      if (err instanceof ApiError && err.status === 401) {
        setAdminDebugMode(false);
        setAdminDebugModeState(false);
      }
    });
  }, []);

  const myWarSet = useMemo(() => {
    const set = new Set<number>();
    const myFid = user?.faction_id ?? 0;
    if (myFid <= 0) return set;
    for (const w of diplomacy.wars) {
      if (w.faction_a === myFid) set.add(w.faction_b);
      if (w.faction_b === myFid) set.add(w.faction_a);
    }
    return set;
  }, [diplomacy.wars, user?.faction_id]);

  const stateRef = useRef({
    boardSize,
    user,
    factions,
    diplomacy,
    myWarSet,
    season,
    actionMode,
    selectedColorId,
    eyedropperActive,
    selectedCell,
    pinnedFactionId,
    confirmTapMode,
  });
  stateRef.current = {
    boardSize,
    user,
    factions,
    diplomacy,
    myWarSet,
    season,
    actionMode,
    selectedColorId,
    eyedropperActive,
    selectedCell,
    pinnedFactionId,
    confirmTapMode,
  };

  const subscribeInspect = useCallback((cb: () => void) => {
    inspectListenersRef.current.add(cb);
    return () => {
      inspectListenersRef.current.delete(cb);
    };
  }, []);

  const subscribeBoardChange = useCallback((cb: () => void) => {
    minimapListenersRef.current.add(cb);
    return () => {
      minimapListenersRef.current.delete(cb);
    };
  }, []);

  const notifyMinimapListeners = useCallback(() => {
    for (const cb of minimapListenersRef.current) {
      cb();
    }
  }, []);

  const getActiveInfo = useCallback((): HoverInfo | null => {
    const sel = stateRef.current.selectedCell;
    const selInfo = selectedInfoRef.current;
    if (sel) {
      return selInfo && selInfo.x === sel.x && selInfo.y === sel.y ? selInfo : null;
    }
    return hoverInfoRef.current;
  }, []);

  /** 選択セル・勢力点滅ハイライト・操作アクセント色を WebGL2 レンダラーへ同期 */
  const syncRendererHoverVisuals = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const cur = stateRef.current;
    const activeInfo = getActiveInfo();
    renderer.selectedX = cur.selectedCell?.x ?? -1;
    renderer.selectedY = cur.selectedCell?.y ?? -1;
    renderer.highlightFactionId =
      cur.pinnedFactionId > 0
        ? cur.pinnedFactionId
        : activeInfo && activeInfo.factionId > 0
          ? activeInfo.factionId
          : 0;

    if (cur.actionMode === 1) {
      const base = (cur.selectedColorId & 0x3f) * 3;
      renderer.hoverAccent = [
        PALETTE_RGB_FLOAT[base] ?? 0.98,
        PALETTE_RGB_FLOAT[base + 1] ?? 0.96,
        PALETTE_RGB_FLOAT[base + 2] ?? 0.75,
      ];
    } else if (!activeInfo || activeInfo.terrain !== 1 || !activeInfo.canExecute) {
      renderer.hoverAccent = [0.72, 0.76, 0.84];
    } else if (activeInfo.factionId === 0) {
      renderer.hoverAccent = [0.08, 0.85, 0.56];
    } else if (activeInfo.factionId === (cur.user?.faction_id ?? -1)) {
      renderer.hoverAccent = [0.25, 0.62, 1.0];
    } else if (activeInfo.needsWarConfirm) {
      renderer.hoverAccent = [0.98, 0.65, 0.12];
    } else {
      renderer.hoverAccent = [0.98, 0.28, 0.30];
    }
  }, [getActiveInfo]);

  const notifyInspectListeners = useCallback(() => {
    syncRendererHoverVisuals();
    for (const cb of inspectListenersRef.current) {
      cb();
    }
  }, [syncRendererHoverVisuals]);

  const addToast = useCallback(
    (
      text: string,
      kind: 'info' | 'success' | 'error' | 'war' = 'info',
      opts?: { title?: string; clickable?: boolean; sound?: boolean }
    ) => {
      if (unmountedRef.current) return;
      if (kind === 'error') {
        playErrorSound();
      } else if (kind === 'war' || kind === 'success' || opts?.sound) {
        playNoticeSound();
      }
      const id = ++nextToastIdRef.current;
      setToasts((prev) => {
        // 表示上限(5件)を超えて押し出されるトーストのタイマーを先に解除する
        if (prev.length >= 5) {
          for (const dropped of prev.slice(0, prev.length - 4)) {
            const droppedTimer = toastTimersRef.current.get(dropped.id);
            if (droppedTimer !== undefined) {
              window.clearTimeout(droppedTimer);
              toastTimersRef.current.delete(dropped.id);
            }
          }
        }
        return [
          ...prev.slice(-4),
          { id, text, kind, title: opts?.title, clickable: opts?.clickable },
        ];
      });
      const timerId = window.setTimeout(() => {
        toastTimersRef.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 5000);
      toastTimersRef.current.set(id, timerId);
    },
    []
  );

  const dismissToast = useCallback((id: number) => {
    const timerId = toastTimersRef.current.get(id);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      toastTimersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearToasts = useCallback(() => {
    for (const timerId of toastTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }
    toastTimersRef.current.clear();
    setToasts([]);
  }, []);

  const closeActiveBrowserNotifs = useCallback(() => {
    for (const n of activeBrowserNotifsRef.current) {
      n.onclick = null;
      n.onclose = null;
      n.onerror = null;
      try {
        n.close();
      } catch {
        // ignore
      }
    }
    activeBrowserNotifsRef.current.clear();
  }, []);

  const clearNotifications = useCallback(() => {
    notifSeqMapRef.current.clear();
    setNotifications([]);
  }, []);

  /** ブラウザ側で通知権限が取り消された場合、ローカル設定の ON 残留を同期解除する */
  const syncBrowserNotifPermission = useCallback(() => {
    const granted =
      typeof window !== 'undefined' &&
      'Notification' in window &&
      typeof Notification === 'function' &&
      Notification.permission === 'granted';
    if (!granted && browserNotifEnabledRef.current) {
      browserNotifEnabledRef.current = false;
      setBrowserNotifEnabled(false);
      saveBoolPref('teien_browser_notif_enabled', false);
      closeActiveBrowserNotifs();
    }
  }, [closeActiveBrowserNotifs]);

  useEffect(() => {
    syncBrowserNotifPermission();
    const onVis = () => {
      if (!document.hidden) {
        syncBrowserNotifPermission();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [syncBrowserNotifPermission]);

  const markActionNotificationsRead = useCallback(
    (actionKind: NonNullable<NotificationItem['actionKind']>, targetId?: number) => {
      setNotifications((prev) => {
        let changed = false;
        const next = prev.map((n) => {
          if (
            !n.read &&
            n.actionKind === actionKind &&
            (targetId === undefined || n.actionTargetId === undefined || n.actionTargetId === targetId)
          ) {
            changed = true;
            return { ...n, read: true };
          }
          return n;
        });
        return changed ? next : prev;
      });
    },
    []
  );

  /** リクエスト開始時点以前に生成された未読参加申請通知のうち、権限喪失またはサーバー上でもう存在しないものを既読化する */
  const reconcileJoinRequestNotifications = useCallback((me: UserProfile, seqAtStart: number) => {
    const canManage = Boolean(me.faction_id > 0 && me.permissions.can_manage_members);
    const activeUserIds = canManage
      ? new Set((me.incoming_join_requests ?? []).map((r) => r.user_id))
      : null;
    setNotifications((prev) => {
      let changed = false;
      const next = prev.map((n) => {
        if (
          !n.read &&
          n.actionKind === 'join_request' &&
          (notifSeqMapRef.current.get(n.id) ?? 0) <= seqAtStart &&
          (!canManage || (n.actionTargetId !== undefined && !activeUserIds!.has(n.actionTargetId)))
        ) {
          changed = true;
          return { ...n, read: true };
        }
        return n;
      });
      return changed ? next : prev;
    });
  }, []);

  /** リクエスト開始時点以前に生成された未読停戦提案通知のうち、無所属化・停戦権限喪失・またはサーバー上でもう存在しないものを既読化する */
  const reconcileCeasefireNotifications = useCallback(
    (d: DiplomacyState, myFactionId: number, canCeasefire: boolean, seqAtStart: number) => {
      const canAct = myFactionId > 0 && canCeasefire;
      const activeFromIds = canAct
        ? new Set(
            d.ceasefire_proposals
              .filter((p) => p.to_faction_id === myFactionId)
              .map((p) => p.from_faction_id)
          )
        : null;
      setNotifications((prev) => {
        let changed = false;
        const next = prev.map((n) => {
          if (
            !n.read &&
            n.actionKind === 'ceasefire_offer' &&
            (notifSeqMapRef.current.get(n.id) ?? 0) <= seqAtStart &&
            (!canAct || (n.actionTargetId !== undefined && !activeFromIds!.has(n.actionTargetId)))
          ) {
            changed = true;
            return { ...n, read: true };
          }
          return n;
        });
        return changed ? next : prev;
      });
    },
    []
  );

  const clearSelfAcceptCeasefireEntries = useCallback(() => {
    for (const item of recentSelfAcceptedCeasefireRef.current) {
      if (item.fallbackTimerId !== undefined) {
        window.clearTimeout(item.fallbackTimerId);
      }
    }
    recentSelfAcceptedCeasefireRef.current = [];
  }, []);

  const beginSelfAcceptCeasefire = useCallback((fromFactionId: number): number | null => {
    const myFid = stateRef.current.user?.faction_id ?? 0;
    if (myFid <= 0) return null;
    const token = ++nextSelfAcceptTokenRef.current;
    const now = Date.now();
    const kept: typeof recentSelfAcceptedCeasefireRef.current = [];
    for (const item of recentSelfAcceptedCeasefireRef.current) {
      if (now - item.at < 15000) {
        kept.push(item);
      } else if (item.fallbackTimerId !== undefined) {
        window.clearTimeout(item.fallbackTimerId);
      }
    }
    kept.push({ token, fromFactionId, toFactionId: myFid, at: now });
    recentSelfAcceptedCeasefireRef.current = kept;
    return token;
  }, []);

  const cancelSelfAcceptCeasefire = useCallback((token: number | null) => {
    if (token === null) return;
    recentSelfAcceptedCeasefireRef.current = recentSelfAcceptedCeasefireRef.current.filter(
      (item) => {
        if (item.token === token) {
          if (item.fallbackTimerId !== undefined) {
            window.clearTimeout(item.fallbackTimerId);
          }
          return false;
        }
        return true;
      }
    );
  }, []);

  /** WS の ceasefire_accepted が遅延・欠落した場合に備え、一定時間後（または即時）にフォールバックトーストを表示する */
  const confirmSelfAcceptCeasefire = useCallback(
    (token: number | null, fallbackMessage = '停戦協定が成立しました', immediate = false) => {
      if (token === null || unmountedRef.current) return;
      const entry = recentSelfAcceptedCeasefireRef.current.find((item) => item.token === token);
      if (!entry) return;
      if (immediate) {
        if (entry.fallbackTimerId !== undefined) {
          window.clearTimeout(entry.fallbackTimerId);
          entry.fallbackTimerId = undefined;
        }
        if (!entry.fallbackShown) {
          entry.fallbackShown = true;
          addToast(fallbackMessage, 'success');
        }
        return;
      }
      if (entry.fallbackTimerId !== undefined || entry.fallbackShown) return;
      entry.fallbackTimerId = window.setTimeout(() => {
        if (unmountedRef.current) return;
        const target = recentSelfAcceptedCeasefireRef.current.find(
          (item) => item.token === token
        );
        if (!target) return;
        target.fallbackTimerId = undefined;
        if (target.fallbackShown) return;
        target.fallbackShown = true;
        addToast(fallbackMessage, 'success');
      }, 1500);
    },
    [addToast]
  );

  const handleCeasefireResponded = useCallback(
    (fromFactionId: number, _accept: boolean) => {
      markActionNotificationsRead('ceasefire_offer', fromFactionId);
    },
    [markActionNotificationsRead]
  );

  const handleJoinRequestResolved = useCallback(
    (applicantUserId: number) => {
      const fid = stateRef.current.user?.faction_id ?? 0;
      if (fid > 0) {
        const key = `${fid}:${applicantUserId}`;
        resolvedJoinReqSeqRef.current.set(key, ++notifSeqRef.current);
        if (resolvedJoinReqSeqRef.current.size > 200) {
          const oldestKey = resolvedJoinReqSeqRef.current.keys().next().value;
          if (oldestKey !== undefined) {
            resolvedJoinReqSeqRef.current.delete(oldestKey);
          }
        }
      }
      markActionNotificationsRead('join_request', applicantUserId);
    },
    [markActionNotificationsRead]
  );

  const pushNotification = useCallback(
    (
      kind: NotificationItem['kind'],
      title: string,
      message: string,
      toastKind: 'info' | 'success' | 'error' | 'war' = 'info',
      opts?: {
        actionKind?: NotificationItem['actionKind'];
        actionTargetId?: number;
        read?: boolean;
        sound?: boolean;
        seqOverride?: number;
        skipToast?: boolean;
      }
    ) => {
      if (unmountedRef.current) return;
      const seq = opts?.seqOverride ?? ++notifSeqRef.current;
      const item: NotificationItem = {
        id: `${Date.now()}-${++nextNotifIdRef.current}`,
        kind,
        title,
        message,
        createdAt: new Date().toISOString(),
        read: opts?.read ?? false,
        ...(opts?.actionKind ? { actionKind: opts.actionKind } : {}),
        ...(opts?.actionTargetId !== undefined ? { actionTargetId: opts.actionTargetId } : {}),
      };
      notifSeqMapRef.current.set(item.id, seq);
      setNotifications((prev) => {
        const merged = [item, ...prev];
        if (merged.length > 60) {
          for (const dropped of merged.slice(60)) {
            notifSeqMapRef.current.delete(dropped.id);
          }
          return merged.slice(0, 60);
        }
        return merged;
      });
      if (!opts?.skipToast) {
        addToast(message, toastKind, { title, clickable: true, sound: opts?.sound });
      }
      if (
        !opts?.read &&
        browserNotifEnabledRef.current &&
        !browserNotifUnsupportedRef.current &&
        typeof window !== 'undefined' &&
        'Notification' in window &&
        typeof Notification === 'function' &&
        Notification.permission === 'granted' &&
        typeof document !== 'undefined' &&
        document.hidden
      ) {
        try {
          const n = new Notification(`庭園勢力図 - ${title}`, {
            body: message,
            tag: item.id,
          });
          activeBrowserNotifsRef.current.add(n);
          n.onclose = () => {
            activeBrowserNotifsRef.current.delete(n);
          };
          n.onerror = () => {
            activeBrowserNotifsRef.current.delete(n);
          };
          n.onclick = () => {
            activeBrowserNotifsRef.current.delete(n);
            if (unmountedRef.current) {
              n.close();
              return;
            }
            window.focus();
            openNotificationsModalRef.current();
            n.close();
          };
        } catch {
          // Android Chrome 等 new Notification 非対応環境で ON 張り付きにならないよう即時 ref も同期無効化する
          browserNotifUnsupportedRef.current = true;
          setBrowserNotifUnsupported(true);
          browserNotifEnabledRef.current = false;
          setBrowserNotifEnabled(false);
          saveBoolPref('teien_browser_notif_enabled', false);
        }
      }
    },
    [addToast]
  );

  /** new Notification() コンストラクタが実際に動作するかテスト発火してブラウザ通知を有効化する */
  const tryEnableBrowserNotifWithTest = useCallback(() => {
    if (unmountedRef.current) return;
    if (browserNotifUnsupportedRef.current || typeof Notification !== 'function') {
      browserNotifUnsupportedRef.current = true;
      setBrowserNotifUnsupported(true);
      browserNotifEnabledRef.current = false;
      setBrowserNotifEnabled(false);
      saveBoolPref('teien_browser_notif_enabled', false);
      addToast('このブラウザはデスクトップ通知に対応していません', 'error');
      return;
    }
    try {
      const n = new Notification('庭園勢力図', {
        body: 'ブラウザ通知を有効にしました（タブ非表示時に通知します）',
        tag: 'teien-browser-notif-test',
      });
      activeBrowserNotifsRef.current.add(n);
      n.onclose = () => {
        activeBrowserNotifsRef.current.delete(n);
      };
      n.onerror = () => {
        activeBrowserNotifsRef.current.delete(n);
      };
      n.onclick = () => {
        activeBrowserNotifsRef.current.delete(n);
        if (unmountedRef.current) {
          n.close();
          return;
        }
        window.focus();
        n.close();
      };
      browserNotifEnabledRef.current = true;
      setBrowserNotifEnabled(true);
      saveBoolPref('teien_browser_notif_enabled', true);
      addToast('ブラウザ通知を ON にしました（タブ非表示時に通知します）', 'success');
    } catch {
      browserNotifUnsupportedRef.current = true;
      setBrowserNotifUnsupported(true);
      browserNotifEnabledRef.current = false;
      setBrowserNotifEnabled(false);
      saveBoolPref('teien_browser_notif_enabled', false);
      addToast('このブラウザはデスクトップ通知に対応していません', 'error');
    }
  }, [addToast]);

  const toggleBrowserNotif = useCallback(async () => {
    if (browserNotifBusyRef.current) return;
    if (
      browserNotifUnsupportedRef.current ||
      typeof window === 'undefined' ||
      !('Notification' in window) ||
      typeof Notification !== 'function'
    ) {
      syncBrowserNotifPermission();
      addToast('このブラウザはデスクトップ通知に対応していません', 'error');
      return;
    }
    if (browserNotifEnabledRef.current && Notification.permission === 'granted') {
      browserNotifEnabledRef.current = false;
      setBrowserNotifEnabled(false);
      saveBoolPref('teien_browser_notif_enabled', false);
      closeActiveBrowserNotifs();
      addToast('ブラウザ通知を OFF にしました', 'info');
      return;
    }
    if (Notification.permission === 'granted') {
      tryEnableBrowserNotifWithTest();
      return;
    }
    if (Notification.permission === 'denied') {
      syncBrowserNotifPermission();
      addToast(
        'ブラウザの通知権限がブロックされています。ブラウザの設定から許可してください',
        'error'
      );
      return;
    }
    browserNotifBusyRef.current = true;
    try {
      const perm = await Notification.requestPermission();
      if (unmountedRef.current) return;
      if (perm === 'granted') {
        tryEnableBrowserNotifWithTest();
      } else {
        syncBrowserNotifPermission();
        addToast('ブラウザ通知の許可が得られませんでした', 'info');
      }
    } catch {
      if (unmountedRef.current) return;
      syncBrowserNotifPermission();
      addToast('ブラウザ通知の許可リクエストに失敗しました', 'error');
    } finally {
      browserNotifBusyRef.current = false;
    }
  }, [addToast, closeActiveBrowserNotifs, syncBrowserNotifPermission, tryEnableBrowserNotifWithTest]);

  // フェーズ遷移を検知して通知する（初回ロードおよびシーズン切替直後は通知しない）
  const knownPhaseRef = useRef<SeasonPhase | null>(null);
  const knownSeasonIdRef = useRef<number | null>(null);
  const syncPhaseAndNotify = useCallback(
    (nextPhase: SeasonPhase, nextSeasonId: number) => {
      if (knownPhaseRef.current === null || knownSeasonIdRef.current !== nextSeasonId) {
        knownPhaseRef.current = nextPhase;
        knownSeasonIdRef.current = nextSeasonId;
        return;
      }
      if (knownPhaseRef.current !== nextPhase) {
        knownPhaseRef.current = nextPhase;
        if (nextPhase === 'preparation') {
          pushNotification(
            'info',
            '準備フェーズ',
            '準備フェーズに移行しました（既存勢力への参加や参加申請・承認が可能です）',
            'info'
          );
        } else if (nextPhase === 'active') {
          pushNotification(
            'info',
            '進行中フェーズ開始',
            '進行中フェーズに移行しました！領土の塗りと開戦が可能です',
            'success'
          );
        } else if (nextPhase === 'frozen') {
          pushNotification(
            'info',
            '凍結フェーズ移行',
            '凍結（結果発表）フェーズに移行しました。盤面操作・外交は終了です',
            'war'
          );
        }
      }
    },
    [pushNotification]
  );

  // 終盤ブースト突入を検知して初回のみ通知する
  const knownEndgameBoostRef = useRef<boolean | null>(null);
  const knownEndgameSeasonIdRef = useRef<number | null>(null);
  const syncEndgameBoostAndNotify = useCallback(
    (nextBoost: boolean | undefined, nextSeasonId: number, nextMultiplier?: number) => {
      if (typeof nextBoost !== 'boolean') return;
      if (knownEndgameBoostRef.current === null || knownEndgameSeasonIdRef.current !== nextSeasonId) {
        knownEndgameBoostRef.current = nextBoost;
        knownEndgameSeasonIdRef.current = nextSeasonId;
        return;
      }
      if (!knownEndgameBoostRef.current && nextBoost) {
        knownEndgameBoostRef.current = true;
        const mult = nextMultiplier ?? stateRef.current.season.ap_config?.endgame_ap_multiplier ?? 2;
        pushNotification(
          'info',
          '終盤ブースト開始！',
          `シーズン終盤に突入しました！AP補充量と上限が ${mult} 倍になります`,
          'war'
        );
      } else if (!nextBoost) {
        knownEndgameBoostRef.current = false;
      }
    },
    [pushNotification]
  );

  const factionMap = useMemo(() => new Map(factions.map((f) => [f.id, f])), [factions]);

  const cancelPendingMetadataRefresh = useCallback(() => {
    refreshGenRef.current += 1;
    seasonStatusGenRef.current += 1;
    userGenRef.current += 1;
    listFactionsGenRef.current += 1;
    diplomacyGenRef.current += 1;
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    if (listFactionsTimerRef.current !== null) {
      window.clearTimeout(listFactionsTimerRef.current);
      listFactionsTimerRef.current = null;
    }
    if (diplomacyTimerRef.current !== null) {
      window.clearTimeout(diplomacyTimerRef.current);
      diplomacyTimerRef.current = null;
    }
    if (jitteredTickRefreshTimerRef.current !== null) {
      window.clearTimeout(jitteredTickRefreshTimerRef.current);
      jitteredTickRefreshTimerRef.current = null;
    }
    pendingRefreshRef.current?.resolve();
    pendingRefreshRef.current = null;
  }, []);

  const buildWsUrl = useCallback(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }, []);

  // 401 セッション失効時、直前までログイン状態だった場合のみ私的 UI 状態と WS 認証をリセットする
  const resetPrivateStateOnAuthLoss = useCallback(() => {
    const wasLoggedIn = stateRef.current.user !== null;
    // 並列リクエストの連続 401 で二重リセットが走らないよう即座に同期クリアする
    stateRef.current = { ...stateRef.current, user: null };
    if (logoutConfirmTimerRef.current !== null) {
      window.clearTimeout(logoutConfirmTimerRef.current);
      logoutConfirmTimerRef.current = null;
    }
    setLogoutConfirm(false);
    setUser(null);
    setPendingWar(null);
    setPendingJoinFactionId(null);
    if (wasLoggedIn) {
      authGenRef.current += 1;
      clearToasts();
      clearNotifications();
      closeActiveBrowserNotifs();
      clearSelfAcceptCeasefireEntries();
      resolvedJoinReqSeqRef.current.clear();
      joinPermRevokedSeqRef.current = 0;
      if (modalRef.current === 'notifications') {
        setModal(null);
      }
      setPinnedFactionId(0);
      sentActionQueueRef.current = [];
      const inv = ++nextInspectReqIdRef.current;
      hoverInspectReqIdRef.current = inv;
      selectInspectReqIdRef.current = inv;
      netWorkerRef.current?.postMessage({
        type: 'reconnect',
        wsUrl: buildWsUrl(),
        wsGen: ++wsGenRef.current,
      });
    }
  }, [buildWsUrl, clearNotifications, clearSelfAcceptCeasefireEntries, clearToasts, closeActiveBrowserNotifs]);

  const refreshUserOnly = useCallback(async (): Promise<UserProfile | null> => {
    const uGen = ++userGenRef.current;
    const seqAtStart = notifSeqRef.current;
    try {
      const me = await api.getMe();
      if (uGen !== userGenRef.current) return null;
      appliedUserGenRef.current = uGen;
      stateRef.current = { ...stateRef.current, user: me };
      setUser(me);
      reconcileJoinRequestNotifications(me, seqAtStart);
      reconcileCeasefireNotifications(
        stateRef.current.diplomacy,
        me.faction_id,
        Boolean(me.permissions.can_ceasefire),
        seqAtStart
      );
      return me;
    } catch (err) {
      if (uGen !== userGenRef.current) return null;
      if (err instanceof ApiError && err.status === 401) {
        resetPrivateStateOnAuthLoss();
      }
      return null;
    }
  }, [reconcileCeasefireNotifications, reconcileJoinRequestNotifications, resetPrivateStateOnAuthLoss]);

  const executeRefreshMetadata = useCallback(async () => {
    const gen = ++refreshGenRef.current;
    const sGen = ++seasonStatusGenRef.current;
    const uGen = ++userGenRef.current;
    const fGen = ++listFactionsGenRef.current;
    const dGen = ++diplomacyGenRef.current;
    const seqAtStart = notifSeqRef.current;
    lastRefreshAtRef.current = Date.now();
    let latestDiplomacy: DiplomacyState | null = null;
    try {
      const [s, f, d] = await Promise.all([
        api.getSeasonStatus(),
        api.listFactions(),
        api.getDiplomacy(),
      ]);
      if (gen !== refreshGenRef.current) return;
      if (sGen === seasonStatusGenRef.current) {
        seasonInitializedRef.current = true;
        setSeason(s);
        syncPhaseAndNotify(s.phase, s.season_id);
        syncEndgameBoostAndNotify(
          s.endgame_boost_active,
          s.season_id,
          s.ap_config?.endgame_ap_multiplier
        );
      } else {
        // WS で新しい状態を受信済みの場合はフェーズや終盤ブーストの通知・上書きは行わず、未初期化の静的設定のみ補完する
        setSeason((prev) => {
          if (prev.ap_config !== undefined || s.season_id !== prev.season_id) {
            return prev;
          }
          return {
            ...s,
            phase: prev.phase,
            tick_number: prev.tick_number,
            next_tick_unix: prev.next_tick_unix,
            season_id: prev.season_id,
            ...(prev.endgame_boost_active !== undefined
              ? { endgame_boost_active: prev.endgame_boost_active }
              : {}),
            ...(prev.effective_max_ap !== undefined
              ? { effective_max_ap: prev.effective_max_ap }
              : {}),
            ...(prev.cost_config !== undefined ? { cost_config: prev.cost_config } : {}),
            ...(prev.ap_config !== undefined ? { ap_config: prev.ap_config } : {}),
            ...(prev.game_rules !== undefined ? { game_rules: prev.game_rules } : {}),
            ...(prev.faction_name_max_len !== undefined
              ? { faction_name_max_len: prev.faction_name_max_len }
              : {}),
          };
        });
      }
      if (fGen === listFactionsGenRef.current) {
        setFactions(f);
      }
      if (dGen === diplomacyGenRef.current) {
        latestDiplomacy = d;
        setDiplomacy(d);
        reconcileCeasefireNotifications(
          d,
          stateRef.current.user?.faction_id ?? 0,
          Boolean(stateRef.current.user?.permissions.can_ceasefire),
          seqAtStart
        );
      }
    } catch {
      // 一時エラーは無視
    }
    const userSeqAtStart = notifSeqRef.current;
    try {
      const me = await api.getMe();
      if (gen !== refreshGenRef.current || uGen !== userGenRef.current) return;
      appliedUserGenRef.current = uGen;
      stateRef.current = { ...stateRef.current, user: me };
      setUser(me);
      reconcileJoinRequestNotifications(me, userSeqAtStart);
      if (latestDiplomacy) {
        reconcileCeasefireNotifications(
          latestDiplomacy,
          me.faction_id,
          Boolean(me.permissions.can_ceasefire),
          seqAtStart
        );
      }
    } catch (err) {
      if (gen !== refreshGenRef.current || uGen !== userGenRef.current) return;
      // 401 認証エラーの場合のみログアウト扱いとし、一時的な通信エラーや429は無視する
      if (err instanceof ApiError && err.status === 401) {
        resetPrivateStateOnAuthLoss();
      }
    }
  }, [
    reconcileCeasefireNotifications,
    reconcileJoinRequestNotifications,
    resetPrivateStateOnAuthLoss,
    syncEndgameBoostAndNotify,
    syncPhaseAndNotify,
  ]);

  // 連続イベント受信時の過剰リクエストを防ぐ 300ms スロットル（force=true で即時実行、通信中の要求は trailing で再取得）
  const refreshMetadata = useCallback(
    async (force = false): Promise<void> => {
      const runNow = (): Promise<void> => {
        const p = executeRefreshMetadata().finally(() => {
          // 最新のリクエスト完了時のみ後続の pendingRefreshRef をスケジューリングする
          if (inFlightRefreshRef.current !== p) return;
          inFlightRefreshRef.current = null;
          // 通信中に後続の更新要求が予約されていれば、スロットル間隔を守って 1 回だけ再実行する
          if (pendingRefreshRef.current && refreshTimerRef.current === null) {
            const waitMs = Math.max(0, 300 - (Date.now() - lastRefreshAtRef.current));
            if (waitMs === 0) {
              const nextPending = pendingRefreshRef.current;
              pendingRefreshRef.current = null;
              void runNow().finally(() => {
                nextPending.resolve();
              });
            } else {
              refreshTimerRef.current = window.setTimeout(() => {
                refreshTimerRef.current = null;
                const nextPending = pendingRefreshRef.current;
                pendingRefreshRef.current = null;
                void runNow().finally(() => {
                  nextPending?.resolve();
                });
              }, waitMs);
            }
          }
        });
        inFlightRefreshRef.current = p;
        return p;
      };

      if (force) {
        if (refreshTimerRef.current !== null) {
          window.clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = null;
        }
        const pending = pendingRefreshRef.current;
        pendingRefreshRef.current = null;
        try {
          await runNow();
        } finally {
          pending?.resolve();
        }
        return;
      }

      const elapsed = Date.now() - lastRefreshAtRef.current;
      if (elapsed >= 300 && !inFlightRefreshRef.current) {
        if (refreshTimerRef.current !== null) {
          window.clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = null;
        }
        const pending = pendingRefreshRef.current;
        pendingRefreshRef.current = null;
        try {
          await runNow();
        } finally {
          pending?.resolve();
        }
        return;
      }

      if (pendingRefreshRef.current) {
        return pendingRefreshRef.current.promise;
      }

      let resolveFn!: () => void;
      const promise = new Promise<void>((resolve) => {
        resolveFn = resolve;
      });
      pendingRefreshRef.current = { promise, resolve: resolveFn };

      // inFlightRefreshRef が存在しない（elapsed < 300 で待機中）場合のみタイマーをセットする
      if (!inFlightRefreshRef.current && refreshTimerRef.current === null) {
        refreshTimerRef.current = window.setTimeout(() => {
          refreshTimerRef.current = null;
          const pending = pendingRefreshRef.current;
          pendingRefreshRef.current = null;
          void runNow().finally(() => {
            pending?.resolve();
          });
        }, Math.max(0, 300 - elapsed));
      }

      return promise;
    },
    [executeRefreshMetadata]
  );

  const forceRefreshMetadata = useCallback(() => refreshMetadata(true), [refreshMetadata]);

  // ティック同期・定期補充時の Thundering Herd を防ぐため 0〜2,000ms のジッター付きで 1 回に統合して再取得する
  const scheduleJitteredMetadataRefresh = useCallback(() => {
    if (jitteredTickRefreshTimerRef.current !== null) return;
    const delay = Math.floor(Math.random() * 2000);
    jitteredTickRefreshTimerRef.current = window.setTimeout(() => {
      jitteredTickRefreshTimerRef.current = null;
      void refreshMetadata();
    }, delay);
  }, [refreshMetadata]);

  const scheduleListFactions = useCallback(() => {
    if (listFactionsTimerRef.current !== null) {
      window.clearTimeout(listFactionsTimerRef.current);
    }
    const gen = ++listFactionsGenRef.current;
    listFactionsTimerRef.current = window.setTimeout(() => {
      listFactionsTimerRef.current = null;
      api
        .listFactions()
        .then((list) => {
          if (gen === listFactionsGenRef.current) {
            setFactions(list);
          }
        })
        .catch(() => {});
    }, 300);
  }, []);

  // 当事者限定の停戦提案・却下はトースト即クリック時に空表示にならないよう即時再取得する
  const refreshDiplomacyNow = useCallback(async () => {
    if (diplomacyTimerRef.current !== null) {
      window.clearTimeout(diplomacyTimerRef.current);
      diplomacyTimerRef.current = null;
    }
    const gen = ++diplomacyGenRef.current;
    const seqAtStart = notifSeqRef.current;
    try {
      const d = await api.getDiplomacy();
      if (gen === diplomacyGenRef.current) {
        setDiplomacy(d);
        reconcileCeasefireNotifications(
          d,
          stateRef.current.user?.faction_id ?? 0,
          Boolean(stateRef.current.user?.permissions.can_ceasefire),
          seqAtStart
        );
      }
    } catch {
      // 一時エラーは無視
    }
  }, [reconcileCeasefireNotifications]);

  // 外交イベント集中時の Thundering Herd を防ぐため 0〜2,000ms のジッター付きで /api/diplomacy のみ再取得する
  const scheduleJitteredDiplomacyRefresh = useCallback(() => {
    if (diplomacyTimerRef.current !== null) return;
    const delay = Math.floor(Math.random() * 2000);
    diplomacyTimerRef.current = window.setTimeout(() => {
      diplomacyTimerRef.current = null;
      const gen = ++diplomacyGenRef.current;
      const seqAtStart = notifSeqRef.current;
      api
        .getDiplomacy()
        .then((d) => {
          if (gen === diplomacyGenRef.current) {
            setDiplomacy(d);
            reconcileCeasefireNotifications(
              d,
              stateRef.current.user?.faction_id ?? 0,
              Boolean(stateRef.current.user?.permissions.can_ceasefire),
              seqAtStart
            );
          }
        })
        .catch(() => {});
    }, delay);
  }, [reconcileCeasefireNotifications]);

  const clearScheduledLabelRecompute = useCallback(() => {
    if (recomputeTimerRef.current !== null) {
      window.clearTimeout(recomputeTimerRef.current);
      recomputeTimerRef.current = null;
    }
  }, []);

  const clearHoverState = useCallback(() => {
    if (rendererRef.current) {
      rendererRef.current.hoverX = -1;
      rendererRef.current.hoverY = -1;
    }
    hoverInspectReqIdRef.current = ++nextInspectReqIdRef.current;
    if (hoverInfoRef.current !== null) {
      hoverInfoRef.current = null;
      notifyInspectListeners();
    }
  }, [notifyInspectListeners]);

  /** 指定サイズで共有バッファ・WebGLテクスチャ・Workerを再構成してスナップショット再取得 */
  const reallocateForBoardSize = useCallback(
    (nextSize: number) => {
      if (!Number.isInteger(nextSize) || nextSize < 16 || nextSize > MAX_BOARD_SIZE) {
        addToast(`不正な盤面サイズを受信しました: ${String(nextSize)}`, 'error');
        return;
      }
      clearScheduledLabelRecompute();
      const buffers = createBoardBuffers(nextSize);
      buffersRef.current = buffers;
      setBoardSize(nextSize);
      setBoardLoaded(false);
      clearHoverState();
      setSelectedCell(null);
      selectedInfoRef.current = null;
      notifyInspectListeners();
      setPendingWar(null);
      setPendingJoinFactionId(null);
      factionLabelsRef.current = [];
      labelDirtyRef.current = true;
      labelsStaleRef.current = false;
      boardLabelVersionRef.current += 1;
      inFlightLabelBoardVersionRef.current = boardLabelVersionRef.current;
      labelRecomputeInFlightRef.current = false;
      pendingFocusFactionRef.current = null;
      rendererRef.current?.requestRender();

      // 再確保前に送信された旧 inspect 応答を無効化する
      const invalidatedReqId = ++nextInspectReqIdRef.current;
      hoverInspectReqIdRef.current = invalidatedReqId;
      selectInspectReqIdRef.current = invalidatedReqId;

      // 同サイズ再確保時でも保留アップロードと選択状態を確実にリセットする
      rendererRef.current?.resizeBoard(nextSize, true);

      if (buffers.sabEnabled) {
        logicWorkerRef.current?.postMessage({
          type: 'init',
          boardSize: nextSize,
          rawCellsBuffer: buffers.rawCellsBuffer,
          ctrlBuffer: buffers.ctrlBuffer,
          skipInitialLabels: true,
        });
      } else {
        // 非 SAB モードでも旧盤面での誤インスペクトを防ぐためバッファ参照をリセットする
        logicWorkerRef.current?.postMessage({
          type: 'init',
          boardSize: nextSize,
          skipInitialLabels: true,
        });
      }

      const bufferGen = ++bufferGenRef.current;
      labelGenRef.current++;
      netWorkerRef.current?.postMessage({
        type: 'resizeBuffers',
        boardSize: nextSize,
        sabEnabled: buffers.sabEnabled,
        rawCellsBuffer: buffers.sabEnabled ? buffers.rawCellsBuffer : undefined,
        gpuTexBuffer: buffers.sabEnabled ? buffers.gpuTexBuffer : undefined,
        ctrlBuffer: buffers.ctrlBuffer,
        snapshotUrl: '/api/board/snapshot',
        bufferGen,
      });
      notifyMinimapListeners();
    },
    [addToast, clearHoverState, clearScheduledLabelRecompute, notifyInspectListeners, notifyMinimapListeners]
  );

  // WebGL2 レンダラー + Network Worker + Logic Worker 初期化
  useEffect(() => {
    unmountedRef.current = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const buffers = createBoardBuffers(DEFAULT_BOARD_SIZE);
    buffersRef.current = buffers;

    let renderer: BoardGLRenderer;
    try {
      renderer = new BoardGLRenderer(canvas, DEFAULT_BOARD_SIZE);
    } catch (err) {
      setGlError(err instanceof Error ? err.message : 'お使いのブラウザは WebGL2 に対応していません');
      return;
    }
    rendererRef.current = renderer;

    renderer.onContextRestored = () => {
      if (timelapseModeRef.current) {
        const tl = lastTimelapseGpuRef.current;
        if (tl) {
          renderer.uploadFullBoard(tl.gpu, tl.boardSize);
        }
      } else {
        const curBuf = buffersRef.current;
        if (curBuf) {
          renderer.uploadFullBoard(curBuf.gpuTex, curBuf.boardSize, curBuf.ctrl);
        }
      }
      const cur = stateRef.current;
      renderer.updateFactionMetadata(cur.factions, cur.user?.faction_id ?? 0, cur.myWarSet);
    };

    const onResize = () => renderer.resize();
    window.addEventListener('resize', onResize);

    const netWorker = new Worker(new URL('../workers/network.worker.ts', import.meta.url), {
      type: 'module',
    });
    const logicWorker = new Worker(new URL('../workers/logic.worker.ts', import.meta.url), {
      type: 'module',
    });
    netWorkerRef.current = netWorker;
    logicWorkerRef.current = logicWorker;

    netWorker.onerror = (ev) => {
      addToast(`通信ワーカーエラー: ${ev.message || '不明なエラー'}`, 'error');
    };
    logicWorker.onerror = (ev) => {
      addToast(`計算ワーカーエラー: ${ev.message || '不明なエラー'}`, 'error');
    };

    if (buffers.sabEnabled) {
      logicWorker.postMessage({
        type: 'init',
        boardSize: DEFAULT_BOARD_SIZE,
        rawCellsBuffer: buffers.rawCellsBuffer,
        ctrlBuffer: buffers.ctrlBuffer,
        skipInitialLabels: true,
      });
    }

    logicWorker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data;
      if (msg.type === 'inspectResult') {
        const info = msg.info as HoverInfo | null;
        if (msg.requestId === hoverInspectReqIdRef.current) {
          hoverInfoRef.current = info;
          const sel = stateRef.current.selectedCell;
          if (sel && info && info.x === sel.x && info.y === sel.y) {
            selectedInfoRef.current = info;
          }
          notifyInspectListeners();
        } else if (msg.requestId === selectInspectReqIdRef.current) {
          selectedInfoRef.current = info;
          notifyInspectListeners();
        }
      } else if (msg.type === 'factionLabels') {
        if (msg.labelGen !== undefined && msg.labelGen !== labelGenRef.current) return;
        factionLabelsRef.current = msg.labels as FactionClusterAnchor[];
        labelRecomputeInFlightRef.current = false;
        const hasNewerBoardChange =
          !timelapseModeRef.current &&
          inFlightLabelBoardVersionRef.current !== boardLabelVersionRef.current;
        labelsStaleRef.current = hasNewerBoardChange;
        labelDirtyRef.current = true;
        renderer.requestRender();
        if (pendingFocusFactionRef.current !== null && !timelapseModeRef.current) {
          if (hasNewerBoardChange && logicWorkerRef.current) {
            clearScheduledLabelRecompute();
            labelsStaleRef.current = false;
            labelRecomputeInFlightRef.current = true;
            inFlightLabelBoardVersionRef.current = boardLabelVersionRef.current;
            const labelGen = ++labelGenRef.current;
            logicWorkerRef.current.postMessage({ type: 'recomputeLabels', labelGen });
          } else {
            const targetFid = pendingFocusFactionRef.current;
            pendingFocusFactionRef.current = null;
            focusFactionAnchorRef.current(targetFid);
          }
        }
      } else if (msg.type === 'factionLabelsFailed') {
        if (msg.labelGen !== undefined && msg.labelGen !== labelGenRef.current) return;
        labelRecomputeInFlightRef.current = false;
        if (!timelapseModeRef.current) {
          labelsStaleRef.current = true;
        }
        if (pendingFocusFactionRef.current !== null) {
          const targetFid = pendingFocusFactionRef.current;
          pendingFocusFactionRef.current = null;
          if (!timelapseModeRef.current) {
            focusFactionAnchorRef.current(targetFid);
          }
        }
      }
    };

    const scheduleLabelRecompute = () => {
      boardLabelVersionRef.current += 1;
      if (!showFactionNamesRef.current) {
        labelsStaleRef.current = true;
        return;
      }
      clearScheduledLabelRecompute();
      const sz = stateRef.current.boardSize;
      const delayMs = sz <= 250 ? 400 : sz <= 500 ? 800 : 1500;
      recomputeTimerRef.current = window.setTimeout(() => {
        recomputeTimerRef.current = null;
        if (timelapseModeRef.current) return;
        labelRecomputeInFlightRef.current = true;
        inFlightLabelBoardVersionRef.current = boardLabelVersionRef.current;
        const labelGen = ++labelGenRef.current;
        logicWorker.postMessage({ type: 'recomputeLabels', labelGen });
      }, delayMs);
    };

    netWorker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data;
      const curBuf = buffersRef.current;
      switch (msg.type) {
        case 'wsStatus':
          if (msg.wsGen !== undefined && msg.wsGen !== wsGenRef.current) break;
          setWsConnected(msg.connected);
          if (msg.connected) {
            if (wsDisconnectTimerRef.current !== null) {
              window.clearTimeout(wsDisconnectTimerRef.current);
              wsDisconnectTimerRef.current = null;
            }
            if (wsDisconnectToastShownRef.current) {
              wsDisconnectToastShownRef.current = false;
              addToast('サーバーに再接続しました', 'success');
            }
            hasWsConnectedOnceRef.current = true;
          } else {
            sentActionQueueRef.current = [];
            if (
              hasWsConnectedOnceRef.current &&
              !wsDisconnectToastShownRef.current &&
              wsDisconnectTimerRef.current === null
            ) {
              wsDisconnectTimerRef.current = window.setTimeout(() => {
                wsDisconnectTimerRef.current = null;
                wsDisconnectToastShownRef.current = true;
                addToast('サーバーとの接続が切れました。再接続しています…', 'error');
              }, 3000);
            }
          }
          break;
        case 'sizeMismatch': {
          if (timelapseModeRef.current) {
            // タイムラプス再生中はライブ盤面の最新サイズのみ記録し、終了時に再確保する
            timelapsePendingBoardSizeRef.current = msg.boardSize;
          } else {
            reallocateForBoardSize(msg.boardSize);
          }
          break;
        }
        case 'snapshotReady': {
          if (timelapseModeRef.current || !curBuf) break;
          if (msg.bufferGen !== undefined && msg.bufferGen !== bufferGenRef.current) break;
          // Worker 側で非 SAB フォールバックが起きた場合も rawBytes/gpuBytes を優先処理して描画する
          if (msg.rawBytes && msg.gpuBytes) {
            if (msg.boardSize !== curBuf.boardSize) break;
            const rawArr = new Uint8Array(msg.rawBytes);
            const gpuArr = new Uint8Array(msg.gpuBytes);
            if (
              rawArr.byteLength !== curBuf.rawCells.byteLength ||
              gpuArr.byteLength !== curBuf.gpuTex.byteLength
            ) {
              break;
            }
            curBuf.sabEnabled = false;
            curBuf.ctrl = undefined;
            curBuf.rawCells.set(rawArr);
            curBuf.gpuTex.set(gpuArr);
            renderer.uploadFullBoard(curBuf.gpuTex, msg.boardSize, curBuf.ctrl);
            labelDirtyRef.current = true;
            const logicCopy = rawArr.slice();
            clearScheduledLabelRecompute();
            labelsStaleRef.current = false;
            boardLabelVersionRef.current += 1;
            inFlightLabelBoardVersionRef.current = boardLabelVersionRef.current;
            labelRecomputeInFlightRef.current = true;
            const labelGen = ++labelGenRef.current;
            logicWorker.postMessage(
              {
                type: 'init',
                boardSize: msg.boardSize,
                rawCellsBuffer: logicCopy.buffer,
                ctrlBuffer: undefined,
                labelGen,
              },
              [logicCopy.buffer]
            );
          } else if (curBuf.sabEnabled) {
            renderer.uploadFullBoard(curBuf.gpuTex, msg.boardSize, curBuf.ctrl);
            labelDirtyRef.current = true;
            // 初回読み込み時は「自勢力」ボタンやランキングジャンプ用に常にラベルを計算する
            clearScheduledLabelRecompute();
            labelsStaleRef.current = false;
            boardLabelVersionRef.current += 1;
            inFlightLabelBoardVersionRef.current = boardLabelVersionRef.current;
            labelRecomputeInFlightRef.current = true;
            const labelGen = ++labelGenRef.current;
            logicWorker.postMessage({ type: 'recomputeLabels', labelGen });
          } else {
            break;
          }
          notifyMinimapListeners();
          setBoardLoaded(true);
          labelDirtyRef.current = true;
          renderer.requestRender();
          refreshActiveInspectRef.current();
          if (!initialUrlFocusedRef.current) {
            initialUrlFocusedRef.current = true;
            const params = new URLSearchParams(window.location.search);
            const px = Number(params.get('x'));
            const py = Number(params.get('y'));
            const pz = Number(params.get('z'));
            if (params.has('x') && params.has('y') && Number.isFinite(px) && Number.isFinite(py)) {
              const targetZoom = Number.isFinite(pz) && pz > 0 ? pz : undefined;
              renderer.focusOn(px + 0.5, py + 0.5, targetZoom);
            }
          }
          break;
        }
        case 'dirtyRect': {
          if (timelapseModeRef.current || !curBuf) break;
          if (msg.bufferGen !== undefined && msg.bufferGen !== bufferGenRef.current) break;
          if (msg.boardSize && msg.boardSize !== curBuf.boardSize) break;
          renderer.uploadDirtyRect(curBuf.gpuTex, msg.minX, msg.minY, msg.maxX, msg.maxY, curBuf.ctrl);
          notifyMinimapListeners();
          labelDirtyRef.current = true;
          renderer.requestRender();
          scheduleLabelRecompute();
          refreshActiveInspectRef.current();
          if (modalRef.current === 'logs' && msg.hasTerritoryLogChange !== false) {
            setLogsLiveSignal((n) => n + 1);
          }
          break;
        }
        case 'dirtyRectFallback': {
          if (timelapseModeRef.current || !curBuf) break;
          if (msg.bufferGen !== undefined && msg.bufferGen !== bufferGenRef.current) break;
          if (msg.boardSize !== curBuf.boardSize) break;
          const patchBuf = msg.patchBytes as ArrayBuffer | undefined;
          const count = Number(msg.count ?? 0);
          if (!patchBuf || count <= 0 || patchBuf.byteLength < count * FALLBACK_PATCH_STRIDE) {
            break;
          }
          const sz = curBuf.boardSize;
          const view = new DataView(patchBuf);
          const bytes = new Uint8Array(patchBuf);
          for (let i = 0; i < count; i++) {
            const off = i * FALLBACK_PATCH_STRIDE;
            const x = view.getUint16(off, true);
            const y = view.getUint16(off + 2, true);
            if (x >= sz || y >= sz) continue;
            const cellIdx = y * sz + x;
            curBuf.rawCells.set(bytes.subarray(off + 4, off + 12), cellIdx * CELL_BYTES);
            curBuf.gpuTex.set(bytes.subarray(off + 12, off + 16), cellIdx * 4);
          }
          renderer.uploadDirtyRect(curBuf.gpuTex, msg.minX, msg.minY, msg.maxX, msg.maxY, curBuf.ctrl);
          notifyMinimapListeners();
          labelDirtyRef.current = true;
          renderer.requestRender();
          logicWorker.postMessage(
            { type: 'patchFallback', boardSize: sz, count, patchBytes: patchBuf },
            [patchBuf]
          );
          scheduleLabelRecompute();
          refreshActiveInspectRef.current();
          if (modalRef.current === 'logs' && msg.hasTerritoryLogChange !== false) {
            setLogsLiveSignal((n) => n + 1);
          }
          break;
        }
        case 'actionResult': {
          if (msg.wsGen !== undefined && msg.wsGen !== wsGenRef.current) break;
          const sent = sentActionQueueRef.current.shift();
          if (msg.status === STATUS_WAR_CONFIRM) {
            playNoticeSound();
            const cur = stateRef.current;
            const hi = hoverInfoRef.current;
            const serverCost =
              typeof msg.costAp === 'number' && msg.costAp > 0 ? msg.costAp : undefined;
            setPendingWar({
              x: sent?.x ?? hi?.x ?? 0,
              y: sent?.y ?? hi?.y ?? 0,
              mode: sent?.mode ?? cur.actionMode,
              colorId: sent?.colorId ?? cur.selectedColorId,
              targetFactionId: msg.targetFaction,
              costAp: serverCost ?? (sent?.costKnown ? sent.costAp : hi?.costAp) ?? 1,
            });
          } else if (msg.status === STATUS_ERROR && msg.message) {
            addToast(msg.message, 'error');
          } else if (msg.status === STATUS_OK) {
            if (sent?.mode === 1) {
              playRecolorSound();
            } else {
              playPaintSound();
            }
            const prevUser = stateRef.current.user;
            const prevAp = prevUser?.ap ?? 0;
            // サーバーから返却された確定消費 AP を優先使用する
            const confirmedCost =
              typeof msg.costAp === 'number' && msg.costAp > 0 ? msg.costAp : undefined;
            if (sent) {
              const factionColorId =
                stateRef.current.factions.find((f) => f.id === prevUser?.faction_id)?.color_id ??
                sent.colorId;
              const fxColorId = sent.mode === 1 ? sent.colorId : factionColorId;
              const displayCost =
                confirmedCost ?? (sent.costKnown ? sent.costAp : Math.max(0, prevAp - msg.ap));
              fxListRef.current.push({
                x: sent.x,
                y: sent.y,
                text: sent.mode === 0 && displayCost > 0 ? `-${displayCost} AP` : '',
                color: PALETTE_HEX[fxColorId & 0x3f] ?? '#fde047',
                startedAt: performance.now(),
              });
              renderer.requestRender();
            }
            if (sent?.mode === 1) {
              setRecentColors((prev) =>
                [sent.colorId, ...prev.filter((c) => c !== sent.colorId)].slice(0, 8)
              );
            }
            setUser((prev) => (prev ? { ...prev, ap: msg.ap } : prev));
            scheduleListFactions();
            setActionSeq((prev) => prev + 1);
            if (modalRef.current === 'logs' && sent?.mode !== 1) {
              setLogsLiveSignal((n) => n + 1);
            }
          }
          break;
        }
        case 'tickSync': {
          if (msg.wsGen !== undefined && msg.wsGen !== wsGenRef.current) break;
          seasonStatusGenRef.current += 1;
          seasonInitializedRef.current = true;
          setSeason((prev) => ({
            ...prev,
            phase: msg.phase,
            tick_number: msg.tickNumber,
            next_tick_unix: msg.nextTickUnix,
            season_id: msg.seasonId,
          }));
          syncPhaseAndNotify(msg.phase, msg.seasonId);
          if (typeof msg.ap === 'number' && msg.ap > 0) {
            setUser((prev) => (prev ? { ...prev, ap: msg.ap } : prev));
          }
          scheduleJitteredMetadataRefresh();
          if (modalRef.current === 'logs') {
            setLogsLiveSignal((n) => n + 1);
          }
          break;
        }
        case 'serverEvent': {
          if (msg.wsGen !== undefined && msg.wsGen !== wsGenRef.current) break;
          const e = msg.event;
          if (
            modalRef.current === 'logs' &&
            e.type !== 'resync_required' &&
            e.type !== 'map_regenerated' &&
            e.type !== 'season_reset'
          ) {
            setLogsLiveSignal((n) => n + 1);
          }
          if (e.type === 'war_declared') {
            const warMsg = e.defender_name
              ? `「${e.attacker_name}」が「${e.defender_name}」へ宣戦布告しました`
              : `${e.attacker_name} が宣戦布告しました`;
            const curUser = stateRef.current.user;
            const isSelfDeclared = Boolean(
              curUser &&
                curUser.faction_id > 0 &&
                curUser.faction_id === Number(e.attacker_faction_id) &&
                typeof e.by_user === 'string' &&
                e.by_user === curUser.username
            );
            pushNotification('war', '開戦！', warMsg, 'war', { read: isSelfDeclared });
            scheduleJitteredDiplomacyRefresh();
          } else if (e.type === 'ceasefire_accepted') {
            const nameA = e.from_faction_name ?? e.faction_a_name;
            const nameB = e.to_faction_name ?? e.faction_b_name;
            const cfMsg =
              nameA && nameB
                ? `「${nameA}」と「${nameB}」の停戦協定が成立しました`
                : '停戦協定が成立しました';
            const relatedFids = new Set(
              [e.from_faction_id, e.to_faction_id, e.faction_a, e.faction_b]
                .map((v) => Number(v))
                .filter((v) => Number.isFinite(v) && v > 0)
            );
            const myFid = stateRef.current.user?.faction_id ?? 0;
            if (myFid > 0 && relatedFids.has(myFid)) {
              for (const fid of relatedFids) {
                if (fid !== myFid) {
                  markActionNotificationsRead('ceasefire_offer', fid);
                }
              }
            }
            const fromFid = Number(e.from_faction_id ?? 0);
            const toFid = Number(e.to_faction_id ?? 0);
            const now = Date.now();
            const keptSelfAccepts: typeof recentSelfAcceptedCeasefireRef.current = [];
            for (const item of recentSelfAcceptedCeasefireRef.current) {
              if (now - item.at < 15000) {
                keptSelfAccepts.push(item);
              } else if (item.fallbackTimerId !== undefined) {
                window.clearTimeout(item.fallbackTimerId);
              }
            }
            recentSelfAcceptedCeasefireRef.current = keptSelfAccepts;
            const selfIdx = recentSelfAcceptedCeasefireRef.current.findIndex(
              (item) => item.fromFactionId === fromFid && item.toFactionId === toFid
            );
            const isSelfAccepted = selfIdx !== -1;
            let alreadyToasted = false;
            if (isSelfAccepted) {
              const [matched] = recentSelfAcceptedCeasefireRef.current.splice(selfIdx, 1);
              if (matched?.fallbackTimerId !== undefined) {
                window.clearTimeout(matched.fallbackTimerId);
              }
              alreadyToasted = Boolean(matched?.fallbackShown);
            }
            pushNotification('ceasefire', '停戦成立', cfMsg, 'success', {
              read: isSelfAccepted,
              skipToast: alreadyToasted,
            });
            scheduleJitteredDiplomacyRefresh();
          } else if (e.type === 'ceasefire_rejected') {
            const curUser = stateRef.current.user;
            const fromFid = Number(e.from_faction_id ?? 0);
            if (curUser && curUser.faction_id === Number(e.to_faction_id) && fromFid > 0) {
              markActionNotificationsRead('ceasefire_offer', fromFid);
            }
            if (
              curUser &&
              (curUser.faction_id === Number(e.from_faction_id) ||
                curUser.faction_id === Number(e.to_faction_id)) &&
              curUser.id !== Number(e.actor_user_id)
            ) {
              const rejMsg =
                e.from_faction_name && e.to_faction_name
                  ? `「${e.to_faction_name}」が「${e.from_faction_name}」からの停戦提案を却下しました`
                  : '停戦提案が却下されました';
              pushNotification('ceasefire', '停戦却下', rejMsg, 'info');
            }
            void refreshDiplomacyNow();
          } else if (e.type === 'ceasefire_proposed') {
            const curUser = stateRef.current.user;
            if (
              curUser &&
              (curUser.faction_id === Number(e.from_faction_id) ||
                curUser.faction_id === Number(e.to_faction_id)) &&
              curUser.id !== Number(e.actor_user_id)
            ) {
              const isIncomingToMyFaction = curUser.faction_id === Number(e.to_faction_id);
              const canActOnCeasefire =
                isIncomingToMyFaction && Boolean(curUser.permissions.can_ceasefire);
              const propMsg = isIncomingToMyFaction
                ? e.from_faction_name
                  ? `「${e.from_faction_name}」から停戦提案が届きました`
                  : '自勢力へ停戦提案が届きました'
                : e.to_faction_name
                  ? `「${e.to_faction_name}」へ停戦提案が送信されました`
                  : '停戦提案が送信されました';
              pushNotification('ceasefire', '停戦提案', propMsg, 'info', {
                ...(canActOnCeasefire
                  ? {
                      actionKind: 'ceasefire_offer' as const,
                      actionTargetId: Number(e.from_faction_id),
                      sound: true,
                    }
                  : isIncomingToMyFaction
                    ? { sound: true }
                    : {}),
              });
            }
            void refreshDiplomacyNow();
          } else if (e.type === 'faction_join_request_created') {
            const curUser = stateRef.current.user;
            const targetFid = Number(e.faction_id);
            const applicantUid = Number(e.user_id);
            if (curUser && curUser.faction_id === targetFid) {
              if (curUser.permissions.can_manage_members) {
                pushNotification(
                  'join_request',
                  '参加申請',
                  `${e.username} から参加申請が届きました`,
                  'success',
                  { actionKind: 'join_request', actionTargetId: applicantUid }
                );
                setFactionRefreshSeq((n) => n + 1);
                void refreshUserOnly();
              } else {
                // 権限付与直後のレースに備え最新ユーザー情報を取得し、管理権限があれば通知する（他リクエストと世代競合させない）
                setFactionRefreshSeq((n) => n + 1);
                const expectedUid = curUser.id;
                const reqAuthGen = authGenRef.current;
                const reqSeasonId = stateRef.current.season.season_id;
                const uGen = ++userGenRef.current;
                const seqAtStart = notifSeqRef.current;
                void api
                  .getMe()
                  .then((me) => {
                    if (unmountedRef.current || authGenRef.current !== reqAuthGen) return;
                    if (stateRef.current.season.season_id !== reqSeasonId) return;
                    if (uGen === userGenRef.current) {
                      appliedUserGenRef.current = uGen;
                      stateRef.current = { ...stateRef.current, user: me };
                      setUser(me);
                      reconcileJoinRequestNotifications(me, seqAtStart);
                    }
                    const latestUser = stateRef.current.user;
                    if (
                      !latestUser ||
                      latestUser.id !== expectedUid ||
                      latestUser.faction_id !== targetFid
                    ) {
                      return;
                    }
                    if (
                      joinPermRevokedSeqRef.current > seqAtStart &&
                      !latestUser.permissions.can_manage_members
                    ) {
                      return;
                    }
                    const resolvedSeq =
                      resolvedJoinReqSeqRef.current.get(`${targetFid}:${applicantUid}`) ?? 0;
                    if (resolvedSeq > seqAtStart) return;
                    // 自分より新しい getMe() が既に反映済みの場合は最新ユーザー情報で判定し、幽霊通知を防ぐ
                    const checkUser = appliedUserGenRef.current > uGen ? latestUser : me;
                    if (
                      checkUser.id === expectedUid &&
                      checkUser.faction_id === targetFid &&
                      checkUser.permissions.can_manage_members &&
                      (checkUser.incoming_join_requests ?? []).some(
                        (r) => r.user_id === applicantUid
                      )
                    ) {
                      const hasInFlightNewerGetMe =
                        uGen < userGenRef.current && appliedUserGenRef.current < uGen;
                      pushNotification(
                        'join_request',
                        '参加申請',
                        `${e.username} から参加申請が届きました`,
                        'success',
                        {
                          actionKind: 'join_request',
                          actionTargetId: applicantUid,
                          ...(hasInFlightNewerGetMe ? { seqOverride: seqAtStart } : {}),
                        }
                      );
                    }
                  })
                  .catch((err) => {
                    if (
                      !unmountedRef.current &&
                      authGenRef.current === reqAuthGen &&
                      uGen === userGenRef.current &&
                      err instanceof ApiError &&
                      err.status === 401
                    ) {
                      resetPrivateStateOnAuthLoss();
                    }
                  });
              }
            }
          } else if (e.type === 'faction_join_request_resolved') {
            const curUser = stateRef.current.user;
            const targetFid = Number(e.faction_id ?? 0);
            const applicantUid = Number(e.user_id);
            if (targetFid > 0 && applicantUid > 0) {
              const key = `${targetFid}:${applicantUid}`;
              resolvedJoinReqSeqRef.current.set(key, ++notifSeqRef.current);
              if (resolvedJoinReqSeqRef.current.size > 200) {
                const oldestKey = resolvedJoinReqSeqRef.current.keys().next().value;
                if (oldestKey !== undefined) {
                  resolvedJoinReqSeqRef.current.delete(oldestKey);
                }
              }
            }
            if (curUser && curUser.id === applicantUid) {
              const accepted = Boolean(e.accepted);
              pushNotification(
                'join_request',
                accepted ? '参加承認' : '参加拒否',
                `${e.faction_name} への参加申請が${accepted ? '承認' : '拒否'}されました`,
                accepted ? 'success' : 'info'
              );
              setFactionRefreshSeq((n) => n + 1);
              void refreshMetadata();
            } else if (curUser && curUser.faction_id === Number(e.faction_id)) {
              markActionNotificationsRead('join_request', applicantUid);
              setFactionRefreshSeq((n) => n + 1);
              void refreshUserOnly();
              scheduleListFactions();
            }
          } else if (e.type === 'faction_member_joined') {
            const curUser = stateRef.current.user;
            if (
              curUser &&
              curUser.faction_id === Number(e.faction_id) &&
              curUser.id !== Number(e.user_id)
            ) {
              pushNotification(
                'faction',
                'メンバー参加',
                `${e.username} が勢力「${e.faction_name}」に参加しました`,
                'success'
              );
            }
          } else if (e.type === 'faction_member_left') {
            const curUser = stateRef.current.user;
            if (
              curUser &&
              curUser.faction_id === Number(e.faction_id) &&
              curUser.id !== Number(e.user_id)
            ) {
              pushNotification(
                'faction',
                'メンバー脱退',
                `${e.username} が勢力「${e.faction_name}」から脱退しました`,
                'info'
              );
            }
          } else if (e.type === 'faction_member_kicked') {
            const curUser = stateRef.current.user;
            const kickedUid = Number(e.user_id);
            if (curUser && curUser.id === kickedUid) {
              markActionNotificationsRead('join_request');
              markActionNotificationsRead('ceasefire_offer');
              const cleared = clearUserFactionMembership(curUser);
              stateRef.current = { ...stateRef.current, user: cleared };
              setUser((prev) =>
                prev && prev.id === kickedUid ? clearUserFactionMembership(prev) : prev
              );
              pushNotification(
                'faction',
                '勢力追放',
                `勢力「${e.faction_name}」から追放されました`,
                'error'
              );
              setFactionRefreshSeq((n) => n + 1);
              void refreshMetadata();
            } else if (
              curUser &&
              curUser.faction_id === Number(e.faction_id) &&
              curUser.id !== Number(e.actor_user_id)
            ) {
              pushNotification(
                'faction',
                'メンバー追放',
                `${e.username} が勢力「${e.faction_name}」から追放されました`,
                'info'
              );
            }
          } else if (e.type === 'faction_leader_transferred') {
            const curUser = stateRef.current.user;
            if (
              curUser &&
              (curUser.faction_id === Number(e.faction_id) ||
                curUser.id === Number(e.new_leader_user_id))
            ) {
              if (curUser.id === Number(e.new_leader_user_id)) {
                pushNotification(
                  'faction',
                  '勢力主就任',
                  `あなたが勢力「${e.faction_name}」の新しい勢力主になりました`,
                  'success'
                );
              } else {
                pushNotification(
                  'faction',
                  '勢力主交代',
                  `${e.new_leader_username} が勢力「${e.faction_name}」の新しい勢力主になりました`,
                  'info'
                );
              }
              setFactionRefreshSeq((n) => n + 1);
              void refreshUserOnly();
            }
          } else if (e.type === 'faction_permissions_updated') {
            const curUser = stateRef.current.user;
            if (
              curUser &&
              curUser.faction_id === Number(e.faction_id) &&
              (e.bulk === true || curUser.id === Number(e.user_id))
            ) {
              // 一括権限更新は勢力主・副主には適用されないため通知もスキップする
              if (
                e.bulk === true &&
                (curUser.permissions.is_leader || curUser.permissions.is_vice_leader)
              ) {
                setFactionRefreshSeq((n) => n + 1);
                void refreshUserOnly();
              } else {
                const perms: string[] = [];
                if (e.is_vice_leader) perms.push('副主');
                if (e.can_declare_war) perms.push('宣戦');
                if (e.can_ceasefire) perms.push('停戦');
                if (e.can_manage_members) perms.push('メンバー管理');
                const permText =
                  perms.length > 0 ? perms.join('・') : '一般メンバー（特別権限なし）';
                const applyPermUpdate = (prev: UserProfile): UserProfile => {
                  if (prev.faction_id !== Number(e.faction_id)) return prev;
                  if (e.bulk === true) {
                    if (prev.permissions.is_leader || prev.permissions.is_vice_leader) return prev;
                    const nextCanManage = Boolean(e.can_manage_members);
                    return {
                      ...prev,
                      permissions: {
                        ...prev.permissions,
                        can_declare_war: Boolean(e.can_declare_war),
                        can_ceasefire: Boolean(e.can_ceasefire),
                        can_manage_members: nextCanManage,
                      },
                      ...(nextCanManage ? {} : { incoming_join_requests: [] }),
                    };
                  }
                  const nextCanManage = Boolean(e.can_manage_members);
                  return {
                    ...prev,
                    permissions: {
                      ...prev.permissions,
                      is_vice_leader: Boolean(e.is_vice_leader),
                      can_declare_war: Boolean(e.can_declare_war),
                      can_ceasefire: Boolean(e.can_ceasefire),
                      can_manage_members: nextCanManage,
                    },
                    ...(nextCanManage ? {} : { incoming_join_requests: [] }),
                  };
                };
                const nextUser = applyPermUpdate(curUser);
                stateRef.current = { ...stateRef.current, user: nextUser };
                setUser((prev) => (prev ? applyPermUpdate(prev) : prev));
                if (!nextUser.permissions.can_manage_members) {
                  joinPermRevokedSeqRef.current = ++notifSeqRef.current;
                  markActionNotificationsRead('join_request');
                }
                if (!nextUser.permissions.can_ceasefire) {
                  markActionNotificationsRead('ceasefire_offer');
                }
                pushNotification(
                  'faction',
                  '権限変更',
                  `勢力「${e.faction_name}」でのあなたの権限が変更されました（${permText}）`,
                  'info'
                );
                setFactionRefreshSeq((n) => n + 1);
                void refreshUserOnly();
              }
            }
          } else if (e.type === 'hourly_tick') {
            seasonStatusGenRef.current += 1;
            const tickIntervalMin = Number(e.tick_interval_minutes ?? 30);
            const tickTitle = tickIntervalMin === 60 ? '毎時00分ティック' : 'ターンティック';
            const refillPart = e.ap_refilled === false ? '' : 'AP配布・';
            addToast(
              `${tickTitle} (#${e.tick_number}): ${refillPart}中核昇格 ${e.promoted_cores}マス`,
              'success'
            );
            if (typeof e.endgame_boost === 'boolean') {
              setSeason((prev) => ({ ...prev, endgame_boost_active: e.endgame_boost }));
              if (seasonInitializedRef.current) {
                syncEndgameBoostAndNotify(e.endgame_boost, stateRef.current.season.season_id);
              }
            }
            setFactionRefreshSeq((n) => n + 1);
            scheduleJitteredMetadataRefresh();
          } else if (e.type === 'faction_extinct') {
            const curUser = stateRef.current.user;
            const isMyFaction = Boolean(curUser && curUser.faction_id === Number(e.faction_id));
            pushNotification(
              'faction',
              isMyFaction ? '自勢力滅亡（亡命）' : '勢力滅亡',
              isMyFaction
                ? `自勢力「${e.faction_name}」が全領土を失い亡命状態になりました（空き地から再起可能）`
                : `勢力「${e.faction_name}」が全領土を失い滅亡（亡命）しました`,
              'war'
            );
            setFactionRefreshSeq((n) => n + 1);
            scheduleJitteredMetadataRefresh();
          } else if (e.type === 'faction_revived') {
            pushNotification(
              'faction',
              '勢力再起',
              `亡命勢力「${e.faction_name}」が再起しました！`,
              'war'
            );
            setFactionRefreshSeq((n) => n + 1);
            scheduleJitteredMetadataRefresh();
          } else if (e.type === 'core_attacked') {
            const curUser = stateRef.current.user;
            if (curUser && curUser.faction_id === Number(e.defender_faction_id)) {
              pushNotification(
                'war',
                '中核マス侵攻！',
                `「${e.attacker_name}」に中核マス (${e.x}, ${e.y}) を奪われました！`,
                'war'
              );
            }
          } else if (e.type === 'faction_settings_updated') {
            const curUser = stateRef.current.user;
            if (
              curUser &&
              curUser.faction_id === Number(e.faction_id) &&
              curUser.id !== Number(e.actor_user_id)
            ) {
              const changes: string[] = [];
              if (e.allow_auto_paint_changed) {
                changes.push(e.allow_auto_paint ? '自動塗りを許可' : '自動塗りを禁止');
              }
              if (e.join_policy_changed) {
                changes.push(
                  Number(e.join_policy) === 1 ? '参加許可制に変更' : '自由参加に変更'
                );
              }
              if (e.color_changed) {
                changes.push('勢力カラーを変更');
              }
              if (changes.length > 0) {
                pushNotification(
                  'faction',
                  '勢力設定変更',
                  `勢力「${e.faction_name}」の設定が変更されました（${changes.join('・')}）`,
                  'info'
                );
              }
            }
          } else if (e.type === 'auto_paint_executed') {
            const painted = Number(e.painted_cells ?? 0);
            const spent = Number(e.spent_ap ?? 0);
            if (stateRef.current.user !== null && painted > 0) {
              addToast(`自動塗りを実行しました（-${spent} AP・${painted}マス獲得）`, 'success');
            }
          } else if (e.type === 'cost_config_updated') {
            if (e.cost_config) {
              seasonStatusGenRef.current += 1;
              setSeason((prev) => ({ ...prev, cost_config: e.cost_config }));
              addToast('管理者によりAPコスト設定が更新されました', 'info');
            }
          } else if (e.type === 'ap_config_updated') {
            if (e.ap_config) {
              seasonStatusGenRef.current += 1;
              setSeason((prev) => ({
                ...prev,
                ap_config: e.ap_config,
                ...(typeof e.effective_max_ap === 'number'
                  ? { effective_max_ap: Number(e.effective_max_ap) }
                  : {}),
                ...(typeof e.endgame_boost === 'boolean'
                  ? { endgame_boost_active: e.endgame_boost }
                  : {}),
              }));
              if (seasonInitializedRef.current && typeof e.endgame_boost === 'boolean') {
                syncEndgameBoostAndNotify(
                  e.endgame_boost,
                  stateRef.current.season.season_id,
                  e.ap_config.endgame_ap_multiplier
                );
              }
              addToast('管理者によりAP設定が更新されました', 'info');
            }
          } else if (e.type === 'rules_config_updated') {
            if (e.game_rules || e.faction_name_max_len !== undefined) {
              seasonStatusGenRef.current += 1;
              setSeason((prev) => ({
                ...prev,
                ...(e.game_rules ? { game_rules: e.game_rules } : {}),
                ...(e.faction_name_max_len !== undefined
                  ? { faction_name_max_len: Number(e.faction_name_max_len) }
                  : {}),
                ...(e.game_rules?.max_ticks !== undefined
                  ? { max_ticks: Number(e.game_rules.max_ticks) }
                  : {}),
              }));
              addToast('管理者によりゲームルール設定が更新されました', 'info');
            }
          } else if (e.type === 'faction_created') {
            if (e.name && stateRef.current.user?.id !== Number(e.leader_user_id)) {
              addToast(`新勢力「${e.name}」が設立されました`, 'info');
            } else if (stateRef.current.user?.id === Number(e.leader_user_id)) {
              void refreshUserOnly();
            }
            setFactionRefreshSeq((n) => n + 1);
            scheduleListFactions();
          } else if (e.type === 'faction_deleted') {
            const curUser = stateRef.current.user;
            const deletedFid = Number(e.faction_id ?? 0);
            if (deletedFid > 0) {
              markActionNotificationsRead('ceasefire_offer', deletedFid);
              setFactions((prev) => prev.filter((f) => f.id !== deletedFid));
              if (curUser && curUser.faction_id === deletedFid) {
                markActionNotificationsRead('join_request');
                markActionNotificationsRead('ceasefire_offer');
                const cleared = clearUserFactionMembership(curUser);
                stateRef.current = { ...stateRef.current, user: cleared };
                setUser((prev) =>
                  prev && prev.faction_id === deletedFid ? clearUserFactionMembership(prev) : prev
                );
                const fname = e.name ? `「${e.name}」` : '';
                pushNotification(
                  'faction',
                  '勢力削除',
                  `所属勢力${fname}が管理者により削除されました`,
                  'error'
                );
              }
            }
            setFactionRefreshSeq((n) => n + 1);
            scheduleJitteredMetadataRefresh();
          } else if (e.type === 'faction_updated') {
            const curUser = stateRef.current.user;
            const targetFid = Number(e.faction_id ?? 0);
            if (e.renamed_by_admin && curUser && curUser.faction_id === targetFid && e.name) {
              const msgText = e.old_name
                ? `管理者により所属勢力名が「${e.old_name}」から「${e.name}」に変更されました`
                : `管理者により所属勢力名が「${e.name}」に変更されました`;
              pushNotification('faction', '勢力名変更', msgText, 'info');
            }
            if (e.color_id !== undefined || e.join_policy !== undefined) {
              // 飛行中の旧 /api/factions 応答で新しい勢力色や参加方針が上書きされないよう世代を進める
              listFactionsGenRef.current += 1;
              setFactions((prev) =>
                prev.map((f) =>
                  f.id === targetFid
                    ? {
                        ...f,
                        ...(e.color_id !== undefined ? { color_id: Number(e.color_id) } : {}),
                        ...(e.join_policy !== undefined
                          ? { join_policy: Number(e.join_policy) }
                          : {}),
                      }
                    : f
                )
              );
            }
            if (
              curUser &&
              (curUser.faction_id === targetFid || curUser.id === Number(e.joined_user_id))
            ) {
              setFactionRefreshSeq((n) => n + 1);
              void refreshUserOnly();
            }
            if (e.color_id === undefined) {
              scheduleListFactions();
            }
          } else if (e.type === 'ap_refilled') {
            seasonStatusGenRef.current += 1;
            if (stateRef.current.user !== null) {
              const boostLabel = e.endgame_boost ? '（終盤ブースト中）' : '';
              addToast(`APが定期補充されました (+${e.min}〜${e.max} AP)${boostLabel}`, 'success');
            }
            if (typeof e.endgame_boost === 'boolean') {
              setSeason((prev) => ({ ...prev, endgame_boost_active: e.endgame_boost }));
              if (seasonInitializedRef.current) {
                syncEndgameBoostAndNotify(e.endgame_boost, stateRef.current.season.season_id);
              }
            }
            scheduleJitteredMetadataRefresh();
          } else if (e.type === 'ap_granted') {
            if (typeof e.ap === 'number' && Number.isFinite(e.ap)) {
              setUser((prev) => (prev ? { ...prev, ap: Number(e.ap) } : prev));
            } else {
              scheduleJitteredMetadataRefresh();
            }
            if (stateRef.current.user !== null) {
              if (e.all === true && e.mode === 'add' && typeof e.delta === 'number') {
                addToast(
                  `管理者により全プレイヤーのAPが ${e.delta >= 0 ? '+' : ''}${e.delta} 調整されました`,
                  'info'
                );
              } else if (
                e.all === true &&
                typeof e.ap === 'number' &&
                Number.isFinite(e.ap)
              ) {
                addToast(
                  `管理者により全プレイヤーのAPが ${Number(e.ap)} に設定されました`,
                  'info'
                );
              } else if (typeof e.ap === 'number' && Number.isFinite(e.ap)) {
                addToast(`管理者によりAPが更新されました（現在 ${Number(e.ap)} AP）`, 'info');
              }
            }
          } else if (e.type === 'resync_required' || e.type === 'metadata_resync_required') {
            scheduleJitteredMetadataRefresh();
          } else if (e.type === 'map_regenerated' || e.type === 'season_reset') {
            const nextSz = Number(e.board_size || stateRef.current.boardSize);
            // 進行中の openTimelapse 取得やタイムラプス再生を無条件で中断・終了する
            timelapseGenRef.current++;
            timelapseAbortRef.current?.abort();
            setTimelapseLoading(false);
            clearScheduledLabelRecompute();
            cancelPendingMetadataRefresh();
            if (timelapseModeRef.current) {
              setTimelapsePlaying(false);
              setTimelapseMode(false);
              timelapseModeRef.current = false;
              timelapsePendingBoardSizeRef.current = null;
              lastTimelapseGpuRef.current = null;
              labelGenRef.current++;
              timelapseCacheRef.current.clear();
            }
            clearHoverState();
            setSelectedCell(null);
            selectedInfoRef.current = null;
            notifyInspectListeners();
            setPendingWar(null);
            setPendingJoinFactionId(null);
            setFactions([]);
            setDiplomacy({ wars: [], ceasefire_proposals: [] });
            setPinnedFactionId(0);
            if (
              typeof e.season_id === 'number' &&
              (e.phase === 'preparation' || e.phase === 'active' || e.phase === 'frozen')
            ) {
              seasonInitializedRef.current = true;
              knownPhaseRef.current = e.phase;
              knownSeasonIdRef.current = e.season_id;
            } else {
              knownPhaseRef.current = null;
              knownSeasonIdRef.current = null;
            }
            if (typeof e.season_id === 'number') {
              knownEndgameBoostRef.current = false;
              knownEndgameSeasonIdRef.current = e.season_id;
              const nextSeasonState: SeasonStatus = {
                ...stateRef.current.season,
                season_id: e.season_id,
                endgame_boost_active: false,
                ...(e.phase ? { phase: e.phase } : {}),
              };
              stateRef.current = { ...stateRef.current, season: nextSeasonState };
              setSeason((prev) => ({
                ...prev,
                season_id: e.season_id,
                endgame_boost_active: false,
                ...(e.phase ? { phase: e.phase } : {}),
              }));
            } else {
              knownEndgameBoostRef.current = null;
              knownEndgameSeasonIdRef.current = null;
            }
            clearNotifications();
            closeActiveBrowserNotifs();
            clearSelfAcceptCeasefireEntries();
            resolvedJoinReqSeqRef.current.clear();
            joinPermRevokedSeqRef.current = 0;
            if (e.type === 'map_regenerated') {
              clearToasts();
              if (modalRef.current === 'notifications') {
                setModal(null);
              }
              // マップ再生成時は全ユーザー・全セッションが削除されるため私的状態・キュー・WS認証をリセットする
              authGenRef.current += 1;
              sentActionQueueRef.current = [];
              stateRef.current = { ...stateRef.current, user: null };
              setUser(null);
              netWorkerRef.current?.postMessage({
                type: 'reconnect',
                wsUrl: buildWsUrl(),
                wsGen: ++wsGenRef.current,
              });
            } else {
              // シーズン切替時は所属勢力・権限・参加申請を即時クリアし、新 season_id/phase を反映する
              const curUser = stateRef.current.user;
              if (curUser) {
                stateRef.current = {
                  ...stateRef.current,
                  user: {
                    ...clearUserFactionMembership(curUser),
                    outgoing_join_request_faction_ids: [],
                  },
                };
              }
              setUser((prev) =>
                prev
                  ? {
                      ...clearUserFactionMembership(prev),
                      outgoing_join_request_faction_ids: [],
                    }
                  : prev
              );
            }
            addToast(
              e.type === 'map_regenerated'
                ? `管理者によりマップが再生成されました (${nextSz}×${nextSz})`
                : `新シーズン #${e.season_id} が開始されました！`,
              'success'
            );
            reallocateForBoardSize(nextSz);
            scheduleJitteredMetadataRefresh();
            if (modalRef.current === 'logs') {
              setLogsResetSignal((n) => n + 1);
            }
          }
          break;
        }
        case 'actionSendFailed':
          if (msg.wsGen !== undefined && msg.wsGen !== wsGenRef.current) break;
          if (msg.actionId !== undefined) {
            sentActionQueueRef.current = sentActionQueueRef.current.filter(
              (item) => item.id !== msg.actionId
            );
          } else {
            sentActionQueueRef.current.pop();
          }
          addToast(msg.message, 'error');
          break;
        case 'error':
          addToast(msg.message, 'error');
          break;
      }
    };

    const initBufferGen = ++bufferGenRef.current;
    netWorker.postMessage({
      type: 'init',
      boardSize: DEFAULT_BOARD_SIZE,
      sabEnabled: buffers.sabEnabled,
      rawCellsBuffer: buffers.sabEnabled ? buffers.rawCellsBuffer : undefined,
      gpuTexBuffer: buffers.sabEnabled ? buffers.gpuTexBuffer : undefined,
      ctrlBuffer: buffers.ctrlBuffer,
      snapshotUrl: '/api/board/snapshot',
      wsUrl: buildWsUrl(),
      bufferGen: initBufferGen,
      wsGen: wsGenRef.current,
    });

    void refreshMetadata();

    return () => {
      unmountedRef.current = true;
      closeActiveBrowserNotifs();
      clearSelfAcceptCeasefireEntries();
      window.removeEventListener('resize', onResize);
      clearScheduledLabelRecompute();
      timelapseGenRef.current++;
      cancelPendingMetadataRefresh();
      for (const tid of toastTimersRef.current.values()) {
        window.clearTimeout(tid);
      }
      toastTimersRef.current.clear();
      if (logoutConfirmTimerRef.current !== null) {
        window.clearTimeout(logoutConfirmTimerRef.current);
        logoutConfirmTimerRef.current = null;
      }
      if (wsDisconnectTimerRef.current !== null) {
        window.clearTimeout(wsDisconnectTimerRef.current);
        wsDisconnectTimerRef.current = null;
      }
      timelapseAbortRef.current?.abort();
      renderer.onContextRestored = undefined;
      netWorker.terminate();
      logicWorker.terminate();
      renderer.dispose();
    };
  }, [
    addToast,
    buildWsUrl,
    cancelPendingMetadataRefresh,
    clearNotifications,
    clearSelfAcceptCeasefireEntries,
    clearToasts,
    closeActiveBrowserNotifs,
    markActionNotificationsRead,
    pushNotification,
    reallocateForBoardSize,
    reconcileJoinRequestNotifications,
    refreshDiplomacyNow,
    refreshMetadata,
    refreshUserOnly,
    resetPrivateStateOnAuthLoss,
    scheduleJitteredDiplomacyRefresh,
    scheduleJitteredMetadataRefresh,
    scheduleListFactions,
    syncEndgameBoostAndNotify,
    syncPhaseAndNotify,
  ]);

  // 所属勢力が変わった場合、旧勢力に紐づく要対応通知（参加申請・停戦提案）の未読を既読化する
  useEffect(() => {
    const curFid = user?.faction_id ?? 0;
    const prevFid = prevUserFactionIdRef.current;
    prevUserFactionIdRef.current = curFid;
    if (prevFid > 0 && curFid !== prevFid) {
      markActionNotificationsRead('join_request');
      markActionNotificationsRead('ceasefire_offer');
    }
  }, [user?.faction_id, markActionNotificationsRead]);

  useEffect(() => {
    rendererRef.current?.updateFactionMetadata(factions, user?.faction_id ?? 0, myWarSet);
    labelDirtyRef.current = true;
    rendererRef.current?.requestRender();
    // 勢力削除後などに存在しない勢力のハイライトが残らないようクリアする
    if (pinnedFactionId > 0 && !factions.some((f) => f.id === pinnedFactionId)) {
      setPinnedFactionId(0);
    }
  }, [factions, user?.faction_id, myWarSet, pinnedFactionId]);

  useEffect(() => {
    if (
      pendingJoinFactionId !== null &&
      (!user || user.faction_id > 0 || !factionMap.has(pendingJoinFactionId))
    ) {
      setPendingJoinFactionId(null);
    }
  }, [pendingJoinFactionId, user, factionMap]);

  useEffect(() => {
    saveBoolPref('teien_show_faction_names', showFactionNames);
    labelDirtyRef.current = true;
    rendererRef.current?.requestRender();
    if (!showFactionNames) {
      if (recomputeTimerRef.current !== null) {
        clearScheduledLabelRecompute();
        labelsStaleRef.current = true;
      }
      return;
    }
    if (labelsStaleRef.current && !timelapseModeRef.current && logicWorkerRef.current) {
      clearScheduledLabelRecompute();
      labelsStaleRef.current = false;
      labelRecomputeInFlightRef.current = true;
      inFlightLabelBoardVersionRef.current = boardLabelVersionRef.current;
      const labelGen = ++labelGenRef.current;
      logicWorkerRef.current.postMessage({ type: 'recomputeLabels', labelGen });
    }
  }, [showFactionNames, clearScheduledLabelRecompute]);

  useEffect(() => {
    if (modal === 'ranking' && labelsStaleRef.current && !timelapseModeRef.current && logicWorkerRef.current) {
      clearScheduledLabelRecompute();
      labelsStaleRef.current = false;
      labelRecomputeInFlightRef.current = true;
      inFlightLabelBoardVersionRef.current = boardLabelVersionRef.current;
      const labelGen = ++labelGenRef.current;
      logicWorkerRef.current.postMessage({ type: 'recomputeLabels', labelGen });
    }
  }, [modal, clearScheduledLabelRecompute]);

  // 2D オーバーレイキャンバス描画（WebGL2 レンダラーの 1本の rAF ループに統合）
  const factionMapRef = useRef(factionMap);
  factionMapRef.current = factionMap;
  const showFactionNamesRef = useRef(showFactionNames);
  showFactionNamesRef.current = showFactionNames;

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    let lastCx = Number.NaN;
    let lastCy = Number.NaN;
    let lastZoom = Number.NaN;
    let lastW = 0;
    let lastH = 0;
    let hadActiveFx = false;

    renderer.hasExternalAnimation = () => fxListRef.current.length > 0;

    renderer.onAfterRender = () => {
      const canvas = labelCanvasRef.current;
      if (!canvas) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const { width: rawW, height: rawH } = renderer.getCssSize();
      const cssW = Math.max(1, rawW);
      const cssH = Math.max(1, rawH);
      const cam = renderer.camera;

      const now = performance.now();
      const activeFx = fxListRef.current.filter((fx) => now - fx.startedAt < 650);
      fxListRef.current = activeFx;
      const hasActiveFx = activeFx.length > 0;

      const resized =
        canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr);
      const camMoved = cam.cx !== lastCx || cam.cy !== lastCy || cam.zoom !== lastZoom;
      if (
        !resized &&
        !camMoved &&
        !labelDirtyRef.current &&
        !hasActiveFx &&
        !hadActiveFx &&
        cssW === lastW &&
        cssH === lastH
      ) {
        return;
      }

      if (resized) {
        canvas.width = Math.floor(cssW * dpr);
        canvas.height = Math.floor(cssH * dpr);
      }
      lastCx = cam.cx;
      lastCy = cam.cy;
      lastZoom = cam.zoom;
      lastW = cssW;
      lastH = cssH;
      labelDirtyRef.current = false;
      hadActiveFx = hasActiveFx;

      let ctx = labelCtxRef.current;
      if (!ctx || ctx.canvas !== canvas) {
        ctx = canvas.getContext('2d');
        labelCtxRef.current = ctx;
      }
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      // 重ね塗り層数表示モード時は拡大時に可視セルの層数を数字で描画する
      if (renderer.overlayMode === 2 && !timelapseModeRef.current && cam.zoom >= 15) {
        const curBuf = buffersRef.current;
        if (curBuf) {
          const seqBefore = sabReadSeq(curBuf.ctrl);
          if ((seqBefore & 1) !== 0) {
            // 書き込み中は UI スレッドをブロックせず次フレームで再描画する
            labelDirtyRef.current = true;
            renderer.requestRender();
          } else {
            const { gpuTex, boardSize } = curBuf;
            const halfW = (cssW * 0.5) / cam.zoom;
            const halfH = (cssH * 0.5) / cam.zoom;
            const minX = Math.max(0, Math.floor(cam.cx - halfW));
            const maxX = Math.min(boardSize - 1, Math.floor(cam.cx + halfW));
            const minY = Math.max(0, Math.floor(cam.cy - halfH));
            const maxY = Math.min(boardSize - 1, Math.floor(cam.cy + halfH));

            const fontSize = Math.max(8, Math.min(20, Math.floor(cam.zoom * 0.46)));
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineJoin = 'round';
            ctx.font = `700 ${fontSize}px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace`;
            ctx.lineWidth = Math.max(2, fontSize * 0.24);
            ctx.strokeStyle = 'rgba(9, 14, 26, 0.85)';

            for (let cy = minY; cy <= maxY; cy++) {
              const screenY = (cy + 0.5 - cam.cy) * cam.zoom + cssH * 0.5;
              const rowBase = cy * boardSize;
              for (let cx = minX; cx <= maxX; cx++) {
                const off = (rowBase + cx) * 4;
                const terrain = (gpuTex[off] >> 6) & 1;
                if (terrain === 0) continue;
                const fid = gpuTex[off + 2] | (gpuTex[off + 3] << 8);
                if (fid === 0) continue;
                const layers = gpuTex[off + 1] & 15;
                if (layers === 0) continue;

                const screenX = (cx + 0.5 - cam.cx) * cam.zoom + cssW * 0.5;
                const text = String(layers);
                ctx.fillStyle = layers >= 2 ? '#ffffff' : 'rgba(255, 255, 255, 0.78)';
                ctx.strokeText(text, screenX, screenY);
                ctx.fillText(text, screenX, screenY);
              }
            }

            if (sabReadSeq(curBuf.ctrl) !== seqBefore) {
              // 描画中に共有バッファが更新された場合は tearing 描画を破棄し次フレームで再描画する
              ctx.clearRect(0, 0, cssW, cssH);
              labelDirtyRef.current = true;
              renderer.requestRender();
            }
          }
        }
      }

      if (showFactionNamesRef.current) {
        const anchors = factionLabelsRef.current;
        if (anchors.length > 0) {
          const fMap = factionMapRef.current;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.lineJoin = 'round';

          for (const anchor of anchors) {
            const faction = fMap.get(anchor.factionId);
            if (!faction) continue;

            const screenX = (anchor.centerX - cam.cx) * cam.zoom + cssW * 0.5;
            const screenY = (anchor.centerY - cam.cy) * cam.zoom + cssH * 0.5;
            if (screenX < -200 || screenX > cssW + 200 || screenY < -80 || screenY > cssH + 80) {
              continue;
            }

            const clusterPx = Math.max(anchor.spanW, anchor.spanH) * cam.zoom;
            if (clusterPx < 10) continue;

            const areaPx = Math.sqrt(anchor.cellCount) * cam.zoom;
            const fontSize = Math.round(
              Math.max(10, Math.min(44, Math.min(areaPx * 0.36, clusterPx * 0.25)))
            );

            ctx.font = `700 ${fontSize}px "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif`;
            ctx.lineWidth = Math.max(2.5, fontSize * 0.22);
            ctx.strokeStyle = 'rgba(9, 14, 26, 0.88)';
            ctx.fillStyle = '#f8fafc';
            ctx.strokeText(faction.name, screenX, screenY);
            ctx.fillText(faction.name, screenX, screenY);
          }
        }
      }

      // 塗抹・重ね塗り成功時の波紋＆消費APフローティングテキスト
      if (hasActiveFx) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        for (const fx of activeFx) {
          const t = Math.min(1, Math.max(0, (now - fx.startedAt) / 650));
          const easeOut = 1 - (1 - t) * (1 - t);
          const alpha = 1 - t;
          const sx = (fx.x + 0.5 - cam.cx) * cam.zoom + cssW * 0.5;
          const sy = (fx.y + 0.5 - cam.cy) * cam.zoom + cssH * 0.5;
          const radius = Math.max(6, cam.zoom * 0.5) + easeOut * Math.max(18, cam.zoom * 1.4);

          ctx.globalAlpha = alpha;
          ctx.beginPath();
          ctx.arc(sx, sy, radius, 0, Math.PI * 2);
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = fx.color;
          ctx.stroke();

          if (fx.text) {
            const textY = sy - 10 - easeOut * 28;
            ctx.font = '800 13px "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif';
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(9, 14, 26, 0.92)';
            ctx.fillStyle = '#fde047';
            ctx.strokeText(fx.text, sx, textY);
            ctx.fillText(fx.text, sx, textY);
          }
        }
        ctx.globalAlpha = 1;
      }
    };

    return () => {
      renderer.onAfterRender = undefined;
      renderer.hasExternalAnimation = undefined;
    };
  }, []);

  const showTimelapseFrameAt = useCallback(
    async (frames: TimelapseFrameMeta[], idx: number): Promise<boolean> => {
      const meta = frames[idx];
      const renderer = rendererRef.current;
      if (!meta || !renderer) return false;

      timelapseAbortRef.current?.abort();
      const controller = new AbortController();
      timelapseAbortRef.current = controller;
      const gen = ++timelapseGenRef.current;

      const cache = timelapseCacheRef.current;
      let cached = cache.get(meta.id);
      if (cached) {
        // LRU順序更新
        cache.delete(meta.id);
        cache.set(meta.id, cached);
        setTimelapseLoading(false);
      } else {
        setTimelapseLoading(true);
        try {
          const res = await fetch(`/api/timelapse/frames/${meta.id}`, {
            cache: 'force-cache',
            signal: controller.signal,
          });
          if (!res.ok) {
            if (gen === timelapseGenRef.current) {
              addToast(`タイムラプスフレームの取得に失敗しました (HTTP ${res.status})`, 'error');
            }
            return false;
          }
          const buf = await res.arrayBuffer();
          const raw = new Uint8Array(buf);
          const headerSz = Number(res.headers.get('x-board-size') || meta.board_size);
          const sz = headerSz > 0 ? headerSz : meta.board_size;
          if (sz * sz * CELL_BYTES !== raw.byteLength) {
            if (gen === timelapseGenRef.current) {
              addToast('タイムラプスフレームのデータサイズが不正です', 'error');
            }
            return false;
          }
          const gpu = new Uint8Array(sz * sz * 4);
          packAllCellsToRgba8ui(raw, gpu, sz);
          cached = { raw, gpu, boardSize: sz };
          // 最大12フレームまでに制限（1000x1000時のメモリ圧迫防止）
          if (cache.size >= 12) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey !== undefined) {
              cache.delete(oldestKey);
            }
          }
          cache.set(meta.id, cached);
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            return false;
          }
          if (gen === timelapseGenRef.current) {
            addToast('タイムラプスフレームの読込に失敗しました', 'error');
          }
          return false;
        } finally {
          if (gen === timelapseGenRef.current) {
            setTimelapseLoading(false);
          }
        }
      }

      if (gen !== timelapseGenRef.current || !timelapseModeRef.current) return false;
      clearScheduledLabelRecompute();
      lastTimelapseGpuRef.current = { gpu: cached.gpu, boardSize: cached.boardSize };
      renderer.uploadFullBoard(cached.gpu, cached.boardSize);
      const copy = cached.raw.slice();
      const labelGen = ++labelGenRef.current;
      logicWorkerRef.current?.postMessage(
        {
          type: 'computeLabelsFromSnapshot',
          boardSize: cached.boardSize,
          rawCellsBuffer: copy.buffer,
          labelGen,
        },
        [copy.buffer]
      );
      return true;
    },
    [addToast, clearScheduledLabelRecompute]
  );

  const openTimelapse = async () => {
    if (timelapseOpeningRef.current) return;
    timelapseOpeningRef.current = true;
    const openGen = ++timelapseGenRef.current;
    setMobileMenuOpen(false);
    setTimelapseLoading(true);
    let keepLoadingForFirstFrame = false;
    try {
      const res = await api.listTimelapseFrames();
      if (openGen !== timelapseGenRef.current) return;
      if (res.frames.length === 0) {
        addToast('まだタイムラプス履歴がありません（Tick実行ごとに自動記録されます）', 'info');
        return;
      }
      clearScheduledLabelRecompute();
      labelRecomputeInFlightRef.current = false;
      pendingFocusFactionRef.current = null;
      clearHoverState();
      keepLoadingForFirstFrame = true;
      setTimelapseFrames(res.frames);
      setTimelapseIndex(0);
      setTimelapseMode(true);
      setTimelapsePlaying(res.frames.length > 1);
      setSelectedCell(null);
      selectedInfoRef.current = null;
      notifyInspectListeners();
      timelapseModeRef.current = true;
      labelDirtyRef.current = true;
      rendererRef.current?.requestRender();
    } catch (err) {
      if (openGen === timelapseGenRef.current) {
        addToast((err as Error).message, 'error');
      }
    } finally {
      timelapseOpeningRef.current = false;
      if (!keepLoadingForFirstFrame) {
        setTimelapseLoading(false);
      }
    }
  };

  const closeTimelapse = useCallback(() => {
    clearScheduledLabelRecompute();
    labelRecomputeInFlightRef.current = false;
    pendingFocusFactionRef.current = null;
    timelapseAbortRef.current?.abort();
    timelapseGenRef.current++;
    labelGenRef.current++;
    setTimelapseLoading(false);
    setTimelapsePlaying(false);
    setTimelapseMode(false);
    timelapseModeRef.current = false;
    labelDirtyRef.current = true;
    lastTimelapseGpuRef.current = null;
    timelapseCacheRef.current.clear();
    const nextSize = timelapsePendingBoardSizeRef.current ?? stateRef.current.boardSize;
    timelapsePendingBoardSizeRef.current = null;
    reallocateForBoardSize(nextSize);
  }, [reallocateForBoardSize]);

  // タイムラプスフレームの読込・描画（再生状態・速度変化では再読込しない）
  useEffect(() => {
    if (!timelapseMode || timelapseFrames.length === 0) {
      setTimelapseLoadedState(null);
      setTimelapseLoadFailed(false);
      return;
    }
    const frameKey = `${timelapseFrames[timelapseIndex]?.id ?? 'none'}:${timelapseIndex}`;
    let cancelled = false;
    const startedAt = performance.now();
    setTimelapseLoadedState(null);
    setTimelapseLoadFailed(false);

    void (async () => {
      const ok = await showTimelapseFrameAt(timelapseFrames, timelapseIndex);
      if (cancelled) return;
      if (!ok) {
        setTimelapseLoadFailed(true);
        setTimelapsePlaying(false);
        return;
      }
      setTimelapseLoadFailed(false);
      setTimelapseLoadedState({ key: frameKey, startedAt });
    })();

    return () => {
      cancelled = true;
    };
  }, [timelapseMode, timelapseIndex, timelapseFrames, timelapseRetrySeq, showTimelapseFrameAt]);

  // タイムラプス自動再生の次フレーム進行タイマー（現在フレーム読込完了後のみ進行する）
  useEffect(() => {
    if (!timelapseMode || !timelapsePlaying || timelapseFrames.length <= 1) return;
    const frameKey = `${timelapseFrames[timelapseIndex]?.id ?? 'none'}:${timelapseIndex}`;
    if (!timelapseLoadedState || timelapseLoadedState.key !== frameKey) return;
    if (timelapseIndex + 1 >= timelapseFrames.length) {
      setTimelapsePlaying(false);
      return;
    }

    const intervalMs = Math.max(120, Math.round(900 / timelapseSpeed));
    const elapsed = performance.now() - timelapseLoadedState.startedAt;
    const remain = Math.max(0, intervalMs - elapsed);
    const timerId = window.setTimeout(() => {
      setTimelapseIndex((prev) => {
        if (prev + 1 >= timelapseFrames.length) {
          setTimelapsePlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, remain);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [
    timelapseMode,
    timelapsePlaying,
    timelapseSpeed,
    timelapseIndex,
    timelapseFrames,
    timelapseLoadedState,
  ]);

  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.overlayMode = overlayMode;
      labelDirtyRef.current = true;
      rendererRef.current.requestRender();
    }
  }, [overlayMode]);

  useEffect(() => {
    saveBoolPref('teien_show_core_marker', showCoreMarker);
    if (rendererRef.current) {
      rendererRef.current.showCoreMarker = showCoreMarker;
    }
  }, [showCoreMarker]);

  useEffect(() => {
    saveBoolPref('teien_confirm_tap_mode', confirmTapMode);
  }, [confirmTapMode]);

  useEffect(() => {
    try {
      localStorage.setItem('teien_recent_colors', JSON.stringify(recentColors));
    } catch {
      // ignore
    }
  }, [recentColors]);

  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.maxLayers = season.game_rules?.max_layers ?? 10;
      rendererRef.current.assimilationRequiredTicks =
        season.game_rules?.assimilation_required_ticks ?? 10;
    }
  }, [season.game_rules?.max_layers, season.game_rules?.assimilation_required_ticks]);

  // ヘッダーの実測高さに応じて下部HUD（バナー・ミニマップ・トースト等）の上端オフセットを動的調整
  useEffect(() => {
    const updateHudTopOffset = () => {
      const el = headerRef.current;
      if (!el) return;
      if (window.innerWidth <= 768 && mobileMenuOpen) return;
      const rect = el.getBoundingClientRect();
      const offset = Math.ceil(rect.bottom + 8);
      document.documentElement.style.setProperty('--hud-top-offset', `${offset}px`);
    };

    updateHudTopOffset();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateHudTopOffset) : null;
    if (ro && headerRef.current) ro.observe(headerRef.current);
    window.addEventListener('resize', updateHudTopOffset);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', updateHudTopOffset);
    };
  }, [mobileMenuOpen]);

  useEffect(() => {
    if (!mapSettingsOpen) return;
    // pointerdown で閉じるとモバイルメニュー内のレイアウトが先に縮んで他ボタンの1回目タップが無効化されるため click で判定する
    const onClick = (e: MouseEvent) => {
      if (mapMenuRef.current && !mapMenuRef.current.contains(e.target as Node)) {
        setMapSettingsOpen(false);
      }
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [mapSettingsOpen]);

  const jumpToFactionAnchor = useCallback(
    (fid: number) => {
      if (fid <= 0) return;
      const anchor = factionLabelsRef.current.find((a) => a.factionId === fid);
      if (!anchor) {
        addToast('この勢力の領土位置が見つかりません', 'info');
        return;
      }
      const minSide = Math.min(window.innerWidth, window.innerHeight);
      const targetZoom = Math.max(
        0.8,
        Math.min(10, (minSide * 0.45) / Math.max(anchor.spanW, anchor.spanH, 6))
      );
      rendererRef.current?.focusOn(anchor.centerX, anchor.centerY, targetZoom);
      refreshHoverFromLastMouseRef.current();
    },
    [addToast]
  );
  focusFactionAnchorRef.current = jumpToFactionAnchor;

  const focusFaction = useCallback(
    (fid: number) => {
      if (fid <= 0) return;
      // 勢力名非表示中や再計算待ちの間に呼ばれた場合は、最新ラベル取得完了後にジャンプする
      if (
        !timelapseModeRef.current &&
        logicWorkerRef.current &&
        (labelsStaleRef.current || labelRecomputeInFlightRef.current || recomputeTimerRef.current !== null)
      ) {
        pendingFocusFactionRef.current = fid;
        if (labelsStaleRef.current || recomputeTimerRef.current !== null) {
          clearScheduledLabelRecompute();
          labelsStaleRef.current = false;
          labelRecomputeInFlightRef.current = true;
          inFlightLabelBoardVersionRef.current = boardLabelVersionRef.current;
          const labelGen = ++labelGenRef.current;
          logicWorkerRef.current.postMessage({ type: 'recomputeLabels', labelGen });
        }
        return;
      }
      jumpToFactionAnchor(fid);
    },
    [clearScheduledLabelRecompute, jumpToFactionAnchor]
  );

  const pickColorAt = useCallback(
    (x: number, y: number) => {
      const buf = buffersRef.current;
      if (!buf) return;
      const sz = buf.boardSize;
      if (x < 0 || x >= sz || y < 0 || y >= sz) return;
      const snap = sabTrySnapshotRead(buf.ctrl, () => {
        const off = (y * sz + x) * CELL_BYTES;
        const raw = buf.rawCells;
        return {
          terrain: raw[off] & 1,
          fid: raw[off + 4] | (raw[off + 5] << 8),
          colorId: raw[off + 1] & 0x3f,
        };
      });
      if (!snap.ok) {
        addToast('盤面更新中のため色を取得できませんでした。再度お試しください', 'info');
        return;
      }
      const { terrain, fid, colorId } = snap.value;
      if (terrain !== 1) {
        addToast('海域からは色を拾えません', 'info');
        return;
      }
      if (fid === 0) {
        addToast('無所属の空き地からは色を拾えません', 'info');
        return;
      }
      setSelectedColorId(colorId);
      setEyedropperActive(false);
      addToast(`カラー #${colorId} をスポイトで取得しました`, 'info');
    },
    [addToast]
  );

  const copyCoordLink = useCallback(
    (x: number, y: number) => {
      const url = new URL(window.location.href);
      url.searchParams.set('x', String(x));
      url.searchParams.set('y', String(y));
      const zoom = rendererRef.current?.camera.zoom;
      if (zoom !== undefined) {
        url.searchParams.set('z', zoom.toFixed(2));
      }
      if (!navigator.clipboard) {
        addToast('この環境ではクリップボードコピーを利用できません', 'error');
        return;
      }
      navigator.clipboard.writeText(url.toString()).then(
        () => addToast(`座標 (${x}, ${y}) のリンクをコピーしました`, 'success'),
        () => addToast('クリップボードへのコピーに失敗しました', 'error')
      );
    },
    [addToast]
  );

  // キーボードショートカット
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      unlockAudio();

      if (e.key === 'Escape') {
        if (pendingWar) {
          setPendingWar(null);
        } else if (pendingJoinFactionId !== null) {
          setPendingJoinFactionId(null);
        } else if (modal) {
          setModal(null);
        } else if (mapSettingsOpen) {
          setMapSettingsOpen(false);
        } else if (mobileMenuOpen) {
          setMobileMenuOpen(false);
        } else if (timelapseMode) {
          closeTimelapse();
        } else if (eyedropperActive) {
          setEyedropperActive(false);
        } else if (selectedCell) {
          setSelectedCell(null);
          selectedInfoRef.current = null;
          clearHoverState();
          notifyInspectListeners();
        } else if (pinnedFactionId > 0) {
          setPinnedFactionId(0);
        }
      } else if (e.key === ' ' && timelapseMode && !modal && !pendingWar && pendingJoinFactionId === null) {
        e.preventDefault();
        if (timelapseFrames.length <= 1) return;
        if (!timelapsePlaying) {
          if (timelapseIndex >= timelapseFrames.length - 1) {
            setTimelapseIndex(0);
          } else if (timelapseLoadFailed) {
            setTimelapseRetrySeq((n) => n + 1);
          }
        }
        setTimelapsePlaying((p) => !p);
      } else if (
        timelapseMode &&
        !modal &&
        !pendingWar &&
        pendingJoinFactionId === null &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      ) {
        e.preventDefault();
        setTimelapsePlaying(false);
        setTimelapseIndex((p) =>
          e.key === 'ArrowLeft'
            ? Math.max(0, p - 1)
            : Math.min(Math.max(0, timelapseFrames.length - 1), p + 1)
        );
      } else if (!timelapseMode && !modal && !pendingWar && pendingJoinFactionId === null) {
        if (e.key >= '1' && e.key <= '5') {
          setOverlayMode((Number(e.key) - 1) as OverlayMode);
        } else if (e.key === 'm' || e.key === 'M') {
          setActionMode((prev) => {
            const next = prev === 0 ? 1 : 0;
            if (next === 0) setEyedropperActive(false);
            return next;
          });
        } else if (e.key === 'i' || e.key === 'I') {
          if (actionMode === 0) {
            setActionMode(1);
            setEyedropperActive(true);
          } else {
            setEyedropperActive((prev) => !prev);
          }
        } else if (e.key === 'c' || e.key === 'C') {
          setConfirmTapMode((prev) => {
            const next = !prev;
            if (!next) {
              setSelectedCell(null);
              selectedInfoRef.current = null;
              notifyInspectListeners();
            }
            return next;
          });
        } else if (e.key === 'h' || e.key === 'H') {
          if (user && user.faction_id > 0) {
            focusFaction(user.faction_id);
          }
        } else if (e.key === 'f' || e.key === 'F') {
          rendererRef.current?.fitBoard();
          refreshHoverFromLastMouseRef.current();
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          rendererRef.current?.panBy(56, 0);
          refreshHoverFromLastMouseRef.current();
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          rendererRef.current?.panBy(-56, 0);
          refreshHoverFromLastMouseRef.current();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          rendererRef.current?.panBy(0, 56);
          refreshHoverFromLastMouseRef.current();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          rendererRef.current?.panBy(0, -56);
          refreshHoverFromLastMouseRef.current();
        } else if (e.key === '+' || e.key === '=' || e.key === ';') {
          e.preventDefault();
          rendererRef.current?.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.25);
          refreshHoverFromLastMouseRef.current();
        } else if (e.key === '-') {
          e.preventDefault();
          rendererRef.current?.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.25);
          refreshHoverFromLastMouseRef.current();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    pendingWar,
    pendingJoinFactionId,
    modal,
    mapSettingsOpen,
    mobileMenuOpen,
    eyedropperActive,
    selectedCell,
    pinnedFactionId,
    timelapseMode,
    timelapsePlaying,
    timelapseIndex,
    timelapseLoadFailed,
    timelapseFrames.length,
    closeTimelapse,
    actionMode,
    user,
    focusFaction,
  ]);

  const requestInspect = useCallback((x: number, y: number, target: 'hover' | 'selected' = 'hover') => {
    const worker = logicWorkerRef.current;
    if (!worker) return;
    const cur = stateRef.current;
    const myFid = cur.user?.faction_id ?? 0;
    const warIds: number[] = [];
    if (myFid > 0) {
      for (const w of cur.diplomacy.wars) {
        if (w.faction_a === myFid) warIds.push(w.faction_b);
        if (w.faction_b === myFid) warIds.push(w.faction_a);
      }
    }
    const reqId = ++nextInspectReqIdRef.current;
    if (target === 'selected') {
      selectInspectReqIdRef.current = reqId;
    } else {
      hoverInspectReqIdRef.current = reqId;
    }
    worker.postMessage({
      type: 'inspect',
      requestId: reqId,
      x,
      y,
      myFactionId: myFid,
      mode: cur.actionMode,
      selectedColorId: cur.selectedColorId,
      warFactionIds: warIds,
      canDeclareWar: Boolean(cur.user?.permissions.can_declare_war),
      phase: cur.season.phase,
      costConfig: cur.season.cost_config,
      maxLayers: cur.season.game_rules?.max_layers,
    });
  }, []);

  /** 指定クライアント座標に対応する盤面セルへホバー表示と inspect を同期する */
  const syncMouseHoverAt = useCallback(
    (clientX: number, clientY: number) => {
      const renderer = rendererRef.current;
      if (!renderer || timelapseModeRef.current) return;
      const sz = stateRef.current.boardSize;
      const pos = renderer.screenToBoard(clientX, clientY);
      if (pos.x >= 0 && pos.x < sz && pos.y >= 0 && pos.y < sz) {
        if (renderer.hoverX !== pos.x || renderer.hoverY !== pos.y) {
          renderer.hoverX = pos.x;
          renderer.hoverY = pos.y;
          requestInspect(pos.x, pos.y);
        }
      } else {
        clearHoverState();
      }
    },
    [clearHoverState, requestInspect]
  );

  const refreshHoverFromLastMouse = useCallback(() => {
    const pt = lastMouseClientRef.current;
    if (!pt) return;
    syncMouseHoverAt(pt.x, pt.y);
  }, [syncMouseHoverAt]);
  refreshHoverFromLastMouseRef.current = refreshHoverFromLastMouse;

  refreshActiveInspectRef.current = () => {
    if (timelapseModeRef.current) return;
    const cur = stateRef.current;
    if (cur.selectedCell) {
      requestInspect(cur.selectedCell.x, cur.selectedCell.y, 'selected');
    }
    const r = rendererRef.current;
    if (r && r.hoverX >= 0 && r.hoverY >= 0) {
      requestInspect(r.hoverX, r.hoverY, 'hover');
    }
  };

  // 選択マスや操作モード変化時に選択中/ホバー中マスの詳細を再評価
  useEffect(() => {
    if (selectedCell) {
      requestInspect(selectedCell.x, selectedCell.y, 'selected');
    } else if (rendererRef.current && rendererRef.current.hoverX >= 0 && rendererRef.current.hoverY >= 0) {
      requestInspect(rendererRef.current.hoverX, rendererRef.current.hoverY, 'hover');
    }
  }, [
    selectedCell,
    actionMode,
    selectedColorId,
    actionSeq,
    user?.faction_id,
    user?.permissions.can_declare_war,
    diplomacy.wars,
    season.phase,
    season.cost_config,
    season.game_rules?.max_layers,
    requestInspect,
  ]);

  // WebGL2 レンダラーへ選択セル・勢力点滅ハイライト・操作アクセント色を同期
  useEffect(() => {
    syncRendererHoverVisuals();
  }, [selectedCell, pinnedFactionId, actionMode, selectedColorId, user?.faction_id, syncRendererHoverVisuals]);

  const executeActionAt = useCallback(
    (x: number, y: number, info: HoverInfo | null) => {
      const cur = stateRef.current;
      if (!cur.user) {
        setModal('auth');
        return;
      }
      if (cur.user.faction_id <= 0) {
        let clickedFactionId =
          info && info.x === x && info.y === y ? info.factionId : 0;
        if (clickedFactionId <= 0 && buffersRef.current) {
          const buf = buffersRef.current;
          if (x >= 0 && y >= 0 && x < buf.boardSize && y < buf.boardSize) {
            const snap = sabTrySnapshotRead(buf.ctrl, () => {
              const off = (y * buf.boardSize + x) * CELL_BYTES;
              if ((buf.rawCells[off] & 1) === 0) return 0;
              return buf.rawCells[off + 4] | (buf.rawCells[off + 5] << 8);
            });
            if (snap.ok) {
              clickedFactionId = snap.value;
            }
          }
        }
        if (
          clickedFactionId > 0 &&
          cur.factions.some((f) => f.id === clickedFactionId)
        ) {
          if (cur.season.phase === 'frozen') {
            addToast('凍結フェーズ中は勢力へ参加できません', 'info');
            return;
          }
          setPendingJoinFactionId(clickedFactionId);
          return;
        }
        setModal('faction');
        return;
      }
      if (info && info.x === x && info.y === y && info.needsWarConfirm) {
        setPendingWar({
          x,
          y,
          mode: cur.actionMode,
          colorId: cur.selectedColorId,
          targetFactionId: info.factionId,
          costAp: info.costAp,
        });
        return;
      }
      const actionId = ++nextActionIdRef.current;
      const hasMatchedInfo = Boolean(info && info.x === x && info.y === y);
      sentActionQueueRef.current.push({
        id: actionId,
        x,
        y,
        mode: cur.actionMode,
        colorId: cur.selectedColorId,
        costAp: hasMatchedInfo ? info!.costAp : 1,
        costKnown: hasMatchedInfo,
      });
      netWorkerRef.current?.postMessage({
        type: 'sendAction',
        actionId,
        x,
        y,
        mode: cur.actionMode,
        colorId: cur.selectedColorId,
        confirmWar: false,
        wsGen: wsGenRef.current,
      });
    },
    [addToast]
  );

  const dragStateRef = useRef({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    pointerId: -1,
  });
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ dist: number; midX: number; midY: number } | null>(null);
  const authGenRef = useRef(0);

  const handlePointerDown = (e: PointerEvent) => {
    unlockAudio();
    // マウス操作時は左クリックのみ受け付ける
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try {
      (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
    } catch {
      // キャプチャ不可のポインターは無視
    }

    const pointers = activePointersRef.current;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      // 2本指ピンチ開始
      const pts = Array.from(pointers.values());
      pinchRef.current = {
        dist: Math.max(1, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)),
        midX: (pts[0].x + pts[1].x) * 0.5,
        midY: (pts[0].y + pts[1].y) * 0.5,
      };
      dragStateRef.current.active = false;
      dragStateRef.current.moved = true;
      setIsDragging(true);
      return;
    }

    if (pointers.size === 1) {
      dragStateRef.current = {
        active: true,
        moved: false,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        pointerId: e.pointerId,
      };
    }
  };

  const handlePointerMove = (e: PointerEvent) => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    const pointers = activePointersRef.current;
    if (pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // 2本指ピンチズーム & パン
    if (pointers.size >= 2) {
      const pts = Array.from(pointers.values());
      const dist = Math.max(1, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
      const midX = (pts[0].x + pts[1].x) * 0.5;
      const midY = (pts[0].y + pts[1].y) * 0.5;
      const prev = pinchRef.current;
      if (prev) {
        renderer.panBy(midX - prev.midX, midY - prev.midY);
        const factor = dist / prev.dist;
        if (Math.abs(factor - 1) > 0.002) {
          renderer.zoomAt(midX, midY, factor);
        }
      }
      pinchRef.current = { dist, midX, midY };
      return;
    }

    const ds = dragStateRef.current;
    if (ds.active && ds.pointerId === e.pointerId) {
      if (e.pointerType === 'mouse' && (e.buttons & 1) === 0) {
        handlePointerCancel(e);
        return;
      }
      const dx = e.clientX - ds.lastX;
      const dy = e.clientY - ds.lastY;
      if (!ds.moved && Math.hypot(e.clientX - ds.startX, e.clientY - ds.startY) > 6) {
        ds.moved = true;
        setIsDragging(true);
        if (e.pointerType === 'mouse') {
          clearHoverState();
        }
      }
      if (ds.moved) {
        renderer.panBy(dx, dy);
      }
      ds.lastX = e.clientX;
      ds.lastY = e.clientY;
    }

    // マウス操作時のみリアルタイムホバー更新（ドラッグ中やタイムラプス中は不要な inspect を抑制）
    if (e.pointerType === 'mouse') {
      lastMouseClientRef.current = { x: e.clientX, y: e.clientY };
      if (!timelapseModeRef.current && !(ds.active && ds.moved)) {
        syncMouseHoverAt(e.clientX, e.clientY);
      }
    }
  };

  const handlePointerUp = (e: PointerEvent) => {
    // 未登録の非左クリックマウスボタン解除は無視し、登録済みポインターは必ず解放する
    if (e.pointerType === 'mouse' && e.button !== 0 && !activePointersRef.current.has(e.pointerId)) return;
    try {
      const target = e.currentTarget as HTMLElement | null;
      if (target?.hasPointerCapture?.(e.pointerId)) {
        target.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }

    const pointers = activePointersRef.current;
    pointers.delete(e.pointerId);
    if (pointers.size >= 2) {
      // 3本指→2本指復帰時に現在の2指でピンチ基準を再初期化する
      const pts = Array.from(pointers.values());
      pinchRef.current = {
        dist: Math.max(1, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)),
        midX: (pts[0].x + pts[1].x) * 0.5,
        midY: (pts[0].y + pts[1].y) * 0.5,
      };
    } else {
      pinchRef.current = null;
    }

    const ds = dragStateRef.current;
    const wasDraggingMouse = e.pointerType === 'mouse' && ds.active && ds.pointerId === e.pointerId && ds.moved;
    const wasClick =
      ds.active && ds.pointerId === e.pointerId && !ds.moved && (e.pointerType !== 'mouse' || e.button === 0);
    if (ds.pointerId === e.pointerId) {
      ds.active = false;
      ds.pointerId = -1;
    }
    // 2本指ピンチから片方の指を離した場合、残りの1本指でパンを継続できるようにする
    if (pointers.size === 1) {
      const [remId, remPt] = Array.from(pointers.entries())[0];
      dragStateRef.current = {
        active: true,
        moved: true,
        startX: remPt.x,
        startY: remPt.y,
        lastX: remPt.x,
        lastY: remPt.y,
        pointerId: remId,
      };
    }
    if (pointers.size === 0) {
      setIsDragging(false);
    }

    if (wasDraggingMouse) {
      const overCanvas =
        canvasRef.current !== null &&
        document.elementFromPoint(e.clientX, e.clientY) === canvasRef.current;
      if (overCanvas) {
        lastMouseClientRef.current = { x: e.clientX, y: e.clientY };
        syncMouseHoverAt(e.clientX, e.clientY);
      } else {
        lastMouseClientRef.current = null;
        clearHoverState();
      }
    }

    if (!wasClick || timelapseModeRef.current) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const sz = stateRef.current.boardSize;
    const pos = renderer.screenToBoard(e.clientX, e.clientY);
    if (pos.x < 0 || pos.x >= sz || pos.y < 0 || pos.y >= sz) return;

    const isTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
    const cur = stateRef.current;

    if (cur.actionMode === 1 && cur.eyedropperActive) {
      pickColorAt(pos.x, pos.y);
      return;
    }

    // タッチ端末または「確認クリック」ON時: 1タップ目で選択＆点滅ハイライト、同じマス再タップで実行
    if (isTouch || cur.confirmTapMode) {
      if (cur.selectedCell && cur.selectedCell.x === pos.x && cur.selectedCell.y === pos.y) {
        executeActionAt(pos.x, pos.y, selectedInfoRef.current ?? hoverInfoRef.current);
      } else {
        selectedInfoRef.current = null;
        setSelectedCell({ x: pos.x, y: pos.y });
        setPinnedFactionId(0);
        notifyInspectListeners();
        playSelectSound();
      }
      return;
    }

    // PC 通常クリック: 即座に実行
    executeActionAt(pos.x, pos.y, hoverInfoRef.current);
  };

  const handlePointerCancel = (e: PointerEvent) => {
    try {
      const target = e.currentTarget as HTMLElement | null;
      if (target?.hasPointerCapture?.(e.pointerId)) {
        target.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
    const pointers = activePointersRef.current;
    pointers.delete(e.pointerId);
    if (pointers.size >= 2) {
      // 3本指→2本指復帰時に現在の2指でピンチ基準を再初期化する
      const pts = Array.from(pointers.values());
      pinchRef.current = {
        dist: Math.max(1, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)),
        midX: (pts[0].x + pts[1].x) * 0.5,
        midY: (pts[0].y + pts[1].y) * 0.5,
      };
    } else {
      pinchRef.current = null;
    }
    if (dragStateRef.current.pointerId === e.pointerId) {
      dragStateRef.current.active = false;
      dragStateRef.current.pointerId = -1;
    }
    if (pointers.size === 1) {
      const [remId, remPt] = Array.from(pointers.entries())[0];
      dragStateRef.current = {
        active: true,
        moved: true,
        startX: remPt.x,
        startY: remPt.y,
        lastX: remPt.x,
        lastY: remPt.y,
        pointerId: remId,
      };
    }
    if (pointers.size === 0) {
      setIsDragging(false);
    }
    if (e.type === 'pointercancel' && e.pointerType === 'mouse') {
      lastMouseClientRef.current = null;
      clearHoverState();
    }
  };

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    rendererRef.current?.zoomAt(e.clientX, e.clientY, factor);
    lastMouseClientRef.current = { x: e.clientX, y: e.clientY };
    syncMouseHoverAt(e.clientX, e.clientY);
  };

  const handleAuthSuccess = (nextUser: UserProfile) => {
    authGenRef.current += 1;
    cancelPendingMetadataRefresh();
    if (logoutConfirmTimerRef.current !== null) {
      window.clearTimeout(logoutConfirmTimerRef.current);
      logoutConfirmTimerRef.current = null;
    }
    setLogoutConfirm(false);
    stateRef.current = { ...stateRef.current, user: nextUser };
    setUser(nextUser);
    clearToasts();
    clearNotifications();
    closeActiveBrowserNotifs();
    clearSelfAcceptCeasefireEntries();
    resolvedJoinReqSeqRef.current.clear();
    joinPermRevokedSeqRef.current = 0;
    if (modalRef.current === 'notifications') {
      setModal(null);
    }
    setPendingWar(null);
    setPendingJoinFactionId(null);
    setSelectedCell(null);
    selectedInfoRef.current = null;
    clearHoverState();
    notifyInspectListeners();
    setPinnedFactionId(0);
    sentActionQueueRef.current = [];
    const inv = ++nextInspectReqIdRef.current;
    hoverInspectReqIdRef.current = inv;
    selectInspectReqIdRef.current = inv;
    netWorkerRef.current?.postMessage({
      type: 'reconnect',
      wsUrl: buildWsUrl(),
      wsGen: ++wsGenRef.current,
    });
    void refreshMetadata(true);
  };

  const handleLogout = async () => {
    const gen = ++authGenRef.current;
    if (logoutConfirmTimerRef.current !== null) {
      window.clearTimeout(logoutConfirmTimerRef.current);
      logoutConfirmTimerRef.current = null;
    }
    setLogoutConfirm(false);
    cancelPendingMetadataRefresh();
    try {
      await api.logout();
    } catch (err) {
      // 401（既にセッション失効済み）以外のエラー時はローカル認証状態を維持して通知する
      if (!(err instanceof ApiError && err.status === 401)) {
        addToast(`ログアウトに失敗しました: ${err instanceof Error ? err.message : String(err)}`, 'error');
        return;
      }
    }
    // ログアウト完了待ちの間に別ユーザーでのログインが完了していた場合は状態を上書きしない
    if (authGenRef.current !== gen) return;
    cancelPendingMetadataRefresh();
    stateRef.current = { ...stateRef.current, user: null };
    setUser(null);
    clearToasts();
    clearNotifications();
    closeActiveBrowserNotifs();
    clearSelfAcceptCeasefireEntries();
    resolvedJoinReqSeqRef.current.clear();
    joinPermRevokedSeqRef.current = 0;
    if (modalRef.current === 'notifications') {
      setModal(null);
    }
    setPendingWar(null);
    setPendingJoinFactionId(null);
    setSelectedCell(null);
    selectedInfoRef.current = null;
    clearHoverState();
    notifyInspectListeners();
    setPinnedFactionId(0);
    sentActionQueueRef.current = [];
    const inv = ++nextInspectReqIdRef.current;
    hoverInspectReqIdRef.current = inv;
    selectInspectReqIdRef.current = inv;
    netWorkerRef.current?.postMessage({
      type: 'reconnect',
      wsUrl: buildWsUrl(),
      wsGen: ++wsGenRef.current,
    });
    addToast('ログアウトしました', 'info');
  };

  const myFaction = user && user.faction_id > 0 ? factionMap.get(user.faction_id) : undefined;
  const maxLayers = season.game_rules?.max_layers ?? 10;
  const assimilationReq = season.game_rules?.assimilation_required_ticks ?? 10;
  const tickIntervalMin = Math.max(1, season.game_rules?.tick_interval_minutes ?? 30);
  const tickUnit = tickIntervalMin === 60 ? '時間' : ' Tick';
  const tickShortUnit = tickIntervalMin === 60 ? 'h' : ' Tick';
  const enemyCoreMult = season.cost_config?.enemy_core_multiplier ?? 2;
  const pinnedFaction = pinnedFactionId > 0 ? factionMap.get(pinnedFactionId) : undefined;
  const availableAp = user?.ap ?? 0;
  const needModalsModule =
    modal === 'auth' ||
    modal === 'diplomacy' ||
    modal === 'ranking' ||
    modal === 'logs' ||
    modal === 'notifications' ||
    modal === 'help' ||
    (pendingJoinFactionId !== null &&
      Boolean(user && user.faction_id <= 0 && factionMap.has(pendingJoinFactionId))) ||
    pendingWar !== null;
  const { mod: modalsMod, error: modalsLoadError, retry: retryModalsLoad } =
    useModalsModule(needModalsModule);
  const getMinimapGpuTex = useCallback(() => buffersRef.current?.gpuTex ?? null, []);
  const getMinimapCtrl = useCallback(() => buffersRef.current?.ctrl, []);
  const getMinimapViewport = useCallback(
    () => rendererRef.current?.getViewportBounds() ?? null,
    []
  );
  const handleMinimapJumpTo = useCallback((bx: number, by: number) => {
    rendererRef.current?.focusOn(bx, by);
    refreshHoverFromLastMouseRef.current();
  }, []);
  const isFrozenPhase = season.phase === 'frozen';
  const canManageJoin =
    !isFrozenPhase && Boolean(user && user.faction_id > 0 && user.permissions.can_manage_members);
  const canManageCeasefire =
    !isFrozenPhase && Boolean(user && user.faction_id > 0 && user.permissions.can_ceasefire);
  const incomingJoinRequestCount = canManageJoin
    ? (user?.incoming_join_requests?.length ?? 0)
    : 0;
  const ceasefireOfferCount = useMemo(
    () =>
      canManageCeasefire && user
        ? diplomacy.ceasefire_proposals.filter((p) => p.to_faction_id === user.faction_id).length
        : 0,
    [canManageCeasefire, diplomacy.ceasefire_proposals, user]
  );
  const { unreadJoinAction, unreadCeasefireAction, unreadOther } = useMemo(() => {
    let joinAction = 0;
    let ceasefireAction = 0;
    let other = 0;
    for (const n of notifications) {
      if (n.read) continue;
      if (n.actionKind === 'join_request') joinAction++;
      else if (n.actionKind === 'ceasefire_offer') ceasefireAction++;
      else other++;
    }
    return { unreadJoinAction: joinAction, unreadCeasefireAction: ceasefireAction, unreadOther: other };
  }, [notifications]);
  const notificationBadgeCount =
    (canManageJoin ? Math.max(incomingJoinRequestCount, unreadJoinAction) : unreadJoinAction) +
    (canManageCeasefire ? Math.max(ceasefireOfferCount, unreadCeasefireAction) : unreadCeasefireAction) +
    unreadOther;

  const markAllNotificationsRead = useCallback(() => {
    setNotifications((prev) =>
      prev.some((n) => !n.read) ? prev.map((n) => (n.read ? n : { ...n, read: true })) : prev
    );
  }, []);

  const openNotificationsModal = () => {
    setPendingWar(null);
    setPendingJoinFactionId(null);
    syncBrowserNotifPermission();
    closeActiveBrowserNotifs();
    setModal('notifications');
    setMobileMenuOpen(false);
    void refreshMetadata();
  };
  openNotificationsModalRef.current = openNotificationsModal;

  if (glError) {
    return (
      <div class="admin-shell">
        <div class="admin-login-card" style={{ maxWidth: '460px', textAlign: 'center' }}>
          <h2 style={{ marginBottom: '12px', color: '#fca5a5' }}>WebGL2 を利用できません</h2>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.7, marginBottom: '16px' }}>
            庭園勢力図のマップ描画には WebGL2 対応ブラウザおよびハードウェアアクセラレーションが必要です。
          </p>
          <div class="admin-alert admin-alert-err" style={{ marginBottom: '16px', fontSize: '12px' }}>
            {glError}
          </div>
          <button class="btn btn-primary" onClick={() => window.location.reload()}>
            再読み込み
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="viewport">
      <canvas
        ref={canvasRef}
        class={`board-canvas ${isDragging ? 'dragging' : ''} ${actionMode === 1 && eyedropperActive && !timelapseMode ? 'eyedropper' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handlePointerCancel}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') {
            lastMouseClientRef.current = null;
            clearHoverState();
          }
        }}
        onWheel={handleWheel}
        onContextMenu={(e) => {
          e.preventDefault();
          if (timelapseModeRef.current) return;
          if (rendererRef.current) {
            const pos = rendererRef.current.screenToBoard(e.clientX, e.clientY);
            pickColorAt(pos.x, pos.y);
          }
        }}
      />
      <canvas ref={labelCanvasRef} class="label-canvas" />
      {!boardLoaded && !timelapseMode && (
        <div class="board-loading-overlay" aria-live="polite">
          <div class="board-loading-spinner" />
          <span>盤面を読み込み中...</span>
        </div>
      )}

      {/* トップ HUD バー（PCは1行、スマホはコンパクトヘッダー＋開閉メニュー） */}
      <header class="top-bar" ref={headerRef}>
        <div class="top-bar-main">
          <div class="brand-group">
            <span class="brand-title">庭園勢力図</span>
            <span
              class={`phase-badge phase-${season.phase}`}
              title={
                season.phase === 'active'
                  ? '開催中: マスの塗抹・外交・拡張が可能です（残りTick数に基づく開催時間）'
                  : season.phase === 'preparation'
                    ? '準備中: 既存勢力への参加や参加申請・承認ができます'
                    : '凍結中: シーズン終了・閲覧専用です'
              }
            >
              {formatPhaseBadgeLabel(season)}
            </span>
            <span
              class="tick-info"
              title={`Tick は${tickIntervalMin === 60 ? '1時間' : `${tickIntervalMin}分`}ごとのターン進行です。次回AP付与までのカウントダウンを表示しています`}
            >
              {boardSize}×{boardSize} / Tick {season.tick_number}/{season.max_ticks}
              <TickCountdown
                phase={season.phase}
                nextTickUnix={season.next_tick_unix}
                prefix=" / 次回付与 "
                onResyncNeeded={scheduleJitteredMetadataRefresh}
              />
            </span>
          </div>

          <div class="mobile-quick-bar">
            {user && (
              <div
                class="ap-pill ap-pill-compact"
                title={formatApRefillTooltip(season, user.max_ap)}
              >
                <span>AP {user.ap}/{user.max_ap}</span>
              </div>
            )}
            <button
              class="btn btn-sm"
              title="遊び方・ルールマニュアルを開く"
              onClick={() => setModal('help')}
            >
              ？
            </button>
            <button
              class={`btn btn-sm ${mobileMenuOpen ? 'btn-primary' : ''}`}
              aria-label="メニューを開く"
              onClick={() => setMobileMenuOpen((prev) => !prev)}
            >
              {mobileMenuOpen ? '閉じる' : '☰ メニュー'}
              {!mobileMenuOpen && notificationBadgeCount > 0 && (
                <span class="nav-badge">{notificationBadgeCount}</span>
              )}
            </button>
          </div>
        </div>

        <div class={`top-bar-nav ${mobileMenuOpen ? 'open' : ''}`}>
          <div class="mobile-tick-row">
            {boardSize}×{boardSize} / Tick {season.tick_number}/{season.max_ticks}
            <TickCountdown
              phase={season.phase}
              nextTickUnix={season.next_tick_unix}
              prefix=" / 次回AP付与 "
            />
          </div>

          <div class="map-settings-wrap" ref={mapMenuRef}>
            <button
              class={`btn ${mapSettingsOpen ? 'btn-primary' : ''}`}
              title="マップの表示モードや中核印・勢力名の表示を切り替えます"
              onClick={() => setMapSettingsOpen((prev) => !prev)}
            >
              マップ設定: {OVERLAY_LABELS.find((i) => i.mode === overlayMode)?.label ?? '標準'} ▾
            </button>
            {mapSettingsOpen && (
              <div class="map-settings-menu">
                <div class="map-settings-title">表示モード</div>
                <div class="map-settings-modes">
                  {OVERLAY_LABELS.map((item) => (
                    <button
                      key={item.mode}
                      class={`map-settings-option ${overlayMode === item.mode ? 'active' : ''}`}
                      title={item.desc}
                      onClick={() => {
                        setOverlayMode(item.mode);
                        setMapSettingsOpen(false);
                      }}
                    >
                      <div>{item.label}</div>
                      <div class="map-settings-option-desc">{item.desc}</div>
                    </button>
                  ))}
                </div>
                <div class="map-settings-divider" />
                <label class="map-settings-check" title="ズーム時に中核マスの右上へ金色の印を表示します">
                  <input
                    type="checkbox"
                    checked={showCoreMarker}
                    onChange={(e) => setShowCoreMarker((e.target as HTMLInputElement).checked)}
                  />
                  <span>中核マスの印を表示</span>
                </label>
                <label class="map-settings-check" title="各勢力のメイン領土の中央に勢力名を表示します">
                  <input
                    type="checkbox"
                    checked={showFactionNames}
                    onChange={(e) => setShowFactionNames((e.target as HTMLInputElement).checked)}
                  />
                  <span>勢力名をマップに表示</span>
                </label>
              </div>
            )}
          </div>

          <div class="nav-actions">
            {user && (
              <div
                class="ap-pill desktop-only-ap"
                title={formatApRefillTooltip(season, user.max_ap)}
              >
                <span>
                  AP {user.ap}/{user.max_ap}
                </span>
                {user.auto_paint_enabled &&
                  user.faction_id > 0 &&
                  user.faction_allow_auto_paint !== false && (
                    <span class="ap-auto-tag">自動</span>
                  )}
                <div class="ap-bar-bg">
                  <div
                    class="ap-bar-fill"
                    style={{ width: `${Math.min(100, (user.ap / user.max_ap) * 100)}%` }}
                  />
                </div>
              </div>
            )}

            <button
              class="btn"
              title="勢力の設立・参加・権限設定・自動塗り"
              onClick={() => {
                setModal('faction');
                setMobileMenuOpen(false);
              }}
            >
              {myFaction ? (
                <span>
                  <span
                    class="color-dot"
                    style={{ background: PALETTE_HEX[myFaction.color_id] }}
                  />
                  {myFaction.name}
                </span>
              ) : (
                '勢力'
              )}
              {incomingJoinRequestCount > 0 && (
                <span class="nav-badge">{incomingJoinRequestCount}</span>
              )}
            </button>

            <button
              class="btn"
              title="戦争中の勢力確認と停戦提案・受諾"
              onClick={() => {
                setModal('diplomacy');
                setMobileMenuOpen(false);
              }}
            >
              外交 ({diplomacy.wars.length})
              {ceasefireOfferCount > 0 && <span class="nav-badge">{ceasefireOfferCount}</span>}
            </button>

            <button
              class="btn"
              title="勢力ランキング確認（勢力クリックでマップ上を点滅ハイライト）"
              onClick={() => {
                setModal('ranking');
                setMobileMenuOpen(false);
              }}
            >
              ランキング
            </button>

            <button
              class="btn"
              title="プレイヤーの領土塗抹・外交・AP利用の行動履歴"
              onClick={() => {
                setModal('logs');
                setMobileMenuOpen(false);
              }}
            >
              行動ログ
            </button>

            <button
              class="btn"
              title="開戦・停戦・参加申請の通知一覧を確認します"
              aria-label="通知一覧を開く"
              onClick={openNotificationsModal}
            >
              🔔<span class="mobile-only-inline"> 通知</span>
              {notificationBadgeCount > 0 && (
                <span class="nav-badge">{notificationBadgeCount}</span>
              )}
            </button>

            <button
              class={`btn ${timelapseMode ? 'btn-gold' : ''}`}
              title="記録された各Tickの勢力図をプレイヤーのマップ設定に合わせてタイムラプス再生します"
              onClick={() => {
                if (timelapseMode) {
                  closeTimelapse();
                } else {
                  void openTimelapse();
                }
              }}
            >
              タイムラプス
            </button>

            <button
              class="btn"
              title={soundMuted ? '効果音をオンにする' : '効果音をミュートにする'}
              aria-label={soundMuted ? '効果音をオンにする' : '効果音をミュートにする'}
              onClick={() => {
                const next = !soundMuted;
                setSoundMuted(next);
                setSoundMutedState(next);
                if (!next) playSelectSound();
              }}
            >
              {soundMuted ? '🔇' : '🔊'}
              <span class="mobile-only-inline">{soundMuted ? ' 消音' : ' 音'}</span>
            </button>

            <button
              class="btn desktop-only-help"
              title="遊び方・操作方法・ルールのマニュアルを開く"
              aria-label="遊び方・ゲームルールを開く"
              onClick={() => setModal('help')}
            >
              ？
            </button>

            {user ? (
              <button
                class={`btn ${logoutConfirm ? 'btn-danger' : ''}`}
                title={
                  logoutConfirm
                    ? 'もう一度クリックするとログアウトします'
                    : '現在のアカウントからログアウトします'
                }
                onClick={() => {
                  if (!logoutConfirm) {
                    setLogoutConfirm(true);
                    if (logoutConfirmTimerRef.current !== null) {
                      window.clearTimeout(logoutConfirmTimerRef.current);
                    }
                    logoutConfirmTimerRef.current = window.setTimeout(() => {
                      logoutConfirmTimerRef.current = null;
                      setLogoutConfirm(false);
                    }, 3000);
                    return;
                  }
                  setMobileMenuOpen(false);
                  void handleLogout();
                }}
              >
                {logoutConfirm ? 'ログアウト確定？' : `${user.username} (ログアウト)`}
              </button>
            ) : (
              <button
                class="btn btn-primary"
                title="アカウント登録またはログインして参加します"
                onClick={() => {
                  setModal('auth');
                  setMobileMenuOpen(false);
                }}
              >
                ログイン / 登録
              </button>
            )}
          </div>
        </div>
      </header>

      {/* 上部通知バナー群（重ならないよう縦並びスタック） */}
      {(pinnedFaction ||
        season.phase === 'frozen' ||
        (overlayMode !== 0 && !timelapseMode) ||
        (actionMode === 1 && eyedropperActive && !timelapseMode) ||
        (!timelapseMode &&
          !onboardingDismissed &&
          (!user || user.faction_id <= 0))) && (
        <div class="top-banner-stack">
          {actionMode === 1 && eyedropperActive && !timelapseMode && (
            <div class="eyedropper-banner">
              <span>💧 スポイトモード中: マスをクリックして色を取得</span>
              <button class="btn btn-sm" onClick={() => setEyedropperActive(false)}>
                解除
              </button>
            </div>
          )}
          {pinnedFaction && (
            <div class="highlight-banner">
              <span>
                <button
                  type="button"
                  class="faction-link-btn"
                  title="クリックで領土へカメラ移動"
                  onClick={() => focusFaction(pinnedFaction.id)}
                >
                  <span
                    class="color-dot"
                    style={{ background: PALETTE_HEX[pinnedFaction.color_id] }}
                  />
                  <strong>{pinnedFaction.name}</strong>
                </button>{' '}
                を点滅ハイライト中
              </span>
              <button class="btn btn-sm" onClick={() => setPinnedFactionId(0)}>
                解除
              </button>
            </div>
          )}
          {season.phase === 'frozen' && (
            <button type="button" class="frozen-banner" onClick={() => setModal('ranking')}>
              シーズン #{season.season_id} 盤面凍結中 —{' '}
              <span class="desktop-only-inline">クリックして最終結果ランキングを表示</span>
              <span class="mobile-only-inline">最終結果を見る</span>
            </button>
          )}
          {!timelapseMode &&
            season.phase !== 'frozen' &&
            !onboardingDismissed &&
            (!user || user.faction_id <= 0) && (
              <div class="onboarding-banner">
                <span>
                  {!user
                    ? 'ステップ 1: ログインまたは新規登録して勢力図に参加しよう'
                    : 'ステップ 2: 既存の勢力に参加するか、新しい勢力を設立して領土を塗ろう'}
                </span>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  {!user ? (
                    <button
                      type="button"
                      class="btn btn-primary btn-sm"
                      onClick={() => setModal('auth')}
                    >
                      ログイン / 登録
                    </button>
                  ) : (
                    <button
                      type="button"
                      class="btn btn-primary btn-sm"
                      onClick={() => setModal('faction')}
                    >
                      勢力を選ぶ / 設立
                    </button>
                  )}
                  <button
                    type="button"
                    class="btn btn-sm"
                    title="ガイドを閉じる"
                    onClick={() => setOnboardingDismissed(true)}
                  >
                    ×
                  </button>
                </div>
              </div>
            )}
          {overlayMode !== 0 && !timelapseMode && (
            <div class="overlay-legend">
              {overlayMode === 1 && (
                <>
                  <span class="legend-title">勢力色モード:</span>
                  <span>各勢力の代表色で領土を表示</span>
                </>
              )}
              {overlayMode === 2 && (
                <>
                  <span class="legend-title">層数:</span>
                  <span>
                    <span class="color-dot" style={{ background: '#33b87a' }} /> 1層 →{' '}
                    <span class="color-dot" style={{ background: '#f5d633' }} /> 中間 →{' '}
                    <span class="color-dot" style={{ background: '#e6145c' }} /> 最大層
                  </span>
                </>
              )}
              {overlayMode === 3 && (
                <>
                  <span class="legend-title">中核/同化:</span>
                  <span>
                    <span class="color-dot" style={{ background: '#facc15' }} /> 中核
                  </span>
                  <span>
                    <span class="color-dot" style={{ background: '#22d3ee' }} /> 同化中
                  </span>
                  <span>
                    <span class="color-dot" style={{ background: '#c084fc' }} /> 旧中核
                  </span>
                </>
              )}
              {overlayMode === 4 && (
                <>
                  <span class="legend-title">外交:</span>
                  <span>
                    <span class="color-dot" style={{ background: '#22c55e' }} /> 自勢力
                  </span>
                  <span>
                    <span class="color-dot" style={{ background: '#ef4444' }} /> 交戦中
                  </span>
                  <span>
                    <span class="color-dot" style={{ background: '#94a3b8' }} /> 中立
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* ミニマップ */}
      {!timelapseMode && (
        <Minimap
          boardSize={boardSize}
          getGpuTex={getMinimapGpuTex}
          getCtrl={getMinimapCtrl}
          getViewport={getMinimapViewport}
          onJumpTo={handleMinimapJumpTo}
          subscribeBoardChange={subscribeBoardChange}
        />
      )}

      {/* 左上: 管理者デバッグパネル（モードON時のみ表示） */}
      {adminDebugMode && (
        <LazyDebugPanel
          currentUser={user}
          currentPhase={season.phase}
          devMode={season.dev_mode}
          maxAp={season.ap_config?.max_ap}
          wsConnected={wsConnected}
          onSwitchUser={handleAuthSuccess}
          onRefresh={forceRefreshMetadata}
          onDisableMode={() => {
            setAdminDebugMode(false);
            setAdminDebugModeState(false);
            addToast('管理者デバッグパネルを非表示にしました', 'info');
          }}
          onOpenAdmin={onOpenAdmin}
          onToast={addToast}
        />
      )}

      {/* 下部 HUD（タイムラプス中は再生バー、通常時はセル情報＋ツール） */}
      {timelapseMode ? (
        <aside class="timelapse-bar">
          <div class="timelapse-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span class="debug-badge">タイムラプス再生中</span>
              <span style={{ fontSize: '12px', fontWeight: 700 }}>
                Tick #{timelapseFrames[timelapseIndex]?.tick_number ?? 0}
              </span>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                ({timelapseIndex + 1} / {timelapseFrames.length})
                {timelapseFrames[timelapseIndex] &&
                  ` · ${new Date(timelapseFrames[timelapseIndex].created_at).toLocaleString('ja-JP', {
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}`}
              </span>
              {timelapseLoading && (
                <span style={{ fontSize: '11px', color: '#fde047' }}>読込中...</span>
              )}
            </div>
            <button class="btn btn-danger btn-sm" onClick={closeTimelapse}>
              ライブ盤面へ戻る
            </button>
          </div>

          <input
            type="range"
            class="slider"
            min={0}
            max={Math.max(0, timelapseFrames.length - 1)}
            value={timelapseIndex}
            onInput={(e) => {
              setTimelapsePlaying(false);
              setTimelapseIndex(Number((e.target as HTMLInputElement).value));
            }}
          />

          <div class="timelapse-controls">
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button
                class="btn btn-sm"
                disabled={timelapseIndex <= 0}
                onClick={() => {
                  setTimelapsePlaying(false);
                  setTimelapseIndex((p) => Math.max(0, p - 1));
                }}
              >
                ◀ 前へ
              </button>
              <button
                class="btn btn-primary btn-sm"
                disabled={timelapseFrames.length <= 1}
                title={timelapseFrames.length <= 1 ? '再生可能な複数フレームがありません' : undefined}
                onClick={() => {
                  if (!timelapsePlaying) {
                    if (timelapseIndex >= timelapseFrames.length - 1) {
                      setTimelapseIndex(0);
                    } else if (timelapseLoadFailed) {
                      setTimelapseRetrySeq((n) => n + 1);
                    }
                  }
                  setTimelapsePlaying((p) => !p);
                }}
              >
                {timelapsePlaying ? '❚❚ 一時停止' : '▶ 再生'}
              </button>
              <button
                class="btn btn-sm"
                disabled={timelapseIndex >= timelapseFrames.length - 1}
                onClick={() => {
                  setTimelapsePlaying(false);
                  setTimelapseIndex((p) => Math.min(timelapseFrames.length - 1, p + 1));
                }}
              >
                次へ ▶
              </button>
            </div>

            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>速度:</span>
              {[1, 2, 4, 8].map((spd) => (
                <button
                  key={spd}
                  class={`btn btn-sm ${timelapseSpeed === spd ? 'btn-gold' : ''}`}
                  onClick={() => setTimelapseSpeed(spd)}
                >
                  {spd}x
                </button>
              ))}
            </div>
          </div>
        </aside>
      ) : (
        <div class="bottom-hud">
        {/* セル情報インスペクタ & 選択マス実行ボタン */}
        <HoverInspectorPanel
          subscribeInspect={subscribeInspect}
          getActiveInfo={getActiveInfo}
          selectedCell={selectedCell}
          factionMap={factionMap}
          user={user}
          season={season}
          actionMode={actionMode}
          availableAp={availableAp}
          maxLayers={maxLayers}
          assimilationReq={assimilationReq}
          tickUnit={tickUnit}
          tickShortUnit={tickShortUnit}
          enemyCoreMult={enemyCoreMult}
          onCopyCoordLink={copyCoordLink}
          onClearSelection={() => {
            setSelectedCell(null);
            selectedInfoRef.current = null;
            clearHoverState();
            notifyInspectListeners();
          }}
          onTogglePinFaction={(fid) =>
            setPinnedFactionId((prev) => (prev === fid ? 0 : fid))
          }
          onExecuteSelected={executeActionAt}
        />

        {/* ツール & 64色パレット */}
        <aside class="tool-panel">
          <div class="mode-switch">
            <PaintActionButton
              subscribeInspect={subscribeInspect}
              getActiveInfo={getActiveInfo}
              actionMode={actionMode}
              availableAp={availableAp}
              phase={season.phase}
              user={user}
              onSelectPaintMode={() => {
                setActionMode(0);
                setEyedropperActive(false);
              }}
            />
            <button
              class={`mode-btn ${actionMode === 1 ? 'active' : ''}`}
              title="自勢力のマスの表示色を64色から自由に変更します"
              onClick={() => setActionMode(1)}
            >
              マス色変更
            </button>
          </div>

          {actionMode === 1 && (
            <>
              <div class="palette-tools-row">
                <button
                  type="button"
                  class={`btn btn-sm ${eyedropperActive ? 'btn-primary' : ''}`}
                  title="マップ上のマスをクリック（または右クリック）して色を拾います (I)"
                  onClick={() => setEyedropperActive((prev) => !prev)}
                >
                  スポイト<span class="desktop-only-inline"> (I)</span>
                </button>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  選択中:{' '}
                  <span
                    class="color-dot"
                    style={{ background: PALETTE_HEX[selectedColorId] }}
                  />
                  #{selectedColorId}
                </span>
              </div>
              {recentColors.length > 0 && (
                <div class="recent-colors-row" title="最近使った色">
                  {recentColors.map((cid) => (
                    <button
                      key={cid}
                      type="button"
                      class={`recent-swatch ${selectedColorId === cid ? 'selected' : ''}`}
                      style={{ background: PALETTE_HEX[cid] }}
                      title={`最近使った色 #${cid}`}
                      aria-label={`最近使ったカラー #${cid}`}
                      onClick={() => {
                        setSelectedColorId(cid);
                        setEyedropperActive(false);
                      }}
                    />
                  ))}
                </div>
              )}
              <div class="palette-grid">
                {PALETTE_HEX.map((hex, idx) => (
                  <button
                    key={idx}
                    class={`swatch ${selectedColorId === idx ? 'selected' : ''}`}
                    style={{ background: hex }}
                    title={`ID #${idx} (${hex})`}
                    aria-label={`カラー #${idx}`}
                    onClick={() => {
                      setSelectedColorId(idx);
                      setEyedropperActive(false);
                    }}
                  />
                ))}
              </div>
            </>
          )}

          <div class="tool-footer">
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <button
                class="btn btn-sm"
                title="マップを拡大"
                onClick={() => {
                  rendererRef.current?.zoomAt(
                    window.innerWidth / 2,
                    window.innerHeight / 2,
                    1.5
                  );
                  refreshHoverFromLastMouse();
                }}
              >
                ＋
              </button>
              <button
                class="btn btn-sm"
                title="マップを縮小"
                onClick={() => {
                  rendererRef.current?.zoomAt(
                    window.innerWidth / 2,
                    window.innerHeight / 2,
                    1 / 1.5
                  );
                  refreshHoverFromLastMouse();
                }}
              >
                －
              </button>
              <button
                class="btn btn-sm"
                title="マップ全体が見える位置へ戻します (F)"
                onClick={() => {
                  rendererRef.current?.fitBoard();
                  refreshHoverFromLastMouse();
                }}
              >
                全体
              </button>
              {user && user.faction_id > 0 && (
                <button
                  class="btn btn-sm"
                  title="自勢力の領土へ移動 (H)"
                  onClick={() => focusFaction(user.faction_id)}
                >
                  自勢力
                </button>
              )}
              <label
                class="confirm-tap-toggle"
                title="ONにするとPCでも1クリック目で選択・2クリック目または実行ボタンで確定になります（誤クリック防止）"
              >
                <input
                  type="checkbox"
                  checked={confirmTapMode}
                  onChange={(e) => {
                    const checked = (e.target as HTMLInputElement).checked;
                    setConfirmTapMode(checked);
                    if (!checked) {
                      setSelectedCell(null);
                      selectedInfoRef.current = null;
                      notifyInspectListeners();
                    }
                  }}
                />
                <span>確認操作</span>
              </label>
            </div>
            <span class="ws-status" title="サーバーとのリアルタイム通信状態">
              <span class={`ws-dot ${wsConnected ? 'online' : 'offline'}`} />
              {wsConnected ? '接続' : '再接続中'}
            </span>
          </div>
        </aside>
        </div>
      )}

      {/* トースト通知（クリック可能な通知ポップアップ） */}
      <div class="toast-stack">
        {toasts.map((t) => {
          const canOpenNotif = Boolean(t.clickable && modal !== 'notifications');
          return (
            <div
              key={t.id}
              class={`toast toast-${t.kind} ${canOpenNotif ? 'toast-clickable' : ''}`}
              onClick={() => {
                if (t.clickable) {
                  dismissToast(t.id);
                  if (modal !== 'notifications') {
                    openNotificationsModal();
                  }
                }
              }}
            >
              <div class="toast-body">
                {t.title && <div class="toast-title">{t.title}</div>}
                <div>{t.text}</div>
                {canOpenNotif && <div class="toast-hint">クリックして通知センターを開く</div>}
              </div>
              <button
                type="button"
                class="toast-close"
                aria-label="閉じる"
                onClick={(e) => {
                  e.stopPropagation();
                  dismissToast(t.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {/* モーダル群 */}
      {modal === 'auth' && modalsMod && (
        <modalsMod.AuthModal
          onClose={() => setModal(null)}
          onAuthSuccess={handleAuthSuccess}
          onToast={addToast}
        />
      )}
      {modal === 'faction' && (
        <LazyFactionModal
          user={user}
          factions={factions}
          phase={season.phase}
          refreshSeq={factionRefreshSeq}
          maxNameLen={season.faction_name_max_len ?? 20}
          initialCoreQuota={season.game_rules?.initial_core_quota ?? 30}
          enclaveBaseMultiplier={season.cost_config?.enclave_base_multiplier ?? 3}
          onClose={() => setModal(null)}
          onRefresh={forceRefreshMetadata}
          onJoinRequestResolved={handleJoinRequestResolved}
          onToast={addToast}
        />
      )}
      {modal === 'diplomacy' && modalsMod && (
        <modalsMod.DiplomacyModal
          user={user}
          factions={factions}
          diplomacy={diplomacy}
          phase={season.phase}
          wsConnected={wsConnected}
          onClose={() => setModal(null)}
          onRefresh={forceRefreshMetadata}
          onCeasefireAcceptStart={beginSelfAcceptCeasefire}
          onCeasefireAcceptCancel={cancelSelfAcceptCeasefire}
          onCeasefireAcceptConfirmed={confirmSelfAcceptCeasefire}
          onCeasefireResponded={handleCeasefireResponded}
          onToast={addToast}
        />
      )}
      {modal === 'ranking' && modalsMod && (
        <modalsMod.RankingModal
          factions={factions}
          phase={season.phase}
          seasonId={season.season_id}
          onHighlightFaction={(fid) => {
            setPinnedFactionId(fid);
            focusFaction(fid);
            const f = factionMap.get(fid);
            if (f) {
              addToast(`「${f.name}」の領土を点滅ハイライトしています`, 'info');
            }
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'logs' && modalsMod && (
        <modalsMod.LogsModal
          factions={factions}
          currentUserId={user?.id}
          currentFactionId={user?.faction_id}
          liveSignal={logsLiveSignal}
          resetSignal={logsResetSignal}
          onJumpToCoord={(x, y) => {
            const sz = buffersRef.current?.boardSize ?? season.board_size;
            if (x < 0 || y < 0 || x >= sz || y >= sz) {
              addToast('盤面範囲外の座標です', 'info');
              return;
            }
            setModal(null);
            if (timelapseModeRef.current) {
              addToast('タイムラプス再生中は座標ジャンプできません', 'info');
              return;
            }
            rendererRef.current?.focusOn(x + 0.5, y + 0.5, 12);
            setSelectedCell({ x, y });
            refreshHoverFromLastMouseRef.current();
          }}
          onFocusFaction={(fid) => {
            setModal(null);
            setPinnedFactionId(fid);
            focusFaction(fid);
            const f = factionMap.get(fid);
            if (f) {
              addToast(`「${f.name}」の領土を点滅ハイライトしています`, 'info');
            }
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'notifications' && modalsMod && (
        <modalsMod.NotificationsModal
          user={user}
          factions={factions}
          diplomacy={diplomacy}
          phase={season.phase}
          wsConnected={wsConnected}
          notifications={notifications}
          browserNotifEnabled={browserNotifEnabled}
          browserNotifUnsupported={browserNotifUnsupported}
          onToggleBrowserNotif={() => void toggleBrowserNotif()}
          onMarkAllRead={markAllNotificationsRead}
          onClearHistory={clearNotifications}
          onCeasefireAcceptStart={beginSelfAcceptCeasefire}
          onCeasefireAcceptCancel={cancelSelfAcceptCeasefire}
          onCeasefireAcceptConfirmed={confirmSelfAcceptCeasefire}
          onCeasefireResponded={handleCeasefireResponded}
          onJoinRequestResolved={handleJoinRequestResolved}
          onClose={() => setModal(null)}
          onRefresh={forceRefreshMetadata}
          onToast={addToast}
        />
      )}
      {modal === 'help' && modalsMod && (
        <modalsMod.HelpModal season={season} onClose={() => setModal(null)} />
      )}
      {pendingJoinFactionId !== null &&
        modalsMod &&
        user &&
        user.faction_id <= 0 &&
        factionMap.has(pendingJoinFactionId) && (
          <modalsMod.JoinFactionConfirmModal
            faction={factionMap.get(pendingJoinFactionId)!}
            user={user}
            onCancel={() => setPendingJoinFactionId(null)}
            onOpenFactionModal={() => {
              setPendingJoinFactionId(null);
              setModal('faction');
            }}
            onRefresh={forceRefreshMetadata}
            onToast={addToast}
          />
        )}
      {pendingWar && modalsMod && (
        <modalsMod.WarConfirmModal
          targetFactionName={
            factionMap.get(pendingWar.targetFactionId)?.name ??
            `勢力 #${pendingWar.targetFactionId}`
          }
          targetColorId={factionMap.get(pendingWar.targetFactionId)?.color_id ?? 0}
          x={pendingWar.x}
          y={pendingWar.y}
          costAp={pendingWar.costAp}
          onCancel={() => setPendingWar(null)}
          onConfirm={() => {
            const actionId = ++nextActionIdRef.current;
            sentActionQueueRef.current.push({
              id: actionId,
              x: pendingWar.x,
              y: pendingWar.y,
              mode: pendingWar.mode,
              colorId: pendingWar.colorId,
              costAp: pendingWar.costAp,
              costKnown: true,
            });
            netWorkerRef.current?.postMessage({
              type: 'sendAction',
              actionId,
              x: pendingWar.x,
              y: pendingWar.y,
              mode: pendingWar.mode,
              colorId: pendingWar.colorId,
              confirmWar: true,
              wsGen: wsGenRef.current,
            });
            setPendingWar(null);
          }}
        />
      )}
      {needModalsModule && !modalsMod && !modalsLoadError && (
        <div
          class="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setModal(null);
              setPendingJoinFactionId(null);
              setPendingWar(null);
            }
          }}
        >
          <div class="modal-card" style={{ textAlign: 'center', padding: '24px' }}>
            <div style={{ marginBottom: '12px' }}>読み込み中...</div>
            <button
              type="button"
              class="btn btn-sm"
              onClick={() => {
                setModal(null);
                setPendingJoinFactionId(null);
                setPendingWar(null);
              }}
            >
              閉じる
            </button>
          </div>
        </div>
      )}
      {needModalsModule && modalsLoadError && (
        <div
          class="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setModal(null);
              setPendingJoinFactionId(null);
              setPendingWar(null);
            }
          }}
        >
          <div class="modal-card" style={{ textAlign: 'center', padding: '24px' }}>
            <p style={{ marginBottom: '14px', color: '#fca5a5' }}>{modalsLoadError}</p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
              <button type="button" class="btn btn-primary" onClick={retryModalsLoad}>
                再試行
              </button>
              <button
                type="button"
                class="btn"
                onClick={() => {
                  setModal(null);
                  setPendingJoinFactionId(null);
                  setPendingWar(null);
                }}
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
