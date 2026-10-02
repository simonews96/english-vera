import { describe, expect, it } from "vitest";
import {
  computeWarp,
  paintWarp,
  SHED_LIFT,
  type WarpGeometry,
  type WarpSegment,
} from "../../src/ui/loom/warp";

const BASE: WarpGeometry = {
  width: 80,
  height: 200,
  step: 8,
  open: false,
  amplitude: 0,
  phase: 0,
  textBand: null,
};

describe("computeWarp", () => {
  it("draws one unbroken thread per step when the shed is closed", () => {
    const segments = computeWarp(BASE);
    expect(segments).toHaveLength(10);
    for (const s of segments) {
      expect(s.y0).toBe(0);
      expect(s.y1).toBe(200);
    }
  });

  it("returns nothing for a degenerate box", () => {
    expect(computeWarp({ ...BASE, width: 0 })).toEqual([]);
    expect(computeWarp({ ...BASE, height: 0 })).toEqual([]);
  });

  it("opens a lozenge-shaped shed: split threads, even up and odd down, widest at the centre", () => {
    const segments = computeWarp({ ...BASE, open: true });
    expect(segments).toHaveLength(20);
    const byX = new Map<number, WarpSegment[]>();
    for (const s of segments) byX.set(s.x, [...(byX.get(s.x) ?? []), s]);
    const centreOf = (x: number): number => {
      const pair = byX.get(x) ?? [];
      const upper = pair[0];
      const lower = pair[1];
      if (!upper || !lower) throw new Error(`no pair at ${x}`);
      return (upper.y1 + lower.y0) / 2;
    };
    const gapAt = (x: number): number => {
      const pair = byX.get(x) ?? [];
      const upper = pair[0];
      const lower = pair[1];
      if (!upper || !lower) throw new Error(`no pair at ${x}`);
      return lower.y0 - upper.y1;
    };
    // x = 36 (index 4, even) and x = 44 (index 5, odd) straddle the centre of an 80px box.
    expect(centreOf(36)).toBeLessThan(100);
    expect(centreOf(44)).toBeGreaterThan(100);
    expect(100 - centreOf(36)).toBeCloseTo(SHED_LIFT * 0.9, 5);
    expect(gapAt(36)).toBeGreaterThan(gapAt(4));
    expect(gapAt(4)).toBeGreaterThan(0);
  });

  it("vibration moves the split with the amplitude", () => {
    const still = computeWarp({ ...BASE, open: true });
    const shaking = computeWarp({ ...BASE, open: true, amplitude: 4, phase: Math.PI / 2 });
    const a = still[0];
    const b = shaking[0];
    if (!a || !b) throw new Error("missing segments");
    expect(Math.abs(a.y1 - b.y1)).toBeCloseTo(4, 5);
  });

  it("never draws through the text band, only beside it", () => {
    const band = { top: 60, bottom: 140, left: 20, right: 60 };
    const segments = computeWarp({ ...BASE, textBand: band });
    for (const s of segments) {
      if (s.x >= band.left && s.x <= band.right) {
        const insideBand = s.y0 < band.bottom && s.y1 > band.top;
        expect(insideBand).toBe(false);
      } else {
        expect(s.y1 - s.y0).toBe(200);
      }
    }
    expect(segments.some((s) => s.x > band.left && s.x < band.right && s.y1 === band.top)).toBe(true);
    expect(segments.some((s) => s.x > band.left && s.x < band.right && s.y0 === band.bottom)).toBe(true);
  });
});

describe("paintWarp", () => {
  it("clears, then strokes every segment once with the warp colour and opacity", () => {
    const calls: string[] = [];
    const ctx = {
      globalAlpha: 1,
      strokeStyle: "",
      lineWidth: 0,
      clearRect: () => calls.push("clear"),
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      beginPath: () => calls.push("begin"),
      moveTo: () => calls.push("move"),
      lineTo: () => calls.push("line"),
      stroke: () => calls.push("stroke"),
    };
    const segments = computeWarp(BASE);
    paintWarp(ctx as unknown as CanvasRenderingContext2D, segments, "#9aa3ad", 0.6, 80, 200);
    expect(calls.filter((c) => c === "move")).toHaveLength(10);
    expect(calls.filter((c) => c === "stroke")).toHaveLength(1);
    expect(calls[0]).toBe("clear");
    expect(ctx.strokeStyle).toBe("#9aa3ad");
    expect(ctx.globalAlpha).toBe(0.6);
  });

  it("only clears when there is nothing to draw", () => {
    const calls: string[] = [];
    const ctx = {
      clearRect: () => calls.push("clear"),
      beginPath: () => calls.push("begin"),
      stroke: () => calls.push("stroke"),
    };
    paintWarp(ctx as unknown as CanvasRenderingContext2D, [], "#000", 1, 10, 10);
    expect(calls).toEqual(["clear"]);
  });
});
