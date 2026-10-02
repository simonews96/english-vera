import { describe, expect, it } from "vitest";
import { createTextInput } from "../../src/voice/text-input";
import type { SpeechInputEvent } from "../../src/voice/types";

describe("createTextInput", () => {
  it("emits start on start, then final and end(text) on submit", async () => {
    const input = createTextInput();
    const events: SpeechInputEvent[] = [];
    input.subscribe((event) => events.push(event));
    expect(input.capabilities).toMatchObject({ available: false, continuous: true, profile: "text" });
    await input.start({ lang: "en-GB", mode: "utterance" });
    input.submit("  I would like a coffee ");
    expect(events).toEqual([
      { type: "start" },
      { type: "final", text: "I would like a coffee", confidence: 1 },
      { type: "end", cause: "text" },
    ]);
  });

  it("ignores blank text and ends only once per session", async () => {
    const input = createTextInput();
    const events: SpeechInputEvent[] = [];
    const unsubscribe = input.subscribe((event) => events.push(event));
    await input.start({ lang: "it-IT", mode: "continuous" });
    input.submit("   ");
    input.abort();
    input.stop();
    expect(events).toEqual([{ type: "start" }, { type: "end", cause: "own-abort" }]);
    unsubscribe();
    input.submit("ciao");
    expect(events).toHaveLength(2);
  });
});
