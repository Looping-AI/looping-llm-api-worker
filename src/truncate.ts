export const DEFAULT_THINKING_TRUNCATE = 4096;

export interface TruncateResult {
  text: string;
  truncated: boolean;
}

/**
 * Parses `bodyText` as an OpenRouter Responses API response and truncates any
 * `output[type=reasoning].summary[].text` strings that exceed `max` characters.
 *
 * Truncated form: first `floor((max-3)/2)` chars + "..." + last `floor((max-3)/2)` chars.
 *
 * If the body cannot be parsed or does not match the expected shape, it is
 * returned verbatim with `truncated: false`.
 */
export function truncateReasoning(
  bodyText: string,
  max: number,
): TruncateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { text: bodyText, truncated: false };
  }

  if (!isResponsesApiResponse(parsed)) {
    return { text: bodyText, truncated: false };
  }

  let anyTruncated = false;

  for (const item of parsed.output) {
    if (item.type !== "reasoning" || !Array.isArray(item.summary)) continue;
    for (const summaryItem of item.summary) {
      if (
        typeof summaryItem.text === "string" &&
        summaryItem.text.length > max
      ) {
        summaryItem.text = truncateString(summaryItem.text, max);
        anyTruncated = true;
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

import { z } from "zod";

function truncateString(s: string, max: number): string {
  if (max < 5) return s.slice(0, max);
  const half = Math.floor((max - 3) / 2);
  return s.slice(0, half) + "..." + s.slice(s.length - half);
}

const SummaryItemSchema = z.looseObject({
  text: z.string().optional(),
});

const OutputItemSchema = z.looseObject({
  type: z.string(),
  summary: z.array(SummaryItemSchema).optional(),
});

const ResponsesApiSchema = z.looseObject({
  output: z.array(OutputItemSchema),
});

type ResponsesApiResponse = z.infer<typeof ResponsesApiSchema>;

function isResponsesApiResponse(v: unknown): v is ResponsesApiResponse {
  return ResponsesApiSchema.safeParse(v).success;
}
