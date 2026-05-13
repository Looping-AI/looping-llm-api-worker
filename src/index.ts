import { verifyInboundSignature } from "./auth";
import type { EncryptedApiKey } from "./crypto";
import { DEFAULT_THINKING_TRUNCATE } from "./truncate";
import type { Params } from "./workflow";

export { LlmRelayWorkflow } from "./workflow";

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const { method, url } = req;
		const { pathname } = new URL(url);

		if (method === "POST" && pathname === "/relay") {
			return handleRelay(req, env);
		}

		return new Response("Not Found", { status: 404 });
	},
};

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleRelay(req: Request, env: Env): Promise<Response> {
	if (req.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
		return new Response("Unsupported Media Type", { status: 415 });
	}

	// Read raw body once — required for HMAC verification.
	let rawBody: string;
	try {
		rawBody = await req.text();
	} catch {
		return new Response("Bad Request: could not read body", { status: 400 });
	}

	// Verify inbound HMAC signature.
	const authResult = await verifyInboundSignature(
		req.headers,
		rawBody,
		env.SHARED_SECRET,
	);
	if (!authResult.ok) {
		return new Response(`Unauthorized: ${authResult.reason}`, { status: 401 });
	}

	// Parse and validate body shape.
	let body: unknown;
	try {
		body = JSON.parse(rawBody);
	} catch {
		return new Response("Bad Request: invalid JSON", { status: 400 });
	}

	const validation = validateBody(body);
	if (!validation.ok) {
		return new Response(`Bad Request: ${validation.reason}`, { status: 400 });
	}
	const { requestId, openrouter, encryptedApiKey, truncateThinkingMaxChars } =
		validation.data;

	// Dispatch the workflow.
	let instance: { id: string };
	try {
		const params: Params = {
			requestId,
			openrouterPayload: openrouter,
			encryptedApiKey,
			truncateThinkingMaxChars,
		};
		instance = await env.LLM_RELAY.create({ params });
	} catch (err) {
		console.error("[relay] failed to create workflow instance:", err);
		return new Response("Internal Server Error", { status: 500 });
	}

	return Response.json(
		{ ok: true, instanceId: instance.id, requestId },
		{ status: 202 },
	);
}

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

interface ValidBody {
	requestId: string;
	openrouter: Record<string, unknown>;
	encryptedApiKey: EncryptedApiKey;
	truncateThinkingMaxChars: number;
}

type ValidationResult =
	| { ok: true; data: ValidBody }
	| { ok: false; reason: string };

function validateBody(raw: unknown): ValidationResult {
	if (typeof raw !== "object" || raw === null) {
		return { ok: false, reason: "body must be a JSON object" };
	}
	const b = raw as Record<string, unknown>;

	if (typeof b.requestId !== "string" || b.requestId.length === 0) {
		return { ok: false, reason: "requestId must be a non-empty string" };
	}

	if (
		typeof b.openrouter !== "object" ||
		b.openrouter === null ||
		!Array.isArray((b.openrouter as Record<string, unknown>).messages)
	) {
		return { ok: false, reason: "openrouter must be an object with a messages array" };
	}

	const eak = b.encryptedApiKey;
	if (
		typeof eak !== "object" ||
		eak === null ||
		typeof (eak as Record<string, unknown>).iv !== "string" ||
		typeof (eak as Record<string, unknown>).ct !== "string"
	) {
		return { ok: false, reason: "encryptedApiKey must be an object with iv and ct strings" };
	}

	let truncateThinkingMaxChars = DEFAULT_THINKING_TRUNCATE;
	if (b.truncate_thinking_to_max_chars !== undefined && b.truncate_thinking_to_max_chars !== null) {
		if (
			typeof b.truncate_thinking_to_max_chars !== "number" ||
			!Number.isInteger(b.truncate_thinking_to_max_chars) ||
			b.truncate_thinking_to_max_chars <= 0
		) {
			return { ok: false, reason: "truncate_thinking_to_max_chars must be a positive integer or null" };
		}
		truncateThinkingMaxChars = b.truncate_thinking_to_max_chars;
	}

	return {
		ok: true,
		data: {
			requestId: b.requestId as string,
			openrouter: b.openrouter as Record<string, unknown>,
			encryptedApiKey: eak as EncryptedApiKey,
			truncateThinkingMaxChars,
		},
	};
}

