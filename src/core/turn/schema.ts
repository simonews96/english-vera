/**
 * The turn protocol: Vera's structured reply. TypeScript types plus the JSON schema sent
 * as `output_config.format` (structured outputs). Rules (docs/PIANO.md §1.3):
 * - `additionalProperties: false` everywhere, no min/max/pattern, no recursion;
 * - `segments` is the first required property so the voice can start on the first closed segment;
 * - enum values are uppercase; the app normalizes case before use;
 * - no field named `reasoning`/`thinking` (refusal risk);
 * - one schema version per milestone (changing it invalidates the prompt cache).
 */

export const TURN_SCHEMA_VERSION = "m1.0";

export type Lang = "IT" | "EN";
export type SegmentKind = "SAY" | "ASK" | "MODEL";
export type ListenExpect = "REPEAT" | "ANSWER" | "FREE";
export type ItemKind = "PHRASE" | "ERROR";
export type Signal = "FAILED" | "HARD" | "PRODUCED" | "SPONTANEOUS" | "NOT_OBSERVED";
export type Topic = "TRAVEL" | "TABLE_AND_STAY" | "CITY_AND_TROUBLE" | "SMALL_TALK";
export type FactTopic = "TRIP" | "COMPANIONS" | "INTERESTS" | "WORRIES" | "OTHER";
export type GoalStatus = "ONGOING" | "DONE";

export interface Segment {
  readonly lang: Lang;
  readonly kind: SegmentKind;
  readonly text: string;
}

export interface Listen {
  readonly lang: Lang;
  readonly expect: ListenExpect;
  readonly target?: string;
  readonly alternatives?: readonly string[];
}

export interface Correction {
  readonly heard: string;
  readonly correct: string;
  readonly note_it: string;
}

export interface ItemSignal {
  readonly kind: ItemKind;
  readonly id: string;
  readonly signal: Signal;
}

export interface Learned {
  readonly text_en: string;
  readonly gloss_it: string;
  readonly topic: Topic;
}

export interface LearnerFact {
  readonly fact: string;
  readonly topic: FactTopic;
}

export interface Goal {
  readonly id: string;
  readonly status: GoalStatus;
}

export interface Closing {
  readonly remember: readonly string[];
}

export interface TurnResponse {
  readonly segments: readonly Segment[];
  readonly listen: Listen;
  readonly correction: Correction | null;
  readonly items: readonly ItemSignal[];
  readonly learned: readonly Learned[];
  readonly about_learner: readonly LearnerFact[];
  readonly goal: Goal | null;
  readonly closing: Closing | null;
}

const LANG = { type: "string", enum: ["IT", "EN"] } as const;

/** JSON schema for `output_config.format`. Keep in sync with the types above. */
export const TURN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["segments", "listen", "correction", "items", "learned", "about_learner", "goal", "closing"],
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["lang", "kind", "text"],
        properties: {
          lang: LANG,
          kind: { type: "string", enum: ["SAY", "ASK", "MODEL"] },
          text: { type: "string" },
        },
      },
    },
    listen: {
      type: "object",
      additionalProperties: false,
      required: ["lang", "expect"],
      properties: {
        lang: LANG,
        expect: { type: "string", enum: ["REPEAT", "ANSWER", "FREE"] },
        target: { type: "string" },
        alternatives: { type: "array", items: { type: "string" } },
      },
    },
    correction: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["heard", "correct", "note_it"],
          properties: {
            heard: { type: "string" },
            correct: { type: "string" },
            note_it: { type: "string" },
          },
        },
        { type: "null" },
      ],
    },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "id", "signal"],
        properties: {
          kind: { type: "string", enum: ["PHRASE", "ERROR"] },
          id: { type: "string" },
          signal: { type: "string", enum: ["FAILED", "HARD", "PRODUCED", "SPONTANEOUS", "NOT_OBSERVED"] },
        },
      },
    },
    learned: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text_en", "gloss_it", "topic"],
        properties: {
          text_en: { type: "string" },
          gloss_it: { type: "string" },
          topic: { type: "string", enum: ["TRAVEL", "TABLE_AND_STAY", "CITY_AND_TROUBLE", "SMALL_TALK"] },
        },
      },
    },
    about_learner: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fact", "topic"],
        properties: {
          fact: { type: "string" },
          topic: { type: "string", enum: ["TRIP", "COMPANIONS", "INTERESTS", "WORRIES", "OTHER"] },
        },
      },
    },
    goal: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["id", "status"],
          properties: {
            id: { type: "string" },
            status: { type: "string", enum: ["ONGOING", "DONE"] },
          },
        },
        { type: "null" },
      ],
    },
    closing: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["remember"],
          properties: { remember: { type: "array", items: { type: "string" } } },
        },
        { type: "null" },
      ],
    },
  },
} as const;

/** Maps the protocol language to a recognizer/synthesizer tag. */
export function langToTag(
  lang: Lang,
  englishVariant: "en-GB" | "en-US" = "en-GB",
): "en-GB" | "en-US" | "it-IT" {
  return lang === "IT" ? "it-IT" : englishVariant;
}
