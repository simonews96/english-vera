/**
 * Pure helpers for the loom view: labels per state, threshold behaviour, and the small
 * derived quantities (beam thickness, portrait strokes, thread steps). No DOM here.
 */

import type { ListenMode, LoomState } from "../../core/session/types";

/** What a tap on the threshold means in a given state. */
export type ThresholdAction = "tap" | "interrupt" | "press" | "label";

const STATE_LABELS: Record<LoomState, string> = {
  setup: "IMPOSTAZIONI",
  idle: "PRONTA",
  listening: "ASCOLTO",
  thinking: "VERA PENSA",
  speaking: "VERA PARLA",
  correcting: "RIPETI",
  repeating: "RIPETI",
  error: "ERRORE",
};

/** The big uppercase label carried by the reed. Offline overrides the resting states only. */
export function stateLabel(state: LoomState, offline: boolean): string {
  if (offline && (state === "idle" || state === "error")) return "SENZA RETE";
  return STATE_LABELS[state];
}

/** Label of the single big control, per state and listening mode. */
export function thresholdLabel(state: LoomState, mode: ListenMode | null): string {
  switch (state) {
    case "setup":
      return "Apri le impostazioni";
    case "idle":
      return mode === "push" ? "Tieni premuto e parla" : "Tocca per iniziare";
    case "listening":
      return mode === "push" ? "Ti ascolto · lascia per inviare" : "Ti ascolto · tocca per fermare";
    case "repeating":
      return mode === "push" ? "Ora dilla tu · tieni premuto" : "Ora dilla tu · tocca per fermare";
    case "thinking":
      return "Vera pensa…";
    case "speaking":
    case "correcting":
      return "Tocca per interrompere";
    case "error":
      return "Riprova";
  }
}

/** Which callback a tap (or press) on the threshold should reach. */
export function thresholdAction(state: LoomState, mode: ListenMode | null): ThresholdAction {
  switch (state) {
    case "setup":
      return "label";
    case "thinking":
    case "speaking":
    case "correcting":
      return "interrupt";
    case "idle":
    case "listening":
    case "repeating":
      return mode === "push" ? "press" : "tap";
    case "error":
      return "tap";
  }
}

/** The threshold looks disabled while Vera thinks (a tap still reaches onInterrupt). */
export function thresholdLooksDisabled(state: LoomState): boolean {
  return state === "thinking";
}

/** Number of thin lines in the beam: grows with the cloth on a log scale, capped. */
export function beamLineCount(rows: number): number {
  if (rows <= 0) return 1;
  return Math.min(12, 1 + Math.floor(Math.log2(rows + 1)));
}

export interface PortraitStroke {
  /** Width as a fraction of the miniature, 0.1..1. */
  readonly width: number;
  /** Darkness as opacity, 0.35..1, from the row weight. */
  readonly darkness: number;
}

const PORTRAIT_MAX_STROKES = 32;
const PORTRAIT_FULL_LENGTH = 48;

/** Latest rows as horizontal strokes: length = text length, darkness = weight. */
export function portraitStrokes(
  rows: ReadonlyArray<{ readonly textEn: string; readonly weight: 300 | 500 | 700 }>,
): PortraitStroke[] {
  const slice = rows.slice(-PORTRAIT_MAX_STROKES);
  return slice.map((row) => ({
    width: Math.min(1, Math.max(0.1, row.textEn.length / PORTRAIT_FULL_LENGTH)),
    darkness: row.weight === 700 ? 1 : row.weight === 500 ? 0.65 : 0.35,
  }));
}

/** Reduced-motion substitute for the vibrating warp: thread thickness in 1/2/3 px steps. */
export function threadStep(level: number): 1 | 2 | 3 {
  if (level >= 0.6) return 3;
  if (level >= 0.2) return 2;
  return 1;
}

/** Clamp a number into [0, 1]; NaN becomes 0. */
export function unit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Split a sentence into words for span wrapping; whitespace runs are collapsed. */
export function splitWords(text: string): string[] {
  return text.split(/\s+/).filter((word) => word.length > 0);
}
