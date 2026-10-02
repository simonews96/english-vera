// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformInfo } from "../../src/platform/detect";
import type { SpeechInputEvent } from "../../src/voice/types";
import {
  createWebSpeechInput,
  IOS_SILENCE_TIMEOUT_MS,
  MAX_CONSECUTIVE_NO_SPEECH,
  MAX_RESTARTS_PER_MINUTE,
  SpeechInputStartError,
  START_WATCHDOG_MS,
} from "../../src/voice/web-speech-input";
import { createFakeRecognitionCtor, type FakeRecognitionRegistry } from "../helpers/voice-recognition-fake";

function platform(overrides: Partial<PlatformInfo> = {}): PlatformInfo {
  return {
    os: "windows",
    browser: "chrome",
    standalone: false,
    touch: false,
    hasSpeechRecognition: true,
    hasSpeechSynthesis: true,
    hasGetUserMedia: true,
    hasWakeLock: false,
    hasVibrate: false,
    hasMediaSession: false,
    prefersReducedMotion: false,
    prefersDark: false,
    userAgent: "test",
    ...overrides,
  };
}

const ANDROID = platform({ os: "android", browser: "chrome", touch: true });
const IOS = platform({ os: "ios", browser: "safari", touch: true });

function setup(
  options: { platform?: PlatformInfo; registry?: FakeRecognitionRegistry; document?: Document } = {},
) {
  const registry = options.registry ?? createFakeRecognitionCtor();
  const input = createWebSpeechInput({
    platform: options.platform ?? platform(),
    ctor: registry.ctor,
    document: options.document,
  });
  const events: SpeechInputEvent[] = [];
  input.subscribe((event) => events.push(event));
  const types = () => events.map((event) => event.type);
  const ends = () => events.flatMap((event) => (event.type === "end" ? [event.cause] : []));
  const errors = () => events.flatMap((event) => (event.type === "error" ? [event.code] : []));
  return { registry, input, events, types, ends, errors };
}

/** Starts a session and lets the engine report start; returns the start promise. */
function started(ctx: ReturnType<typeof setup>, mode: "utterance" | "continuous" = "continuous") {
  const promise = ctx.input.start({ lang: "en-GB", mode });
  ctx.registry.last.emitStart();
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createWebSpeechInput: instances and profiles", () => {
  it("creates a new recognizer per start, bound to the language, with the desktop profile", async () => {
    const ctx = setup();
    await started(ctx, "continuous");
    expect(ctx.registry.instances).toHaveLength(1);
    const first = ctx.registry.last;
    expect(first.lang).toBe("en-GB");
    expect(first.continuous).toBe(true);
    expect(first.interimResults).toBe(true);
    expect(first.maxAlternatives).toBe(3);
    expect(first.startCalls).toBe(1);
    expect(ctx.types()).toEqual(["start"]);

    const second = ctx.input.start({ lang: "it-IT", mode: "utterance" });
    expect(ctx.ends()).toEqual(["own-abort"]);
    expect(first.abortCalls).toBe(1);
    expect(ctx.registry.instances).toHaveLength(2);
    expect(ctx.registry.last).not.toBe(first);
    expect(ctx.registry.last.lang).toBe("it-IT");
    expect(ctx.registry.last.continuous).toBe(false);
    ctx.registry.last.emitStart();
    await second;
    expect(ctx.input.capabilities).toMatchObject({
      available: true,
      continuous: true,
      profile: "chrome-desktop",
    });
  });

  it("uses one-phrase sessions on phones and reports the platform profile", () => {
    const android = setup({ platform: ANDROID });
    void android.input.start({ lang: "en-US", mode: "continuous" }).catch(() => undefined);
    expect(android.registry.last.continuous).toBe(false);
    expect(android.input.capabilities).toMatchObject({ continuous: false, profile: "android" });

    const ios = setup({ platform: IOS });
    expect(ios.input.capabilities.profile).toBe("ios-safari");
    const standalone = setup({ platform: platform({ os: "ios", browser: "safari", standalone: true }) });
    expect(standalone.input.capabilities.profile).toBe("ios-standalone");
  });

  it("is unavailable without a constructor and rejects start", async () => {
    const input = createWebSpeechInput({ platform: platform(), ctor: null });
    const events: SpeechInputEvent[] = [];
    input.subscribe((event) => events.push(event));
    expect(input.capabilities).toMatchObject({ available: false, profile: "unsupported" });
    await expect(input.start({ lang: "en-GB", mode: "utterance" })).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(events).toEqual([{ type: "error", code: "unsupported", message: expect.any(String) }]);
  });
});

describe("createWebSpeechInput: results", () => {
  it("reads only results from resultIndex, emits interim then final with alternatives", async () => {
    const ctx = setup();
    await started(ctx);
    const rec = ctx.registry.last;
    rec.emitResult([{ transcript: " hello ", isFinal: false }], 0);
    rec.emitResult(
      [{ transcript: "hello world", isFinal: true, confidence: 0.8, alternatives: ["hello word"] }],
      0,
    );
    // Second phrase: the engine keeps the first result in the list; only index 1 changed.
    rec.emitResult(
      [
        { transcript: "hello world", isFinal: true },
        { transcript: "how are", isFinal: false },
      ],
      1,
    );
    rec.emitResult(
      [
        { transcript: "hello world", isFinal: true },
        {
          transcript: "how are you",
          isFinal: true,
          confidence: 0.6,
          alternatives: ["how are u", "how are you"],
        },
      ],
      1,
    );
    expect(ctx.events.slice(1)).toEqual([
      { type: "interim", text: "hello" },
      { type: "final", text: "hello world", confidence: 0.8, alternatives: ["hello word"] },
      { type: "interim", text: "how are" },
      { type: "final", text: "how are you", confidence: 0.6, alternatives: ["how are u"] },
    ]);
  });

  it("does not re-emit a final that the engine re-delivers (duplicated results)", async () => {
    const ctx = setup({ platform: IOS });
    await started(ctx, "utterance");
    const rec = ctx.registry.last;
    rec.emitResult([{ transcript: "good morning", isFinal: true }], 0);
    // iOS re-delivers the whole session list with resultIndex 0.
    rec.emitResult(
      [
        { transcript: "good morning", isFinal: true },
        { transcript: "good morning", isFinal: true },
      ],
      0,
    );
    rec.emitResult([{ transcript: "good morning", isFinal: true }], 0);
    const finals = ctx.events.filter((event) => event.type === "final");
    // Index 0 once; index 1 is a distinct result slot and is delivered once.
    expect(finals.map((event) => (event.type === "final" ? event.text : ""))).toEqual([
      "good morning",
      "good morning",
    ]);
  });

  it("ends an utterance session after the final when the engine ends", async () => {
    const ctx = setup();
    await started(ctx, "utterance");
    const rec = ctx.registry.last;
    rec.emitResult([{ transcript: "yes", isFinal: true }], 0);
    rec.emitEnd();
    expect(ctx.ends()).toEqual(["complete"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.registry.instances).toHaveLength(1);
  });
});

describe("createWebSpeechInput: stop and abort", () => {
  it("own abort ends immediately and suppresses the restart loop", async () => {
    const ctx = setup();
    await started(ctx);
    const rec = ctx.registry.last;
    ctx.input.abort();
    expect(rec.abortCalls).toBe(1);
    expect(ctx.ends()).toEqual(["own-abort"]);
    rec.emitError("aborted");
    rec.emitEnd();
    await vi.advanceTimersByTimeAsync(10000);
    expect(ctx.registry.instances).toHaveLength(1);
    expect(ctx.ends()).toEqual(["own-abort"]);
    expect(ctx.errors()).toEqual([]);
    expect(ctx.input.diagnostics().lastEndCause).toBe("own-abort");
  });

  it("stop is graceful: the pending final still arrives, then end(stop)", async () => {
    const ctx = setup();
    await started(ctx);
    const rec = ctx.registry.last;
    ctx.input.stop();
    expect(rec.stopCalls).toBe(1);
    expect(rec.abortCalls).toBe(0);
    rec.emitResult([{ transcript: "see you", isFinal: true }], 0);
    rec.emitEnd();
    expect(ctx.types()).toEqual(["start", "final", "end"]);
    expect(ctx.ends()).toEqual(["stop"]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(ctx.registry.instances).toHaveLength(1);
  });

  it("forces the end when the engine never reports onend after stop", async () => {
    const ctx = setup();
    await started(ctx);
    ctx.input.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.ends()).toEqual(["stop"]);
    expect(ctx.registry.last.abortCalls).toBe(1);
  });
});

describe("createWebSpeechInput: restart loop", () => {
  it("emulates continuous mode on phones by restarting after each final", async () => {
    const ctx = setup({ platform: ANDROID });
    await started(ctx);
    const first = ctx.registry.last;
    first.emitResult([{ transcript: "I am fine", isFinal: true }], 0);
    first.emitEnd();
    expect(ctx.ends()).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.registry.instances).toHaveLength(2);
    const second = ctx.registry.last;
    expect(second.lang).toBe("en-GB");
    expect(second.continuous).toBe(false);
    expect(second.startCalls).toBe(1);
    second.emitStart();
    expect(ctx.types().filter((type) => type === "start")).toHaveLength(1);
    expect(ctx.input.diagnostics()).toMatchObject({ restarts: 1, lastEndCause: "final" });
  });

  it("restarts desktop continuous sessions after a silence end, with backoff", async () => {
    const ctx = setup();
    await started(ctx);
    ctx.registry.last.emitEnd();
    expect(ctx.input.diagnostics().lastEndCause).toBe("silence");
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.registry.instances).toHaveLength(2);
    ctx.registry.last.emitStart();
    ctx.registry.last.emitEnd();
    await vi.advanceTimersByTimeAsync(249);
    expect(ctx.registry.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.registry.instances).toHaveLength(3);
    expect(ctx.ends()).toEqual([]);
  });

  it("stops after five consecutive no-speech errors", async () => {
    const ctx = setup();
    await started(ctx);
    for (let i = 0; i < MAX_CONSECUTIVE_NO_SPEECH; i += 1) {
      const rec = ctx.registry.last;
      if (i > 0) rec.emitStart();
      if (i === 0) rec.emitNoMatch();
      else rec.emitError("no-speech");
      rec.emitEnd();
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(ctx.errors()).toEqual(Array(MAX_CONSECUTIVE_NO_SPEECH).fill("no-speech"));
    expect(ctx.ends()).toEqual(["no-speech-cap"]);
    expect(ctx.registry.instances).toHaveLength(MAX_CONSECUTIVE_NO_SPEECH);
    expect(ctx.input.diagnostics().consecutiveNoSpeech).toBe(MAX_CONSECUTIVE_NO_SPEECH);
  });

  it("a final resets the no-speech count", async () => {
    const ctx = setup();
    await started(ctx);
    ctx.registry.last.emitError("no-speech");
    await vi.advanceTimersByTimeAsync(1000);
    ctx.registry.last.emitStart();
    ctx.registry.last.emitResult([{ transcript: "hi", isFinal: true }], 0);
    expect(ctx.input.diagnostics().consecutiveNoSpeech).toBe(0);
  });

  it("retries network errors with 1/2/4 s backoff and stops after five", async () => {
    const ctx = setup();
    await started(ctx);
    const expectedDelays = [1000, 2000, 4000, 4000, 4000];
    for (const delay of expectedDelays) {
      const count = ctx.registry.instances.length;
      ctx.registry.last.emitError("network");
      ctx.registry.last.emitEnd();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(ctx.registry.instances).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(ctx.registry.instances).toHaveLength(count + 1);
      ctx.registry.last.emitStart();
    }
    ctx.registry.last.emitError("network");
    expect(ctx.errors()).toEqual(Array(6).fill("network"));
    expect(ctx.ends()).toEqual(["network-cap"]);
  });

  it("ends without restart on not-allowed and rejects the start promise", async () => {
    const ctx = setup();
    const promise = ctx.input.start({ lang: "en-GB", mode: "continuous" });
    ctx.registry.last.emitError("not-allowed");
    ctx.registry.last.emitEnd();
    await expect(promise).rejects.toBeInstanceOf(SpeechInputStartError);
    await promise.catch((error: SpeechInputStartError) => {
      expect(error.code).toBe("not-allowed");
      expect(error.endCause).toBe("error:not-allowed");
    });
    expect(ctx.errors()).toEqual(["not-allowed"]);
    expect(ctx.ends()).toEqual(["error:not-allowed"]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(ctx.registry.instances).toHaveLength(1);
  });

  it("maps unknown engine codes to 'unknown' and ends", async () => {
    const ctx = setup();
    await started(ctx);
    ctx.registry.last.emitError("bad-grammar", "grammar");
    expect(ctx.errors()).toEqual(["unknown"]);
    expect(ctx.ends()).toEqual(["error:unknown"]);
  });

  it("restarts once on a foreign abort, then gives up", async () => {
    const ctx = setup();
    await started(ctx);
    ctx.registry.last.emitError("aborted");
    ctx.registry.last.emitEnd();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.registry.instances).toHaveLength(2);
    expect(ctx.errors()).toEqual([]);
    ctx.registry.last.emitStart();
    ctx.registry.last.emitError("aborted");
    expect(ctx.errors()).toEqual(["aborted"]);
    expect(ctx.ends()).toEqual(["error:aborted"]);
  });

  it("caps automatic restarts at ten per minute", async () => {
    const ctx = setup();
    await started(ctx);
    for (let i = 0; i < MAX_RESTARTS_PER_MINUTE; i += 1) {
      ctx.registry.last.emitStart();
      ctx.registry.last.emitResult([{ transcript: `phrase ${i}`, isFinal: true }], 0);
      ctx.registry.last.emitEnd();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(ctx.registry.instances).toHaveLength(MAX_RESTARTS_PER_MINUTE + 1);
    ctx.registry.last.emitStart();
    ctx.registry.last.emitResult([{ transcript: "one more", isFinal: true }], 0);
    ctx.registry.last.emitEnd();
    expect(ctx.ends()).toEqual(["restart-cap"]);
  });
});

describe("createWebSpeechInput: watchdogs", () => {
  it("retries once when neither onstart nor onaudiostart arrives, then times out", async () => {
    const ctx = setup({ platform: IOS });
    const outcome = ctx.input.start({ lang: "en-GB", mode: "utterance" }).catch((error: unknown) => error);
    const first = ctx.registry.last;
    await vi.advanceTimersByTimeAsync(START_WATCHDOG_MS - 1);
    expect(ctx.registry.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.abortCalls).toBe(1);
    expect(ctx.registry.instances).toHaveLength(2);
    expect(ctx.registry.last.startCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(START_WATCHDOG_MS);
    expect(ctx.errors()).toEqual(["timeout"]);
    expect(ctx.ends()).toEqual(["start-timeout"]);
    await expect(outcome).resolves.toMatchObject({ code: "timeout", endCause: "start-timeout" });
    // Late events from the dead instances are ignored.
    first.emitStart();
    expect(ctx.types()).not.toContain("start");
  });

  it("onaudiostart satisfies the watchdog without announcing start twice", async () => {
    const ctx = setup();
    const promise = ctx.input.start({ lang: "en-GB", mode: "continuous" });
    ctx.registry.last.emitAudioStart();
    await promise;
    ctx.registry.last.emitStart();
    expect(ctx.types()).toEqual(["start"]);
    await vi.advanceTimersByTimeAsync(START_WATCHDOG_MS + 1);
    expect(ctx.registry.instances).toHaveLength(1);
  });

  it("on iOS ends the session with cause silence after 20 s without results", async () => {
    const ctx = setup({ platform: IOS });
    await started(ctx);
    await vi.advanceTimersByTimeAsync(IOS_SILENCE_TIMEOUT_MS - 1);
    ctx.registry.last.emitResult([{ transcript: "wait", isFinal: false }], 0);
    await vi.advanceTimersByTimeAsync(IOS_SILENCE_TIMEOUT_MS - 1);
    expect(ctx.ends()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.ends()).toEqual(["silence"]);
    expect(ctx.registry.last.abortCalls).toBe(1);
  });

  it("on Android a hidden page aborts the session with cause hidden", async () => {
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const ctx = setup({ platform: ANDROID, document });
    await started(ctx);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(ctx.ends()).toEqual(["hidden"]);
    expect(ctx.registry.last.abortCalls).toBe(1);
    // The listener is detached with the session.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(ctx.ends()).toEqual(["hidden"]);
  });

  it("on desktop a hidden page keeps listening", async () => {
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const ctx = setup({ document });
    await started(ctx);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(ctx.ends()).toEqual([]);
  });
});
