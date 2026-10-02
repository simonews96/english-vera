import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnResponse } from "../../src/core/turn/schema";
import { TURN_JSON_SCHEMA } from "../../src/core/turn/schema";
import { createClaudeClient, STALL_TIMEOUT_MS } from "../../src/llm/client";
import { PRESETS } from "../../src/llm/presets";
import type { LlmStreamEvent, LlmTurnRequest, ModelPreset } from "../../src/llm/types";
import {
  anthropicErrorJson,
  anthropicModelsJson,
  anthropicSseBody,
  anthropicSseError,
  mockFetchFor,
  stalledSseBody,
} from "../helpers/llm-sse";

const REPLY: TurnResponse = {
  segments: [
    { lang: "IT", kind: "SAY", text: "Quasi. Ascolta:" },
    { lang: "EN", kind: "MODEL", text: "Could I have the bill, please?" },
  ],
  listen: { lang: "EN", expect: "REPEAT", target: "Could I have the bill, please?" },
  correction: { heard: "can I have bill", correct: "Could I have the bill", note_it: "manca 'the'" },
  items: [{ kind: "PHRASE", id: "bill-please", signal: "HARD" }],
  learned: [],
  about_learner: [],
  goal: null,
  closing: null,
};
const JSON_TEXT = JSON.stringify(REPLY);
const JSON_HEADERS = { "content-type": "application/json" };

function request(preset: ModelPreset = PRESETS["sonnet-between-tools"]): LlmTurnRequest {
  return {
    systemStable: "You are Vera.",
    learnerCard: "[scheda] livello A0, fase: warmup",
    history: [
      { role: "user", text: "hello" },
      { role: "assistant", text: "Ciao! Hello!" },
    ],
    userText: "can I have bill",
    preset,
  };
}

async function collect(events: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function lastError(events: LlmStreamEvent[]) {
  const last = events[events.length - 1];
  if (last?.type !== "error") throw new Error(`expected an error event, got ${JSON.stringify(last)}`);
  return last.error;
}

function sentBody(fetch: ReturnType<typeof mockFetchFor>): Record<string, unknown> {
  const body = fetch.calls[0]?.body;
  if (typeof body !== "object" || body === null) throw new Error("no JSON body sent");
  return body as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createClaudeClient.stream", () => {
  it("yields text deltas in order, cumulative usage and a done event with the full JSON", async () => {
    const fetch = mockFetchFor(
      anthropicSseBody(REPLY, {
        chunk: 7,
        usage: {
          input_tokens: 420,
          cache_read_input_tokens: 1800,
          cache_creation_input_tokens: 0,
          output_tokens: 95,
        },
      }),
    );
    const client = createClaudeClient({ apiKey: "sk-ant-test", fetch });
    const events = await collect(client.stream(request()));

    expect(events[0]).toEqual({
      type: "usage",
      usage: { inputTokens: 420, outputTokens: 1, cacheReadTokens: 1800, cacheWriteTokens: 0 },
    });
    const text = events.flatMap((e) => (e.type === "text" ? [e.delta] : []));
    expect(text.length).toBeGreaterThan(5);
    expect(text.join("")).toBe(JSON_TEXT);
    const usages = events.flatMap((e) => (e.type === "usage" ? [e.usage] : []));
    expect(usages[usages.length - 1]).toEqual({
      inputTokens: 420,
      outputTokens: 95,
      cacheReadTokens: 1800,
      cacheWriteTokens: 0,
    });
    const done = events[events.length - 1];
    expect(done).toEqual({
      type: "done",
      stopReason: "end_turn",
      usage: { inputTokens: 420, outputTokens: 95, cacheReadTokens: 1800, cacheWriteTokens: 0 },
      fullText: JSON_TEXT,
    });
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
  });

  it("sends the cached system block, the schema, the preset thinking and the card in the last user message", async () => {
    const fetch = mockFetchFor(anthropicSseBody(REPLY));
    const client = createClaudeClient({ apiKey: "sk-ant-test", fetch });
    await collect(client.stream(request()));

    const call = fetch.calls[0];
    expect(call?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call?.headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(call?.headers.get("x-api-key")).toBe("sk-ant-test");
    const body = sentBody(fetch);
    expect(body).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 1536,
      stream: true,
      system: [{ type: "text", text: "You are Vera.", cache_control: { type: "ephemeral" } }],
      thinking: { type: "between_tools" },
      output_config: { effort: "low", format: { type: "json_schema", schema: TURN_JSON_SCHEMA } },
    });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "Ciao! Hello!" },
      { role: "user", content: "[scheda] livello A0, fase: warmup\n\ncan I have bill" },
    ]);
  });

  it("omits thinking for haiku and effort when the preset has none; adaptive preset carries display", async () => {
    const haikuFetch = mockFetchFor(anthropicSseBody(REPLY));
    await collect(createClaudeClient({ apiKey: "k", fetch: haikuFetch }).stream(request(PRESETS.haiku)));
    const haiku = sentBody(haikuFetch);
    expect(haiku.model).toBe("claude-haiku-4-5");
    expect(haiku).not.toHaveProperty("thinking");
    expect(haiku.output_config).toEqual({ format: { type: "json_schema", schema: TURN_JSON_SCHEMA } });

    const opusFetch = mockFetchFor(anthropicSseBody(REPLY));
    await collect(createClaudeClient({ apiKey: "k", fetch: opusFetch }).stream(request(PRESETS.opus)));
    const opus = sentBody(opusFetch);
    expect(opus).not.toHaveProperty("thinking");
    expect(opus.output_config).toMatchObject({ effort: "low" });

    const adaptiveFetch = mockFetchFor(anthropicSseBody(REPLY));
    await collect(
      createClaudeClient({ apiKey: "k", fetch: adaptiveFetch }).stream(
        request(PRESETS["sonnet-adaptive-low"]),
      ),
    );
    expect(sentBody(adaptiveFetch).thinking).toEqual({ type: "adaptive", display: "omitted" });
  });

  it("turns a refusal into an error event after the usage, never a done", async () => {
    const fetch = mockFetchFor(
      anthropicSseBody(REPLY, {
        text: "",
        stopReason: "refusal",
        stopDetails: { category: "general_harms", explanation: "declined" },
        usage: { output_tokens: 3 },
      }),
    );
    const events = await collect(createClaudeClient({ apiKey: "k", fetch }).stream(request()));
    expect(events.some((e) => e.type === "done")).toBe(false);
    const error = lastError(events);
    expect(error.kind).toBe("refusal");
    expect(error.message).toContain("declined");
    const beforeError = events[events.length - 2];
    expect(beforeError).toMatchObject({ type: "usage", usage: { outputTokens: 3 } });
  });

  it("turns max_tokens into an error event and keeps the partial text out of done", async () => {
    const partial = JSON_TEXT.slice(0, 40);
    const fetch = mockFetchFor(anthropicSseBody(REPLY, { text: partial, stopReason: "max_tokens" }));
    const events = await collect(createClaudeClient({ apiKey: "k", fetch }).stream(request()));
    expect(events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("")).toBe(partial);
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(lastError(events).kind).toBe("max-tokens");
  });

  it("maps HTTP errors before the stream starts", async () => {
    const cases: Array<[number, string, string, Record<string, string>, string, number | undefined]> = [
      [401, "authentication_error", "invalid x-api-key", {}, "invalid-key", undefined],
      [
        401,
        "authentication_error",
        "CORS requests are not allowed for this Organization because of its settings.",
        {},
        "zdr-cors",
        undefined,
      ],
      [
        400,
        "invalid_request_error",
        "You have reached your specified API usage limits.",
        {},
        "spend-limit",
        undefined,
      ],
      [429, "rate_limit_error", "Rate limited", { "retry-after": "12" }, "rate-limited", 12_000],
      [429, "rate_limit_error", "enforced_spend_limit_reached", {}, "spend-limit", undefined],
      [529, "overloaded_error", "Overloaded", {}, "overloaded", undefined],
      [500, "api_error", "Internal server error", {}, "server", undefined],
    ];
    for (const [status, type, message, headers, kind, retryAfterMs] of cases) {
      const fetch = mockFetchFor(anthropicErrorJson(type, message), {
        status,
        headers: { ...JSON_HEADERS, ...headers },
      });
      const events = await collect(createClaudeClient({ apiKey: "k", fetch }).stream(request()));
      expect(events).toHaveLength(1);
      const error = lastError(events);
      expect(error.kind, `${status} ${message}`).toBe(kind);
      expect(error.status).toBe(status);
      expect(error.retryAfterMs).toBe(retryAfterMs);
      expect(error.message).not.toContain("sk-ant");
    }
  });

  it("maps an in-stream overloaded error and keeps the usage already received", async () => {
    const head = anthropicSseBody(REPLY).split("event: content_block_delta")[0] ?? "";
    const fetch = mockFetchFor(head + anthropicSseError("overloaded_error", "Overloaded"));
    const events = await collect(createClaudeClient({ apiKey: "k", fetch }).stream(request()));
    expect(events[0]?.type).toBe("usage");
    expect(lastError(events).kind).toBe("overloaded");
  });

  it("reports a network error when the body closes before message_stop", async () => {
    const cut = anthropicSseBody(REPLY).split("event: message_delta")[0] ?? "";
    const fetch = mockFetchFor(cut);
    const events = await collect(createClaudeClient({ apiKey: "k", fetch }).stream(request()));
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(lastError(events).kind).toBe("network");
  });

  it("honors the caller's abort signal", async () => {
    const controller = new AbortController();
    const fetch = mockFetchFor(
      stalledSseBody(anthropicSseBody(REPLY).split("event: content_block_stop")[0] ?? ""),
    );
    const client = createClaudeClient({ apiKey: "k", fetch });
    const events: LlmStreamEvent[] = [];
    for await (const event of client.stream(request(), controller.signal)) {
      events.push(event);
      if (event.type === "text") controller.abort();
    }
    const error = lastError(events);
    expect(error.kind).toBe("network");
    expect(error.message).toBe("aborted");
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("fires the inactivity watchdog on a stalled stream", async () => {
    vi.useFakeTimers();
    let clock = 1_000_000;
    vi.setSystemTime(clock);
    const head = anthropicSseBody(REPLY, { chunk: 1000 }).split("event: content_block_stop")[0] ?? "";
    const fetch = mockFetchFor(stalledSseBody(head));
    const client = createClaudeClient({ apiKey: "k", fetch, now: () => clock });
    const events: LlmStreamEvent[] = [];
    const consumed = (async () => {
      for await (const event of client.stream(request())) events.push(event);
    })();

    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS - 1);
    expect(events.map((e) => e.type)).toEqual(["usage", "text"]);
    clock += STALL_TIMEOUT_MS;
    await vi.advanceTimersByTimeAsync(2);
    await consumed;

    const error = lastError(events);
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("8 s");
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("does not fire the watchdog while events keep flowing", async () => {
    vi.useFakeTimers();
    const fetch = mockFetchFor(anthropicSseBody(REPLY, { chunk: 4 }));
    const client = createClaudeClient({ apiKey: "k", fetch });
    const events: LlmStreamEvent[] = [];
    const consumed = (async () => {
      for await (const event of client.stream(request())) events.push(event);
    })();
    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS * 2);
    await consumed;
    expect(events[events.length - 1]?.type).toBe("done");
  });
});

describe("createClaudeClient.validateKey", () => {
  it("returns the model ids on 200", async () => {
    const fetch = mockFetchFor(anthropicModelsJson(["claude-sonnet-5-5", "claude-haiku-4-5"]), {
      headers: JSON_HEADERS,
    });
    const result = await createClaudeClient({ apiKey: "sk-ant-x", fetch }).validateKey();
    expect(result).toEqual({ ok: true, models: ["claude-sonnet-5-5", "claude-haiku-4-5"] });
    const call = fetch.calls[0];
    expect(call?.method).toBe("GET");
    expect(call?.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models(\?|$)/);
    expect(call?.headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
  });

  it("returns the mapped error on 401", async () => {
    const fetch = mockFetchFor(anthropicErrorJson("authentication_error", "invalid x-api-key"), {
      status: 401,
      headers: JSON_HEADERS,
    });
    const result = await createClaudeClient({ apiKey: "bad", fetch }).validateKey();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid-key");
  });
});

describe("createClaudeClient.warmUp", () => {
  it("sends a minimal non-streaming request with the schema and swallows errors", async () => {
    const fetch = mockFetchFor(anthropicErrorJson("overloaded_error", "Overloaded"), {
      status: 529,
      headers: JSON_HEADERS,
    });
    await expect(
      createClaudeClient({ apiKey: "k", fetch }).warmUp(PRESETS["sonnet-between-tools"]),
    ).resolves.toBeUndefined();
    const body = sentBody(fetch);
    expect(body).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 1,
      thinking: { type: "between_tools" },
      output_config: { effort: "low", format: { type: "json_schema", schema: TURN_JSON_SCHEMA } },
      messages: [{ role: "user", content: "ok" }],
    });
    expect(body).not.toHaveProperty("stream");
  });
});
