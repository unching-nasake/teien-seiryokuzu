use crate::auth::{hash_password, LoginLockout, RateLimiter};
use crate::board::{ActionMode, Board, CostConfig, GameRulesConfig};
use crate::config::Config;
use crate::db::{
    begin_immediate, build_new_board_in_memory, load_or_init_board, load_setting_strict,
    persist_board_in_tx, record_player_log_tx, save_chunks_batch, war_pair,
};
use crate::map_gen::MapGenParams;
use crate::protocol::{encode_cell_diff_batch, encode_event_json, encode_tick_sync};
use crate::season::{
    compute_cycle_id, compute_phase_jst_with_schedule, compute_tick_number_with_schedule,
    current_season_end_boundary_at, is_ap_refill_minute_with_schedule,
    is_season_end_boundary_minute, is_season_start_minute, next_ap_refill_unix_with_schedule,
    SeasonPhase, SeasonSchedule, SCHEDULE_CATCHUP_GRACE_MINUTES,
};
use crate::tick::run_board_tick_with_rules;
use axum::body::Bytes;
use chrono::{Timelike, Utc};
use dashmap::DashMap;
use flate2::write::GzEncoder;
use flate2::Compression;
use parking_lot::{Mutex, RwLock};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{broadcast, mpsc, watch, Notify};

pub const DEFAULT_INITIAL_AP: i64 = 30;
pub const DEFAULT_MAX_AP: i64 = 100;
pub const DEFAULT_TICK_AP_MIN: i64 = 6;
pub const DEFAULT_TICK_AP_MAX: i64 = 12;
pub const DEFAULT_FACTION_NAME_MAX_LEN: usize = 20;
pub const MAX_SESSION_CACHE_ENTRIES: usize = 10_000;
pub const MAX_WS_TOTAL: usize = 2_000;
pub const MAX_WS_PER_IP: usize = 10;
pub const MAX_WS_PER_USER: usize = 5;
/// Argon2id 同時ハッシュ・検証の上限数（OOM 防止）
pub const MAX_CONCURRENT_ARGON2: usize = 8;
/// 1シーズンあたりのタイムラプス保存フレーム上限数
pub const MAX_TIMELAPSE_FRAMES_PER_SEASON: i64 = 500;
/// 敵中核マス奪取アラートの同一攻撃・防衛ペア間クールダウン（秒）
pub const CORE_ATTACK_ALERT_COOLDOWN_SECS: u64 = 30;

pub const DEFAULT_ENDGAME_THRESHOLD_PCT: u8 = 20;
pub const DEFAULT_ENDGAME_AP_MULTIPLIER: f64 = 2.0;

fn default_endgame_threshold_pct() -> u8 {
    DEFAULT_ENDGAME_THRESHOLD_PCT
}

fn default_endgame_ap_multiplier() -> f64 {
    DEFAULT_ENDGAME_AP_MULTIPLIER
}

/// 管理者コンソールから動的に変更可能な AP・補充スケジュール設定
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(try_from = "ApConfigWire")]
pub struct ApConfig {
    pub initial_ap_min: i64,
    pub initial_ap_max: i64,
    pub max_ap: i64,
    pub refill_interval_minutes: u32,
    pub refill_offset_minute: u32,
    pub refill_min: i64,
    pub refill_max: i64,
    pub endgame_threshold_pct: u8,
    pub endgame_ap_multiplier: f64,
}

#[derive(Deserialize)]
struct ApConfigWire {
    #[serde(default)]
    initial_ap: Option<i64>,
    #[serde(default)]
    initial_ap_min: Option<i64>,
    #[serde(default)]
    initial_ap_max: Option<i64>,
    max_ap: i64,
    refill_interval_minutes: u32,
    refill_offset_minute: u32,
    refill_min: i64,
    refill_max: i64,
    #[serde(default = "default_endgame_threshold_pct")]
    endgame_threshold_pct: u8,
    #[serde(default = "default_endgame_ap_multiplier")]
    endgame_ap_multiplier: f64,
}

impl TryFrom<ApConfigWire> for ApConfig {
    type Error = String;

    fn try_from(wire: ApConfigWire) -> Result<Self, Self::Error> {
        let (initial_ap_min, initial_ap_max) = match (wire.initial_ap_min, wire.initial_ap_max) {
            (Some(min), Some(max)) => (min, max),
            (None, None) => match wire.initial_ap {
                Some(v) => (v, v),
                None => return Err("initial_ap_min / initial_ap_max が指定されていません".into()),
            },
            _ => {
                return Err(
                    "initial_ap_min と initial_ap_max は両方指定してください".into(),
                )
            }
        };
        Ok(Self {
            initial_ap_min,
            initial_ap_max,
            max_ap: wire.max_ap,
            refill_interval_minutes: wire.refill_interval_minutes,
            refill_offset_minute: wire.refill_offset_minute,
            refill_min: wire.refill_min,
            refill_max: wire.refill_max,
            endgame_threshold_pct: wire.endgame_threshold_pct,
            endgame_ap_multiplier: wire.endgame_ap_multiplier,
        })
    }
}

impl Default for ApConfig {
    fn default() -> Self {
        Self {
            initial_ap_min: DEFAULT_INITIAL_AP,
            initial_ap_max: DEFAULT_INITIAL_AP,
            max_ap: DEFAULT_MAX_AP,
            refill_interval_minutes: 60,
            refill_offset_minute: 0,
            refill_min: DEFAULT_TICK_AP_MIN,
            refill_max: DEFAULT_TICK_AP_MAX,
            endgame_threshold_pct: DEFAULT_ENDGAME_THRESHOLD_PCT,
            endgame_ap_multiplier: DEFAULT_ENDGAME_AP_MULTIPLIER,
        }
    }
}

impl ApConfig {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=1000).contains(&self.max_ap) {
            return Err("AP上限は 1〜1000 の範囲で指定してください".into());
        }
        if self.initial_ap_min < 0
            || self.initial_ap_max > self.max_ap
            || self.initial_ap_min > self.initial_ap_max
        {
            return Err(format!(
                "初期APランダム範囲は 0 <= 最小 <= 最大 <= {}（AP上限）となるように指定してください",
                self.max_ap
            ));
        }
        if !(1..=1440).contains(&self.refill_interval_minutes) {
            return Err("AP補充頻度は 1〜1440 分の範囲で指定してください".into());
        }
        if self.refill_offset_minute >= 60 {
            return Err("AP補充基準分は 0〜59 分の範囲で指定してください".into());
        }
        if self.refill_min < 0 || self.refill_max > self.max_ap || self.refill_min > self.refill_max
        {
            return Err(
                "AP補充ランダム範囲は 0 <= 最小 <= 最大 <= AP上限 となるように指定してください"
                    .into(),
            );
        }
        if self.endgame_threshold_pct > 100 {
            return Err("終盤APブースト発動ライン（残り%）は 0〜100 の範囲で指定してください".into());
        }
        if !(1.0..=10.0).contains(&self.endgame_ap_multiplier)
            || !self.endgame_ap_multiplier.is_finite()
        {
            return Err("終盤APブースト倍率は 1.0〜10.0 の範囲で指定してください".into());
        }
        Ok(())
    }

    /// 終盤ブースト適用有無に応じた実効 (max_ap, refill_min, refill_max) を返す
    pub fn effective_bounds(&self, boost_active: bool) -> (i64, i64, i64) {
        if !boost_active || self.endgame_threshold_pct == 0 || self.endgame_ap_multiplier <= 1.0 {
            return (self.max_ap, self.refill_min, self.refill_max);
        }
        let eff_max = ((self.max_ap as f64) * self.endgame_ap_multiplier)
            .round()
            .max(1.0) as i64;
        let eff_min = ((self.refill_min as f64) * self.endgame_ap_multiplier)
            .round()
            .clamp(0.0, eff_max as f64) as i64;
        let eff_refill_max = ((self.refill_max as f64) * self.endgame_ap_multiplier)
            .round()
            .clamp(eff_min as f64, eff_max as f64) as i64;
        (eff_max, eff_min, eff_refill_max)
    }

    /// 設定範囲内から初期APをランダムに1つ抽選する
    pub fn roll_initial_ap(&self) -> i64 {
        let lo = self.initial_ap_min.clamp(0, self.max_ap);
        let hi = self.initial_ap_max.clamp(lo, self.max_ap);
        if lo >= hi {
            lo
        } else {
            rand::thread_rng().gen_range(lo..=hi)
        }
    }
}

/// 盤面スナップショットのインメモリ gzip キャッシュ
pub struct CachedSnapshot {
    pub version: u64,
    pub board_size: usize,
    pub gz_bytes: Bytes,
    pub cached_at: Instant,
}

/// 個別ユーザー WebSocket 送信チャネルと溢れ通知状態
pub struct WsDirectSender {
    pub conn_id: u64,
    pub token: String,
    pub expires_at_unix: i64,
    pub tx: mpsc::Sender<Bytes>,
    pub overflowed: Arc<AtomicBool>,
    pub overflow_notify: Arc<Notify>,
}

/// 勢力一覧 JSON のインメモリキャッシュ有効期間（秒）
pub const FACTIONS_CACHE_TTL_SECS: u64 = 2;

/// サーバー全体で共有されるアプリケーション状態
pub struct AppState {
    pub config: Config,
    pub pool: SqlitePool,
    pub board: RwLock<Board>,
    pub map_params: RwLock<MapGenParams>,
    pub ap_config: RwLock<ApConfig>,
    pub cost_config: RwLock<CostConfig>,
    pub game_rules: RwLock<GameRulesConfig>,
    pub faction_name_max_len: AtomicUsize,
    pub season_id: AtomicI64,
    pub season_cycle_id: AtomicI64,
    pub auto_frozen_season_id: AtomicI64,
    pub phase_override: RwLock<Option<SeasonPhase>>,
    pub manual_tick_offset: RwLock<u16>,
    pub last_synced_phase: Mutex<Option<(i64, SeasonPhase)>>,
    pub broadcast_tx: broadcast::Sender<Bytes>,
    pub shutdown_tx: watch::Sender<bool>,
    pub ws_shutdown_notify: Notify,
    pub session_invalidation_notify: Notify,
    pub argon2_semaphore: tokio::sync::Semaphore,
    pub admin_password_hash: Option<String>,
    pub ip_limiter: RateLimiter,
    pub account_limiter: RateLimiter,
    pub register_limiter: RateLimiter,
    pub login_limiter: RateLimiter,
    pub login_account_limiter: RateLimiter,
    pub admin_login_limiter: RateLimiter,
    pub admin_global_login_limiter: RateLimiter,
    pub read_limiter: RateLimiter,
    pub ws_handshake_limiter: RateLimiter,
    pub recolor_limiter: RateLimiter,
    pub admin_lockout: LoginLockout,
    pub faction_color_cooldown: DashMap<i64, Instant>,
    pub core_attack_alert_cooldown: DashMap<(u16, u16), Instant>,
    pub session_cache: DashMap<String, (i64, i64)>,
    pub admin_session_cache: DashMap<String, (String, i64)>,
    pub session_cache_epoch: AtomicU64,
    pub admin_session_cache_epoch: AtomicU64,
    pub session_cache_lock: Mutex<()>,
    pub action_mutex: tokio::sync::Mutex<()>,
    pub timelapse_write_lock: tokio::sync::Mutex<()>,
    pub map_generation: AtomicU64,
    pub snapshot_refresh_lock: tokio::sync::Mutex<()>,
    pub snapshot_cache: parking_lot::RwLock<Option<CachedSnapshot>>,
    pub snapshot_version: AtomicU64,
    pub factions_cache: parking_lot::RwLock<Option<(i64, Instant, Bytes)>>,
    pub factions_cache_epoch: AtomicU64,
    pub online_count: AtomicUsize,
    pub ws_ip_counts: DashMap<String, usize>,
    pub ws_user_counts: DashMap<i64, usize>,
    pub ws_user_senders: DashMap<i64, Vec<WsDirectSender>>,
    ws_conn_seq: AtomicU64,
}

#[derive(Serialize, Debug, Clone)]
pub struct TickSummary {
    pub tick_number: u16,
    pub promoted_cores: usize,
    pub expired_old_cores: usize,
    pub changed_cell_count: usize,
    pub newly_extinct_factions: Vec<i64>,
}

/// 自動塗りシミュレーション結果（DB・盤面反映前）
struct AutoPaintSimulation {
    updated_cells: Vec<crate::board::Cell>,
    changed_cells: Vec<(u16, u16, crate::board::Cell)>,
    user_updates: Vec<(i64, String, i64, i64, usize)>,
    core_increments: HashMap<i64, i64>,
    painted_factions: HashSet<i64>,
    captured_enemy_cores: HashMap<(u16, u16), (u16, u16)>,
}

/// `"bucket:hour"` 形式の文字列から時間バケット値を取り出す
fn parse_hour_bucket(raw: &str) -> Option<i64> {
    let (bucket, hour) = raw.trim().split_once(':')?;
    let bucket_val = bucket.parse::<i64>().ok()?;
    let hour_val = hour.parse::<u32>().ok()?;
    if hour_val >= 24 {
        return None;
    }
    Some(bucket_val)
}

/// 既存トランザクション内で game_settings テーブルへ設定値を保存する
async fn save_setting_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    key: &str,
    value: &str,
) -> Result<(), String> {
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
    .await
    .map_err(|e| format!("設定({})の保存失敗: {}", key, e))?;
    Ok(())
}

impl AppState {
    pub fn new(
        mut config: Config,
        pool: SqlitePool,
        board: Board,
        map_params: MapGenParams,
        season_id: i64,
    ) -> Self {
        let (broadcast_tx, _) = broadcast::channel(4096);
        let (shutdown_tx, _) = watch::channel(false);
        // 管理者パスワードは起動時に1回だけ Argon2id ハッシュ化し、Config 内の平文は即座に消去する
        let admin_password_hash = config.take_admin_password().map(|pw| {
            hash_password(&pw).expect("管理者パスワードのハッシュ化に失敗しました")
        });
        Self {
            config,
            pool,
            board: RwLock::new(board),
            map_params: RwLock::new(map_params),
            ap_config: RwLock::new(ApConfig::default()),
            cost_config: RwLock::new(CostConfig::default()),
            game_rules: RwLock::new(GameRulesConfig::default()),
            faction_name_max_len: AtomicUsize::new(DEFAULT_FACTION_NAME_MAX_LEN),
            season_id: AtomicI64::new(season_id),
            season_cycle_id: AtomicI64::new(season_id),
            auto_frozen_season_id: AtomicI64::new(0),
            phase_override: RwLock::new(None),
            manual_tick_offset: RwLock::new(0),
            last_synced_phase: Mutex::new(None),
            broadcast_tx,
            shutdown_tx,
            ws_shutdown_notify: Notify::new(),
            session_invalidation_notify: Notify::new(),
            argon2_semaphore: tokio::sync::Semaphore::new(MAX_CONCURRENT_ARGON2),
            admin_password_hash,
            ip_limiter: RateLimiter::new(10),
            account_limiter: RateLimiter::new(10),
            register_limiter: RateLimiter::with_burst(3.0, 3.0 / 600.0),
            login_limiter: RateLimiter::with_burst(10.0, 10.0 / 60.0),
            login_account_limiter: RateLimiter::with_burst(10.0, 10.0 / 300.0),
            admin_login_limiter: RateLimiter::with_burst(5.0, 5.0 / 300.0),
            admin_global_login_limiter: RateLimiter::with_burst(15.0, 15.0 / 300.0),
            read_limiter: RateLimiter::with_burst(40.0, 20.0),
            ws_handshake_limiter: RateLimiter::with_burst(20.0, 5.0),
            recolor_limiter: RateLimiter::with_burst(5.0, 1.0),
            admin_lockout: LoginLockout::new(5, std::time::Duration::from_secs(900)),
            faction_color_cooldown: DashMap::new(),
            core_attack_alert_cooldown: DashMap::new(),
            session_cache: DashMap::new(),
            admin_session_cache: DashMap::new(),
            session_cache_epoch: AtomicU64::new(0),
            admin_session_cache_epoch: AtomicU64::new(0),
            session_cache_lock: Mutex::new(()),
            action_mutex: tokio::sync::Mutex::new(()),
            timelapse_write_lock: tokio::sync::Mutex::new(()),
            map_generation: AtomicU64::new(0),
            snapshot_refresh_lock: tokio::sync::Mutex::new(()),
            snapshot_cache: parking_lot::RwLock::new(None),
            snapshot_version: AtomicU64::new(0),
            factions_cache: parking_lot::RwLock::new(None),
            factions_cache_epoch: AtomicU64::new(0),
            online_count: AtomicUsize::new(0),
            ws_ip_counts: DashMap::new(),
            ws_user_counts: DashMap::new(),
            ws_user_senders: DashMap::new(),
            ws_conn_seq: AtomicU64::new(1),
        }
    }

    /// シャットダウン通知用の Receiver を購読する
    pub fn subscribe_shutdown(&self) -> watch::Receiver<bool> {
        self.shutdown_tx.subscribe()
    }

    /// サーバーがシャットダウン処理中かどうかを返す
    pub fn is_shutting_down(&self) -> bool {
        *self.shutdown_tx.borrow()
    }

    /// 全タスクおよび WebSocket 接続へシャットダウンを通知する
    pub fn trigger_shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
        self.ws_shutdown_notify.notify_waiters();
    }

    /// Argon2id 同時実行数制限セマフォからパーミットを取得する（3秒でタイムアウト）
    pub async fn acquire_argon2_permit(&self) -> Option<tokio::sync::SemaphorePermit<'_>> {
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            self.argon2_semaphore.acquire(),
        )
        .await
        .ok()
        .and_then(Result::ok)
    }

    /// ユーザー単位の WebSocket 送信チャネルを登録し、接続IDを返す（テスト・簡易登録用）
    #[allow(dead_code)]
    pub fn register_ws_user_sender(
        &self,
        user_id: i64,
        token: String,
        tx: mpsc::Sender<Bytes>,
    ) -> u64 {
        self.register_ws_user_sender_with_overflow(
            user_id,
            token,
            i64::MAX,
            tx,
            Arc::new(AtomicBool::new(false)),
            Arc::new(Notify::new()),
        )
    }

    /// 溢れ検知フラグ付きのユーザー単位 WebSocket 送信チャネルを登録し、接続IDを返す
    pub fn register_ws_user_sender_with_overflow(
        &self,
        user_id: i64,
        token: String,
        expires_at_unix: i64,
        tx: mpsc::Sender<Bytes>,
        overflowed: Arc<AtomicBool>,
        overflow_notify: Arc<Notify>,
    ) -> u64 {
        let conn_id = self.ws_conn_seq.fetch_add(1, Ordering::Relaxed);
        self.ws_user_senders
            .entry(user_id)
            .or_default()
            .push(WsDirectSender {
                conn_id,
                token,
                expires_at_unix,
                tx,
                overflowed,
                overflow_notify,
            });
        conn_id
    }

    /// ユーザー単位の WebSocket 送信チャネルを解除する
    pub fn unregister_ws_user_sender(&self, user_id: i64, conn_id: u64) {
        if let Some(mut entry) = self.ws_user_senders.get_mut(&user_id) {
            entry.retain(|s| s.conn_id != conn_id);
        }
        self.ws_user_senders
            .remove_if(&user_id, |_, list| list.is_empty());
    }

    /// 全クライアントへバイナリフレームをゼロコピーでブロードキャストする
    pub fn broadcast_frame(&self, payload: Vec<u8>) {
        let _ = self.broadcast_tx.send(Bytes::from(payload));
    }

    /// 最後に全体通知した (season_id, phase) を記録する
    pub fn record_synced_phase(&self, season_id: i64, phase: SeasonPhase) {
        *self.last_synced_phase.lock() = Some((season_id, phase));
    }

    /// 指定の (season_id, phase) が直近で全体同期済みかどうかを返す
    pub fn is_phase_already_synced(&self, season_id: i64, phase: SeasonPhase) -> bool {
        *self.last_synced_phase.lock() == Some((season_id, phase))
    }

    /// フェーズ・ティック同期フレームを全体ブロードキャストし、同期済みフェーズを記録する
    pub fn broadcast_tick_sync(
        &self,
        phase: SeasonPhase,
        tick_num: u16,
        ap: u16,
        next_tick_unix: i64,
        season_id: i64,
    ) {
        self.record_synced_phase(season_id, phase);
        self.broadcast_frame(encode_tick_sync(
            phase.as_u8(),
            tick_num,
            ap,
            next_tick_unix,
            season_id,
        ));
    }

    /// 個別 WS チャネルへ送信し、期限切れ・閉鎖時は false、送信成功または満杯溢れ通知時は true を返す
    fn try_send_direct(
        user_id: i64,
        sender: &WsDirectSender,
        payload: Bytes,
        now_unix: i64,
    ) -> bool {
        // TTL 自然失効済みの接続には定期掃除前でも即座に個別イベントを送らない
        if now_unix >= sender.expires_at_unix {
            return false;
        }
        match sender.tx.try_send(payload) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                tracing::warn!(
                    "個別 WebSocket 送信チャネルが満杯のため通知をドロップしました (user_id={}, conn_id={})",
                    user_id,
                    sender.conn_id
                );
                if !sender.overflowed.swap(true, Ordering::AcqRel) {
                    sender.overflow_notify.notify_one();
                }
                true
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }

    /// 指定ユーザーの全有効 WebSocket 接続へイベントペイロードを送信し、配信できた接続数を返す
    pub fn send_event_to_user(&self, user_id: i64, payload: Vec<u8>) -> usize {
        let shared = Bytes::from(payload);
        let now_unix = Utc::now().timestamp();
        let mut delivered = 0usize;
        if let Some(entry) = self.ws_user_senders.get(&user_id) {
            for sender in entry.value() {
                if Self::try_send_direct(user_id, sender, shared.clone(), now_unix) {
                    delivered += 1;
                }
            }
        }
        delivered
    }

    /// 複数ユーザーの各有効 WebSocket 接続へイベントペイロードを重複なく送信し、配信できた接続数を返す
    pub fn send_event_to_users(&self, user_ids: &[i64], payload: Vec<u8>) -> usize {
        let shared = Bytes::from(payload);
        let now_unix = Utc::now().timestamp();
        let mut delivered = 0usize;
        let mut seen = HashSet::with_capacity(user_ids.len());
        for &uid in user_ids {
            if seen.insert(uid) {
                if let Some(entry) = self.ws_user_senders.get(&uid) {
                    for sender in entry.value() {
                        if Self::try_send_direct(uid, sender, shared.clone(), now_unix) {
                            delivered += 1;
                        }
                    }
                }
            }
        }
        delivered
    }

    /// 現在のユーザーセッションキャッシュ世代番号を返す
    pub fn current_session_cache_epoch(&self) -> u64 {
        let _guard = self.session_cache_lock.lock();
        self.session_cache_epoch.load(Ordering::Acquire)
    }

    /// 現在の管理者セッションキャッシュ世代番号を返す
    pub fn current_admin_session_cache_epoch(&self) -> u64 {
        let _guard = self.session_cache_lock.lock();
        self.admin_session_cache_epoch.load(Ordering::Acquire)
    }

    /// session_cache_lock 保持中にユーザーセッションをキャッシュへ登録する（上限超過時は掃除またはクリア）
    fn cache_user_session_locked(&self, token: String, user_id: i64, expires_at_unix: i64) {
        if self.session_cache.len() >= MAX_SESSION_CACHE_ENTRIES {
            let now = Utc::now().timestamp();
            self.session_cache.retain(|_, (_, exp)| *exp > now);
            if self.session_cache.len() >= MAX_SESSION_CACHE_ENTRIES {
                self.session_cache.clear();
            }
        }
        self.session_cache.insert(token, (user_id, expires_at_unix));
    }

    /// session_cache_lock 保持中に管理者セッションをキャッシュへ登録する（上限超過時は掃除またはクリア）
    fn cache_admin_session_locked(&self, token: String, admin_id: String, expires_at_unix: i64) {
        if self.admin_session_cache.len() >= MAX_SESSION_CACHE_ENTRIES {
            let now = Utc::now().timestamp();
            self.admin_session_cache.retain(|_, (_, exp)| *exp > now);
            if self.admin_session_cache.len() >= MAX_SESSION_CACHE_ENTRIES {
                self.admin_session_cache.clear();
            }
        }
        self.admin_session_cache
            .insert(token, (admin_id, expires_at_unix));
    }

    /// ユーザーセッションをメモリキャッシュに登録する（テスト・互換用）
    #[cfg(test)]
    pub fn cache_user_session(&self, token: String, user_id: i64, expires_at_unix: i64) {
        let _guard = self.session_cache_lock.lock();
        self.cache_user_session_locked(token, user_id, expires_at_unix);
    }

    /// 管理者セッションをメモリキャッシュに登録する（テスト・互換用）
    #[allow(dead_code)]
    pub fn cache_admin_session(&self, token: String, admin_id: String, expires_at_unix: i64) {
        let _guard = self.session_cache_lock.lock();
        self.cache_admin_session_locked(token, admin_id, expires_at_unix);
    }

    /// 世代番号が expected_epoch と一致する場合のみユーザーセッションを原子的にキャッシュ登録する
    pub fn cache_user_session_if_epoch(
        &self,
        token: String,
        user_id: i64,
        expires_at_unix: i64,
        expected_epoch: u64,
    ) {
        let _guard = self.session_cache_lock.lock();
        if self.session_cache_epoch.load(Ordering::Acquire) != expected_epoch {
            return;
        }
        self.cache_user_session_locked(token, user_id, expires_at_unix);
    }

    /// 世代番号が expected_epoch と一致する場合のみ管理者セッションを原子的にキャッシュ登録する
    pub fn cache_admin_session_if_epoch(
        &self,
        token: String,
        admin_id: String,
        expires_at_unix: i64,
        expected_epoch: u64,
    ) {
        let _guard = self.session_cache_lock.lock();
        if self.admin_session_cache_epoch.load(Ordering::Acquire) != expected_epoch {
            return;
        }
        self.cache_admin_session_locked(token, admin_id, expires_at_unix);
    }

    /// 指定ユーザーセッションをキャッシュから即時失効させ、世代番号と該当トークンの WS 送信チャネルを解除する
    pub fn invalidate_user_session(&self, token: &str) {
        {
            let _guard = self.session_cache_lock.lock();
            self.session_cache_epoch.fetch_add(1, Ordering::AcqRel);
            self.session_cache.remove(token);
        }
        self.ws_user_senders.retain(|_, list| {
            list.retain(|s| s.token != token);
            !list.is_empty()
        });
        self.session_invalidation_notify.notify_waiters();
    }

    /// キャッシュまたは WS 送信チャネルに該当トークンが存在する場合のみユーザーセッションを失効させ、実行有無を返す
    pub fn invalidate_user_session_if_present(&self, token: &str) -> bool {
        let mut removed_ws = false;
        self.ws_user_senders.retain(|_, list| {
            let before = list.len();
            list.retain(|s| s.token != token);
            if list.len() != before {
                removed_ws = true;
            }
            !list.is_empty()
        });
        let removed_cache = {
            let _guard = self.session_cache_lock.lock();
            let removed = self.session_cache.remove(token).is_some();
            if removed || removed_ws {
                self.session_cache_epoch.fetch_add(1, Ordering::AcqRel);
            }
            removed
        };
        if removed_cache || removed_ws {
            self.session_invalidation_notify.notify_waiters();
            return true;
        }
        false
    }

    /// 全ユーザーセッションをキャッシュから即時失効させ、世代番号と全 WS 送信チャネルをクリアする
    pub fn invalidate_all_user_sessions(&self) {
        {
            let _guard = self.session_cache_lock.lock();
            self.session_cache_epoch.fetch_add(1, Ordering::AcqRel);
            self.session_cache.clear();
        }
        self.ws_user_senders.clear();
        self.session_invalidation_notify.notify_waiters();
    }

    /// 指定ユーザーの全セッションをキャッシュから即時失効させ、世代番号と該当ユーザーの WS 送信チャネルを解除する
    pub fn invalidate_user_sessions_by_uid(&self, uid: i64) {
        {
            let _guard = self.session_cache_lock.lock();
            self.session_cache_epoch.fetch_add(1, Ordering::AcqRel);
            self.session_cache.retain(|_, v| v.0 != uid);
        }
        self.ws_user_senders.remove(&uid);
        self.session_invalidation_notify.notify_waiters();
    }

    /// 指定管理者セッションをキャッシュから即時失効させ、世代番号を進める
    pub fn invalidate_admin_session(&self, token: &str) {
        let _guard = self.session_cache_lock.lock();
        self.admin_session_cache_epoch
            .fetch_add(1, Ordering::AcqRel);
        self.admin_session_cache.remove(token);
    }

    /// キャッシュに該当トークンが存在する場合のみ管理者セッションを失効させ、実行有無を返す
    pub fn invalidate_admin_session_if_present(&self, token: &str) -> bool {
        let _guard = self.session_cache_lock.lock();
        if self.admin_session_cache.remove(token).is_some() {
            self.admin_session_cache_epoch
                .fetch_add(1, Ordering::AcqRel);
            return true;
        }
        false
    }

    /// 期限切れのセッションキャッシュエントリを削除し、削除した一般ユーザートークン一覧を返す
    pub fn cleanup_session_caches(&self) -> Vec<String> {
        let _guard = self.session_cache_lock.lock();
        let now = Utc::now().timestamp();
        let expired_user_tokens: Vec<String> = self
            .session_cache
            .iter()
            .filter(|entry| entry.value().1 <= now)
            .map(|entry| entry.key().clone())
            .collect();
        self.session_cache.retain(|_, (_, exp)| *exp > now);
        self.admin_session_cache.retain(|_, (_, exp)| *exp > now);
        expired_user_tokens
    }

    /// 期限切れで削除されたユーザートークンの WS 送信チャネルを即時解除し、接続中セッションの再検証を起床させる
    pub fn invalidate_expired_user_sessions(&self, expired_tokens: &[String]) {
        if expired_tokens.is_empty() {
            return;
        }
        let expired_set: HashSet<&str> = expired_tokens.iter().map(String::as_str).collect();
        {
            let _guard = self.session_cache_lock.lock();
            self.session_cache_epoch.fetch_add(1, Ordering::AcqRel);
            for tok in expired_tokens {
                self.session_cache.remove(tok);
            }
        }
        self.ws_user_senders.retain(|_, list| {
            list.retain(|s| !expired_set.contains(s.token.as_str()));
            !list.is_empty()
        });
        self.session_invalidation_notify.notify_waiters();
    }

    /// DB行の expires_at カラム（TEXT RFC3339 優先、失敗時のみ i64）を UNIX 秒に変換する
    fn parse_expires_at_unix(row: &sqlx::sqlite::SqliteRow) -> Option<i64> {
        if let Ok(s) = row.try_get::<String, _>("expires_at") {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&s) {
                return Some(dt.timestamp());
            }
            if let Ok(ts) = s.trim().parse::<i64>() {
                return Some(ts);
            }
            return None;
        }
        row.try_get::<i64, _>("expires_at").ok()
    }

    /// ユーザーセッショントークンを検証し、有効であれば (user_id, expires_at_unix) を返す
    pub async fn resolve_active_user_session_with_expiry(&self, token: &str) -> Option<(i64, i64)> {
        let now = Utc::now().timestamp();
        // キャッシュ参照と照会前世代番号の取得を session_cache_lock 内で原子的に行う
        let epoch_before = {
            let _guard = self.session_cache_lock.lock();
            if let Some(entry) = self.session_cache.get(token) {
                let (uid, exp) = *entry.value();
                if exp > now {
                    return Some((uid, exp));
                }
                drop(entry);
                self.session_cache.remove(token);
            }
            self.session_cache_epoch.load(Ordering::Acquire)
        };

        let row = sqlx::query("SELECT user_id, expires_at FROM sessions WHERE token = ?")
            .bind(token)
            .fetch_optional(&self.pool)
            .await
            .ok()??;
        let uid: i64 = row.try_get("user_id").ok()?;
        let Some(expires_at) = Self::parse_expires_at_unix(&row) else {
            let _ = sqlx::query("DELETE FROM sessions WHERE token = ?")
                .bind(token)
                .execute(&self.pool)
                .await;
            return None;
        };
        if expires_at <= now {
            let _ = sqlx::query("DELETE FROM sessions WHERE token = ?")
                .bind(token)
                .execute(&self.pool)
                .await;
            return None;
        }
        self.cache_user_session_if_epoch(token.to_string(), uid, expires_at, epoch_before);
        Some((uid, expires_at))
    }

    /// ユーザーセッショントークンを検証し、有効であれば user_id を返す
    pub async fn resolve_active_user_session(&self, token: &str) -> Option<i64> {
        self.resolve_active_user_session_with_expiry(token)
            .await
            .map(|(uid, _)| uid)
    }

    /// 管理者セッショントークンを検証し、有効であれば admin_id を返す
    pub async fn resolve_active_admin_session(&self, token: &str) -> Option<String> {
        let now = Utc::now().timestamp();
        // キャッシュ参照と照会前世代番号の取得を session_cache_lock 内で原子的に行う
        let epoch_before = {
            let _guard = self.session_cache_lock.lock();
            if let Some(entry) = self.admin_session_cache.get(token) {
                let (admin_id, exp) = entry.value().clone();
                if exp > now {
                    return Some(admin_id);
                }
                drop(entry);
                self.admin_session_cache.remove(token);
            }
            self.admin_session_cache_epoch.load(Ordering::Acquire)
        };

        let row = sqlx::query("SELECT admin_id, expires_at FROM admin_sessions WHERE token = ?")
            .bind(token)
            .fetch_optional(&self.pool)
            .await
            .ok()??;
        let admin_id: String = row.try_get("admin_id").ok()?;
        let Some(expires_at) = Self::parse_expires_at_unix(&row) else {
            let _ = sqlx::query("DELETE FROM admin_sessions WHERE token = ?")
                .bind(token)
                .execute(&self.pool)
                .await;
            return None;
        };
        if expires_at <= now {
            let _ = sqlx::query("DELETE FROM admin_sessions WHERE token = ?")
                .bind(token)
                .execute(&self.pool)
                .await;
            return None;
        }
        self.cache_admin_session_if_epoch(
            token.to_string(),
            admin_id.clone(),
            expires_at,
            epoch_before,
        );
        Some(admin_id)
    }

    pub fn current_season_id(&self) -> i64 {
        self.season_id.load(Ordering::Acquire)
    }

    pub fn current_cycle_id(&self) -> i64 {
        self.season_cycle_id.load(Ordering::Acquire)
    }

    pub fn current_schedule(&self) -> SeasonSchedule {
        SeasonSchedule::from_rules(self.current_game_rules())
    }

    #[cfg(test)]
    pub fn current_board_size(&self) -> usize {
        self.board.read().size
    }

    pub fn current_map_params(&self) -> MapGenParams {
        *self.map_params.read()
    }

    pub fn current_ap_config(&self) -> ApConfig {
        *self.ap_config.read()
    }

    /// 指定 Tick 時点で終盤APブーストが発動中か判定する
    pub fn is_endgame_boost_at_tick(ap_cfg: ApConfig, max_ticks: u16, cur_tick: u16) -> bool {
        if ap_cfg.endgame_threshold_pct == 0 || ap_cfg.endgame_ap_multiplier <= 1.0 {
            return false;
        }
        let max_t = max_ticks as u64;
        if max_t == 0 {
            return false;
        }
        let remaining = max_t.saturating_sub(cur_tick as u64);
        remaining * 100 <= max_t * (ap_cfg.endgame_threshold_pct as u64)
    }

    /// 指定時刻時点で終盤APブースト（残りN% Tick）が発動中か判定する
    pub fn is_endgame_ap_boost_active_at(&self, now: chrono::DateTime<Utc>) -> bool {
        if self.phase_at(now) != SeasonPhase::Active {
            return false;
        }
        let ap_cfg = self.current_ap_config();
        let rules = self.current_game_rules();
        let cur_tick = self.actual_tick_number_at(now);
        Self::is_endgame_boost_at_tick(ap_cfg, rules.max_ticks, cur_tick)
    }

    pub fn is_endgame_ap_boost_active(&self) -> bool {
        self.is_endgame_ap_boost_active_at(Utc::now())
    }

    /// 指定時刻時点の実効 (max_ap, refill_min, refill_max) を返す
    pub fn effective_ap_bounds_at(&self, now: chrono::DateTime<Utc>) -> (i64, i64, i64) {
        let ap_cfg = self.current_ap_config();
        ap_cfg.effective_bounds(self.is_endgame_ap_boost_active_at(now))
    }

    pub fn effective_max_ap(&self) -> i64 {
        self.effective_ap_bounds_at(Utc::now()).0
    }

    pub fn current_cost_config(&self) -> CostConfig {
        *self.cost_config.read()
    }

    pub fn current_game_rules(&self) -> GameRulesConfig {
        *self.game_rules.read()
    }

    pub fn current_faction_name_max_len(&self) -> usize {
        self.faction_name_max_len.load(Ordering::Acquire)
    }

    /// 指定時刻における次回 AP 補充時刻の Unix 秒を返す
    pub fn next_refill_unix_at(&self, now: chrono::DateTime<Utc>) -> i64 {
        let cfg = self.current_ap_config();
        let schedule = self.current_schedule();
        let skip_start = self.phase_override.read().is_none();
        next_ap_refill_unix_with_schedule(
            now,
            cfg.refill_interval_minutes,
            cfg.refill_offset_minute,
            schedule,
            skip_start,
        )
    }

    pub fn next_refill_unix(&self) -> i64 {
        self.next_refill_unix_at(Utc::now())
    }

    /// 指定時刻における現在のゲームフェーズを返す（自動凍結・手動フェーズ上書きを優先）
    pub fn phase_at(&self, now: chrono::DateTime<Utc>) -> SeasonPhase {
        // 最大ティック到達による自動凍結は手動「開催」設定中も優先する（手動フェーズ切替APIで0にクリアされる）
        if self.auto_frozen_season_id.load(Ordering::Acquire) == self.current_season_id() {
            return SeasonPhase::Frozen;
        }
        if let Some(ov) = *self.phase_override.read() {
            return ov;
        }
        compute_phase_jst_with_schedule(now, self.current_schedule())
    }

    pub fn current_phase(&self) -> SeasonPhase {
        self.phase_at(Utc::now())
    }

    /// 盤面更新チャンク数分のバージョンを進行し (start_ver, end_ver) を返す（必ず board.write() 保持中に呼ぶ）
    pub fn bump_board_version_n(&self, n: u64) -> (u64, u64) {
        let count = n.max(1);
        let prev = self.snapshot_version.fetch_add(count, Ordering::AcqRel);
        (prev + 1, prev + count)
    }

    /// インメモリのスナップショットキャッシュを破棄する（board.write() 解放直後に呼ぶ）
    pub fn clear_snapshot_cache(&self) {
        *self.snapshot_cache.write() = None;
    }

    /// インメモリの勢力一覧キャッシュを破棄し、世代番号を進める（勢力・メンバー・領土統計の更新コミット後に呼ぶ）
    pub fn invalidate_factions_cache(&self) {
        let mut guard = self.factions_cache.write();
        self.factions_cache_epoch.fetch_add(1, Ordering::AcqRel);
        *guard = None;
    }

    /// 勢力一覧キャッシュを参照し、ヒット時はバイト列を、ミス時は読み取り開始前の世代番号を返す
    pub fn read_factions_cache(
        &self,
        season_id: i64,
        ttl: std::time::Duration,
    ) -> Result<Bytes, u64> {
        let guard = self.factions_cache.read();
        if let Some((cached_season, cached_at, ref json_bytes)) = *guard {
            if cached_season == season_id && cached_at.elapsed() < ttl {
                return Ok(json_bytes.clone());
            }
        }
        Err(self.factions_cache_epoch.load(Ordering::Acquire))
    }

    /// 読み取り開始前からキャッシュ無効化やシーズン切替が起きていない場合のみ勢力一覧キャッシュへ格納する
    pub fn store_factions_cache_if_fresh(
        &self,
        season_id: i64,
        epoch_before: u64,
        json_bytes: Bytes,
    ) -> bool {
        let mut guard = self.factions_cache.write();
        if self.factions_cache_epoch.load(Ordering::Acquire) != epoch_before
            || self.current_season_id() != season_id
        {
            return false;
        }
        *guard = Some((season_id, Instant::now(), json_bytes));
        true
    }

    /// 指定時刻基準でルール変更・フェーズ上書き切替時に引き継ぐべき manual_tick_offset を算出する純粋関数（メモリ書換なし）
    pub fn compute_synced_tick_offset_for_mode_change_at(
        &self,
        now: chrono::DateTime<Utc>,
        next_rules: GameRulesConfig,
        next_override: Option<SeasonPhase>,
    ) -> u16 {
        let cur_rules = self.current_game_rules();
        let cur_schedule = SeasonSchedule::from_rules(cur_rules);
        let natural_phase = compute_phase_jst_with_schedule(now, cur_schedule);
        let cur_override = *self.phase_override.read();
        let is_cur_standard_auto = cur_rules.tick_interval_minutes == 60
            && cur_rules.max_ticks == 48
            && cur_override.is_none();

        let prev_tick = if is_cur_standard_auto && natural_phase == SeasonPhase::Frozen {
            // 自然凍結状態の標準自動モードからは完了上限 48 を引き継がず進行中オフセットのみ引き継ぐ
            *self.manual_tick_offset.read()
        } else {
            self.actual_tick_number_at(now)
        };

        let is_next_custom_or_manual = next_rules.tick_interval_minutes != 60
            || next_rules.max_ticks != 48
            || next_override.is_some();
        if is_next_custom_or_manual {
            prev_tick
        } else {
            let next_schedule = SeasonSchedule::from_rules(next_rules);
            let next_natural = compute_phase_jst_with_schedule(now, next_schedule);
            let base = compute_tick_number_with_schedule(now, next_natural, next_schedule);
            prev_tick.saturating_sub(base)
        }
    }

    /// 指定時刻・ルール・フェーズ上書き・オフセットを前提とした実ティック番号を返す
    pub fn actual_tick_number_with_at(
        &self,
        now: chrono::DateTime<Utc>,
        rules: GameRulesConfig,
        phase_override: Option<SeasonPhase>,
        offset: u16,
    ) -> u16 {
        if rules.tick_interval_minutes != 60
            || rules.max_ticks != 48
            || phase_override.is_some()
        {
            return offset;
        }
        let schedule = SeasonSchedule::from_rules(rules);
        let base = compute_tick_number_with_schedule(
            now,
            compute_phase_jst_with_schedule(now, schedule),
            schedule,
        );
        base.saturating_add(offset)
    }

    /// 指定時刻基準で自動凍結による表示上の 48 固定を適用しない実ティック番号を返す
    pub fn actual_tick_number_at(&self, now: chrono::DateTime<Utc>) -> u16 {
        let rules = self.current_game_rules();
        let phase_override = *self.phase_override.read();
        let offset = *self.manual_tick_offset.read();
        self.actual_tick_number_with_at(now, rules, phase_override, offset)
    }

    /// 自動凍結による表示上の 48 固定を適用しない実ティック番号を返す
    #[allow(dead_code)]
    pub fn actual_tick_number(&self) -> u16 {
        self.actual_tick_number_at(Utc::now())
    }

    /// 指定時刻における現在の表示用ティック番号を返す
    pub fn tick_number_at(&self, now: chrono::DateTime<Utc>) -> u16 {
        let phase = self.phase_at(now);
        let rules = self.current_game_rules();
        if rules.tick_interval_minutes != 60
            || rules.max_ticks != 48
            || self.phase_override.read().is_some()
        {
            return *self.manual_tick_offset.read();
        }
        let schedule = SeasonSchedule::from_rules(rules);
        let base = compute_tick_number_with_schedule(now, phase, schedule);
        if phase == SeasonPhase::Frozen {
            return base;
        }
        let offset = *self.manual_tick_offset.read();
        base.saturating_add(offset)
    }

    pub fn current_tick_number(&self) -> u16 {
        self.tick_number_at(Utc::now())
    }

    /// 管理者操作によるマップ再生成（盤面・チャンク・領土・外交・APを単一トランザクションでリセットし全クライアントへ通知）
    pub async fn regenerate_map(&self, params: MapGenParams) -> Result<MapGenParams, String> {
        let action_guard = self.action_mutex.lock().await;
        params.validate()?;
        let season_id = self.current_season_id();

        // トランザクション開始前にブロッキングプールで地形・盤面を生成する
        let params_copy = params;
        let new_board =
            tokio::task::spawn_blocking(move || build_new_board_in_memory(&params_copy))
                .await
                .map_err(|e| format!("盤面生成タスク失敗: {}", e))??;

        // タイムラプス削除と他タスクの遅延保存を直列化するため timelapse_write_lock -> begin_immediate の順で取得する
        let tl_guard = self.timelapse_write_lock.lock().await;
        let mut tx = begin_immediate(&self.pool)
            .await
            .map_err(|e| format!("リセットTX開始失敗: {}", e))?;

        persist_board_in_tx(&mut tx, season_id, &params, &new_board).await?;

        for (table, label) in [
            ("sessions", "セッション"),
            ("faction_join_requests", "参加申請"),
            ("faction_members", "勢力メンバー"),
            ("diplomacy_wars", "戦争"),
            ("ceasefire_proposals", "停戦提案"),
            ("factions", "勢力"),
            ("player_logs", "行動ログ"),
            ("users", "ユーザー"),
        ] {
            let sql = format!("DELETE FROM {}", table);
            sqlx::query(&sql)
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("{}リセット失敗: {}", label, e))?;
        }

        sqlx::query("DELETE FROM timelapse_frames WHERE season_id = ?")
            .bind(season_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("タイムラプス削除失敗: {}", e))?;

        save_setting_tx(&mut tx, "manual_tick_offset", "0").await?;
        save_setting_tx(&mut tx, "auto_frozen_season_id", "0").await?;
        save_setting_tx(&mut tx, "last_active_season_id", &season_id.to_string()).await?;
        record_player_log_tx(
            &mut tx,
            season_id,
            0,
            "管理者",
            0,
            "system",
            &format!(
                "管理者がマップを再生成した（サイズ {}×{} / シード {}）",
                params.size, params.size, params.seed
            ),
        )
        .await;

        tx.commit()
            .await
            .map_err(|e| format!("リセットコミット失敗: {}", e))?;
        // timelapse_write_lock 保持中に map_generation を進めて旧マップの遅延タイムラプス保存を確実に破棄する
        let expected_gen = self.map_generation.fetch_add(1, Ordering::AcqRel) + 1;
        drop(tl_guard);

        // コミット成功後にユーザーセッションキャッシュを世代ごと無効化（管理者セッションは維持）
        self.invalidate_all_user_sessions();
        self.faction_color_cooldown.clear();
        self.core_attack_alert_cooldown.clear();

        // タイムラプス圧縮・保存は action_mutex 解放後に行うため、生バイト列をここでコピーしておく
        let tl_board_size = new_board.size;
        let tl_raw_bytes = new_board.as_bytes().to_vec();

        // DB TX コミット成功後にメモリ上の盤面を差し替え、同じ board.write() ロック内でバージョンを進める
        {
            let mut board_guard = self.board.write();
            *board_guard = new_board;
            self.bump_board_version_n(1);
        }
        self.clear_snapshot_cache();
        self.invalidate_factions_cache();

        {
            let mut params_guard = self.map_params.write();
            *params_guard = params;
        }
        *self.manual_tick_offset.write() = 0;
        self.auto_frozen_season_id.store(0, Ordering::Release);

        let phase_now = self.current_phase();
        // 再生成直後に定期タスク2がフェーズ移行ログや余分な tick_sync を誤発火しないよう同期済みフェーズを記録する
        self.record_synced_phase(season_id, phase_now);

        // イベント順序逆転を防ぐため WS ブロードキャストは action_mutex 解放前（タイムラプス保存前）に行う
        let event = serde_json::json!({
            "type": "map_regenerated",
            "season_id": season_id,
            "board_size": params.size,
            "map_params": params,
            "phase": phase_now,
        });
        self.broadcast_frame(encode_event_json(&event.to_string()));

        drop(action_guard);

        let _ = self
            .save_timelapse_frame_guarded(season_id, 0, expected_gen, tl_board_size, tl_raw_bytes)
            .await;

        Ok(params)
    }

    /// ダーティチャンクを SQLite へ非同期バッチ保存（5秒ごとの定期タスクから呼ばれる）
    pub async fn flush_dirty_chunks(&self) -> Result<usize, sqlx::Error> {
        let _action_guard = self.action_mutex.lock().await;
        self.flush_dirty_chunks_locked().await
    }

    /// action_mutex 保持状態でダーティチャンクを保存し、失敗時・キャンセル時はダーティフラグを復元する
    pub(crate) async fn flush_dirty_chunks_locked(&self) -> Result<usize, sqlx::Error> {
        struct DirtyRestoreGuard<'a> {
            board: &'a RwLock<Board>,
            dirty_ids: Vec<usize>,
            armed: bool,
        }

        impl Drop for DirtyRestoreGuard<'_> {
            fn drop(&mut self) {
                if self.armed && !self.dirty_ids.is_empty() {
                    self.board.read().mark_chunk_dirty_ids(&self.dirty_ids);
                }
            }
        }

        let season_id = self.current_season_id();
        let (dirty_ids, payloads): (Vec<usize>, Vec<(usize, Vec<u8>)>) = {
            let board = self.board.read();
            let dirty_ids = board.take_dirty_chunks();
            if dirty_ids.is_empty() {
                return Ok(0);
            }
            let payloads = dirty_ids
                .iter()
                .map(|&cid| (cid, board.extract_chunk_bytes(cid)))
                .collect();
            (dirty_ids, payloads)
        };
        let count = payloads.len();
        let mut guard = DirtyRestoreGuard {
            board: &self.board,
            dirty_ids,
            armed: true,
        };
        save_chunks_batch(&self.pool, season_id, &payloads).await?;
        guard.armed = false;
        Ok(count)
    }

    /// 新シーズンへの自動遷移チェック（準備開始時刻 JST に新マップ生成・リセット）
    pub async fn check_season_rollover(&self) -> Result<bool, String> {
        // 毎秒の不要なロック取得を避けるため高速事前チェックを行う
        // 手動フェーズ固定中でも、現在シーズンが max_ticks 到達で自動凍結済みの場合は次シーズン遷移を許可する
        let current_pre = self.current_season_id();
        let current_cycle_pre = self.current_cycle_id();
        let is_auto_frozen_pre = self.auto_frozen_season_id.load(Ordering::Acquire) == current_pre;
        if self.phase_override.read().is_some() && !is_auto_frozen_pre {
            return Ok(false);
        }
        let schedule_pre = self.current_schedule();
        if compute_cycle_id(Utc::now(), schedule_pre) <= current_cycle_pre {
            return Ok(false);
        }

        let action_guard = self.action_mutex.lock().await;
        let current = self.current_season_id();
        let current_cycle = self.current_cycle_id();
        let is_auto_frozen_current = self.auto_frozen_season_id.load(Ordering::Acquire) == current;
        if self.phase_override.read().is_some() && !is_auto_frozen_current {
            return Ok(false);
        }
        let schedule = self.current_schedule();
        let target_cycle = compute_cycle_id(Utc::now(), schedule);
        if target_cycle <= current_cycle {
            return Ok(false);
        }
        let target_season = current.saturating_add(target_cycle - current_cycle);

        if let Err(e) = self.flush_dirty_chunks_locked().await {
            tracing::error!("シーズン切替前のダーティチャンク保存失敗: {}", e);
            return Err(format!("シーズン切替前のダーティチャンク保存失敗: {}", e));
        }
        let (new_board, new_params) =
            load_or_init_board(&self.pool, target_season, self.config.map_seed).await?;

        let ap_cfg = self.current_ap_config();
        let user_ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM users")
            .fetch_all(&self.pool)
            .await
            .map_err(|e| format!("新シーズンユーザー取得失敗: {}", e))?;
        let user_initial_aps: Vec<(i64, i64)> = user_ids
            .into_iter()
            .map(|uid| (uid, ap_cfg.roll_initial_ap()))
            .collect();
        // ユーザーリセットと各種設定初期化を単一 BEGIN IMMEDIATE トランザクションで原子的にコミットする
        {
            let mut tx = begin_immediate(&self.pool)
                .await
                .map_err(|e| format!("新シーズン切替TX開始失敗: {}", e))?;

            for (uid, init_ap) in user_initial_aps {
                sqlx::query("UPDATE users SET ap = ?, faction_id = 0 WHERE id = ?")
                    .bind(init_ap)
                    .bind(uid)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("新シーズンユーザーリセット失敗: {}", e))?;
            }

            sqlx::query("DELETE FROM game_settings WHERE key = 'phase_override'")
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("新シーズンフェーズ上書き解除失敗: {}", e))?;

            save_setting_tx(&mut tx, "manual_tick_offset", "0").await?;
            save_setting_tx(&mut tx, "auto_frozen_season_id", "0").await?;
            save_setting_tx(&mut tx, "last_active_season_id", &target_season.to_string()).await?;
            save_setting_tx(&mut tx, "last_active_cycle_id", &target_cycle.to_string()).await?;
            record_player_log_tx(
                &mut tx,
                target_season,
                0,
                "システム",
                0,
                "system",
                &format!("シーズン #{} が開始された（準備フェーズ）", target_season),
            )
            .await;

            tx.commit()
                .await
                .map_err(|e| format!("新シーズン切替TXコミット失敗: {}", e))?;
        }

        // タイムラプス圧縮・保存を action_mutex 解放後に行うため生バイト列を事前取得する
        let tl_board_size = new_board.size;
        let tl_raw_bytes = new_board.as_bytes().to_vec();
        let expected_gen = self.map_generation.load(Ordering::Acquire);

        // DB TX コミット成功後にメモリ上の盤面・バージョン・マップ設定・シーズン状態を確定する
        self.faction_color_cooldown.clear();
        self.core_attack_alert_cooldown.clear();
        {
            let mut board = self.board.write();
            *board = new_board;
            self.bump_board_version_n(1);
        }
        self.clear_snapshot_cache();
        self.invalidate_factions_cache();

        {
            let mut mp = self.map_params.write();
            *mp = new_params;
        }
        self.season_id.store(target_season, Ordering::Release);
        self.season_cycle_id.store(target_cycle, Ordering::Release);
        *self.phase_override.write() = None;
        *self.manual_tick_offset.write() = 0;
        self.auto_frozen_season_id.store(0, Ordering::Release);

        let phase_now = self.current_phase();
        // イベント順序逆転を防ぐため WS ブロードキャストは action_mutex 解放前（タイムラプス保存前）に行う
        self.record_synced_phase(target_season, phase_now);
        let event = serde_json::json!({
            "type": "season_reset",
            "season_id": target_season,
            "board_size": new_params.size,
            "phase": phase_now,
        });
        self.broadcast_frame(encode_event_json(&event.to_string()));

        drop(action_guard);

        let _ = self
            .save_timelapse_frame_guarded(
                target_season,
                0,
                expected_gen,
                tl_board_size,
                tl_raw_bytes,
            )
            .await;

        Ok(true)
    }

    /// 定期スケジュール用の AP 補充（action_mutex 内でフェーズ・補充対象分・同期設定・既実行キーを再検証し、last_refill_minute と原子コミットする）
    #[cfg(test)]
    pub async fn grant_scheduled_ap_refill(
        &self,
        minute_key: i64,
        now: chrono::DateTime<Utc>,
    ) -> Result<Option<usize>, String> {
        self.grant_scheduled_ap_refill_for_slot(minute_key, now, now)
            .await
    }

    /// 遅延補完対応の定期スケジュール用 AP 補充（`slot_now` のスケジュール枠を `current_now` 時点で検証して実行する）
    pub async fn grant_scheduled_ap_refill_for_slot(
        &self,
        slot_minute_key: i64,
        slot_now: chrono::DateTime<Utc>,
        current_now: chrono::DateTime<Utc>,
    ) -> Result<Option<usize>, String> {
        let _action_guard = self.action_mutex.lock().await;
        if self.phase_at(current_now) != SeasonPhase::Active {
            return Ok(None);
        }
        let lag_min = (current_now.timestamp() / 60) - (slot_now.timestamp() / 60);
        if !(0..=SCHEDULE_CATCHUP_GRACE_MINUTES).contains(&lag_min) {
            return Ok(None);
        }
        let schedule = self.current_schedule();
        // 自動スケジュールの開幕直後や開催帯外スロットでは補完・発火させない
        if self.phase_override.read().is_none()
            && (is_season_start_minute(slot_now, schedule)
                || compute_phase_jst_with_schedule(slot_now, schedule) != SeasonPhase::Active)
        {
            return Ok(None);
        }
        let ap_cfg = self.current_ap_config();
        if !is_ap_refill_minute_with_schedule(
            slot_now,
            ap_cfg.refill_interval_minutes,
            ap_cfg.refill_offset_minute,
            schedule,
        ) {
            return Ok(None);
        }
        let rules = self.current_game_rules();
        let is_synced_hourly = rules.tick_interval_minutes.max(1) == 60
            && ap_cfg.refill_interval_minutes == 60
            && ap_cfg.refill_offset_minute == 0;
        if is_synced_hourly {
            return Ok(None);
        }
        if load_setting_strict(&self.pool, "last_refill_minute")
            .await
            .map_err(|e| format!("last_refill_minute 読み込み失敗: {}", e))?
            .and_then(|s| s.trim().parse::<i64>().ok())
            .is_some_and(|saved| saved >= slot_minute_key)
        {
            return Ok(None);
        }
        let count = self
            .grant_ap_refill_locked(true, Some(slot_minute_key))
            .await?;
        Ok(Some(count))
    }

    /// 全ユーザーの AP 補充量を算出する（DB 書き込みは行わない）
    async fn compute_ap_refill_gains(
        &self,
        refill_min: i64,
        refill_max: i64,
    ) -> Result<Vec<(i64, i64)>, String> {
        let user_rows = sqlx::query("SELECT id FROM users")
            .fetch_all(&self.pool)
            .await
            .map_err(|e| format!("ユーザー取得失敗: {}", e))?;

        // ThreadRng は !Send のため .await 前に一括算出してドロップする
        let ap_gains: Vec<(i64, i64)> = {
            let mut rng = rand::thread_rng();
            user_rows
                .into_iter()
                .map(|row| {
                    let uid: i64 = row.get("id");
                    let gain = if refill_min >= refill_max {
                        refill_min
                    } else {
                        rng.gen_range(refill_min..=refill_max)
                    };
                    (uid, gain)
                })
                .collect()
        };
        Ok(ap_gains)
    }

    /// action_mutex 保持状態で全ユーザーへ AP を相対加算補充する
    async fn grant_ap_refill_locked(
        &self,
        broadcast_sync: bool,
        persist_refill_minute: Option<i64>,
    ) -> Result<usize, String> {
        let now = Utc::now();
        let boost_active = self.is_endgame_ap_boost_active_at(now);
        let (eff_max_ap, eff_refill_min, eff_refill_max) =
            self.current_ap_config().effective_bounds(boost_active);
        let ap_gains = self
            .compute_ap_refill_gains(eff_refill_min, eff_refill_max)
            .await?;
        let count = ap_gains.len();

        {
            let mut tx = begin_immediate(&self.pool)
                .await
                .map_err(|e| format!("トランザクション開始失敗: {}", e))?;
            if eff_refill_min >= eff_refill_max {
                // 固定値補充時は単一 UPDATE で一括更新する
                sqlx::query("UPDATE users SET ap = MIN(?, ap + ?)")
                    .bind(eff_max_ap)
                    .bind(eff_refill_min)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("AP一括更新失敗: {}", e))?;
            } else {
                for (uid, gain) in ap_gains {
                    sqlx::query("UPDATE users SET ap = MIN(?, ap + ?) WHERE id = ?")
                        .bind(eff_max_ap)
                        .bind(gain)
                        .bind(uid)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| format!("AP更新失敗: {}", e))?;
                }
            }
            if let Some(mk) = persist_refill_minute {
                save_setting_tx(&mut tx, "last_refill_minute", &mk.to_string()).await?;
            }
            let range_str = if eff_refill_min >= eff_refill_max {
                format!("+{} AP", eff_refill_min)
            } else {
                format!("+{}〜{} AP", eff_refill_min, eff_refill_max)
            };
            let boost_suffix = if boost_active {
                "・終盤ブースト適用中"
            } else {
                ""
            };
            record_player_log_tx(
                &mut tx,
                self.current_season_id(),
                0,
                "システム",
                0,
                "ap",
                &format!(
                    "定期 AP 補充を実施した（{} / 上限 {} AP{}）",
                    range_str, eff_max_ap, boost_suffix
                ),
            )
            .await;
            tx.commit()
                .await
                .map_err(|e| format!("APコミット失敗: {}", e))?;
        }

        if broadcast_sync {
            self.broadcast_tick_sync(
                self.current_phase(),
                self.current_tick_number(),
                0,
                self.next_refill_unix(),
                self.current_season_id(),
            );
            let event = serde_json::json!({
                "type": "ap_refilled",
                "min": eff_refill_min,
                "max": eff_refill_max,
                "max_ap": eff_max_ap,
                "endgame_boost": boost_active,
            });
            self.broadcast_frame(encode_event_json(&event.to_string()));
        }

        Ok(count)
    }

    /// クローン盤面上で自動塗りシミュレーションを実行する（DB・実盤面はまだ変更しない）
    async fn simulate_auto_paint(
        &self,
        season_id: i64,
        board_size: usize,
        cells_clone: Vec<crate::board::Cell>,
        ap_bonus_by_user: Option<(&HashMap<i64, i64>, i64)>,
    ) -> Result<AutoPaintSimulation, String> {
        let rows = sqlx::query(
            r#"
            SELECT u.id AS user_id, u.username, u.ap, u.auto_paint_pct, u.faction_id,
                   f.color_id, f.initial_core_used
            FROM users u
            JOIN factions f ON f.id = u.faction_id AND f.season_id = ?
            WHERE u.auto_paint_enabled = 1 AND f.allow_auto_paint = 1
            "#,
        )
        .bind(season_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| format!("自動塗り対象ユーザー取得失敗: {}", e))?;

        if rows.is_empty() {
            return Ok(AutoPaintSimulation {
                updated_cells: cells_clone,
                changed_cells: Vec::new(),
                user_updates: Vec::new(),
                core_increments: HashMap::new(),
                painted_factions: HashSet::new(),
                captured_enemy_cores: HashMap::new(),
            });
        }

        let war_rows =
            sqlx::query("SELECT faction_a, faction_b FROM diplomacy_wars WHERE season_id = ?")
                .bind(season_id)
                .fetch_all(&self.pool)
                .await
                .map_err(|e| format!("自動塗り戦争状態取得失敗: {}", e))?;
        let mut wars = HashSet::new();
        for wr in war_rows {
            if let (Ok(a), Ok(b)) = (
                u16::try_from(wr.get::<i64, _>("faction_a")),
                u16::try_from(wr.get::<i64, _>("faction_b")),
            ) {
                if a != 0 && b != 0 {
                    wars.insert(war_pair(a, b));
                }
            }
        }

        let cost_cfg = self.current_cost_config();
        let rules_cfg = self.current_game_rules();

        struct AutoPaintUser {
            uid: i64,
            uname: String,
            cur_ap: i64,
            pct: i64,
            fid: u16,
            fid_i64: i64,
            color_id: u8,
        }

        let mut active_factions = HashSet::new();
        let mut faction_core_used: HashMap<i64, u32> = HashMap::new();
        let mut users = Vec::with_capacity(rows.len());
        for row in rows {
            let uid: i64 = row.get("user_id");
            let base_ap: i64 = row.get("ap");
            let cur_ap = if let Some((bonus_map, max_ap)) = ap_bonus_by_user {
                (base_ap + bonus_map.get(&uid).copied().unwrap_or(0)).min(max_ap)
            } else {
                base_ap
            };
            if cur_ap <= 0 {
                continue;
            }

            let fid_i64: i64 = row.get("faction_id");
            let used = row.get::<i64, _>("initial_core_used").max(0) as u32;
            faction_core_used.entry(fid_i64).or_insert(used);

            let Ok(fid) = u16::try_from(fid_i64) else {
                continue;
            };
            if fid == 0 {
                continue;
            }
            active_factions.insert(fid);
            users.push(AutoPaintUser {
                uid,
                uname: row.get("username"),
                cur_ap,
                pct: row.get::<i64, _>("auto_paint_pct").clamp(1, 100),
                fid,
                fid_i64,
                color_id: row.get::<i64, _>("color_id").clamp(0, 63) as u8,
            });
        }

        if users.is_empty() {
            return Ok(AutoPaintSimulation {
                updated_cells: cells_clone,
                changed_cells: Vec::new(),
                user_updates: Vec::new(),
                core_increments: HashMap::new(),
                painted_factions: HashSet::new(),
                captured_enemy_cores: HashMap::new(),
            });
        }

        let (
            updated_cells,
            changed_cells,
            user_updates,
            core_increments,
            painted_factions,
            captured_enemy_cores,
        ) =
            tokio::task::spawn_blocking(move || {
                let mut tmp_board = Board::from_cells(board_size, cells_clone);
                let sz = tmp_board.size;

                let mut user_updates: Vec<(i64, String, i64, i64, usize)> = Vec::new();
                let mut core_increments: HashMap<i64, i64> = HashMap::new();
                let mut painted_factions: HashSet<i64> = HashSet::new();
                let mut captured_enemy_cores: HashMap<(u16, u16), (u16, u16)> = HashMap::new();
                let mut changed_cells: Vec<(u16, u16, crate::board::Cell)> = Vec::new();

                // 1パスで全対象勢力分の隣接塗抹候補と既存領土有無を一括収集（O(盤面サイズ)）
                let mut candidates_by_faction: HashMap<u16, Vec<(usize, usize)>> = HashMap::new();
                let mut seen_candidates_by_faction: HashMap<u16, HashSet<(usize, usize)>> =
                    HashMap::new();
                let mut factions_with_territory: HashSet<u16> = HashSet::new();

                for y in 0..sz {
                    for x in 0..sz {
                        let c = tmp_board.cells[tmp_board.idx(x, y)];
                        if !c.is_land() {
                            continue;
                        }
                        if c.faction_id != 0 {
                            factions_with_territory.insert(c.faction_id);
                        }
                        let mut adj_fids = [0u16; 4];
                        let mut adj_len = 0usize;
                        let dirs = [(-1isize, 0), (1, 0), (0, -1), (0, 1)];
                        for (dx, dy) in dirs {
                            let nx = x as isize + dx;
                            let ny = y as isize + dy;
                            if nx >= 0 && ny >= 0 && (nx as usize) < sz && (ny as usize) < sz {
                                let nfid =
                                    tmp_board.cells[tmp_board.idx(nx as usize, ny as usize)].faction_id;
                                if nfid != 0
                                    && nfid != c.faction_id
                                    && active_factions.contains(&nfid)
                                    && !adj_fids[..adj_len].contains(&nfid)
                                {
                                    adj_fids[adj_len] = nfid;
                                    adj_len += 1;
                                }
                            }
                        }
                        for &nfid in &adj_fids[..adj_len] {
                            if (c.faction_id == 0 || wars.contains(&war_pair(nfid, c.faction_id)))
                                && seen_candidates_by_faction
                                    .entry(nfid)
                                    .or_default()
                                    .insert((x, y))
                            {
                                candidates_by_faction.entry(nfid).or_default().push((x, y));
                            }
                        }
                    }
                }

                let mut rng = rand::thread_rng();

                for user in users {
                    let mut budget = (user.cur_ap * user.pct) / 100;
                    if budget <= 0 {
                        continue;
                    }

                    // 同一勢力のメンバー間で候補リスト・重複排除セット・初期中核消費数を共有する
                    let candidates = candidates_by_faction.entry(user.fid).or_default();
                    let seen_candidates = seen_candidates_by_faction.entry(user.fid).or_default();

                    let mut remaining_ap = user.cur_ap;
                    let mut core_added = 0i64;
                    let mut painted = 0usize;
                    let mut attempts = 0usize;
                    let mut seed_tried = false;
                    // 予算不足でスキップした候補は同一勢力の後続メンバーのためループ終了後に戻す
                    let mut deferred_candidates: Vec<(usize, usize)> = Vec::new();

                    while budget > 0 && painted < 50 && attempts < 200 {
                        attempts += 1;
                        let has_territory = factions_with_territory.contains(&user.fid);
                        if candidates.is_empty() {
                            // 既存領土がある勢力はランダム飛び地を掘らない。領土0勢力も1ユーザーあたり最大1回のみシード探索
                            if has_territory || seed_tried {
                                break;
                            }
                            seed_tried = true;
                            let mut found_seed: Option<(usize, usize)> = None;
                            for _ in 0..400 {
                                let rx = rng.gen_range(0..sz);
                                let ry = rng.gen_range(0..sz);
                                let c = tmp_board.cells[tmp_board.idx(rx, ry)];
                                if c.is_land()
                                    && c.faction_id == 0
                                    && !seen_candidates.contains(&(rx, ry))
                                {
                                    found_seed = Some((rx, ry));
                                    break;
                                }
                            }
                            if let Some(pos) = found_seed {
                                if seen_candidates.insert(pos) {
                                    candidates.push(pos);
                                }
                            } else {
                                break;
                            }
                        }
                        if candidates.is_empty() {
                            break;
                        }

                        let pick = rng.gen_range(0..candidates.len());
                        let (tx, ty) = candidates.swap_remove(pick);

                        let Ok(eval) = tmp_board.evaluate_action_with_all(
                            tx,
                            ty,
                            user.fid,
                            ActionMode::Paint,
                            user.color_id,
                            &cost_cfg,
                            &rules_cfg,
                        ) else {
                            continue;
                        };
                        // 既に別メンバーが塗った空き地・他勢力マスで重ね塗りになった場合はスキップ
                        if eval.target_faction == user.fid {
                            continue;
                        }
                        // 既存領土あり勢力が同一ティック内で他勢力に拠点を奪われた直後に高コスト飛び地を掘らない
                        if has_territory && eval.is_enclave {
                            continue;
                        }
                        if eval.target_faction != 0
                            && !wars.contains(&war_pair(user.fid, eval.target_faction))
                        {
                            continue;
                        }
                        let cost_i64 = eval.cost as i64;
                        if cost_i64 > budget || cost_i64 > remaining_ap {
                            deferred_candidates.push((tx, ty));
                            continue;
                        }

                        if eval.kind == crate::board::ActionKind::CaptureEnemyCore
                            && eval.target_faction != 0
                            && eval.target_faction != user.fid
                        {
                            captured_enemy_cores
                                .entry((eval.target_faction, user.fid))
                                .or_insert((tx as u16, ty as u16));
                        }

                        let core_used = faction_core_used.entry(user.fid_i64).or_insert(0);
                        let initial_rem = *core_used < rules_cfg.initial_core_quota;
                        let (next_cell, consumed) = tmp_board.apply_evaluated_action_with_rules(
                            tx,
                            ty,
                            user.fid,
                            user.color_id,
                            user.color_id,
                            eval,
                            initial_rem,
                            &rules_cfg,
                        );
                        if consumed {
                            *core_used += 1;
                            core_added += 1;
                        }
                        factions_with_territory.insert(user.fid);
                        remaining_ap -= cost_i64;
                        budget -= cost_i64;
                        painted += 1;
                        changed_cells.push((tx as u16, ty as u16, next_cell));

                        // 新たに隣接した空き地・戦争中敵地を候補に追加（重複排除）
                        let dirs = [(-1isize, 0), (1, 0), (0, -1), (0, 1)];
                        for (dx, dy) in dirs {
                            let nx = tx as isize + dx;
                            let ny = ty as isize + dy;
                            if nx >= 0 && ny >= 0 && (nx as usize) < sz && (ny as usize) < sz {
                                let ux = nx as usize;
                                let uy = ny as usize;
                                let nc = tmp_board.cells[tmp_board.idx(ux, uy)];
                                if nc.is_land()
                                    && nc.faction_id != user.fid
                                    && (nc.faction_id == 0
                                        || wars.contains(&war_pair(user.fid, nc.faction_id)))
                                    && seen_candidates.insert((ux, uy))
                                {
                                    candidates.push((ux, uy));
                                }
                            }
                        }
                    }

                    if !deferred_candidates.is_empty() {
                        candidates.extend(deferred_candidates);
                    }

                    if remaining_ap != user.cur_ap {
                        user_updates.push((
                            user.uid,
                            user.uname,
                            user.fid_i64,
                            user.cur_ap - remaining_ap,
                            painted,
                        ));
                    }
                    if painted > 0 {
                        painted_factions.insert(user.fid_i64);
                    }
                    if core_added > 0 {
                        *core_increments.entry(user.fid_i64).or_insert(0) += core_added;
                    }
                }

                (
                    tmp_board.cells,
                    changed_cells,
                    user_updates,
                    core_increments,
                    painted_factions,
                    captured_enemy_cores,
                )
            })
            .await
            .map_err(|e| format!("自動塗り計算タスク失敗: {}", e))?;

        Ok(AutoPaintSimulation {
            updated_cells,
            changed_cells,
            user_updates,
            core_increments,
            painted_factions,
            captured_enemy_cores,
        })
    }

    /// 自動塗りを有効にしているプレイヤーのAPを割合消費して隣接マスを自動塗抹する
    #[cfg(test)]
    async fn run_auto_paint_tick(
        &self,
        season_id: i64,
    ) -> Result<Vec<(u16, u16, crate::board::Cell)>, String> {
        let (board_size, cells_clone) = {
            let board = self.board.read();
            (board.size, board.cells.clone())
        };
        let sim = self
            .simulate_auto_paint(season_id, board_size, cells_clone, None)
            .await?;

        if !sim.user_updates.is_empty()
            || !sim.core_increments.is_empty()
            || !sim.painted_factions.is_empty()
        {
            let mut tx = begin_immediate(&self.pool)
                .await
                .map_err(|e| format!("自動塗りDB更新開始失敗: {}", e))?;
            for (uid, _, _, used_ap, _) in &sim.user_updates {
                sqlx::query("UPDATE users SET ap = MAX(0, ap - ?) WHERE id = ?")
                    .bind(used_ap)
                    .bind(uid)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("自動塗りAP更新失敗: {}", e))?;
            }
            for (fid, inc) in &sim.core_increments {
                sqlx::query(
                    "UPDATE factions SET initial_core_used = initial_core_used + ? WHERE id = ?",
                )
                .bind(inc)
                .bind(fid)
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("自動塗り中核更新失敗: {}", e))?;
            }
            for &fid in &sim.painted_factions {
                sqlx::query("UPDATE factions SET ever_had_territory = 1 WHERE id = ?")
                    .bind(fid)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("自動塗り領土履歴更新失敗: {}", e))?;
            }
            for (uid, uname, fid, used_ap, painted) in &sim.user_updates {
                record_player_log_tx(
                    &mut tx,
                    season_id,
                    *uid,
                    uname,
                    *fid,
                    "territory",
                    &format!("自動塗りで {} マス塗抹 (-{} AP)", painted, used_ap),
                )
                .await;
            }
            tx.commit()
                .await
                .map_err(|e| format!("自動塗りDBコミット失敗: {}", e))?;
        }

        // DB コミット成功後にメモリ上の盤面へ反映する（DB失敗時は盤面を変更しない）
        if !sim.changed_cells.is_empty() {
            let mut board = self.board.write();
            for &(x, y, cell) in &sim.changed_cells {
                let idx = board.idx(x as usize, y as usize);
                board.cells[idx] = cell;
                board.mark_chunk_dirty(x as usize, y as usize);
            }
        }

        Ok(sim.changed_cells)
    }

    /// タイムラプスフレームをロック外で gzip 圧縮し、timelapse_write_lock 保持下で season_id / map_generation を検証して保存する
    async fn save_timelapse_frame_guarded(
        &self,
        season_id: i64,
        tick_number: u16,
        expected_gen: u64,
        board_size: usize,
        raw_bytes: Vec<u8>,
    ) -> Result<(), String> {
        let gz = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
            let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
            enc.write_all(&raw_bytes)
                .map_err(|e| format!("タイムラプス圧縮失敗: {}", e))?;
            enc.finish()
                .map_err(|e| format!("タイムラプス圧縮完了失敗: {}", e))
        })
        .await
        .map_err(|e| format!("タイムラプス圧縮タスク失敗: {}", e))??;

        let _tl_guard = self.timelapse_write_lock.lock().await;
        if self.current_season_id() != season_id
            || self.map_generation.load(Ordering::Acquire) != expected_gen
        {
            // 保存完了前にシーズン遷移またはマップ再生成が発生したため旧フレームを破棄する
            return Ok(());
        }

        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO timelapse_frames (season_id, tick_number, board_size, snapshot_gz, created_at)
            VALUES (?, ?, ?, ?, ?)
            "#,
        )
        .bind(season_id)
        .bind(tick_number as i64)
        .bind(board_size as i64)
        .bind(&gz)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| format!("タイムラプス保存失敗: {}", e))?;

        // シーズンあたりのフレーム上限を超えた場合は初期フレーム以外で古いものから削除する
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM timelapse_frames WHERE season_id = ?")
                .bind(season_id)
                .fetch_one(&self.pool)
                .await
                .unwrap_or(0);
        if count > MAX_TIMELAPSE_FRAMES_PER_SEASON {
            let excess = count - MAX_TIMELAPSE_FRAMES_PER_SEASON;
            let _ = sqlx::query(
                r#"
                DELETE FROM timelapse_frames
                WHERE id IN (
                    SELECT id FROM timelapse_frames
                    WHERE season_id = ?
                    ORDER BY (tick_number = 0) ASC, id ASC
                    LIMIT ?
                )
                "#,
            )
            .bind(season_id)
            .bind(excess)
            .execute(&self.pool)
            .await;
        }
        Ok(())
    }

    /// action_mutex 内で現在の盤面・世代情報を原子取得し、ロック外でタイムラプスフレームを保存してティック番号を返す
    pub async fn capture_timelapse_frame_current(&self) -> Result<u16, String> {
        let (season_id, tick_num, expected_gen, board_size, raw_bytes) = {
            let _action_guard = self.action_mutex.lock().await;
            let season_id = self.current_season_id();
            let tick_num = self.current_tick_number();
            let expected_gen = self.map_generation.load(Ordering::Acquire);
            let (board_size, raw_bytes) = {
                let board = self.board.read();
                (board.size, board.as_bytes().to_vec())
            };
            (season_id, tick_num, expected_gen, board_size, raw_bytes)
        };
        self.save_timelapse_frame_guarded(season_id, tick_num, expected_gen, board_size, raw_bytes)
            .await?;
        Ok(tick_num)
    }

    /// 現在の盤面スナップショットをタイムラプスフレームとして保存する（互換用）
    #[allow(dead_code)]
    pub async fn capture_timelapse_frame(&self, tick_number: u16) -> Result<(), String> {
        let (season_id, expected_gen, board_size, raw_bytes) = {
            let _action_guard = self.action_mutex.lock().await;
            let season_id = self.current_season_id();
            let expected_gen = self.map_generation.load(Ordering::Acquire);
            let (board_size, raw_bytes) = {
                let board = self.board.read();
                (board.size, board.as_bytes().to_vec())
            };
            (season_id, expected_gen, board_size, raw_bytes)
        };
        self.save_timelapse_frame_guarded(season_id, tick_number, expected_gen, board_size, raw_bytes)
            .await
    }

    /// 管理者/開発者による手動ティック実行（開催フェーズ以外では拒否）
    pub async fn execute_manual_tick(&self) -> Result<TickSummary, String> {
        let action_guard = self.action_mutex.lock().await;
        match self.current_phase() {
            SeasonPhase::Active => {}
            SeasonPhase::Preparation => {
                return Err("準備フェーズ中はティックを実行できません".into());
            }
            SeasonPhase::Frozen => {
                return Err("凍結フェーズ中はティックを実行できません".into());
            }
        }
        self.execute_tick_locked(action_guard, true, false, None, None, None, None)
            .await
    }

    /// 毎時00分または手動操作によるターンティック処理を実行する
    #[cfg(test)]
    pub async fn execute_hourly_tick(&self, is_manual: bool) -> Result<TickSummary, String> {
        let action_guard = self.action_mutex.lock().await;
        self.execute_tick_locked(action_guard, is_manual, false, None, None, None, None)
            .await
    }

    /// 定期スケジューラからのターンティック処理を実行する（action_mutex 内でフェーズ・境界条件・対象分・既実行キーを再検証し、完了キーを同一TXで原子保存）
    #[cfg(test)]
    pub async fn execute_scheduled_tick(
        &self,
        allow_when_frozen_boundary: bool,
        minute_key: i64,
        hour_key: Option<(i64, u32)>,
        now: chrono::DateTime<Utc>,
    ) -> Result<Option<TickSummary>, String> {
        self.execute_scheduled_tick_for_slot(
            allow_when_frozen_boundary,
            minute_key,
            hour_key,
            now,
            now,
        )
        .await
    }

    /// 遅延補完・分跨ぎ終了境界対応の定期スケジューラ用ターンティック処理を実行する
    pub async fn execute_scheduled_tick_for_slot(
        &self,
        allow_when_frozen_boundary: bool,
        slot_minute_key: i64,
        slot_hour_key: Option<(i64, u32)>,
        slot_now: chrono::DateTime<Utc>,
        current_now: chrono::DateTime<Utc>,
    ) -> Result<Option<TickSummary>, String> {
        let action_guard = self.action_mutex.lock().await;
        let season_id = self.current_season_id();
        let rules = self.current_game_rules();
        let schedule = SeasonSchedule::from_rules(rules);
        let current_phase = self.phase_at(current_now);
        if allow_when_frozen_boundary {
            let is_valid_boundary = self.phase_override.read().is_none()
                && self.auto_frozen_season_id.load(Ordering::Acquire) != season_id
                && rules.tick_interval_minutes == 60
                && rules.max_ticks == 48
                && current_phase == SeasonPhase::Frozen
                && is_season_end_boundary_minute(slot_now, schedule)
                && current_season_end_boundary_at(current_now, schedule)
                    .is_some_and(|b| b.timestamp() / 60 == slot_now.timestamp() / 60);
            if !is_valid_boundary {
                return Ok(None);
            }
        } else {
            if current_phase != SeasonPhase::Active {
                return Ok(None);
            }
            let lag_min = (current_now.timestamp() / 60) - (slot_now.timestamp() / 60);
            if !(0..=SCHEDULE_CATCHUP_GRACE_MINUTES).contains(&lag_min) {
                return Ok(None);
            }
            if self.phase_override.read().is_none()
                && (is_season_start_minute(slot_now, schedule)
                    || compute_phase_jst_with_schedule(slot_now, schedule) != SeasonPhase::Active)
            {
                return Ok(None);
            }
            let tick_interval = rules.tick_interval_minutes.max(1);
            let is_due_minute = if tick_interval == 60 {
                slot_now.minute() == schedule.start_minute as u32
            } else {
                is_ap_refill_minute_with_schedule(slot_now, tick_interval, 0, schedule)
            };
            if !is_due_minute {
                return Ok(None);
            }
        }
        // action_mutex 内で最新ルールから 60 分モード用 hour_key を決定し TOCTOU 競合を防ぐ
        let effective_hour_key = if rules.tick_interval_minutes.max(1) == 60 {
            Some(slot_hour_key.unwrap_or_else(|| (slot_now.timestamp() / 3600, slot_now.hour())))
        } else {
            None
        };
        if let Some((bucket, hour)) = effective_hour_key {
            let expected = format!("{}:{}", bucket, hour);
            if load_setting_strict(&self.pool, "last_tick_hour")
                .await
                .map_err(|e| format!("last_tick_hour 読み込み失敗: {}", e))?
                .is_some_and(|v| {
                    parse_hour_bucket(&v).is_some_and(|saved_bucket| saved_bucket >= bucket)
                        || v.trim() == expected
                })
            {
                return Ok(None);
            }
        }
        if load_setting_strict(&self.pool, "last_tick_minute")
            .await
            .map_err(|e| format!("last_tick_minute 読み込み失敗: {}", e))?
            .and_then(|s| s.trim().parse::<i64>().ok())
            .is_some_and(|saved| saved >= slot_minute_key)
        {
            return Ok(None);
        }
        let summary = self
            .execute_tick_locked(
                action_guard,
                false,
                allow_when_frozen_boundary,
                Some(slot_minute_key),
                effective_hour_key,
                Some(current_now),
                Some(slot_now),
            )
            .await?;
        Ok(Some(summary))
    }

    /// AP補充・自動塗り・盤面ティック・勢力集計・設定永続化を単一トランザクションで原子的に実行する
    #[allow(clippy::too_many_arguments)]
    async fn execute_tick_locked<'a>(
        &'a self,
        action_guard: tokio::sync::MutexGuard<'a, ()>,
        is_manual: bool,
        is_boundary: bool,
        minute_key: Option<i64>,
        hour_key: Option<(i64, u32)>,
        now: Option<chrono::DateTime<Utc>>,
        slot_now: Option<chrono::DateTime<Utc>>,
    ) -> Result<TickSummary, String> {
        let season_id = self.current_season_id();
        let expected_gen = self.map_generation.load(Ordering::Acquire);
        let target_now = now.unwrap_or_else(Utc::now);
        let effective_slot_now = slot_now.unwrap_or(target_now);
        if !is_manual && !is_boundary && self.phase_at(target_now) != SeasonPhase::Active {
            return Err("開催フェーズではないため定期ティックをスキップしました".into());
        }

        let ap_cfg = self.current_ap_config();
        let rules = self.current_game_rules();
        let schedule = SeasonSchedule::from_rules(rules);

        // 手動実行時は無条件補充、終了境界ティックや自動スケジュール開幕直後はAP補充・自動塗りをスキップし、定期実行時は最新設定から判定する
        let is_synced_hourly = rules.tick_interval_minutes.max(1) == 60
            && ap_cfg.refill_interval_minutes == 60
            && ap_cfg.refill_offset_minute == 0;
        let is_auto_start_min = !is_manual
            && self.phase_override.read().is_none()
            && is_season_start_minute(effective_slot_now, schedule);
        let should_refill_ap = if is_boundary || is_auto_start_min {
            false
        } else if is_manual {
            true
        } else {
            let ap_due = is_synced_hourly
                || is_ap_refill_minute_with_schedule(
                    effective_slot_now,
                    ap_cfg.refill_interval_minutes,
                    ap_cfg.refill_offset_minute,
                    schedule,
                );
            if !ap_due {
                false
            } else if let Some(mk) = minute_key {
                load_setting_strict(&self.pool, "last_refill_minute")
                    .await
                    .map_err(|e| format!("last_refill_minute 読み込み失敗: {}", e))?
                    .and_then(|s| s.trim().parse::<i64>().ok())
                    .is_none_or(|saved| saved < mk)
            } else {
                true
            }
        };
        let (eff_max_ap, eff_refill_min, eff_refill_max) = self.effective_ap_bounds_at(target_now);
        let ap_gains = if should_refill_ap {
            self.compute_ap_refill_gains(eff_refill_min, eff_refill_max)
                .await?
        } else {
            Vec::new()
        };
        let ap_bonus_map: HashMap<i64, i64> = ap_gains.iter().copied().collect();

        let (board_size, cells_clone) = {
            let board = self.board.read();
            (board.size, board.cells.clone())
        };

        // クローン盤面上で自動塗りシミュレーションを実行（終了境界ティック時はスキップ）
        let auto_sim = if is_boundary {
            AutoPaintSimulation {
                updated_cells: cells_clone,
                changed_cells: Vec::new(),
                user_updates: Vec::new(),
                core_increments: HashMap::new(),
                painted_factions: HashSet::new(),
                captured_enemy_cores: HashMap::new(),
            }
        } else {
            self.simulate_auto_paint(
                season_id,
                board_size,
                cells_clone,
                if ap_gains.is_empty() {
                    None
                } else {
                    Some((&ap_bonus_map, eff_max_ap))
                },
            )
            .await?
        };

        // 自動塗り後のクローン盤面上で盤面ティック計算を実行
        let assimilation_ticks = rules.assimilation_required_ticks;
        let (final_cells, mut report) = tokio::task::spawn_blocking(move || {
            let mut tmp_board = Board::from_cells(board_size, auto_sim.updated_cells);
            let report = run_board_tick_with_rules(&mut tmp_board, assimilation_ticks);
            (tmp_board.cells, report)
        })
        .await
        .map_err(|e| format!("ティック盤面計算タスク失敗: {}", e))?;

        let faction_rows = sqlx::query(
            "SELECT id, name, is_extinct, territory_count, ever_had_territory FROM factions WHERE season_id = ?",
        )
        .bind(season_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| format!("勢力取得失敗: {}", e))?;

        let mut newly_extinct_factions = Vec::new();
        let mut newly_extinct_logs: Vec<(i64, String)> = Vec::new();
        let mut revived_factions: Vec<(i64, String)> = Vec::new();
        let mut faction_names: HashMap<u16, String> = HashMap::with_capacity(faction_rows.len());
        let mut faction_updates: Vec<(i64, i64, i64, i64, i64)> =
            Vec::with_capacity(faction_rows.len());
        for row in faction_rows {
            let fid: i64 = row.get("id");
            let fname: String = row.get("name");
            if let Ok(fid_u16) = u16::try_from(fid) {
                faction_names.insert(fid_u16, fname.clone());
            }
            let was_extinct: i64 = row.get("is_extinct");
            let prev_terr: i64 = row.get("territory_count");
            let ever_had_territory: i64 = row.get("ever_had_territory");
            let (terr, core) = report
                .faction_stats
                .get(&(fid as u16))
                .copied()
                .unwrap_or((0, 0));
            // 一度でも領土を持ったことがある勢力が領土0になったら滅亡（未入植の新設勢力は除外）
            let ever_had = ever_had_territory != 0
                || prev_terr > 0
                || was_extinct != 0
                || terr > 0
                || auto_sim.painted_factions.contains(&fid);
            let is_extinct = if terr == 0 && ever_had { 1 } else { 0 };
            if is_extinct == 1 && was_extinct == 0 {
                newly_extinct_factions.push(fid);
                newly_extinct_logs.push((fid, fname));
            } else if is_extinct == 0 && was_extinct != 0 {
                revived_factions.push((fid, fname));
            }
            faction_updates.push((
                fid,
                terr as i64,
                core as i64,
                is_extinct,
                if ever_had { 1i64 } else { 0i64 },
            ));
        }

        // オフセット更新および自動凍結判定を事前に確定する
        let is_custom_tick = rules.tick_interval_minutes != 60 || rules.max_ticks != 48;
        let is_manual_or_custom = is_custom_tick || self.phase_override.read().is_some();
        let phase_before_inc = self.phase_at(target_now);
        let cur_offset = *self.manual_tick_offset.read();
        let next_offset_to_save: Option<u16> = if (is_manual && phase_before_inc != SeasonPhase::Frozen)
            || (phase_before_inc == SeasonPhase::Active
                && (is_manual_or_custom
                    || compute_phase_jst_with_schedule(target_now, schedule)
                        != SeasonPhase::Active))
            || (is_boundary && is_custom_tick)
        {
            Some(cur_offset.saturating_add(1))
        } else {
            None
        };
        let effective_offset = next_offset_to_save.unwrap_or(cur_offset);
        let next_tick_num = if is_manual_or_custom {
            effective_offset
        } else {
            let base = compute_tick_number_with_schedule(target_now, phase_before_inc, schedule);
            if phase_before_inc == SeasonPhase::Frozen {
                base
            } else {
                base.saturating_add(effective_offset)
            }
        };
        let should_auto_freeze =
            next_tick_num >= rules.max_ticks && phase_before_inc == SeasonPhase::Active;
        // 標準自動スケジュールではスケジュール時刻ベースで既に next_tick_num が進んでいるため、直前ティックから突入判定する
        let prev_tick_num = if next_offset_to_save.is_none() && !is_manual && !is_boundary {
            next_tick_num.saturating_sub(1)
        } else {
            self.actual_tick_number_at(target_now)
        };
        let was_boost = Self::is_endgame_boost_at_tick(ap_cfg, rules.max_ticks, prev_tick_num);
        let next_boost = Self::is_endgame_boost_at_tick(ap_cfg, rules.max_ticks, next_tick_num);
        let boost_active_now = self.is_endgame_ap_boost_active_at(target_now);

        // 全 DB 更新（AP 補充・自動塗り・行動ログ・勢力集計・設定）を単一 BEGIN IMMEDIATE トランザクションで原子的にコミット
        {
            let mut tx = begin_immediate(&self.pool)
                .await
                .map_err(|e| format!("ティック更新TX開始失敗: {}", e))?;

            if !ap_gains.is_empty() {
                if eff_refill_min >= eff_refill_max {
                    // 固定値補充時は単一 UPDATE で一括更新する
                    sqlx::query("UPDATE users SET ap = MIN(?, ap + ?)")
                        .bind(eff_max_ap)
                        .bind(eff_refill_min)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| format!("AP一括更新失敗: {}", e))?;
                } else {
                    for (uid, gain) in &ap_gains {
                        sqlx::query("UPDATE users SET ap = MIN(?, ap + ?) WHERE id = ?")
                            .bind(eff_max_ap)
                            .bind(gain)
                            .bind(uid)
                            .execute(&mut *tx)
                            .await
                            .map_err(|e| format!("AP更新失敗: {}", e))?;
                    }
                }
            }

            for (uid, _, _, used_ap, _) in &auto_sim.user_updates {
                sqlx::query("UPDATE users SET ap = MAX(0, ap - ?) WHERE id = ?")
                    .bind(used_ap)
                    .bind(uid)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("自動塗りAP更新失敗: {}", e))?;
            }

            for (fid, inc) in &auto_sim.core_increments {
                sqlx::query(
                    "UPDATE factions SET initial_core_used = initial_core_used + ? WHERE id = ?",
                )
                .bind(inc)
                .bind(fid)
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("自動塗り中核更新失敗: {}", e))?;
            }

            for &fid in &auto_sim.painted_factions {
                sqlx::query("UPDATE factions SET ever_had_territory = 1 WHERE id = ?")
                    .bind(fid)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("自動塗り領土履歴更新失敗: {}", e))?;
            }

            for (uid, uname, fid, used_ap, painted) in &auto_sim.user_updates {
                record_player_log_tx(
                    &mut tx,
                    season_id,
                    *uid,
                    uname,
                    *fid,
                    "territory",
                    &format!("自動塗りで {} マス塗抹 (-{} AP)", painted, used_ap),
                )
                .await;
            }

            for (fid, fname) in &newly_extinct_logs {
                record_player_log_tx(
                    &mut tx,
                    season_id,
                    0,
                    "システム",
                    *fid,
                    "faction",
                    &format!("勢力「{}」が滅亡した", fname),
                )
                .await;
            }

            for (fid, fname) in &revived_factions {
                record_player_log_tx(
                    &mut tx,
                    season_id,
                    0,
                    "システム",
                    *fid,
                    "faction",
                    &format!("勢力「{}」が滅亡から再起した", fname),
                )
                .await;
            }

            if should_refill_ap {
                let range_str = if eff_refill_min >= eff_refill_max {
                    format!("+{} AP", eff_refill_min)
                } else {
                    format!("+{}〜{} AP", eff_refill_min, eff_refill_max)
                };
                let boost_suffix = if boost_active_now {
                    "・終盤ブースト適用中"
                } else {
                    ""
                };
                let prefix = if is_manual {
                    "手動ティックにより AP 補充を実施した"
                } else {
                    "定期 AP 補充を実施した"
                };
                record_player_log_tx(
                    &mut tx,
                    season_id,
                    0,
                    "システム",
                    0,
                    "ap",
                    &format!(
                        "{}（{} / 上限 {} AP{}）",
                        prefix, range_str, eff_max_ap, boost_suffix
                    ),
                )
                .await;
            }

            if phase_before_inc == SeasonPhase::Active
                && !should_auto_freeze
                && !was_boost
                && next_boost
            {
                record_player_log_tx(
                    &mut tx,
                    season_id,
                    0,
                    "システム",
                    0,
                    "ap",
                    &format!(
                        "終盤 AP ブーストが発動した（補充・上限 ×{:.1}倍）",
                        ap_cfg.endgame_ap_multiplier
                    ),
                )
                .await;
            }

            record_player_log_tx(
                &mut tx,
                season_id,
                0,
                "システム",
                0,
                "system",
                &format!(
                    "Tick #{} が完了した（自然中核化 {} マス / 旧中核消滅 {} マス）",
                    next_tick_num, report.promoted_cores, report.expired_old_cores
                ),
            )
            .await;

            if should_auto_freeze {
                record_player_log_tx(
                    &mut tx,
                    season_id,
                    0,
                    "システム",
                    0,
                    "system",
                    "最大 Tick に到達し、凍結（結果発表）フェーズへ移行した",
                )
                .await;
            }

            for (fid, terr, core, is_extinct, ever_had) in faction_updates {
                sqlx::query(
                    "UPDATE factions SET territory_count = ?, core_count = ?, is_extinct = ?, ever_had_territory = ? WHERE id = ?",
                )
                .bind(terr)
                .bind(core)
                .bind(is_extinct)
                .bind(ever_had)
                .bind(fid)
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("勢力集計更新失敗: {}", e))?;
            }

            if let Some(next_offset) = next_offset_to_save {
                save_setting_tx(&mut tx, "manual_tick_offset", &next_offset.to_string()).await?;
            }
            if should_auto_freeze {
                save_setting_tx(&mut tx, "auto_frozen_season_id", &season_id.to_string()).await?;
            }
            if let Some(mk) = minute_key {
                save_setting_tx(&mut tx, "last_tick_minute", &mk.to_string()).await?;
                if should_refill_ap {
                    save_setting_tx(&mut tx, "last_refill_minute", &mk.to_string()).await?;
                }
            }
            if let Some((bucket, hour)) = hour_key {
                save_setting_tx(&mut tx, "last_tick_hour", &format!("{}:{}", bucket, hour)).await?;
            }

            tx.commit()
                .await
                .map_err(|e| format!("ティック更新コミット失敗: {}", e))?;
        }

        // 自動塗り差分と盤面ティック差分を統合（後続の盤面ティック側を優先）
        if !auto_sim.changed_cells.is_empty() {
            let mut dedup: HashMap<(u16, u16), crate::board::Cell> =
                HashMap::with_capacity(auto_sim.changed_cells.len() + report.changed_cells.len());
            for (x, y, cell) in auto_sim.changed_cells {
                dedup.insert((x, y), cell);
            }
            for (x, y, cell) in report.changed_cells {
                dedup.insert((x, y), cell);
            }
            report.changed_cells = dedup
                .into_iter()
                .map(|((x, y), cell)| (x, y, cell))
                .collect();
        }

        // DB TX コミット成功後にメモリ盤面を更新し、同じ board.write() ロック内でチャンク数分のバージョンを進める
        let (tl_board_size, tl_raw_bytes, start_ver) = {
            let mut board = self.board.write();
            board.cells = final_cells;
            for &(x, y, _) in &report.changed_cells {
                board.mark_chunk_dirty(x as usize, y as usize);
            }
            let start_ver = if !report.changed_cells.is_empty() {
                let chunk_count = report.changed_cells.chunks(4000).len().max(1) as u64;
                Some(self.bump_board_version_n(chunk_count).0)
            } else {
                None
            };
            (board.size, board.as_bytes().to_vec(), start_ver)
        };
        if start_ver.is_some() {
            self.clear_snapshot_cache();
        }
        self.invalidate_factions_cache();

        if let Some(next_offset) = next_offset_to_save {
            *self.manual_tick_offset.write() = next_offset;
        }
        if should_auto_freeze {
            self.auto_frozen_season_id
                .store(season_id, Ordering::Release);
        }

        let tick_num = self.tick_number_at(target_now);
        let phase = self.phase_at(target_now);
        let next_tick = self.next_refill_unix_at(target_now);

        // イベント順序逆転を防ぐため、分割差分・tick_sync・各種イベントのブロードキャストを action_mutex 解放前（タイムラプス保存前）に実行する
        if let Some(sv) = start_ver {
            for (i, chunk) in report.changed_cells.chunks(4000).enumerate() {
                let ver = sv + i as u64;
                self.broadcast_frame(encode_cell_diff_batch(ver, chunk));
            }
        }

        self.broadcast_tick_sync(
            phase,
            tick_num,
            0,
            next_tick,
            season_id,
        );

        let event = serde_json::json!({
            "type": "hourly_tick",
            "tick_number": tick_num,
            "promoted_cores": report.promoted_cores,
            "expired_old_cores": report.expired_old_cores,
            "newly_extinct_factions": newly_extinct_factions,
            "ap_refilled": should_refill_ap,
            "tick_interval_minutes": rules.tick_interval_minutes,
            "endgame_boost": self.is_endgame_ap_boost_active_at(target_now),
        });
        self.broadcast_frame(encode_event_json(&event.to_string()));

        // 自動塗りで1マス以上獲得したプレイヤー本人へ実行結果を通知する
        for (uid, _uname, _fid, used_ap, painted) in auto_sim.user_updates {
            if painted > 0 {
                let auto_event = serde_json::json!({
                    "type": "auto_paint_executed",
                    "spent_ap": used_ap,
                    "painted_cells": painted,
                });
                self.send_event_to_user(uid, encode_event_json(&auto_event.to_string()));
            }
        }

        // 自動塗りで敵中核マスを奪取した場合、被害勢力メンバーへクールダウン付きでアラートを送信する
        for ((defender_fid, attacker_fid), (cx, cy)) in auto_sim.captured_enemy_cores {
            let on_cooldown = self
                .core_attack_alert_cooldown
                .get(&(defender_fid, attacker_fid))
                .is_some_and(|t| {
                    t.elapsed() < std::time::Duration::from_secs(CORE_ATTACK_ALERT_COOLDOWN_SECS)
                });
            if on_cooldown {
                continue;
            }
            if let Ok(uids) = sqlx::query_scalar::<_, i64>(
                "SELECT user_id FROM faction_members WHERE faction_id = ?",
            )
            .bind(defender_fid as i64)
            .fetch_all(&self.pool)
            .await
            {
                if !uids.is_empty() {
                    let attacker_name = faction_names
                        .get(&attacker_fid)
                        .cloned()
                        .unwrap_or_else(|| format!("勢力#{}", attacker_fid));
                    let core_event = serde_json::json!({
                        "type": "core_attacked",
                        "defender_faction_id": defender_fid,
                        "attacker_faction_id": attacker_fid,
                        "attacker_name": attacker_name,
                        "x": cx,
                        "y": cy,
                    });
                    // 実際に1接続以上へ配信できた場合のみクールダウンを記録する
                    let delivered =
                        self.send_event_to_users(&uids, encode_event_json(&core_event.to_string()));
                    if delivered > 0 {
                        self.core_attack_alert_cooldown
                            .insert((defender_fid, attacker_fid), Instant::now());
                    }
                }
            }
        }

        // 新たに滅亡（亡命状態）になった勢力をブロードキャスト通知する
        for (fid, fname) in newly_extinct_logs {
            let extinct_event = serde_json::json!({
                "type": "faction_extinct",
                "faction_id": fid,
                "faction_name": fname,
            });
            self.broadcast_frame(encode_event_json(&extinct_event.to_string()));
        }

        for (fid, fname) in revived_factions {
            let revive_event = serde_json::json!({
                "type": "faction_revived",
                "faction_id": fid,
                "faction_name": fname,
            });
            self.broadcast_frame(encode_event_json(&revive_event.to_string()));
        }

        if let Err(e) = self.flush_dirty_chunks_locked().await {
            tracing::error!("ティック後のダーティチャンク保存エラー: {}", e);
        }

        drop(action_guard);

        // action_mutex 解放後にタイムラプスフレームを gzip 圧縮・世代検証付きで保存する
        let _ = self
            .save_timelapse_frame_guarded(
                season_id,
                tick_num,
                expected_gen,
                tl_board_size,
                tl_raw_bytes,
            )
            .await;

        Ok(TickSummary {
            tick_number: tick_num,
            promoted_cores: report.promoted_cores,
            expired_old_cores: report.expired_old_cores,
            changed_cell_count: report.changed_cells.len(),
            newly_extinct_factions,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_memory_db, load_setting};
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

    #[tokio::test]
    async fn hourly_tick_grants_ap_and_detects_extinct_faction() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(250, &vec![1u8; 250 * 250]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO users (username, password_hash, ap, faction_id, created_at) VALUES ('u1', 'h', 30, 1, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO users (username, password_hash, ap, faction_id, created_at) VALUES ('u2', 'h', 97, 0, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO factions (season_id, name, color_id, leader_user_id, territory_count, is_extinct, created_at) VALUES (1, '亡命予定国', 5, 1, 10, 0, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();

        let mut bcast_rx = state.broadcast_tx.subscribe();
        let summary = state.execute_hourly_tick(true).await.unwrap();
        assert_eq!(summary.newly_extinct_factions, vec![1]);

        let mut found_extinct_event = false;
        let mut found_hourly_tick_boost = false;
        while let Ok(frame) = bcast_rx.try_recv() {
            if frame.first() == Some(&crate::protocol::OP_SERVER_EVENT_JSON) {
                if let Ok(ev) = serde_json::from_slice::<serde_json::Value>(&frame[1..]) {
                    if ev["type"] == "hourly_tick" {
                        assert!(
                            ev["endgame_boost"].is_boolean(),
                            "hourly_tick には endgame_boost ブール値が含まれるべきです"
                        );
                        found_hourly_tick_boost = true;
                    }
                    if ev["type"] == "faction_extinct" {
                        assert_eq!(ev["faction_id"], 1);
                        assert_eq!(ev["faction_name"], "亡命予定国");
                        found_extinct_event = true;
                    }
                }
            }
        }
        assert!(found_hourly_tick_boost, "hourly_tick イベントがブロードキャストされるべきです");
        assert!(found_extinct_event, "滅亡時に faction_extinct イベントがブロードキャストされるべきです");

        let ap1: i64 = sqlx::query("SELECT ap FROM users WHERE username = 'u1'")
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .get("ap");
        assert!((36..=42).contains(&ap1), "u1のAP付与が範囲外: {}", ap1);

        let ap2: i64 = sqlx::query("SELECT ap FROM users WHERE username = 'u2'")
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .get("ap");
        assert_eq!(ap2, 100, "AP上限100を超えてはいけません");

        let extinct: i64 = sqlx::query("SELECT is_extinct FROM factions WHERE id = 1")
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .get("is_extinct");
        assert_eq!(extinct, 1, "領土0の勢力は滅亡状態になるべきです");

        let log_row = sqlx::query(
            "SELECT user_id, username, faction_id, category, summary FROM player_logs WHERE faction_id = 1 AND category = 'faction'",
        )
        .fetch_one(&state.pool)
        .await
        .unwrap();
        assert_eq!(log_row.get::<i64, _>("user_id"), 0);
        assert_eq!(log_row.get::<String, _>("username"), "システム");
        assert_eq!(log_row.get::<String, _>("summary"), "勢力「亡命予定国」が滅亡した");
    }

    #[tokio::test]
    async fn regenerate_map_changes_size_and_resets_state() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(10);
        let board = Board::from_terrain(250, &vec![1u8; 250 * 250]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'old_player', 'hash', 30, 0, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        state.cache_user_session("tok1".to_string(), 1, Utc::now().timestamp() + 3600);

        let next_params = MapGenParams {
            size: 500,
            continent_count: 2,
            island_count: 10,
            land_ratio_pct: 45,
            seed: 777,
        };
        state.regenerate_map(next_params).await.unwrap();
        assert_eq!(state.current_board_size(), 500);
        assert_eq!(state.current_map_params(), next_params);
        assert_eq!(state.board.read().cells.len(), 500 * 500);

        let user_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(user_count, 0);
        assert!(state.session_cache.is_empty());
    }

    #[tokio::test]
    async fn auto_paint_shares_candidates_and_core_quota_across_members() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let mut board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        // 勢力1の既存領土を (50, 50) に1マス配置
        let idx = board.idx(50, 50);
        board.cells[idx].faction_id = 1;
        board.cells[idx].color_id = 2;
        board.cells[idx].layers = 1;
        board.cells[idx].set_core(true);

        let state = AppState::new(test_config(), pool, board, params, 1);
        {
            let mut rules = state.game_rules.write();
            rules.initial_core_quota = 3;
        }

        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO factions (id, season_id, name, color_id, leader_user_id, initial_core_used, allow_auto_paint, created_at) VALUES (1, 1, 'F1', 2, 1, 1, 1, ?)",
        )
        .bind(&now)
        .execute(&state.pool)
        .await
        .unwrap();

        for (uid, uname) in [(1, "m1"), (2, "m2")] {
            sqlx::query(
                "INSERT INTO users (id, username, password_hash, ap, faction_id, auto_paint_enabled, auto_paint_pct, created_at) VALUES (?, ?, 'h', 20, 1, 1, 50, ?)",
            )
            .bind(uid)
            .bind(uname)
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        }

        let changed = state.run_auto_paint_tick(1).await.unwrap();
        assert!(!changed.is_empty());

        // 初期中核枠3を超えて消費されていないことを確認
        let core_used: i64 = sqlx::query("SELECT initial_core_used FROM factions WHERE id = 1")
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .get("initial_core_used");
        assert!(
            core_used <= 3,
            "複数メンバー同時自動塗りで初期中核枠(3)を超えてはいけません: {}",
            core_used
        );

        // 2人とも既存領土からの連結拡大（隣接マス1AP）で塗れているため、高コストな飛び地ばかりになっていないことを確認
        let terr_count = state
            .board
            .read()
            .cells
            .iter()
            .filter(|c| c.faction_id == 1)
            .count();
        assert!(
            terr_count >= 15,
            "2人目も既存領土に隣接して塗れるべきです: terr_count={}",
            terr_count
        );
    }

    #[tokio::test]
    async fn execute_hourly_tick_notifies_auto_paint_result() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let mut board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let idx = board.idx(50, 50);
        board.cells[idx].faction_id = 1;
        board.cells[idx].color_id = 2;
        board.cells[idx].layers = 1;
        board.cells[idx].set_core(true);

        let state = AppState::new(test_config(), pool, board, params, 1);
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO factions (id, season_id, name, color_id, leader_user_id, initial_core_used, allow_auto_paint, territory_count, ever_had_territory, created_at) VALUES (1, 1, 'F1', 2, 1, 1, 1, 1, 1, ?)",
        )
        .bind(&now)
        .execute(&state.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO users (id, username, password_hash, ap, faction_id, auto_paint_enabled, auto_paint_pct, created_at) VALUES (1, 'ap_u1', 'h', 20, 1, 1, 50, ?)",
        )
        .bind(&now)
        .execute(&state.pool)
        .await
        .unwrap();

        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        state.register_ws_user_sender(1, "tok_ap_u1".to_string(), tx);

        state.execute_hourly_tick(true).await.unwrap();
        let frame = rx.try_recv().expect("自動塗り実行後に本人へ通知が届くべきです");
        assert_eq!(frame.first(), Some(&crate::protocol::OP_SERVER_EVENT_JSON));
        let ev: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
        assert_eq!(ev["type"], "auto_paint_executed");
        assert!(ev["spent_ap"].as_i64().unwrap() > 0);
        assert!(ev["painted_cells"].as_i64().unwrap() > 0);
    }

    #[tokio::test]
    async fn expired_rfc3339_sessions_are_rejected_and_deleted() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);
        {
            let mut rules = state.game_rules.write();
            rules.tick_interval_minutes = 60;
            rules.max_ticks = 48;
        }

        let now_str = Utc::now().to_rfc3339();
        let expired_str = (Utc::now() - chrono::Duration::hours(2)).to_rfc3339();

        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'u_exp', 'h', 30, 0, ?)")
            .bind(&now_str)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES ('tok_exp', 1, ?, ?)")
            .bind(&expired_str)
            .bind(&now_str)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO admin_sessions (token, admin_id, expires_at, created_at) VALUES ('adm_exp', 'admin', ?, ?)")
            .bind(&expired_str)
            .bind(&now_str)
            .execute(&state.pool)
            .await
            .unwrap();

        assert_eq!(state.resolve_active_user_session("tok_exp").await, None);
        assert_eq!(state.resolve_active_admin_session("adm_exp").await, None);

        // 期限切れセッションが削除され、再延長されていないことを確認
        let user_cnt: i64 = sqlx::query("SELECT COUNT(*) AS cnt FROM sessions WHERE token = 'tok_exp'")
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .get("cnt");
        let admin_cnt: i64 = sqlx::query("SELECT COUNT(*) AS cnt FROM admin_sessions WHERE token = 'adm_exp'")
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .get("cnt");
        assert_eq!(user_cnt, 0);
        assert_eq!(admin_cnt, 0);
    }

    #[tokio::test]
    async fn auto_paint_zero_territory_with_1ap_does_not_infinite_loop() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);
        {
            let mut rules = state.game_rules.write();
            rules.tick_interval_minutes = 60;
            rules.max_ticks = 48;
        }

        let now_str = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO factions (id, season_id, name, color_id, leader_user_id, initial_core_used, allow_auto_paint, created_at) VALUES (1, 1, 'F0', 3, 1, 0, 1, ?)",
        )
        .bind(&now_str)
        .execute(&state.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO users (id, username, password_hash, ap, faction_id, auto_paint_enabled, auto_paint_pct, created_at) VALUES (1, 'low_ap', 'h', 1, 1, 1, 100, ?)",
        )
        .bind(&now_str)
        .execute(&state.pool)
        .await
        .unwrap();

        // 領土0（飛び地コスト3AP）に対して予算1APのユーザーが無限ループせず正常終了すること
        let changed = state.run_auto_paint_tick(1).await.unwrap();
        assert!(changed.is_empty());
    }

    #[tokio::test]
    async fn hourly_tick_marks_extinct_when_ever_had_territory_and_zero_count() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);
        {
            let mut rules = state.game_rules.write();
            rules.tick_interval_minutes = 60;
            rules.max_ticks = 48;
        }

        let now_str = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO factions (id, season_id, name, color_id, leader_user_id, territory_count, is_extinct, ever_had_territory, created_at) VALUES (1, 1, 'ラスト1マス喪失国', 4, 1, 0, 0, 1, ?)",
        )
        .bind(&now_str)
        .execute(&state.pool)
        .await
        .unwrap();

        let summary = state.execute_hourly_tick(true).await.unwrap();
        assert_eq!(summary.newly_extinct_factions, vec![1]);

        let extinct: i64 = sqlx::query("SELECT is_extinct FROM factions WHERE id = 1")
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .get("is_extinct");
        assert_eq!(extinct, 1);
    }

    #[tokio::test]
    async fn custom_tick_interval_does_not_over_refill_ap_and_persists_tick_offset() {
        use chrono::TimeZone;

        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);
        *state.phase_override.write() = Some(SeasonPhase::Active);
        state.game_rules.write().tick_interval_minutes = 10;

        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'u_custom', 'h', 25, 0, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();

        // 毎時10分（非00分）の固定時刻でカスタム Tick 間隔 (10分) の定期ティックを実行し、デフォルト AP 補充 (60分/0分) が混入しないことを決定論的に検証
        let fixed_now = crate::season::jst_offset()
            .with_ymd_and_hms(2026, 3, 7, 0, 10, 0)
            .unwrap()
            .with_timezone(&Utc);
        let summary = state
            .execute_scheduled_tick(
                false,
                fixed_now.timestamp() / 60,
                Some((fixed_now.timestamp() / 3600, 15)),
                fixed_now,
            )
            .await
            .unwrap()
            .expect("10分間隔設定の10分時点では定期ティックが実行されるべきです");
        assert_eq!(summary.tick_number, 1);

        let ap: i64 = sqlx::query("SELECT ap FROM users WHERE id = 1")
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .get("ap");
        assert_eq!(ap, 25, "カスタム Tick 間隔時にデフォルト AP 補充が混入してはいけません");

        let saved_offset = crate::db::load_setting(&state.pool, "manual_tick_offset").await;
        assert_eq!(
            saved_offset.as_deref(),
            Some("1"),
            "manual_tick_offset が DB に永続化されているべきです"
        );
    }

    #[tokio::test]
    async fn auto_freeze_overrides_manual_active_phase_when_max_ticks_reached() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);
        *state.phase_override.write() = Some(SeasonPhase::Active);
        state.game_rules.write().max_ticks = 2;

        let s1 = state.execute_hourly_tick(false).await.unwrap();
        assert_eq!(s1.tick_number, 1);
        assert_eq!(state.current_phase(), SeasonPhase::Active);

        let s2 = state.execute_hourly_tick(false).await.unwrap();
        assert_eq!(s2.tick_number, 2);
        assert_eq!(
            state.current_phase(),
            SeasonPhase::Frozen,
            "phase_override=Active でも max_ticks 到達で自動凍結されるべきです"
        );
    }

    #[tokio::test]
    async fn auto_frozen_manual_active_season_rolls_over_to_next_season() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let current_target = crate::season::compute_season_id(Utc::now());
        let old_season = current_target.saturating_sub(1);
        let state = AppState::new(test_config(), pool, board, params, old_season);

        *state.phase_override.write() = Some(SeasonPhase::Active);
        state
            .auto_frozen_season_id
            .store(old_season, Ordering::Release);

        let rolled = state.check_season_rollover().await.unwrap();
        assert!(
            rolled,
            "自動凍結済みの手動開催シーズンは次シーズンへ自動ロールオーバーするべきです"
        );
        assert_eq!(state.current_season_id(), current_target);
        assert!(
            state.phase_override.read().is_none(),
            "新シーズンへのロールオーバー時は phase_override が解除されるべきです"
        );
    }

    #[tokio::test]
    async fn bump_board_version_n_returns_monotonic_range() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        assert_eq!(state.bump_board_version_n(3), (1, 3));
        assert_eq!(state.snapshot_version.load(Ordering::Acquire), 3);
        assert_eq!(state.bump_board_version_n(0), (4, 4));
        assert_eq!(state.snapshot_version.load(Ordering::Acquire), 4);
    }

    #[tokio::test]
    async fn execute_tick_assigns_strictly_increasing_versions_across_4000_cell_chunks() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let mut board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        for c in board.cells.iter_mut().take(4500) {
            c.old_core_faction = 1;
            c.set_old_core_ttl(1);
        }
        let state = AppState::new(test_config(), pool, board, params, 1);
        let mut rx = state.broadcast_tx.subscribe();

        let summary = state.execute_hourly_tick(true).await.unwrap();
        assert_eq!(summary.changed_cell_count, 4500);
        assert_eq!(summary.expired_old_cores, 4500);

        let mut diff_versions = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            if frame.first() == Some(&crate::protocol::OP_SERVER_CELL_DIFF) && frame.len() >= 9 {
                let ver = u64::from_le_bytes(frame[1..9].try_into().unwrap());
                diff_versions.push(ver);
            }
        }
        assert_eq!(
            diff_versions,
            vec![1, 2],
            "4,000セル超の分割差分は厳密単調増加のバージョンを割り当てるべきです"
        );
        assert_eq!(state.snapshot_version.load(Ordering::Acquire), 2);
    }

    #[tokio::test]
    async fn sync_tick_offset_and_scheduled_tick_boundary_and_dedup() {
        use chrono::TimeZone;

        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        // 初期状態（標準自動）から手動 Active へ切り替えても、自然凍結時に 48 を引き継がないこと
        let jst = crate::season::jst_offset();
        let default_rules = GameRulesConfig {
            tick_interval_minutes: 60,
            max_ticks: 48,
            ..GameRulesConfig::default()
        };
        let fri_1500 = jst.with_ymd_and_hms(2026, 11, 20, 15, 0, 0).unwrap().with_timezone(&Utc);
        let sat_0200 = jst.with_ymd_and_hms(2026, 11, 21, 2, 0, 0).unwrap().with_timezone(&Utc);
        let sat_1000 = jst.with_ymd_and_hms(2026, 11, 21, 10, 0, 0).unwrap().with_timezone(&Utc);
        let mon_1000 = jst.with_ymd_and_hms(2026, 11, 23, 10, 0, 0).unwrap().with_timezone(&Utc);

        assert_eq!(
            state.compute_synced_tick_offset_for_mode_change_at(
                mon_1000,
                default_rules,
                Some(SeasonPhase::Active)
            ),
            0
        );

        // カスタムモードで3ティック進めた後、標準週末自動モードへ戻しても発散しないこと（全フェーズの固定時刻で決定論検証）
        *state.phase_override.write() = Some(SeasonPhase::Active);
        state.game_rules.write().max_ticks = 10;
        for _ in 0..3 {
            state.execute_hourly_tick(false).await.unwrap();
        }
        assert_eq!(state.actual_tick_number(), 3);

        // Preparation (金曜15:00): base=0 -> synced_offset=3, actual=3
        let off_prep =
            state.compute_synced_tick_offset_for_mode_change_at(fri_1500, default_rules, None);
        assert_eq!(off_prep, 3);
        assert_eq!(state.actual_tick_number_with_at(fri_1500, default_rules, None, off_prep), 3);

        // Active序盤 (土曜02:00): base=2 -> synced_offset=1, actual=3
        let off_sat2 =
            state.compute_synced_tick_offset_for_mode_change_at(sat_0200, default_rules, None);
        assert_eq!(off_sat2, 1);
        assert_eq!(state.actual_tick_number_with_at(sat_0200, default_rules, None, off_sat2), 3);

        // Active後半 (土曜10:00): base=10 -> synced_offset=0, actual=10
        let off_sat10 =
            state.compute_synced_tick_offset_for_mode_change_at(sat_1000, default_rules, None);
        assert_eq!(off_sat10, 0);
        assert_eq!(state.actual_tick_number_with_at(sat_1000, default_rules, None, off_sat10), 10);

        // Frozen (月曜10:00): base=48 -> synced_offset=0, actual=48
        let synced_offset =
            state.compute_synced_tick_offset_for_mode_change_at(mon_1000, default_rules, None);
        assert_eq!(synced_offset, 0);
        assert_eq!(
            state.actual_tick_number_with_at(mon_1000, default_rules, None, synced_offset),
            48
        );
        *state.manual_tick_offset.write() = synced_offset;
        *state.game_rules.write() = default_rules;
        *state.phase_override.write() = None;

        // 境界フラグ (allow_when_frozen_boundary=true) でも、標準ルール以外のカスタム設定や
        // 月曜 00:00 JST 以外の時刻では action_mutex 内の再検証でスキップされること
        let sat_0000 = jst
            .with_ymd_and_hms(2026, 11, 21, 0, 0, 0)
            .unwrap()
            .with_timezone(&Utc);
        let sat_0015 = jst
            .with_ymd_and_hms(2026, 11, 21, 0, 15, 0)
            .unwrap()
            .with_timezone(&Utc);
        let mon_0000 = jst
            .with_ymd_and_hms(2026, 11, 23, 0, 0, 0)
            .unwrap()
            .with_timezone(&Utc);

        state.game_rules.write().max_ticks = 10;
        let boundary_custom = state
            .execute_scheduled_tick(true, 999_999, Some((16_666, 0)), mon_0000)
            .await
            .unwrap();
        assert!(
            boundary_custom.is_none(),
            "カスタムルール時は境界ティック再検証でスキップされるべきです"
        );

        // Active フェーズ・対象分（00分）では実行され、非対象分（15分）や同一 minute_key 再実行はスキップされること
        *state.phase_override.write() = Some(SeasonPhase::Active);
        *state.manual_tick_offset.write() = 0;
        let non_due = state
            .execute_scheduled_tick(false, 999_998, Some((16_666, 0)), sat_0015)
            .await
            .unwrap();
        assert!(
            non_due.is_none(),
            "60分間隔で00分以外の時刻はスキップされるべきです"
        );

        let before_offset = *state.manual_tick_offset.read();
        let res1 = state
            .execute_scheduled_tick(false, 999_999, Some((16_666, 0)), sat_0000)
            .await
            .unwrap();
        assert!(res1.is_some());
        assert_eq!(*state.manual_tick_offset.read(), before_offset + 1);

        let res2 = state
            .execute_scheduled_tick(false, 999_999, Some((16_666, 0)), sat_0000)
            .await
            .unwrap();
        assert!(
            res2.is_none(),
            "同一 minute_key での定期ティック再実行はスキップされるべきです"
        );
    }

    #[tokio::test]
    async fn scheduled_tick_ap_refill_dedup_and_async_fallback() {
        use chrono::TimeZone;

        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);
        {
            let mut rules = state.game_rules.write();
            rules.tick_interval_minutes = 60;
            rules.max_ticks = 48;
        }

        let now_str = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO users (username, password_hash, ap, faction_id, created_at) VALUES ('u_ap', 'h', 10, 0, ?)")
            .bind(&now_str)
            .execute(&state.pool)
            .await
            .unwrap();

        *state.phase_override.write() = Some(SeasonPhase::Active);
        {
            let mut ap_cfg = state.ap_config.write();
            ap_cfg.refill_interval_minutes = 30;
            ap_cfg.refill_offset_minute = 0;
            ap_cfg.refill_min = 5;
            ap_cfg.refill_max = 5;
        }

        let jst = crate::season::jst_offset();
        let sat_0100 = jst
            .with_ymd_and_hms(2026, 11, 21, 1, 0, 0)
            .unwrap()
            .with_timezone(&Utc);
        let mk1 = sat_0100.timestamp() / 60;
        let hk1 = (sat_0100.timestamp() / 3600, sat_0100.hour());

        // 1回目: 非同期設定で先に grant_scheduled_ap_refill が補充済みなら、同分の execute_scheduled_tick で二重補充しない
        let granted = state.grant_scheduled_ap_refill(mk1, sat_0100).await.unwrap();
        assert_eq!(granted, Some(1));
        let ticked = state
            .execute_scheduled_tick(false, mk1, Some(hk1), sat_0100)
            .await
            .unwrap();
        assert!(ticked.is_some());

        let ap_after_first: i64 = sqlx::query_scalar("SELECT ap FROM users WHERE username = 'u_ap'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(ap_after_first, 15, "既補充の分では二重補充されてはいけません");

        // 2回目: まだ補充されていない分であれば、非同期設定でも該当分なら execute_scheduled_tick が補充＋last_refill_minute保存を行う
        let sat_0200 = jst
            .with_ymd_and_hms(2026, 11, 21, 2, 0, 0)
            .unwrap()
            .with_timezone(&Utc);
        let mk2 = sat_0200.timestamp() / 60;
        let hk2 = (sat_0200.timestamp() / 3600, sat_0200.hour());
        let ticked2 = state
            .execute_scheduled_tick(false, mk2, Some(hk2), sat_0200)
            .await
            .unwrap();
        assert!(ticked2.is_some());

        let ap_after_second: i64 = sqlx::query_scalar("SELECT ap FROM users WHERE username = 'u_ap'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(ap_after_second, 20, "未補充の該当分はティックと同一TXで補充されるべきです");
        let saved_refill_mk = load_setting(&state.pool, "last_refill_minute")
            .await
            .and_then(|s| s.trim().parse::<i64>().ok());
        assert_eq!(saved_refill_mk, Some(mk2));
    }

    #[tokio::test]
    async fn session_cache_epoch_blocks_resurrection_and_clears_ws_senders() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        let epoch_before = state.current_session_cache_epoch();
        let (tx, _rx) = mpsc::channel(4);
        state.register_ws_user_sender(42, "tok".to_string(), tx);

        state.invalidate_user_sessions_by_uid(42);
        state.cache_user_session_if_epoch(
            "stale_tok".to_string(),
            42,
            Utc::now().timestamp() + 3600,
            epoch_before,
        );

        assert!(
            state.session_cache.is_empty(),
            "失効後の古い epoch によるセッション再登録は拒否されるべきです"
        );
        assert!(
            !state.ws_user_senders.contains_key(&42),
            "ユーザー単位失効時に該当ユーザーの WS 送信チャネルも解除されるべきです"
        );
    }

    #[tokio::test]
    async fn invalidate_user_session_removes_only_matching_token_ws_sender() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        let (tx_a, _rx_a) = mpsc::channel(4);
        let (tx_b, _rx_b) = mpsc::channel(4);
        let conn_a = state.register_ws_user_sender(42, "tok_a".to_string(), tx_a);
        let conn_b = state.register_ws_user_sender(42, "tok_b".to_string(), tx_b);
        assert_ne!(conn_a, conn_b);

        state.invalidate_user_session("tok_a");
        {
            let entry = state.ws_user_senders.get(&42).expect("tok_b が残るべきです");
            assert_eq!(entry.len(), 1);
            assert_eq!(entry[0].conn_id, conn_b);
            assert_eq!(entry[0].token, "tok_b");
        }

        state.invalidate_user_session("tok_b");
        assert!(
            !state.ws_user_senders.contains_key(&42),
            "全トークン失効後はエントリ自体が削除されるべきです"
        );
    }

    #[tokio::test]
    async fn execute_manual_tick_rejects_preparation_and_frozen_phases() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        *state.phase_override.write() = Some(SeasonPhase::Preparation);
        let prep_err = state.execute_manual_tick().await.unwrap_err();
        assert!(prep_err.contains("準備フェーズ"));

        *state.phase_override.write() = Some(SeasonPhase::Frozen);
        let frozen_err = state.execute_manual_tick().await.unwrap_err();
        assert!(frozen_err.contains("凍結フェーズ"));
    }

    #[tokio::test]
    async fn scheduled_tick_skips_saturday_midnight_start_and_boundary_skips_ap_refill() {
        use chrono::TimeZone;

        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);
        {
            let mut rules = state.game_rules.write();
            rules.tick_interval_minutes = 60;
            rules.max_ticks = 48;
        }

        // 2026-03-07 00:00:00 JST (= 2026-03-06 15:00:00 UTC) は土曜00:00の開幕瞬間
        let sat_midnight_utc = chrono::Utc
            .with_ymd_and_hms(2026, 3, 6, 15, 0, 0)
            .unwrap();
        let sat_min = sat_midnight_utc.timestamp() / 60;
        let sat_hour = (sat_midnight_utc.timestamp() / 3600, 15u32);
        let sat_res = state
            .execute_scheduled_tick(false, sat_min, Some(sat_hour), sat_midnight_utc)
            .await
            .unwrap();
        assert!(
            sat_res.is_none(),
            "通常スケジュールの土曜00:00 JST開幕瞬間はティックがスキップされるべきです"
        );

        // 2026-03-07 01:00:00 JST (= 2026-03-06 16:00:00 UTC) は土曜01:00のため実行されること
        let sat_0100_utc = chrono::Utc
            .with_ymd_and_hms(2026, 3, 6, 16, 0, 0)
            .unwrap();
        let sat_0100_min = sat_0100_utc.timestamp() / 60;
        let sat_0100_hour = (sat_0100_utc.timestamp() / 3600, 16u32);
        let sat_0100_res = state
            .execute_scheduled_tick(false, sat_0100_min, Some(sat_0100_hour), sat_0100_utc)
            .await
            .unwrap()
            .expect("通常スケジュールの土曜01:00 JSTではティックが実行されるべきです");
        assert_eq!(
            sat_0100_res.tick_number, 1,
            "土曜01:00 JSTの初回ティック番号は1になるべきです"
        );

        // ユーザーを作成して AP を確認し、月曜00:00 JST終了境界ティックでAP補充されないことを確認
        sqlx::query(
            "INSERT INTO users (id, username, password_hash, faction_id, ap, created_at) VALUES (1, 'u1', 'h', 0, 10, '2026-01-01T00:00:00Z')",
        )
        .execute(&state.pool)
        .await
        .unwrap();

        // 2026-03-09 00:00:00 JST (= 2026-03-08 15:00:00 UTC) は月曜00:00の凍結境界
        let mon_midnight_utc = chrono::Utc
            .with_ymd_and_hms(2026, 3, 8, 15, 0, 0)
            .unwrap();
        let mon_min = mon_midnight_utc.timestamp() / 60;
        let mon_hour = (mon_midnight_utc.timestamp() / 3600, 15u32);
        let mon_res = state
            .execute_scheduled_tick(true, mon_min, Some(mon_hour), mon_midnight_utc)
            .await
            .unwrap()
            .expect("月曜00:00 JSTの終了境界ティック自体は実行されるべきです");
        assert_eq!(
            mon_res.tick_number, 48,
            "月曜00:00 JSTの終了境界ティック番号は48になるべきです"
        );

        let ap_after: i64 = sqlx::query_scalar("SELECT ap FROM users WHERE id = 1")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(
            ap_after, 10,
            "月曜00:00 JSTの終了境界ティックではAP補充が行われないべきです"
        );
    }

    #[tokio::test]
    async fn invalidate_if_present_skips_missing_tokens_and_bumps_epoch_only_when_present() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        let u_epoch0 = state.current_session_cache_epoch();
        assert!(!state.invalidate_user_session_if_present("unknown_tok"));
        assert_eq!(state.current_session_cache_epoch(), u_epoch0);

        // キャッシュに存在する場合のみ epoch が進む
        state.cache_user_session("cached_tok".to_string(), 1, Utc::now().timestamp() + 3600);
        assert!(state.invalidate_user_session_if_present("cached_tok"));
        assert_eq!(state.current_session_cache_epoch(), u_epoch0 + 1);

        // WS 送信チャネルのみに存在する場合も epoch が進む
        let (tx, _rx) = mpsc::channel(4);
        state.register_ws_user_sender(2, "ws_only_tok".to_string(), tx);
        assert!(state.invalidate_user_session_if_present("ws_only_tok"));
        assert_eq!(state.current_session_cache_epoch(), u_epoch0 + 2);

        // 管理者セッションも同様
        let a_epoch0 = state.current_admin_session_cache_epoch();
        assert!(!state.invalidate_admin_session_if_present("unknown_admin"));
        assert_eq!(state.current_admin_session_cache_epoch(), a_epoch0);

        state.cache_admin_session(
            "adm_tok".to_string(),
            "admin".to_string(),
            Utc::now().timestamp() + 3600,
        );
        assert!(state.invalidate_admin_session_if_present("adm_tok"));
        assert_eq!(state.current_admin_session_cache_epoch(), a_epoch0 + 1);
    }

    #[tokio::test]
    async fn execute_scheduled_tick_normalizes_hour_key_inside_action_mutex() {
        use chrono::TimeZone;

        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);
        *state.phase_override.write() = Some(SeasonPhase::Active);

        // 非60分モード時に Some(hour_key) が渡されても last_tick_hour を保存しない
        state.game_rules.write().tick_interval_minutes = 15;
        let t1 = crate::season::jst_offset()
            .with_ymd_and_hms(2026, 3, 7, 1, 15, 0)
            .unwrap()
            .with_timezone(&Utc);
        let mk1 = t1.timestamp() / 60;
        let hk1 = (t1.timestamp() / 3600, t1.hour());
        let res1 = state
            .execute_scheduled_tick(false, mk1, Some(hk1), t1)
            .await
            .unwrap();
        assert!(res1.is_some());
        assert_eq!(load_setting(&state.pool, "last_tick_hour").await, None);

        // 60分モード時に hour_key=None が渡されても now から自動算出して保存し、同一時間の再実行を防ぐ
        state.game_rules.write().tick_interval_minutes = 60;
        let t2 = crate::season::jst_offset()
            .with_ymd_and_hms(2026, 3, 7, 2, 0, 0)
            .unwrap()
            .with_timezone(&Utc);
        let mk2 = t2.timestamp() / 60;
        let res2 = state
            .execute_scheduled_tick(false, mk2, None, t2)
            .await
            .unwrap();
        assert!(res2.is_some());
        let expected_hk2 = format!("{}:{}", t2.timestamp() / 3600, t2.hour());
        assert_eq!(
            load_setting(&state.pool, "last_tick_hour").await.as_deref(),
            Some(expected_hk2.as_str())
        );

        // last_tick_minute を別値にずらしても last_tick_hour 一致によりスキップされる
        crate::db::save_setting(&state.pool, "last_tick_minute", &(mk2 - 1).to_string())
            .await
            .unwrap();
        let res2_dup = state
            .execute_scheduled_tick(false, mk2, None, t2)
            .await
            .unwrap();
        assert!(res2_dup.is_none());
    }

    #[tokio::test]
    async fn flush_dirty_chunks_restores_dirty_flags_when_cancelled_before_commit() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        // いったん全チャンクをフラッシュしてダーティフラグをクリア
        let initial_flushed = state.flush_dirty_chunks().await.unwrap();
        assert!(initial_flushed > 0);
        assert!(state.board.read().take_dirty_chunks().is_empty());

        // 1チャンクをダーティにし、フラッシュ用 Future を1回だけポーリングして即ドロップ（キャンセル模擬）
        state.board.read().mark_chunk_dirty(10, 10);
        {
            let mut fut = Box::pin(state.flush_dirty_chunks_locked());
            let waker = futures_util::task::noop_waker();
            let mut cx = std::task::Context::from_waker(&waker);
            let _ = std::future::Future::poll(fut.as_mut(), &mut cx);
        }

        // キャンセル後もダーティフラグが復元されていること
        let remaining_dirty = state.board.read().take_dirty_chunks();
        assert_eq!(remaining_dirty, vec![0]);

        // 正常完了時は復元されずクリアされたままになること
        state.board.read().mark_chunk_dirty_ids(&remaining_dirty);
        let flushed = state.flush_dirty_chunks().await.unwrap();
        assert_eq!(flushed, 1);
        assert!(state.board.read().take_dirty_chunks().is_empty());
    }

    #[test]
    fn ap_config_supports_legacy_json_and_initial_ap_range_validation() {
        let legacy: ApConfig = serde_json::from_str(
            r#"{"initial_ap":25,"max_ap":100,"refill_interval_minutes":60,"refill_offset_minute":0,"refill_min":5,"refill_max":10}"#,
        )
        .unwrap();
        assert_eq!(legacy.initial_ap_min, 25);
        assert_eq!(legacy.initial_ap_max, 25);
        assert!(legacy.validate().is_ok());

        let ranged = ApConfig {
            initial_ap_min: 15,
            initial_ap_max: 45,
            ..ApConfig::default()
        };
        assert!(ranged.validate().is_ok());
        for _ in 0..30 {
            let v = ranged.roll_initial_ap();
            assert!((15..=45).contains(&v));
        }

        let invalid = ApConfig {
            initial_ap_min: 50,
            initial_ap_max: 30,
            ..ApConfig::default()
        };
        assert!(invalid.validate().is_err());
    }

    #[tokio::test]
    async fn custom_season_start_blocks_immediate_refill_and_tick_then_allows_subsequent() {
        use chrono::TimeZone;

        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        // 土曜 21:30 JST 開幕・Tick 60分・AP補充 30分 (offset 0)
        {
            let mut rules = state.game_rules.write();
            rules.season_start_weekday = 5;
            rules.season_start_hour = 21;
            rules.season_start_minute = 30;
            rules.tick_interval_minutes = 60;
            rules.max_ticks = 48;
        }
        {
            let mut ap = state.ap_config.write();
            ap.refill_interval_minutes = 30;
            ap.refill_offset_minute = 0;
            ap.refill_min = 5;
            ap.refill_max = 5;
        }

        let now_str = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'u_start', 'h', 20, 0, ?)")
            .bind(&now_str)
            .execute(&state.pool)
            .await
            .unwrap();

        let jst = crate::season::jst_offset();
        let start_2130 = jst.with_ymd_and_hms(2026, 11, 21, 21, 30, 0).unwrap().with_timezone(&Utc);
        let mk_start = start_2130.timestamp() / 60;
        let hk_start = (start_2130.timestamp() / 3600, start_2130.hour());

        // 開幕瞬間 21:30 は AP 補充も定期ティックも発火しない
        assert_eq!(state.grant_scheduled_ap_refill(mk_start, start_2130).await.unwrap(), None);
        assert!(state
            .execute_scheduled_tick(false, mk_start, Some(hk_start), start_2130)
            .await
            .unwrap()
            .is_none());

        // 30分後の 22:00 は AP 補充が発火する
        let next_2200 = jst.with_ymd_and_hms(2026, 11, 21, 22, 0, 0).unwrap().with_timezone(&Utc);
        assert_eq!(
            state
                .grant_scheduled_ap_refill(next_2200.timestamp() / 60, next_2200)
                .await
                .unwrap(),
            Some(1)
        );

        // 60分後の 22:30 は定期ティックが発火する
        let next_2230 = jst.with_ymd_and_hms(2026, 11, 21, 22, 30, 0).unwrap().with_timezone(&Utc);
        let tick_res = state
            .execute_scheduled_tick(
                false,
                next_2230.timestamp() / 60,
                Some((next_2230.timestamp() / 3600, next_2230.hour())),
                next_2230,
            )
            .await
            .unwrap();
        assert!(tick_res.is_some());
    }

    #[tokio::test]
    async fn scheduled_catchup_handles_active_grace_window_and_crossed_end_boundary() {
        use chrono::TimeZone;

        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);
        {
            let mut rules = state.game_rules.write();
            rules.tick_interval_minutes = 60;
            rules.max_ticks = 48;
        }

        let now_str = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'u_catchup', 'h', 10, 0, ?)",
        )
        .bind(&now_str)
        .execute(&state.pool)
        .await
        .unwrap();

        {
            let mut ap = state.ap_config.write();
            ap.refill_min = 5;
            ap.refill_max = 5;
        }

        let jst = crate::season::jst_offset();
        let sat_0000 = jst
            .with_ymd_and_hms(2026, 11, 21, 0, 0, 0)
            .unwrap()
            .with_timezone(&Utc);
        let sat_0005 = jst
            .with_ymd_and_hms(2026, 11, 21, 0, 5, 0)
            .unwrap()
            .with_timezone(&Utc);
        let sat_0100 = jst
            .with_ymd_and_hms(2026, 11, 21, 1, 0, 0)
            .unwrap()
            .with_timezone(&Utc);
        let sat_0105 = jst
            .with_ymd_and_hms(2026, 11, 21, 1, 5, 0)
            .unwrap()
            .with_timezone(&Utc);
        let sat_0111 = jst
            .with_ymd_and_hms(2026, 11, 21, 1, 11, 0)
            .unwrap()
            .with_timezone(&Utc);

        // 開幕瞬間 (土曜 00:00) を 00:05 から補完しようとしてもスキップされる
        assert!(state
            .execute_scheduled_tick_for_slot(
                false,
                sat_0000.timestamp() / 60,
                Some((sat_0000.timestamp() / 3600, sat_0000.hour())),
                sat_0000,
                sat_0005,
            )
            .await
            .unwrap()
            .is_none());

        // 猶予超過 (11分遅延) はスキップされる
        assert!(state
            .execute_scheduled_tick_for_slot(
                false,
                sat_0100.timestamp() / 60,
                Some((sat_0100.timestamp() / 3600, sat_0100.hour())),
                sat_0100,
                sat_0111,
            )
            .await
            .unwrap()
            .is_none());

        // 5分遅延 (土曜 01:05 に 01:00 スロットを補完) は実行され、01:00 のキーが保存される
        let mk_0100 = sat_0100.timestamp() / 60;
        let hk_0100 = (sat_0100.timestamp() / 3600, sat_0100.hour());
        let res = state
            .execute_scheduled_tick_for_slot(false, mk_0100, Some(hk_0100), sat_0100, sat_0105)
            .await
            .unwrap()
            .expect("猶予内の遅延ティックは補完実行されるべきです");
        assert_eq!(res.tick_number, 1);

        let ap_after_catchup: i64 = sqlx::query_scalar("SELECT ap FROM users WHERE id = 1")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(ap_after_catchup, 15);
        assert_eq!(
            load_setting(&state.pool, "last_tick_minute")
                .await
                .and_then(|s| s.parse::<i64>().ok()),
            Some(mk_0100)
        );
        assert_eq!(
            load_setting(&state.pool, "last_refill_minute")
                .await
                .and_then(|s| s.parse::<i64>().ok()),
            Some(mk_0100)
        );

        // 同スロットの再補完はスキップされる
        assert!(state
            .execute_scheduled_tick_for_slot(false, mk_0100, Some(hk_0100), sat_0100, sat_0105)
            .await
            .unwrap()
            .is_none());

        // 終了境界の分跨ぎ補完（月曜 00:05 時点で 月曜 00:00 境界を補完）は AP 補充なしで 1 回だけ実行される
        let mon_0000 = jst
            .with_ymd_and_hms(2026, 11, 23, 0, 0, 0)
            .unwrap()
            .with_timezone(&Utc);
        let mon_0005 = jst
            .with_ymd_and_hms(2026, 11, 23, 0, 5, 0)
            .unwrap()
            .with_timezone(&Utc);
        let mk_mon = mon_0000.timestamp() / 60;
        let hk_mon = (mon_0000.timestamp() / 3600, mon_0000.hour());
        let boundary_res = state
            .execute_scheduled_tick_for_slot(true, mk_mon, Some(hk_mon), mon_0000, mon_0005)
            .await
            .unwrap()
            .expect("分跨ぎの終了境界ティックは1回補完実行されるべきです");
        assert_eq!(boundary_res.tick_number, 48);

        let ap_after_boundary: i64 = sqlx::query_scalar("SELECT ap FROM users WHERE id = 1")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(ap_after_boundary, 15, "終了境界補完ではAP補充されないべきです");

        // 2回目はスキップされる
        assert!(state
            .execute_scheduled_tick_for_slot(true, mk_mon, Some(hk_mon), mon_0000, mon_0005)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn endgame_ap_boost_doubles_refill_and_cap_in_last_20_percent() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        *state.phase_override.write() = Some(SeasonPhase::Active);
        {
            let mut rules = state.game_rules.write();
            rules.max_ticks = 10;
        }
        {
            let mut ap = state.ap_config.write();
            ap.max_ap = 100;
            ap.refill_min = 10;
            ap.refill_max = 10;
            ap.endgame_threshold_pct = 20;
            ap.endgame_ap_multiplier = 2.0;
        }

        sqlx::query(
            "INSERT INTO users (id, username, password_hash, faction_id, ap, created_at) VALUES (1, 'u_endgame', 'h', 0, 95, '2026-01-01T00:00:00Z')",
        )
        .execute(&state.pool)
        .await
        .unwrap();

        // Tick 0〜7（残り30%以上）は通常上限 100 / 補充 10
        for _ in 0..7 {
            state.execute_hourly_tick(true).await.unwrap();
        }
        assert!(!state.is_endgame_ap_boost_active());
        let ap_before_boost: i64 = sqlx::query_scalar("SELECT ap FROM users WHERE id = 1")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(ap_before_boost, 100);

        // Tick 8（残り20%到達）以降は上限 200 / 補充 20
        state.execute_hourly_tick(true).await.unwrap();
        assert!(state.is_endgame_ap_boost_active());
        state.execute_hourly_tick(true).await.unwrap();
        let ap_after_boost: i64 = sqlx::query_scalar("SELECT ap FROM users WHERE id = 1")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(ap_after_boost, 120);
    }

    #[tokio::test]
    async fn direct_sender_overflow_sets_flag_and_triggers_notify() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        let (tx, _rx) = mpsc::channel(1);
        let overflowed = Arc::new(AtomicBool::new(false));
        let overflow_notify = Arc::new(Notify::new());
        state.register_ws_user_sender_with_overflow(
            7,
            "tok_ov".to_string(),
            i64::MAX,
            tx,
            Arc::clone(&overflowed),
            Arc::clone(&overflow_notify),
        );

        let notified = overflow_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        // 1件目はキューに入るため溢れない
        state.send_event_to_user(7, vec![1]);
        assert!(!overflowed.load(Ordering::Acquire));

        // 2件目は満杯のためドロップされ、溢れフラグと通知が発火する
        state.send_event_to_user(7, vec![2]);
        assert!(overflowed.load(Ordering::Acquire));
        tokio::time::timeout(std::time::Duration::from_millis(100), notified)
            .await
            .expect("溢れ通知が発火するべきです");
    }

    #[tokio::test]
    async fn auto_paint_capture_enemy_core_notifies_defender_with_cooldown() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let mut board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        // 勢力1の隣接領土 (20, 20) と 勢力2の隣接中核マス (21, 20), (22, 20) を配置
        let idx1 = board.idx(20, 20);
        board.cells[idx1].faction_id = 1;
        board.cells[idx1].color_id = 5;
        board.cells[idx1].layers = 1;
        board.cells[idx1].set_core(true);
        for x in [21usize, 22usize] {
            let idx = board.idx(x, 20);
            board.cells[idx].faction_id = 2;
            board.cells[idx].color_id = 10;
            board.cells[idx].layers = 1;
            board.cells[idx].set_core(true);
        }
        let state = AppState::new(test_config(), pool, board, params, 1);
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO users (id, username, password_hash, ap, faction_id, auto_paint_enabled, auto_paint_pct, created_at) VALUES (1, 'att_auto', 'h', 100, 1, 1, 100, ?)",
        )
        .bind(&now)
        .execute(&state.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO users (id, username, password_hash, ap, faction_id, auto_paint_enabled, auto_paint_pct, created_at) VALUES (2, 'def_auto', 'h', 100, 2, 0, 50, ?)",
        )
        .bind(&now)
        .execute(&state.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO factions (id, season_id, name, color_id, leader_user_id, created_at) VALUES (1, 1, '自動攻撃国', 5, 1, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO factions (id, season_id, name, color_id, leader_user_id, created_at) VALUES (2, 1, '自動防衛国', 10, 2, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO faction_members (faction_id, user_id, joined_at) VALUES (1, 1, ?), (2, 2, ?)")
            .bind(&now)
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO diplomacy_wars (season_id, faction_a, faction_b, started_at) VALUES (1, 1, 2, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();

        let (tx_def, mut rx_def) = mpsc::channel(16);
        state.register_ws_user_sender(2, "tok_def_auto".to_string(), tx_def);

        state.execute_hourly_tick(true).await.unwrap();

        let mut core_alerts = Vec::new();
        while let Ok(frame) = rx_def.try_recv() {
            if frame.first() == Some(&crate::protocol::OP_SERVER_EVENT_JSON) {
                if let Ok(ev) = serde_json::from_slice::<serde_json::Value>(&frame[1..]) {
                    if ev["type"] == "core_attacked" {
                        core_alerts.push(ev);
                    }
                }
            }
        }
        assert_eq!(core_alerts.len(), 1, "自動塗りによる敵中核奪取時もクールダウンにより1件だけ通知されるべきです");
        assert_eq!(core_alerts[0]["defender_faction_id"], 2);
        assert_eq!(core_alerts[0]["attacker_faction_id"], 1);
        assert_eq!(core_alerts[0]["attacker_name"], "自動攻撃国");
    }

    #[tokio::test]
    async fn broadcast_tick_sync_records_synced_phase_and_detects_change() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        assert!(!state.is_phase_already_synced(1, SeasonPhase::Active));
        state.broadcast_tick_sync(SeasonPhase::Active, 3, 0, 12345, 1);
        assert!(state.is_phase_already_synced(1, SeasonPhase::Active));
        assert!(!state.is_phase_already_synced(1, SeasonPhase::Frozen));
        assert!(!state.is_phase_already_synced(2, SeasonPhase::Active));
    }

    #[tokio::test]
    async fn tick_records_ap_system_and_endgame_boost_logs() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        *state.phase_override.write() = Some(SeasonPhase::Active);
        {
            let mut rules = state.game_rules.write();
            rules.max_ticks = 10;
        }
        {
            let mut ap = state.ap_config.write();
            ap.max_ap = 100;
            ap.refill_min = 10;
            ap.refill_max = 10;
            ap.endgame_threshold_pct = 20;
            ap.endgame_ap_multiplier = 2.0;
        }

        // Tick 0 -> 8 まで進めて終盤ブースト発動ログを確認する
        for _ in 0..8 {
            state.execute_hourly_tick(true).await.unwrap();
        }

        let rows = sqlx::query("SELECT category, summary FROM player_logs ORDER BY id ASC")
            .fetch_all(&state.pool)
            .await
            .unwrap();
        let logs: Vec<(String, String)> = rows
            .into_iter()
            .map(|r| (r.get("category"), r.get("summary")))
            .collect();

        assert!(logs.iter().any(|(c, s)| c == "ap" && s.contains("AP 補充を実施した")));
        assert!(logs.iter().any(|(c, s)| c == "ap" && s.contains("終盤 AP ブーストが発動した")));
        assert!(logs.iter().any(|(c, s)| c == "system" && s.contains("Tick #8 が完了した")));
    }

    #[tokio::test]
    async fn regenerate_map_records_synced_phase_and_emits_phase_in_event() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        // 自動凍結状態からマップ再生成
        state.auto_frozen_season_id.store(1, Ordering::Release);
        let mut bcast_rx = state.broadcast_tx.subscribe();

        state
            .regenerate_map(MapGenParams::default_with_seed(2))
            .await
            .unwrap();

        let expected_phase = state.current_phase();
        assert!(
            state.is_phase_already_synced(1, expected_phase),
            "regenerate_map 後は復帰フェーズが同期済みとして記録されるべきです"
        );

        let mut found = false;
        while let Ok(frame) = bcast_rx.try_recv() {
            if frame.first() == Some(&crate::protocol::OP_SERVER_EVENT_JSON) {
                let ev: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
                if ev["type"] == "map_regenerated" {
                    assert_eq!(ev["phase"], serde_json::json!(expected_phase));
                    found = true;
                }
            }
        }
        assert!(found, "map_regenerated イベントがブロードキャストされるべきです");
    }

    #[tokio::test]
    async fn invalidate_expired_user_sessions_removes_ws_senders_and_notifies() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        let now = Utc::now().timestamp();
        state.cache_user_session("tok_exp".to_string(), 1, now - 10);
        state.cache_user_session("tok_ok".to_string(), 2, now + 3600);

        let (tx_exp, _rx_exp) = mpsc::channel(4);
        let (tx_ok, _rx_ok) = mpsc::channel(4);
        state.register_ws_user_sender(1, "tok_exp".to_string(), tx_exp);
        state.register_ws_user_sender(2, "tok_ok".to_string(), tx_ok);

        let epoch_before = state.current_session_cache_epoch();
        let notified = state.session_invalidation_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        let expired = state.cleanup_session_caches();
        assert_eq!(expired, vec!["tok_exp".to_string()]);
        state.invalidate_expired_user_sessions(&expired);

        assert!(state.current_session_cache_epoch() > epoch_before);
        assert!(!state.ws_user_senders.contains_key(&1));
        assert!(state.ws_user_senders.contains_key(&2));
        assert!(!state.session_cache.contains_key("tok_exp"));
        assert!(state.session_cache.contains_key("tok_ok"));
        tokio::time::timeout(std::time::Duration::from_millis(100), notified)
            .await
            .expect("期限切れセッション失効通知が発火するべきです");
    }

    #[tokio::test]
    async fn standard_auto_schedule_records_endgame_boost_log_once() {
        use chrono::TimeZone;

        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        // 標準自動スケジュール（phase_override=None, 60分, 48ティック, 残り20%=Tick 39で突入）
        *state.phase_override.write() = None;
        {
            let mut rules = state.game_rules.write();
            rules.tick_interval_minutes = 60;
            rules.max_ticks = 48;
        }
        {
            let mut ap = state.ap_config.write();
            ap.endgame_threshold_pct = 20;
            ap.endgame_ap_multiplier = 2.0;
        }

        let jst = crate::season::jst_offset();
        // 土曜 00:00 JST (2026-11-21 00:00) の 39時間後 = 2026-11-22 15:00 JST (Tick 39)
        let tick39_dt = jst
            .with_ymd_and_hms(2026, 11, 22, 15, 0, 0)
            .unwrap()
            .with_timezone(&Utc);
        let tick39_mk = tick39_dt.timestamp() / 60;
        let tick39_hk = (tick39_dt.timestamp() / 3600, tick39_dt.hour());
        state
            .execute_scheduled_tick(false, tick39_mk, Some(tick39_hk), tick39_dt)
            .await
            .unwrap()
            .expect("Tick 39 が実行されるべきです");

        // 40時間後 = 2026-11-22 16:00 JST (Tick 40)
        let tick40_dt = jst
            .with_ymd_and_hms(2026, 11, 22, 16, 0, 0)
            .unwrap()
            .with_timezone(&Utc);
        let tick40_mk = tick40_dt.timestamp() / 60;
        let tick40_hk = (tick40_dt.timestamp() / 3600, tick40_dt.hour());
        state
            .execute_scheduled_tick(false, tick40_mk, Some(tick40_hk), tick40_dt)
            .await
            .unwrap()
            .expect("Tick 40 が実行されるべきです");

        let boost_log_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM player_logs WHERE category = 'ap' AND summary LIKE '%終盤 AP ブーストが発動した%'",
        )
        .fetch_one(&state.pool)
        .await
        .unwrap();
        assert_eq!(
            boost_log_count, 1,
            "標準自動スケジュールで終盤ブースト突入ログが1件だけ記録されるべきです"
        );
    }

    #[tokio::test]
    async fn regenerate_map_records_system_log_after_clearing_old_logs() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(10);
        let board = Board::from_terrain(250, &vec![1u8; 250 * 250]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        crate::db::record_player_log(&state.pool, 1, 1, "old_u", 1, "territory", "(1, 1) を塗った").await;

        let next_params = MapGenParams {
            size: 500,
            continent_count: 2,
            island_count: 4,
            land_ratio_pct: 40,
            seed: 42,
        };
        state.regenerate_map(next_params).await.unwrap();

        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT username, category, summary FROM player_logs ORDER BY id ASC",
        )
        .fetch_all(&state.pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "管理者");
        assert_eq!(rows[0].1, "system");
        assert!(rows[0].2.contains("500×500") && rows[0].2.contains("42"));
    }

    #[tokio::test]
    async fn expired_ws_direct_sender_blocks_private_events_immediately() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);

        let now = Utc::now().timestamp();
        let (tx_exp, mut rx_exp) = mpsc::channel(8);
        let (tx_ok, mut rx_ok) = mpsc::channel(8);
        state.register_ws_user_sender_with_overflow(
            1,
            "tok_exp".to_string(),
            now - 1,
            tx_exp,
            Arc::new(AtomicBool::new(false)),
            Arc::new(Notify::new()),
        );
        state.register_ws_user_sender_with_overflow(
            2,
            "tok_ok".to_string(),
            now + 3600,
            tx_ok,
            Arc::new(AtomicBool::new(false)),
            Arc::new(Notify::new()),
        );

        assert_eq!(state.send_event_to_user(1, vec![1, 2]), 0);
        assert!(rx_exp.try_recv().is_err(), "期限切れ接続へは私的イベントを送らないべきです");

        assert_eq!(state.send_event_to_user(2, vec![3, 4]), 1);
        assert_eq!(rx_ok.try_recv().unwrap(), Bytes::from_static(&[3, 4]));

        assert_eq!(state.send_event_to_users(&[1, 2], vec![5, 6]), 1);
        assert!(rx_exp.try_recv().is_err());
        assert_eq!(rx_ok.try_recv().unwrap(), Bytes::from_static(&[5, 6]));
    }

    #[tokio::test]
    async fn auto_paint_capture_enemy_core_does_not_consume_cooldown_when_defender_offline() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let mut board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let idx1 = board.idx(20, 20);
        board.cells[idx1].faction_id = 1;
        board.cells[idx1].color_id = 5;
        board.cells[idx1].layers = 1;
        board.cells[idx1].set_core(true);
        let idx2 = board.idx(21, 20);
        board.cells[idx2].faction_id = 2;
        board.cells[idx2].color_id = 10;
        board.cells[idx2].layers = 1;
        board.cells[idx2].set_core(true);
        let state = AppState::new(test_config(), pool, board, params, 1);
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO users (id, username, password_hash, ap, faction_id, auto_paint_enabled, auto_paint_pct, created_at) VALUES (1, 'att_off', 'h', 100, 1, 1, 100, ?)",
        )
        .bind(&now)
        .execute(&state.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO users (id, username, password_hash, ap, faction_id, auto_paint_enabled, auto_paint_pct, created_at) VALUES (2, 'def_off', 'h', 100, 2, 0, 50, ?)",
        )
        .bind(&now)
        .execute(&state.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO factions (id, season_id, name, color_id, leader_user_id, created_at) VALUES (1, 1, '自動攻撃国', 5, 1, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO factions (id, season_id, name, color_id, leader_user_id, created_at) VALUES (2, 1, '自動防衛国', 10, 2, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO faction_members (faction_id, user_id, joined_at) VALUES (1, 1, ?), (2, 2, ?)")
            .bind(&now)
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO diplomacy_wars (season_id, faction_a, faction_b, started_at) VALUES (1, 1, 2, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();

        // 1回目: 防衛側オフラインなのでクールダウンは記録されない
        state.execute_hourly_tick(true).await.unwrap();
        assert!(
            !state.core_attack_alert_cooldown.contains_key(&(2, 1)),
            "防衛側オフライン時はクールダウンを消費しないべきです"
        );

        // 2回目: 防衛側がオンラインになった状態で別の中核マスを自動奪取すると通知が届く
        {
            let mut b = state.board.write();
            let idx3 = b.idx(22, 20);
            b.cells[idx3].faction_id = 2;
            b.cells[idx3].color_id = 10;
            b.cells[idx3].layers = 1;
            b.cells[idx3].set_core(true);
        }
        let (tx_def, mut rx_def) = mpsc::channel(16);
        state.register_ws_user_sender(2, "tok_def_online".to_string(), tx_def);
        state.execute_hourly_tick(true).await.unwrap();

        let mut core_alerts = 0usize;
        while let Ok(frame) = rx_def.try_recv() {
            if frame.first() == Some(&crate::protocol::OP_SERVER_EVENT_JSON) {
                if let Ok(ev) = serde_json::from_slice::<serde_json::Value>(&frame[1..]) {
                    if ev["type"] == "core_attacked" {
                        core_alerts += 1;
                    }
                }
            }
        }
        assert_eq!(core_alerts, 1, "オンライン復帰後の次の中核奪取では通知されるべきです");
    }
}
