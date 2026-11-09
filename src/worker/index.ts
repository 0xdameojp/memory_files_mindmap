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
} from "./google-drive";
import { sealJson, unsealJson } from "./session";

const NO_INDEX = "noindex, nofollow, noimageindex, noarchive";

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
  return unsealJson<SessionTokens>(getCookie(request, SESSION_COOKIE), env.APP_SESSION_SECRET);
}

async function sessionCookie(request: Request, env: Env, tokens: SessionTokens) {
  return serializeCookie(
    request,
    SESSION_COOKIE,
    await sealJson(tokens, env.APP_SESSION_SECRET),
    SESSION_MAX_AGE,
  );
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

      if (folderMatch?.[1]) {
        return folderMatch[1];
      }

      return url.searchParams.get("id") ?? "";
    } catch {
      return "";
    }
  }

  return trimmed;
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
    await sealJson({ state }, env.APP_SESSION_SECRET),
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
    getCookie(request, OAUTH_STATE_COOKIE),
    env.APP_SESSION_SECRET,
  );
  const clearState = deleteCookie(request, OAUTH_STATE_COOKIE);
  const errorRedirect = (message: string) =>
    redirect(new URL(`/?error=${encodeURIComponent(message)}`, appBaseUrl).toString(), [
      clearState,
    ]);

  if (error) {
    return errorRedirect(`Google OAuth error: ${error}`);
  }

  if (!code || !returnedState || !savedState || returnedState !== savedState.state) {
    return errorRedirect("OAuth state verification failed. Please try again.");
  }

  try {
    const tokens = await exchangeCodeForTokens(env, code, request.url);

    return redirect(new URL("/", appBaseUrl).toString(), [
      clearState,
      await sessionCookie(request, env, tokens),
    ]);
  } catch (caughtError) {
    return errorRedirect(
      errorMessage(caughtError, "Google authentication could not be completed."),
    );
  }
}

function handleLogout(request: Request) {
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
    return json({ error: "folderId を指定してください。" }, { status: 400 });
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

function isHeicLikeFile(name: string, mimeType: string) {
  return (
    mimeType.includes("heic") || mimeType.includes("heif") || /\.(heic|heif)$/i.test(name)
  );
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
    const headers = new Headers();

    if (refreshed) {
      headers.append("Set-Cookie", await sessionCookie(request, env, tokens));
    }

    let body: ReadableStream | null;
    let outputMimeType = metadata.mimeType;
    let outputName = metadata.name;
    const isHeic = isHeicLikeFile(metadata.name, metadata.mimeType);

    if (isHeic) {
      // Workers 上では heic-convert (libheif の JS 版) が CPU/メモリ制限に収まらないため、
      // Google Drive が生成する JPEG サムネイル (1600px) を返す。
      if (!metadata.thumbnailLink) {
        return new Response("HEIC thumbnail is not available yet.", { status: 404 });
      }

      const thumbnailResponse = await fetch(upscaleDriveThumbnailUrl(metadata.thumbnailLink), {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });

      if (!thumbnailResponse.ok) {
        return new Response("HEIC thumbnail could not be loaded.", { status: 502 });
      }

      body = thumbnailResponse.body;
      outputMimeType = thumbnailResponse.headers.get("content-type") ?? "image/jpeg";
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
      return handleLogout(request);
    }
    if (method === "GET" && pathname === "/api/drive/tree") {
      return handleTree(request, env);
    }

    const fileMatch = pathname.match(/^\/api\/drive\/file\/([^/]+)$/);
    if (method === "GET" && fileMatch) {
      return handleFile(request, env, decodeURIComponent(fileMatch[1]));
    }

    return json({ error: "Not Found" }, { status: 404 });
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    const response = await route(request, env);
    // 元の robots 設定と同じく、全レスポンスを検索エンジンから除外
    const withHeaders = new Response(response.body, response);
    withHeaders.headers.set("X-Robots-Tag", NO_INDEX);
    return withHeaders;
  },
} satisfies ExportedHandler<Env>;
