# 庭園勢力図 (Teien Seiryokuzu)

「庭園勢力図」は、リアルタイムで進行する多人数参加型の陣取りブラウザゲームです。
広大なマップ上のタイルを塗り合い、勢力を拡大してランキングを競います。

## システム構成

- **Backend**: Node.js, Express, Socket.io
- **Frontend**: React, Vite, Pixi.js (描画エンジン)
- **Process Management**: PM2

## 動作要件

このアプリケーションを動作させるためには、以下の環境が必要です。

- **Node.js**: v18.0.0 以上推奨
- **npm**: (Node.js に付属)
- **Python 3.x**: (`garden_sync.py` を使用する場合)
- **PM2**: 本番環境でのプロセス管理に使用

### PM2 のインストール（未インストールの場合）

```bash
npm install pm2 -g
```

## インストール手順

リポジトリをクローンし、サーバーとクライアントそれぞれの依存パッケージをインストールします。

```bash
# 1. ルートディレクトリ（サーバー）の依存関係インストール
npm install

# 2. クライアントディレクトリの依存関係インストール
cd client
npm install
cd ..
```

## 起動方法

### 開発環境 (Development)

開発サーバーとフロントエンド（Vite）を同時に起動します。
ソースコードの変更はホットリロードで反映されます。

```bash
npm run dev
```

アクセス: `http://localhost:5173` (デフォルト)

### 本番環境 (Production)

本番環境では、フロントエンドをビルドして静的ファイルとして配信し、PM2 を使用してサーバープロセスを管理します。

#### 1. ビルド

クライアントアプリケーションをビルドします。ビルドされたファイルは `client/dist` に出力されます。

```bash
npm run build
```

#### 2. PM2 での起動

`ecosystem.config.js` の設定に基づき、PM2 でサーバーを起動します。

```bash
pm2 start ecosystem.config.js
```

アクセス: `http://localhost:3001` (または設定されたポート)

### Webサーバー設定例 (Apache)

Apache を使用して外部に公開する場合は、リバースプロキシ設定を行います。
`mod_proxy`, `mod_proxy_http` 等を有効にし、設定ファイルに以下のようなプロキシ設定を追加してください。

```apache
ProxyPass / http://localhost:3001/
ProxyPassReverse / http://localhost:3001/
```

## 管理画面 (Admin Panel)

管理画面は `/admin` でアクセスできます。ゲームの設定変更、データリセット、お知らせ管理などの管理機能を提供します。

初期パスワードは `admin` です。

### アクセス方法

```
http://localhost:3001/admin
```

### 管理画面の機能

- **ゲーム設定**: AP設定、庭園モード、休憩時間設定など
- **ゲーム制御**: ゲームの停止/再開、スケジュール予約
- **データ管理**: 全データのリセット
- **お知らせ管理**: プレイヤー向けお知らせの投稿・削除
- **アカウント設定**: IP制限などのアカウント関連設定

> **注意**: 管理画面では初回アクセス時にパスワードが要求されます。設定したパスワードはCookieで24時間保持されます。

#### 便利な PM2 コマンド

## ファイル構成

- `server/`: バックエンドのソースコード
- `client/`: フロントエンドのソースコード (React, Vite)
- `ecosystem.config.js`: PM2 設定ファイル
- `garden_sync.py`: 庭園認証用スクリプト(cronなどで定期実行してください)

## ライセンス

[MIT License](LICENSE)
