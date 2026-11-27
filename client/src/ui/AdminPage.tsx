import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  api,
  ApiError,
  getAdminDebugMode,
  setAdminDebugMode,
} from '../shared/api';
import {
  AdminDebugAccount,
  AdminLogEntry,
  AdminLogVisibility,
  AdminStatus,
  ApConfig,
  CELL_BYTES,
  CostConfig,
  FactionSummary,
  GameRulesConfig,
  MapSizeLimits,
  PALETTE_HEX,
  PlayerLogCategory,
} from '../shared/protocol';
import {
  copyTextToClipboard,
  downloadTextFile,
  formatLogsAsCsv,
  formatLogsAsText,
} from '../shared/logExport';
import { MAX_BOARD_SIZE } from '../shared/sab';

interface AdminPageProps {
  onBackToMap: () => void;
}

const FALLBACK_LIMITS: MapSizeLimits[] = [
  { size: 100, max_continents: 2, max_islands: 8, min_land_ratio_pct: 15, max_land_ratio_pct: 65 },
  { size: 250, max_continents: 4, max_islands: 20, min_land_ratio_pct: 15, max_land_ratio_pct: 70 },
  { size: 500, max_continents: 8, max_islands: 45, min_land_ratio_pct: 15, max_land_ratio_pct: 70 },
  { size: 750, max_continents: 12, max_islands: 70, min_land_ratio_pct: 15, max_land_ratio_pct: 70 },
  { size: 1000, max_continents: 16, max_islands: 100, min_land_ratio_pct: 15, max_land_ratio_pct: 70 },
];

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

const PALETTE_RGB: Array<[number, number, number]> = PALETTE_HEX.map(hexToRgb);

/** 空文字入力中は NaN を保持して 2 桁以上の打ち直しを妨げない */
const parseNumInput = (raw: string): number => (raw.trim() === '' ? Number.NaN : Number(raw));
const numVal = (v: number): string | number => (Number.isFinite(v) ? v : '');
const fallbackNum = (v: number, def: number): number => (Number.isFinite(v) ? v : def);

type AdminTab = 'map' | 'rules' | 'factions' | 'players' | 'logs' | 'debug';

const ADMIN_LOG_TABS: Array<{ key: PlayerLogCategory; label: string }> = [
  { key: 'all', label: 'すべて' },
  { key: 'territory', label: '領土' },
  { key: 'diplomacy', label: '外交' },
  { key: 'faction', label: '勢力' },
  { key: 'ap', label: 'AP' },
  { key: 'system', label: 'システム' },
];

const ADMIN_LOG_CATEGORY_LABELS: Record<Exclude<PlayerLogCategory, 'all'>, string> = {
  territory: '領土',
  diplomacy: '外交',
  faction: '勢力',
  ap: 'AP',
  system: 'システム',
};

const ADMIN_LOG_BADGE_CLASS: Record<Exclude<PlayerLogCategory, 'all'>, string> = {
  territory: 'badge-log-territory',
  diplomacy: 'badge-log-diplomacy',
  faction: 'badge-log-faction',
  ap: 'badge-log-ap',
  system: 'badge-log-system',
};

function formatAdminLogDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}:${ss}`;
}

const DEFAULT_AP_CONFIG: ApConfig = {
  initial_ap_min: 30,
  initial_ap_max: 30,
  max_ap: 100,
  refill_interval_minutes: 60,
  refill_offset_minute: 0,
  refill_min: 6,
  refill_max: 12,
  endgame_threshold_pct: 20,
  endgame_ap_multiplier: 2.0,
};

const DEFAULT_COST_CONFIG: CostConfig = {
  claim_cost: 1,
  reinforce_cost: 1,
  enemy_normal_multiplier: 1.0,
  enemy_core_multiplier: 2.0,
  enclave_base_multiplier: 3.0,
  enclave_distance_step: 10,
  enclave_distance_rate: 0.5,
};

const DEFAULT_GAME_RULES: GameRulesConfig = {
  max_layers: 10,
  initial_core_quota: 30,
  assimilation_required_ticks: 10,
  old_core_ttl_ticks: 10,
  tick_interval_minutes: 30,
  max_ticks: 100,
  season_start_weekday: 5,
  season_start_hour: 0,
  season_start_minute: 0,
};

const WEEKDAY_LABELS = ['月曜', '火曜', '水曜', '木曜', '金曜', '土曜', '日曜'] as const;

function formatWeekMinuteJst(totalMinutes: number): string {
  const norm = ((totalMinutes % 10080) + 10080) % 10080;
  const wd = Math.floor(norm / 1440);
  const rem = norm % 1440;
  const hh = String(Math.floor(rem / 60)).padStart(2, '0');
  const mm = String(rem % 60).padStart(2, '0');
  return `${WEEKDAY_LABELS[wd] ?? '土曜'} ${hh}:${mm}`;
}

function validateApConfig(ap: ApConfig): string | null {
  if (!Number.isInteger(ap.max_ap) || ap.max_ap < 1 || ap.max_ap > 1000) {
    return 'AP上限は 1〜1000 の整数で指定してください';
  }
  if (
    !Number.isInteger(ap.initial_ap_min) ||
    !Number.isInteger(ap.initial_ap_max) ||
    ap.initial_ap_min < 0 ||
    ap.initial_ap_max > ap.max_ap ||
    ap.initial_ap_min > ap.initial_ap_max
  ) {
    return `初期APランダム範囲は 0 <= 最小 <= 最大 <= ${ap.max_ap}（AP上限）の整数で指定してください`;
  }
  if (
    !Number.isInteger(ap.refill_interval_minutes) ||
    ap.refill_interval_minutes < 1 ||
    ap.refill_interval_minutes > 1440
  ) {
    return 'AP補充頻度は 1〜1440 分の整数で指定してください';
  }
  if (
    !Number.isInteger(ap.refill_offset_minute) ||
    ap.refill_offset_minute < 0 ||
    ap.refill_offset_minute >= 60
  ) {
    return 'AP補充基準分は 0〜59 分の整数で指定してください';
  }
  if (
    !Number.isInteger(ap.refill_min) ||
    !Number.isInteger(ap.refill_max) ||
    ap.refill_min < 0 ||
    ap.refill_max > ap.max_ap ||
    ap.refill_min > ap.refill_max
  ) {
    return 'AP補充ランダム範囲は 0 <= 最小 <= 最大 <= AP上限 の整数で指定してください';
  }
  if (
    !Number.isInteger(ap.endgame_threshold_pct) ||
    ap.endgame_threshold_pct < 0 ||
    ap.endgame_threshold_pct > 100
  ) {
    return '終盤APブースト発動ライン（残り%）は 0〜100 の整数で指定してください';
  }
  if (
    !Number.isFinite(ap.endgame_ap_multiplier) ||
    ap.endgame_ap_multiplier < 1.0 ||
    ap.endgame_ap_multiplier > 10.0
  ) {
    return '終盤APブースト倍率は 1.0〜10.0 の数値で指定してください';
  }
  return null;
}

function validateCostConfig(cost: CostConfig): string | null {
  if (!Number.isInteger(cost.claim_cost) || cost.claim_cost < 1 || cost.claim_cost > 50) {
    return '塗り基本コストは 1〜50 AP の整数で指定してください';
  }
  if (!Number.isInteger(cost.reinforce_cost) || cost.reinforce_cost < 1 || cost.reinforce_cost > 50) {
    return '重ね塗り基本コストは 1〜50 AP の整数で指定してください';
  }
  if (
    !Number.isFinite(cost.enemy_normal_multiplier) ||
    cost.enemy_normal_multiplier < 0.1 ||
    cost.enemy_normal_multiplier > 50.0
  ) {
    return '敵地塗りコスト倍率は 0.1〜50.0 で指定してください';
  }
  if (
    !Number.isFinite(cost.enemy_core_multiplier) ||
    cost.enemy_core_multiplier < 0.1 ||
    cost.enemy_core_multiplier > 50.0
  ) {
    return '敵地中核塗りコスト倍率は 0.1〜50.0 で指定してください';
  }
  if (
    !Number.isFinite(cost.enclave_base_multiplier) ||
    cost.enclave_base_multiplier < 1.0 ||
    cost.enclave_base_multiplier > 20.0
  ) {
    return '飛び地基本倍率は 1.0〜20.0 で指定してください';
  }
  if (
    !Number.isInteger(cost.enclave_distance_step) ||
    cost.enclave_distance_step < 1 ||
    cost.enclave_distance_step > 500
  ) {
    return '飛び地距離ステップは 1〜500 マスの整数で指定してください';
  }
  if (
    !Number.isFinite(cost.enclave_distance_rate) ||
    cost.enclave_distance_rate < 0.0 ||
    cost.enclave_distance_rate > 10.0
  ) {
    return '飛び地距離増加率は 0.0〜10.0 で指定してください';
  }
  // サーバー側 CostConfig::validate と同様に 15層・最大距離1997マス飛び地が u16 上限内に収まるか検証
  const maxEnemyMult = Math.max(cost.enemy_normal_multiplier, cost.enemy_core_multiplier);
  const maxBaseRaw = 15.0 * cost.claim_cost * maxEnemyMult;
  const maxBaseCost = Math.max(1.0, Math.ceil(maxBaseRaw - 1e-9));
  const maxEnclaveMult =
    cost.enclave_base_multiplier + (1997.0 / cost.enclave_distance_step) * cost.enclave_distance_rate;
  const maxTotalCost = Math.round(maxBaseCost * maxEnclaveMult);
  if (!Number.isFinite(maxTotalCost) || maxTotalCost > 65535) {
    return '最大想定コスト（15層・最大距離飛び地）が上限 65,535 AP を超えるため設定値を見直してください';
  }
  return null;
}

function validateGameRulesConfig(rules: GameRulesConfig): string | null {
  if (!Number.isInteger(rules.max_layers) || rules.max_layers < 1 || rules.max_layers > 15) {
    return '重ね塗り最大層数は 1〜15 の整数で指定してください';
  }
  if (
    !Number.isInteger(rules.initial_core_quota) ||
    rules.initial_core_quota < 0 ||
    rules.initial_core_quota > 500
  ) {
    return '初期中核付与枠は 0〜500 の整数で指定してください';
  }
  if (
    !Number.isInteger(rules.assimilation_required_ticks) ||
    rules.assimilation_required_ticks < 1 ||
    rules.assimilation_required_ticks > 15
  ) {
    return '自然中核化までの時間は 1〜15 Tick の整数で指定してください';
  }
  if (
    !Number.isInteger(rules.old_core_ttl_ticks) ||
    rules.old_core_ttl_ticks < 0 ||
    rules.old_core_ttl_ticks > 15
  ) {
    return '旧中核履歴の保持時間は 0〜15 Tick の整数で指定してください';
  }
  if (
    !Number.isInteger(rules.tick_interval_minutes) ||
    rules.tick_interval_minutes < 1 ||
    rules.tick_interval_minutes > 1440
  ) {
    return 'Tick間隔は 1〜1440 分の整数で指定してください';
  }
  if (!Number.isInteger(rules.max_ticks) || rules.max_ticks < 1 || rules.max_ticks > 1000) {
    return 'ゲーム終了Tick数は 1〜1000 の整数で指定してください';
  }
  if (
    !Number.isInteger(rules.season_start_weekday) ||
    rules.season_start_weekday < 0 ||
    rules.season_start_weekday > 6
  ) {
    return '開幕曜日は 0（月）〜6（日）の整数で指定してください';
  }
  if (
    !Number.isInteger(rules.season_start_hour) ||
    rules.season_start_hour < 0 ||
    rules.season_start_hour > 23
  ) {
    return '開幕時（JST）は 0〜23 の整数で指定してください';
  }
  if (
    !Number.isInteger(rules.season_start_minute) ||
    rules.season_start_minute < 0 ||
    rules.season_start_minute > 59
  ) {
    return '開幕分（JST）は 0〜59 の整数で指定してください';
  }
  return null;
}

export function AdminPage({ onBackToMap }: AdminPageProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>('map');
  const [apGrantAmount, setApGrantAmount] = useState<number>(30);
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [checking, setChecking] = useState(true);

  // ログインフォーム
  const [loginId, setLoginId] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginErr, setLoginErr] = useState('');

  // マップ生成フォーム
  const [size, setSize] = useState<number>(250);
  const [continentCount, setContinentCount] = useState<number>(1);
  const [islandCount, setIslandCount] = useState<number>(6);
  const [landRatioPct, setLandRatioPct] = useState<number>(40);
  const [seedInput, setSeedInput] = useState<string>('');

  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  // デバッグ勢力生成時の一時パスワード表示用（汎用通知バナーとは分離してログアウト時に確実に消去）
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(null);
  const [actualLandPct, setActualLandPct] = useState<string>('--');

  // デバッグ用 複数勢力生成 & パネルモード
  const [debugMode, setDebugMode] = useState<boolean>(getAdminDebugMode);
  const [seedFactionCount, setSeedFactionCount] = useState<number>(4);
  const [seedMembersPerFaction, setSeedMembersPerFaction] = useState<number>(1);

  // 監査ログタブ用ステート
  const [auditLogs, setAuditLogs] = useState<AdminLogEntry[]>([]);
  const [auditCategory, setAuditCategory] = useState<PlayerLogCategory>('all');
  const [auditVisibility, setAuditVisibility] = useState<AdminLogVisibility>('all');
  const [auditFactionId, setAuditFactionId] = useState<number>(0);
  const [auditSeasonId, setAuditSeasonId] = useState<number | null>(null);
  const [auditAvailableSeasons, setAuditAvailableSeasons] = useState<number[]>([]);
  const [auditSearchInput, setAuditSearchInput] = useState('');
  const [auditSearchQuery, setAuditSearchQuery] = useState('');
  const [auditHasMore, setAuditHasMore] = useState(false);
  const [auditNextBeforeId, setAuditNextBeforeId] = useState<number | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditCopied, setAuditCopied] = useState(false);
  const auditGenRef = useRef(0);
  const auditFilterRef = useRef({
    auditCategory,
    auditVisibility,
    auditFactionId,
    auditSeasonId,
    auditSearchQuery,
  });
  auditFilterRef.current = {
    auditCategory,
    auditVisibility,
    auditFactionId,
    auditSeasonId,
    auditSearchQuery,
  };

  useEffect(() => {
    const t = window.setTimeout(() => {
      setAuditSearchQuery(auditSearchInput.trim());
    }, 250);
    return () => window.clearTimeout(t);
  }, [auditSearchInput]);

  const fetchAuditLogs = useCallback(async (beforeId: number | null = null) => {
    const gen = beforeId === null ? ++auditGenRef.current : auditGenRef.current;
    const f = auditFilterRef.current;
    if (beforeId === null) {
      setAuditLoading(true);
      setAuditLoadingMore(false);
      setAuditError(null);
    } else {
      setAuditLoadingMore(true);
    }
    try {
      const res = await api.adminGetLogs(f.auditCategory, 100, {
        before_id: beforeId,
        faction_id: f.auditFactionId > 0 ? f.auditFactionId : null,
        visibility: f.auditVisibility,
        season_id: f.auditSeasonId,
        q: f.auditSearchQuery || undefined,
      });
      if (gen !== auditGenRef.current) return;
      if (beforeId === null) {
        setAuditLogs(res.logs);
      } else {
        setAuditLogs((prev) => {
          const seen = new Set(prev.map((item) => item.id));
          return [...prev, ...res.logs.filter((item) => !seen.has(item.id))];
        });
      }
      setAuditHasMore(Boolean(res.has_more));
      setAuditNextBeforeId(res.next_before_id ?? null);
      setAuditAvailableSeasons(res.available_seasons ?? []);
    } catch (err) {
      if (gen !== auditGenRef.current) return;
      const msg = err instanceof Error ? err.message : '監査ログの取得に失敗しました';
      if (beforeId === null) {
        setAuditLogs([]);
        setAuditHasMore(false);
        setAuditNextBeforeId(null);
      }
      setAuditError(msg);
    } finally {
      if (gen === auditGenRef.current) {
        if (beforeId === null) {
          setAuditLoading(false);
        } else {
          setAuditLoadingMore(false);
        }
      }
    }
  }, []);

  useEffect(() => {
    if (status?.authenticated && activeTab === 'logs') {
      void fetchAuditLogs(null);
    }
  }, [
    status?.authenticated,
    activeTab,
    auditCategory,
    auditVisibility,
    auditFactionId,
    auditSeasonId,
    auditSearchQuery,
    fetchAuditLogs,
  ]);
  const [seedInitialAp, setSeedInitialAp] = useState<number>(100);
  const [seedPlaceCore, setSeedPlaceCore] = useState<boolean>(true);
  const [debugAccounts, setDebugAccounts] = useState<AdminDebugAccount[]>([]);

  // AP・補充スケジュール設定
  const [apConfig, setApConfig] = useState<ApConfig>(DEFAULT_AP_CONFIG);
  const [costConfig, setCostConfig] = useState<CostConfig>(DEFAULT_COST_CONFIG);
  const [gameRules, setGameRules] = useState<GameRulesConfig>(DEFAULT_GAME_RULES);
  const [factions, setFactions] = useState<FactionSummary[]>([]);
  const [renameInputs, setRenameInputs] = useState<Record<number, string>>({});
  const [warFactionA, setWarFactionA] = useState<number>(0);
  const [warFactionB, setWarFactionB] = useState<number>(0);
  const warFactionARef = useRef<number>(0);
  const warFactionBRef = useRef<number>(0);
  warFactionARef.current = warFactionA;
  warFactionBRef.current = warFactionB;

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewGenRef = useRef(0);
  const mountedRef = useRef(true);
  const accountsSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const beginBusy = useCallback((): boolean => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    return true;
  }, []);

  const endBusy = useCallback(() => {
    busyRef.current = false;
    setBusy(false);
  }, []);

  const sizeLimits = status?.size_limits?.length ? status.size_limits : FALLBACK_LIMITS;
  const activeLimit =
    sizeLimits.find((l) => l.size === size) ?? sizeLimits[1] ?? FALLBACK_LIMITS[1];

  const drawPreview = useCallback(async () => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    // 進行中のプレビュー取得をキャンセルし、世代を進めて古い応答による上書きを防止する
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    const gen = ++previewGenRef.current;

    try {
      const res = await fetch('/api/board/snapshot', {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok) return;
      const buf = await res.arrayBuffer();
      if (controller.signal.aborted || gen !== previewGenRef.current) return;

      const bytes = new Uint8Array(buf);
      const headerSize = Number(res.headers.get('x-board-size') || '0');
      const boardSize =
        headerSize > 0 ? headerSize : Math.round(Math.sqrt(bytes.byteLength / CELL_BYTES));
      if (
        boardSize <= 0 ||
        boardSize > MAX_BOARD_SIZE ||
        boardSize * boardSize * CELL_BYTES !== bytes.byteLength
      ) {
        return;
      }

      const currentCanvas = previewCanvasRef.current;
      if (!currentCanvas || !currentCanvas.isConnected) return;

      currentCanvas.width = boardSize;
      currentCanvas.height = boardSize;
      const ctx = currentCanvas.getContext('2d');
      if (!ctx) return;

      const img = ctx.createImageData(boardSize, boardSize);
      const data = img.data;
      const total = boardSize * boardSize;
      let landCells = 0;

      for (let i = 0; i < total; i++) {
        const rOff = i * 8;
        const pOff = i * 4;
        const terrain = bytes[rOff];
        if (terrain === 0) {
          // 海色 #122338
          data[pOff] = 0x12;
          data[pOff + 1] = 0x23;
          data[pOff + 2] = 0x38;
          data[pOff + 3] = 255;
        } else {
          landCells++;
          const fid = bytes[rOff + 4] | (bytes[rOff + 5] << 8);
          if (fid > 0) {
            const [r, g, b] = PALETTE_RGB[bytes[rOff + 1] & 0x3f];
            data[pOff] = r;
            data[pOff + 1] = g;
            data[pOff + 2] = b;
            data[pOff + 3] = 255;
          } else {
            // 中立陸地
            data[pOff] = 0xd1;
            data[pOff + 1] = 0xcb;
            data[pOff + 2] = 0xbb;
            data[pOff + 3] = 255;
          }
        }
      }
      if (controller.signal.aborted || gen !== previewGenRef.current) return;
      ctx.putImageData(img, 0, 0);
      setActualLandPct(((landCells / total) * 100).toFixed(1));
    } catch {
      // 中断およびプレビュー読込エラーは無視
    } finally {
      if (previewAbortRef.current === controller) {
        previewAbortRef.current = null;
      }
    }
  }, []);

  const loadDebugAccounts = useCallback(async () => {
    const seq = ++accountsSeqRef.current;
    try {
      const [accRes, facRes] = await Promise.all([
        api.adminDebugListAccounts(),
        api.listFactions(),
      ]);
      if (!mountedRef.current || seq !== accountsSeqRef.current) return;
      setDebugAccounts(accRes.accounts);
      setFactions(facRes);
      const curA = warFactionARef.current;
      const curB = warFactionBRef.current;
      const nextA = facRes.some((f) => f.id === curA) ? curA : (facRes[0]?.id ?? 0);
      const nextB =
        curB !== nextA && facRes.some((f) => f.id === curB)
          ? curB
          : (facRes.find((f) => f.id !== nextA)?.id ?? 0);
      setWarFactionA(nextA);
      setWarFactionB(nextB);
    } catch {
      // 一覧取得失敗時は無視
    }
  }, []);

  const loadAdminStatus = useCallback(async () => {
    try {
      const me = await api.adminMe();
      setStatus(me);
      setNotice(null);
      setSize(me.map_params.size);
      setContinentCount(me.map_params.continent_count);
      setIslandCount(me.map_params.island_count);
      setLandRatioPct(me.map_params.land_ratio_pct);
      if (me.ap_config) {
        setApConfig(me.ap_config);
        setSeedInitialAp((prev) => Math.min(prev, me.ap_config!.max_ap));
      }
      if (me.cost_config) {
        setCostConfig(me.cost_config);
      }
      if (me.game_rules) {
        setGameRules(me.game_rules);
      }
      setChecking(false);
      void loadDebugAccounts();
    } catch (err) {
      // 401 認証エラーのみ未ログイン状態として扱い、429 等の一時エラーではエラー表示に留める
      if (err instanceof ApiError && err.status === 401) {
        setStatus(null);
        setGeneratedPassword(null);
      } else {
        setNotice({
          text: err instanceof Error ? err.message : '管理者情報の取得に失敗しました',
          kind: 'err',
        });
      }
      setChecking(false);
    }
  }, [loadDebugAccounts]);

  useEffect(() => {
    void loadAdminStatus();
  }, [loadAdminStatus]);

  const isAuthed = Boolean(status);

  // 管理者コンソールがマウントされた後、またはマップタブへ戻った際にプレビューを描画し、離脱時に中断する
  useEffect(() => {
    if (isAuthed && activeTab === 'map') {
      void drawPreview();
    }
    return () => {
      previewAbortRef.current?.abort();
      previewAbortRef.current = null;
      previewGenRef.current += 1;
    };
  }, [isAuthed, activeTab, drawPreview]);

  // マップサイズ変更時に破綻しない上限値へ自動クランプ
  const handleSelectSize = (nextSize: number) => {
    setSize(nextSize);
    const lim = sizeLimits.find((l) => l.size === nextSize);
    if (!lim) return;
    setContinentCount((prev) => Math.min(prev, lim.max_continents));
    setIslandCount((prev) => Math.min(prev, lim.max_islands));
    setLandRatioPct((prev) =>
      Math.max(lim.min_land_ratio_pct, Math.min(prev, lim.max_land_ratio_pct))
    );
  };

  const applyDefaults = () => {
    setSize(250);
    setContinentCount(1);
    setIslandCount(6);
    setLandRatioPct(40);
    setSeedInput('');
  };

  const handleLogin = async (e: Event) => {
    e.preventDefault();
    if (!beginBusy()) return;
    setLoginErr('');
    try {
      await api.adminLogin(loginId, loginPass);
      setLoginPass('');
      await loadAdminStatus();
    } catch (err) {
      setLoginErr((err as Error).message);
    } finally {
      endBusy();
    }
  };

  const handleLogout = async () => {
    if (!beginBusy()) return;
    try {
      await api.adminLogout();
      accountsSeqRef.current += 1;
      previewAbortRef.current?.abort();
      previewAbortRef.current = null;
      previewGenRef.current += 1;
      setAdminDebugMode(false);
      setDebugMode(false);
      setStatus(null);
      setNotice(null);
      setGeneratedPassword(null);
      setLoginErr('');
      setLoginId('');
      setLoginPass('');
      setDebugAccounts([]);
      setFactions([]);
      setRenameInputs({});
      setWarFactionA(0);
      setWarFactionB(0);
      setActualLandPct('--');
    } catch (err) {
      setNotice({
        text: `ログアウトに失敗しました（セッションが残留している可能性があります）: ${err instanceof Error ? err.message : String(err)}`,
        kind: 'err',
      });
    } finally {
      endBusy();
    }
  };

  const handleRegenerate = async (e: Event) => {
    e.preventDefault();
    if (busyRef.current) return;
    if (continentCount === 0 && islandCount === 0) {
      setNotice({ text: '大陸または島を少なくとも1つ以上設定してください', kind: 'err' });
      return;
    }
    if (
      !window.confirm(
        'マップを再生成すると現在の領土・戦争状態・タイムラプスがリセットされます。よろしいですか？'
      )
    ) {
      return;
    }
    if (!beginBusy()) return;
    setNotice(null);
    try {
      const trimmedSeed = seedInput.trim();
      const parsedSeed = trimmedSeed !== '' ? Number(trimmedSeed) : null;
      if (parsedSeed !== null && (!Number.isSafeInteger(parsedSeed) || parsedSeed < 0)) {
        throw new Error('シード値は0以上の安全な整数、または空欄（ランダム）にしてください');
      }

      const res = await api.adminRegenerateMap({
        size,
        continent_count: continentCount,
        island_count: islandCount,
        land_ratio_pct: landRatioPct,
        seed: parsedSeed,
      });
      setNotice({
        text: `マップを再生成しました（${res.board_size}×${res.board_size} / 大陸 ${res.map_params.continent_count} / 島 ${res.map_params.island_count} / 陸地 ${res.map_params.land_ratio_pct}% / Seed ${res.map_params.seed}）`,
        kind: 'ok',
      });
      const me = await api.adminMe();
      setStatus(me);
      await drawPreview();
      await loadDebugAccounts();
    } catch (err) {
      setNotice({ text: (err as Error).message, kind: 'err' });
    } finally {
      endBusy();
    }
  };

  const handlePhase = async (phase: 'preparation' | 'active' | 'frozen' | 'auto') => {
    if (!beginBusy()) return;
    setNotice(null);
    try {
      const res = await api.adminSetPhase(phase);
      setNotice({ text: `シーズンフェーズを「${res.phase}」へ変更しました`, kind: 'ok' });
      const me = await api.adminMe();
      setStatus(me);
    } catch (err) {
      setNotice({ text: (err as Error).message, kind: 'err' });
    } finally {
      endBusy();
    }
  };

  const handleTick = async () => {
    if (!beginBusy()) return;
    setNotice(null);
    try {
      const res = await api.adminTriggerTick();
      setNotice({
        text: `ターンティックを実行しました（Tick #${res.tick_number} / 中核昇格 ${res.promoted_cores}）`,
        kind: 'ok',
      });
      const me = await api.adminMe();
      setStatus(me);
      await loadDebugAccounts();
    } catch (err) {
      setNotice({ text: (err as Error).message, kind: 'err' });
    } finally {
      endBusy();
    }
  };

  const handleCaptureTimelapse = async () => {
    if (!beginBusy()) return;
    setNotice(null);
    try {
      const res = await api.adminCaptureTimelapse();
      setNotice({
        text: `タイムラプスフレームを記録しました (Tick #${res.tick_number})`,
        kind: 'ok',
      });
    } catch (err) {
      setNotice({ text: (err as Error).message, kind: 'err' });
    } finally {
      endBusy();
    }
  };

  const handleToggleDebugMode = (next: boolean) => {
    setAdminDebugMode(next);
    setDebugMode(next);
    setNotice({
      text: next
        ? 'ゲーム画面デバッグパネルモードを ON にしました（マップへ戻ると左上に表示されます）'
        : 'ゲーム画面デバッグパネルモードを OFF にしました',
      kind: 'ok',
    });
  };

  const handleSeedFactions = async (e: Event) => {
    e.preventDefault();
    if (status?.dev_mode === false) return;
    if (!beginBusy()) return;
    setNotice(null);
    try {
      const res = await api.adminDebugSeedFactions({
        faction_count: seedFactionCount,
        members_per_faction: seedMembersPerFaction,
        initial_ap: seedInitialAp,
        place_initial_core: seedPlaceCore,
      });
      // 生成パスワードは汎用通知バナーではなく、明示的に閉じられる専用一時表示へ格納する
      setGeneratedPassword(res.generated_password ?? null);
      setNotice({
        text: `デバッグ用勢力を ${res.created_count} 勢力誕生させました（初期中核配置: ${res.placed_cores}）`,
        kind: 'ok',
      });
      await loadDebugAccounts();
      await drawPreview();
    } catch (err) {
      setNotice({ text: (err as Error).message, kind: 'err' });
    } finally {
      endBusy();
    }
  };

  const savedMaxAp = status?.ap_config?.max_ap ?? 100;

  const handleGrantAp = async (
    userId: number | null,
    amount: number,
    mode: 'set' | 'add'
  ) => {
    if (!beginBusy()) return;
    const safeAmount = Math.max(0, Math.min(savedMaxAp, Math.round(fallbackNum(amount, 0))));
    setNotice(null);
    try {
      const res = await api.adminDebugGrantAp({ user_id: userId, amount: safeAmount, mode });
      if (userId === null) {
        setNotice({
          text: `全プレイヤー（${res.updated_count}人）のAPを${mode === 'add' ? ` +${res.delta ?? safeAmount} 加算` : ` ${res.ap ?? safeAmount} に設定`}しました`,
          kind: 'ok',
        });
      } else {
        setNotice({
          text: `プレイヤーのAPを ${res.ap ?? safeAmount} に更新しました`,
          kind: 'ok',
        });
      }
      await loadDebugAccounts();
    } catch (err) {
      setNotice({ text: (err as Error).message, kind: 'err' });
    } finally {
      endBusy();
    }
  };

  const handleGrantAllAp = () => handleGrantAp(null, savedMaxAp, 'set');

  // 設定保存の部分失敗時にサーバー側の最新設定へ再同期する
  const syncRulesFromAdminMe = async () => {
    try {
      const me = await api.adminMe();
      setStatus(me);
      if (me.ap_config) {
        setApConfig(me.ap_config);
        setSeedInitialAp((prev) => Math.min(prev, me.ap_config!.max_ap));
      }
      if (me.cost_config) {
        setCostConfig(me.cost_config);
      }
      if (me.game_rules) {
        setGameRules(me.game_rules);
      }
    } catch {
      // 再同期失敗時は既存の通知のみ維持
    }
  };

  const handleSaveApConfig = async (e: Event) => {
    e.preventDefault();
    if (busyRef.current) return;
    const validationErr = validateApConfig(apConfig);
    if (validationErr) {
      setNotice({ text: validationErr, kind: 'err' });
      return;
    }
    if (!beginBusy()) return;
    const safeAp: ApConfig = {
      ...apConfig,
    };
    setNotice(null);
    try {
      const res = await api.adminUpdateApConfig(safeAp);
      setApConfig(res.ap_config);
      setStatus((prev) => (prev ? { ...prev, ap_config: res.ap_config } : prev));
      setSeedInitialAp((prev) => Math.min(prev, res.ap_config.max_ap));
      setNotice({
        text: `AP設定を保存しました（初期 ${res.ap_config.initial_ap_min}〜${res.ap_config.initial_ap_max} / 上限 ${res.ap_config.max_ap} / 補充 ${res.ap_config.refill_min}〜${res.ap_config.refill_max}）`,
        kind: 'ok',
      });
      await loadDebugAccounts();
    } catch (err) {
      await syncRulesFromAdminMe();
      setNotice({ text: err instanceof Error ? err.message : String(err), kind: 'err' });
    } finally {
      endBusy();
    }
  };

  const handleSaveCostConfig = async (e: Event) => {
    e.preventDefault();
    if (busyRef.current) return;
    const validationErr = validateCostConfig(costConfig);
    if (validationErr) {
      setNotice({ text: validationErr, kind: 'err' });
      return;
    }
    if (!beginBusy()) return;
    setNotice(null);
    try {
      const res = await api.adminUpdateCostConfig(costConfig);
      setCostConfig(res.cost_config);
      setStatus((prev) => (prev ? { ...prev, cost_config: res.cost_config } : prev));
      setNotice({
        text: `コスト設定を保存しました（塗り基本 ${res.cost_config.claim_cost} / 重ね塗り ${res.cost_config.reinforce_cost} / 敵地倍率 ${res.cost_config.enemy_normal_multiplier}倍 / 敵地中核倍率 ${res.cost_config.enemy_core_multiplier}倍 / 飛び地基本 ${res.cost_config.enclave_base_multiplier}倍 + ${res.cost_config.enclave_distance_step}マスごと +${res.cost_config.enclave_distance_rate}倍）`,
        kind: 'ok',
      });
    } catch (err) {
      setNotice({ text: (err as Error).message, kind: 'err' });
    } finally {
      endBusy();
    }
  };

  const handleSaveRulesConfig = async (
    e: Event,
    section: 'schedule' | 'territory' | 'tick'
  ) => {
    e.preventDefault();
    if (busyRef.current) return;
    // 他タブ・他セクションの未保存編集を巻き込まないよう保存済み設定をベースに対象セクションのみ上書きする
    const base = status?.game_rules ?? DEFAULT_GAME_RULES;
    const payload: GameRulesConfig =
      section === 'schedule'
        ? {
            ...base,
            season_start_weekday: gameRules.season_start_weekday,
            season_start_hour: gameRules.season_start_hour,
            season_start_minute: gameRules.season_start_minute,
          }
        : section === 'territory'
          ? {
              ...base,
              max_layers: gameRules.max_layers,
              initial_core_quota: gameRules.initial_core_quota,
              assimilation_required_ticks: gameRules.assimilation_required_ticks,
              old_core_ttl_ticks: gameRules.old_core_ttl_ticks,
            }
          : {
              ...base,
              tick_interval_minutes: gameRules.tick_interval_minutes,
              max_ticks: gameRules.max_ticks,
            };

    const validationErr = validateGameRulesConfig(payload);
    if (validationErr) {
      setNotice({ text: validationErr, kind: 'err' });
      return;
    }
    if (!beginBusy()) return;
    setNotice(null);
    try {
      const res = await api.adminUpdateRulesConfig(payload);
      // 別セクションの未保存編集を消さないよう該当セクションのフィールドのみ同期する
      setGameRules((prev) =>
        section === 'schedule'
          ? {
              ...prev,
              season_start_weekday: res.game_rules.season_start_weekday,
              season_start_hour: res.game_rules.season_start_hour,
              season_start_minute: res.game_rules.season_start_minute,
            }
          : section === 'territory'
            ? {
                ...prev,
                max_layers: res.game_rules.max_layers,
                initial_core_quota: res.game_rules.initial_core_quota,
                assimilation_required_ticks: res.game_rules.assimilation_required_ticks,
                old_core_ttl_ticks: res.game_rules.old_core_ttl_ticks,
              }
            : {
                ...prev,
                tick_interval_minutes: res.game_rules.tick_interval_minutes,
                max_ticks: res.game_rules.max_ticks,
              }
      );
      // max_ticks 変更に伴う自動凍結の発動・解除（phase 変更）を含めて status を最新化する
      try {
        const me = await api.adminMe();
        setStatus(me);
      } catch {
        setStatus((prev) => (prev ? { ...prev, game_rules: res.game_rules } : prev));
      }
      const savedText =
        section === 'schedule'
          ? `開幕スケジュールを保存しました（${WEEKDAY_LABELS[res.game_rules.season_start_weekday] ?? '土曜'} ${String(res.game_rules.season_start_hour).padStart(2, '0')}:${String(res.game_rules.season_start_minute).padStart(2, '0')} JST）`
          : section === 'territory'
            ? `領土設定を保存しました（最大層数 ${res.game_rules.max_layers} / 初期中核枠 ${res.game_rules.initial_core_quota} / 同化 ${res.game_rules.assimilation_required_ticks}Tick / 旧中核保持 ${res.game_rules.old_core_ttl_ticks}Tick）`
            : `Tick設定を保存しました（間隔 ${res.game_rules.tick_interval_minutes}分 / 終了 ${res.game_rules.max_ticks}Tick）`;
      setNotice({ text: savedText, kind: 'ok' });
    } catch (err) {
      setNotice({ text: (err as Error).message, kind: 'err' });
    } finally {
      endBusy();
    }
  };

  const handleRenameFaction = async (fid: number) => {
    const nextName = (renameInputs[fid] ?? '').trim();
    if (!nextName) return;
    if (!beginBusy()) return;
    setNotice(null);
    try {
      await api.adminRenameFaction(fid, nextName);
      setNotice({ text: `勢力 #${fid} の名称を「${nextName}」に変更しました`, kind: 'ok' });
      setRenameInputs((prev) => ({ ...prev, [fid]: '' }));
      await loadDebugAccounts();
    } catch (err) {
      setNotice({ text: (err as Error).message, kind: 'err' });
    } finally {
      endBusy();
    }
  };

  const handleDeleteFaction = async (fid: number, name: string) => {
    if (busyRef.current) return;
    if (!window.confirm(`勢力「${name}」を解散し、領土をすべて無所属に戻しますか？`)) {
      return;
    }
    if (!beginBusy()) return;
    setNotice(null);
    try {
      const res = await api.adminDeleteFaction(fid);
      setNotice({
        text: `勢力「${name}」を解散しました（返還マス: ${res.cleared_cells}）`,
        kind: 'ok',
      });
      await loadDebugAccounts();
      await drawPreview();
    } catch (err) {
      setNotice({ text: (err as Error).message, kind: 'err' });
    } finally {
      endBusy();
    }
  };

  const handleDeleteUser = async (uid: number, username: string) => {
    if (busyRef.current) return;
    if (!window.confirm(`プレイヤー「${username}」を削除しますか？`)) {
      return;
    }
    if (!beginBusy()) return;
    setNotice(null);
    try {
      await api.adminDeleteUser(uid);
      setNotice({ text: `プレイヤー「${username}」を削除しました`, kind: 'ok' });
      await loadDebugAccounts();
    } catch (err) {
      setNotice({ text: (err as Error).message, kind: 'err' });
    } finally {
      endBusy();
    }
  };

  const handleForceDiplomacy = async (kind: 'war' | 'ceasefire') => {
    if (busyRef.current) return;
    if (warFactionA <= 0 || warFactionB <= 0 || warFactionA === warFactionB) {
      setNotice({ text: '異なる2つの勢力を選択してください', kind: 'err' });
      return;
    }
    if (!beginBusy()) return;
    setNotice(null);
    try {
      if (kind === 'war') {
        await api.adminForceWar(warFactionA, warFactionB);
        setNotice({ text: `勢力 #${warFactionA} と 勢力 #${warFactionB} を強制開戦させました`, kind: 'ok' });
      } else {
        await api.adminForceCeasefire(warFactionA, warFactionB);
        setNotice({ text: `勢力 #${warFactionA} と 勢力 #${warFactionB} を強制停戦させました`, kind: 'ok' });
      }
    } catch (err) {
      setNotice({ text: (err as Error).message, kind: 'err' });
    } finally {
      endBusy();
    }
  };

  const handleSaveAllRules = async () => {
    if (busyRef.current) return;
    // 送信前にすべての設定を検証し、1つでも不正があれば部分適用を防ぐため一切送信しない
    const apErr = validateApConfig(apConfig);
    if (apErr) {
      setNotice({ text: apErr, kind: 'err' });
      return;
    }
    const costErr = validateCostConfig(costConfig);
    if (costErr) {
      setNotice({ text: costErr, kind: 'err' });
      return;
    }
    const baseRules = status?.game_rules ?? DEFAULT_GAME_RULES;
    const rulesPayload: GameRulesConfig = {
      ...baseRules,
      max_layers: gameRules.max_layers,
      initial_core_quota: gameRules.initial_core_quota,
      assimilation_required_ticks: gameRules.assimilation_required_ticks,
      old_core_ttl_ticks: gameRules.old_core_ttl_ticks,
      tick_interval_minutes: gameRules.tick_interval_minutes,
      max_ticks: gameRules.max_ticks,
    };
    const rulesErr = validateGameRulesConfig(rulesPayload);
    if (rulesErr) {
      setNotice({ text: rulesErr, kind: 'err' });
      return;
    }
    if (!beginBusy()) return;
    const safeAp: ApConfig = {
      ...apConfig,
    };
    setNotice(null);
    const applied: string[] = [];
    try {
      const apRes = await api.adminUpdateApConfig(safeAp);
      applied.push('AP設定');
      const costRes = await api.adminUpdateCostConfig(costConfig);
      applied.push('コスト設定');
      const rulesRes = await api.adminUpdateRulesConfig(rulesPayload);
      applied.push('ルール設定');

      setApConfig(apRes.ap_config);
      setCostConfig(costRes.cost_config);
      // マップタブの未保存開幕スケジュールを消さないようルールタブの項目のみ同期する
      setGameRules((prev) => ({
        ...prev,
        max_layers: rulesRes.game_rules.max_layers,
        initial_core_quota: rulesRes.game_rules.initial_core_quota,
        assimilation_required_ticks: rulesRes.game_rules.assimilation_required_ticks,
        old_core_ttl_ticks: rulesRes.game_rules.old_core_ttl_ticks,
        tick_interval_minutes: rulesRes.game_rules.tick_interval_minutes,
        max_ticks: rulesRes.game_rules.max_ticks,
      }));
      try {
        const me = await api.adminMe();
        setStatus(me);
      } catch {
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                ap_config: apRes.ap_config,
                cost_config: costRes.cost_config,
                game_rules: rulesRes.game_rules,
              }
            : prev
        );
      }
      setSeedInitialAp((prev) => Math.min(prev, apRes.ap_config.max_ap));
      setNotice({
        text: 'AP・コスト・ルールのすべての設定を一括保存しました',
        kind: 'ok',
      });
      await loadDebugAccounts();
    } catch (err) {
      await syncRulesFromAdminMe();
      const msg = err instanceof Error ? err.message : String(err);
      const prefix =
        applied.length > 0 ? `※ ${applied.join('・')} は適用済みですが、後続の保存に失敗しました: ` : '';
      setNotice({ text: `${prefix}${msg}`, kind: 'err' });
    } finally {
      endBusy();
    }
  };

  if (checking) {
    return (
      <div class="admin-shell">
        <div class="admin-login-card">認証状態を確認中...</div>
      </div>
    );
  }

  if (!status) {
    return (
      <div class="admin-shell">
        <div class="admin-login-card">
          <div class="modal-header">
            <h2>庭園勢力図 — 管理者ログイン</h2>
            <button class="btn btn-sm" onClick={onBackToMap}>
              マップへ戻る
            </button>
          </div>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
            管理者アカウントの ID とパスワードを入力してログインしてください。
          </p>
          <form onSubmit={handleLogin}>
            <div class="form-field">
              <label>管理者 ID</label>
              <input
                class="input"
                required
                autoFocus
                autoComplete="username"
                placeholder="管理者 ID を入力"
                value={loginId}
                onInput={(e) => setLoginId((e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="form-field">
              <label>パスワード</label>
              <input
                class="input"
                type="password"
                required
                autoComplete="current-password"
                placeholder="パスワードを入力"
                value={loginPass}
                onInput={(e) => setLoginPass((e.target as HTMLInputElement).value)}
              />
            </div>
            {notice && (
              <div
                class={`admin-alert ${notice.kind === 'ok' ? 'admin-alert-ok' : 'admin-alert-err'}`}
                style={{ marginBottom: '12px' }}
              >
                {notice.text}
              </div>
            )}
            {loginErr && (
              <div class="admin-alert admin-alert-err" style={{ marginBottom: '12px' }}>
                {loginErr}
              </div>
            )}
            <button class="btn btn-primary" style={{ width: '100%' }} type="submit" disabled={busy}>
              ログイン
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div class="admin-shell">
      <div class="admin-container">
        <header class="admin-header">
          <div>
            <h1>庭園勢力図 — 管理者コンソール</h1>
            <div class="admin-sub">
              ログイン中: <strong>{status.admin_id}</strong> / シーズン #{status.season_id} /
              フェーズ: <strong>{status.phase}</strong> / Tick {status.tick_number}/
              {status.game_rules?.max_ticks ?? fallbackNum(gameRules.max_ticks, 100)} / 接続中{' '}
              {status.online_count} 人
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button class="btn btn-primary" onClick={onBackToMap}>
              ゲームマップへ戻る
            </button>
            <button class="btn" disabled={busy} onClick={() => void handleLogout()}>
              ログアウト
            </button>
          </div>
        </header>

        {notice && (
          <div class={`admin-alert ${notice.kind === 'ok' ? 'admin-alert-ok' : 'admin-alert-err'}`}>
            {notice.text}
          </div>
        )}

        {generatedPassword && (
          <div
            class="admin-alert admin-alert-ok"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            <span>
              デバッグ用アカウントの一時生成パスワード: <code>{generatedPassword}</code>
              （確認後、このバナーを閉じてください）
            </span>
            <button
              type="button"
              class="btn btn-sm"
              onClick={() => setGeneratedPassword(null)}
            >
              閉じる
            </button>
          </div>
        )}

        <nav class="admin-tabs">
          <button
            type="button"
            class={`admin-tab ${activeTab === 'map' ? 'active' : ''}`}
            onClick={() => setActiveTab('map')}
          >
            マップ・進行
          </button>
          <button
            type="button"
            class={`admin-tab ${activeTab === 'rules' ? 'active' : ''}`}
            onClick={() => setActiveTab('rules')}
          >
            ルール・バランス
          </button>
          <button
            type="button"
            class={`admin-tab ${activeTab === 'factions' ? 'active' : ''}`}
            onClick={() => setActiveTab('factions')}
          >
            勢力・外交 ({factions.length})
          </button>
          <button
            type="button"
            class={`admin-tab ${activeTab === 'players' ? 'active' : ''}`}
            onClick={() => setActiveTab('players')}
          >
            プレイヤー ({debugAccounts.length})
          </button>
          <button
            type="button"
            class={`admin-tab ${activeTab === 'logs' ? 'active' : ''}`}
            onClick={() => setActiveTab('logs')}
          >
            行動ログ（監査）
          </button>
          <button
            type="button"
            class={`admin-tab ${activeTab === 'debug' ? 'active' : ''}`}
            onClick={() => setActiveTab('debug')}
          >
            デバッグ
          </button>
        </nav>

        {activeTab === 'map' && (
          <div class="admin-grid">
          {/* 左: マップ再生成設定 */}
          <section class="admin-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h2>マップ再生成設定</h2>
              <button type="button" class="btn btn-sm" onClick={applyDefaults}>
                標準設定に戻す
              </button>
            </div>

            <form onSubmit={handleRegenerate}>
              <div class="form-field">
                <label>マップサイズ（正方形 / デフォルト: 250×250）</label>
                <div class="size-selector">
                  {sizeLimits.map((lim) => (
                    <button
                      key={lim.size}
                      type="button"
                      class={`size-pill ${size === lim.size ? 'active' : ''}`}
                      onClick={() => handleSelectSize(lim.size)}
                    >
                      {lim.size}×{lim.size}
                      {lim.size === 250 ? ' (標準)' : ''}
                    </button>
                  ))}
                </div>
                <div class="field-hint">
                  このサイズの上限: 大陸最大 {activeLimit.max_continents} / 島最大{' '}
                  {activeLimit.max_islands} / 陸地 {activeLimit.min_land_ratio_pct}%〜
                  {activeLimit.max_land_ratio_pct}%
                </div>
              </div>

              <div class="form-field">
                <label>
                  大陸の数: <strong>{continentCount}</strong>（上限: {activeLimit.max_continents}）
                </label>
                <input
                  type="range"
                  class="slider"
                  min={0}
                  max={activeLimit.max_continents}
                  value={continentCount}
                  onInput={(e) => setContinentCount(Number((e.target as HTMLInputElement).value))}
                />
              </div>

              <div class="form-field">
                <label>
                  島の数: <strong>{islandCount}</strong>（上限: {activeLimit.max_islands}）
                </label>
                <input
                  type="range"
                  class="slider"
                  min={0}
                  max={activeLimit.max_islands}
                  value={islandCount}
                  onInput={(e) => setIslandCount(Number((e.target as HTMLInputElement).value))}
                />
              </div>

              <div class="form-field">
                <label>
                  陸地の割合: <strong>{landRatioPct}%</strong>（範囲:{' '}
                  {activeLimit.min_land_ratio_pct}%〜{activeLimit.max_land_ratio_pct}%）
                </label>
                <input
                  type="range"
                  class="slider"
                  min={activeLimit.min_land_ratio_pct}
                  max={activeLimit.max_land_ratio_pct}
                  value={landRatioPct}
                  onInput={(e) => setLandRatioPct(Number((e.target as HTMLInputElement).value))}
                />
              </div>

              <div class="form-field">
                <label>シード値（空欄にすると毎回ランダムな配置・形状で生成）</label>
                <input
                  class="input"
                  placeholder="空欄 = ランダム生成"
                  value={seedInput}
                  onInput={(e) => setSeedInput((e.target as HTMLInputElement).value)}
                />
              </div>

              <p class="field-hint" style={{ marginBottom: '12px', color: '#fcd34d' }}>
                ※ マップを再生成すると現在の盤面領土・戦争状態はリセットされ、全クライアントへ即時反映されます。
              </p>

              <button
                type="submit"
                class="btn btn-primary"
                style={{ width: '100%', padding: '10px' }}
                disabled={busy || (continentCount === 0 && islandCount === 0)}
              >
                {busy ? '生成中...' : 'マップを再生成する'}
              </button>
            </form>
          </section>

          {/* 右: 現在のマッププレビュー & シーズン制御 */}
          <section class="admin-card">
            <h2 style={{ marginBottom: '10px' }}>現在のマッププレビュー</h2>
            <div class="preview-wrap">
              <canvas ref={previewCanvasRef} class="preview-canvas" />
            </div>
            <div class="preview-meta">
              <div>
                サイズ: <strong>{status.map_params.size}×{status.map_params.size}</strong>
              </div>
              <div>
                設定: 大陸 <strong>{status.map_params.continent_count}</strong> / 島{' '}
                <strong>{status.map_params.island_count}</strong>
              </div>
              <div>
                陸地割合: 目標 <strong>{status.map_params.land_ratio_pct}%</strong>（実測{' '}
                <strong>{actualLandPct}%</strong>）
              </div>
              <div>
                シード: <code>{status.map_params.seed}</code>
              </div>
            </div>

            <div class="section-title" style={{ marginTop: '18px' }}>
              シーズンフェーズ・ティック操作
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
              <button class="btn btn-sm" disabled={busy} onClick={() => handlePhase('preparation')}>
                準備フェーズ
              </button>
              <button class="btn btn-primary btn-sm" disabled={busy} onClick={() => handlePhase('active')}>
                開催フェーズ
              </button>
              <button class="btn btn-gold btn-sm" disabled={busy} onClick={() => handlePhase('frozen')}>
                凍結・結果発表
              </button>
              <button class="btn btn-sm" disabled={busy} onClick={() => handlePhase('auto')}>
                JST 自動判定
              </button>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                class="btn"
                disabled={busy || status.phase !== 'active'}
                title={status.phase !== 'active' ? '開催フェーズ中のみ実行できます' : undefined}
                onClick={handleTick}
              >
                ターンティックを即時実行
              </button>
              <button
                class="btn btn-sm"
                disabled={busy}
                onClick={() => void handleCaptureTimelapse()}
              >
                タイムラプスを今すぐ記録
              </button>
            </div>
          </section>

          {/* 開幕スケジュール設定 */}
          <section class="admin-card">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '10px',
                marginBottom: '12px',
              }}
            >
              <div>
                <h2>開幕スケジュール設定</h2>
              </div>
              <button
                type="button"
                class="btn btn-sm"
                onClick={() =>
                  setGameRules((prev) => ({
                    ...prev,
                    season_start_weekday: 5,
                    season_start_hour: 0,
                    season_start_minute: 0,
                  }))
                }
              >
                標準設定に戻す
              </button>
            </div>

            <form onSubmit={(e) => void handleSaveRulesConfig(e, 'schedule')}>
              <div class="form-field">
                <label>開幕日時（JST / 準備は12時間前から開始）</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <select
                    class="input"
                    style={{ width: 'auto', minWidth: '100px' }}
                    value={fallbackNum(gameRules.season_start_weekday, 5)}
                    onChange={(e) =>
                      setGameRules((prev) => ({
                        ...prev,
                        season_start_weekday: Number((e.target as HTMLSelectElement).value),
                      }))
                    }
                  >
                    {WEEKDAY_LABELS.map((label, idx) => (
                      <option key={idx} value={idx}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    class="input"
                    style={{ width: '72px' }}
                    min={0}
                    max={23}
                    value={numVal(gameRules.season_start_hour)}
                    onInput={(e) =>
                      setGameRules((prev) => ({
                        ...prev,
                        season_start_hour: parseNumInput((e.target as HTMLInputElement).value),
                      }))
                    }
                    onBlur={() =>
                      setGameRules((prev) => ({
                        ...prev,
                        season_start_hour: Math.max(
                          0,
                          Math.min(23, fallbackNum(prev.season_start_hour, 0))
                        ),
                      }))
                    }
                  />
                  <span>時</span>
                  <input
                    type="number"
                    class="input"
                    style={{ width: '72px' }}
                    min={0}
                    max={59}
                    value={numVal(gameRules.season_start_minute)}
                    onInput={(e) =>
                      setGameRules((prev) => ({
                        ...prev,
                        season_start_minute: parseNumInput((e.target as HTMLInputElement).value),
                      }))
                    }
                    onBlur={() =>
                      setGameRules((prev) => ({
                        ...prev,
                        season_start_minute: Math.max(
                          0,
                          Math.min(59, fallbackNum(prev.season_start_minute, 0))
                        ),
                      }))
                    }
                  />
                  <span>分 JST</span>
                </div>
                <div class="field-hint">
                  {(() => {
                    const wd = Math.max(0, Math.min(6, fallbackNum(gameRules.season_start_weekday, 5)));
                    const hh = Math.max(0, Math.min(23, fallbackNum(gameRules.season_start_hour, 0)));
                    const mm = Math.max(0, Math.min(59, fallbackNum(gameRules.season_start_minute, 0)));
                    const startMin = wd * 1440 + hh * 60 + mm;
                    const prepMin = startMin - 720;
                    const durMin = Math.min(
                      2880,
                      Math.max(1, fallbackNum(gameRules.tick_interval_minutes, 30)) *
                        Math.max(1, fallbackNum(gameRules.max_ticks, 100))
                    );
                    const endMin = startMin + durMin;
                    return `準備開始: ${formatWeekMinuteJst(prepMin)} → 開幕: ${formatWeekMinuteJst(startMin)} → 終了: ${formatWeekMinuteJst(endMin)} JST`;
                  })()}
                </div>
              </div>
              <button
                type="submit"
                class="btn btn-primary"
                style={{ marginTop: '8px' }}
                disabled={busy}
              >
                {busy ? '保存中...' : '開幕スケジュールを保存して反映する'}
              </button>
            </form>
          </section>
        </div>
        )}

        {/* デバッグタブ */}
        {activeTab === 'debug' && (
        <section class="admin-card">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '10px',
              marginBottom: '14px',
            }}
          >
            <div>
              <h2>手動デバッグモード（複数勢力誕生 &amp; 画面上アカウント切替パネル）</h2>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                type="button"
                class={`btn ${debugMode ? 'btn-primary' : ''}`}
                onClick={() => handleToggleDebugMode(!debugMode)}
              >
                画面パネルモード: {debugMode ? 'ON' : 'OFF'}
              </button>
              <button
                type="button"
                class="btn btn-gold"
                onClick={() => {
                  setAdminDebugMode(true);
                  setDebugMode(true);
                  onBackToMap();
                }}
              >
                パネルONでマップへ移動
              </button>
            </div>
          </div>

          <div class="admin-grid">
            <form onSubmit={handleSeedFactions}>
              <div class="section-title">複数勢力を一括誕生させる</div>
              {status.dev_mode === false && (
                <div class="admin-alert admin-alert-err" style={{ marginBottom: '10px', fontSize: '12px' }}>
                  本番モード（dev_mode: false）のため、勢力の一括生成および代理ログイン（アカウント切替）は無効化されています。
                </div>
              )}
              <div class="form-field">
                <label>
                  誕生させる勢力数: <strong>{seedFactionCount}</strong> 勢力
                </label>
                <input
                  type="range"
                  class="slider"
                  min={1}
                  max={16}
                  disabled={status.dev_mode === false}
                  value={seedFactionCount}
                  onInput={(e) => setSeedFactionCount(Number((e.target as HTMLInputElement).value))}
                />
              </div>

              <div class="form-field">
                <label>
                  1勢力あたりのプレイヤー数: <strong>{seedMembersPerFaction}</strong> 人
                </label>
                <input
                  type="range"
                  class="slider"
                  min={1}
                  max={5}
                  disabled={status.dev_mode === false}
                  value={seedMembersPerFaction}
                  onInput={(e) =>
                    setSeedMembersPerFaction(Number((e.target as HTMLInputElement).value))
                  }
                />
              </div>

              <div class="form-field">
                <label>
                  初期AP: <strong>{seedInitialAp}</strong> / {savedMaxAp}
                </label>
                <input
                  type="range"
                  class="slider"
                  min={0}
                  max={savedMaxAp}
                  step={5}
                  disabled={status.dev_mode === false}
                  value={Math.min(seedInitialAp, savedMaxAp)}
                  onInput={(e) => setSeedInitialAp(Number((e.target as HTMLInputElement).value))}
                />
              </div>

              <div class="form-field">
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    disabled={status.dev_mode === false}
                    checked={seedPlaceCore}
                    onChange={(e) => setSeedPlaceCore((e.target as HTMLInputElement).checked)}
                  />
                  各勢力の初期中核（拠点1マス）をマップ上の空き陸地に自動配置する
                </label>
              </div>

              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  type="submit"
                  class="btn btn-primary"
                  disabled={busy || status.dev_mode === false}
                >
                  {busy ? '処理中...' : `${seedFactionCount} 勢力を誕生させる`}
                </button>
                <button type="button" class="btn" disabled={busy} onClick={handleGrantAllAp}>
                  全プレイヤーAPを{savedMaxAp}にする
                </button>
              </div>
            </form>
          </div>
        </section>
        )}

        {/* プレイヤータブ */}
        {activeTab === 'players' && (
        <section class="admin-card">
          <h2>プレイヤー管理</h2>
            <div>
              <div class="section-title">
                登録済みプレイヤー一覧 &amp; AP付与（{debugAccounts.length} 人 / ランダム生成PW）
              </div>
              {(() => {
                const isGrantValid = Number.isFinite(apGrantAmount);
                const normalizedGrant = Math.max(
                  0,
                  Math.min(savedMaxAp, Math.round(fallbackNum(apGrantAmount, 0)))
                );
                return (
                  <>
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        gap: '6px',
                        marginBottom: '10px',
                        padding: '8px',
                        borderRadius: '8px',
                        background: 'rgba(15, 23, 42, 0.55)',
                        border: '1px solid rgba(148, 163, 184, 0.2)',
                      }}
                    >
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>付与量:</span>
                      <input
                        type="number"
                        class="input"
                        style={{ width: '74px', padding: '4px 6px', fontSize: '12px' }}
                        min={0}
                        max={savedMaxAp}
                        value={numVal(apGrantAmount)}
                        onInput={(e) =>
                          setApGrantAmount(parseNumInput((e.target as HTMLInputElement).value))
                        }
                        onBlur={() =>
                          setApGrantAmount((v) =>
                            Math.max(0, Math.min(savedMaxAp, Math.round(fallbackNum(v, 0))))
                          )
                        }
                      />
                      <button
                        type="button"
                        class="btn btn-primary btn-sm"
                        disabled={busy || !isGrantValid || debugAccounts.length === 0}
                        onClick={() => void handleGrantAp(null, normalizedGrant, 'add')}
                      >
                        {isGrantValid ? `全員に +${normalizedGrant} AP` : '全員に +AP'}
                      </button>
                      <button
                        type="button"
                        class="btn btn-sm"
                        disabled={busy || !isGrantValid || debugAccounts.length === 0}
                        onClick={() => void handleGrantAp(null, normalizedGrant, 'set')}
                      >
                        {isGrantValid ? `全員を ${normalizedGrant} に設定` : '全員を設定'}
                      </button>
                      <button
                        type="button"
                        class="btn btn-gold btn-sm"
                        disabled={busy || debugAccounts.length === 0}
                        onClick={() => void handleGrantAllAp()}
                      >
                        全員MAX ({savedMaxAp})
                      </button>
                    </div>
                    <div class="admin-account-preview" style={{ maxHeight: '360px' }}>
                      {debugAccounts.length === 0 ? (
                        <div class="field-hint">まだプレイヤーが登録されていません。</div>
                      ) : (
                        debugAccounts.map((acc) => (
                          <div key={acc.id} class="admin-account-row">
                            <span>
                              <span
                                class="color-dot"
                                style={{
                                  background:
                                    acc.faction_id > 0 ? PALETTE_HEX[acc.faction_color_id] : '#64748b',
                                }}
                              />
                              <strong>{acc.username}</strong>
                              {acc.is_leader ? ' [長]' : ''}
                            </span>
                            <span
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px',
                                color: 'var(--text-muted)',
                                fontSize: '11px',
                              }}
                            >
                              <span style={{ marginRight: '4px' }}>
                                {acc.faction_id > 0 ? acc.faction_name : '無所属'} / AP {acc.ap}
                              </span>
                              <button
                                type="button"
                                class="btn btn-sm"
                                disabled={busy || !isGrantValid}
                                onClick={() => void handleGrantAp(acc.id, normalizedGrant, 'add')}
                                title={
                                  isGrantValid
                                    ? `${acc.username} に +${normalizedGrant} AP`
                                    : '付与量を入力してください'
                                }
                              >
                                {isGrantValid ? `+${normalizedGrant}` : '+'}
                              </button>
                              <button
                                type="button"
                                class="btn btn-sm"
                                disabled={busy || !isGrantValid}
                                onClick={() => void handleGrantAp(acc.id, normalizedGrant, 'set')}
                                title={
                                  isGrantValid
                                    ? `${acc.username} の AP を ${normalizedGrant} に設定`
                                    : '付与量を入力してください'
                                }
                              >
                                {isGrantValid ? `=${normalizedGrant}` : '='}
                              </button>
                              <button
                                type="button"
                                class="btn btn-primary btn-sm"
                                disabled={busy}
                                onClick={() => void handleGrantAp(acc.id, savedMaxAp, 'set')}
                              >
                                MAX
                              </button>
                              {!acc.is_leader && (
                                <button
                                  type="button"
                                  class="btn btn-danger btn-sm"
                                  disabled={busy}
                                  onClick={() => void handleDeleteUser(acc.id, acc.username)}
                                >
                                  削除
                                </button>
                              )}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </>
                );
              })()}
            </div>
        </section>
        )}

        {/* ルール・バランスタブ */}
        {activeTab === 'rules' && (
        <>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '8px',
            marginBottom: '12px',
          }}
        >
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            各設定を変更後、個別保存または右の「すべて一括保存」で即時反映できます。
          </span>
          <button
            type="button"
            class="btn btn-gold"
            disabled={busy}
            onClick={() => void handleSaveAllRules()}
          >
            {busy ? '保存中...' : 'すべてのルール設定を一括保存'}
          </button>
        </div>
        <section class="admin-card">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '10px',
              marginBottom: '12px',
            }}
          >
              <div>
                <h2>AP設定</h2>
              </div>
              <button
                type="button"
                class="btn btn-sm"
                onClick={() => {
                  setApConfig((prev) => ({
                    ...prev,
                    initial_ap_min: DEFAULT_AP_CONFIG.initial_ap_min,
                    initial_ap_max: DEFAULT_AP_CONFIG.initial_ap_max,
                    max_ap: DEFAULT_AP_CONFIG.max_ap,
                    refill_min: DEFAULT_AP_CONFIG.refill_min,
                    refill_max: DEFAULT_AP_CONFIG.refill_max,
                  }));
                }}
              >
                標準設定に戻す
              </button>
            </div>

            <form onSubmit={handleSaveApConfig}>
              <div class="admin-grid">
                <div>
                  <div class="form-field">
                    <label>初期APのランダム範囲（最小 〜 最大 / 新規登録・リセット時）</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        type="number"
                        class="input"
                        min={0}
                        max={apConfig.max_ap}
                        value={numVal(apConfig.initial_ap_min)}
                        onInput={(e) =>
                          setApConfig((prev) => ({
                            ...prev,
                            initial_ap_min: parseNumInput((e.target as HTMLInputElement).value),
                          }))
                        }
                        onBlur={() =>
                          setApConfig((prev) => ({
                            ...prev,
                            initial_ap_min: Math.max(0, fallbackNum(prev.initial_ap_min, 0)),
                          }))
                        }
                      />
                      <span>〜</span>
                      <input
                        type="number"
                        class="input"
                        min={0}
                        max={apConfig.max_ap}
                        value={numVal(apConfig.initial_ap_max)}
                        onInput={(e) =>
                          setApConfig((prev) => ({
                            ...prev,
                            initial_ap_max: parseNumInput((e.target as HTMLInputElement).value),
                          }))
                        }
                        onBlur={() =>
                          setApConfig((prev) => ({
                            ...prev,
                            initial_ap_max: Math.max(0, fallbackNum(prev.initial_ap_max, 0)),
                          }))
                        }
                      />
                    </div>
                  </div>
                <div class="form-field">
                  <label>AP上限（1〜1000）</label>
                  <input
                    type="number"
                    class="input"
                    min={1}
                    max={1000}
                    value={numVal(apConfig.max_ap)}
                    onInput={(e) =>
                      setApConfig((prev) => ({
                        ...prev,
                        max_ap: parseNumInput((e.target as HTMLInputElement).value),
                      }))
                    }
                    onBlur={() =>
                      setApConfig((prev) => ({
                        ...prev,
                        max_ap: Math.max(1, fallbackNum(prev.max_ap, 1)),
                      }))
                    }
                  />
                </div>
                <div class="form-field">
                  <label>補充のランダム範囲（最小 〜 最大）</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="number"
                      class="input"
                      min={0}
                      max={apConfig.max_ap}
                      value={numVal(apConfig.refill_min)}
                      onInput={(e) =>
                        setApConfig((prev) => ({
                          ...prev,
                          refill_min: parseNumInput((e.target as HTMLInputElement).value),
                        }))
                      }
                      onBlur={() =>
                        setApConfig((prev) => ({
                          ...prev,
                          refill_min: Math.max(0, fallbackNum(prev.refill_min, 0)),
                        }))
                      }
                    />
                    <span>〜</span>
                    <input
                      type="number"
                      class="input"
                      min={0}
                      max={apConfig.max_ap}
                      value={numVal(apConfig.refill_max)}
                      onInput={(e) =>
                        setApConfig((prev) => ({
                          ...prev,
                          refill_max: parseNumInput((e.target as HTMLInputElement).value),
                        }))
                      }
                      onBlur={() =>
                        setApConfig((prev) => ({
                          ...prev,
                          refill_max: Math.max(0, fallbackNum(prev.refill_max, 0)),
                        }))
                      }
                    />
                  </div>
                </div>
                <div class="form-field">
                  <label>終盤APブースト発動ライン（残り%: 0〜100 / 0で無効 / 標準: 20%）</label>
                  <input
                    type="number"
                    class="input"
                    min={0}
                    max={100}
                    value={numVal(apConfig.endgame_threshold_pct)}
                    onInput={(e) =>
                      setApConfig((prev) => ({
                        ...prev,
                        endgame_threshold_pct: parseNumInput((e.target as HTMLInputElement).value),
                      }))
                    }
                    onBlur={() =>
                      setApConfig((prev) => ({
                        ...prev,
                        endgame_threshold_pct: Math.max(
                          0,
                          Math.min(100, Math.round(fallbackNum(prev.endgame_threshold_pct, 20)))
                        ),
                      }))
                    }
                  />
                </div>
                <div class="form-field">
                  <label>終盤APブースト倍率（補充量・AP上限倍率: 1.0〜10.0倍 / 標準: 2.0倍）</label>
                  <input
                    type="number"
                    class="input"
                    min={1.0}
                    max={10.0}
                    step={0.1}
                    value={numVal(apConfig.endgame_ap_multiplier)}
                    onInput={(e) =>
                      setApConfig((prev) => ({
                        ...prev,
                        endgame_ap_multiplier: parseNumInput((e.target as HTMLInputElement).value),
                      }))
                    }
                    onBlur={() =>
                      setApConfig((prev) => ({
                        ...prev,
                        endgame_ap_multiplier: Math.max(
                          1.0,
                          Math.min(10.0, fallbackNum(prev.endgame_ap_multiplier, 2.0))
                        ),
                      }))
                    }
                  />
                  <div class="field-hint">
                    発動中: 補充{' '}
                    <strong>
                      {Math.round(
                        fallbackNum(apConfig.refill_min, 6) *
                          fallbackNum(apConfig.endgame_ap_multiplier, 2.0)
                      )}
                      〜
                      {Math.round(
                        fallbackNum(apConfig.refill_max, 12) *
                          fallbackNum(apConfig.endgame_ap_multiplier, 2.0)
                      )}
                    </strong>{' '}
                    / 上限{' '}
                    <strong>
                      {Math.round(
                        fallbackNum(apConfig.max_ap, 100) *
                          fallbackNum(apConfig.endgame_ap_multiplier, 2.0)
                      )}
                    </strong>{' '}
                    AP
                  </div>
                </div>
              </div>
            </div>

            <button
              type="submit"
              class="btn btn-primary"
              style={{ marginTop: '8px' }}
              disabled={busy}
            >
              {busy ? '保存中...' : 'AP設定を保存して反映する'}
            </button>
          </form>
        </section>

        {/* アクションコスト・飛び地増加率設定 */}
        <section class="admin-card" style={{ marginTop: '18px' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '10px',
              marginBottom: '12px',
            }}
          >
            <div>
              <h2>コスト設定</h2>
              <div class="field-hint">
                基本消費APと、飛び地（自勢力から離れたマス）への距離に応じた倍率増加を調整できます。
              </div>
            </div>
            <button
              type="button"
              class="btn btn-sm"
              onClick={() =>
                setCostConfig({
                  claim_cost: 1,
                  reinforce_cost: 1,
                  enemy_normal_multiplier: 1.0,
                  enemy_core_multiplier: 2.0,
                  enclave_base_multiplier: 3.0,
                  enclave_distance_step: 10,
                  enclave_distance_rate: 0.5,
                })
              }
            >
              標準設定に戻す
            </button>
          </div>

          <form onSubmit={handleSaveCostConfig}>
            <div class="admin-grid">
              <div>
                <div class="form-field">
                  <label>塗り基本コスト（AP）</label>
                  <input
                    type="number"
                    class="input"
                    min={1}
                    max={50}
                    value={numVal(costConfig.claim_cost)}
                    onInput={(e) =>
                      setCostConfig((prev) => ({
                        ...prev,
                        claim_cost: parseNumInput((e.target as HTMLInputElement).value),
                      }))
                    }
                    onBlur={() =>
                      setCostConfig((prev) => ({
                        ...prev,
                        claim_cost: Math.max(1, fallbackNum(prev.claim_cost, 1)),
                      }))
                    }
                  />
                </div>
                <div class="form-field">
                  <label>重ね塗り基本コスト（AP）</label>
                  <input
                    type="number"
                    class="input"
                    min={1}
                    max={50}
                    value={numVal(costConfig.reinforce_cost)}
                    onInput={(e) =>
                      setCostConfig((prev) => ({
                        ...prev,
                        reinforce_cost: parseNumInput((e.target as HTMLInputElement).value),
                      }))
                    }
                    onBlur={() =>
                      setCostConfig((prev) => ({
                        ...prev,
                        reinforce_cost: Math.max(1, fallbackNum(prev.reinforce_cost, 1)),
                      }))
                    }
                  />
                </div>
                <div class="form-field">
                  <label>敵地塗りコスト倍率（塗り基本コストに対する倍率 / 標準: 1.0倍）</label>
                  <input
                    type="number"
                    class="input"
                    min={0.1}
                    max={50}
                    step={0.1}
                    value={numVal(costConfig.enemy_normal_multiplier)}
                    onInput={(e) =>
                      setCostConfig((prev) => ({
                        ...prev,
                        enemy_normal_multiplier: parseNumInput((e.target as HTMLInputElement).value),
                      }))
                    }
                    onBlur={() =>
                      setCostConfig((prev) => ({
                        ...prev,
                        enemy_normal_multiplier: Math.max(
                          0.1,
                          fallbackNum(prev.enemy_normal_multiplier, 1.0)
                        ),
                      }))
                    }
                  />
                  <div class="field-hint">
                    1層あたり（小数点切り上げ）:{' '}
                    <strong>
                      {Math.max(
                        1,
                        Math.ceil(
                          fallbackNum(costConfig.claim_cost, 1) *
                            fallbackNum(costConfig.enemy_normal_multiplier, 1.0) -
                            1e-9
                        )
                      )}{' '}
                      AP
                    </strong>
                  </div>
                </div>
                <div class="form-field">
                  <label>敵地中核塗りコスト倍率（塗り基本コストに対する倍率 / 標準: 2.0倍）</label>
                  <input
                    type="number"
                    class="input"
                    min={0.1}
                    max={50}
                    step={0.1}
                    value={numVal(costConfig.enemy_core_multiplier)}
                    onInput={(e) =>
                      setCostConfig((prev) => ({
                        ...prev,
                        enemy_core_multiplier: parseNumInput((e.target as HTMLInputElement).value),
                      }))
                    }
                    onBlur={() =>
                      setCostConfig((prev) => ({
                        ...prev,
                        enemy_core_multiplier: Math.max(
                          0.1,
                          fallbackNum(prev.enemy_core_multiplier, 2.0)
                        ),
                      }))
                    }
                  />
                  <div class="field-hint">
                    1層あたり（小数点切り上げ）:{' '}
                    <strong>
                      {Math.max(
                        1,
                        Math.ceil(
                          fallbackNum(costConfig.claim_cost, 1) *
                            fallbackNum(costConfig.enemy_core_multiplier, 2.0) -
                            1e-9
                        )
                      )}{' '}
                      AP
                    </strong>
                  </div>
                </div>
              </div>

              <div>
                <div class="form-field">
                  <label>飛び地 基本倍率（標準: 3.0倍）</label>
                  <input
                    type="number"
                    class="input"
                    min={1}
                    max={20}
                    step={0.1}
                    value={numVal(costConfig.enclave_base_multiplier)}
                    onInput={(e) =>
                      setCostConfig((prev) => ({
                        ...prev,
                        enclave_base_multiplier: parseNumInput((e.target as HTMLInputElement).value),
                      }))
                    }
                    onBlur={() =>
                      setCostConfig((prev) => ({
                        ...prev,
                        enclave_base_multiplier: Math.max(
                          1,
                          fallbackNum(prev.enclave_base_multiplier, 3.0)
                        ),
                      }))
                    }
                  />
                </div>
                <div class="form-field">
                  <label>距離ステップ（何マス離れるごとに倍率増加するか / 標準: 10マス）</label>
                  <input
                    type="number"
                    class="input"
                    min={1}
                    max={500}
                    value={numVal(costConfig.enclave_distance_step)}
                    onInput={(e) =>
                      setCostConfig((prev) => ({
                        ...prev,
                        enclave_distance_step: parseNumInput((e.target as HTMLInputElement).value),
                      }))
                    }
                    onBlur={() =>
                      setCostConfig((prev) => ({
                        ...prev,
                        enclave_distance_step: Math.max(
                          1,
                          fallbackNum(prev.enclave_distance_step, 10)
                        ),
                      }))
                    }
                  />
                </div>
                <div class="form-field">
                  <label>距離増加率（1ステップごとの加算倍率 / 標準: +0.5倍）</label>
                  <input
                    type="number"
                    class="input"
                    min={0}
                    max={10}
                    step={0.1}
                    value={numVal(costConfig.enclave_distance_rate)}
                    onInput={(e) =>
                      setCostConfig((prev) => ({
                        ...prev,
                        enclave_distance_rate: parseNumInput((e.target as HTMLInputElement).value),
                      }))
                    }
                    onBlur={() =>
                      setCostConfig((prev) => ({
                        ...prev,
                        enclave_distance_rate: Math.max(
                          0,
                          fallbackNum(prev.enclave_distance_rate, 0.5)
                        ),
                      }))
                    }
                  />
                  <div class="field-hint">
                    計算式: 基本倍率({fallbackNum(costConfig.enclave_base_multiplier, 3.0)}) + (距離 ÷{' '}
                    {fallbackNum(costConfig.enclave_distance_step, 10)}) ×{' '}
                    {fallbackNum(costConfig.enclave_distance_rate, 0.5)}
                    <br />
                    例: 距離20マス時の空き地コスト ={' '}
                    <strong>
                      {Math.max(
                        1,
                        Math.round(
                          fallbackNum(costConfig.claim_cost, 1) *
                            (fallbackNum(costConfig.enclave_base_multiplier, 3.0) +
                              (20 / Math.max(1, fallbackNum(costConfig.enclave_distance_step, 10))) *
                                fallbackNum(costConfig.enclave_distance_rate, 0.5))
                        )
                      )}{' '}
                      AP
                    </strong>
                  </div>
                </div>
              </div>
            </div>

            <button
              type="submit"
              class="btn btn-primary"
              style={{ marginTop: '8px' }}
              disabled={busy}
            >
              {busy ? '保存中...' : 'コスト・飛び地設定を保存して反映する'}
            </button>
          </form>
        </section>

        {/* 領土設定 */}
        <section class="admin-card" style={{ marginTop: '18px' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '10px',
              marginBottom: '12px',
            }}
          >
            <div>
              <h2>領土設定</h2>
            </div>
            <button
              type="button"
              class="btn btn-sm"
              onClick={() =>
                setGameRules((prev) => ({
                  ...prev,
                  max_layers: 10,
                  initial_core_quota: 30,
                  assimilation_required_ticks: 10,
                  old_core_ttl_ticks: 10,
                }))
              }
            >
              標準設定に戻す
            </button>
          </div>

          <form onSubmit={(e) => void handleSaveRulesConfig(e, 'territory')}>
            <div class="admin-grid">
              <div class="form-field">
                <label>重ね塗り最大層数（1〜15 / 標準: 10層）</label>
                <input
                  type="number"
                  class="input"
                  min={1}
                  max={15}
                  value={numVal(gameRules.max_layers)}
                  onInput={(e) =>
                    setGameRules((prev) => ({
                      ...prev,
                      max_layers: parseNumInput((e.target as HTMLInputElement).value),
                    }))
                  }
                  onBlur={() =>
                    setGameRules((prev) => ({
                      ...prev,
                      max_layers: Math.max(1, fallbackNum(prev.max_layers, 10)),
                    }))
                  }
                />
              </div>
              <div class="form-field">
                <label>初期中核付与枠（0〜500 / 標準: 30ドット）</label>
                <input
                  type="number"
                  class="input"
                  min={0}
                  max={500}
                  value={numVal(gameRules.initial_core_quota)}
                  onInput={(e) =>
                    setGameRules((prev) => ({
                      ...prev,
                      initial_core_quota: parseNumInput((e.target as HTMLInputElement).value),
                    }))
                  }
                  onBlur={() =>
                    setGameRules((prev) => ({
                      ...prev,
                      initial_core_quota: Math.max(0, fallbackNum(prev.initial_core_quota, 30)),
                    }))
                  }
                />
              </div>
              <div class="form-field">
                <label>自然中核化（同化）までの必要 Tick（1〜15 / 標準: 10）</label>
                <input
                  type="number"
                  class="input"
                  min={1}
                  max={15}
                  value={numVal(gameRules.assimilation_required_ticks)}
                  onInput={(e) =>
                    setGameRules((prev) => ({
                      ...prev,
                      assimilation_required_ticks: parseNumInput(
                        (e.target as HTMLInputElement).value
                      ),
                    }))
                  }
                  onBlur={() =>
                    setGameRules((prev) => ({
                      ...prev,
                      assimilation_required_ticks: Math.max(
                        1,
                        fallbackNum(prev.assimilation_required_ticks, 10)
                      ),
                    }))
                  }
                />
              </div>
              <div class="form-field">
                <label>旧中核履歴の保持 Tick（0〜15 / 標準: 10）</label>
                <input
                  type="number"
                  class="input"
                  min={0}
                  max={15}
                  value={numVal(gameRules.old_core_ttl_ticks)}
                  onInput={(e) =>
                    setGameRules((prev) => ({
                      ...prev,
                      old_core_ttl_ticks: parseNumInput((e.target as HTMLInputElement).value),
                    }))
                  }
                  onBlur={() =>
                    setGameRules((prev) => ({
                      ...prev,
                      old_core_ttl_ticks: Math.max(0, fallbackNum(prev.old_core_ttl_ticks, 10)),
                    }))
                  }
                />
              </div>
            </div>
            <button
              type="submit"
              class="btn btn-primary"
              style={{ marginTop: '8px' }}
              disabled={busy}
            >
              {busy ? '保存中...' : '領土設定を保存して反映する'}
            </button>
          </form>
        </section>

        {/* Tick設定 */}
        <section class="admin-card" style={{ marginTop: '18px' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '10px',
              marginBottom: '12px',
            }}
          >
            <div>
              <h2>Tick設定</h2>
            </div>
            <button
              type="button"
              class="btn btn-sm"
              onClick={() =>
                setGameRules((prev) => ({
                  ...prev,
                  tick_interval_minutes: 30,
                  max_ticks: 100,
                }))
              }
            >
              標準設定に戻す
            </button>
          </div>

          <form onSubmit={(e) => void handleSaveRulesConfig(e, 'tick')}>
            <div class="admin-grid">
              <div class="form-field">
                <label>Tick 間隔（分単位: 1〜1440 / 標準: 30分）</label>
                <div class="size-selector" style={{ marginBottom: '6px' }}>
                  {[1, 5, 10, 15, 30, 60].map((mins) => (
                    <button
                      key={mins}
                      type="button"
                      class={`size-pill ${gameRules.tick_interval_minutes === mins ? 'active' : ''}`}
                      onClick={() =>
                        setGameRules((prev) => ({ ...prev, tick_interval_minutes: mins }))
                      }
                    >
                      {mins}分
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  class="input"
                  min={1}
                  max={1440}
                  value={numVal(gameRules.tick_interval_minutes)}
                  onInput={(e) =>
                    setGameRules((prev) => ({
                      ...prev,
                      tick_interval_minutes: parseNumInput((e.target as HTMLInputElement).value),
                    }))
                  }
                  onBlur={() =>
                    setGameRules((prev) => ({
                      ...prev,
                      tick_interval_minutes: Math.max(
                        1,
                        fallbackNum(prev.tick_interval_minutes, 30)
                      ),
                    }))
                  }
                />
              </div>
              <div class="form-field">
                <label>ゲーム終了 Tick 数（1〜1000 / 標準: 100 Tick で自動凍結）</label>
                <input
                  type="number"
                  class="input"
                  min={1}
                  max={1000}
                  value={numVal(gameRules.max_ticks)}
                  onInput={(e) =>
                    setGameRules((prev) => ({
                      ...prev,
                      max_ticks: parseNumInput((e.target as HTMLInputElement).value),
                    }))
                  }
                  onBlur={() =>
                    setGameRules((prev) => ({
                      ...prev,
                      max_ticks: Math.max(1, fallbackNum(prev.max_ticks, 100)),
                    }))
                  }
                />
              </div>
            </div>
            <button
              type="submit"
              class="btn btn-primary"
              style={{ marginTop: '8px' }}
              disabled={busy}
            >
              {busy ? '保存中...' : 'Tick設定を保存して反映する'}
            </button>
          </form>
        </section>
        </>
        )}

        {/* 勢力・外交タブ */}
        {activeTab === 'factions' && (
        <section class="admin-card">
          <h2 style={{ marginBottom: '12px' }}>勢力・外交管理</h2>

          <div class="admin-grid">
            <div>
              <div class="section-title">勢力一覧（名前変更・強制解散）</div>
              <div class="admin-account-preview">
                {factions.length === 0 ? (
                  <div class="field-hint">勢力がありません。</div>
                ) : (
                  factions.map((f) => (
                    <div key={f.id} class="admin-account-row" style={{ gap: '6px' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 }}>
                        <span class="color-dot" style={{ background: PALETTE_HEX[f.color_id] }} />
                        <strong>{f.name}</strong>
                        <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                          ({f.territory_count}マス)
                        </span>
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <input
                          class="input"
                          style={{ width: '110px', padding: '3px 6px', fontSize: '11px' }}
                          maxLength={status.faction_name_max_len ?? 20}
                          placeholder="新しい名前"
                          value={renameInputs[f.id] ?? ''}
                          onInput={(e) =>
                            setRenameInputs((prev) => ({
                              ...prev,
                              [f.id]: (e.target as HTMLInputElement).value,
                            }))
                          }
                        />
                        <button
                          type="button"
                          class="btn btn-sm"
                          disabled={busy}
                          onClick={() => void handleRenameFaction(f.id)}
                        >
                          変更
                        </button>
                        <button
                          type="button"
                          class="btn btn-danger btn-sm"
                          disabled={busy}
                          onClick={() => void handleDeleteFaction(f.id, f.name)}
                        >
                          解散
                        </button>
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div>
              <div class="section-title">強制開戦 / 強制停戦</div>
              <div class="form-field">
                <label>対象勢力 A</label>
                <select
                  class="input"
                  value={warFactionA}
                  onChange={(e) => setWarFactionA(Number((e.target as HTMLSelectElement).value))}
                >
                  <option value={0}>選択してください</option>
                  {factions.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} (#{f.id})
                    </option>
                  ))}
                </select>
              </div>
              <div class="form-field">
                <label>対象勢力 B</label>
                <select
                  class="input"
                  value={warFactionB}
                  onChange={(e) => setWarFactionB(Number((e.target as HTMLSelectElement).value))}
                >
                  <option value={0}>選択してください</option>
                  {factions.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} (#{f.id})
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  class="btn btn-danger"
                  disabled={busy}
                  onClick={() => void handleForceDiplomacy('war')}
                >
                  強制開戦
                </button>
                <button
                  type="button"
                  class="btn btn-primary"
                  disabled={busy}
                  onClick={() => void handleForceDiplomacy('ceasefire')}
                >
                  強制停戦
                </button>
              </div>
            </div>
          </div>
        </section>
        )}

        {activeTab === 'logs' && (() => {
          const adminFactionMap = new Map(factions.map((f) => [f.id, f]));
          return (
            <section class="admin-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
                <h2>行動ログ（管理者監査ビュー）</h2>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    class="btn btn-sm"
                    disabled={auditLogs.length === 0}
                    onClick={async () => {
                      const ok = await copyTextToClipboard(formatLogsAsText(auditLogs, adminFactionMap, true));
                      if (ok) {
                        setAuditCopied(true);
                        window.setTimeout(() => setAuditCopied(false), 1800);
                      }
                    }}
                  >
                    {auditCopied ? 'コピー済み' : 'テキストコピー'}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm"
                    disabled={auditLogs.length === 0}
                    onClick={() => {
                      const csv = formatLogsAsCsv(auditLogs, adminFactionMap, true);
                      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
                      downloadTextFile(`teien-audit-logs-${stamp}.csv`, csv, 'text/csv;charset=utf-8');
                    }}
                  >
                    CSV保存
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-primary"
                    disabled={auditLoading || auditLoadingMore}
                    onClick={() => void fetchAuditLogs(null)}
                  >
                    更新
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                {ADMIN_LOG_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    class={`btn btn-sm ${auditCategory === tab.key ? 'btn-primary' : ''}`}
                    onClick={() => setAuditCategory(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div class="logs-filter-bar">
                <select
                  class="input logs-faction-select"
                  aria-label="公開範囲"
                  value={auditVisibility}
                  onChange={(e) => setAuditVisibility((e.target as HTMLSelectElement).value as AdminLogVisibility)}
                >
                  <option value="all">公開範囲: すべて（勢力限定含む）</option>
                  <option value="public">全体公開のみ</option>
                  <option value="faction">勢力限定のみ</option>
                </select>

                <select
                  class="input logs-faction-select"
                  aria-label="勢力で絞り込み"
                  value={String(auditFactionId)}
                  onChange={(e) => setAuditFactionId(Number((e.target as HTMLSelectElement).value) || 0)}
                >
                  <option value="0">すべての勢力</option>
                  {factions.map((f) => (
                    <option key={f.id} value={String(f.id)}>
                      {f.name}
                    </option>
                  ))}
                </select>

                <select
                  class="input logs-faction-select"
                  aria-label="シーズン選択"
                  value={auditSeasonId === null ? 'current' : String(auditSeasonId)}
                  onChange={(e) => {
                    const v = (e.target as HTMLSelectElement).value;
                    setAuditSeasonId(v === 'current' ? null : Number(v));
                  }}
                >
                  <option value="current">現在シーズン (#{status.season_id})</option>
                  <option value="0">全シーズン</option>
                  {auditAvailableSeasons
                    .filter((s) => s !== status.season_id)
                    .map((s) => (
                      <option key={s} value={String(s)}>
                        シーズン #{s}
                      </option>
                    ))}
                </select>

                <div class="logs-search-wrap">
                  <input
                    type="search"
                    class="input logs-search-input"
                    placeholder="プレイヤー名・内容で検索..."
                    value={auditSearchInput}
                    onInput={(e) => setAuditSearchInput((e.target as HTMLInputElement).value)}
                  />
                  {auditSearchInput && (
                    <button
                      type="button"
                      class="btn btn-sm"
                      onClick={() => {
                        setAuditSearchInput('');
                        setAuditSearchQuery('');
                      }}
                    >
                      クリア
                    </button>
                  )}
                </div>
              </div>

              <div class="logs-status-bar">
                <span>
                  {auditLoading
                    ? '読み込み中...'
                    : `${auditLogs.length}件表示中${auditHasMore ? '（さらに過去のログあり）' : ''}`}
                </span>
              </div>

              {auditError && (
                <div class="logs-load-more-error" style={{ marginBottom: '8px' }}>
                  <span>{auditError}</span>
                  <button type="button" class="btn btn-sm" onClick={() => void fetchAuditLogs(null)}>
                    再試行
                  </button>
                </div>
              )}

              <div class="logs-table-wrap" style={{ maxHeight: '520px' }}>
                {auditLoading ? (
                  <div style={{ padding: '16px', fontSize: '12px', color: 'var(--text-muted)' }}>
                    読み込み中...
                  </div>
                ) : auditLogs.length === 0 ? (
                  <div style={{ padding: '16px', fontSize: '12px', color: 'var(--text-muted)' }}>
                    該当する行動ログはありません。
                  </div>
                ) : (
                  <div class="table-scroll">
                    <table class="list-table">
                      <thead>
                        <tr>
                          <th>S</th>
                          <th>日時</th>
                          <th>種別</th>
                          <th>プレイヤー</th>
                          <th>行動内容</th>
                        </tr>
                      </thead>
                      <tbody>
                        {auditLogs.map((log) => {
                          const fac = log.faction_id > 0 ? adminFactionMap.get(log.faction_id) : undefined;
                          const badgeCls = ADMIN_LOG_BADGE_CLASS[log.category] ?? 'badge-art';
                          return (
                            <tr key={log.id}>
                              <td style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                                #{log.season_id}
                              </td>
                              <td style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                                {formatAdminLogDateTime(log.created_at)}
                              </td>
                              <td style={{ whiteSpace: 'nowrap' }}>
                                <span class={`mini-badge ${badgeCls}`}>
                                  {ADMIN_LOG_CATEGORY_LABELS[log.category] ?? log.category}
                                </span>
                                {log.faction_only && (
                                  <span class="mini-badge badge-log-private">勢力限定</span>
                                )}
                              </td>
                              <td style={{ whiteSpace: 'nowrap' }}>
                                {fac && (
                                  <span
                                    class="color-dot"
                                    style={{ background: PALETTE_HEX[fac.color_id] }}
                                    title={fac.name}
                                  />
                                )}
                                <strong>{log.username}</strong>
                              </td>
                              <td style={{ fontSize: '12px' }}>{log.summary}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {auditHasMore && auditNextBeforeId !== null && (
                      <div class="logs-load-more-row">
                        <button
                          type="button"
                          class="btn btn-sm"
                          disabled={auditLoadingMore}
                          onClick={() => void fetchAuditLogs(auditNextBeforeId)}
                        >
                          {auditLoadingMore ? '読み込み中...' : 'さらに読み込む'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
          );
        })()}
      </div>
    </div>
  );
}
