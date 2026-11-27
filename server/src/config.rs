use std::env;
use std::path::{Path, PathBuf};

/// サーバー動作設定
#[derive(Clone)]
pub struct Config {
    /// 待受アドレス
    pub bind_addr: String,
    /// SQLite データベースファイルパス
    pub db_path: PathBuf,
    /// フロントエンド静的ファイルディレクトリ
    pub static_dir: PathBuf,
    /// 開発モード（フェーズ切替・手動ティック・AP補充APIの有効化）
    pub dev_mode: bool,
    /// マップ生成シード値（未指定時はランダムまたはシーズン番号から算出）
    pub map_seed: Option<u64>,
    /// 管理者ログインID（デフォルト: admin）
    pub admin_id: String,
    /// 管理者パスワード（未設定時は dev_mode=true なら Some("admin")、dev_mode=false なら None）
    pub admin_password: Option<String>,
    /// リバースプロキシからの転送ヘッダを信頼するか
    pub trust_proxy: bool,
    /// セッションクッキーに Secure 属性を付与するか
    pub cookie_secure: bool,
    /// CORS / Origin チェックで許可するオリジン一覧
    pub allowed_origins: Vec<String>,
}

/// 環境変数文字列を真偽値として解釈する（"1" / "true" のみ true）
fn parse_env_bool_true_only(val: &str) -> bool {
    let normalized = val.trim().to_ascii_lowercase();
    normalized == "1" || normalized == "true"
}

/// 環境変数を読み込み、前後の空白を除去したうえで空文字列なら None を返す
fn env_non_empty(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// ポート番号文字列が 1..=65535 の有効な数値か検証する
fn parse_valid_port(port_str: &str) -> Option<u16> {
    if port_str.is_empty() || !port_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    port_str.parse::<u16>().ok().filter(|&p| p > 0)
}

/// 許可オリジン文字列を検証し、正規化済みオリジン（`scheme://host[:port]`）を返す
pub fn validate_and_normalize_origin(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "*" || trimmed.eq_ignore_ascii_case("null") {
        return None;
    }

    // スキームを大文字小文字無視で検証し、小文字へ正規化する
    let (scheme, rest) = if trimmed
        .get(..7)
        .is_some_and(|s| s.eq_ignore_ascii_case("http://"))
    {
        ("http", &trimmed[7..])
    } else if trimmed
        .get(..8)
        .is_some_and(|s| s.eq_ignore_ascii_case("https://"))
    {
        ("https", &trimmed[8..])
    } else {
        return None;
    };

    // 末尾のスラッシュ1つのみ許容して除去する（パス付きオリジンは後続チェックで拒否）
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

    // ホスト部とポート部を分離して検証する
    let (host_lower, port_opt) = if let Some(after_bracket) = authority.strip_prefix('[') {
        // IPv6 リテラル: `[addr]` または `[addr]:port`
        let close_idx = after_bracket.find(']')?;
        let ipv6_host = &after_bracket[..close_idx];
        if ipv6_host.is_empty() || ipv6_host.contains('[') {
            return None;
        }
        let remainder = &after_bracket[close_idx + 1..];
        let port_opt = if remainder.is_empty() {
            None
        } else if let Some(port_str) = remainder.strip_prefix(':') {
            Some(parse_valid_port(port_str)?)
        } else {
            return None;
        };
        (format!("[{}]", ipv6_host.to_ascii_lowercase()), port_opt)
    } else if let Some((host, port_str)) = authority.split_once(':') {
        if host.is_empty() || port_str.contains(':') {
            return None;
        }
        let port = parse_valid_port(port_str)?;
        (host.to_ascii_lowercase(), Some(port))
    } else {
        (authority.to_ascii_lowercase(), None)
    };

    // デフォルトポート（http:80 / https:443）はブラウザの Origin ヘッダ仕様に合わせて省略する
    let normalized_port = match (scheme, port_opt) {
        ("http", Some(80)) | ("https", Some(443)) => None,
        (_, p) => p,
    };
    match normalized_port {
        Some(port) => Some(format!("{scheme}://{host_lower}:{port}")),
        None => Some(format!("{scheme}://{host_lower}")),
    }
}

/// パスの `.` と `..` を字句的に正規化する
fn normalize_lexical_path(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(comp.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push(comp.as_os_str());
                }
            }
            Component::Normal(s) => out.push(s),
        }
    }
    out
}

#[cfg(windows)]
fn normalize_verbatim_prefix(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{}", rest));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

#[cfg(not(windows))]
fn normalize_verbatim_prefix(path: PathBuf) -> PathBuf {
    path
}

/// パスを可能な限り存在する祖先から `canonicalize` し、未作成ファイルでも正規化済み絶対パスへ解決する
fn resolve_normalized_path(path: &Path) -> PathBuf {
    if let Ok(canon) = std::fs::canonicalize(path) {
        return normalize_verbatim_prefix(canon);
    }
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else if let Ok(cwd) = env::current_dir() {
        cwd.join(path)
    } else {
        path.to_path_buf()
    };
    let lexical = normalize_lexical_path(&abs);
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = lexical.as_path();
    while !cur.as_os_str().is_empty() {
        if let Ok(canon) = std::fs::canonicalize(cur) {
            let mut out = normalize_verbatim_prefix(canon);
            for part in suffix.iter().rev() {
                out.push(part);
            }
            return out;
        }
        let Some(name) = cur.file_name() else {
            break;
        };
        suffix.push(name.to_os_string());
        let Some(parent) = cur.parent() else {
            break;
        };
        cur = parent;
    }
    normalize_verbatim_prefix(lexical)
}

impl Config {
    /// 保持している平文の管理者パスワードを取り出し、Config 内のフィールドを None に消去する
    pub fn take_admin_password(&mut self) -> Option<String> {
        self.admin_password.take()
    }

    /// `static_dir` 配下に `db_path` が含まれて DB ファイルが静的配信で露出しないか検証する
    pub fn validate_static_dir_safety(&self) -> Result<(), String> {
        if self.db_path == Path::new(":memory:") {
            return Ok(());
        }
        let norm_static = resolve_normalized_path(&self.static_dir);
        let norm_db = resolve_normalized_path(&self.db_path);
        if norm_db.starts_with(&norm_static) {
            let msg = format!(
                "SEIRYOKUZU_STATIC_DIR ({}) の配下に DB パス ({}) が含まれており、DB ファイルが静的配信される恐れがあります",
                norm_static.display(),
                norm_db.display()
            );
            if !self.dev_mode {
                return Err(msg);
            }
            tracing::warn!("{}（dev_mode のため継続します）", msg);
        }
        Ok(())
    }

    /// 環境変数から設定を読み込む
    pub fn from_env() -> Self {
        let bind_addr =
            env_non_empty("SEIRYOKUZU_BIND_ADDR").unwrap_or_else(|| "127.0.0.1:3000".to_string());
        let db_path = env_non_empty("SEIRYOKUZU_DB_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("data/teien.db"));
        let static_dir = env_non_empty("SEIRYOKUZU_STATIC_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("../client/dist"));
        if static_dir == Path::new(".")
            || static_dir == Path::new("./")
            || db_path.starts_with(&static_dir)
        {
            tracing::warn!(
                "SEIRYOKUZU_STATIC_DIR ({}) がカレントディレクトリまたは DB パス ({}) を含む可能性があるため注意してください",
                static_dir.display(),
                db_path.display()
            );
        }
        let dev_mode = env::var("SEIRYOKUZU_DEVMODE")
            .map(|v| parse_env_bool_true_only(&v))
            .unwrap_or(false);
        let map_seed = env::var("SEIRYOKUZU_MAP_SEED").ok().and_then(|v| v.parse::<u64>().ok());
        let admin_id = env::var("SEIRYOKUZU_ADMIN_ID")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "admin".to_string());
        let admin_password = match env::var("SEIRYOKUZU_ADMIN_PASS") {
            Ok(pw) if !pw.is_empty() => Some(pw),
            _ => {
                if dev_mode {
                    Some("admin".to_string())
                } else {
                    None
                }
            }
        };
        let trust_proxy = env::var("SEIRYOKUZU_TRUST_PROXY")
            .map(|v| parse_env_bool_true_only(&v))
            .unwrap_or(false);
        let cookie_secure = env::var("SEIRYOKUZU_COOKIE_SECURE")
            .ok()
            .and_then(|v| match v.trim().to_ascii_lowercase().as_str() {
                "1" | "true" => Some(true),
                "0" | "false" => Some(false),
                _ => None,
            })
            .unwrap_or_else(|| {
                trust_proxy
                    || (!bind_addr.starts_with("127.0.0.1:")
                        && !bind_addr.starts_with("localhost:")
                        && !bind_addr.starts_with("[::1]:"))
            });
        let allowed_origins = env::var("SEIRYOKUZU_ALLOWED_ORIGINS")
            .ok()
            .map(|v| {
                let mut origins = Vec::new();
                for item in v.split(',') {
                    let trimmed = item.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    match validate_and_normalize_origin(trimmed) {
                        Some(origin) => {
                            if !origins.contains(&origin) {
                                origins.push(origin);
                            }
                        }
                        None => {
                            tracing::warn!(
                                "SEIRYOKUZU_ALLOWED_ORIGINS の不正なオリジンを除外しました: {:?}",
                                trimmed
                            );
                        }
                    }
                }
                origins
            })
            .unwrap_or_default();

        Self {
            bind_addr,
            db_path,
            static_dir,
            dev_mode,
            map_seed,
            admin_id,
            admin_password,
            trust_proxy,
            cookie_secure,
            allowed_origins,
        }
    }
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // admin_password はログ出力時の漏洩を防ぐためマスクする
        let masked_password = self.admin_password.as_ref().map(|_| "[REDACTED]");
        f.debug_struct("Config")
            .field("bind_addr", &self.bind_addr)
            .field("db_path", &self.db_path)
            .field("static_dir", &self.static_dir)
            .field("dev_mode", &self.dev_mode)
            .field("map_seed", &self.map_seed)
            .field("admin_id", &self.admin_id)
            .field("admin_password", &masked_password)
            .field("trust_proxy", &self.trust_proxy)
            .field("cookie_secure", &self.cookie_secure)
            .field("allowed_origins", &self.allowed_origins)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_config(static_dir: PathBuf, db_path: PathBuf, dev_mode: bool) -> Config {
        Config {
            bind_addr: "127.0.0.1:3000".into(),
            db_path,
            static_dir,
            dev_mode,
            map_seed: None,
            admin_id: "admin".into(),
            admin_password: None,
            trust_proxy: false,
            cookie_secure: false,
            allowed_origins: Vec::new(),
        }
    }

    #[test]
    fn validate_static_dir_safety_detects_relative_db_inside_static_dir() {
        let cfg_prod = dummy_config(PathBuf::from("."), PathBuf::from("./data/teien.db"), false);
        assert!(cfg_prod.validate_static_dir_safety().is_err());

        let cfg_nested_nonexistent = dummy_config(
            PathBuf::from("."),
            PathBuf::from("nonexistent_dir_1/nonexistent_dir_2/teien.db"),
            false,
        );
        assert!(cfg_nested_nonexistent.validate_static_dir_safety().is_err());

        let cfg_dev = dummy_config(PathBuf::from("."), PathBuf::from("./data/teien.db"), true);
        assert!(cfg_dev.validate_static_dir_safety().is_ok());

        let cfg_safe = dummy_config(
            PathBuf::from("../client/dist"),
            PathBuf::from("data/teien.db"),
            false,
        );
        assert!(cfg_safe.validate_static_dir_safety().is_ok());
    }

    #[test]
    fn validate_and_normalize_origin_strips_default_ports() {
        assert_eq!(
            validate_and_normalize_origin("http://Example.com:80"),
            Some("http://example.com".to_string())
        );
        assert_eq!(
            validate_and_normalize_origin("https://Example.com:443/"),
            Some("https://example.com".to_string())
        );
        assert_eq!(
            validate_and_normalize_origin("https://Example.com:8443"),
            Some("https://example.com:8443".to_string())
        );
    }
}
