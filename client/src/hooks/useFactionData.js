import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const useFactionData = (playerData) => {
  const [factions, setFactions] = useState({});
  const factionsRef = useRef(factions);
  const [alliances, setAlliances] = useState({});
  const alliancesRef = useRef(alliances);
  const [wars, setWars] = useState({});
  const warsRef = useRef(wars);
  const [truces, setTruces] = useState({});

  useEffect(() => {
    factionsRef.current = factions;
  }, [factions]);
  useEffect(() => {
    alliancesRef.current = alliances;
  }, [alliances]);
  useEffect(() => {
    warsRef.current = wars;
  }, [wars]);

  const fetchFactions = useCallback(async () => {
    try {
      const res = await fetch("/api/factions");
      const data = await res.json();
      if (data.factions) setFactions(data.factions || {});
    } catch (e) {
      console.error("Failed to fetch factions", e);
    }
  }, []);

  const fetchAlliances = useCallback(async () => {
    try {
      const res = await fetch("/api/alliances?detail=true", {
        credentials: "include",
      });
      const data = await res.json();
      if (data.success) setAlliances(data.alliances || {});
    } catch (e) {
      console.error("Failed to fetch alliances", e);
    }
  }, []);

  const fetchWars = useCallback(async () => {
    try {
      const res = await fetch("/api/wars", { credentials: "include" });
      const data = await res.json();
      if (data.success) setWars(data.wars || {});
    } catch (e) {
      console.error("Failed to fetch wars", e);
    }
  }, []);

  const fetchTruces = useCallback(async () => {
    try {
      const res = await fetch("/api/truces", { credentials: "include" });
      const data = await res.json();
      if (data.success) setTruces(data.truces || {});
    } catch (e) {
      console.error("Failed to fetch truces", e);
    }
  }, []);

  // 初期ロード
  useEffect(() => {
    fetchFactions();
    fetchAlliances();
    fetchWars();
    fetchTruces();
  }, [fetchFactions, fetchAlliances, fetchWars, fetchTruces]);

  // 同盟盟主判定
  const playerIsAllianceLeader = useMemo(() => {
    if (!playerData?.factionId || !factions || !alliances) return false;
    const myFaction = factions[playerData.factionId];
    if (!myFaction?.allianceId) return false;
    const alliance = alliances[myFaction.allianceId];
    return alliance?.leaderId === playerData.factionId;
  }, [playerData, factions, alliances]);

  // ランキングデータ生成
  const leaderboardItems = useMemo(() => {
    const sorted = Object.values(factions)
      .filter((f) => f && typeof f === "object")
      .sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0));

    let currentRank = 1;
    return sorted.map((f, index) => {
      // ポイントが前の勢力より低い場合のみランクを更新 (同点なら維持)
      if (
        index > 0 &&
        (f.totalPoints || 0) < (sorted[index - 1].totalPoints || 0)
      ) {
        currentRank = index + 1;
      }
      return {
        id: f.id,
        rank: currentRank,
        name: f.name,
        color: f.color,
        count: f.totalPoints || 0,
      };
    });
  }, [factions]);

  return {
    factions,
    setFactions,
    factionsRef,
    alliances,
    setAlliances,
    alliancesRef,
    wars,
    setWars,
    warsRef,
    truces,
    setTruces,
    fetchFactions,
    fetchAlliances,
    fetchWars,
    fetchTruces,
    playerIsAllianceLeader,
    leaderboardItems,
  };
};

export default useFactionData;
