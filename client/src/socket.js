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

// tile:update を自動的にバッファリング
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
