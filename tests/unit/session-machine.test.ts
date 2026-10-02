import { describe, expect, it } from "vitest";
import { createSessionMachine } from "../../src/core/session/machine";
import type { Effect, SessionMachine, SessionSnapshot } from "../../src/core/session/types";
import type { Lang, Segment, TurnResponse } from "../../src/core/turn/schema";
import { EMPTY_USAGE, LlmError } from "../../src/llm/types";

const SEGMENTS: readonly Segment[] = [
  { lang: "IT", kind: "SAY", text: "Bene. Ora dilla tu:" },
  { lang: "EN", kind: "MODEL", text: "Could I have the bill, please?" },
  { lang: "EN", kind: "ASK", text: "Your turn." },
];

function response(listenLang: Lang = "EN", segments: readonly Segment[] = SEGMENTS): TurnResponse {
  return {
    segments,
    listen: { lang: listenLang, expect: "REPEAT", target: "Could I have the bill, please?" },
    correction: null,
    items: [],
    learned: [],
    about_learner: [],
    goal: null,
    closing: null,
  };
}

function machine(initial?: Partial<{ now: number; variant: "en-GB" | "en-US" }>): {
  m: SessionMachine;
  clock: { now: number };
} {
  const clock = { now: initial?.now ?? 1000 };
  const m = createSessionMachine({ now: () => clock.now, englishVariant: initial?.variant ?? "en-GB" });
  return { m, clock };
}

function types(effects: readonly Effect[]): string[] {
  return effects.map((e) => e.type);
}

function started(mode: "handsfree" | "push" = "handsfree"): { m: SessionMachine; clock: { now: number } } {
  const { m, clock } = machine();
  m.dispatch({ type: "SETUP_DONE" });
  m.dispatch({ type: "START", mode });
  return { m, clock };
}

/** Streams a full reply segment by segment and lets the voice speak everything. */
function runReply(m: SessionMachine, res: TurnResponse): Effect[] {
  const all: Effect[] = [];
  res.segments.forEach((segment, index) => {
    all.push(...m.dispatch({ type: "LLM_SEGMENT", segment, index, atMs: 2000 + index }).effects);
  });
  all.push(...m.dispatch({ type: "LLM_DONE", response: res, usage: EMPTY_USAGE, atMs: 2500 }).effects);
  for (let i = 0; i < res.segments.length; i += 1) {
    all.push(...m.dispatch({ type: "SPEAK_START", index: i, atMs: 2600 + i }).effects);
    all.push(...m.dispatch({ type: "SPEAK_DONE", index: i, outcome: "ended" }).effects);
  }
  return all;
}

describe("session machine: setup and modes", () => {
  it("starts in setup, goes idle on SETUP_DONE, listens on handsfree START", () => {
    const { m } = machine();
    expect(m.snapshot.state).toBe("setup");
    expect(m.dispatch({ type: "START", mode: "handsfree" }).snapshot.state).toBe("setup");
    expect(m.dispatch({ type: "SETUP_DONE" }).snapshot.state).toBe("idle");
    const r = m.dispatch({ type: "START", mode: "handsfree" });
    expect(r.snapshot.state).toBe("listening");
    expect(r.snapshot.mode).toBe("handsfree");
    expect(r.effects).toEqual([{ type: "listen", lang: "it-IT", mode: "continuous" }]);
  });

  it("push mode: START stays idle, PRESS listens one utterance, RELEASE stops gracefully", () => {
    const { m } = machine();
    m.dispatch({ type: "SETUP_DONE" });
    const start = m.dispatch({ type: "START", mode: "push" });
    expect(start.snapshot.state).toBe("idle");
    expect(start.snapshot.mode).toBe("push");
    expect(start.effects).toEqual([]);
    const press = m.dispatch({ type: "PRESS" });
    expect(press.snapshot.state).toBe("listening");
    expect(press.effects).toEqual([{ type: "listen", lang: "it-IT", mode: "utterance" }]);
    const release = m.dispatch({ type: "RELEASE" });
    expect(release.snapshot.state).toBe("listening");
    expect(release.effects).toEqual([{ type: "stopListening" }]);
    // The final arrives after the release, then the reply; push mode ends the turn idle.
    m.dispatch({ type: "FINAL", text: "I would like a coffee" });
    expect(m.snapshot.state).toBe("thinking");
    const effects = runReply(m, response());
    expect(types(effects)).toContain("commitTurn");
    expect(m.snapshot.state).toBe("idle");
    expect(m.snapshot.turnsCompleted).toBe(1);
  });

  it("STOP from any state goes idle, aborts and cancels, clears the mode", () => {
    const { m } = started();
    m.dispatch({ type: "FINAL", text: "hello" });
    m.dispatch({ type: "LLM_SEGMENT", segment: SEGMENTS[0] as Segment, index: 0, atMs: 1 });
    expect(m.snapshot.state).toBe("speaking");
    const r = m.dispatch({ type: "STOP" });
    expect(r.snapshot.state).toBe("idle");
    expect(r.snapshot.mode).toBeNull();
    expect(r.effects).toEqual([{ type: "abortListening" }, { type: "cancelSpeech" }]);
    // Late stream events after STOP are ignored.
    const late = m.dispatch({ type: "LLM_DONE", response: response(), usage: EMPTY_USAGE, atMs: 9 });
    expect(late.effects).toEqual([]);
    expect(late.snapshot.state).toBe("idle");
  });
});

describe("session machine: handsfree happy path", () => {
  it("runs a full turn and relistens in the language the reply asks for", () => {
    const { m, clock } = started();
    clock.now = 5000;
    m.dispatch({ type: "INPUT_START" });
    const interim = m.dispatch({ type: "INTERIM", text: "I would" });
    expect(interim.snapshot.interim).toBe("I would");

    const final = m.dispatch({ type: "FINAL", text: "I would like a coffee" });
    expect(final.snapshot.state).toBe("thinking");
    expect(final.snapshot.transcript).toBe("I would like a coffee");
    expect(final.snapshot.interim).toBe("");
    expect(final.snapshot.turnStartedAtMs).toBe(5000);
    expect(final.effects).toEqual([
      { type: "abortListening" },
      { type: "callLlm", userText: "I would like a coffee" },
    ]);

    expect(m.dispatch({ type: "LLM_FIRST_TOKEN", atMs: 5300 }).snapshot.timings.firstTokenMs).toBe(300);

    const seg0 = m.dispatch({ type: "LLM_SEGMENT", segment: SEGMENTS[0] as Segment, index: 0, atMs: 5600 });
    expect(seg0.snapshot.state).toBe("speaking");
    expect(seg0.snapshot.timings.firstSegmentMs).toBe(600);
    expect(seg0.effects).toEqual([{ type: "speak", segment: SEGMENTS[0], index: 0, rate: 1 }]);

    // A second segment while the first is in flight waits.
    const seg1 = m.dispatch({ type: "LLM_SEGMENT", segment: SEGMENTS[1] as Segment, index: 1, atMs: 5700 });
    expect(seg1.effects).toEqual([]);
    expect(seg1.snapshot.segments).toHaveLength(2);

    expect(m.dispatch({ type: "SPEAK_START", index: 0, atMs: 5800 }).snapshot.timings.firstAudioMs).toBe(800);
    const done0 = m.dispatch({ type: "SPEAK_DONE", index: 0, outcome: "ended" });
    expect(done0.snapshot.spokenUpTo).toBe(0);
    expect(done0.effects).toEqual([{ type: "speak", segment: SEGMENTS[1], index: 1, rate: 1 }]);

    m.dispatch({ type: "LLM_SEGMENT", segment: SEGMENTS[2] as Segment, index: 2, atMs: 5900 });
    const res = response("IT");
    const llmDone = m.dispatch({ type: "LLM_DONE", response: res, usage: EMPTY_USAGE, atMs: 6000 });
    expect(llmDone.effects).toEqual([]);
    expect(llmDone.snapshot.state).toBe("speaking");
    expect(llmDone.snapshot.listenLang).toBe("it-IT");
    expect(llmDone.snapshot.lastResponse).toBe(res);

    const done1 = m.dispatch({ type: "SPEAK_DONE", index: 1, outcome: "ended" });
    expect(done1.effects).toEqual([{ type: "speak", segment: SEGMENTS[2], index: 2, rate: 1 }]);
    const done2 = m.dispatch({ type: "SPEAK_DONE", index: 2, outcome: "ended" });
    expect(done2.effects).toEqual([
      {
        type: "commitTurn",
        response: res,
        usage: EMPTY_USAGE,
        timings: { firstTokenMs: 300, firstSegmentMs: 600, firstAudioMs: 800 },
      },
      { type: "listen", lang: "it-IT", mode: "continuous" },
    ]);
    expect(done2.snapshot.state).toBe("listening");
    expect(done2.snapshot.turnsCompleted).toBe(1);
    // Segments stay visible until the next turn starts.
    expect(done2.snapshot.segments).toHaveLength(3);
    const next = m.dispatch({ type: "FINAL", text: "Vorrei un caffè" });
    expect(next.snapshot.segments).toEqual([]);
    expect(next.snapshot.spokenUpTo).toBe(-1);
    expect(next.snapshot.timings).toEqual({});
  });

  it("maps EN to the configured English variant", () => {
    const { m } = machine({ variant: "en-US" });
    m.dispatch({ type: "SETUP_DONE" });
    m.dispatch({ type: "START", mode: "handsfree" });
    m.dispatch({ type: "FINAL", text: "hello" });
    runReply(m, response("EN"));
    expect(m.snapshot.listenLang).toBe("en-US");
  });

  it("ignores empty or whitespace input and stays listening", () => {
    const { m } = started();
    const r = m.dispatch({ type: "FINAL", text: "   " });
    expect(r.snapshot.state).toBe("listening");
    expect(r.effects).toEqual([]);
  });

  it("accepts TEXT_SUBMIT at rest (text mode) and finishes idle", () => {
    const { m } = machine();
    m.dispatch({ type: "SETUP_DONE" });
    const r = m.dispatch({ type: "TEXT_SUBMIT", text: "hello" });
    expect(r.snapshot.state).toBe("thinking");
    expect(types(r.effects)).toEqual(["abortListening", "callLlm"]);
    runReply(m, response());
    expect(m.snapshot.state).toBe("idle");
    expect(m.snapshot.turnsCompleted).toBe(1);
  });
});

describe("session machine: ordering of segments and LLM_DONE", () => {
  it("reconciles segments that arrive only with LLM_DONE", () => {
    const { m } = started();
    m.dispatch({ type: "FINAL", text: "hello" });
    const res = response();
    const done = m.dispatch({ type: "LLM_DONE", response: res, usage: EMPTY_USAGE, atMs: 2000 });
    expect(done.snapshot.state).toBe("speaking");
    expect(done.snapshot.segments).toEqual(SEGMENTS);
    expect(done.effects).toEqual([{ type: "speak", segment: SEGMENTS[0], index: 0, rate: 1 }]);
    m.dispatch({ type: "SPEAK_DONE", index: 0, outcome: "ended" });
    m.dispatch({ type: "SPEAK_DONE", index: 1, outcome: "ended" });
    const last = m.dispatch({ type: "SPEAK_DONE", index: 2, outcome: "ended" });
    expect(types(last.effects)).toEqual(["commitTurn", "listen"]);
  });

  it("waits when the voice finishes before the LLM, then commits on LLM_DONE", () => {
    const { m } = started();
    m.dispatch({ type: "FINAL", text: "hello" });
    m.dispatch({ type: "LLM_SEGMENT", segment: SEGMENTS[0] as Segment, index: 0, atMs: 1 });
    const done0 = m.dispatch({ type: "SPEAK_DONE", index: 0, outcome: "ended" });
    expect(done0.effects).toEqual([]);
    expect(done0.snapshot.state).toBe("speaking");
    const res = response("EN", [SEGMENTS[0] as Segment]);
    const done = m.dispatch({ type: "LLM_DONE", response: res, usage: EMPTY_USAGE, atMs: 2 });
    expect(types(done.effects)).toEqual(["commitTurn", "listen"]);
    expect(done.snapshot.state).toBe("listening");
    expect(done.snapshot.listenLang).toBe("en-GB");
  });

  it("commits a reply with no segments immediately", () => {
    const { m } = started();
    m.dispatch({ type: "FINAL", text: "hello" });
    const done = m.dispatch({ type: "LLM_DONE", response: response("EN", []), usage: EMPTY_USAGE, atMs: 2 });
    expect(types(done.effects)).toEqual(["commitTurn", "listen"]);
  });

  it("ignores stale SPEAK_DONE for an index not in flight", () => {
    const { m } = started();
    m.dispatch({ type: "FINAL", text: "hello" });
    m.dispatch({ type: "LLM_SEGMENT", segment: SEGMENTS[0] as Segment, index: 0, atMs: 1 });
    const stale = m.dispatch({ type: "SPEAK_DONE", index: 5, outcome: "ended" });
    expect(stale.effects).toEqual([]);
    expect(stale.snapshot.spokenUpTo).toBe(-1);
  });
});

describe("session machine: interruptions", () => {
  it("INTERRUPT while speaking cancels and relistens (handsfree)", () => {
    const { m } = started();
    m.dispatch({ type: "FINAL", text: "hello" });
    m.dispatch({ type: "LLM_SEGMENT", segment: SEGMENTS[0] as Segment, index: 0, atMs: 1 });
    const r = m.dispatch({ type: "INTERRUPT" });
    expect(r.effects).toEqual([
      { type: "cancelSpeech" },
      { type: "listen", lang: "it-IT", mode: "continuous" },
    ]);
    expect(r.snapshot.state).toBe("listening");
    // The cancelled utterance reports back; nothing else happens.
    const cancelled = m.dispatch({ type: "SPEAK_DONE", index: 0, outcome: "cancelled" });
    expect(cancelled.effects).toEqual([]);
    expect(cancelled.snapshot.state).toBe("listening");
  });

  it("INTERRUPT never aborts the request: the turn is still committed when LLM_DONE arrives", () => {
    const { m } = started();
    m.dispatch({ type: "FINAL", text: "hello" });
    m.dispatch({ type: "LLM_SEGMENT", segment: SEGMENTS[0] as Segment, index: 0, atMs: 1 });
    m.dispatch({ type: "INTERRUPT" });
    m.dispatch({ type: "SPEAK_DONE", index: 0, outcome: "cancelled" });
    const seg1 = m.dispatch({ type: "LLM_SEGMENT", segment: SEGMENTS[1] as Segment, index: 1, atMs: 2 });
    expect(seg1.effects).toEqual([]);
    const res = response("EN");
    const done = m.dispatch({ type: "LLM_DONE", response: res, usage: EMPTY_USAGE, atMs: 3 });
    expect(types(done.effects)).toEqual(["commitTurn", "listen"]);
    expect(done.effects[1]).toEqual({ type: "listen", lang: "en-GB", mode: "continuous" });
    expect(done.snapshot.state).toBe("listening");
    expect(done.snapshot.turnsCompleted).toBe(1);
    expect(done.snapshot.segments).toEqual(SEGMENTS);
  });

  it("INTERRUPT in thinking or listening is ignored", () => {
    const { m } = started();
    expect(m.dispatch({ type: "INTERRUPT" }).effects).toEqual([]);
    m.dispatch({ type: "FINAL", text: "hello" });
    const r = m.dispatch({ type: "INTERRUPT" });
    expect(r.effects).toEqual([]);
    expect(r.snapshot.state).toBe("thinking");
  });

  it("INTERRUPT in push mode goes idle", () => {
    const { m } = started("push");
    m.dispatch({ type: "PRESS" });
    m.dispatch({ type: "FINAL", text: "hello" });
    m.dispatch({ type: "LLM_SEGMENT", segment: SEGMENTS[0] as Segment, index: 0, atMs: 1 });
    const r = m.dispatch({ type: "INTERRUPT" });
    expect(r.effects).toEqual([{ type: "cancelSpeech" }]);
    expect(r.snapshot.state).toBe("idle");
  });
});

describe("session machine: errors", () => {
  it("LLM_ERROR enters error with an Italian message; RETRY resends the same text", () => {
    const { m } = started();
    m.dispatch({ type: "FINAL", text: "I would like a coffee" });
    const err = m.dispatch({ type: "LLM_ERROR", error: new LlmError("timeout", "boom") });
    expect(err.snapshot.state).toBe("error");
    expect(err.snapshot.lastError).toEqual({ message: "Filo spezzato: nessuna risposta", kind: "timeout" });
    expect(err.effects).toEqual([
      { type: "abortListening" },
      { type: "notify", level: "error", message: "Filo spezzato: nessuna risposta" },
    ]);
    const retry = m.dispatch({ type: "RETRY" });
    expect(retry.snapshot.state).toBe("thinking");
    expect(retry.snapshot.lastError).toBeNull();
    expect(retry.effects).toEqual([
      { type: "abortListening" },
      { type: "callLlm", userText: "I would like a coffee" },
    ]);
  });

  it("RETRY keeps the help flag of the failed request", () => {
    const { m } = started();
    m.dispatch({ type: "FINAL", text: "come si dice grazie" });
    m.dispatch({ type: "LLM_ERROR", error: new LlmError("server", "500", { status: 500 }) });
    const retry = m.dispatch({ type: "RETRY" });
    expect(retry.effects).toContainEqual({ type: "callLlm", userText: "grazie", help: "HOW_TO_SAY" });
  });

  it("formats the rate-limited message with the retry delay", () => {
    const { m } = started();
    m.dispatch({ type: "FINAL", text: "hello" });
    const err = m.dispatch({
      type: "LLM_ERROR",
      error: new LlmError("rate-limited", "429", { status: 429, retryAfterMs: 4200 }),
    });
    expect(err.snapshot.lastError?.message).toBe("Troppe richieste, riprovo tra 5 s");
    const unknown = m.dispatch({ type: "STOP" });
    expect(unknown.snapshot.state).toBe("idle");
    expect(unknown.snapshot.lastError).toBeNull();
  });

  it("STOP from error goes idle", () => {
    const { m } = started();
    m.dispatch({ type: "FINAL", text: "hello" });
    m.dispatch({ type: "LLM_ERROR", error: new LlmError("invalid-key", "401") });
    expect(m.dispatch({ type: "STOP" }).snapshot.state).toBe("idle");
  });

  it("recognizer errors: no-speech stays listening, not-allowed stops with a message", () => {
    const { m } = started();
    const noSpeech = m.dispatch({ type: "INPUT_ERROR", code: "no-speech", message: "" });
    expect(noSpeech.snapshot.state).toBe("listening");
    expect(noSpeech.effects).toEqual([]);
    const aborted = m.dispatch({ type: "INPUT_ERROR", code: "aborted", message: "" });
    expect(aborted.snapshot.state).toBe("listening");
    const denied = m.dispatch({ type: "INPUT_ERROR", code: "not-allowed", message: "" });
    expect(denied.snapshot.state).toBe("error");
    expect(denied.snapshot.lastError?.kind).toBe("not-allowed");
    expect(denied.effects).toEqual([
      { type: "abortListening" },
      {
        type: "notify",
        level: "error",
        message: "Microfono chiuso: consenti il microfono nel browser e riprova, oppure scrivi",
      },
    ]);
    // RETRY after a recognizer error reopens the microphone, it does not call the model.
    const retry = m.dispatch({ type: "RETRY" });
    expect(retry.snapshot.state).toBe("listening");
    expect(retry.effects).toEqual([{ type: "listen", lang: "it-IT", mode: "continuous" }]);
  });

  it.each([
    ["network", "Il riconoscimento ha bisogno di rete"],
    ["timeout", "Non ti sento: tocca per riprovare"],
    ["audio-capture", "Nessun microfono: controlla cuffie o Bluetooth"],
    ["language-not-supported", "Lingua non disponibile su questo dispositivo"],
  ] as const)("recognizer error %s notifies '%s'", (code, message) => {
    const { m } = started();
    const r = m.dispatch({ type: "INPUT_ERROR", code, message: "" });
    expect(r.snapshot.state).toBe("error");
    expect(r.effects).toContainEqual({ type: "notify", level: "error", message });
  });

  it("INPUT_END while listening (not our abort) goes idle with a hint", () => {
    const { m } = started();
    const own = m.dispatch({ type: "INPUT_END", cause: "own-abort" });
    expect(own.snapshot.state).toBe("listening");
    const gaveUp = m.dispatch({ type: "INPUT_END", cause: "silence" });
    expect(gaveUp.snapshot.state).toBe("idle");
    expect(gaveUp.effects).toEqual([
      { type: "notify", level: "info", message: "Non ti sento: tocca per riprovare" },
    ]);
    // Not listening: ignored.
    m.dispatch({ type: "TEXT_SUBMIT", text: "hello" });
    expect(m.dispatch({ type: "INPUT_END", cause: "silence" }).snapshot.state).toBe("thinking");
  });
});

describe("session machine: help", () => {
  function afterReply(): SessionMachine {
    const { m } = started();
    m.dispatch({ type: "FINAL", text: "hello" });
    runReply(m, response("EN"));
    expect(m.snapshot.state).toBe("listening");
    return m;
  }

  it("REPEAT re-speaks the whole reply from the top and relistens without committing again", () => {
    const m = afterReply();
    const r = m.dispatch({ type: "FINAL", text: "ripeti" });
    expect(r.snapshot.state).toBe("speaking");
    expect(r.snapshot.spokenUpTo).toBe(-1);
    expect(r.effects).toEqual([
      { type: "abortListening" },
      { type: "speak", segment: SEGMENTS[0], index: 0, rate: 1 },
    ]);
    m.dispatch({ type: "SPEAK_DONE", index: 0, outcome: "ended" });
    m.dispatch({ type: "SPEAK_DONE", index: 1, outcome: "ended" });
    const last = m.dispatch({ type: "SPEAK_DONE", index: 2, outcome: "ended" });
    expect(last.effects).toEqual([{ type: "listen", lang: "en-GB", mode: "continuous" }]);
    expect(last.snapshot.state).toBe("listening");
    expect(last.snapshot.turnsCompleted).toBe(1);
    expect(m.snapshot.transcript).toBe("hello");
  });

  it("SLOWER sets slow mode for the session and re-speaks at 0.8", () => {
    const m = afterReply();
    const r = m.dispatch({ type: "FINAL", text: "più lento" });
    expect(r.snapshot.slowMode).toBe(true);
    expect(r.effects).toContainEqual({ type: "speak", segment: SEGMENTS[0], index: 0, rate: 0.8 });
    const next = m.dispatch({ type: "SPEAK_DONE", index: 0, outcome: "ended" });
    expect(next.effects).toEqual([{ type: "speak", segment: SEGMENTS[1], index: 1, rate: 0.8 }]);
    // Slow mode persists into the next turn.
    m.dispatch({ type: "SPEAK_DONE", index: 1, outcome: "ended" });
    m.dispatch({ type: "SPEAK_DONE", index: 2, outcome: "ended" });
    m.dispatch({ type: "FINAL", text: "a coffee please" });
    const seg = m.dispatch({ type: "LLM_SEGMENT", segment: SEGMENTS[0] as Segment, index: 0, atMs: 1 });
    expect(seg.effects).toEqual([{ type: "speak", segment: SEGMENTS[0], index: 0, rate: 0.8 }]);
  });

  it("REPEAT while Vera is still speaking restarts from the top (cancel first)", () => {
    const { m } = started();
    m.dispatch({ type: "FINAL", text: "hello" });
    m.dispatch({ type: "LLM_SEGMENT", segment: SEGMENTS[0] as Segment, index: 0, atMs: 1 });
    m.dispatch({ type: "LLM_DONE", response: response(), usage: EMPTY_USAGE, atMs: 2 });
    m.dispatch({ type: "SPEAK_DONE", index: 0, outcome: "ended" });
    const r = m.dispatch({ type: "HELP", kind: "REPEAT" });
    expect(types(r.effects)).toEqual(["cancelSpeech", "speak"]);
    m.dispatch({ type: "SPEAK_DONE", index: 1, outcome: "cancelled" });
    m.dispatch({ type: "SPEAK_DONE", index: 0, outcome: "ended" });
    m.dispatch({ type: "SPEAK_DONE", index: 1, outcome: "ended" });
    const last = m.dispatch({ type: "SPEAK_DONE", index: 2, outcome: "ended" });
    // The turn had not been committed yet: it is committed exactly once, at the end.
    expect(types(last.effects)).toEqual(["commitTurn", "listen"]);
    expect(last.snapshot.turnsCompleted).toBe(1);
  });

  it("REPEAT with nothing to repeat only notifies", () => {
    const { m } = started();
    const r = m.dispatch({ type: "FINAL", text: "ripeti" });
    expect(r.snapshot.state).toBe("listening");
    expect(types(r.effects)).toEqual(["notify"]);
  });

  it("DIDNT_UNDERSTAND: first time re-speaks the last English segment slower, second time asks the model", () => {
    const m = afterReply();
    const first = m.dispatch({ type: "FINAL", text: "non o capito" });
    expect(first.snapshot.state).toBe("speaking");
    expect(first.effects).toEqual([
      { type: "abortListening" },
      { type: "speak", segment: SEGMENTS[1], index: 1, rate: 0.8 },
    ]);
    expect(first.snapshot.slowMode).toBe(false);
    const done = m.dispatch({ type: "SPEAK_DONE", index: 1, outcome: "ended" });
    expect(done.effects).toEqual([{ type: "listen", lang: "en-GB", mode: "continuous" }]);
    expect(done.snapshot.state).toBe("listening");

    const second = m.dispatch({ type: "FINAL", text: "non ho capito" });
    expect(second.snapshot.state).toBe("thinking");
    expect(second.effects).toEqual([
      { type: "abortListening" },
      { type: "callLlm", userText: "non ho capito", help: "DIDNT_UNDERSTAND" },
    ]);
    // A new reply resets the counter.
    runReply(m, response("EN"));
    const again = m.dispatch({ type: "FINAL", text: "non capisco" });
    expect(again.snapshot.state).toBe("speaking");
  });

  it("HOW_TO_SAY with payload asks the model directly", () => {
    const m = afterReply();
    const r = m.dispatch({ type: "FINAL", text: "come si dice il conto" });
    expect(r.snapshot.state).toBe("thinking");
    expect(r.effects).toEqual([
      { type: "abortListening" },
      { type: "callLlm", userText: "il conto", help: "HOW_TO_SAY" },
    ]);
    // The learner's transcript is not overwritten by the help request.
    expect(r.snapshot.transcript).toBe("hello");
  });

  it("HOW_TO_SAY without payload listens in Italian, then sends the next final as the request", () => {
    const m = afterReply();
    const r = m.dispatch({ type: "FINAL", text: "come si dice" });
    expect(r.snapshot.state).toBe("listening");
    expect(r.effects).toEqual([
      { type: "abortListening" },
      { type: "notify", level: "info", message: "Dimmelo in italiano" },
      { type: "listen", lang: "it-IT", mode: "utterance" },
    ]);
    expect(r.snapshot.listenLang).toBe("en-GB");
    const req = m.dispatch({ type: "FINAL", text: "il conto per favore" });
    expect(req.snapshot.state).toBe("thinking");
    expect(req.effects).toEqual([
      { type: "abortListening" },
      { type: "callLlm", userText: "il conto per favore", help: "HOW_TO_SAY" },
    ]);
    // Back to the expected language afterwards.
    runReply(m, response("EN"));
    expect(m.snapshot.state).toBe("listening");
    expect(m.snapshot.listenLang).toBe("en-GB");
  });

  it("the pending Italian request is dropped if the recognizer gives up", () => {
    const m = afterReply();
    m.dispatch({ type: "FINAL", text: "how do you say" });
    m.dispatch({ type: "INPUT_END", cause: "silence" });
    m.dispatch({ type: "START", mode: "handsfree" });
    const r = m.dispatch({ type: "FINAL", text: "il conto" });
    expect(r.effects).toContainEqual({ type: "callLlm", userText: "il conto" });
  });

  it("tapped HELP works while Vera is speaking", () => {
    const { m } = started();
    m.dispatch({ type: "FINAL", text: "hello" });
    runReply(m, response("EN"));
    m.dispatch({ type: "FINAL", text: "ripeti" });
    expect(m.snapshot.state).toBe("speaking");
    const r = m.dispatch({ type: "HELP", kind: "SLOWER" });
    expect(r.effects).toEqual([
      { type: "cancelSpeech" },
      { type: "speak", segment: SEGMENTS[0], index: 0, rate: 0.8 },
    ]);
  });
});

describe("session machine: immutability", () => {
  it("returns a new snapshot object on every change and never mutates the old one", () => {
    const { m } = started();
    const before: SessionSnapshot = m.snapshot;
    const r = m.dispatch({ type: "INTERIM", text: "ciao" });
    expect(r.snapshot).not.toBe(before);
    expect(before.interim).toBe("");
    expect(r.snapshot.interim).toBe("ciao");
    expect(m.snapshot).toBe(r.snapshot);
    const segmentsBefore = r.snapshot.segments;
    m.dispatch({ type: "FINAL", text: "hello" });
    m.dispatch({ type: "LLM_SEGMENT", segment: SEGMENTS[0] as Segment, index: 0, atMs: 1 });
    expect(segmentsBefore).toEqual([]);
    expect(m.snapshot.segments).toHaveLength(1);
  });
});
