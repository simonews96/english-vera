/**
 * The "più italiano ↔ più inglese" offset. Milestone 1 only persists the number: the app
 * passes it to the learner card and the loom reads it to preview the fading of the warp.
 * Stored outside the settings store (its contract does not carry it yet) under its own key.
 */

export const LANG_OFFSET_KEY = "vera.lang-offset";
export const LANG_OFFSET_MIN = -15;
export const LANG_OFFSET_MAX = 15;

function clampLangOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(LANG_OFFSET_MIN, Math.min(LANG_OFFSET_MAX, Math.round(value)));
}

export function readLangOffset(storage: Storage | null = globalThis.localStorage ?? null): number {
  if (!storage) return 0;
  try {
    const raw = storage.getItem(LANG_OFFSET_KEY);
    return raw === null ? 0 : clampLangOffset(Number(raw));
  } catch {
    return 0;
  }
}

export function writeLangOffset(
  value: number,
  storage: Storage | null = globalThis.localStorage ?? null,
): number {
  const clamped = clampLangOffset(value);
  if (!storage) return clamped;
  try {
    storage.setItem(LANG_OFFSET_KEY, String(clamped));
  } catch {
    // Storage unavailable: the value lives only in the slider for this page load.
  }
  return clamped;
}

/** "+3", "−3" (typographic minus) or "0". */
export function formatLangOffset(value: number): string {
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${Math.abs(value)}`;
  return "0";
}
