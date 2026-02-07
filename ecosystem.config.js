module.exports = {
  apps: [
    {
      name: "teien-server",
      script: "./server/server.js",
      instances: 1, // シングルプロセス（Worker Threadsで計算分散）
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "3G",
      node_args: "--max-old-space-size=3072",
      env: {
        NODE_ENV: "production",
      },
      // ログ設定
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
