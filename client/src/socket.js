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
  Object.assign(tileBuffer, updates);
  if (!tileFlushTimeout) {
    tileFlushTimeout = setTimeout(() => {
      socket.flushTileBuffer();
      tileFlushTimeout = null;
    }, TILE_FLUSH_INTERVAL);
  }
});

export default socket;
