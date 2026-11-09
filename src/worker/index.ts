import type { SessionTokens } from "../shared/types";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_MAX_AGE,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  deleteCookie,
  getCookie,
  serializeCookie,
} from "./cookies";
import type { Env } from "./env";
import {
  createGoogleLoginUrl,
  downloadDriveFile,
  exchangeCodeForTokens,
  getAppBaseUrl,
  getDriveImageTree,
  getFreshTokens,
  isHeicMimeType,
  isSafeImageMimeType,
  isTrustedThumbnailUrl,
  isValidDriveId,
  revokeToken,
} from "./google-drive";
import { sealJson, unsealJson } from "./session";

const NO_INDEX = "noindex, nofollow, noimageindex, noarchive";

// API レスポンス共通のセキュリティヘッダー (静的アセットは public/_headers で設定)
const API_SECURITY_HEADERS: Record<string, string> = {
  "X-Robots-Tag": NO_INDEX,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

// 画面に渡すのはエラーの種類を表すコードだけ。文言はクライアント側で決まったものを出す
type AuthErrorCode = "oauth_denied" | "oauth_state" | "oauth_failed";

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function redirect(location: string, cookies: string[] = []) {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}

function errorMessage(caughtError: unknown, fallback: string) {
  return caughtError instanceof Error ? caughtError.message : fallback;
}

async function readSession(request: Request, env: Env) {
  return unsealJson<SessionTokens>(
    SESSION_COOKIE,
    getCookie(request, SESSION_COOKIE),
    env.APP_SESSION_SECRET,
  );
}

async function sessionCookie(request: Request, env: Env, tokens: SessionTokens) {
  return serializeCookie(
    request,
    SESSION_COOKIE,
    await sealJson(SESSION_COOKIE, tokens, SESSION_MAX_AGE, env.APP_SESSION_SECRET),
    SESSION_MAX_AGE,
  );
}

/** 状態を変える POST は同一オリジンからのみ受け付ける (CSRF 対策) */
function isSameOriginRequest(request: Request) {
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");

  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return false;
  }

  if (origin) {
    return origin === new URL(request.url).origin;
  }

  // Origin も Sec-Fetch-Site も無い古いクライアントは拒否
  return fetchSite !== null;
}

function normalizeFolderId(input: string) {
  const trimmed = input.trim();

  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      const folderMatch = url.pathname.match(/\/folders\/([^/?]+)/);

      const id = folderMatch?.[1] ?? url.searchParams.get("id") ?? "";
      return isValidDriveId(id) ? id : "";
    } catch {
      return "";
    }
  }

  return trimmed === "root" || isValidDriveId(trimmed) ? trimmed : "";
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleSession(request: Request, env: Env) {
  const session = await readSession(request, env);
  return json({ signedIn: Boolean(session) });
}

async function handleLogin(request: Request, env: Env) {
  const state = crypto.randomUUID();
  const stateCookie = serializeCookie(
    request,
    OAUTH_STATE_COOKIE,
    await sealJson(OAUTH_STATE_COOKIE, { state }, OAUTH_STATE_MAX_AGE, env.APP_SESSION_SECRET),
    OAUTH_STATE_MAX_AGE,
  );

  return redirect(createGoogleLoginUrl(env, state, request.url), [stateCookie]);
}

async function handleCallback(request: Request, env: Env) {
  const url = new URL(request.url);
  const appBaseUrl = getAppBaseUrl(env, request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const savedState = await unsealJson<{ state: string }>(
    OAUTH_STATE_COOKIE,
    getCookie(request, OAUTH_STATE_COOKIE),
    env.APP_SESSION_SECRET,
  );
  const clearState = deleteCookie(request, OAUTH_STATE_COOKIE);
  const errorRedirect = (code: AuthErrorCode) =>
    redirect(new URL(`/?error=${code}`, appBaseUrl).toString(), [clearState]);

  if (error) {
    console.warn("Google OAuth returned an error:", error);
    return errorRedirect("oauth_denied");
  }

  if (!code || !returnedState || !savedState || returnedState !== savedState.state) {
    return errorRedirect("oauth_state");
  }

  try {
    const tokens = await exchangeCodeForTokens(env, code, request.url);

    return redirect(new URL("/", appBaseUrl).toString(), [
      clearState,
      await sessionCookie(request, env, tokens),
    ]);
  } catch (caughtError) {
    console.error("Google token exchange failed:", errorMessage(caughtError, "unknown"));
    return errorRedirect("oauth_failed");
  }
}

async function handleLogout(request: Request, env: Env) {
  if (!isSameOriginRequest(request)) {
    return json({ error: "Forbidden" }, { status: 403 });
  }

  const session = await readSession(request, env);

  if (session) {
    // Cookie を消すだけでなく、Google 側でもトークンを失効させる
    await revokeToken(session.refreshToken);
  }

  return json(
    { ok: true },
    { headers: { "Set-Cookie": deleteCookie(request, SESSION_COOKIE) } },
  );
}

async function handleTree(request: Request, env: Env) {
  const session = await readSession(request, env);

  if (!session) {
    return json({ error: "Google アカウントでログインしてください。" }, { status: 401 });
  }

  const url = new URL(request.url);
  const folderId = normalizeFolderId(url.searchParams.get("folderId") ?? "");

  if (!folderId) {
    return json(
      { error: "Google Drive のフォルダ URL かフォルダ ID を正しく指定してください。" },
      { status: 400 },
    );
  }

  try {
    const { tokens } = await getFreshTokens(env, session);
    const cookie = await sessionCookie(request, env, tokens);
    const tree = await getDriveImageTree(tokens.accessToken, folderId);

    return json({ tree }, { headers: { "Set-Cookie": cookie } });
  } catch (caughtError) {
    return json(
      { error: errorMessage(caughtError, "Drive の読み込みに失敗しました。") },
      { status: 500 },
    );
  }
}

function toJpegFilename(name: string) {
  return name.replace(/\.(heic|heif)$/i, ".jpg");
}

function upscaleDriveThumbnailUrl(url: string) {
  return url.replace(/=s\d+/, "=s1600");
}

async function handleFile(request: Request, env: Env, fileId: string) {
  const session = await readSession(request, env);

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const { tokens, refreshed } = await getFreshTokens(env, session);
    const { metadata, fetchMedia } = await downloadDriveFile(tokens.accessToken, fileId);

    // 画像以外 (HTML・SVG など) は返さない。同一オリジンでスクリプトが動くのを防ぐ
    if (!isSafeImageMimeType(metadata.mimeType)) {
      return new Response("Unsupported file type.", { status: 403 });
    }

    const headers = new Headers();

    if (refreshed) {
      headers.append("Set-Cookie", await sessionCookie(request, env, tokens));
    }

    let body: ReadableStream | null;
    let outputMimeType = metadata.mimeType;
    let outputName = metadata.name;
    const isHeic = isHeicMimeType(metadata.mimeType);

    if (isHeic) {
      // Workers 上では heic-convert (libheif の JS 版) が CPU/メモリ制限に収まらないため、
      // Google Drive が生成する JPEG サムネイル (1600px) を返す。
      // アクセストークンを付けるので、Google の配信元以外には送らない
      if (!metadata.thumbnailLink || !isTrustedThumbnailUrl(metadata.thumbnailLink)) {
        return new Response("HEIC thumbnail is not available yet.", { status: 404 });
      }

      const thumbnailResponse = await fetch(upscaleDriveThumbnailUrl(metadata.thumbnailLink), {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });

      if (!thumbnailResponse.ok) {
        return new Response("HEIC thumbnail could not be loaded.", { status: 502 });
      }

      body = thumbnailResponse.body;
      const thumbnailType = thumbnailResponse.headers.get("content-type")?.split(";")[0].trim();
      outputMimeType = isSafeImageMimeType(thumbnailType) ? thumbnailType! : "image/jpeg";
      outputName = toJpegFilename(metadata.name);
    } else {
      const mediaResponse = await fetchMedia();

      if (!mediaResponse.ok) {
        throw new Error("Failed to download file from Google Drive.");
      }

      body = mediaResponse.body;
      const length = mediaResponse.headers.get("content-length");
      if (length) {
        headers.set("Content-Length", length);
      }
    }

    headers.set("Content-Type", outputMimeType);
    headers.set("Cache-Control", isHeic ? "private, no-store" : "private, max-age=600");
    headers.set(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(outputName)}"`,
    );

    return new Response(body, { status: 200, headers });
  } catch {
    return new Response("File could not be loaded.", { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (pathname.startsWith("/api/")) {
    if (method === "GET" && pathname === "/api/auth/session") {
      return handleSession(request, env);
    }
    if (method === "GET" && pathname === "/api/auth/google/login") {
      return handleLogin(request, env);
    }
    if (method === "GET" && pathname === "/api/auth/google/callback") {
      return handleCallback(request, env);
    }
    if (method === "POST" && pathname === "/api/auth/google/logout") {
      return handleLogout(request, env);
    }
    if (method === "GET" && pathname === "/api/drive/tree") {
      return handleTree(request, env);
    }

    const fileMatch = pathname.match(/^\/api\/drive\/file\/([^/]+)$/);
    if (method === "GET" && fileMatch) {
      // 正しい ID はデコード不要な文字だけなので、そのまま検証する
      if (!isValidDriveId(fileMatch[1])) {
        return new Response("Invalid file ID.", { status: 400 });
      }
      return handleFile(request, env, fileMatch[1]);
    }

    return json({ error: "Not Found" }, { status: 404 });
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    const response = await route(request, env);

    if (!new URL(request.url).pathname.startsWith("/api/")) {
      return response;
    }

    const withHeaders = new Response(response.body, response);
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
      withHeaders.headers.set(name, value);
    }
    return withHeaders;
  },
} satisfies ExportedHandler<Env>;
