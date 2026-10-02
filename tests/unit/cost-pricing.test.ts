import { describe, expect, it } from "vitest";
import {
  costOfUsage,
  formatUsd,
  mergePriceTable,
  PRICE_TABLE,
  type PriceTable,
  resolveModelPrice,
} from "../../src/core/cost/pricing";
import type { LlmUsage } from "../../src/llm/types";

function usage(partial: Partial<LlmUsage>): LlmUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...partial };
}

describe("costOfUsage", () => {
  it("prices a typical cached Sonnet turn", () => {
    // 600 new input + 300 output + 4500 cache read: (1200 + 3000 + 900) / 1e6
    const result = costOfUsage(
      usage({ inputTokens: 600, outputTokens: 300, cacheReadTokens: 4500 }),
      "claude-sonnet-5-5",
    );
    expect(result.known).toBe(true);
    expect(result.usd).toBeCloseTo(0.0051, 10);
  });

  it("prices Haiku with all four token kinds", () => {
    const result = costOfUsage(
      usage({ inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 1000, cacheWriteTokens: 1000 }),
      "claude-haiku-4-5",
    );
    expect(result.usd).toBeCloseTo((1 + 5 + 0.1 + 1.25) / 1000, 10);
  });

  it("prices Opus cache writes at the 5-minute rate", () => {
    const result = costOfUsage(usage({ cacheWriteTokens: 1_000_000 }), "claude-opus-5-5");
    expect(result).toEqual({ usd: 5, known: true });
  });

  it("returns zero and known=false for an unknown model", () => {
    expect(costOfUsage(usage({ inputTokens: 1_000_000 }), "claude-mystery-9")).toEqual({
      usd: 0,
      known: false,
    });
    expect(costOfUsage(usage({ inputTokens: 1 }), "")).toEqual({ usd: 0, known: false });
  });

  it("matches a dated model id by prefix, but not a different version", () => {
    expect(costOfUsage(usage({ inputTokens: 1_000_000 }), "claude-sonnet-5-5-20261001")).toEqual({
      usd: 2,
      known: true,
    });
    expect(costOfUsage(usage({ inputTokens: 1 }), "claude-sonnet-5-55").known).toBe(false);
    expect(resolveModelPrice("CLAUDE-HAIKU-4-5-latest")).toBe(PRICE_TABLE.perMillion["claude-haiku-4-5"]);
  });

  it("ignores negative or non-finite token counts", () => {
    const result = costOfUsage(
      usage({ inputTokens: -5, outputTokens: Number.NaN, cacheReadTokens: 1_000_000 }),
      "claude-sonnet-5-5",
    );
    expect(result.usd).toBeCloseTo(0.2, 10);
  });
});

describe("formatUsd", () => {
  it.each([
    [0.0048, "$0.0048"],
    [0.00999, "$0.0100"],
    [0.01, "$0.01"],
    [1.2, "$1.20"],
    [15.456, "$15.46"],
    [0, "$0.00"],
    [-1, "$0.00"],
    [Number.NaN, "$0.00"],
  ])("formats %s as %s", (usd, expected) => {
    expect(formatUsd(usd)).toBe(expected);
  });
});

describe("mergePriceTable", () => {
  it("overrides single fields and leaves the base table untouched", () => {
    const merged = mergePriceTable(PRICE_TABLE, { perMillion: { "claude-sonnet-5-5": { output: 12 } } });
    expect(merged.perMillion["claude-sonnet-5-5"]).toEqual({
      input: 2,
      output: 12,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    });
    expect(PRICE_TABLE.perMillion["claude-sonnet-5-5"]?.output).toBe(10);
    expect(merged.version).toBe("2026-10-02 (personalizzato)");
  });

  it("adds a new model only when all four rates are valid", () => {
    const merged = mergePriceTable(PRICE_TABLE, {
      version: "2027-01-01",
      perMillion: {
        "claude-next-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        "claude-half-6": { input: 3, output: 15 },
      },
    });
    expect(merged.version).toBe("2027-01-01");
    expect(costOfUsage(usage({ outputTokens: 1_000_000 }), "claude-next-6", merged)).toEqual({
      usd: 15,
      known: true,
    });
    expect(merged.perMillion["claude-half-6"]).toBeUndefined();
  });

  it("ignores invalid rates coming from user input", () => {
    const override = {
      perMillion: {
        "claude-haiku-4-5": { input: -1, output: Number.NaN, cacheRead: "0.5" as unknown as number },
      },
    };
    const merged = mergePriceTable(PRICE_TABLE, override);
    expect(merged.perMillion["claude-haiku-4-5"]).toEqual(PRICE_TABLE.perMillion["claude-haiku-4-5"]);
  });

  it("keeps the base version when nothing changed", () => {
    const base: PriceTable = { version: "v1", currency: "USD", perMillion: {} };
    expect(mergePriceTable(base, {})).toEqual(base);
  });
});
