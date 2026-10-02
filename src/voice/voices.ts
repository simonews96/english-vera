/**
 * Voice resolution: pure functions that pick a coherent "Vera" voice out of whatever the
 * engine exposes. Platform facts behind the design (docs/ricerca/speech-synthesis.md):
 * - Chrome Android names voices by locale display name ("English United Kingdom",
 *   "Inglese Regno Unito") with underscore langs ("en_GB"): only `lang` is reliable there.
 * - Edge 150 reports every Natural voice as "Microsoft undefined Online (Natural) - undefined":
 *   such voices are recognised from `voiceURI` and `lang` instead of being discarded.
 * - iOS lists only pre-installed voices; on iOS 18+ the list may be dominated by the
 *   Eloquence family, which must still be an acceptable last resort.
 */

import type { VoiceInfo } from "./types";

export type TutorLanguage = "en" | "it";
export type EnglishVariant = "en-GB" | "en-US";
export type PreferenceTag = EnglishVariant | "it-IT";

/** Resolution step: 0 = explicit voice id, 1-3 = cascade, 4 = nothing usable. */
export type ResolutionStep = 0 | 1 | 2 | 3 | 4;

export interface VoiceResolution {
  readonly voice: VoiceInfo | null;
  readonly step: ResolutionStep;
  /** Short English diagnostic, e.g. "step 1: preference 'Serena' (en-GB)". */
  readonly reason: string;
}

/**
 * Normalises an engine language tag: "en_GB" -> "en-GB", "EN-gb" -> "en-GB",
 * "zh-hans-cn" -> "zh-Hans-CN". Unknown shapes are returned lower-cased.
 */
export function normalizeLang(tag: string): string {
  const parts = tag
    .trim()
    .split(/[-_]/)
    .filter((part) => part.length > 0);
  return parts
    .map((part, index) => {
      if (index === 0) return part.toLowerCase();
      if (part.length === 2) return part.toUpperCase();
      if (part.length === 4) return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      return part.toLowerCase();
    })
    .join("-");
}

/** Primary language subtag of a (possibly un-normalised) tag: "en_GB" -> "en". */
export function primaryLanguage(tag: string): string {
  return normalizeLang(tag).split("-")[0] ?? "";
}

/**
 * Ranked name substrings per language, best first. The order encodes voice families:
 * Edge Natural > Apple > Google network > Windows local, so that English and Italian end
 * up in the same family whenever the platform allows it.
 */
export const VOICE_PREFERENCES: Readonly<Record<PreferenceTag, readonly string[]>> = {
  "en-GB": [
    "Microsoft Sonia Online (Natural)",
    "Microsoft Libby Online (Natural)",
    "Serena",
    "Kate",
    "Google UK English Female",
    "Microsoft Hazel",
    "Microsoft Susan",
    "Stephanie",
    "Martha",
  ],
  "en-US": [
    "Microsoft AvaMultilingual",
    "Microsoft EmmaMultilingual",
    "Microsoft Jenny",
    "Microsoft Aria",
    "Ava",
    "Samantha",
    "Karen",
    "Zoe",
    "Allison",
    "Google US English",
    "Microsoft Zira",
  ],
  "it-IT": [
    "Microsoft Elsa Online (Natural)",
    "Microsoft Isabella Online (Natural)",
    "Federica",
    "Emma",
    "Alice",
    "Paola",
    "Google italiano",
    "Microsoft Elsa",
  ],
};

/**
 * Names that never qualify in steps 1-2: child voices, the iOS Eloquence family and the
 * macOS novelty voices. Single words match whole name tokens ("Ana" does not hit "Anna");
 * multi-word entries match as substrings.
 */
export const EXCLUDED_NAME_PARTS: readonly string[] = [
  // Child voices
  "Ana",
  "Maisie",
  "Joelle",
  "Pierina",
  // iOS/macOS Eloquence family
  "Eddy",
  "Flo",
  "Grandma",
  "Grandpa",
  "Reed",
  "Rocko",
  "Sandy",
  "Shelley",
  // macOS novelty voices
  "Albert",
  "Bad News",
  "Bahh",
  "Bells",
  "Boing",
  "Bubbles",
  "Cellos",
  "Deranged",
  "Good News",
  "Hysterical",
  "Jester",
  "Junior",
  "Organ",
  "Princess",
  "Ralph",
  "Superstar",
  "Trinoids",
  "Whisper",
  "Wobble",
  "Zarvox",
];

/** Known male voice names, used only to skip "obviously male" candidates in step 2. */
export const MALE_NAME_PARTS: readonly string[] = [
  "Daniel",
  "Arthur",
  "Luca",
  "Diego",
  "Giuseppe",
  "Oliver",
  "Thomas",
  "Alfie",
  "Rishi",
  "Aaron",
  "Fred",
  "Gordon",
  "Lee",
  "Google UK English Male",
  "Microsoft Mark",
  "Microsoft David",
  "Microsoft George",
  "Microsoft Ryan",
  "Microsoft Guy",
  "Microsoft Christopher",
  "Microsoft Eric",
  "Microsoft Cosimo",
  "Microsoft Diego",
  "Microsoft Giuseppe",
];

/** True when the engine reported a broken name (Edge 150 "Microsoft undefined Online (Natural)"). */
export function hasBrokenName(voice: VoiceInfo): boolean {
  const name = voice.name.trim();
  return name.length === 0 || /\bundefined\b/i.test(name) || name === "null";
}

/** The name to reason about: the reported name, or the id when the name is broken. */
export function effectiveName(voice: VoiceInfo): string {
  return hasBrokenName(voice) ? voice.id : voice.name;
}

/** True for Edge "Online (Natural)" voices, recognised from id or name. */
export function isNaturalVoice(voice: VoiceInfo): boolean {
  return /natural/i.test(voice.id) || /natural/i.test(voice.name);
}

function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** Matches whole tokens for single words and substrings for multi-word parts. */
export function nameHasPart(name: string, part: string): boolean {
  const lowerPart = part.toLowerCase();
  if (lowerPart.includes(" ")) return name.toLowerCase().includes(lowerPart);
  return tokens(name).includes(lowerPart);
}

export function isExcludedVoice(voice: VoiceInfo): boolean {
  const name = effectiveName(voice);
  return EXCLUDED_NAME_PARTS.some((part) => nameHasPart(name, part));
}

export function isMaleVoice(voice: VoiceInfo): boolean {
  const name = effectiveName(voice);
  return MALE_NAME_PARTS.some((part) => nameHasPart(name, part));
}

function fullTagFor(language: TutorLanguage, englishVariant: EnglishVariant): PreferenceTag {
  return language === "en" ? englishVariant : "it-IT";
}

function preferenceOrder(language: TutorLanguage, englishVariant: EnglishVariant): PreferenceTag[] {
  if (language === "it") return ["it-IT"];
  return englishVariant === "en-GB" ? ["en-GB", "en-US"] : ["en-US", "en-GB"];
}

/** Candidates of the language, exact variant first, engine order otherwise. */
function candidatesFor(
  voices: readonly VoiceInfo[],
  language: TutorLanguage,
  fullTag: PreferenceTag,
): VoiceInfo[] {
  const ofLanguage = voices.filter((voice) => primaryLanguage(voice.lang) === language);
  const exact = ofLanguage.filter((voice) => normalizeLang(voice.lang) === fullTag);
  const others = ofLanguage.filter((voice) => normalizeLang(voice.lang) !== fullTag);
  return [...exact, ...others];
}

function describe(voice: VoiceInfo): string {
  return `'${effectiveName(voice)}' (${normalizeLang(voice.lang)})`;
}

/**
 * Picks a voice for the language with a cascade whose last step is mandatory when any
 * voice of the language exists:
 * 0. `preferredId` matches a known voice (the user's saved choice);
 * 1. ranked preference list by name (or id, for broken names) and language, exact variant
 *    first; a Natural voice with a broken name and the right language also qualifies here;
 * 2. first voice of the language that is neither excluded nor obviously male;
 * 3. any voice of the language, Eloquence included;
 * 4. nothing: the caller leaves `utterance.voice` unset and relies on `utterance.lang`.
 */
export function resolveVoice(
  voices: readonly VoiceInfo[],
  language: TutorLanguage,
  englishVariant: EnglishVariant,
  preferredId?: string | null,
): VoiceResolution {
  if (preferredId) {
    const chosen = voices.find((voice) => voice.id === preferredId);
    if (chosen) return { voice: chosen, step: 0, reason: `step 0: saved voice ${describe(chosen)}` };
  }

  const fullTag = fullTagFor(language, englishVariant);
  const candidates = candidatesFor(voices, language, fullTag);
  if (candidates.length === 0) {
    return { voice: null, step: 4, reason: `step 4: no voice for '${language}' among ${voices.length}` };
  }

  // Step 1: preference lists, exact variant first within each name.
  for (const tag of preferenceOrder(language, englishVariant)) {
    for (const part of VOICE_PREFERENCES[tag]) {
      const match = candidates.find(
        (voice) => !isExcludedVoice(voice) && nameHasPart(effectiveName(voice), part),
      );
      if (match) return { voice: match, step: 1, reason: `step 1: preference '${part}' ${describe(match)}` };
    }
  }
  const brokenNatural = candidates.find(
    (voice) =>
      hasBrokenName(voice) && isNaturalVoice(voice) && !isExcludedVoice(voice) && !isMaleVoice(voice),
  );
  if (brokenNatural) {
    return {
      voice: brokenNatural,
      step: 1,
      reason: `step 1: Natural voice with broken name, matched by lang ${describe(brokenNatural)}`,
    };
  }

  // Step 2: first non-excluded, not obviously male voice of the language.
  const plain = candidates.find((voice) => !isExcludedVoice(voice) && !isMaleVoice(voice));
  if (plain) return { voice: plain, step: 2, reason: `step 2: first plausible voice ${describe(plain)}` };

  // Step 3: anything of the language, Eloquence and male voices included.
  const any = candidates[0];
  if (any) return { voice: any, step: 3, reason: `step 3: any voice of the language ${describe(any)}` };

  return { voice: null, step: 4, reason: `step 4: no voice for '${language}'` };
}
