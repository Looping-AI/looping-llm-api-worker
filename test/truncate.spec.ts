import { describe, it, expect } from "vitest";
import { truncateReasoning, DEFAULT_THINKING_TRUNCATE } from "../src/truncate";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(
  reasoning: string | null,
  reasoningDetails?: Array<{ text?: string; summary?: string }>,
) {
  return JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: "hi",
          ...(reasoning !== null ? { reasoning } : {}),
          ...(reasoningDetails ? { reasoning_details: reasoningDetails } : {}),
        },
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

  it("returns verbatim + truncated:false when choices is absent", () => {
    const input = JSON.stringify({ model: "gpt-4" });
    const result = truncateReasoning(input, 100);
    expect(result.text).toBe(input);
    expect(result.truncated).toBe(false);
  });

  it("returns verbatim + truncated:false when choices is not an array", () => {
    const input = JSON.stringify({ choices: "wrong" });
    const result = truncateReasoning(input, 100);
    expect(result.text).toBe(input);
    expect(result.truncated).toBe(false);
  });

  it("does not truncate reasoning that is within max", () => {
    const reasoning = "a".repeat(10);
    const input = makeResponse(reasoning);
    const result = truncateReasoning(input, 100);
    expect(result.text).toBe(input);
    expect(result.truncated).toBe(false);
  });

  it("does not truncate reasoning that equals max exactly", () => {
    const reasoning = "a".repeat(100);
    const input = makeResponse(reasoning);
    const result = truncateReasoning(input, 100);
    expect(result.text).toBe(input);
    expect(result.truncated).toBe(false);
  });

  it("truncates reasoning longer than max with correct head+tail", () => {
    const max = 20; // half = floor((20-3)/2) = 8
    const reasoning = "A".repeat(100);
    const result = truncateReasoning(makeResponse(reasoning), max);

    expect(result.truncated).toBe(true);

    const parsed = JSON.parse(result.text);
    const got: string = parsed.choices[0].message.reasoning;
    const half = Math.floor((max - 3) / 2);
    expect(got).toBe("A".repeat(half) + "..." + "A".repeat(half));
    expect(got.length).toBe(half * 2 + 3);
  });

  it("truncates reasoning_details[].text when over max", () => {
    const max = 10; // half = 3
    const input = makeResponse(null, [
      { text: "X".repeat(50), summary: "short" },
    ]);
    const result = truncateReasoning(input, max);

    expect(result.truncated).toBe(true);
    const parsed = JSON.parse(result.text);
    const detail = parsed.choices[0].message.reasoning_details[0];
    const half = Math.floor((max - 3) / 2);
    expect(detail.text).toBe("X".repeat(half) + "..." + "X".repeat(half));
    expect(detail.summary).toBe("short"); // untouched
  });

  it("truncates reasoning_details[].summary when over max", () => {
    const max = 10;
    const input = makeResponse(null, [{ text: "hi", summary: "Y".repeat(50) }]);
    const result = truncateReasoning(input, max);

    expect(result.truncated).toBe(true);
    const parsed = JSON.parse(result.text);
    const detail = parsed.choices[0].message.reasoning_details[0];
    const half = Math.floor((max - 3) / 2);
    expect(detail.summary).toBe("Y".repeat(half) + "..." + "Y".repeat(half));
    expect(detail.text).toBe("hi"); // untouched
  });

  it("does not re-serialise the body when nothing was truncated", () => {
    const input = makeResponse("short");
    const result = truncateReasoning(input, DEFAULT_THINKING_TRUNCATE);
    // Identity — same reference is not guaranteed but text must be bitwise equal
    expect(result.text).toBe(input);
    expect(result.truncated).toBe(false);
  });

  it("sets truncated:true only when at least one field was over max", () => {
    const max = 20;
    // reasoning is short but reasoning_details.text is long
    const input = makeResponse("short", [{ text: "Z".repeat(100) }]);
    const result = truncateReasoning(input, max);
    expect(result.truncated).toBe(true);
  });
});
