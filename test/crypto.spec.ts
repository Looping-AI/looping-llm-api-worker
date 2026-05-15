import { describe, it, expect } from "vitest";
import {
  getKeys,
  setKeys,
  signHmac,
  verifyHmac,
  decryptApiKey,
  b64encode,
  HKDF_INFO,
} from "../src/crypto";

const SECRET = "test-secret";

// ---------------------------------------------------------------------------
// Key derivation + caching
// ---------------------------------------------------------------------------

describe("getKeys / setKeys", () => {
  it("returns CryptoKeys for hmac and aes", async () => {
    const keys = await setKeys(SECRET);
    expect(keys.hmac).toBeInstanceOf(CryptoKey);
    expect(keys.aes).toBeInstanceOf(CryptoKey);
  });

  it("getKeys() returns the cached object after setKeys()", async () => {
    const k1 = await setKeys(SECRET);
    const k2 = getKeys();
    expect(k2).not.toBeNull();
    expect(k1.hmac).toBe(k2!.hmac);
    expect(k1.aes).toBe(k2!.aes);
  });
});

// ---------------------------------------------------------------------------
// HMAC sign + verify
// ---------------------------------------------------------------------------

describe("signHmac / verifyHmac", () => {
  it("verifies a signature produced by signHmac", async () => {
    const { hmac } = await setKeys(SECRET);
    const hex = await signHmac(hmac, "hello world");
    const valid = await verifyHmac(hmac, "hello world", hex);
    expect(valid).toBe(true);
  });

  it("rejects a tampered message", async () => {
    const { hmac } = await setKeys(SECRET);
    const hex = await signHmac(hmac, "original");
    const valid = await verifyHmac(hmac, "tampered", hex);
    expect(valid).toBe(false);
  });

  it("rejects a malformed hex signature", async () => {
    const { hmac } = await setKeys(SECRET);
    const valid = await verifyHmac(hmac, "msg", "not-hex!!!");
    expect(valid).toBe(false);
  });

  it("rejects a truncated hex signature (wrong length)", async () => {
    const { hmac } = await setKeys(SECRET);
    const hex = await signHmac(hmac, "msg");
    const valid = await verifyHmac(hmac, "msg", hex.slice(0, 10));
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AES-256-GCM decryption
// ---------------------------------------------------------------------------

describe("decryptApiKey", () => {
  it("round-trips: encrypt with SubtleCrypto then decryptApiKey", async () => {
    const { aes } = await setKeys(SECRET);

    // Encrypt directly with SubtleCrypto so we have a valid ciphertext
    const plaintext = "sk-or-supersecretkey";
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        // decryptApiKey uses the derived aes key, so we must encrypt with the
        // same key. Re-derive an encrypt-capable copy.
        await crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array(0),
            info: new TextEncoder().encode(HKDF_INFO),
          },
          await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(SECRET),
            { name: "HKDF" },
            false,
            ["deriveKey"],
          ),
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt"],
        ),
        new TextEncoder().encode(plaintext),
      ),
    );

    const result = await decryptApiKey(aes, {
      iv: b64encode(iv),
      ct: b64encode(ct),
    });

    expect(result).toBe(plaintext);
  });

  it("throws on tampered ciphertext (GCM auth tag failure)", async () => {
    const { aes } = await setKeys(SECRET);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    // 20 bytes of garbage — not a valid GCM ciphertext+tag
    const ct = crypto.getRandomValues(new Uint8Array(20));

    await expect(
      decryptApiKey(aes, { iv: b64encode(iv), ct: b64encode(ct) }),
    ).rejects.toThrow();
  });
});
