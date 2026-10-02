/**
 * Fake speechSynthesis for unit tests: records utterances, emits events on demand and
 * exposes the voice list through getVoices()/voiceschanged. Paired with FakeTimers so that
 * watchdogs and the voiceschanged timeout are driven deterministically.
 */

import type { VoiceInfo } from "../../src/voice/types";

export interface FakeVoiceSpec {
  readonly name: string;
  readonly lang: string;
  readonly voiceURI?: string;
  readonly localService?: boolean;
}

export function makeVoice(spec: FakeVoiceSpec): SpeechSynthesisVoice {
  return {
    name: spec.name,
    lang: spec.lang,
    voiceURI: spec.voiceURI ?? spec.name,
    localService: spec.localService ?? true,
    default: false,
  };
}

export function makeVoiceInfo(spec: FakeVoiceSpec): VoiceInfo {
  return {
    id: spec.voiceURI ?? spec.name,
    name: spec.name,
    lang: spec.lang,
    local: spec.localService ?? true,
  };
}

type Handler<E> = ((this: SpeechSynthesisUtterance, ev: E) => unknown) | null;

export class FakeUtterance extends EventTarget implements SpeechSynthesisUtterance {
  text: string;
  lang = "";
  voice: SpeechSynthesisVoice | null = null;
  rate = 1;
  pitch = 1;
  volume = 1;
  onstart: Handler<SpeechSynthesisEvent> = null;
  onend: Handler<SpeechSynthesisEvent> = null;
  onerror: Handler<SpeechSynthesisErrorEvent> = null;
  onboundary: Handler<SpeechSynthesisEvent> = null;
  onmark: Handler<SpeechSynthesisEvent> = null;
  onpause: Handler<SpeechSynthesisEvent> = null;
  onresume: Handler<SpeechSynthesisEvent> = null;

  constructor(text?: string) {
    super();
    this.text = text ?? "";
  }

  private fire(type: string, init: Record<string, unknown>): void {
    const event = new Event(type);
    for (const [key, value] of Object.entries(init)) {
      Object.defineProperty(event, key, { value, enumerable: true });
    }
    const handlers: Record<string, Handler<Event>> = {
      start: this.onstart as Handler<Event>,
      end: this.onend as Handler<Event>,
      error: this.onerror as Handler<Event>,
      boundary: this.onboundary as Handler<Event>,
    };
    handlers[type]?.call(this, event);
    this.dispatchEvent(event);
  }

  emitStart(): void {
    this.fire("start", { charIndex: 0, utterance: this });
  }

  emitBoundary(charIndex: number, charLength = 1): void {
    this.fire("boundary", { name: "word", charIndex, charLength, utterance: this });
  }

  emitEnd(): void {
    this.fire("end", { charIndex: this.text.length, utterance: this });
  }

  emitError(error: string): void {
    this.fire("error", { error, utterance: this });
  }
}

export class FakeSynth extends EventTarget implements SpeechSynthesis {
  /** Every utterance handed to speak(), in order. */
  readonly utterances: FakeUtterance[] = [];
  cancelCalls = 0;
  speaking = false;
  pending = false;
  paused = false;
  onvoiceschanged: ((this: SpeechSynthesis, ev: Event) => unknown) | null = null;
  private voices: SpeechSynthesisVoice[] = [];
  /** When true, cancel() behaves like Chromium: error("interrupted") on the current utterance. */
  emitInterruptedOnCancel = false;
  /** When true, speak() records the utterance but the engine never takes it (iOS without gesture). */
  dropUtterances = false;
  private current: FakeUtterance | null = null;

  constructor(voices: readonly SpeechSynthesisVoice[] = []) {
    super();
    this.voices = [...voices];
  }

  getVoices(): SpeechSynthesisVoice[] {
    return [...this.voices];
  }

  /** Replaces the voice list and fires voiceschanged, as the browsers do. */
  setVoices(voices: readonly SpeechSynthesisVoice[]): void {
    this.voices = [...voices];
    const event = new Event("voiceschanged");
    this.onvoiceschanged?.call(this, event);
    this.dispatchEvent(event);
  }

  speak(utterance: SpeechSynthesisUtterance): void {
    const fake = utterance as FakeUtterance;
    this.utterances.push(fake);
    if (this.dropUtterances) return;
    this.current = fake;
    this.speaking = true;
  }

  cancel(): void {
    this.cancelCalls += 1;
    const current = this.current;
    this.current = null;
    this.speaking = false;
    this.pending = false;
    if (current && this.emitInterruptedOnCancel) current.emitError("interrupted");
  }

  pause(): void {
    throw new Error("pause() must never be called");
  }

  resume(): void {
    throw new Error("resume() must never be called");
  }

  get last(): FakeUtterance {
    const last = this.utterances[this.utterances.length - 1];
    if (!last) throw new Error("no utterance was spoken");
    return last;
  }

  /** Simulates a natural end of the current utterance. */
  finish(utterance: FakeUtterance): void {
    if (this.current === utterance) {
      this.current = null;
      this.speaking = false;
    }
    utterance.emitEnd();
  }
}

export const fakeUtteranceCtor = FakeUtterance as unknown as typeof SpeechSynthesisUtterance;

interface ScheduledTimer {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
}

/** Deterministic timers: `advance(ms)` runs everything due, in order. */
export class FakeTimers {
  now = 0;
  private nextId = 1;
  private timers: ScheduledTimer[] = [];

  readonly setTimeout = (fn: () => void, ms: number): unknown => {
    const timer: ScheduledTimer = { id: this.nextId, at: this.now + Math.max(0, ms), fn };
    this.nextId += 1;
    this.timers.push(timer);
    return timer.id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };

  get pendingCount(): number {
    return this.timers.length;
  }

  /** Advances the clock, running due timers (and timers they schedule) in time order. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id);
      const next = due[0];
      if (!next) break;
      this.timers = this.timers.filter((timer) => timer.id !== next.id);
      this.now = Math.max(this.now, next.at);
      next.fn();
      await flushMicrotasks();
    }
    this.now = target;
  }
}

/** Lets promise chains settle without advancing fake timers. */
export async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}
