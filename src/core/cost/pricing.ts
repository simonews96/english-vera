/**
 * Versioned price table and cost arithmetic (docs/PIANO.md §1.1 "Costi").
 * Costs are estimates: real `usage` from the API multiplied by a dated table.
 * The table is user-overridable so a price change does not need a new deploy.
 */

import type { LlmUsage } from "../../llm/types";

/** USD per million tokens. `cacheWrite` is the 5-minute TTL rate. */
export interface ModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface PriceTable {
  /** ISO date of the day the rates were read from the official price list. */
  readonly version: string;
  readonly currency: "USD";
  readonly perMillion: Readonly<Record<string, ModelPrice>>;
}

/** Shape accepted by `mergePriceTable`: every field optional, per-model fields optional too. */
export interface PriceTableOverride {
  readonly version?: string;
  readonly currency?: "USD";
  readonly perMillion?: Readonly<Record<string, Partial<ModelPrice>>>;
}

export interface CostEstimate {
  readonly usd: number;
  /** False when the model has no entry in the table (cost counted as 0). */
  readonly known: boolean;
}

export const PRICE_TABLE: PriceTable = {
  version: "2026-10-02",
  currency: "USD",
  perMillion: {
    "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  },
};

const PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function isValidRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Finds the price of a model id. Exact match first; otherwise the longest table id that is a
 * prefix of the model followed by a dash (so `claude-sonnet-5-5-20261001` resolves to
 * `claude-sonnet-5-5`, while `claude-sonnet-5-55` does not).
 */
export function resolveModelPrice(model: string, table: PriceTable = PRICE_TABLE): ModelPrice | undefined {
  const id = model.trim().toLowerCase();
  if (id === "") return undefined;
  const exact = table.perMillion[id];
  if (exact) return exact;
  let best: ModelPrice | undefined;
  let bestLength = 0;
  for (const [key, price] of Object.entries(table.perMillion)) {
    const prefix = key.toLowerCase();
    if (id.startsWith(`${prefix}-`) && prefix.length > bestLength) {
      best = price;
      bestLength = prefix.length;
    }
  }
  return best;
}

function tokens(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Cost in USD of one usage report. Unknown model: `{ usd: 0, known: false }`. */
export function costOfUsage(usage: LlmUsage, model: string, table: PriceTable = PRICE_TABLE): CostEstimate {
  const price = resolveModelPrice(model, table);
  if (!price) return { usd: 0, known: false };
  const usd =
    (tokens(usage.inputTokens) * price.input +
      tokens(usage.outputTokens) * price.output +
      tokens(usage.cacheReadTokens) * price.cacheRead +
      tokens(usage.cacheWriteTokens) * price.cacheWrite) /
    1_000_000;
  return { usd, known: true };
}

/** `$0.0048` under one cent, `$1.20` otherwise. Non-finite or negative amounts render as `$0.00`. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/**
 * Applies a user override on top of a base table. Per-model fields are merged; invalid rates
 * (negative, NaN, non-numeric) are ignored; a model unknown to the base table is added only
 * when all four rates are valid. The result keeps the override version when given, otherwise
 * marks the base version as customised.
 */
export function mergePriceTable(base: PriceTable, override: PriceTableOverride): PriceTable {
  const perMillion: Record<string, ModelPrice> = { ...base.perMillion };
  let changed = false;
  for (const [rawId, partial] of Object.entries(override.perMillion ?? {})) {
    const id = rawId.trim().toLowerCase();
    if (id === "" || typeof partial !== "object" || partial === null) continue;
    const current = perMillion[id];
    const next: Partial<Record<keyof ModelPrice, number>> = current ? { ...current } : {};
    for (const field of PRICE_FIELDS) {
      const value = partial[field];
      if (isValidRate(value)) next[field] = value;
    }
    if (PRICE_FIELDS.every((field) => isValidRate(next[field]))) {
      perMillion[id] = next as ModelPrice;
      changed = true;
    }
  }
  const version =
    typeof override.version === "string" && override.version.trim() !== ""
      ? override.version.trim()
      : changed
        ? `${base.version} (personalizzato)`
        : base.version;
  return { version, currency: "USD", perMillion };
}
