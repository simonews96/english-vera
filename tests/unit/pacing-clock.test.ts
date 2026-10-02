import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALIBRATION_STORAGE_KEY,
  countSyllables,
  createCalibrationStore,
  createPacer,
  estimateWordTimings,
  wordIndexAt,
} from "../../src/core/pacing/clock";
import { fakeStorage } from "../helpers/cost-storage-fake";

describe("countSyllables", () => {
  it.each([
    ["hello", 2],
    ["I", 1],
    ["make", 1],
    ["table", 2],
    ["the", 1],
    ["bee", 1],
    ["walked", 1],
    ["played", 1],
    ["wanted", 2],
    ["likes", 1],
    ["boxes", 2],
    ["watches", 2],
    ["beautiful", 3],
    ["don't", 1],
    ["2026", 4],
    ["", 1],
  ])("EN '%s' -> %i", (word, expected) => {
    expect(countSyllables(word, "EN")).toBe(expected);
  });

  it.each([
    ["ciao", 1],
    ["buongiorno", 3],
    ["perché", 2],
    ["città", 2],
    ["grazie", 2],
  ])("IT '%s' -> %i", (word, expected) => {
    expect(countSyllables(word, "IT")).toBe(expected);
  });
});

describe("estimateWordTimings", () => {
  it("adds per-word durations and punctuation pauses", () => {
    const { words, totalMs } = estimateWordTimings("Hello, world.", "EN");
    expect(words).toEqual([
      { word: "Hello", charIndex: 0, startMs: 0, endMs: 230 },
      { word: "world", charIndex: 7, startMs: 410, endMs: 570 },
    ]);
    expect(totalMs).toBe(890);
  });

  it("uses the Italian constants and clause pauses", () => {
    const { words, totalMs } = estimateWordTimings("Ciao; bene", "IT");
    expect(words[0]).toEqual({ word: "Ciao", charIndex: 0, startMs: 0, endMs: 140 });
    expect(words[1]?.startMs).toBe(140 + 250);
    expect(totalMs).toBe(140 + 250 + 80 + 120);
  });

  it("scales by rate and calibration, and sanitizes bad values", () => {
    expect(estimateWordTimings("Hello, world.", "EN", 2).totalMs).toBe(445);
    expect(estimateWordTimings("Hello, world.", "EN", 1, 1.5).totalMs).toBe(1335);
    expect(estimateWordTimings("Hello, world.", "EN", 0, Number.NaN).totalMs).toBe(890);
  });

  it("keeps apostrophes inside words and handles empty text", () => {
    expect(estimateWordTimings("don't go", "EN").words.map((w) => w.word)).toEqual(["don't", "go"]);
    expect(estimateWordTimings("   ", "EN")).toEqual({ words: [], totalMs: 0 });
  });

  it("finds the word at a character index", () => {
    const { words } = estimateWordTimings("one two three", "EN");
    expect(wordIndexAt(words, 0)).toBe(0);
    expect(wordIndexAt(words, 5)).toBe(1);
    expect(wordIndexAt(words, 3)).toBe(1); // the space before "two" snaps forward
    expect(wordIndexAt(words, 12)).toBe(2);
    expect(wordIndexAt(words, 99)).toBe(-1);
  });
});

describe("pacer", () => {
  // "one two three four": four one-syllable words at 0, 160, 320, 480 ms; charIndex 0, 4, 8, 14.
  const TEXT = "one two three four";

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function run(text = TEXT): { seen: number[]; pacer: ReturnType<typeof createPacer> } {
    const seen: number[] = [];
    const pacer = createPacer();
    pacer.start(text, "EN", 1, 1, (i) => seen.push(i));
    return { seen, pacer };
  }

  it("fires word 0 synchronously and the rest on the estimated clock", () => {
    const { seen } = run("Hello, world.");
    expect(seen).toEqual([0]);
    vi.advanceTimersByTime(409);
    expect(seen).toEqual([0]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([0, 1]);
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([0, 1]);
  });

  it("snaps forward on an early boundary and reschedules the rest from there", () => {
    const { seen, pacer } = run();
    vi.advanceTimersByTime(50);
    pacer.boundary(8); // "three"
    expect(seen).toEqual([0, 1, 2]);
    vi.advanceTimersByTime(159); // word 3 is now due 160 ms after the snap
    expect(seen).toEqual([0, 1, 2]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it("delays the clock on a late boundary without re-firing", () => {
    const { seen, pacer } = run();
    vi.advanceTimersByTime(200);
    expect(seen).toEqual([0, 1]);
    pacer.boundary(4); // "two" is really starting only now, 40 ms late
    expect(seen).toEqual([0, 1]);
    vi.advanceTimersByTime(159); // t = 359: "three" moved from 320 to 360
    expect(seen).toEqual([0, 1]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([0, 1, 2]);
    vi.advanceTimersByTime(160);
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it("completes the remaining words within 120 ms when the engine ends early", () => {
    const { seen, pacer } = run();
    vi.advanceTimersByTime(50);
    pacer.end(); // three words left: 40 ms apart
    vi.advanceTimersByTime(39);
    expect(seen).toEqual([0]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([0, 1]);
    vi.advanceTimersByTime(79);
    expect(seen).toEqual([0, 1, 2]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([0, 1, 2, 3]);
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it("ends quietly when every word was already shown", () => {
    const { seen, pacer } = run("one");
    pacer.end();
    pacer.boundary(0);
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([0]);
  });

  it("cancel stops everything and ignores later boundaries", () => {
    const { seen, pacer } = run();
    pacer.cancel();
    pacer.boundary(14);
    pacer.end();
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([0]);
  });

  it("ignores a boundary outside the text", () => {
    const { seen, pacer } = run();
    pacer.boundary(999);
    expect(seen).toEqual([0]);
  });

  it("a new start replaces the previous run", () => {
    const pacer = createPacer();
    const first: number[] = [];
    const second: number[] = [];
    pacer.start(TEXT, "EN", 1, 1, (i) => first.push(i));
    pacer.start("Hello, world.", "EN", 1, 1, (i) => second.push(i));
    vi.advanceTimersByTime(2000);
    expect(first).toEqual([0]);
    expect(second).toEqual([0, 1]);
  });

  it("uses injected timers instead of the globals", () => {
    const queue: Array<{ at: number; fn: () => void; id: number }> = [];
    let t = 0;
    let nextId = 0;
    const pacer = createPacer({
      setTimeout: (fn, ms) => {
        nextId += 1;
        queue.push({ at: t + ms, fn, id: nextId });
        return nextId;
      },
      clearTimeout: (handle) => {
        const i = queue.findIndex((q) => q.id === handle);
        if (i >= 0) queue.splice(i, 1);
      },
      now: () => t,
    });
    const advance = (ms: number): void => {
      const target = t + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at);
        const next = queue[0];
        if (!next || next.at > target) break;
        queue.shift();
        t = next.at;
        next.fn();
      }
      t = target;
    };
    const seen: number[] = [];
    pacer.start(TEXT, "EN", 1, 1, (i) => seen.push(i));
    advance(320);
    expect(seen).toEqual([0, 1, 2]);
    vi.advanceTimersByTime(10_000); // the globals must not be involved
    expect(seen).toEqual([0, 1, 2]);
    advance(160);
    expect(seen).toEqual([0, 1, 2, 3]);
  });
});

describe("calibration store", () => {
  it("starts at 1 and moves with an EMA of alpha 0.3", () => {
    const store = createCalibrationStore(fakeStorage());
    expect(store.get("v")).toBe(1);
    expect(store.observations("v")).toBe(0);
    expect(store.observe("v", 1000, 1200)).toBeCloseTo(1.06, 10);
    expect(store.observe("v", 1000, 1200)).toBeCloseTo(1.102, 10);
    expect(store.get("v")).toBeCloseTo(1.102, 10);
    expect(store.observations("v")).toBe(2);
  });

  it("clamps samples and the factor to 0.5..2", () => {
    const store = createCalibrationStore(fakeStorage());
    expect(store.observe("slow", 1000, 50_000)).toBeCloseTo(1.3, 10);
    for (let i = 0; i < 100; i += 1) store.observe("slow", 1000, 50_000);
    expect(store.get("slow")).toBeLessThanOrEqual(2);
    expect(store.get("slow")).toBeGreaterThan(1.99);
    expect(store.observe("fast", 1000, 10)).toBeCloseTo(0.85, 10);
  });

  it("ignores invalid observations", () => {
    const store = createCalibrationStore(fakeStorage());
    store.observe("v", 1000, 1500);
    const before = store.get("v");
    expect(store.observe("v", 0, 1500)).toBe(before);
    expect(store.observe("v", 1000, Number.NaN)).toBe(before);
    expect(store.observe("v", 1000, -3)).toBe(before);
    expect(store.observations("v")).toBe(1);
  });

  it("persists under vera.pacing.v1 and survives corrupt storage", () => {
    const storage = fakeStorage();
    createCalibrationStore(storage).observe("Google UK English", 1000, 800);
    expect(storage.getItem(CALIBRATION_STORAGE_KEY)).toContain("Google UK English");
    const reloaded = createCalibrationStore(storage);
    expect(reloaded.get("Google UK English")).toBeCloseTo(0.94, 10);
    expect(reloaded.observations("Google UK English")).toBe(1);
    const corrupt = createCalibrationStore(fakeStorage({ [CALIBRATION_STORAGE_KEY]: "[broken" }));
    expect(corrupt.get("x")).toBe(1);
    const outOfRange = createCalibrationStore(
      fakeStorage({
        [CALIBRATION_STORAGE_KEY]: JSON.stringify({ v: 1, voices: { x: { factor: 9, count: 3 } } }),
      }),
    );
    expect(outOfRange.get("x")).toBe(2);
    expect(createCalibrationStore(null).observe("x", 100, 100)).toBe(1);
  });
});
