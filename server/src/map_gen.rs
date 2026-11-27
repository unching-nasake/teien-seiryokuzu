use rand::{rngs::StdRng, Rng, SeedableRng};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::f64::consts::TAU;

/// 選択可能な正方形マップサイズ一覧
pub const ALLOWED_MAP_SIZES: &[usize] = &[100, 250, 500, 750, 1000];
/// デフォルトマップサイズ (250×250)
pub const DEFAULT_MAP_SIZE: usize = 250;
/// デフォルト大陸数 (1)
pub const DEFAULT_CONTINENT_COUNT: u32 = 1;
/// デフォルト島数 (6)
pub const DEFAULT_ISLAND_COUNT: u32 = 6;
/// デフォルト陸地割合 (%)
pub const DEFAULT_LAND_RATIO_PCT: u32 = 40;
/// 地形生成で許容するマップ一辺の最大サイズ（整数オーバーフロー・OOM防止）
const MAX_TERRAIN_SIZE: usize = 2048;
/// 地形生成で許容する陸塊（大陸＋島）の最大合計数（整数オーバーフロー・OOM防止）
const MAX_LAND_BODIES: usize = 1024;

/// マップサイズごとの破綻しない設定上限値
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct MapSizeLimits {
    pub size: usize,
    pub max_continents: u32,
    pub max_islands: u32,
    pub min_land_ratio_pct: u32,
    pub max_land_ratio_pct: u32,
}

/// マップサイズに応じた安全な設定上限値を返す
pub fn limits_for_size(size: usize) -> Option<MapSizeLimits> {
    match size {
        100 => Some(MapSizeLimits {
            size: 100,
            max_continents: 2,
            max_islands: 8,
            min_land_ratio_pct: 15,
            max_land_ratio_pct: 65,
        }),
        250 => Some(MapSizeLimits {
            size: 250,
            max_continents: 4,
            max_islands: 20,
            min_land_ratio_pct: 15,
            max_land_ratio_pct: 70,
        }),
        500 => Some(MapSizeLimits {
            size: 500,
            max_continents: 8,
            max_islands: 45,
            min_land_ratio_pct: 15,
            max_land_ratio_pct: 70,
        }),
        750 => Some(MapSizeLimits {
            size: 750,
            max_continents: 12,
            max_islands: 70,
            min_land_ratio_pct: 15,
            max_land_ratio_pct: 70,
        }),
        1000 => Some(MapSizeLimits {
            size: 1000,
            max_continents: 16,
            max_islands: 100,
            min_land_ratio_pct: 15,
            max_land_ratio_pct: 70,
        }),
        _ => None,
    }
}

/// 全サイズの上限値リストを返す（管理UI向け）
pub fn all_size_limits() -> Vec<MapSizeLimits> {
    ALLOWED_MAP_SIZES
        .iter()
        .filter_map(|&s| limits_for_size(s))
        .collect()
}

/// マップ生成パラメータ
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct MapGenParams {
    /// 正方形の一辺サイズ (100 / 250 / 500 / 750 / 1000)
    pub size: usize,
    /// 大陸の数
    pub continent_count: u32,
    /// 島の数
    pub island_count: u32,
    /// 陸地の割合 (%)
    pub land_ratio_pct: u32,
    /// 地形生成シード値
    pub seed: u64,
}

impl MapGenParams {
    pub fn default_with_seed(seed: u64) -> Self {
        Self {
            size: DEFAULT_MAP_SIZE,
            continent_count: DEFAULT_CONTINENT_COUNT,
            island_count: DEFAULT_ISLAND_COUNT,
            land_ratio_pct: DEFAULT_LAND_RATIO_PCT,
            seed,
        }
    }

    /// サイズごとの上限・下限に照らして妥当性を検証する
    pub fn validate(&self) -> Result<(), String> {
        let Some(lim) = limits_for_size(self.size) else {
            return Err(format!(
                "未対応のマップサイズです: {} (選択可能: {:?})",
                self.size, ALLOWED_MAP_SIZES
            ));
        };
        if self.continent_count > lim.max_continents {
            return Err(format!(
                "サイズ {}×{} の大陸数上限は {} です",
                self.size, self.size, lim.max_continents
            ));
        }
        if self.island_count > lim.max_islands {
            return Err(format!(
                "サイズ {}×{} の島数上限は {} です",
                self.size, self.size, lim.max_islands
            ));
        }
        if self.continent_count == 0 && self.island_count == 0 {
            return Err("大陸または島を少なくとも1つ以上設定してください".to_string());
        }
        if self.land_ratio_pct < lim.min_land_ratio_pct
            || self.land_ratio_pct > lim.max_land_ratio_pct
        {
            return Err(format!(
                "サイズ {}×{} の陸地割合は {}%〜{}% の範囲で指定してください",
                self.size, self.size, lim.min_land_ratio_pct, lim.max_land_ratio_pct
            ));
        }
        Ok(())
    }
}

/// 2D ハッシュ関数（決定論的グラデーションノイズ用）
#[inline]
fn hash2(x: i32, y: i32, seed: u64) -> u64 {
    let mut h = (x as i64 as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ (y as i64 as u64).wrapping_mul(0xBF58_476D_1CE4_E5B9)
        ^ seed.wrapping_mul(0x94D0_49BB_1331_11EB);
    h ^= h >> 30;
    h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h ^= h >> 27;
    h = h.wrapping_mul(0x94D0_49BB_1331_11EB);
    h ^ (h >> 31)
}

#[inline]
fn fade(t: f64) -> f64 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

#[inline]
fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

#[inline]
fn grad(hash: u64, dx: f64, dy: f64) -> f64 {
    match hash & 7 {
        0 => dx + dy,
        1 => -dx + dy,
        2 => dx - dy,
        3 => -dx - dy,
        4 => dx,
        5 => -dx,
        6 => dy,
        _ => -dy,
    }
}

/// 2D パーリンノイズ (-1.0..1.0 付近)
fn perlin2d(x: f64, y: f64, seed: u64) -> f64 {
    let x0 = x.floor() as i32;
    let y0 = y.floor() as i32;
    let xf = x - x0 as f64;
    let yf = y - y0 as f64;

    let u = fade(xf);
    let v = fade(yf);

    let aa = grad(hash2(x0, y0, seed), xf, yf);
    let ba = grad(hash2(x0 + 1, y0, seed), xf - 1.0, yf);
    let ab = grad(hash2(x0, y0 + 1, seed), xf, yf - 1.0);
    let bb = grad(hash2(x0 + 1, y0 + 1, seed), xf - 1.0, yf - 1.0);

    let x1 = lerp(aa, ba, u);
    let x2 = lerp(ab, bb, u);
    lerp(x1, x2, v)
}

/// フラクタルブラウン運動 (fBm)
fn fbm(x: f64, y: f64, seed: u64, octaves: u32) -> f64 {
    let mut sum = 0.0;
    let mut amp = 0.5;
    let mut freq = 1.0;
    let mut norm = 0.0;
    for i in 0..octaves {
        sum += perlin2d(x * freq, y * freq, seed.wrapping_add(i as u64 * 1013)) * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2.03;
    }
    sum / norm
}

/// 大陸・島それぞれの有機的ボディ定義（正規化座標 0..1）
#[derive(Clone, Debug)]
struct LandBody {
    cx: f64,
    cy: f64,
    radius: f64,
    aspect: f64,
    cos_rot: f64,
    sin_rot: f64,
    /// 角度方向の有機的輪郭歪み（半島・入り江を形成）
    harmonics: [(f64, f64, f64); 3], // (freq, amp, phase)
    weight: f64,
    /// 距離枝刈り用の閾値二乗値（(1.8 * max_eff_r)^2）
    cutoff_sq: f64,
}

impl LandBody {
    /// 陸塊パラメータと距離枝刈り用の閾値二乗値を事前計算して構築する
    #[allow(clippy::too_many_arguments)]
    fn new(
        cx: f64,
        cy: f64,
        radius: f64,
        aspect: f64,
        angle: f64,
        harmonics: [(f64, f64, f64); 3],
        weight: f64,
    ) -> Self {
        let max_eff_r = (radius * 1.50).max(0.015);
        let cutoff_sq = (1.8 * max_eff_r).powi(2);
        Self {
            cx,
            cy,
            radius,
            aspect,
            cos_rot: angle.cos(),
            sin_rot: angle.sin(),
            harmonics,
            weight,
            cutoff_sq,
        }
    }

    /// 指定座標におけるこの陸塊からの寄与値（中心ほど高い、正のピークを持つ）
    #[inline]
    fn evaluate(&self, nx: f64, ny: f64) -> f64 {
        let dx = nx - self.cx;
        let dy = ny - self.cy;
        // 回転＋扁平楕円変換
        let rx = dx * self.cos_rot + dy * self.sin_rot;
        let ry = (-dx * self.sin_rot + dy * self.cos_rot) * self.aspect;
        let dist_sq = rx * rx + ry * ry;
        // 最大有効半径の1.8倍以遠は必ず定数海溝値となるため、sqrt/atan2/sin を枝刈り
        if dist_sq >= self.cutoff_sq {
            return -2.24 * self.weight;
        }
        let dist = dist_sq.sqrt();
        let angle = ry.atan2(rx);

        // 角度方向の調和歪みでランダムな半島・湾を生成
        let mut rad_mod = 1.0;
        for &(freq, amp, phase) in &self.harmonics {
            rad_mod += amp * (angle * freq + phase).sin();
        }
        let eff_r = (self.radius * rad_mod.clamp(0.55, 1.50)).max(0.015);
        let d = dist / eff_r;

        // 滑らかなフォールオフ（d=0 で weight, d=1 で 0, d>1 で負の海溝へなだらかに低下）
        if d < 1.8 {
            let falloff = 1.0 - d * d;
            self.weight * falloff
        } else {
            -2.24 * self.weight
        }
    }
}

/// 指定パラメータに基づき size×size の地形配列 (0: 海, 1: 陸地) を生成する
/// 大陸・島の配置・形はシードに応じてランダム生成され、陸地割合は目標値へ自動調整される
pub fn generate_terrain(params: &MapGenParams) -> Vec<u8> {
    let size = params.size;
    if size > MAX_TERRAIN_SIZE {
        return Vec::new();
    }
    let Some(total) = size.checked_mul(size) else {
        return Vec::new();
    };
    if size < 2 {
        return vec![0u8; total];
    }

    let cont_n = params.continent_count as usize;
    let isl_n = params.island_count as usize;
    let Some(body_total) = cont_n.checked_add(isl_n) else {
        return vec![0u8; total];
    };
    if body_total == 0 || body_total > MAX_LAND_BODIES {
        return vec![0u8; total];
    }

    let mut rng = StdRng::seed_from_u64(params.seed);

    let land_frac = (params.land_ratio_pct as f64 / 100.0).clamp(0.10, 0.75);

    // 面積配分：大陸が存在する場合は陸地の約80〜85%を大陸、残りを島々へ配分
    let (cont_total_area, isl_total_area) = match (cont_n > 0, isl_n > 0) {
        (true, true) => (land_frac * 0.80, land_frac * 0.20),
        (true, false) => (land_frac, 0.0),
        (false, true) => (0.0, land_frac),
        (false, false) => (0.0, 0.0),
    };

    let mut bodies: Vec<LandBody> = Vec::with_capacity(body_total);

    // 1. 大陸のランダム配置と形状パラメータ生成
    if cont_n > 0 {
        let avg_r = (cont_total_area / (cont_n as f64 * std::f64::consts::PI))
            .sqrt()
            .clamp(0.08, 0.36);

        for idx in 0..cont_n {
            let r = avg_r * rng.gen_range(0.82..1.18);
            let margin = (r * 0.75).clamp(0.10, 0.28);
            let mut best_pos = (
                rng.gen_range(margin..(1.0 - margin)),
                rng.gen_range(margin..(1.0 - margin)),
            );

            // 他の大陸と適度に距離が離れる配置を探索
            let mut best_min_dist = -1.0_f64;
            let tries = if idx == 0 { 1 } else { 40 };
            for _ in 0..tries {
                let cx = rng.gen_range(margin..(1.0 - margin));
                let cy = rng.gen_range(margin..(1.0 - margin));
                let min_d = bodies
                    .iter()
                    .map(|b| ((cx - b.cx).hypot(cy - b.cy)) / (r + b.radius))
                    .fold(f64::INFINITY, f64::min);
                if min_d > best_min_dist {
                    best_min_dist = min_d;
                    best_pos = (cx, cy);
                }
                if min_d > 1.15 {
                    break;
                }
            }

            let angle = rng.gen_range(0.0..TAU);
            bodies.push(LandBody::new(
                best_pos.0,
                best_pos.1,
                r,
                rng.gen_range(0.68..1.45),
                angle,
                [
                    (2.0, rng.gen_range(0.08..0.22), rng.gen_range(0.0..TAU)),
                    (3.0, rng.gen_range(0.06..0.18), rng.gen_range(0.0..TAU)),
                    (5.0, rng.gen_range(0.04..0.12), rng.gen_range(0.0..TAU)),
                ],
                1.0,
            ));
        }
    }

    // 2. 島のランダム配置と形状パラメータ生成（大陸や他島と重なりにくい海域を探索）
    if isl_n > 0 {
        let base_isl_r = (isl_total_area / (isl_n as f64 * std::f64::consts::PI))
            .sqrt()
            .clamp(0.028, 0.14);

        for _ in 0..isl_n {
            // 小島から大きめの島まで大小のばらつきを持たせる（大陸サイズにはしない）
            let scale = 0.42 + 1.28 * rng.gen_range(0.0..1.0_f64).powf(1.35);
            let r = (base_isl_r * scale).clamp(0.020, 0.145);
            let margin = (r * 1.15).clamp(0.05, 0.18);
            let mut best_pos = (
                rng.gen_range(margin..(1.0 - margin)),
                rng.gen_range(margin..(1.0 - margin)),
            );
            let mut best_score = f64::NEG_INFINITY;

            for _ in 0..55 {
                let cx = rng.gen_range(margin..(1.0 - margin));
                let cy = rng.gen_range(margin..(1.0 - margin));
                // すべての既存陸塊からの距離マージンを計算
                let min_clearance = bodies
                    .iter()
                    .map(|b| (cx - b.cx).hypot(cy - b.cy) - (b.radius * 1.12 + r * 1.25))
                    .fold(f64::INFINITY, f64::min);
                if min_clearance > best_score {
                    best_score = min_clearance;
                    best_pos = (cx, cy);
                }
                if min_clearance > 0.04 {
                    break;
                }
            }

            let angle = rng.gen_range(0.0..TAU);
            // 島のピークを大陸と同等レベルに保ち、陸地割合調整時に島が沈まないようにする
            bodies.push(LandBody::new(
                best_pos.0,
                best_pos.1,
                r,
                rng.gen_range(0.70..1.40),
                angle,
                [
                    (2.0, rng.gen_range(0.06..0.18), rng.gen_range(0.0..TAU)),
                    (3.0, rng.gen_range(0.04..0.14), rng.gen_range(0.0..TAU)),
                    (4.0, rng.gen_range(0.03..0.10), rng.gen_range(0.0..TAU)),
                ],
                0.96,
            ));
        }
    }

    // 3. ドメインワーピング＋海岸ディテールノイズ合成で全セルの高度場を生成
    let warp_seed_x = params.seed ^ 0xA1B2_C3D4_E5F6_0123;
    let warp_seed_y = params.seed ^ 0x5E6F_7081_92A3_B4C5;
    let detail_seed = params.seed ^ 0x1357_9BDF_2468_ACE0;

    let mut heights = vec![0.0_f32; total];
    let inv = 1.0 / size as f64;
    let bodies_ref = &bodies;

    // 高度場生成を rayon で行単位に並列化（各セルは独立・決定論的）
    heights
        .par_chunks_mut(size)
        .enumerate()
        .for_each(|(y, row)| {
            let ny = (y as f64 + 0.5) * inv;
            let edge_y = (ny.min(1.0 - ny) / 0.035).min(1.0);
            for (x, cell_h) in row.iter_mut().enumerate() {
                let nx = (x as f64 + 0.5) * inv;

                // 自然な海岸線カーブを生むドメインワーピング
                let wx = fbm(nx * 4.5, ny * 4.5, warp_seed_x, 3) * 0.055;
                let wy = fbm(nx * 4.5 + 3.1, ny * 4.5 + 7.4, warp_seed_y, 3) * 0.055;
                let pnx = nx + wx;
                let pny = ny + wy;

                // 各大陸・島のうち最も強い影響値を採用（滑らかな接合）
                let mut max_body = f64::NEG_INFINITY;
                for body in bodies_ref {
                    let v = body.evaluate(pnx, pny);
                    if v > max_body {
                        max_body = v;
                    }
                }

                // 細かいリアス式海岸・入江ディテール
                let detail = fbm(nx * 10.0, ny * 10.0, detail_seed, 4) * 0.24;

                // 盤面外周を緩やかに海へ落とす
                let edge_x = (nx.min(1.0 - nx) / 0.035).min(1.0);
                let edge_mask = (edge_x * edge_y).sqrt();
                let edge_penalty = (1.0 - edge_mask) * 1.4;

                *cell_h = (max_body + detail - edge_penalty) as f32;
            }
        });

    // 4. 目標の陸地割合になるよう海面閾値を分位数で精密キャリブレーション
    let mut sorted = heights.clone();
    let clamped_land_pct = (land_frac * 100.0).round() as usize;
    let sea_pct = 100usize.saturating_sub(clamped_land_pct);
    let sea_target_idx = (((total as u128 * sea_pct as u128) / 100) as usize)
        .min(total.saturating_sub(1));
    let (_, threshold_ref, _) = sorted.select_nth_unstable_by(sea_target_idx, |a, b| {
        a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)
    });
    let sea_level = *threshold_ref;

    let mut terrain = vec![0_u8; total];
    for i in 0..total {
        if heights[i] > sea_level {
            terrain[i] = 1;
        }
    }

    // 外周1ピクセルは必ず海とする
    for x in 0..size {
        terrain[x] = 0;
        terrain[(size - 1) * size + x] = 0;
    }
    for y in 0..size {
        terrain[y * size] = 0;
        terrain[y * size + (size - 1)] = 0;
    }

    // 1マス孤立ノイズを軽く平滑化（rayon で行単位並列化）
    let mut smoothed = terrain.clone();
    let terrain_ref = &terrain;
    smoothed
        .par_chunks_mut(size)
        .enumerate()
        .for_each(|(y, row)| {
            if y == 0 || y + 1 >= size {
                return;
            }
            let row_off = y * size;
            for (x, cell_s) in row.iter_mut().enumerate().take(size - 1).skip(1) {
                let idx = row_off + x;
                let land_neighbors = terrain_ref[idx - 1]
                    + terrain_ref[idx + 1]
                    + terrain_ref[idx - size]
                    + terrain_ref[idx + size];
                if terrain_ref[idx] == 1 && land_neighbors == 0 {
                    *cell_s = 0;
                } else if terrain_ref[idx] == 0 && land_neighbors == 4 {
                    *cell_s = 1;
                }
            }
        });

    smoothed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_250_map_matches_land_ratio_and_is_deterministic() {
        let params = MapGenParams::default_with_seed(42);
        params.validate().unwrap();
        let t1 = generate_terrain(&params);
        let t2 = generate_terrain(&params);
        assert_eq!(t1.len(), 250 * 250);
        assert_eq!(t1, t2);

        let land_ratio = t1.iter().filter(|&&v| v == 1).count() as f64 / t1.len() as f64;
        assert!(
            (0.37..=0.43).contains(&land_ratio),
            "陸地比率が想定範囲外です: {:.4}",
            land_ratio
        );
    }

    #[test]
    fn different_seeds_produce_different_random_maps() {
        let t1 = generate_terrain(&MapGenParams::default_with_seed(100));
        let t2 = generate_terrain(&MapGenParams::default_with_seed(200));
        assert_ne!(t1, t2);
    }

    #[test]
    fn limits_reject_invalid_counts_per_size() {
        // 100x100 では大陸上限2・島上限8
        let ok = MapGenParams {
            size: 100,
            continent_count: 2,
            island_count: 8,
            land_ratio_pct: 35,
            seed: 1,
        };
        assert!(ok.validate().is_ok());

        let too_many_cont = MapGenParams {
            continent_count: 3,
            ..ok
        };
        assert!(too_many_cont.validate().is_err());

        let too_many_isl = MapGenParams {
            island_count: 9,
            ..ok
        };
        assert!(too_many_isl.validate().is_err());

        let zero_both = MapGenParams {
            continent_count: 0,
            island_count: 0,
            ..ok
        };
        assert!(zero_both.validate().is_err());
    }

    #[test]
    fn generate_terrain_handles_invalid_and_overflow_inputs() {
        // 極小サイズやオーバーフロー・上限超過入力でもパニックせず安全に返ること
        let zero_size = MapGenParams {
            size: 0,
            continent_count: 1,
            island_count: 1,
            land_ratio_pct: 40,
            seed: 1,
        };
        assert!(generate_terrain(&zero_size).is_empty());

        let huge_size = MapGenParams {
            size: usize::MAX,
            ..zero_size
        };
        assert!(generate_terrain(&huge_size).is_empty());

        let over_limit_size = MapGenParams {
            size: MAX_TERRAIN_SIZE + 1,
            ..zero_size
        };
        assert!(generate_terrain(&over_limit_size).is_empty());

        let overflow_bodies = MapGenParams {
            size: 10,
            continent_count: u32::MAX,
            island_count: u32::MAX,
            land_ratio_pct: 40,
            seed: 1,
        };
        let res = generate_terrain(&overflow_bodies);
        assert_eq!(res.len(), 100);
        assert!(res.iter().all(|&v| v == 0));
    }

    #[test]
    fn land_body_evaluate_cutoff_matches_uncutoff() {
        let body = LandBody::new(
            0.5,
            0.5,
            0.2,
            1.2,
            0.7,
            [(2.0, 0.15, 0.3), (3.0, 0.10, 1.2), (5.0, 0.08, 2.1)],
            0.96,
        );

        for iy in 0..25 {
            for ix in 0..25 {
                let nx = ix as f64 / 24.0;
                let ny = iy as f64 / 24.0;
                let actual = body.evaluate(nx, ny);

                // 距離枝刈りなしの元数式で期待値を計算
                let dx = nx - body.cx;
                let dy = ny - body.cy;
                let rx = dx * body.cos_rot + dy * body.sin_rot;
                let ry = (-dx * body.sin_rot + dy * body.cos_rot) * body.aspect;
                let dist = (rx * rx + ry * ry).sqrt();
                let angle = ry.atan2(rx);
                let mut rad_mod = 1.0;
                for &(freq, amp, phase) in &body.harmonics {
                    rad_mod += amp * (angle * freq + phase).sin();
                }
                let eff_r = (body.radius * rad_mod.clamp(0.55, 1.50)).max(0.015);
                let d = dist / eff_r;
                let expected = if d < 1.8 {
                    body.weight * (1.0 - d * d)
                } else {
                    -2.24 * body.weight
                };

                assert!(
                    (actual - expected).abs() < 1e-12,
                    "座標 ({}, {}) で不一致: actual={}, expected={}",
                    nx,
                    ny,
                    actual,
                    expected
                );
            }
        }
    }
}
