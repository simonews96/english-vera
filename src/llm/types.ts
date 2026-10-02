/**
 * LLM client contract. One implementation talks to the Claude API from the browser
 * (streaming + structured outputs), another is a scripted fake for tests and e2e.
 */

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export const EMPTY_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export type ThinkingConfig =
  | { readonly type: "between_tools" }
  | { readonly type: "adaptive"; readonly display: "omitted" };

export type Effort = "low" | "medium" | "high";

export type ModelPresetId = "sonnet-between-tools" | "sonnet-adaptive-low" | "haiku" | "opus" | "custom";

/** Per-model request configuration. Parameters are model-specific (docs/PIANO.md §1.1). */
export interface ModelPreset {
  readonly id: ModelPresetId;
  readonly label: string;
  readonly model: string;
  readonly thinking?: ThinkingConfig;
  readonly effort?: Effort;
  readonly maxTokens: number;
}

export type HistoryRole = "user" | "assistant";

export interface HistoryMessage {
  readonly role: HistoryRole;
  /** For assistant turns: only the spoken text of the segments, never the full JSON. */
  readonly text: string;
}

export interface LlmTurnRequest {
  /** Stable block, cached (`cache_control`). Must stay byte-identical across turns. */
  readonly systemStable: string;
  /** Learner card, regenerated per turn; sent after the cache breakpoint. */
  readonly learnerCard: string;
  readonly history: readonly HistoryMessage[];
  readonly userText: string;
  readonly preset: ModelPreset;
}

export type StopReason = "end_turn" | "max_tokens" | "refusal" | "stop_sequence" | "other";

export type LlmStreamEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "usage"; readonly usage: Partial<LlmUsage> }
  | {
      readonly type: "done";
      readonly stopReason: StopReason;
      readonly usage: LlmUsage;
      readonly fullText: string;
    }
  | { readonly type: "error"; readonly error: LlmError };

export type LlmErrorKind =
  | "invalid-key"
  | "zdr-cors"
  | "spend-limit"
  | "rate-limited"
  | "overloaded"
  | "server"
  | "network"
  | "timeout"
  | "refusal"
  | "max-tokens"
  | "bad-request"
  | "unknown";

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(kind: LlmErrorKind, message: string, options: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export type KeyValidation =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly error: LlmError };

export interface LlmClient {
  /** Streams one turn. The iterator ends with a `done` or an `error` event. */
  stream(request: LlmTurnRequest, signal?: AbortSignal): AsyncIterable<LlmStreamEvent>;
  /** GET /v1/models: validates the key without spending tokens. */
  validateKey(): Promise<KeyValidation>;
  /** Tiny request that compiles the structured-output grammar (cached 24 h server-side). */
  warmUp(preset: ModelPreset): Promise<void>;
}
