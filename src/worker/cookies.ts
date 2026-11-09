export const SESSION_COOKIE = "google_drive_session";
export const OAUTH_STATE_COOKIE = "google_oauth_state";

export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
export const OAUTH_STATE_MAX_AGE = 60 * 10;

export function getCookie(request: Request, name: string) {
  const header = request.headers.get("Cookie");

  if (!header) {
    return undefined;
  }

  for (const part of header.split(";")) {
    const index = part.indexOf("=");

    if (index === -1) {
      continue;
    }

    if (part.slice(0, index).trim() === name) {
      const raw = part.slice(index + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }

  return undefined;
}

export function serializeCookie(
  request: Request,
  name: string,
  value: string,
  maxAge: number,
) {
  const secure = new URL(request.url).protocol === "https:";

  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function deleteCookie(request: Request, name: string) {
  return serializeCookie(request, name, "", 0);
}
