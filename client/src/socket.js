import { io } from "socket.io-client";

const socket = io("", {
  withCredentials: true,
  autoConnect: true,
  transports: ["websocket", "polling"], // WebSocket優先
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  timeout: 20000,
});

// タイル更新のスロットリング
// 高頻度の tile:update イベントをバッファリングして統合処理
let tileBuffer = {};
let tileFlushTimeout = null;
const TILE_FLUSH_INTERVAL = 50; // 50ms間隔で統合

// 元のemitを保持
const originalEmit = socket.emit.bind(socket);

// バッファリングされたタイル更新を通知するためのカスタムイベント
socket.flushTileBuffer = () => {
  if (Object.keys(tileBuffer).length > 0) {
    const buffered = tileBuffer;
    tileBuffer = {};
    // 内部的に tile:buffered イベントを発火
    socket.listeners("tile:buffered").forEach((fn) => fn(buffered));
  }
};

// [NEW] バイナリプロトコル版の受信
// [NEW] バイナリプロトコル版の受信 (Phase 7: Fixed-size 28 bytes)
socket.on("tile:update:bin", (buffer) => {
  const view = new DataView(buffer);
  let offset = 0;

  const count = view.getUint16(offset, true);
  offset += 2;

  const optimizedUpdates = {};

  for (let i = 0; i < count; i++) {
    // 座標
    const x = view.getUint16(offset, true);
    const y = view.getUint16(offset + 2, true);

    // データペイロード (24 bytes)
    // 0-1: fidIdx
    // 2-5: color
    // 6-9: pidIdx
    // 10: overpaint
    // 11: flags
    // 12-19: exp
    // 20-23: paintedAt

    const fidIdx = view.getUint16(offset + 4, true);
    const colorInt = view.getUint32(offset + 6, true);
    const pidIdx = view.getUint32(offset + 10, true);
    const overpaint = view.getUint8(offset + 14);
    const flags = view.getUint8(offset + 15);
    const exp = view.getFloat64(offset + 16, true);
    const paintedAt = view.getUint32(offset + 24, true); // Phase 7 New

    offset += 28; // 4 header + 24 payload

    const color = `#${colorInt.toString(16).padStart(6, "0")}`;

    const tile = {
      // 文字列IDではなくインデックスを渡す (useWorldState側で解決、または直接SAB書き込み)
      fidIdx,
      pidIdx,
      color,
      overpaint,
      paintedAt, // 秒単位
    };

    if (flags & 1) {
      // isCore
      // Faction ID is needed for core object?
      // Existing logic used `fid`. Now we have `fidIdx`.
      // We'll pass `fidIdx` in the core object too?
      // Or rely on `useWorldState` to resolve it if needed?
      // The `core` object in mapState usually has `expiresAt`. `factionId` is implicit or redundant?
      // Check existing usage: `tile.core = { factionId, expiresAt }`.
      // We will pass `fidIdx` instead of `factionId`. useWorldState must handle it.
      tile.core = {
        fidIdx,
        expiresAt: exp > 0 ? new Date(exp).toISOString() : null,
      };
    }
    if (flags & 2) {
      // isCoreifying
      tile.coreificationUntil = new Date(exp).toISOString();
      tile.coreificationFidIdx = fidIdx;
    }

    optimizedUpdates[`${x}_${y}`] = tile;
  }

  Object.assign(tileBuffer, optimizedUpdates);
  if (!tileFlushTimeout) {
    tileFlushTimeout = setTimeout(() => {
      socket.flushTileBuffer();
      tileFlushTimeout = null;
    }, TILE_FLUSH_INTERVAL);
  }
});

// tile:update を自動的にバッファリング (レガシー互換。サーバー側がbinに移行すれば不要)
socket.on("tile:update", (updates) => {
  // [OPTIMIZATION] 受信データから不要なプロパティを削除してメモリを節約
  // 描画に必要なのは factionId, color, type など。計算用の center などは不要。
  // ただし、updates は { key: tile } の形式。

  const optimizedUpdates = {};
  for (const key in updates) {
    const tile = updates[key];
    if (tile) {
      // 必要なプロパティのみを抽出（あるいは不要なものを削除）
      // ここでは安全のため、既存のオブジェクトを使いつつ、明らかに不要な巨大データがあれば削除する戦略をとる。
      // 現状の tile オブジェクトの構造次第だが、サーバー側ですでに軽量化されている場合はそのままでよい。
      // もし `center` (計算用座標オブジェクト)などが含まれているなら削除する。

      // クライアント側でのメモリ節約のため、新しいオブジェクトを作成して必要なものだけコピー
      const optimizedTile = {
        factionId: tile.factionId,
        faction: tile.faction, // 互換性
        color: tile.color,
        // type: tile.type, // 必要なら
        // core: tile.core // 必要なら
        // land: tile.land // 必要なら
      };

      // 他のプロパティも必要に応じてコピー (動的なプロパティがある場合)
      // ひとまず、そのままコピーしつつ、既知の不要プロパティがあれば delete するアプローチのほうが安全か。
      // server.js から送られてくるデータは `liteTiles` 相当のはず。

      // ここでは Object.assign でコピーし、明らかに不要な `center` などを削除
      const safeTile = Object.assign({}, tile);
      delete safeTile.center; // 重心計算などで付与されていた場合
      delete safeTile.neighbors; // 隣接情報

      optimizedUpdates[key] = safeTile;
    } else {
      optimizedUpdates[key] = null; // 削除
    }
  }

  Object.assign(tileBuffer, optimizedUpdates);
  if (!tileFlushTimeout) {
    tileFlushTimeout = setTimeout(() => {
      socket.flushTileBuffer();
      tileFlushTimeout = null;
    }, TILE_FLUSH_INTERVAL);
  }
});

export default socket;
