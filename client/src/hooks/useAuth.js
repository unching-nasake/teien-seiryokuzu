import { useCallback, useEffect, useMemo, useState } from "react";

const useAuth = (factions, addNotification, triggerApEffect) => {
  const [authStatus, setAuthStatus] = useState({
    loading: true,
    authenticated: false,
    isGuest: true,
    player: null,
    gardenMode: false,
  });
  const [playerData, setPlayerData] = useState(null);

  // 認証状態の取得
  const refreshAuthStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/status", { credentials: "include" });
      if (!res.ok) throw new Error("Auth status failed");
      const data = await res.json();

      setAuthStatus({
        loading: false,
        authenticated: !!data.authenticated,
        isGuest: !!data.isGuest,
        player: data.player,
        gardenMode: !!data.gardenMode,
        gardenAuthKey: data.gardenAuthKey,
        gardenRefillCost: data.gardenRefillCost,
        gardenRefillAmount: data.gardenRefillAmount,
        apSettings: data.apSettings,
        mergerSettings: data.mergerSettings, // [NEW] receive merger settings
      });

      if (data.player) {
        setPlayerData(data.player);
        if (data.player.refilledAmount > 0) {
          addNotification(
            `APが ${data.player.refilledAmount} 補充されました！`,
            "AP補充",
          );
          triggerApEffect();
        }
      }
    } catch (e) {
      setAuthStatus((prev) => ({ ...prev, loading: false }));
    }
  }, [addNotification, triggerApEffect]);

  useEffect(() => {
    refreshAuthStatus();
  }, [refreshAuthStatus]);

  // 権限計算
  const enrichedPlayerData = useMemo(() => {
    if (!playerData) return null;
    const faction = playerData.factionId
      ? factions[playerData.factionId]
      : null;
    const isKing = faction?.kingId === playerData.id;

    let permissions = {
      canManageSettings: false,
      canUseSharedAp: false,
      canDiplomacy: false,
      canDeclareWar: false,
      canManageMembers: false,
      canKick: false,
      canRequestTruce: false,
      canManageAlliance: false,
      canErase: false,
      canManageNamedTiles: false,
    };

    if (isKing) {
      permissions = {
        canManageSettings: true,
        canUseSharedAp: true,
        canDiplomacy: true,
        canDeclareWar: true,
        canManageMembers: true,
        canKick: true,
        canRequestTruce: true,
        canManageAlliance: true,
        canErase: true,
        canManageNamedTiles: true,
      };
    } else if (faction) {
      const roleId = faction.memberRoles?.[playerData.id];
      const role = faction.roles?.find((r) => r.id === roleId);
      if (role && role.permissions) {
        permissions = {
          ...role.permissions,
          canKick: !!role.permissions.canManageMembers,
          canRequestTruce: !!role.permissions.canDiplomacy,
          canManageAlliance: !!role.permissions.canDiplomacy,
          canDiplomacy: !!role.permissions.canDiplomacy,
        };
      }
    }

    return { ...playerData, permissions, isLeader: isKing };
  }, [playerData, factions]);

  return {
    authStatus,
    setAuthStatus,
    playerData,
    setPlayerData,
    enrichedPlayerData,
    refreshAuthStatus,
  };
};

export default useAuth;
