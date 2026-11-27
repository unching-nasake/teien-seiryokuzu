# 庭園勢力図（Teien Seiryokuzu）

週末48時間限定 陣取りドット絵オンラインストラテジーゲームの Rust バックエンド + TypeScript / WebGL2 / Web Workers フロントエンド実装です。

## ディレクトリ構成

- `server/` — Rust (Edition 2021) + `tokio` + `axum` + `rayon` + `sqlx` (SQLite WAL) + `argon2`
- `client/` — TypeScript + Preact + Vite + WebGL2 + Web Workers (`SharedArrayBuffer` 対応 + フォールバック)

## 起動方法

### 1. フロントエンドビルド
```powershell
cd client
npm install
npm run build
```

### 2. バックエンド起動（ビルド済みフロントエンドを同時配信）
```powershell
cd server
cargo run --release
```
ブラウザで `http://127.0.0.1:3000` を開くとプレイできます。

### 開発モードでの起動（ホットリロード）
1. ターミナル1: `cd server; cargo run`（ポート `3000`）
2. ターミナル2: `cd client; npm run dev`（ポート `5173`、API/WS は `3000` へ自動プロキシ）

## 環境変数

| 変数名 | デフォルト値 | 説明 |
| :--- | :--- | :--- |
| `SEIRYOKUZU_BIND_ADDR` | `127.0.0.1:3000` | サーバー待受アドレス |
| `SEIRYOKUZU_DB_PATH` | `data/teien.db` | SQLite DB ファイルパス |
| `SEIRYOKUZU_STATIC_DIR` | `../client/dist` | フロントエンド静的ファイルディレクトリ |
| `SEIRYOKUZU_DEVMODE` | `0` | 本番では無効。`1` で開発パネルとデバッグ機能を限定有効化 |
| `SEIRYOKUZU_MAP_SEED` | ランダム | 地形プロシージャル生成シード値 |
| `SEIRYOKUZU_ADMIN_ID` | `admin` | 管理者ページ (`/admin`) ログインID |
| `SEIRYOKUZU_ADMIN_PASS` | 未設定 | 未指定時（`SEIRYOKUZU_DEVMODE=0`）は管理者ログイン無効（`SEIRYOKUZU_DEVMODE=1` のみ `admin`）。本番運用時は必ず強固な値を設定すること |
| `SEIRYOKUZU_TRUST_PROXY` | `0` | リバースプロキシ背後で `X-Real-IP` / `X-Forwarded-For` を信頼する場合のみ `1` |
| `SEIRYOKUZU_COOKIE_SECURE` | 自動 | 未指定時は `SEIRYOKUZU_BIND_ADDR` が `127.0.0.1:` / `localhost:` 以外なら `1`。HTTPS 運用時は `1` 推奨 |
| `SEIRYOKUZU_ALLOWED_ORIGINS` | 未設定 | 追加許可するオリジン（カンマ区切り、任意） |

## 管理者ページ (`/admin`)

ブラウザで `http://127.0.0.1:3000/admin`（または画面右上の「管理者」ボタン）からアクセスできます。`SEIRYOKUZU_DEVMODE=1` かつ `SEIRYOKUZU_ADMIN_PASS` 未設定時のみ初期認証情報（ID `admin` / パスワード `admin`）が有効です。通常運用時は必ず `SEIRYOKUZU_ADMIN_PASS` を設定してください。
マップサイズ（`100×100` / `250×250` [デフォルト] / `500×500` / `750×750` / `1000×1000`）、大陸数・島数・陸地割合（サイズ別安全上限付き）を指定して、ランダムな地形を再生成できます。

## テスト実行

```powershell
cd server
cargo test
```
