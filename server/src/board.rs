use bytemuck::{Pod, Zeroable};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

/// チャンクの一辺（選択可能マップサイズ 100/250/500/750/1000 のすべてを割り切る 50）
pub const CHUNK_SIZE: usize = 50;
pub const CHUNK_CELL_COUNT: usize = CHUNK_SIZE * CHUNK_SIZE; // 2_500
pub const CHUNK_BYTE_LEN: usize = CHUNK_CELL_COUNT * std::mem::size_of::<Cell>(); // 20_000

pub const MAX_LAYERS: u8 = 10;
pub const INITIAL_CORE_QUOTA: u32 = 30;
pub const ASSIMILATION_REQUIRED_TICKS: u8 = 10;
pub const OLD_CORE_TTL_TICKS: u8 = 10;
pub const DEFAULT_TICK_INTERVAL_MINUTES: u32 = 30;
pub const DEFAULT_MAX_TICKS: u16 = 100;
/// 開幕曜日デフォルト（0=月〜6=日、5=土）
pub const DEFAULT_SEASON_START_WEEKDAY: u8 = 5;
pub const DEFAULT_SEASON_START_HOUR: u8 = 0;
pub const DEFAULT_SEASON_START_MINUTE: u8 = 0;

/// 管理者コンソールから動的に変更可能な領土・中核バランス設定
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct GameRulesConfig {
    pub max_layers: u8,
    pub initial_core_quota: u32,
    pub assimilation_required_ticks: u8,
    pub old_core_ttl_ticks: u8,
    #[serde(default = "default_tick_interval_minutes")]
    pub tick_interval_minutes: u32,
    #[serde(default = "default_max_ticks")]
    pub max_ticks: u16,
    #[serde(default = "default_season_start_weekday")]
    pub season_start_weekday: u8,
    #[serde(default = "default_season_start_hour")]
    pub season_start_hour: u8,
    #[serde(default = "default_season_start_minute")]
    pub season_start_minute: u8,
}

fn default_tick_interval_minutes() -> u32 {
    DEFAULT_TICK_INTERVAL_MINUTES
}

fn default_max_ticks() -> u16 {
    DEFAULT_MAX_TICKS
}

fn default_season_start_weekday() -> u8 {
    DEFAULT_SEASON_START_WEEKDAY
}

fn default_season_start_hour() -> u8 {
    DEFAULT_SEASON_START_HOUR
}

fn default_season_start_minute() -> u8 {
    DEFAULT_SEASON_START_MINUTE
}

impl Default for GameRulesConfig {
    fn default() -> Self {
        Self {
            max_layers: MAX_LAYERS,
            initial_core_quota: INITIAL_CORE_QUOTA,
            assimilation_required_ticks: ASSIMILATION_REQUIRED_TICKS,
            old_core_ttl_ticks: OLD_CORE_TTL_TICKS,
            tick_interval_minutes: DEFAULT_TICK_INTERVAL_MINUTES,
            max_ticks: DEFAULT_MAX_TICKS,
            season_start_weekday: DEFAULT_SEASON_START_WEEKDAY,
            season_start_hour: DEFAULT_SEASON_START_HOUR,
            season_start_minute: DEFAULT_SEASON_START_MINUTE,
        }
    }
}

impl GameRulesConfig {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=15).contains(&self.max_layers) {
            return Err("重ね塗り最大層数は 1〜15 で指定してください".into());
        }
        if self.initial_core_quota > 500 {
            return Err("初期中核付与枠は 0〜500 で指定してください".into());
        }
        if !(1..=15).contains(&self.assimilation_required_ticks) {
            return Err("自然中核化までの時間は 1〜15 Tick で指定してください".into());
        }
        if self.old_core_ttl_ticks > 15 {
            return Err("旧中核履歴の保持時間は 0〜15 Tick で指定してください".into());
        }
        if !(1..=1440).contains(&self.tick_interval_minutes) {
            return Err("Tick間隔は 1〜1440 分の範囲で指定してください".into());
        }
        if !(1..=1000).contains(&self.max_ticks) {
            return Err("ゲーム終了Tick数は 1〜1000 の範囲で指定してください".into());
        }
        if self.season_start_weekday > 6 {
            return Err("開幕曜日は 0（月）〜6（日）の範囲で指定してください".into());
        }
        if self.season_start_hour >= 24 {
            return Err("開幕時（JST）は 0〜23 の範囲で指定してください".into());
        }
        if self.season_start_minute >= 60 {
            return Err("開幕分（JST）は 0〜59 の範囲で指定してください".into());
        }
        Ok(())
    }
}

/// 管理者コンソールから動的に変更可能なアクションコスト・飛び地増加率設定
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct CostConfig {
    pub claim_cost: u16,
    pub reinforce_cost: u16,
    pub enemy_normal_multiplier: f64,
    pub enemy_core_multiplier: f64,
    pub enclave_base_multiplier: f64,
    pub enclave_distance_step: u16,
    pub enclave_distance_rate: f64,
}

impl Default for CostConfig {
    fn default() -> Self {
        Self {
            claim_cost: 1,
            reinforce_cost: 1,
            enemy_normal_multiplier: 1.0,
            enemy_core_multiplier: 2.0,
            enclave_base_multiplier: 3.0,
            enclave_distance_step: 10,
            enclave_distance_rate: 0.5,
        }
    }
}

impl CostConfig {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=50).contains(&self.claim_cost) {
            return Err("塗り基本コストは 1〜50 AP で指定してください".into());
        }
        if !(1..=50).contains(&self.reinforce_cost) {
            return Err("重ね塗り基本コストは 1〜50 AP で指定してください".into());
        }
        if !(0.1..=50.0).contains(&self.enemy_normal_multiplier) || !self.enemy_normal_multiplier.is_finite() {
            return Err("敵地塗りコスト倍率は 0.1〜50.0 で指定してください".into());
        }
        if !(0.1..=50.0).contains(&self.enemy_core_multiplier) || !self.enemy_core_multiplier.is_finite() {
            return Err("敵地中核塗りコスト倍率は 0.1〜50.0 で指定してください".into());
        }
        if !(1.0..=20.0).contains(&self.enclave_base_multiplier) || !self.enclave_base_multiplier.is_finite() {
            return Err("飛び地基本倍率は 1.0〜20.0 で指定してください".into());
        }
        if !(1..=500).contains(&self.enclave_distance_step) {
            return Err("飛び地距離ステップは 1〜500 マスで指定してください".into());
        }
        if !(0.0..=10.0).contains(&self.enclave_distance_rate) || !self.enclave_distance_rate.is_finite() {
            return Err("飛び地距離増加率は 0.0〜10.0 で指定してください".into());
        }
        // 最大設定値組み合わせ（15層・1000×1000 盤面対角距離 1997 マス飛び地）が u16 上限内に収まるか検証
        let max_enemy_mult = self.enemy_normal_multiplier.max(self.enemy_core_multiplier);
        let max_base_raw = 15.0 * (self.claim_cost as f64) * max_enemy_mult;
        let max_base_cost = (max_base_raw - 1e-9).ceil().max(1.0);
        let max_enclave_mult = self.enclave_base_multiplier
            + (1997.0 / (self.enclave_distance_step as f64)) * self.enclave_distance_rate;
        let max_total_cost = (max_base_cost * max_enclave_mult).round();
        if !max_total_cost.is_finite() || max_total_cost > u16::MAX as f64 {
            return Err(
                "最大想定コスト（15層・最大距離飛び地）が上限 65,535 AP を超えるため設定値を見直してください"
                    .into(),
            );
        }
        Ok(())
    }
}

/// サーバー側インメモリ盤面セル（1マス = 8バイト固定長構造体）
/// ビット配置:
/// - terrain bit 0: 地形 (0: 海, 1: 陸地)
/// - terrain bit 1: assimilation_ticks bit 3 (上位1ビット)
/// - flags bit 0: is_core (0..1)
/// - flags bit 1..=3: assimilation_ticks bit 0..=2 (自然中核化連続維持カウント 0..=15)
/// - flags bit 4..=7: old_core_ttl (0..12, 旧中核履歴の残りティック数)
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct Cell {
    pub terrain: u8,           // bit0: 0=海/1=陸地, bit1: assimilation_ticks bit3
    pub color_id: u8,          // 0..63 (現在の表示色)
    pub layers: u8,            // 0..10 (重ね塗り層数)
    pub flags: u8,             // bit0: is_core, bit1..3: assimilation(下位3bit), bit4..7: old_core_ttl(0..12)
    pub faction_id: u16,       // 0: 無所属, 1..65535: 勢力ID
    pub old_core_faction: u16, // 0: なし, 1..65535: 旧中核の勢力ID
}

impl Cell {
    #[inline]
    pub fn is_land(&self) -> bool {
        (self.terrain & 0x01) == 1
    }

    #[inline]
    pub fn is_core(&self) -> bool {
        (self.flags & 0x01) != 0
    }

    #[inline]
    pub fn set_core(&mut self, core: bool) {
        if core {
            self.flags |= 0x01;
        } else {
            self.flags &= !0x01;
        }
    }

    #[inline]
    pub fn assimilation_ticks(&self) -> u8 {
        ((self.flags >> 1) & 0x07) | (((self.terrain >> 1) & 0x01) << 3)
    }

    #[inline]
    pub fn set_assimilation_ticks(&mut self, ticks: u8) {
        let clamped = ticks.min(15);
        self.flags = (self.flags & !(0x07 << 1)) | ((clamped & 0x07) << 1);
        self.terrain = (self.terrain & !0x02) | (((clamped >> 3) & 0x01) << 1);
    }

    #[inline]
    pub fn old_core_ttl(&self) -> u8 {
        (self.flags >> 4) & 0x0F
    }

    #[inline]
    pub fn set_old_core_ttl(&mut self, ttl: u8) {
        let clamped = ttl.min(15);
        self.flags = (self.flags & 0x0F) | (clamped << 4);
    }

    /// セルを明示的なリトルエンディアン 8 バイト配列へシリアライズする
    #[inline]
    pub fn to_le_bytes(self) -> [u8; 8] {
        let fid = self.faction_id.to_le_bytes();
        let ocf = self.old_core_faction.to_le_bytes();
        [
            self.terrain,
            self.color_id,
            self.layers,
            self.flags,
            fid[0],
            fid[1],
            ocf[0],
            ocf[1],
        ]
    }

    /// リトルエンディアン 8 バイト配列からセルをデシリアライズする
    #[inline]
    pub fn from_le_bytes(b: [u8; 8]) -> Self {
        Self {
            terrain: b[0],
            color_id: b[1],
            layers: b[2],
            flags: b[3],
            faction_id: u16::from_le_bytes([b[4], b[5]]),
            old_core_faction: u16::from_le_bytes([b[6], b[7]]),
        }
    }
}

/// クライアントからのセル操作モード
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionMode {
    /// 打設・重ね塗り・敵マス上書き（対象マスの状態に応じて自動判定）
    Paint = 0,
    /// 自勢力マスの色変更（AP不要・囲い込み制限なし）
    Recolor = 1,
}

impl ActionMode {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Paint),
            1 => Some(Self::Recolor),
            _ => None,
        }
    }
}

/// セル操作の種別
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionKind {
    ClaimNeutral,
    Reinforce,
    Recolor,
    CaptureEnemyNormal,
    CaptureEnemyCore,
}

/// セル操作の評価結果
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EvaluatedAction {
    pub kind: ActionKind,
    pub cost: u16,
    pub is_enclave: bool,
    pub target_faction: u16,
}

/// セル操作のエラー種別
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActionError {
    OutOfBounds,
    SeaTile,
    InvalidColor,
    MaxLayersReached,
    NotOwnedForRecolor,
    SameColor,
}

/// チャンク単位の勢力領土インデックス（飛び地距離計算の高速化用）
#[derive(Default)]
struct FactionChunkIndex {
    /// チャンクID -> (勢力ID -> チャンク内の当該勢力陸地セル数)
    chunk_factions: Vec<HashMap<u16, u32>>,
    /// 勢力ID -> (チャンクID -> チャンク内の当該勢力陸地セル数)
    faction_chunks: HashMap<u16, HashMap<usize, u32>>,
}

impl FactionChunkIndex {
    fn new(total_chunks: usize) -> Self {
        Self {
            chunk_factions: vec![HashMap::new(); total_chunks],
            faction_chunks: HashMap::new(),
        }
    }

    /// 1セル分の勢力領土カウントを差分更新する（O(1)）
    fn adjust_cell(&mut self, chunk_id: usize, faction_id: u16, delta: i32) {
        if faction_id == 0 || chunk_id >= self.chunk_factions.len() {
            return;
        }
        if delta > 0 {
            *self.chunk_factions[chunk_id].entry(faction_id).or_insert(0) += delta as u32;
            *self
                .faction_chunks
                .entry(faction_id)
                .or_default()
                .entry(chunk_id)
                .or_insert(0) += delta as u32;
        } else if delta < 0 {
            let sub = (-delta) as u32;
            if let Some(cnt) = self.chunk_factions[chunk_id].get_mut(&faction_id) {
                if *cnt <= sub {
                    self.chunk_factions[chunk_id].remove(&faction_id);
                } else {
                    *cnt -= sub;
                }
            }
            if let Some(chunks) = self.faction_chunks.get_mut(&faction_id) {
                if let Some(cnt) = chunks.get_mut(&chunk_id) {
                    if *cnt <= sub {
                        chunks.remove(&chunk_id);
                    } else {
                        *cnt -= sub;
                    }
                }
                if chunks.is_empty() {
                    self.faction_chunks.remove(&faction_id);
                }
            }
        }
    }

    /// 指定チャンクの勢力領土カウントを盤面セルから再構築する
    fn rebuild_chunk(&mut self, chunk_id: usize, size: usize, chunks_per_side: usize, cells: &[Cell]) {
        if chunk_id >= self.chunk_factions.len() {
            return;
        }
        // 既存の登録を除去
        let old_map = std::mem::take(&mut self.chunk_factions[chunk_id]);
        for fid in old_map.keys() {
            if let Some(chunks) = self.faction_chunks.get_mut(fid) {
                chunks.remove(&chunk_id);
                if chunks.is_empty() {
                    self.faction_chunks.remove(fid);
                }
            }
        }

        // チャンク内の陸地セルを集計
        let cx = (chunk_id % chunks_per_side) * CHUNK_SIZE;
        let cy = (chunk_id / chunks_per_side) * CHUNK_SIZE;
        let mut new_map: HashMap<u16, u32> = HashMap::new();
        for dy in 0..CHUNK_SIZE {
            let row_start = (cy + dy) * size + cx;
            for c in &cells[row_start..row_start + CHUNK_SIZE] {
                if c.is_land() && c.faction_id != 0 {
                    *new_map.entry(c.faction_id).or_insert(0) += 1;
                }
            }
        }
        for (&fid, &count) in &new_map {
            self.faction_chunks
                .entry(fid)
                .or_default()
                .insert(chunk_id, count);
        }
        self.chunk_factions[chunk_id] = new_map;
    }
}

/// 可変正方形サイズ対応のインメモリ盤面とダーティチャンク管理
pub struct Board {
    pub size: usize,
    pub chunks_per_side: usize,
    pub total_chunks: usize,
    pub cells: Vec<Cell>,
    dirty_chunks: Vec<AtomicBool>,
    faction_index: RwLock<FactionChunkIndex>,
    index_dirty_chunks: Vec<AtomicBool>,
    has_dirty_index: AtomicBool,
}

impl Board {
    /// 地形配列と正方形サイズから新規盤面を生成
    pub fn from_terrain(size: usize, terrain: &[u8]) -> Self {
        assert!(size >= CHUNK_SIZE && size.is_multiple_of(CHUNK_SIZE));
        assert_eq!(terrain.len(), size * size);
        let chunks_per_side = size / CHUNK_SIZE;
        let total_chunks = chunks_per_side * chunks_per_side;
        let mut cells = vec![Cell::default(); size * size];
        for (cell, &t) in cells.iter_mut().zip(terrain.iter()) {
            cell.terrain = t;
        }
        let dirty_chunks = (0..total_chunks).map(|_| AtomicBool::new(true)).collect();
        let index_dirty_chunks = (0..total_chunks).map(|_| AtomicBool::new(false)).collect();
        Self {
            size,
            chunks_per_side,
            total_chunks,
            cells,
            dirty_chunks,
            faction_index: RwLock::new(FactionChunkIndex::new(total_chunks)),
            index_dirty_chunks,
            has_dirty_index: AtomicBool::new(false),
        }
    }

    /// 既存のセル配列から盤面を構築する（ダーティフラグは全て false）
    pub fn from_cells(size: usize, cells: Vec<Cell>) -> Self {
        assert!(size >= CHUNK_SIZE && size.is_multiple_of(CHUNK_SIZE));
        assert_eq!(cells.len(), size * size);
        let chunks_per_side = size / CHUNK_SIZE;
        let total_chunks = chunks_per_side * chunks_per_side;
        let dirty_chunks = (0..total_chunks).map(|_| AtomicBool::new(false)).collect();
        // 既存セルからの構築時はインデックスを遅延構築対象としてマークする
        let index_dirty_chunks = (0..total_chunks).map(|_| AtomicBool::new(true)).collect();
        Self {
            size,
            chunks_per_side,
            total_chunks,
            cells,
            dirty_chunks,
            faction_index: RwLock::new(FactionChunkIndex::new(total_chunks)),
            index_dirty_chunks,
            has_dirty_index: AtomicBool::new(true),
        }
    }

    #[inline]
    pub fn idx(&self, x: usize, y: usize) -> usize {
        y * self.size + x
    }

    #[inline]
    pub fn chunk_id(&self, x: usize, y: usize) -> usize {
        (y / CHUNK_SIZE) * self.chunks_per_side + (x / CHUNK_SIZE)
    }

    /// DB 保存用ダーティフラグのみを立てる（インデックスを直接更新済みの場合の内部用）
    #[inline]
    fn mark_chunk_dirty_internal(&self, x: usize, y: usize) {
        if x >= self.size || y >= self.size {
            return;
        }
        let cid = self.chunk_id(x, y);
        if cid < self.total_chunks {
            self.dirty_chunks[cid].store(true, Ordering::Release);
        }
    }

    #[inline]
    pub fn mark_chunk_dirty(&self, x: usize, y: usize) {
        if x >= self.size || y >= self.size {
            return;
        }
        let cid = self.chunk_id(x, y);
        if cid < self.total_chunks {
            self.dirty_chunks[cid].store(true, Ordering::Release);
            // 外部から cells を直接書き換えられた場合でも次回の距離計算時にチャンク単位で再構築する
            self.index_dirty_chunks[cid].store(true, Ordering::Release);
            self.has_dirty_index.store(true, Ordering::Release);
        }
    }

    /// 指定されたチャンクID群にダーティフラグを再設定する
    pub fn mark_chunk_dirty_ids(&self, ids: &[usize]) {
        for &cid in ids {
            if cid < self.total_chunks {
                self.dirty_chunks[cid].store(true, Ordering::Release);
            }
        }
    }

    /// ダーティフラグが立っているチャンクID一覧を取得し、フラグをクリアする
    pub fn take_dirty_chunks(&self) -> Vec<usize> {
        let mut list = Vec::new();
        for (cid, flag) in self.dirty_chunks.iter().enumerate() {
            if flag.swap(false, Ordering::AcqRel) {
                list.push(cid);
            }
        }
        list
    }

    /// チャンクID の 50×50 セルをバイト列 (20,000B) として抽出
    pub fn extract_chunk_bytes(&self, chunk_id: usize) -> Vec<u8> {
        if chunk_id >= self.total_chunks {
            return Vec::new();
        }
        let cx = (chunk_id % self.chunks_per_side) * CHUNK_SIZE;
        let cy = (chunk_id / self.chunks_per_side) * CHUNK_SIZE;
        let mut out = Vec::with_capacity(CHUNK_BYTE_LEN);
        for dy in 0..CHUNK_SIZE {
            let start = self.idx(cx, cy + dy);
            let row_slice = &self.cells[start..start + CHUNK_SIZE];
            for cell in row_slice {
                out.extend_from_slice(&cell.to_le_bytes());
            }
        }
        out
    }

    /// SQLite から読み込んだチャンクバイト列 (20,000B) を盤面へ復元
    pub fn load_chunk_bytes(&mut self, chunk_id: usize, data: &[u8]) -> Result<(), String> {
        if chunk_id >= self.total_chunks {
            return Err(format!("不正なチャンクID: {}", chunk_id));
        }
        if data.len() != CHUNK_BYTE_LEN {
            return Err(format!(
                "チャンク {} のサイズ不正: expected {}, got {}",
                chunk_id,
                CHUNK_BYTE_LEN,
                data.len()
            ));
        }
        let cx = (chunk_id % self.chunks_per_side) * CHUNK_SIZE;
        let cy = (chunk_id / self.chunks_per_side) * CHUNK_SIZE;
        for dy in 0..CHUNK_SIZE {
            let dst_start = self.idx(cx, cy + dy);
            let row_byte_start = dy * CHUNK_SIZE * 8;
            for dx in 0..CHUNK_SIZE {
                let off = row_byte_start + dx * 8;
                let cell = Cell::from_le_bytes([
                    data[off],
                    data[off + 1],
                    data[off + 2],
                    data[off + 3],
                    data[off + 4],
                    data[off + 5],
                    data[off + 6],
                    data[off + 7],
                ]);
                self.cells[dst_start + dx] = cell;
            }
        }
        self.dirty_chunks[chunk_id].store(false, Ordering::Release);
        self.index_dirty_chunks[chunk_id].store(true, Ordering::Release);
        self.has_dirty_index.store(true, Ordering::Release);
        Ok(())
    }

    /// 盤面全体をそのまま連続バイト列として参照
    pub fn as_bytes(&self) -> &[u8] {
        bytemuck::cast_slice(&self.cells)
    }

    /// 盤面全体をリトルエンディアン固定のバイト列として取得
    #[allow(dead_code)]
    pub fn as_bytes_le(&self) -> std::borrow::Cow<'_, [u8]> {
        #[cfg(target_endian = "little")]
        {
            std::borrow::Cow::Borrowed(bytemuck::cast_slice(&self.cells))
        }
        #[cfg(not(target_endian = "little"))]
        {
            let mut out = Vec::with_capacity(self.cells.len() * std::mem::size_of::<Cell>());
            for c in &self.cells {
                out.push(c.terrain);
                out.push(c.color_id);
                out.push(c.layers);
                out.push(c.flags);
                out.extend_from_slice(&c.faction_id.to_le_bytes());
                out.extend_from_slice(&c.old_core_faction.to_le_bytes());
            }
            std::borrow::Cow::Owned(out)
        }
    }

    /// 上下左右および斜め（8近傍）のいずれかに指定勢力のドットが隣接しているか判定
    pub fn has_adjacent_faction(&self, x: usize, y: usize, faction_id: u16) -> bool {
        if faction_id == 0 {
            return false;
        }
        let min_x = x.saturating_sub(1);
        let max_x = (x + 1).min(self.size.saturating_sub(1));
        let min_y = y.saturating_sub(1);
        let max_y = (y + 1).min(self.size.saturating_sub(1));
        for ny in min_y..=max_y {
            for nx in min_x..=max_x {
                if nx == x && ny == y {
                    continue;
                }
                if self.cells[self.idx(nx, ny)].faction_id == faction_id {
                    return true;
                }
            }
        }
        false
    }

    /// ダーティマークされたチャンクの勢力領土インデックスを同期する
    fn sync_dirty_index_chunks(&self) {
        if !self.has_dirty_index.load(Ordering::Acquire) {
            return;
        }
        let mut idx = self.faction_index.write();
        self.has_dirty_index.store(false, Ordering::Release);
        for cid in 0..self.total_chunks {
            if self.index_dirty_chunks[cid].swap(false, Ordering::AcqRel) {
                idx.rebuild_chunk(cid, self.size, self.chunks_per_side, &self.cells);
            }
        }
    }

    /// 指定セルから最も近い自勢力マスまでのマンハッタン距離を返す（勢力保有チャンクのみ距離順ソート＋枝刈り付き）
    pub fn nearest_faction_distance(&self, x: usize, y: usize, faction_id: u16) -> Option<usize> {
        if faction_id == 0 || x >= self.size || y >= self.size {
            return None;
        }
        // 指定セル自身が対象勢力の陸地マスであれば最短距離は 0
        let self_cell = self.cells[self.idx(x, y)];
        if self_cell.faction_id == faction_id && self_cell.is_land() {
            return Some(0);
        }

        self.sync_dirty_index_chunks();

        // 対象勢力が実際に領土を持つチャンク ID のみを取得（領土 0 なら即座に None を返す）
        let candidate_chunks: Vec<usize> = {
            let idx = self.faction_index.read();
            match idx.faction_chunks.get(&faction_id) {
                Some(chunks) if !chunks.is_empty() => chunks.keys().copied().collect(),
                _ => return None,
            }
        };

        let sz = self.size;
        let cps = self.chunks_per_side;

        // 対象勢力が存在するチャンクのみ (x, y) からの最小マンハッタン距離順にソート
        let mut chunk_order = Vec::with_capacity(candidate_chunks.len());
        for cid in candidate_chunks {
            let cx_chunk = cid % cps;
            let cy_chunk = cid / cps;
            let y0 = cy_chunk * CHUNK_SIZE;
            let y1 = (y0 + CHUNK_SIZE).min(sz);
            let min_dy = if y < y0 {
                y0 - y
            } else if y >= y1 {
                y - (y1 - 1)
            } else {
                0
            };
            let x0 = cx_chunk * CHUNK_SIZE;
            let x1 = (x0 + CHUNK_SIZE).min(sz);
            let min_dx = if x < x0 {
                x0 - x
            } else if x >= x1 {
                x - (x1 - 1)
            } else {
                0
            };
            chunk_order.push((min_dx + min_dy, x0, x1, y0, y1));
        }
        chunk_order.sort_unstable_by_key(|item| item.0);

        let mut best: Option<usize> = None;
        for (min_chunk_dist, x0, x1, y0, y1) in chunk_order {
            if let Some(b) = best {
                if min_chunk_dist >= b {
                    break;
                }
            }
            for cy in y0..y1 {
                let dy = cy.abs_diff(y);
                if let Some(b) = best {
                    if dy >= b {
                        continue;
                    }
                }
                let row_start = cy * sz;
                for cx in x0..x1 {
                    let c = self.cells[row_start + cx];
                    if c.faction_id == faction_id && c.is_land() {
                        let d = cx.abs_diff(x) + dy;
                        if best.is_none_or(|b| d < b) {
                            best = Some(d);
                            // 先頭で距離 0 のケースを除外済みのため、d == 1 検出時点で真の最小距離が確定する
                            if d <= 1 {
                                return Some(d);
                            }
                        }
                    }
                }
            }
        }
        best
    }

    /// 敵マス奪取時の基本コスト計算（層数 × 塗り基本コスト × 倍率、小数点切り上げ）
    fn compute_enemy_capture_cost(layers: u16, claim_cost: u16, multiplier: f64) -> u16 {
        let raw = (layers as f64) * (claim_cost as f64) * multiplier;
        // 浮動小数点誤差による意図しない切り上げを防ぐため微小値を引いてから ceil する
        (raw - 1e-9).ceil().max(1.0) as u16
    }

    /// 飛び地距離に応じたコスト計算
    fn compute_enclave_cost(&self, x: usize, y: usize, faction_id: u16, base_cost: u16, cfg: &CostConfig) -> u16 {
        let effective_dist = match self.nearest_faction_distance(x, y, faction_id) {
            Some(d) => d.saturating_sub(1),
            None => 0,
        };
        let step = cfg.enclave_distance_step.max(1) as f64;
        let mult = cfg.enclave_base_multiplier + (effective_dist as f64 / step) * cfg.enclave_distance_rate;
        ((base_cost as f64) * mult).round().max(1.0) as u16
    }

    /// 指定セルに対する操作の種別・APコスト・飛び地判定を評価する（標準設定）
    #[cfg(test)]
    pub fn evaluate_action(
        &self,
        x: usize,
        y: usize,
        faction_id: u16,
        mode: ActionMode,
        requested_color_id: u8,
    ) -> Result<EvaluatedAction, ActionError> {
        self.evaluate_action_with_config(x, y, faction_id, mode, requested_color_id, &CostConfig::default())
    }

    /// 指定セルに対する操作の種別・APコスト・飛び地判定をコスト設定に基づいて評価する
    #[cfg(test)]
    pub fn evaluate_action_with_config(
        &self,
        x: usize,
        y: usize,
        faction_id: u16,
        mode: ActionMode,
        requested_color_id: u8,
        cfg: &CostConfig,
    ) -> Result<EvaluatedAction, ActionError> {
        self.evaluate_action_with_all(
            x,
            y,
            faction_id,
            mode,
            requested_color_id,
            cfg,
            &GameRulesConfig::default(),
        )
    }

    /// コスト設定とルール設定の両方に基づいてアクションを評価する
    #[allow(clippy::too_many_arguments)]
    pub fn evaluate_action_with_all(
        &self,
        x: usize,
        y: usize,
        faction_id: u16,
        mode: ActionMode,
        requested_color_id: u8,
        cfg: &CostConfig,
        rules: &GameRulesConfig,
    ) -> Result<EvaluatedAction, ActionError> {
        if x >= self.size || y >= self.size {
            return Err(ActionError::OutOfBounds);
        }
        let cell = self.cells[self.idx(x, y)];
        if !cell.is_land() {
            return Err(ActionError::SeaTile);
        }

        match mode {
            ActionMode::Recolor => {
                if faction_id == 0 {
                    return Err(ActionError::NotOwnedForRecolor);
                }
                if requested_color_id >= 64 {
                    return Err(ActionError::InvalidColor);
                }
                if cell.faction_id != faction_id {
                    return Err(ActionError::NotOwnedForRecolor);
                }
                if cell.color_id == requested_color_id {
                    return Err(ActionError::SameColor);
                }
                Ok(EvaluatedAction {
                    kind: ActionKind::Recolor,
                    cost: 0,
                    is_enclave: false,
                    target_faction: faction_id,
                })
            }
            ActionMode::Paint => {
                if faction_id == 0 {
                    return Err(ActionError::NotOwnedForRecolor);
                }
                if cell.faction_id == 0 {
                    // 空き地を塗る
                    let is_enclave = !self.has_adjacent_faction(x, y, faction_id);
                    let cost = if is_enclave {
                        self.compute_enclave_cost(x, y, faction_id, cfg.claim_cost, cfg)
                    } else {
                        cfg.claim_cost
                    };
                    Ok(EvaluatedAction {
                        kind: ActionKind::ClaimNeutral,
                        cost,
                        is_enclave,
                        target_faction: 0,
                    })
                } else if cell.faction_id == faction_id {
                    // 自勢力マスへの重ね塗り
                    if cell.layers >= rules.max_layers {
                        return Err(ActionError::MaxLayersReached);
                    }
                    Ok(EvaluatedAction {
                        kind: ActionKind::Reinforce,
                        cost: cfg.reinforce_cost,
                        is_enclave: false,
                        target_faction: faction_id,
                    })
                } else {
                    // 他勢力マスを奪う
                    let layers = cell.layers.max(1) as u16;
                    let is_enclave = !self.has_adjacent_faction(x, y, faction_id);
                    let (kind, base_cost) = if cell.is_core() {
                        (
                            ActionKind::CaptureEnemyCore,
                            Self::compute_enemy_capture_cost(layers, cfg.claim_cost, cfg.enemy_core_multiplier),
                        )
                    } else {
                        (
                            ActionKind::CaptureEnemyNormal,
                            Self::compute_enemy_capture_cost(layers, cfg.claim_cost, cfg.enemy_normal_multiplier),
                        )
                    };
                    let cost = if is_enclave {
                        self.compute_enclave_cost(x, y, faction_id, base_cost, cfg)
                    } else {
                        base_cost
                    };
                    Ok(EvaluatedAction {
                        kind,
                        cost,
                        is_enclave,
                        target_faction: cell.faction_id,
                    })
                }
            }
        }
    }

    /// 評価済みアクションを盤面へ適用し、変更後のセルと初期中核消費の有無を返す
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub fn apply_evaluated_action(
        &mut self,
        x: usize,
        y: usize,
        faction_id: u16,
        faction_color_id: u8,
        requested_color_id: u8,
        eval: EvaluatedAction,
        initial_core_remaining: bool,
    ) -> (Cell, bool) {
        self.apply_evaluated_action_with_rules(
            x,
            y,
            faction_id,
            faction_color_id,
            requested_color_id,
            eval,
            initial_core_remaining,
            &GameRulesConfig::default(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn apply_evaluated_action_with_rules(
        &mut self,
        x: usize,
        y: usize,
        faction_id: u16,
        faction_color_id: u8,
        requested_color_id: u8,
        eval: EvaluatedAction,
        initial_core_remaining: bool,
        rules: &GameRulesConfig,
    ) -> (Cell, bool) {
        let idx = self.idx(x, y);
        let old = self.cells[idx];
        let mut next = old;
        let mut consumed_initial_core = false;

        match eval.kind {
            ActionKind::ClaimNeutral => {
                next.faction_id = faction_id;
                next.color_id = faction_color_id;
                next.layers = 1;
                next.set_assimilation_ticks(0);
                // 自勢力の旧中核復帰を先に判定し、初期中核枠の不要消費を防ぐ
                if old.old_core_faction == faction_id && old.old_core_ttl() > 0 {
                    next.set_core(true);
                    next.old_core_faction = 0;
                    next.set_old_core_ttl(0);
                } else if initial_core_remaining {
                    // 初期中核枠が残っていれば即時中核化
                    next.set_core(true);
                    next.old_core_faction = 0;
                    next.set_old_core_ttl(0);
                    consumed_initial_core = true;
                } else {
                    next.set_core(false);
                }
            }
            ActionKind::Reinforce => {
                // 破損データ等で layers == 255 の場合でもパニック・ラップアラウンドしないよう飽和加算
                next.layers = old.layers.saturating_add(1).min(rules.max_layers);
            }
            ActionKind::Recolor => {
                next.color_id = requested_color_id;
            }
            ActionKind::CaptureEnemyNormal | ActionKind::CaptureEnemyCore => {
                next.faction_id = faction_id;
                next.color_id = faction_color_id;
                next.layers = 1;
                next.set_assimilation_ticks(0);

                // 旧中核履歴の判定
                if old.is_core() {
                    // 敵の中核ドットを奪取 → 保持時間が1以上の場合のみ元の勢力の中核履歴を保持
                    next.set_core(false);
                    if rules.old_core_ttl_ticks > 0 {
                        next.old_core_faction = old.faction_id;
                        next.set_old_core_ttl(rules.old_core_ttl_ticks);
                    } else {
                        next.old_core_faction = 0;
                        next.set_old_core_ttl(0);
                    }
                } else if old.old_core_faction == faction_id && old.old_core_ttl() > 0 {
                    // 12時間以内に元の勢力が奪還 → 即座に中核ドットとして復活
                    next.set_core(true);
                    next.old_core_faction = 0;
                    next.set_old_core_ttl(0);
                } else if !old.is_core() && initial_core_remaining {
                    // 元のマスが中核マスでない場合のみ、初期中核枠が残っていれば即時中核化
                    next.set_core(true);
                    next.old_core_faction = 0;
                    next.set_old_core_ttl(0);
                    consumed_initial_core = true;
                } else {
                    // 第三国の旧中核履歴が残っていればそのまま引き継ぐ
                    next.set_core(false);
                }
            }
        }

        self.cells[idx] = next;
        let cid = self.chunk_id(x, y);
        if cid < self.total_chunks && !self.index_dirty_chunks[cid].load(Ordering::Acquire) {
            let old_fid = if old.is_land() { old.faction_id } else { 0 };
            let new_fid = if next.is_land() { next.faction_id } else { 0 };
            if old_fid != new_fid {
                let mut faction_idx = self.faction_index.write();
                if old_fid != 0 {
                    faction_idx.adjust_cell(cid, old_fid, -1);
                }
                if new_fid != 0 {
                    faction_idx.adjust_cell(cid, new_fid, 1);
                }
            }
        }
        self.mark_chunk_dirty_internal(x, y);
        (next, consumed_initial_core)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat_land_board(size: usize) -> Board {
        Board::from_terrain(size, &vec![1u8; size * size])
    }

    #[test]
    fn cell_size_is_exactly_8_bytes() {
        assert_eq!(std::mem::size_of::<Cell>(), 8);
        assert_eq!(CHUNK_BYTE_LEN, 20_000);
    }

    #[test]
    fn flags_bit_packing_works() {
        let mut c = Cell::default();
        c.set_core(true);
        c.set_assimilation_ticks(6);
        c.set_old_core_ttl(12);
        assert!(c.is_core());
        assert_eq!(c.assimilation_ticks(), 6);
        assert_eq!(c.old_core_ttl(), 12);

        c.set_core(false);
        assert!(!c.is_core());
        assert_eq!(c.assimilation_ticks(), 6);
        assert_eq!(c.old_core_ttl(), 12);
    }

    #[test]
    fn chunk_extract_and_load_roundtrip() {
        let mut b1 = flat_land_board(250);
        let idx = b1.idx(134, 217);
        b1.cells[idx].faction_id = 12;
        b1.cells[idx].color_id = 33;
        b1.cells[idx].layers = 7;
        b1.cells[idx].set_core(true);
        b1.cells[idx].old_core_faction = 9;
        b1.cells[idx].set_old_core_ttl(10);

        let cid = b1.chunk_id(134, 217);
        let blob = b1.extract_chunk_bytes(cid);

        let mut b2 = flat_land_board(250);
        b2.load_chunk_bytes(cid, &blob).unwrap();
        assert_eq!(b2.cells[idx], b1.cells[idx]);
    }

    #[test]
    fn action_costs_enclave_recolor_and_recapture() {
        let mut board = flat_land_board(250);

        // 1. 初期打設（飛び地なので 1 * 3 = 3 AP、初期中核消費）
        let e1 = board.evaluate_action(10, 10, 1, ActionMode::Paint, 0).unwrap();
        assert_eq!(e1.cost, 3);
        assert!(e1.is_enclave);
        let (c1, consumed) = board.apply_evaluated_action(10, 10, 1, 5, 5, e1, true);
        assert!(consumed);
        assert!(c1.is_core());
        assert_eq!(c1.layers, 1);

        // 2. 隣接打設（飛び地でないので 1 AP）
        for (nx, ny) in [(9, 10), (11, 10), (10, 9), (10, 11)] {
            let e = board.evaluate_action(nx, ny, 1, ActionMode::Paint, 0).unwrap();
            assert_eq!(e.cost, 1);
            assert!(!e.is_enclave);
            board.apply_evaluated_action(nx, ny, 1, 5, 5, e, true);
        }

        // 3. 重ね塗り（1 AP, 最大10層）
        for expected_layer in 2..=10 {
            let e = board.evaluate_action(10, 10, 1, ActionMode::Paint, 0).unwrap();
            assert_eq!(e.cost, 1);
            let (c, _) = board.apply_evaluated_action(10, 10, 1, 5, 5, e, false);
            assert_eq!(c.layers, expected_layer);
        }
        assert_eq!(
            board.evaluate_action(10, 10, 1, ActionMode::Paint, 0),
            Err(ActionError::MaxLayersReached)
        );

        // 4. マス色変更（AP不要, 層数10維持）
        let re = board.evaluate_action(10, 10, 1, ActionMode::Recolor, 42).unwrap();
        assert_eq!(re.cost, 0);
        let (rc, _) = board.apply_evaluated_action(10, 10, 1, 5, 42, re, false);
        assert_eq!(rc.color_id, 42);
        assert_eq!(rc.layers, 10);

        // 囲まれていない自勢力マスでも色変更可能（AP不要）
        let re_edge = board.evaluate_action(9, 10, 1, ActionMode::Recolor, 42).unwrap();
        assert_eq!(re_edge.cost, 0);

        // 5. 敵勢力2が勢力1の10層中核ドットを飛び地で上書き: 10 * 2 * 3 = 60 AP
        let cap = board.evaluate_action(10, 10, 2, ActionMode::Paint, 0).unwrap();
        assert_eq!(cap.kind, ActionKind::CaptureEnemyCore);
        assert_eq!(cap.cost, 60);
        let (cc, consumed2) = board.apply_evaluated_action(10, 10, 2, 12, 12, cap, true);
        // 敵マス奪取は初期中核を消費しない
        assert!(!consumed2);
        assert!(!cc.is_core());
        assert_eq!(cc.faction_id, 2);
        assert_eq!(cc.color_id, 12);
        assert_eq!(cc.layers, 1);
        assert_eq!(cc.old_core_faction, 1);
        assert_eq!(cc.old_core_ttl(), 10);

        // 6. 勢力1が12時間以内に奪還 → 即座に中核復活（隣接あり・通常1層 = 1 AP）
        let recap = board.evaluate_action(10, 10, 1, ActionMode::Paint, 0).unwrap();
        assert_eq!(recap.cost, 1);
        let (rc2, _) = board.apply_evaluated_action(10, 10, 1, 5, 5, recap, false);
        assert!(rc2.is_core());
        assert_eq!(rc2.old_core_faction, 0);
        assert_eq!(rc2.old_core_ttl(), 0);

        // 7. 距離に応じた飛び地コスト増加（勢力2が (50, 10) に領土を持つとき、(10, 11) への距離は 41 → 増加倍率 3.0 + (40/10)*0.5 = 5.0）
        let far_idx = board.idx(50, 10);
        board.cells[far_idx].faction_id = 2;
        board.mark_chunk_dirty(50, 10);
        let far_claim = board.evaluate_action(10, 11, 2, ActionMode::Paint, 0).unwrap();
        assert!(far_claim.is_enclave);
        assert!(
            far_claim.cost > 3,
            "遠距離の飛び地は基本倍率3より高くなるべき: {}",
            far_claim.cost
        );
    }

    #[test]
    fn enemy_capture_cost_uses_claim_multiplier_and_ceil() {
        let mut board = flat_land_board(50);
        // 勢力1の通常マス(10,10)と中核マス(10,11)を用意し、勢力2の隣接マス(9,10),(9,11)を配置
        let i_norm = board.idx(10, 10);
        board.cells[i_norm].faction_id = 1;
        board.cells[i_norm].layers = 1;
        let i_core = board.idx(10, 11);
        board.cells[i_core].faction_id = 1;
        board.cells[i_core].layers = 1;
        board.cells[i_core].set_core(true);

        let a1 = board.idx(9, 10);
        board.cells[a1].faction_id = 2;
        let a2 = board.idx(9, 11);
        board.cells[a2].faction_id = 2;

        let cfg = CostConfig {
            claim_cost: 1,
            reinforce_cost: 1,
            enemy_normal_multiplier: 1.5,
            enemy_core_multiplier: 1.5,
            ..CostConfig::default()
        };

        // 1層 × 塗り基本1 × 1.5倍 = 1.5 → 切り上げ 2
        let cap_core_1 = board
            .evaluate_action_with_config(10, 11, 2, ActionMode::Paint, 0, &cfg)
            .unwrap();
        assert_eq!(cap_core_1.cost, 2);

        // 2層 × 塗り基本1 × 1.5倍 = 3.0 → 3
        board.cells[i_core].layers = 2;
        let cap_core_2 = board
            .evaluate_action_with_config(10, 11, 2, ActionMode::Paint, 0, &cfg)
            .unwrap();
        assert_eq!(cap_core_2.cost, 3);

        // 塗り基本3 × 1.2倍 × 1層 = 3.6 → 切り上げ 4、5層なら 3 × 1.2 × 5 = 18.0 → 18
        let cfg2 = CostConfig {
            claim_cost: 3,
            enemy_normal_multiplier: 1.2,
            ..cfg
        };
        let cap_norm_1 = board
            .evaluate_action_with_config(10, 10, 2, ActionMode::Paint, 0, &cfg2)
            .unwrap();
        assert_eq!(cap_norm_1.cost, 4);

        board.cells[i_norm].layers = 5;
        let cap_norm_5 = board
            .evaluate_action_with_config(10, 10, 2, ActionMode::Paint, 0, &cfg2)
            .unwrap();
        assert_eq!(cap_norm_5.cost, 18);
    }

    #[test]
    fn diagonal_adjacent_cells_are_not_treated_as_enclave() {
        let mut board = flat_land_board(50);
        let center_idx = board.idx(20, 20);
        board.cells[center_idx].faction_id = 1;
        board.cells[center_idx].layers = 1;

        // 斜め4方向 (19,19), (21,19), (19,21), (21,21) の空き地は飛び地扱いにならない
        for (dx, dy) in [(19, 19), (21, 19), (19, 21), (21, 21)] {
            let e = board.evaluate_action(dx, dy, 1, ActionMode::Paint, 0).unwrap();
            assert!(!e.is_enclave, "斜め隣接 ({}, {}) は飛び地にならないべきです", dx, dy);
            assert_eq!(e.cost, 1);
        }

        // 斜め位置にある敵マスも飛び地扱いにならず通常奪取コストになる
        let enemy_diag = board.idx(21, 21);
        board.cells[enemy_diag].faction_id = 2;
        board.cells[enemy_diag].layers = 1;
        let cap = board.evaluate_action(21, 21, 1, ActionMode::Paint, 0).unwrap();
        assert!(!cap.is_enclave);
        assert_eq!(cap.cost, 1);
    }

    #[test]
    fn nearest_faction_distance_handles_zero_distance_and_empty_territory() {
        let mut board = flat_land_board(100);
        // 領土を持たない勢力は即座に None を返す
        assert_eq!(board.nearest_faction_distance(10, 10, 1), None);

        // 指定セル自身と隣接セルが自勢力陸地の場合、最小距離は 1 ではなく 0 を返す
        let e1 = board.evaluate_action(10, 10, 1, ActionMode::Paint, 0).unwrap();
        board.apply_evaluated_action(10, 10, 1, 1, 1, e1, false);
        let e2 = board.evaluate_action(10, 9, 1, ActionMode::Paint, 0).unwrap();
        board.apply_evaluated_action(10, 9, 1, 1, 1, e2, false);

        assert_eq!(board.nearest_faction_distance(10, 10, 1), Some(0));
        assert_eq!(board.nearest_faction_distance(12, 10, 1), Some(2));
    }

    #[test]
    fn recolor_rejects_faction_zero() {
        let board = flat_land_board(50);
        // 無所属 (faction_id == 0) で空き地を Recolor 評価しても確実に拒否される
        assert_eq!(
            board.evaluate_action(10, 10, 0, ActionMode::Recolor, 5),
            Err(ActionError::NotOwnedForRecolor)
        );
    }

    #[test]
    fn reinforce_saturates_without_overflow_when_layers_is_max_u8() {
        let mut board = flat_land_board(50);
        let idx = board.idx(10, 10);
        board.cells[idx].faction_id = 1;
        board.cells[idx].layers = u8::MAX;
        let eval = EvaluatedAction {
            kind: ActionKind::Reinforce,
            cost: 1,
            is_enclave: false,
            target_faction: 1,
        };
        let rules = GameRulesConfig::default();
        let (next, _) = board.apply_evaluated_action_with_rules(10, 10, 1, 1, 1, eval, false, &rules);
        assert_eq!(next.layers, rules.max_layers);
    }

    #[test]
    fn cost_config_validate_rejects_u16_overflow() {
        assert!(CostConfig::default().validate().is_ok());
        let extreme = CostConfig {
            claim_cost: 50,
            reinforce_cost: 50,
            enemy_normal_multiplier: 50.0,
            enemy_core_multiplier: 50.0,
            enclave_base_multiplier: 20.0,
            enclave_distance_step: 1,
            enclave_distance_rate: 10.0,
        };
        assert!(extreme.validate().is_err());
    }
}
