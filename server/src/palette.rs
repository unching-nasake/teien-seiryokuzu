/// 海・背景色 (#122338)
pub const SEA_COLOR_RGB: [u8; 3] = [0x12, 0x23, 0x38];

/// 海色との最小許容 CIELAB 色差 (ΔE76)
#[cfg(test)]
pub const MIN_SEA_DELTA_E: f64 = 15.0;

/// システム定義の 64 色固定パレット (ID: 0..63)
/// 海色 (#122338) と視覚的に紛らわしい近似色 (ΔE < 15) を除外済み
pub const PALETTE: [[u8; 3]; 64] = [
    // 赤・朱・桃系 (0..9)
    [0xE6, 0x39, 0x46], // 0: 紅 (Crimson)
    [0xB9, 0x1C, 0x1C], // 1: 深紅 (Deep Red)
    [0xFF, 0x6B, 0x6B], // 2: 珊瑚 (Coral)
    [0xF9, 0x73, 0x16], // 3: 朱橙 (Orange)
    [0xEA, 0x58, 0x0C], // 4: 柿 (Persimmon)
    [0xFB, 0x92, 0x3C], // 5: 杏 (Apricot)
    [0xF4, 0x3F, 0x5E], // 6: 薔薇 (Rose)
    [0xEC, 0x48, 0x99], // 7: 牡丹 (Magenta Pink)
    [0xF9, 0xA8, 0xD4], // 8: 桜 (Sakura)
    [0x88, 0x13, 0x37], // 9: 臙脂 (Burgundy)
    // 黄・金・茶系 (10..21)
    [0xFA, 0xCC, 0x15], // 10: 山吹 (Gold Yellow)
    [0xEA, 0xB3, 0x08], // 11: 鬱金 (Amber)
    [0xFE, 0xF0, 0x8A], // 12: 菜の花 (Lemon)
    [0xD9, 0x77, 0x06], // 13: 琥珀 (Ochre)
    [0x92, 0x40, 0x0E], // 14: 栗 (Chestnut)
    [0x78, 0x35, 0x0F], // 15: 焦茶 (Dark Brown)
    [0xB4, 0x53, 0x09], // 16: 煉瓦 (Rust)
    [0xD6, 0xA8, 0x7C], // 17: 砂 (Sand)
    [0xF5, 0xDE, 0xB3], // 18: 象牙 (Wheat)
    [0xA1, 0x62, 0x07], // 19: 黄土 (Dark Gold)
    [0x6D, 0x4C, 0x41], // 20: 珈琲 (Mocha)
    [0xBC, 0x8F, 0x8F], // 21: 灰桜 (Rosy Brown)
    // 緑・若草・苔系 (22..35)
    [0x22, 0xC5, 0x5E], // 22: 若葉 (Emerald)
    [0x16, 0xA3, 0x4A], // 23: 常磐 (Green)
    [0x15, 0x80, 0x3D], // 24: 深緑 (Forest)
    [0x4A, 0xDE, 0x80], // 25: 萌黄 (Mint Green)
    [0x86, 0xEF, 0xAC], // 26: 薄緑 (Light Mint)
    [0x84, 0xCC, 0x16], // 27: 鶸 (Lime)
    [0xBE, 0xF2, 0x64], // 28: 若苗 (Chartreuse)
    [0x65, 0xA3, 0x0D], // 29: 苔 (Moss)
    [0x4D, 0x7C, 0x0F], // 30: 松葉 (Olive Green)
    [0x3F, 0x62, 0x12], // 31: 海松 (Dark Olive)
    [0x10, 0xB9, 0x81], // 32: 翡翠 (Jade)
    [0x05, 0x96, 0x69], // 33: 青竹 (Deep Jade)
    [0x14, 0xB8, 0xA6], // 34: 青磁 (Teal)
    [0x0D, 0x94, 0x88], // 35: 納戸 (Deep Teal)
    // 水・空・青系 (36..45) ※海色 #122338 から十分離れた明度・彩度のみ
    [0x06, 0xB6, 0xD4], // 36: 浅葱 (Cyan)
    [0x22, 0xD3, 0xEE], // 37: 水色 (Aqua)
    [0x67, 0xE8, 0xF9], // 38: 空 (Sky Light)
    [0x0E, 0xA5, 0xE9], // 39: 露草 (Sky Blue)
    [0x38, 0xBD, 0xF8], // 40: 勿忘草 (Light Blue)
    [0x3B, 0x82, 0xF6], // 41: 瑠璃 (Royal Blue)
    [0x25, 0x63, 0xEB], // 42: 群青 (Cobalt)
    [0x60, 0xA5, 0xFA], // 43: 藤納戸 (Cornflower)
    [0x93, 0xC5, 0xFD], // 44: 淡青 (Ice Blue)
    [0x4F, 0x46, 0xE5], // 45: 藍紫 (Indigo)
    // 紫・藤・菫系 (46..55)
    [0x63, 0x66, 0xF1], // 46: 桔梗 (Periwinkle)
    [0x81, 0x8C, 0xF8], // 47: 藤 (Soft Indigo)
    [0x7C, 0x3A, 0xED], // 48: 菫 (Violet)
    [0x8B, 0x5C, 0xF6], // 49: 紫苑 (Purple)
    [0xA7, 0x8B, 0xFA], // 50: 薄藤 (Lavender)
    [0xA8, 0x55, 0xF7], // 51: 菖蒲 (Orchid)
    [0xC0, 0x84, 0xFC], // 52: 紅藤 (Lilac)
    [0xD9, 0x46, 0xEF], // 53: 躑躅 (Fuchsia)
    [0xC0, 0x26, 0xD3], // 54: 濃紫 (Deep Fuchsia)
    [0x6B, 0x21, 0xA8], // 55: 江戸紫 (Royal Purple)
    // 無彩色・白・灰・黒系 (56..63)
    [0xFF, 0xFF, 0xFF], // 56: 白 (White)
    [0xF1, 0xF5, 0xF9], // 57: 雪白 (Off White)
    [0xCB, 0xD5, 0xE1], // 58: 銀鼠 (Silver)
    [0x94, 0xA3, 0xB8], // 59: 鼠 (Cool Gray)
    [0x64, 0x74, 0x8B], // 60: 鈍 (Slate Gray)
    [0xA8, 0xA2, 0x9E], // 61: 利休鼠 (Warm Gray)
    [0x57, 0x53, 0x4E], // 62: 炭鼠 (Charcoal)
    [0x09, 0x09, 0x0B], // 63: 漆黒 (Jet Black)
];

/// sRGB (0..255) を CIELAB (D65) に変換
#[cfg(test)]
pub fn rgb_to_lab(rgb: [u8; 3]) -> (f64, f64, f64) {
    let linearize = |c: u8| -> f64 {
        let v = c as f64 / 255.0;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };

    let r = linearize(rgb[0]);
    let g = linearize(rgb[1]);
    let b = linearize(rgb[2]);

    // sRGB -> XYZ (D65)
    let x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
    let y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750) / 1.00000;
    let z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;

    let f = |t: f64| -> f64 {
        const EPSILON: f64 = 216.0 / 24389.0;
        const KAPPA: f64 = 24389.0 / 27.0;
        if t > EPSILON {
            t.cbrt()
        } else {
            (KAPPA * t + 16.0) / 116.0
        }
    };

    let fx = f(x);
    let fy = f(y);
    let fz = f(z);

    let l = 116.0 * fy - 16.0;
    let a = 500.0 * (fx - fy);
    let b_val = 200.0 * (fy - fz);
    (l, a, b_val)
}

/// CIELAB 色差 ΔE76 を計算
#[cfg(test)]
pub fn delta_e76(rgb1: [u8; 3], rgb2: [u8; 3]) -> f64 {
    let (l1, a1, b1) = rgb_to_lab(rgb1);
    let (l2, a2, b2) = rgb_to_lab(rgb2);
    ((l1 - l2).powi(2) + (a1 - a2).powi(2) + (b1 - b2).powi(2)).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn palette_colors_are_distinct_and_far_from_sea() {
        let mut seen = HashSet::new();
        for (idx, &rgb) in PALETTE.iter().enumerate() {
            assert!(
                seen.insert(rgb),
                "パレット色 ID={} ({:?}) が重複しています",
                idx,
                rgb
            );
            let de = delta_e76(rgb, SEA_COLOR_RGB);
            assert!(
                de >= MIN_SEA_DELTA_E,
                "パレット色 ID={} ({:02X}{:02X}{:02X}) の海色との色差 ΔE={:.2} が {:.1} 未満です",
                idx,
                rgb[0],
                rgb[1],
                rgb[2],
                de,
                MIN_SEA_DELTA_E
            );
        }
    }
}
