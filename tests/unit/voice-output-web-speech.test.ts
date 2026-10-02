// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { PlatformInfo } from "../../src/platform/detect";
import {
  createWebSpeechOutput,
  VOICES_TIMEOUT_MS,
  WATCHDOG_GRACE_MS,
} from "../../src/voice/web-speech-output";
import {
  FakeSynth,
  FakeTimers,
  fakeUtteranceCtor,
  flushMicrotasks,
  makeVoice,
} from "../helpers/voice-synthesis-fake";

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

const DESKTOP_VOICES = [
  makeVoice({ name: "Google UK English Male", lang: "en-GB", localService: false }),
  makeVoice({ name: "Google UK English Female", lang: "en-GB", localService: false }),
  makeVoice({ name: "Microsoft Hazel - English (Great Britain)", lang: "en-GB", voiceURI: "hazel" }),
  makeVoice({ name: "Google italiano", lang: "it-IT", localService: false }),
];

const ANDROID_VOICES = [
  makeVoice({ name: "English United States", lang: "en_US" }),
  makeVoice({ name: "English United Kingdom", lang: "en_GB" }),
  makeVoice({ name: "Italian Italy", lang: "it_IT" }),
];

function setup(
  options: { voices?: SpeechSynthesisVoice[]; platform?: Partial<PlatformInfo>; probe?: number } = {},
) {
  const timers = new FakeTimers();
  const synth = new FakeSynth(options.voices ?? DESKTOP_VOICES);
  const output = createWebSpeechOutput({
    synth,
    utteranceCtor: fakeUtteranceCtor,
    platform: platform(options.platform),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    startProbeMs: options.probe,
  });
  return { timers, synth, output };
}

/** Resolves to the promise's value if it settled, or to "pending" after microtasks. */
async function settled<T>(promise: Promise<T>): Promise<T | "pending"> {
  const result = await Promise.race([promise, flushMicrotasks().then(() => "pending" as const)]);
  return result;
}

describe("voice loading", () => {
  it("resolves listVoices once voiceschanged brings a non-empty list", async () => {
    const { synth, output } = setup({ voices: [] });
    const list = output.listVoices();
    expect(await settled(list)).toBe("pending");
    synth.setVoices([]); // Chrome fires an empty event first.
    expect(await settled(list)).toBe("pending");
    synth.setVoices(DESKTOP_VOICES);
    const voices = await list;
    expect(voices.map((v) => v.name)).toEqual(DESKTOP_VOICES.map((v) => v.name));
    expect(voices[2]).toEqual({ id: "hazel", name: DESKTOP_VOICES[2]?.name, lang: "en-GB", local: true });
  });

  it("gives up waiting after the timeout and keeps updating on later events", async () => {
    const { synth, output, timers } = setup({ voices: [] });
    const list = output.listVoices();
    await timers.advance(VOICES_TIMEOUT_MS);
    expect(await list).toEqual([]);
    synth.setVoices(ANDROID_VOICES); // Android: the engine initialises late.
    expect((await output.listVoices()).map((v) => v.lang)).toEqual(["en_US", "en_GB", "it_IT"]);
    expect(output.diagnostics().voiceCount).toBe(3);
  });

  it("lets speak() wait for the voice list so the first utterance gets a voice", async () => {
    const { synth, output } = setup({ voices: [] });
    void output.speak("Hello", { lang: "en-GB" });
    await flushMicrotasks();
    expect(synth.utterances).toHaveLength(0);
    synth.setVoices(DESKTOP_VOICES);
    await flushMicrotasks();
    expect(synth.last.voice?.name).toBe("Google UK English Female");
  });

  it("resolves immediately when the first getVoices() is populated", async () => {
    const { output } = setup();
    expect((await output.listVoices()).length).toBe(4);
  });
});

describe("speak", () => {
  it("always sets lang and voice, clamps rate, and fixes pitch and volume", async () => {
    const { synth, output } = setup({ voices: ANDROID_VOICES, platform: { os: "android" } });
    void output.speak("Hello world", { lang: "en-GB", rate: 0.5 });
    await flushMicrotasks();
    const u = synth.last;
    expect(u.lang).toBe("en-GB");
    expect(u.voice?.lang).toBe("en_GB");
    expect(u.rate).toBe(0.7);
    expect(u.pitch).toBe(1);
    expect(u.volume).toBe(1);
    expect(output.capabilities.selectableVoice).toBe(false);

    void output.speak("Ciao", { lang: "it-IT", rate: 3 });
    output.cancel();
    void output.speak("Ciao", { lang: "it-IT", rate: 3 });
    await flushMicrotasks();
    expect(synth.last.lang).toBe("it-IT");
    expect(synth.last.voice?.lang).toBe("it_IT");
    expect(synth.last.rate).toBe(1.2);
  });

  it("uses a known voiceId, otherwise the cascade, and reports it in diagnostics", async () => {
    const { synth, output } = setup();
    void output.speak("Hello", { lang: "en-GB", voiceId: "hazel" });
    await flushMicrotasks();
    expect(synth.last.voice?.name).toContain("Hazel");
    expect(output.diagnostics().lastResolution.en).toEqual({
      name: "Microsoft Hazel - English (Great Britain)",
      step: 0,
    });
    output.cancel();
    void output.speak("Hello", { lang: "en-GB", voiceId: "no-such-voice" });
    await flushMicrotasks();
    expect(synth.last.voice?.name).toBe("Google UK English Female");
    expect(output.diagnostics().lastResolution.en?.step).toBe(1);
  });

  it("leaves voice unset but keeps lang when no voice exists for the language", async () => {
    const { synth, output } = setup({ voices: [makeVoice({ name: "Alice", lang: "it-IT" })] });
    void output.speak("Hello", { lang: "en-US" });
    await flushMicrotasks();
    expect(synth.last.voice).toBeNull();
    expect(synth.last.lang).toBe("en-US");
    expect(output.diagnostics().lastResolution.en?.step).toBe(4);
  });

  it("speaks one chunk at a time, maps boundaries to text offsets and calls onStart once", async () => {
    const { synth, output } = setup();
    const onStart = vi.fn();
    const onBoundary = vi.fn();
    const text = "Hello there. How are you?";
    const promise = output.speak(text, { lang: "en-GB", onStart, onBoundary });
    await flushMicrotasks();
    expect(synth.utterances.map((u) => u.text)).toEqual(["Hello there."]);

    synth.last.emitStart();
    expect(onStart).toHaveBeenCalledTimes(1);
    synth.last.emitBoundary(6);
    expect(onBoundary).toHaveBeenLastCalledWith(6);
    expect(await settled(promise)).toBe("pending");

    synth.finish(synth.last);
    await flushMicrotasks();
    expect(synth.utterances.map((u) => u.text)).toEqual(["Hello there.", "How are you?"]);
    synth.last.emitStart();
    expect(onStart).toHaveBeenCalledTimes(1);
    synth.last.emitBoundary(4);
    expect(onBoundary).toHaveBeenLastCalledWith(text.indexOf("are"));
    synth.finish(synth.last);
    expect(await promise).toBe("ended");
    expect(output.capabilities.wordBoundary).toBe("yes");
  });

  it("serialises concurrent speak() calls so only one utterance is ever in the engine", async () => {
    const { synth, output } = setup();
    const first = output.speak("First.", { lang: "en-GB" });
    const second = output.speak("Second.", { lang: "en-GB" });
    await flushMicrotasks();
    expect(synth.utterances.map((u) => u.text)).toEqual(["First."]);
    synth.last.emitStart();
    synth.finish(synth.last);
    expect(await first).toBe("ended");
    await flushMicrotasks();
    expect(synth.utterances.map((u) => u.text)).toEqual(["First.", "Second."]);
    synth.last.emitStart();
    synth.finish(synth.last);
    expect(await second).toBe("ended");
  });

  it("resolves 'ended' for empty text and 'error' without an engine", async () => {
    const { output } = setup();
    expect(await output.speak("   ", { lang: "en-GB" })).toBe("ended");
    const noEngine = createWebSpeechOutput({ platform: platform(), synth: undefined });
    expect(noEngine.capabilities.available).toBe(false);
    expect(await noEngine.speak("Hello", { lang: "en-GB" })).toBe("error");
  });
});

describe("cancel and stale events", () => {
  it("resolves every pending speak as 'cancelled' immediately, without engine events", async () => {
    const { synth, output } = setup();
    const onBoundary = vi.fn();
    const a = output.speak("One two. Three four.", { lang: "en-GB", onBoundary });
    const b = output.speak("Queued.", { lang: "en-GB" });
    await flushMicrotasks();
    const spoken = synth.last;
    spoken.emitStart();
    output.cancel();
    expect(await settled(a)).toBe("cancelled");
    expect(await settled(b)).toBe("cancelled");
    expect(synth.cancelCalls).toBe(1);
    expect(synth.utterances).toHaveLength(1);

    // Late events from the cancelled generation are ignored.
    spoken.emitBoundary(4);
    spoken.emitError("interrupted");
    spoken.emitEnd();
    expect(onBoundary).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(synth.utterances).toHaveLength(1);

    const c = output.speak("After.", { lang: "en-GB" });
    await flushMicrotasks();
    expect(synth.last.text).toBe("After.");
    synth.last.emitStart();
    synth.finish(synth.last);
    expect(await c).toBe("ended");
  });

  it("treats the Chromium 'interrupted' error on cancel as our own cancellation", async () => {
    const { synth, output } = setup();
    synth.emitInterruptedOnCancel = true;
    const a = output.speak("Hello there.", { lang: "en-GB" });
    await flushMicrotasks();
    synth.last.emitStart();
    output.cancel();
    expect(await a).toBe("cancelled");
  });

  it("reports 'error' for an interruption that was not ours and for engine failures", async () => {
    const { synth, output } = setup();
    const a = output.speak("Hello there.", { lang: "en-GB" });
    await flushMicrotasks();
    synth.last.emitStart();
    synth.last.emitError("interrupted");
    expect(await a).toBe("error");

    const b = output.speak("Hello again.", { lang: "en-GB" });
    await flushMicrotasks();
    synth.last.emitError("synthesis-failed");
    expect(await b).toBe("error");
  });
});

describe("watchdog", () => {
  it("resolves a stuck utterance as 'ended' after the estimate plus grace and clears the engine", async () => {
    const { synth, output, timers } = setup();
    const promise = output.speak("Hello world", { lang: "en-GB" }); // 11 chars -> min 1500 ms
    await flushMicrotasks();
    await timers.advance(1500 + WATCHDOG_GRACE_MS - 1);
    expect(await settled(promise)).toBe("pending");
    await timers.advance(1);
    expect(await promise).toBe("ended");
    expect(synth.cancelCalls).toBe(1);
  });

  it("grants one extra grace when the engine started and still claims to speak, then gives up", async () => {
    const { synth, output, timers } = setup();
    const promise = output.speak("Hello world", { lang: "en-GB" });
    await flushMicrotasks();
    synth.last.emitStart();
    await timers.advance(3000);
    expect(await settled(promise)).toBe("pending");
    await timers.advance(1500);
    expect(await promise).toBe("ended");
  });

  it("uses the injected estimate and re-arms on boundaries", async () => {
    const timers = new FakeTimers();
    const synth = new FakeSynth(DESKTOP_VOICES);
    const output = createWebSpeechOutput({
      synth,
      utteranceCtor: fakeUtteranceCtor,
      platform: platform(),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      estimateDurationMs: (text) => text.length * 100,
    });
    const promise = output.speak("aaaa bbbb", { lang: "en-GB" }); // 900 + 1500
    await flushMicrotasks();
    synth.last.emitStart();
    await timers.advance(2000);
    synth.last.emitBoundary(5); // remaining "bbbb" -> 400 + 1500 from now
    synth.speaking = false;
    await timers.advance(1899);
    expect(await settled(promise)).toBe("pending");
    await timers.advance(1);
    expect(await promise).toBe("ended");
  });

  it("reports 'error' quickly when the engine silently drops the utterance", async () => {
    const { synth, output, timers } = setup({ platform: { os: "ios", browser: "safari" } });
    synth.dropUtterances = true;
    const promise = output.speak("Hello there", { lang: "en-GB" });
    await flushMicrotasks();
    expect(synth.utterances).toHaveLength(1);
    await timers.advance(300);
    expect(await promise).toBe("error");
  });
});

describe("WebKit quirks", () => {
  it("defers the first speak after a cancel to a macrotask and ignores 'end' before 'start'", async () => {
    const { synth, output, timers } = setup({ platform: { os: "macos", browser: "safari" } });
    const first = output.speak("One.", { lang: "en-GB" });
    await flushMicrotasks();
    expect(synth.utterances).toHaveLength(1);
    output.cancel();
    expect(await first).toBe("cancelled");

    const second = output.speak("Two.", { lang: "en-GB" });
    await flushMicrotasks();
    expect(synth.utterances).toHaveLength(1);
    await timers.advance(0);
    expect(synth.utterances).toHaveLength(2);

    synth.last.emitEnd(); // spurious end from the cancelled utterance
    expect(await settled(second)).toBe("pending");
    synth.last.emitStart();
    synth.finish(synth.last);
    expect(await second).toBe("ended");
  });
});

describe("unlock", () => {
  it("on iOS cancels and speaks a near-silent '.' synchronously, once", () => {
    const { synth, output } = setup({ platform: { os: "ios", browser: "safari" } });
    expect(output.capabilities.needsGesture).toBe(true);
    expect(output.diagnostics().unlocked).toBe(false);
    output.unlock();
    expect(synth.cancelCalls).toBe(1);
    expect(synth.utterances).toHaveLength(1);
    expect(synth.last.text).toBe(".");
    expect(synth.last.volume).toBe(0.01);
    expect(synth.last.rate).toBe(10);
    output.unlock();
    expect(synth.utterances).toHaveLength(1);
    expect(output.diagnostics().unlocked).toBe(true);
  });

  it("elsewhere only marks the output as unlocked", () => {
    const { synth, output } = setup();
    expect(output.capabilities.needsGesture).toBe(false);
    output.unlock();
    expect(synth.utterances).toHaveLength(0);
    expect(synth.cancelCalls).toBe(0);
    expect(output.diagnostics().unlocked).toBe(true);
  });
});

describe("boundary capability", () => {
  it("is unknown, then 'no' after a long utterance without boundaries, then 'yes' at the first boundary", async () => {
    const { synth, output } = setup();
    expect(output.capabilities.wordBoundary).toBe("unknown");
    const a = output.speak("Hi there.", { lang: "en-GB" });
    await flushMicrotasks();
    synth.last.emitStart();
    synth.finish(synth.last);
    await a;
    expect(output.capabilities.wordBoundary).toBe("unknown");

    const b = output.speak("One two three four five.", { lang: "en-GB" });
    await flushMicrotasks();
    synth.last.emitStart();
    synth.finish(synth.last);
    await b;
    expect(output.capabilities.wordBoundary).toBe("no");

    const c = output.speak("One two three four five.", { lang: "en-GB" });
    await flushMicrotasks();
    synth.last.emitStart();
    synth.last.emitBoundary(0);
    expect(output.capabilities.wordBoundary).toBe("yes");
    synth.finish(synth.last);
    await c;
    expect(output.diagnostics().boundary).toBe("yes");
  });
});
