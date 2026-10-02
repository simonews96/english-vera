import { describe, expect, it } from "vitest";
import type { LoomState } from "../../src/core/session/types";
import {
  beamLineCount,
  portraitStrokes,
  splitWords,
  stateLabel,
  threadStep,
  thresholdAction,
  thresholdLabel,
  unit,
} from "../../src/ui/loom/labels";

const STATES: LoomState[] = [
  "setup",
  "idle",
  "listening",
  "thinking",
  "speaking",
  "correcting",
  "repeating",
  "error",
];

describe("stateLabel", () => {
  it("names every state in uppercase Italian", () => {
    for (const state of STATES) {
      const label = stateLabel(state, false);
      expect(label).toBe(label.toUpperCase());
      expect(label.length).toBeGreaterThan(0);
    }
    expect(stateLabel("listening", false)).toBe("ASCOLTO");
    expect(stateLabel("thinking", false)).toBe("VERA PENSA");
    expect(stateLabel("speaking", false)).toBe("VERA PARLA");
    expect(stateLabel("repeating", false)).toBe("RIPETI");
    expect(stateLabel("error", false)).toBe("ERRORE");
    expect(stateLabel("setup", false)).toBe("SERVE LA CHIAVE");
  });

  it("names the cause of an error: microphone, thread to the model, or generic", () => {
    expect(stateLabel("error", false, "not-allowed")).toBe("MICROFONO CHIUSO");
    expect(stateLabel("error", false, "audio-capture")).toBe("MICROFONO CHIUSO");
    expect(stateLabel("error", false, "timeout")).toBe("FILO SPEZZATO");
    expect(stateLabel("error", false, "invalid-key")).toBe("FILO SPEZZATO");
    expect(stateLabel("error", false, "language-not-supported")).toBe("ERRORE");
    expect(stateLabel("error", true, "timeout")).toBe("SENZA RETE");
    expect(stateLabel("listening", false, "timeout")).toBe("ASCOLTO");
  });

  it("shows SENZA RETE only in resting states when offline", () => {
    expect(stateLabel("idle", true)).toBe("SENZA RETE");
    expect(stateLabel("error", true)).toBe("SENZA RETE");
    expect(stateLabel("listening", true)).toBe("ASCOLTO");
  });
});

describe("thresholdLabel / thresholdAction", () => {
  it("follows state and mode", () => {
    expect(thresholdLabel("idle", "handsfree")).toBe("Tocca per iniziare");
    expect(thresholdLabel("idle", "push")).toBe("Tieni premuto e parla");
    expect(thresholdLabel("listening", "handsfree")).toBe("Ti ascolto · tocca per fermare");
    expect(thresholdLabel("speaking", "handsfree")).toBe("Tocca per interrompere");
    expect(thresholdLabel("thinking", "push")).toBe("Vera pensa…");
    expect(thresholdLabel("error", null)).toBe("Riprova");
  });

  it("routes taps to the right callback", () => {
    expect(thresholdAction("idle", "handsfree")).toBe("tap");
    expect(thresholdAction("idle", "push")).toBe("press");
    expect(thresholdAction("speaking", "push")).toBe("interrupt");
    expect(thresholdAction("thinking", null)).toBe("interrupt");
    expect(thresholdAction("error", "push")).toBe("tap");
    // Setup taps reach the app, which opens the label on the key section.
    expect(thresholdAction("setup", null)).toBe("tap");
  });
});

describe("derived quantities", () => {
  it("beam grows on a log scale and is capped", () => {
    expect(beamLineCount(0)).toBe(1);
    expect(beamLineCount(1)).toBe(2);
    expect(beamLineCount(7)).toBe(4);
    expect(beamLineCount(100_000)).toBe(12);
  });

  it("portrait strokes map length and weight, keeping the latest (first) rows", () => {
    // The cloth is newest-first: row 0 is the latest.
    const rows = Array.from({ length: 60 }, (_, i) => ({
      textEn: "x".repeat(60 - i),
      weight: (i % 3 === 0 ? 700 : i % 3 === 1 ? 500 : 300) as 300 | 500 | 700,
    }));
    const strokes = portraitStrokes(rows);
    expect(strokes).toHaveLength(32);
    const first = strokes[0];
    const last = strokes[strokes.length - 1];
    expect(first?.width).toBe(1);
    expect(last?.width).toBeLessThan(first?.width ?? 0);
    expect(last?.width).toBeCloseTo(29 / 48, 5);
    expect(portraitStrokes([{ textEn: "a", weight: 300 }])[0]).toEqual({ width: 0.1, darkness: 0.35 });
  });

  it("thread steps are 1/2/3 px", () => {
    expect(threadStep(0)).toBe(1);
    expect(threadStep(0.3)).toBe(2);
    expect(threadStep(0.9)).toBe(3);
  });

  it("unit clamps and tolerates NaN", () => {
    expect(unit(-1)).toBe(0);
    expect(unit(2)).toBe(1);
    expect(unit(Number.NaN)).toBe(0);
  });

  it("splitWords collapses whitespace", () => {
    expect(splitWords("  Could I   have the bill? ")).toEqual(["Could", "I", "have", "the", "bill?"]);
    expect(splitWords("")).toEqual([]);
  });
});
