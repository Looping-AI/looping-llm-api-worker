import { z } from "zod";
import { verifyInboundSignature } from "./auth";
import { DEFAULT_THINKING_TRUNCATE } from "./truncate";
import type { Params } from "./workflow";

export { LlmRelayWorkflow } from "./workflow";

export default {
  async fetch(
    req: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
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
  if (
    req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  ) {
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
  try {
    const params: Params = {
      openrouterPayload: openrouter,
      encryptedApiKey,
      truncateThinkingMaxChars,
    };
    await env.LLM_RELAY.create({ id: requestId, params });
  } catch (err) {
    // create() throws when an instance with the same ID already exists within
    // its retention window. Treat this as an idempotent duplicate submission.
    if (/already exists/i.test(String(err))) {
      return Response.json({ ok: true, requestId }, { status: 202 });
    }
    console.error("[relay] failed to create workflow instance:", err);
    return new Response("Internal Server Error", { status: 500 });
  }

  return Response.json({ ok: true, requestId }, { status: 202 });
}

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

const BodySchema = z.object({
  requestId: z.string().min(1),
  openrouter: z.looseObject({ messages: z.array(z.unknown()) }),
  encryptedApiKey: z.object({ iv: z.string(), ct: z.string() }),
  truncate_thinking_to_max_chars: z.int().positive().optional().nullable(),
});

type ValidBody = {
  requestId: string;
  openrouter: Record<string, unknown>;
  encryptedApiKey: { iv: string; ct: string };
  truncateThinkingMaxChars: number;
};

type ValidationResult =
  | { ok: true; data: ValidBody }
  | { ok: false; reason: string };

function validateBody(raw: unknown): ValidationResult {
  const result = BodySchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      reason: result.error.issues[0]?.message ?? "invalid body",
    };
  }
  const { truncate_thinking_to_max_chars, ...rest } = result.data;
  return {
    ok: true,
    data: {
      requestId: rest.requestId,
      openrouter: rest.openrouter,
      encryptedApiKey: rest.encryptedApiKey,
      truncateThinkingMaxChars:
        truncate_thinking_to_max_chars ?? DEFAULT_THINKING_TRUNCATE,
    },
  };
}
