/**
 * アクティビティログのメッセージを表示用にフォーマットする共通ユーティリティ
 */

export const LOG_TYPES = {
  war: { color: "#ef4444", label: "戦闘", icon: "⚔️" },
  diplomacy: { color: "#3b82f6", label: "外交", icon: "🤝" },
  faction: { color: "#10b981", label: "勢力", icon: "🚩" },
  system: { color: "#8b5cf6", label: "システム", icon: "ℹ️" },
  other: { color: "#6b7280", label: "その他", icon: "📝" },
};

/**
 * ログのカテゴリを判定する
 */
export const getLogCategory = (log) => {
  if (!log) return "other";
  const type = log.type || "";
  const msg = log.message || "";

  if (
    type === "tiles_invaded" ||
    type === "named_tile_fallen" ||
    type === "war" ||
    msg.includes("侵略") ||
    msg.includes("攻撃") ||
    msg.includes("破壊")
  )
    return "war";
  // war_started は勢力動向 (faction) に分類
  if (type === "war_started") return "faction";

  if (
    type.startsWith("alliance_") ||
    type === "diplomacy" ||
    type === "truce_established" ||
    type === "faction_merged" ||
    msg.includes("同盟") ||
    msg.includes("停戦") ||
    msg.includes("合併") ||
    msg.includes("条約") ||
    msg.includes("領土割譲")
  )
    return "diplomacy";
  if (type.startsWith("faction_") || msg.includes("勢力")) return "faction";
  if (
    type === "new_user" ||
    type === "registration" ||
    type === "core_expanded"
  )
    return "system";
  if (type === "system") return "system";

  return "other";
};

/**
 * ログメッセージのテキストを取得する
 */
export const getLogMessageText = (log) => {
  if (typeof log !== "object" || !log) return log || "";
  if (typeof log.content === "string" && log.content) return log.content;
  if (log.message) return log.message;

  const data = log.data || {};
  const type = log.type;

  switch (type) {
    case "new_user":
      return `新規ユーザー (${data.key || log.key || "???"}) が登録されました`;
    case "faction_joined_via_approval":
      return `${data.playerName || data.playerId || "不明"} が承認により「${data.factionName || data.factionId || "???"}」に加入しました (承認者: ${data.approverName || data.approvedBy || "不明"})`;
    case "faction_created":
      return `新勢力「${data.factionName}」が誕生しました (創設者: ${data.creatorName || data.playerShortId || "不明"})`;
    case "faction_joined":
      return `${data.playerName || "不明"} が「${data.factionName || "???"}」に加入しました`;
    case "faction_left":
      return `${data.playerName || "不明"} が「${data.factionName || "???"}」から脱退しました`;
    case "faction_kicked":
      return `${data.targetName || "不明"} が「${data.factionName || "???"}」から追放されました (追放者: ${data.kickerName || "不明"})`;
    case "faction_destroyed": {
      const destroyedName =
        data.destroyedFactionName || data.targetFactionName || "ある勢力";
      const destroyerName = data.destroyerName || "不明";
      const destroyerFaction = data.destroyerFactionName || "ある勢力";
      const rName =
        data.destroyerRoleName && data.destroyerRoleName !== "Member"
          ? `(${data.destroyerRoleName})`
          : "";

      if (data.destroyerName) {
        return `${destroyerName}${rName}[${destroyerFaction}] が ${destroyedName} を滅亡させました`;
      }
      return data.message || `${destroyedName} が滅亡しました`;
    }
    case "faction_merged":
      return `「${data.sourceFactionName || data.absorbedFactionName || "ある勢力"}」が「${data.targetFactionName || data.absorbingFactionName || "別の勢力"}」に吸収合併されました`;
    case "faction_renamed":
      return `「${data.oldName || "???"}」が勢力名を「${data.newName || "???"}」に変更しました`;
    case "faction_independence":
      return `${data.playerName || "不明"} が「${data.oldFactionName || "???"}」から独立し、新たな勢力「${data.newFactionName || "???"}」を立ち上げました`;
    case "alliance_formed":
    case "alliance_created":
      return `同盟結成: 「${data.leaderFactionName || data.names?.[0] || "不明"}」が同盟「${data.allianceName || "???"}」を結成しました`;
    case "alliance_request_sent":
      if (data.isInvitation) {
        return `同盟招待: 同盟「${data.allianceName || "???"}」（盟主：${data.leaderFactionName || "不明"}）が ${data.targetFactionName || "不明"} に招待を送りました`;
      }
      return `同盟加盟申請: 「${data.sourceFactionName || "不明"}」が同盟「${data.allianceName || "???"}」（盟主：${data.leaderFactionName || "不明"}）に加盟申請を送りました`;
    case "alliance_broken":
      return `同盟解消: 「${data.names?.[0] || "?"}」と「${data.names?.[1] || "?"}」の同盟が解消されました`;
    case "alliance_joined":
      return `同盟加盟: ${data.factionName || "不明"} が 同盟「${data.allianceName || "???"}」（盟主：${data.leaderFactionName || "不明"}）に加盟しました`;
    case "alliance_disbanded":
      return `同盟解散: 同盟「${data.allianceName || "???"}」が解散しました`;
    case "named_cell_created":
    case "named_tile_created": {
      const role =
        data.roleName && data.roleName !== "Member" ? `(${data.roleName})` : "";
      const faction = data.factionName ? `[${data.factionName}]` : "";
      return `${data.creatorName || data.playerName || "不明"}${role}${faction} が 「${data.name || data.cellName || "???"}」 を建設しました`;
    }
    case "named_cell_levelup":
      return `「${data.cellName || "???"}」がレベル${data.newLevel || "?"}にアップグレードされました`;
    case "named_cell_destroyed": {
      const cellName = data.name || data.cellName || "不明なネームドマス";
      const role = data.roleName ? `(${data.roleName})` : "";
      const faction = data.factionName ? `[${data.factionName}]` : "";
      return `${data.playerName || "不明"}${role}${faction}がネームドマス「${cellName}」を燃やしました`;
    }
    case "named_cell_deleted": {
      const cellName = data.name || data.cellName || "不明なネームドマス";
      const role = data.roleName ? `(${data.roleName})` : "";
      const faction = data.factionName ? `[${data.factionName}]` : "";
      return `${data.playerName || "不明"}${role}${faction}がネームドマス「${cellName}」を燃やしました`;
    }
    case "named_tile_renamed":
      return `「${data.oldName || "???"}」が「${data.newName || "???"}」に改名されました (変更者: ${data.playerName || "不明"})`;
    case "truce_established":
      return `「${data.factionAName || "?"}」と「${data.factionBName || "?"}」の間で停戦協定が結ばれました`;
    case "war_started":
      return `${data.attackerName || "攻撃側"} が ${data.defenderName || "防衛側"} に侵攻開始`;
    case "shared_ap_donated": {
      const rolePart = data.roleName ? `(${data.roleName})` : "";
      return `${data.playerName || "不明"}${rolePart} が ${data.factionName || "勢力"} に共有APを ${data.amount || 0} 寄付しました`;
    }
    case "shared_ap_withdrawn":
      return `${data.playerName || "不明"} が共有APを ${data.amount || 0} 引き出しました`;
    case "faction_leader_transferred":
    case "faction_leader_changed":
      return `「${data.factionName || "???"}」の盟主が交代しました`;
    case "faction_policy_changed": {
      const policies = {
        open: "誰でも加入可",
        approval: "承認制",
        closed: "募集停止",
      };
      return `「${data.factionName || "自勢力"}」の加入設定が「${policies[data.joinPolicy] || data.joinPolicy}」に変更されました`;
    }
    case "faction_name_changed":
      return `勢力名が「${data.newName || "???"}」に変更されました (変更者: ${data.changedByName || "不明"})`;
    case "faction_color_changed":
      return `「${data.factionName || "???"}」のイメージカラーが変更されました (変更者: ${data.changedByName || "不明"})`;
    case "faction_settings_changed":
      return `「${data.factionName || "???"}」の方針・設定が変更されました`;
    case "tiles_painted": {
      const role =
        data.roleName && data.roleName !== "Member"
          ? ` (${data.roleName})`
          : "";
      const faction = data.factionName ? ` [${data.factionName}]` : "";
      // [NEW] action による表示分岐
      const actionText = data.action === "overpaint" ? "重ね塗り" : "拡張";
      return `${data.painterName || data.playerName || "不明"}${role}${faction} が領土を ${data.count || 0} マス${actionText}しました (${data.x}, ${data.y})${data.destruction ? " (※敵対勢力消滅)" : ""}`;
    }
    case "tiles_invaded": {
      const rName =
        data.roleName && data.roleName !== "Member" ? `(${data.roleName})` : "";
      return `${data.playerName || "不明"}${rName}[${data.factionName || "不明"}] が ${data.targetFactionName || "不明"} から ${data.count || 0} マス奪いました (${data.x}, ${data.y})`;
    }
    case "named_tile_resist": {
      const rName =
        data.roleName && data.roleName !== "Member" ? `(${data.roleName})` : "";
      return `[攻撃失敗] ${data.playerName || "不明"}${rName}[${data.factionName || "不明"}] が ${data.targetFactionName || "不明"} のネームドマス「${data.tileName || "???"}」への攻撃に失敗しました`;
    }
    case "named_tile_fallen": {
      const rName =
        data.roleName && data.roleName !== "Member" ? `(${data.roleName})` : "";
      return `ネームドマス「${data.tileName || "???"}」が ${data.playerName || "不明"}${rName}[${data.factionName || "不明"}] によって陥落しました！ (${data.x}, ${data.y})`;
    }
    case "overpaint": {
      const rName =
        data.roleName && data.roleName !== "Member" ? `(${data.roleName})` : "";
      return `${data.playerName || "不明"}${rName}[${data.factionName || "不明"}] が ${data.count || 0} マス重ね塗りしました (${data.x}, ${data.y})`;
    }
    case "core_expanded":
      return `「${data.factionName || "不明"}」が支配領土 ${data.totalTiles || "?"}マスで新たに中核マスを獲得しました (${data.x}, ${data.y})`;
    case "alliance_renamed":
      return `同盟「${data.oldName || "???"}」が「${data.newName || "???"}」に同盟名を変更`;
    case "alliance_updated":
      return (
        data.message ||
        `同盟「${data.allianceName || "???"}」の状態が更新されました`
      );
    default:
      return (
        log.message ||
        (data.message
          ? data.message
          : `[${type || "info"}] ${JSON.stringify(data).substring(0, 50)}`)
      );
  }
};

/**
 * アイコン付きのメッセージテキストを取得する
 */
export const getLogWithIcon = (log) => {
  const text = getLogMessageText(log);
  if (!text) return "";
  const category = getLogCategory(log);
  const icon = LOG_TYPES[category]?.icon || "ℹ️";

  // 特定のタイプには追加のアイコン
  let prefix = icon;
  if (log.type === "faction_destroyed") prefix = "💀";
  else if (log.type === "faction_joined") prefix = "👋";
  else if (log.type === "faction_left") prefix = "🚪";
  else if (log.type === "faction_independence") prefix = "🚩";
  else if (log.type === "faction_kicked") prefix = "👢";
  else if (log.type === "named_cell_created") prefix = "🏰";
  else if (
    log.type === "named_cell_destroyed" ||
    log.type === "named_cell_deleted"
  )
    prefix = "🔥";
  else if (log.type === "named_tile_fallen") prefix = "🚩";
  else if (log.type === "named_tile_resist") prefix = "🛡️";
  else if (log.type === "named_tile_renamed") prefix = "🏷️";
  else if (log.type === "war_started") prefix = "⚔️";

  return `${prefix} ${text}`;
};
