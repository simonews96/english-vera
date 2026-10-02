/**
 * Fixtures for the Messages API over SSE, shared by the unit tests (SDK + mocked fetch)
 * and the e2e tests (`page.route` → `route.fulfill({ body: anthropicSseBody(...) })`).
 */

import type { TurnResponse } from "../../src/core/turn/schema";

export interface SseUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

export interface SseBodyOptions {
  /** Characters per `text_delta`. Default 16. */
  readonly chunk?: number;
  /** `stop_reason` of the `message_delta`. Default "end_turn". */
  readonly stopReason?: string;
  readonly usage?: SseUsage;
  /** Raw text to stream instead of the JSON of `response` (e.g. a truncated reply). */
  readonly text?: string;
  /** `stop_details` of the `message_delta` (refusals). */
  readonly stopDetails?: { readonly category: string | null; readonly explanation: string | null };
  readonly model?: string;
}

const DEFAULT_CHUNK = 16;

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Splits a string in fixed-size pieces; an empty string yields no pieces. */
function chunkText(text: string, size: number): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size));
  return pieces;
}

export function anthropicSseBody(response: TurnResponse, options: SseBodyOptions = {}): string {
  const text = options.text ?? JSON.stringify(response);
  const chunk = Math.max(1, options.chunk ?? DEFAULT_CHUNK);
  const model = options.model ?? "claude-sonnet-5-5";
  const inputTokens = options.usage?.input_tokens ?? 900;
  const cacheRead = options.usage?.cache_read_input_tokens ?? 1500;
  const cacheWrite = options.usage?.cache_creation_input_tokens ?? 0;
  const outputTokens = options.usage?.output_tokens ?? Math.max(1, Math.ceil(text.length / 4));
  const stopDetails =
    options.stopDetails === undefined
      ? null
      : {
          type: "refusal",
          category: options.stopDetails.category,
          explanation: options.stopDetails.explanation,
        };

  const events: string[] = [
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_fake_0001",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 1,
          cache_creation_input_tokens: cacheWrite,
          cache_read_input_tokens: cacheRead,
          cache_creation: null,
          inference_geo: null,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: "standard",
        },
      },
    }),
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    }),
    sseEvent("ping", { type: "ping" }),
  ];
  for (const piece of chunkText(text, chunk)) {
    events.push(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: piece },
      }),
    );
  }
  events.push(sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
  events.push(
    sseEvent("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: options.stopReason ?? "end_turn",
        stop_sequence: null,
        stop_details: stopDetails,
        container: null,
      },
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
        output_tokens_details: null,
        server_tool_use: null,
      },
    }),
  );
  events.push(sseEvent("message_stop", { type: "message_stop" }));
  return events.join("");
}

/** An in-stream `event: error` the API sends when it fails after the headers (e.g. overloaded). */
export function anthropicSseError(type: string, message: string): string {
  return sseEvent("error", { type: "error", error: { type, message } });
}

/** The JSON body of a non-2xx Messages API response. */
export function anthropicErrorJson(type: string, message: string): string {
  return JSON.stringify({ type: "error", error: { type, message } });
}

/** The JSON body of `GET /v1/models`. */
export function anthropicModelsJson(ids: readonly string[]): string {
  return JSON.stringify({
    data: ids.map((id) => ({
      id,
      type: "model",
      display_name: id,
      created_at: "2026-01-01T00:00:00Z",
      capabilities: null,
      max_input_tokens: null,
      max_tokens: null,
    })),
    first_id: ids[0] ?? null,
    last_id: ids[ids.length - 1] ?? null,
    has_more: false,
  });
}

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  /** Parsed JSON body, or null when the request had none. */
  readonly body: unknown;
}

export interface MockFetchInit {
  readonly status?: number;
  readonly headers?: Record<string, string>;
}

export type RecordingFetch = typeof fetch & { readonly calls: RecordedCall[] };

function bodyAsJson(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string" || init.body === "") return null;
  try {
    return JSON.parse(init.body);
  } catch {
    return init.body;
  }
}

function toRecordingFetch(
  calls: RecordedCall[],
  respond: (call: RecordedCall, init: RequestInit | undefined) => Response,
): RecordingFetch {
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: bodyAsJson(init),
    };
    calls.push(call);
    return respond(call, init);
  };
  return Object.assign(impl as typeof fetch, { calls });
}

/**
 * A fetch that answers every request with `body`. Default status 200 and content type
 * `text/event-stream`; pass `headers["content-type"]` to answer with JSON (errors, models).
 * The returned function records its calls (`fetch.calls`) so tests can inspect the body sent.
 */
export function mockFetchFor(
  body: string | ReadableStream<Uint8Array>,
  init: MockFetchInit = {},
): RecordingFetch {
  const calls: RecordedCall[] = [];
  return toRecordingFetch(calls, (_call, requestInit) => {
    const headers = new Headers({ "content-type": "text/event-stream", ...init.headers });
    const responseBody = typeof body === "string" ? body : abortableBody(body, requestInit?.signal ?? null);
    return new Response(responseBody, { status: init.status ?? 200, headers });
  });
}

/**
 * Like a real fetch body: a pending read rejects when the request signal aborts. A plain
 * ReadableStream would ignore the signal and keep the SDK waiting forever.
 */
function abortableBody(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal | null,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const fail = (): void => controller.error(signal?.reason ?? new DOMException("aborted", "AbortError"));
      if (signal?.aborted) fail();
      else signal?.addEventListener("abort", fail, { once: true });
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: () => reader.cancel(),
  });
}

/** A body that sends `head` and then stays open forever (for the inactivity watchdog). */
export function stalledSseBody(head: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(head));
    },
  });
}
