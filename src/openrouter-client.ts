const OPENROUTER_URL = "https://openrouter.ai/api/v1/responses";

const ALLOWED_HEADER_PREFIXES = [
  "content-type",
  "x-request-id",
  "openrouter-",
  "x-openrouter-",
];

export interface OpenRouterSuccess {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type OpenRouterResult = OpenRouterSuccess;

export function extractAllowedHeaders(
  headers: Headers,
): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      ALLOWED_HEADER_PREFIXES.some((p) => lower === p || lower.startsWith(p))
    ) {
      result[lower] = value;
    }
  });
  return result;
}

export class OpenRouterClient {
  constructor(private readonly apiKey: string) {}

  async respond(payload: Record<string, unknown>): Promise<OpenRouterResult> {
    const resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://loopingai.app",
      },
      body: JSON.stringify({ ...payload, stream: false }),
    });
    return {
      status: resp.status,
      headers: extractAllowedHeaders(resp.headers),
      body: await resp.text(),
    };
  }
}
