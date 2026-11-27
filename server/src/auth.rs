use argon2::{
    password_hash::{
        rand_core::{OsRng, RngCore},
        PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
    },
    Argon2,
};
use axum::http::{header, HeaderMap};
use parking_lot::RwLock;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// 一般ユーザーセッションの有効期限（秒）: 7日
pub const USER_SESSION_TTL_SECS: i64 = 7 * 24 * 3600;
/// 管理者セッションの有効期限（秒）: 12時間
pub const ADMIN_SESSION_TTL_SECS: i64 = 12 * 3600;
/// 新規パスワードの最小文字数
pub const MIN_PASSWORD_CHARS: usize = 8;
/// 新規パスワードの最大バイト長
pub const MAX_PASSWORD_BYTES: usize = 128;

/// パスワードを Argon2id でハッシュ化
pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    argon2
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| format!("パスワードハッシュ失敗: {}", e))
}

/// パスワードを検証
pub fn verify_password(password: &str, hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

/// ランダムなセッショントークン (64文字の16進文字列) を生成
pub fn generate_session_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// OsRng を用いて指定文字数の英数字ランダムパスワードを生成する
pub fn generate_random_password(len: usize) -> String {
    const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut out = String::with_capacity(len);
    let mut buf = [0u8; 32];
    while out.len() < len {
        OsRng.fill_bytes(&mut buf);
        for &b in &buf {
            // 62 * 4 = 248 未満のみ採用し、文字出現確率の偏りをなくす
            if b < 248 {
                out.push(CHARSET[(b % 62) as usize] as char);
                if out.len() == len {
                    break;
                }
            }
        }
    }
    out
}

/// 新規パスワードの文字数・バイト長制約を検証する
pub fn validate_new_password(password: &str) -> Result<(), &'static str> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err("パスワードは8文字以上で入力してください");
    }
    if password.len() > MAX_PASSWORD_BYTES {
        return Err("パスワードは128バイト以下で入力してください");
    }
    Ok(())
}

/// ユーザー名・勢力名などの表示名から制御文字・ゼロ幅文字・Bidi フォーマット文字を除外して検証する
pub fn validate_display_name(
    raw: &str,
    min_chars: usize,
    max_chars: usize,
    label: &str,
) -> Result<String, String> {
    // 空白トリム前に制御文字（\r, \n, \t 等）や不可視文字をチェックし、先頭・末尾の制御文字混入を確実に拒否する
    for c in raw.chars() {
        if (c.is_control())
            || matches!(
                c,
                '\u{200B}'..='\u{200F}'
                    | '\u{2028}'..='\u{202F}'
                    | '\u{2060}'..='\u{206F}'
                    | '\u{FEFF}'
                    | '\u{00AD}'
                    | '\u{034F}'
                    | '\u{061C}'
                    | '\u{180E}'
                    | '\u{2800}'
                    | '\u{3164}'
                    | '\u{FFA0}'
            )
        {
            return Err(format!("{}に使用できない制御文字または不可視文字が含まれています", label));
        }
    }
    let trimmed = raw.trim();
    let len = trimmed.chars().count();
    if len < min_chars || len > max_chars {
        return Err(format!(
            "{}は{}〜{}文字で入力してください",
            label, min_chars, max_chars
        ));
    }
    if trimmed.chars().all(|c| c.is_whitespace()) {
        return Err(format!("{}に空白のみは使用できません", label));
    }
    Ok(trimmed.to_string())
}

/// 長さ差と全バイト XOR を早期リターンなしで畳み込む定数時間比較
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    // 短い秘密値の長さ情報漏洩を抑えるため最低 64 バイト幅で走査する
    const MIN_COMPARE_LEN: usize = 64;
    let mut diff = std::hint::black_box(a.len() ^ b.len());
    let scan_len = a.len().max(b.len()).max(MIN_COMPARE_LEN);
    for i in 0..scan_len {
        let x = if i < a.len() { a[i] } else { 0 };
        let y = if i < b.len() { b[i] } else { 0 };
        let x = std::hint::black_box(x);
        let y = std::hint::black_box(y);
        diff |= std::hint::black_box((x ^ y) as usize);
    }
    std::hint::black_box(diff) == 0
}

/// クライアント IP を抽出する（trust_proxy=true 時のみ転送ヘッダを参照）
pub fn extract_client_ip(addr: SocketAddr, headers: &HeaderMap, trust_proxy: bool) -> String {
    let fallback_ip = || addr.ip().to_canonical().to_string();
    if !trust_proxy {
        return fallback_ip();
    }

    // 複数 X-Forwarded-For ヘッダ行がある場合は末尾行の右端要素（直近プロキシ付与）を最優先で採用する
    if let Some(xff_val) = headers.get_all("x-forwarded-for").iter().next_back() {
        if let Some(ip) = xff_val
            .to_str()
            .ok()
            .and_then(|xff| xff.rsplit(',').next())
            .and_then(|last| IpAddr::from_str(last.trim()).ok())
        {
            return ip.to_canonical().to_string();
        }
        // X-Forwarded-For が存在するのにパース不能な場合は偽装 X-Real-IP へのフォールバックを避けソケット IP を返す
        return fallback_ip();
    }

    // X-Forwarded-For が無い場合のみ末尾の X-Real-IP を参照する
    if let Some(real_ip) = headers
        .get_all("x-real-ip")
        .iter()
        .next_back()
        .and_then(|v| v.to_str().ok())
    {
        if let Ok(ip) = IpAddr::from_str(real_ip.trim()) {
            return ip.to_canonical().to_string();
        }
    }

    fallback_ip()
}

/// 全 Cookie ヘッダから指定名のクッキー値を取得する（空値は無視して後続を探索）
pub fn extract_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    for val in headers.get_all(header::COOKIE) {
        let Ok(raw) = val.to_str() else {
            continue;
        };
        for pair in raw.split(';') {
            if let Some((k, v)) = pair.trim().split_once('=') {
                if k.trim() == name {
                    let val_trimmed = v.trim();
                    if !val_trimmed.is_empty() {
                        return Some(val_trimmed.to_string());
                    }
                }
            }
        }
    }
    None
}

/// セッション設定用 Set-Cookie ヘッダ値を組み立てる
pub fn build_session_cookie(
    name: &str,
    value: &str,
    max_age_secs: i64,
    same_site: &str,
    secure: bool,
) -> String {
    let secure_attr = if secure { "; Secure" } else { "" };
    format!(
        "{}={}; HttpOnly; SameSite={}; Path=/; Max-Age={}{}",
        name, value, same_site, max_age_secs, secure_attr
    )
}

/// セッション削除用 Set-Cookie ヘッダ値を組み立てる
pub fn build_clear_cookie(name: &str, same_site: &str, secure: bool) -> String {
    build_session_cookie(name, "", 0, same_site, secure)
}

/// Referer ヘッダからホスト部と HTTPS かどうかを抽出する（スキーム大小文字無視）
fn extract_referer_host(referer: &str) -> Option<(&str, bool)> {
    let (rest, is_https) = if referer
        .get(..8)
        .is_some_and(|s| s.eq_ignore_ascii_case("https://"))
    {
        (&referer[8..], true)
    } else if referer
        .get(..7)
        .is_some_and(|s| s.eq_ignore_ascii_case("http://"))
    {
        (&referer[7..], false)
    } else {
        return None;
    };
    let host = rest.split(['/', '?', '#']).next()?;
    if host.is_empty() {
        return None;
    }
    Some((host, is_https))
}

/// スキームに応じたデフォルトポート（:443 / :80）を除去してホスト表記を正規化する
fn normalize_host_port(host: &str, is_https: bool) -> &str {
    let default_port = if is_https { ":443" } else { ":80" };
    host.strip_suffix(default_port).unwrap_or(host)
}

/// オリジン文字列を `(正規化オリジン, 正規化小文字ホスト, is_https)` へ正規化する
fn normalize_origin_for_compare(raw: &str) -> Option<(String, String, bool)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "*" || trimmed.eq_ignore_ascii_case("null") {
        return None;
    }
    let (is_https, rest) = if trimmed
        .get(..8)
        .is_some_and(|s| s.eq_ignore_ascii_case("https://"))
    {
        (true, &trimmed[8..])
    } else if trimmed
        .get(..7)
        .is_some_and(|s| s.eq_ignore_ascii_case("http://"))
    {
        (false, &trimmed[7..])
    } else {
        return None;
    };
    let authority = rest.strip_suffix('/').unwrap_or(rest);
    if authority.is_empty()
        || authority.chars().any(|c| {
            c.is_control()
                || c.is_whitespace()
                || matches!(c, '/' | '?' | '#' | '@' | '\\')
        })
    {
        return None;
    }
    let norm_host = normalize_host_port(&authority.to_ascii_lowercase(), is_https).to_string();
    let scheme = if is_https { "https" } else { "http" };
    Some((format!("{}://{}", scheme, norm_host), norm_host, is_https))
}

/// 開発モード時に許可するローカルホストオリジンか判定する
fn is_dev_local_host(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    if lower == "localhost" || lower == "127.0.0.1" || lower == "[::1]" {
        return true;
    }
    if let Some(port) = lower
        .strip_prefix("localhost:")
        .or_else(|| lower.strip_prefix("127.0.0.1:"))
        .or_else(|| lower.strip_prefix("[::1]:"))
    {
        return !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit());
    }
    false
}

/// X-Forwarded-Proto の末尾ヘッダ右端要素から HTTPS 終端か判定する
fn is_forwarded_https(headers: &HeaderMap) -> bool {
    headers
        .get_all("x-forwarded-proto")
        .iter()
        .next_back()
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.rsplit(',').next())
        .map(|p| p.trim().eq_ignore_ascii_case("https"))
        .unwrap_or(false)
}

/// 単一ヘッダの UTF-8 文字列を取得する（複数ヘッダまたは非 UTF-8 の場合は Err）
fn get_single_header_str<'a>(
    headers: &'a HeaderMap,
    name: impl axum::http::header::AsHeaderName,
) -> Result<Option<&'a str>, ()> {
    let mut iter = headers.get_all(name).iter();
    let Some(first) = iter.next() else {
        return Ok(None);
    };
    if iter.next().is_some() {
        return Err(());
    }
    first.to_str().map(|s| Some(s.trim())).map_err(|_| ())
}

/// リクエストが同一オリジンまたは許可されたオリジンからのものか検証する
pub fn is_same_origin_request(
    headers: &HeaderMap,
    allowed_origins: &[String],
    dev_mode: bool,
    trust_proxy: bool,
    require_https: bool,
) -> bool {
    // 複数 Host ヘッダまたは非 UTF-8 Host ヘッダによるヘッダインジェクションを拒否する
    let Ok(host_header) = get_single_header_str(headers, header::HOST) else {
        return false;
    };
    let effective_https = require_https || (trust_proxy && is_forwarded_https(headers));

    let Ok(origin_header) = get_single_header_str(headers, header::ORIGIN) else {
        return false;
    };
    if let Some(origin) = origin_header {
        let Some((norm_origin, norm_origin_host, is_https)) =
            normalize_origin_for_compare(origin)
        else {
            return false;
        };
        if allowed_origins.iter().any(|allowed| {
            normalize_origin_for_compare(allowed)
                .map(|(norm_allowed, _, _)| norm_allowed == norm_origin)
                .unwrap_or_else(|| allowed == origin)
        }) {
            return true;
        }
        // HTTPS 環境（または信頼プロキシの HTTPS 終端）での HTTP オリジンからのスキームダウングレードを拒否する
        if effective_https && !is_https {
            return false;
        }
        if let Some(host) = host_header {
            let host_lower = host.to_ascii_lowercase();
            let norm_host = normalize_host_port(&host_lower, is_https);
            if norm_origin_host == norm_host {
                return true;
            }
        }
        if dev_mode && is_dev_local_host(&norm_origin_host) {
            return true;
        }
        return false;
    }

    // Origin ヘッダがない場合は Sec-Fetch-Site を same-origin のみ許容する
    let Ok(sfs_header) = get_single_header_str(headers, "sec-fetch-site") else {
        return false;
    };
    if let Some(sfs) = sfs_header {
        return sfs.eq_ignore_ascii_case("same-origin");
    }

    // Origin と Sec-Fetch-Site が両方欠落している場合は Referer のホスト一致を確認する
    let Ok(referer_header) = get_single_header_str(headers, header::REFERER) else {
        return false;
    };
    if let Some(referer) = referer_header {
        let Some((ref_host, is_https)) = extract_referer_host(referer) else {
            return false;
        };
        let ref_host_lower = ref_host.to_ascii_lowercase();
        let norm_ref_host = normalize_host_port(&ref_host_lower, is_https);
        let norm_ref_origin = format!(
            "{}://{}",
            if is_https { "https" } else { "http" },
            norm_ref_host
        );
        if allowed_origins.iter().any(|allowed| {
            normalize_origin_for_compare(allowed)
                .map(|(norm_allowed, _, _)| norm_allowed == norm_ref_origin)
                .unwrap_or(false)
        }) {
            return true;
        }
        // HTTPS 環境（または信頼プロキシの HTTPS 終端）での HTTP リファラからのスキームダウングレードを拒否する
        if effective_https && !is_https {
            return false;
        }
        if let Some(host) = host_header {
            let host_lower = host.to_ascii_lowercase();
            let norm_host = normalize_host_port(&host_lower, is_https);
            if norm_ref_host == norm_host {
                return true;
            }
        }
        if dev_mode && is_dev_local_host(norm_ref_host) {
            return true;
        }
        return false;
    }

    // Origin / Sec-Fetch-Site / Referer がすべて欠落している場合は本番モードではフェイルクローズ
    dev_mode
}

/// WebSocket 接続の Origin を検証する（Origin ヘッダ必須）
pub fn is_valid_ws_origin(
    headers: &HeaderMap,
    allowed_origins: &[String],
    dev_mode: bool,
    trust_proxy: bool,
    require_https: bool,
) -> bool {
    if headers.get(header::ORIGIN).is_none() {
        return false;
    }
    is_same_origin_request(headers, allowed_origins, dev_mode, trust_proxy, require_https)
}

/// レートリミッターおよびロックアウト管理で追跡する最大エントリ数（メモリ枯渇防止）
const MAX_TRACKED_ENTRIES: usize = 50_000;
/// 固定シャード数
const SHARD_COUNT: usize = 64;
/// 全走査クリーンアップの最小実行間隔（ミリ秒）
const CLEANUP_COOLDOWN_MS: u64 = 5_000;
/// 上限到達時に最古エントリ置換で検査するサンプル件数
const EVICT_SAMPLE_SIZE: usize = 32;

/// キーから固定シャードインデックスを O(1) で算出する
fn shard_index(key: &str) -> usize {
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    (hasher.finish() as usize) % SHARD_COUNT
}

/// 固定 64 シャードの RwLock<HashMap> 配列を生成する
fn new_shards<T>() -> Box<[RwLock<HashMap<String, T>>]> {
    (0..SHARD_COUNT)
        .map(|_| RwLock::new(HashMap::new()))
        .collect::<Vec<_>>()
        .into_boxed_slice()
}

/// 並行追い出し排他フラグを Drop 時に確実に解除する RAII ガード
struct EvictGuard<'a>(&'a AtomicBool);

impl Drop for EvictGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// 同時追い出しを 1 スレッドに制限するための排他取得を試みる
fn try_acquire_evict_guard(evicting: &AtomicBool) -> Option<EvictGuard<'_>> {
    evicting
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .ok()
        .map(|_| EvictGuard(evicting))
}

/// 前回実行からクールダウンが経過していれば true を返し、タイムスタンプを原子的に更新する
fn try_acquire_cleanup_slot(epoch: Instant, last_cleanup_ms: &AtomicU64) -> bool {
    let elapsed_ms = epoch.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let last = last_cleanup_ms.load(Ordering::Relaxed);
    if elapsed_ms.saturating_sub(last) < CLEANUP_COOLDOWN_MS {
        return false;
    }
    last_cleanup_ms
        .compare_exchange(last, elapsed_ms, Ordering::AcqRel, Ordering::Relaxed)
        .is_ok()
}

/// トークンバケット方式のレートリミッター
pub struct RateLimiter {
    burst: f64,
    refill_per_sec: f64,
    shards: Box<[RwLock<HashMap<String, Bucket>>]>,
    entry_count: AtomicUsize,
    epoch: Instant,
    last_cleanup_ms: AtomicU64,
    evict_cursor: AtomicUsize,
    evicting: AtomicBool,
}

struct Bucket {
    tokens: f64,
    last_refill: Instant,
}

impl RateLimiter {
    pub fn new(max_per_sec: u32) -> Self {
        Self::with_burst(max_per_sec as f64, max_per_sec as f64)
    }

    /// バースト上限と秒間補充レートを個別に指定して生成する
    pub fn with_burst(burst: f64, refill_per_sec: f64) -> Self {
        Self {
            burst,
            refill_per_sec,
            shards: new_shards(),
            entry_count: AtomicUsize::new(0),
            epoch: Instant::now(),
            last_cleanup_ms: AtomicU64::new(0),
            evict_cursor: AtomicUsize::new(0),
            evicting: AtomicBool::new(false),
        }
    }

    /// 上限到達時に超過分＋バッチ分を O(1) シャード選択でサンプリング追い出しし、上限を遵守する
    fn evict_oldest_sample(&self) {
        let Some(_guard) = try_acquire_evict_guard(&self.evicting) else {
            return;
        };
        let current = self.entry_count.load(Ordering::Relaxed);
        if current < MAX_TRACKED_ENTRIES {
            return;
        }
        let need = (current - MAX_TRACKED_ENTRIES + 64).min(1024);
        let mut removed = 0usize;
        let start = self.evict_cursor.fetch_add(1, Ordering::Relaxed) % SHARD_COUNT;

        for offset in 0..SHARD_COUNT {
            if removed >= need {
                break;
            }
            let shard_idx = (start + offset) % SHARD_COUNT;
            let mut map = self.shards[shard_idx].write();
            if map.is_empty() {
                continue;
            }
            let remain = need - removed;
            let sample_limit = (remain * 4).max(EVICT_SAMPLE_SIZE);
            let mut candidates: Vec<(String, Instant)> = map
                .iter()
                .take(sample_limit)
                .map(|(k, b)| (k.clone(), b.last_refill))
                .collect();
            candidates.sort_by_key(|(_, ts)| *ts);
            let mut shard_removed = 0usize;
            for (key, _) in candidates.into_iter().take(remain) {
                if map.remove(&key).is_some() {
                    shard_removed += 1;
                }
            }
            if shard_removed > 0 {
                self.entry_count.fetch_sub(shard_removed, Ordering::Relaxed);
                removed += shard_removed;
            }
        }
    }

    /// リクエストを許可できるかチェックし、可能ならトークンを1消費する
    pub fn check_and_consume(&self, key: &str) -> bool {
        let idx = shard_index(key);
        // 新規キー挿入前にメモリ枯渇防止の上限チェック（スロットル付き掃除＋最古エントリ置換）を行う
        if self.entry_count.load(Ordering::Relaxed) >= MAX_TRACKED_ENTRIES
            && !self.shards[idx].read().contains_key(key)
        {
            if try_acquire_cleanup_slot(self.epoch, &self.last_cleanup_ms) {
                let idle = Duration::from_secs(
                    ((self.burst / self.refill_per_sec.max(0.0001)).ceil() as u64).max(120),
                );
                self.cleanup_stale(idle);
            }
            if self.entry_count.load(Ordering::Relaxed) >= MAX_TRACKED_ENTRIES {
                self.evict_oldest_sample();
            }
        }

        let mut map = self.shards[idx].write();
        // 時刻巻き戻り競合を防ぐため、シャードロック取得後に現在時刻を取得する
        let now = Instant::now();
        let entry = map.entry(key.to_string()).or_insert_with(|| {
            self.entry_count.fetch_add(1, Ordering::Relaxed);
            Bucket {
                tokens: self.burst,
                // シャードロック取得後の時刻で初期化する
                last_refill: now,
            }
        });
        let elapsed = now
            .saturating_duration_since(entry.last_refill)
            .as_secs_f64();
        entry.tokens = (entry.tokens + elapsed * self.refill_per_sec).min(self.burst);
        entry.last_refill = now;

        if entry.tokens >= 1.0 {
            entry.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// 一定時間アクセスのないバケットを掃除してメモリ肥大を防止
    pub fn cleanup_stale(&self, max_idle: Duration) {
        let now = Instant::now();
        for shard in self.shards.iter() {
            let mut map = shard.write();
            if map.is_empty() {
                continue;
            }
            let before = map.len();
            map.retain(|_, b| now.saturating_duration_since(b.last_refill) < max_idle);
            let removed = before.saturating_sub(map.len());
            if removed > 0 {
                self.entry_count.fetch_sub(removed, Ordering::Relaxed);
            }
        }
    }
}

/// 連続ログイン失敗によるアカウント・IP ロックアウト管理
pub struct LoginLockout {
    max_failures: u32,
    lockout_duration: Duration,
    shards: Box<[RwLock<HashMap<String, LockoutEntry>>]>,
    entry_count: AtomicUsize,
    epoch: Instant,
    last_cleanup_ms: AtomicU64,
    evict_cursor: AtomicUsize,
    evicting: AtomicBool,
}

struct LockoutEntry {
    failures: u32,
    locked_until: Option<Instant>,
    last_attempt: Instant,
}

impl LoginLockout {
    pub fn new(max_failures: u32, lockout_duration: Duration) -> Self {
        Self {
            max_failures,
            lockout_duration,
            shards: new_shards(),
            entry_count: AtomicUsize::new(0),
            epoch: Instant::now(),
            last_cleanup_ms: AtomicU64::new(0),
            evict_cursor: AtomicUsize::new(0),
            evicting: AtomicBool::new(false),
        }
    }

    /// 上限到達時に超過分＋バッチ分を O(1) シャード選択で追い出す（未ロック最古を優先）
    fn evict_oldest_sample(&self) {
        let Some(_guard) = try_acquire_evict_guard(&self.evicting) else {
            return;
        };
        let current = self.entry_count.load(Ordering::Relaxed);
        if current < MAX_TRACKED_ENTRIES {
            return;
        }
        let need = (current - MAX_TRACKED_ENTRIES + 64).min(1024);
        let mut removed = 0usize;
        let start = self.evict_cursor.fetch_add(1, Ordering::Relaxed) % SHARD_COUNT;

        // 第1パス: 各シャードのライトロック保持中に未ロック判定と削除を原子的に行う
        for offset in 0..SHARD_COUNT {
            if removed >= need {
                break;
            }
            let shard_idx = (start + offset) % SHARD_COUNT;
            let mut map = self.shards[shard_idx].write();
            if map.is_empty() {
                continue;
            }
            let now = Instant::now();
            let remain = need - removed;
            let sample_limit = (remain * 4).max(EVICT_SAMPLE_SIZE);
            let mut unlocked: Vec<(String, Instant)> = map
                .iter()
                .filter(|(_, e)| e.locked_until.map(|u| now >= u).unwrap_or(true))
                .take(sample_limit)
                .map(|(k, e)| (k.clone(), e.last_attempt))
                .collect();
            unlocked.sort_by_key(|(_, ts)| *ts);

            let mut shard_removed = 0usize;
            for (key, _) in unlocked.into_iter().take(remain) {
                if map.remove(&key).is_some() {
                    shard_removed += 1;
                }
            }
            if shard_removed > 0 {
                self.entry_count.fetch_sub(shard_removed, Ordering::Relaxed);
                removed += shard_removed;
            }
        }

        // 第2パス: 全シャードに未ロック候補が存在しない場合のみロック中エントリをフォールバック削除する
        if removed < need {
            for offset in 0..SHARD_COUNT {
                if removed >= need {
                    break;
                }
                let shard_idx = (start + offset) % SHARD_COUNT;
                let mut map = self.shards[shard_idx].write();
                if map.is_empty() {
                    continue;
                }
                let remain = need - removed;
                let sample_limit = (remain * 4).max(EVICT_SAMPLE_SIZE);
                let mut locked: Vec<(String, Instant)> = map
                    .iter()
                    .take(sample_limit)
                    .map(|(k, e)| (k.clone(), e.last_attempt))
                    .collect();
                locked.sort_by_key(|(_, ts)| *ts);

                let mut shard_removed = 0usize;
                for (key, _) in locked.into_iter().take(remain) {
                    if map.remove(&key).is_some() {
                        shard_removed += 1;
                    }
                }
                if shard_removed > 0 {
                    self.entry_count.fetch_sub(shard_removed, Ordering::Relaxed);
                    removed += shard_removed;
                }
            }
        }
    }

    /// 指定キーが現在ロックアウト中か判定する
    pub fn is_locked(&self, key: &str) -> bool {
        let idx = shard_index(key);
        let map = self.shards[idx].read();
        let Some(entry) = map.get(key) else {
            return false;
        };
        entry
            .locked_until
            .map(|until| Instant::now() < until)
            .unwrap_or(false)
    }

    /// ログイン失敗を記録し、閾値到達時はロックアウトを設定する
    pub fn record_failure(&self, key: &str) {
        let idx = shard_index(key);
        // 新規キー挿入前にメモリ枯渇防止の上限チェック（スロットル付き掃除＋最古エントリ置換）を行う
        if self.entry_count.load(Ordering::Relaxed) >= MAX_TRACKED_ENTRIES
            && !self.shards[idx].read().contains_key(key)
        {
            if try_acquire_cleanup_slot(self.epoch, &self.last_cleanup_ms) {
                self.cleanup_stale(Duration::from_secs(300));
            }
            if self.entry_count.load(Ordering::Relaxed) >= MAX_TRACKED_ENTRIES {
                self.evict_oldest_sample();
            }
        }

        let mut map = self.shards[idx].write();
        // 時刻巻き戻り競合を防ぐため、シャードロック取得後に現在時刻を取得する
        let now = Instant::now();
        let entry = map.entry(key.to_string()).or_insert_with(|| {
            self.entry_count.fetch_add(1, Ordering::Relaxed);
            LockoutEntry {
                failures: 0,
                locked_until: None,
                // シャードロック取得後の時刻で初期化する
                last_attempt: now,
            }
        });
        // 過去のロックアウト期間が既に終了していればカウントをリセットする
        if let Some(until) = entry.locked_until {
            if now >= until {
                entry.failures = 0;
                entry.locked_until = None;
            }
        }
        entry.failures = entry.failures.saturating_add(1);
        entry.last_attempt = now;
        if entry.failures >= self.max_failures {
            entry.locked_until = Some(now + self.lockout_duration);
        }
    }

    /// ログイン成功時に失敗履歴をクリアする
    pub fn record_success(&self, key: &str) {
        let idx = shard_index(key);
        let mut map = self.shards[idx].write();
        if map.remove(key).is_some() {
            self.entry_count.fetch_sub(1, Ordering::Relaxed);
        }
    }

    /// 一定時間アクセスのないエントリを掃除する（ロック中は保持）
    pub fn cleanup_stale(&self, max_idle: Duration) {
        let now = Instant::now();
        for shard in self.shards.iter() {
            let mut map = shard.write();
            if map.is_empty() {
                continue;
            }
            let before = map.len();
            map.retain(|_, e| {
                let still_locked = e.locked_until.map(|u| now < u).unwrap_or(false);
                still_locked || now.saturating_duration_since(e.last_attempt) < max_idle
            });
            let removed = before.saturating_sub(map.len());
            if removed > 0 {
                self.entry_count.fetch_sub(removed, Ordering::Relaxed);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn password_hash_and_verify() {
        let hash = hash_password("secret123").unwrap();
        assert!(verify_password("secret123", &hash));
        assert!(!verify_password("wrongpass", &hash));
    }

    #[test]
    fn rate_limiter_enforces_10_per_sec() {
        let limiter = RateLimiter::new(10);
        for _ in 0..10 {
            assert!(limiter.check_and_consume("127.0.0.1"));
        }
        // 11回目は即座に拒否される
        assert!(!limiter.check_and_consume("127.0.0.1"));
        // 別キーは影響しない
        assert!(limiter.check_and_consume("10.0.0.1"));
    }

    #[test]
    fn rate_limiter_with_burst_respects_burst_capacity() {
        let limiter = RateLimiter::with_burst(3.0, 0.1);
        assert!(limiter.check_and_consume("user1"));
        assert!(limiter.check_and_consume("user1"));
        assert!(limiter.check_and_consume("user1"));
        assert!(!limiter.check_and_consume("user1"));
    }

    #[test]
    fn constant_time_eq_works() {
        assert!(constant_time_eq(b"abcdef", b"abcdef"));
        assert!(constant_time_eq(b"", b""));
        assert!(!constant_time_eq(b"abcdef", b"abcdeg"));
        assert!(!constant_time_eq(b"abcdef", b"abcde"));
        assert!(!constant_time_eq(b"abc", b"abcdef"));
    }

    #[test]
    fn validate_new_password_enforces_bounds() {
        assert!(validate_new_password("1234567").is_err());
        assert!(validate_new_password("12345678").is_ok());
        assert!(validate_new_password(&"a".repeat(128)).is_ok());
        assert!(validate_new_password(&"a".repeat(129)).is_err());
        // マルチバイト文字は8文字以上かつ128バイト以下
        assert!(validate_new_password("あいうえおかきく").is_ok());
        assert!(validate_new_password(&"あ".repeat(43)).is_err());
    }

    #[test]
    fn extract_cookie_finds_target() {
        let mut headers = HeaderMap::new();
        headers.append(
            header::COOKIE,
            HeaderValue::from_static("foo=bar; teien_session=abc123; baz=qux"),
        );
        assert_eq!(
            extract_cookie(&headers, "teien_session").as_deref(),
            Some("abc123")
        );
        assert_eq!(extract_cookie(&headers, "missing"), None);
    }

    #[test]
    fn is_same_origin_request_checks_origin_and_sec_fetch() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("game.example.com"));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://game.example.com"),
        );
        assert!(is_same_origin_request(&headers, &[], false, false, false));

        // 別オリジンは拒否、許可リストにあれば許可（大文字・デフォルトポート正規化含む）
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://EVIL.example.com:443"),
        );
        assert!(!is_same_origin_request(&headers, &[], false, false, false));
        assert!(is_same_origin_request(
            &headers,
            &["https://evil.example.com".to_string()],
            false,
            false,
            false
        ));

        // dev_mode 時は localhost 各ポートを許可
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:5173"),
        );
        assert!(!is_same_origin_request(&headers, &[], false, false, false));
        assert!(is_same_origin_request(&headers, &[], true, false, false));

        // Origin なし + Sec-Fetch-Site: same-origin のみ許可（cross-site / same-site / none は拒否）
        headers.remove(header::ORIGIN);
        for denied in ["cross-site", "same-site", "none"] {
            headers.insert("sec-fetch-site", HeaderValue::from_static(denied));
            assert!(!is_same_origin_request(&headers, &[], false, false, false));
        }
        headers.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
        assert!(is_same_origin_request(&headers, &[], false, false, false));
    }

    #[test]
    fn login_lockout_lifecycle() {
        let lockout = LoginLockout::new(3, Duration::from_secs(60));
        assert!(!lockout.is_locked("user1"));
        lockout.record_failure("user1");
        lockout.record_failure("user1");
        assert!(!lockout.is_locked("user1"));
        lockout.record_failure("user1");
        assert!(lockout.is_locked("user1"));

        lockout.record_success("user1");
        assert!(!lockout.is_locked("user1"));
    }

    #[test]
    fn extract_client_ip_prefers_last_xff_header_and_rightmost_ip() {
        let addr: SocketAddr = "192.0.2.1:12345".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.append("x-forwarded-for", HeaderValue::from_static("198.51.100.1, 203.0.113.10"));
        headers.append("x-forwarded-for", HeaderValue::from_static("198.51.100.2, 203.0.113.20"));
        headers.insert("x-real-ip", HeaderValue::from_static("198.51.100.99"));
        assert_eq!(extract_client_ip(addr, &headers, true), "203.0.113.20");
        assert_eq!(extract_client_ip(addr, &headers, false), "192.0.2.1");

        // X-Forwarded-For が無い場合は X-Real-IP にフォールバック
        headers.remove("x-forwarded-for");
        assert_eq!(extract_client_ip(addr, &headers, true), "198.51.100.99");
    }

    #[test]
    fn is_same_origin_request_normalizes_default_ports_and_checks_referer() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("game.example.com"));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://game.example.com:443"),
        );
        assert!(is_same_origin_request(&headers, &[], false, false, false));

        // Origin / Sec-Fetch-Site 欠落時は Referer を検証
        headers.remove(header::ORIGIN);
        headers.insert(
            header::REFERER,
            HeaderValue::from_static("https://evil.example.com/attack"),
        );
        assert!(!is_same_origin_request(&headers, &[], false, false, false));

        headers.insert(
            header::REFERER,
            HeaderValue::from_static("https://game.example.com:443/play"),
        );
        assert!(is_same_origin_request(&headers, &[], false, false, false));

        // trust_proxy=true の HTTPS プロキシ配下での HTTP Referer ダウングレードを拒否
        headers.insert(
            "x-forwarded-proto",
            HeaderValue::from_static("HTTPS"),
        );
        headers.insert(
            header::REFERER,
            HeaderValue::from_static("http://game.example.com/play"),
        );
        assert!(!is_same_origin_request(&headers, &[], false, true, false));
        // trust_proxy=false かつ require_https=false なら X-Forwarded-Proto は無視される
        assert!(is_same_origin_request(&headers, &[], false, false, false));
        // require_https=true なら X-Forwarded-Proto 無しでも HTTP Referer は拒否される
        headers.remove("x-forwarded-proto");
        assert!(!is_same_origin_request(&headers, &[], false, false, true));
    }

    #[test]
    fn extract_client_ip_hardening_and_canonicalization() {
        let v4_mapped_addr: SocketAddr = "[::ffff:192.0.2.1]:12345".parse().unwrap();
        let mut headers = HeaderMap::new();
        // X-Forwarded-For が不正値の場合は X-Real-IP へフォールバックせずソケット IP を返す
        headers.insert("x-forwarded-for", HeaderValue::from_static("not-an-ip"));
        headers.insert("x-real-ip", HeaderValue::from_static("198.51.100.50"));
        assert_eq!(extract_client_ip(v4_mapped_addr, &headers, true), "192.0.2.1");

        // X-Real-IP が複数ある場合は末尾を優先し、IPv4-mapped IPv6 は正規化される
        headers.remove("x-forwarded-for");
        headers.append("x-real-ip", HeaderValue::from_static("::ffff:198.51.100.77"));
        assert_eq!(
            extract_client_ip(v4_mapped_addr, &headers, true),
            "198.51.100.77"
        );
    }

    #[test]
    fn is_same_origin_request_enforces_whitelist_and_fail_closed() {
        // Origin / Sec-Fetch-Site / Referer がすべて欠落している場合は本番で拒否、dev_mode で許可
        let empty = HeaderMap::new();
        assert!(!is_same_origin_request(&empty, &[], false, false, false));
        assert!(is_same_origin_request(&empty, &[], true, false, false));

        // 複数 Origin や複数 Host は拒否
        let mut multi_origin = HeaderMap::new();
        multi_origin.insert(header::HOST, HeaderValue::from_static("game.example.com"));
        multi_origin.append(
            header::ORIGIN,
            HeaderValue::from_static("https://game.example.com"),
        );
        multi_origin.append(
            header::ORIGIN,
            HeaderValue::from_static("https://evil.example.com"),
        );
        assert!(!is_same_origin_request(&multi_origin, &[], false, false, false));

        let mut multi_host = HeaderMap::new();
        multi_host.append(header::HOST, HeaderValue::from_static("game.example.com"));
        multi_host.append(header::HOST, HeaderValue::from_static("evil.example.com"));
        multi_host.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://game.example.com"),
        );
        assert!(!is_same_origin_request(&multi_host, &[], false, false, false));

        // Sec-Fetch-Site は same-origin のみ許容
        let mut sfs = HeaderMap::new();
        sfs.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
        assert!(is_same_origin_request(&sfs, &[], false, false, false));
        for denied in ["cross-site", "same-site", "none", "unknown", "same-origin, cross-site"] {
            sfs.insert("sec-fetch-site", HeaderValue::from_static(denied));
            assert!(!is_same_origin_request(&sfs, &[], false, false, false));
        }

        // trust_proxy=true の多段プロキシの X-Forwarded-Proto でも http:// ダウングレードを拒否
        let mut proto = HeaderMap::new();
        proto.insert(header::HOST, HeaderValue::from_static("game.example.com"));
        proto.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://game.example.com"),
        );
        proto.insert(
            "x-forwarded-proto",
            HeaderValue::from_static("http, https"),
        );
        assert!(!is_same_origin_request(&proto, &[], false, true, false));
    }

    #[test]
    fn validate_display_name_rejects_control_zero_width_and_bidi_chars() {
        assert_eq!(
            validate_display_name("  Player1  ", 2, 20, "ユーザー名").unwrap(),
            "Player1"
        );
        assert!(validate_display_name("a\nb", 2, 20, "ユーザー名").is_err());
        assert!(validate_display_name("ab\r", 2, 20, "ユーザー名").is_err());
        assert!(validate_display_name("ab\u{200B}c", 2, 20, "ユーザー名").is_err());
        assert!(validate_display_name("ab\u{202E}c", 2, 20, "ユーザー名").is_err());
        assert!(validate_display_name("\u{3000}\u{3000}", 1, 20, "勢力名").is_err());
    }

    #[test]
    fn evict_guard_resets_flag_on_drop_and_blocks_concurrent_acquisition() {
        let evicting = AtomicBool::new(false);
        {
            let guard = try_acquire_evict_guard(&evicting);
            assert!(guard.is_some());
            // 排他取得中は2つ目の取得が拒否される
            assert!(try_acquire_evict_guard(&evicting).is_none());
        }
        // スコープ終了（Drop）後は再び取得できる
        assert!(try_acquire_evict_guard(&evicting).is_some());
    }

    #[test]
    fn rate_limiter_evicts_at_max_entries_and_keeps_count_bounded() {
        let limiter = RateLimiter::new(10);
        for i in 0..(MAX_TRACKED_ENTRIES + 200) {
            let key = format!("rl-key-{}", i);
            assert!(limiter.check_and_consume(&key));
        }

        let actual_len: usize = limiter.shards.iter().map(|s| s.read().len()).sum();
        assert_eq!(limiter.entry_count.load(Ordering::Relaxed), actual_len);
        assert!(actual_len <= MAX_TRACKED_ENTRIES);
        assert!(!limiter.evicting.load(Ordering::Acquire));

        limiter.cleanup_stale(Duration::ZERO);
        let after_cleanup: usize = limiter.shards.iter().map(|s| s.read().len()).sum();
        assert_eq!(after_cleanup, 0);
        assert_eq!(limiter.entry_count.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn rate_limiter_concurrent_eviction_is_serialized_and_safe() {
        use std::sync::{Arc, Barrier};

        let limiter = Arc::new(RateLimiter::new(10));
        for i in 0..MAX_TRACKED_ENTRIES {
            limiter.check_and_consume(&format!("seed-{}", i));
        }

        let threads = 4;
        let barrier = Arc::new(Barrier::new(threads));
        let mut handles = Vec::with_capacity(threads);
        for t in 0..threads {
            let limiter = Arc::clone(&limiter);
            let barrier = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                for j in 0..100 {
                    limiter.check_and_consume(&format!("conc-{}-{}", t, j));
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        let actual_len: usize = limiter.shards.iter().map(|s| s.read().len()).sum();
        assert_eq!(limiter.entry_count.load(Ordering::Relaxed), actual_len);
        assert!(actual_len <= MAX_TRACKED_ENTRIES);
        assert!(!limiter.evicting.load(Ordering::Acquire));
    }

    #[test]
    fn login_lockout_eviction_preserves_locked_entries_over_unlocked() {
        let lockout = LoginLockout::new(3, Duration::from_secs(600));
        // 100 件をロックアウト状態にする
        for i in 0..100 {
            let key = format!("locked-{}", i);
            lockout.record_failure(&key);
            lockout.record_failure(&key);
            lockout.record_failure(&key);
            assert!(lockout.is_locked(&key));
        }
        // 残りを未ロック状態（1回失敗）で上限まで埋める
        for i in 0..(MAX_TRACKED_ENTRIES - 100) {
            lockout.record_failure(&format!("unlocked-{}", i));
        }
        // さらに新規キーを追加して追い出しを複数回発動させる
        for i in 0..500 {
            lockout.record_failure(&format!("extra-{}", i));
        }

        // 未ロックエントリが優先削除され、ロック中エントリはすべて保護されている
        for i in 0..100 {
            assert!(
                lockout.is_locked(&format!("locked-{}", i)),
                "ロック中エントリ locked-{} が誤って追い出された",
                i
            );
        }
        let actual_len: usize = lockout.shards.iter().map(|s| s.read().len()).sum();
        assert_eq!(lockout.entry_count.load(Ordering::Relaxed), actual_len);
        assert!(actual_len <= MAX_TRACKED_ENTRIES);
        assert!(!lockout.evicting.load(Ordering::Acquire));
    }

    #[test]
    fn login_lockout_eviction_falls_back_to_locked_when_no_unlocked_exist() {
        let lockout = LoginLockout::new(1, Duration::from_secs(600));
        // 全件ロックアウト状態で上限まで埋める
        for i in 0..MAX_TRACKED_ENTRIES {
            let key = format!("all-locked-{}", i);
            lockout.record_failure(&key);
        }
        // さらに新規キーを追加するとフォールバック削除が働き上限以内に収まる
        for i in 0..100 {
            lockout.record_failure(&format!("overflow-{}", i));
        }

        let actual_len: usize = lockout.shards.iter().map(|s| s.read().len()).sum();
        assert_eq!(lockout.entry_count.load(Ordering::Relaxed), actual_len);
        assert!(actual_len <= MAX_TRACKED_ENTRIES);
        assert!(!lockout.evicting.load(Ordering::Acquire));
    }

    #[test]
    fn dev_local_host_recognizes_ipv6_loopback() {
        assert!(is_dev_local_host("localhost"));
        assert!(is_dev_local_host("127.0.0.1:5173"));
        assert!(is_dev_local_host("[::1]"));
        assert!(is_dev_local_host("[::1]:5173"));
        assert!(!is_dev_local_host("[::1]:abc"));
        assert!(!is_dev_local_host("example.com"));
    }

    #[test]
    fn extract_cookie_skips_empty_values() {
        let mut empty_only = HeaderMap::new();
        empty_only.insert(header::COOKIE, HeaderValue::from_static("teien_session="));
        assert_eq!(extract_cookie(&empty_only, "teien_session"), None);

        let mut empty_then_valid = HeaderMap::new();
        empty_then_valid.insert(
            header::COOKIE,
            HeaderValue::from_static("teien_session=; other=1; teien_session=tok123"),
        );
        assert_eq!(
            extract_cookie(&empty_then_valid, "teien_session").as_deref(),
            Some("tok123")
        );
    }
}
