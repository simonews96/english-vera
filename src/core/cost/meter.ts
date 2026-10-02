/**
 * Cost meter: today / session / total spend from real API usage × the price table.
 * Today and total are persisted in localStorage (`vera.cost.v1`) with a rollover on the
 * local calendar day; the session counters live in memory and reset on `startSession()`.
 */

import type { LlmUsage } from "../../llm/types";
import { costOfUsage, PRICE_TABLE, type PriceTable } from "./pricing";

export interface CostSummary {
  readonly todayUsd: number;
  readonly sessionUsd: number;
  readonly totalUsd: number;
  readonly todayTurns: number;
  readonly sessionTurns: number;
  readonly totalTurns: number;
  /** Turns whose usage was a partial estimate (request aborted before the final usage). */
  readonly partialTurns: number;
  /** Turns billed at 0 because the model is not in the table. */
  readonly unknownModelTurns: number;
  /** Local calendar day the "today" counters refer to, `YYYY-MM-DD`. */
  readonly dayKey: string;
  readonly tableVersion: string;
}

export interface CostEntry {
  readonly usage: LlmUsage;
  readonly model: string;
  readonly partial?: boolean;
}

export interface CostMeterOptions {
  readonly storage?: Storage | null;
  readonly now?: () => Date;
  readonly table?: PriceTable;
}

export interface CostMeter {
  record(entry: CostEntry): CostSummary;
  /** Resets the session counters (call at the start of each practice session). */
  startSession(): void;
  summary(): CostSummary;
  subscribe(listener: (summary: CostSummary) => void): () => void;
}

export const COST_STORAGE_KEY = "vera.cost.v1";

interface PersistedCost {
  readonly v: 1;
  readonly dayKey: string;
  readonly todayUsd: number;
  readonly todayTurns: number;
  readonly totalUsd: number;
  readonly totalTurns: number;
  readonly partialTurns: number;
  readonly unknownModelTurns: number;
}

/** Local calendar day as `YYYY-MM-DD` (not UTC: the budget resets at the user's midnight). */
export function dayKeyOf(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function emptyPersisted(dayKey: string): PersistedCost {
  return {
    v: 1,
    dayKey,
    todayUsd: 0,
    todayTurns: 0,
    totalUsd: 0,
    totalTurns: 0,
    partialTurns: 0,
    unknownModelTurns: 0,
  };
}

function readPersisted(storage: Storage | null, dayKey: string): PersistedCost {
  const fallback = emptyPersisted(dayKey);
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(COST_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return fallback;
    const p = parsed as Record<string, unknown>;
    const storedDay = typeof p.dayKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.dayKey) ? p.dayKey : "";
    const sameDay = storedDay === dayKey;
    return {
      v: 1,
      dayKey,
      todayUsd: sameDay ? nonNegative(p.todayUsd) : 0,
      todayTurns: sameDay ? Math.floor(nonNegative(p.todayTurns)) : 0,
      totalUsd: nonNegative(p.totalUsd),
      totalTurns: Math.floor(nonNegative(p.totalTurns)),
      partialTurns: Math.floor(nonNegative(p.partialTurns)),
      unknownModelTurns: Math.floor(nonNegative(p.unknownModelTurns)),
    };
  } catch {
    return fallback;
  }
}

function writePersisted(storage: Storage | null, state: PersistedCost): void {
  if (!storage) return;
  try {
    storage.setItem(COST_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota or private mode: the meter keeps counting in memory.
  }
}

export function createCostMeter(options: CostMeterOptions = {}): CostMeter {
  const storage = options.storage === undefined ? (globalThis.localStorage ?? null) : options.storage;
  const now = options.now ?? (() => new Date());
  const table = options.table ?? PRICE_TABLE;
  const listeners = new Set<(summary: CostSummary) => void>();

  let persisted = readPersisted(storage, dayKeyOf(now()));
  let sessionUsd = 0;
  let sessionTurns = 0;

  const rollover = (): void => {
    const today = dayKeyOf(now());
    if (persisted.dayKey !== today) {
      persisted = { ...persisted, dayKey: today, todayUsd: 0, todayTurns: 0 };
    }
  };

  const summary = (): CostSummary => {
    rollover();
    return {
      todayUsd: persisted.todayUsd,
      sessionUsd,
      totalUsd: persisted.totalUsd,
      todayTurns: persisted.todayTurns,
      sessionTurns,
      totalTurns: persisted.totalTurns,
      partialTurns: persisted.partialTurns,
      unknownModelTurns: persisted.unknownModelTurns,
      dayKey: persisted.dayKey,
      tableVersion: table.version,
    };
  };

  const emit = (): CostSummary => {
    const current = summary();
    for (const listener of listeners) listener(current);
    return current;
  };

  return {
    record(entry) {
      rollover();
      const { usd, known } = costOfUsage(entry.usage, entry.model, table);
      persisted = {
        ...persisted,
        todayUsd: persisted.todayUsd + usd,
        todayTurns: persisted.todayTurns + 1,
        totalUsd: persisted.totalUsd + usd,
        totalTurns: persisted.totalTurns + 1,
        partialTurns: persisted.partialTurns + (entry.partial ? 1 : 0),
        unknownModelTurns: persisted.unknownModelTurns + (known ? 0 : 1),
      };
      sessionUsd += usd;
      sessionTurns += 1;
      writePersisted(storage, persisted);
      return emit();
    },
    startSession() {
      sessionUsd = 0;
      sessionTurns = 0;
      emit();
    },
    summary,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
