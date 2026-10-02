/**
 * The learner card: the per-turn block the app regenerates and sends AFTER the cache
 * breakpoint, inside the user message (docs/PIANO.md §1.1, §1.4). It is compact, labeled,
 * deterministic (same input, same string) and capped in length. For milestone 1 most fields
 * are absent: the card is still meaningful with name, level, share, slow flag and turn count.
 */

import type { HelpKind } from "../session/types";

export type CardLevel = "A0" | "A1" | "A1+" | "A2";
export type CardPhase = "WARMUP" | "SCENARIO" | "CLOSING";

export interface CardGoal {
  readonly id: string;
  readonly textEn: string;
  readonly textIt: string;
  readonly beats?: readonly string[];
}

export interface CardDueItem {
  readonly id: string;
  readonly kind: "PHRASE" | "ERROR";
  readonly textEn: string;
  readonly glossIt?: string;
  readonly note?: string;
}

export interface CardActiveError {
  readonly id: string;
  readonly wrong: string;
  readonly target: string;
  readonly hintIt?: string;
  readonly recurrences: number;
}

export interface CardCorrection {
  readonly wrong: string;
  readonly target: string;
}

export interface CardMetrics {
  readonly talkShare?: number;
  readonly againRate14d?: number;
  readonly helpPerSession?: number;
}

export interface LearnerCardInput {
  readonly name: string;
  readonly level: CardLevel;
  /** Share of Vera's words that may be Italian, 0..1. */
  readonly italianShareTarget: number;
  readonly slowMode: boolean;
  readonly phase?: CardPhase;
  readonly elapsedS?: number;
  readonly targetS?: number;
  readonly beatsDone?: number;
  readonly goal?: CardGoal;
  readonly dueItems?: readonly CardDueItem[];
  readonly activeErrors?: readonly CardActiveError[];
  readonly recentCorrections?: readonly CardCorrection[];
  readonly aboutLearner?: readonly string[];
  readonly lastSessionSummary?: readonly string[];
  readonly checkpoint?: string;
  readonly metrics?: CardMetrics;
  readonly turnsThisSession: number;
  readonly help?: HelpKind;
}

/** Soft cap on the card length (≈ 400 tokens). */
export const CARD_MAX_CHARS = 1600;

/** The text the app sends as the learner's first message so Vera greets and starts. */
export const FIRST_TURN_TEXT = "[inizio sessione]";

/** List caps, by priority (applied before the length cap). */
const LIST_CAPS = {
  dueItems: 6,
  activeErrors: 3,
  recentCorrections: 5,
  aboutLearner: 6,
  lastSessionSummary: 3,
} as const;

/** Floors kept when the length cap forces lists to shrink. */
const LIST_FLOORS = {
  dueItems: 2,
  activeErrors: 1,
  recentCorrections: 0,
  aboutLearner: 0,
  lastSessionSummary: 0,
} as const;

/** Shrink order under the length cap: least valuable first. */
const SHRINK_ORDER: readonly (keyof typeof LIST_CAPS)[] = [
  "lastSessionSummary",
  "aboutLearner",
  "recentCorrections",
  "dueItems",
  "activeErrors",
];

const MAX_BEATS = 4;
const TEXT_MAX = 70;
const LONG_TEXT_MAX = 110;
const CHECKPOINT_MAX = 160;

/** One line, trimmed, no tag-like brackets, clamped with an ellipsis. */
function clean(text: string, max: number): string {
  const flat = text.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function percent(value: number): string {
  return `${Math.round(clampUnit(value) * 100)}%`;
}

function duration(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (rest === 0) return `${minutes}m`;
  return `${minutes}m${String(rest).padStart(2, "0")}s`;
}

function levelLine(input: LearnerCardInput): string {
  return `LEVEL: ${input.level} (italian share target ${percent(input.italianShareTarget)})`;
}

function phaseLine(input: LearnerCardInput): string | null {
  if (input.phase === undefined) return null;
  const parts: string[] = [input.phase];
  if (input.elapsedS !== undefined) {
    parts.push(
      input.targetS === undefined
        ? duration(input.elapsedS)
        : `${duration(input.elapsedS)}/${duration(input.targetS)}`,
    );
  }
  if (input.beatsDone !== undefined) {
    const total = input.goal?.beats?.length;
    parts.push(total === undefined ? `beats ${input.beatsDone}` : `beats ${input.beatsDone}/${total}`);
  }
  return `PHASE: ${parts.join(" ")}`;
}

function goalLines(goal: CardGoal | undefined): string[] {
  if (goal === undefined) return [];
  const lines = [
    `GOAL: ${clean(goal.id, TEXT_MAX)} — ${clean(goal.textEn, TEXT_MAX)} (${clean(goal.textIt, TEXT_MAX)})`,
  ];
  const beats = (goal.beats ?? []).slice(0, MAX_BEATS);
  if (beats.length > 0) {
    lines.push(`BEATS: ${beats.map((beat, index) => `${index + 1}. ${clean(beat, TEXT_MAX)}`).join(" | ")}`);
  }
  return lines;
}

function dueItemEntry(item: CardDueItem): string {
  let entry = `${clean(item.id, TEXT_MAX)} ${item.kind} "${clean(item.textEn, TEXT_MAX)}"`;
  if (item.glossIt !== undefined && item.glossIt.trim().length > 0)
    entry += ` (${clean(item.glossIt, TEXT_MAX)})`;
  if (item.note !== undefined && item.note.trim().length > 0) entry += ` [${clean(item.note, TEXT_MAX)}]`;
  return entry;
}

function activeErrorEntry(error: CardActiveError): string {
  let entry = `${clean(error.id, TEXT_MAX)} "${clean(error.wrong, TEXT_MAX)}" -> "${clean(error.target, TEXT_MAX)}"`;
  if (error.hintIt !== undefined && error.hintIt.trim().length > 0)
    entry += ` (hint: ${clean(error.hintIt, TEXT_MAX)})`;
  entry += ` x${Math.max(0, Math.floor(error.recurrences))}`;
  return entry;
}

function correctionEntry(correction: CardCorrection): string {
  return `"${clean(correction.wrong, TEXT_MAX)}" -> "${clean(correction.target, TEXT_MAX)}"`;
}

function metricsLine(metrics: CardMetrics | undefined): string | null {
  if (metrics === undefined) return null;
  const parts: string[] = [];
  if (metrics.talkShare !== undefined) parts.push(`learner talk ${percent(metrics.talkShare)}`);
  if (metrics.againRate14d !== undefined) parts.push(`again 14d ${percent(metrics.againRate14d)}`);
  if (metrics.helpPerSession !== undefined && Number.isFinite(metrics.helpPerSession)) {
    parts.push(`help/session ${Math.max(0, metrics.helpPerSession).toFixed(1)}`);
  }
  return parts.length === 0 ? null : `METRICS: ${parts.join(", ")}`;
}

function flagsLine(input: LearnerCardInput): string | null {
  const flags: string[] = [];
  if (input.slowMode) flags.push("SLOW");
  if (input.help !== undefined) flags.push(`HELP=${input.help}`);
  return flags.length === 0 ? null : `FLAGS: ${flags.join(", ")}`;
}

interface CardLists {
  dueItems: string[];
  activeErrors: string[];
  recentCorrections: string[];
  aboutLearner: string[];
  lastSessionSummary: string[];
}

function nonEmpty(values: readonly string[] | undefined, max: number): string[] {
  return (values ?? []).map((value) => clean(value, max)).filter((value) => value.length > 0);
}

function initialLists(input: LearnerCardInput): CardLists {
  return {
    dueItems: (input.dueItems ?? []).slice(0, LIST_CAPS.dueItems).map(dueItemEntry),
    activeErrors: (input.activeErrors ?? []).slice(0, LIST_CAPS.activeErrors).map(activeErrorEntry),
    recentCorrections: (input.recentCorrections ?? [])
      .slice(0, LIST_CAPS.recentCorrections)
      .map(correctionEntry),
    aboutLearner: nonEmpty(input.aboutLearner, LONG_TEXT_MAX).slice(0, LIST_CAPS.aboutLearner),
    lastSessionSummary: nonEmpty(input.lastSessionSummary, LONG_TEXT_MAX).slice(
      0,
      LIST_CAPS.lastSessionSummary,
    ),
  };
}

function render(input: LearnerCardInput, lists: CardLists): string {
  const lines: string[] = [];
  const name = clean(input.name, TEXT_MAX);
  lines.push(`LEARNER: ${name.length > 0 ? name : "(nome non impostato)"}`);
  lines.push(levelLine(input));
  lines.push(`TURN: ${Math.max(0, Math.floor(input.turnsThisSession))} this session`);
  const phase = phaseLine(input);
  if (phase !== null) lines.push(phase);
  lines.push(...goalLines(input.goal));
  if (lists.dueItems.length > 0) lines.push(`DUE ITEMS: ${lists.dueItems.join("; ")}`);
  if (lists.activeErrors.length > 0) lines.push(`ACTIVE ERRORS: ${lists.activeErrors.join("; ")}`);
  if (lists.recentCorrections.length > 0)
    lines.push(`RECENT CORRECTIONS: ${lists.recentCorrections.join("; ")}`);
  if (lists.aboutLearner.length > 0) lines.push(`ABOUT: ${lists.aboutLearner.join("; ")}`);
  if (lists.lastSessionSummary.length > 0)
    lines.push(`LAST SESSION: ${lists.lastSessionSummary.join(" / ")}`);
  if (input.checkpoint !== undefined) {
    const checkpoint = clean(input.checkpoint, CHECKPOINT_MAX);
    if (checkpoint.length > 0) lines.push(`CHECKPOINT: ${checkpoint}`);
  }
  const metrics = metricsLine(input.metrics);
  if (metrics !== null) lines.push(metrics);
  const flags = flagsLine(input);
  if (flags !== null) lines.push(flags);
  return lines.join("\n");
}

/**
 * Builds the card. Lists are capped by priority, then the whole card is shrunk to about
 * `CARD_MAX_CHARS` by dropping the least valuable entries first (summary, facts,
 * corrections, due items down to two, errors down to one).
 */
export function buildLearnerCard(input: LearnerCardInput): string {
  const lists = initialLists(input);
  let card = render(input, lists);
  for (const key of SHRINK_ORDER) {
    while (card.length > CARD_MAX_CHARS && lists[key].length > LIST_FLOORS[key]) {
      lists[key].pop();
      card = render(input, lists);
    }
  }
  return card;
}

/**
 * Wraps the card and the learner's words into the user message: the card in a tagged block,
 * an optional help flag, then the learner's text. The prompt (./system) describes this shape.
 */
export function buildUserMessage(card: string, userText: string, help?: HelpKind): string {
  const text = userText.replace(/[<>]/g, "").trim();
  const parts: string[] = ["<learner_card>", card, "</learner_card>"];
  if (help !== undefined) parts.push(`<help>${help}</help>`);
  parts.push("<learner_says>", text.length > 0 ? text : FIRST_TURN_TEXT, "</learner_says>");
  return parts.join("\n");
}
