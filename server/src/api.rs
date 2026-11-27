use crate::auth::{
    build_clear_cookie, build_session_cookie, constant_time_eq, extract_client_ip, extract_cookie,
    generate_random_password, generate_session_token, hash_password, validate_display_name,
    validate_new_password, verify_password, ADMIN_SESSION_TTL_SECS, MAX_PASSWORD_BYTES,
    USER_SESSION_TTL_SECS,
};
use crate::db::{
    record_player_log, record_player_log_tx, record_player_log_tx_with_target,
    record_player_log_tx_with_visibility, war_pair, LOG_VISIBILITY_FACTION, LOG_VISIBILITY_PUBLIC,
};
use crate::map_gen::{all_size_limits, MapGenParams};
use crate::palette::{PALETTE, SEA_COLOR_RGB};
use crate::protocol::{encode_cell_diff_batch, encode_event_json};
use crate::season::SeasonPhase;
use crate::state::{ApConfig, AppState, FACTIONS_CACHE_TTL_SECS};
use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use flate2::write::GzEncoder;
use flate2::Compression;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::io::Write;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// メタデータ再同期要求イベントの JSON ペイロード
const METADATA_RESYNC_EVENT_JSON: &str = r#"{"type":"metadata_resync_required"}"#;

/// API エラーレスポンス生成ヘルパ
fn api_err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(serde_json::json!({ "error": msg.into() }))).into_response()
}

/// 内部エラーをログに記録し、詳細を隠蔽した汎用 500 レスポンスを返す
fn api_internal_err(context: &str, err: impl std::fmt::Display) -> Response {
    tracing::error!("{}: {}", context, err);
    api_err(
        StatusCode::INTERNAL_SERVER_ERROR,
        "サーバー内部エラーが発生しました",
    )
}

/// 勢力 ID を 1..=u16::MAX の範囲で検証し u16 に変換
#[allow(clippy::result_large_err)]
fn validate_faction_id_u16(id: i64) -> Result<u16, Response> {
    if id < 1 {
        return Err(api_err(StatusCode::BAD_REQUEST, "無効な勢力IDです"));
    }
    u16::try_from(id).map_err(|_| api_err(StatusCode::BAD_REQUEST, "無効な勢力IDです"))
}

/// Authorization ヘッダから Bearer トークンを抽出（空トークンは無視）
fn extract_bearer_token(headers: &HeaderMap) -> Option<String> {
    let val = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    val.strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Cookie 優先でユーザーセッショントークンを抽出（Authorization ヘッダフォールバック）
fn extract_token(headers: &HeaderMap) -> Option<String> {
    if let Some(tok) = extract_cookie(headers, "teien_session") {
        return Some(tok);
    }
    extract_bearer_token(headers)
}

/// セッショントークンからユーザーIDを解決（キャッシュ・有効期限検証付き）
async fn resolve_user_id(state: &AppState, headers: &HeaderMap) -> Option<i64> {
    let tok = extract_token(headers)?;
    state.resolve_active_user_session(&tok).await
}

/// IP レートリミットを先に検証し、続いてユーザー認証とアカウント単位レートリミットを検証する
#[allow(clippy::result_large_err)]
async fn authenticate_user_with_rate_limit(
    state: &AppState,
    addr: SocketAddr,
    headers: &HeaderMap,
) -> Result<i64, Response> {
    let ip = extract_client_ip(addr, headers, state.config.trust_proxy);
    if !state.ip_limiter.check_and_consume(&ip) {
        return Err(api_err(
            StatusCode::TOO_MANY_REQUESTS,
            "リクエスト制限を超過しました (IP: 最大10 req/sec)",
        ));
    }
    let Some(uid) = resolve_user_id(state, headers).await else {
        return Err(api_err(StatusCode::UNAUTHORIZED, "ログインが必要です"));
    };
    if !state.account_limiter.check_and_consume(&uid.to_string()) {
        return Err(api_err(
            StatusCode::TOO_MANY_REQUESTS,
            "リクエスト制限を超過しました (アカウント: 最大10 req/sec)",
        ));
    }
    Ok(uid)
}

/// IP レートリミットを先に検証し、続いて管理者認証を検証する
#[allow(clippy::result_large_err)]
async fn authenticate_admin_with_rate_limit(
    state: &AppState,
    addr: SocketAddr,
    headers: &HeaderMap,
) -> Result<String, Response> {
    let ip = extract_client_ip(addr, headers, state.config.trust_proxy);
    if !state.ip_limiter.check_and_consume(&ip) {
        return Err(api_err(
            StatusCode::TOO_MANY_REQUESTS,
            "リクエスト制限を超過しました (IP: 最大10 req/sec)",
        ));
    }
    let Some(admin_id) = resolve_admin(state, headers).await else {
        return Err(api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です"));
    };
    Ok(admin_id)
}

#[allow(clippy::result_large_err)]
fn check_rate_limit(state: &AppState, ip: &str, uid: Option<i64>) -> Result<(), Response> {
    if !state.ip_limiter.check_and_consume(ip) {
        return Err(api_err(
            StatusCode::TOO_MANY_REQUESTS,
            "リクエスト制限を超過しました (IP: 最大10 req/sec)",
        ));
    }
    if let Some(id) = uid {
        if !state.account_limiter.check_and_consume(&id.to_string()) {
            return Err(api_err(
                StatusCode::TOO_MANY_REQUESTS,
                "リクエスト制限を超過しました (アカウント: 最大10 req/sec)",
            ));
        }
    }
    Ok(())
}

/// 読み取り系エンドポイント向けのレートリミットを検証
#[allow(clippy::result_large_err)]
fn check_read_rate_limit(state: &AppState, ip: &str) -> Result<(), Response> {
    if !state.read_limiter.check_and_consume(ip) {
        return Err(api_err(
            StatusCode::TOO_MANY_REQUESTS,
            "リクエスト制限を超過しました。しばらく待ってから再試行してください",
        ));
    }
    Ok(())
}

// ============================================================
// 認証 API
// ============================================================

#[derive(Deserialize)]
pub struct AuthPayload {
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct UserProfile {
    pub id: i64,
    pub username: String,
    pub ap: i64,
    pub max_ap: i64,
    pub faction_id: i64,
    pub faction_allow_auto_paint: bool,
    pub auto_paint_enabled: bool,
    pub auto_paint_pct: i64,
    pub permissions: MemberPermissions,
    pub incoming_join_requests: Vec<JoinRequestInfo>,
    pub outgoing_join_request_faction_ids: Vec<i64>,
}

#[derive(Serialize, Default, Clone)]
pub struct MemberPermissions {
    pub is_leader: bool,
    pub is_vice_leader: bool,
    pub can_declare_war: bool,
    pub can_ceasefire: bool,
    pub can_manage_members: bool,
}

#[derive(Serialize)]
pub struct JoinRequestInfo {
    pub id: i64,
    pub faction_id: i64,
    pub user_id: i64,
    pub username: String,
    pub created_at: String,
}

#[allow(clippy::result_large_err)]
async fn load_user_profile(state: &AppState, uid: i64) -> Result<UserProfile, Response> {
    let season_id = state.current_season_id();
    let row = sqlx::query(
        "SELECT id, username, ap, faction_id, auto_paint_enabled, auto_paint_pct FROM users WHERE id = ?",
    )
        .bind(uid)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| api_internal_err("ユーザープロフィール取得失敗", e))?
        .ok_or_else(|| api_err(StatusCode::UNAUTHORIZED, "ユーザーが見つかりません"))?;

    let mut faction_id: i64 = row.get("faction_id");
    let mut faction_allow_auto_paint = false;
    let mut permissions = MemberPermissions::default();

    if faction_id > 0 {
        let f_opt = sqlx::query(
            "SELECT leader_user_id, allow_auto_paint FROM factions WHERE id = ? AND season_id = ?",
        )
            .bind(faction_id)
            .bind(season_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| api_internal_err("所属勢力情報取得失敗", e))?;

        if let Some(frow) = f_opt {
            let leader_id: i64 = frow.get("leader_user_id");
            faction_allow_auto_paint = frow.get::<i64, _>("allow_auto_paint") != 0;
            let m_opt = sqlx::query(
                "SELECT is_vice_leader, can_declare_war, can_ceasefire, can_manage_members FROM faction_members WHERE faction_id = ? AND user_id = ?",
            )
            .bind(faction_id)
            .bind(uid)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| api_internal_err("メンバー権限取得失敗", e))?;

            let is_leader = leader_id == uid;
            let is_vice = m_opt
                .as_ref()
                .map(|r| r.get::<i64, _>("is_vice_leader") != 0)
                .unwrap_or(false);
            permissions = MemberPermissions {
                is_leader,
                is_vice_leader: is_vice,
                can_declare_war: is_leader
                    || is_vice
                    || m_opt
                        .as_ref()
                        .map(|r| r.get::<i64, _>("can_declare_war") != 0)
                        .unwrap_or(false),
                can_ceasefire: is_leader
                    || is_vice
                    || m_opt
                        .as_ref()
                        .map(|r| r.get::<i64, _>("can_ceasefire") != 0)
                        .unwrap_or(false),
                can_manage_members: is_leader
                    || is_vice
                    || m_opt
                        .as_ref()
                        .map(|r| r.get::<i64, _>("can_manage_members") != 0)
                        .unwrap_or(false),
            };
        } else {
            faction_id = 0;
        }
    }

    let incoming_join_requests = if faction_id > 0 && permissions.can_manage_members {
        let req_rows = sqlx::query(
            r#"
            SELECT jr.id, jr.faction_id, jr.user_id, u.username, jr.created_at
            FROM faction_join_requests jr
            JOIN users u ON u.id = jr.user_id
            JOIN factions f ON f.id = jr.faction_id
            WHERE jr.faction_id = ? AND f.season_id = ?
            ORDER BY jr.id DESC
            "#,
        )
        .bind(faction_id)
        .bind(season_id)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| api_internal_err("受信参加申請取得失敗", e))?;

        req_rows
            .into_iter()
            .map(|r| JoinRequestInfo {
                id: r.get("id"),
                faction_id: r.get("faction_id"),
                user_id: r.get("user_id"),
                username: r.get("username"),
                created_at: r.get("created_at"),
            })
            .collect()
    } else {
        Vec::new()
    };

    let outgoing_join_request_faction_ids = sqlx::query(
        r#"
        SELECT jr.faction_id
        FROM faction_join_requests jr
        JOIN factions f ON f.id = jr.faction_id
        WHERE jr.user_id = ? AND f.season_id = ?
        "#,
    )
    .bind(uid)
    .bind(season_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| api_internal_err("送信済み参加申請取得失敗", e))?
    .into_iter()
    .map(|r| r.get::<i64, _>("faction_id"))
    .collect();

    Ok(UserProfile {
        id: row.get("id"),
        username: row.get("username"),
        ap: row.get("ap"),
        max_ap: state.effective_max_ap(),
        faction_id,
        faction_allow_auto_paint,
        auto_paint_enabled: row.get::<i64, _>("auto_paint_enabled") != 0,
        auto_paint_pct: row.get::<i64, _>("auto_paint_pct").clamp(1, 100),
        permissions,
        incoming_join_requests,
        outgoing_join_request_faction_ids,
    })
}

pub async fn register(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<AuthPayload>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if !state.register_limiter.check_and_consume(&ip) {
        return api_err(
            StatusCode::TOO_MANY_REQUESTS,
            "新規登録の制限を超過しました。しばらく待ってから再試行してください",
        );
    }
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    let username = match validate_display_name(&payload.username, 2, 20, "ユーザー名") {
        Ok(name) => name,
        Err(msg) => return api_err(StatusCode::BAD_REQUEST, msg),
    };
    if let Err(msg) = validate_new_password(&payload.password) {
        return api_err(StatusCode::BAD_REQUEST, msg);
    }

    let Some(_argon2_permit) = state.acquire_argon2_permit().await else {
        return api_err(
            StatusCode::SERVICE_UNAVAILABLE,
            "認証処理が混雑しています。少し待ってから再試行してください",
        );
    };
    let pw = payload.password.clone();
    let hash = match tokio::task::spawn_blocking(move || hash_password(&pw)).await {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => return api_internal_err("パスワードハッシュ化失敗", e),
        Err(e) => return api_internal_err("パスワードハッシュタスク失敗", e),
    };
    drop(_argon2_permit);
    let now = Utc::now().to_rfc3339();

    // セッション破棄との競合を防ぐため、action_mutex 内で AP 設定参照・DB 登録・キャッシュ登録を行う
    let _action_guard = state.action_mutex.lock().await;
    let epoch = state.current_session_cache_epoch();
    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("ユーザー登録TX開始失敗", e),
    };
    let initial_ap = state.current_ap_config().roll_initial_ap();
    let insert = sqlx::query(
        "INSERT INTO users (username, password_hash, ap, faction_id, created_at) VALUES (?, ?, ?, 0, ?)",
    )
    .bind(username)
    .bind(&hash)
    .bind(initial_ap)
    .bind(&now)
    .execute(&mut *tx)
    .await;

    let uid = match insert {
        Ok(res) => res.last_insert_rowid(),
        Err(e) => {
            if e.to_string().contains("UNIQUE") {
                return api_err(
                    StatusCode::CONFLICT,
                    "そのユーザー名は既に使用されています",
                );
            }
            return api_internal_err("ユーザー登録失敗", e);
        }
    };

    let token = generate_session_token();
    let expires_at_dt = Utc::now() + chrono::Duration::seconds(USER_SESSION_TTL_SECS);
    let expires_at = expires_at_dt.to_rfc3339();
    let expires_at_unix = expires_at_dt.timestamp();
    if let Err(e) = sqlx::query(
        "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&token)
    .bind(uid)
    .bind(&now)
    .bind(&expires_at)
    .execute(&mut *tx)
    .await
    {
        return api_internal_err("セッション登録失敗", e);
    }
    if let Err(e) = tx.commit().await {
        return api_internal_err("ユーザー登録TXコミット失敗", e);
    }
    state.cache_user_session_if_epoch(token.clone(), uid, expires_at_unix, epoch);
    drop(_action_guard);

    match load_user_profile(&state, uid).await {
        Ok(user) => {
            let mut resp = (
                StatusCode::CREATED,
                Json(serde_json::json!({ "ok": true, "user": user })),
            )
                .into_response();
            let cookie = build_session_cookie(
                "teien_session",
                &token,
                USER_SESSION_TTL_SECS,
                "Lax",
                state.config.cookie_secure,
            );
            if let Ok(hv) = HeaderValue::from_str(&cookie) {
                resp.headers_mut().insert(header::SET_COOKIE, hv);
            }
            resp
        }
        Err(r) => r,
    }
}

pub async fn login(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<AuthPayload>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if !state.login_limiter.check_and_consume(&ip) {
        return api_err(
            StatusCode::TOO_MANY_REQUESTS,
            "ログイン試行の制限を超過しました。しばらく待ってから再試行してください",
        );
    }
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    if payload.password.len() > MAX_PASSWORD_BYTES {
        return api_err(
            StatusCode::UNAUTHORIZED,
            "ユーザー名またはパスワードが正しくありません",
        );
    }
    let username = payload.username.trim();
    if !state
        .login_account_limiter
        .check_and_consume(&username.to_lowercase())
    {
        return api_err(
            StatusCode::TOO_MANY_REQUESTS,
            "ログイン試行の制限を超過しました。しばらく待ってから再試行してください",
        );
    }
    let row = match sqlx::query("SELECT id, password_hash FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(r)) => r,
        Ok(None) => {
            // ユーザー不在時もダミーの Argon2 検証を実行し、タイミング差による列挙を軽減する
            const DUMMY_ARGON2_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
            let Some(_argon2_permit) = state.acquire_argon2_permit().await else {
                return api_err(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "認証処理が混雑しています。少し待ってから再試行してください",
                );
            };
            let pw = payload.password.clone();
            let _ = tokio::task::spawn_blocking(move || verify_password(&pw, DUMMY_ARGON2_HASH))
                .await;
            return api_err(
                StatusCode::UNAUTHORIZED,
                "ユーザー名またはパスワードが正しくありません",
            );
        }
        Err(e) => return api_internal_err("ログインユーザー検索失敗", e),
    };

    let uid: i64 = row.get("id");
    let hash: String = row.get("password_hash");
    let Some(_argon2_permit) = state.acquire_argon2_permit().await else {
        return api_err(
            StatusCode::SERVICE_UNAVAILABLE,
            "認証処理が混雑しています。少し待ってから再試行してください",
        );
    };
    let pw = payload.password.clone();
    let valid = tokio::task::spawn_blocking(move || verify_password(&pw, &hash))
        .await
        .unwrap_or(false);
    drop(_argon2_permit);
    if !valid {
        return api_err(
            StatusCode::UNAUTHORIZED,
            "ユーザー名またはパスワードが正しくありません",
        );
    }

    let epoch = state.current_session_cache_epoch();
    let token = generate_session_token();
    let now = Utc::now().to_rfc3339();
    let expires_at_dt = Utc::now() + chrono::Duration::seconds(USER_SESSION_TTL_SECS);
    let expires_at = expires_at_dt.to_rfc3339();
    let expires_at_unix = expires_at_dt.timestamp();
    if let Err(e) = sqlx::query(
        "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&token)
    .bind(uid)
    .bind(&now)
    .bind(&expires_at)
    .execute(&state.pool)
    .await
    {
        return api_internal_err("セッション登録失敗", e);
    }
    state.cache_user_session_if_epoch(token.clone(), uid, expires_at_unix, epoch);
    for evicted_tok in crate::db::enforce_user_session_limit(&state.pool, uid, 10).await {
        state.invalidate_user_session(&evicted_tok);
    }

    match load_user_profile(&state, uid).await {
        Ok(user) => {
            let mut resp =
                Json(serde_json::json!({ "ok": true, "user": user })).into_response();
            let cookie = build_session_cookie(
                "teien_session",
                &token,
                USER_SESSION_TTL_SECS,
                "Lax",
                state.config.cookie_secure,
            );
            if let Ok(hv) = HeaderValue::from_str(&cookie) {
                resp.headers_mut().insert(header::SET_COOKIE, hv);
            }
            resp
        }
        Err(r) => r,
    }
}

pub async fn logout(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    if let Some(tok) = extract_token(&headers) {
        // 先に DB から削除し、未登録の偽トークンによる全 WS 起床・キャッシュ世代進行を防ぐ
        match sqlx::query("DELETE FROM sessions WHERE token = ?")
            .bind(&tok)
            .execute(&state.pool)
            .await
        {
            Ok(res) if res.rows_affected() > 0 => {
                state.invalidate_user_session(&tok);
            }
            Ok(_) => {
                state.invalidate_user_session_if_present(&tok);
            }
            Err(e) => {
                tracing::error!("セッション削除に失敗しました: {}", e);
                state.invalidate_user_session(&tok);
            }
        }
    }
    let mut resp = Json(serde_json::json!({ "ok": true })).into_response();
    let cookie = build_clear_cookie("teien_session", "Lax", state.config.cookie_secure);
    if let Ok(hv) = HeaderValue::from_str(&cookie) {
        resp.headers_mut().insert(header::SET_COOKIE, hv);
    }
    resp
}

pub async fn get_me(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_read_rate_limit(&state, &ip) {
        return r;
    }
    let Some(uid) = resolve_user_id(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "未ログインです");
    };
    match load_user_profile(&state, uid).await {
        Ok(profile) => Json(profile).into_response(),
        Err(r) => r,
    }
}

// ============================================================
// シーズン・盤面スナップショット・ランキング API
// ============================================================

pub async fn season_status(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_read_rate_limit(&state, &ip) {
        return r;
    }
    let now = Utc::now();
    let phase = state.phase_at(now);
    let map_params = state.current_map_params();
    let palette_hex: Vec<String> = PALETTE
        .iter()
        .map(|[r, g, b]| format!("#{:02X}{:02X}{:02X}", r, g, b))
        .collect();
    let sea_hex = format!(
        "#{:02X}{:02X}{:02X}",
        SEA_COLOR_RGB[0], SEA_COLOR_RGB[1], SEA_COLOR_RGB[2]
    );
    Json(serde_json::json!({
        "season_id": state.current_season_id(),
        "phase": phase,
        "tick_number": state.tick_number_at(now),
        "max_ticks": state.current_game_rules().max_ticks,
        "next_tick_unix": state.next_refill_unix_at(now),
        "online_count": state.online_count.load(Ordering::Relaxed),
        "dev_mode": state.config.dev_mode,
        "board_size": map_params.size,
        "map_params": map_params,
        "size_limits": all_size_limits(),
        "ap_config": state.current_ap_config(),
        "effective_max_ap": state.effective_ap_bounds_at(now).0,
        "endgame_boost_active": state.is_endgame_ap_boost_active_at(now),
        "cost_config": state.current_cost_config(),
        "game_rules": state.current_game_rules(),
        "faction_name_max_len": state.current_faction_name_max_len(),
        "sea_color": sea_hex,
        "palette": palette_hex,
    }))
    .into_response()
}

/// 盤面バイナリを gzip 圧縮して高速配信（2秒キャッシュ＋spawn_blocking圧縮＋スタンピード防止）
pub async fn board_snapshot(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_read_rate_limit(&state, &ip) {
        return r;
    }

    let cached_hit = {
        let guard = state.snapshot_cache.read();
        if let Some(c) = guard.as_ref() {
            if c.cached_at.elapsed() < std::time::Duration::from_secs(2)
                && c.version == state.snapshot_version.load(Ordering::Acquire)
            {
                Some((c.version, c.board_size, c.gz_bytes.clone()))
            } else {
                None
            }
        } else {
            None
        }
    };

    let (snapshot_version, board_size, compressed) = if let Some(hit) = cached_hit {
        hit
    } else {
        // キャッシュミス時はリフレッシュロックを取得して再確認し、キャッシュスタンピードを防止
        let _refresh_guard = state.snapshot_refresh_lock.lock().await;
        let recheck_hit = {
            let guard = state.snapshot_cache.read();
            if let Some(c) = guard.as_ref() {
                if c.cached_at.elapsed() < std::time::Duration::from_secs(2)
                    && c.version == state.snapshot_version.load(Ordering::Acquire)
                {
                    Some((c.version, c.board_size, c.gz_bytes.clone()))
                } else {
                    None
                }
            } else {
                None
            }
        };

        if let Some(hit) = recheck_hit {
            hit
        } else {
            // 盤面内容とスナップショットバージョンの不整合を防ぐため同一 board.read() ロック内で一括取得する
            let (ver, sz, raw_bytes): (u64, usize, Vec<u8>) = {
                let board = state.board.read();
                (
                    state.snapshot_version.load(Ordering::Acquire),
                    board.size,
                    board.as_bytes().to_vec(),
                )
            };
            let compressed =
                match tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
                    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
                    encoder
                        .write_all(&raw_bytes)
                        .map_err(|e| format!("盤面圧縮に失敗しました: {}", e))?;
                    encoder
                        .finish()
                        .map_err(|e| format!("盤面圧縮完了に失敗しました: {}", e))
                })
                .await
                {
                    Ok(Ok(bytes)) => bytes,
                    Ok(Err(msg)) => return api_internal_err("盤面圧縮失敗", msg),
                    Err(e) => return api_internal_err("盤面圧縮タスク失敗", e),
                };

            let mut guard = state.snapshot_cache.write();
            let gz_bytes = Bytes::from(compressed);
            if state.snapshot_version.load(Ordering::Acquire) == ver {
                *guard = Some(crate::state::CachedSnapshot {
                    version: ver,
                    board_size: sz,
                    gz_bytes: gz_bytes.clone(),
                    cached_at: std::time::Instant::now(),
                });
            }
            (ver, sz, gz_bytes)
        }
    };

    let mut resp = (
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CONTENT_ENCODING, "gzip"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        compressed,
    )
        .into_response();
    if let Ok(val) = HeaderValue::from_str(&board_size.to_string()) {
        resp.headers_mut()
            .insert(HeaderName::from_static("x-board-size"), val);
    }
    if let Ok(val) = HeaderValue::from_str(&snapshot_version.to_string()) {
        resp.headers_mut()
            .insert(HeaderName::from_static("x-snapshot-version"), val);
    }
    resp
}

#[derive(Serialize)]
pub struct FactionSummary {
    pub id: i64,
    pub name: String,
    pub color_id: i64,
    pub leader_user_id: i64,
    pub leader_name: String,
    pub initial_core_used: i64,
    pub territory_count: i64,
    pub core_count: i64,
    pub is_extinct: bool,
    pub join_policy: i64,
    pub member_count: i64,
}

pub async fn list_factions(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_read_rate_limit(&state, &ip) {
        return r;
    }
    let season_id = state.current_season_id();
    let ttl = std::time::Duration::from_secs(FACTIONS_CACHE_TTL_SECS);
    let epoch_before = match state.read_factions_cache(season_id, ttl) {
        Ok(json_bytes) => {
            return ([(header::CONTENT_TYPE, "application/json")], json_bytes).into_response();
        }
        Err(epoch) => epoch,
    };

    let rows = match sqlx::query(
        r#"
        SELECT f.id, f.name, f.color_id, f.leader_user_id, COALESCE(u.username, '(不在)') AS leader_name,
               f.initial_core_used, f.territory_count, f.core_count, f.is_extinct, f.join_policy,
               COALESCE(mc.member_count, 0) AS member_count
        FROM factions f
        LEFT JOIN users u ON u.id = f.leader_user_id
        LEFT JOIN (
            SELECT faction_id, COUNT(*) AS member_count
            FROM faction_members
            GROUP BY faction_id
        ) mc ON mc.faction_id = f.id
        WHERE f.season_id = ?
        ORDER BY f.territory_count DESC, f.core_count DESC, f.id ASC
        "#,
    )
    .bind(season_id)
    .fetch_all(&state.pool)
    .await
    {
        Ok(r) => r,
        Err(e) => return api_internal_err("勢力一覧取得失敗", e),
    };

    let list: Vec<FactionSummary> = rows
        .into_iter()
        .map(|r| FactionSummary {
            id: r.get("id"),
            name: r.get("name"),
            color_id: r.get("color_id"),
            leader_user_id: r.get("leader_user_id"),
            leader_name: r.get("leader_name"),
            initial_core_used: r.get("initial_core_used"),
            territory_count: r.get("territory_count"),
            core_count: r.get("core_count"),
            is_extinct: r.get::<i64, _>("is_extinct") != 0,
            join_policy: r.get("join_policy"),
            member_count: r.get("member_count"),
        })
        .collect();

    let json_vec = match serde_json::to_vec(&list) {
        Ok(v) => v,
        Err(e) => return api_internal_err("勢力一覧シリアライズ失敗", e),
    };
    let json_bytes = Bytes::from(json_vec);
    let _ = state.store_factions_cache_if_fresh(season_id, epoch_before, json_bytes.clone());

    (
        [(header::CONTENT_TYPE, "application/json")],
        json_bytes,
    )
        .into_response()
}

pub async fn get_rankings(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    list_factions(ConnectInfo(addr), State(state), headers).await
}

// ============================================================
// 勢力・権限管理 API
// ============================================================

#[derive(Deserialize)]
pub struct CreateFactionPayload {
    pub name: String,
    pub color_id: i64,
}

pub async fn create_faction(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<CreateFactionPayload>,
) -> Response {
    let uid = match authenticate_user_with_rate_limit(&state, addr, &headers).await {
        Ok(id) => id,
        Err(r) => return r,
    };

    let max_len = state.current_faction_name_max_len();
    let name = match validate_display_name(&payload.name, 1, max_len, "勢力名") {
        Ok(n) => n,
        Err(msg) => return api_err(StatusCode::BAD_REQUEST, msg),
    };
    if !(0..64).contains(&payload.color_id) {
        return api_err(StatusCode::BAD_REQUEST, "勢力カラーIDは 0..63 で指定してください");
    }

    let _action_guard = state.action_mutex.lock().await;
    match state.current_phase() {
        SeasonPhase::Frozen => {
            return api_err(
                StatusCode::FORBIDDEN,
                "凍結フェーズ中は勢力を設立できません",
            );
        }
        SeasonPhase::Preparation => {
            return api_err(
                StatusCode::FORBIDDEN,
                "準備フェーズ中は勢力を設立できません",
            );
        }
        SeasonPhase::Active => {}
    }

    let season_id = state.current_season_id();
    let now = Utc::now().to_rfc3339();

    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("勢力設立TX開始失敗", e),
    };

    // トランザクション内で既存勢力に所属していないか確認（同時設立 TOCTOU 防止・フェイルオープン解消）
    let (cur_fid, founder_name): (i64, String) =
        match sqlx::query("SELECT faction_id, username FROM users WHERE id = ?")
            .bind(uid)
            .fetch_optional(&mut *tx)
            .await
        {
            Ok(Some(r)) => (r.get("faction_id"), r.get("username")),
            Ok(None) => return api_err(StatusCode::UNAUTHORIZED, "ユーザーが見つかりません"),
            Err(e) => return api_internal_err("ユーザー所属確認失敗", e),
        };

    if cur_fid > 0 {
        let exists = match sqlx::query("SELECT 1 FROM factions WHERE id = ? AND season_id = ?")
            .bind(cur_fid)
            .bind(season_id)
            .fetch_optional(&mut *tx)
            .await
        {
            Ok(opt) => opt.is_some(),
            Err(e) => return api_internal_err("既存勢力確認失敗", e),
        };
        if exists {
            return api_err(
                StatusCode::CONFLICT,
                "既に別の勢力に所属しています。先に脱退してください",
            );
        }
    }

    let res = sqlx::query(
        r#"
        INSERT INTO factions (season_id, name, color_id, leader_user_id, created_at)
        VALUES (?, ?, ?, ?, ?)
        "#,
    )
    .bind(season_id)
    .bind(&name)
    .bind(payload.color_id)
    .bind(uid)
    .bind(&now)
    .execute(&mut *tx)
    .await;

    let fid = match res {
        Ok(r) => r.last_insert_rowid(),
        Err(e) => {
            if e.to_string().contains("UNIQUE") {
                return api_err(
                    StatusCode::CONFLICT,
                    "勢力名または勢力カラーが他の勢力と重複しています",
                );
            }
            return api_internal_err("勢力作成失敗", e);
        }
    };

    if fid <= 0 || fid > u16::MAX as i64 {
        let _ = tx.rollback().await;
        return api_err(
            StatusCode::BAD_REQUEST,
            "勢力IDの上限に達したため新規作成できません",
        );
    }

    if let Err(e) = sqlx::query(
        r#"
        INSERT INTO faction_members
        (faction_id, user_id, is_vice_leader, can_declare_war, can_ceasefire, can_manage_members, joined_at)
        VALUES (?, ?, 0, 1, 1, 1, ?)
        "#,
    )
    .bind(fid)
    .bind(uid)
    .bind(&now)
    .execute(&mut *tx)
    .await
    {
        return api_internal_err("勢力メンバー登録失敗", e);
    }

    if let Err(e) = sqlx::query("UPDATE users SET faction_id = ? WHERE id = ?")
        .bind(fid)
        .bind(uid)
        .execute(&mut *tx)
        .await
    {
        return api_internal_err("ユーザー勢力更新失敗", e);
    }

    // 勢力設立前に他勢力へ出していた未処理の参加申請を削除（後からの強制引き抜き防止）
    let cleared_request_managers =
        match collect_join_request_managers_tx(&mut tx, uid, season_id, None).await {
            Ok(uids) => uids,
            Err(r) => return r,
        };
    if let Err(e) = sqlx::query("DELETE FROM faction_join_requests WHERE user_id = ?")
        .bind(uid)
        .execute(&mut *tx)
        .await
    {
        return api_internal_err("参加申請クリア失敗", e);
    }

    if let Err(e) = tx.commit().await {
        return api_internal_err("勢力設立TXコミット失敗", e);
    }
    state.invalidate_factions_cache();

    if !cleared_request_managers.is_empty() {
        state.send_event_to_users(
            &cleared_request_managers,
            encode_event_json(METADATA_RESYNC_EVENT_JSON),
        );
    }

    let event = serde_json::json!({
        "type": "faction_created",
        "faction_id": fid,
        "name": name,
        "color_id": payload.color_id,
        "leader_user_id": uid,
    });
    state.broadcast_frame(encode_event_json(&event.to_string()));

    record_player_log(
        &state.pool,
        season_id,
        uid,
        &founder_name,
        fid,
        "faction",
        &format!("勢力「{}」を設立した", name),
    )
    .await;

    (
        StatusCode::CREATED,
        Json(serde_json::json!({ "id": fid, "name": name, "color_id": payload.color_id })),
    )
        .into_response()
}

#[derive(Serialize)]
pub struct FactionMemberInfo {
    pub user_id: i64,
    pub username: String,
    pub is_leader: bool,
    pub is_vice_leader: bool,
    pub can_declare_war: bool,
    pub can_ceasefire: bool,
    pub can_manage_members: bool,
}

pub async fn get_faction_detail(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(faction_id): Path<i64>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_read_rate_limit(&state, &ip) {
        return r;
    }
    let season_id = state.current_season_id();
    let frow = match sqlx::query(
        r#"
        SELECT id, name, color_id, leader_user_id, initial_core_used, territory_count, core_count, is_extinct,
               allow_auto_paint, join_policy
        FROM factions WHERE id = ? AND season_id = ?
        "#,
    )
    .bind(faction_id)
    .bind(season_id)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::NOT_FOUND, "勢力が見つかりません"),
        Err(e) => return api_internal_err("勢力詳細取得失敗", e),
    };

    let leader_id: i64 = frow.get("leader_user_id");
    let mrows = match sqlx::query(
        r#"
        SELECT fm.user_id, u.username, fm.is_vice_leader, fm.can_declare_war, fm.can_ceasefire, fm.can_manage_members
        FROM faction_members fm
        JOIN users u ON u.id = fm.user_id
        WHERE fm.faction_id = ?
        ORDER BY (fm.user_id = ?) DESC, fm.is_vice_leader DESC, fm.joined_at ASC
        "#,
    )
    .bind(faction_id)
    .bind(leader_id)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => return api_internal_err("勢力メンバー一覧取得失敗", e),
    };

    let members: Vec<FactionMemberInfo> = mrows
        .into_iter()
        .map(|r| {
            let uid: i64 = r.get("user_id");
            FactionMemberInfo {
                user_id: uid,
                username: r.get("username"),
                is_leader: uid == leader_id,
                is_vice_leader: r.get::<i64, _>("is_vice_leader") != 0,
                can_declare_war: r.get::<i64, _>("can_declare_war") != 0,
                can_ceasefire: r.get::<i64, _>("can_ceasefire") != 0,
                can_manage_members: r.get::<i64, _>("can_manage_members") != 0,
            }
        })
        .collect();

    Json(serde_json::json!({
        "id": frow.get::<i64, _>("id"),
        "name": frow.get::<String, _>("name"),
        "color_id": frow.get::<i64, _>("color_id"),
        "leader_user_id": leader_id,
        "initial_core_used": frow.get::<i64, _>("initial_core_used"),
        "territory_count": frow.get::<i64, _>("territory_count"),
        "core_count": frow.get::<i64, _>("core_count"),
        "is_extinct": frow.get::<i64, _>("is_extinct") != 0,
        "allow_auto_paint": frow.get::<i64, _>("allow_auto_paint") != 0,
        "join_policy": frow.get::<i64, _>("join_policy"),
        "members": members,
    }))
    .into_response()
}

pub async fn join_faction(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(faction_id): Path<i64>,
) -> Response {
    let uid = match authenticate_user_with_rate_limit(&state, addr, &headers).await {
        Ok(id) => id,
        Err(r) => return r,
    };

    let _action_guard = state.action_mutex.lock().await;
    if state.current_phase() == SeasonPhase::Frozen {
        return api_err(StatusCode::FORBIDDEN, "凍結フェーズ中は参加できません");
    }

    let season_id = state.current_season_id();
    let now = Utc::now().to_rfc3339();
    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("勢力参加TX開始失敗", e),
    };

    // トランザクション内で勢力情報・参加方式・現所属を確認
    let frow = match sqlx::query(
        "SELECT name, join_policy, leader_user_id FROM factions WHERE id = ? AND season_id = ?",
    )
    .bind(faction_id)
    .bind(season_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::NOT_FOUND, "勢力が見つかりません"),
        Err(e) => return api_internal_err("勢力情報取得失敗", e),
    };
    let faction_name: String = frow.get("name");
    let join_policy: i64 = frow.get("join_policy");
    let target_leader_id: i64 = frow.get("leader_user_id");
    if join_policy == 1 {
        return api_err(
            StatusCode::FORBIDDEN,
            "この勢力は参加許可制です。参加申請を送信してください",
        );
    }

    // 現所属を確認し、既に同勢力または他勢力に所属していれば拒否する
    let (cleared_managers, promoted_to_leader) = match move_user_to_faction_tx(
        &mut tx,
        uid,
        faction_id,
        target_leader_id,
        season_id,
        &now,
    )
    .await
    {
        Ok(res) => res,
        Err(resp) => return resp,
    };

    let username: String = match sqlx::query_scalar("SELECT username FROM users WHERE id = ?")
        .bind(uid)
        .fetch_optional(&mut *tx)
        .await
    {
        Ok(Some(u)) => u,
        Ok(None) => return api_err(StatusCode::UNAUTHORIZED, "ユーザーが見つかりません"),
        Err(e) => return api_internal_err("ユーザー名取得失敗", e),
    };
    record_player_log_tx(
        &mut tx,
        season_id,
        uid,
        &username,
        faction_id,
        "faction",
        &format!("勢力「{}」に参加した", faction_name),
    )
    .await;
    if promoted_to_leader {
        record_player_log_tx(
            &mut tx,
            season_id,
            uid,
            &username,
            faction_id,
            "faction",
            &format!("勢力「{}」の新リーダーに就任した", faction_name),
        )
        .await;
    }

    let recipient_uids = match collect_faction_member_uids_except_tx(&mut tx, faction_id, uid).await
    {
        Ok(uids) => uids,
        Err(resp) => return resp,
    };

    if let Err(e) = tx.commit().await {
        return api_internal_err("勢力参加TXコミット失敗", e);
    }
    state.invalidate_factions_cache();

    if !cleared_managers.is_empty() {
        state.send_event_to_users(
            &cleared_managers,
            encode_event_json(METADATA_RESYNC_EVENT_JSON),
        );
    }
    if !recipient_uids.is_empty() {
        let join_event = serde_json::json!({
            "type": "faction_member_joined",
            "faction_id": faction_id,
            "faction_name": faction_name,
            "user_id": uid,
            "username": username,
        });
        state.send_event_to_users(&recipient_uids, encode_event_json(&join_event.to_string()));
    }
    if promoted_to_leader {
        let transfer_event = serde_json::json!({
            "type": "faction_leader_transferred",
            "faction_id": faction_id,
            "faction_name": faction_name,
            "new_leader_user_id": uid,
            "new_leader_username": username,
        });
        state.send_event_to_user(uid, encode_event_json(&transfer_event.to_string()));
    }
    let event = serde_json::json!({
        "type": "faction_updated",
        "faction_id": faction_id,
        "joined_user_id": uid,
    });
    state.broadcast_frame(encode_event_json(&event.to_string()));

    Json(serde_json::json!({ "ok": true, "faction_id": faction_id })).into_response()
}

/// トランザクション内で指定勢力のメンバーUID一覧（exclude_user_id を除く）を取得する
#[allow(clippy::result_large_err)]
async fn collect_faction_member_uids_except_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    faction_id: i64,
    exclude_user_id: i64,
) -> Result<Vec<i64>, Response> {
    sqlx::query_scalar("SELECT user_id FROM faction_members WHERE faction_id = ? AND user_id != ?")
        .bind(faction_id)
        .bind(exclude_user_id)
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| api_internal_err("勢力メンバーUID一覧取得失敗", e))
}

/// トランザクション内で指定勢力のメンバー管理権限保持者（勢力主・副主・can_manage_members）UID一覧を取得する
#[allow(clippy::result_large_err)]
async fn collect_faction_manager_uids_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    faction_id: i64,
    season_id: i64,
) -> Result<Vec<i64>, Response> {
    sqlx::query_scalar(
        r#"
        SELECT fm.user_id
        FROM faction_members fm
        JOIN factions f ON f.id = fm.faction_id
        WHERE fm.faction_id = ? AND f.season_id = ?
          AND (f.leader_user_id = fm.user_id OR fm.is_vice_leader != 0 OR fm.can_manage_members != 0)
        "#,
    )
    .bind(faction_id)
    .bind(season_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| api_internal_err("通知先管理者取得失敗", e))
}

/// トランザクション内で2つの勢力に所属するメンバーUID一覧（重複なし）を取得する
#[allow(clippy::result_large_err)]
async fn collect_two_factions_member_uids_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    fid_a: i64,
    fid_b: i64,
) -> Result<Vec<i64>, Response> {
    sqlx::query_scalar("SELECT DISTINCT user_id FROM faction_members WHERE faction_id IN (?, ?)")
        .bind(fid_a)
        .bind(fid_b)
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| api_internal_err("両勢力メンバーUID一覧取得失敗", e))
}

/// トランザクション内で2つの勢力名ペアを取得する（見つからない場合はフォールバック名）
#[allow(clippy::result_large_err)]
async fn collect_faction_names_pair_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    season_id: i64,
    fid_a: i64,
    fid_b: i64,
) -> Result<(String, String), Response> {
    let rows = sqlx::query("SELECT id, name FROM factions WHERE season_id = ? AND id IN (?, ?)")
        .bind(season_id)
        .bind(fid_a)
        .bind(fid_b)
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| api_internal_err("勢力名ペア取得失敗", e))?;
    let name_a = rows
        .iter()
        .find(|r| r.get::<i64, _>("id") == fid_a)
        .map(|r| r.get::<String, _>("name"))
        .unwrap_or_else(|| format!("勢力#{}", fid_a));
    let name_b = rows
        .iter()
        .find(|r| r.get::<i64, _>("id") == fid_b)
        .map(|r| r.get::<String, _>("name"))
        .unwrap_or_else(|| format!("勢力#{}", fid_b));
    Ok((name_a, name_b))
}

/// トランザクション内で無人化した勢力の参加申請を削除し、影響を受けたユーザーID一覧を返す
#[allow(clippy::result_large_err)]
async fn cleanup_empty_faction_pending_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    faction_id: i64,
) -> Result<Vec<i64>, Response> {
    let cleared_uids: Vec<i64> =
        sqlx::query_scalar("SELECT user_id FROM faction_join_requests WHERE faction_id = ?")
            .bind(faction_id)
            .fetch_all(&mut **tx)
            .await
            .map_err(|e| api_internal_err("無人勢力参加申請取得失敗", e))?;

    sqlx::query("DELETE FROM faction_join_requests WHERE faction_id = ?")
        .bind(faction_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| api_internal_err("勢力参加申請クリーンアップ失敗", e))?;

    Ok(cleared_uids)
}

/// トランザクション内で対象ユーザーの未処理参加申請を受け取っている現シーズン勢力（exclude_faction_id を除く）の管理者 UID 一覧を収集する
#[allow(clippy::result_large_err)]
async fn collect_join_request_managers_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    user_id: i64,
    season_id: i64,
    exclude_faction_id: Option<i64>,
) -> Result<Vec<i64>, Response> {
    let uids: Vec<i64> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT fm.user_id
        FROM faction_join_requests jr
        JOIN factions f ON f.id = jr.faction_id
        JOIN faction_members fm ON fm.faction_id = f.id
        WHERE jr.user_id = ?
          AND f.season_id = ?
          AND (? IS NULL OR f.id != ?)
          AND (f.leader_user_id = fm.user_id OR fm.is_vice_leader != 0 OR fm.can_manage_members != 0)
        "#,
    )
    .bind(user_id)
    .bind(season_id)
    .bind(exclude_faction_id)
    .bind(exclude_faction_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| api_internal_err("参加申請削除通知先取得失敗", e))?;
    Ok(uids)
}

/// トランザクション内でユーザーを指定勢力へ移動し、(他勢力の削除対象申請管理者ID一覧, リーダー自動昇格有無) を返す
#[allow(clippy::result_large_err)]
async fn move_user_to_faction_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    uid: i64,
    faction_id: i64,
    target_leader_id: i64,
    season_id: i64,
    now: &str,
) -> Result<(Vec<i64>, bool), Response> {
    let prev_fid_raw: i64 = match sqlx::query("SELECT faction_id FROM users WHERE id = ?")
        .bind(uid)
        .fetch_optional(&mut **tx)
        .await
    {
        Ok(Some(r)) => r.get("faction_id"),
        Ok(None) => return Err(api_err(StatusCode::UNAUTHORIZED, "ユーザーが見つかりません")),
        Err(e) => return Err(api_internal_err("ユーザー所属確認失敗", e)),
    };

    if prev_fid_raw == faction_id {
        return Err(api_err(StatusCode::BAD_REQUEST, "既にこの勢力に所属しています"));
    }

    if prev_fid_raw > 0 {
        let in_active_faction = match sqlx::query(
            "SELECT 1 FROM factions WHERE id = ? AND season_id = ?",
        )
        .bind(prev_fid_raw)
        .bind(season_id)
        .fetch_optional(&mut **tx)
        .await
        {
            Ok(opt) => opt.is_some(),
            Err(e) => return Err(api_internal_err("既存所属勢力確認失敗", e)),
        };
        if in_active_faction {
            return Err(api_err(
                StatusCode::CONFLICT,
                "既に別の勢力に所属しています。先に脱退してください",
            ));
        }
    }

    if let Err(e) = sqlx::query(
        "DELETE FROM faction_members WHERE user_id = ? AND faction_id IN (SELECT id FROM factions WHERE season_id = ?)",
    )
    .bind(uid)
    .bind(season_id)
    .execute(&mut **tx)
    .await
    {
        return Err(api_internal_err("旧所属削除失敗", e));
    }

    let promoted_to_leader = if target_leader_id == 0 {
        match sqlx::query(
            "UPDATE factions SET leader_user_id = ? WHERE id = ? AND leader_user_id = 0",
        )
        .bind(uid)
        .bind(faction_id)
        .execute(&mut **tx)
        .await
        {
            Ok(r) => r.rows_affected() == 1,
            Err(e) => return Err(api_internal_err("勢力リーダー昇格失敗", e)),
        }
    } else {
        false
    };

    let perm = if promoted_to_leader { 1i64 } else { 0i64 };
    if let Err(e) = sqlx::query(
        r#"
        INSERT OR REPLACE INTO faction_members
        (faction_id, user_id, is_vice_leader, can_declare_war, can_ceasefire, can_manage_members, joined_at)
        VALUES (?, ?, 0, ?, ?, ?, ?)
        "#,
    )
    .bind(faction_id)
    .bind(uid)
    .bind(perm)
    .bind(perm)
    .bind(perm)
    .bind(now)
    .execute(&mut **tx)
    .await
    {
        return Err(api_internal_err("勢力メンバー登録失敗", e));
    }

    if let Err(e) = sqlx::query("UPDATE users SET faction_id = ? WHERE id = ?")
        .bind(faction_id)
        .bind(uid)
        .execute(&mut **tx)
        .await
    {
        return Err(api_internal_err("ユーザー勢力更新失敗", e));
    }

    let cleared_managers =
        collect_join_request_managers_tx(tx, uid, season_id, Some(faction_id)).await?;

    if let Err(e) = sqlx::query(
        "DELETE FROM faction_join_requests WHERE user_id = ? AND faction_id IN (SELECT id FROM factions WHERE season_id = ?)",
    )
    .bind(uid)
    .bind(season_id)
    .execute(&mut **tx)
    .await
    {
        return Err(api_internal_err("参加申請削除失敗", e));
    }

    Ok((cleared_managers, promoted_to_leader))
}

/// 参加許可制勢力へ参加申請を送信する
pub async fn request_join_faction(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(faction_id): Path<i64>,
) -> Response {
    let uid = match authenticate_user_with_rate_limit(&state, addr, &headers).await {
        Ok(id) => id,
        Err(r) => return r,
    };
    let _action_guard = state.action_mutex.lock().await;
    if state.current_phase() == SeasonPhase::Frozen {
        return api_err(StatusCode::FORBIDDEN, "凍結フェーズ中は申請できません");
    }

    let season_id = state.current_season_id();
    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("参加申請TX開始失敗", e),
    };

    let user_row = match sqlx::query("SELECT username, faction_id FROM users WHERE id = ?")
        .bind(uid)
        .fetch_optional(&mut *tx)
        .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::UNAUTHORIZED, "認証エラー"),
        Err(e) => return api_internal_err("ユーザー情報取得失敗", e),
    };
    let username: String = user_row.get("username");
    let user_faction_id: i64 = user_row.get("faction_id");
    if user_faction_id > 0 {
        let in_active_faction = match sqlx::query(
            "SELECT 1 FROM factions WHERE id = ? AND season_id = ?",
        )
        .bind(user_faction_id)
        .bind(season_id)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(opt) => opt.is_some(),
            Err(e) => return api_internal_err("所属勢力確認失敗", e),
        };
        if in_active_faction {
            if user_faction_id == faction_id {
                return api_err(StatusCode::BAD_REQUEST, "既にこの勢力に所属しています");
            }
            return api_err(
                StatusCode::BAD_REQUEST,
                "既に別の勢力に所属しています。先に脱退してから申請してください",
            );
        }
    }

    let frow = match sqlx::query(
        "SELECT name, join_policy FROM factions WHERE id = ? AND season_id = ?",
    )
    .bind(faction_id)
    .bind(season_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::NOT_FOUND, "勢力が見つかりません"),
        Err(e) => return api_internal_err("勢力情報取得失敗", e),
    };
    let join_policy: i64 = frow.get("join_policy");
    let faction_name: String = frow.get("name");
    if join_policy != 1 {
        return api_err(StatusCode::BAD_REQUEST, "この勢力は自由参加のため直接参加できます");
    }

    let now = Utc::now().to_rfc3339();
    let insert_res = match sqlx::query(
        "INSERT OR IGNORE INTO faction_join_requests (faction_id, user_id, created_at) VALUES (?, ?, ?)",
    )
    .bind(faction_id)
    .bind(uid)
    .bind(&now)
    .execute(&mut *tx)
    .await
    {
        Ok(r) => r,
        Err(e) => return api_internal_err("参加申請登録失敗", e),
    };
    if insert_res.rows_affected() == 0 {
        return api_err(StatusCode::CONFLICT, "既に参加申請を送信済みです");
    }

    // 対象勢力のメンバー管理権限保持者のみに通知を配信する
    let manager_uids = match collect_faction_manager_uids_tx(&mut tx, faction_id, season_id).await
    {
        Ok(uids) => uids,
        Err(r) => return r,
    };

    record_player_log_tx_with_visibility(
        &mut tx,
        season_id,
        uid,
        &username,
        faction_id,
        "faction",
        &format!("勢力「{}」へ参加申請を送信した", faction_name),
        LOG_VISIBILITY_FACTION,
    )
    .await;

    if let Err(e) = tx.commit().await {
        return api_internal_err("参加申請TXコミット失敗", e);
    }

    let event = serde_json::json!({
        "type": "faction_join_request_created",
        "faction_id": faction_id,
        "faction_name": faction_name,
        "user_id": uid,
        "username": username,
    });
    state.send_event_to_users(&manager_uids, encode_event_json(&event.to_string()));

    Json(serde_json::json!({ "ok": true })).into_response()
}

/// 参加申請を承認して申請者を自勢力へ加入させる
pub async fn accept_join_request(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((faction_id, req_id)): Path<(i64, i64)>,
) -> Response {
    let uid = match authenticate_user_with_rate_limit(&state, addr, &headers).await {
        Ok(id) => id,
        Err(r) => return r,
    };
    let _action_guard = state.action_mutex.lock().await;
    if state.current_phase() == SeasonPhase::Frozen {
        return api_err(StatusCode::FORBIDDEN, "凍結フェーズ中は承認できません");
    }

    let season_id = state.current_season_id();
    let now = Utc::now().to_rfc3339();
    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("参加承認TX開始失敗", e),
    };

    // トランザクション内で操作者の現シーズン所属・権限を再検証（TOCTOU 防止）
    let auth_row = match sqlx::query(
        r#"
        SELECT
            u.faction_id AS user_faction_id,
            f.leader_user_id,
            COALESCE(fm.is_vice_leader, 0) AS is_vice_leader,
            COALESCE(fm.can_manage_members, 0) AS can_manage_members
        FROM users u
        LEFT JOIN factions f ON f.id = ? AND f.season_id = ?
        LEFT JOIN faction_members fm ON fm.faction_id = f.id AND fm.user_id = u.id
        WHERE u.id = ?
        "#,
    )
    .bind(faction_id)
    .bind(season_id)
    .bind(uid)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::UNAUTHORIZED, "認証エラー"),
        Err(e) => return api_internal_err("権限確認失敗", e),
    };
    let op_fid: i64 = auth_row.get("user_faction_id");
    let leader_opt: Option<i64> = auth_row.try_get("leader_user_id").ok();
    let is_vice: i64 = auth_row.get("is_vice_leader");
    let can_manage: i64 = auth_row.get("can_manage_members");
    let is_leader = leader_opt == Some(uid);
    if op_fid != faction_id || leader_opt.is_none() || (!is_leader && is_vice == 0 && can_manage == 0) {
        return api_err(StatusCode::FORBIDDEN, "参加申請を承認する権限がありません");
    }

    let req_row = match sqlx::query(
        r#"
        SELECT
            jr.user_id,
            u.username,
            f.name,
            f.leader_user_id,
            EXISTS(
                SELECT 1 FROM factions cf
                WHERE cf.id = u.faction_id AND cf.season_id = ?
            ) AS already_in_faction
        FROM faction_join_requests jr
        JOIN users u ON u.id = jr.user_id
        JOIN factions f ON f.id = jr.faction_id
        WHERE jr.id = ? AND jr.faction_id = ? AND f.season_id = ?
        "#,
    )
    .bind(season_id)
    .bind(req_id)
    .bind(faction_id)
    .bind(season_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::NOT_FOUND, "参加申請が見つかりません"),
        Err(e) => return api_internal_err("参加申請取得失敗", e),
    };
    let target_uid: i64 = req_row.get("user_id");
    let target_username: String = req_row.get("username");
    let faction_name: String = req_row.get("name");
    let target_leader_id: i64 = req_row.get("leader_user_id");
    let already_in_faction: i64 = req_row.get("already_in_faction");

    // 申請者が既に別勢力に所属している場合は、古い申請を削除して強制引き抜きを防ぐ
    if already_in_faction != 0 {
        let manager_uids =
            match collect_faction_manager_uids_tx(&mut tx, faction_id, season_id).await {
                Ok(uids) => uids,
                Err(r) => return r,
            };
        if let Err(e) = sqlx::query("DELETE FROM faction_join_requests WHERE id = ?")
            .bind(req_id)
            .execute(&mut *tx)
            .await
        {
            return api_internal_err("重複参加申請削除失敗", e);
        }
        if let Err(e) = tx.commit().await {
            return api_internal_err("重複参加申請削除TXコミット失敗", e);
        }
        if !manager_uids.is_empty() {
            state.send_event_to_users(
                &manager_uids,
                encode_event_json(METADATA_RESYNC_EVENT_JSON),
            );
        }
        return api_err(
            StatusCode::CONFLICT,
            "対象ユーザーは既に別の勢力に所属しています",
        );
    }

    let (cleared_managers, _promoted_to_leader) = match move_user_to_faction_tx(
        &mut tx,
        target_uid,
        faction_id,
        target_leader_id,
        season_id,
        &now,
    )
    .await
    {
        Ok(res) => res,
        Err(resp) => return resp,
    };

    let mut recipient_uids =
        match collect_faction_manager_uids_tx(&mut tx, faction_id, season_id).await {
            Ok(uids) => uids,
            Err(r) => return r,
        };
    recipient_uids.push(target_uid);

    let other_member_uids: Vec<i64> =
        match collect_faction_member_uids_except_tx(&mut tx, faction_id, uid).await {
            Ok(uids) => uids.into_iter().filter(|&id| id != target_uid).collect(),
            Err(r) => return r,
        };

    let approver_name = match sqlx::query_scalar::<_, String>("SELECT username FROM users WHERE id = ?")
        .bind(uid)
        .fetch_optional(&mut *tx)
        .await
    {
        Ok(Some(name)) => name,
        Ok(None) => format!("ユーザー#{}", uid),
        Err(e) => return api_internal_err("承認者名取得失敗", e),
    };

    record_player_log_tx(
        &mut tx,
        season_id,
        target_uid,
        &target_username,
        faction_id,
        "faction",
        &format!("勢力「{}」に参加した（承認: {}）", faction_name, approver_name),
    )
    .await;

    if let Err(e) = tx.commit().await {
        return api_internal_err("参加承認TXコミット失敗", e);
    }

    if !cleared_managers.is_empty() {
        state.send_event_to_users(
            &cleared_managers,
            encode_event_json(METADATA_RESYNC_EVENT_JSON),
        );
    }

    let event = serde_json::json!({
        "type": "faction_join_request_resolved",
        "accepted": true,
        "faction_id": faction_id,
        "faction_name": faction_name,
        "user_id": target_uid,
        "username": target_username,
    });
    state.send_event_to_users(&recipient_uids, encode_event_json(&event.to_string()));
    // 承認者・加入本人以外の既存メンバーへ新メンバー参加を通知する
    if !other_member_uids.is_empty() {
        let join_event = serde_json::json!({
            "type": "faction_member_joined",
            "faction_id": faction_id,
            "faction_name": faction_name,
            "user_id": target_uid,
            "username": target_username,
        });
        state.send_event_to_users(&other_member_uids, encode_event_json(&join_event.to_string()));
    }
    // 非所属クライアントにも勢力メンバー数の変化を同期するため公開イベントをブロードキャストする
    state.invalidate_factions_cache();
    let public_event = serde_json::json!({
        "type": "faction_updated",
        "faction_id": faction_id,
    });
    state.broadcast_frame(encode_event_json(&public_event.to_string()));

    Json(serde_json::json!({ "ok": true })).into_response()
}

/// 参加申請を拒否する
pub async fn reject_join_request(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((faction_id, req_id)): Path<(i64, i64)>,
) -> Response {
    let uid = match authenticate_user_with_rate_limit(&state, addr, &headers).await {
        Ok(id) => id,
        Err(r) => return r,
    };
    let _action_guard = state.action_mutex.lock().await;
    if state.current_phase() == SeasonPhase::Frozen {
        return api_err(StatusCode::FORBIDDEN, "凍結フェーズ中は拒否できません");
    }

    let season_id = state.current_season_id();
    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("参加拒否TX開始失敗", e),
    };

    // トランザクション内で操作者の現シーズン所属・権限を再検証（TOCTOU 防止）
    let auth_row = match sqlx::query(
        r#"
        SELECT
            u.faction_id AS user_faction_id,
            f.leader_user_id,
            COALESCE(fm.is_vice_leader, 0) AS is_vice_leader,
            COALESCE(fm.can_manage_members, 0) AS can_manage_members
        FROM users u
        LEFT JOIN factions f ON f.id = ? AND f.season_id = ?
        LEFT JOIN faction_members fm ON fm.faction_id = f.id AND fm.user_id = u.id
        WHERE u.id = ?
        "#,
    )
    .bind(faction_id)
    .bind(season_id)
    .bind(uid)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::UNAUTHORIZED, "認証エラー"),
        Err(e) => return api_internal_err("権限確認失敗", e),
    };
    let op_fid: i64 = auth_row.get("user_faction_id");
    let leader_opt: Option<i64> = auth_row.try_get("leader_user_id").ok();
    let is_vice: i64 = auth_row.get("is_vice_leader");
    let can_manage: i64 = auth_row.get("can_manage_members");
    let is_leader = leader_opt == Some(uid);
    if op_fid != faction_id || leader_opt.is_none() || (!is_leader && is_vice == 0 && can_manage == 0) {
        return api_err(StatusCode::FORBIDDEN, "参加申請を拒否する権限がありません");
    }

    let req_row = match sqlx::query(
        r#"
        SELECT jr.user_id, u.username, f.name
        FROM faction_join_requests jr
        JOIN users u ON u.id = jr.user_id
        JOIN factions f ON f.id = jr.faction_id
        WHERE jr.id = ? AND jr.faction_id = ? AND f.season_id = ?
        "#,
    )
    .bind(req_id)
    .bind(faction_id)
    .bind(season_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::NOT_FOUND, "参加申請が見つかりません"),
        Err(e) => return api_internal_err("参加申請取得失敗", e),
    };
    let target_uid: i64 = req_row.get("user_id");
    let target_username: String = req_row.get("username");
    let faction_name: String = req_row.get("name");

    if let Err(e) = sqlx::query("DELETE FROM faction_join_requests WHERE id = ? AND faction_id = ?")
        .bind(req_id)
        .bind(faction_id)
        .execute(&mut *tx)
        .await
    {
        return api_internal_err("参加申請削除失敗", e);
    }

    let mut recipient_uids =
        match collect_faction_manager_uids_tx(&mut tx, faction_id, season_id).await {
            Ok(uids) => uids,
            Err(r) => return r,
        };
    recipient_uids.push(target_uid);

    let actor_name = match sqlx::query_scalar::<_, String>("SELECT username FROM users WHERE id = ?")
        .bind(uid)
        .fetch_optional(&mut *tx)
        .await
    {
        Ok(Some(name)) => name,
        Ok(None) => format!("ユーザー#{}", uid),
        Err(e) => return api_internal_err("拒否操作者名取得失敗", e),
    };
    record_player_log_tx_with_visibility(
        &mut tx,
        season_id,
        uid,
        &actor_name,
        faction_id,
        "faction",
        &format!("{} の参加申請を拒否した", target_username),
        LOG_VISIBILITY_FACTION,
    )
    .await;

    if let Err(e) = tx.commit().await {
        return api_internal_err("参加拒否TXコミット失敗", e);
    }

    let event = serde_json::json!({
        "type": "faction_join_request_resolved",
        "accepted": false,
        "faction_id": faction_id,
        "faction_name": faction_name,
        "user_id": target_uid,
        "username": target_username,
    });
    state.send_event_to_users(&recipient_uids, encode_event_json(&event.to_string()));

    Json(serde_json::json!({ "ok": true })).into_response()
}

pub async fn leave_faction(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(faction_id): Path<i64>,
) -> Response {
    let uid = match authenticate_user_with_rate_limit(&state, addr, &headers).await {
        Ok(id) => id,
        Err(r) => return r,
    };
    let _action_guard = state.action_mutex.lock().await;
    if state.current_phase() == SeasonPhase::Frozen {
        return api_err(StatusCode::FORBIDDEN, "凍結フェーズ中は脱退できません");
    }

    let season_id = state.current_season_id();
    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("勢力脱退TX開始失敗", e),
    };

    // 対象勢力が現在のシーズンに存在するか確認
    let faction_name: String =
        match sqlx::query_scalar("SELECT name FROM factions WHERE id = ? AND season_id = ?")
            .bind(faction_id)
            .bind(season_id)
            .fetch_optional(&mut *tx)
            .await
        {
            Ok(Some(name)) => name,
            Ok(None) => return api_err(StatusCode::NOT_FOUND, "勢力が見つかりません"),
            Err(e) => return api_internal_err("勢力確認失敗", e),
        };

    let del_res = match sqlx::query("DELETE FROM faction_members WHERE faction_id = ? AND user_id = ?")
        .bind(faction_id)
        .bind(uid)
        .execute(&mut *tx)
        .await
    {
        Ok(r) => r,
        Err(e) => return api_internal_err("勢力メンバー削除失敗", e),
    };
    let upd_res = match sqlx::query("UPDATE users SET faction_id = 0 WHERE id = ? AND faction_id = ?")
        .bind(uid)
        .bind(faction_id)
        .execute(&mut *tx)
        .await
    {
        Ok(r) => r,
        Err(e) => return api_internal_err("ユーザー勢力解除失敗", e),
    };
    if del_res.rows_affected() == 0 && upd_res.rows_affected() == 0 {
        return api_err(StatusCode::BAD_REQUEST, "この勢力に所属していません");
    }

    // リーダーが脱退した場合、残存メンバー（副リーダー優先）へリーダー権限を移譲（無人なら0）
    let next_uid: i64 = match sqlx::query(
        "SELECT user_id FROM faction_members WHERE faction_id = ? ORDER BY is_vice_leader DESC, joined_at ASC LIMIT 1",
    )
    .bind(faction_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(r)) => r.get("user_id"),
        Ok(None) => 0,
        Err(e) => return api_internal_err("次期リーダー検索失敗", e),
    };

    let transfer_res = match sqlx::query(
        "UPDATE factions SET leader_user_id = ?, join_policy = CASE WHEN ? = 0 THEN 0 ELSE join_policy END WHERE id = ? AND leader_user_id = ?",
    )
    .bind(next_uid)
    .bind(next_uid)
    .bind(faction_id)
    .bind(uid)
    .execute(&mut *tx)
    .await
    {
        Ok(r) => r,
        Err(e) => return api_internal_err("リーダー権限移譲失敗", e),
    };
    let mut cleared_uids = Vec::new();
    if transfer_res.rows_affected() == 1 && next_uid == 0 {
        cleared_uids = match cleanup_empty_faction_pending_tx(&mut tx, faction_id).await {
            Ok(uids) => uids,
            Err(resp) => return resp,
        };
    }
    let mut leader_transferred_to: Option<(i64, String)> = None;
    if transfer_res.rows_affected() == 1 && next_uid > 0 {
        if let Err(e) = sqlx::query(
            "UPDATE faction_members SET is_vice_leader = 0, can_declare_war = 1, can_ceasefire = 1, can_manage_members = 1 WHERE faction_id = ? AND user_id = ?",
        )
        .bind(faction_id)
        .bind(next_uid)
        .execute(&mut *tx)
        .await
        {
            return api_internal_err("新リーダー権限更新失敗", e);
        }
        let next_username = match sqlx::query_scalar::<_, String>("SELECT username FROM users WHERE id = ?")
            .bind(next_uid)
            .fetch_optional(&mut *tx)
            .await
        {
            Ok(Some(name)) => name,
            Ok(None) => format!("ユーザー#{}", next_uid),
            Err(e) => return api_internal_err("新リーダー名取得失敗", e),
        };
        leader_transferred_to = Some((next_uid, next_username));
    }

    let username: String = match sqlx::query_scalar("SELECT username FROM users WHERE id = ?")
        .bind(uid)
        .fetch_optional(&mut *tx)
        .await
    {
        Ok(Some(u)) => u,
        Ok(None) => return api_err(StatusCode::UNAUTHORIZED, "ユーザーが見つかりません"),
        Err(e) => return api_internal_err("ユーザー名取得失敗", e),
    };
    record_player_log_tx(
        &mut tx,
        season_id,
        uid,
        &username,
        faction_id,
        "faction",
        &format!("勢力「{}」から脱退した", faction_name),
    )
    .await;

    if let Some((new_leader_uid, ref new_leader_username)) = leader_transferred_to {
        record_player_log_tx(
            &mut tx,
            season_id,
            new_leader_uid,
            new_leader_username,
            faction_id,
            "faction",
            &format!("勢力「{}」の新リーダーに就任した", faction_name),
        )
        .await;
    }

    let recipient_uids = match collect_faction_member_uids_except_tx(&mut tx, faction_id, uid).await
    {
        Ok(uids) => uids,
        Err(resp) => return resp,
    };

    if let Err(e) = tx.commit().await {
        return api_internal_err("勢力脱退TXコミット失敗", e);
    }
    state.invalidate_factions_cache();

    if !cleared_uids.is_empty() {
        state.send_event_to_users(
            &cleared_uids,
            encode_event_json(METADATA_RESYNC_EVENT_JSON),
        );
    }

    if !recipient_uids.is_empty() {
        let leave_event = serde_json::json!({
            "type": "faction_member_left",
            "faction_id": faction_id,
            "faction_name": faction_name,
            "user_id": uid,
            "username": username,
        });
        state.send_event_to_users(&recipient_uids, encode_event_json(&leave_event.to_string()));

        if let Some((new_leader_uid, new_leader_username)) = leader_transferred_to {
            let transfer_event = serde_json::json!({
                "type": "faction_leader_transferred",
                "faction_id": faction_id,
                "faction_name": faction_name,
                "new_leader_user_id": new_leader_uid,
                "new_leader_username": new_leader_username,
            });
            state.send_event_to_users(&recipient_uids, encode_event_json(&transfer_event.to_string()));
        }
    }

    let event = serde_json::json!({
        "type": "faction_updated",
        "faction_id": faction_id,
    });
    state.broadcast_frame(encode_event_json(&event.to_string()));

    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
pub struct KickPayload {
    pub user_id: i64,
}

pub async fn kick_member(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(faction_id): Path<i64>,
    Json(payload): Json<KickPayload>,
) -> Response {
    let uid = match authenticate_user_with_rate_limit(&state, addr, &headers).await {
        Ok(id) => id,
        Err(r) => return r,
    };
    let _action_guard = state.action_mutex.lock().await;
    if state.current_phase() == SeasonPhase::Frozen {
        return api_err(StatusCode::FORBIDDEN, "凍結フェーズ中は追放できません");
    }

    if payload.user_id == uid {
        return api_err(StatusCode::BAD_REQUEST, "自分自身を追放することはできません");
    }

    let season_id = state.current_season_id();
    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("メンバー追放TX開始失敗", e),
    };

    // トランザクション内で操作者の所属・権限と勢力リーダーを再検証（TOCTOU 防止）
    let auth_row = match sqlx::query(
        r#"
        SELECT
            u.faction_id AS user_faction_id,
            f.name AS faction_name,
            f.leader_user_id,
            COALESCE(fm.is_vice_leader, 0) AS is_vice_leader,
            COALESCE(fm.can_manage_members, 0) AS can_manage_members
        FROM users u
        LEFT JOIN factions f ON f.id = ? AND f.season_id = ?
        LEFT JOIN faction_members fm ON fm.faction_id = f.id AND fm.user_id = u.id
        WHERE u.id = ?
        "#,
    )
    .bind(faction_id)
    .bind(season_id)
    .bind(uid)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::UNAUTHORIZED, "認証エラー"),
        Err(e) => return api_internal_err("権限確認失敗", e),
    };
    let op_fid: i64 = auth_row.get("user_faction_id");
    let Some(faction_name) = auth_row.try_get::<String, _>("faction_name").ok() else {
        return api_err(StatusCode::NOT_FOUND, "勢力が見つかりません");
    };
    let Some(leader_id) = auth_row.try_get::<i64, _>("leader_user_id").ok() else {
        return api_err(StatusCode::NOT_FOUND, "勢力が見つかりません");
    };
    let op_is_leader = leader_id == uid;
    let op_is_vice: i64 = auth_row.get("is_vice_leader");
    let op_can_manage: i64 = auth_row.get("can_manage_members");
    if op_fid != faction_id || (!op_is_leader && op_is_vice == 0 && op_can_manage == 0) {
        return api_err(StatusCode::FORBIDDEN, "メンバー管理（承認・追放）権限がありません");
    }

    // リーダーは追放不可
    if payload.user_id == leader_id {
        return api_err(StatusCode::FORBIDDEN, "勢力リーダーは追放できません");
    }

    // 対象が副主の場合は勢力主のみ追放可能
    let target_vice: i64 = match sqlx::query(
        "SELECT is_vice_leader FROM faction_members WHERE faction_id = ? AND user_id = ?",
    )
    .bind(faction_id)
    .bind(payload.user_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(r)) => r.get("is_vice_leader"),
        Ok(None) => return api_err(StatusCode::NOT_FOUND, "対象メンバーが見つかりません"),
        Err(e) => return api_internal_err("対象メンバー権限確認失敗", e),
    };
    if target_vice != 0 && !op_is_leader {
        return api_err(
            StatusCode::FORBIDDEN,
            "副主を追放できるのは勢力主のみです",
        );
    }

    if let Err(e) = sqlx::query("DELETE FROM faction_members WHERE faction_id = ? AND user_id = ?")
        .bind(faction_id)
        .bind(payload.user_id)
        .execute(&mut *tx)
        .await
    {
        return api_internal_err("メンバー削除失敗", e);
    }
    if let Err(e) = sqlx::query("UPDATE users SET faction_id = 0 WHERE id = ? AND faction_id = ?")
        .bind(payload.user_id)
        .bind(faction_id)
        .execute(&mut *tx)
        .await
    {
        return api_internal_err("ユーザー勢力解除失敗", e);
    }

    let target_username_opt = match sqlx::query_scalar::<_, String>(
        "SELECT username FROM users WHERE id = ?",
    )
    .bind(payload.user_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(u) => u,
        Err(e) => return api_internal_err("追放対象ユーザー名取得失敗", e),
    };
    let actor_username = match sqlx::query_scalar::<_, String>("SELECT username FROM users WHERE id = ?")
        .bind(uid)
        .fetch_optional(&mut *tx)
        .await
    {
        Ok(Some(name)) => name,
        Ok(None) => format!("ユーザー#{}", uid),
        Err(e) => return api_internal_err("追放操作者名取得失敗", e),
    };
    if let Some(ref target_username) = target_username_opt {
        record_player_log_tx(
            &mut tx,
            season_id,
            payload.user_id,
            target_username,
            faction_id,
            "faction",
            &format!(
                "勢力「{}」から追放された（実行: {}）",
                faction_name, actor_username
            ),
        )
        .await;
    }
    let target_username_str =
        target_username_opt.unwrap_or_else(|| format!("ユーザー#{}", payload.user_id));

    // 追放された本人と、操作者以外の残存メンバーへ通知する
    let mut recipient_uids = match collect_faction_member_uids_except_tx(&mut tx, faction_id, uid).await
    {
        Ok(uids) => uids,
        Err(resp) => return resp,
    };
    recipient_uids.push(payload.user_id);

    if let Err(e) = tx.commit().await {
        return api_internal_err("メンバー追放TXコミット失敗", e);
    }
    state.invalidate_factions_cache();

    let kick_event = serde_json::json!({
        "type": "faction_member_kicked",
        "faction_id": faction_id,
        "faction_name": faction_name,
        "user_id": payload.user_id,
        "username": target_username_str,
        "actor_user_id": uid,
    });
    state.send_event_to_users(&recipient_uids, encode_event_json(&kick_event.to_string()));

    let event = serde_json::json!({
        "type": "faction_updated",
        "faction_id": faction_id,
    });
    state.broadcast_frame(encode_event_json(&event.to_string()));

    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
pub struct UpdatePermissionsPayload {
    pub is_vice_leader: bool,
    pub can_declare_war: bool,
    pub can_ceasefire: bool,
    pub can_manage_members: bool,
}

pub async fn update_member_permissions(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((faction_id, target_uid)): Path<(i64, i64)>,
    Json(payload): Json<UpdatePermissionsPayload>,
) -> Response {
    let uid = match authenticate_user_with_rate_limit(&state, addr, &headers).await {
        Ok(id) => id,
        Err(r) => return r,
    };
    let _action_guard = state.action_mutex.lock().await;
    if state.current_phase() == SeasonPhase::Frozen {
        return api_err(StatusCode::FORBIDDEN, "凍結フェーズ中は権限を変更できません");
    }

    if target_uid == uid {
        return api_err(
            StatusCode::BAD_REQUEST,
            "自分自身の権限を変更することはできません",
        );
    }

    let season_id = state.current_season_id();
    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("権限更新TX開始失敗", e),
    };

    // トランザクション内で操作者の現シーズン所属・権限を再検証（TOCTOU 防止）
    let auth_row = match sqlx::query(
        r#"
        SELECT
            u.faction_id AS user_faction_id,
            f.name AS faction_name,
            f.leader_user_id,
            COALESCE(fm.is_vice_leader, 0) AS is_vice_leader
        FROM users u
        LEFT JOIN factions f ON f.id = ? AND f.season_id = ?
        LEFT JOIN faction_members fm ON fm.faction_id = f.id AND fm.user_id = u.id
        WHERE u.id = ?
        "#,
    )
    .bind(faction_id)
    .bind(season_id)
    .bind(uid)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::UNAUTHORIZED, "認証エラー"),
        Err(e) => return api_internal_err("権限確認失敗", e),
    };
    let op_fid: i64 = auth_row.get("user_faction_id");
    let Some(faction_name) = auth_row.try_get::<String, _>("faction_name").ok() else {
        return api_err(StatusCode::NOT_FOUND, "勢力が見つかりません");
    };
    let Some(leader_id) = auth_row.try_get::<i64, _>("leader_user_id").ok() else {
        return api_err(StatusCode::NOT_FOUND, "勢力が見つかりません");
    };
    let op_is_leader = leader_id == uid;
    let op_is_vice: i64 = auth_row.get("is_vice_leader");
    if op_fid != faction_id || (!op_is_leader && op_is_vice == 0) {
        return api_err(
            StatusCode::FORBIDDEN,
            "メンバー権限の変更には勢力主または副主権限が必要です",
        );
    }

    if target_uid == leader_id {
        return api_err(StatusCode::FORBIDDEN, "勢力主の権限は変更できません");
    }

    // 対象が現在副主、または副主へ任命する場合は勢力主のみ実行可能
    let target_row = match sqlx::query(
        "SELECT is_vice_leader, can_declare_war, can_ceasefire, can_manage_members FROM faction_members WHERE faction_id = ? AND user_id = ?",
    )
    .bind(faction_id)
    .bind(target_uid)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::NOT_FOUND, "対象メンバーが見つかりません"),
        Err(e) => return api_internal_err("対象メンバー権限確認失敗", e),
    };
    let old_vice = target_row.get::<i64, _>("is_vice_leader") != 0;
    let old_war = old_vice || target_row.get::<i64, _>("can_declare_war") != 0;
    let old_cf = old_vice || target_row.get::<i64, _>("can_ceasefire") != 0;
    let old_manage = old_vice || target_row.get::<i64, _>("can_manage_members") != 0;
    if (old_vice || payload.is_vice_leader) && !op_is_leader {
        return api_err(
            StatusCode::FORBIDDEN,
            "副主の任命・権限変更は勢力主のみ実行できます",
        );
    }

    let eff_vice = payload.is_vice_leader;
    let eff_war = eff_vice || payload.can_declare_war;
    let eff_cf = eff_vice || payload.can_ceasefire;
    let eff_manage = eff_vice || payload.can_manage_members;
    let perm_changed =
        eff_vice != old_vice || eff_war != old_war || eff_cf != old_cf || eff_manage != old_manage;

    let is_vice_val = if eff_vice { 1 } else { 0 };
    let upd_res = if op_is_leader {
        sqlx::query(
            r#"
            UPDATE faction_members
            SET is_vice_leader = ?, can_declare_war = ?, can_ceasefire = ?, can_manage_members = ?
            WHERE faction_id = ? AND user_id = ?
            "#,
        )
        .bind(is_vice_val)
        .bind(if eff_war { 1 } else { 0 })
        .bind(if eff_cf { 1 } else { 0 })
        .bind(if eff_manage { 1 } else { 0 })
        .bind(faction_id)
        .bind(target_uid)
        .execute(&mut *tx)
        .await
    } else {
        // 勢力主でない場合は WHERE 句でも副主保護条件を付与する
        sqlx::query(
            r#"
            UPDATE faction_members
            SET is_vice_leader = ?, can_declare_war = ?, can_ceasefire = ?, can_manage_members = ?
            WHERE faction_id = ? AND user_id = ? AND is_vice_leader = 0
            "#,
        )
        .bind(is_vice_val)
        .bind(if eff_war { 1 } else { 0 })
        .bind(if eff_cf { 1 } else { 0 })
        .bind(if eff_manage { 1 } else { 0 })
        .bind(faction_id)
        .bind(target_uid)
        .execute(&mut *tx)
        .await
    };

    match upd_res {
        Ok(r) if r.rows_affected() == 1 => {}
        Ok(_) => return api_err(StatusCode::FORBIDDEN, "対象メンバーの権限を変更できません"),
        Err(e) => return api_internal_err("メンバー権限更新失敗", e),
    }

    if perm_changed {
        let actor_name = match sqlx::query_scalar::<_, String>("SELECT username FROM users WHERE id = ?")
            .bind(uid)
            .fetch_optional(&mut *tx)
            .await
        {
            Ok(Some(name)) => name,
            Ok(None) => format!("ユーザー#{}", uid),
            Err(e) => return api_internal_err("権限操作者名取得失敗", e),
        };
        let target_name = match sqlx::query_scalar::<_, String>("SELECT username FROM users WHERE id = ?")
            .bind(target_uid)
            .fetch_optional(&mut *tx)
            .await
        {
            Ok(Some(name)) => name,
            Ok(None) => format!("ユーザー#{}", target_uid),
            Err(e) => return api_internal_err("権限対象者名取得失敗", e),
        };
        let mut perms_list = Vec::new();
        if eff_vice {
            perms_list.push("副主");
        }
        if eff_war {
            perms_list.push("開戦");
        }
        if eff_cf {
            perms_list.push("停戦");
        }
        if eff_manage {
            perms_list.push("メンバー管理");
        }
        let perm_desc = if perms_list.is_empty() {
            "権限なし".to_string()
        } else {
            perms_list.join("・")
        };
        record_player_log_tx_with_visibility(
            &mut tx,
            season_id,
            uid,
            &actor_name,
            faction_id,
            "faction",
            &format!("{} の権限を変更した（{}）", target_name, perm_desc),
            LOG_VISIBILITY_FACTION,
        )
        .await;
    }

    if let Err(e) = tx.commit().await {
        return api_internal_err("権限更新TXコミット失敗", e);
    }

    if perm_changed {
        let perm_event = serde_json::json!({
            "type": "faction_permissions_updated",
            "faction_id": faction_id,
            "faction_name": faction_name,
            "user_id": target_uid,
            "is_vice_leader": eff_vice,
            "can_declare_war": eff_war,
            "can_ceasefire": eff_cf,
            "can_manage_members": eff_manage,
            "bulk": false,
        });
        state.send_event_to_user(target_uid, encode_event_json(&perm_event.to_string()));

        let event = serde_json::json!({
            "type": "faction_updated",
            "faction_id": faction_id,
        });
        state.broadcast_frame(encode_event_json(&event.to_string()));
    }

    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
pub struct BulkPermissionsPayload {
    pub can_declare_war: bool,
    pub can_ceasefire: bool,
    pub can_manage_members: bool,
}

pub async fn bulk_update_member_permissions(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(faction_id): Path<i64>,
    Json(payload): Json<BulkPermissionsPayload>,
) -> Response {
    let uid = match authenticate_user_with_rate_limit(&state, addr, &headers).await {
        Ok(id) => id,
        Err(r) => return r,
    };
    let _action_guard = state.action_mutex.lock().await;
    if state.current_phase() == SeasonPhase::Frozen {
        return api_err(StatusCode::FORBIDDEN, "凍結フェーズ中は権限を変更できません");
    }

    let season_id = state.current_season_id();
    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("一括権限更新TX開始失敗", e),
    };

    // トランザクション内で操作者の現シーズン所属・権限を再検証（TOCTOU 防止）
    let auth_row = match sqlx::query(
        r#"
        SELECT
            u.faction_id AS user_faction_id,
            f.name AS faction_name,
            f.leader_user_id,
            COALESCE(fm.is_vice_leader, 0) AS is_vice_leader
        FROM users u
        LEFT JOIN factions f ON f.id = ? AND f.season_id = ?
        LEFT JOIN faction_members fm ON fm.faction_id = f.id AND fm.user_id = u.id
        WHERE u.id = ?
        "#,
    )
    .bind(faction_id)
    .bind(season_id)
    .bind(uid)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::UNAUTHORIZED, "認証エラー"),
        Err(e) => return api_internal_err("権限確認失敗", e),
    };
    let op_fid: i64 = auth_row.get("user_faction_id");
    let Some(faction_name) = auth_row.try_get::<String, _>("faction_name").ok() else {
        return api_err(StatusCode::NOT_FOUND, "勢力が見つかりません");
    };
    let Some(leader_id) = auth_row.try_get::<i64, _>("leader_user_id").ok() else {
        return api_err(StatusCode::NOT_FOUND, "勢力が見つかりません");
    };
    let op_is_leader = leader_id == uid;
    let op_is_vice: i64 = auth_row.get("is_vice_leader");
    if op_fid != faction_id || (!op_is_leader && op_is_vice == 0) {
        return api_err(
            StatusCode::FORBIDDEN,
            "メンバー権限の一括変更には勢力主または副主権限が必要です",
        );
    }

    // 権限が実際に変化するメンバー（勢力主・副主・操作者自身を除く）を取得する
    let new_war = if payload.can_declare_war { 1i64 } else { 0 };
    let new_cf = if payload.can_ceasefire { 1i64 } else { 0 };
    let new_manage = if payload.can_manage_members { 1i64 } else { 0 };
    let affected_uids: Vec<i64> = match sqlx::query_scalar(
        r#"
        SELECT user_id
        FROM faction_members
        WHERE faction_id = ?
          AND user_id != ?
          AND is_vice_leader = 0
          AND user_id != ?
          AND (can_declare_war != ? OR can_ceasefire != ? OR can_manage_members != ?)
        "#,
    )
    .bind(faction_id)
    .bind(leader_id)
    .bind(uid)
    .bind(new_war)
    .bind(new_cf)
    .bind(new_manage)
    .fetch_all(&mut *tx)
    .await
    {
        Ok(uids) => uids,
        Err(e) => return api_internal_err("一括権限更新対象取得失敗", e),
    };

    if let Err(e) = sqlx::query(
        r#"
        UPDATE faction_members
        SET can_declare_war = ?, can_ceasefire = ?, can_manage_members = ?
        WHERE faction_id = ? AND user_id != ? AND is_vice_leader = 0
        "#,
    )
    .bind(new_war)
    .bind(new_cf)
    .bind(new_manage)
    .bind(faction_id)
    .bind(leader_id)
    .execute(&mut *tx)
    .await
    {
        return api_internal_err("メンバー権限一括更新失敗", e);
    }

    if !affected_uids.is_empty() {
        let actor_name = match sqlx::query_scalar::<_, String>("SELECT username FROM users WHERE id = ?")
            .bind(uid)
            .fetch_optional(&mut *tx)
            .await
        {
            Ok(Some(name)) => name,
            Ok(None) => format!("ユーザー#{}", uid),
            Err(e) => return api_internal_err("一括権限操作者名取得失敗", e),
        };
        let mut perms_list = Vec::new();
        if payload.can_declare_war {
            perms_list.push("開戦");
        }
        if payload.can_ceasefire {
            perms_list.push("停戦");
        }
        if payload.can_manage_members {
            perms_list.push("メンバー管理");
        }
        let perm_desc = if perms_list.is_empty() {
            "権限なし".to_string()
        } else {
            perms_list.join("・")
        };
        record_player_log_tx_with_visibility(
            &mut tx,
            season_id,
            uid,
            &actor_name,
            faction_id,
            "faction",
            &format!(
                "一般メンバー {} 人の権限を一括変更した（{}）",
                affected_uids.len(),
                perm_desc
            ),
            LOG_VISIBILITY_FACTION,
        )
        .await;
    }

    if let Err(e) = tx.commit().await {
        return api_internal_err("一括権限更新TXコミット失敗", e);
    }

    if !affected_uids.is_empty() {
        let perm_event = serde_json::json!({
            "type": "faction_permissions_updated",
            "faction_id": faction_id,
            "faction_name": faction_name,
            "user_id": 0,
            "is_vice_leader": false,
            "can_declare_war": payload.can_declare_war,
            "can_ceasefire": payload.can_ceasefire,
            "can_manage_members": payload.can_manage_members,
            "bulk": true,
        });
        state.send_event_to_users(&affected_uids, encode_event_json(&perm_event.to_string()));

        let event = serde_json::json!({
            "type": "faction_updated",
            "faction_id": faction_id,
        });
        state.broadcast_frame(encode_event_json(&event.to_string()));
    }

    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
pub struct FactionSettingsPayload {
    pub allow_auto_paint: bool,
    pub join_policy: Option<i64>,
    pub color_id: Option<i64>,
}

pub async fn update_faction_settings(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(faction_id): Path<i64>,
    Json(payload): Json<FactionSettingsPayload>,
) -> Response {
    const FACTION_COLOR_COOLDOWN_SECS: u64 = 60;
    const MAX_COLOR_DIFF_BROADCAST: usize = 50_000;

    let uid = match authenticate_user_with_rate_limit(&state, addr, &headers).await {
        Ok(id) => id,
        Err(r) => return r,
    };
    if let Some(cid) = payload.color_id {
        if !(0..64).contains(&cid) {
            return api_err(StatusCode::BAD_REQUEST, "勢力カラーIDは 0..63 で指定してください");
        }
    }
    if let Some(p) = payload.join_policy {
        if p != 0 && p != 1 {
            return api_err(
                StatusCode::BAD_REQUEST,
                "参加方針は 0（自由参加）または 1（参加許可制）で指定してください",
            );
        }
    }

    let _action_guard = state.action_mutex.lock().await;
    if state.current_phase() == SeasonPhase::Frozen {
        return api_err(StatusCode::FORBIDDEN, "凍結フェーズ中は勢力設定を変更できません");
    }

    let season_id = state.current_season_id();
    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("勢力設定更新TX開始失敗", e),
    };

    // トランザクション内で操作者の現シーズン所属・権限・現在カラー・参加方式を再検証（TOCTOU 防止）
    let auth_row = match sqlx::query(
        r#"
        SELECT
            u.faction_id AS user_faction_id,
            f.name AS faction_name,
            f.leader_user_id,
            f.color_id,
            f.join_policy,
            f.allow_auto_paint,
            COALESCE(fm.is_vice_leader, 0) AS is_vice_leader
        FROM users u
        LEFT JOIN factions f ON f.id = ? AND f.season_id = ?
        LEFT JOIN faction_members fm ON fm.faction_id = f.id AND fm.user_id = u.id
        WHERE u.id = ?
        "#,
    )
    .bind(faction_id)
    .bind(season_id)
    .bind(uid)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::UNAUTHORIZED, "認証エラー"),
        Err(e) => return api_internal_err("権限確認失敗", e),
    };
    let op_fid: i64 = auth_row.get("user_faction_id");
    let Some(faction_name) = auth_row.try_get::<String, _>("faction_name").ok() else {
        return api_err(StatusCode::NOT_FOUND, "勢力が見つかりません");
    };
    let Some(leader_id) = auth_row.try_get::<i64, _>("leader_user_id").ok() else {
        return api_err(StatusCode::NOT_FOUND, "勢力が見つかりません");
    };
    let old_cid: i64 = auth_row.get("color_id");
    let old_join_policy: i64 = auth_row.get("join_policy");
    let old_allow_auto_paint = auth_row.get::<i64, _>("allow_auto_paint") != 0;
    let op_is_leader = leader_id == uid;
    let op_is_vice: i64 = auth_row.get("is_vice_leader");
    if op_fid != faction_id || (!op_is_leader && op_is_vice == 0) {
        return api_err(
            StatusCode::FORBIDDEN,
            "勢力設定の変更には勢力主または副主権限が必要です",
        );
    }

    let color_changed = payload.color_id.is_some_and(|cid| cid != old_cid);
    if let Some(cid) = payload.color_id {
        if color_changed {
            // 勢力単位のカラー変更クールダウン（60秒）を検証
            if let Some(last_at) = state.faction_color_cooldown.get(&faction_id) {
                let elapsed = last_at.elapsed();
                if elapsed < std::time::Duration::from_secs(FACTION_COLOR_COOLDOWN_SECS) {
                    let remain = FACTION_COLOR_COOLDOWN_SECS.saturating_sub(elapsed.as_secs());
                    return api_err(
                        StatusCode::TOO_MANY_REQUESTS,
                        format!(
                            "勢力カラーの変更は60秒に1回までです（残り約{}秒）",
                            remain.max(1)
                        ),
                    );
                }
            }
        }

        let dup = match sqlx::query(
            "SELECT 1 FROM factions WHERE season_id = ? AND color_id = ? AND id != ?",
        )
        .bind(season_id)
        .bind(cid)
        .bind(faction_id)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(opt) => opt.is_some(),
            Err(e) => return api_internal_err("勢力カラー重複確認失敗", e),
        };
        if dup {
            return api_err(
                StatusCode::CONFLICT,
                "そのカラーは既に他の勢力で使用されています",
            );
        }
    }

    let join_policy = payload.join_policy;
    let join_policy_changed = join_policy.is_some_and(|p| p != old_join_policy);
    let allow_auto_paint_changed = payload.allow_auto_paint != old_allow_auto_paint;
    if let Err(e) = sqlx::query(
        "UPDATE factions SET allow_auto_paint = ?, join_policy = COALESCE(?, join_policy), color_id = COALESCE(?, color_id) WHERE id = ? AND season_id = ?",
    )
    .bind(if payload.allow_auto_paint { 1 } else { 0 })
    .bind(join_policy)
    .bind(payload.color_id)
    .bind(faction_id)
    .bind(season_id)
    .execute(&mut *tx)
    .await
    {
        if e.to_string().contains("UNIQUE") {
            return api_err(
                StatusCode::CONFLICT,
                "そのカラーは既に他の勢力で使用されています",
            );
        }
        return api_internal_err("勢力設定更新失敗", e);
    }

    let cleared_applicant_uids: Vec<i64> = if join_policy == Some(0) {
        let uids: Vec<i64> =
            match sqlx::query_scalar("SELECT user_id FROM faction_join_requests WHERE faction_id = ?")
                .bind(faction_id)
                .fetch_all(&mut *tx)
                .await
            {
                Ok(rows) => rows,
                Err(e) => return api_internal_err("削除対象参加申請取得失敗", e),
            };
        if let Err(e) = sqlx::query("DELETE FROM faction_join_requests WHERE faction_id = ?")
            .bind(faction_id)
            .execute(&mut *tx)
            .await
        {
            return api_internal_err("参加申請クリーンアップ失敗", e);
        }
        uids
    } else {
        Vec::new()
    };

    // 設定に実質的な変更がある場合のみ、操作者以外のメンバー一覧を通知先として取得し、行動ログを記録する
    let any_changed = allow_auto_paint_changed || join_policy_changed || color_changed;
    let settings_notify_uids = if any_changed {
        let actor_name = match sqlx::query_scalar::<_, String>("SELECT username FROM users WHERE id = ?")
            .bind(uid)
            .fetch_optional(&mut *tx)
            .await
        {
            Ok(Some(name)) => name,
            Ok(None) => format!("ユーザー#{}", uid),
            Err(e) => return api_internal_err("設定操作者名取得失敗", e),
        };
        if color_changed || join_policy_changed {
            let mut public_changes = Vec::new();
            if color_changed {
                public_changes.push("代表色を変更");
            }
            if join_policy_changed {
                if join_policy == Some(1) {
                    public_changes.push("参加方針を「参加許可制」に変更");
                } else {
                    public_changes.push("参加方針を「自由参加」に変更");
                }
            }
            record_player_log_tx_with_visibility(
                &mut tx,
                season_id,
                uid,
                &actor_name,
                faction_id,
                "faction",
                &format!("勢力「{}」の{}", faction_name, public_changes.join("・")),
                LOG_VISIBILITY_PUBLIC,
            )
            .await;
        }
        if allow_auto_paint_changed {
            record_player_log_tx_with_visibility(
                &mut tx,
                season_id,
                uid,
                &actor_name,
                faction_id,
                "faction",
                &format!(
                    "自動塗り許可を{}に変更した",
                    if payload.allow_auto_paint { "ON" } else { "OFF" }
                ),
                LOG_VISIBILITY_FACTION,
            )
            .await;
        }
        match collect_faction_member_uids_except_tx(&mut tx, faction_id, uid).await {
            Ok(uids) => uids,
            Err(resp) => return resp,
        }
    } else {
        Vec::new()
    };

    if let Err(e) = tx.commit().await {
        return api_internal_err("勢力設定更新TXコミット失敗", e);
    }
    if any_changed {
        state.invalidate_factions_cache();
    }

    if !settings_notify_uids.is_empty() {
        let settings_ev = serde_json::json!({
            "type": "faction_settings_updated",
            "faction_id": faction_id,
            "faction_name": faction_name,
            "allow_auto_paint_changed": allow_auto_paint_changed,
            "allow_auto_paint": payload.allow_auto_paint,
            "join_policy_changed": join_policy_changed,
            "join_policy": join_policy.unwrap_or(old_join_policy),
            "color_changed": color_changed,
            "color_id": payload.color_id.unwrap_or(old_cid),
            "actor_user_id": uid,
        });
        state.send_event_to_users(
            &settings_notify_uids,
            encode_event_json(&settings_ev.to_string()),
        );
    }

    if !cleared_applicant_uids.is_empty() {
        state.send_event_to_users(
            &cleared_applicant_uids,
            encode_event_json(METADATA_RESYNC_EVENT_JSON),
        );
    }

    if let Some(cid) = payload.color_id.filter(|_| color_changed) {
        state
            .faction_color_cooldown
            .insert(faction_id, std::time::Instant::now());
        if let Ok(fid_u16) = u16::try_from(faction_id) {
            let old_u8 = old_cid.clamp(0, 63) as u8;
            let new_u8 = cid.clamp(0, 63) as u8;
            let mut diffs = Vec::new();
            let start_ver = {
                let mut board = state.board.write();
                let sz = board.size;
                for y in 0..sz {
                    for x in 0..sz {
                        let idx = board.idx(x, y);
                        let mut cell = board.cells[idx];
                        // 独自に色変更されていない（旧勢力色のままの）マスのみ新しい勢力色へ更新
                        if cell.faction_id == fid_u16 && cell.color_id == old_u8 {
                            cell.color_id = new_u8;
                            board.cells[idx] = cell;
                            board.mark_chunk_dirty(x, y);
                            diffs.push((x as u16, y as u16, cell));
                        }
                    }
                }
                if diffs.is_empty() {
                    None
                } else {
                    let chunk_count = if diffs.len() > MAX_COLOR_DIFF_BROADCAST {
                        1
                    } else {
                        diffs.chunks(4000).len().max(1) as u64
                    };
                    Some(state.bump_board_version_n(chunk_count).0)
                }
            };
            if let Some(start_ver) = start_ver {
                state.clear_snapshot_cache();
                // 変更セル数が上限を超える場合は大量差分ブロードキャストを避け、スナップショット再取得を促す
                if diffs.len() > MAX_COLOR_DIFF_BROADCAST {
                    state.broadcast_frame(encode_event_json(r#"{"type":"resync_required"}"#));
                } else {
                    for (i, chunk) in diffs.chunks(4000).enumerate() {
                        let ver = start_ver + i as u64;
                        state.broadcast_frame(encode_cell_diff_batch(ver, chunk));
                    }
                }
            }
        }

        let mut ev = serde_json::json!({
            "type": "faction_updated",
            "faction_id": faction_id,
            "color_id": cid,
        });
        if join_policy_changed {
            ev["join_policy"] = serde_json::json!(join_policy.unwrap_or(old_join_policy));
        }
        state.broadcast_frame(encode_event_json(&ev.to_string()));
        let _ = state.flush_dirty_chunks_locked().await;
    }

    if !color_changed && (join_policy_changed || allow_auto_paint_changed) {
        let ev = serde_json::json!({
            "type": "faction_updated",
            "faction_id": faction_id,
        });
        state.broadcast_frame(encode_event_json(&ev.to_string()));
    }

    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
pub struct AutoPaintConfigPayload {
    pub enabled: bool,
    pub pct: i64,
}

pub async fn update_auto_paint(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<AutoPaintConfigPayload>,
) -> Response {
    let uid = match authenticate_user_with_rate_limit(&state, addr, &headers).await {
        Ok(id) => id,
        Err(r) => return r,
    };
    let _action_guard = state.action_mutex.lock().await;
    if state.current_phase() == SeasonPhase::Frozen {
        return api_err(
            StatusCode::FORBIDDEN,
            "凍結フェーズ中は自動塗り設定を変更できません",
        );
    }

    let season_id = state.current_season_id();
    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("自動塗り設定TX開始失敗", e),
    };

    let row = match sqlx::query(
        r#"
        SELECT u.faction_id, f.id AS active_faction_id, f.allow_auto_paint
        FROM users u
        LEFT JOIN factions f ON f.id = u.faction_id AND f.season_id = ?
        WHERE u.id = ?
        "#,
    )
    .bind(season_id)
    .bind(uid)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::UNAUTHORIZED, "認証エラー"),
        Err(e) => return api_internal_err("自動塗り許可確認失敗", e),
    };

    let active_faction_id: Option<i64> = row.try_get("active_faction_id").ok();
    if payload.enabled && active_faction_id.is_some() {
        let allowed = row.get::<Option<i64>, _>("allow_auto_paint").unwrap_or(0) != 0;
        if !allowed {
            return api_err(
                StatusCode::FORBIDDEN,
                "所属勢力で自動塗り機能が許可されていません",
            );
        }
    }

    let pct = payload.pct.clamp(1, 100);
    if let Err(e) =
        sqlx::query("UPDATE users SET auto_paint_enabled = ?, auto_paint_pct = ? WHERE id = ?")
            .bind(if payload.enabled { 1 } else { 0 })
            .bind(pct)
            .bind(uid)
            .execute(&mut *tx)
            .await
    {
        return api_internal_err("自動塗り設定更新失敗", e);
    }

    if let Err(e) = tx.commit().await {
        return api_internal_err("自動塗り設定TXコミット失敗", e);
    }

    Json(serde_json::json!({
        "ok": true,
        "auto_paint_enabled": payload.enabled,
        "auto_paint_pct": pct,
    }))
    .into_response()
}

// ============================================================
// 外交（戦争・停戦提案・停戦承認）API
// ============================================================

pub async fn get_diplomacy(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_read_rate_limit(&state, &ip) {
        return r;
    }
    let season_id = state.current_season_id();
    let war_rows = match sqlx::query(
        "SELECT faction_a, faction_b, started_at FROM diplomacy_wars WHERE season_id = ?",
    )
    .bind(season_id)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => return api_internal_err("戦争状態一覧取得失敗", e),
    };

    let wars: Vec<_> = war_rows
        .into_iter()
        .map(|r| {
            serde_json::json!({
                "faction_a": r.get::<i64, _>("faction_a"),
                "faction_b": r.get::<i64, _>("faction_b"),
                "started_at": r.get::<String, _>("started_at"),
            })
        })
        .collect();

    let prop_rows = match sqlx::query(
        "SELECT id, from_faction_id, to_faction_id, created_at FROM ceasefire_proposals WHERE season_id = ?",
    )
    .bind(season_id)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => return api_internal_err("停戦提案一覧取得失敗", e),
    };

    let proposals: Vec<_> = prop_rows
        .into_iter()
        .map(|r| {
            serde_json::json!({
                "id": r.get::<i64, _>("id"),
                "from_faction_id": r.get::<i64, _>("from_faction_id"),
                "to_faction_id": r.get::<i64, _>("to_faction_id"),
                "created_at": r.get::<String, _>("created_at"),
            })
        })
        .collect();

    Json(serde_json::json!({
        "wars": wars,
        "ceasefire_proposals": proposals,
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct CeasefireProposePayload {
    pub target_faction_id: i64,
}

pub async fn propose_ceasefire(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<CeasefireProposePayload>,
) -> Response {
    let uid = match authenticate_user_with_rate_limit(&state, addr, &headers).await {
        Ok(id) => id,
        Err(r) => return r,
    };
    let target_fid = match validate_faction_id_u16(payload.target_faction_id) {
        Ok(id) => id,
        Err(r) => return r,
    };

    let _action_guard = state.action_mutex.lock().await;
    if state.current_phase() == SeasonPhase::Frozen {
        return api_err(StatusCode::FORBIDDEN, "凍結フェーズ中は外交操作できません");
    }

    let season_id = state.current_season_id();
    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("停戦提案TX開始失敗", e),
    };

    // トランザクション内で操作者の現シーズン所属・停戦権限を確認
    let auth_row = match sqlx::query(
        r#"
        SELECT
            u.username,
            u.faction_id AS user_faction_id,
            f.leader_user_id,
            COALESCE(fm.is_vice_leader, 0) AS is_vice_leader,
            COALESCE(fm.can_ceasefire, 0) AS can_ceasefire
        FROM users u
        LEFT JOIN factions f ON f.id = u.faction_id AND f.season_id = ?
        LEFT JOIN faction_members fm ON fm.faction_id = f.id AND fm.user_id = u.id
        WHERE u.id = ?
        "#,
    )
    .bind(season_id)
    .bind(uid)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::UNAUTHORIZED, "認証エラー"),
        Err(e) => return api_internal_err("権限確認失敗", e),
    };
    let username: String = auth_row.get("username");
    let op_fid: i64 = auth_row.get("user_faction_id");
    let leader_opt: Option<i64> = auth_row.try_get("leader_user_id").ok();
    let is_vice: i64 = auth_row.get("is_vice_leader");
    let can_ceasefire: i64 = auth_row.get("can_ceasefire");
    let is_leader = leader_opt == Some(uid);
    if op_fid <= 0 || leader_opt.is_none() || (!is_leader && is_vice == 0 && can_ceasefire == 0) {
        return api_err(StatusCode::FORBIDDEN, "停戦権限がありません");
    }

    let my_fid = match validate_faction_id_u16(op_fid) {
        Ok(id) => id,
        Err(r) => return r,
    };
    let (fa, fb) = war_pair(my_fid, target_fid);
    let at_war = match sqlx::query(
        "SELECT 1 FROM diplomacy_wars WHERE season_id = ? AND faction_a = ? AND faction_b = ?",
    )
    .bind(season_id)
    .bind(fa)
    .bind(fb)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(opt) => opt.is_some(),
        Err(e) => return api_internal_err("戦争状態確認失敗", e),
    };
    if !at_war {
        return api_err(StatusCode::BAD_REQUEST, "指定勢力とは戦争状態ではありません");
    }

    let now = Utc::now().to_rfc3339();
    let insert_res = match sqlx::query(
        r#"
        INSERT OR IGNORE INTO ceasefire_proposals
        (season_id, from_faction_id, to_faction_id, proposed_by, created_at)
        VALUES (?, ?, ?, ?, ?)
        "#,
    )
    .bind(season_id)
    .bind(op_fid)
    .bind(payload.target_faction_id)
    .bind(uid)
    .bind(&now)
    .execute(&mut *tx)
    .await
    {
        Ok(r) => r,
        Err(e) => return api_internal_err("停戦提案登録失敗", e),
    };
    if insert_res.rows_affected() == 0 {
        return api_err(StatusCode::CONFLICT, "既にこの勢力へ停戦を提案済みです");
    }

    let (from_faction_name, to_faction_name) =
        match collect_faction_names_pair_tx(&mut tx, season_id, op_fid, payload.target_faction_id)
            .await
        {
            Ok(names) => names,
            Err(resp) => return resp,
        };
    let party_uids =
        match collect_two_factions_member_uids_tx(&mut tx, op_fid, payload.target_faction_id).await
        {
            Ok(uids) => uids,
            Err(resp) => return resp,
        };

    record_player_log_tx_with_target(
        &mut tx,
        season_id,
        uid,
        &username,
        op_fid,
        payload.target_faction_id,
        "diplomacy",
        &format!("勢力「{}」へ停戦を提案した", to_faction_name),
    )
    .await;

    if let Err(e) = tx.commit().await {
        return api_internal_err("停戦提案TXコミット失敗", e);
    }

    if !party_uids.is_empty() {
        let event = serde_json::json!({
            "type": "ceasefire_proposed",
            "from_faction_id": op_fid,
            "to_faction_id": payload.target_faction_id,
            "from_faction_name": from_faction_name,
            "to_faction_name": to_faction_name,
            "actor_user_id": uid,
        });
        state.send_event_to_users(&party_uids, encode_event_json(&event.to_string()));
    }

    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
pub struct CeasefireRespondPayload {
    pub accept: bool,
}

pub async fn respond_ceasefire(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(proposal_id): Path<i64>,
    Json(payload): Json<CeasefireRespondPayload>,
) -> Response {
    let uid = match authenticate_user_with_rate_limit(&state, addr, &headers).await {
        Ok(id) => id,
        Err(r) => return r,
    };
    let _action_guard = state.action_mutex.lock().await;
    if state.current_phase() == SeasonPhase::Frozen {
        return api_err(StatusCode::FORBIDDEN, "凍結フェーズ中は外交操作できません");
    }

    let season_id = state.current_season_id();
    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("停戦応答TX開始失敗", e),
    };

    // トランザクション内で操作者の現シーズン所属・停戦権限を再検証（TOCTOU 防止）
    let auth_row = match sqlx::query(
        r#"
        SELECT
            u.username,
            u.faction_id AS user_faction_id,
            f.leader_user_id,
            COALESCE(fm.is_vice_leader, 0) AS is_vice_leader,
            COALESCE(fm.can_ceasefire, 0) AS can_ceasefire
        FROM users u
        LEFT JOIN factions f ON f.id = u.faction_id AND f.season_id = ?
        LEFT JOIN faction_members fm ON fm.faction_id = f.id AND fm.user_id = u.id
        WHERE u.id = ?
        "#,
    )
    .bind(season_id)
    .bind(uid)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::UNAUTHORIZED, "認証エラー"),
        Err(e) => return api_internal_err("権限確認失敗", e),
    };
    let username: String = auth_row.get("username");
    let op_fid: i64 = auth_row.get("user_faction_id");
    let leader_opt: Option<i64> = auth_row.try_get("leader_user_id").ok();
    let is_vice: i64 = auth_row.get("is_vice_leader");
    let can_ceasefire: i64 = auth_row.get("can_ceasefire");
    let is_leader = leader_opt == Some(uid);
    if op_fid <= 0 || leader_opt.is_none() || (!is_leader && is_vice == 0 && can_ceasefire == 0) {
        return api_err(StatusCode::FORBIDDEN, "停戦権限がありません");
    }

    let prop = match sqlx::query(
        "SELECT from_faction_id, to_faction_id FROM ceasefire_proposals WHERE id = ? AND season_id = ?",
    )
    .bind(proposal_id)
    .bind(season_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::NOT_FOUND, "停戦提案が見つかりません"),
        Err(e) => return api_internal_err("停戦提案取得失敗", e),
    };

    let from_fid: i64 = prop.get("from_faction_id");
    let to_fid: i64 = prop.get("to_faction_id");
    if to_fid != op_fid {
        return api_err(StatusCode::FORBIDDEN, "自勢力宛ての停戦提案ではありません");
    }

    match sqlx::query("DELETE FROM ceasefire_proposals WHERE id = ?")
        .bind(proposal_id)
        .execute(&mut *tx)
        .await
    {
        Ok(r) if r.rows_affected() == 1 => {}
        Ok(_) => return api_err(StatusCode::NOT_FOUND, "停戦提案が見つかりません"),
        Err(e) => return api_internal_err("停戦提案削除失敗", e),
    }

    let accepted_pair = if payload.accept {
        let from_u16 = match validate_faction_id_u16(from_fid) {
            Ok(id) => id,
            Err(r) => return r,
        };
        let to_u16 = match validate_faction_id_u16(to_fid) {
            Ok(id) => id,
            Err(r) => return r,
        };
        let (fa, fb) = war_pair(from_u16, to_u16);
        if let Err(e) = sqlx::query(
            "DELETE FROM diplomacy_wars WHERE season_id = ? AND faction_a = ? AND faction_b = ?",
        )
        .bind(season_id)
        .bind(fa)
        .bind(fb)
        .execute(&mut *tx)
        .await
        {
            return api_internal_err("戦争状態解除失敗", e);
        }

        if let Err(e) = sqlx::query(
            "DELETE FROM ceasefire_proposals WHERE season_id = ? AND from_faction_id = ? AND to_faction_id = ?",
        )
        .bind(season_id)
        .bind(to_fid)
        .bind(from_fid)
        .execute(&mut *tx)
        .await
        {
            return api_internal_err("逆方向停戦提案削除失敗", e);
        }

        Some((fa, fb))
    } else {
        None
    };

    let (from_faction_name, to_faction_name) =
        match collect_faction_names_pair_tx(&mut tx, season_id, from_fid, to_fid).await {
            Ok(names) => names,
            Err(resp) => return resp,
        };
    let reject_party_uids = if payload.accept {
        Vec::new()
    } else {
        match collect_two_factions_member_uids_tx(&mut tx, from_fid, to_fid).await {
            Ok(uids) => uids,
            Err(resp) => return resp,
        }
    };

    let cf_log_summary = if accepted_pair.is_some() {
        format!("勢力「{}」からの停戦提案を承認し停戦が成立した", from_faction_name)
    } else {
        format!("勢力「{}」からの停戦提案を却下した", from_faction_name)
    };
    record_player_log_tx_with_target(
        &mut tx,
        season_id,
        uid,
        &username,
        op_fid,
        from_fid,
        "diplomacy",
        &cf_log_summary,
    )
    .await;

    if let Err(e) = tx.commit().await {
        return api_internal_err("停戦応答TXコミット失敗", e);
    }

    if let Some((fa, fb)) = accepted_pair {
        let event = serde_json::json!({
            "type": "ceasefire_accepted",
            "faction_a": fa,
            "faction_b": fb,
            "from_faction_id": from_fid,
            "to_faction_id": to_fid,
            "from_faction_name": from_faction_name,
            "to_faction_name": to_faction_name,
        });
        state.broadcast_frame(encode_event_json(&event.to_string()));
    } else {
        if !reject_party_uids.is_empty() {
            let event = serde_json::json!({
                "type": "ceasefire_rejected",
                "from_faction_id": from_fid,
                "to_faction_id": to_fid,
                "from_faction_name": from_faction_name,
                "to_faction_name": to_faction_name,
                "actor_user_id": uid,
            });
            state.send_event_to_users(&reject_party_uids, encode_event_json(&event.to_string()));
        }
    }

    Json(serde_json::json!({ "ok": true, "accepted": payload.accept })).into_response()
}

// ============================================================
// 開発モード限定デバッグ API
// ============================================================

#[derive(Deserialize)]
pub struct DevPhasePayload {
    pub phase: String, // "preparation" | "active" | "frozen" | "auto"
}

/// トランザクション内で game_settings の設定値を保存する
async fn save_setting_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    key: &str,
    value: &str,
) -> Result<(), sqlx::Error> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        INSERT INTO game_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        "#,
    )
    .bind(key)
    .bind(value)
    .bind(&now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// トランザクション内で phase_override を保存（None で削除＝自動判定）する
async fn save_phase_override_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    phase: Option<SeasonPhase>,
) -> Result<(), String> {
    if let Some(p) = phase {
        let val = match p {
            SeasonPhase::Preparation => "preparation",
            SeasonPhase::Active => "active",
            SeasonPhase::Frozen => "frozen",
        };
        save_setting_in_tx(tx, "phase_override", val)
            .await
            .map_err(|e| format!("フェーズ設定の保存に失敗しました: {}", e))?;
    } else {
        sqlx::query("DELETE FROM game_settings WHERE key = 'phase_override'")
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("フェーズ設定の削除に失敗しました: {}", e))?;
    }
    Ok(())
}

/// フェーズ変更時に phase_override・manual_tick_offset・auto_frozen_season_id を単一TXで原子保存し、コミット後にメモリ反映と tick_sync ブロードキャストを一括実行する
async fn apply_phase_override_change_at(
    state: &Arc<AppState>,
    next_ov: Option<SeasonPhase>,
    now: chrono::DateTime<Utc>,
) -> Result<SeasonPhase, Response> {
    let _action_guard = state.action_mutex.lock().await;
    let rules = state.current_game_rules();
    let season_id = state.current_season_id();
    let new_offset = state.compute_synced_tick_offset_for_mode_change_at(now, rules, next_ov);
    let next_tick = state.actual_tick_number_with_at(now, rules, next_ov, new_offset);
    let natural_phase = crate::season::compute_phase_jst_with_schedule(
        now,
        crate::season::SeasonSchedule::from_rules(rules),
    );
    // 手動・自動を問わず、現在ティックが max_ticks 以上（かつ自然凍結以外または手動Active）なら自動凍結を維持・適用する
    let can_auto_freeze = match next_ov {
        None => natural_phase != SeasonPhase::Frozen,
        Some(SeasonPhase::Active) => true,
        Some(_) => false,
    };
    let new_auto_frozen_season_id = if can_auto_freeze && next_tick >= rules.max_ticks {
        season_id
    } else {
        0
    };

    let prev_phase = state.phase_at(now);
    let next_phase = if new_auto_frozen_season_id == season_id {
        SeasonPhase::Frozen
    } else {
        next_ov.unwrap_or(natural_phase)
    };

    let mut tx = crate::db::begin_immediate(&state.pool)
        .await
        .map_err(|e| api_internal_err("フェーズ設定TX開始失敗", e))?;
    save_phase_override_in_tx(&mut tx, next_ov)
        .await
        .map_err(|e| api_internal_err("フェーズ設定保存失敗", e))?;
    save_setting_in_tx(&mut tx, "manual_tick_offset", &new_offset.to_string())
        .await
        .map_err(|e| api_internal_err("手動ティックオフセット保存失敗", e))?;
    save_setting_in_tx(
        &mut tx,
        "auto_frozen_season_id",
        &new_auto_frozen_season_id.to_string(),
    )
    .await
    .map_err(|e| api_internal_err("自動凍結フラグ保存失敗", e))?;
    if prev_phase != next_phase {
        let phase_label = match next_phase {
            SeasonPhase::Preparation => "準備",
            SeasonPhase::Active => "開催",
            SeasonPhase::Frozen => "凍結（結果発表）",
        };
        record_player_log_tx(
            &mut tx,
            season_id,
            0,
            "管理者",
            0,
            "system",
            &format!("管理者がフェーズを「{}」へ変更した", phase_label),
        )
        .await;
    }
    tx.commit()
        .await
        .map_err(|e| api_internal_err("フェーズ設定コミット失敗", e))?;

    // DB コミット成功後にインメモリ状態反映と tick_sync ブロードキャストをロック保持のまま一括完了させる
    *state.phase_override.write() = next_ov;
    *state.manual_tick_offset.write() = new_offset;
    state
        .auto_frozen_season_id
        .store(new_auto_frozen_season_id, Ordering::Release);
    let phase = state.phase_at(now);
    state.broadcast_tick_sync(
        phase,
        state.tick_number_at(now),
        0,
        state.next_refill_unix_at(now),
        season_id,
    );
    Ok(phase)
}

async fn apply_phase_override_change(
    state: &Arc<AppState>,
    next_ov: Option<SeasonPhase>,
) -> Result<SeasonPhase, Response> {
    apply_phase_override_change_at(state, next_ov, Utc::now()).await
}

pub async fn dev_set_phase(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<DevPhasePayload>,
) -> Response {
    if !state.config.dev_mode {
        return api_err(StatusCode::FORBIDDEN, "開発モードが無効です");
    }
    if let Err(r) = authenticate_admin_with_rate_limit(&state, addr, &headers).await {
        return r;
    }
    let next_ov = if payload.phase == "auto" {
        None
    } else if let Some(p) = SeasonPhase::from_str_name(&payload.phase) {
        Some(p)
    } else {
        return api_err(StatusCode::BAD_REQUEST, "無効なフェーズ指定です");
    };
    let phase = match apply_phase_override_change(&state, next_ov).await {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    Json(serde_json::json!({ "ok": true, "phase": phase })).into_response()
}

pub async fn dev_trigger_tick(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if !state.config.dev_mode {
        return api_err(StatusCode::FORBIDDEN, "開発モードが無効です");
    }
    if let Err(r) = authenticate_admin_with_rate_limit(&state, addr, &headers).await {
        return r;
    }
    match state.execute_manual_tick().await {
        Ok(summary) => Json(summary).into_response(),
        Err(e) if e.contains("凍結フェーズ") || e.contains("準備フェーズ") => {
            api_err(StatusCode::FORBIDDEN, e)
        }
        Err(e) => api_internal_err("開発ティック実行失敗", e),
    }
}

#[derive(Deserialize)]
pub struct DevApPayload {
    pub amount: Option<i64>,
}

pub async fn dev_refill_ap(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<DevApPayload>,
) -> Response {
    if !state.config.dev_mode {
        return api_err(StatusCode::FORBIDDEN, "開発モードが無効です");
    }
    if let Err(r) = authenticate_admin_with_rate_limit(&state, addr, &headers).await {
        return r;
    }
    let Some(uid) = resolve_user_id(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "ログインが必要です");
    };
    if !state.account_limiter.check_and_consume(&uid.to_string()) {
        return api_err(
            StatusCode::TOO_MANY_REQUESTS,
            "リクエスト制限を超過しました (アカウント: 最大10 req/sec)",
        );
    }
    let _action_guard = state.action_mutex.lock().await;
    let max_ap = state.effective_max_ap();
    let target = payload.amount.unwrap_or(max_ap).clamp(0, max_ap);
    let row = match sqlx::query("UPDATE users SET ap = ? WHERE id = ? RETURNING username, faction_id")
        .bind(target)
        .bind(uid)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::NOT_FOUND, "ユーザーが見つかりません"),
        Err(e) => return api_internal_err("開発AP補充失敗", e),
    };
    let uname: String = row.get("username");
    let ufid: i64 = row.get("faction_id");
    record_player_log(
        &state.pool,
        state.current_season_id(),
        uid,
        &uname,
        ufid,
        "ap",
        &format!("開発用操作で AP を {} AP に設定した", target),
    )
    .await;
    let ap_event = serde_json::json!({
        "type": "ap_granted",
        "ap": target,
    });
    state.send_event_to_user(uid, encode_event_json(&ap_event.to_string()));
    Json(serde_json::json!({ "ok": true, "ap": target })).into_response()
}

// ============================================================
// 管理者ページ用 API (デフォルト ID/Pass: admin / admin)
// ============================================================

/// Cookie 優先で管理者セッショントークンを取得（X-Admin-Token / Authorization フォールバック）
fn extract_admin_token(headers: &HeaderMap) -> Option<String> {
    if let Some(tok) = extract_cookie(headers, "teien_admin_session") {
        return Some(tok);
    }
    if let Some(v) = headers.get("x-admin-token").and_then(|v| v.to_str().ok()) {
        let s = v.trim();
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }
    extract_bearer_token(headers)
}

async fn resolve_admin(state: &AppState, headers: &HeaderMap) -> Option<String> {
    let tok = extract_admin_token(headers)?;
    state.resolve_active_admin_session(&tok).await
}

#[derive(Deserialize)]
pub struct AdminLoginPayload {
    pub id: String,
    pub password: String,
}

pub async fn admin_login(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<AdminLoginPayload>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    let Some(admin_hash) = state.admin_password_hash.clone() else {
        return api_err(
            StatusCode::SERVICE_UNAVAILABLE,
            "管理者認証が設定されていません",
        );
    };
    if state.admin_lockout.is_locked(&ip) {
        return api_err(
            StatusCode::TOO_MANY_REQUESTS,
            "ログイン試行回数の上限に達しました。しばらく待ってから再試行してください",
        );
    }
    if !state.admin_login_limiter.check_and_consume(&ip)
        || !state.admin_global_login_limiter.check_and_consume("admin_global")
    {
        return api_err(
            StatusCode::TOO_MANY_REQUESTS,
            "管理者ログインの制限を超過しました。しばらく待ってから再試行してください",
        );
    }
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    if payload.password.len() > MAX_PASSWORD_BYTES {
        state.admin_lockout.record_failure(&ip);
        return api_err(
            StatusCode::UNAUTHORIZED,
            "管理者IDまたはパスワードが正しくありません",
        );
    }

    let id_ok = constant_time_eq(payload.id.as_bytes(), state.config.admin_id.as_bytes());
    let Some(_argon2_permit) = state.acquire_argon2_permit().await else {
        return api_err(
            StatusCode::SERVICE_UNAVAILABLE,
            "認証処理が混雑しています。少し待ってから再試行してください",
        );
    };
    let pw = payload.password.clone();
    let pw_ok = tokio::task::spawn_blocking(move || verify_password(&pw, &admin_hash))
        .await
        .unwrap_or(false);
    drop(_argon2_permit);
    if !id_ok || !pw_ok {
        state.admin_lockout.record_failure(&ip);
        return api_err(
            StatusCode::UNAUTHORIZED,
            "管理者IDまたはパスワードが正しくありません",
        );
    }
    state.admin_lockout.record_success(&ip);

    let epoch = state.current_admin_session_cache_epoch();
    let token = generate_session_token();
    let now = Utc::now().to_rfc3339();
    let expires_at_dt = Utc::now() + chrono::Duration::seconds(ADMIN_SESSION_TTL_SECS);
    let expires_at = expires_at_dt.to_rfc3339();
    let expires_at_unix = expires_at_dt.timestamp();
    if let Err(e) = sqlx::query(
        "INSERT INTO admin_sessions (token, admin_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&token)
    .bind(&state.config.admin_id)
    .bind(&now)
    .bind(&expires_at)
    .execute(&state.pool)
    .await
    {
        return api_internal_err("管理者セッション登録失敗", e);
    }

    state.cache_admin_session_if_epoch(
        token.clone(),
        state.config.admin_id.clone(),
        expires_at_unix,
        epoch,
    );
    for evicted_tok in
        crate::db::enforce_admin_session_limit(&state.pool, &state.config.admin_id, 5).await
    {
        state.invalidate_admin_session(&evicted_tok);
    }

    let mut resp = Json(serde_json::json!({
        "ok": true,
        "admin_id": state.config.admin_id,
    }))
    .into_response();
    let cookie = build_session_cookie(
        "teien_admin_session",
        &token,
        ADMIN_SESSION_TTL_SECS,
        "Strict",
        state.config.cookie_secure,
    );
    if let Ok(hv) = HeaderValue::from_str(&cookie) {
        resp.headers_mut().insert(header::SET_COOKIE, hv);
    }
    resp
}

pub async fn admin_logout(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    if let Some(tok) = extract_admin_token(&headers) {
        // 先に DB から削除し、未登録の偽トークンによる不要なキャッシュ世代進行を防ぐ
        match sqlx::query("DELETE FROM admin_sessions WHERE token = ?")
            .bind(&tok)
            .execute(&state.pool)
            .await
        {
            Ok(res) if res.rows_affected() > 0 => {
                state.invalidate_admin_session(&tok);
            }
            Ok(_) => {
                state.invalidate_admin_session_if_present(&tok);
            }
            Err(e) => {
                tracing::error!("管理者セッション削除に失敗しました: {}", e);
                state.invalidate_admin_session(&tok);
            }
        }
    }
    let mut resp = Json(serde_json::json!({ "ok": true })).into_response();
    let cookie = build_clear_cookie("teien_admin_session", "Strict", state.config.cookie_secure);
    if let Ok(hv) = HeaderValue::from_str(&cookie) {
        resp.headers_mut().insert(header::SET_COOKIE, hv);
    }
    resp
}

pub async fn admin_me(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_read_rate_limit(&state, &ip) {
        return r;
    }
    let Some(admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };
    let now = Utc::now();
    let map_params = state.current_map_params();
    Json(serde_json::json!({
        "authenticated": true,
        "admin_id": admin_id,
        "dev_mode": state.config.dev_mode,
        "season_id": state.current_season_id(),
        "phase": state.phase_at(now),
        "tick_number": state.tick_number_at(now),
        "online_count": state.online_count.load(Ordering::Relaxed),
        "board_size": map_params.size,
        "map_params": map_params,
        "size_limits": all_size_limits(),
        "ap_config": state.current_ap_config(),
        "effective_max_ap": state.effective_ap_bounds_at(now).0,
        "endgame_boost_active": state.is_endgame_ap_boost_active_at(now),
        "cost_config": state.current_cost_config(),
        "game_rules": state.current_game_rules(),
        "faction_name_max_len": state.current_faction_name_max_len(),
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct AdminRegenerateMapPayload {
    pub size: usize,
    pub continent_count: u32,
    pub island_count: u32,
    pub land_ratio_pct: u32,
    pub seed: Option<u64>,
}

pub async fn admin_regenerate_map(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<AdminRegenerateMapPayload>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    let Some(admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };

    let seed = payload
        .seed
        .unwrap_or_else(|| rand::thread_rng().gen_range(1..=(1u64 << 50)));
    let params = MapGenParams {
        size: payload.size,
        continent_count: payload.continent_count,
        island_count: payload.island_count,
        land_ratio_pct: payload.land_ratio_pct,
        seed,
    };

    if let Err(msg) = params.validate() {
        return api_err(StatusCode::BAD_REQUEST, msg);
    }

    match state.regenerate_map(params).await {
        Ok(applied) => {
            tracing::warn!(
                "管理者監査ログ: admin_id={} がマップ再生成を実行 (size={}, seed={})",
                admin_id,
                applied.size,
                applied.seed
            );
            Json(serde_json::json!({
                "ok": true,
                "board_size": applied.size,
                "map_params": applied,
            }))
            .into_response()
        }
        Err(msg) => {
            tracing::error!("マップ再生成失敗: {}", msg);
            api_err(StatusCode::INTERNAL_SERVER_ERROR, "マップ再生成に失敗しました")
        }
    }
}

pub async fn admin_set_phase(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<DevPhasePayload>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    let Some(admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };
    let next_ov = if payload.phase == "auto" {
        None
    } else if let Some(p) = SeasonPhase::from_str_name(&payload.phase) {
        Some(p)
    } else {
        return api_err(StatusCode::BAD_REQUEST, "無効なフェーズ指定です");
    };
    let phase = match apply_phase_override_change(&state, next_ov).await {
        Ok(p) => p,
        Err(resp) => return resp,
    };

    tracing::warn!(
        "管理者監査ログ: admin_id={} がフェーズ変更を実行 (phase={})",
        admin_id,
        payload.phase
    );

    Json(serde_json::json!({ "ok": true, "phase": phase })).into_response()
}

pub async fn admin_trigger_tick(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    let Some(admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };
    match state.execute_manual_tick().await {
        Ok(summary) => {
            tracing::warn!("管理者監査ログ: admin_id={} が手動ティックを実行", admin_id);
            Json(summary).into_response()
        }
        Err(e) if e.contains("凍結フェーズ") || e.contains("準備フェーズ") => {
            api_err(StatusCode::FORBIDDEN, e)
        }
        Err(e) => api_internal_err("管理者ティック実行失敗", e),
    }
}

// ============================================================
// 管理者デバッグ用 API (複数勢力一括生成・アカウント切替・AP付与)
// ============================================================

#[derive(Serialize)]
pub struct AdminDebugAccount {
    pub id: i64,
    pub username: String,
    pub ap: i64,
    pub max_ap: i64,
    pub faction_id: i64,
    pub faction_name: String,
    pub faction_color_id: i64,
    pub is_leader: bool,
    pub is_vice_leader: bool,
}

pub async fn admin_debug_list_accounts(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_read_rate_limit(&state, &ip) {
        return r;
    }
    let Some(_admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };

    let season_id = state.current_season_id();
    let rows = match sqlx::query(
        r#"
        SELECT
            u.id,
            u.username,
            u.ap,
            COALESCE(f.id, 0) AS faction_id,
            COALESCE(f.name, '') AS faction_name,
            COALESCE(f.color_id, 0) AS faction_color_id,
            CASE WHEN f.id IS NOT NULL AND f.leader_user_id = u.id THEN 1 ELSE 0 END AS is_leader,
            COALESCE(fm.is_vice_leader, 0) AS is_vice_leader
        FROM users u
        LEFT JOIN factions f ON f.id = u.faction_id AND f.season_id = ?
        LEFT JOIN faction_members fm ON fm.faction_id = f.id AND fm.user_id = u.id
        ORDER BY (f.id IS NULL) ASC, f.id ASC, is_leader DESC, u.id ASC
        "#,
    )
    .bind(season_id)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => return api_internal_err("デバッグアカウント一覧取得失敗", e),
    };

    let max_ap = state.effective_max_ap();
    let accounts: Vec<AdminDebugAccount> = rows
        .into_iter()
        .map(|r| AdminDebugAccount {
            id: r.get("id"),
            username: r.get("username"),
            ap: r.get("ap"),
            max_ap,
            faction_id: r.get("faction_id"),
            faction_name: r.get("faction_name"),
            faction_color_id: r.get("faction_color_id"),
            is_leader: r.get::<i64, _>("is_leader") != 0,
            is_vice_leader: r.get::<i64, _>("is_vice_leader") != 0,
        })
        .collect();

    Json(serde_json::json!({ "accounts": accounts })).into_response()
}

#[derive(Deserialize)]
pub struct AdminSeedFactionsPayload {
    pub faction_count: Option<usize>,
    pub members_per_faction: Option<usize>,
    pub initial_ap: Option<i64>,
    pub place_initial_core: Option<bool>,
}

pub async fn admin_debug_seed_factions(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<AdminSeedFactionsPayload>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    if !state.config.dev_mode {
        return api_err(StatusCode::FORBIDDEN, "開発モードが無効です");
    }
    let Some(admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };

    // 高負荷な Argon2id ハッシュ化は action_mutex 取得前に完了させる
    let Some(_argon2_permit) = state.acquire_argon2_permit().await else {
        return api_err(
            StatusCode::SERVICE_UNAVAILABLE,
            "認証処理が混雑しています。少し待ってから再試行してください",
        );
    };
    let generated_password = generate_random_password(12);
    let pw_for_hash = generated_password.clone();
    let pw_hash = match tokio::task::spawn_blocking(move || hash_password(&pw_for_hash)).await {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => return api_internal_err("デバッグパスワードハッシュ失敗", e),
        Err(e) => return api_internal_err("デバッグパスワードハッシュタスク失敗", e),
    };
    drop(_argon2_permit);

    let _action_guard = state.action_mutex.lock().await;
    if state.current_phase() == SeasonPhase::Frozen {
        return api_err(
            StatusCode::FORBIDDEN,
            "凍結フェーズ中は勢力を生成できません",
        );
    }

    let ap_cfg = state.current_ap_config();
    let rules = state.current_game_rules();
    let max_len = state.current_faction_name_max_len();
    let faction_count = payload.faction_count.unwrap_or(4).clamp(1, 32);
    let members_per_faction = payload.members_per_faction.unwrap_or(1).clamp(1, 5);
    let initial_ap = payload
        .initial_ap
        .unwrap_or(ap_cfg.max_ap)
        .clamp(0, ap_cfg.max_ap);
    let place_initial_core = payload.place_initial_core.unwrap_or(true) && rules.initial_core_quota > 0;

    let season_id = state.current_season_id();
    let now = Utc::now().to_rfc3339();

    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("デバッグ勢力生成TX開始失敗", e),
    };

    // トランザクション内で既存勢力の使用済みカラー・名前および既存ユーザー名を取得
    let existing_factions =
        match sqlx::query("SELECT name, color_id FROM factions WHERE season_id = ?")
            .bind(season_id)
            .fetch_all(&mut *tx)
            .await
        {
            Ok(rows) => rows,
            Err(e) => return api_internal_err("既存勢力一覧取得失敗", e),
        };

    let mut used_colors = [false; 64];
    let mut used_faction_names = std::collections::HashSet::new();
    for r in existing_factions {
        let cid: i64 = r.get("color_id");
        if (0..64).contains(&cid) {
            used_colors[cid as usize] = true;
        }
        used_faction_names.insert(r.get::<String, _>("name"));
    }

    let available_colors: Vec<i64> = (0..64).filter(|&c| !used_colors[c as usize]).collect();
    if available_colors.is_empty() {
        return api_err(
            StatusCode::BAD_REQUEST,
            "使用可能な勢力カラー（最大64色）に空きがありません",
        );
    }
    let spawn_count = faction_count.min(available_colors.len());

    let existing_users = match sqlx::query("SELECT username FROM users")
        .fetch_all(&mut *tx)
        .await
    {
        Ok(rows) => rows,
        Err(e) => return api_internal_err("既存ユーザー一覧取得失敗", e),
    };
    let mut used_usernames: std::collections::HashSet<String> = existing_users
        .into_iter()
        .map(|r| r.get::<String, _>("username"))
        .collect();

    let mut created_factions = Vec::new();
    let mut faction_seq = 1usize;

    for &color_id in available_colors.iter().take(spawn_count) {
        let faction_name = loop {
            let suffix = faction_seq.to_string();
            let suffix_len = suffix.chars().count();
            if suffix_len > max_len {
                let _ = tx.rollback().await;
                return api_err(
                    StatusCode::BAD_REQUEST,
                    "勢力名最大文字数の制約によりデバッグ勢力名を生成できません",
                );
            }
            let prefix: String = "デバッグ勢力".chars().take(max_len - suffix_len).collect();
            let candidate = format!("{}{}", prefix, suffix);
            if !used_faction_names.contains(&candidate) {
                break candidate;
            }
            faction_seq += 1;
        };
        used_faction_names.insert(faction_name.clone());

        let mut member_ids = Vec::with_capacity(members_per_faction);
        let mut member_names = Vec::with_capacity(members_per_faction);

        for m in 1..=members_per_faction {
            let mut u_suffix = 0usize;
            let username = loop {
                let candidate = if u_suffix == 0 {
                    format!("dbg_f{}_p{}", faction_seq, m)
                } else {
                    format!("dbg_f{}_p{}_{}", faction_seq, m, u_suffix)
                };
                if !used_usernames.contains(&candidate) {
                    used_usernames.insert(candidate.clone());
                    break candidate;
                }
                u_suffix += 1;
            };

            let u_res = sqlx::query(
                "INSERT INTO users (username, password_hash, ap, faction_id, created_at) VALUES (?, ?, ?, 0, ?)",
            )
            .bind(&username)
            .bind(&pw_hash)
            .bind(initial_ap)
            .bind(&now)
            .execute(&mut *tx)
            .await;

            let uid = match u_res {
                Ok(r) => r.last_insert_rowid(),
                Err(e) => return api_internal_err("デバッグユーザー作成失敗", e),
            };
            member_ids.push(uid);
            member_names.push(username);
        }

        let leader_uid = member_ids[0];
        let f_res = sqlx::query(
            "INSERT INTO factions (season_id, name, color_id, leader_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(season_id)
        .bind(&faction_name)
        .bind(color_id)
        .bind(leader_uid)
        .bind(&now)
        .execute(&mut *tx)
        .await;

        let fid = match f_res {
            Ok(r) => r.last_insert_rowid(),
            Err(e) => return api_internal_err("デバッグ勢力作成失敗", e),
        };

        if fid <= 0 || fid > u16::MAX as i64 {
            let _ = tx.rollback().await;
            return api_err(
                StatusCode::BAD_REQUEST,
                "勢力IDの上限に達したため新規作成できません",
            );
        }

        for (idx_m, &uid) in member_ids.iter().enumerate() {
            let is_leader_or_vice = 0i64;
            let perm = if idx_m == 0 { 1i64 } else { 0i64 };
            if let Err(e) = sqlx::query(
                r#"
                INSERT INTO faction_members
                (faction_id, user_id, is_vice_leader, can_declare_war, can_ceasefire, can_manage_members, joined_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                "#,
            )
            .bind(fid)
            .bind(uid)
            .bind(is_leader_or_vice)
            .bind(perm)
            .bind(perm)
            .bind(perm)
            .bind(&now)
            .execute(&mut *tx)
            .await
            {
                return api_internal_err("デバッグ勢力メンバー登録失敗", e);
            }

            if let Err(e) = sqlx::query("UPDATE users SET faction_id = ? WHERE id = ?")
                .bind(fid)
                .bind(uid)
                .execute(&mut *tx)
                .await
            {
                return api_internal_err("デバッグユーザー勢力更新失敗", e);
            }
        }

        created_factions.push((fid, faction_name, color_id, member_names));
        faction_seq += 1;
    }

    // 初期中核を盤面の空き陸地にランダム配置（先に候補座標のみ選定し、DB コミット後に盤面へ反映する）
    let mut placed_plans: Vec<(i64, i64, usize, usize)> = Vec::new();
    if place_initial_core {
        {
            let board = state.board.read();
            let sz = board.size;
            let mut rng = rand::thread_rng();
            let mut reserved_coords: std::collections::HashSet<(usize, usize)> =
                std::collections::HashSet::new();

            for &(fid, _, color_id, _) in &created_factions {
                let mut found: Option<(usize, usize)> = None;
                // ランダムサンプリングで空き陸地を探索
                for _ in 0..2000 {
                    let rx = rng.gen_range(0..sz);
                    let ry = rng.gen_range(0..sz);
                    if reserved_coords.contains(&(rx, ry)) {
                        continue;
                    }
                    let idx = board.idx(rx, ry);
                    let c = board.cells[idx];
                    if c.is_land() && c.faction_id == 0 {
                        found = Some((rx, ry));
                        break;
                    }
                }
                // ランダムで見つからない場合は線形走査
                if found.is_none() {
                    'scan: for ry in 0..sz {
                        for rx in 0..sz {
                            if reserved_coords.contains(&(rx, ry)) {
                                continue;
                            }
                            let idx = board.idx(rx, ry);
                            let c = board.cells[idx];
                            if c.is_land() && c.faction_id == 0 {
                                found = Some((rx, ry));
                                break 'scan;
                            }
                        }
                    }
                }

                if let Some((cx, cy)) = found {
                    reserved_coords.insert((cx, cy));
                    placed_plans.push((fid, color_id, cx, cy));
                }
            }
        }

        for &(fid, _, _, _) in &placed_plans {
            if let Err(e) = sqlx::query(
                "UPDATE factions SET initial_core_used = 1, territory_count = 1, core_count = 1, ever_had_territory = 1 WHERE id = ?",
            )
            .bind(fid)
            .execute(&mut *tx)
            .await
            {
                return api_internal_err("デバッグ勢力初期中核DB更新失敗", e);
            }
        }
    }

    if let Err(e) = tx.commit().await {
        return api_internal_err("デバッグ勢力生成TXコミット失敗", e);
    }

    // DB コミット成功後にインメモリ盤面へ反映し、同一ロック内でバージョンを進行する
    let mut cell_diffs = Vec::new();
    let mut placed_coords = Vec::new();
    let start_ver = if !placed_plans.is_empty() {
        let mut board = state.board.write();
        for &(fid, color_id, cx, cy) in &placed_plans {
            let idx = board.idx(cx, cy);
            let mut cell = board.cells[idx];
            if cell.is_land() && cell.faction_id == 0 {
                cell.faction_id = fid as u16;
                cell.color_id = color_id as u8;
                cell.layers = 1;
                cell.set_core(true);
                cell.set_assimilation_ticks(0);
                cell.old_core_faction = 0;
                cell.set_old_core_ttl(0);
                board.cells[idx] = cell;
                board.mark_chunk_dirty(cx, cy);
                cell_diffs.push((cx as u16, cy as u16, cell));
                placed_coords.push((fid, cx, cy));
            }
        }
        if cell_diffs.is_empty() {
            None
        } else {
            let chunk_count = cell_diffs.chunks(4000).len().max(1) as u64;
            Some(state.bump_board_version_n(chunk_count).0)
        }
    } else {
        None
    };

    if start_ver.is_some() {
        state.clear_snapshot_cache();
    }
    state.invalidate_factions_cache();

    for (fid, name, color_id, _) in &created_factions {
        let event = serde_json::json!({
            "type": "faction_created",
            "faction_id": fid,
            "name": name,
            "color_id": color_id,
        });
        state.broadcast_frame(encode_event_json(&event.to_string()));
    }

    if let Some(start_ver) = start_ver {
        for (i, chunk) in cell_diffs.chunks(4000).enumerate() {
            let ver = start_ver + i as u64;
            state.broadcast_frame(crate::protocol::encode_cell_diff_batch(ver, chunk));
        }
        let _ = state.flush_dirty_chunks_locked().await;
    }

    let summary: Vec<serde_json::Value> = created_factions
        .into_iter()
        .map(|(fid, name, color_id, members)| {
            serde_json::json!({
                "id": fid,
                "name": name,
                "color_id": color_id,
                "members": members,
            })
        })
        .collect();

    tracing::warn!(
        "管理者監査ログ: admin_id={} がデバッグ勢力一括生成を実行 (created_count={}, placed_cores={})",
        admin_id,
        summary.len(),
        placed_coords.len()
    );

    Json(serde_json::json!({
        "ok": true,
        "created_count": summary.len(),
        "placed_cores": placed_coords.len(),
        "generated_password": generated_password,
        "factions": summary,
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct AdminImpersonatePayload {
    pub user_id: i64,
}

pub async fn admin_debug_impersonate(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<AdminImpersonatePayload>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    if !state.config.dev_mode {
        return api_err(StatusCode::FORBIDDEN, "開発モードが無効です");
    }
    let Some(admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };

    let _action_guard = state.action_mutex.lock().await;
    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("代理ログインTX開始失敗", e),
    };

    let target_exists = match sqlx::query("SELECT 1 FROM users WHERE id = ?")
        .bind(payload.user_id)
        .fetch_optional(&mut *tx)
        .await
    {
        Ok(opt) => opt.is_some(),
        Err(e) => return api_internal_err("代理ログイン対象ユーザー確認失敗", e),
    };
    if !target_exists {
        return api_err(StatusCode::NOT_FOUND, "指定されたユーザーが見つかりません");
    }

    let old_tok_deleted: Option<(String, u64)> =
        if let Some(old_tok) = extract_cookie(&headers, "teien_session") {
            match sqlx::query("DELETE FROM sessions WHERE token = ?")
                .bind(&old_tok)
                .execute(&mut *tx)
                .await
            {
                Ok(res) => Some((old_tok, res.rows_affected())),
                Err(e) => return api_internal_err("代理ログイン時の旧セッション削除失敗", e),
            }
        } else {
            None
        };

    let token = generate_session_token();
    let now_dt = Utc::now();
    let now = now_dt.to_rfc3339();
    let expires_at_dt = now_dt + chrono::Duration::seconds(USER_SESSION_TTL_SECS);
    let expires_at = expires_at_dt.to_rfc3339();
    let expires_at_unix = expires_at_dt.timestamp();
    if let Err(e) = sqlx::query(
        "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&token)
    .bind(payload.user_id)
    .bind(&now)
    .bind(&expires_at)
    .execute(&mut *tx)
    .await
    {
        return api_internal_err("代理ログインセッション登録失敗", e);
    }

    if let Err(e) = tx.commit().await {
        return api_internal_err("代理ログインTXコミット失敗", e);
    }

    // invalidate_user_session がキャッシュ世代を進めるため、必ず先に旧トークンを無効化してから世代を取得する
    if let Some((old_tok, deleted_rows)) = old_tok_deleted {
        if deleted_rows > 0 {
            state.invalidate_user_session(&old_tok);
        } else {
            state.invalidate_user_session_if_present(&old_tok);
        }
    }
    let epoch = state.current_session_cache_epoch();
    state.cache_user_session_if_epoch(token.clone(), payload.user_id, expires_at_unix, epoch);
    for evicted_tok in
        crate::db::enforce_user_session_limit(&state.pool, payload.user_id, 10).await
    {
        state.invalidate_user_session(&evicted_tok);
    }

    let profile = match load_user_profile(&state, payload.user_id).await {
        Ok(p) => p,
        Err(resp) if resp.status() == StatusCode::UNAUTHORIZED => {
            return api_err(StatusCode::NOT_FOUND, "指定されたユーザーが見つかりません");
        }
        Err(resp) => return resp,
    };
    tracing::warn!(
        "管理者監査ログ: admin_id={} が user_id={} ({}) への代理ログインを実行",
        admin_id,
        payload.user_id,
        profile.username
    );

    let mut resp = Json(serde_json::json!({
        "ok": true,
        "user": profile,
    }))
    .into_response();
    let cookie = build_session_cookie(
        "teien_session",
        &token,
        USER_SESSION_TTL_SECS,
        "Lax",
        state.config.cookie_secure,
    );
    if let Ok(hv) = HeaderValue::from_str(&cookie) {
        resp.headers_mut().insert(header::SET_COOKIE, hv);
    }
    resp
}

#[derive(Deserialize)]
pub struct AdminGrantApPayload {
    pub user_id: Option<i64>,
    pub amount: i64,
    pub mode: Option<String>, // "set" | "add"
}

pub async fn admin_debug_grant_ap(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<AdminGrantApPayload>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    let Some(admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };

    let is_add = match payload.mode.as_deref() {
        None | Some("set") => false,
        Some("add") => true,
        Some(_) => {
            return api_err(
                StatusCode::BAD_REQUEST,
                "mode は 'set' または 'add' を指定してください",
            );
        }
    };
    // max_ap の読取と AP 更新を action_mutex 内で直列化する
    let _action_guard = state.action_mutex.lock().await;
    let max_ap = state.effective_max_ap();

    if let Some(uid) = payload.user_id {
        let clamped_delta = payload.amount.clamp(-max_ap, max_ap);
        let row = if is_add {
            sqlx::query("UPDATE users SET ap = MIN(?, MAX(0, ap + ?)) WHERE id = ? RETURNING ap, username, faction_id")
                .bind(max_ap)
                .bind(clamped_delta)
                .bind(uid)
                .fetch_optional(&state.pool)
                .await
        } else {
            let target = payload.amount.clamp(0, max_ap);
            sqlx::query("UPDATE users SET ap = ? WHERE id = ? RETURNING ap, username, faction_id")
                .bind(target)
                .bind(uid)
                .fetch_optional(&state.pool)
                .await
        };
        let (next_ap, uname, ufid): (i64, String, i64) = match row {
            Ok(Some(r)) => (r.get("ap"), r.get("username"), r.get("faction_id")),
            Ok(None) => return api_err(StatusCode::NOT_FOUND, "ユーザーが見つかりません"),
            Err(e) => return api_internal_err("管理者AP付与失敗", e),
        };
        tracing::warn!(
            "管理者監査ログ: admin_id={} が AP 変更を実行 (user_id={}, mode={}, amount={}, next_ap={})",
            admin_id,
            uid,
            if is_add { "add" } else { "set" },
            if is_add { clamped_delta } else { payload.amount },
            next_ap
        );
        let log_summary = if is_add {
            format!("管理者により AP が {:+} 変更された（現在: {} AP）", clamped_delta, next_ap)
        } else {
            format!("管理者により AP が {} AP に設定された", next_ap)
        };
        record_player_log(
            &state.pool,
            state.current_season_id(),
            uid,
            &uname,
            ufid,
            "ap",
            &log_summary,
        )
        .await;
        let ap_event = serde_json::json!({
            "type": "ap_granted",
            "ap": next_ap,
            "mode": if is_add { "add" } else { "set" },
            "delta": if is_add { Some(clamped_delta) } else { None },
        });
        state.send_event_to_user(uid, encode_event_json(&ap_event.to_string()));
        Json(serde_json::json!({ "ok": true, "updated_count": 1, "ap": next_ap })).into_response()
    } else {
        if is_add {
            let delta = payload.amount.clamp(-max_ap, max_ap);
            match sqlx::query("UPDATE users SET ap = MIN(?, MAX(0, ap + ?))")
                .bind(max_ap)
                .bind(delta)
                .execute(&state.pool)
                .await
            {
                Ok(r) => {
                    tracing::warn!(
                        "管理者監査ログ: admin_id={} が全体 AP 加算を実行 (delta={}, updated_count={})",
                        admin_id,
                        delta,
                        r.rows_affected()
                    );
                    record_player_log(
                        &state.pool,
                        state.current_season_id(),
                        0,
                        "管理者",
                        0,
                        "ap",
                        &format!("管理者が全プレイヤーの AP を {:+} 変更した", delta),
                    )
                    .await;
                    let now = Utc::now();
                    state.broadcast_tick_sync(
                        state.phase_at(now),
                        state.tick_number_at(now),
                        0,
                        state.next_refill_unix_at(now),
                        state.current_season_id(),
                    );
                    let ap_event = serde_json::json!({
                        "type": "ap_granted",
                        "all": true,
                        "mode": "add",
                        "delta": delta,
                    });
                    state.broadcast_frame(encode_event_json(&ap_event.to_string()));
                    Json(serde_json::json!({
                        "ok": true,
                        "updated_count": r.rows_affected(),
                        "delta": delta,
                    }))
                    .into_response()
                }
                Err(e) => api_internal_err("管理者全体AP付与失敗", e),
            }
        } else {
            let target = payload.amount.clamp(0, max_ap);
            match sqlx::query("UPDATE users SET ap = ?")
                .bind(target)
                .execute(&state.pool)
                .await
            {
                Ok(r) => {
                    tracing::warn!(
                        "管理者監査ログ: admin_id={} が全体 AP 設定を実行 (ap={}, updated_count={})",
                        admin_id,
                        target,
                        r.rows_affected()
                    );
                    record_player_log(
                        &state.pool,
                        state.current_season_id(),
                        0,
                        "管理者",
                        0,
                        "ap",
                        &format!("管理者が全プレイヤーの AP を {} AP に設定した", target),
                    )
                    .await;
                    let now = Utc::now();
                    state.broadcast_tick_sync(
                        state.phase_at(now),
                        state.tick_number_at(now),
                        0,
                        state.next_refill_unix_at(now),
                        state.current_season_id(),
                    );
                    let ap_event = serde_json::json!({
                        "type": "ap_granted",
                        "all": true,
                        "mode": "set",
                        "ap": target,
                    });
                    state.broadcast_frame(encode_event_json(&ap_event.to_string()));
                    Json(serde_json::json!({
                        "ok": true,
                        "updated_count": r.rows_affected(),
                        "ap": target,
                    }))
                    .into_response()
                }
                Err(e) => api_internal_err("管理者全体AP付与失敗", e),
            }
        }
    }
}

pub async fn admin_update_ap_config(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<ApConfig>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    let Some(admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };
    if let Err(msg) = payload.validate() {
        return api_err(StatusCode::BAD_REQUEST, msg);
    }
    let ap_cfg_json = match serde_json::to_string(&payload) {
        Ok(j) => j,
        Err(e) => return api_internal_err("AP設定シリアライズ失敗", e),
    };
    let now = Utc::now().to_rfc3339();

    let _action_guard = state.action_mutex.lock().await;
    let sync_now = Utc::now();
    let rules_now = state.current_game_rules();
    let cur_tick = state.actual_tick_number_at(sync_now);
    let boost_active = state.phase_at(sync_now) == SeasonPhase::Active
        && AppState::is_endgame_boost_at_tick(payload, rules_now.max_ticks, cur_tick);
    let effective_max_ap = payload.effective_bounds(boost_active).0;

    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("AP設定・上限調整TX開始失敗", e),
    };

    // AP設定の永続化と既存ユーザー・勢力の AP 上限調整を同一トランザクションで原子的に実行する
    if let Err(e) = sqlx::query(
        r#"
        INSERT INTO game_settings (key, value, updated_at)
        VALUES ('ap_config', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        "#,
    )
    .bind(&ap_cfg_json)
    .bind(&now)
    .execute(&mut *tx)
    .await
    {
        return api_internal_err("AP設定保存失敗", e);
    }

    // 上限引き下げ時に既存ユーザーの AP が実効上限（終盤ブースト考慮）を超えないよう調整
    if let Err(e) = sqlx::query("UPDATE users SET ap = MIN(ap, ?)")
        .bind(effective_max_ap)
        .execute(&mut *tx)
        .await
    {
        return api_internal_err("ユーザーAP上限調整失敗", e);
    }
    record_player_log_tx(
        &mut tx,
        state.current_season_id(),
        0,
        "管理者",
        0,
        "system",
        &format!(
            "管理者が AP 設定を変更した（上限 {} AP / 補充 {}〜{} AP・{}分ごと）",
            payload.max_ap, payload.refill_min, payload.refill_max, payload.refill_interval_minutes
        ),
    )
    .await;
    if let Err(e) = tx.commit().await {
        return api_internal_err("AP上限調整TXコミット失敗", e);
    }
    tracing::warn!(
        "管理者監査ログ: admin_id={} がAP設定変更を実行 (max_ap={}, refill={}分)",
        admin_id,
        payload.max_ap,
        payload.refill_interval_minutes
    );

    *state.ap_config.write() = payload;

    let ap_cfg_event = serde_json::json!({
        "type": "ap_config_updated",
        "ap_config": payload,
        "effective_max_ap": effective_max_ap,
        "endgame_boost": boost_active,
    });
    state.broadcast_frame(encode_event_json(&ap_cfg_event.to_string()));
    state.broadcast_tick_sync(
        state.phase_at(sync_now),
        state.tick_number_at(sync_now),
        0,
        state.next_refill_unix_at(sync_now),
        state.current_season_id(),
    );

    Json(serde_json::json!({
        "ok": true,
        "ap_config": payload,
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct AdminFactionConfigPayload {
    pub faction_name_max_len: usize,
}

pub async fn admin_update_faction_config(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<AdminFactionConfigPayload>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    let Some(admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };
    if !(2..=40).contains(&payload.faction_name_max_len) {
        return api_err(
            StatusCode::BAD_REQUEST,
            "勢力名の最大文字数は 2〜40 の範囲で指定してください",
        );
    }
    let _action_guard = state.action_mutex.lock().await;
    if let Err(e) =
        crate::db::save_faction_name_max_len(&state.pool, payload.faction_name_max_len).await
    {
        return api_internal_err("勢力名最大文字数保存失敗", e);
    }
    tracing::warn!(
        "管理者監査ログ: admin_id={} が勢力名最大文字数変更を実行 (faction_name_max_len={})",
        admin_id,
        payload.faction_name_max_len
    );
    state
        .faction_name_max_len
        .store(payload.faction_name_max_len, Ordering::Release);

    record_player_log(
        &state.pool,
        state.current_season_id(),
        0,
        "管理者",
        0,
        "system",
        &format!(
            "管理者が勢力名の最大文字数を {} 文字に変更した",
            payload.faction_name_max_len
        ),
    )
    .await;

    let event = serde_json::json!({
        "type": "rules_config_updated",
        "faction_name_max_len": payload.faction_name_max_len,
    });
    state.broadcast_frame(encode_event_json(&event.to_string()));

    Json(serde_json::json!({
        "ok": true,
        "faction_name_max_len": payload.faction_name_max_len,
    }))
    .into_response()
}

pub async fn admin_update_cost_config(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<crate::board::CostConfig>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    let Some(admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };
    if let Err(msg) = payload.validate() {
        return api_err(StatusCode::BAD_REQUEST, msg);
    }
    let _action_guard = state.action_mutex.lock().await;
    if let Err(e) = crate::db::save_cost_config(&state.pool, &payload).await {
        return api_internal_err("コスト設定保存失敗", e);
    }
    tracing::warn!(
        "管理者監査ログ: admin_id={} がコスト設定変更を実行 (claim_cost={}, reinforce_cost={})",
        admin_id,
        payload.claim_cost,
        payload.reinforce_cost
    );

    *state.cost_config.write() = payload;

    record_player_log(
        &state.pool,
        state.current_season_id(),
        0,
        "管理者",
        0,
        "system",
        &format!(
            "管理者がコスト設定を変更した（空き地 {} AP / 重ね塗り {} AP / 敵中核 ×{}）",
            payload.claim_cost, payload.reinforce_cost, payload.enemy_core_multiplier
        ),
    )
    .await;

    let event = serde_json::json!({
        "type": "cost_config_updated",
        "cost_config": payload,
    });
    state.broadcast_frame(encode_event_json(&event.to_string()));

    Json(serde_json::json!({
        "ok": true,
        "cost_config": payload,
    }))
    .into_response()
}

async fn apply_rules_config_change_at(
    state: &Arc<AppState>,
    payload: crate::board::GameRulesConfig,
    now: chrono::DateTime<Utc>,
) -> Result<(), Response> {
    let _action_guard = state.action_mutex.lock().await;
    let cur_rules = state.current_game_rules();
    let current_ov = *state.phase_override.read();
    let season_id = state.current_season_id();
    let new_offset = state.compute_synced_tick_offset_for_mode_change_at(now, payload, current_ov);
    let tick_num = state.actual_tick_number_with_at(now, payload, current_ov, new_offset);
    // 新しい max_ticks と現在ティック（自動凍結固定値ではない実ティック値）に応じて自動凍結状態を事前算出する
    let next_schedule = crate::season::SeasonSchedule::from_rules(payload);
    let natural_phase = crate::season::compute_phase_jst_with_schedule(now, next_schedule);
    let start_changed = cur_rules.season_start_weekday != payload.season_start_weekday
        || cur_rules.season_start_hour != payload.season_start_hour
        || cur_rules.season_start_minute != payload.season_start_minute;
    let new_cycle_id = if start_changed {
        Some(crate::season::compute_cycle_id(now, next_schedule))
    } else {
        None
    };
    let can_auto_freeze = match current_ov {
        None => natural_phase != SeasonPhase::Frozen,
        Some(SeasonPhase::Active) => true,
        Some(_) => false,
    };
    let new_auto_frozen_season_id = if can_auto_freeze && tick_num >= payload.max_ticks {
        season_id
    } else {
        0
    };

    let rules_json = serde_json::to_string(&payload)
        .map_err(|e| api_internal_err("ゲームルールシリアライズ失敗", e))?;
    let mut tx = crate::db::begin_immediate(&state.pool)
        .await
        .map_err(|e| api_internal_err("ゲームルール保存TX開始失敗", e))?;
    save_setting_in_tx(&mut tx, "game_rules", &rules_json)
        .await
        .map_err(|e| api_internal_err("ゲームルール保存失敗", e))?;
    save_setting_in_tx(&mut tx, "manual_tick_offset", &new_offset.to_string())
        .await
        .map_err(|e| api_internal_err("手動ティックオフセット保存失敗", e))?;
    save_setting_in_tx(
        &mut tx,
        "auto_frozen_season_id",
        &new_auto_frozen_season_id.to_string(),
    )
    .await
    .map_err(|e| api_internal_err("自動凍結フラグ保存失敗", e))?;
    if let Some(cid) = new_cycle_id {
        save_setting_in_tx(&mut tx, "last_active_cycle_id", &cid.to_string())
            .await
            .map_err(|e| api_internal_err("シーズンサイクルID保存失敗", e))?;
    }
    record_player_log_tx(
        &mut tx,
        season_id,
        0,
        "管理者",
        0,
        "system",
        &format!(
            "管理者がゲームルールを変更した（最大 {} 層 / Tick 間隔 {} 分 / 最大 {} Tick）",
            payload.max_layers, payload.tick_interval_minutes, payload.max_ticks
        ),
    )
    .await;
    tx.commit()
        .await
        .map_err(|e| api_internal_err("ゲームルール保存コミット失敗", e))?;

    // DB コミット成功後にのみインメモリ状態を連続して反映する
    *state.game_rules.write() = payload;
    *state.manual_tick_offset.write() = new_offset;
    state
        .auto_frozen_season_id
        .store(new_auto_frozen_season_id, Ordering::Release);
    if let Some(cid) = new_cycle_id {
        state.season_cycle_id.store(cid, Ordering::Release);
    }

    let event = serde_json::json!({
        "type": "rules_config_updated",
        "game_rules": payload,
    });
    state.broadcast_frame(encode_event_json(&event.to_string()));
    state.broadcast_tick_sync(
        state.phase_at(now),
        state.tick_number_at(now),
        0,
        state.next_refill_unix_at(now),
        season_id,
    );
    Ok(())
}

pub async fn admin_update_rules_config(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<crate::board::GameRulesConfig>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    let Some(admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };
    if let Err(msg) = payload.validate() {
        return api_err(StatusCode::BAD_REQUEST, msg);
    }
    if let Err(resp) = apply_rules_config_change_at(&state, payload, Utc::now()).await {
        return resp;
    }
    tracing::warn!(
        "管理者監査ログ: admin_id={} がゲームルール設定変更を実行 (tick_interval={}分, max_ticks={})",
        admin_id,
        payload.tick_interval_minutes,
        payload.max_ticks
    );

    Json(serde_json::json!({
        "ok": true,
        "game_rules": payload,
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct AdminRenameFactionPayload {
    pub name: String,
}

pub async fn admin_rename_faction(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(faction_id): Path<i64>,
    Json(payload): Json<AdminRenameFactionPayload>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    let Some(admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };
    let max_len = state.current_faction_name_max_len();
    let name = match validate_display_name(&payload.name, 1, max_len, "勢力名") {
        Ok(n) => n,
        Err(msg) => return api_err(StatusCode::BAD_REQUEST, msg),
    };
    let _action_guard = state.action_mutex.lock().await;
    let season_id = state.current_season_id();
    let old_name: String = match sqlx::query_scalar(
        "SELECT name FROM factions WHERE id = ? AND season_id = ?",
    )
    .bind(faction_id)
    .bind(season_id)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(Some(n)) => n,
        Ok(None) => return api_err(StatusCode::NOT_FOUND, "勢力が見つかりません"),
        Err(e) => return api_internal_err("勢力存在確認失敗", e),
    };
    let res = sqlx::query("UPDATE factions SET name = ? WHERE id = ? AND season_id = ?")
        .bind(&name)
        .bind(faction_id)
        .bind(season_id)
        .execute(&state.pool)
        .await;
    match res {
        Ok(r) if r.rows_affected() > 0 => {
            tracing::warn!(
                "管理者監査ログ: admin_id={} が勢力名変更を実行 (faction_id={}, name={})",
                admin_id,
                faction_id,
                name
            );
            state.invalidate_factions_cache();
            let renamed = old_name != name;
            if renamed {
                record_player_log(
                    &state.pool,
                    season_id,
                    0,
                    "管理者",
                    faction_id,
                    "faction",
                    &format!("管理者が勢力名を「{}」から「{}」へ変更した", old_name, name),
                )
                .await;
            }
            let event = serde_json::json!({
                "type": "faction_updated",
                "faction_id": faction_id,
                "name": name,
                "renamed_by_admin": renamed,
                "old_name": old_name,
            });
            state.broadcast_frame(encode_event_json(&event.to_string()));
            Json(serde_json::json!({ "ok": true, "name": name })).into_response()
        }
        Ok(_) => api_err(StatusCode::NOT_FOUND, "勢力が見つかりません"),
        Err(e) => {
            if e.to_string().contains("UNIQUE") {
                api_err(StatusCode::CONFLICT, "同じ勢力名が既に存在します")
            } else {
                api_internal_err("勢力名変更失敗", e)
            }
        }
    }
}

pub async fn admin_delete_faction(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(faction_id): Path<i64>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    let Some(admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };
    let fid_u16 = match validate_faction_id_u16(faction_id) {
        Ok(id) => id,
        Err(r) => return r,
    };
    let _action_guard = state.action_mutex.lock().await;
    let season_id = state.current_season_id();
    let faction_name: String = match sqlx::query_scalar(
        "SELECT name FROM factions WHERE id = ? AND season_id = ?",
    )
    .bind(faction_id)
    .bind(season_id)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(Some(n)) => n,
        Ok(None) => return api_err(StatusCode::NOT_FOUND, "勢力が見つかりません"),
        Err(e) => return api_internal_err("勢力存在確認失敗", e),
    };

    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("勢力削除TX開始失敗", e),
    };
    if let Err(e) = sqlx::query("UPDATE users SET faction_id = 0 WHERE faction_id = ?")
        .bind(faction_id)
        .execute(&mut *tx)
        .await
    {
        return api_internal_err("ユーザー勢力解除失敗", e);
    }
    if let Err(e) = sqlx::query("DELETE FROM faction_members WHERE faction_id = ?")
        .bind(faction_id)
        .execute(&mut *tx)
        .await
    {
        return api_internal_err("勢力メンバー削除失敗", e);
    }
    if let Err(e) = sqlx::query("DELETE FROM faction_join_requests WHERE faction_id = ?")
        .bind(faction_id)
        .execute(&mut *tx)
        .await
    {
        return api_internal_err("勢力参加申請削除失敗", e);
    }
    if let Err(e) = sqlx::query(
        "DELETE FROM diplomacy_wars WHERE season_id = ? AND (faction_a = ? OR faction_b = ?)",
    )
    .bind(season_id)
    .bind(faction_id)
    .bind(faction_id)
    .execute(&mut *tx)
    .await
    {
        return api_internal_err("勢力戦争状態削除失敗", e);
    }
    if let Err(e) = sqlx::query(
        "DELETE FROM ceasefire_proposals WHERE season_id = ? AND (from_faction_id = ? OR to_faction_id = ?)",
    )
    .bind(season_id)
    .bind(faction_id)
    .bind(faction_id)
    .execute(&mut *tx)
    .await
    {
        return api_internal_err("勢力停戦提案削除失敗", e);
    }
    if let Err(e) = sqlx::query("DELETE FROM factions WHERE id = ? AND season_id = ?")
        .bind(faction_id)
        .bind(season_id)
        .execute(&mut *tx)
        .await
    {
        return api_internal_err("勢力レコード削除失敗", e);
    }

    record_player_log_tx(
        &mut tx,
        season_id,
        0,
        "管理者",
        faction_id,
        "faction",
        &format!("管理者が勢力「{}」を削除した", faction_name),
    )
    .await;

    if let Err(e) = tx.commit().await {
        return api_internal_err("勢力削除TXコミット失敗", e);
    }
    tracing::warn!(
        "管理者監査ログ: admin_id={} が勢力削除を実行 (faction_id={})",
        admin_id,
        faction_id
    );

    // DB コミット成功後に盤面上のその勢力のセルおよび旧中核参照をすべて無所属に戻し、同一ロック内でバージョンを進行する
    let mut diffs = Vec::new();
    let start_ver = {
        let mut board = state.board.write();
        let sz = board.size;
        for y in 0..sz {
            for x in 0..sz {
                let idx = board.idx(x, y);
                let mut cell = board.cells[idx];
                let mut changed = false;
                if cell.faction_id == fid_u16 {
                    cell.faction_id = 0;
                    cell.color_id = 0;
                    cell.layers = 0;
                    cell.set_core(false);
                    cell.set_assimilation_ticks(0);
                    changed = true;
                }
                if cell.old_core_faction == fid_u16 {
                    cell.old_core_faction = 0;
                    cell.set_old_core_ttl(0);
                    changed = true;
                }
                if changed {
                    board.cells[idx] = cell;
                    board.mark_chunk_dirty(x, y);
                    diffs.push((x as u16, y as u16, cell));
                }
            }
        }
        if diffs.is_empty() {
            None
        } else {
            let chunk_count = if diffs.len() > 50_000 {
                1
            } else {
                diffs.chunks(4000).len().max(1) as u64
            };
            Some(state.bump_board_version_n(chunk_count).0)
        }
    };

    state.invalidate_factions_cache();
    let event = serde_json::json!({
        "type": "faction_deleted",
        "faction_id": faction_id,
        "name": faction_name,
    });
    state.broadcast_frame(encode_event_json(&event.to_string()));
    if let Some(start_ver) = start_ver {
        state.clear_snapshot_cache();
        // 変更セル数が上限を超える場合は大量差分ブロードキャストを避け、スナップショット再取得を促す
        if diffs.len() > 50_000 {
            state.broadcast_frame(encode_event_json(r#"{"type":"resync_required"}"#));
        } else {
            for (i, chunk) in diffs.chunks(4000).enumerate() {
                let ver = start_ver + i as u64;
                state.broadcast_frame(encode_cell_diff_batch(ver, chunk));
            }
        }
        let _ = state.flush_dirty_chunks_locked().await;
    }

    Json(serde_json::json!({ "ok": true, "cleared_cells": diffs.len() })).into_response()
}

pub async fn admin_delete_user(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(user_id): Path<i64>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    let Some(admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };
    let _action_guard = state.action_mutex.lock().await;
    let season_id = state.current_season_id();
    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("ユーザー削除TX開始失敗", e),
    };
    let is_leader = match sqlx::query(
        "SELECT 1 FROM factions WHERE leader_user_id = ? AND season_id = ?",
    )
    .bind(user_id)
    .bind(season_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(opt) => opt.is_some(),
        Err(e) => return api_internal_err("ユーザーリーダー判定失敗", e),
    };

    if is_leader {
        return api_err(
            StatusCode::BAD_REQUEST,
            "勢力リーダーのプレイヤーは削除できません。先に勢力を解散してください",
        );
    }
    let deleted_faction_id: i64 = match sqlx::query_scalar(
        "SELECT COALESCE((SELECT f.id FROM users u JOIN factions f ON f.id = u.faction_id AND f.season_id = ? WHERE u.id = ?), 0)",
    )
    .bind(season_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(fid)) => fid,
        Ok(None) => return api_err(StatusCode::NOT_FOUND, "ユーザーが見つかりません"),
        Err(e) => return api_internal_err("ユーザー情報取得失敗", e),
    };
    // ユーザーの存在確認とユーザー名取得（上記クエリは COALESCE により存在しないユーザーでも 0 を返すため）
    let Some(deleted_username) = (match sqlx::query_scalar::<_, String>("SELECT username FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await
    {
        Ok(opt) => opt,
        Err(e) => return api_internal_err("ユーザー存在確認失敗", e),
    }) else {
        return api_err(StatusCode::NOT_FOUND, "ユーザーが見つかりません");
    };
    let deleted_faction_name: Option<String> = if deleted_faction_id > 0 {
        match sqlx::query_scalar("SELECT name FROM factions WHERE id = ? AND season_id = ?")
            .bind(deleted_faction_id)
            .bind(season_id)
            .fetch_optional(&mut *tx)
            .await
        {
            Ok(opt) => opt,
            Err(e) => return api_internal_err("削除ユーザー所属勢力名取得失敗", e),
        }
    } else {
        None
    };
    if let Err(e) = sqlx::query("DELETE FROM faction_members WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await
    {
        return api_internal_err("ユーザー所属メンバー削除失敗", e);
    }
    let faction_member_uids = if deleted_faction_id > 0 {
        match collect_faction_member_uids_except_tx(&mut tx, deleted_faction_id, user_id).await {
            Ok(uids) => uids,
            Err(r) => return r,
        }
    } else {
        Vec::new()
    };
    let affected_users =
        match collect_join_request_managers_tx(&mut tx, user_id, season_id, None).await {
            Ok(uids) => uids,
            Err(r) => return r,
        };
    if let Err(e) = sqlx::query("DELETE FROM faction_join_requests WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await
    {
        return api_internal_err("ユーザー参加申請削除失敗", e);
    }
    let res = match sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await
    {
        Ok(r) => r,
        Err(e) => return api_internal_err("ユーザー削除失敗", e),
    };

    if res.rows_affected() == 0 {
        return api_err(StatusCode::NOT_FOUND, "ユーザーが見つかりません");
    }

    if let Err(e) = tx.commit().await {
        return api_internal_err("ユーザー削除TXコミット失敗", e);
    }
    tracing::warn!(
        "管理者監査ログ: admin_id={} がユーザー削除を実行 (user_id={})",
        admin_id,
        user_id
    );

    // 削除対象本人のクライアントが即座に /api/auth/me (401) を検知できるよう、WS 解除前に再同期イベントを送る
    state.send_event_to_user(
        user_id,
        encode_event_json(METADATA_RESYNC_EVENT_JSON),
    );
    state.invalidate_user_sessions_by_uid(user_id);
    if !affected_users.is_empty() {
        state.send_event_to_users(
            &affected_users,
            encode_event_json(METADATA_RESYNC_EVENT_JSON),
        );
    }
    if deleted_faction_id > 0 {
        state.invalidate_factions_cache();
        if !faction_member_uids.is_empty() {
            let fname = deleted_faction_name
                .unwrap_or_else(|| format!("勢力#{}", deleted_faction_id));
            let leave_ev = serde_json::json!({
                "type": "faction_member_left",
                "faction_id": deleted_faction_id,
                "faction_name": fname,
                "user_id": user_id,
                "username": deleted_username,
            });
            state.send_event_to_users(
                &faction_member_uids,
                encode_event_json(&leave_ev.to_string()),
            );
        }
        let ev = serde_json::json!({
            "type": "faction_updated",
            "faction_id": deleted_faction_id,
        });
        state.broadcast_frame(encode_event_json(&ev.to_string()));
    }
    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
pub struct AdminDiplomacyPairPayload {
    pub faction_a: i64,
    pub faction_b: i64,
}

pub async fn admin_force_war(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<AdminDiplomacyPairPayload>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    let Some(admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };
    let a_u16 = match validate_faction_id_u16(payload.faction_a) {
        Ok(id) => id,
        Err(r) => return r,
    };
    let b_u16 = match validate_faction_id_u16(payload.faction_b) {
        Ok(id) => id,
        Err(r) => return r,
    };
    if a_u16 == b_u16 {
        return api_err(StatusCode::BAD_REQUEST, "異なる2つの勢力を指定してください");
    }
    let _action_guard = state.action_mutex.lock().await;
    let season_id = state.current_season_id();
    let (fa, fb) = war_pair(a_u16, b_u16);
    let now = Utc::now().to_rfc3339();
    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("強制開戦TX開始失敗", e),
    };
    let faction_rows = match sqlx::query(
        "SELECT id, name FROM factions WHERE season_id = ? AND id IN (?, ?)",
    )
    .bind(season_id)
    .bind(fa)
    .bind(fb)
    .fetch_all(&mut *tx)
    .await
    {
        Ok(rows) => rows,
        Err(e) => return api_internal_err("勢力存在確認失敗", e),
    };
    if faction_rows.len() < 2 {
        return api_err(StatusCode::NOT_FOUND, "指定された勢力が見つかりません");
    }
    let attacker_name = faction_rows
        .iter()
        .find(|r| r.get::<i64, _>("id") == a_u16 as i64)
        .map(|r| r.get::<String, _>("name"))
        .unwrap_or_else(|| format!("勢力#{}", a_u16));
    let defender_name = faction_rows
        .iter()
        .find(|r| r.get::<i64, _>("id") == b_u16 as i64)
        .map(|r| r.get::<String, _>("name"))
        .unwrap_or_else(|| format!("勢力#{}", b_u16));

    let ins_res = match sqlx::query(
        "INSERT OR IGNORE INTO diplomacy_wars (season_id, faction_a, faction_b, started_at) VALUES (?, ?, ?, ?)",
    )
    .bind(season_id)
    .bind(fa)
    .bind(fb)
    .bind(&now)
    .execute(&mut *tx)
    .await
    {
        Ok(r) => r,
        Err(e) => return api_internal_err("強制開戦登録失敗", e),
    };
    if ins_res.rows_affected() == 0 {
        return api_err(StatusCode::CONFLICT, "指定された勢力は既に戦争状態です");
    }
    if let Err(e) = sqlx::query(
        "DELETE FROM ceasefire_proposals WHERE season_id = ? AND ((from_faction_id = ? AND to_faction_id = ?) OR (from_faction_id = ? AND to_faction_id = ?))",
    )
    .bind(season_id)
    .bind(fa)
    .bind(fb)
    .bind(fb)
    .bind(fa)
    .execute(&mut *tx)
    .await
    {
        return api_internal_err("強制開戦停戦提案削除失敗", e);
    }
    record_player_log_tx_with_target(
        &mut tx,
        season_id,
        0,
        "管理者",
        a_u16 as i64,
        b_u16 as i64,
        "diplomacy",
        &format!("管理者が勢力「{}」と勢力「{}」を強制開戦させた", attacker_name, defender_name),
    )
    .await;
    if let Err(e) = tx.commit().await {
        return api_internal_err("強制開戦TXコミット失敗", e);
    }
    tracing::warn!(
        "管理者監査ログ: admin_id={} が強制開戦を実行 (faction_a={}, faction_b={})",
        admin_id,
        a_u16,
        b_u16
    );

    let event = serde_json::json!({
        "type": "war_declared",
        "attacker_faction_id": a_u16,
        "attacker_name": attacker_name,
        "defender_faction_id": b_u16,
        "defender_name": defender_name,
        "by_user": "管理者",
    });
    state.broadcast_frame(encode_event_json(&event.to_string()));
    Json(serde_json::json!({ "ok": true })).into_response()
}

pub async fn admin_force_ceasefire(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<AdminDiplomacyPairPayload>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    let Some(admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };
    let a_u16 = match validate_faction_id_u16(payload.faction_a) {
        Ok(id) => id,
        Err(r) => return r,
    };
    let b_u16 = match validate_faction_id_u16(payload.faction_b) {
        Ok(id) => id,
        Err(r) => return r,
    };
    if a_u16 == b_u16 {
        return api_err(StatusCode::BAD_REQUEST, "異なる2つの勢力を指定してください");
    }
    let _action_guard = state.action_mutex.lock().await;
    let season_id = state.current_season_id();
    let (fa, fb) = war_pair(a_u16, b_u16);
    let mut tx = match crate::db::begin_immediate(&state.pool).await {
        Ok(t) => t,
        Err(e) => return api_internal_err("強制停戦TX開始失敗", e),
    };
    let del_res = match sqlx::query(
        "DELETE FROM diplomacy_wars WHERE season_id = ? AND faction_a = ? AND faction_b = ?",
    )
    .bind(season_id)
    .bind(fa)
    .bind(fb)
    .execute(&mut *tx)
    .await
    {
        Ok(r) => r,
        Err(e) => return api_internal_err("強制停戦戦争削除失敗", e),
    };
    if del_res.rows_affected() == 0 {
        return api_err(StatusCode::BAD_REQUEST, "指定された勢力は戦争状態ではありません");
    }
    if let Err(e) = sqlx::query(
        "DELETE FROM ceasefire_proposals WHERE season_id = ? AND ((from_faction_id = ? AND to_faction_id = ?) OR (from_faction_id = ? AND to_faction_id = ?))",
    )
    .bind(season_id)
    .bind(fa)
    .bind(fb)
    .bind(fb)
    .bind(fa)
    .execute(&mut *tx)
    .await
    {
        return api_internal_err("強制停戦提案削除失敗", e);
    }
    let (faction_a_name, faction_b_name) =
        match collect_faction_names_pair_tx(&mut tx, season_id, fa as i64, fb as i64).await {
            Ok(names) => names,
            Err(resp) => return resp,
        };
    record_player_log_tx_with_target(
        &mut tx,
        season_id,
        0,
        "管理者",
        fa,
        fb,
        "diplomacy",
        &format!("管理者が勢力「{}」と勢力「{}」を強制停戦させた", faction_a_name, faction_b_name),
    )
    .await;
    if let Err(e) = tx.commit().await {
        return api_internal_err("強制停戦TXコミット失敗", e);
    }
    tracing::warn!(
        "管理者監査ログ: admin_id={} が強制停戦を実行 (faction_a={}, faction_b={})",
        admin_id,
        a_u16,
        b_u16
    );

    let event = serde_json::json!({
        "type": "ceasefire_accepted",
        "faction_a": fa,
        "faction_b": fb,
        "faction_a_name": faction_a_name,
        "faction_b_name": faction_b_name,
    });
    state.broadcast_frame(encode_event_json(&event.to_string()));
    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
pub struct LogsQuery {
    pub category: Option<String>,
    pub limit: Option<i64>,
    pub before_id: Option<i64>,
    pub after_id: Option<i64>,
    pub scope: Option<String>,
    pub faction_id: Option<i64>,
    pub q: Option<String>,
}

#[derive(Serialize)]
pub struct PlayerLogItem {
    pub id: i64,
    pub user_id: i64,
    pub username: String,
    pub faction_id: i64,
    pub target_faction_id: i64,
    pub category: String,
    pub summary: String,
    pub faction_only: bool,
    pub created_at: String,
}

fn escape_like_pattern(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 4);
    for ch in raw.chars().take(64) {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    format!("%{}%", out)
}

pub async fn get_player_logs(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<LogsQuery>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_read_rate_limit(&state, &ip) {
        return r;
    }
    let season_id = state.current_season_id();
    let limit = query.limit.unwrap_or(100).clamp(1, 300);
    let cat = query.category.as_deref().unwrap_or("all").trim();
    let scope = query.scope.as_deref().unwrap_or("all").trim();

    let caller_uid = resolve_user_id(&state, &headers).await;
    let caller_fid: i64 = if let Some(uid) = caller_uid {
        match sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE((SELECT f.id FROM users u JOIN factions f ON f.id = u.faction_id AND f.season_id = ? WHERE u.id = ?), 0)",
        )
        .bind(season_id)
        .bind(uid)
        .fetch_one(&state.pool)
        .await
        {
            Ok(fid) => fid,
            Err(e) => return api_internal_err("ユーザー勢力確認失敗", e),
        }
    } else {
        0
    };

    if (scope == "mine" && caller_uid.is_none()) || (scope == "faction" && caller_fid <= 0) {
        return Json(serde_json::json!({
            "logs": Vec::<PlayerLogItem>::new(),
            "has_more": false,
            "next_before_id": serde_json::Value::Null,
        }))
        .into_response();
    }

    let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
        "SELECT id, user_id, username, faction_id, target_faction_id, category, summary, visibility, created_at FROM player_logs WHERE season_id = ",
    );
    qb.push_bind(season_id);

    if caller_fid > 0 {
        qb.push(" AND (visibility = ");
        qb.push_bind(LOG_VISIBILITY_PUBLIC);
        qb.push(" OR (visibility = ");
        qb.push_bind(LOG_VISIBILITY_FACTION);
        qb.push(" AND faction_id = ");
        qb.push_bind(caller_fid);
        qb.push("))");
    } else {
        qb.push(" AND visibility = ");
        qb.push_bind(LOG_VISIBILITY_PUBLIC);
    }

    if !cat.is_empty() && cat != "all" {
        qb.push(" AND category = ");
        qb.push_bind(cat);
    }

    if let Some(after_id) = query.after_id.filter(|&id| id > 0) {
        qb.push(" AND id > ");
        qb.push_bind(after_id);
    }

    if let Some(before_id) = query.before_id.filter(|&id| id > 0) {
        qb.push(" AND id < ");
        qb.push_bind(before_id);
    }

    if scope == "mine" {
        if let Some(uid) = caller_uid {
            qb.push(" AND user_id = ");
            qb.push_bind(uid);
        }
    } else if scope == "faction" {
        qb.push(" AND (faction_id = ");
        qb.push_bind(caller_fid);
        qb.push(" OR target_faction_id = ");
        qb.push_bind(caller_fid);
        qb.push(")");
    } else if let Some(fid) = query.faction_id.filter(|&id| id > 0) {
        qb.push(" AND (faction_id = ");
        qb.push_bind(fid);
        qb.push(" OR target_faction_id = ");
        qb.push_bind(fid);
        qb.push(")");
    }

    if let Some(q_trimmed) = query.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let pattern = escape_like_pattern(q_trimmed);
        qb.push(" AND (username LIKE ");
        qb.push_bind(pattern.clone());
        qb.push(" ESCAPE '\\' OR summary LIKE ");
        qb.push_bind(pattern);
        qb.push(" ESCAPE '\\')");
    }

    qb.push(" ORDER BY id DESC LIMIT ");
    qb.push_bind(limit + 1);

    let mut rows = match qb.build().fetch_all(&state.pool).await {
        Ok(rows) => rows,
        Err(e) => return api_internal_err("行動ログ取得失敗", e),
    };

    let has_more = rows.len() > limit as usize;
    if has_more {
        rows.truncate(limit as usize);
    }

    let logs: Vec<PlayerLogItem> = rows
        .into_iter()
        .map(|r| PlayerLogItem {
            id: r.get("id"),
            user_id: r.get("user_id"),
            username: r.get("username"),
            faction_id: r.get("faction_id"),
            target_faction_id: r.get("target_faction_id"),
            category: r.get("category"),
            summary: r.get("summary"),
            faction_only: r.get::<i64, _>("visibility") != LOG_VISIBILITY_PUBLIC,
            created_at: r.get("created_at"),
        })
        .collect();

    let next_before_id = if has_more {
        logs.last().map(|l| l.id)
    } else {
        None
    };

    Json(serde_json::json!({
        "logs": logs,
        "has_more": has_more,
        "next_before_id": next_before_id,
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct AdminLogsQuery {
    pub category: Option<String>,
    pub limit: Option<i64>,
    pub before_id: Option<i64>,
    pub after_id: Option<i64>,
    pub faction_id: Option<i64>,
    pub visibility: Option<String>,
    pub season_id: Option<i64>,
    pub q: Option<String>,
}

#[derive(Serialize)]
pub struct AdminLogItem {
    pub id: i64,
    pub season_id: i64,
    pub user_id: i64,
    pub username: String,
    pub faction_id: i64,
    pub target_faction_id: i64,
    pub category: String,
    pub summary: String,
    pub faction_only: bool,
    pub created_at: String,
}

pub async fn admin_get_logs(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<AdminLogsQuery>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_read_rate_limit(&state, &ip) {
        return r;
    }
    let Some(_admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };

    let current_season_id = state.current_season_id();
    let target_season_id = query.season_id.unwrap_or(current_season_id);
    let limit = query.limit.unwrap_or(100).clamp(1, 300);
    let cat = query.category.as_deref().unwrap_or("all").trim();
    let vis = query.visibility.as_deref().unwrap_or("all").trim();

    let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
        "SELECT id, season_id, user_id, username, faction_id, target_faction_id, category, summary, visibility, created_at FROM player_logs WHERE 1=1",
    );

    if target_season_id > 0 {
        qb.push(" AND season_id = ");
        qb.push_bind(target_season_id);
    }

    if vis == "public" {
        qb.push(" AND visibility = ");
        qb.push_bind(LOG_VISIBILITY_PUBLIC);
    } else if vis == "faction" {
        qb.push(" AND visibility = ");
        qb.push_bind(LOG_VISIBILITY_FACTION);
    }

    if !cat.is_empty() && cat != "all" {
        qb.push(" AND category = ");
        qb.push_bind(cat);
    }

    if let Some(after_id) = query.after_id.filter(|&id| id > 0) {
        qb.push(" AND id > ");
        qb.push_bind(after_id);
    }

    if let Some(before_id) = query.before_id.filter(|&id| id > 0) {
        qb.push(" AND id < ");
        qb.push_bind(before_id);
    }

    if let Some(fid) = query.faction_id.filter(|&id| id > 0) {
        qb.push(" AND (faction_id = ");
        qb.push_bind(fid);
        qb.push(" OR target_faction_id = ");
        qb.push_bind(fid);
        qb.push(")");
    }

    if let Some(q_trimmed) = query.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let pattern = escape_like_pattern(q_trimmed);
        qb.push(" AND (username LIKE ");
        qb.push_bind(pattern.clone());
        qb.push(" ESCAPE '\\' OR summary LIKE ");
        qb.push_bind(pattern);
        qb.push(" ESCAPE '\\')");
    }

    qb.push(" ORDER BY id DESC LIMIT ");
    qb.push_bind(limit + 1);

    let mut rows = match qb.build().fetch_all(&state.pool).await {
        Ok(rows) => rows,
        Err(e) => return api_internal_err("管理者監査ログ取得失敗", e),
    };

    let has_more = rows.len() > limit as usize;
    if has_more {
        rows.truncate(limit as usize);
    }

    let logs: Vec<AdminLogItem> = rows
        .into_iter()
        .map(|r| AdminLogItem {
            id: r.get("id"),
            season_id: r.get("season_id"),
            user_id: r.get("user_id"),
            username: r.get("username"),
            faction_id: r.get("faction_id"),
            target_faction_id: r.get("target_faction_id"),
            category: r.get("category"),
            summary: r.get("summary"),
            faction_only: r.get::<i64, _>("visibility") != LOG_VISIBILITY_PUBLIC,
            created_at: r.get("created_at"),
        })
        .collect();

    let next_before_id = if has_more {
        logs.last().map(|l| l.id)
    } else {
        None
    };

    let mut available_seasons: Vec<i64> = sqlx::query_scalar(
        "SELECT DISTINCT season_id FROM player_logs ORDER BY season_id DESC",
    )
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    if !available_seasons.contains(&current_season_id) {
        available_seasons.insert(0, current_season_id);
    }

    Json(serde_json::json!({
        "logs": logs,
        "has_more": has_more,
        "next_before_id": next_before_id,
        "season_id": target_season_id,
        "available_seasons": available_seasons,
    }))
    .into_response()
}

#[derive(Serialize)]
pub struct TimelapseFrameMeta {
    pub id: i64,
    pub tick_number: i64,
    pub board_size: i64,
    pub created_at: String,
}

pub async fn list_timelapse_frames(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_read_rate_limit(&state, &ip) {
        return r;
    }
    let season_id = state.current_season_id();
    let rows = match sqlx::query(
        r#"
        SELECT id, tick_number, board_size, created_at
        FROM (
            SELECT id, tick_number, board_size, created_at
            FROM timelapse_frames
            WHERE season_id = ?
            ORDER BY id DESC
            LIMIT 500
        )
        ORDER BY id ASC
        "#,
    )
    .bind(season_id)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => return api_internal_err("タイムラプスフレーム一覧取得失敗", e),
    };

    let frames: Vec<TimelapseFrameMeta> = rows
        .into_iter()
        .map(|r| TimelapseFrameMeta {
            id: r.get("id"),
            tick_number: r.get("tick_number"),
            board_size: r.get("board_size"),
            created_at: r.get("created_at"),
        })
        .collect();

    Json(serde_json::json!({ "frames": frames })).into_response()
}

pub async fn get_timelapse_frame(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(frame_id): Path<i64>,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_read_rate_limit(&state, &ip) {
        return r;
    }
    let season_id = state.current_season_id();
    let row = match sqlx::query(
        "SELECT board_size, snapshot_gz FROM timelapse_frames WHERE id = ? AND season_id = ?",
    )
    .bind(frame_id)
    .bind(season_id)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return api_err(StatusCode::NOT_FOUND, "タイムラプスフレームが見つかりません"),
        Err(e) => return api_internal_err("タイムラプスフレーム取得失敗", e),
    };

    let board_size: i64 = row.get("board_size");
    let gz: Vec<u8> = row.get("snapshot_gz");

    let mut resp = Response::new(axum::body::Body::from(gz));
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    resp.headers_mut().insert(
        header::CONTENT_ENCODING,
        HeaderValue::from_static("gzip"),
    );
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );
    if let Ok(val) = HeaderValue::from_str(&board_size.to_string()) {
        resp.headers_mut()
            .insert(HeaderName::from_static("x-board-size"), val);
    }
    resp
}

pub async fn admin_capture_timelapse(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let ip = extract_client_ip(addr, &headers, state.config.trust_proxy);
    if let Err(r) = check_rate_limit(&state, &ip, None) {
        return r;
    }
    let Some(admin_id) = resolve_admin(&state, &headers).await else {
        return api_err(StatusCode::UNAUTHORIZED, "管理者ログインが必要です");
    };
    match state.capture_timelapse_frame_current().await {
        Ok(tick_num) => {
            tracing::warn!(
                "管理者監査ログ: admin_id={} がタイムラプス手動撮影を実行 (tick_number={})",
                admin_id,
                tick_num
            );
            Json(serde_json::json!({ "ok": true, "tick_number": tick_num })).into_response()
        }
        Err(e) => api_internal_err("タイムラプス手動撮影失敗", e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::Board;
    use crate::config::Config;
    use crate::db::init_memory_db;
    use std::path::PathBuf;

    fn test_config() -> Config {
        Config {
            bind_addr: "127.0.0.1:0".into(),
            db_path: PathBuf::from(":memory:"),
            static_dir: PathBuf::from("."),
            dev_mode: true,
            map_seed: Some(1),
            admin_id: "admin".into(),
            admin_password: Some("admin".into()),
            trust_proxy: false,
            cookie_secure: false,
            allowed_origins: Vec::new(),
        }
    }

    async fn insert_test_user(pool: &sqlx::SqlitePool, username: &str, token: &str) -> i64 {
        let now = Utc::now().to_rfc3339();
        let expires = (Utc::now() + chrono::Duration::hours(24)).to_rfc3339();
        let res = sqlx::query(
            "INSERT INTO users (username, password_hash, ap, faction_id, created_at) VALUES (?, 'h', 50, 0, ?)",
        )
        .bind(username)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();
        let uid = res.last_insert_rowid();
        sqlx::query("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
            .bind(token)
            .bind(uid)
            .bind(&expires)
            .bind(&now)
            .execute(pool)
            .await
            .unwrap();
        uid
    }

    fn auth_headers(token: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", token)).unwrap(),
        );
        h
    }

    #[tokio::test]
    async fn create_faction_clears_pending_join_requests_and_blocks_cross_faction_abduction() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let leader_x = insert_test_user(&state.pool, "leader_x", "tok_x").await;
        let applicant_a = insert_test_user(&state.pool, "applicant_a", "tok_a").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        // 1. リーダーXが勢力Xを設立（参加許可制）
        let resp = create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_x"),
            Json(CreateFactionPayload {
                name: "FactionX".into(),
                color_id: 1,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::CREATED);

        let fid_x: i64 = sqlx::query("SELECT faction_id FROM users WHERE id = ?")
            .bind(leader_x)
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .get("faction_id");

        let now = Utc::now().to_rfc3339();
        // 2. プレイヤーAが勢力Xへ参加申請を出す
        let req_res = sqlx::query(
            "INSERT INTO faction_join_requests (faction_id, user_id, created_at) VALUES (?, ?, ?)",
        )
        .bind(fid_x)
        .bind(applicant_a)
        .bind(&now)
        .execute(&state.pool)
        .await
        .unwrap();
        let req_id = req_res.last_insert_rowid();

        // 3. その後プレイヤーAが自分で勢力Yを設立する -> 未処理申請が削除されるはず
        let resp_y = create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_a"),
            Json(CreateFactionPayload {
                name: "FactionY".into(),
                color_id: 2,
            }),
        )
        .await;
        assert_eq!(resp_y.status(), StatusCode::CREATED);

        let fid_y: i64 = sqlx::query("SELECT faction_id FROM users WHERE id = ?")
            .bind(applicant_a)
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .get("faction_id");
        assert_ne!(fid_y, 0);

        let remaining_reqs: i64 =
            sqlx::query("SELECT COUNT(*) AS cnt FROM faction_join_requests WHERE user_id = ?")
                .bind(applicant_a)
                .fetch_one(&state.pool)
                .await
                .unwrap()
                .get("cnt");
        assert_eq!(
            remaining_reqs, 0,
            "勢力設立時に未処理の参加申請が削除されているべきです"
        );

        // 4. 直接残存申請レコードを挿入したケースでも accept_join_request が 409 Conflict で強制引き抜きを拒否することを確認
        let stale_req_id = sqlx::query(
            "INSERT INTO faction_join_requests (faction_id, user_id, created_at) VALUES (?, ?, ?)",
        )
        .bind(fid_x)
        .bind(applicant_a)
        .bind(&now)
        .execute(&state.pool)
        .await
        .unwrap()
        .last_insert_rowid();
        assert_ne!(stale_req_id, req_id);

        let accept_resp = accept_join_request(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_x"),
            Path((fid_x, stale_req_id)),
        )
        .await;
        assert_eq!(
            accept_resp.status(),
            StatusCode::CONFLICT,
            "既に別勢力所属のユーザーへの参加申請承認は 409 Conflict で拒否されるべきです"
        );

        let still_fid_y: i64 = sqlx::query("SELECT faction_id FROM users WHERE id = ?")
            .bind(applicant_a)
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .get("faction_id");
        assert_eq!(
            still_fid_y, fid_y,
            "勢力Yのリーダーが勢力Xへ強制移動されてはいけません"
        );
    }

    #[tokio::test]
    async fn admin_impersonate_blocked_in_prod_and_display_name_sanitized() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let mut prod_cfg = test_config();
        prod_cfg.dev_mode = false;
        let state = Arc::new(AppState::new(prod_cfg, pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let uid = insert_test_user(&state.pool, "valid_u", "tok_u").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        // dev_mode=false では admin_debug_impersonate が 403 を返すこと
        let imp_resp = admin_debug_impersonate(
            ConnectInfo(addr),
            State(state.clone()),
            HeaderMap::new(),
            Json(AdminImpersonatePayload { user_id: uid }),
        )
        .await;
        assert_eq!(imp_resp.status(), StatusCode::FORBIDDEN);

        // 制御文字・ゼロ幅文字を含むユーザー名登録や勢力設立が 400 を返すこと
        let reg_resp = register(
            ConnectInfo(addr),
            State(state.clone()),
            HeaderMap::new(),
            Json(AuthPayload {
                username: "bad\u{200B}user".into(),
                password: "password123".into(),
            }),
        )
        .await;
        assert_eq!(reg_resp.status(), StatusCode::BAD_REQUEST);

        let fac_resp = create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_u"),
            Json(CreateFactionPayload {
                name: "bad\nfac".into(),
                color_id: 1,
            }),
        )
        .await;
        assert_eq!(fac_resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn apply_phase_override_auto_preserves_auto_freeze_outside_natural_frozen() {
        use chrono::TimeZone;

        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        let jst = crate::season::jst_offset();
        let fri_1500 = jst.with_ymd_and_hms(2026, 11, 20, 15, 0, 0).unwrap().with_timezone(&Utc);
        let sat_1000 = jst.with_ymd_and_hms(2026, 11, 21, 10, 0, 0).unwrap().with_timezone(&Utc);
        let mon_1000 = jst.with_ymd_and_hms(2026, 11, 23, 10, 0, 0).unwrap().with_timezone(&Utc);

        // 10ティック上限で10ティック分進めた手動Active状態を模擬
        state.game_rules.write().max_ticks = 10;
        *state.phase_override.write() = Some(SeasonPhase::Active);
        *state.manual_tick_offset.write() = 10;
        state.auto_frozen_season_id.store(1, Ordering::Release);

        // Preparation (金曜15:00) および Active (土曜10:00) の両方で auto 復帰時に自動凍結が維持されること
        let prep_phase = apply_phase_override_change_at(&state, None, fri_1500).await.unwrap();
        assert_eq!(state.auto_frozen_season_id.load(Ordering::Acquire), 1);
        assert_eq!(prep_phase, SeasonPhase::Frozen);

        let sat_phase = apply_phase_override_change_at(&state, None, sat_1000).await.unwrap();
        assert_eq!(state.auto_frozen_season_id.load(Ordering::Acquire), 1);
        assert_eq!(sat_phase, SeasonPhase::Frozen);

        // max_ticks 到達済み状態から手動 Active へ切り替えても自動凍結が維持され超過実行できないこと
        let active_phase = apply_phase_override_change_at(&state, Some(SeasonPhase::Active), fri_1500)
            .await
            .unwrap();
        assert_eq!(state.auto_frozen_season_id.load(Ordering::Acquire), 1);
        assert_eq!(active_phase, SeasonPhase::Frozen);

        // Frozen (月曜10:00) では自動凍結フラグは0へクリアされ、自然凍結状態となること
        let mon_phase = apply_phase_override_change_at(&state, None, mon_1000).await.unwrap();
        assert_eq!(state.auto_frozen_season_id.load(Ordering::Acquire), 0);
        assert_eq!(mon_phase, SeasonPhase::Frozen);
    }

    #[tokio::test]
    async fn admin_update_rules_config_auto_freeze_matches_auto_mode() {
        use chrono::TimeZone;

        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        let jst = crate::season::jst_offset();
        let fri_1500 = jst.with_ymd_and_hms(2026, 11, 20, 15, 0, 0).unwrap().with_timezone(&Utc);
        let sat_1000 = jst.with_ymd_and_hms(2026, 11, 21, 10, 0, 0).unwrap().with_timezone(&Utc);

        // 自動モード（phase_override = None）で既に15ティック進んでいる状態を模擬し、max_ticks を 10 へ引き下げる
        *state.manual_tick_offset.write() = 15;
        let mut new_rules = crate::board::GameRulesConfig::default();
        new_rules.max_ticks = 10;

        // Preparation (金曜15:00) 中でも max_ticks 以下へ引き下げた場合は即座に自動凍結されること
        apply_rules_config_change_at(&state, new_rules, fri_1500).await.unwrap();
        assert_eq!(state.auto_frozen_season_id.load(Ordering::Acquire), 1);

        // max_ticks を 20 へ引き上げると自動凍結が解除され、Active (土曜10:00) 中に再引下げ(10)すると再凍結すること
        let mut raised_rules = new_rules;
        raised_rules.max_ticks = 20;
        apply_rules_config_change_at(&state, raised_rules, sat_1000).await.unwrap();
        assert_eq!(state.auto_frozen_season_id.load(Ordering::Acquire), 0);

        apply_rules_config_change_at(&state, new_rules, sat_1000).await.unwrap();
        assert_eq!(state.auto_frozen_season_id.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn logout_with_unknown_token_does_not_bump_epoch() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        let u_epoch0 = state.current_session_cache_epoch();
        let resp = logout(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("nonexistent_tok"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            state.current_session_cache_epoch(),
            u_epoch0,
            "未登録トークンの logout でユーザーセッション世代が進んではいけません"
        );

        let a_epoch0 = state.current_admin_session_cache_epoch();
        let mut adm_headers = HeaderMap::new();
        adm_headers.insert("x-admin-token", HeaderValue::from_static("nonexistent_adm"));
        let adm_resp = admin_logout(ConnectInfo(addr), State(state.clone()), adm_headers).await;
        assert_eq!(adm_resp.status(), StatusCode::OK);
        assert_eq!(
            state.current_admin_session_cache_epoch(),
            a_epoch0,
            "未登録トークンの admin_logout で管理者セッション世代が進んではいけません"
        );

        // 有効セッションが存在する場合は削除され世代が進む
        let _uid = insert_test_user(&state.pool, "logout_u", "valid_tok").await;
        let resp2 = logout(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("valid_tok"),
        )
        .await;
        assert_eq!(resp2.status(), StatusCode::OK);
        assert_eq!(state.current_session_cache_epoch(), u_epoch0 + 1);
    }

    #[test]
    fn extract_token_falls_back_when_cookie_is_empty() {
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, HeaderValue::from_static("teien_session=; teien_admin_session="));
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer user_tok_1"));
        h.insert("x-admin-token", HeaderValue::from_static("adm_tok_1"));

        assert_eq!(extract_token(&h).as_deref(), Some("user_tok_1"));
        assert_eq!(extract_admin_token(&h).as_deref(), Some("adm_tok_1"));

        let mut empty_bearer = HeaderMap::new();
        empty_bearer.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer "));
        assert_eq!(extract_bearer_token(&empty_bearer), None);
    }

    #[tokio::test]
    async fn update_faction_settings_emits_update_on_join_policy_change_and_notifies_cleared_applicants() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let _leader = insert_test_user(&state.pool, "leader_s", "tok_ls").await;
        let applicant = insert_test_user(&state.pool, "app_s", "tok_as").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        let resp = create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_ls"),
            Json(CreateFactionPayload {
                name: "SettingsFac".into(),
                color_id: 5,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::CREATED);
        let fid: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = 'SettingsFac'")
            .fetch_one(&state.pool)
            .await
            .unwrap();

        // 参加許可制へ変更
        let set_inv = update_faction_settings(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_ls"),
            Path(fid),
            Json(FactionSettingsPayload {
                allow_auto_paint: true,
                join_policy: Some(1),
                color_id: Some(5),
            }),
        )
        .await;
        assert_eq!(set_inv.status(), StatusCode::OK);

        // 申請を登録し、申請者の WS チャネルを登録
        let req_resp = request_join_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_as"),
            Path(fid),
        )
        .await;
        assert_eq!(req_resp.status(), StatusCode::OK);

        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        state.register_ws_user_sender(applicant, "tok_as".to_string(), tx);
        let mut bcast_rx = state.broadcast_tx.subscribe();

        // color_id は同値(5)のまま join_policy を 0(自由参加)へ変更
        let set_open = update_faction_settings(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_ls"),
            Path(fid),
            Json(FactionSettingsPayload {
                allow_auto_paint: true,
                join_policy: Some(0),
                color_id: Some(5),
            }),
        )
        .await;
        assert_eq!(set_open.status(), StatusCode::OK);

        // 申請者へメタデータ再同期通知が届くこと
        let direct_frame = rx.try_recv().expect("申請者へ再同期通知が送られるべきです");
        assert_eq!(direct_frame.first(), Some(&crate::protocol::OP_SERVER_EVENT_JSON));
        let ev: serde_json::Value = serde_json::from_slice(&direct_frame[1..]).unwrap();
        assert_eq!(ev["type"], "metadata_resync_required");

        // ブロードキャストされた faction_updated に不要な color_id が含まれないこと（一覧再取得トリガー用）
        let mut saw_plain_update = false;
        while let Ok(frame) = bcast_rx.try_recv() {
            if frame.first() == Some(&crate::protocol::OP_SERVER_EVENT_JSON) {
                let v: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
                if v.get("type").and_then(|t| t.as_str()) == Some("faction_updated")
                    && v.get("color_id").is_none()
                {
                    saw_plain_update = true;
                }
            }
        }
        assert!(
            saw_plain_update,
            "色変更なし・join_policy変更時は color_id 無しの faction_updated が配信されるべきです"
        );
    }

    #[tokio::test]
    async fn leave_faction_and_admin_delete_user_cleanup_join_requests() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let _leader = insert_test_user(&state.pool, "inv_leader", "tok_il").await;
        let applicant1 = insert_test_user(&state.pool, "inv_target", "tok_it").await;
        let applicant2 = insert_test_user(&state.pool, "inv_sender", "tok_is").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        let resp = create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_il"),
            Json(CreateFactionPayload {
                name: "InvFac".into(),
                color_id: 7,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::CREATED);
        let fid: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = 'InvFac'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(
            update_faction_settings(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_il"),
                Path(fid),
                Json(FactionSettingsPayload {
                    allow_auto_paint: false,
                    join_policy: Some(1),
                    color_id: None,
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );

        // 参加申請を送信し、その後リーダーが脱退して勢力が無人化すると参加申請も削除される
        let req_resp = request_join_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_it"),
            Path(fid),
        )
        .await;
        assert_eq!(req_resp.status(), StatusCode::OK);

        let leave_resp = leave_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_il"),
            Path(fid),
        )
        .await;
        assert_eq!(leave_resp.status(), StatusCode::OK);

        let req_cnt: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM faction_join_requests WHERE faction_id = ?")
                .bind(fid)
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(req_cnt, 0, "無人化時に勢力の参加申請も削除されるべきです");

        // 管理者ユーザー削除でそのユーザーの参加申請も削除されることを確認
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO faction_join_requests (faction_id, user_id, created_at) VALUES (?, ?, ?)",
        )
        .bind(fid)
        .bind(applicant2)
        .bind(&now)
        .execute(&state.pool)
        .await
        .unwrap();

        state.cache_admin_session(
            "adm_del_tok".to_string(),
            "admin".to_string(),
            Utc::now().timestamp() + 3600,
        );
        let mut adm_headers = HeaderMap::new();
        adm_headers.insert("x-admin-token", HeaderValue::from_static("adm_del_tok"));
        let del_resp = admin_delete_user(
            ConnectInfo(addr),
            State(state.clone()),
            adm_headers,
            Path(applicant2),
        )
        .await;
        assert_eq!(del_resp.status(), StatusCode::OK);

        let left_req: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM faction_join_requests WHERE user_id = ?")
                .bind(applicant2)
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(left_req, 0, "削除ユーザーが送信した参加申請も削除されるべきです");
        let _ = applicant1;
    }

    #[tokio::test]
    async fn join_faction_rejects_existing_member_and_approval_only_faction() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let _l1 = insert_test_user(&state.pool, "l1_ji", "tok_l1_ji").await;
        let _l2 = insert_test_user(&state.pool, "l2_ji", "tok_l2_ji").await;
        let _target = insert_test_user(&state.pool, "t_ji", "tok_t_ji").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        let r1 = create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_l1_ji"),
            Json(CreateFactionPayload {
                name: "Fac1_JI".into(),
                color_id: 1,
            }),
        )
        .await;
        assert_eq!(r1.status(), StatusCode::CREATED);
        let fid1: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = 'Fac1_JI'")
            .fetch_one(&state.pool)
            .await
            .unwrap();

        let r2 = create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_l2_ji"),
            Json(CreateFactionPayload {
                name: "Fac2_JI".into(),
                color_id: 2,
            }),
        )
        .await;
        assert_eq!(r2.status(), StatusCode::CREATED);
        let fid2: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = 'Fac2_JI'")
            .fetch_one(&state.pool)
            .await
            .unwrap();

        // Fac1 を参加許可制に変更 -> 直接 join_faction は 403 Forbidden
        assert_eq!(
            update_faction_settings(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_l1_ji"),
                Path(fid1),
                Json(FactionSettingsPayload {
                    allow_auto_paint: false,
                    join_policy: Some(1),
                    color_id: None,
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let join_approval_only = join_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_t_ji"),
            Path(fid1),
        )
        .await;
        assert_eq!(join_approval_only.status(), StatusCode::FORBIDDEN);

        // 自由参加の Fac2 に参加後、別の自由参加勢力へ直接 join_faction すると 409 Conflict
        let join2 = join_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_t_ji"),
            Path(fid2),
        )
        .await;
        assert_eq!(join2.status(), StatusCode::OK);

        assert_eq!(
            update_faction_settings(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_l1_ji"),
                Path(fid1),
                Json(FactionSettingsPayload {
                    allow_auto_paint: false,
                    join_policy: Some(0),
                    color_id: None,
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let join1_again = join_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_t_ji"),
            Path(fid1),
        )
        .await;
        assert_eq!(join1_again.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn clearing_join_requests_notifies_target_faction_managers() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let mgr = insert_test_user(&state.pool, "mgr_jr", "tok_mgr_jr").await;
        let u_create = insert_test_user(&state.pool, "u_cr_jr", "tok_uc_jr").await;
        let u_join = insert_test_user(&state.pool, "u_jn_jr", "tok_uj_jr").await;
        let u_del = insert_test_user(&state.pool, "u_dl_jr", "tok_ud_jr").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        // 参加許可制勢力を作成
        assert_eq!(
            create_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_mgr_jr"),
                Json(CreateFactionPayload {
                    name: "MgrFac_JR".into(),
                    color_id: 1,
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        let fid: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = 'MgrFac_JR'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(
            update_faction_settings(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_mgr_jr"),
                Path(fid),
                Json(FactionSettingsPayload {
                    allow_auto_paint: true,
                    join_policy: Some(1),
                    color_id: Some(1),
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );

        // 自由参加勢力も1つ作成
        let _l2 = insert_test_user(&state.pool, "l2_jr", "tok_l2_jr").await;
        assert_eq!(
            create_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_l2_jr"),
                Json(CreateFactionPayload {
                    name: "OpenFac_JR".into(),
                    color_id: 2,
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        let open_fid: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = 'OpenFac_JR'")
            .fetch_one(&state.pool)
            .await
            .unwrap();

        // 3人から MgrFac_JR へ参加申請
        for tok in ["tok_uc_jr", "tok_uj_jr", "tok_ud_jr"] {
            assert_eq!(
                request_join_faction(
                    ConnectInfo(addr),
                    State(state.clone()),
                    auth_headers(tok),
                    Path(fid),
                )
                .await
                .status(),
                StatusCode::OK
            );
        }

        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        state.register_ws_user_sender(mgr, "tok_mgr_jr".to_string(), tx);

        // 1) create_faction による申請消滅
        assert_eq!(
            create_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_uc_jr"),
                Json(CreateFactionPayload {
                    name: "NewFac_JR".into(),
                    color_id: 3,
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        let f1 = rx.try_recv().expect("create_faction 時に管理者へ通知が届くべきです");
        assert_eq!(f1.first(), Some(&crate::protocol::OP_SERVER_EVENT_JSON));
        let ev1: serde_json::Value = serde_json::from_slice(&f1[1..]).unwrap();
        assert_eq!(ev1["type"], "metadata_resync_required");

        // 2) join_faction による申請消滅
        assert_eq!(
            join_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_uj_jr"),
                Path(open_fid),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let f2 = rx.try_recv().expect("join_faction 時に管理者へ通知が届くべきです");
        assert_eq!(f2.first(), Some(&crate::protocol::OP_SERVER_EVENT_JSON));
        let ev2: serde_json::Value = serde_json::from_slice(&f2[1..]).unwrap();
        assert_eq!(ev2["type"], "metadata_resync_required");

        // 3) admin_delete_user による申請消滅
        state.cache_admin_session(
            "adm_jr_tok".to_string(),
            "admin".to_string(),
            Utc::now().timestamp() + 3600,
        );
        let mut adm_headers = HeaderMap::new();
        adm_headers.insert("x-admin-token", HeaderValue::from_static("adm_jr_tok"));
        assert_eq!(
            admin_delete_user(
                ConnectInfo(addr),
                State(state.clone()),
                adm_headers,
                Path(u_del),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let f3 = rx.try_recv().expect("admin_delete_user 時に管理者へ通知が届くべきです");
        assert_eq!(f3.first(), Some(&crate::protocol::OP_SERVER_EVENT_JSON));
        let ev3: serde_json::Value = serde_json::from_slice(&f3[1..]).unwrap();
        assert_eq!(ev3["type"], "metadata_resync_required");
        let _ = (u_create, u_join);
    }

    #[tokio::test]
    async fn admin_force_war_and_ceasefire_validate_state_and_attacker() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let _u1 = insert_test_user(&state.pool, "fw_u1", "tok_fw1").await;
        let _u2 = insert_test_user(&state.pool, "fw_u2", "tok_fw2").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        assert_eq!(
            create_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_fw1"),
                Json(CreateFactionPayload {
                    name: "Alpha".into(),
                    color_id: 1,
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        assert_eq!(
            create_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_fw2"),
                Json(CreateFactionPayload {
                    name: "Beta".into(),
                    color_id: 2,
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        let fid_a: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = 'Alpha'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        let fid_b: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = 'Beta'")
            .fetch_one(&state.pool)
            .await
            .unwrap();

        state.cache_admin_session(
            "adm_fw_tok".to_string(),
            "admin".to_string(),
            Utc::now().timestamp() + 3600,
        );
        let mut adm_headers = HeaderMap::new();
        adm_headers.insert("x-admin-token", HeaderValue::from_static("adm_fw_tok"));

        let mut bcast_rx = state.broadcast_tx.subscribe();

        // 非戦争状態への強制停戦は 400 Bad Request でイベントを送らない
        let cf_not_at_war = admin_force_ceasefire(
            ConnectInfo(addr),
            State(state.clone()),
            adm_headers.clone(),
            Json(AdminDiplomacyPairPayload {
                faction_a: fid_a,
                faction_b: fid_b,
            }),
        )
        .await;
        assert_eq!(cf_not_at_war.status(), StatusCode::BAD_REQUEST);
        assert!(bcast_rx.try_recv().is_err());

        // 大きい ID (fid_b) を attacker として強制開戦 -> イベントの attacker が fid_b / Beta になる
        let war_ok = admin_force_war(
            ConnectInfo(addr),
            State(state.clone()),
            adm_headers.clone(),
            Json(AdminDiplomacyPairPayload {
                faction_a: fid_b,
                faction_b: fid_a,
            }),
        )
        .await;
        assert_eq!(war_ok.status(), StatusCode::OK);
        let frame = bcast_rx.try_recv().unwrap();
        let ev: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
        assert_eq!(ev["type"], "war_declared");
        assert_eq!(ev["attacker_faction_id"], fid_b);
        assert_eq!(ev["attacker_name"], "Beta");
        assert_eq!(ev["defender_faction_id"], fid_a);
        assert_eq!(ev["defender_name"], "Alpha");

        // 重複強制開戦は 409 Conflict
        let war_dup = admin_force_war(
            ConnectInfo(addr),
            State(state.clone()),
            adm_headers,
            Json(AdminDiplomacyPairPayload {
                faction_a: fid_b,
                faction_b: fid_a,
            }),
        )
        .await;
        assert_eq!(war_dup.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn apply_rules_config_clears_auto_freeze_when_entering_natural_frozen() {
        use chrono::TimeZone;

        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        let jst = crate::season::jst_offset();
        let mon_1000 = jst.with_ymd_and_hms(2026, 11, 23, 10, 0, 0).unwrap().with_timezone(&Utc);

        state.auto_frozen_season_id.store(1, Ordering::Release);
        let new_rules = crate::board::GameRulesConfig::default();
        apply_rules_config_change_at(&state, new_rules, mon_1000)
            .await
            .unwrap();
        assert_eq!(
            state.auto_frozen_season_id.load(Ordering::Acquire),
            0,
            "自然凍結帯では auto_frozen_season_id が 0 にクリアされるべきです"
        );
    }

    #[tokio::test]
    async fn impersonate_ignores_bearer_admin_token_and_grant_ap_rejects_invalid_mode() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        let uid = insert_test_user(&state.pool, "imp_u", "tok_imp_u").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        state.cache_admin_session(
            "adm_bearer_tok".to_string(),
            "admin".to_string(),
            Utc::now().timestamp() + 3600,
        );
        let mut adm_headers = HeaderMap::new();
        adm_headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer adm_bearer_tok"),
        );

        let epoch_before = state.current_session_cache_epoch();
        let imp_resp = admin_debug_impersonate(
            ConnectInfo(addr),
            State(state.clone()),
            adm_headers.clone(),
            Json(AdminImpersonatePayload { user_id: uid }),
        )
        .await;
        assert_eq!(imp_resp.status(), StatusCode::OK);
        assert_eq!(
            state.current_session_cache_epoch(),
            epoch_before,
            "Bearer 管理者トークンを旧ユーザートークンとして誤認し世代を進めてはいけません"
        );

        let bad_mode = admin_debug_grant_ap(
            ConnectInfo(addr),
            State(state.clone()),
            adm_headers,
            Json(AdminGrantApPayload {
                user_id: Some(uid),
                amount: 10,
                mode: Some("invalid".into()),
            }),
        )
        .await;
        assert_eq!(bad_mode.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn respond_ceasefire_records_diplomacy_log_and_get_diplomacy_returns_500_on_db_error() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let _u1 = insert_test_user(&state.pool, "cf_u1", "tok_cf1").await;
        let _u2 = insert_test_user(&state.pool, "cf_u2", "tok_cf2").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_cf1"),
            Json(CreateFactionPayload {
                name: "CF1".into(),
                color_id: 1,
            }),
        )
        .await;
        create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_cf2"),
            Json(CreateFactionPayload {
                name: "CF2".into(),
                color_id: 2,
            }),
        )
        .await;
        let fid1: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = 'CF1'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        let fid2: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = 'CF2'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        let now = Utc::now().to_rfc3339();
        let (fa, fb) = war_pair(fid1 as u16, fid2 as u16);
        sqlx::query("INSERT INTO diplomacy_wars (season_id, faction_a, faction_b, started_at) VALUES (1, ?, ?, ?)")
            .bind(fa)
            .bind(fb)
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();

        assert_eq!(
            propose_ceasefire(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_cf1"),
                Json(CeasefireProposePayload {
                    target_faction_id: fid2,
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let prop_id: i64 = sqlx::query_scalar("SELECT id FROM ceasefire_proposals WHERE from_faction_id = ?")
            .bind(fid1)
            .fetch_one(&state.pool)
            .await
            .unwrap();

        assert_eq!(
            respond_ceasefire(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_cf2"),
                Path(prop_id),
                Json(CeasefireRespondPayload { accept: true }),
            )
            .await
            .status(),
            StatusCode::OK
        );

        let log_cnt: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM player_logs WHERE category = 'diplomacy' AND faction_id = ?",
        )
        .bind(fid2)
        .fetch_one(&state.pool)
        .await
        .unwrap();
        assert_eq!(log_cnt, 1, "停戦応答も diplomacy ログへ記録されるべきです");

        state.pool.close().await;
        let dip_err = get_diplomacy(ConnectInfo(addr), State(state.clone()), HeaderMap::new()).await;
        assert_eq!(dip_err.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn update_faction_settings_rejects_invalid_join_policy() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let _leader = insert_test_user(&state.pool, "jp_leader", "tok_jp_l").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();
        create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_jp_l"),
            Json(CreateFactionPayload {
                name: "JpFaction".into(),
                color_id: 4,
            }),
        )
        .await;
        let fid: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = 'JpFaction'")
            .fetch_one(&state.pool)
            .await
            .unwrap();

        for invalid in [-1i64, 2i64] {
            let resp = update_faction_settings(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_jp_l"),
                Path(fid),
                Json(FactionSettingsPayload {
                    allow_auto_paint: false,
                    join_policy: Some(invalid),
                    color_id: None,
                }),
            )
            .await;
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        }
    }

    #[tokio::test]
    async fn accept_join_request_stale_cleanup_notifies_other_managers() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let _leader_a = insert_test_user(&state.pool, "st_la", "tok_st_la").await;
        let vice_a = insert_test_user(&state.pool, "st_va", "tok_st_va").await;
        let _leader_b = insert_test_user(&state.pool, "st_lb", "tok_st_lb").await;
        let _applicant = insert_test_user(&state.pool, "st_app", "tok_st_app").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_st_la"),
            Json(CreateFactionPayload {
                name: "StA".into(),
                color_id: 5,
            }),
        )
        .await;
        let fid_a: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = 'StA'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        // vice_a を自由参加の状態で StA に参加させて副リーダー登録したあと、参加許可制へ変更
        assert_eq!(
            join_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_st_va"),
                Path(fid_a),
            )
            .await
            .status(),
            StatusCode::OK
        );
        sqlx::query("UPDATE faction_members SET is_vice_leader = 1 WHERE faction_id = ? AND user_id = ?")
            .bind(fid_a)
            .bind(vice_a)
            .execute(&state.pool)
            .await
            .unwrap();
        update_faction_settings(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_st_la"),
            Path(fid_a),
            Json(FactionSettingsPayload {
                allow_auto_paint: false,
                join_policy: Some(1),
                color_id: None,
            }),
        )
        .await;

        // 申請者が StA へ参加申請を送信
        assert_eq!(
            request_join_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_st_app"),
                Path(fid_a),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let req_id: i64 = sqlx::query_scalar("SELECT id FROM faction_join_requests WHERE faction_id = ?")
            .bind(fid_a)
            .fetch_one(&state.pool)
            .await
            .unwrap();

        // 申請者が別勢力 StB に先に参加（DB上は古い申請がまだ残っている状態を再現）
        create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_st_lb"),
            Json(CreateFactionPayload {
                name: "StB".into(),
                color_id: 6,
            }),
        )
        .await;
        let fid_b: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = 'StB'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        let now = Utc::now().to_rfc3339();
        let app_uid: i64 = sqlx::query_scalar("SELECT id FROM users WHERE username = 'st_app'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE users SET faction_id = ? WHERE id = ?")
            .bind(fid_b)
            .bind(app_uid)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO faction_members (faction_id, user_id, is_vice_leader, can_declare_war, can_ceasefire, can_manage_members, joined_at) VALUES (?, ?, 0, 0, 0, 0, ?)",
        )
        .bind(fid_b)
        .bind(app_uid)
        .bind(&now)
        .execute(&state.pool)
        .await
        .unwrap();

        let (tx_vice, mut rx_vice) = tokio::sync::mpsc::channel::<Bytes>(8);
        state.register_ws_user_sender(vice_a, "tok_st_va".into(), tx_vice);

        // リーダーA が承認しようとすると 409 Conflict になり、副リーダーAへ同期イベントが届く
        let resp = accept_join_request(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_st_la"),
            Path((fid_a, req_id)),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        let stale_frame = rx_vice
            .try_recv()
            .expect("古い参加申請クリーンアップ時に他の管理権限者へ同期通知を送るべきです");
        assert_eq!(stale_frame.first(), Some(&crate::protocol::OP_SERVER_EVENT_JSON));
        let stale_ev: serde_json::Value = serde_json::from_slice(&stale_frame[1..]).unwrap();
        assert_eq!(stale_ev["type"], "metadata_resync_required");
    }

    #[tokio::test]
    async fn admin_debug_impersonate_preserves_old_session_when_target_missing() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));

        let caller_uid = insert_test_user(&state.pool, "caller_u", "tok_caller_keep").await;
        state.cache_user_session(
            "tok_caller_keep".to_string(),
            caller_uid,
            Utc::now().timestamp() + 3600,
        );
        state.cache_admin_session(
            "adm_tok_keep".to_string(),
            "admin".to_string(),
            Utc::now().timestamp() + 3600,
        );

        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer adm_tok_keep"),
        );
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("teien_session=tok_caller_keep"),
        );

        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();
        let resp = admin_debug_impersonate(
            ConnectInfo(addr),
            State(state.clone()),
            headers,
            Json(AdminImpersonatePayload { user_id: 999_999 }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            state.resolve_active_user_session("tok_caller_keep").await,
            Some(caller_uid),
            "対象ユーザー不在時に呼び出し元の既存セッションを破棄してはいけません"
        );
    }

    #[tokio::test]
    async fn admin_debug_seed_factions_respects_frozen_phase_and_name_max_len() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        state.cache_admin_session(
            "adm_tok_seed".to_string(),
            "admin".to_string(),
            Utc::now().timestamp() + 3600,
        );
        let adm_headers = auth_headers("adm_tok_seed");
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        // 凍結フェーズでは 403 Forbidden
        *state.phase_override.write() = Some(SeasonPhase::Frozen);
        let frozen_resp = admin_debug_seed_factions(
            ConnectInfo(addr),
            State(state.clone()),
            adm_headers.clone(),
            Json(AdminSeedFactionsPayload {
                faction_count: Some(2),
                members_per_faction: Some(1),
                initial_ap: None,
                place_initial_core: Some(true),
            }),
        )
        .await;
        assert_eq!(frozen_resp.status(), StatusCode::FORBIDDEN);

        // Active フェーズ・max_len=4 では 4文字以内の名前で生成される
        *state.phase_override.write() = Some(SeasonPhase::Active);
        state.faction_name_max_len.store(4, Ordering::Release);
        let ok_resp = admin_debug_seed_factions(
            ConnectInfo(addr),
            State(state.clone()),
            adm_headers,
            Json(AdminSeedFactionsPayload {
                faction_count: Some(2),
                members_per_faction: Some(1),
                initial_ap: None,
                place_initial_core: Some(true),
            }),
        )
        .await;
        assert_eq!(ok_resp.status(), StatusCode::OK);
        let names: Vec<String> = sqlx::query_scalar("SELECT name FROM factions")
            .fetch_all(&state.pool)
            .await
            .unwrap();
        assert_eq!(names.len(), 2);
        assert!(names.iter().all(|n| n.chars().count() <= 4));
    }

    #[tokio::test]
    async fn list_factions_cache_hits_and_invalidates_on_create() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'cache_u1', 'h', 30, 0, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (token, user_id, created_at) VALUES ('tok_cache_1', 1, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        state.cache_user_session("tok_cache_1".to_string(), 1, Utc::now().timestamp() + 3600);

        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        // 初回呼び出しでキャッシュが構築される（0件）
        let resp1 = list_factions(ConnectInfo(addr), State(state.clone()), HeaderMap::new()).await;
        assert_eq!(resp1.status(), StatusCode::OK);
        let body1 = axum::body::to_bytes(resp1.into_body(), usize::MAX)
            .await
            .unwrap();
        let list1: Vec<serde_json::Value> = serde_json::from_slice(&body1).unwrap();
        assert!(list1.is_empty());
        assert!(state.factions_cache.read().is_some());

        // 勢力作成するとキャッシュが無効化され、次回の list_factions で新勢力が返る
        let create_resp = create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_cache_1"),
            Json(CreateFactionPayload {
                name: "CacheTest".into(),
                color_id: 3,
            }),
        )
        .await;
        assert_eq!(create_resp.status(), StatusCode::CREATED);
        assert!(state.factions_cache.read().is_none());

        let resp2 = list_factions(ConnectInfo(addr), State(state.clone()), HeaderMap::new()).await;
        assert_eq!(resp2.status(), StatusCode::OK);
        let body2 = axum::body::to_bytes(resp2.into_body(), usize::MAX)
            .await
            .unwrap();
        let list2: Vec<serde_json::Value> = serde_json::from_slice(&body2).unwrap();
        assert_eq!(list2.len(), 1);
        assert_eq!(list2[0]["name"], "CacheTest");
    }

    #[tokio::test]
    async fn list_factions_cache_rejects_stale_store_after_invalidation() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));

        let ttl = std::time::Duration::from_secs(FACTIONS_CACHE_TTL_SECS);
        let epoch_before = state.read_factions_cache(1, ttl).unwrap_err();

        // DB 読み取り中に別リクエストで勢力更新とキャッシュ無効化が走った想定
        state.invalidate_factions_cache();

        // 先行していた古い読み取り結果はキャッシュへ格納されない
        let stale_stored = state.store_factions_cache_if_fresh(
            1,
            epoch_before,
            Bytes::from_static(b"[{\"id\":999}]"),
        );
        assert!(!stale_stored);
        assert!(state.factions_cache.read().is_none());

        // 最新世代で取得した結果は正常に格納される
        let epoch_after = state.read_factions_cache(1, ttl).unwrap_err();
        let fresh_stored =
            state.store_factions_cache_if_fresh(1, epoch_after, Bytes::from_static(b"[]"));
        assert!(fresh_stored);
        assert!(state.factions_cache.read().is_some());
    }

    #[tokio::test]
    async fn create_faction_forbidden_during_preparation_phase() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Preparation);

        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'prep_u1', 'h', 30, 0, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (token, user_id, created_at) VALUES ('tok_prep_1', 1, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        state.cache_user_session("tok_prep_1".to_string(), 1, Utc::now().timestamp() + 3600);

        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();
        let resp = create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_prep_1"),
            Json(CreateFactionPayload {
                name: "PrepBlocked".into(),
                color_id: 2,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn join_leave_and_kick_record_faction_player_logs() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'leader1', 'h', 30, 0, ?), (2, 'member2', 'h', 30, 0, ?), (3, 'member3', 'h', 30, 0, ?)")
            .bind(&now)
            .bind(&now)
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        for (uid, tok) in [(1, "tok_l1"), (2, "tok_m2"), (3, "tok_m3")] {
            sqlx::query("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)")
                .bind(tok)
                .bind(uid)
                .bind(&now)
                .execute(&state.pool)
                .await
                .unwrap();
            state.cache_user_session(tok.to_string(), uid, Utc::now().timestamp() + 3600);
        }

        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();
        let c_resp = create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_l1"),
            Json(CreateFactionPayload {
                name: "木漏れ日藩".into(),
                color_id: 1,
            }),
        )
        .await;
        assert_eq!(c_resp.status(), StatusCode::CREATED);

        // member2 が参加して脱退
        let j2 = join_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_m2"),
            Path(1),
        )
        .await;
        assert_eq!(j2.status(), StatusCode::OK);
        let l2 = leave_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_m2"),
            Path(1),
        )
        .await;
        assert_eq!(l2.status(), StatusCode::OK);

        // member3 が参加して追放
        let j3 = join_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_m3"),
            Path(1),
        )
        .await;
        assert_eq!(j3.status(), StatusCode::OK);
        let k3 = kick_member(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_l1"),
            Path(1),
            Json(KickPayload { user_id: 3 }),
        )
        .await;
        assert_eq!(k3.status(), StatusCode::OK);

        let rows = sqlx::query(
            "SELECT user_id, username, faction_id, category, summary FROM player_logs ORDER BY id ASC",
        )
        .fetch_all(&state.pool)
        .await
        .unwrap();
        let summaries: Vec<(i64, String, String, String)> = rows
            .into_iter()
            .map(|r| {
                (
                    r.get("user_id"),
                    r.get("username"),
                    r.get("category"),
                    r.get("summary"),
                )
            })
            .collect();
        assert_eq!(
            summaries,
            vec![
                (1, "leader1".into(), "faction".into(), "勢力「木漏れ日藩」を設立した".into()),
                (2, "member2".into(), "faction".into(), "勢力「木漏れ日藩」に参加した".into()),
                (2, "member2".into(), "faction".into(), "勢力「木漏れ日藩」から脱退した".into()),
                (3, "member3".into(), "faction".into(), "勢力「木漏れ日藩」に参加した".into()),
                (3, "member3".into(), "faction".into(), "勢力「木漏れ日藩」から追放された（実行: leader1）".into()),
            ]
        );
    }

    #[tokio::test]
    async fn join_and_leave_faction_notify_faction_members() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let leader = insert_test_user(&state.pool, "leader_n", "tok_leader_n").await;
        let member = insert_test_user(&state.pool, "member_n", "tok_member_n").await;
        let outsider = insert_test_user(&state.pool, "outsider_n", "tok_outsider_n").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        assert_eq!(
            create_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_leader_n"),
                Json(CreateFactionPayload {
                    name: "自由勢力N".into(),
                    color_id: 1,
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        let fid: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = '自由勢力N'")
            .fetch_one(&state.pool)
            .await
            .unwrap();

        let (tx_l, mut rx_l) = tokio::sync::mpsc::channel(16);
        let (tx_m, mut rx_m) = tokio::sync::mpsc::channel(16);
        let (tx_o, mut rx_o) = tokio::sync::mpsc::channel(16);
        state.register_ws_user_sender(leader, "tok_leader_n".to_string(), tx_l);
        state.register_ws_user_sender(member, "tok_member_n".to_string(), tx_m);
        state.register_ws_user_sender(outsider, "tok_outsider_n".to_string(), tx_o);

        // 自由参加勢力に参加すると、既存メンバー（leader）に faction_member_joined が届く
        assert_eq!(
            join_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_member_n"),
                Path(fid),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let frame_join = rx_l.try_recv().expect("参加時に既存メンバーへ通知が届くべきです");
        assert_eq!(frame_join.first(), Some(&crate::protocol::OP_SERVER_EVENT_JSON));
        let ev_join: serde_json::Value = serde_json::from_slice(&frame_join[1..]).unwrap();
        assert_eq!(ev_join["type"], "faction_member_joined");
        assert_eq!(ev_join["faction_id"], fid);
        assert_eq!(ev_join["faction_name"], "自由勢力N");
        assert_eq!(ev_join["user_id"], member);
        assert_eq!(ev_join["username"], "member_n");
        assert!(rx_m.try_recv().is_err(), "参加した本人には通知されない");
        assert!(rx_o.try_recv().is_err(), "部外者には通知されない");

        // 脱退すると、残存メンバー（leader）に faction_member_left が届く
        assert_eq!(
            leave_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_member_n"),
                Path(fid),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let frame_leave = rx_l.try_recv().expect("脱退時に残存メンバーへ通知が届くべきです");
        assert_eq!(frame_leave.first(), Some(&crate::protocol::OP_SERVER_EVENT_JSON));
        let ev_leave: serde_json::Value = serde_json::from_slice(&frame_leave[1..]).unwrap();
        assert_eq!(ev_leave["type"], "faction_member_left");
        assert_eq!(ev_leave["faction_id"], fid);
        assert_eq!(ev_leave["faction_name"], "自由勢力N");
        assert_eq!(ev_leave["user_id"], member);
        assert_eq!(ev_leave["username"], "member_n");
        assert!(rx_m.try_recv().is_err(), "脱退した本人には通知されない");
        assert!(rx_o.try_recv().is_err(), "部外者には通知されない");
    }

    #[tokio::test]
    async fn kick_and_leader_transfer_and_permissions_notify_targets() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let leader = insert_test_user(&state.pool, "leader_k", "tok_leader_k").await;
        let m1 = insert_test_user(&state.pool, "m1_k", "tok_m1_k").await;
        let m2 = insert_test_user(&state.pool, "m2_k", "tok_m2_k").await;
        let outsider = insert_test_user(&state.pool, "out_k", "tok_out_k").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        assert_eq!(
            create_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_leader_k"),
                Json(CreateFactionPayload {
                    name: "通知検証藩".into(),
                    color_id: 1,
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        let fid: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = '通知検証藩'")
            .fetch_one(&state.pool)
            .await
            .unwrap();

        for tok in ["tok_m1_k", "tok_m2_k"] {
            assert_eq!(
                join_faction(
                    ConnectInfo(addr),
                    State(state.clone()),
                    auth_headers(tok),
                    Path(fid),
                )
                .await
                .status(),
                StatusCode::OK
            );
        }

        let (tx_l, mut rx_l) = tokio::sync::mpsc::channel(16);
        let (tx_1, mut rx_1) = tokio::sync::mpsc::channel(16);
        let (tx_2, mut rx_2) = tokio::sync::mpsc::channel(16);
        let (tx_o, mut rx_o) = tokio::sync::mpsc::channel(16);
        state.register_ws_user_sender(leader, "tok_leader_k".to_string(), tx_l);
        state.register_ws_user_sender(m1, "tok_m1_k".to_string(), tx_1);
        state.register_ws_user_sender(m2, "tok_m2_k".to_string(), tx_2);
        state.register_ws_user_sender(outsider, "tok_out_k".to_string(), tx_o);

        // 1) 個別権限変更 -> m1 のみに faction_permissions_updated (bulk: false) が届く
        assert_eq!(
            update_member_permissions(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_leader_k"),
                Path((fid, m1)),
                Json(UpdatePermissionsPayload {
                    is_vice_leader: false,
                    can_declare_war: true,
                    can_ceasefire: false,
                    can_manage_members: true,
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let f_perm = rx_1.try_recv().expect("個別権限変更の対象者に通知が届くべきです");
        let ev_perm: serde_json::Value = serde_json::from_slice(&f_perm[1..]).unwrap();
        assert_eq!(ev_perm["type"], "faction_permissions_updated");
        assert_eq!(ev_perm["faction_name"], "通知検証藩");
        assert_eq!(ev_perm["user_id"], m1);
        assert_eq!(ev_perm["can_declare_war"], true);
        assert_eq!(ev_perm["can_manage_members"], true);
        assert_eq!(ev_perm["bulk"], false);
        assert!(rx_2.try_recv().is_err());
        assert!(rx_l.try_recv().is_err());
        assert!(rx_o.try_recv().is_err());

        // 2) 一括権限変更 -> m1, m2 に faction_permissions_updated (bulk: true) が届く
        assert_eq!(
            bulk_update_member_permissions(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_leader_k"),
                Path(fid),
                Json(BulkPermissionsPayload {
                    can_declare_war: true,
                    can_ceasefire: true,
                    can_manage_members: false,
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        for rx in [&mut rx_1, &mut rx_2] {
            let f_bulk = rx.try_recv().expect("一括権限変更の対象者に通知が届くべきです");
            let ev_bulk: serde_json::Value = serde_json::from_slice(&f_bulk[1..]).unwrap();
            assert_eq!(ev_bulk["type"], "faction_permissions_updated");
            assert_eq!(ev_bulk["bulk"], true);
            assert_eq!(ev_bulk["can_ceasefire"], true);
        }
        assert!(rx_l.try_recv().is_err());
        assert!(rx_o.try_recv().is_err());

        // 3) メンバー追放 (leader が m2 を追放) -> 本人 m2 と残存メンバー m1 に届く（leader, outsider には届かない）
        assert_eq!(
            kick_member(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_leader_k"),
                Path(fid),
                Json(KickPayload { user_id: m2 }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        for rx in [&mut rx_1, &mut rx_2] {
            let f_kick = rx.try_recv().expect("追放通知が届くべきです");
            let ev_kick: serde_json::Value = serde_json::from_slice(&f_kick[1..]).unwrap();
            assert_eq!(ev_kick["type"], "faction_member_kicked");
            assert_eq!(ev_kick["faction_id"], fid);
            assert_eq!(ev_kick["user_id"], m2);
            assert_eq!(ev_kick["username"], "m2_k");
            assert_eq!(ev_kick["actor_user_id"], leader);
        }
        assert!(rx_l.try_recv().is_err(), "操作者には追放通知を送らない");
        assert!(rx_o.try_recv().is_err(), "部外者には追放通知を送らない");

        // 4) 勢力主脱退による自動移譲 -> m1 に faction_member_left と faction_leader_transferred が届く
        assert_eq!(
            leave_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_leader_k"),
                Path(fid),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let f_left = rx_1.try_recv().expect("脱退通知が届くべきです");
        let ev_left: serde_json::Value = serde_json::from_slice(&f_left[1..]).unwrap();
        assert_eq!(ev_left["type"], "faction_member_left");
        assert_eq!(ev_left["user_id"], leader);

        let f_trans = rx_1.try_recv().expect("勢力主移譲通知が届くべきです");
        let ev_trans: serde_json::Value = serde_json::from_slice(&f_trans[1..]).unwrap();
        assert_eq!(ev_trans["type"], "faction_leader_transferred");
        assert_eq!(ev_trans["faction_id"], fid);
        assert_eq!(ev_trans["faction_name"], "通知検証藩");
        assert_eq!(ev_trans["new_leader_user_id"], m1);
        assert_eq!(ev_trans["new_leader_username"], "m1_k");
        assert!(rx_o.try_recv().is_err());
    }

    #[tokio::test]
    async fn accept_join_request_notifies_other_members() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let leader = insert_test_user(&state.pool, "leader_aj", "tok_leader_aj").await;
        let peer = insert_test_user(&state.pool, "peer_aj", "tok_peer_aj").await;
        let applicant = insert_test_user(&state.pool, "app_aj", "tok_app_aj").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        assert_eq!(
            create_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_leader_aj"),
                Json(CreateFactionPayload {
                    name: "許可制勢力AJ".into(),
                    color_id: 2,
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        let fid: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = '許可制勢力AJ'")
            .fetch_one(&state.pool)
            .await
            .unwrap();

        assert_eq!(
            join_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_peer_aj"),
                Path(fid),
            )
            .await
            .status(),
            StatusCode::OK
        );

        assert_eq!(
            update_faction_settings(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_leader_aj"),
                Path(fid),
                Json(FactionSettingsPayload {
                    allow_auto_paint: false,
                    join_policy: Some(1),
                    color_id: None,
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );

        assert_eq!(
            request_join_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_app_aj"),
                Path(fid),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let req_id: i64 =
            sqlx::query_scalar("SELECT id FROM faction_join_requests WHERE faction_id = ?")
                .bind(fid)
                .fetch_one(&state.pool)
                .await
                .unwrap();

        let (tx_l, mut rx_l) = tokio::sync::mpsc::channel(16);
        let (tx_p, mut rx_p) = tokio::sync::mpsc::channel(16);
        let (tx_a, mut rx_a) = tokio::sync::mpsc::channel(16);
        state.register_ws_user_sender(leader, "tok_leader_aj".to_string(), tx_l);
        state.register_ws_user_sender(peer, "tok_peer_aj".to_string(), tx_p);
        state.register_ws_user_sender(applicant, "tok_app_aj".to_string(), tx_a);

        assert_eq!(
            accept_join_request(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_leader_aj"),
                Path((fid, req_id)),
            )
            .await
            .status(),
            StatusCode::OK
        );

        // 承認者 leader は faction_join_request_resolved のみ受け取り、faction_member_joined は受け取らない
        let f_l = rx_l.try_recv().unwrap();
        let ev_l: serde_json::Value = serde_json::from_slice(&f_l[1..]).unwrap();
        assert_eq!(ev_l["type"], "faction_join_request_resolved");
        assert!(rx_l.try_recv().is_err());

        // 管理権限のない一般メンバー peer は faction_join_request_resolved を受け取らず、faction_member_joined のみ受け取る
        let f_p = rx_p.try_recv().expect("既存メンバーへ参加通知が届くべきです");
        let ev_p: serde_json::Value = serde_json::from_slice(&f_p[1..]).unwrap();
        assert_eq!(ev_p["type"], "faction_member_joined");
        assert_eq!(ev_p["user_id"], applicant);
        assert_eq!(ev_p["username"], "app_aj");
        assert!(rx_p.try_recv().is_err(), "一般メンバーに承認結果イベントは送られないべきです");

        // 申請者 applicant は faction_join_request_resolved のみ受け取る
        let f_a = rx_a.try_recv().unwrap();
        let ev_a: serde_json::Value = serde_json::from_slice(&f_a[1..]).unwrap();
        assert_eq!(ev_a["type"], "faction_join_request_resolved");
        assert!(rx_a.try_recv().is_err());
    }

    #[tokio::test]
    async fn ceasefire_events_notify_parties_with_names() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let u_a = insert_test_user(&state.pool, "u_cf_a", "tok_cf_a").await;
        let u_b = insert_test_user(&state.pool, "u_cf_b", "tok_cf_b").await;
        let u_c = insert_test_user(&state.pool, "u_cf_c", "tok_cf_c").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        for (tok, name, cid) in [
            ("tok_cf_a", "停戦国A", 1),
            ("tok_cf_b", "停戦国B", 2),
            ("tok_cf_c", "第三国C", 3),
        ] {
            assert_eq!(
                create_faction(
                    ConnectInfo(addr),
                    State(state.clone()),
                    auth_headers(tok),
                    Json(CreateFactionPayload {
                        name: name.into(),
                        color_id: cid,
                    }),
                )
                .await
                .status(),
                StatusCode::CREATED
            );
        }
        let fid_a: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = '停戦国A'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        let fid_b: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = '停戦国B'")
            .fetch_one(&state.pool)
            .await
            .unwrap();

        let (fa, fb) = war_pair(fid_a as u16, fid_b as u16);
        sqlx::query(
            "INSERT INTO diplomacy_wars (season_id, faction_a, faction_b, started_at) VALUES (1, ?, ?, ?)",
        )
        .bind(fa)
        .bind(fb)
        .bind(Utc::now().to_rfc3339())
        .execute(&state.pool)
        .await
        .unwrap();

        let (tx_a, mut rx_a) = tokio::sync::mpsc::channel(16);
        let (tx_b, mut rx_b) = tokio::sync::mpsc::channel(16);
        let (tx_c, mut rx_c) = tokio::sync::mpsc::channel(16);
        state.register_ws_user_sender(u_a, "tok_cf_a".to_string(), tx_a);
        state.register_ws_user_sender(u_b, "tok_cf_b".to_string(), tx_b);
        state.register_ws_user_sender(u_c, "tok_cf_c".to_string(), tx_c);
        let mut bcast_rx = state.broadcast_tx.subscribe();

        // 1) 停戦提案 -> 当事者 A, B にのみ送信され、第三者 C および全体ブロードキャストには流れない
        assert_eq!(
            propose_ceasefire(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_cf_a"),
                Json(CeasefireProposePayload {
                    target_faction_id: fid_b,
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        for rx in [&mut rx_a, &mut rx_b] {
            let f = rx.try_recv().expect("当事者に停戦提案通知が届くべきです");
            let ev: serde_json::Value = serde_json::from_slice(&f[1..]).unwrap();
            assert_eq!(ev["type"], "ceasefire_proposed");
            assert_eq!(ev["from_faction_name"], "停戦国A");
            assert_eq!(ev["to_faction_name"], "停戦国B");
            assert_eq!(ev["actor_user_id"], u_a);
        }
        assert!(rx_c.try_recv().is_err(), "第三者には停戦提案通知が届かない");
        assert!(bcast_rx.try_recv().is_err(), "停戦提案は全体ブロードキャストされない");

        let prop_id: i64 =
            sqlx::query_scalar("SELECT id FROM ceasefire_proposals WHERE from_faction_id = ?")
                .bind(fid_a)
                .fetch_one(&state.pool)
                .await
                .unwrap();

        // 2) 停戦却下 -> 当事者 A, B にのみ送信され、第三者 C には届かない
        assert_eq!(
            respond_ceasefire(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_cf_b"),
                Path(prop_id),
                Json(CeasefireRespondPayload { accept: false }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        for rx in [&mut rx_a, &mut rx_b] {
            let f = rx.try_recv().expect("当事者に停戦却下通知が届くべきです");
            let ev: serde_json::Value = serde_json::from_slice(&f[1..]).unwrap();
            assert_eq!(ev["type"], "ceasefire_rejected");
            assert_eq!(ev["from_faction_name"], "停戦国A");
            assert_eq!(ev["to_faction_name"], "停戦国B");
            assert_eq!(ev["actor_user_id"], u_b);
        }
        assert!(rx_c.try_recv().is_err(), "第三者には停戦却下通知が届かない");

        // 3) 再提案して停戦成立 -> ceasefire_accepted が全体ブロードキャストされ両勢力名を含む
        assert_eq!(
            propose_ceasefire(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_cf_a"),
                Json(CeasefireProposePayload {
                    target_faction_id: fid_b,
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let prop_id2: i64 =
            sqlx::query_scalar("SELECT id FROM ceasefire_proposals WHERE from_faction_id = ?")
                .bind(fid_a)
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(
            respond_ceasefire(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_cf_b"),
                Path(prop_id2),
                Json(CeasefireRespondPayload { accept: true }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let f_acc = bcast_rx.try_recv().expect("停戦成立は全体ブロードキャストされるべきです");
        let ev_acc: serde_json::Value = serde_json::from_slice(&f_acc[1..]).unwrap();
        assert_eq!(ev_acc["type"], "ceasefire_accepted");
        assert_eq!(ev_acc["from_faction_name"], "停戦国A");
        assert_eq!(ev_acc["to_faction_name"], "停戦国B");
    }

    #[tokio::test]
    async fn faction_settings_and_created_and_admin_ap_notifications() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let leader = insert_test_user(&state.pool, "leader_s", "tok_leader_s").await;
        let member = insert_test_user(&state.pool, "member_s", "tok_member_s").await;
        let outsider = insert_test_user(&state.pool, "outsider_s", "tok_outsider_s").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        let (tx_l, mut rx_l) = tokio::sync::mpsc::channel(16);
        let (tx_m, mut rx_m) = tokio::sync::mpsc::channel(16);
        let (tx_o, mut rx_o) = tokio::sync::mpsc::channel(16);
        state.register_ws_user_sender(leader, "tok_leader_s".to_string(), tx_l);
        state.register_ws_user_sender(member, "tok_member_s".to_string(), tx_m);
        state.register_ws_user_sender(outsider, "tok_outsider_s".to_string(), tx_o);
        let mut bcast_rx = state.broadcast_tx.subscribe();

        // 1) create_faction の faction_created に leader_user_id が含まれること
        assert_eq!(
            create_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_leader_s"),
                Json(CreateFactionPayload {
                    name: "設定検証国".into(),
                    color_id: 3,
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        let f_cr = bcast_rx.try_recv().unwrap();
        let ev_cr: serde_json::Value = serde_json::from_slice(&f_cr[1..]).unwrap();
        assert_eq!(ev_cr["type"], "faction_created");
        assert_eq!(ev_cr["name"], "設定検証国");
        assert_eq!(ev_cr["leader_user_id"], leader);

        let fid: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = '設定検証国'")
            .fetch_one(&state.pool)
            .await
            .unwrap();

        assert_eq!(
            join_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_member_s"),
                Path(fid),
            )
            .await
            .status(),
            StatusCode::OK
        );
        // 参加通知を消化
        let _ = rx_l.try_recv();

        // 2) update_faction_settings で変更あり -> member のみに faction_settings_updated が届く
        assert_eq!(
            update_faction_settings(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_leader_s"),
                Path(fid),
                Json(FactionSettingsPayload {
                    allow_auto_paint: false,
                    join_policy: Some(1),
                    color_id: Some(7),
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let f_set = rx_m.try_recv().expect("設定変更時に他メンバーへ通知が届くべきです");
        let ev_set: serde_json::Value = serde_json::from_slice(&f_set[1..]).unwrap();
        assert_eq!(ev_set["type"], "faction_settings_updated");
        assert_eq!(ev_set["faction_id"], fid);
        assert_eq!(ev_set["faction_name"], "設定検証国");
        assert_eq!(ev_set["allow_auto_paint_changed"], true);
        assert_eq!(ev_set["allow_auto_paint"], false);
        assert_eq!(ev_set["join_policy_changed"], true);
        assert_eq!(ev_set["join_policy"], 1);
        assert_eq!(ev_set["color_changed"], true);
        assert_eq!(ev_set["color_id"], 7);
        assert_eq!(ev_set["actor_user_id"], leader);
        assert!(rx_l.try_recv().is_err(), "操作者には送らない");
        assert!(rx_o.try_recv().is_err(), "部外者には送らない");

        // 変更なしの更新では通知されない
        assert_eq!(
            update_faction_settings(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_leader_s"),
                Path(fid),
                Json(FactionSettingsPayload {
                    allow_auto_paint: false,
                    join_policy: Some(1),
                    color_id: Some(7),
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert!(rx_m.try_recv().is_err(), "変更なしの場合は通知されない");

        // 3) admin_grant_ap（個別＆全体）で ap_granted イベントが送信されること
        state.cache_admin_session(
            "adm_ap_tok".to_string(),
            "admin".to_string(),
            Utc::now().timestamp() + 3600,
        );
        let mut adm_headers = HeaderMap::new();
        adm_headers.insert("x-admin-token", HeaderValue::from_static("adm_ap_tok"));

        assert_eq!(
            admin_debug_grant_ap(
                ConnectInfo(addr),
                State(state.clone()),
                adm_headers.clone(),
                Json(AdminGrantApPayload {
                    user_id: Some(member),
                    amount: 15,
                    mode: Some("add".into()),
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let f_ap1 = rx_m.try_recv().expect("個別AP付与通知が届くべきです");
        let ev_ap1: serde_json::Value = serde_json::from_slice(&f_ap1[1..]).unwrap();
        assert_eq!(ev_ap1["type"], "ap_granted");
        assert_eq!(ev_ap1["mode"], "add");
        assert_eq!(ev_ap1["delta"], 15);

        while bcast_rx.try_recv().is_ok() {}
        assert_eq!(
            admin_debug_grant_ap(
                ConnectInfo(addr),
                State(state.clone()),
                adm_headers,
                Json(AdminGrantApPayload {
                    user_id: None,
                    amount: 50,
                    mode: Some("set".into()),
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let mut found_all_ap = false;
        while let Ok(f) = bcast_rx.try_recv() {
            if f.first() == Some(&crate::protocol::OP_SERVER_EVENT_JSON) {
                if let Ok(ev) = serde_json::from_slice::<serde_json::Value>(&f[1..]) {
                    if ev["type"] == "ap_granted" {
                        assert_eq!(ev["all"], true);
                        assert_eq!(ev["mode"], "set");
                        assert_eq!(ev["ap"], 50);
                        found_all_ap = true;
                    }
                }
            }
        }
        assert!(found_all_ap, "全体AP設定時に ap_granted がブロードキャストされるべきです");
    }

    #[tokio::test]
    async fn admin_rename_and_delete_faction_emit_notification_fields() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let _leader = insert_test_user(&state.pool, "leader_ad", "tok_leader_ad").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        assert_eq!(
            create_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_leader_ad"),
                Json(CreateFactionPayload {
                    name: "旧勢力名".into(),
                    color_id: 4,
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        let fid: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = '旧勢力名'")
            .fetch_one(&state.pool)
            .await
            .unwrap();

        state.cache_admin_session(
            "adm_rnd_tok".to_string(),
            "admin".to_string(),
            Utc::now().timestamp() + 3600,
        );
        let mut adm_headers = HeaderMap::new();
        adm_headers.insert("x-admin-token", HeaderValue::from_static("adm_rnd_tok"));
        let mut bcast_rx = state.broadcast_tx.subscribe();

        // 1) 別名へ改名 -> renamed_by_admin: true, old_name, name が含まれる
        assert_eq!(
            admin_rename_faction(
                ConnectInfo(addr),
                State(state.clone()),
                adm_headers.clone(),
                Path(fid),
                Json(AdminRenameFactionPayload {
                    name: "新勢力名".into(),
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let f_ren = bcast_rx.try_recv().unwrap();
        let ev_ren: serde_json::Value = serde_json::from_slice(&f_ren[1..]).unwrap();
        assert_eq!(ev_ren["type"], "faction_updated");
        assert_eq!(ev_ren["faction_id"], fid);
        assert_eq!(ev_ren["name"], "新勢力名");
        assert_eq!(ev_ren["renamed_by_admin"], true);
        assert_eq!(ev_ren["old_name"], "旧勢力名");

        // 2) 同名で再適用 -> renamed_by_admin: false
        assert_eq!(
            admin_rename_faction(
                ConnectInfo(addr),
                State(state.clone()),
                adm_headers.clone(),
                Path(fid),
                Json(AdminRenameFactionPayload {
                    name: "新勢力名".into(),
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let f_same = bcast_rx.try_recv().unwrap();
        let ev_same: serde_json::Value = serde_json::from_slice(&f_same[1..]).unwrap();
        assert_eq!(ev_same["renamed_by_admin"], false);

        // 3) 勢力削除 -> faction_deleted に name が含まれる
        assert_eq!(
            admin_delete_faction(
                ConnectInfo(addr),
                State(state.clone()),
                adm_headers,
                Path(fid),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let f_del = bcast_rx.try_recv().unwrap();
        let ev_del: serde_json::Value = serde_json::from_slice(&f_del[1..]).unwrap();
        assert_eq!(ev_del["type"], "faction_deleted");
        assert_eq!(ev_del["faction_id"], fid);
        assert_eq!(ev_del["name"], "新勢力名");
    }

    #[tokio::test]
    async fn reject_join_request_notifies_only_managers_and_applicant() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let leader = insert_test_user(&state.pool, "leader_rj", "tok_leader_rj").await;
        let peer = insert_test_user(&state.pool, "peer_rj", "tok_peer_rj").await;
        let applicant = insert_test_user(&state.pool, "app_rj", "tok_app_rj").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_leader_rj"),
            Json(CreateFactionPayload {
                name: "拒否検証藩".into(),
                color_id: 2,
            }),
        )
        .await;
        let fid: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = '拒否検証藩'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        join_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_peer_rj"),
            Path(fid),
        )
        .await;
        update_faction_settings(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_leader_rj"),
            Path(fid),
            Json(FactionSettingsPayload {
                allow_auto_paint: false,
                join_policy: Some(1),
                color_id: None,
            }),
        )
        .await;
        request_join_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_app_rj"),
            Path(fid),
        )
        .await;
        let req_id: i64 =
            sqlx::query_scalar("SELECT id FROM faction_join_requests WHERE faction_id = ?")
                .bind(fid)
                .fetch_one(&state.pool)
                .await
                .unwrap();

        let (tx_l, mut rx_l) = tokio::sync::mpsc::channel(16);
        let (tx_p, mut rx_p) = tokio::sync::mpsc::channel(16);
        let (tx_a, mut rx_a) = tokio::sync::mpsc::channel(16);
        state.register_ws_user_sender(leader, "tok_leader_rj".to_string(), tx_l);
        state.register_ws_user_sender(peer, "tok_peer_rj".to_string(), tx_p);
        state.register_ws_user_sender(applicant, "tok_app_rj".to_string(), tx_a);

        assert_eq!(
            reject_join_request(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_leader_rj"),
                Path((fid, req_id)),
            )
            .await
            .status(),
            StatusCode::OK
        );

        let ev_l: serde_json::Value = serde_json::from_slice(&rx_l.try_recv().unwrap()[1..]).unwrap();
        assert_eq!(ev_l["type"], "faction_join_request_resolved");
        assert_eq!(ev_l["accepted"], false);
        let ev_a: serde_json::Value = serde_json::from_slice(&rx_a.try_recv().unwrap()[1..]).unwrap();
        assert_eq!(ev_a["type"], "faction_join_request_resolved");
        assert_eq!(ev_a["accepted"], false);
        assert!(rx_p.try_recv().is_err(), "一般メンバーに拒否通知は届かないべきです");
    }

    #[tokio::test]
    async fn permissions_update_skips_noop_and_normalizes_vice_leader() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let _leader = insert_test_user(&state.pool, "leader_pn", "tok_leader_pn").await;
        let m1 = insert_test_user(&state.pool, "m1_pn", "tok_m1_pn").await;
        let m2 = insert_test_user(&state.pool, "m2_pn", "tok_m2_pn").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_leader_pn"),
            Json(CreateFactionPayload {
                name: "権限正規化藩".into(),
                color_id: 6,
            }),
        )
        .await;
        let fid: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = '権限正規化藩'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        for tok in ["tok_m1_pn", "tok_m2_pn"] {
            join_faction(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers(tok),
                Path(fid),
            )
            .await;
        }

        let (tx_1, mut rx_1) = tokio::sync::mpsc::channel(16);
        let (tx_2, mut rx_2) = tokio::sync::mpsc::channel(16);
        state.register_ws_user_sender(m1, "tok_m1_pn".to_string(), tx_1);
        state.register_ws_user_sender(m2, "tok_m2_pn".to_string(), tx_2);

        // 変更なしの個別権限更新（初期値すべて false -> false）は通知されない
        assert_eq!(
            update_member_permissions(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_leader_pn"),
                Path((fid, m1)),
                Json(UpdatePermissionsPayload {
                    is_vice_leader: false,
                    can_declare_war: false,
                    can_ceasefire: false,
                    can_manage_members: false,
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert!(rx_1.try_recv().is_err(), "変更なしの場合は通知されないべきです");

        // 副主任命時は他フラグが false 指定でも実効権限すべて true に正規化されて通知される
        assert_eq!(
            update_member_permissions(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_leader_pn"),
                Path((fid, m1)),
                Json(UpdatePermissionsPayload {
                    is_vice_leader: true,
                    can_declare_war: false,
                    can_ceasefire: false,
                    can_manage_members: false,
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let ev_v: serde_json::Value = serde_json::from_slice(&rx_1.try_recv().unwrap()[1..]).unwrap();
        assert_eq!(ev_v["is_vice_leader"], true);
        assert_eq!(ev_v["can_declare_war"], true);
        assert_eq!(ev_v["can_ceasefire"], true);
        assert_eq!(ev_v["can_manage_members"], true);

        // 一括更新で m2 を変更後、同値で再実行すると m2 へ重複通知されない
        assert_eq!(
            bulk_update_member_permissions(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_leader_pn"),
                Path(fid),
                Json(BulkPermissionsPayload {
                    can_declare_war: true,
                    can_ceasefire: false,
                    can_manage_members: false,
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert!(rx_2.try_recv().is_ok());
        assert_eq!(
            bulk_update_member_permissions(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_leader_pn"),
                Path(fid),
                Json(BulkPermissionsPayload {
                    can_declare_war: true,
                    can_ceasefire: false,
                    can_manage_members: false,
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert!(rx_2.try_recv().is_err(), "既に同一権限のメンバーへ重複通知されないべきです");
    }

    #[tokio::test]
    async fn admin_grant_ap_clamps_delta_and_ap_config_emits_event_and_delete_orders_events() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let mut board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let idx = board.idx(10, 10);
        board.cells[idx].faction_id = 1;
        board.cells[idx].color_id = 4;
        board.cells[idx].layers = 1;
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let u1 = insert_test_user(&state.pool, "u_ap_cl", "tok_ap_cl").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();
        create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_ap_cl"),
            Json(CreateFactionPayload {
                name: "順序検証国".into(),
                color_id: 4,
            }),
        )
        .await;
        let fid: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = '順序検証国'")
            .fetch_one(&state.pool)
            .await
            .unwrap();

        state.cache_admin_session(
            "adm_ord_tok".to_string(),
            "admin".to_string(),
            Utc::now().timestamp() + 3600,
        );
        let mut adm_headers = HeaderMap::new();
        adm_headers.insert("x-admin-token", HeaderValue::from_static("adm_ord_tok"));

        let (tx_u, mut rx_u) = tokio::sync::mpsc::channel(16);
        state.register_ws_user_sender(u1, "tok_ap_cl".to_string(), tx_u);
        let mut bcast_rx = state.broadcast_tx.subscribe();

        // 1) 個別 AP 加算で max_ap (100) を超える 500 を指定 -> delta は 100 にクランプされる
        assert_eq!(
            admin_debug_grant_ap(
                ConnectInfo(addr),
                State(state.clone()),
                adm_headers.clone(),
                Json(AdminGrantApPayload {
                    user_id: Some(u1),
                    amount: 500,
                    mode: Some("add".into()),
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let ev_ap: serde_json::Value = serde_json::from_slice(&rx_u.try_recv().unwrap()[1..]).unwrap();
        assert_eq!(ev_ap["type"], "ap_granted");
        assert_eq!(ev_ap["delta"], 100);

        // 2) AP設定更新で ap_config_updated がブロードキャストされる
        while bcast_rx.try_recv().is_ok() {}
        let mut next_cfg = state.current_ap_config();
        next_cfg.max_ap = 120;
        assert_eq!(
            admin_update_ap_config(
                ConnectInfo(addr),
                State(state.clone()),
                adm_headers.clone(),
                Json(next_cfg),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let ev_cfg: serde_json::Value = serde_json::from_slice(&bcast_rx.try_recv().unwrap()[1..]).unwrap();
        assert_eq!(ev_cfg["type"], "ap_config_updated");
        assert_eq!(ev_cfg["ap_config"]["max_ap"], 120);

        // 3) 勢力削除で faction_deleted がセル差分より先にブロードキャストされる
        while bcast_rx.try_recv().is_ok() {}
        assert_eq!(
            admin_delete_faction(
                ConnectInfo(addr),
                State(state.clone()),
                adm_headers,
                Path(fid),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let first_frame = bcast_rx.try_recv().unwrap();
        assert_eq!(first_frame.first(), Some(&crate::protocol::OP_SERVER_EVENT_JSON));
        let ev_del: serde_json::Value = serde_json::from_slice(&first_frame[1..]).unwrap();
        assert_eq!(ev_del["type"], "faction_deleted");
        let second_frame = bcast_rx.try_recv().unwrap();
        assert_eq!(second_frame.first(), Some(&crate::protocol::OP_SERVER_CELL_DIFF));
    }

    #[tokio::test]
    async fn get_player_logs_filters_visibility_scope_faction_search_and_pagination() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let u1 = insert_test_user(&state.pool, "alpha_u1", "tok_alpha_u1").await;
        let u2 = insert_test_user(&state.pool, "alpha_u2", "tok_alpha_u2").await;
        let u3 = insert_test_user(&state.pool, "beta_u3", "tok_beta_u3").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_alpha_u1"),
            Json(CreateFactionPayload {
                name: "蒼空藩".into(),
                color_id: 1,
            }),
        )
        .await;
        let f1: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = '蒼空藩'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        join_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_alpha_u2"),
            Path(f1),
        )
        .await;

        create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_beta_u3"),
            Json(CreateFactionPayload {
                name: "紅蓮藩".into(),
                color_id: 2,
            }),
        )
        .await;
        let f2: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = '紅蓮藩'")
            .fetch_one(&state.pool)
            .await
            .unwrap();

        // 勢力1の内部限定ログを追加
        crate::db::record_player_log_with_visibility(
            &state.pool,
            1,
            u1,
            "alpha_u1",
            f1,
            "faction",
            "alpha_u2 の権限を変更した（開戦）",
            LOG_VISIBILITY_FACTION,
        )
        .await;
        // 検索・ページネーション用の公開ログを追加
        record_player_log(&state.pool, 1, u2, "alpha_u2", f1, "territory", "(10, 20) の空き地を塗った (-1 AP)").await;
        record_player_log(&state.pool, 1, u3, "beta_u3", f2, "territory", "(30, 40) の空き地を塗った (-1 AP)").await;

        let parse_logs = |resp: Response| async move {
            let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()
        };

        // 1) 未ログインは公開ログのみ（勢力限定ログは含まれない）
        let anon_json = parse_logs(
            get_player_logs(
                ConnectInfo(addr),
                State(state.clone()),
                HeaderMap::new(),
                axum::extract::Query(LogsQuery {
                    category: None,
                    limit: Some(50),
                    before_id: None,
                    after_id: None,
                    scope: None,
                    faction_id: None,
                    q: None,
                }),
            )
            .await,
        )
        .await;
        let anon_summaries: Vec<String> = anon_json["logs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["summary"].as_str().unwrap().to_string())
            .collect();
        assert!(!anon_summaries.iter().any(|s| s.contains("権限を変更した")));

        // 2) 他勢力メンバーにも勢力1の限定ログは見えない
        let beta_json = parse_logs(
            get_player_logs(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_beta_u3"),
                axum::extract::Query(LogsQuery {
                    category: None,
                    limit: Some(50),
                    before_id: None,
                    after_id: None,
                    scope: None,
                    faction_id: None,
                    q: None,
                }),
            )
            .await,
        )
        .await;
        let beta_summaries: Vec<String> = beta_json["logs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["summary"].as_str().unwrap().to_string())
            .collect();
        assert!(!beta_summaries.iter().any(|s| s.contains("権限を変更した")));

        // 3) 自勢力メンバーには勢力限定ログ（faction_only=true）が見える
        let alpha_json = parse_logs(
            get_player_logs(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_alpha_u2"),
                axum::extract::Query(LogsQuery {
                    category: None,
                    limit: Some(50),
                    before_id: None,
                    after_id: None,
                    scope: Some("faction".into()),
                    faction_id: None,
                    q: None,
                }),
            )
            .await,
        )
        .await;
        let alpha_logs = alpha_json["logs"].as_array().unwrap();
        assert!(alpha_logs
            .iter()
            .any(|v| v["summary"].as_str().unwrap().contains("権限を変更した") && v["faction_only"] == true));
        assert!(alpha_logs.iter().all(|v| v["faction_id"] == f1));

        // 4) scope=mine とキーワード検索・ページネーション
        let mine_json = parse_logs(
            get_player_logs(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_alpha_u2"),
                axum::extract::Query(LogsQuery {
                    category: None,
                    limit: Some(1),
                    before_id: None,
                    after_id: None,
                    scope: Some("mine".into()),
                    faction_id: None,
                    q: Some("空き地".into()),
                }),
            )
            .await,
        )
        .await;
        assert_eq!(mine_json["logs"].as_array().unwrap().len(), 1);
        assert_eq!(mine_json["logs"][0]["username"], "alpha_u2");
        assert_eq!(mine_json["has_more"], false);

        // 5) 2件以上ある条件で limit=2 ページネーション確認
        let p1 = parse_logs(
            get_player_logs(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_alpha_u1"),
                axum::extract::Query(LogsQuery {
                    category: None,
                    limit: Some(2),
                    before_id: None,
                    after_id: None,
                    scope: None,
                    faction_id: None,
                    q: None,
                }),
            )
            .await,
        )
        .await;
        assert_eq!(p1["logs"].as_array().unwrap().len(), 2);
        assert_eq!(p1["has_more"], true);
        let cursor = p1["next_before_id"].as_i64().unwrap();
        let p2 = parse_logs(
            get_player_logs(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_alpha_u1"),
                axum::extract::Query(LogsQuery {
                    category: None,
                    limit: Some(2),
                    before_id: Some(cursor),
                    after_id: None,
                    scope: None,
                    faction_id: None,
                    q: None,
                }),
            )
            .await,
        )
        .await;
        assert!(!p2["logs"].as_array().unwrap().is_empty());
        assert!(p2["logs"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["id"].as_i64().unwrap() < cursor));
    }

    #[tokio::test]
    async fn admin_force_war_ceasefire_and_leader_transfer_record_named_logs() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let _l1 = insert_test_user(&state.pool, "tr_l1", "tok_tr_l1").await;
        let _m1 = insert_test_user(&state.pool, "tr_m1", "tok_tr_m1").await;
        let _l2 = insert_test_user(&state.pool, "tr_l2", "tok_tr_l2").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_tr_l1"),
            Json(CreateFactionPayload {
                name: "東雲藩".into(),
                color_id: 1,
            }),
        )
        .await;
        let f1: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = '東雲藩'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        join_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_tr_m1"),
            Path(f1),
        )
        .await;
        leave_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_tr_l1"),
            Path(f1),
        )
        .await;

        create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_tr_l2"),
            Json(CreateFactionPayload {
                name: "西風藩".into(),
                color_id: 2,
            }),
        )
        .await;
        let f2: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = '西風藩'")
            .fetch_one(&state.pool)
            .await
            .unwrap();

        let adm_tok = "adm_log_tok".to_string();
        let exp = (Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        sqlx::query("INSERT INTO admin_sessions (token, admin_id, created_at, expires_at) VALUES (?, 'admin', ?, ?)")
            .bind(&adm_tok)
            .bind(Utc::now().to_rfc3339())
            .bind(&exp)
            .execute(&state.pool)
            .await
            .unwrap();
        state.cache_admin_session(adm_tok.clone(), "admin".into(), Utc::now().timestamp() + 3600);
        let mut adm_headers = HeaderMap::new();
        adm_headers.insert(header::COOKIE, HeaderValue::from_str(&format!("teien_admin_session={}", adm_tok)).unwrap());

        assert_eq!(
            admin_force_war(
                ConnectInfo(addr),
                State(state.clone()),
                adm_headers.clone(),
                Json(AdminDiplomacyPairPayload { faction_a: f1, faction_b: f2 }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            admin_force_ceasefire(
                ConnectInfo(addr),
                State(state.clone()),
                adm_headers,
                Json(AdminDiplomacyPairPayload { faction_a: f1, faction_b: f2 }),
            )
            .await
            .status(),
            StatusCode::OK
        );

        let summaries: Vec<String> = sqlx::query_scalar("SELECT summary FROM player_logs ORDER BY id ASC")
            .fetch_all(&state.pool)
            .await
            .unwrap();
        assert!(summaries.iter().any(|s| s == "勢力「東雲藩」の新リーダーに就任した"));
        assert!(summaries.iter().any(|s| s == "管理者が勢力「東雲藩」と勢力「西風藩」を強制開戦させた"));
        assert!(summaries.iter().any(|s| s == "管理者が勢力「東雲藩」と勢力「西風藩」を強制停戦させた"));
    }

    #[tokio::test]
    async fn update_faction_settings_skips_noop_and_dedups_color_plus_policy() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let _leader = insert_test_user(&state.pool, "set_l", "tok_set_l").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_set_l"),
            Json(CreateFactionPayload {
                name: "SettingDedup".into(),
                color_id: 3,
            }),
        )
        .await;
        let fid: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = 'SettingDedup'")
            .fetch_one(&state.pool)
            .await
            .unwrap();

        let mut bcast_rx = state.broadcast_tx.subscribe();

        // 1) 変更なし -> faction_updated はブロードキャストされない
        let noop_resp = update_faction_settings(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_set_l"),
            Path(fid),
            Json(FactionSettingsPayload {
                allow_auto_paint: true,
                join_policy: Some(0),
                color_id: Some(3),
            }),
        )
        .await;
        assert_eq!(noop_resp.status(), StatusCode::OK);
        assert!(
            bcast_rx.try_recv().is_err(),
            "実質変更なしの場合は faction_updated をブロードキャストしないべきです"
        );

        // 2) color_id + join_policy 同時変更 -> faction_updated が1回だけ送られ、両フィールドを含む
        let both_resp = update_faction_settings(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_set_l"),
            Path(fid),
            Json(FactionSettingsPayload {
                allow_auto_paint: true,
                join_policy: Some(1),
                color_id: Some(8),
            }),
        )
        .await;
        assert_eq!(both_resp.status(), StatusCode::OK);

        let mut updates = Vec::new();
        while let Ok(frame) = bcast_rx.try_recv() {
            if frame.first() == Some(&crate::protocol::OP_SERVER_EVENT_JSON) {
                let ev: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
                if ev["type"] == "faction_updated" {
                    updates.push(ev);
                }
            }
        }
        assert_eq!(updates.len(), 1, "同時変更時は faction_updated を1回だけ送るべきです");
        assert_eq!(updates[0]["color_id"], 8);
        assert_eq!(updates[0]["join_policy"], 1);
    }

    #[tokio::test]
    async fn join_empty_faction_promotes_leader_with_notification_and_log() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let _old_leader = insert_test_user(&state.pool, "old_l", "tok_old_l").await;
        let newcomer = insert_test_user(&state.pool, "new_l", "tok_new_l").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_old_l"),
            Json(CreateFactionPayload {
                name: "無人予定国".into(),
                color_id: 9,
            }),
        )
        .await;
        let fid: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = '無人予定国'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        leave_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_old_l"),
            Path(fid),
        )
        .await;

        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        state.register_ws_user_sender(newcomer, "tok_new_l".to_string(), tx);

        let join_resp = join_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_new_l"),
            Path(fid),
        )
        .await;
        assert_eq!(join_resp.status(), StatusCode::OK);

        let frame = rx.try_recv().expect("無人勢力参加時にリーダー就任通知が届くべきです");
        assert_eq!(frame.first(), Some(&crate::protocol::OP_SERVER_EVENT_JSON));
        let ev: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
        assert_eq!(ev["type"], "faction_leader_transferred");
        assert_eq!(ev["faction_id"], fid);
        assert_eq!(ev["new_leader_user_id"], newcomer);
        assert_eq!(ev["new_leader_username"], "new_l");

        let summaries: Vec<String> = sqlx::query_scalar("SELECT summary FROM player_logs")
            .fetch_all(&state.pool)
            .await
            .unwrap();
        assert!(summaries.iter().any(|s| s == "勢力「無人予定国」の新リーダーに就任した"));
    }

    #[tokio::test]
    async fn admin_delete_user_notifies_deleted_user_and_faction_members() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let leader = insert_test_user(&state.pool, "del_l", "tok_del_l").await;
        let member = insert_test_user(&state.pool, "del_m", "tok_del_m").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_del_l"),
            Json(CreateFactionPayload {
                name: "削除通知国".into(),
                color_id: 12,
            }),
        )
        .await;
        let fid: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = '削除通知国'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        join_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_del_m"),
            Path(fid),
        )
        .await;

        let (tx_l, mut rx_l) = tokio::sync::mpsc::channel(8);
        let (tx_m, mut rx_m) = tokio::sync::mpsc::channel(8);
        state.register_ws_user_sender(leader, "tok_del_l".to_string(), tx_l);
        state.register_ws_user_sender(member, "tok_del_m".to_string(), tx_m);

        state.cache_admin_session(
            "adm_del_u".to_string(),
            "admin".to_string(),
            Utc::now().timestamp() + 3600,
        );
        let mut adm_headers = HeaderMap::new();
        adm_headers.insert("x-admin-token", HeaderValue::from_static("adm_del_u"));

        let resp = admin_delete_user(
            ConnectInfo(addr),
            State(state.clone()),
            adm_headers,
            Path(member),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let f_self = rx_m.try_recv().expect("削除本人へ再同期イベントが届くべきです");
        let ev_self: serde_json::Value = serde_json::from_slice(&f_self[1..]).unwrap();
        assert_eq!(ev_self["type"], "metadata_resync_required");

        let f_leader = rx_l.try_recv().expect("残存メンバーへ脱退通知が届くべきです");
        let ev_leader: serde_json::Value = serde_json::from_slice(&f_leader[1..]).unwrap();
        assert_eq!(ev_leader["type"], "faction_member_left");
        assert_eq!(ev_leader["faction_id"], fid);
        assert_eq!(ev_leader["faction_name"], "削除通知国");
        assert_eq!(ev_leader["user_id"], member);
        assert_eq!(ev_leader["username"], "del_m");
    }

    #[tokio::test]
    async fn get_player_logs_matches_target_faction_id_and_after_id_and_admin_config_logs() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let u1 = insert_test_user(&state.pool, "tf_u1", "tok_tf_u1").await;
        let u2 = insert_test_user(&state.pool, "tf_u2", "tok_tf_u2").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_tf_u1"),
            Json(CreateFactionPayload { name: "北星国".into(), color_id: 1 }),
        )
        .await;
        let f1: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = '北星国'")
            .fetch_one(&state.pool)
            .await
            .unwrap();

        create_faction(
            ConnectInfo(addr),
            State(state.clone()),
            auth_headers("tok_tf_u2"),
            Json(CreateFactionPayload { name: "南十字国".into(), color_id: 2 }),
        )
        .await;
        let f2: i64 = sqlx::query_scalar("SELECT id FROM factions WHERE name = '南十字国'")
            .fetch_one(&state.pool)
            .await
            .unwrap();

        // 勢力1の内部限定ログ（勢力2には見えてはいけない）
        crate::db::record_player_log_with_visibility(
            &state.pool,
            1,
            u1,
            "tf_u1",
            f1,
            "faction",
            "内部権限を更新した",
            LOG_VISIBILITY_FACTION,
        )
        .await;

        // 勢力1が勢力2の領土を奪取した公開ログ（target_faction_id = f2）
        crate::db::record_player_log_with_target(
            &state.pool,
            1,
            u1,
            "tf_u1",
            f1,
            f2,
            "territory",
            "(10, 10) の「南十字国」領土を奪った (-1 AP)",
        )
        .await;

        let parse_logs = |resp: Response| async move {
            let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()
        };

        // 勢力2が scope=faction で取得すると、相手（勢力1）による奪取ログが含まれ、勢力1の限定ログは含まれない
        let f2_json = parse_logs(
            get_player_logs(
                ConnectInfo(addr),
                State(state.clone()),
                auth_headers("tok_tf_u2"),
                axum::extract::Query(LogsQuery {
                    category: None,
                    limit: Some(50),
                    before_id: None,
                    after_id: None,
                    scope: Some("faction".into()),
                    faction_id: None,
                    q: None,
                }),
            )
            .await,
        )
        .await;
        let f2_logs = f2_json["logs"].as_array().unwrap();
        assert!(f2_logs
            .iter()
            .any(|v| v["summary"].as_str().unwrap().contains("南十字国」領土を奪った") && v["target_faction_id"] == f2));
        assert!(!f2_logs
            .iter()
            .any(|v| v["summary"].as_str().unwrap().contains("内部権限を更新した")));

        let latest_id = f2_logs[0]["id"].as_i64().unwrap();

        // 管理者設定変更（AP・コスト・ルール）を実行して system ログが増えること、after_id で差分取得できることを検証
        let adm_tok = "adm_cfg_tok".to_string();
        let exp = (Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        sqlx::query("INSERT INTO admin_sessions (token, admin_id, created_at, expires_at) VALUES (?, 'admin', ?, ?)")
            .bind(&adm_tok)
            .bind(Utc::now().to_rfc3339())
            .bind(&exp)
            .execute(&state.pool)
            .await
            .unwrap();
        state.cache_admin_session(adm_tok.clone(), "admin".into(), Utc::now().timestamp() + 3600);
        let mut adm_headers = HeaderMap::new();
        adm_headers.insert(header::COOKIE, HeaderValue::from_str(&format!("teien_admin_session={}", adm_tok)).unwrap());

        assert_eq!(
            admin_update_ap_config(
                ConnectInfo(addr),
                State(state.clone()),
                adm_headers.clone(),
                Json(crate::state::ApConfig::default()),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            admin_update_cost_config(
                ConnectInfo(addr),
                State(state.clone()),
                adm_headers.clone(),
                Json(crate::board::CostConfig::default()),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            admin_update_rules_config(
                ConnectInfo(addr),
                State(state.clone()),
                adm_headers,
                Json(crate::board::GameRulesConfig::default()),
            )
            .await
            .status(),
            StatusCode::OK
        );

        let diff_json = parse_logs(
            get_player_logs(
                ConnectInfo(addr),
                State(state.clone()),
                HeaderMap::new(),
                axum::extract::Query(LogsQuery {
                    category: Some("system".into()),
                    limit: Some(50),
                    before_id: None,
                    after_id: Some(latest_id),
                    scope: None,
                    faction_id: None,
                    q: None,
                }),
            )
            .await,
        )
        .await;
        let diff_summaries: Vec<String> = diff_json["logs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["summary"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(diff_summaries.len(), 3);
        assert!(diff_summaries.iter().any(|s| s.contains("AP 設定を変更した")));
        assert!(diff_summaries.iter().any(|s| s.contains("コスト設定を変更した")));
        assert!(diff_summaries.iter().any(|s| s.contains("ゲームルールを変更した")));
        let _ = u2;
    }

    #[tokio::test]
    async fn admin_get_logs_requires_auth_and_returns_all_faction_private_logs() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let u1 = insert_test_user(&state.pool, "aud_u1", "tok_aud_u1").await;
        let u2 = insert_test_user(&state.pool, "aud_u2", "tok_aud_u2").await;
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        // 1) 未認証時は 401
        let unauth = admin_get_logs(
            ConnectInfo(addr),
            State(state.clone()),
            HeaderMap::new(),
            axum::extract::Query(AdminLogsQuery {
                category: None,
                limit: None,
                before_id: None,
                after_id: None,
                faction_id: None,
                visibility: None,
                season_id: None,
                q: None,
            }),
        )
        .await;
        assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);

        // 勢力1・勢力2それぞれの勢力限定ログと公開ログを挿入
        crate::db::record_player_log_with_visibility(
            &state.pool, 1, u1, "aud_u1", 1, "faction", "勢力1の内部権限変更", LOG_VISIBILITY_FACTION,
        ).await;
        crate::db::record_player_log_with_visibility(
            &state.pool, 1, u2, "aud_u2", 2, "faction", "勢力2の参加申請拒否", LOG_VISIBILITY_FACTION,
        ).await;
        crate::db::record_player_log(
            &state.pool, 1, u1, "aud_u1", 1, "territory", "(5, 5) の空き地を塗った (-1 AP)",
        ).await;
        // 別シーズンのログ
        crate::db::record_player_log(
            &state.pool, 2, 0, "システム", 0, "system", "シーズン #2 が開始された",
        ).await;

        let adm_tok = "adm_audit_tok".to_string();
        let exp = (Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        sqlx::query("INSERT INTO admin_sessions (token, admin_id, created_at, expires_at) VALUES (?, 'admin', ?, ?)")
            .bind(&adm_tok)
            .bind(Utc::now().to_rfc3339())
            .bind(&exp)
            .execute(&state.pool)
            .await
            .unwrap();
        state.cache_admin_session(adm_tok.clone(), "admin".into(), Utc::now().timestamp() + 3600);
        let mut adm_headers = HeaderMap::new();
        adm_headers.insert(header::COOKIE, HeaderValue::from_str(&format!("teien_admin_session={}", adm_tok)).unwrap());

        let parse = |resp: Response| async move {
            let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()
        };

        // 2) visibility=faction で全勢力の限定ログが取得できる
        let priv_json = parse(
            admin_get_logs(
                ConnectInfo(addr),
                State(state.clone()),
                adm_headers.clone(),
                axum::extract::Query(AdminLogsQuery {
                    category: None,
                    limit: Some(50),
                    before_id: None,
                    after_id: None,
                    faction_id: None,
                    visibility: Some("faction".into()),
                    season_id: None,
                    q: None,
                }),
            )
            .await,
        )
        .await;
        let priv_summaries: Vec<String> = priv_json["logs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["summary"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(priv_summaries.len(), 2);
        assert!(priv_summaries.iter().any(|s| s == "勢力1の内部権限変更"));
        assert!(priv_summaries.iter().any(|s| s == "勢力2の参加申請拒否"));

        // 3) season_id=0 で全シーズン検索、available_seasons に [2, 1] が含まれる
        let all_seasons_json = parse(
            admin_get_logs(
                ConnectInfo(addr),
                State(state.clone()),
                adm_headers,
                axum::extract::Query(AdminLogsQuery {
                    category: None,
                    limit: Some(50),
                    before_id: None,
                    after_id: None,
                    faction_id: None,
                    visibility: None,
                    season_id: Some(0),
                    q: Some("シーズン #2".into()),
                }),
            )
            .await,
        )
        .await;
        assert_eq!(all_seasons_json["logs"].as_array().unwrap().len(), 1);
        assert_eq!(all_seasons_json["logs"][0]["season_id"], 2);
        let seasons: Vec<i64> = all_seasons_json["available_seasons"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_i64().unwrap())
            .collect();
        assert!(seasons.contains(&1) && seasons.contains(&2));
    }

    #[tokio::test]
    async fn admin_update_ap_config_clamps_users_to_effective_max_ap_during_endgame_boost() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(test_config(), pool, board, params, 1));
        *state.phase_override.write() = Some(SeasonPhase::Active);
        {
            let mut rules = state.game_rules.write();
            rules.max_ticks = 10;
        }
        // Tick 9/10（残り10% <= 20%）で終盤ブースト発動中
        *state.manual_tick_offset.write() = 9;

        let u1 = insert_test_user(&state.pool, "u_boost_clamp", "tok_bc").await;
        sqlx::query("UPDATE users SET ap = 180 WHERE id = ?")
            .bind(u1)
            .execute(&state.pool)
            .await
            .unwrap();

        state.cache_admin_session(
            "adm_bc_tok".to_string(),
            "admin".to_string(),
            Utc::now().timestamp() + 3600,
        );
        let mut adm_headers = HeaderMap::new();
        adm_headers.insert("x-admin-token", HeaderValue::from_static("adm_bc_tok"));
        let addr: SocketAddr = "127.0.0.1:12345".parse().unwrap();

        let mut bcast_rx = state.broadcast_tx.subscribe();
        let mut cfg = state.current_ap_config();
        cfg.max_ap = 80; // 倍率 2.0 なので実効上限は 160（ベース 80 ではない）
        cfg.endgame_threshold_pct = 20;
        cfg.endgame_ap_multiplier = 2.0;

        let resp = admin_update_ap_config(
            ConnectInfo(addr),
            State(state.clone()),
            adm_headers,
            Json(cfg),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let ap_after: i64 = sqlx::query_scalar("SELECT ap FROM users WHERE id = ?")
            .bind(u1)
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(
            ap_after, 160,
            "終盤ブースト中の AP 設定変更ではベース上限ではなく実効上限 160 でクランプされるべきです"
        );

        let ev: serde_json::Value = serde_json::from_slice(&bcast_rx.try_recv().unwrap()[1..]).unwrap();
        assert_eq!(ev["type"], "ap_config_updated");
        assert_eq!(ev["effective_max_ap"], 160);
        assert_eq!(ev["endgame_boost"], true);
    }
}

