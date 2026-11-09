import type { MindMapNode, SessionTokens } from "../shared/types";
import type { Env } from "./env";

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.readonly",
];

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_API_URL = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

// 表示してよい画像形式だけを許可する。
// SVG はスクリプトを含められるため除外 (同一オリジンで開かれると XSS になる)。
const SAFE_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/pjpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-ms-bmp",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

export function isSafeImageMimeType(mimeType: string | null | undefined) {
  return Boolean(mimeType && SAFE_IMAGE_MIME_TYPES.has(mimeType.toLowerCase()));
}

export function isHeicMimeType(mimeType: string) {
  return /^image\/(heic|heif)/i.test(mimeType);
}

// Workers には 1 リクエストあたりのサブリクエスト数上限があるため、
// 複数フォルダの中身を `'a' in parents or 'b' in parents ...` で 1 回にまとめて取得する。
const PARENTS_PER_QUERY = 30;

type DriveFile = {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  webViewLink?: string | null;
  thumbnailLink?: string | null;
  parents?: string[] | null;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type DriveListResponse = {
  files?: DriveFile[];
  nextPageToken?: string;
};

function requireEnv(env: Env, name: "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET") {
  const value = env[name];

  if (!value) {
    throw new Error(`${name} is not set.`);
  }

  return value;
}

export function getAppBaseUrl(env: Env, requestUrl: string) {
  if (env.APP_BASE_URL) {
    return env.APP_BASE_URL.replace(/\/$/, "");
  }

  const url = new URL(requestUrl);
  return `${url.protocol}//${url.host}`;
}

export function getGoogleRedirectUri(env: Env, requestUrl: string) {
  if (env.GOOGLE_REDIRECT_URI) {
    return env.GOOGLE_REDIRECT_URI;
  }

  return `${getAppBaseUrl(env, requestUrl)}/api/auth/google/callback`;
}

function toExpiryDate(expiresInSeconds?: number) {
  if (!expiresInSeconds) {
    return undefined;
  }

  return Date.now() + expiresInSeconds * 1000;
}

async function postForm<TResponse>(
  url: string,
  params: Record<string, string>,
): Promise<TResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });

  const data = (await response.json()) as TResponse;

  if (!response.ok) {
    const maybeError = data as TokenResponse;
    throw new Error(
      maybeError.error_description ??
        maybeError.error ??
        "Google API request failed.",
    );
  }

  return data;
}

async function fetchJson<TResponse>(
  url: string,
  accessToken: string,
): Promise<TResponse> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    let message = "Google Drive request failed.";

    try {
      const data = (await response.json()) as {
        error?: { message?: string };
      };
      message = data.error?.message ?? message;
    } catch {
      // Ignore JSON parsing failures and use fallback message.
    }

    throw new Error(message);
  }

  return (await response.json()) as TResponse;
}

async function refreshAccessToken(
  env: Env,
  refreshToken: string,
): Promise<Pick<SessionTokens, "accessToken" | "expiryDate">> {
  const tokens = await postForm<TokenResponse>(GOOGLE_TOKEN_URL, {
    client_id: requireEnv(env, "GOOGLE_CLIENT_ID"),
    client_secret: requireEnv(env, "GOOGLE_CLIENT_SECRET"),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  if (!tokens.access_token) {
    throw new Error("Google refresh token flow did not return an access token.");
  }

  return {
    accessToken: tokens.access_token,
    expiryDate: toExpiryDate(tokens.expires_in),
  };
}

export function createGoogleLoginUrl(env: Env, state: string, requestUrl: string) {
  const params = new URLSearchParams({
    client_id: requireEnv(env, "GOOGLE_CLIENT_ID"),
    redirect_uri: getGoogleRedirectUri(env, requestUrl),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: GOOGLE_SCOPES.join(" "),
    state,
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  env: Env,
  code: string,
  requestUrl: string,
): Promise<SessionTokens> {
  const tokens = await postForm<TokenResponse>(GOOGLE_TOKEN_URL, {
    client_id: requireEnv(env, "GOOGLE_CLIENT_ID"),
    client_secret: requireEnv(env, "GOOGLE_CLIENT_SECRET"),
    code,
    grant_type: "authorization_code",
    redirect_uri: getGoogleRedirectUri(env, requestUrl),
  });

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error(
      "Google did not return both access_token and refresh_token. Try reconnecting and granting consent again.",
    );
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: toExpiryDate(tokens.expires_in),
  };
}

/** Google 側でトークンを失効させる (リフレッシュトークンを渡すと、紐づくアクセストークンも失効する) */
export async function revokeToken(token: string) {
  try {
    await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // 失効に失敗しても Cookie の削除は行う
  }
}

/** 期限切れ間近ならリフレッシュしたトークンを返す */
export async function getFreshTokens(
  env: Env,
  tokens: SessionTokens,
): Promise<{ tokens: SessionTokens; refreshed: boolean }> {
  const shouldRefresh =
    !tokens.expiryDate || tokens.expiryDate - Date.now() < 60_000;

  if (!shouldRefresh) {
    return { tokens, refreshed: false };
  }

  const refreshedTokens = await refreshAccessToken(env, tokens.refreshToken);

  return {
    tokens: {
      accessToken: refreshedTokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiryDate: refreshedTokens.expiryDate,
    },
    refreshed: true,
  };
}

function isFolder(file: DriveFile) {
  return file.mimeType === "application/vnd.google-apps.folder";
}

function isImage(file: DriveFile) {
  return isSafeImageMimeType(file.mimeType);
}

function createDriveFileUrl(fileId: string, fields?: string) {
  const url = new URL(`${GOOGLE_DRIVE_API_URL}/${encodeURIComponent(fileId)}`);
  url.searchParams.set("supportsAllDrives", "true");

  if (fields) {
    url.searchParams.set("fields", fields);
  }

  return url.toString();
}

function escapeQueryValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** 複数フォルダの直下エントリを 1 クエリ (＋ページング) でまとめて取得 */
async function listEntriesOfParents(accessToken: string, parentIds: string[]) {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  const parentClause = parentIds
    .map((id) => `'${escapeQueryValue(id)}' in parents`)
    .join(" or ");

  do {
    const url = new URL(GOOGLE_DRIVE_API_URL);
    url.searchParams.set("q", `(${parentClause}) and trashed = false`);
    url.searchParams.set(
      "fields",
      "nextPageToken,files(id,name,mimeType,webViewLink,parents)",
    );
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");

    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await fetchJson<DriveListResponse>(url.toString(), accessToken);

    files.push(...(response.files ?? []));
    pageToken = response.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}

async function getDriveFile(
  accessToken: string,
  fileId: string,
  fields: string,
): Promise<DriveFile> {
  return fetchJson<DriveFile>(createDriveFileUrl(fileId, fields), accessToken);
}

async function getRootFolder(accessToken: string, folderId: string) {
  const file = await getDriveFile(accessToken, folderId, "id,name,mimeType");

  if (!file.id || !isFolder(file)) {
    throw new Error("The specified ID is not an accessible Google Drive folder.");
  }

  return {
    // "root" エイリアスを実 ID に解決しておく (parents は実 ID で返るため)
    id: file.id,
    name: folderId === "root" ? "My Drive" : (file.name ?? "Untitled folder"),
  };
}

function chunk<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

const byName = (a: DriveFile, b: DriveFile) =>
  (a.name ?? "").localeCompare(b.name ?? "", "ja");

export async function getDriveImageTree(
  accessToken: string,
  folderId: string,
): Promise<MindMapNode> {
  const root = await getRootFolder(accessToken, folderId);

  // 幅優先で階層ごとにまとめて取得
  const entriesByParent = new Map<string, DriveFile[]>();
  const visited = new Set<string>([root.id]);
  let frontier = [root.id];

  while (frontier.length > 0) {
    const batches = chunk(frontier, PARENTS_PER_QUERY);
    const results = await Promise.all(
      batches.map((batch) => listEntriesOfParents(accessToken, batch)),
    );
    const frontierSet = new Set(frontier);
    const nextFrontier: string[] = [];

    for (const id of frontier) {
      entriesByParent.set(id, []);
    }

    for (const file of results.flat()) {
      if (!file.id) {
        continue;
      }

      for (const parentId of file.parents ?? []) {
        if (frontierSet.has(parentId)) {
          entriesByParent.get(parentId)?.push(file);
        }
      }

      if (isFolder(file) && !visited.has(file.id)) {
        visited.add(file.id);
        nextFrontier.push(file.id);
      }
    }

    frontier = nextFrontier;
  }

  const ancestors = new Set<string>();

  const build = (id: string, name: string): MindMapNode => {
    ancestors.add(id);
    const entries = entriesByParent.get(id) ?? [];

    const folderChildren = entries
      .filter(isFolder)
      .filter((item) => !ancestors.has(item.id as string))
      .sort(byName)
      .map((folder) => build(folder.id as string, folder.name ?? "Untitled folder"));

    const imageChildren: MindMapNode[] = entries
      .filter(isImage)
      .sort(byName)
      .map((image) => ({
        id: image.id as string,
        name: image.name ?? "Untitled image",
        type: "image",
        mimeType: image.mimeType ?? undefined,
        webViewLink: image.webViewLink ?? undefined,
        imageUrl: `/api/drive/file/${image.id}`,
        children: [],
        imageCount: 1,
      }));

    ancestors.delete(id);

    const children = [...folderChildren, ...imageChildren];
    const imageCount = children.reduce(
      (sum, child) => sum + (child.type === "image" ? 1 : child.imageCount),
      0,
    );

    return {
      // ルートはリクエストされた ID のまま返す (元実装と同じ)
      id: id === root.id ? folderId : id,
      name,
      type: "folder",
      children,
      imageCount,
    };
  };

  return build(root.id, root.name);
}

export async function downloadDriveFile(accessToken: string, fileId: string) {
  const metadata = await getDriveFile(
    accessToken,
    fileId,
    "mimeType,name,thumbnailLink",
  );

  return {
    metadata: {
      mimeType: metadata.mimeType ?? "application/octet-stream",
      name: metadata.name ?? `${fileId}.bin`,
      thumbnailLink: metadata.thumbnailLink ?? undefined,
    },
    fetchMedia: () =>
      fetch(`${createDriveFileUrl(fileId)}&alt=media`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
  };
}
