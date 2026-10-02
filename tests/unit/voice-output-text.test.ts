import { describe, expect, it, vi } from "vitest";
import { createTextOutput } from "../../src/voice/text-output";
import { FakeTimers, flushMicrotasks } from "../helpers/voice-synthesis-fake";

describe("text output", () => {
  it("has text-mode capabilities and no voices", async () => {
    const output = createTextOutput({ msPerChar: 0 });
    expect(output.capabilities).toEqual({
      available: false,
      wordBoundary: "no",
      selectableVoice: false,
      needsGesture: false,
    });
    expect(await output.listVoices()).toEqual([]);
    output.unlock();
  });

  it("calls onStart immediately and resolves 'ended' without delay when msPerChar is 0", async () => {
    const output = createTextOutput({ msPerChar: 0 });
    const onStart = vi.fn();
    const promise = output.speak("Hello", { lang: "en-GB", onStart });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(await promise).toBe("ended");
  });

  it("waits the estimated reading time, scaled by rate", async () => {
    const timers = new FakeTimers();
    const output = createTextOutput({
      msPerChar: 10,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    let outcome: string | null = null;
    void output.speak("abcd", { lang: "it-IT", rate: 0.5 }).then((o) => {
      outcome = o;
    });
    await timers.advance(79);
    expect(outcome).toBeNull();
    await timers.advance(1);
    expect(outcome).toBe("ended");
  });

  it("cancel resolves pending speaks as 'cancelled' and clears their timers", async () => {
    const timers = new FakeTimers();
    const output = createTextOutput({
      msPerChar: 10,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const a = output.speak("abcd", { lang: "en-GB" });
    const b = output.speak("efgh", { lang: "en-GB" });
    output.cancel();
    await flushMicrotasks();
    expect(await a).toBe("cancelled");
    expect(await b).toBe("cancelled");
    expect(timers.pendingCount).toBe(0);
    expect(await output.speak("ok", { lang: "en-GB", rate: 100 })).toBe("ended");
  });
});
