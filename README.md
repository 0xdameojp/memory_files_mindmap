# Drive Mind Map (Cloudflare Workers 版)

Google OAuth でログインし、Google Drive のフォルダを再帰的に走査して、画像ファイルを
マインドマップ風に表示するアプリです。

元の Next.js + PM2 版を **Cloudflare Workers（Static Assets 付き）** で動くように作り直しています。

## 構成

| パス | 役割 |
| --- | --- |
| `src/worker/` | Worker 本体（API ルーティング、OAuth、Drive API、署名付き Cookie） |
| `src/client/` | React SPA（Vite でビルドし、Workers Static Assets として配信） |
| `src/shared/types.ts` | Worker とクライアントで共有する型 |
| `wrangler.jsonc` | Worker の設定 |
| `vite.config.ts` | `@cloudflare/vite-plugin` で Worker と SPA をまとめて dev / build |

### API

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/auth/session` | ログイン状態 `{ signedIn }`（旧版の SSR での Cookie 判定の代わり） |
| GET | `/api/auth/google/login` | Google OAuth へリダイレクト |
| GET | `/api/auth/google/callback` | OAuth コールバック |
| POST | `/api/auth/google/logout` | ログアウト |
| GET | `/api/drive/tree?folderId=...` | フォルダツリー（画像のみ）を JSON で返す |
| GET | `/api/drive/file/:fileId` | 画像のプロキシ（HEIC は JPEG サムネイルを返す） |

`/api/*` 以外は静的アセットで、見つからないパスは `index.html` を返します（SPA）。

## Next.js 版からの主な変更点

- **Next.js → Vite + React SPA + Worker**。`next/image` は `<img>` に置き換えました。
- **`node:crypto` → Web Crypto API**。Cookie の形式・署名は旧版と同じなので、
  `APP_SESSION_SECRET` が同じなら旧版のセッション Cookie もそのまま使えます。
- **Drive の走査をまとめて取得する方式に変更**。旧版はフォルダ 1 つごとに API を 2 回呼んでいましたが、
  Workers には 1 リクエストあたりのサブリクエスト数に上限（Free プランでは 50）があります。
  そこで `'a' in parents or 'b' in parents ...` で最大 30 フォルダずつまとめて、階層ごとに取得するようにしました。
- **HEIC の扱い**。`heic-convert`（libheif の JS 版）は Workers の CPU・メモリ制限に収まらないため外しました。
  旧版で最初に試していた「Drive が作る JPEG サムネイル（1600px）を返す」処理だけ残しています。
  サムネイルがまだ作られていない HEIC は表示されません。
- **PM2 / デプロイ用スクリプトは削除**。`wrangler deploy` で置き換えます。
- `robots.ts` → `public/robots.txt`、`<meta name="robots">`、全レスポンスに `X-Robots-Tag`。

## ローカル開発

```bash
npm install
cp .dev.vars.example .dev.vars   # 値を埋める
npm run dev                      # http://localhost:5173
```

Google Cloud Console の OAuth クライアントに、次のリダイレクト URI を追加してください。

```text
http://localhost:5173/api/auth/google/callback
```

## 環境変数

| 名前 | 種類 | 説明 |
| --- | --- | --- |
| `APP_SESSION_SECRET` | secret | Cookie 署名用の長いランダム文字列 |
| `GOOGLE_CLIENT_ID` | secret | OAuth クライアント ID |
| `GOOGLE_CLIENT_SECRET` | secret | OAuth クライアントシークレット |
| `APP_BASE_URL` | var（任意） | 例 `https://mindmap.example.com`。未設定ならリクエストの URL から決める |
| `GOOGLE_REDIRECT_URI` | var（任意） | 未設定なら `${APP_BASE_URL}/api/auth/google/callback` |

## デプロイ

```bash
npx wrangler login
npx wrangler secret put APP_SESSION_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npm run deploy
```

デプロイ後、`https://<worker名>.<アカウント>.workers.dev/api/auth/google/callback`
（独自ドメインならそちらの URL）を Google Cloud Console のリダイレクト URI に追加してください。
独自ドメインを使う場合は `wrangler.jsonc` に `routes` か `vars.APP_BASE_URL` を設定します。

## その他

- スコープは `drive.readonly` です
- 共有ドライブにも対応しています
- 走査できるのは、ログインしたユーザーがアクセスできるフォルダだけです
