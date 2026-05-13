export const DEFAULT_THINKING_TRUNCATE = 4096;

export interface TruncateResult {
	text: string;
	truncated: boolean;
}

/**
 * Parses `bodyText` as an OpenAI-style chat completion and truncates any
 * `reasoning` / `reasoning_details[].text` / `reasoning_details[].summary`
 * strings that exceed `max` characters.
 *
 * Truncated form: first `floor((max-3)/2)` chars + "..." + last `floor((max-3)/2)` chars.
 *
 * If the body cannot be parsed or does not match the expected shape, it is
 * returned verbatim with `truncated: false`.
 */
export function truncateReasoning(bodyText: string, max: number): TruncateResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return { text: bodyText, truncated: false };
	}

	if (!isOpenAiStyleResponse(parsed)) {
		return { text: bodyText, truncated: false };
	}

	let anyTruncated = false;

	for (const choice of parsed.choices) {
		const msg = choice.message;
		if (typeof msg.reasoning === "string" && msg.reasoning.length > max) {
			msg.reasoning = truncateString(msg.reasoning, max);
			anyTruncated = true;
		}
		if (Array.isArray(msg.reasoning_details)) {
			for (const detail of msg.reasoning_details) {
				if (typeof detail.text === "string" && detail.text.length > max) {
					detail.text = truncateString(detail.text, max);
					anyTruncated = true;
				}
				if (typeof detail.summary === "string" && detail.summary.length > max) {
					detail.summary = truncateString(detail.summary, max);
					anyTruncated = true;
				}
			}
		}
	}

	return {
		text: anyTruncated ? JSON.stringify(parsed) : bodyText,
		truncated: anyTruncated,
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function truncateString(s: string, max: number): string {
	const half = Math.floor((max - 3) / 2);
	return s.slice(0, half) + "..." + s.slice(s.length - half);
}

type OpenAiMessage = {
	reasoning?: string;
	reasoning_details?: Array<{ text?: string; summary?: string }>;
	[key: string]: unknown;
};

type OpenAiStyleResponse = {
	choices: Array<{ message: OpenAiMessage; [key: string]: unknown }>;
	[key: string]: unknown;
};

function isOpenAiStyleResponse(v: unknown): v is OpenAiStyleResponse {
	return (
		typeof v === "object" &&
		v !== null &&
		"choices" in v &&
		Array.isArray((v as Record<string, unknown>).choices)
	);
}
