// Web Crypto (HMAC-SHA256) で署名した JSON を Cookie に載せる。
// 元の Node.js 版 (node:crypto) と同じ `payload.signature` 形式・同じ署名結果。

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function getKey(secret: string) {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    keyCache.set(secret, key);
  }
  return key;
}

function requireSecret(secret: string | undefined) {
  if (!secret) {
    throw new Error("APP_SESSION_SECRET is not set.");
  }
  return secret;
}

export async function sealJson<T>(value: T, secret: string | undefined) {
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify(value)));
  const key = await getKey(requireSecret(secret));
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

  return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function unsealJson<T>(
  sealedValue: string | null | undefined,
  secret: string | undefined,
): Promise<T | null> {
  if (!sealedValue) {
    return null;
  }

  const [payload, signature] = sealedValue.split(".");

  if (!payload || !signature) {
    return null;
  }

  try {
    const key = await getKey(requireSecret(secret));
    // crypto.subtle.verify は定数時間比較
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(signature),
      encoder.encode(payload),
    );

    if (!valid) {
      return null;
    }

    return JSON.parse(decoder.decode(base64UrlToBytes(payload))) as T;
  } catch {
    return null;
  }
}
