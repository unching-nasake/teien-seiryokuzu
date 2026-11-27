use crate::auth;
use crate::board::{ActionError, ActionKind, ActionMode, Cell};
use crate::db::{begin_immediate, record_player_log_tx_full, war_pair, LOG_VISIBILITY_PUBLIC};
use crate::protocol::{
    encode_action_result, encode_cell_diff_batch, encode_event_json, encode_tick_sync,
    ClientActionMsg, OP_CLIENT_ACTION, OP_CLIENT_PING, OP_SERVER_PONG, OP_SERVER_TICK_SYNC,
    STATUS_ERROR, STATUS_OK, STATUS_WAR_CONFIRM,
};
use crate::season::SeasonPhase;
use crate::state::{
    AppState, CORE_ATTACK_ALERT_COOLDOWN_SECS, MAX_WS_PER_IP, MAX_WS_PER_USER, MAX_WS_TOTAL,
};
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{ConnectInfo, State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use chrono::Utc;
use dashmap::mapref::entry::Entry;
use futures_util::{SinkExt, StreamExt};
use sqlx::Row;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Notify};

/// WebSocket 接続数・IP別・ユーザー別接続数を RAII で管理するガード
struct WsConnectionGuard {
    state: Arc<AppState>,
    ip: String,
    ip_counted: bool,
    user_id: Option<i64>,
    conn_id: Option<u64>,
}

impl WsConnectionGuard {
    /// 認証済みユーザーの個別送信チャネル登録および接続数カウントを即時解除する（重複呼び出し安全）
    fn release_user_slot(&mut self) {
        if let Some(uid) = self.user_id.take() {
            if let Some(conn_id) = self.conn_id.take() {
                self.state.unregister_ws_user_sender(uid, conn_id);
            }
            if let Entry::Occupied(mut entry) = self.state.ws_user_counts.entry(uid) {
                if *entry.get() <= 1 {
                    entry.remove();
                } else {
                    *entry.get_mut() -= 1;
                }
            }
        }
    }
}

impl Drop for WsConnectionGuard {
    fn drop(&mut self) {
        self.state.online_count.fetch_sub(1, Ordering::AcqRel);

        // IP 別接続数を加算済みの場合のみデクリメントし、0 になったらエントリを削除
        if self.ip_counted {
            if let Entry::Occupied(mut entry) = self.state.ws_ip_counts.entry(self.ip.clone()) {
                if *entry.get() <= 1 {
                    entry.remove();
                } else {
                    *entry.get_mut() -= 1;
                }
            }
        }

        // 認証済みユーザー別送信チャネルと接続数をデクリメントし、0 になったらエントリを削除
        self.release_user_slot();
    }
}

/// WebSocket 接続ハンドラ (/ws)
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // シャットダウン処理中は新規 WebSocket 接続を受け付けない
    if state.is_shutting_down() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }

    // Origin ヘッダを検証し、不正なクロスサイト WebSocket 接続を拒否する
    if !auth::is_valid_ws_origin(
        &headers,
        &state.config.allowed_origins,
        state.config.dev_mode,
        state.config.trust_proxy,
        state.config.cookie_secure && !state.config.dev_mode,
    ) {
        return StatusCode::FORBIDDEN.into_response();
    }

    let ip = auth::extract_client_ip(addr, &headers, state.config.trust_proxy);

    // DB セッション照会の前に IP 単位のハンドシェイク・レート制限を適用する
    if !state.ws_handshake_limiter.check_and_consume(&ip) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }

    // DB アクセス前に総接続数・IP別接続数上限をアトミックにチェック＆加算（DoS・TOCTOU 防止）
    if state
        .online_count
        .try_update(Ordering::AcqRel, Ordering::Acquire, |c| {
            if c < MAX_WS_TOTAL {
                Some(c + 1)
            } else {
                None
            }
        })
        .is_err()
    {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }

    // 以降で早期リターンした場合も Drop で確実に減算されるようガードを先に生成する
    let mut guard = WsConnectionGuard {
        state: Arc::clone(&state),
        ip: ip.clone(),
        ip_counted: false,
        user_id: None,
        conn_id: None,
    };

    let ip_ok = match state.ws_ip_counts.entry(ip.clone()) {
        Entry::Occupied(mut entry) => {
            if *entry.get() >= MAX_WS_PER_IP {
                false
            } else {
                *entry.get_mut() += 1;
                true
            }
        }
        Entry::Vacant(entry) => {
            entry.insert(1);
            true
        }
    };
    if !ip_ok {
        // guard の Drop により online_count のみがロールバックされる
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    guard.ip_counted = true;

    let mut token = auth::extract_cookie(&headers, "teien_session");
    let user_id = match token.as_deref() {
        Some(tok) => state.resolve_active_user_session(tok).await,
        None => None,
    };
    if user_id.is_none() {
        // 無効トークンによる後続の不要な DB 照会を抑止するためクリアする
        token = None;
    }

    if let Some(uid) = user_id {
        let user_ok = match state.ws_user_counts.entry(uid) {
            Entry::Occupied(mut entry) => {
                if *entry.get() >= MAX_WS_PER_USER {
                    false
                } else {
                    *entry.get_mut() += 1;
                    true
                }
            }
            Entry::Vacant(entry) => {
                entry.insert(1);
                true
            }
        };
        if !user_ok {
            // guard の Drop により online_count と ws_ip_counts がロールバックされる
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        }
        guard.user_id = Some(uid);
    }

    ws.max_message_size(4096)
        .max_frame_size(4096)
        .on_upgrade(move |socket| handle_socket(socket, state, ip, token, user_id, guard))
        .into_response()
}

/// init_sync 生成直前までに滞留した古い tick_sync を除去しつつ、他の差分・イベントを上限付きで退避する
fn drain_pre_queued_broadcast(
    bcast_rx: &mut tokio::sync::broadcast::Receiver<Bytes>,
    broadcast_tx: &tokio::sync::broadcast::Sender<Bytes>,
) -> Vec<Bytes> {
    const MAX_PRE_QUEUED_BCAST: usize = 256;
    const MAX_PRE_DRAIN_ITERS: usize = 4096;
    let mut pre_queued_bcast: Vec<Bytes> = Vec::new();
    let mut pre_drain_overflow = false;
    let mut drained_to_end = false;
    for _ in 0..MAX_PRE_DRAIN_ITERS {
        match bcast_rx.try_recv() {
            Ok(frame) => {
                if frame.first() != Some(&OP_SERVER_TICK_SYNC) {
                    if pre_queued_bcast.len() >= MAX_PRE_QUEUED_BCAST {
                        pre_drain_overflow = true;
                        break;
                    }
                    pre_queued_bcast.push(frame);
                }
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {
                pre_drain_overflow = true;
                break;
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
            | Err(tokio::sync::broadcast::error::TryRecvError::Closed) => {
                drained_to_end = true;
                break;
            }
        }
    }
    if pre_drain_overflow || !drained_to_end {
        pre_queued_bcast.clear();
        pre_queued_bcast.push(Bytes::from(encode_event_json(r#"{"type":"resync_required"}"#)));
        *bcast_rx = broadcast_tx.subscribe();
    }
    pre_queued_bcast
}

/// セッション失効確定時に登録〜再検証の隙間で積まれた個別イベントと溢れフラグを破棄する
fn discard_pending_direct_events(
    direct_rx: &mut mpsc::Receiver<Bytes>,
    direct_overflowed: &AtomicBool,
) {
    while direct_rx.try_recv().is_ok() {}
    direct_overflowed.store(false, Ordering::Release);
}

async fn handle_socket(
    socket: WebSocket,
    state: Arc<AppState>,
    ip: String,
    mut session_token: Option<String>,
    user_id: Option<i64>,
    mut guard: WsConnectionGuard,
) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (direct_tx, mut direct_rx) = mpsc::channel::<Bytes>(128);
    let direct_overflowed = Arc::new(AtomicBool::new(false));
    let direct_overflow_notify = Arc::new(Notify::new());
    let mut bcast_rx = state.broadcast_tx.subscribe();
    let mut shutdown_rx = state.subscribe_shutdown();

    // ハンドシェイクからアップグレード完了までの TOCTOU を防ぐためセッション有効性と有効期限を再検証する
    let mut last_checked_epoch = state.current_session_cache_epoch();
    let mut active_user_id: Option<i64> = None;
    let mut active_session_exp: Option<i64> = None;
    if let (Some(expected_uid), Some(tok)) = (user_id, session_token.as_deref()) {
        if let Some((uid, exp)) = state.resolve_active_user_session_with_expiry(tok).await {
            if uid == expected_uid {
                active_user_id = Some(expected_uid);
                active_session_exp = Some(exp);
            } else {
                guard.release_user_slot();
                session_token = None;
            }
        } else {
            guard.release_user_slot();
            session_token = None;
        }
    } else if user_id.is_some() {
        guard.release_user_slot();
        session_token = None;
    }

    // 最新の AP を DB から取得し、その直後に個別送信チャネルを登録して init_sync との順序逆転を防ぐ
    let mut init_ap = if let Some(uid) = active_user_id {
        sqlx::query("SELECT ap FROM users WHERE id = ?")
            .bind(uid)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten()
            .map(|r| r.get::<i64, _>("ap").clamp(0, u16::MAX as i64) as u16)
            .unwrap_or(0)
    } else {
        0
    };

    if let (Some(expected_uid), Some(tok), Some(exp)) =
        (active_user_id, session_token.clone(), active_session_exp)
    {
        let conn_id = state.register_ws_user_sender_with_overflow(
            expected_uid,
            tok.clone(),
            exp,
            direct_tx.clone(),
            Arc::clone(&direct_overflowed),
            Arc::clone(&direct_overflow_notify),
        );
        guard.conn_id = Some(conn_id);
        let epoch_after = state.current_session_cache_epoch();
        if epoch_after != last_checked_epoch {
            // 登録直前にセッション無効化が競合した可能性があるため再検証する
            last_checked_epoch = epoch_after;
            if state.resolve_active_user_session(&tok).await != Some(expected_uid) {
                guard.release_user_slot();
                session_token = None;
                active_user_id = None;
                init_ap = 0;
                // 登録〜解除の間に積まれた私的イベントが匿名接続へ漏れないよう破棄する
                discard_pending_direct_events(&mut direct_rx, &direct_overflowed);
            }
        }
    }

    // 全 DB await 完了後・init_sync 生成直前に古い tick_sync を除去し、新旧逆転を防ぐ
    let pre_queued_bcast = drain_pre_queued_broadcast(&mut bcast_rx, &state.broadcast_tx);

    let now = Utc::now();
    let init_sync = encode_tick_sync(
        state.phase_at(now).as_u8(),
        state.tick_number_at(now),
        init_ap,
        state.next_refill_unix_at(now),
        state.current_season_id(),
    );

    // 送信タスク（ダイレクト応答 + 全体ブロードキャストを合流、無通信時は Ping 送信、シャットダウン時は Close 送信）
    let send_overflowed = Arc::clone(&direct_overflowed);
    let send_overflow_notify = Arc::clone(&direct_overflow_notify);
    let mut send_task = tokio::spawn(async move {
        const SEND_TIMEOUT: Duration = Duration::from_secs(10);
        const PING_INTERVAL: Duration = Duration::from_secs(30);
        if *shutdown_rx.borrow() {
            let _ = tokio::time::timeout(SEND_TIMEOUT, ws_sender.send(Message::Close(None))).await;
            return;
        }
        // 初期同期フレームを先頭で直接送信し、その後に接続直前の退避フレームを順序通り送る（シャットダウン監視付き）
        for msg in std::iter::once(Bytes::from(init_sync)).chain(pre_queued_bcast) {
            tokio::select! {
                res = shutdown_rx.changed() => {
                    if res.is_err() || *shutdown_rx.borrow() {
                        let _ = tokio::time::timeout(SEND_TIMEOUT, ws_sender.send(Message::Close(None))).await;
                        return;
                    }
                }
                send_res = tokio::time::timeout(SEND_TIMEOUT, ws_sender.send(Message::Binary(msg.to_vec()))) => {
                    match send_res {
                        Ok(Ok(())) => {}
                        _ => return,
                    }
                }
            }
        }
        // ブロードキャスト受信でタイマーがリセットされないよう interval を使用する
        let mut ping_interval = tokio::time::interval(PING_INTERVAL);
        ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ping_interval.tick().await;
        loop {
            if send_overflowed.swap(false, Ordering::AcqRel) {
                // direct_tx は個別イベント専用のため、盤面全再取得ではなくメタデータ再同期のみを促す
                let msg = encode_event_json(r#"{"type":"metadata_resync_required"}"#);
                match tokio::time::timeout(SEND_TIMEOUT, ws_sender.send(Message::Binary(msg))).await {
                    Ok(Ok(())) => {}
                    _ => break,
                }
            }
            tokio::select! {
                res = shutdown_rx.changed() => {
                    if res.is_err() || *shutdown_rx.borrow() {
                        let _ = tokio::time::timeout(SEND_TIMEOUT, ws_sender.send(Message::Close(None))).await;
                        break;
                    }
                }
                _ = send_overflow_notify.notified() => {}
                Some(payload) = direct_rx.recv() => {
                    match tokio::time::timeout(SEND_TIMEOUT, ws_sender.send(Message::Binary(payload.to_vec()))).await {
                        Ok(Ok(())) => {}
                        _ => break,
                    }
                }
                res = bcast_rx.recv() => {
                    match res {
                        Ok(payload) => {
                            match tokio::time::timeout(SEND_TIMEOUT, ws_sender.send(Message::Binary(payload.to_vec()))).await {
                                Ok(Ok(())) => {}
                                _ => break,
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            let msg = encode_event_json(r#"{"type":"resync_required"}"#);
                            match tokio::time::timeout(SEND_TIMEOUT, ws_sender.send(Message::Binary(msg))).await {
                                Ok(Ok(())) => {}
                                _ => break,
                            }
                        }
                        Err(_) => break,
                    }
                }
                _ = ping_interval.tick() => {
                    // 30秒ごとに WebSocket Ping を送信して死活監視する
                    match tokio::time::timeout(SEND_TIMEOUT, ws_sender.send(Message::Ping(vec![]))).await {
                        Ok(Ok(())) => {}
                        _ => break,
                    }
                }
            }
        }
    });

    // PING スロットリング用の最終受信時刻
    let mut last_ping_at: Option<Instant> = None;
    // 連続無効・未知フレームの上限カウント（過負荷・タイムアウト延長攻撃防止）
    const MAX_INVALID_WS_FRAMES: u32 = 20;
    let mut invalid_frame_count: u32 = 0;
    // 30秒ごとの定期セッション再検証タイマー
    let mut session_check_interval = tokio::time::interval(Duration::from_secs(30));
    session_check_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    session_check_interval.tick().await;
    // セッション失効の即時通知待機
    let invalidation_notified = state.session_invalidation_notify.notified();
    tokio::pin!(invalidation_notified);
    // 65秒無通信タイムアウト用の期限（セッション検証タイマー発火ではリセットしない）
    let mut idle_deadline = tokio::time::Instant::now() + Duration::from_secs(65);

    // 受信ループ（send_task 終了、65秒無通信タイムアウト、または受信終了で即座に終了する）
    loop {
        invalidation_notified.as_mut().enable();
        let current_epoch = state.current_session_cache_epoch();
        if session_token.is_some() && current_epoch != last_checked_epoch {
            last_checked_epoch = current_epoch;
            let valid = match (session_token.as_deref(), active_user_id) {
                (Some(tok), Some(expected_uid)) => {
                    state.resolve_active_user_session(tok).await == Some(expected_uid)
                }
                _ => false,
            };
            if !valid {
                guard.release_user_slot();
                session_token = None;
                active_user_id = None;
            }
        }

        let next_msg = tokio::select! {
            _ = &mut send_task => break,
            _ = &mut invalidation_notified, if session_token.is_some() => {
                invalidation_notified.set(state.session_invalidation_notify.notified());
                invalidation_notified.as_mut().enable();
                last_checked_epoch = state.current_session_cache_epoch();
                let valid = match (session_token.as_deref(), active_user_id) {
                    (Some(tok), Some(expected_uid)) => {
                        state.resolve_active_user_session(tok).await == Some(expected_uid)
                    }
                    _ => false,
                };
                if !valid {
                    guard.release_user_slot();
                    session_token = None;
                    active_user_id = None;
                }
                continue;
            }
            _ = session_check_interval.tick(), if session_token.is_some() => {
                last_checked_epoch = state.current_session_cache_epoch();
                let valid = match (session_token.as_deref(), active_user_id) {
                    (Some(tok), Some(expected_uid)) => {
                        state.resolve_active_user_session(tok).await == Some(expected_uid)
                    }
                    _ => false,
                };
                if !valid {
                    // ログアウト・有効期限切れ等を検知した時点で個別送信チャネルと接続枠を即時解除する
                    guard.release_user_slot();
                    session_token = None;
                    active_user_id = None;
                }
                continue;
            }
            res = tokio::time::timeout_at(idle_deadline, ws_receiver.next()) => {
                match res {
                    Ok(msg) => msg,
                    Err(_) => break,
                }
            }
        };
        let Some(Ok(msg)) = next_msg else {
            break;
        };
        match msg {
            Message::Binary(data) => {
                if data.is_empty() {
                    invalid_frame_count += 1;
                    if invalid_frame_count >= MAX_INVALID_WS_FRAMES {
                        break;
                    }
                    continue;
                }
                match data[0] {
                    OP_CLIENT_PING => {
                        if data.len() != 1 {
                            invalid_frame_count += 1;
                            if invalid_frame_count >= MAX_INVALID_WS_FRAMES {
                                break;
                            }
                            continue;
                        }
                        // 前回 PING から 2 秒未満の場合は無視して負荷を抑制する
                        let now = Instant::now();
                        if last_ping_at
                            .map(|prev| now.duration_since(prev) < Duration::from_secs(2))
                            .unwrap_or(false)
                        {
                            continue;
                        }
                        last_ping_at = Some(now);
                        invalid_frame_count = 0;
                        idle_deadline = tokio::time::Instant::now() + Duration::from_secs(65);
                        // キャッシュ世代が変化していれば即座にセッション有効性を再検証する
                        if let Some(tok) = session_token.as_deref() {
                            let current_epoch = state.current_session_cache_epoch();
                            if current_epoch != last_checked_epoch {
                                last_checked_epoch = current_epoch;
                                let valid = active_user_id.is_some()
                                    && state.resolve_active_user_session(tok).await
                                        == active_user_id;
                                if !valid {
                                    guard.release_user_slot();
                                    session_token = None;
                                    active_user_id = None;
                                }
                            }
                        }
                        if direct_tx.send(Bytes::from_static(&[OP_SERVER_PONG])).await.is_err() {
                            break;
                        }
                    }
                    OP_CLIENT_ACTION => {
                        // デコードや DB セッション解決の前に IP レートリミットを検証し、不正バイナリ連打も即拒否する
                        if !state.ip_limiter.check_and_consume(&ip) {
                            if direct_tx
                                .send(Bytes::from(encode_action_result(
                                    STATUS_ERROR,
                                    0,
                                    0,
                                    0,
                                    "操作が速すぎます。少し待ってから再試行してください",
                                )))
                                .await
                                .is_err()
                            {
                                break;
                            }
                            continue;
                        }
                        let Some(action) = ClientActionMsg::decode(&data) else {
                            invalid_frame_count += 1;
                            if direct_tx
                                .send(Bytes::from(encode_action_result(
                                    STATUS_ERROR,
                                    0,
                                    0,
                                    0,
                                    "不正なバイナリ形式",
                                )))
                                .await
                                .is_err()
                            {
                                break;
                            }
                            if invalid_frame_count >= MAX_INVALID_WS_FRAMES {
                                break;
                            }
                            continue;
                        };
                        invalid_frame_count = 0;
                        idle_deadline = tokio::time::Instant::now() + Duration::from_secs(65);
                        // アクション実行ごとにセッションの有効性を再検証する
                        last_checked_epoch = state.current_session_cache_epoch();
                        let resolved_uid = match session_token.as_deref() {
                            Some(tok) => state.resolve_active_user_session(tok).await,
                            None => None,
                        };
                        let valid_uid = match (resolved_uid, active_user_id) {
                            (Some(uid), Some(expected_uid)) if uid == expected_uid => Some(uid),
                            _ => None,
                        };
                        let Some(uid) = valid_uid else {
                            // セッション失効を検知した時点で個別送信チャネルとユーザー接続枠を即時解除し匿名化する
                            guard.release_user_slot();
                            session_token = None;
                            active_user_id = None;
                            if direct_tx
                                .send(Bytes::from(encode_action_result(
                                    STATUS_ERROR,
                                    0,
                                    0,
                                    0,
                                    "操作にはログインが必要です",
                                )))
                                .await
                                .is_err()
                            {
                                break;
                            }
                            continue;
                        };
                        let reply = process_cell_action_inner(&state, &ip, uid, action, false).await;
                        if direct_tx.send(Bytes::from(reply)).await.is_err() {
                            break;
                        }
                    }
                    _ => {
                        invalid_frame_count += 1;
                        if invalid_frame_count >= MAX_INVALID_WS_FRAMES {
                            break;
                        }
                    }
                }
            }
            Message::Ping(_) | Message::Pong(_) => {
                idle_deadline = tokio::time::Instant::now() + Duration::from_secs(65);
            }
            Message::Close(_) => break,
            Message::Text(_) => {
                invalid_frame_count += 1;
                if invalid_frame_count >= MAX_INVALID_WS_FRAMES {
                    break;
                }
            }
        }
    }

    send_task.abort();
}

/// セル操作を検証・適用し、結果バイナリフレームを返す
#[cfg(test)]
pub(crate) async fn process_cell_action(
    state: &AppState,
    ip: &str,
    user_id: Option<i64>,
    msg: ClientActionMsg,
) -> Vec<u8> {
    let Some(uid) = user_id else {
        return encode_action_result(STATUS_ERROR, 0, 0, 0, "操作にはログインが必要です");
    };
    process_cell_action_for_user(state, ip, uid, msg).await
}

/// 指定ユーザー ID に対してセル操作を検証・DB 永続化・盤面反映する
#[cfg(test)]
pub(crate) async fn process_cell_action_for_user(
    state: &AppState,
    ip: &str,
    uid: i64,
    msg: ClientActionMsg,
) -> Vec<u8> {
    process_cell_action_inner(state, ip, uid, msg, true).await
}

/// セル操作の内部実装（WS 経由では既に IP レートリミットを消費済みのため check_ip_limit=false を渡す）
async fn process_cell_action_inner(
    state: &AppState,
    ip: &str,
    uid: i64,
    msg: ClientActionMsg,
    check_ip_limit: bool,
) -> Vec<u8> {
    // 1. IP / アカウント単位レートリミット (10 req/sec)
    if (check_ip_limit && !state.ip_limiter.check_and_consume(ip))
        || !state.account_limiter.check_and_consume(&uid.to_string())
    {
        return encode_action_result(
            STATUS_ERROR,
            0,
            0,
            0,
            "リクエスト制限を超過しました (最大 10 req/sec)",
        );
    }

    // 1.5. Recolor（コスト0）の連打による負荷・DB肥大化を専用リミッターで抑制する
    if matches!(msg.mode, ActionMode::Recolor)
        && !state.recolor_limiter.check_and_consume(&uid.to_string())
    {
        return encode_action_result(
            STATUS_ERROR,
            0,
            0,
            0,
            "色変更の操作が速すぎます。少し待ってから再試行してください",
        );
    }

    // 2. 開催フェーズのみ打設・上書き・色変更を許可
    if state.current_phase() != SeasonPhase::Active {
        let phase_msg = match state.current_phase() {
            SeasonPhase::Preparation => "準備フェーズ中はドットを塗れません",
            SeasonPhase::Frozen => "盤面が凍結されているため操作できません",
            SeasonPhase::Active => "",
        };
        return encode_action_result(STATUS_ERROR, 0, 0, 0, phase_msg);
    }

    // 3. ミューテックス取得前に board.read() で明らかな範囲外・海マス・不正カラーを早期弾きする
    {
        let board = state.board.read();
        let x = msg.x as usize;
        let y = msg.y as usize;
        if x >= board.size || y >= board.size {
            return encode_action_result(STATUS_ERROR, 0, 0, 0, "盤面範囲外です");
        }
        let cell = board.cells[board.idx(x, y)];
        if !cell.is_land() {
            return encode_action_result(STATUS_ERROR, 0, 0, 0, "海マスは塗れません");
        }
        if matches!(msg.mode, ActionMode::Recolor) && msg.color_id >= 64 {
            return encode_action_result(STATUS_ERROR, 0, 0, 0, "無効なカラーIDです (0..63)");
        }
    }

    // 4. 操作を直列化し、TOCTOU による二重消費や盤面・DB 不整合を防止する
    let _action_guard = state.action_mutex.lock().await;

    // ロック取得後にフェーズが凍結等へ切り替わっていないか再検証する
    if state.current_phase() != SeasonPhase::Active {
        let phase_msg = match state.current_phase() {
            SeasonPhase::Preparation => "準備フェーズ中はドットを塗れません",
            SeasonPhase::Frozen => "盤面が凍結されているため操作できません",
            SeasonPhase::Active => "",
        };
        return encode_action_result(STATUS_ERROR, 0, 0, 0, phase_msg);
    }

    let season_id = state.current_season_id();
    let cost_cfg = state.current_cost_config();
    let rules_cfg = state.current_game_rules();

    // 5. BEGIN IMMEDIATE トランザクションを開始し、他書き込み API との競合（SQLITE_BUSY_SNAPSHOT）を防止する
    let mut tx = match begin_immediate(&state.pool).await {
        Ok(tx) => tx,
        Err(e) => {
            tracing::error!("トランザクション開始に失敗しました: {}", e);
            return encode_action_result(
                STATUS_ERROR,
                0,
                0,
                0,
                "サーバー内部エラーが発生しました",
            );
        }
    };

    // ユーザー・所属勢力・メンバー権限を 1 回の LEFT JOIN クエリで一括取得し DB ラウンドトリップを削減
    let info_row = match sqlx::query(
        r#"
        SELECT
            u.ap, u.faction_id, u.username,
            f.id AS f_id, f.name AS f_name, f.color_id AS f_color_id,
            f.leader_user_id AS f_leader_user_id, f.initial_core_used AS f_initial_core_used,
            f.is_extinct AS f_is_extinct,
            fm.is_vice_leader AS fm_is_vice_leader, fm.can_declare_war AS fm_can_declare_war
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
        Ok(None) => {
            return encode_action_result(STATUS_ERROR, 0, 0, 0, "ユーザー情報が見つかりません");
        }
        Err(e) => {
            tracing::error!("ユーザー・勢力情報取得に失敗しました: {}", e);
            return encode_action_result(
                STATUS_ERROR,
                0,
                0,
                0,
                "サーバー内部エラーが発生しました",
            );
        }
    };

    let current_ap: i64 = info_row.get("ap");
    let current_ap_u16 = current_ap.clamp(0, u16::MAX as i64) as u16;
    let my_faction_i64: i64 = info_row.get("faction_id");
    let username: String = info_row.get("username");

    if my_faction_i64 <= 0 {
        return encode_action_result(
            STATUS_ERROR,
            current_ap_u16,
            0,
            0,
            "先に勢力を設立または勢力へ参加してください",
        );
    }
    let Ok(my_faction_id) = u16::try_from(my_faction_i64) else {
        return encode_action_result(STATUS_ERROR, current_ap_u16, 0, 0, "不正な勢力IDです");
    };

    let Some(_) = info_row.try_get::<Option<i64>, _>("f_id").ok().flatten() else {
        return encode_action_result(
            STATUS_ERROR,
            current_ap_u16,
            0,
            0,
            "現シーズンの所属勢力が見つかりません",
        );
    };

    let faction_name: String = info_row.get("f_name");
    let faction_color_id = info_row.get::<i64, _>("f_color_id").clamp(0, 63) as u8;
    let leader_user_id: i64 = info_row.get("f_leader_user_id");
    let initial_core_used: i64 = info_row.get("f_initial_core_used");
    let was_extinct: i64 = info_row.get("f_is_extinct");

    let is_leader_or_vice = leader_user_id == uid
        || info_row
            .try_get::<Option<i64>, _>("fm_is_vice_leader")
            .ok()
            .flatten()
            .is_some_and(|v| v != 0);

    let can_declare_war = is_leader_or_vice
        || info_row
            .try_get::<Option<i64>, _>("fm_can_declare_war")
            .ok()
            .flatten()
            .is_some_and(|v| v != 0);

    // ActionMode::Paint の最小コストは常に 1 AP 以上のため、保有 AP が 0 以下なら盤面評価前に早期リターンする
    if matches!(msg.mode, ActionMode::Paint) && current_ap <= 0 {
        return encode_action_result(
            STATUS_ERROR,
            current_ap_u16,
            0,
            0,
            &format!("APが不足しています（保有: {} AP）", current_ap),
        );
    }

    // 6. board.read() ロック内でアクションを評価し、コストと対象勢力を確定する（write ロックは取らない）
    let (eval, prev_cell) = {
        let board = state.board.read();
        let ev = match board.evaluate_action_with_all(
            msg.x as usize,
            msg.y as usize,
            my_faction_id,
            msg.mode,
            msg.color_id,
            &cost_cfg,
            &rules_cfg,
        ) {
            Ok(ev) => ev,
            Err(err) => {
                return encode_action_result(
                    STATUS_ERROR,
                    current_ap_u16,
                    0,
                    0,
                    &action_error_text(&err, rules_cfg.max_layers),
                );
            }
        };
        let idx = board.idx(msg.x as usize, msg.y as usize);
        (ev, board.cells[idx])
    };

    let cost_i64 = eval.cost as i64;
    if current_ap < cost_i64 {
        return encode_action_result(
            STATUS_ERROR,
            current_ap_u16,
            0,
            eval.cost,
            &format!(
                "APが不足しています（必要: {} AP / 保有: {} AP）",
                eval.cost, current_ap
            ),
        );
    }

    // 7. 敵マス上書き時の戦争状態・開戦権限チェック
    let mut newly_declared_war: Option<u16> = None;
    if matches!(
        eval.kind,
        ActionKind::CaptureEnemyNormal | ActionKind::CaptureEnemyCore
    ) {
        let (fa, fb) = war_pair(my_faction_id, eval.target_faction);
        let at_war = match sqlx::query(
            "SELECT 1 FROM diplomacy_wars WHERE season_id = ? AND faction_a = ? AND faction_b = ?",
        )
        .bind(season_id)
        .bind(fa)
        .bind(fb)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(r) => r.is_some(),
            Err(e) => {
                tracing::error!("外交状態確認に失敗しました: {}", e);
                return encode_action_result(
                    STATUS_ERROR,
                    current_ap_u16,
                    0,
                    0,
                    "サーバー内部エラーが発生しました",
                );
            }
        };

        if !at_war {
            if !can_declare_war {
                return encode_action_result(
                    STATUS_ERROR,
                    current_ap_u16,
                    eval.target_faction,
                    eval.cost,
                    "非戦争状態の勢力への攻撃には開戦権限が必要です",
                );
            }
            if !msg.confirm_war {
                return encode_action_result(
                    STATUS_WAR_CONFIRM,
                    current_ap_u16,
                    eval.target_faction,
                    eval.cost,
                    "非戦争状態の勢力マスを上書きすると即座に開戦します",
                );
            }
            newly_declared_war = Some(eval.target_faction);
        }
    }

    // 8. 条件付き UPDATE で AP を厳密に消費する（コスト0の操作では更新をスキップ）
    let new_ap = if cost_i64 == 0 {
        current_ap
    } else {
        let res = sqlx::query("UPDATE users SET ap = ap - ? WHERE id = ? AND ap >= ?")
            .bind(cost_i64)
            .bind(uid)
            .bind(cost_i64)
            .execute(&mut *tx)
            .await;
        match res {
            Ok(r) if r.rows_affected() == 1 => current_ap - cost_i64,
            Ok(_) => {
                return encode_action_result(
                    STATUS_ERROR,
                    current_ap_u16,
                    0,
                    0,
                    "APが不足しています",
                );
            }
            Err(e) => {
                tracing::error!("AP更新に失敗しました: {}", e);
                return encode_action_result(
                    STATUS_ERROR,
                    current_ap_u16,
                    0,
                    0,
                    "サーバー内部エラーが発生しました",
                );
            }
        }
    };

    // 9. 初期中核・領土統計・外交・行動ログをトランザクション内で更新し、全エラーを検証する
    let initial_core_remaining = initial_core_used >= 0
        && (initial_core_used as u64) < (rules_cfg.initial_core_quota as u64);
    // 自勢力の有効な旧中核履歴がある空き地を再占領する場合は初期中核枠を消費しない
    let is_reclaiming_old_core =
        prev_cell.old_core_faction == my_faction_id && prev_cell.old_core_ttl() > 0;
    let will_consume_initial_core = matches!(
        eval.kind,
        ActionKind::ClaimNeutral | ActionKind::CaptureEnemyNormal
    ) && initial_core_remaining
        && !is_reclaiming_old_core
        && !prev_cell.is_core();

    if will_consume_initial_core {
        let res = sqlx::query(
            "UPDATE factions SET initial_core_used = initial_core_used + 1 WHERE id = ? AND initial_core_used < ?",
        )
        .bind(my_faction_i64)
        .bind(rules_cfg.initial_core_quota as i64)
        .execute(&mut *tx)
        .await;
        match res {
            Ok(r) if r.rows_affected() == 1 => {}
            Ok(_) => {
                return encode_action_result(
                    STATUS_ERROR,
                    current_ap_u16,
                    0,
                    0,
                    "初期中核枠の上限に達しています",
                );
            }
            Err(e) => {
                tracing::error!("初期中核更新に失敗しました: {}", e);
                return encode_action_result(
                    STATUS_ERROR,
                    current_ap_u16,
                    0,
                    0,
                    "サーバー内部エラーが発生しました",
                );
            }
        }
    }

    // ログ文言や core_count 増減のため、適用後のセル状態を事前算出する
    let next_layers_preview = prev_cell.layers.saturating_add(1).min(rules_cfg.max_layers);
    let next_is_core_preview = predict_next_is_core(
        eval.kind,
        prev_cell,
        my_faction_id,
        will_consume_initial_core,
    );

    // 相手領土の奪取・開戦通知向けに相手勢力名を事前取得する
    let prev_faction_name: Option<String> =
        if prev_cell.faction_id != 0 && prev_cell.faction_id != my_faction_id {
            match sqlx::query_scalar::<_, String>(
                "SELECT name FROM factions WHERE id = ? AND season_id = ?",
            )
            .bind(prev_cell.faction_id as i64)
            .bind(season_id)
            .fetch_optional(&mut *tx)
            .await
            {
                Ok(opt) => Some(opt.unwrap_or_else(|| format!("勢力#{}", prev_cell.faction_id))),
                Err(e) => {
                    tracing::error!("相手勢力名の取得に失敗しました: {}", e);
                    return encode_action_result(
                        STATUS_ERROR,
                        current_ap_u16,
                        0,
                        0,
                        "サーバー内部エラーが発生しました",
                    );
                }
            }
        } else {
            None
        };

    // Recolor はコスト0のため DB 肥大化とログフラッディング防止のため行動ログ記録を省略する
    if !matches!(eval.kind, ActionKind::Recolor) {
        let action_desc = match eval.kind {
            ActionKind::ClaimNeutral => {
                if will_consume_initial_core {
                    format!(
                        "({}, {}) の空き地を塗った（初期中核 / -{} AP）",
                        msg.x, msg.y, eval.cost
                    )
                } else if is_reclaiming_old_core {
                    format!(
                        "({}, {}) の空き地を塗った（中核復活 / -{} AP）",
                        msg.x, msg.y, eval.cost
                    )
                } else {
                    format!("({}, {}) の空き地を塗った (-{} AP)", msg.x, msg.y, eval.cost)
                }
            }
            ActionKind::Reinforce => format!(
                "({}, {}) を重ね塗りした ({}層 / -{} AP)",
                msg.x, msg.y, next_layers_preview, eval.cost
            ),
            ActionKind::Recolor => unreachable!(),
            ActionKind::CaptureEnemyNormal => {
                let target_name = prev_faction_name
                    .as_deref()
                    .unwrap_or("相手");
                if next_is_core_preview && is_reclaiming_old_core {
                    format!(
                        "({}, {}) の「{}」領土を奪った（中核復活 / -{} AP）",
                        msg.x, msg.y, target_name, eval.cost
                    )
                } else if will_consume_initial_core {
                    format!(
                        "({}, {}) の「{}」領土を奪った（初期中核 / -{} AP）",
                        msg.x, msg.y, target_name, eval.cost
                    )
                } else {
                    format!(
                        "({}, {}) の「{}」領土を奪った (-{} AP)",
                        msg.x, msg.y, target_name, eval.cost
                    )
                }
            }
            ActionKind::CaptureEnemyCore => {
                let target_name = prev_faction_name
                    .as_deref()
                    .unwrap_or("相手");
                format!(
                    "({}, {}) の「{}」中核を奪った (-{} AP)",
                    msg.x, msg.y, target_name, eval.cost
                )
            }
        };
        let target_fid_for_log = match eval.kind {
            ActionKind::CaptureEnemyNormal | ActionKind::CaptureEnemyCore => {
                prev_cell.faction_id as i64
            }
            _ => 0,
        };
        if let Err(e) = record_player_log_tx_full(
            &mut tx,
            season_id,
            uid,
            &username,
            my_faction_i64,
            target_fid_for_log,
            "territory",
            &action_desc,
            LOG_VISIBILITY_PUBLIC,
        )
        .await
        {
            tracing::error!("行動ログ保存に失敗しました: {}", e);
            return encode_action_result(
                STATUS_ERROR,
                current_ap_u16,
                0,
                0,
                "サーバー内部エラーが発生しました",
            );
        }
    }

    let terr_delta_self: i64 = if prev_cell.faction_id != my_faction_id { 1 } else { 0 };
    let core_delta_self: i64 = match (
        prev_cell.faction_id == my_faction_id && prev_cell.is_core(),
        next_is_core_preview,
    ) {
        (false, true) => 1,
        (true, false) => -1,
        _ => 0,
    };
    if terr_delta_self != 0 || core_delta_self != 0 {
        if let Err(e) = sqlx::query(
            "UPDATE factions SET territory_count = MAX(0, territory_count + ?), core_count = MAX(0, core_count + ?), is_extinct = CASE WHEN ? > 0 THEN 0 ELSE is_extinct END, ever_had_territory = CASE WHEN ? > 0 THEN 1 ELSE ever_had_territory END WHERE id = ?",
        )
        .bind(terr_delta_self)
        .bind(core_delta_self)
        .bind(terr_delta_self)
        .bind(terr_delta_self)
        .bind(my_faction_i64)
        .execute(&mut *tx)
        .await
        {
            tracing::error!("自勢力統計の更新に失敗しました: {}", e);
            return encode_action_result(
                STATUS_ERROR,
                current_ap_u16,
                0,
                0,
                "サーバー内部エラーが発生しました",
            );
        }
    }

    if prev_cell.faction_id != 0 && prev_cell.faction_id != my_faction_id {
        let prev_core_loss: i64 = if prev_cell.is_core() { 1 } else { 0 };
        if let Err(e) = sqlx::query(
            "UPDATE factions SET territory_count = MAX(0, territory_count - 1), core_count = MAX(0, core_count - ?) WHERE id = ?",
        )
        .bind(prev_core_loss)
        .bind(prev_cell.faction_id as i64)
        .execute(&mut *tx)
        .await
        {
            tracing::error!("相手勢力統計の更新に失敗しました: {}", e);
            return encode_action_result(
                STATUS_ERROR,
                current_ap_u16,
                0,
                0,
                "サーバー内部エラーが発生しました",
            );
        }
    }

    if was_extinct != 0 && terr_delta_self > 0 {
        if let Err(e) = record_player_log_tx_full(
            &mut tx,
            season_id,
            uid,
            &username,
            my_faction_i64,
            0,
            "faction",
            &format!("勢力「{}」が滅亡から再起した", faction_name),
            LOG_VISIBILITY_PUBLIC,
        )
        .await
        {
            tracing::error!("再起ログ保存に失敗しました: {}", e);
            return encode_action_result(
                STATUS_ERROR,
                current_ap_u16,
                0,
                0,
                "サーバー内部エラーが発生しました",
            );
        }
    }

    let mut newly_declared_war_defender_name: Option<String> = None;
    if let Some(target_fid) = newly_declared_war {
        let (fa, fb) = war_pair(my_faction_id, target_fid);
        let now = Utc::now().to_rfc3339();
        if let Err(e) = sqlx::query(
            "INSERT OR IGNORE INTO diplomacy_wars (season_id, faction_a, faction_b, started_at) VALUES (?, ?, ?, ?)",
        )
        .bind(season_id)
        .bind(fa)
        .bind(fb)
        .bind(&now)
        .execute(&mut *tx)
        .await
        {
            tracing::error!("戦争状態の登録に失敗しました: {}", e);
            return encode_action_result(
                STATUS_ERROR,
                current_ap_u16,
                0,
                0,
                "サーバー内部エラーが発生しました",
            );
        }

        // 開戦通知・ログ用に防御側の勢力名を取得する
        let defender_name = prev_faction_name
            .clone()
            .unwrap_or_else(|| format!("勢力#{}", target_fid));
        newly_declared_war_defender_name = Some(defender_name.clone());

        if let Err(e) = sqlx::query(
            "DELETE FROM ceasefire_proposals WHERE season_id = ? AND ((from_faction_id = ? AND to_faction_id = ?) OR (from_faction_id = ? AND to_faction_id = ?))",
        )
        .bind(season_id)
        .bind(my_faction_i64)
        .bind(target_fid as i64)
        .bind(target_fid as i64)
        .bind(my_faction_i64)
        .execute(&mut *tx)
        .await
        {
            tracing::error!("停戦提案の削除に失敗しました: {}", e);
            return encode_action_result(
                STATUS_ERROR,
                current_ap_u16,
                0,
                0,
                "サーバー内部エラーが発生しました",
            );
        }

        if let Err(e) = record_player_log_tx_full(
            &mut tx,
            season_id,
            uid,
            &username,
            my_faction_i64,
            target_fid as i64,
            "diplomacy",
            &format!("勢力「{}」へ宣戦布告した", defender_name),
            LOG_VISIBILITY_PUBLIC,
        )
        .await
        {
            tracing::error!("外交ログ保存に失敗しました: {}", e);
            return encode_action_result(
                STATUS_ERROR,
                current_ap_u16,
                0,
                0,
                "サーバー内部エラーが発生しました",
            );
        }
    }

    // 9.5 中核マス奪取時の被害勢力メンバー向けアラート送信先を収集（30秒クールダウン付き）
    let core_attack_recipients: Vec<i64> = if eval.kind == ActionKind::CaptureEnemyCore
        && prev_cell.faction_id != 0
        && prev_cell.faction_id != my_faction_id
    {
        let on_cooldown = state
            .core_attack_alert_cooldown
            .get(&(prev_cell.faction_id, my_faction_id))
            .is_some_and(|t| {
                t.elapsed() < std::time::Duration::from_secs(CORE_ATTACK_ALERT_COOLDOWN_SECS)
            });
        if on_cooldown {
            Vec::new()
        } else {
            match sqlx::query_scalar::<_, i64>(
                "SELECT user_id FROM faction_members WHERE faction_id = ?",
            )
            .bind(prev_cell.faction_id as i64)
            .fetch_all(&mut *tx)
            .await
            {
                Ok(uids) => uids,
                Err(e) => {
                    tracing::error!("中核マス奪取通知先の取得に失敗しました: {}", e);
                    Vec::new()
                }
            }
        }
    } else {
        Vec::new()
    };

    // 10. トランザクションをコミットし、完全成功後のみ盤面へ O(1) 反映する
    if let Err(e) = tx.commit().await {
        tracing::error!("DB保存に失敗しました: {}", e);
        return encode_action_result(
            STATUS_ERROR,
            current_ap_u16,
            0,
            0,
            "サーバー内部エラーが発生しました",
        );
    }

    let ((applied_cell, _), board_ver) = {
        let mut board = state.board.write();
        let res = board.apply_evaluated_action_with_rules(
            msg.x as usize,
            msg.y as usize,
            my_faction_id,
            faction_color_id,
            msg.color_id,
            eval,
            will_consume_initial_core,
            &rules_cfg,
        );
        // 盤面更新と同一ロック内でバージョンを原子的に進める
        let (start_ver, _end_ver) = state.bump_board_version_n(1);
        (res, start_ver)
    };
    // スナップショットキャッシュは board_snapshot 側がバージョン一致で自動検証するため単セル塗抹時は破棄不要
    if terr_delta_self != 0
        || core_delta_self != 0
        || was_extinct != 0
        || will_consume_initial_core
        || (prev_cell.faction_id != 0 && prev_cell.faction_id != my_faction_id)
    {
        state.invalidate_factions_cache();
    }

    if let Some(target_fid) = newly_declared_war {
        let defender_name = newly_declared_war_defender_name
            .unwrap_or_else(|| format!("勢力#{}", target_fid));
        let war_event = serde_json::json!({
            "type": "war_declared",
            "attacker_faction_id": my_faction_id,
            "attacker_name": faction_name,
            "defender_faction_id": target_fid,
            "defender_name": defender_name,
            "by_user": username,
        });
        state.broadcast_frame(encode_event_json(&war_event.to_string()));
    }

    // 中核マス奪取アラート（被害勢力メンバーへ通知、実際に1接続以上へ配信できた場合のみクールダウン記録）
    if !core_attack_recipients.is_empty() {
        let core_event = serde_json::json!({
            "type": "core_attacked",
            "defender_faction_id": prev_cell.faction_id,
            "attacker_faction_id": my_faction_id,
            "attacker_name": faction_name,
            "x": msg.x,
            "y": msg.y,
        });
        let delivered = state.send_event_to_users(
            &core_attack_recipients,
            encode_event_json(&core_event.to_string()),
        );
        if delivered > 0 {
            state
                .core_attack_alert_cooldown
                .insert((prev_cell.faction_id, my_faction_id), std::time::Instant::now());
        }
    }

    // 滅亡からの再起通知
    if was_extinct != 0 && terr_delta_self > 0 {
        let revive_event = serde_json::json!({
            "type": "faction_revived",
            "faction_id": my_faction_id,
            "faction_name": faction_name,
        });
        state.broadcast_frame(encode_event_json(&revive_event.to_string()));
    }

    // 新バージョン付きの差分を全クライアントへバイナリブロードキャスト
    let diff = encode_cell_diff_batch(board_ver, &[(msg.x, msg.y, applied_cell)]);
    state.broadcast_frame(diff);

    encode_action_result(
        STATUS_OK,
        new_ap.clamp(0, u16::MAX as i64) as u16,
        0,
        eval.cost,
        "",
    )
}

/// 適用後のセルが中核ドットになるかを事前判定する
fn predict_next_is_core(
    kind: ActionKind,
    prev: Cell,
    my_faction_id: u16,
    initial_core_remaining: bool,
) -> bool {
    match kind {
        ActionKind::ClaimNeutral => {
            initial_core_remaining
                || (prev.old_core_faction == my_faction_id && prev.old_core_ttl() > 0)
        }
        ActionKind::Reinforce | ActionKind::Recolor => prev.is_core(),
        ActionKind::CaptureEnemyNormal | ActionKind::CaptureEnemyCore => {
            !prev.is_core() && prev.old_core_faction == my_faction_id && prev.old_core_ttl() > 0
        }
    }
}

fn action_error_text(err: &ActionError, max_layers: u8) -> String {
    match err {
        ActionError::OutOfBounds => "盤面範囲外です".to_string(),
        ActionError::SeaTile => "海マスは塗れません".to_string(),
        ActionError::InvalidColor => "無効なカラーIDです (0..63)".to_string(),
        ActionError::MaxLayersReached => format!("重ね塗りは最大{}層までです", max_layers),
        ActionError::NotOwnedForRecolor => "自勢力のマスのみ色変更できます".to_string(),
        ActionError::SameColor => "現在と同じ色です".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::{ActionMode, Board};
    use crate::config::Config;
    use crate::db::init_memory_db;
    use crate::map_gen::MapGenParams;
    use crate::protocol::ClientActionMsg;
    use std::path::PathBuf;

    /// テスト用のデフォルト Config を生成する
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
            allowed_origins: vec![],
        }
    }

    #[tokio::test]
    async fn ws_action_rejected_after_logout_session_removal() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'u1', 'h', 30, 1, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO factions (id, season_id, name, color_id, leader_user_id, created_at) VALUES (1, 1, 'F1', 5, 1, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();

        let token = "test_session_token_abc".to_string();
        sqlx::query("INSERT INTO sessions (token, user_id, created_at) VALUES (?, 1, ?)")
            .bind(&token)
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        state.cache_user_session(token.clone(), 1, Utc::now().timestamp() + 3600);

        // ログアウト前はセッションが有効
        assert_eq!(state.resolve_active_user_session(&token).await, Some(1));

        // ログアウト相当（DB 削除 + キャッシュ削除）
        sqlx::query("DELETE FROM sessions WHERE token = ?")
            .bind(&token)
            .execute(&state.pool)
            .await
            .unwrap();
        state.session_cache.remove(&token);

        let active_uid = state.resolve_active_user_session(&token).await;
        assert_eq!(active_uid, None);

        let msg = ClientActionMsg {
            x: 15,
            y: 15,
            mode: ActionMode::Paint,
            color_id: 5,
            confirm_war: false,
        };
        let reply = process_cell_action(&state, "127.0.0.1", active_uid, msg).await;
        assert_eq!(reply[1], STATUS_ERROR, "ログアウト後はアクションが拒否されるべきです");

        let cell = {
            let b = state.board.read();
            b.cells[b.idx(15, 15)]
        };
        assert_eq!(cell.faction_id, 0, "拒否されたアクションで盤面が変更されてはいけません");
    }

    #[tokio::test]
    async fn initial_core_does_not_exceed_initial_core_quota() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);
        *state.phase_override.write() = Some(SeasonPhase::Active);
        state.game_rules.write().initial_core_quota = 2;

        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'u1', 'h', 50, 1, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO factions (id, season_id, name, color_id, leader_user_id, initial_core_used, created_at) VALUES (1, 1, 'F1', 5, 1, 0, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();

        // 隣接マスを3回塗る（クォータ=2 なので最初の2マスのみ初期中核になり、3マス目は通常領土になる）
        for x in 10u16..=12u16 {
            let msg = ClientActionMsg {
                x,
                y: 10,
                mode: ActionMode::Paint,
                color_id: 5,
                confirm_war: false,
            };
            let reply = process_cell_action_for_user(&state, "127.0.0.1", 1, msg).await;
            assert_eq!(reply[1], STATUS_OK);
        }

        {
            let b = state.board.read();
            assert!(b.cells[b.idx(10, 10)].is_core(), "1マス目は初期中核になるべきです");
            assert!(b.cells[b.idx(11, 10)].is_core(), "2マス目は初期中核になるべきです");
            assert!(!b.cells[b.idx(12, 10)].is_core(), "3マス目はクォータ超過のため初期中核になってはいけません");
        }

        let used: i64 = sqlx::query("SELECT initial_core_used FROM factions WHERE id = 1")
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .get("initial_core_used");
        assert_eq!(used, 2);
    }

    #[tokio::test]
    async fn board_cell_unchanged_when_ap_is_insufficient() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let state = AppState::new(test_config(), pool, board, params, 1);
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'u1', 'h', 1, 1, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO factions (id, season_id, name, color_id, leader_user_id, created_at) VALUES (1, 1, 'F1', 5, 1, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();

        // 飛び地初期打設は 3 AP 必要だが保有 AP=1 のため失敗する
        let msg = ClientActionMsg {
            x: 20,
            y: 20,
            mode: ActionMode::Paint,
            color_id: 5,
            confirm_war: false,
        };
        let reply = process_cell_action_for_user(&state, "127.0.0.1", 1, msg).await;
        assert_eq!(reply[1], STATUS_ERROR, "AP不足時はエラーになるべきです");

        let cell = {
            let b = state.board.read();
            b.cells[b.idx(20, 20)]
        };
        assert_eq!(cell.faction_id, 0, "AP不足時に盤面セルが変更されてはいけません");

        let user_ap: i64 = sqlx::query("SELECT ap FROM users WHERE id = 1")
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .get("ap");
        assert_eq!(user_ap, 1, "AP不足時に保有APが減ってはいけません");
    }

    #[tokio::test]
    async fn war_confirm_returns_server_evaluated_cost_ap_in_10byte_header() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let mut board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        // (20, 20) を勢力2の通常領土にする
        let idx = board.idx(20, 20);
        board.cells[idx].faction_id = 2;
        board.cells[idx].color_id = 10;
        board.cells[idx].layers = 1;
        let state = AppState::new(test_config(), pool, board, params, 1);
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'u1', 'h', 50, 1, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO factions (id, season_id, name, color_id, leader_user_id, created_at) VALUES (1, 1, 'F1', 5, 1, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();

        let msg = ClientActionMsg {
            x: 20,
            y: 20,
            mode: ActionMode::Paint,
            color_id: 5,
            confirm_war: false,
        };
        let reply = process_cell_action_for_user(&state, "127.0.0.1", 1, msg).await;
        assert!(reply.len() >= 10, "ヘッダは10バイト以上であるべきです");
        assert_eq!(reply[1], STATUS_WAR_CONFIRM);
        let target_faction = u16::from_le_bytes([reply[4], reply[5]]);
        let cost_ap = u16::from_le_bytes([reply[6], reply[7]]);
        let msg_len = u16::from_le_bytes([reply[8], reply[9]]) as usize;
        assert_eq!(target_faction, 2);
        assert!(cost_ap > 0, "STATUS_WAR_CONFIRM にはサーバー評価コストが含まれるべきです");
        assert_eq!(reply.len(), 10 + msg_len);
    }

    #[tokio::test]
    async fn capture_enemy_core_notifies_defender_with_cooldown() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let mut board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        for (x, y) in [(20usize, 20usize), (21usize, 20usize)] {
            let idx = board.idx(x, y);
            board.cells[idx].faction_id = 2;
            board.cells[idx].color_id = 10;
            board.cells[idx].layers = 1;
            board.cells[idx].set_core(true);
        }
        let state = AppState::new(test_config(), pool, board, params, 1);
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'att_u', 'h', 100, 1, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (2, 'def_u', 'h', 100, 2, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO factions (id, season_id, name, color_id, leader_user_id, created_at) VALUES (1, 1, '攻撃国', 5, 1, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO factions (id, season_id, name, color_id, leader_user_id, created_at) VALUES (2, 1, '防衛国', 10, 2, ?)")
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

        let (tx_def, mut rx_def) = tokio::sync::mpsc::channel(16);
        state.register_ws_user_sender(2, "tok_def".to_string(), tx_def);

        // 1回目の中核奪取 -> 防衛側メンバーへ core_attacked が届く
        let r1 = process_cell_action_for_user(
            &state,
            "127.0.0.1",
            1,
            ClientActionMsg {
                x: 20,
                y: 20,
                mode: ActionMode::Paint,
                color_id: 5,
                confirm_war: true,
            },
        )
        .await;
        assert_eq!(r1[1], STATUS_OK);
        let f1 = rx_def.try_recv().expect("中核奪取時に防衛側へ通知が届くべきです");
        assert_eq!(f1.first(), Some(&crate::protocol::OP_SERVER_EVENT_JSON));
        let ev1: serde_json::Value = serde_json::from_slice(&f1[1..]).unwrap();
        assert_eq!(ev1["type"], "core_attacked");
        assert_eq!(ev1["defender_faction_id"], 2);
        assert_eq!(ev1["attacker_faction_id"], 1);
        assert_eq!(ev1["attacker_name"], "攻撃国");
        assert_eq!(ev1["x"], 20);
        assert_eq!(ev1["y"], 20);

        // 2回目の中核奪取（クールダウン内） -> 重複通知は送られない
        let r2 = process_cell_action_for_user(
            &state,
            "127.0.0.1",
            1,
            ClientActionMsg {
                x: 21,
                y: 20,
                mode: ActionMode::Paint,
                color_id: 5,
                confirm_war: true,
            },
        )
        .await;
        assert_eq!(r2[1], STATUS_OK);
        assert!(rx_def.try_recv().is_err(), "クールダウン中は重複通知されないべきです");

        let logs: Vec<(String, String)> = sqlx::query_as(
            "SELECT category, summary FROM player_logs ORDER BY id ASC",
        )
        .fetch_all(&state.pool)
        .await
        .unwrap();
        assert!(logs
            .iter()
            .any(|(c, s)| c == "territory" && s.contains("「防衛国」中核を奪った")));
    }

    #[tokio::test]
    async fn capture_non_war_cell_records_named_war_and_revive_logs() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let mut board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        let idx = board.idx(20, 20);
        board.cells[idx].faction_id = 2;
        board.cells[idx].color_id = 10;
        board.cells[idx].layers = 1;
        let state = AppState::new(test_config(), pool, board, params, 1);
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'att_u', 'h', 50, 1, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO factions (id, season_id, name, color_id, leader_user_id, is_extinct, ever_had_territory, created_at) VALUES (1, 1, '再起国', 5, 1, 1, 1, ?), (2, 1, '対象国', 10, 2, 0, 1, ?)")
            .bind(&now)
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();

        let reply = process_cell_action_for_user(
            &state,
            "127.0.0.1",
            1,
            ClientActionMsg {
                x: 20,
                y: 20,
                mode: ActionMode::Paint,
                color_id: 5,
                confirm_war: true,
            },
        )
        .await;
        assert_eq!(reply[1], STATUS_OK);

        let logs: Vec<(String, String)> = sqlx::query_as(
            "SELECT category, summary FROM player_logs ORDER BY id ASC",
        )
        .fetch_all(&state.pool)
        .await
        .unwrap();
        assert!(logs
            .iter()
            .any(|(c, s)| c == "diplomacy" && s == "勢力「対象国」へ宣戦布告した"));
        assert!(logs
            .iter()
            .any(|(c, s)| c == "faction" && s == "勢力「再起国」が滅亡から再起した"));
    }

    #[tokio::test]
    async fn capture_enemy_core_does_not_consume_cooldown_when_defender_offline() {
        let pool = init_memory_db().await.unwrap();
        let params = MapGenParams::default_with_seed(1);
        let mut board = Board::from_terrain(100, &vec![1u8; 100 * 100]);
        for (x, y) in [(20usize, 20usize), (21usize, 20usize)] {
            let idx = board.idx(x, y);
            board.cells[idx].faction_id = 2;
            board.cells[idx].color_id = 10;
            board.cells[idx].layers = 1;
            board.cells[idx].set_core(true);
        }
        let state = AppState::new(test_config(), pool, board, params, 1);
        *state.phase_override.write() = Some(SeasonPhase::Active);

        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (1, 'att_u', 'h', 100, 1, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO users (id, username, password_hash, ap, faction_id, created_at) VALUES (2, 'def_u', 'h', 100, 2, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO factions (id, season_id, name, color_id, leader_user_id, created_at) VALUES (1, 1, '攻撃国', 5, 1, ?)")
            .bind(&now)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO factions (id, season_id, name, color_id, leader_user_id, created_at) VALUES (2, 1, '防衛国', 10, 2, ?)")
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

        // 1回目: 防衛側オフラインのためクールダウンは消費されない
        let r1 = process_cell_action_for_user(
            &state,
            "127.0.0.1",
            1,
            ClientActionMsg {
                x: 20,
                y: 20,
                mode: ActionMode::Paint,
                color_id: 5,
                confirm_war: true,
            },
        )
        .await;
        assert_eq!(r1[1], STATUS_OK);
        assert!(
            !state.core_attack_alert_cooldown.contains_key(&(2, 1)),
            "防衛側オフライン時はクールダウンを記録しないべきです"
        );

        // 防衛側がオンラインになった直後の2マス目奪取では通知が届く
        let (tx_def, mut rx_def) = tokio::sync::mpsc::channel(16);
        state.register_ws_user_sender(2, "tok_def".to_string(), tx_def);
        let r2 = process_cell_action_for_user(
            &state,
            "127.0.0.1",
            1,
            ClientActionMsg {
                x: 21,
                y: 20,
                mode: ActionMode::Paint,
                color_id: 5,
                confirm_war: true,
            },
        )
        .await;
        assert_eq!(r2[1], STATUS_OK);
        let f2 = rx_def.try_recv().expect("オンライン化後の奪取では通知が届くべきです");
        let ev2: serde_json::Value = serde_json::from_slice(&f2[1..]).unwrap();
        assert_eq!(ev2["type"], "core_attacked");
        assert_eq!(ev2["x"], 21);
        assert_eq!(ev2["y"], 20);
    }

    #[tokio::test]
    async fn pre_queued_broadcast_drain_drops_stale_tick_sync_and_discard_clears_direct_events() {
        let (bcast_tx, mut bcast_rx) = tokio::sync::broadcast::channel::<Bytes>(16);
        let stale_sync = Bytes::from(encode_tick_sync(1, 10, 0, 1000, 1));
        let event1 = Bytes::from(encode_event_json(r#"{"type":"faction_updated","faction_id":1}"#));
        let event2 = Bytes::from(encode_event_json(r#"{"type":"war_declared","attacker_faction_id":1}"#));
        bcast_tx.send(stale_sync).unwrap();
        bcast_tx.send(event1.clone()).unwrap();
        bcast_tx.send(Bytes::from(encode_tick_sync(2, 11, 0, 2000, 1))).unwrap();
        bcast_tx.send(event2.clone()).unwrap();

        let drained = drain_pre_queued_broadcast(&mut bcast_rx, &bcast_tx);
        assert_eq!(drained, vec![event1, event2]);

        let (direct_tx, mut direct_rx) = mpsc::channel::<Bytes>(8);
        let overflowed = AtomicBool::new(true);
        direct_tx
            .try_send(Bytes::from(encode_event_json(r#"{"type":"core_attacked"}"#)))
            .unwrap();
        discard_pending_direct_events(&mut direct_rx, &overflowed);
        assert!(direct_rx.try_recv().is_err());
        assert!(!overflowed.load(Ordering::Acquire));
    }
}
