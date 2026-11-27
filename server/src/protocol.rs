use crate::board::{ActionMode, Cell};

// クライアント -> サーバー オペコード
pub const OP_CLIENT_ACTION: u8 = 0x01;
pub const OP_CLIENT_PING: u8 = 0x02;

// サーバー -> クライアント オペコード
pub const OP_SERVER_CELL_DIFF: u8 = 0x81;
pub const OP_SERVER_ACTION_RESULT: u8 = 0x82;
pub const OP_SERVER_TICK_SYNC: u8 = 0x83;
pub const OP_SERVER_EVENT_JSON: u8 = 0x84;
pub const OP_SERVER_PONG: u8 = 0x85;

// アクション結果ステータス
pub const STATUS_OK: u8 = 0;
pub const STATUS_WAR_CONFIRM: u8 = 1;
pub const STATUS_ERROR: u8 = 2;

/// クライアントからのセル操作リクエスト (8バイト固定)
/// [opcode:u8, x:u16 LE, y:u16 LE, mode:u8, color_id:u8, confirm_war:u8]
#[derive(Clone, Copy, Debug)]
pub struct ClientActionMsg {
    pub x: u16,
    pub y: u16,
    pub mode: ActionMode,
    pub color_id: u8,
    pub confirm_war: bool,
}

impl ClientActionMsg {
    pub fn decode(data: &[u8]) -> Option<Self> {
        if data.len() != 8 || data[0] != OP_CLIENT_ACTION {
            return None;
        }
        let x = u16::from_le_bytes([data[1], data[2]]);
        let y = u16::from_le_bytes([data[3], data[4]]);
        let mode = ActionMode::from_u8(data[5])?;
        let color_id = data[6];
        let confirm_war = data[7] != 0;
        Some(Self {
            x,
            y,
            mode,
            color_id,
            confirm_war,
        })
    }
}

/// セル差分バッチをバイナリフレームへエンコード
/// [0x81, board_version:u64 LE, count:u32 LE, (x:u16 LE, y:u16 LE, cell:8B) * count]
pub fn encode_cell_diff_batch(board_version: u64, updates: &[(u16, u16, Cell)]) -> Vec<u8> {
    // ヘッダ13バイト（opcode:1 + board_version:8 + count:4）＋各セル差分12バイト
    let mut buf = Vec::with_capacity(13 + updates.len() * 12);
    buf.push(OP_SERVER_CELL_DIFF);
    buf.extend_from_slice(&board_version.to_le_bytes());
    buf.extend_from_slice(&(updates.len() as u32).to_le_bytes());
    for &(x, y, cell) in updates {
        buf.extend_from_slice(&x.to_le_bytes());
        buf.extend_from_slice(&y.to_le_bytes());
        buf.extend_from_slice(&cell.to_le_bytes());
    }
    buf
}

/// 単一アクション結果をエンコード
/// [0x82, status:u8, ap:u16 LE, target_faction:u16 LE, cost_ap:u16 LE, msg_len:u16 LE, msg_utf8...]
pub fn encode_action_result(
    status: u8,
    ap: u16,
    target_faction: u16,
    cost_ap: u16,
    message: &str,
) -> Vec<u8> {
    // 65,535バイト上限切り詰め時に UTF-8 文字境界を破壊しないよう調整
    let mut cut = message.len().min(u16::MAX as usize);
    while cut > 0 && !message.is_char_boundary(cut) {
        cut -= 1;
    }
    let len = cut as u16;
    let msg_bytes = &message.as_bytes()[..cut];
    // ヘッダ10バイト（opcode:1 + status:1 + ap:2 + target_faction:2 + cost_ap:2 + msg_len:2）
    let mut buf = Vec::with_capacity(10 + cut);
    buf.push(OP_SERVER_ACTION_RESULT);
    buf.push(status);
    buf.extend_from_slice(&ap.to_le_bytes());
    buf.extend_from_slice(&target_faction.to_le_bytes());
    buf.extend_from_slice(&cost_ap.to_le_bytes());
    buf.extend_from_slice(&len.to_le_bytes());
    buf.extend_from_slice(msg_bytes);
    buf
}

/// ティック / フェーズ同期通知をエンコード
/// [0x83, phase:u8, tick_num:u16 LE, ap:u16 LE, next_tick_unix:i64 LE, season_id:i64 LE]
pub fn encode_tick_sync(
    phase: u8,
    tick_num: u16,
    ap: u16,
    next_tick_unix: i64,
    season_id: i64,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(22);
    buf.push(OP_SERVER_TICK_SYNC);
    buf.push(phase);
    buf.extend_from_slice(&tick_num.to_le_bytes());
    buf.extend_from_slice(&ap.to_le_bytes());
    buf.extend_from_slice(&next_tick_unix.to_le_bytes());
    buf.extend_from_slice(&season_id.to_le_bytes());
    buf
}

/// 外交・勢力イベント等の JSON ペイロードをバイナリフレームへエンコード
pub fn encode_event_json(json_str: &str) -> Vec<u8> {
    let bytes = json_str.as_bytes();
    let mut buf = Vec::with_capacity(1 + bytes.len());
    buf.push(OP_SERVER_EVENT_JSON);
    buf.extend_from_slice(bytes);
    buf
}
