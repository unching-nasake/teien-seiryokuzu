mod api;
mod auth;
mod board;
mod config;
mod db;
mod map_gen;
mod palette;
mod protocol;
mod season;
mod state;
mod tick;
mod ws;

use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, header::HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{from_fn, from_fn_with_state, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, patch, post};
use axum::{Json, Router};
use chrono::{Timelike, Utc};
use config::Config;
use season::{compute_cycle_id, SeasonPhase, SeasonSchedule};
use state::AppState;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tower_http::compression::CompressionLayer;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tracing::{error, info, warn};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,sqlx=warn".into()),
        )
        .init();

    let config = Config::from_env();
    if let Err(msg) = config.validate_static_dir_safety() {
        error!("{}", msg);
        std::process::exit(1);
    }
    info!(
        "庭園勢力図サーバー起動中... bind={}, db={}, dev_mode={}",
        config.bind_addr,
        config.db_path.display(),
        config.dev_mode
    );
    if config.dev_mode {
        warn!("SEIRYOKUZU_DEVMODE が有効です。開発用エンドポイントが公開されています（本番環境では無効化してください）");
    }

    // 二重起動時に DB やバックグラウンドタスクへ触れる前にポートを確保する
    let listener = tokio::net::TcpListener::bind(&config.bind_addr)
        .await
        .expect("ポートのバインドに失敗しました");

    let pool = db::init_db(&config.db_path)
        .await
        .expect("SQLite データベース初期化に失敗しました");

    // 盤面初期化・DB書き込み前にシステム時刻の巻き戻りチェックと手動フェーズ延長状態・全設定の検証を実施する（DBエラー・形式破損時は起動中断）
    let recorded_season_id = match db::load_setting_strict(&pool, "last_active_season_id").await {
        Ok(Some(v)) => match parse_positive_i64(&v) {
            Some(id) => Some(id),
            None => {
                error!("last_active_season_id の値が不正です ({:?})", v);
                std::process::exit(1);
            }
        },
        Ok(None) => None,
        Err(e) => {
            error!("last_active_season_id の読み込みに失敗しました: {}", e);
            std::process::exit(1);
        }
    };
    let recorded_cycle_id_opt = match db::load_setting_strict(&pool, "last_active_cycle_id").await {
        Ok(Some(v)) => match parse_positive_i64(&v) {
            Some(id) => Some(id),
            None => {
                error!("last_active_cycle_id の値が不正です ({:?})", v);
                std::process::exit(1);
            }
        },
        Ok(None) => None,
        Err(e) => {
            error!("last_active_cycle_id の読み込みに失敗しました: {}", e);
            std::process::exit(1);
        }
    };
    let phase_override = match db::load_setting_strict(&pool, "phase_override").await {
        Ok(Some(v)) => match SeasonPhase::from_str_name(v.trim()) {
            Some(p) => Some(p),
            None => {
                error!("phase_override の値が不正です: {:?}", v);
                std::process::exit(1);
            }
        },
        Ok(None) => None,
        Err(e) => {
            error!("phase_override の読み込みに失敗しました: {}", e);
            std::process::exit(1);
        }
    };
    let auto_frozen_season_id = match db::load_setting_strict(&pool, "auto_frozen_season_id").await {
        Ok(Some(v)) => match parse_non_negative_i64(&v) {
            Some(id) => Some(id),
            None => {
                error!("auto_frozen_season_id の値が不正です ({:?})", v);
                std::process::exit(1);
            }
        },
        Ok(None) => None,
        Err(e) => {
            error!("auto_frozen_season_id の読み込みに失敗しました: {}", e);
            std::process::exit(1);
        }
    };

    let ap_config = match db::load_ap_config(&pool).await {
        Ok(cfg) => cfg,
        Err(e) => {
            error!("{}", e);
            std::process::exit(1);
        }
    };
    let cost_config = match db::load_cost_config(&pool).await {
        Ok(cfg) => cfg,
        Err(e) => {
            error!("{}", e);
            std::process::exit(1);
        }
    };
    let game_rules = match db::load_game_rules(&pool).await {
        Ok(cfg) => cfg,
        Err(e) => {
            error!("{}", e);
            std::process::exit(1);
        }
    };

    let schedule = SeasonSchedule::from_rules(game_rules);
    let wall_cycle_id = compute_cycle_id(Utc::now(), schedule);
    let startup_season = match resolve_startup_season(
        recorded_season_id,
        recorded_cycle_id_opt,
        wall_cycle_id,
        phase_override,
        auto_frozen_season_id,
    ) {
        Ok(res) => res,
        Err(msg) => {
            error!("{}", msg);
            std::process::exit(1);
        }
    };
    let season_id = startup_season.season_id;
    let season_cycle_id = startup_season.season_cycle_id;
    let is_resumed_existing_season = startup_season.is_resumed_existing_season;
    if startup_season.rollover_deferred {
        info!(
            "手動フェーズ固定中のためシーズン切替を保留し、継続シーズン ({}) で起動します (壁時計サイクル: {})",
            season_id, wall_cycle_id
        );
    }
    let manual_tick_offset = match db::load_setting_strict(&pool, "manual_tick_offset").await {
        Ok(Some(v)) => match v.trim().parse::<u16>() {
            Ok(offset) => Some(offset),
            Err(e) => {
                error!("manual_tick_offset の値が不正です ({:?}): {}", v, e);
                std::process::exit(1);
            }
        },
        Ok(None) => None,
        Err(e) => {
            error!("manual_tick_offset の読み込みに失敗しました: {}", e);
            std::process::exit(1);
        }
    };
    let faction_name_max_len = match db::load_faction_name_max_len(&pool).await {
        Ok(len) => len,
        Err(e) => {
            error!("{}", e);
            std::process::exit(1);
        }
    };
    let init_last_tick_hour = match db::load_setting_strict(&pool, "last_tick_hour").await {
        Ok(Some(v)) => match parse_hour_key(&v) {
            Some(hk) => Some(hk),
            None => {
                error!("last_tick_hour の値が不正です ({:?})", v);
                std::process::exit(1);
            }
        },
        Ok(None) => None,
        Err(e) => {
            error!("last_tick_hour の読み込みに失敗しました: {}", e);
            std::process::exit(1);
        }
    };
    let init_last_refill_minute = match db::load_setting_strict(&pool, "last_refill_minute").await {
        Ok(Some(v)) => match parse_minute_key(&v) {
            Some(mk) => Some(mk),
            None => {
                error!("last_refill_minute の値が不正です ({:?})", v);
                std::process::exit(1);
            }
        },
        Ok(None) => None,
        Err(e) => {
            error!("last_refill_minute の読み込みに失敗しました: {}", e);
            std::process::exit(1);
        }
    };
    let init_last_tick_minute = match db::load_setting_strict(&pool, "last_tick_minute").await {
        Ok(Some(v)) => match parse_minute_key(&v) {
            Some(mk) => Some(mk),
            None => {
                error!("last_tick_minute の値が不正です ({:?})", v);
                std::process::exit(1);
            }
        },
        Ok(None) => None,
        Err(e) => {
            error!("last_tick_minute の読み込みに失敗しました: {}", e);
            std::process::exit(1);
        }
    };

    let (board, map_params) = db::load_or_init_board(&pool, season_id, config.map_seed)
        .await
        .expect("盤面の読み込みまたは初期化に失敗しました");

    // Config をムーブし、AppState::new 内で管理者パスワードをハッシュ化後に平文を即座に消去する
    let state = Arc::new(AppState::new(config, pool, board, map_params, season_id));
    if state.admin_password_hash.is_none() {
        warn!("SEIRYOKUZU_ADMIN_PASS が未設定のため、管理者ログインは無効化されています");
    }
    *state.ap_config.write() = ap_config;
    *state.cost_config.write() = cost_config;
    *state.game_rules.write() = game_rules;
    state
        .season_cycle_id
        .store(season_cycle_id, Ordering::Release);
    *state.phase_override.write() = phase_override;
    if let Some(v) = auto_frozen_season_id {
        state.auto_frozen_season_id.store(v, Ordering::Release);
    }
    if let Some(offset) = manual_tick_offset {
        *state.manual_tick_offset.write() = offset;
    }
    state
        .faction_name_max_len
        .store(faction_name_max_len, Ordering::Release);

    // サーバー停止中にシーズン切替を跨いだ場合の全ユーザー所属・APリセット（単一トランザクションで原子的に実行）
    match recorded_season_id {
        Some(prev_sid) if prev_sid < season_id => {
            let user_ids: Vec<i64> = match sqlx::query_scalar("SELECT id FROM users")
                .fetch_all(&state.pool)
                .await
            {
                Ok(ids) => ids,
                Err(e) => {
                    error!("起動時シーズン切替ユーザー取得エラー: {}", e);
                    std::process::exit(1);
                }
            };
            let user_initial_aps: Vec<(i64, i64)> = user_ids
                .into_iter()
                .map(|uid| (uid, ap_config.roll_initial_ap()))
                .collect();
            let user_reset_count = user_initial_aps.len();

            let mut tx = match db::begin_immediate(&state.pool).await {
                Ok(tx) => tx,
                Err(e) => {
                    error!("起動時シーズン切替トランザクション開始エラー: {}", e);
                    std::process::exit(1);
                }
            };
            for (uid, init_ap) in user_initial_aps {
                if let Err(e) = sqlx::query("UPDATE users SET ap = ?, faction_id = 0 WHERE id = ?")
                    .bind(init_ap)
                    .bind(uid)
                    .execute(&mut *tx)
                    .await
                {
                    error!("起動時シーズン切替ユーザーリセットエラー: {}", e);
                    std::process::exit(1);
                }
            }
            let now_rfc3339 = Utc::now().to_rfc3339();
            let season_id_str = season_id.to_string();
            let cycle_id_str = season_cycle_id.to_string();
            for (key, val) in [
                ("last_active_season_id", season_id_str.as_str()),
                ("last_active_cycle_id", cycle_id_str.as_str()),
                ("manual_tick_offset", "0"),
                ("auto_frozen_season_id", "0"),
            ] {
                if let Err(e) = sqlx::query(
                    r#"
                    INSERT INTO game_settings (key, value, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                    "#,
                )
                .bind(key)
                .bind(val)
                .bind(&now_rfc3339)
                .execute(&mut *tx)
                .await
                {
                    error!("起動時シーズン切替設定({})保存エラー: {}", key, e);
                    std::process::exit(1);
                }
            }
            if let Err(e) = sqlx::query("DELETE FROM game_settings WHERE key = 'phase_override'")
                .execute(&mut *tx)
                .await
            {
                error!("起動時シーズン切替 phase_override 削除エラー: {}", e);
                std::process::exit(1);
            }
            if let Err(e) = tx.commit().await {
                error!("起動時シーズン切替トランザクションコミットエラー: {}", e);
                std::process::exit(1);
            }

            // DB コミット成功後にメモリ上の状態を同期し、初期タイムラプスフレームを記録する
            *state.manual_tick_offset.write() = 0;
            state.auto_frozen_season_id.store(0, Ordering::Release);
            *state.phase_override.write() = None;
            info!(
                "起動時シーズン切替を完了 ({} -> {}): 全ユーザーの所属・APをリセットしました ({} 件)",
                prev_sid,
                season_id,
                user_reset_count
            );
            if let Err(e) = state.capture_timelapse_frame(0).await {
                warn!("初期タイムラプスフレームの保存に失敗しました: {}", e);
            }
        }
        None => {
            if let Err(e) = db::save_setting(
                &state.pool,
                "last_active_season_id",
                &season_id.to_string(),
            )
            .await
            {
                error!("last_active_season_id の初期保存エラー: {}", e);
                std::process::exit(1);
            }
            if let Err(e) = db::save_setting(
                &state.pool,
                "last_active_cycle_id",
                &season_cycle_id.to_string(),
            )
            .await
            {
                error!("last_active_cycle_id の初期保存エラー: {}", e);
                std::process::exit(1);
            }
            // 初回起動時も 0 ティック目の初期タイムラプスフレームを記録しておく
            if let Err(e) = state.capture_timelapse_frame(0).await {
                warn!("初期タイムラプスフレームの保存に失敗しました: {}", e);
            }
        }
        Some(_) => {
            if recorded_cycle_id_opt.is_none() {
                if let Err(e) = db::save_setting(
                    &state.pool,
                    "last_active_cycle_id",
                    &season_cycle_id.to_string(),
                )
                .await
                {
                    error!("last_active_cycle_id の移行保存エラー: {}", e);
                    std::process::exit(1);
                }
            }
        }
    }

    // サーバー停止中にシーズン切替を跨いだ場合のユーザー所属・AP整合性回復
    let inconsistent_user_ids: Vec<i64> = match sqlx::query_scalar(
        "SELECT id FROM users WHERE faction_id != 0 AND faction_id NOT IN (SELECT id FROM factions WHERE season_id = ?)",
    )
    .bind(season_id)
    .fetch_all(&state.pool)
    .await
    {
        Ok(ids) => ids,
        Err(e) => {
            error!("起動時ユーザー整合性確認エラー: {}", e);
            std::process::exit(1);
        }
    };
    if !inconsistent_user_ids.is_empty() {
        let updates: Vec<(i64, i64)> = inconsistent_user_ids
            .into_iter()
            .map(|uid| (uid, ap_config.roll_initial_ap()))
            .collect();
        let count = updates.len();
        let mut tx = match db::begin_immediate(&state.pool).await {
            Ok(tx) => tx,
            Err(e) => {
                error!("起動時ユーザー整合性回復TX開始エラー: {}", e);
                std::process::exit(1);
            }
        };
        for (uid, init_ap) in updates {
            if let Err(e) = sqlx::query("UPDATE users SET faction_id = 0, ap = ? WHERE id = ?")
                .bind(init_ap)
                .bind(uid)
                .execute(&mut *tx)
                .await
            {
                error!("起動時ユーザー整合性回復エラー: {}", e);
                std::process::exit(1);
            }
        }
        if let Err(e) = tx.commit().await {
            error!("起動時ユーザー整合性回復TXコミットエラー: {}", e);
            std::process::exit(1);
        }
        info!(
            "シーズン切替に伴う不整合ユーザーの所属・APをリセットしました: {} 件",
            count
        );
    }

    // バックグラウンドタスク 1: 5秒ごとにダーティチャンクのみ SQLite へ非同期バッチ保存
    let mut task1_handle = {
        let st = Arc::clone(&state);
        let mut rx = state.subscribe_shutdown();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = interval.tick() => {}
                    res = rx.changed() => {
                        if res.is_err() || *rx.borrow() {
                            break;
                        }
                    }
                }
                if *rx.borrow() {
                    break;
                }
                match st.flush_dirty_chunks().await {
                    Ok(n) if n > 0 => info!("ダーティチャンク保存完了: {} チャンク", n),
                    Err(e) => error!("ダーティチャンク保存エラー: {}", e),
                    _ => {}
                }
            }
        })
    };

    // バックグラウンドタスク 2: 毎時00分00秒ターンティック実行 & シーズン遷移監視
    let mut task2_handle = {
        let st = Arc::clone(&state);
        let mut rx = state.subscribe_shutdown();
        tokio::spawn(async move {
            const MAX_RETRY_PER_CYCLE: u32 = 3;
            let mut last_tick_hour: Option<(i64, u32)> = init_last_tick_hour;
            let mut last_refill_minute: Option<i64> = init_last_refill_minute;
            let mut last_tick_minute: Option<i64> = init_last_tick_minute;
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut boundary_tracker = TickBoundaryTracker::new(is_resumed_existing_season);
            // 新規シーズン起動時・設定変更時・手動Active復帰時は過去スロットへの遡及補完を抑止する
            let mut min_catchup_minute: Option<i64> = if is_resumed_existing_season {
                None
            } else {
                Some(Utc::now().timestamp() / 60)
            };
            let mut prev_schedule_fingerprint: Option<(SeasonSchedule, u32, u32)> = None;
            let mut rollover_backoff: Option<(u32, tokio::time::Instant)> = None;
            let mut tick_backoff: Option<(i64, u32, tokio::time::Instant)> = None;
            let mut refill_backoff: Option<(i64, u32, tokio::time::Instant)> = None;

            loop {
                tokio::select! {
                    _ = interval.tick() => {}
                    res = rx.changed() => {
                        if res.is_err() || *rx.borrow() {
                            break;
                        }
                    }
                }
                if *rx.borrow() {
                    break;
                }

                // 新シーズン遷移チェック（金曜 12:00 JST）を先に実行し、完了後の現在時刻でフェーズ・ティックを評価する
                let rollover_blocked = rollover_backoff
                    .is_some_and(|(_, until)| tokio::time::Instant::now() < until);
                if !rollover_blocked {
                    match st.check_season_rollover().await {
                        Ok(rolled_over) => {
                            rollover_backoff = None;
                            if rolled_over {
                                // シーズン切替直後に旧シーズンの境界・バックオフ・補完対象を持ち越さないよう初期化する
                                boundary_tracker.on_season_rollover();
                                min_catchup_minute = Some(Utc::now().timestamp() / 60);
                                tick_backoff = None;
                                refill_backoff = None;
                            }
                        }
                        Err(e) => {
                            error!("シーズン遷移エラー: {}", e);
                            let fails = rollover_backoff.map_or(1, |(f, _)| f.saturating_add(1));
                            let delay =
                                Duration::from_secs(2u64.saturating_pow(fails.min(5)).min(60));
                            rollover_backoff =
                                Some((fails, tokio::time::Instant::now() + delay));
                        }
                    }
                }
                let now = Utc::now();

                let minute_key = now.timestamp() / 60;

                let ap_cfg = st.current_ap_config();
                let rules_cfg = st.current_game_rules();
                let schedule = SeasonSchedule::from_rules(rules_cfg);
                let tick_interval = rules_cfg.tick_interval_minutes.max(1);
                let cur_fingerprint = (
                    schedule,
                    ap_cfg.refill_interval_minutes,
                    ap_cfg.refill_offset_minute,
                );
                if prev_schedule_fingerprint.is_some_and(|prev| prev != cur_fingerprint) {
                    min_catchup_minute = Some(minute_key);
                }
                prev_schedule_fingerprint = Some(cur_fingerprint);

                // Tick間隔とAP補充がともに毎時00分の場合のみ同一処理に合流させる
                let is_synced_hourly = tick_interval == 60
                    && ap_cfg.refill_interval_minutes == 60
                    && ap_cfg.refill_offset_minute == 0;
                let phase = st.phase_at(now);

                // 自動スケジュール状態かつ自然境界（終了時刻 JST）の Active -> Frozen 遷移のみ境界フラグを保持する
                let is_auto_schedule = st.phase_override.read().is_none()
                    && st.auto_frozen_season_id.load(Ordering::Acquire) != st.current_season_id();
                if phase == SeasonPhase::Active
                    && !is_auto_schedule
                    && boundary_tracker
                        .prev_phase
                        .is_some_and(|p| p != SeasonPhase::Active)
                {
                    min_catchup_minute = Some(minute_key);
                }

                // 毎時00分同期以外のスケジュールによる AP 補充処理（直近10分猶予内の取りこぼし補完対応）
                if !is_synced_hourly && phase == SeasonPhase::Active {
                    if let Some(refill_slot_dt) = season::latest_scheduled_slot_within(
                        now,
                        ap_cfg.refill_interval_minutes,
                        ap_cfg.refill_offset_minute,
                        schedule,
                        season::SCHEDULE_CATCHUP_GRACE_MINUTES,
                    ) {
                        let slot_mk = refill_slot_dt.timestamp() / 60;
                        let slot_allowed = min_catchup_minute.is_none_or(|min_mk| slot_mk >= min_mk)
                            && (!is_auto_schedule
                                || (!season::is_season_start_minute(refill_slot_dt, schedule)
                                    && season::compute_phase_jst_with_schedule(
                                        refill_slot_dt,
                                        schedule,
                                    ) == SeasonPhase::Active));
                        let refill_blocked = match refill_backoff {
                            Some((k, fails, until)) if k == slot_mk => {
                                fails >= MAX_RETRY_PER_CYCLE || tokio::time::Instant::now() < until
                            }
                            _ => false,
                        };
                        if slot_allowed
                            && !refill_blocked
                            && last_refill_minute.is_none_or(|m| m < slot_mk)
                        {
                            match st
                                .grant_scheduled_ap_refill_for_slot(slot_mk, refill_slot_dt, now)
                                .await
                            {
                                Ok(Some(_)) => {
                                    refill_backoff = None;
                                    last_refill_minute = Some(slot_mk);
                                }
                                Ok(None) => {
                                    // action_mutex 取得後の再検証で非Active・同期設定・既実行だった場合はスキップし、DB エラー時は既存値を維持する
                                    if sync_minute_setting(
                                        &st.pool,
                                        "last_refill_minute",
                                        &mut last_refill_minute,
                                    )
                                    .await
                                    {
                                        refill_backoff = None;
                                    } else {
                                        let fails = match refill_backoff {
                                            Some((k, f, _)) if k == slot_mk => f.saturating_add(1),
                                            _ => 1,
                                        };
                                        let delay = Duration::from_secs(
                                            2u64.saturating_pow(fails.min(5)).min(60),
                                        );
                                        refill_backoff = Some((
                                            slot_mk,
                                            fails,
                                            tokio::time::Instant::now() + delay,
                                        ));
                                    }
                                }
                                Err(e) => {
                                    error!("AP補充エラー: {}", e);
                                    let fails = match refill_backoff {
                                        Some((k, f, _)) if k == slot_mk => f.saturating_add(1),
                                        _ => 1,
                                    };
                                    let delay = Duration::from_secs(
                                        2u64.saturating_pow(fails.min(5)).min(60),
                                    );
                                    refill_backoff = Some((
                                        slot_mk,
                                        fails,
                                        tokio::time::Instant::now() + delay,
                                    ));
                                }
                            }
                        }
                    }
                }

                // 設定された間隔でのティック処理（自動終了境界の分跨ぎ補完、または開催中の10分猶予内補完）
                let end_boundary_slot = if phase == SeasonPhase::Frozen
                    && is_auto_schedule
                    && tick_interval == 60
                    && rules_cfg.max_ticks == 48
                {
                    season::current_season_end_boundary_at(now, schedule)
                } else {
                    None
                };
                let active_boundary_mk =
                    boundary_tracker.prepare_boundary(end_boundary_slot.map(|dt| dt.timestamp() / 60));

                let tick_candidate = if let (Some(b_dt), Some(b_mk)) =
                    (end_boundary_slot, active_boundary_mk)
                {
                    let b_bucket = b_dt.timestamp() / 3600;
                    let is_due = last_tick_minute.is_none_or(|m| m < b_mk)
                        && last_tick_hour.is_none_or(|(b, _)| b < b_bucket);
                    if is_due {
                        Some((b_dt, b_mk, Some((b_bucket, b_dt.hour())), true))
                    } else {
                        boundary_tracker.clear_pending_boundary();
                        None
                    }
                } else if phase == SeasonPhase::Active {
                    season::latest_scheduled_slot_within(
                        now,
                        tick_interval,
                        0,
                        schedule,
                        season::SCHEDULE_CATCHUP_GRACE_MINUTES,
                    )
                    .and_then(|slot_dt| {
                        let slot_mk = slot_dt.timestamp() / 60;
                        let slot_allowed = min_catchup_minute.is_none_or(|min_mk| slot_mk >= min_mk)
                            && (!is_auto_schedule
                                || (!season::is_season_start_minute(slot_dt, schedule)
                                    && season::compute_phase_jst_with_schedule(slot_dt, schedule)
                                        == SeasonPhase::Active));
                        if !slot_allowed || last_tick_minute.is_some_and(|m| m >= slot_mk) {
                            return None;
                        }
                        if tick_interval == 60 {
                            let slot_bucket = slot_dt.timestamp() / 3600;
                            if last_tick_hour.is_some_and(|(b, _)| b >= slot_bucket) {
                                return None;
                            }
                            Some((slot_dt, slot_mk, Some((slot_bucket, slot_dt.hour())), false))
                        } else {
                            Some((slot_dt, slot_mk, None, false))
                        }
                    })
                } else {
                    None
                };

                let mut tick_synced_this_iter = false;
                if let Some((slot_dt, slot_mk, tick_hour_key, is_frozen_boundary)) = tick_candidate {
                    let tick_blocked = match tick_backoff {
                        Some((k, fails, until)) if k == slot_mk => {
                            fails >= MAX_RETRY_PER_CYCLE || tokio::time::Instant::now() < until
                        }
                        _ => false,
                    };
                    if !tick_blocked {
                        match st
                            .execute_scheduled_tick_for_slot(
                                is_frozen_boundary,
                                slot_mk,
                                tick_hour_key,
                                slot_dt,
                                now,
                            )
                            .await
                        {
                            Ok(Some(summary)) => {
                                tick_synced_this_iter = true;
                                info!(
                                    "ティック完了 (間隔={}分, 境界={}): {:?}",
                                    tick_interval, is_frozen_boundary, summary
                                );
                                tick_backoff = None;
                                boundary_tracker.clear_pending_boundary();
                                last_tick_minute = Some(slot_mk);
                                // DB の最新状態を厳格に同期し、DB 一時障害時は既知の値のみフォールバック更新して既存値を保護する
                                if !sync_hour_setting(
                                    &st.pool,
                                    "last_tick_hour",
                                    &mut last_tick_hour,
                                )
                                .await
                                {
                                    if let Some(hk) = tick_hour_key {
                                        last_tick_hour = Some(hk);
                                    }
                                }
                                let _ = sync_minute_setting(
                                    &st.pool,
                                    "last_refill_minute",
                                    &mut last_refill_minute,
                                )
                                .await;
                            }
                            Ok(None) => {
                                // action_mutex 取得後の再検証で非Activeまたは既実行だった場合は DB の既実行キーを同期して空回りを防ぐ
                                boundary_tracker.clear_pending_boundary();
                                let min_ok = sync_minute_setting(
                                    &st.pool,
                                    "last_tick_minute",
                                    &mut last_tick_minute,
                                )
                                .await;
                                let hour_ok = sync_hour_setting(
                                    &st.pool,
                                    "last_tick_hour",
                                    &mut last_tick_hour,
                                )
                                .await;
                                if min_ok && hour_ok {
                                    tick_backoff = None;
                                } else {
                                    let fails = match tick_backoff {
                                        Some((k, f, _)) if k == slot_mk => f.saturating_add(1),
                                        _ => 1,
                                    };
                                    let delay = Duration::from_secs(
                                        2u64.saturating_pow(fails.min(5)).min(60),
                                    );
                                    tick_backoff = Some((
                                        slot_mk,
                                        fails,
                                        tokio::time::Instant::now() + delay,
                                    ));
                                }
                            }
                            Err(e) => {
                                if e.contains("開催フェーズではないため") {
                                    warn!("定期ティックスキップ: {}", e);
                                    tick_backoff = None;
                                    boundary_tracker.clear_pending_boundary();
                                } else {
                                    error!("定期ティックエラー: {}", e);
                                    let fails = match tick_backoff {
                                        Some((k, f, _)) if k == slot_mk => f.saturating_add(1),
                                        _ => 1,
                                    };
                                    let delay = Duration::from_secs(
                                        2u64.saturating_pow(fails.min(5)).min(60),
                                    );
                                    tick_backoff = Some((
                                        slot_mk,
                                        fails,
                                        tokio::time::Instant::now() + delay,
                                    ));
                                    if fails >= MAX_RETRY_PER_CYCLE {
                                        boundary_tracker.clear_pending_boundary();
                                    }
                                }
                            }
                        }
                    }
                }

                let next_phase = st.phase_at(now);
                // 月曜00:00境界ティックが一時失敗してリトライ待機中の間は Frozen 同期のフライング送信を抑止する
                let waiting_boundary_retry =
                    boundary_tracker.is_waiting_boundary_retry(tick_backoff, MAX_RETRY_PER_CYCLE);
                if !waiting_boundary_retry {
                    // 土曜00:00 JST開幕やカスタム間隔時の自然凍結など、ティック非実行のフェーズ遷移でもクライアントへ同期通知を送る
                    if boundary_tracker
                        .prev_phase
                        .is_some_and(|p| p != next_phase)
                        && !tick_synced_this_iter
                    {
                        let cur_sid = st.current_season_id();
                        if !st.is_phase_already_synced(cur_sid, next_phase) {
                            st.broadcast_tick_sync(
                                next_phase,
                                st.tick_number_at(now),
                                0,
                                st.next_refill_unix_at(now),
                                cur_sid,
                            );
                            let phase_label = match next_phase {
                                SeasonPhase::Preparation => "準備",
                                SeasonPhase::Active => "開催",
                                SeasonPhase::Frozen => "凍結（結果発表）",
                            };
                            db::record_player_log(
                                &st.pool,
                                cur_sid,
                                0,
                                "システム",
                                0,
                                "system",
                                &format!("{}フェーズへ移行した", phase_label),
                            )
                            .await;
                        }
                    }
                    let next_is_auto_schedule = st.phase_override.read().is_none()
                        && st.auto_frozen_season_id.load(Ordering::Acquire)
                            != st.current_season_id();
                    boundary_tracker.commit_phase(next_phase, next_is_auto_schedule);
                }
            }
        })
    };

    // バックグラウンドタスク 3: 60秒ごとのレートリミット・セッション・古いデータ掃除（ティック監視を遅延させないため独立実行）
    let mut task3_handle = {
        let st = Arc::clone(&state);
        let mut rx = state.subscribe_shutdown();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // 起動直後の即時発火を消費し、初回実行を60秒後に揃える
            interval.tick().await;
            let mut old_data_cleanup_counter = 0u32;
            loop {
                tokio::select! {
                    _ = interval.tick() => {}
                    res = rx.changed() => {
                        if res.is_err() || *rx.borrow() {
                            break;
                        }
                    }
                }
                if *rx.borrow() {
                    break;
                }
                st.ip_limiter.cleanup_stale(Duration::from_secs(120));
                st.account_limiter.cleanup_stale(Duration::from_secs(120));
                st.read_limiter.cleanup_stale(Duration::from_secs(120));
                st.ws_handshake_limiter.cleanup_stale(Duration::from_secs(120));
                st.recolor_limiter.cleanup_stale(Duration::from_secs(120));
                st.register_limiter.cleanup_stale(Duration::from_secs(900));
                st.login_limiter.cleanup_stale(Duration::from_secs(900));
                st.login_account_limiter.cleanup_stale(Duration::from_secs(900));
                st.admin_login_limiter.cleanup_stale(Duration::from_secs(900));
                st.admin_global_login_limiter.cleanup_stale(Duration::from_secs(900));
                st.admin_lockout.cleanup_stale(Duration::from_secs(900));
                st.faction_color_cooldown
                    .retain(|_, t| t.elapsed() < Duration::from_secs(120));
                st.core_attack_alert_cooldown
                    .retain(|_, t| t.elapsed() < Duration::from_secs(120));
                let mut expired_tokens = st.cleanup_session_caches();
                expired_tokens.extend(db::cleanup_expired_sessions(&st.pool).await);
                if !expired_tokens.is_empty() {
                    st.invalidate_expired_user_sessions(&expired_tokens);
                }
                old_data_cleanup_counter += 1;
                if old_data_cleanup_counter >= 10 {
                    old_data_cleanup_counter = 0;
                    db::cleanup_old_data(&st.pool, st.current_season_id()).await;
                }
            }
        })
    };

    // ルーティング構築
    let app = build_app_router(Arc::clone(&state));

    let local_addr = listener
        .local_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| state.config.bind_addr.clone());
    info!("サーバー起動完了: http://{}", local_addr);

    let shutdown_state = Arc::clone(&state);
    let mut shutdown_wait_rx = state.subscribe_shutdown();
    let serve_fut = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_signal().await;
        shutdown_state.trigger_shutdown();
    });

    // 停滞 HTTP 接続による無期限ブロックを防ぐため、シャットダウン通知後は最大 15 秒で待受終了を切り上げる
    tokio::select! {
        res = serve_fut => {
            if let Err(e) = res {
                error!("サーバー実行中にエラーが発生しました: {}", e);
            }
        }
        _ = async {
            loop {
                if *shutdown_wait_rx.borrow() {
                    break;
                }
                if shutdown_wait_rx.changed().await.is_err() {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_secs(15)).await;
        } => {
            warn!("シャットダウン時の HTTP 接続完了待機がタイムアウトしました（15秒）。後続の終了処理へ移行します");
        }
    }

    // サーバループ異常終了時も含め、全タスク・WebSocket 接続へ停止通知を確実に送る
    state.trigger_shutdown();

    // WebSocket 接続の終了待機とバックグラウンドタスクの完了待機を並列実行し、タイムアウト時はタスクを中断する
    let ws_wait_fut = async {
        let ws_wait_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while state.online_count.load(Ordering::Acquire) > 0 {
            if tokio::time::Instant::now() >= ws_wait_deadline {
                warn!(
                    "WebSocket 接続の終了待機がタイムアウトしました（残存: {} 件）",
                    state.online_count.load(Ordering::Acquire)
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };
    let task1_wait_fut = async {
        match tokio::time::timeout(Duration::from_secs(10), &mut task1_handle).await {
            Ok(Err(e)) => error!("チャンク保存タスク終了エラー: {}", e),
            Err(_) => {
                error!("チャンク保存タスクの終了待機がタイムアウトしました（10秒）。タスクを中断します");
                task1_handle.abort();
                let _ = tokio::time::timeout(Duration::from_secs(1), &mut task1_handle).await;
            }
            Ok(Ok(())) => {}
        }
    };
    let task2_wait_fut = async {
        match tokio::time::timeout(Duration::from_secs(10), &mut task2_handle).await {
            Ok(Err(e)) => error!("ティック監視タスク終了エラー: {}", e),
            Err(_) => {
                error!("ティック監視タスクの終了待機がタイムアウトしました（10秒）。タスクを中断します");
                task2_handle.abort();
                let _ = tokio::time::timeout(Duration::from_secs(1), &mut task2_handle).await;
            }
            Ok(Ok(())) => {}
        }
    };
    let task3_wait_fut = async {
        match tokio::time::timeout(Duration::from_secs(10), &mut task3_handle).await {
            Ok(Err(e)) => error!("定期掃除タスク終了エラー: {}", e),
            Err(_) => {
                error!("定期掃除タスクの終了待機がタイムアウトしました（10秒）。タスクを中断します");
                task3_handle.abort();
                let _ = tokio::time::timeout(Duration::from_secs(1), &mut task3_handle).await;
            }
            Ok(Ok(())) => {}
        }
    };
    tokio::join!(ws_wait_fut, task1_wait_fut, task2_wait_fut, task3_wait_fut);

    // 終了前に未保存のダーティチャンクをタイムアウト付きで SQLite へフラッシュする
    match tokio::time::timeout(Duration::from_secs(5), state.flush_dirty_chunks()).await {
        Ok(Ok(n)) => info!("シャットダウン時のダーティチャンク保存完了: {} チャンク", n),
        Ok(Err(e)) => error!("シャットダウン時のダーティチャンク保存エラー: {}", e),
        Err(_) => error!("シャットダウン時のダーティチャンク保存がタイムアウトしました（5秒）"),
    }

    // SQLite 接続プールをタイムアウト付きでクリーンにクローズする
    if tokio::time::timeout(Duration::from_secs(3), state.pool.close())
        .await
        .is_err()
    {
        warn!("SQLite 接続プールのクローズ待機がタイムアウトしました（3秒）");
    }
}

/// アプリケーションの HTTP / WebSocket / 静的ファイルルーターを構築する
fn build_app_router(state: Arc<AppState>) -> Router {
    let mut api_router = Router::new()
        .route("/api/auth/register", post(api::register))
        .route("/api/auth/login", post(api::login))
        .route("/api/auth/logout", post(api::logout))
        .route("/api/auth/me", get(api::get_me))
        .route("/api/season/status", get(api::season_status))
        .route("/api/board/snapshot", get(api::board_snapshot))
        .route("/api/rankings", get(api::get_rankings))
        .route("/api/logs", get(api::get_player_logs))
        .route("/api/timelapse/frames", get(api::list_timelapse_frames))
        .route("/api/timelapse/frames/:id", get(api::get_timelapse_frame))
        .route("/api/factions", get(api::list_factions).post(api::create_faction))
        .route("/api/factions/:id", get(api::get_faction_detail))
        .route("/api/factions/:id/join", post(api::join_faction))
        .route("/api/factions/:id/join-request", post(api::request_join_faction))
        .route(
            "/api/factions/:id/join-requests/:req_id/accept",
            post(api::accept_join_request),
        )
        .route(
            "/api/factions/:id/join-requests/:req_id/reject",
            post(api::reject_join_request),
        )
        .route("/api/factions/:id/leave", post(api::leave_faction))
        .route("/api/factions/:id/kick", post(api::kick_member))
        .route(
            "/api/factions/:id/members/:user_id/permissions",
            patch(api::update_member_permissions),
        )
        .route(
            "/api/factions/:id/permissions/bulk",
            post(api::bulk_update_member_permissions),
        )
        .route("/api/factions/:id/settings", post(api::update_faction_settings))
        .route("/api/auth/auto_paint", post(api::update_auto_paint))
        .route("/api/diplomacy", get(api::get_diplomacy))
        .route("/api/diplomacy/ceasefire/propose", post(api::propose_ceasefire))
        .route(
            "/api/diplomacy/ceasefire/:id/respond",
            post(api::respond_ceasefire),
        )
        .route("/api/admin/login", post(api::admin_login))
        .route("/api/admin/logout", post(api::admin_logout))
        .route("/api/admin/me", get(api::admin_me))
        .route("/api/admin/map/regenerate", post(api::admin_regenerate_map))
        .route("/api/admin/phase", post(api::admin_set_phase))
        .route("/api/admin/tick", post(api::admin_trigger_tick))
        .route("/api/admin/timelapse/capture", post(api::admin_capture_timelapse))
        .route("/api/admin/ap_config", post(api::admin_update_ap_config))
        .route("/api/admin/cost_config", post(api::admin_update_cost_config))
        .route("/api/admin/rules_config", post(api::admin_update_rules_config))
        .route("/api/admin/faction_config", post(api::admin_update_faction_config))
        .route("/api/admin/factions/:id/rename", post(api::admin_rename_faction))
        .route("/api/admin/factions/:id", delete(api::admin_delete_faction))
        .route("/api/admin/users/:id", delete(api::admin_delete_user))
        .route("/api/admin/diplomacy/war", post(api::admin_force_war))
        .route("/api/admin/diplomacy/ceasefire", post(api::admin_force_ceasefire))
        .route("/api/admin/debug/accounts", get(api::admin_debug_list_accounts))
        .route("/api/admin/debug/seed_factions", post(api::admin_debug_seed_factions))
        .route("/api/admin/debug/impersonate", post(api::admin_debug_impersonate))
        .route("/api/admin/debug/grant_ap", post(api::admin_debug_grant_ap))
        .route("/api/admin/logs", get(api::admin_get_logs))
        .route("/ws", get(ws::ws_handler));

    // 開発用エンドポイントは dev_mode 有効時のみ登録する
    if state.config.dev_mode {
        api_router = api_router
            .route("/api/dev/phase", post(api::dev_set_phase))
            .route("/api/dev/tick", post(api::dev_trigger_tick))
            .route("/api/dev/ap", post(api::dev_refill_ap));
    }

    // 未定義の /api/* パスが静的ファイルフォールバック(index.html)に流れないよう 404 JSON を返す
    api_router = api_router
        .route("/api", any(api_not_found_handler))
        .route("/api/", any(api_not_found_handler))
        .route("/api/*path", any(api_not_found_handler));

    let mut api_router = api_router
        .layer(from_fn_with_state(
            Arc::clone(&state),
            csrf_same_origin_middleware,
        ))
        .layer(from_fn(http_request_timeout_middleware))
        .layer(DefaultBodyLimit::max(64 * 1024));

    // ALLOWED_ORIGINS が設定されている場合は正規化・検証のうえで CORS レイヤーを適用する
    if !state.config.allowed_origins.is_empty() {
        let mut normalized_origins: Vec<String> = Vec::new();
        for raw in &state.config.allowed_origins {
            match config::validate_and_normalize_origin(raw) {
                Some(norm) => {
                    if !normalized_origins.contains(&norm) {
                        normalized_origins.push(norm);
                    }
                }
                None => {
                    warn!("CORS 許可オリジンとして不正な値を除外しました: {:?}", raw);
                }
            }
        }
        let origins: Vec<HeaderValue> = normalized_origins
            .into_iter()
            .filter_map(|norm| match HeaderValue::from_str(&norm) {
                Ok(hv) => Some(hv),
                Err(_) => {
                    warn!("CORS 許可オリジンのヘッダ変換に失敗したため除外しました: {:?}", norm);
                    None
                }
            })
            .collect();
        if !origins.is_empty() {
            let cors = CorsLayer::new()
                .allow_origin(origins)
                .allow_credentials(true)
                .allow_methods([
                    Method::GET,
                    Method::POST,
                    Method::PATCH,
                    Method::DELETE,
                    Method::OPTIONS,
                ])
                .allow_headers([
                    header::CONTENT_TYPE,
                    header::AUTHORIZATION,
                    header::HeaderName::from_static("x-admin-token"),
                ])
                .expose_headers([
                    HeaderName::from_static("x-board-size"),
                    HeaderName::from_static("x-snapshot-version"),
                ]);
            api_router = api_router.layer(cors);
        }
    }

    let api_router = api_router.with_state(Arc::clone(&state));

    // クライアント静的ファイル配信（存在する場合）
    // /assets/* は存在しない旧ハッシュ要求時に index.html へフォールバックせず 404 を返す
    let index_path = state.config.static_dir.join("index.html");
    let assets_service = ServeDir::new(state.config.static_dir.join("assets"));
    let static_service =
        ServeDir::new(&state.config.static_dir).fallback(ServeFile::new(index_path));
    let static_router = Router::new()
        .nest_service("/assets", assets_service)
        .fallback_service(static_service)
        .layer(from_fn(static_cache_control_middleware))
        .layer(from_fn(http_request_timeout_middleware));

    // SharedArrayBuffer 有効化のための COOP/COEP ヘッダおよびセキュリティヘッダを付与
    let strict_https = state.config.cookie_secure && !state.config.dev_mode;
    let csp_value = if strict_https {
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss:; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    } else {
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    };
    let mut app = api_router
        .fallback_service(static_router)
        .layer(CompressionLayer::new())
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("cross-origin-embedder-policy"),
            HeaderValue::from_static("require-corp"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("x-content-type-options"),
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("x-frame-options"),
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("strict-origin-when-cross-origin"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static(csp_value),
        ));
    if strict_https {
        app = app.layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("strict-transport-security"),
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        ));
    }
    app
}

/// 正の整数 (1 以上) 文字列をパースする
fn parse_positive_i64(raw: &str) -> Option<i64> {
    raw.trim().parse::<i64>().ok().filter(|&v| v > 0)
}

/// 0 以上の整数文字列をパースする
fn parse_non_negative_i64(raw: &str) -> Option<i64> {
    raw.trim().parse::<i64>().ok().filter(|&v| v >= 0)
}

/// 起動時のシーズン・サイクル解決結果
#[derive(Debug, PartialEq, Eq)]
struct StartupSeasonResolution {
    season_id: i64,
    season_cycle_id: i64,
    is_resumed_existing_season: bool,
    rollover_deferred: bool,
}

/// DB 記録値と現在時刻のサイクルIDから起動時のシーズンID・サイクルID・継続状態を決定する
fn resolve_startup_season(
    recorded_season_id: Option<i64>,
    recorded_cycle_id_opt: Option<i64>,
    wall_cycle_id: i64,
    phase_override: Option<SeasonPhase>,
    auto_frozen_season_id: Option<i64>,
) -> Result<StartupSeasonResolution, String> {
    let recorded_cycle_id = recorded_cycle_id_opt.or(recorded_season_id);
    if let Some(prev_cycle) = recorded_cycle_id {
        if prev_cycle > wall_cycle_id {
            return Err(format!(
                "記録済みサイクルID ({}) が現在の算出サイクルID ({}) より新しいため起動を中断します（システム時刻の巻き戻りの可能性があります）",
                prev_cycle, wall_cycle_id
            ));
        }
    }

    match recorded_season_id {
        None => Ok(StartupSeasonResolution {
            season_id: wall_cycle_id,
            season_cycle_id: wall_cycle_id,
            is_resumed_existing_season: false,
            rollover_deferred: false,
        }),
        Some(prev_sid) => {
            let prev_cycle = recorded_cycle_id.unwrap_or(prev_sid);
            if prev_cycle < wall_cycle_id {
                if phase_override.is_some() && auto_frozen_season_id != Some(prev_sid) {
                    Ok(StartupSeasonResolution {
                        season_id: prev_sid,
                        season_cycle_id: prev_cycle,
                        is_resumed_existing_season: true,
                        rollover_deferred: true,
                    })
                } else {
                    Ok(StartupSeasonResolution {
                        season_id: prev_sid.saturating_add(wall_cycle_id - prev_cycle),
                        season_cycle_id: wall_cycle_id,
                        is_resumed_existing_season: false,
                        rollover_deferred: false,
                    })
                }
            } else {
                Ok(StartupSeasonResolution {
                    season_id: prev_sid,
                    season_cycle_id: prev_cycle,
                    is_resumed_existing_season: true,
                    rollover_deferred: false,
                })
            }
        }
    }
}

/// 定期ティックループにおける終了境界遷移とロールオーバー後の状態リセットを管理する
struct TickBoundaryTracker {
    prev_phase: Option<SeasonPhase>,
    prev_is_auto_schedule: bool,
    allow_startup_boundary_catchup: bool,
    pending_frozen_boundary_key: Option<i64>,
}

impl TickBoundaryTracker {
    fn new(is_resumed_existing_season: bool) -> Self {
        Self {
            prev_phase: None,
            prev_is_auto_schedule: false,
            allow_startup_boundary_catchup: is_resumed_existing_season,
            pending_frozen_boundary_key: None,
        }
    }

    /// シーズン切替完了時に前シーズンのフェーズ・境界状態を破棄する
    fn on_season_rollover(&mut self) {
        self.prev_phase = None;
        self.prev_is_auto_schedule = false;
        self.allow_startup_boundary_catchup = false;
        self.pending_frozen_boundary_key = None;
    }

    /// 終了境界の分キーを更新し、終了境界ティックを実行すべきならその分キーを返す
    fn prepare_boundary(&mut self, boundary_minute_key: Option<i64>) -> Option<i64> {
        let startup_catchup = self.allow_startup_boundary_catchup;
        self.allow_startup_boundary_catchup = false;

        let Some(bmk) = boundary_minute_key else {
            self.pending_frozen_boundary_key = None;
            return None;
        };
        if self
            .pending_frozen_boundary_key
            .is_some_and(|k| k != bmk)
        {
            self.pending_frozen_boundary_key = None;
        }
        if (self.prev_phase == Some(SeasonPhase::Active) && self.prev_is_auto_schedule)
            || (startup_catchup && self.prev_phase.is_none())
        {
            self.pending_frozen_boundary_key = Some(bmk);
        }

        self.pending_frozen_boundary_key.filter(|&k| k == bmk)
    }

    /// 終了境界の保留フラグを明示的に解除する
    fn clear_pending_boundary(&mut self) {
        self.pending_frozen_boundary_key = None;
    }

    /// 終了境界ティックが実際にリトライ待機中（上限未到達）かどうかを判定する
    fn is_waiting_boundary_retry(
        &self,
        tick_backoff: Option<(i64, u32, tokio::time::Instant)>,
        max_retry: u32,
    ) -> bool {
        let Some(bmk) = self.pending_frozen_boundary_key else {
            return false;
        };
        matches!(tick_backoff, Some((k, fails, _)) if k == bmk && fails < max_retry)
    }

    /// 次回反復向けに現在フェーズと自動スケジュール状態を確定する
    fn commit_phase(&mut self, next_phase: SeasonPhase, next_is_auto_schedule: bool) {
        self.prev_phase = Some(next_phase);
        self.prev_is_auto_schedule = next_is_auto_schedule;
    }
}

/// `last_tick_hour` 文字列 ("bucket:hour") をパースする
fn parse_hour_key(raw: &str) -> Option<(i64, u32)> {
    let (bucket, hour) = raw.trim().split_once(':')?;
    let bucket_val = bucket.parse().ok()?;
    let hour_val = hour.parse::<u32>().ok()?;
    if hour_val >= 24 {
        return None;
    }
    Some((bucket_val, hour_val))
}

/// 分単位の既実行キー文字列をパースする
fn parse_minute_key(raw: &str) -> Option<i64> {
    raw.trim().parse::<i64>().ok()
}

/// DB から分単位の既実行キーを厳格に読み込み、成功時のみメモリ上の値を更新する
async fn sync_minute_setting(pool: &sqlx::SqlitePool, key: &str, target: &mut Option<i64>) -> bool {
    match db::load_setting_strict(pool, key).await {
        Ok(Some(v)) => match parse_minute_key(&v) {
            Some(mk) => {
                *target = Some(mk);
                true
            }
            None => {
                error!("{} の値が不正なため既存値を維持します: {:?}", key, v);
                false
            }
        },
        Ok(None) => {
            *target = None;
            true
        }
        Err(e) => {
            error!("{} の読み込みに失敗したため既存値を維持します: {}", key, e);
            false
        }
    }
}

/// DB から時間単位の既実行キーを厳格に読み込み、成功時のみメモリ上の値を更新する
async fn sync_hour_setting(
    pool: &sqlx::SqlitePool,
    key: &str,
    target: &mut Option<(i64, u32)>,
) -> bool {
    match db::load_setting_strict(pool, key).await {
        Ok(Some(v)) => match parse_hour_key(&v) {
            Some(hk) => {
                *target = Some(hk);
                true
            }
            None => {
                error!("{} の値が不正なため既存値を維持します: {:?}", key, v);
                false
            }
        },
        Ok(None) => {
            *target = None;
            true
        }
        Err(e) => {
            error!("{} の読み込みに失敗したため既存値を維持します: {}", key, e);
            false
        }
    }
}

/// 未定義の `/api/*` パスに対する 404 JSON レスポンス
async fn api_not_found_handler() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({
            "error": "指定された API エンドポイントが見つかりません"
        })),
    )
        .into_response()
}

/// 静的アセット配信に適切な Cache-Control ヘッダを付与するミドルウェア
async fn static_cache_control_middleware(req: Request, next: Next) -> Response {
    let is_hashed_asset = req.uri().path().starts_with("/assets/");
    let mut resp = next.run(req).await;
    if resp.status() == StatusCode::OK && !resp.headers().contains_key(header::CACHE_CONTROL) {
        // HTML フォールバック等へ誤って長期キャッシュが付与されるのを防ぐ二重ガード
        let is_html = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| ct.trim_start().starts_with("text/html"));
        let val = if is_hashed_asset && !is_html {
            HeaderValue::from_static("public, max-age=31536000, immutable")
        } else {
            HeaderValue::from_static("no-cache")
        };
        resp.headers_mut().insert(header::CACHE_CONTROL, val);
    }
    resp
}

/// WebSocket 以外の HTTP リクエストに対して指定タイムアウトを適用する内部ミドルウェア
async fn http_request_timeout_with_duration(
    req: Request,
    next: Next,
    timeout: Duration,
) -> Response {
    if req.uri().path() == "/ws" {
        return next.run(req).await;
    }
    match tokio::time::timeout(timeout, next.run(req)).await {
        Ok(res) => res,
        Err(_) => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({
                "error": "リクエストがタイムアウトしました"
            })),
        )
            .into_response(),
    }
}

/// WebSocket 以外の HTTP リクエストに対して上限タイムアウト（60秒）を適用するミドルウェア
async fn http_request_timeout_middleware(req: Request, next: Next) -> Response {
    http_request_timeout_with_duration(req, next, Duration::from_secs(60)).await
}

/// Ctrl+C または SIGTERM を待機するグレースフルシャットダウン用シグナル
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("Ctrl+C シグナルハンドラの登録に失敗しました");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM シグナルハンドラの登録に失敗しました")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    info!("シャットダウンシグナルを受信しました。終了処理を開始します...");
}

/// 状態変更系 HTTP メソッドに対して Same-Origin / 許可オリジンを検証する CSRF 対策ミドルウェア
async fn csrf_same_origin_middleware(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Response {
    if matches!(
        *req.method(),
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) && !auth::is_same_origin_request(
        req.headers(),
        &state.config.allowed_origins,
        state.config.dev_mode,
        state.config.trust_proxy,
        state.config.cookie_secure && !state.config.dev_mode,
    ) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "不正なオリジンからのリクエストです"
            })),
        )
            .into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::Board;
    use crate::map_gen::MapGenParams;
    use axum::body::Body;
    use std::path::PathBuf;
    use tower::Service;

    fn test_config_with_origins(allowed_origins: Vec<String>) -> Config {
        Config {
            bind_addr: "127.0.0.1:0".into(),
            db_path: PathBuf::from(":memory:"),
            static_dir: PathBuf::from("."),
            dev_mode: false,
            map_seed: Some(1),
            admin_id: "admin".into(),
            admin_password: Some("admin".into()),
            trust_proxy: false,
            cookie_secure: false,
            allowed_origins,
        }
    }

    async fn call_router(router: &mut Router, req: Request<Body>) -> Response {
        futures_util::future::poll_fn(|cx| {
            <Router as Service<Request<Body>>>::poll_ready(router, cx)
        })
        .await
        .expect("ルーターが ready になりませんでした");
        <Router as Service<Request<Body>>>::call(router, req)
            .await
            .expect("ルーター呼び出しに失敗しました")
    }

    #[tokio::test]
    async fn load_setting_strict_distinguishes_missing_present_and_db_error() {
        let pool = db::init_memory_db().await.unwrap();

        // 未設定キーは Ok(None)
        assert_eq!(
            db::load_setting_strict(&pool, "missing_key").await.unwrap(),
            None
        );

        // 保存済みキーは Ok(Some(...))
        db::save_setting(&pool, "test_key", "42").await.unwrap();
        assert_eq!(
            db::load_setting_strict(&pool, "test_key").await.unwrap(),
            Some("42".to_string())
        );

        // DB 接続プールクローズ後は Err(_) を返す
        pool.close().await;
        assert!(db::load_setting_strict(&pool, "test_key").await.is_err());
    }

    #[tokio::test]
    async fn unknown_api_route_returns_404_json_with_cors_headers() {
        let pool = db::init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(
            test_config_with_origins(vec!["https://example.com".into()]),
            pool,
            board,
            params,
            1,
        ));
        let mut app = build_app_router(state);

        for uri in ["/api", "/api/", "/api/nonexistent"] {
            let req = Request::builder()
                .method(Method::GET)
                .uri(uri)
                .header(header::ORIGIN, "https://example.com")
                .body(Body::empty())
                .unwrap();
            let resp = call_router(&mut app, req).await;

            assert_eq!(resp.status(), StatusCode::NOT_FOUND, "uri={}", uri);
            assert_eq!(
                resp.headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok()),
                Some("application/json"),
                "uri={}",
                uri
            );
            assert_eq!(
                resp.headers()
                    .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                    .and_then(|v| v.to_str().ok()),
                Some("https://example.com"),
                "uri={}",
                uri
            );
        }
    }

    #[tokio::test]
    async fn http_request_timeout_returns_504_and_skips_ws() {
        let mut app = Router::new()
            .route(
                "/api/slow",
                get(|| async {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    StatusCode::OK
                }),
            )
            .route(
                "/ws",
                get(|| async {
                    tokio::time::sleep(Duration::from_millis(80)).await;
                    StatusCode::OK
                }),
            )
            .layer(from_fn(|req, next| {
                http_request_timeout_with_duration(req, next, Duration::from_millis(30))
            }));

        let slow_req = Request::builder()
            .method(Method::GET)
            .uri("/api/slow")
            .body(Body::empty())
            .unwrap();
        let slow_resp = call_router(&mut app, slow_req).await;
        assert_eq!(slow_resp.status(), StatusCode::GATEWAY_TIMEOUT);

        let ws_req = Request::builder()
            .method(Method::GET)
            .uri("/ws")
            .body(Body::empty())
            .unwrap();
        let ws_resp = call_router(&mut app, ws_req).await;
        assert_eq!(ws_resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn cors_layer_normalizes_origins_and_excludes_invalid_ones() {
        let pool = db::init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = Arc::new(AppState::new(
            test_config_with_origins(vec![
                "https://Example.com:443/".into(),
                "http://:80".into(),
                "http://example.com:99999".into(),
            ]),
            pool,
            board,
            params,
            1,
        ));
        let mut app = build_app_router(state);

        // 大文字・デフォルトポート・末尾スラッシュ付きで渡されたオリジンも正規化されて許可される
        let ok_req = Request::builder()
            .method(Method::GET)
            .uri("/api/nonexistent")
            .header(header::ORIGIN, "https://example.com")
            .body(Body::empty())
            .unwrap();
        let ok_resp = call_router(&mut app, ok_req).await;
        assert_eq!(
            ok_resp
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .and_then(|v| v.to_str().ok()),
            Some("https://example.com")
        );

        // 不正オリジンは除外されているため Access-Control-Allow-Origin が付与されない
        let bad_req = Request::builder()
            .method(Method::GET)
            .uri("/api/nonexistent")
            .header(header::ORIGIN, "http://:80")
            .body(Body::empty())
            .unwrap();
        let bad_resp = call_router(&mut app, bad_req).await;
        assert!(bad_resp
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());
    }

    #[test]
    fn parse_hour_key_validates_hour_range() {
        assert_eq!(parse_hour_key("12345:0"), Some((12345, 0)));
        assert_eq!(parse_hour_key(" 12345:23 "), Some((12345, 23)));
        assert_eq!(parse_hour_key("12345:24"), None);
        assert_eq!(parse_hour_key("12345:99"), None);
        assert_eq!(parse_hour_key("invalid"), None);
    }

    #[test]
    fn parse_positive_and_non_negative_i64_validate_bounds() {
        assert_eq!(parse_positive_i64("1"), Some(1));
        assert_eq!(parse_positive_i64(" 42 "), Some(42));
        assert_eq!(parse_positive_i64("0"), None);
        assert_eq!(parse_positive_i64("-1"), None);
        assert_eq!(parse_positive_i64("abc"), None);

        assert_eq!(parse_non_negative_i64("0"), Some(0));
        assert_eq!(parse_non_negative_i64(" 7 "), Some(7));
        assert_eq!(parse_non_negative_i64("-1"), None);
        assert_eq!(parse_non_negative_i64("abc"), None);
    }

    #[test]
    fn resolve_startup_season_handles_missing_season_id_rollover_and_clock_rollback() {
        // last_active_season_id が欠損していても古い cycle_id を引き継がず wall_cycle_id に揃える
        assert_eq!(
            resolve_startup_season(None, Some(2), 5, None, None).unwrap(),
            StartupSeasonResolution {
                season_id: 5,
                season_cycle_id: 5,
                is_resumed_existing_season: false,
                rollover_deferred: false,
            }
        );

        // 同一サイクル内の再起動は既存シーズン継続となる
        assert_eq!(
            resolve_startup_season(Some(3), Some(5), 5, None, None).unwrap(),
            StartupSeasonResolution {
                season_id: 3,
                season_cycle_id: 5,
                is_resumed_existing_season: true,
                rollover_deferred: false,
            }
        );

        // 手動フェーズ固定中かつ未凍結なら旧シーズンを継続する
        assert_eq!(
            resolve_startup_season(Some(3), Some(5), 6, Some(SeasonPhase::Active), Some(0))
                .unwrap(),
            StartupSeasonResolution {
                season_id: 3,
                season_cycle_id: 5,
                is_resumed_existing_season: true,
                rollover_deferred: true,
            }
        );

        // 通常ロールオーバー（または自動凍結済み）はサイクル差分だけシーズン番号を進める
        assert_eq!(
            resolve_startup_season(Some(3), Some(5), 7, Some(SeasonPhase::Active), Some(3))
                .unwrap(),
            StartupSeasonResolution {
                season_id: 5,
                season_cycle_id: 7,
                is_resumed_existing_season: false,
                rollover_deferred: false,
            }
        );

        // 記録済みサイクルが現在より未来なら起動エラーとなる
        assert!(resolve_startup_season(Some(3), Some(8), 7, None, None).is_err());
    }

    #[test]
    fn tick_boundary_tracker_handles_due_skip_retry_rollover_and_startup_catchup() {
        let mut tracker = TickBoundaryTracker::new(false);
        tracker.commit_phase(SeasonPhase::Active, true);

        // 終了境界に入ったが is_tick_due == false でクリアされた場合、waiting_boundary_retry は false になる
        assert_eq!(tracker.prepare_boundary(Some(100)), Some(100));
        tracker.clear_pending_boundary();
        assert!(!tracker.is_waiting_boundary_retry(None, 3));

        // 再度 Active -> 終了境界で tick_backoff がリトライ中（fails < 3）のときのみ true、分を跨いでも同じ境界キーなら待機を維持し上限到達で false
        let mut tracker2 = TickBoundaryTracker::new(false);
        tracker2.commit_phase(SeasonPhase::Active, true);
        assert_eq!(tracker2.prepare_boundary(Some(200)), Some(200));
        assert!(!tracker2.is_waiting_boundary_retry(None, 3));
        let until = tokio::time::Instant::now() + Duration::from_secs(2);
        assert!(tracker2.is_waiting_boundary_retry(Some((200, 1, until)), 3));
        // 次の分に進んでも同じ終了境界キー(200)であれば保留とリトライ待機を維持する
        assert_eq!(tracker2.prepare_boundary(Some(200)), Some(200));
        assert!(tracker2.is_waiting_boundary_retry(Some((200, 1, until)), 3));
        assert!(!tracker2.is_waiting_boundary_retry(Some((200, 3, until)), 3));

        // on_season_rollover() 後は直前が Active でも終了境界が誤発火しない
        let mut rollover_tracker = TickBoundaryTracker::new(true);
        rollover_tracker.commit_phase(SeasonPhase::Active, true);
        rollover_tracker.on_season_rollover();
        assert_eq!(rollover_tracker.prepare_boundary(Some(300)), None);

        // 既存シーズン再起動時は初回のみ終了境界キャッチアップが有効（分跨ぎも含む）、2回目以降は発火しない
        let mut resumed_tracker = TickBoundaryTracker::new(true);
        assert_eq!(resumed_tracker.prepare_boundary(Some(400)), Some(400));
        resumed_tracker.clear_pending_boundary();
        assert_eq!(resumed_tracker.prepare_boundary(Some(401)), None);

        // 新規シーズン起動時は初回から終了境界キャッチアップを発火しない
        let mut fresh_tracker = TickBoundaryTracker::new(false);
        assert_eq!(fresh_tracker.prepare_boundary(Some(500)), None);
    }

    #[tokio::test]
    async fn compression_layer_and_static_cache_headers_work_without_double_gzip() {
        use axum::body::to_bytes;
        use axum::extract::ConnectInfo;

        let temp_dir = std::env::temp_dir().join(format!(
            "teien_static_test_{}_{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let assets_dir = temp_dir.join("assets");
        std::fs::create_dir_all(&assets_dir).unwrap();
        std::fs::write(temp_dir.join("index.html"), "<html><body>ok</body></html>").unwrap();
        std::fs::write(
            assets_dir.join("bundle.js"),
            "console.log('hello teien seiryokuzu asset cache test');".repeat(20),
        )
        .unwrap();

        let pool = db::init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let mut cfg = test_config_with_origins(vec![]);
        cfg.static_dir = temp_dir.clone();
        let state = Arc::new(AppState::new(cfg, pool, board, params, 1));
        let mut app = build_app_router(state);

        // 1. JSON API は Accept-Encoding: gzip に対して gzip 圧縮される
        let mut api_req = Request::builder()
            .method(Method::GET)
            .uri("/api/season/status")
            .header(header::ACCEPT_ENCODING, "gzip")
            .body(Body::empty())
            .unwrap();
        api_req
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 12345))));
        let api_resp = call_router(&mut app, api_req).await;
        assert_eq!(api_resp.status(), StatusCode::OK);
        assert_eq!(
            api_resp
                .headers()
                .get(header::CONTENT_ENCODING)
                .and_then(|v| v.to_str().ok()),
            Some("gzip")
        );

        // 2. 既に gzip 済みの /api/board/snapshot は二重圧縮されずそのまま有効な gzip を返す
        let mut snap_req = Request::builder()
            .method(Method::GET)
            .uri("/api/board/snapshot")
            .header(header::ACCEPT_ENCODING, "gzip")
            .body(Body::empty())
            .unwrap();
        snap_req
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 12345))));
        let snap_resp = call_router(&mut app, snap_req).await;
        assert_eq!(snap_resp.status(), StatusCode::OK);
        assert_eq!(
            snap_resp
                .headers()
                .get(header::CONTENT_ENCODING)
                .and_then(|v| v.to_str().ok()),
            Some("gzip")
        );
        let snap_gz = to_bytes(snap_resp.into_body(), usize::MAX).await.unwrap();
        let mut decoder = flate2::read::GzDecoder::new(&snap_gz[..]);
        let mut decoded = Vec::new();
        std::io::Read::read_to_end(&mut decoder, &mut decoded).unwrap();
        assert_eq!(decoded.len(), 100 * 100 * 8);

        // 3. /assets/* 静的配信には長期 immutable キャッシュが付与される
        let asset_req = Request::builder()
            .method(Method::GET)
            .uri("/assets/bundle.js")
            .header(header::ACCEPT_ENCODING, "gzip")
            .body(Body::empty())
            .unwrap();
        let asset_resp = call_router(&mut app, asset_req).await;
        assert_eq!(asset_resp.status(), StatusCode::OK);
        assert_eq!(
            asset_resp
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("public, max-age=31536000, immutable")
        );
        assert_eq!(
            asset_resp
                .headers()
                .get(header::CONTENT_ENCODING)
                .and_then(|v| v.to_str().ok()),
            Some("gzip")
        );

        // 4. 存在しない /assets/* は index.html へフォールバックせず 404 となり immutable も付かない
        let missing_asset_req = Request::builder()
            .method(Method::GET)
            .uri("/assets/missing.js")
            .body(Body::empty())
            .unwrap();
        let missing_asset_resp = call_router(&mut app, missing_asset_req).await;
        assert_eq!(missing_asset_resp.status(), StatusCode::NOT_FOUND);
        assert_ne!(
            missing_asset_resp
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("public, max-age=31536000, immutable")
        );

        // 5. SPA ルートは index.html へフォールバックし no-cache が付与される
        let spa_req = Request::builder()
            .method(Method::GET)
            .uri("/unknown-page")
            .body(Body::empty())
            .unwrap();
        let spa_resp = call_router(&mut app, spa_req).await;
        assert_eq!(spa_resp.status(), StatusCode::OK);
        assert_eq!(
            spa_resp
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("no-cache")
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
