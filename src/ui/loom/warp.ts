/**
 * The warp: vertical threads drawn on the single Canvas 2D of the fell zone. Geometry is
 * computed by a pure function (testable without a canvas); painting is a thin wrapper.
 */

export interface WarpBand {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface WarpGeometry {
  readonly width: number;
  readonly height: number;
  /** Distance between threads in CSS px. */
  readonly step: number;
  /** True in listening: the threads split into the lozenge-shaped shed. */
  readonly open: boolean;
  /** Vibration amplitude in px (0..4), from the microphone level. */
  readonly amplitude: number;
  /** Vibration phase in radians. */
  readonly phase: number;
  /** Rectangle occupied by text: threads are never drawn through it. */
  readonly textBand: WarpBand | null;
}

export interface WarpSegment {
  readonly x: number;
  readonly y0: number;
  readonly y1: number;
}

/** Vertical shift of even/odd threads at the fell line when the shed is open. */
export const SHED_LIFT = 14;
/** Full height of the gap at the centre of the lozenge. */
const SHED_GAP = 24;
/** Minimum gap so even the lozenge tips read as a break. */
const SHED_GAP_MIN = 2;

/** 0 at the edges, 1 at the centre: the lozenge profile along x. */
function lozenge(x: number, width: number): number {
  if (width <= 0) return 0;
  return Math.max(0, 1 - Math.abs((2 * x) / width - 1));
}

function cutByBand(segment: WarpSegment, band: WarpBand | null): WarpSegment[] {
  if (!band || segment.x < band.left || segment.x > band.right) return [segment];
  const out: WarpSegment[] = [];
  if (segment.y0 < band.top) out.push({ x: segment.x, y0: segment.y0, y1: Math.min(segment.y1, band.top) });
  if (segment.y1 > band.bottom)
    out.push({ x: segment.x, y0: Math.max(segment.y0, band.bottom), y1: segment.y1 });
  return out.filter((s) => s.y1 - s.y0 > 0.5);
}

/** Threads of the warp as straight vertical segments, already split by shed and text band. */
export function computeWarp(g: WarpGeometry): WarpSegment[] {
  const segments: WarpSegment[] = [];
  if (g.width <= 0 || g.height <= 0 || g.step <= 0) return segments;
  const fell = g.height / 2;
  let index = 0;
  for (let x = g.step / 2; x < g.width; x += g.step, index += 1) {
    const whole: WarpSegment = { x, y0: 0, y1: g.height };
    if (!g.open) {
      segments.push(...cutByBand(whole, g.textBand));
      continue;
    }
    const profile = lozenge(x, g.width);
    const direction = index % 2 === 0 ? -1 : 1;
    const vibration = g.amplitude * Math.sin(g.phase + index * 0.7);
    const centre = fell + direction * (SHED_LIFT * profile + vibration);
    const half = (SHED_GAP_MIN + SHED_GAP * profile) / 2;
    const upper: WarpSegment = { x, y0: 0, y1: Math.max(0, centre - half) };
    const lower: WarpSegment = { x, y0: Math.min(g.height, centre + half), y1: g.height };
    segments.push(...cutByBand(upper, g.textBand), ...cutByBand(lower, g.textBand));
  }
  return segments;
}

/** Paint the segments on a 2D context. `scale` is the device pixel ratio already applied. */
export function paintWarp(
  ctx: CanvasRenderingContext2D,
  segments: readonly WarpSegment[],
  color: string,
  opacity: number,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  if (segments.length === 0) return;
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const s of segments) {
    const x = Math.round(s.x) + 0.5;
    ctx.moveTo(x, s.y0);
    ctx.lineTo(x, s.y1);
  }
  ctx.stroke();
  ctx.restore();
}
