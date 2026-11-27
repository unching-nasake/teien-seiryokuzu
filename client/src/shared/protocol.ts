// デフォルト盤面サイズ (250×250)
export const DEFAULT_BOARD_SIZE = 250;
export const CELL_BYTES = 8;
export const MAX_LAYERS = 10;
/** 非 SAB 差分転送用パッチの 1 セルあたりバイト長 (x:u16 LE, y:u16 LE, raw:8B, tex:4B) */
export const FALLBACK_PATCH_STRIDE = 16;

// WebSocket バイナリオペコード
export const OP_CLIENT_ACTION = 0x01;
export const OP_CLIENT_PING = 0x02;

export const OP_SERVER_CELL_DIFF = 0x81;
export const OP_SERVER_ACTION_RESULT = 0x82;
export const OP_SERVER_TICK_SYNC = 0x83;
export const OP_SERVER_EVENT_JSON = 0x84;
export const OP_SERVER_PONG = 0x85;

/** OP_SERVER_CELL_DIFF ヘッダ長: [op:1B, board_version:u64 LE (8B), count:u32 LE (4B)] */
export const CELL_DIFF_HEADER_BYTES = 13;
/** OP_SERVER_ACTION_RESULT ヘッダ長: [op:1B, status:u8, ap:u16 LE, target_faction:u16 LE, cost_ap:u16 LE, msg_len:u16 LE] */
export const ACTION_RESULT_HEADER_BYTES = 10;

export const STATUS_OK = 0;
export const STATUS_WAR_CONFIRM = 1;
export const STATUS_ERROR = 2;

export const SEA_COLOR_HEX = '#122338';

// サーバー側と完全一致する 64 色固定パレット
export const PALETTE_HEX: readonly string[] = [
  '#E63946', '#B91C1C', '#FF6B6B', '#F97316', '#EA580C', '#FB923C', '#F43F5E', '#EC4899', '#F9A8D4', '#881337',
  '#FACC15', '#EAB308', '#FEF08A', '#D97706', '#92400E', '#78350F', '#B45309', '#D6A87C', '#F5DEB3', '#A16207', '#6D4C41', '#BC8F8F',
  '#22C55E', '#16A34A', '#15803D', '#4ADE80', '#86EFAC', '#84CC16', '#BEF264', '#65A30D', '#4D7C0F', '#3F6212', '#10B981', '#059669', '#14B8A6', '#0D9488',
  '#06B6D4', '#22D3EE', '#67E8F9', '#0EA5E9', '#38BDF8', '#3B82F6', '#2563EB', '#60A5FA', '#93C5FD', '#4F46E5',
  '#6366F1', '#818CF8', '#7C3AED', '#8B5CF6', '#A78BFA', '#A855F7', '#C084FC', '#D946EF', '#C026D3', '#6B21A8',
  '#FFFFFF', '#F1F5F9', '#CBD5E1', '#94A3B8', '#64748B', '#A8A29E', '#57534E', '#09090B',
];

export const PALETTE_RGB_FLOAT: Float32Array = (() => {
  const arr = new Float32Array(64 * 3);
  for (let i = 0; i < 64; i++) {
    const hex = PALETTE_HEX[i];
    arr[i * 3 + 0] = parseInt(hex.slice(1, 3), 16) / 255;
    arr[i * 3 + 1] = parseInt(hex.slice(3, 5), 16) / 255;
    arr[i * 3 + 2] = parseInt(hex.slice(5, 7), 16) / 255;
  }
  return arr;
})();

export type SeasonPhase = 'preparation' | 'active' | 'frozen';
export type ActionMode = 0 | 1; // 0: 塗る/重ね塗り/奪う, 1: マス色変更
export type OverlayMode = 0 | 1 | 2 | 3 | 4; // 0:通常, 1:勢力色, 2:層数, 3:中核/同化, 4:外交

export interface MapGenParams {
  size: number;
  continent_count: number;
  island_count: number;
  land_ratio_pct: number;
  seed: number;
}

export interface MapSizeLimits {
  size: number;
  max_continents: number;
  max_islands: number;
  min_land_ratio_pct: number;
  max_land_ratio_pct: number;
}

export interface MemberPermissions {
  is_leader: boolean;
  is_vice_leader: boolean;
  can_declare_war: boolean;
  can_ceasefire: boolean;
  can_manage_members: boolean;
}

export interface JoinRequestInfo {
  id: number;
  faction_id: number;
  user_id: number;
  username: string;
  created_at: string;
}

export interface NotificationItem {
  id: string;
  kind: 'war' | 'ceasefire' | 'join_request' | 'faction' | 'info';
  title: string;
  message: string;
  createdAt: string;
  read: boolean;
  actionKind?: 'join_request' | 'ceasefire_offer';
  /** join_request は申請者 user_id、ceasefire_offer は提案元 faction_id */
  actionTargetId?: number;
}

export interface UserProfile {
  id: number;
  username: string;
  ap: number;
  max_ap: number;
  faction_id: number;
  /** 所属勢力の自動塗り許可設定（未所属時は false 相当） */
  faction_allow_auto_paint?: boolean;
  auto_paint_enabled: boolean;
  auto_paint_pct: number;
  permissions: MemberPermissions;
  incoming_join_requests: JoinRequestInfo[];
  outgoing_join_request_faction_ids: number[];
}

export interface ApConfig {
  initial_ap_min: number;
  initial_ap_max: number;
  max_ap: number;
  refill_interval_minutes: number;
  refill_offset_minute: number;
  refill_min: number;
  refill_max: number;
  endgame_threshold_pct: number;
  endgame_ap_multiplier: number;
}

export interface CostConfig {
  claim_cost: number;
  reinforce_cost: number;
  enemy_normal_multiplier: number;
  enemy_core_multiplier: number;
  enclave_base_multiplier: number;
  enclave_distance_step: number;
  enclave_distance_rate: number;
}

export interface GameRulesConfig {
  max_layers: number;
  initial_core_quota: number;
  assimilation_required_ticks: number;
  old_core_ttl_ticks: number;
  tick_interval_minutes: number;
  max_ticks: number;
  season_start_weekday: number;
  season_start_hour: number;
  season_start_minute: number;
}

export type PlayerLogCategory = 'all' | 'territory' | 'diplomacy' | 'faction' | 'ap' | 'system';
export type PlayerLogScope = 'all' | 'mine' | 'faction';
export type AdminLogVisibility = 'all' | 'public' | 'faction';

export interface PlayerLogEntry {
  id: number;
  user_id: number;
  username: string;
  faction_id: number;
  target_faction_id?: number;
  category: Exclude<PlayerLogCategory, 'all'>;
  summary: string;
  faction_only?: boolean;
  created_at: string;
}

export interface AdminLogEntry extends PlayerLogEntry {
  season_id: number;
}

export interface TimelapseFrameMeta {
  id: number;
  tick_number: number;
  board_size: number;
  created_at: string;
}

export interface SeasonStatus {
  season_id: number;
  phase: SeasonPhase;
  tick_number: number;
  max_ticks: number;
  next_tick_unix: number;
  online_count: number;
  dev_mode: boolean;
  board_size: number;
  map_params: MapGenParams;
  size_limits: MapSizeLimits[];
  ap_config?: ApConfig;
  effective_max_ap?: number;
  endgame_boost_active?: boolean;
  cost_config?: CostConfig;
  game_rules?: GameRulesConfig;
  faction_name_max_len?: number;
}

export interface AdminStatus {
  authenticated: boolean;
  admin_id: string;
  season_id: number;
  phase: SeasonPhase;
  tick_number: number;
  online_count: number;
  dev_mode?: boolean;
  board_size: number;
  map_params: MapGenParams;
  size_limits: MapSizeLimits[];
  ap_config?: ApConfig;
  effective_max_ap?: number;
  endgame_boost_active?: boolean;
  cost_config?: CostConfig;
  game_rules?: GameRulesConfig;
  faction_name_max_len?: number;
}

export interface FactionClusterAnchor {
  factionId: number;
  centerX: number;
  centerY: number;
  cellCount: number;
  spanW: number;
  spanH: number;
}

export interface AdminDebugAccount {
  id: number;
  username: string;
  ap: number;
  max_ap: number;
  faction_id: number;
  faction_name: string;
  faction_color_id: number;
  is_leader: boolean;
  is_vice_leader: boolean;
}

export interface AdminSeedFactionsResult {
  ok: boolean;
  created_count: number;
  placed_cores: number;
  generated_password?: string;
  factions: Array<{
    id: number;
    name: string;
    color_id: number;
    members: string[];
  }>;
}

export interface FactionSummary {
  id: number;
  name: string;
  color_id: number;
  leader_user_id: number;
  leader_name: string;
  initial_core_used: number;
  territory_count: number;
  core_count: number;
  is_extinct: boolean;
  member_count: number;
  join_policy?: number;
}

export interface FactionMemberInfo {
  user_id: number;
  username: string;
  is_leader: boolean;
  is_vice_leader: boolean;
  can_declare_war: boolean;
  can_ceasefire: boolean;
  can_manage_members: boolean;
}

export interface FactionDetail {
  id: number;
  name: string;
  color_id: number;
  leader_user_id: number;
  initial_core_used: number;
  territory_count: number;
  core_count: number;
  is_extinct: boolean;
  allow_auto_paint: boolean;
  join_policy?: number;
  members: FactionMemberInfo[];
}

export interface WarEntry {
  faction_a: number;
  faction_b: number;
  started_at: string;
}

export interface CeasefireProposal {
  id: number;
  from_faction_id: number;
  to_faction_id: number;
  created_at: string;
}

export interface DiplomacyState {
  wars: WarEntry[];
  ceasefire_proposals: CeasefireProposal[];
}

export interface HoverInfo {
  x: number;
  y: number;
  terrain: number;
  colorId: number;
  layers: number;
  isCore: boolean;
  assimilationTicks: number;
  oldCoreFaction: number;
  oldCoreTtl: number;
  factionId: number;
  isSurrounded: boolean;
  isEnclave: boolean;
  enclaveDistance: number;
  canExecute: boolean;
  actionLabel: string;
  costAp: number;
  needsWarConfirm: boolean;
  blockedReason: string;
}

/**
 * サーバー 8B Cell データを WebGL2 RGBA8UI テクスチャの 4B テクセルへパッキングする
 */
export function packCellToRgba8ui(
  rawBytes: Uint8Array,
  cellIdx: number,
  gpuTex: Uint8Array
): void {
  const rOff = cellIdx * 8;
  const terrain = rawBytes[rOff] & 1;
  const colorId = rawBytes[rOff + 1] & 0x3f;
  const layers = rawBytes[rOff + 2] & 0x0f;
  const flags = rawBytes[rOff + 3];
  const isCore = flags & 1;
  const assimilationRaw = ((flags >> 1) & 0x07) | (((rawBytes[rOff] >> 1) & 0x01) << 3);
  const assimilation = Math.min(7, assimilationRaw);
  const oldCoreTtl = (flags >> 4) & 0x0f;
  const facLo = rawBytes[rOff + 4];
  const facHi = rawBytes[rOff + 5];

  const tOff = cellIdx * 4;
  gpuTex[tOff] = colorId | (terrain << 6) | (isCore << 7);
  gpuTex[tOff + 1] = layers | ((oldCoreTtl > 0 ? 1 : 0) << 4) | (assimilation << 5);
  gpuTex[tOff + 2] = facLo;
  gpuTex[tOff + 3] = facHi;
}

/** 指定サイズの盤面全セルを一括パッキング */
export function packAllCellsToRgba8ui(
  rawBytes: Uint8Array,
  gpuTex: Uint8Array,
  boardSize: number
): void {
  const total = boardSize * boardSize;
  for (let i = 0; i < total; i++) {
    packCellToRgba8ui(rawBytes, i, gpuTex);
  }
}

/** 8バイトのクライアント操作メッセージを生成 */
export function encodeClientAction(
  x: number,
  y: number,
  mode: ActionMode,
  colorId: number,
  confirmWar: boolean
): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint8(0, OP_CLIENT_ACTION);
  view.setUint16(1, x, true);
  view.setUint16(3, y, true);
  view.setUint8(5, mode);
  view.setUint8(6, colorId & 0x3f);
  view.setUint8(7, confirmWar ? 1 : 0);
  return buf;
}

export function phaseFromCode(code: number): SeasonPhase {
  if (code === 0) return 'preparation';
  if (code === 1) return 'active';
  return 'frozen';
}
