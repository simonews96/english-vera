/**
 * Tolerant matcher for the help phrases (docs/PIANO.md §1.2): "ripeti", "più lento",
 * "non ho capito", "come si dice X". The recognizer is often set to English while the
 * learner speaks Italian, so the phrases arrive deformed ("non o capito", "piu lento"):
 * every candidate is normalized (lowercase, no accents, no punctuation) and compared with
 * a normalized Levenshtein distance. "Come si dice X" is matched by prefix and carries X.
 */

import type { HelpKind } from "./types";

export interface HelpMatch {
  readonly kind: HelpKind;
  /** For HOW_TO_SAY: the thing the learner wants to say, when it followed the prefix. */
  readonly payload?: string;
}

/** Maximum normalized distance (edits / longer length) for a variant to match. */
export const HELP_MAX_DISTANCE = 0.25;

/** Variants shorter than this must match exactly: one edit on "what" is too loose. */
const MIN_FUZZY_LENGTH = 6;

const REPEAT_VARIANTS = [
  "ripeti",
  "ripete",
  "ripetere",
  "ripetilo",
  "ripeti per favore",
  "puoi ripetere",
  "puoi ripetere per favore",
  "me lo ripeti",
  "ancora",
  "di nuovo",
  "un altra volta",
  "ancora una volta",
  "repeat",
  "repeat it",
  "repeat that",
  "repeat please",
  "can you repeat",
  "can you repeat that",
  "say it again",
  "say that again",
  "again",
  "once more",
  "one more time",
];

const SLOWER_VARIANTS = [
  "piu lento",
  "piu piano",
  "piu lentamente",
  "piu lento per favore",
  "piu piano per favore",
  "ripeti piu lento",
  "ripeti piu piano",
  "ripeti piu lentamente",
  "puoi ripetere piu lento",
  "puoi ripetere piu piano",
  "parla piu piano",
  "parla piu lento",
  "pew lento",
  "pew piano",
  "slower",
  "slow down",
  "slowly",
  "more slowly",
  "speak slower",
  "speak slowly",
  "say it slower",
  "say it slowly",
  "can you slow down",
  "can you speak slower",
  "repeat slower",
  "repeat slowly",
];

const DIDNT_UNDERSTAND_VARIANTS = [
  "non ho capito",
  "non o capito",
  "non capito",
  "none capito",
  "non capisco",
  "non ho capito bene",
  "non ho capito scusa",
  "scusa non ho capito",
  "scusa non capisco",
  "cosa hai detto",
  "cosa",
  "what",
  "i dont understand",
  "i do not understand",
  "i didnt understand",
  "i did not understand",
  "sorry i dont understand",
  "i dont get it",
  "what did you say",
  "sorry what",
];

/** Prefixes of "come si dice X"; the longest matching prefix wins. */
const HOW_TO_SAY_PREFIXES = [
  "come si dice",
  "come se dice",
  "come si dice in inglese",
  "come se dice in inglese",
  "how do you say",
  "how do i say",
  "how to say",
  "how do you say in english",
  "how do i say in english",
];

/** Trailing qualifiers stripped from the HOW_TO_SAY payload. */
const PAYLOAD_SUFFIXES = ["in inglese", "in english"];

const EXACT_VARIANTS: ReadonlyArray<readonly [HelpKind, readonly string[]]> = [
  ["SLOWER", SLOWER_VARIANTS],
  ["DIDNT_UNDERSTAND", DIDNT_UNDERSTAND_VARIANTS],
  ["REPEAT", REPEAT_VARIANTS],
];

/** Lowercase, no diacritics, no punctuation, single spaces. */
export function normalizeHelpText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Plain Levenshtein distance (two-row dynamic programming). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    const charA = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      const cost = charA === b.charCodeAt(j - 1) ? 0 : 1;
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const substitution = (previous[j - 1] ?? 0) + cost;
      current.push(Math.min(deletion, insertion, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** Distance divided by the longer length: 0 = identical, 1 = nothing in common. */
export function normalizedDistance(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  return levenshtein(a, b) / longest;
}

function variantDistance(candidate: string, variant: string): number {
  if (variant.length < MIN_FUZZY_LENGTH) return candidate === variant ? 0 : 1;
  return normalizedDistance(candidate, variant);
}

function stripPayloadSuffix(payload: string): string {
  for (const suffix of PAYLOAD_SUFFIXES) {
    if (payload === suffix) return "";
    if (payload.endsWith(` ${suffix}`)) return payload.slice(0, -suffix.length - 1).trim();
  }
  return payload;
}

function matchHowToSay(normalized: string): HelpMatch | null {
  const words = normalized.split(" ");
  let best: { readonly wordCount: number; readonly distance: number } | null = null;
  for (const prefix of HOW_TO_SAY_PREFIXES) {
    const wordCount = prefix.split(" ").length;
    if (words.length < wordCount) continue;
    const head = words.slice(0, wordCount).join(" ");
    const distance = normalizedDistance(head, prefix);
    if (distance > HELP_MAX_DISTANCE) continue;
    if (
      best === null ||
      wordCount > best.wordCount ||
      (wordCount === best.wordCount && distance < best.distance)
    ) {
      best = { wordCount, distance };
    }
  }
  if (best === null) return null;
  const payload = stripPayloadSuffix(words.slice(best.wordCount).join(" "));
  return payload.length > 0 ? { kind: "HOW_TO_SAY", payload } : { kind: "HOW_TO_SAY" };
}

/**
 * Recognizes a help phrase in Italian or English, tolerating recognizer deformations.
 * Returns null for ordinary sentences, so the caller sends them to the model.
 */
export function matchHelp(text: string): HelpMatch | null {
  const normalized = normalizeHelpText(text);
  if (normalized.length === 0) return null;

  const howToSay = matchHowToSay(normalized);
  if (howToSay !== null) return howToSay;

  let best: { readonly kind: HelpKind; readonly distance: number } | null = null;
  for (const [kind, variants] of EXACT_VARIANTS) {
    for (const variant of variants) {
      const distance = variantDistance(normalized, variant);
      if (distance <= HELP_MAX_DISTANCE && (best === null || distance < best.distance)) {
        best = { kind, distance };
      }
    }
  }
  return best === null ? null : { kind: best.kind };
}
