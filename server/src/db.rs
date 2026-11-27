use crate::board::{Board, CHUNK_BYTE_LEN, CHUNK_SIZE};
use crate::map_gen::{generate_terrain, MapGenParams};
use chrono::Utc;
use rand::Rng;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous,
};
use sqlx::{Row, SqlitePool};
use std::path::Path;

/// SQLite 接続プールを初期化し、WAL モード・NORMAL 同期およびスキーマを作成する
pub async fn init_db(db_path: &Path) -> Result<SqlitePool, sqlx::Error> {
    if let Some(parent) = db_path.parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }

    let opts = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(5))
        .pragma("cache_size", "-32000")
        .pragma("temp_store", "MEMORY")
        .pragma("mmap_size", "134217728");

    let pool = SqlitePoolOptions::new()
        .max_connections(16)
        .connect_with(opts)
        .await?;

    create_schema(&pool).await?;
    Ok(pool)
}

/// インメモリ SQLite（ユニット・統合テスト用）を初期化
#[cfg(test)]
pub async fn init_memory_db() -> Result<SqlitePool, sqlx::Error> {
    let opts = SqliteConnectOptions::new()
        .filename(":memory:")
        .create_if_missing(true)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await?;
    create_schema(&pool).await?;
    Ok(pool)
}

async fn create_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let statements = [
        r#"
        CREATE TABLE IF NOT EXISTS seasons (
            season_id INTEGER PRIMARY KEY,
            seed INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS season_map_meta (
            season_id INTEGER PRIMARY KEY,
            board_size INTEGER NOT NULL,
            continent_count INTEGER NOT NULL,
            island_count INTEGER NOT NULL,
            land_ratio_pct INTEGER NOT NULL,
            seed INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS chunks (
            season_id INTEGER NOT NULL,
            chunk_id INTEGER NOT NULL,
            data BLOB NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (season_id, chunk_id)
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            ap INTEGER NOT NULL DEFAULT 30 CHECK (ap >= 0),
            faction_id INTEGER NOT NULL DEFAULT 0,
            auto_paint_enabled INTEGER NOT NULL DEFAULT 0,
            auto_paint_pct INTEGER NOT NULL DEFAULT 50,
            created_at TEXT NOT NULL
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS admin_sessions (
            token TEXT PRIMARY KEY,
            admin_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS game_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS player_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            season_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            faction_id INTEGER NOT NULL DEFAULT 0,
            target_faction_id INTEGER NOT NULL DEFAULT 0,
            category TEXT NOT NULL,
            summary TEXT NOT NULL,
            visibility INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS timelapse_frames (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            season_id INTEGER NOT NULL,
            tick_number INTEGER NOT NULL,
            board_size INTEGER NOT NULL,
            snapshot_gz BLOB NOT NULL,
            created_at TEXT NOT NULL
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS factions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            season_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            color_id INTEGER NOT NULL,
            leader_user_id INTEGER NOT NULL,
            initial_core_used INTEGER NOT NULL DEFAULT 0,
            territory_count INTEGER NOT NULL DEFAULT 0,
            core_count INTEGER NOT NULL DEFAULT 0,
            is_extinct INTEGER NOT NULL DEFAULT 0,
            ever_had_territory INTEGER NOT NULL DEFAULT 0,
            allow_auto_paint INTEGER NOT NULL DEFAULT 1,
            join_policy INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            UNIQUE (season_id, name),
            UNIQUE (season_id, color_id)
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS faction_members (
            faction_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            is_vice_leader INTEGER NOT NULL DEFAULT 0,
            can_declare_war INTEGER NOT NULL DEFAULT 0,
            can_ceasefire INTEGER NOT NULL DEFAULT 0,
            can_manage_members INTEGER NOT NULL DEFAULT 0,
            joined_at TEXT NOT NULL,
            PRIMARY KEY (faction_id, user_id)
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS faction_join_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            faction_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE (faction_id, user_id)
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS diplomacy_wars (
            season_id INTEGER NOT NULL,
            faction_a INTEGER NOT NULL,
            faction_b INTEGER NOT NULL,
            started_at TEXT NOT NULL,
            PRIMARY KEY (season_id, faction_a, faction_b)
        );
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS ceasefire_proposals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            season_id INTEGER NOT NULL,
            from_faction_id INTEGER NOT NULL,
            to_faction_id INTEGER NOT NULL,
            proposed_by INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE (season_id, from_faction_id, to_faction_id)
        );
        "#,
    ];

    for sql in statements {
        sqlx::query(sql).execute(pool).await?;
    }

    // 既存 DB 向け冪等カラム追加マイグレーション
    let migrations = [
        "ALTER TABLE users ADD COLUMN auto_paint_enabled INTEGER NOT NULL DEFAULT 0;",
        "ALTER TABLE users ADD COLUMN auto_paint_pct INTEGER NOT NULL DEFAULT 50;",
        "ALTER TABLE factions ADD COLUMN allow_auto_paint INTEGER NOT NULL DEFAULT 1;",
        "ALTER TABLE sessions ADD COLUMN expires_at TEXT;",
        "ALTER TABLE admin_sessions ADD COLUMN expires_at TEXT;",
        "ALTER TABLE factions ADD COLUMN join_policy INTEGER NOT NULL DEFAULT 0;",
        "ALTER TABLE factions ADD COLUMN ever_had_territory INTEGER NOT NULL DEFAULT 0;",
        "ALTER TABLE player_logs ADD COLUMN visibility INTEGER NOT NULL DEFAULT 0;",
        "ALTER TABLE player_logs ADD COLUMN target_faction_id INTEGER NOT NULL DEFAULT 0;",
    ];
    for m in migrations {
        let _ = sqlx::query(m).execute(pool).await;
    }
    // 旧共有AP機能で使用していたトリガーが残存している場合は削除する
    sqlx::query("DROP TRIGGER IF EXISTS trg_factions_shared_ap_non_negative_insert")
        .execute(pool)
        .await?;
    sqlx::query("DROP TRIGGER IF EXISTS trg_factions_shared_ap_non_negative_update")
        .execute(pool)
        .await?;
    // 廃止した勢力招待テーブルが残存している場合は削除する
    sqlx::query("DROP TABLE IF EXISTS faction_invites")
        .execute(pool)
        .await?;
    // 既存勢力行の ever_had_territory を補完する
    sqlx::query(
        "UPDATE factions SET ever_had_territory = 1 WHERE ever_had_territory = 0 AND (territory_count > 0 OR initial_core_used > 0 OR is_extinct != 0)",
    )
    .execute(pool)
    .await?;
    let _ = sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_player_logs_season_cat ON player_logs (season_id, category, id DESC);",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_timelapse_season ON timelapse_frames (season_id, id ASC);",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_id ON admin_sessions (admin_id);",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions (expires_at);",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_faction_join_requests_user_id ON faction_join_requests (user_id);",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_factions_season_order ON factions (season_id, territory_count DESC, core_count DESC, id ASC);",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_player_logs_season_id ON player_logs (season_id, id DESC);",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_player_logs_season_fac ON player_logs (season_id, faction_id, id DESC);",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_player_logs_season_user ON player_logs (season_id, user_id, id DESC);",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_player_logs_season_target_fac ON player_logs (season_id, target_faction_id, id DESC);",
    )
    .execute(pool)
    .await;

    Ok(())
}

/// expires_at カラム文字列（RFC3339 または UNIX 秒）を UNIX 秒へ変換する
fn parse_expires_at_unix_str(raw: &str) -> Option<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(raw.trim()) {
        return Some(dt.timestamp());
    }
    raw.trim().parse::<i64>().ok()
}

/// DB行の expires_at カラム（TEXT 優先、失敗時は i64）を UNIX 秒へ変換する（NULL や不正値は None）
fn parse_expires_at_from_row(row: &sqlx::sqlite::SqliteRow) -> Option<i64> {
    if let Ok(s) = row.try_get::<String, _>("expires_at") {
        return parse_expires_at_unix_str(&s);
    }
    row.try_get::<i64, _>("expires_at").ok()
}

/// セッション行一覧から期限切れ・NULL・不正形式のトークンを抽出する
fn collect_expired_tokens(rows: Vec<sqlx::sqlite::SqliteRow>, now: i64) -> Vec<String> {
    rows.into_iter()
        .filter_map(|r| {
            let Ok(tok) = r.try_get::<String, _>("token") else {
                return None;
            };
            match parse_expires_at_from_row(&r) {
                Some(exp) if exp > now => None,
                _ => Some(tok),
            }
        })
        .collect()
}

/// 有効期限切れの一般セッション・管理者セッション（expires_at IS NULL を含む）を rowid バッチでデータベースから削除し、削除した一般ユーザートークン一覧を返す
pub async fn cleanup_expired_sessions(pool: &SqlitePool) -> Vec<String> {
    const BATCH_LIMIT: i64 = 500;
    let now = Utc::now().timestamp();

    let mut expired_user_tokens = Vec::new();
    let mut last_rowid = 0i64;
    loop {
        let rows = sqlx::query(
            "SELECT rowid, token, expires_at FROM sessions WHERE rowid > ? ORDER BY rowid ASC LIMIT ?",
        )
        .bind(last_rowid)
        .bind(BATCH_LIMIT)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        if rows.is_empty() {
            break;
        }
        let fetched_len = rows.len() as i64;
        if let Some(last) = rows.last() {
            last_rowid = last.try_get::<i64, _>("rowid").unwrap_or(last_rowid);
        }
        expired_user_tokens.extend(collect_expired_tokens(rows, now));
        if fetched_len < BATCH_LIMIT {
            break;
        }
    }

    let mut expired_admin_tokens = Vec::new();
    let mut last_admin_rowid = 0i64;
    loop {
        let rows = sqlx::query(
            "SELECT rowid, token, expires_at FROM admin_sessions WHERE rowid > ? ORDER BY rowid ASC LIMIT ?",
        )
        .bind(last_admin_rowid)
        .bind(BATCH_LIMIT)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        if rows.is_empty() {
            break;
        }
        let fetched_len = rows.len() as i64;
        if let Some(last) = rows.last() {
            last_admin_rowid = last.try_get::<i64, _>("rowid").unwrap_or(last_admin_rowid);
        }
        expired_admin_tokens.extend(collect_expired_tokens(rows, now));
        if fetched_len < BATCH_LIMIT {
            break;
        }
    }

    if expired_user_tokens.is_empty() && expired_admin_tokens.is_empty() {
        return Vec::new();
    }
    if let Ok(mut tx) = begin_immediate(pool).await {
        for tok in &expired_user_tokens {
            let _ = sqlx::query("DELETE FROM sessions WHERE token = ?")
                .bind(tok)
                .execute(&mut *tx)
                .await;
        }
        for tok in &expired_admin_tokens {
            let _ = sqlx::query("DELETE FROM admin_sessions WHERE token = ?")
                .bind(tok)
                .execute(&mut *tx)
                .await;
        }
        if tx.commit().await.is_ok() {
            return expired_user_tokens;
        }
    }
    Vec::new()
}

/// 1ユーザーあたりの同時有効セッション数上限を超過した古いセッションを削除し、削除済みトークン一覧を返す
pub async fn enforce_user_session_limit(
    pool: &SqlitePool,
    user_id: i64,
    max_sessions: i64,
) -> Vec<String> {
    if max_sessions <= 0 {
        return Vec::new();
    }
    let old_tokens: Vec<String> = sqlx::query_scalar(
        "SELECT token FROM sessions WHERE user_id = ? ORDER BY rowid DESC LIMIT -1 OFFSET ?",
    )
    .bind(user_id)
    .bind(max_sessions)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    if old_tokens.is_empty() {
        return Vec::new();
    }
    if let Ok(mut tx) = begin_immediate(pool).await {
        for tok in &old_tokens {
            let _ = sqlx::query("DELETE FROM sessions WHERE token = ?")
                .bind(tok)
                .execute(&mut *tx)
                .await;
        }
        if tx.commit().await.is_ok() {
            return old_tokens;
        }
    }
    Vec::new()
}

/// 管理者IDあたりの同時有効セッション数上限を超過した古いセッションを削除し、削除済みトークン一覧を返す
pub async fn enforce_admin_session_limit(
    pool: &SqlitePool,
    admin_id: &str,
    max_sessions: i64,
) -> Vec<String> {
    if max_sessions <= 0 {
        return Vec::new();
    }
    let old_tokens: Vec<String> = sqlx::query_scalar(
        "SELECT token FROM admin_sessions WHERE admin_id = ? ORDER BY rowid DESC LIMIT -1 OFFSET ?",
    )
    .bind(admin_id)
    .bind(max_sessions)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    if old_tokens.is_empty() {
        return Vec::new();
    }
    if let Ok(mut tx) = begin_immediate(pool).await {
        for tok in &old_tokens {
            let _ = sqlx::query("DELETE FROM admin_sessions WHERE token = ?")
                .bind(tok)
                .execute(&mut *tx)
                .await;
        }
        if tx.commit().await.is_ok() {
            return old_tokens;
        }
    }
    Vec::new()
}

/// 現シーズンの行動ログ上限超過分と、一定世代より古い旧シーズンデータをクリーンアップする
pub async fn cleanup_old_data(pool: &SqlitePool, current_season_id: i64) {
    const MAX_TERRITORY_LOGS_PER_SEASON: i64 = 15_000;
    const MAX_OTHER_LOGS_PER_SEASON: i64 = 10_000;
    const KEEP_RECENT_SEASONS: i64 = 4;

    if let Ok(mut tx) = begin_immediate(pool).await {
        // 塗りログは件数が多くなりやすいため別枠で上限管理し、外交・勢力・システムログが押し出されないように保護する
        let _ = sqlx::query(
            r#"
            DELETE FROM player_logs
            WHERE season_id = ?
              AND category = 'territory'
              AND id NOT IN (
                SELECT id FROM player_logs
                WHERE season_id = ? AND category = 'territory'
                ORDER BY id DESC LIMIT ?
              )
            "#,
        )
        .bind(current_season_id)
        .bind(current_season_id)
        .bind(MAX_TERRITORY_LOGS_PER_SEASON)
        .execute(&mut *tx)
        .await;

        let _ = sqlx::query(
            r#"
            DELETE FROM player_logs
            WHERE season_id = ?
              AND category != 'territory'
              AND id NOT IN (
                SELECT id FROM player_logs
                WHERE season_id = ? AND category != 'territory'
                ORDER BY id DESC LIMIT ?
              )
            "#,
        )
        .bind(current_season_id)
        .bind(current_season_id)
        .bind(MAX_OTHER_LOGS_PER_SEASON)
        .execute(&mut *tx)
        .await;

        if current_season_id > KEEP_RECENT_SEASONS + 1 {
            let cutoff_season = current_season_id - KEEP_RECENT_SEASONS;
            for sql in [
                "DELETE FROM player_logs WHERE season_id < ?",
                "DELETE FROM timelapse_frames WHERE season_id < ?",
                "DELETE FROM chunks WHERE season_id < ?",
                "DELETE FROM diplomacy_wars WHERE season_id < ?",
                "DELETE FROM ceasefire_proposals WHERE season_id < ?",
                "DELETE FROM season_map_meta WHERE season_id < ?",
                "DELETE FROM faction_members WHERE faction_id IN (SELECT id FROM factions WHERE season_id < ?)",
                "DELETE FROM faction_join_requests WHERE faction_id IN (SELECT id FROM factions WHERE season_id < ?)",
                "DELETE FROM factions WHERE season_id < ?",
                "DELETE FROM seasons WHERE season_id < ?",
            ] {
                let _ = sqlx::query(sql).bind(cutoff_season).execute(&mut *tx).await;
            }
        }
        let _ = tx.commit().await;
    }
}

/// シーズンのマップメタデータを保存する
#[allow(dead_code)]
pub async fn save_map_meta(
    pool: &SqlitePool,
    season_id: i64,
    params: &MapGenParams,
) -> Result<(), sqlx::Error> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        INSERT INTO season_map_meta
        (season_id, board_size, continent_count, island_count, land_ratio_pct, seed, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(season_id) DO UPDATE SET
            board_size = excluded.board_size,
            continent_count = excluded.continent_count,
            island_count = excluded.island_count,
            land_ratio_pct = excluded.land_ratio_pct,
            seed = excluded.seed,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(season_id)
    .bind(params.size as i64)
    .bind(params.continent_count as i64)
    .bind(params.island_count as i64)
    .bind(params.land_ratio_pct as i64)
    .bind(params.seed as i64)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}

/// 指定シーズンの盤面と設定を SQLite から読み込む。存在しない・旧形式ならデフォルト設定で新規生成する。
pub async fn load_or_init_board(
    pool: &SqlitePool,
    season_id: i64,
    seed_override: Option<u64>,
) -> Result<(Board, MapGenParams), String> {
    let meta_row = sqlx::query(
        "SELECT board_size, continent_count, island_count, land_ratio_pct, seed FROM season_map_meta WHERE season_id = ?",
    )
    .bind(season_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("マップメタ読込失敗: {}", e))?;

    if let Some(meta) = meta_row {
        let params = MapGenParams {
            size: meta.get::<i64, _>("board_size") as usize,
            continent_count: meta.get::<i64, _>("continent_count") as u32,
            island_count: meta.get::<i64, _>("island_count") as u32,
            land_ratio_pct: meta.get::<i64, _>("land_ratio_pct") as u32,
            seed: meta.get::<i64, _>("seed") as u64,
        };
        // DB 内のパラメータが妥当な場合のみチャンク読込・盤面構築を行う（不正サイズでのパニック防止）
        if params.validate().is_ok() {
            let expected_chunks = (params.size / CHUNK_SIZE) * (params.size / CHUNK_SIZE);

            let rows = sqlx::query("SELECT chunk_id, data FROM chunks WHERE season_id = ?")
                .bind(season_id)
                .fetch_all(pool)
                .await
                .map_err(|e| format!("チャンク読込失敗: {}", e))?;

            let expected_chunks_i64 = expected_chunks as i64;
            let mut valid_chunks = rows.len() == expected_chunks;
            if valid_chunks {
                let mut seen_ids = std::collections::HashSet::with_capacity(expected_chunks);
                for r in &rows {
                    let cid: i64 = r.get("chunk_id");
                    let data_len = r.get::<Vec<u8>, _>("data").len();
                    if cid < 0
                        || cid >= expected_chunks_i64
                        || data_len != CHUNK_BYTE_LEN
                        || !seen_ids.insert(cid)
                    {
                        valid_chunks = false;
                        break;
                    }
                }
            }
            if valid_chunks {
                let mut board =
                    Board::from_terrain(params.size, &vec![0u8; params.size * params.size]);
                for row in rows {
                    let chunk_id: i64 = row.get("chunk_id");
                    let data: Vec<u8> = row.get("data");
                    board.load_chunk_bytes(chunk_id as usize, &data)?;
                }
                return Ok((board, params));
            }
        }
    }

    // 新規シーズン初期化（デフォルト 250×250, 大陸1, 島6, 陸地40%, JS安全整数範囲のランダムシード）
    let seed = seed_override.unwrap_or_else(|| rand::thread_rng().gen_range(1..=(1u64 << 50)));
    let params = MapGenParams::default_with_seed(seed);
    let board = init_and_persist_new_board(pool, season_id, &params).await?;
    Ok((board, params))
}

/// 指定パラメータで地形生成・盤面構築をインメモリで実行する（DB ロック外で呼ぶこと）
pub fn build_new_board_in_memory(params: &MapGenParams) -> Result<Board, String> {
    params.validate()?;
    let terrain = generate_terrain(params);
    Ok(Board::from_terrain(params.size, &terrain))
}

/// 生成済み盤面メタデータとチャンク群を既存トランザクション内へ永続化する
pub async fn persist_board_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    season_id: i64,
    params: &MapGenParams,
    board: &Board,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO seasons (season_id, seed, created_at) VALUES (?, ?, ?) ON CONFLICT(season_id) DO UPDATE SET seed = excluded.seed",
    )
    .bind(season_id)
    .bind(params.seed as i64)
    .bind(&now)
    .execute(&mut **tx)
    .await
    .map_err(|e| format!("シーズン登録失敗: {}", e))?;

    // 旧チャンクを削除してから新チャンクを一括保存
    sqlx::query("DELETE FROM chunks WHERE season_id = ?")
        .bind(season_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| format!("旧チャンク削除失敗: {}", e))?;

    sqlx::query(
        r#"
        INSERT INTO season_map_meta
        (season_id, board_size, continent_count, island_count, land_ratio_pct, seed, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(season_id) DO UPDATE SET
            board_size = excluded.board_size,
            continent_count = excluded.continent_count,
            island_count = excluded.island_count,
            land_ratio_pct = excluded.land_ratio_pct,
            seed = excluded.seed,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(season_id)
    .bind(params.size as i64)
    .bind(params.continent_count as i64)
    .bind(params.island_count as i64)
    .bind(params.land_ratio_pct as i64)
    .bind(params.seed as i64)
    .bind(&now)
    .execute(&mut **tx)
    .await
    .map_err(|e| format!("マップメタ保存失敗: {}", e))?;

    // ダーティフラグを回収しつつ全チャンクを順次 DB へ保存する
    let _ = board.take_dirty_chunks();
    for chunk_id in 0..board.total_chunks {
        let blob = board.extract_chunk_bytes(chunk_id);
        sqlx::query(
            r#"
            INSERT INTO chunks (season_id, chunk_id, data, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(season_id, chunk_id) DO UPDATE SET
                data = excluded.data,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(season_id)
        .bind(chunk_id as i64)
        .bind(&blob)
        .bind(&now)
        .execute(&mut **tx)
        .await
        .map_err(|e| format!("初期チャンク保存失敗: {}", e))?;
    }

    Ok(())
}

/// 指定パラメータで盤面を新規生成し、既存トランザクション内でチャンクとメタデータを保存する（テスト互換ラッパー）
#[cfg(test)]
pub async fn init_and_persist_new_board_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    season_id: i64,
    params: &MapGenParams,
) -> Result<Board, String> {
    let params_copy = *params;
    let board = tokio::task::spawn_blocking(move || build_new_board_in_memory(&params_copy))
        .await
        .map_err(|e| format!("盤面生成タスク失敗: {}", e))??;
    persist_board_in_tx(tx, season_id, params, &board).await?;
    Ok(board)
}

/// 指定パラメータで盤面を新規生成し、SQLite のチャンクとメタデータを単一トランザクションで全保存する
pub async fn init_and_persist_new_board(
    pool: &SqlitePool,
    season_id: i64,
    params: &MapGenParams,
) -> Result<Board, String> {
    // 地形生成・盤面構築は CPU 負荷が高いためブロッキングスレッドプールへオフロード
    let params_copy = *params;
    let board = tokio::task::spawn_blocking(move || build_new_board_in_memory(&params_copy))
        .await
        .map_err(|e| format!("盤面生成タスク失敗: {}", e))??;

    let mut tx = begin_immediate(pool)
        .await
        .map_err(|e| format!("トランザクション開始失敗: {}", e))?;

    persist_board_in_tx(&mut tx, season_id, params, &board).await?;

    tx.commit()
        .await
        .map_err(|e| format!("盤面初期化コミット失敗: {}", e))?;

    Ok(board)
}

/// ダーティチャンク群を単一トランザクションで SQLite へバッチ保存する
pub async fn save_chunks_batch(
    pool: &SqlitePool,
    season_id: i64,
    chunks: &[(usize, Vec<u8>)],
) -> Result<(), sqlx::Error> {
    if chunks.is_empty() {
        return Ok(());
    }
    let now = Utc::now().to_rfc3339();
    let mut tx = begin_immediate(pool).await?;
    for (chunk_id, blob) in chunks {
        sqlx::query(
            r#"
            INSERT INTO chunks (season_id, chunk_id, data, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(season_id, chunk_id) DO UPDATE SET
                data = excluded.data,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(season_id)
        .bind(*chunk_id as i64)
        .bind(blob)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 2勢力間の戦争キーを (small, large) に正規化
#[inline]
pub fn war_pair(a: u16, b: u16) -> (i64, i64) {
    if a < b {
        (a as i64, b as i64)
    } else {
        (b as i64, a as i64)
    }
}

/// 行動ログの公開範囲（全体公開）
pub const LOG_VISIBILITY_PUBLIC: i64 = 0;
/// 行動ログの公開範囲（自勢力メンバー限定）
pub const LOG_VISIBILITY_FACTION: i64 = 1;

/// 行動ログを全項目指定で1件記録し、DB エラーを返却する（既存トランザクション内）
#[allow(clippy::too_many_arguments)]
pub async fn record_player_log_tx_full(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    season_id: i64,
    user_id: i64,
    username: &str,
    faction_id: i64,
    target_faction_id: i64,
    category: &str,
    summary: &str,
    visibility: i64,
) -> Result<(), sqlx::Error> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        INSERT INTO player_logs (season_id, user_id, username, faction_id, target_faction_id, category, summary, visibility, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(season_id)
    .bind(user_id)
    .bind(username)
    .bind(faction_id)
    .bind(target_faction_id)
    .bind(category)
    .bind(summary)
    .bind(visibility)
    .bind(&now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// 対象勢力IDを指定してプレイヤー行動ログを1件記録する（既存トランザクション内・全体公開）
#[allow(clippy::too_many_arguments)]
pub async fn record_player_log_tx_with_target(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    season_id: i64,
    user_id: i64,
    username: &str,
    faction_id: i64,
    target_faction_id: i64,
    category: &str,
    summary: &str,
) {
    let _ = record_player_log_tx_full(
        tx,
        season_id,
        user_id,
        username,
        faction_id,
        target_faction_id,
        category,
        summary,
        LOG_VISIBILITY_PUBLIC,
    )
    .await;
}

/// 公開範囲を指定してプレイヤー行動ログを1件記録する（既存トランザクション内）
#[allow(clippy::too_many_arguments)]
pub async fn record_player_log_tx_with_visibility(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    season_id: i64,
    user_id: i64,
    username: &str,
    faction_id: i64,
    category: &str,
    summary: &str,
    visibility: i64,
) {
    let _ = record_player_log_tx_full(
        tx,
        season_id,
        user_id,
        username,
        faction_id,
        0,
        category,
        summary,
        visibility,
    )
    .await;
}

/// プレイヤー行動ログを1件記録する（既存トランザクション内）
#[allow(dead_code)]
pub async fn record_player_log_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    season_id: i64,
    user_id: i64,
    username: &str,
    faction_id: i64,
    category: &str,
    summary: &str,
) {
    record_player_log_tx_with_visibility(
        tx,
        season_id,
        user_id,
        username,
        faction_id,
        category,
        summary,
        LOG_VISIBILITY_PUBLIC,
    )
    .await;
}

/// 対象勢力IDを指定してプレイヤー行動ログを1件記録する（全体公開）
#[allow(dead_code)]
#[allow(clippy::too_many_arguments)]
pub async fn record_player_log_with_target(
    pool: &SqlitePool,
    season_id: i64,
    user_id: i64,
    username: &str,
    faction_id: i64,
    target_faction_id: i64,
    category: &str,
    summary: &str,
) {
    let now = Utc::now().to_rfc3339();
    let _ = sqlx::query(
        r#"
        INSERT INTO player_logs (season_id, user_id, username, faction_id, target_faction_id, category, summary, visibility, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(season_id)
    .bind(user_id)
    .bind(username)
    .bind(faction_id)
    .bind(target_faction_id)
    .bind(category)
    .bind(summary)
    .bind(LOG_VISIBILITY_PUBLIC)
    .bind(&now)
    .execute(pool)
    .await;
}

/// 公開範囲を指定してプレイヤー行動ログを1件記録する
#[allow(clippy::too_many_arguments)]
pub async fn record_player_log_with_visibility(
    pool: &SqlitePool,
    season_id: i64,
    user_id: i64,
    username: &str,
    faction_id: i64,
    category: &str,
    summary: &str,
    visibility: i64,
) {
    let now = Utc::now().to_rfc3339();
    let _ = sqlx::query(
        r#"
        INSERT INTO player_logs (season_id, user_id, username, faction_id, target_faction_id, category, summary, visibility, created_at)
        VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
        "#,
    )
    .bind(season_id)
    .bind(user_id)
    .bind(username)
    .bind(faction_id)
    .bind(category)
    .bind(summary)
    .bind(visibility)
    .bind(&now)
    .execute(pool)
    .await;
}

/// プレイヤー行動ログを1件記録する
pub async fn record_player_log(
    pool: &SqlitePool,
    season_id: i64,
    user_id: i64,
    username: &str,
    faction_id: i64,
    category: &str,
    summary: &str,
) {
    record_player_log_with_visibility(
        pool,
        season_id,
        user_id,
        username,
        faction_id,
        category,
        summary,
        LOG_VISIBILITY_PUBLIC,
    )
    .await;
}

/// AP設定を SQLite の game_settings から厳格に読み込む（未設定時のみデフォルト値）
pub async fn load_ap_config(pool: &SqlitePool) -> Result<crate::state::ApConfig, String> {
    let Some(raw) = load_setting_strict(pool, "ap_config")
        .await
        .map_err(|e| format!("AP設定の読み込みに失敗しました: {}", e))?
    else {
        return Ok(crate::state::ApConfig::default());
    };
    let cfg = serde_json::from_str::<crate::state::ApConfig>(&raw)
        .map_err(|e| format!("AP設定のJSON形式が不正です: {}", e))?;
    cfg.validate()
        .map_err(|e| format!("AP設定の値が不正です: {}", e))?;
    Ok(cfg)
}

/// コスト設定を SQLite の game_settings から厳格に読み込む（未設定時のみデフォルト値）
pub async fn load_cost_config(pool: &SqlitePool) -> Result<crate::board::CostConfig, String> {
    let Some(raw) = load_setting_strict(pool, "cost_config")
        .await
        .map_err(|e| format!("コスト設定の読み込みに失敗しました: {}", e))?
    else {
        return Ok(crate::board::CostConfig::default());
    };
    let cfg = serde_json::from_str::<crate::board::CostConfig>(&raw)
        .map_err(|e| format!("コスト設定のJSON形式が不正です: {}", e))?;
    cfg.validate()
        .map_err(|e| format!("コスト設定の値が不正です: {}", e))?;
    Ok(cfg)
}

/// コスト設定を SQLite の game_settings へ保存する
pub async fn save_cost_config(
    pool: &SqlitePool,
    cfg: &crate::board::CostConfig,
) -> Result<(), String> {
    let json = serde_json::to_string(cfg).map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        INSERT INTO game_settings (key, value, updated_at)
        VALUES ('cost_config', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        "#,
    )
    .bind(&json)
    .bind(&now)
    .execute(pool)
    .await
    .map_err(|e| format!("コスト設定の保存に失敗しました: {}", e))?;
    Ok(())
}

/// ゲームルール設定を SQLite の game_settings から厳格に読み込む（未設定時のみデフォルト値）
pub async fn load_game_rules(pool: &SqlitePool) -> Result<crate::board::GameRulesConfig, String> {
    let Some(raw) = load_setting_strict(pool, "game_rules")
        .await
        .map_err(|e| format!("ゲームルール設定の読み込みに失敗しました: {}", e))?
    else {
        return Ok(crate::board::GameRulesConfig::default());
    };
    let cfg = serde_json::from_str::<crate::board::GameRulesConfig>(&raw)
        .map_err(|e| format!("ゲームルール設定のJSON形式が不正です: {}", e))?;
    cfg.validate()
        .map_err(|e| format!("ゲームルール設定の値が不正です: {}", e))?;
    Ok(cfg)
}

/// フェーズ強制上書き設定を SQLite の game_settings から読み込む
#[allow(dead_code)]
pub async fn load_phase_override(pool: &SqlitePool) -> Option<crate::season::SeasonPhase> {
    let row = sqlx::query("SELECT value FROM game_settings WHERE key = 'phase_override'")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()?;
    let raw: String = row.get("value");
    crate::season::SeasonPhase::from_str_name(raw.trim())
}

/// 書き込み競合（SQLITE_BUSY）を防ぐため BEGIN IMMEDIATE でトランザクションを開始する
pub async fn begin_immediate(
    pool: &SqlitePool,
) -> Result<sqlx::Transaction<'_, sqlx::Sqlite>, sqlx::Error> {
    pool.begin_with("BEGIN IMMEDIATE").await
}

/// 汎用設定値を SQLite の game_settings から読み込む（DBエラーを握りつぶさず呼び出し元へ返す）
pub async fn load_setting_strict(
    pool: &SqlitePool,
    key: &str,
) -> Result<Option<String>, sqlx::Error> {
    let row = sqlx::query("SELECT value FROM game_settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.get("value")))
}

/// 汎用設定値を SQLite の game_settings から読み込む（テスト互換用）
#[cfg(test)]
pub async fn load_setting(pool: &SqlitePool, key: &str) -> Option<String> {
    let row = sqlx::query("SELECT value FROM game_settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()?;
    Some(row.get("value"))
}

/// 汎用設定値を SQLite の game_settings へ保存する
pub async fn save_setting(
    pool: &SqlitePool,
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
    .execute(pool)
    .await?;
    Ok(())
}

/// 勢力名の最大文字数を SQLite の game_settings から厳格に読み込む（未設定時のみデフォルト値）
pub async fn load_faction_name_max_len(pool: &SqlitePool) -> Result<usize, String> {
    let Some(raw) = load_setting_strict(pool, "faction_name_max_len")
        .await
        .map_err(|e| format!("勢力名長さ制限の読み込みに失敗しました: {}", e))?
    else {
        return Ok(crate::state::DEFAULT_FACTION_NAME_MAX_LEN);
    };
    let len = raw
        .trim()
        .parse::<usize>()
        .map_err(|e| format!("勢力名長さ制限の値が不正です ({:?}): {}", raw, e))?;
    if !(2..=40).contains(&len) {
        return Err(format!(
            "勢力名長さ制限が許容範囲 (2〜40) 外です: {}",
            len
        ));
    }
    Ok(len)
}

/// 勢力名の最大文字数を SQLite の game_settings へ保存する
pub async fn save_faction_name_max_len(pool: &SqlitePool, max_len: usize) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        INSERT INTO game_settings (key, value, updated_at)
        VALUES ('faction_name_max_len', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        "#,
    )
    .bind(max_len.to_string())
    .bind(&now)
    .execute(pool)
    .await
    .map_err(|e| format!("勢力名長さ制限の保存に失敗しました: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sqlite_chunk_persistence_roundtrip() {
        let pool = init_memory_db().await.unwrap();
        let (mut board, params) = load_or_init_board(&pool, 1, Some(999)).await.unwrap();
        assert_eq!(board.size, 250);
        assert_eq!(params.size, 250);

        // 1セル変更してダーティチャンク保存
        let idx = board.idx(120, 210);
        board.cells[idx].terrain = 1;
        board.cells[idx].faction_id = 7;
        board.cells[idx].color_id = 15;
        board.cells[idx].layers = 4;
        board.cells[idx].set_core(true);
        board.mark_chunk_dirty(120, 210);

        let dirty = board.take_dirty_chunks();
        assert_eq!(dirty.len(), 1);
        let payloads: Vec<_> = dirty
            .into_iter()
            .map(|cid| (cid, board.extract_chunk_bytes(cid)))
            .collect();
        save_chunks_batch(&pool, 1, &payloads).await.unwrap();

        // 再ロードして完全一致を検証
        let (reloaded, reloaded_params) = load_or_init_board(&pool, 1, Some(999)).await.unwrap();
        assert_eq!(reloaded_params, params);
        assert_eq!(reloaded.cells[idx], board.cells[idx]);
    }

    #[tokio::test]
    async fn cleanup_expired_sessions_handles_mixed_rfc3339_and_unix_formats() {
        let pool = init_memory_db().await.unwrap();
        let now_dt = Utc::now();
        let now_str = now_dt.to_rfc3339();

        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'u1', 'h', 30, 0, ?)")
            .bind(&now_str)
            .execute(&pool)
            .await
            .unwrap();

        // 小数秒なし RFC3339 の期限切れ、数値 UNIX 秒の期限切れ、有効なセッションを混在挿入
        let exp_rfc_no_frac = (now_dt - chrono::Duration::seconds(30))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let exp_unix = (now_dt.timestamp() - 60).to_string();
        let valid_rfc = (now_dt + chrono::Duration::hours(1)).to_rfc3339();

        for (tok, exp) in [
            ("tok_exp_rfc", &exp_rfc_no_frac),
            ("tok_exp_unix", &exp_unix),
            ("tok_valid", &valid_rfc),
        ] {
            sqlx::query("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, 1, ?, ?)")
                .bind(tok)
                .bind(exp)
                .bind(&now_str)
                .execute(&pool)
                .await
                .unwrap();
        }

        sqlx::query("INSERT INTO admin_sessions (token, admin_id, expires_at, created_at) VALUES ('adm_exp', 'admin', ?, ?)")
            .bind(&exp_rfc_no_frac)
            .bind(&now_str)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO admin_sessions (token, admin_id, expires_at, created_at) VALUES ('adm_valid', 'admin', ?, ?)")
            .bind(&valid_rfc)
            .bind(&now_str)
            .execute(&pool)
            .await
            .unwrap();

        cleanup_expired_sessions(&pool).await;

        let remaining_users: Vec<String> =
            sqlx::query_scalar("SELECT token FROM sessions ORDER BY token ASC")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(remaining_users, vec!["tok_valid".to_string()]);

        let remaining_admins: Vec<String> =
            sqlx::query_scalar("SELECT token FROM admin_sessions ORDER BY token ASC")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(remaining_admins, vec!["adm_valid".to_string()]);
    }

    #[tokio::test]
    async fn cleanup_expired_sessions_handles_null_and_integer_expires_at() {
        let pool = init_memory_db().await.unwrap();
        let now_dt = Utc::now();
        let now_str = now_dt.to_rfc3339();
        let exp_int = now_dt.timestamp() - 60;
        let valid_int = now_dt.timestamp() + 3600;

        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'u1', 'h', 30, 0, ?)")
            .bind(&now_str)
            .execute(&pool)
            .await
            .unwrap();

        // NULL、INTEGER 期限切れ、INTEGER 有効、不正文字列を混在挿入
        sqlx::query("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES ('tok_null', 1, NULL, ?)")
            .bind(&now_str)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES ('tok_int_exp', 1, ?, ?)")
            .bind(exp_int)
            .bind(&now_str)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES ('tok_int_valid', 1, ?, ?)")
            .bind(valid_int)
            .bind(&now_str)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES ('tok_bad', 1, 'not-a-date', ?)")
            .bind(&now_str)
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query("INSERT INTO admin_sessions (token, admin_id, expires_at, created_at) VALUES ('adm_null', 'admin', NULL, ?)")
            .bind(&now_str)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO admin_sessions (token, admin_id, expires_at, created_at) VALUES ('adm_int_valid', 'admin', ?, ?)")
            .bind(valid_int)
            .bind(&now_str)
            .execute(&pool)
            .await
            .unwrap();

        cleanup_expired_sessions(&pool).await;

        let remaining_users: Vec<String> =
            sqlx::query_scalar("SELECT token FROM sessions ORDER BY token ASC")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(remaining_users, vec!["tok_int_valid".to_string()]);

        let remaining_admins: Vec<String> =
            sqlx::query_scalar("SELECT token FROM admin_sessions ORDER BY token ASC")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(remaining_admins, vec!["adm_int_valid".to_string()]);
    }

    #[tokio::test]
    async fn init_and_persist_new_board_in_tx_persists_within_caller_tx() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(42);
        let mut tx = begin_immediate(&pool).await.unwrap();
        let board = init_and_persist_new_board_in_tx(&mut tx, 7, &params)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let (reloaded, reloaded_params) = load_or_init_board(&pool, 7, None).await.unwrap();
        assert_eq!(reloaded_params, params);
        assert_eq!(reloaded.size, board.size);
        assert_eq!(reloaded.cells, board.cells);
    }

    #[tokio::test]
    async fn build_new_board_in_memory_and_persist_board_in_tx_roundtrip() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(12345);
        let board = build_new_board_in_memory(&params).unwrap();

        let mut tx = begin_immediate(&pool).await.unwrap();
        persist_board_in_tx(&mut tx, 8, &params, &board)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let (reloaded, reloaded_params) = load_or_init_board(&pool, 8, None).await.unwrap();
        assert_eq!(reloaded_params, params);
        assert_eq!(reloaded.size, board.size);
        assert_eq!(reloaded.cells, board.cells);
    }

    #[tokio::test]
    async fn enforce_user_session_limit_and_cleanup_old_data_work() {
        let pool = init_memory_db().await.unwrap();
        let now = Utc::now().to_rfc3339();
        let valid_exp = (Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'u_lim', 'h', 30, 0, ?)")
            .bind(&now)
            .execute(&pool)
            .await
            .unwrap();

        for i in 1..=5 {
            sqlx::query("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, 1, ?, ?)")
                .bind(format!("tok_{}", i))
                .bind(&valid_exp)
                .bind(&now)
                .execute(&pool)
                .await
                .unwrap();
        }
        let mut evicted = enforce_user_session_limit(&pool, 1, 3).await;
        evicted.sort();
        assert_eq!(evicted, vec!["tok_1".to_string(), "tok_2".to_string()]);
        let remaining: Vec<String> =
            sqlx::query_scalar("SELECT token FROM sessions ORDER BY rowid ASC")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            remaining,
            vec!["tok_3".to_string(), "tok_4".to_string(), "tok_5".to_string()]
        );

        // 旧シーズンデータ削除テスト
        sqlx::query("INSERT INTO seasons (season_id, seed, created_at) VALUES (1, 10, ?), (10, 20, ?)")
            .bind(&now)
            .bind(&now)
            .execute(&pool)
            .await
            .unwrap();
        cleanup_old_data(&pool, 10).await;
        let seasons_left: Vec<i64> =
            sqlx::query_scalar("SELECT season_id FROM seasons ORDER BY season_id ASC")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(seasons_left, vec![10]);
    }

    #[tokio::test]
    async fn strict_config_loaders_reject_corrupt_values_and_db_errors() {
        let pool = init_memory_db().await.unwrap();

        // 未設定時はデフォルト値
        assert_eq!(load_ap_config(&pool).await.unwrap(), crate::state::ApConfig::default());
        assert_eq!(load_cost_config(&pool).await.unwrap(), crate::board::CostConfig::default());
        assert_eq!(load_game_rules(&pool).await.unwrap(), crate::board::GameRulesConfig::default());
        assert_eq!(
            load_faction_name_max_len(&pool).await.unwrap(),
            crate::state::DEFAULT_FACTION_NAME_MAX_LEN
        );

        // 不正 JSON・範囲外値は Err
        save_setting(&pool, "ap_config", "{bad json").await.unwrap();
        assert!(load_ap_config(&pool).await.is_err());

        save_setting(&pool, "cost_config", r#"{"claim_cost":0}"#).await.unwrap();
        assert!(load_cost_config(&pool).await.is_err());

        save_setting(&pool, "game_rules", "{}").await.unwrap();
        assert!(load_game_rules(&pool).await.is_err());

        save_setting(&pool, "faction_name_max_len", "999").await.unwrap();
        assert!(load_faction_name_max_len(&pool).await.is_err());

        // クローズ済みプールは Err
        pool.close().await;
        assert!(load_ap_config(&pool).await.is_err());
        assert!(load_cost_config(&pool).await.is_err());
        assert!(load_game_rules(&pool).await.is_err());
        assert!(load_faction_name_max_len(&pool).await.is_err());
    }

    #[tokio::test]
    async fn cleanup_expired_sessions_returns_only_expired_user_tokens() {
        let pool = init_memory_db().await.unwrap();
        let now_dt = Utc::now();
        let now_str = now_dt.to_rfc3339();
        let expired_str = (now_dt - chrono::Duration::seconds(120)).to_rfc3339();
        let valid_str = (now_dt + chrono::Duration::hours(2)).to_rfc3339();

        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'u_ret', 'h', 30, 0, ?)")
            .bind(&now_str)
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES ('u_exp_1', 1, ?, ?), ('u_valid_1', 1, ?, ?)")
            .bind(&expired_str)
            .bind(&now_str)
            .bind(&valid_str)
            .bind(&now_str)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO admin_sessions (token, admin_id, expires_at, created_at) VALUES ('adm_exp_1', 'admin', ?, ?)")
            .bind(&expired_str)
            .bind(&now_str)
            .execute(&pool)
            .await
            .unwrap();

        let mut removed_user_tokens = cleanup_expired_sessions(&pool).await;
        removed_user_tokens.sort();
        assert_eq!(removed_user_tokens, vec!["u_exp_1".to_string()]);
    }

    #[tokio::test]
    async fn cleanup_old_data_protects_non_territory_logs_from_territory_flood() {
        let pool = init_memory_db().await.unwrap();
        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO seasons (season_id, seed, created_at) VALUES (1, 10, ?)")
            .bind(&now)
            .execute(&pool)
            .await
            .unwrap();

        // 重要な外交・システムログを先に挿入
        record_player_log(&pool, 1, 1, "u1", 1, "diplomacy", "勢力「B」へ宣戦布告した").await;
        record_player_log(&pool, 1, 0, "システム", 0, "system", "Tick #1 が完了した").await;

        // 大量（15,050件）の territory ログを後から挿入
        let mut tx = begin_immediate(&pool).await.unwrap();
        for i in 0..15_050 {
            record_player_log_tx(
                &mut tx,
                1,
                1,
                "u1",
                1,
                "territory",
                &format!("({}, 0) の空き地を塗った (-1 AP)", i % 250),
            )
            .await;
        }
        tx.commit().await.unwrap();

        cleanup_old_data(&pool, 1).await;

        let terr_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM player_logs WHERE season_id = 1 AND category = 'territory'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(terr_count, 15_000);

        let dip_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM player_logs WHERE season_id = 1 AND category = 'diplomacy'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let sys_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM player_logs WHERE season_id = 1 AND category = 'system'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(dip_count, 1, "塗りログが大量でも外交ログは保護されるべきです");
        assert_eq!(sys_count, 1, "塗りログが大量でもシステムログは保護されるべきです");
    }
}
