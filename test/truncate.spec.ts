import { describe, it, expect } from "vitest";
import { truncateReasoning, DEFAULT_THINKING_TRUNCATE } from "../src/truncate";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Responses API body with a single reasoning output item
 * whose summary contains one entry per text in `summaryTexts`.
 */
function makeResponse(summaryTexts?: string[]) {
  return JSON.stringify({
    output: [
      {
        type: "reasoning",
        summary: (summaryTexts ?? []).map((text) => ({
          type: "summary_text",
          text,
        })),
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hi" }],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("truncateReasoning", () => {
  it("returns verbatim + truncated:false for invalid JSON", () => {
    const input = "not valid json{{";
    const result = truncateReasoning(input, 100);
    expect(result.text).toBe(input);
    expect(result.truncated).toBe(false);
  });

  it("returns verbatim + truncated:false when output is absent", () => {
    const input = JSON.stringify({ model: "gpt-4" });
    const result = truncateReasoning(input, 100);
    expect(result.text).toBe(input);
    expect(result.truncated).toBe(false);
  });

  it("returns verbatim + truncated:false when output is not an array", () => {
    const input = JSON.stringify({ output: "wrong" });
    const result = truncateReasoning(input, 100);
    expect(result.text).toBe(input);
    expect(result.truncated).toBe(false);
  });

  it("does not truncate summary text that is within max", () => {
    const input = makeResponse(["a".repeat(10)]);
    const result = truncateReasoning(input, 100);
    expect(result.text).toBe(input);
    expect(result.truncated).toBe(false);
  });

  it("does not truncate summary text that equals max exactly", () => {
    const input = makeResponse(["a".repeat(100)]);
    const result = truncateReasoning(input, 100);
    expect(result.text).toBe(input);
    expect(result.truncated).toBe(false);
  });

  it("truncates summary text longer than max with correct head+tail", () => {
    const max = 20; // half = floor((20-3)/2) = 8
    const result = truncateReasoning(makeResponse(["A".repeat(100)]), max);

    expect(result.truncated).toBe(true);

    const parsed = JSON.parse(result.text);
    const got: string = parsed.output[0].summary[0].text;
    const half = Math.floor((max - 3) / 2);
    expect(got).toBe("A".repeat(half) + "..." + "A".repeat(half));
    expect(got.length).toBe(half * 2 + 3);
  });

  it("truncates a long summary item and leaves a short one untouched", () => {
    const max = 10; // half = 3
    const result = truncateReasoning(
      makeResponse(["short", "X".repeat(50)]),
      max,
    );

    expect(result.truncated).toBe(true);
    const parsed = JSON.parse(result.text);
    const summary = parsed.output[0].summary;
    expect(summary[0].text).toBe("short"); // untouched
    const half = Math.floor((max - 3) / 2);
    expect(summary[1].text).toBe("X".repeat(half) + "..." + "X".repeat(half));
  });

  it("does not truncate non-reasoning output items", () => {
    const input = JSON.stringify({
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Z".repeat(100) }],
        },
      ],
    });
    const result = truncateReasoning(input, 10);
    expect(result.text).toBe(input);
    expect(result.truncated).toBe(false);
  });

  it("does not re-serialise the body when nothing was truncated", () => {
    const input = makeResponse(["short"]);
    const result = truncateReasoning(input, DEFAULT_THINKING_TRUNCATE);
    expect(result.text).toBe(input);
    expect(result.truncated).toBe(false);
  });

  it("sets truncated:true only when at least one summary item is over max", () => {
    const max = 20;
    const result = truncateReasoning(
      makeResponse(["short", "Z".repeat(100)]),
      max,
    );
    expect(result.truncated).toBe(true);
  });
});
