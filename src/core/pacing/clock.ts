/**
 * Estimated clock for the "while speaking" animation (docs/PIANO.md §1.7).
 * Primary driver is `onboundary`; this module is the fallback that is always armed:
 * - word durations from a syllable heuristic plus punctuation pauses;
 * - a pacer that fires `onWord` on schedule, snaps to real boundaries and finishes
 *   the remaining words within 120 ms when `onend` arrives early;
 * - a per-voice calibration factor (EMA) persisted in localStorage.
 */

export type PacingLang = "EN" | "IT";

export interface WordTiming {
  readonly word: string;
  /** Index of the first character of the word in the original text. */
  readonly charIndex: number;
  readonly startMs: number;
  readonly endMs: number;
}

export interface WordTimings {
  readonly words: readonly WordTiming[];
  readonly totalMs: number;
}

const EN_VOWELS = /[aeiouy]+/g;
const IT_VOWELS = /[aeiouàáèéìíòóùú]+/g;
const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

const BASE_MS: Record<PacingLang, number> = { EN: 90, IT: 80 };
const PER_SYLLABLE_MS: Record<PacingLang, number> = { EN: 70, IT: 60 };
const PAUSE_SENTENCE_MS = 320;
const PAUSE_CLAUSE_MS = 250;
const PAUSE_COMMA_MS = 180;
/** Budget for completing leftover words when the engine ends earlier than estimated. */
const END_COMPLETION_MS = 120;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Vowel-group count with English silent-e rules; digits count one syllable each; never below 1. */
export function countSyllables(word: string, lang: PacingLang): number {
  const letters = word.toLowerCase().replace(/[^\p{L}]/gu, "");
  if (letters === "") {
    const digits = word.replace(/\D/g, "").length;
    return Math.max(1, digits);
  }
  const groups = letters.match(lang === "EN" ? EN_VOWELS : IT_VOWELS)?.length ?? 0;
  let count = groups;
  if (lang === "EN" && letters.length > 2) {
    // Silent final e ("make", "name"), but not in "-le" after a consonant ("table") nor "-ee"/"-ye".
    if (/[^aeiouyl]e$/.test(letters)) count -= 1;
    // "-ed" is silent except after t/d ("walked" 1, "played" 1, "wanted" 2).
    if (/[^aeioutd]ed$/.test(letters)) count -= 1;
    // "-es" is silent except after sibilants ("likes" 1, "boxes" 2).
    if (/[^aeiouysxz]es$/.test(letters) && !/(ch|sh)es$/.test(letters)) count -= 1;
  }
  return Math.max(1, count);
}

function pauseAfter(gap: string): number {
  if (/[.!?…]/.test(gap)) return PAUSE_SENTENCE_MS;
  if (/[:;]/.test(gap)) return PAUSE_CLAUSE_MS;
  if (/[,—–]/.test(gap)) return PAUSE_COMMA_MS;
  return 0;
}

function sanitizeRate(rate: number): number {
  return Number.isFinite(rate) && rate > 0 ? clamp(rate, 0.1, 10) : 1;
}

function sanitizeCalibration(calibration: number): number {
  return Number.isFinite(calibration) && calibration > 0 ? clamp(calibration, 0.25, 4) : 1;
}

/**
 * Per-word duration = (base + perSyllable × syllables) / rate × calibration; punctuation
 * after a word adds a pause (comma 180, colon/semicolon 250, sentence end 320 ms), scaled by
 * the same factor. `totalMs` includes the pause after the last word, if any.
 */
export function estimateWordTimings(text: string, lang: PacingLang, rate = 1, calibration = 1): WordTimings {
  const scale = sanitizeCalibration(calibration) / sanitizeRate(rate);
  const words: WordTiming[] = [];
  let cursor = 0;
  let lastEnd = 0;
  for (const match of text.matchAll(WORD_PATTERN)) {
    const word = match[0];
    const charIndex = match.index;
    const gapBefore = text.slice(lastEnd, charIndex);
    cursor += pauseAfter(gapBefore) * scale;
    const duration = (BASE_MS[lang] + PER_SYLLABLE_MS[lang] * countSyllables(word, lang)) * scale;
    const startMs = Math.round(cursor);
    cursor += duration;
    const endMs = Math.round(cursor);
    words.push({ word, charIndex, startMs, endMs });
    lastEnd = charIndex + word.length;
  }
  cursor += pauseAfter(text.slice(lastEnd)) * scale;
  return { words, totalMs: Math.round(cursor) };
}

export interface PacerTimers {
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly now?: () => number;
}

export interface Pacer {
  /** Starts the clock; word 0 fires synchronously, the others on schedule. Replaces any run in progress. */
  start(
    text: string,
    lang: PacingLang,
    rate: number,
    calibration: number,
    onWord: (index: number) => void,
  ): void;
  /** A real boundary at `charIndex`: fire up to the word containing it and re-align the rest. */
  boundary(charIndex: number): void;
  /** The engine ended: remaining words complete within 120 ms, then the pacer stops. */
  end(): void;
  /** Stops without firing anything else. */
  cancel(): void;
}

/** Index of the word that contains `charIndex`, else the first word starting after it, else -1. */
export function wordIndexAt(words: readonly WordTiming[], charIndex: number): number {
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w && charIndex < w.charIndex + w.word.length) return i;
  }
  return -1;
}

export function createPacer(options: PacerTimers = {}): Pacer {
  const setTimer =
    options.setTimeout ?? ((callback: () => void, ms: number) => globalThis.setTimeout(callback, ms));
  const clearTimer = options.clearTimeout ?? ((handle: unknown) => globalThis.clearTimeout(handle as number));
  const now = options.now ?? (() => Date.now());

  let words: readonly WordTiming[] = [];
  let onWord: (index: number) => void = () => {};
  let next = 0;
  /** Clock origin: `now()` at which word 0 is at `startMs` 0, shifted by boundary snaps. */
  let origin = 0;
  let handle: unknown = null;
  let active = false;
  /** Increments on every start/cancel so stale timer callbacks are ignored. */
  let generation = 0;

  const clearPending = (): void => {
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
    }
  };

  const fireThrough = (lastIndex: number): void => {
    while (next <= lastIndex && next < words.length) {
      const index = next;
      next += 1;
      onWord(index);
    }
  };

  const stop = (): void => {
    clearPending();
    active = false;
  };

  const scheduleNext = (): void => {
    clearPending();
    if (!active) return;
    const word = words[next];
    if (!word) {
      // Every word has been shown; stay "active" until end()/cancel() so late boundaries are harmless.
      return;
    }
    const delay = Math.max(0, origin + word.startMs - now());
    const myGeneration = generation;
    handle = setTimer(() => {
      handle = null;
      if (!active || myGeneration !== generation) return;
      const elapsed = now() - origin;
      let last = next;
      for (let i = next; i < words.length; i += 1) {
        const w = words[i];
        if (w && w.startMs <= elapsed) last = i;
      }
      fireThrough(last);
      scheduleNext();
    }, delay);
  };

  return {
    start(text, lang, rate, calibration, callback) {
      stop();
      generation += 1;
      words = estimateWordTimings(text, lang, rate, calibration).words;
      onWord = callback;
      next = 0;
      origin = now();
      active = true;
      if (words.length === 0) {
        active = false;
        return;
      }
      fireThrough(0);
      scheduleNext();
    },
    boundary(charIndex) {
      if (!active) return;
      const index = wordIndexAt(words, charIndex);
      const word = words[index];
      if (!word) return;
      // Re-align so this word's startMs is "now" (whether it was early or late).
      origin = now() - word.startMs;
      fireThrough(index);
      scheduleNext();
    },
    end() {
      if (!active) return;
      clearPending();
      const remaining = words.length - next;
      if (remaining <= 0) {
        stop();
        return;
      }
      generation += 1;
      const myGeneration = generation;
      // Word (first + k) is due at (k + 1) × step, so the last one lands exactly at 120 ms.
      const step = END_COMPLETION_MS / remaining;
      const startedAt = now();
      const first = next;
      const tick = (): void => {
        handle = null;
        if (!active || myGeneration !== generation) return;
        const elapsed = now() - startedAt;
        const due = first + Math.floor(elapsed / step + 1e-6) - 1;
        fireThrough(Math.max(due, next));
        if (next >= words.length) {
          stop();
          return;
        }
        const nextAt = startedAt + (next - first + 1) * step;
        handle = setTimer(tick, Math.max(0, nextAt - now()));
      };
      handle = setTimer(tick, step);
    },
    cancel() {
      generation += 1;
      stop();
    },
  };
}

export interface CalibrationStore {
  /** Calibration factor for a voice, 1 when never observed. */
  get(voiceId: string): number;
  /** Feeds one utterance (estimated vs. measured duration). EMA α = 0.3, clamped to 0.5..2. Returns the new factor. */
  observe(voiceId: string, estimatedMs: number, actualMs: number): number;
  /** How many utterances have been observed for this voice (first two use a coarser entrance). */
  observations(voiceId: string): number;
}

export const CALIBRATION_STORAGE_KEY = "vera.pacing.v1";
const CALIBRATION_ALPHA = 0.3;
const CALIBRATION_MIN = 0.5;
const CALIBRATION_MAX = 2;

interface CalibrationEntry {
  readonly factor: number;
  readonly count: number;
}

function readCalibration(storage: Storage | null): Map<string, CalibrationEntry> {
  const result = new Map<string, CalibrationEntry>();
  if (!storage) return result;
  try {
    const raw = storage.getItem(CALIBRATION_STORAGE_KEY);
    if (!raw) return result;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return result;
    const voices = (parsed as { voices?: unknown }).voices;
    if (typeof voices !== "object" || voices === null) return result;
    for (const [id, entry] of Object.entries(voices as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) continue;
      const { factor, count } = entry as { factor?: unknown; count?: unknown };
      if (typeof factor !== "number" || !Number.isFinite(factor)) continue;
      const safeCount =
        typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
      result.set(id, { factor: clamp(factor, CALIBRATION_MIN, CALIBRATION_MAX), count: safeCount });
    }
  } catch {
    // Corrupt or unavailable storage: start uncalibrated.
  }
  return result;
}

function writeCalibration(storage: Storage | null, entries: Map<string, CalibrationEntry>): void {
  if (!storage) return;
  try {
    storage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify({ v: 1, voices: Object.fromEntries(entries) }));
  } catch {
    // Quota or private mode: calibration lives in memory for this page load.
  }
}

export function createCalibrationStore(
  storage: Storage | null = globalThis.localStorage ?? null,
): CalibrationStore {
  const entries = readCalibration(storage);
  return {
    get: (voiceId) => entries.get(voiceId)?.factor ?? 1,
    observations: (voiceId) => entries.get(voiceId)?.count ?? 0,
    observe(voiceId, estimatedMs, actualMs) {
      const current = entries.get(voiceId);
      const valid =
        Number.isFinite(estimatedMs) && estimatedMs > 0 && Number.isFinite(actualMs) && actualMs > 0;
      if (!valid) return current?.factor ?? 1;
      const sample = clamp(actualMs / estimatedMs, CALIBRATION_MIN, CALIBRATION_MAX);
      const previous = current?.factor ?? 1;
      const factor = clamp(
        previous + CALIBRATION_ALPHA * (sample - previous),
        CALIBRATION_MIN,
        CALIBRATION_MAX,
      );
      entries.set(voiceId, { factor, count: (current?.count ?? 0) + 1 });
      writeCalibration(storage, entries);
      return factor;
    },
  };
}
