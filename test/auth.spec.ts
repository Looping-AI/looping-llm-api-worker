import { describe, it, expect } from "vitest";
import {
	verifyInboundSignature,
	signOutbound,
	MAX_TIMESTAMP_SKEW_SECONDS,
} from "../src/auth";
import { getKeys, signHmac } from "../src/crypto";

const SECRET = "test-secret";

function makeHeaders(overrides: Record<string, string | undefined> = {}): Headers {
	const h = new Headers();
	for (const [k, v] of Object.entries(overrides)) {
		if (v !== undefined) h.set(k, v);
	}
	return h;
}

async function validHeaders(body: string): Promise<Headers> {
	const { signature, timestamp } = await signOutbound(body, SECRET);
	return makeHeaders({
		"x-signature": signature,
		"x-timestamp": String(timestamp),
	});
}

// ---------------------------------------------------------------------------
// Missing header cases
// ---------------------------------------------------------------------------

describe("verifyInboundSignature - missing headers", () => {
	it("rejects when X-Signature is absent", async () => {
		const headers = makeHeaders({ "x-timestamp": "1234567890" });
		const result = await verifyInboundSignature(headers, "body", SECRET);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/missing/i);
	});

	it("rejects when X-Timestamp is absent", async () => {
		const headers = makeHeaders({ "x-signature": "sha256=aabbcc" });
		const result = await verifyInboundSignature(headers, "body", SECRET);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/missing/i);
	});
});

// ---------------------------------------------------------------------------
// Timestamp validation
// ---------------------------------------------------------------------------

describe("verifyInboundSignature - timestamp validation", () => {
	it("rejects a non-integer timestamp string", async () => {
		const headers = makeHeaders({ "x-signature": "sha256=aabbcc", "x-timestamp": "not-a-number" });
		const result = await verifyInboundSignature(headers, "body", SECRET);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/invalid/i);
	});

	it("rejects timestamp zero", async () => {
		const headers = makeHeaders({ "x-signature": "sha256=aabbcc", "x-timestamp": "0" });
		const result = await verifyInboundSignature(headers, "body", SECRET);
		expect(result.ok).toBe(false);
	});

	it("rejects timestamp too far in the past", async () => {
		const ts = Math.floor(Date.now() / 1000) - MAX_TIMESTAMP_SKEW_SECONDS - 1;
		// Sign with the stale timestamp to pass signature check, but timestamp check fires first
		const { hmac } = await getKeys(SECRET);
		const body = "stale-body";
		const hex = await signHmac(hmac, `${ts}.${body}`);
		const headers = makeHeaders({
			"x-signature": `sha256=${hex}`,
			"x-timestamp": String(ts),
		});
		const result = await verifyInboundSignature(headers, body, SECRET);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/outside acceptable window/i);
	});

	it("rejects timestamp too far in the future", async () => {
		const ts = Math.floor(Date.now() / 1000) + MAX_TIMESTAMP_SKEW_SECONDS + 1;
		const { hmac } = await getKeys(SECRET);
		const body = "future-body";
		const hex = await signHmac(hmac, `${ts}.${body}`);
		const headers = makeHeaders({
			"x-signature": `sha256=${hex}`,
			"x-timestamp": String(ts),
		});
		const result = await verifyInboundSignature(headers, body, SECRET);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/outside acceptable window/i);
	});
});

// ---------------------------------------------------------------------------
// Signature format
// ---------------------------------------------------------------------------

describe("verifyInboundSignature - signature format", () => {
	it("rejects X-Signature that does not start with sha256=", async () => {
		const ts = Math.floor(Date.now() / 1000);
		const headers = makeHeaders({
			"x-signature": "md5=aabbccddeeff",
			"x-timestamp": String(ts),
		});
		const result = await verifyInboundSignature(headers, "body", SECRET);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/sha256=/i);
	});
});

// ---------------------------------------------------------------------------
// Signature mismatch
// ---------------------------------------------------------------------------

describe("verifyInboundSignature - signature mismatch", () => {
	it("rejects a valid-format signature that does not match the body", async () => {
		const { hmac } = await getKeys(SECRET);
		const ts = Math.floor(Date.now() / 1000);
		// Sign a different body
		const hex = await signHmac(hmac, `${ts}.other-body`);
		const headers = makeHeaders({
			"x-signature": `sha256=${hex}`,
			"x-timestamp": String(ts),
		});
		const result = await verifyInboundSignature(headers, "actual-body", SECRET);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/mismatch/i);
	});
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("verifyInboundSignature - happy path", () => {
	it("accepts a correctly signed request", async () => {
		const body = JSON.stringify({ requestId: "r1" });
		const headers = await validHeaders(body);
		const result = await verifyInboundSignature(headers, body, SECRET);
		expect(result.ok).toBe(true);
	});

	it("signOutbound + verifyInboundSignature roundtrip", async () => {
		const body = "the-raw-body-content";
		const { signature, timestamp } = await signOutbound(body, SECRET);
		const headers = makeHeaders({
			"x-signature": signature,
			"x-timestamp": String(timestamp),
		});
		const result = await verifyInboundSignature(headers, body, SECRET);
		expect(result.ok).toBe(true);
	});
});
