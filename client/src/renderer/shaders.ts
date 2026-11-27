// WebGL2 バーテックスシェーダー（フルスクリーンクワッド）
export const VERTEX_SHADER_SRC = `#version 300 es
precision highp float;

const vec2 POS[4] = vec2[4](
  vec2(-1.0, -1.0),
  vec2( 1.0, -1.0),
  vec2(-1.0,  1.0),
  vec2( 1.0,  1.0)
);

out vec2 v_uv;

void main() {
  vec2 p = POS[gl_VertexID];
  v_uv = p * 0.5 + 0.5;
  v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

// WebGL2 フラグメントシェーダー（可変正方形マップサイズ対応）
// 国境線強調・戦争中勢力点滅・オーバーレイ切替・ズーム時グリッド線・ホバー枠をすべてGPU並列描画
export const FRAGMENT_SHADER_SRC = `#version 300 es
precision highp float;
precision highp usampler2D;

in vec2 v_uv;
out vec4 fragColor;

uniform usampler2D u_boardTex;    // boardSize x boardSize RGBA8UI
uniform usampler2D u_factionTex;  // 256x256 RGBA8UI (R: relation 0=他/1=自/2=戦争, G: faction_color_id, B: extinct)
uniform vec3 u_palette[64];

uniform vec2 u_resolution;        // キャンバス解像度 (px)
uniform vec2 u_camOffset;         // カメラ中心の盤面座標 (0..boardSize)
uniform float u_zoom;             // 1盤面セルあたりの画面ピクセル数
uniform float u_time;             // 経過秒数（点滅アニメーション用）
uniform int u_overlayMode;        // 0:通常, 1:勢力カラー, 2:層数ヒートマップ, 3:中核/同化/旧中核, 4:外交
uniform int u_showCoreMarker;     // 1: 中核マスの右上印を表示, 0: 非表示
uniform ivec2 u_hoverCell;        // ホバー中セル座標（範囲外は -1,-1）
uniform ivec2 u_selectedCell;     // 選択中セル座標（範囲外は -1,-1）
uniform uint u_highlightFaction;  // 点滅ハイライト中の勢力ID（0は無効）
uniform vec3 u_hoverAccent;       // ホバー・選択マスの強調アクセント色
uniform int u_boardSize;          // 盤面の一辺サイズ (100/250/500/750/1000)
uniform int u_maxLayers;          // 重ね塗り最大層数
uniform int u_assimilationReq;    // 自然中核化に必要なTick数

const vec3 SEA_COLOR = vec3(0.0706, 0.1373, 0.2196);       // #122338
const vec3 SEA_DEEP  = vec3(0.0550, 0.1100, 0.1800);
const vec3 LAND_BASE = vec3(0.8200, 0.7960, 0.7350);       // 和紙・枯山水砂色
const vec3 LAND_ALT  = vec3(0.7950, 0.7700, 0.7100);

uvec4 sampleBoard(ivec2 p) {
  if (p.x < 0 || p.y < 0 || p.x >= u_boardSize || p.y >= u_boardSize) {
    return uvec4(0u);
  }
  return texelFetch(u_boardTex, p, 0);
}

uint extractFaction(uvec4 c) {
  return c.b | (c.a << 8u);
}

uvec4 sampleFactionMeta(uint fid) {
  ivec2 coord = ivec2(int(fid & 255u), int((fid >> 8u) & 255u));
  return texelFetch(u_factionTex, coord, 0);
}

vec3 layerHeatmap(uint layers) {
  float t = clamp(float(layers) / max(1.0, float(u_maxLayers)), 0.0, 1.0);
  if (t < 0.33) {
    return mix(vec3(0.20, 0.72, 0.48), vec3(0.96, 0.84, 0.20), t / 0.33);
  } else if (t < 0.66) {
    return mix(vec3(0.96, 0.84, 0.20), vec3(0.96, 0.40, 0.12), (t - 0.33) / 0.33);
  } else {
    return mix(vec3(0.96, 0.40, 0.12), vec3(0.90, 0.08, 0.36), (t - 0.66) / 0.34);
  }
}

void main() {
  float fBoardSize = float(u_boardSize);
  vec2 screenPx = v_uv * u_resolution;
  vec2 boardPos = u_camOffset + (screenPx - u_resolution * 0.5) / u_zoom;

  // 盤面外は深い海色
  if (boardPos.x < 0.0 || boardPos.y < 0.0 || boardPos.x >= fBoardSize || boardPos.y >= fBoardSize) {
    fragColor = vec4(SEA_DEEP, 1.0);
    return;
  }

  ivec2 cellCoord = ivec2(floor(boardPos));
  vec2 sub = fract(boardPos);

  uvec4 cell = sampleBoard(cellCoord);
  uint colorId = cell.r & 63u;
  uint terrain = (cell.r >> 6u) & 1u;
  uint isCore = (cell.r >> 7u) & 1u;
  uint layers = cell.g & 15u;
  uint hasOldCore = (cell.g >> 4u) & 1u;
  uint assimilation = (cell.g >> 5u) & 7u;
  uint fid = extractFaction(cell);

  // 海マス・陸マス共通で後からグリッド線や選択枠を描画するため color を保持
  vec3 color;

  if (terrain == 0u) {
    // 海マス描画（沿岸シェーディング付き）
    uint nearLand =
      ((sampleBoard(cellCoord + ivec2(-1, 0)).r >> 6u) & 1u) |
      ((sampleBoard(cellCoord + ivec2( 1, 0)).r >> 6u) & 1u) |
      ((sampleBoard(cellCoord + ivec2( 0,-1)).r >> 6u) & 1u) |
      ((sampleBoard(cellCoord + ivec2( 0, 1)).r >> 6u) & 1u);
    color = mix(SEA_COLOR, vec3(0.11, 0.22, 0.34), float(nearLand) * 0.45);
  } else {
    uvec4 fmeta = fid > 0u ? sampleFactionMeta(fid) : uvec4(0u);
    uint relation = fmeta.r;
    uint factionColorId = fmeta.g & 63u;

    if (fid == 0u) {
      float checker = float((cellCoord.x + cellCoord.y) & 1);
      color = mix(LAND_BASE, LAND_ALT, checker * 0.45);
    } else {
      if (u_overlayMode == 0) {
        color = u_palette[colorId];
      } else if (u_overlayMode == 1) {
        color = u_palette[factionColorId];
      } else if (u_overlayMode == 2) {
        color = layerHeatmap(layers);
      } else if (u_overlayMode == 3) {
        vec3 base = u_palette[factionColorId] * 0.45 + vec3(0.12);
        if (isCore == 1u) {
          color = mix(u_palette[factionColorId], vec3(1.0, 0.88, 0.30), 0.48);
        } else if (assimilation > 0u) {
          float p = clamp(float(assimilation) / max(1.0, min(7.0, float(u_assimilationReq))), 0.0, 1.0);
          color = mix(base, vec3(0.35, 0.90, 1.0), 0.25 + 0.55 * p);
        } else {
          color = base;
        }
      } else {
        if (relation == 1u) {
          color = vec3(0.16, 0.78, 0.52);
        } else if (relation == 2u) {
          color = vec3(0.92, 0.18, 0.24);
        } else {
          color = vec3(0.42, 0.48, 0.58);
        }
      }
    }

    // 旧中核地履歴は中立化された空き地にも残るため fid == 0u の外側でハイライトする
    if (u_overlayMode == 3 && hasOldCore == 1u) {
      float pulse = 0.5 + 0.5 * sin(u_time * 4.0);
      color = mix(color, vec3(0.85, 0.30, 1.0), 0.35 + 0.25 * pulse);
    }

    // 国境線判定（上下左右4近傍の factionId 比較）
    if (fid > 0u) {
      uint fLeft  = extractFaction(sampleBoard(cellCoord + ivec2(-1, 0)));
      uint fRight = extractFaction(sampleBoard(cellCoord + ivec2( 1, 0)));
      uint fUp    = extractFaction(sampleBoard(cellCoord + ivec2( 0,-1)));
      uint fDown  = extractFaction(sampleBoard(cellCoord + ivec2( 0, 1)));

      bool isBorderCell = (fLeft != fid) || (fRight != fid) || (fUp != fid) || (fDown != fid);

      if (relation == 2u) {
        float warPulse = 0.5 + 0.5 * sin(u_time * 6.0);
        float strength = isBorderCell ? (0.35 + 0.45 * warPulse) : (0.08 + 0.14 * warPulse);
        color = mix(color, vec3(1.0, 0.12, 0.16), strength);
      }

      // ズームアウト時のエイリアシング・黒潰れ対策として国境線強度を滑らかに減衰
      float borderZoomFade = smoothstep(0.55, 2.0, u_zoom);
      float edgeThickness = clamp(1.35 / max(u_zoom, 0.5), 0.10, 0.38);
      bool onBorderEdge =
        (fLeft  != fid && sub.x < edgeThickness) ||
        (fRight != fid && sub.x > 1.0 - edgeThickness) ||
        (fUp    != fid && sub.y < edgeThickness) ||
        (fDown  != fid && sub.y > 1.0 - edgeThickness);

      if (onBorderEdge && borderZoomFade > 0.001) {
        vec3 borderCol = relation == 2u
          ? vec3(1.0, 0.25, 0.20)
          : (relation == 1u ? vec3(0.98, 0.96, 0.72) : vec3(0.08, 0.10, 0.14));
        color = mix(color, borderCol, 0.78 * borderZoomFade);
      }

      // 注目勢力（ホバー・タップ対象）の点滅ハイライト
      if (u_highlightFaction > 0u && fid == u_highlightFaction) {
        float hlPulse = 0.5 + 0.5 * sin(u_time * 7.5);
        color = mix(color, vec3(1.0, 0.98, 0.88), 0.14 + 0.24 * hlPulse);
        if (onBorderEdge && borderZoomFade > 0.001) {
          color = mix(color, vec3(1.0, 0.98, 0.72), (0.55 + 0.40 * hlPulse) * borderZoomFade);
        }
      }

      if (u_showCoreMarker == 1 && isCore == 1u && u_zoom >= 8.0) {
        bool cornerDot = (sub.x > 0.72 && sub.y < 0.28);
        if (cornerDot) {
          color = mix(color, vec3(1.0, 0.92, 0.45), 0.75);
        }
      }
    }
  }

  // ズーム時のグリッド線描画（海マス上でも描画）
  if (u_zoom >= 6.0) {
    float lineW = clamp(1.0 / u_zoom, 0.02, 0.08);
    if (sub.x < lineW || sub.y < lineW) {
      float alpha = clamp((u_zoom - 6.0) / 14.0, 0.0, 0.30);
      color = mix(color, vec3(0.05, 0.08, 0.12), alpha);
    }
  }

  // 選択中セルの強調点滅ハイライト（スマホタップ選択・確認対象）
  if (cellCoord == u_selectedCell) {
    float selPulse = 0.5 + 0.5 * sin(u_time * 9.0);
    float sfw = clamp(2.5 / max(u_zoom, 0.8), 0.14, 0.34);
    vec3 selEdge = mix(u_hoverAccent, vec3(1.0, 0.99, 0.90), 0.35 + 0.35 * selPulse);
    if (sub.x < sfw || sub.x > 1.0 - sfw || sub.y < sfw || sub.y > 1.0 - sfw) {
      color = selEdge;
    } else {
      color = mix(color, u_hoverAccent, 0.18 + 0.20 * selPulse);
    }
  }

  // ホバーセルハイライト枠（操作種別カラー＋柔らかい点滅）
  if (cellCoord == u_hoverCell && cellCoord != u_selectedCell) {
    float hovPulse = 0.5 + 0.5 * sin(u_time * 8.0);
    float fw = clamp(2.2 / max(u_zoom, 1.0), 0.10, 0.28);
    vec3 hovEdge = mix(u_hoverAccent, vec3(1.0, 0.99, 0.92), 0.42 + 0.25 * hovPulse);
    if (sub.x < fw || sub.x > 1.0 - fw || sub.y < fw || sub.y > 1.0 - fw) {
      color = hovEdge;
    } else {
      color = mix(color, u_hoverAccent, 0.14 + 0.12 * hovPulse);
    }
  }

  fragColor = vec4(color, 1.0);
}
`;
