/**
 * Crypto utilities: HMAC-SHA256 signing/verification and AES-256-GCM
 * decryption. Keys are derived once per isolate and cached in module scope.
 *
 * HMAC key  – imported directly from the raw UTF-8 bytes of SHARED_SECRET.
 * AES key   – HKDF-SHA256(SHARED_SECRET, salt="", info="openrouter-key-v1") → 32 B.
 */

interface KeyCache {
  hmac: CryptoKey;
  aes: CryptoKey;
}

export const HKDF_INFO = "openrouter-key-v1";

let _cache: KeyCache | null = null;

/** Returns the per-isolate cached key pair, or null if not yet initialised. */
export function getKeys(): KeyCache | null {
  return _cache;
}

/**
 * Derives and caches the key pair from `secret` on first call.
 * Subsequent calls return the existing cache without re-deriving.
 */
export async function setKeys(secret: string): Promise<KeyCache> {
  if (_cache) return _cache;

  const secretBytes = new TextEncoder().encode(secret);

  // --- HMAC key (raw secret bytes) ---
  const hmac = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  // --- AES key via HKDF ---
  const hkdfBase = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HKDF" },
    false,
    ["deriveKey"],
  );

  const aes = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    hkdfBase,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  _cache = { hmac, aes };
  return _cache;
}

// ---------------------------------------------------------------------------
// HMAC helpers
// ---------------------------------------------------------------------------

/** Signs `message` with the HMAC key and returns a lower-case hex string. */
export async function signHmac(
  key: CryptoKey,
  message: string,
): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return bytesToHex(new Uint8Array(sig));
}

/**
 * Constant-time comparison of a message against a hex HMAC digest.
 * Returns false on any mismatch without leaking timing information.
 */
export async function verifyHmac(
  key: CryptoKey,
  message: string,
  expectedHex: string,
): Promise<boolean> {
  const expected = hexToBytes(expectedHex);
  if (!expected) return false; // malformed hex

  const actual = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );

  return bytesEqualConstantTime(actual, expected);
}

// ---------------------------------------------------------------------------
// AES-256-GCM decryption
// ---------------------------------------------------------------------------

export interface EncryptedApiKey {
  iv: string; // base64 standard, 12 bytes
  ct: string; // base64 standard, ciphertext + 16-byte GCM tag appended
}

/**
 * Decrypts the caller-supplied encrypted API key.
 * Throws if the version is unsupported or the GCM auth tag fails.
 */
export async function decryptApiKey(
  aesKey: CryptoKey,
  payload: EncryptedApiKey,
): Promise<string> {
  const iv = b64decode(payload.iv);
  const ct = b64decode(payload.ct);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    ct,
  );

  return new TextDecoder().decode(plaintext);
}

// ---------------------------------------------------------------------------
// Base64 helpers (standard alphabet, not URL-safe)
// ---------------------------------------------------------------------------

export function b64decode(input: string): Uint8Array {
  const bin = atob(input);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Returns null if `hex` contains non-hex characters or has odd length. */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Constant-time byte array equality.
 * Always iterates the full length of `a` to prevent timing leaks.
 */
export function bytesEqualConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
