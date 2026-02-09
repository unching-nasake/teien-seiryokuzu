const os = require("os");
const numCPUs = os.cpus().length;
// [OPTIMIZATION] vCPU数が4未満の場合は全コアを使用、4以上の場合は安定性のため1コア空ける
const numWorkers = numCPUs < 4 ? numCPUs : numCPUs - 1;

// メモリ設定
const MAIN_MAX_HEAP_SIZE = 2048; // メインプロセスのヒープ上限 (MB)
const WORKER_MAX_HEAP_SIZE = 512; // 各ワーカーのヒープ上限 (MB)
const SYSTEM_RESERVE = 512; // OS等の予備 (MB)

// PM2全体の再起動しきい値を計算 (G単位で指定)
// メイン + (ワーカー数 × ワーカー上限) + 予備
const totalMemoryMB =
  MAIN_MAX_HEAP_SIZE + numWorkers * WORKER_MAX_HEAP_SIZE + SYSTEM_RESERVE;
const maxMemoryRestart = `${Math.ceil(totalMemoryMB / 1024)}G`;

module.exports = {
  apps: [
    {
      name: "teien-server",
      script: "./server/server.js",
      instances: 1, // シングルプロセス（Worker Threadsで計算分散）
      exec_mode: "fork",
      watch: false,
      max_memory_restart: maxMemoryRestart,
      node_args: `--max-old-space-size=${MAIN_MAX_HEAP_SIZE}`,
      env: {
        NODE_ENV: "production",
        WORKER_MAX_HEAP_SIZE: WORKER_MAX_HEAP_SIZE, // ワーカーに上限を伝える
      },
      // ログ設定
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
