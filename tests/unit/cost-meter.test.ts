import { describe, expect, it } from "vitest";
import { COST_STORAGE_KEY, createCostMeter, dayKeyOf } from "../../src/core/cost/meter";
import type { LlmUsage } from "../../src/llm/types";
import { fakeStorage } from "../helpers/cost-storage-fake";

/** One million output tokens on Sonnet = $10: easy arithmetic. */
const MILLION_OUT: LlmUsage = {
  inputTokens: 0,
  outputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const SONNET = "claude-sonnet-5-5";

function clock(start: Date): { now: () => Date; set: (d: Date) => void } {
  let current = start;
  return {
    now: () => current,
    set: (d) => {
      current = d;
    },
  };
}

describe("dayKeyOf", () => {
  it("uses the local calendar date with zero padding", () => {
    expect(dayKeyOf(new Date(2026, 9, 2, 23, 59))).toBe("2026-10-02");
    expect(dayKeyOf(new Date(2026, 0, 5, 0, 0))).toBe("2026-01-05");
  });
});

describe("cost meter", () => {
  it("accumulates today, session and total, and counts partial/unknown turns", () => {
    const meter = createCostMeter({ storage: fakeStorage(), now: () => new Date(2026, 9, 2, 10) });
    meter.record({ usage: MILLION_OUT, model: SONNET });
    meter.record({ usage: MILLION_OUT, model: SONNET, partial: true });
    const summary = meter.record({ usage: MILLION_OUT, model: "claude-unknown-1" });
    expect(summary).toEqual({
      todayUsd: 20,
      sessionUsd: 20,
      totalUsd: 20,
      todayTurns: 3,
      sessionTurns: 3,
      totalTurns: 3,
      partialTurns: 1,
      unknownModelTurns: 1,
      dayKey: "2026-10-02",
      tableVersion: "2026-10-02",
    });
  });

  it("persists today and total under vera.cost.v1 and reloads them", () => {
    const storage = fakeStorage();
    const now = () => new Date(2026, 9, 2, 10);
    createCostMeter({ storage, now }).record({ usage: MILLION_OUT, model: SONNET });
    expect(storage.getItem(COST_STORAGE_KEY)).toContain('"dayKey":"2026-10-02"');
    const reloaded = createCostMeter({ storage, now }).summary();
    expect(reloaded.todayUsd).toBe(10);
    expect(reloaded.totalUsd).toBe(10);
    expect(reloaded.todayTurns).toBe(1);
    expect(reloaded.sessionUsd).toBe(0);
    expect(reloaded.sessionTurns).toBe(0);
  });

  it("rolls today over at local midnight while keeping the total", () => {
    const storage = fakeStorage();
    const time = clock(new Date(2026, 9, 2, 23, 50));
    const meter = createCostMeter({ storage, now: time.now });
    meter.record({ usage: MILLION_OUT, model: SONNET });
    time.set(new Date(2026, 9, 3, 0, 5));
    expect(meter.summary()).toMatchObject({ todayUsd: 0, todayTurns: 0, totalUsd: 10, dayKey: "2026-10-03" });
    meter.record({ usage: MILLION_OUT, model: SONNET });
    expect(meter.summary()).toMatchObject({ todayUsd: 10, todayTurns: 1, totalUsd: 20, totalTurns: 2 });
    // A fresh meter on a later day drops the stored "today" but not the total.
    const later = createCostMeter({ storage, now: () => new Date(2026, 9, 9, 12) }).summary();
    expect(later).toMatchObject({ todayUsd: 0, totalUsd: 20, dayKey: "2026-10-09" });
  });

  it("startSession resets only the session counters and notifies subscribers", () => {
    const meter = createCostMeter({ storage: fakeStorage(), now: () => new Date(2026, 9, 2, 10) });
    const seen: number[] = [];
    const unsubscribe = meter.subscribe((s) => seen.push(s.sessionTurns));
    meter.record({ usage: MILLION_OUT, model: SONNET });
    meter.startSession();
    expect(seen).toEqual([1, 0]);
    expect(meter.summary()).toMatchObject({ sessionUsd: 0, sessionTurns: 0, todayUsd: 10, totalUsd: 10 });
    unsubscribe();
    meter.record({ usage: MILLION_OUT, model: SONNET });
    expect(seen).toEqual([1, 0]);
  });

  it("survives corrupt or malicious storage values", () => {
    const corrupt = createCostMeter({
      storage: fakeStorage({ [COST_STORAGE_KEY]: "{not json" }),
      now: () => new Date(2026, 9, 2),
    });
    expect(corrupt.summary()).toMatchObject({ todayUsd: 0, totalUsd: 0, totalTurns: 0 });
    const weird = createCostMeter({
      storage: fakeStorage({
        [COST_STORAGE_KEY]: JSON.stringify({
          dayKey: "2026-10-02",
          todayUsd: -3,
          totalUsd: "x",
          totalTurns: 2.7,
        }),
      }),
      now: () => new Date(2026, 9, 2),
    });
    expect(weird.summary()).toMatchObject({ todayUsd: 0, totalUsd: 0, totalTurns: 2 });
  });

  it("keeps counting in memory when storage is missing or write fails", () => {
    const none = createCostMeter({ storage: null, now: () => new Date(2026, 9, 2) });
    expect(none.record({ usage: MILLION_OUT, model: SONNET }).totalUsd).toBe(10);
    const throwing = createCostMeter({
      storage: fakeStorage({}, { throwOnWrite: true }),
      now: () => new Date(2026, 9, 2),
    });
    throwing.record({ usage: MILLION_OUT, model: SONNET });
    expect(throwing.record({ usage: MILLION_OUT, model: SONNET }).totalTurns).toBe(2);
  });

  it("uses a custom price table and reports its version", () => {
    const meter = createCostMeter({
      storage: null,
      now: () => new Date(2026, 9, 2),
      table: {
        version: "test",
        currency: "USD",
        perMillion: { m: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 } },
      },
    });
    const summary = meter.record({ usage: MILLION_OUT, model: "m" });
    expect(summary.totalUsd).toBe(1);
    expect(summary.tableVersion).toBe("test");
  });
});
