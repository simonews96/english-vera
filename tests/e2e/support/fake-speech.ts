/**
 * Fake Web Speech API for end-to-end tests. Installed with page.addInitScript, so this
 * function must be self-contained (Playwright serializes its source). Tests drive it through
 * window.__veraFake: `recognize(text)` delivers an interim and a final result to the active
 * recognizer; `utterances` records everything Vera spoke.
 */

export interface FakeSpeechOptions {
  /** Milliseconds per word for the fake synthesizer. */
  readonly msPerWord?: number;
  /** Whether the fake synthesizer emits word boundary events. */
  readonly boundaries?: boolean;
  /** Whether a SpeechRecognition constructor is exposed at all. */
  readonly recognition?: boolean;
}

export interface FakeSpeechHandle {
  readonly recognitions: Array<{ lang: string; continuous: boolean; interimResults: boolean }>;
  readonly utterances: Array<{ text: string; lang: string; voice: string | null; rate: number }>;
  readonly activeCount: number;
  recognize(text: string): boolean;
  recognitionError(code: string): boolean;
  endRecognition(): boolean;
}

declare global {
  interface Window {
    __veraFake?: FakeSpeechHandle;
  }
}

export function installFakeSpeech(options: FakeSpeechOptions): void {
  const msPerWord = options.msPerWord ?? 30;
  const boundaries = options.boundaries ?? true;

  type Handler = ((event: Event) => void) | null;

  function fire(
    target: EventTarget & Record<string, unknown>,
    type: string,
    init: Record<string, unknown>,
  ): void {
    const event = new Event(type);
    for (const [key, value] of Object.entries(init)) {
      Object.defineProperty(event, key, { value, enumerable: true });
    }
    const handler = target[`on${type}`] as Handler;
    if (typeof handler === "function") handler.call(target, event);
    target.dispatchEvent(event);
  }

  // ---- Recognition -------------------------------------------------------------------
  const recognitions: FakeSpeechHandle["recognitions"] = [];
  let active: (EventTarget & Record<string, unknown> & { lang: string; continuous: boolean }) | null = null;

  class FakeRecognition extends EventTarget {
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    [key: string]: unknown;

    start(): void {
      recognitions.push({
        lang: this.lang,
        continuous: this.continuous,
        interimResults: this.interimResults,
      });
      active = this as unknown as typeof active;
      setTimeout(() => {
        if (active === (this as unknown as typeof active)) {
          fire(this, "start", {});
          fire(this, "audiostart", {});
        }
      }, 10);
    }

    stop(): void {
      const self = this as unknown as typeof active;
      setTimeout(() => {
        if (active === self) active = null;
        fire(this, "end", {});
      }, 10);
    }

    abort(): void {
      const self = this as unknown as typeof active;
      if (active === self) active = null;
      setTimeout(() => fire(this, "end", {}), 0);
    }
  }

  function makeResults(text: string, isFinal: boolean): unknown {
    const alternative = { transcript: text, confidence: 0.9 };
    const result = { isFinal, length: 1, 0: alternative, item: () => alternative };
    return { length: 1, 0: result, item: () => result };
  }

  function recognize(text: string): boolean {
    const target = active;
    if (!target) return false;
    fire(target, "result", { resultIndex: 0, results: makeResults(text, false) });
    setTimeout(() => {
      if (active !== target) return;
      fire(target, "result", { resultIndex: 0, results: makeResults(text, true) });
      if (!target.continuous) {
        active = null;
        setTimeout(() => fire(target, "end", {}), 5);
      }
    }, 20);
    return true;
  }

  function recognitionError(code: string): boolean {
    const target = active;
    if (!target) return false;
    active = null;
    fire(target, "error", { error: code, message: `fake ${code}` });
    setTimeout(() => fire(target, "end", {}), 5);
    return true;
  }

  function endRecognition(): boolean {
    const target = active;
    if (!target) return false;
    active = null;
    fire(target, "end", {});
    return true;
  }

  if (options.recognition ?? true) {
    const w = window as unknown as Record<string, unknown>;
    w.SpeechRecognition = FakeRecognition;
    w.webkitSpeechRecognition = FakeRecognition;
  }

  // ---- Synthesis ---------------------------------------------------------------------
  const utterances: FakeSpeechHandle["utterances"] = [];
  const voices = [
    { voiceURI: "fake-en-gb", name: "Fake Kate", lang: "en-GB", localService: true, default: true },
    { voiceURI: "fake-en-us", name: "Fake Samantha", lang: "en-US", localService: true, default: false },
    { voiceURI: "fake-it", name: "Fake Alice", lang: "it-IT", localService: true, default: false },
  ];

  class FakeUtterance extends EventTarget {
    text: string;
    lang = "";
    voice: { voiceURI: string; name: string; lang: string } | null = null;
    rate = 1;
    pitch = 1;
    volume = 1;
    [key: string]: unknown;

    constructor(text?: string) {
      super();
      this.text = text ?? "";
    }
  }

  let current: FakeUtterance | null = null;
  const timers: number[] = [];
  const synth = new EventTarget() as EventTarget & Record<string, unknown>;

  function clearTimers(): void {
    for (const id of timers) clearTimeout(id);
    timers.length = 0;
  }

  Object.assign(synth, {
    speaking: false,
    pending: false,
    paused: false,
    getVoices: () => voices,
    speak(utterance: FakeUtterance) {
      utterances.push({
        text: utterance.text,
        lang: utterance.lang,
        voice: utterance.voice ? utterance.voice.name : null,
        rate: utterance.rate,
      });
      current = utterance;
      synth.speaking = true;
      const words = utterance.text.split(/\s+/).filter(Boolean);
      const perWord = Math.max(5, msPerWord / (utterance.rate || 1));
      timers.push(
        window.setTimeout(() => {
          if (current !== utterance) return;
          fire(utterance, "start", { charIndex: 0, utterance });
        }, 5),
      );
      let charIndex = 0;
      words.forEach((word, index) => {
        const at = 5 + perWord * index;
        const thisIndex = charIndex;
        if (boundaries) {
          timers.push(
            window.setTimeout(() => {
              if (current !== utterance) return;
              fire(utterance, "boundary", {
                name: "word",
                charIndex: thisIndex,
                charLength: word.length,
                utterance,
              });
            }, at),
          );
        }
        charIndex += word.length + 1;
      });
      timers.push(
        window.setTimeout(
          () => {
            if (current !== utterance) return;
            current = null;
            synth.speaking = false;
            fire(utterance, "end", { charIndex: utterance.text.length, utterance });
          },
          5 + perWord * Math.max(1, words.length),
        ),
      );
    },
    cancel() {
      clearTimers();
      const utterance = current;
      current = null;
      synth.speaking = false;
      if (utterance) fire(utterance, "error", { error: "interrupted", utterance });
    },
    pause() {},
    resume() {},
  });

  const w = window as unknown as Record<string, unknown>;
  w.speechSynthesis = synth;
  w.SpeechSynthesisUtterance = FakeUtterance;
  setTimeout(() => fire(synth, "voiceschanged", {}), 20);

  const handle: FakeSpeechHandle = {
    recognitions,
    utterances,
    get activeCount() {
      return active ? 1 : 0;
    },
    recognize,
    recognitionError,
    endRecognition,
  };
  window.__veraFake = handle;
}
