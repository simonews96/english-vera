import { describe, expect, it } from "vitest";
import type { TurnResponse } from "../../src/core/turn/schema";
import { createFakeLlmClient } from "../../src/llm/fake";
import { PRESETS } from "../../src/llm/presets";
import { LlmError, type LlmStreamEvent, type LlmTurnRequest } from "../../src/llm/types";

const REPLY: TurnResponse = {
  segments: [
    { lang: "IT", kind: "SAY", text: "Bene." },
    { lang: "EN", kind: "MODEL", text: "I would like a coffee, please." },
  ],
  listen: { lang: "EN", expect: "REPEAT", target: "I would like a coffee, please." },
  correction: null,
  items: [],
  learned: [],
  about_learner: [],
  goal: null,
  closing: null,
};

const REQUEST: LlmTurnRequest = {
  systemStable: "system",
  learnerCard: "card",
  history: [],
  userText: "hello",
  preset: PRESETS["sonnet-between-tools"],
};

async function collect(events: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("fake LLM client", () => {
  it("streams the JSON in chunks and completes with the full text", async () => {
    const client = createFakeLlmClient({ replies: [REPLY], chunkSize: 10 });
    const events = await collect(client.stream(REQUEST));
    const json = JSON.stringify(REPLY);
    expect(events[0]?.type).toBe("usage");
    const text = events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.delta : ""));
    expect(text.every((piece) => piece.length <= 10)).toBe(true);
    expect(text.join("")).toBe(json);
    const last = events[events.length - 1];
    expect(last?.type).toBe("done");
    if (last?.type === "done") {
      expect(last.fullText).toBe(json);
      expect(last.stopReason).toBe("end_turn");
      expect(last.usage.outputTokens).toBeGreaterThan(0);
    }
    expect(client.requests).toEqual([REQUEST]);
  });

  it("emits a scripted error as an error event and reports exhaustion", async () => {
    const client = createFakeLlmClient({ replies: [new LlmError("overloaded", "busy")] });
    const first = await collect(client.stream(REQUEST));
    expect(first).toEqual([{ type: "error", error: expect.objectContaining({ kind: "overloaded" }) }]);
    const second = await collect(client.stream(REQUEST));
    expect(second[0]?.type).toBe("error");
    if (second[0]?.type === "error") expect(second[0].error.kind).toBe("unknown");
  });

  it("accepts a reply function and usage overrides", async () => {
    const client = createFakeLlmClient({
      replies: (request) => ({ ...REPLY, listen: { lang: "EN", expect: "FREE", target: request.userText } }),
      usage: { cacheWriteTokens: 1200 },
    });
    const events = await collect(client.stream(REQUEST));
    const done = events.find((e) => e.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(JSON.parse(done.fullText).listen.target).toBe("hello");
      expect(done.usage.cacheWriteTokens).toBe(1200);
    }
  });

  it("honors an abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createFakeLlmClient({ replies: [REPLY] });
    const events = await collect(client.stream(REQUEST, controller.signal));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", error: { kind: "network", message: "aborted" } });
  });

  it("validates the key and warms up without network", async () => {
    const client = createFakeLlmClient({ replies: [] });
    expect(await client.validateKey()).toEqual({ ok: true, models: ["claude-sonnet-5-5"] });
    await expect(client.warmUp(PRESETS.haiku)).resolves.toBeUndefined();
  });
});
