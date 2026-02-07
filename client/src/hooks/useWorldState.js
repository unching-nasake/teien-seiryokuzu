import { useCallback, useMemo, useRef, useState } from "react";

/**
 * World State Manager (SharedArrayBuffer)
 * 25万タイルのデータを固定長バイナリ形式で管理し、Worker間で共有する。
 *
 * データ構造 (1タイル 24bytes):
 * [0-1]   Uint16: factionIndex
 * [2-5]   Uint32: colorInt (#RRGGBB)
 * [6-9]   Uint32: paintedByIndex
 * [10]    Uint8:  overpaint
 * [11]    Uint8:  flags (bit0: core, bit1: coreification)
 * [12-15] Padding (Reserved)
 * [16-23] Float64: expiry (timestamp, 8-byte aligned)
 * [24-27] Uint32: paintedAt (Unix seconds, if needed, but size is 24)
 * ※注意: 現状 TILE_BYTE_SIZE = 24 なので、[20-23] もパディングまたは属性として利用。
 */

const MAP_SIZE = 500;
const TILE_COUNT = MAP_SIZE * MAP_SIZE;
const TILE_BYTE_SIZE = 24;
const TOTAL_SIZE = TILE_COUNT * TILE_BYTE_SIZE;

export function useWorldState() {
  // SharedArrayBufferの初期化 (一回のみ)
  const sabRef = useRef(new SharedArrayBuffer(TOTAL_SIZE));
  const [version, setVersion] = useState(0);

  // マッピング用キャッシュ (ID -> Index)
  const factionMapRef = useRef(new Map()); // id -> index
  const factionListRef = useRef([]); // index -> id
  const playerMapRef = useRef(new Map()); // id -> index
  const playerListRef = useRef([]); // index -> id

  // DataViewのキャッシュ (毎回生成しない)
  const dvRef = useRef(null);
  if (!dvRef.current) {
    dvRef.current = new DataView(sabRef.current);
  }

  const getFactionIndex = useCallback((id) => {
    if (!id) return 65535; // null
    const map = factionMapRef.current;
    if (map.has(id)) return map.get(id);
    const idx = factionListRef.current.length;
    map.set(id, idx);
    factionListRef.current.push(id);
    return idx;
  }, []);

  const getPlayerIndex = useCallback((id) => {
    if (!id) return 0; // null
    const map = playerMapRef.current;
    if (map.has(id)) return map.get(id);
    const idx = playerListRef.current.length + 1;
    map.set(id, idx);
    playerListRef.current.push(id);
    return idx;
  }, []);

  // 1タイルの書き込み (内部用)
  const setTileInternal = useCallback(
    (offset, data) => {
      const dv = dvRef.current;

      // [Phase 7] Index support
      let factionIdx;
      if (typeof data.fidIdx === "number") factionIdx = data.fidIdx;
      else factionIdx = getFactionIndex(data.factionId || data.faction);

      const colorStr = data.customColor || data.color || "#ffffff";
      const colorInt = parseInt(colorStr.replace("#", ""), 16) || 0xffffff;

      let paintedByIdx;
      if (typeof data.pidIdx === "number") paintedByIdx = data.pidIdx;
      else paintedByIdx = getPlayerIndex(data.paintedBy);

      dv.setUint16(offset + 0, factionIdx, true);
      dv.setUint32(offset + 2, colorInt, true);
      dv.setUint32(offset + 6, paintedByIdx, true);
      dv.setUint8(offset + 10, data.overpaint || 0);

      let flags = 0;
      let exp = 0;
      if (data.core) {
        flags |= 1;
        exp = new Date(data.core.expiresAt || 0).getTime();
      }
      if (data.coreificationUntil) {
        flags |= 2;
        exp = new Date(data.coreificationUntil).getTime();
      }
      dv.setUint8(offset + 11, flags);
      // offset 12-15 padding
      // offset 12-19 expiry
      dv.setFloat64(offset + 12, exp, true);

      // paintedAt support
      let pAt = 0;
      if (typeof data.paintedAt === "number") pAt = data.paintedAt;
      else if (data.paintedAt)
        pAt = Math.floor(new Date(data.paintedAt).getTime() / 1000);
      dv.setUint32(offset + 20, pAt, true);
    },
    [getFactionIndex, getPlayerIndex],
  );

  // 公開用 setTile
  const setTile = useCallback(
    (x, y, data) => {
      if (x < 0 || x >= MAP_SIZE || y < 0 || y >= MAP_SIZE) return;
      const offset = (y * MAP_SIZE + x) * TILE_BYTE_SIZE;
      setTileInternal(offset, data);
      setVersion((v) => v + 1);
    },
    [setTileInternal],
  );

  // 大量タイルの書き込み
  const setTiles = useCallback(
    (tiles) => {
      const entries = Object.entries(tiles);
      if (entries.length === 0) return;

      entries.forEach(([key, data]) => {
        const parts = key.split("_");
        const x = parseInt(parts[0], 10);
        const y = parseInt(parts[1], 10);

        if (x < 0 || x >= MAP_SIZE || y < 0 || y >= MAP_SIZE) return;
        const offset = (y * MAP_SIZE + x) * TILE_BYTE_SIZE;

        if (data === null) {
          // タイル消去 (現状はfactionIndexをnullにする)
          const dv = dvRef.current;
          dv.setUint16(offset + 0, 65535, true);
        } else {
          setTileInternal(offset, data);
        }
      });
      setVersion((v) => v + 1);
    },
    [setTileInternal],
  );

  // 外部からのマッピング同期 (初期ロード時など)
  const importMappings = useCallback((data) => {
    if (!data) return;
    const { factionsList, playerNames } = data;

    if (factionsList) {
      factionListRef.current = [...factionsList];
      factionMapRef.current = new Map(factionsList.map((id, i) => [id, i]));
    }
    if (playerNames) {
      const pIds = Object.keys(playerNames);
      playerListRef.current = pIds;
      playerMapRef.current = new Map(pIds.map((id, i) => [id, i + 1]));
    }
    setVersion((v) => v + 1);
  }, []);

  const getTile = useCallback((x, y) => {
    if (x < 0 || x >= MAP_SIZE || y < 0 || y >= MAP_SIZE) return null;
    const dv = dvRef.current;
    const offset = (y * MAP_SIZE + x) * TILE_BYTE_SIZE;

    const fidIdx = dv.getUint16(offset + 0, true);
    const colorInt = dv.getUint32(offset + 2, true);
    const paintedByIdx = dv.getUint32(offset + 6, true);
    const overpaint = dv.getUint8(offset + 10);
    const flags = dv.getUint8(offset + 11);
    const exp = dv.getFloat64(offset + 16, true); // Alignment fixed
    const pAtSec = dv.getUint32(offset + 20, true);

    const factionId = fidIdx === 65535 ? null : factionListRef.current[fidIdx];
    const color = factionId
      ? `#${colorInt.toString(16).padStart(6, "0")}`
      : "#ffffff";
    const paintedBy =
      paintedByIdx === 0 ? null : playerListRef.current[paintedByIdx - 1];
    const paintedAt = pAtSec ? new Date(pAtSec * 1000).toISOString() : null;

    const tile = {
      x,
      y,
      factionId,
      faction: factionId,
      color,
      paintedBy,
      paintedAt,
      overpaint,
      isCorePending: (flags & 2) !== 0,
      coreTime: (flags & 2) !== 0 ? new Date(exp).toISOString() : null,
    };

    if (flags & 1) {
      tile.core = {
        factionId,
        expiresAt: exp > 0 ? new Date(exp).toISOString() : null,
      };
    }
    if (flags & 2) {
      tile.coreificationUntil = new Date(exp).toISOString();
      tile.coreificationFactionId = factionId;
    }

    return tile;
  }, []);

  // Worker等に渡すためのデータ
  const sharedData = useMemo(
    () => ({
      sab: sabRef.current,
      factionsList: factionListRef.current,
      playersList: playerListRef.current,
    }),
    [version],
  );

  return {
    setTile,
    setTiles,
    importMappings,
    getTile,
    sharedData,
    version,
    // ID逆引き用
    factionsList: factionListRef.current,
    playersList: playerListRef.current,
  };
}
