const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "server/data");
const FACTIONS_PATH = path.join(DATA_DIR, "factions.json");
const PLAYERS_PATH = path.join(DATA_DIR, "players.json");
const MAP_STATE_PATH = path.join(DATA_DIR, "map_state.json");

let currentAdminId = "MOCK_ADMIN_ID";
if (fs.existsSync(path.join(DATA_DIR, "admin-id.txt"))) {
  currentAdminId = fs
    .readFileSync(path.join(DATA_DIR, "admin-id.txt"), "utf-8")
    .trim();
}

function isWeakFactionUnified(
  rank,
  memberCount,
  factionId,
  allianceId,
  top3Alliances,
) {
  if (rank < 6 || rank > 500) return false;
  if (memberCount > 3) return false;
  if (allianceId && top3Alliances && top3Alliances.includes(allianceId))
    return false;
  return true;
}

function getEnrichedFactionMock(fid, factions, players, cachedRanks) {
  const f = factions.factions[fid];
  if (!f) return null;

  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  let activeMemberCount = 0;

  (f.members || []).forEach((pid) => {
    const p = players.players[pid];
    const isActive = p?.lastApAction && now - p.lastApAction < ONE_DAY_MS;
    if (isActive) activeMemberCount++;
  });

  const rankData = cachedRanks.find((r) => r.id === fid);
  const rank = rankData ? rankData.rank : 999;

  const isWeak = isWeakFactionUnified(
    rank,
    activeMemberCount,
    fid,
    f.allianceId,
    [],
  );
  const adminId = currentAdminId || "";

  return {
    id: fid,
    name: f.name,
    rank,
    activeMemberCount,
    isWeak,
    adminId,
  };
}

async function run() {
  try {
    const factionsData = JSON.parse(fs.readFileSync(FACTIONS_PATH, "utf8"));
    const playersData = JSON.parse(fs.readFileSync(PLAYERS_PATH, "utf8"));
    const mapState = JSON.parse(fs.readFileSync(MAP_STATE_PATH, "utf8"));

    // Mock ranks for testing (Current data seems to only have few factions)
    // Let's force a faction to be Rank 6 to see if it works
    const mockRanks = [
      { id: "faction-1770395197204", rank: 1 },
      { id: "faction-1770395290445", rank: 2 },
      { id: "faction-1770394008016", rank: 3 },
      { id: "faction-1770394632595", rank: 4 },
      { id: "STILL_ANOTHER", rank: 5 },
      { id: "WEAK_CANDIDATE", rank: 6 },
    ];

    console.log("Current Admin ID:", currentAdminId);

    Object.keys(factionsData.factions).forEach((fid) => {
      const enriched = getEnrichedFactionMock(
        fid,
        factionsData,
        playersData,
        mockRanks,
      );
      console.log(
        `Faction ${fid} (${enriched.name}): Rank=${enriched.rank}, Active=${enriched.activeMemberCount}, isWeak=${enriched.isWeak}, adminId="${enriched.adminId}"`,
      );
    });

    // Test with a synthetic weak faction
    factionsData.factions["WEAK_CANDIDATE"] = {
      name: "Weak Faction",
      members: ["u-somebody"],
    };
    playersData.players["u-somebody"] = { lastApAction: Date.now() };
    const enrichedWeak = getEnrichedFactionMock(
      "WEAK_CANDIDATE",
      factionsData,
      playersData,
      mockRanks,
    );
    console.log(
      `\nSynthetic Weak Faction: Rank=${enrichedWeak.rank}, Active=${enrichedWeak.activeMemberCount}, isWeak=${enrichedWeak.isWeak}, adminId="${enrichedWeak.adminId}"`,
    );
  } catch (e) {
    console.error(e);
  }
}

run();
