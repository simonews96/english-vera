/**
 * Claude client for the browser: streaming structured outputs through the official SDK
 * (`dangerouslyAllowBrowser`, `maxRetries: 0`: the retry policy is the app's own, see
 * docs/PIANO.md §1.1). Request layout, designed so the prompt cache actually hits:
 * system = one stable block with `cache_control`; messages = append-only history (its last
 * message carries the second breakpoint), then ONE user message with the learner card plus
 * the new utterance.
 */

import Anthropic from "@anthropic-ai/sdk";
import { TURN_JSON_SCHEMA } from "../core/turn/schema";
import { toLlmError } from "./errors";
import {
  EMPTY_USAGE,
  type KeyValidation,
  type LlmClient,
  LlmError,
  type LlmStreamEvent,
  type LlmTurnRequest,
  type LlmUsage,
  type ModelPreset,
  type StopReason,
} from "./types";

export interface ClaudeClientOptions {
  readonly apiKey: string;
  /** Injected for tests (SSE fixtures) and e2e; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  /** Clock, injected for tests. */
  readonly now?: () => number;
}

/** Time allowed for the response headers (the SDK timeout covers only the connection). */
export const HEADER_TIMEOUT_MS = 20_000;
/** Inactivity watchdog: no stream event for this long closes the stream. */
export const STALL_TIMEOUT_MS = 8_000;
/** Smallest `max_tokens` the API accepts for a request that still compiles the grammar. */
const WARM_UP_MAX_TOKENS = 1;
const WARM_UP_TEXT = "ok";

type SdkParams = Anthropic.Messages.MessageCreateParamsNonStreaming;
type SdkUsage = Anthropic.Messages.Usage;
type SdkDeltaUsage = Anthropic.Messages.MessageDeltaUsage;
type SdkStopReason = Anthropic.Messages.StopReason;
type SdkEvent = Anthropic.Messages.MessageStreamEvent;

const OUTPUT_FORMAT: Anthropic.Messages.JSONOutputFormat = { type: "json_schema", schema: TURN_JSON_SCHEMA };

function outputConfig(preset: ModelPreset): Anthropic.Messages.OutputConfig {
  return preset.effort === undefined
    ? { format: OUTPUT_FORMAT }
    : { effort: preset.effort, format: OUTPUT_FORMAT };
}

/** Parameters that only depend on the preset (shared by turns and warm-up). */
function presetParams(preset: ModelPreset): Pick<SdkParams, "model" | "output_config" | "thinking"> {
  const base = { model: preset.model, output_config: outputConfig(preset) };
  // The field is omitted (not set to undefined) so the serialized body has no `thinking` key.
  return preset.thinking === undefined ? base : { ...base, thinking: preset.thinking };
}

/**
 * The history is append-only, so a breakpoint on its last message caches system + history;
 * the API looks for hits at the earlier block boundaries too, so the previous turn's entry
 * is reused and only the two new messages are written. The user message that follows
 * (card + utterance) never repeats and stays out of the cache.
 */
function buildTurnParams(request: LlmTurnRequest): SdkParams {
  const lastIndex = request.history.length - 1;
  const history: Anthropic.Messages.MessageParam[] = request.history.map((message, index) => ({
    role: message.role,
    content:
      index === lastIndex
        ? [{ type: "text", text: message.text, cache_control: { type: "ephemeral" } }]
        : message.text,
  }));
  return {
    ...presetParams(request.preset),
    max_tokens: request.preset.maxTokens,
    system: [{ type: "text", text: request.systemStable, cache_control: { type: "ephemeral" } }],
    messages: [
      ...history,
      {
        role: "user",
        content: request.learnerCard ? `${request.learnerCard}\n\n${request.userText}` : request.userText,
      },
    ],
  };
}

function usageFromStart(usage: SdkUsage): LlmUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/** `message_delta.usage` carries cumulative totals; absent counters keep the previous value. */
function mergeDeltaUsage(current: LlmUsage, delta: SdkDeltaUsage): LlmUsage {
  return {
    inputTokens: delta.input_tokens ?? current.inputTokens,
    outputTokens: delta.output_tokens,
    cacheReadTokens: delta.cache_read_input_tokens ?? current.cacheReadTokens,
    cacheWriteTokens: delta.cache_creation_input_tokens ?? current.cacheWriteTokens,
  };
}

function toStopReason(reason: SdkStopReason | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "max_tokens":
    case "refusal":
    case "stop_sequence":
      return reason;
    default:
      return "other";
  }
}

const STALLED: unique symbol = Symbol("stalled");
const ABORTED: unique symbol = Symbol("aborted");

/** Resolves when the caller's signal aborts (never, without a signal); the cleanup detaches the listener. */
function abortSentinel(signal: AbortSignal | undefined): {
  promise: Promise<typeof ABORTED>;
  cleanup: () => void;
} {
  if (signal === undefined) {
    return { promise: new Promise(() => undefined), cleanup: () => undefined };
  }
  let onAbort: () => void = () => undefined;
  const promise = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, cleanup: () => signal.removeEventListener("abort", onAbort) };
}

interface Watchdog {
  readonly promise: Promise<typeof STALLED>;
  readonly fired: () => boolean;
  arm(): void;
  disarm(): void;
}

function createWatchdog(ms: number, onFire: () => void): Watchdog {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  let resolve: (value: typeof STALLED) => void = () => undefined;
  const promise = new Promise<typeof STALLED>((res) => {
    resolve = res;
  });
  const disarm = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    promise,
    fired: () => fired,
    arm() {
      disarm();
      timer = setTimeout(() => {
        fired = true;
        timer = null;
        onFire();
        resolve(STALLED);
      }, ms);
    },
    disarm,
  };
}

function createSdk(options: ClaudeClientOptions): Anthropic {
  return new Anthropic({
    apiKey: options.apiKey,
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    timeout: HEADER_TIMEOUT_MS,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

async function* streamTurn(
  sdk: Anthropic,
  request: LlmTurnRequest,
  signal: AbortSignal | undefined,
  now: () => number,
): AsyncGenerator<LlmStreamEvent> {
  const stream = sdk.messages.stream(buildTurnParams(request), signal === undefined ? {} : { signal });
  const iterator = stream[Symbol.asyncIterator]();
  const watchdog = createWatchdog(STALL_TIMEOUT_MS, () => stream.abort());
  const aborted = abortSentinel(signal);
  let usage: LlmUsage = EMPTY_USAGE;
  let fullText = "";
  let stopReason: SdkStopReason | null = null;
  let stopExplanation: string | null = null;
  let lastEventAt = now();
  let pending: Promise<IteratorResult<SdkEvent>> | null = null;
  let settled = false;

  try {
    while (!settled) {
      watchdog.arm();
      pending = iterator.next();
      const result = await Promise.race([pending, watchdog.promise, aborted.promise]);
      watchdog.disarm();
      // The SDK may still hold queued deltas after an abort: the signal, not the race order, decides.
      if (result === ABORTED || signal?.aborted === true) {
        // The caller gave up (never the barge-in: the voice stops, the request goes on).
        settled = true;
        stream.abort();
        yield { type: "error", error: new LlmError("network", "aborted") };
        return;
      }
      if (result === STALLED) {
        const stalledFor = Math.round((now() - lastEventAt) / 1000);
        settled = true;
        yield { type: "error", error: new LlmError("timeout", `no stream event for ${stalledFor} s`) };
        return;
      }
      pending = null;
      lastEventAt = now();
      if (result.done) break;
      const event = result.value;
      switch (event.type) {
        case "message_start":
          usage = usageFromStart(event.message.usage);
          yield { type: "usage", usage };
          break;
        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            fullText += event.delta.text;
            yield { type: "text", delta: event.delta.text };
          }
          break;
        case "message_delta":
          usage = mergeDeltaUsage(usage, event.usage);
          stopReason = event.delta.stop_reason;
          stopExplanation = event.delta.stop_details?.explanation ?? null;
          yield { type: "usage", usage };
          break;
        case "message_stop":
          settled = true;
          yield* finish(stopReason, usage, fullText, stopExplanation);
          return;
        default:
          break;
      }
    }
    settled = true;
    if (stopReason === null) {
      // The body closed before the API announced why generation stopped: the JSON is not trustworthy.
      yield { type: "error", error: new LlmError("network", "stream ended before message_stop") };
      return;
    }
    yield* finish(stopReason, usage, fullText, stopExplanation);
  } catch (err) {
    if (settled) return;
    settled = true;
    yield { type: "error", error: toLlmError(err) };
  } finally {
    watchdog.disarm();
    aborted.cleanup();
    // The raced `next()` may still reject once the stream is aborted: keep it from surfacing.
    pending?.catch(() => undefined);
    if (!settled) stream.abort();
  }
}

function* finish(
  stopReason: SdkStopReason | null,
  usage: LlmUsage,
  fullText: string,
  explanation: string | null,
): Generator<LlmStreamEvent> {
  if (stopReason === "refusal") {
    const detail = explanation === null ? "" : `: ${explanation}`;
    yield { type: "error", error: new LlmError("refusal", `the model refused to answer${detail}`) };
    return;
  }
  if (stopReason === "max_tokens") {
    yield { type: "error", error: new LlmError("max-tokens", "the reply was cut at max_tokens") };
    return;
  }
  yield { type: "done", stopReason: toStopReason(stopReason), usage, fullText };
}

async function validateKey(sdk: Anthropic): Promise<KeyValidation> {
  try {
    const page = await sdk.models.list({ limit: 100 });
    return { ok: true, models: page.data.map((model) => model.id) };
  } catch (err) {
    return { ok: false, error: toLlmError(err) };
  }
}

/** Compiles the output grammar server-side (cached 24 h). Best effort: errors are swallowed. */
async function warmUp(sdk: Anthropic, preset: ModelPreset): Promise<void> {
  try {
    await sdk.messages.create({
      ...presetParams(preset),
      max_tokens: WARM_UP_MAX_TOKENS,
      messages: [{ role: "user", content: WARM_UP_TEXT }],
    });
  } catch {
    // Warm-up is an optimization only; the first real turn pays the compile latency instead.
  }
}

export function createClaudeClient(options: ClaudeClientOptions): LlmClient {
  const sdk = createSdk(options);
  const now = options.now ?? (() => Date.now());
  return {
    stream: (request, signal) => streamTurn(sdk, request, signal, now),
    validateKey: () => validateKey(sdk),
    warmUp: (preset) => warmUp(sdk, preset),
  };
}
