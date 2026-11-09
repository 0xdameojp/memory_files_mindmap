// Cookie に載せる値を AES-256-GCM で暗号化＋改ざん検知する。
// 鍵は APP_SESSION_SECRET から HKDF-SHA256 で導出する。
// 形式: `v1.<iv>.<ciphertext>` (いずれも base64url)
// 中身には有効期限 (exp) を含め、Cookie の Max-Age とは別にサーバー側でも期限切れを判定する。

const VERSION = "v1";
const IV_LENGTH = 12;

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
    key = (async () => {
      const material = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        "HKDF",
        false,
        ["deriveKey"],
      );
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: encoder.encode("drive-mind-map"),
          info: encoder.encode("cookie-encryption-v1"),
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keyCache.set(secret, key);
  }
  return key;
}

function requireSecret(secret: string | undefined) {
  if (!secret || secret.length < 32) {
    throw new Error("APP_SESSION_SECRET must be set to a random string of at least 32 characters.");
  }
  return secret;
}

type Envelope<T> = { v: T; exp: number };

/** 値を暗号化する。`name` は Cookie 名で、別の Cookie への差し替えを防ぐ追加認証データに使う */
export async function sealJson<T>(
  name: string,
  value: T,
  maxAgeSeconds: number,
  secret: string | undefined,
) {
  const key = await getKey(requireSecret(secret));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const envelope: Envelope<T> = { v: value, exp: Date.now() + maxAgeSeconds * 1000 };
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(name) },
    key,
    encoder.encode(JSON.stringify(envelope)),
  );

  return `${VERSION}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function unsealJson<T>(
  name: string,
  sealedValue: string | null | undefined,
  secret: string | undefined,
): Promise<T | null> {
  if (!sealedValue) {
    return null;
  }

  const [version, ivPart, dataPart] = sealedValue.split(".");

  if (version !== VERSION || !ivPart || !dataPart) {
    return null;
  }

  try {
    const key = await getKey(requireSecret(secret));
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(ivPart), additionalData: encoder.encode(name) },
      key,
      base64UrlToBytes(dataPart),
    );
    const envelope = JSON.parse(decoder.decode(plaintext)) as Envelope<T>;

    if (typeof envelope.exp !== "number" || envelope.exp < Date.now()) {
      return null;
    }

    return envelope.v;
  } catch {
    return null;
  }
}
