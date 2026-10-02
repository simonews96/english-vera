/**
 * Scripted LLM client for unit tests, e2e runs and the text-only demo: streams a canned
 * `TurnResponse` as JSON chunks with the same event sequence as the real client.
 */

import type { TurnResponse } from "../core/turn/schema";
import {
  EMPTY_USAGE,
  type LlmClient,
  LlmError,
  type LlmStreamEvent,
  type LlmTurnRequest,
  type LlmUsage,
} from "./types";

export type FakeReply = TurnResponse | LlmError;

export interface FakeLlmClientOptions {
  /** Replies in order of request, or a function of the request. Exhausted list = error event. */
  readonly replies: readonly FakeReply[] | ((request: LlmTurnRequest) => FakeReply);
  /** Characters per text delta. Default 12. */
  readonly chunkSize?: number;
  /** Pause between deltas; 0 (default) streams synchronously, without timers. */
  readonly delayMs?: number;
  /** Overrides for the usage reported with the `done` event. */
  readonly usage?: Partial<LlmUsage>;
}

export interface FakeLlmClient extends LlmClient {
  /** Every request received, in order; lets tests inspect the prompt the app built. */
  readonly requests: readonly LlmTurnRequest[];
}

const FAKE_MODELS = ["claude-sonnet-5-5"];
const DEFAULT_CHUNK = 12;
const DEFAULT_INPUT_TOKENS = 600;
const DEFAULT_CACHE_READ_TOKENS = 1500;

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortedEvent(): LlmStreamEvent {
  return { type: "error", error: new LlmError("network", "aborted") };
}

export function createFakeLlmClient(options: FakeLlmClientOptions): FakeLlmClient {
  const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK);
  const delayMs = Math.max(0, options.delayMs ?? 0);
  const requests: LlmTurnRequest[] = [];
  let index = 0;

  function nextReply(request: LlmTurnRequest): FakeReply {
    if (typeof options.replies === "function") return options.replies(request);
    const reply = options.replies[index];
    index += 1;
    return reply ?? new LlmError("unknown", `fake client: no reply left for request #${index}`);
  }

  async function* stream(request: LlmTurnRequest, signal?: AbortSignal): AsyncGenerator<LlmStreamEvent> {
    requests.push(request);
    if (signal?.aborted) {
      yield abortedEvent();
      return;
    }
    const reply = nextReply(request);
    if (reply instanceof LlmError) {
      yield { type: "error", error: reply };
      return;
    }
    const fullText = JSON.stringify(reply);
    const usage: LlmUsage = {
      ...EMPTY_USAGE,
      inputTokens: DEFAULT_INPUT_TOKENS,
      cacheReadTokens: DEFAULT_CACHE_READ_TOKENS,
      outputTokens: Math.ceil(fullText.length / 4),
      ...options.usage,
    };
    yield {
      type: "usage",
      usage: {
        inputTokens: usage.inputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      },
    };
    for (let at = 0; at < fullText.length; at += chunkSize) {
      if (delayMs > 0 && at > 0) await sleep(delayMs, signal);
      if (signal?.aborted) {
        yield abortedEvent();
        return;
      }
      yield { type: "text", delta: fullText.slice(at, at + chunkSize) };
    }
    yield { type: "usage", usage };
    yield { type: "done", stopReason: "end_turn", usage, fullText };
  }

  return {
    requests,
    stream,
    validateKey: () => Promise.resolve({ ok: true, models: FAKE_MODELS }),
    warmUp: () => Promise.resolve(),
  };
}
