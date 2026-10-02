/**
 * Validation and normalization of the structured turn reply (docs/PIANO.md §1.3).
 * The API does not guarantee enum case, so every enum is uppercased before checking;
 * unknown values are rejected with a reason, extra fields are dropped, lists are capped.
 * Pure functions, no DOM.
 */

import type {
  Closing,
  Correction,
  FactTopic,
  Goal,
  GoalStatus,
  ItemKind,
  ItemSignal,
  Lang,
  Learned,
  LearnerFact,
  Listen,
  ListenExpect,
  Segment,
  SegmentKind,
  Signal,
  Topic,
  TurnResponse,
} from "./schema";

export type ParseResult = { ok: true; response: TurnResponse } | { ok: false; reason: string };

type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Caps applied silently (the first N entries are kept). */
export const TURN_LIMITS = {
  items: 6,
  learned: 5,
  aboutLearner: 1,
  remember: 3,
  alternatives: 5,
} as const;

const LANGS: readonly Lang[] = ["IT", "EN"];
const SEGMENT_KINDS: readonly SegmentKind[] = ["SAY", "ASK", "MODEL"];
const LISTEN_EXPECTS: readonly ListenExpect[] = ["REPEAT", "ANSWER", "FREE"];
const ITEM_KINDS: readonly ItemKind[] = ["PHRASE", "ERROR"];
const SIGNALS: readonly Signal[] = ["FAILED", "HARD", "PRODUCED", "SPONTANEOUS", "NOT_OBSERVED"];
const TOPICS: readonly Topic[] = ["TRAVEL", "TABLE_AND_STAY", "CITY_AND_TROUBLE", "SMALL_TALK"];
const FACT_TOPICS: readonly FactTopic[] = ["TRIP", "COMPANIONS", "INTERESTS", "WORRIES", "OTHER"];
const GOAL_STATUSES: readonly GoalStatus[] = ["ONGOING", "DONE"];

function fail<T>(reason: string): Result<T> {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Uppercases and squashes separators so "table and stay" or "Table-And-Stay" both match. */
export function normalizeEnumValue(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): Result<T> {
  if (typeof value !== "string") {
    return fail(`${path}: atteso un valore tra ${allowed.join("/")}`);
  }
  const normalized = normalizeEnumValue(value);
  const found = allowed.find((candidate) => candidate === normalized);
  if (found === undefined) {
    return fail(`${path}: valore sconosciuto "${value}"`);
  }
  return { ok: true, value: found };
}

/** Required string; returned trimmed (possibly empty, the caller decides what empty means). */
function readString(value: unknown, path: string): Result<string> {
  if (typeof value !== "string") {
    return fail(`${path}: attesa una stringa`);
  }
  return { ok: true, value: value.trim() };
}

/** Optional list of strings: non-strings and blanks are dropped, the rest trimmed and capped. */
function readStringList(value: unknown, max: number): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed.length > 0) {
      out.push(trimmed);
    }
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

/**
 * Normalizes one element of `segments`. `value: null` means a well-formed segment with empty
 * text, which callers drop; a wrong shape or an unknown enum is an error.
 */
export function normalizeSegment(value: unknown, path = "segments[]"): Result<Segment | null> {
  if (!isRecord(value)) {
    return fail(`${path}: atteso un oggetto`);
  }
  const lang = readEnum(value.lang, LANGS, `${path}.lang`);
  if (!lang.ok) {
    return lang;
  }
  const kind = readEnum(value.kind, SEGMENT_KINDS, `${path}.kind`);
  if (!kind.ok) {
    return kind;
  }
  const text = readString(value.text, `${path}.text`);
  if (!text.ok) {
    return text;
  }
  if (text.value.length === 0) {
    return { ok: true, value: null };
  }
  return { ok: true, value: { lang: lang.value, kind: kind.value, text: text.value } };
}

function readSegments(value: unknown): Result<readonly Segment[]> {
  if (!Array.isArray(value)) {
    return fail("segments: atteso un elenco");
  }
  const out: Segment[] = [];
  for (const [index, entry] of value.entries()) {
    const segment = normalizeSegment(entry, `segments[${index}]`);
    if (!segment.ok) {
      return segment;
    }
    if (segment.value !== null) {
      out.push(segment.value);
    }
  }
  if (out.length === 0) {
    return fail("segments: nessun segmento con testo");
  }
  return { ok: true, value: out };
}

function readListen(value: unknown): Result<Listen> {
  if (!isRecord(value)) {
    return fail("listen: atteso un oggetto");
  }
  const lang = readEnum(value.lang, LANGS, "listen.lang");
  if (!lang.ok) {
    return lang;
  }
  const expect = readEnum(value.expect, LISTEN_EXPECTS, "listen.expect");
  if (!expect.ok) {
    return expect;
  }
  const target = typeof value.target === "string" ? value.target.trim() : "";
  const alternatives = readStringList(value.alternatives, TURN_LIMITS.alternatives);
  const listen: Listen = {
    lang: lang.value,
    expect: expect.value,
    ...(target.length > 0 ? { target } : {}),
    ...(alternatives.length > 0 ? { alternatives } : {}),
  };
  return { ok: true, value: listen };
}

function readCorrection(value: unknown): Result<Correction | null> {
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }
  if (!isRecord(value)) {
    return fail("correction: atteso un oggetto o null");
  }
  const heard = readString(value.heard, "correction.heard");
  if (!heard.ok) {
    return heard;
  }
  const correct = readString(value.correct, "correction.correct");
  if (!correct.ok) {
    return correct;
  }
  const noteIt = typeof value.note_it === "string" ? value.note_it.trim() : "";
  if (heard.value.length === 0 || correct.value.length === 0) {
    return { ok: true, value: null };
  }
  return { ok: true, value: { heard: heard.value, correct: correct.value, note_it: noteIt } };
}

function readItems(value: unknown): Result<readonly ItemSignal[]> {
  if (value === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return fail("items: atteso un elenco");
  }
  const out: ItemSignal[] = [];
  for (const [index, entry] of value.entries()) {
    if (out.length >= TURN_LIMITS.items) {
      break;
    }
    const path = `items[${index}]`;
    if (!isRecord(entry)) {
      return fail(`${path}: atteso un oggetto`);
    }
    const kind = readEnum(entry.kind, ITEM_KINDS, `${path}.kind`);
    if (!kind.ok) {
      return kind;
    }
    const signal = readEnum(entry.signal, SIGNALS, `${path}.signal`);
    if (!signal.ok) {
      return signal;
    }
    const id = readString(entry.id, `${path}.id`);
    if (!id.ok) {
      return id;
    }
    if (id.value.length === 0) {
      continue;
    }
    out.push({ kind: kind.value, id: id.value, signal: signal.value });
  }
  return { ok: true, value: out };
}

function readLearned(value: unknown): Result<readonly Learned[]> {
  if (value === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return fail("learned: atteso un elenco");
  }
  const out: Learned[] = [];
  for (const [index, entry] of value.entries()) {
    if (out.length >= TURN_LIMITS.learned) {
      break;
    }
    const path = `learned[${index}]`;
    if (!isRecord(entry)) {
      return fail(`${path}: atteso un oggetto`);
    }
    const textEn = readString(entry.text_en, `${path}.text_en`);
    if (!textEn.ok) {
      return textEn;
    }
    const glossIt = readString(entry.gloss_it, `${path}.gloss_it`);
    if (!glossIt.ok) {
      return glossIt;
    }
    const topic = readEnum(entry.topic, TOPICS, `${path}.topic`);
    if (!topic.ok) {
      return topic;
    }
    if (textEn.value.length === 0) {
      continue;
    }
    out.push({ text_en: textEn.value, gloss_it: glossIt.value, topic: topic.value });
  }
  return { ok: true, value: out };
}

function readAboutLearner(value: unknown): Result<readonly LearnerFact[]> {
  if (value === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return fail("about_learner: atteso un elenco");
  }
  const out: LearnerFact[] = [];
  for (const [index, entry] of value.entries()) {
    if (out.length >= TURN_LIMITS.aboutLearner) {
      break;
    }
    const path = `about_learner[${index}]`;
    if (!isRecord(entry)) {
      return fail(`${path}: atteso un oggetto`);
    }
    const fact = readString(entry.fact, `${path}.fact`);
    if (!fact.ok) {
      return fact;
    }
    const topic = readEnum(entry.topic, FACT_TOPICS, `${path}.topic`);
    if (!topic.ok) {
      return topic;
    }
    if (fact.value.length === 0) {
      continue;
    }
    out.push({ fact: fact.value, topic: topic.value });
  }
  return { ok: true, value: out };
}

function readGoal(value: unknown): Result<Goal | null> {
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }
  if (!isRecord(value)) {
    return fail("goal: atteso un oggetto o null");
  }
  const id = readString(value.id, "goal.id");
  if (!id.ok) {
    return id;
  }
  const status = readEnum(value.status, GOAL_STATUSES, "goal.status");
  if (!status.ok) {
    return status;
  }
  if (id.value.length === 0) {
    return { ok: true, value: null };
  }
  return { ok: true, value: { id: id.value, status: status.value } };
}

function readClosing(value: unknown): Result<Closing | null> {
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }
  if (!isRecord(value)) {
    return fail("closing: atteso un oggetto o null");
  }
  if (value.remember !== undefined && !Array.isArray(value.remember)) {
    return fail("closing.remember: atteso un elenco");
  }
  return { ok: true, value: { remember: readStringList(value.remember, TURN_LIMITS.remember) } };
}

/** Applies the protocol rules to an already-parsed value (e.g. the output of the extractor). */
export function normalizeTurnResponse(obj: unknown): ParseResult {
  if (!isRecord(obj)) {
    return { ok: false, reason: "risposta: atteso un oggetto" };
  }
  const segments = readSegments(obj.segments);
  if (!segments.ok) {
    return segments;
  }
  const listen = readListen(obj.listen);
  if (!listen.ok) {
    return listen;
  }
  const correction = readCorrection(obj.correction);
  if (!correction.ok) {
    return correction;
  }
  const items = readItems(obj.items);
  if (!items.ok) {
    return items;
  }
  const learned = readLearned(obj.learned);
  if (!learned.ok) {
    return learned;
  }
  const aboutLearner = readAboutLearner(obj.about_learner);
  if (!aboutLearner.ok) {
    return aboutLearner;
  }
  const goal = readGoal(obj.goal);
  if (!goal.ok) {
    return goal;
  }
  const closing = readClosing(obj.closing);
  if (!closing.ok) {
    return closing;
  }
  return {
    ok: true,
    response: {
      segments: segments.value,
      listen: listen.value,
      correction: correction.value,
      items: items.value,
      learned: learned.value,
      about_learner: aboutLearner.value,
      goal: goal.value,
      closing: closing.value,
    },
  };
}

/** Parses the full JSON text of a reply and normalizes it. Never throws. */
export function parseTurnResponse(json: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `JSON non valido: ${detail}` };
  }
  return normalizeTurnResponse(parsed);
}
