/**
 * SharedArrayBuffer を使ったタイルデータ共有フック
 * メインスレッドとWorker間でゼロコピー転送を実現
 */
import { useCallback, useEffect, useRef, useState } from "react";

// SharedArrayBufferが使用可能かチェック
const isSharedArrayBufferSupported = () => {
  try {
    // crossOriginIsolatedがtrueの場合のみSharedArrayBufferが使用可能
    return (
      typeof SharedArrayBuffer !== "undefined" &&
      typeof crossOriginIsolated !== "undefined" &&
      crossOriginIsolated
    );
  } catch {
    return false;
  }
};

// タイルデータをエンコード/デコードするためのヘルパー
// 各タイルを8バイトで表現: [x(2), y(2), factionId(4)]
const TILE_BYTE_SIZE = 8;

export function useSharedTileData() {
  const sharedBufferRef = useRef(null);
  const int32ViewRef = useRef(null);
  const [isSupported, setIsSupported] = useState(false);
  const [tileCount, setTileCount] = useState(0);

  useEffect(() => {
    const supported = isSharedArrayBufferSupported();
    setIsSupported(supported);
    if (supported) {
      console.log(
        "[SharedTileData] SharedArrayBuffer is supported (cross-origin isolated)",
      );
    } else {
      console.log(
        "[SharedTileData] SharedArrayBuffer not available, using fallback",
      );
    }
  }, []);

  /**
   * タイルデータをSharedArrayBufferにエンコード
   * @param {Object} tiles - { "x_y": { factionId, ... }, ... }
   * @returns {SharedArrayBuffer|null}
   */
  const encodeTiles = useCallback(
    (tiles) => {
      if (!isSupported) return null;

      const tileEntries = Object.entries(tiles);
      const count = tileEntries.length;

      // 最初の4バイトはタイル数、残りはタイルデータ
      const bufferSize = 4 + count * TILE_BYTE_SIZE;
      const buffer = new SharedArrayBuffer(bufferSize);
      const view = new Int32Array(buffer);

      // タイル数を最初に書き込み
      view[0] = count;

      // タイルデータをエンコード
      let index = 1;
      for (const [key, tile] of tileEntries) {
        const [x, y] = key.split("_").map(Number);
        const factionId = tile.factionId || tile.faction || 0;

        // factionIdがstring ("f_xxx")の場合は数値に変換
        let factionNum = 0;
        if (typeof factionId === "string" && factionId.startsWith("f_")) {
          factionNum = parseInt(factionId.slice(2), 10) || 0;
        } else if (typeof factionId === "number") {
          factionNum = factionId;
        }

        view[index++] = (x << 16) | (y & 0xffff); // x,y を1つの32bit整数に
        view[index++] = factionNum;
      }

      sharedBufferRef.current = buffer;
      int32ViewRef.current = view;
      setTileCount(count);

      return buffer;
    },
    [isSupported],
  );

  /**
   * SharedArrayBufferからタイルデータをデコード
   * @param {SharedArrayBuffer} buffer
   * @returns {Object} tiles
   */
  const decodeTiles = useCallback((buffer) => {
    const view = new Int32Array(buffer);
    const count = view[0];
    const tiles = {};

    let index = 1;
    for (let i = 0; i < count; i++) {
      const xy = view[index++];
      const factionNum = view[index++];

      const x = (xy >> 16) & 0xffff;
      const y = xy & 0xffff;
      const key = `${x}_${y}`;

      tiles[key] = {
        factionId: factionNum > 0 ? `f_${factionNum}` : null,
      };
    }

    return tiles;
  }, []);

  /**
   * 勢力カウントを高速に計算 (SharedArrayBuffer上で直接)
   * Worker側で実行可能
   */
  const countByFaction = useCallback((buffer) => {
    const view = new Int32Array(buffer);
    const count = view[0];
    const factionCounts = new Map();

    let index = 1;
    for (let i = 0; i < count; i++) {
      index++; // skip xy
      const factionNum = view[index++];

      if (factionNum > 0) {
        factionCounts.set(factionNum, (factionCounts.get(factionNum) || 0) + 1);
      }
    }

    return factionCounts;
  }, []);

  /**
   * 現在のSharedArrayBufferを取得
   */
  const getBuffer = useCallback(() => {
    return sharedBufferRef.current;
  }, []);

  return {
    isSupported,
    tileCount,
    encodeTiles,
    decodeTiles,
    countByFaction,
    getBuffer,
  };
}

export default useSharedTileData;
