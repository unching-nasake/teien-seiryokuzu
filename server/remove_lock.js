const fs = require("fs");
const path = require("path");
const os = require("os");

// サーバー環境判定: Windowsでなければ /var/www/html を使用
const isServer = os.platform() !== "win32";
const basePath = isServer
  ? "/var/www/html/game.unching-nasake.xyz/public/server"
  : "d:/Projects/game.unching-nasake.xyz/public/server";

const lockPath = path.join(basePath, "data", "factions.json.lock");

if (fs.existsSync(lockPath)) {
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
    console.log("Lock removed:", lockPath);
  } catch (e) {
    console.error("Failed to remove lock:", e);
  }
} else {
  console.log("Lock does not exist:", lockPath);
}
