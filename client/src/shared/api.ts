import {
  AdminDebugAccount,
  AdminLogEntry,
  AdminLogVisibility,
  AdminSeedFactionsResult,
  AdminStatus,
  ApConfig,
  CostConfig,
  DiplomacyState,
  FactionDetail,
  FactionSummary,
  GameRulesConfig,
  MapGenParams,
  PlayerLogCategory,
  PlayerLogEntry,
  PlayerLogScope,
  SeasonStatus,
  TimelapseFrameMeta,
  UserProfile,
} from './protocol';

const ADMIN_DEBUG_MODE_KEY = 'teien_admin_debug_panel';

export function getAdminDebugMode(): boolean {
  try {
    return localStorage.getItem(ADMIN_DEBUG_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAdminDebugMode(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.setItem(ADMIN_DEBUG_MODE_KEY, '1');
    } else {
      localStorage.removeItem(ADMIN_DEBUG_MODE_KEY);
    }
  } catch {
    // ストレージアクセス不可環境では無視
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  opts: RequestInit = {}
): Promise<T> {
  const headers = new Headers(opts.headers);
  if (opts.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  // HttpOnly Cookie 認証のため同一オリジンの資格情報を送信する
  const res = await fetch(path, { ...opts, credentials: 'same-origin', headers });
  const text = await res.text();
  const trimmed = text.trim();

  if (res.ok && res.status === 204 && !trimmed) {
    return {} as T;
  }

  let data: unknown = {};
  let parseFailed = false;
  if (!trimmed) {
    parseFailed = true;
    data = { error: `HTTP ${res.status}` };
  } else {
    try {
      data = JSON.parse(text);
    } catch {
      parseFailed = true;
      // 502 HTML 等の長文・タグ付きレスポンスはそのまま出さずステータス表記へフォールバック
      const isHtmlOrTooLong = trimmed.length > 200 || /<[a-z!/]/i.test(trimmed);
      data = { error: isHtmlOrTooLong ? `HTTP ${res.status}` : trimmed };
    }
  }

  if (!res.ok) {
    const msg =
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }

  const contentType = res.headers.get('content-type') ?? '';
  const isJsonContentType =
    !contentType || /\bapplication\/(?:[\w.+-]+\+)?json\b/i.test(contentType);
  if (parseFailed || !isJsonContentType) {
    throw new ApiError(res.status, 'サーバーから不正なレスポンスを受信しました');
  }
  return data as T;
}

function adminRequest<T>(path: string, opts: RequestInit = {}): Promise<T> {
  return request<T>(path, opts);
}

export const api = {
  getSeasonStatus: () => request<SeasonStatus>('/api/season/status'),
  getMe: () => request<UserProfile>('/api/auth/me'),
  register: (username: string, password: string) =>
    request<{ ok: boolean; user: UserProfile }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string) =>
    request<{ ok: boolean; user: UserProfile }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  listFactions: () => request<FactionSummary[]>('/api/factions'),
  getPlayerLogs: (
    category: PlayerLogCategory = 'all',
    limit = 100,
    opts?: {
      before_id?: number | null;
      after_id?: number | null;
      scope?: PlayerLogScope;
      faction_id?: number | null;
      q?: string;
    }
  ) => {
    const params = new URLSearchParams();
    params.set('category', category);
    params.set('limit', String(limit));
    if (opts?.before_id && opts.before_id > 0) {
      params.set('before_id', String(opts.before_id));
    }
    if (opts?.after_id && opts.after_id > 0) {
      params.set('after_id', String(opts.after_id));
    }
    if (opts?.scope && opts.scope !== 'all') {
      params.set('scope', opts.scope);
    }
    if (opts?.faction_id && opts.faction_id > 0) {
      params.set('faction_id', String(opts.faction_id));
    }
    const q = opts?.q?.trim();
    if (q) {
      params.set('q', q);
    }
    return request<{
      logs: PlayerLogEntry[];
      has_more: boolean;
      next_before_id: number | null;
    }>(`/api/logs?${params.toString()}`);
  },
  listTimelapseFrames: () =>
    request<{ frames: TimelapseFrameMeta[] }>('/api/timelapse/frames'),
  adminCaptureTimelapse: () =>
    adminRequest<{ ok: boolean; tick_number: number }>('/api/admin/timelapse/capture', {
      method: 'POST',
    }),
  getFactionDetail: (id: number) => request<FactionDetail>(`/api/factions/${id}`),
  createFaction: (name: string, color_id: number) =>
    request<{ id: number; name: string; color_id: number }>('/api/factions', {
      method: 'POST',
      body: JSON.stringify({ name, color_id }),
    }),
  joinFaction: (id: number) =>
    request<{ ok: boolean; faction_id: number }>(`/api/factions/${id}/join`, {
      method: 'POST',
    }),
  requestJoinFaction: (id: number) =>
    request<{ ok: boolean }>(`/api/factions/${id}/join-request`, {
      method: 'POST',
    }),
  acceptJoinRequest: (factionId: number, requestId: number) =>
    request<{ ok: boolean }>(`/api/factions/${factionId}/join-requests/${requestId}/accept`, {
      method: 'POST',
    }),
  rejectJoinRequest: (factionId: number, requestId: number) =>
    request<{ ok: boolean }>(`/api/factions/${factionId}/join-requests/${requestId}/reject`, {
      method: 'POST',
    }),
  leaveFaction: (id: number) =>
    request<{ ok: boolean }>(`/api/factions/${id}/leave`, { method: 'POST' }),
  kickMember: (factionId: number, user_id: number) =>
    request<{ ok: boolean }>(`/api/factions/${factionId}/kick`, {
      method: 'POST',
      body: JSON.stringify({ user_id }),
    }),
  updatePermissions: (
    factionId: number,
    userId: number,
    perms: {
      is_vice_leader: boolean;
      can_declare_war: boolean;
      can_ceasefire: boolean;
      can_manage_members: boolean;
    }
  ) =>
    request<{ ok: boolean }>(`/api/factions/${factionId}/members/${userId}/permissions`, {
      method: 'PATCH',
      body: JSON.stringify(perms),
    }),
  bulkUpdatePermissions: (
    factionId: number,
    perms: {
      can_declare_war: boolean;
      can_ceasefire: boolean;
      can_manage_members: boolean;
    }
  ) =>
    request<{ ok: boolean }>(`/api/factions/${factionId}/permissions/bulk`, {
      method: 'POST',
      body: JSON.stringify(perms),
    }),
  updateFactionSettings: (
    factionId: number,
    settings: {
      allow_auto_paint: boolean;
      join_policy?: number;
      color_id?: number;
    }
  ) =>
    request<{ ok: boolean }>(`/api/factions/${factionId}/settings`, {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
  updateAutoPaint: (enabled: boolean, pct: number) =>
    request<{ ok: boolean; auto_paint_enabled: boolean; auto_paint_pct: number }>(
      '/api/auth/auto_paint',
      {
        method: 'POST',
        body: JSON.stringify({ enabled, pct }),
      }
    ),

  getDiplomacy: () => request<DiplomacyState>('/api/diplomacy'),
  proposeCeasefire: (target_faction_id: number) =>
    request<{ ok: boolean }>('/api/diplomacy/ceasefire/propose', {
      method: 'POST',
      body: JSON.stringify({ target_faction_id }),
    }),
  respondCeasefire: (proposalId: number, accept: boolean) =>
    request<{ ok: boolean; accepted: boolean }>(`/api/diplomacy/ceasefire/${proposalId}/respond`, {
      method: 'POST',
      body: JSON.stringify({ accept }),
    }),

  // 管理者ページ用 API
  adminLogin: (id: string, password: string) =>
    request<{ ok: boolean; admin_id: string }>('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ id, password }),
    }),
  adminLogout: () => adminRequest<{ ok: boolean }>('/api/admin/logout', { method: 'POST' }),
  adminMe: () => adminRequest<AdminStatus>('/api/admin/me'),
  adminRegenerateMap: (payload: {
    size: number;
    continent_count: number;
    island_count: number;
    land_ratio_pct: number;
    seed?: number | null;
  }) =>
    adminRequest<{ ok: boolean; board_size: number; map_params: MapGenParams }>(
      '/api/admin/map/regenerate',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  adminSetPhase: (phase: 'preparation' | 'active' | 'frozen' | 'auto') =>
    adminRequest<{ ok: boolean; phase: string }>('/api/admin/phase', {
      method: 'POST',
      body: JSON.stringify({ phase }),
    }),
  adminTriggerTick: () =>
    adminRequest<{
      tick_number: number;
      promoted_cores: number;
      expired_old_cores: number;
      changed_cell_count: number;
      newly_extinct_factions: number[];
    }>('/api/admin/tick', { method: 'POST' }),

  adminUpdateApConfig: (payload: ApConfig) =>
    adminRequest<{ ok: boolean; ap_config: ApConfig }>('/api/admin/ap_config', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  adminUpdateCostConfig: (payload: CostConfig) =>
    adminRequest<{ ok: boolean; cost_config: CostConfig }>('/api/admin/cost_config', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  adminUpdateRulesConfig: (payload: GameRulesConfig) =>
    adminRequest<{ ok: boolean; game_rules: GameRulesConfig }>('/api/admin/rules_config', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  adminRenameFaction: (factionId: number, name: string) =>
    adminRequest<{ ok: boolean; name: string }>(`/api/admin/factions/${factionId}/rename`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  adminDeleteFaction: (factionId: number) =>
    adminRequest<{ ok: boolean; cleared_cells: number }>(`/api/admin/factions/${factionId}`, {
      method: 'DELETE',
    }),

  adminDeleteUser: (userId: number) =>
    adminRequest<{ ok: boolean }>(`/api/admin/users/${userId}`, {
      method: 'DELETE',
    }),

  adminForceWar: (faction_a: number, faction_b: number) =>
    adminRequest<{ ok: boolean }>('/api/admin/diplomacy/war', {
      method: 'POST',
      body: JSON.stringify({ faction_a, faction_b }),
    }),

  adminForceCeasefire: (faction_a: number, faction_b: number) =>
    adminRequest<{ ok: boolean }>('/api/admin/diplomacy/ceasefire', {
      method: 'POST',
      body: JSON.stringify({ faction_a, faction_b }),
    }),

  // 管理者デバッグ用 API
  adminDebugListAccounts: () =>
    adminRequest<{ accounts: AdminDebugAccount[] }>('/api/admin/debug/accounts'),
  adminDebugSeedFactions: (payload: {
    faction_count: number;
    members_per_faction: number;
    initial_ap: number;
    place_initial_core: boolean;
  }) =>
    adminRequest<AdminSeedFactionsResult>('/api/admin/debug/seed_factions', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  adminDebugImpersonate: (user_id: number) =>
    adminRequest<{ ok: boolean; user: UserProfile }>('/api/admin/debug/impersonate', {
      method: 'POST',
      body: JSON.stringify({ user_id }),
    }),
  adminDebugGrantAp: (payload: {
    user_id?: number | null;
    amount: number;
    mode?: 'set' | 'add';
  }) =>
    adminRequest<{ ok: boolean; updated_count: number; ap?: number; delta?: number }>(
      '/api/admin/debug/grant_ap',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  adminGetLogs: (
    category: PlayerLogCategory = 'all',
    limit = 100,
    opts?: {
      before_id?: number | null;
      after_id?: number | null;
      faction_id?: number | null;
      visibility?: AdminLogVisibility;
      season_id?: number | null;
      q?: string;
    }
  ) => {
    const params = new URLSearchParams();
    params.set('category', category);
    params.set('limit', String(limit));
    if (opts?.before_id && opts.before_id > 0) {
      params.set('before_id', String(opts.before_id));
    }
    if (opts?.after_id && opts.after_id > 0) {
      params.set('after_id', String(opts.after_id));
    }
    if (opts?.faction_id && opts.faction_id > 0) {
      params.set('faction_id', String(opts.faction_id));
    }
    if (opts?.visibility && opts.visibility !== 'all') {
      params.set('visibility', opts.visibility);
    }
    if (opts?.season_id !== undefined && opts.season_id !== null) {
      params.set('season_id', String(opts.season_id));
    }
    const q = opts?.q?.trim();
    if (q) {
      params.set('q', q);
    }
    return adminRequest<{
      logs: AdminLogEntry[];
      has_more: boolean;
      next_before_id: number | null;
      season_id: number;
      available_seasons: number[];
    }>(`/api/admin/logs?${params.toString()}`);
  },
};
