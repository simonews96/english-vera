/**
 * Fake SpeechRecognition for unit tests: every instance records the properties the adapter
 * set and exposes emit* methods to drive start/audiostart/result/error/end/nomatch by hand.
 * `createFakeRecognitionCtor()` returns a constructor plus the registry of instances created
 * through it, so tests can assert "a new instance per start" and inspect the latest one.
 */

import type {
  RecognitionHandler,
  SpeechRecognitionCtor,
  SpeechRecognitionErrorEventLike,
  SpeechRecognitionEventLike,
  SpeechRecognitionLike,
  SpeechRecognitionResultLike,
  SpeechRecognitionResultListLike,
} from "../../src/voice/recognition-types";

export interface FakeResultSpec {
  readonly transcript: string;
  readonly isFinal: boolean;
  readonly confidence?: number;
  /** Extra alternatives after the best one. */
  readonly alternatives?: readonly string[];
}

export function makeResultList(specs: readonly FakeResultSpec[]): SpeechRecognitionResultListLike {
  const results = specs.map((spec): SpeechRecognitionResultLike => {
    const alternatives = [
      { transcript: spec.transcript, confidence: spec.confidence ?? 0.9 },
      ...(spec.alternatives ?? []).map((transcript) => ({ transcript, confidence: 0.5 })),
    ];
    const result: Record<number, { transcript: string; confidence: number }> & {
      isFinal: boolean;
      length: number;
    } = { isFinal: spec.isFinal, length: alternatives.length };
    alternatives.forEach((alt, i) => {
      result[i] = alt;
    });
    return result;
  });
  const list: Record<number, SpeechRecognitionResultLike> & { length: number } = { length: results.length };
  results.forEach((result, i) => {
    list[i] = result;
  });
  return list;
}

export class FakeRecognition implements SpeechRecognitionLike {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;
  onstart: RecognitionHandler<unknown> = null;
  onaudiostart: RecognitionHandler<unknown> = null;
  onresult: RecognitionHandler<SpeechRecognitionEventLike> = null;
  onerror: RecognitionHandler<SpeechRecognitionErrorEventLike> = null;
  onend: RecognitionHandler<unknown> = null;
  onnomatch: RecognitionHandler<SpeechRecognitionEventLike> = null;
  onspeechend: RecognitionHandler<unknown> = null;
  /** When set, start() throws (Chrome's InvalidStateError). */
  throwOnStart: Error | null = null;

  start(): void {
    this.startCalls += 1;
    if (this.throwOnStart) throw this.throwOnStart;
  }

  stop(): void {
    this.stopCalls += 1;
  }

  abort(): void {
    this.abortCalls += 1;
  }

  emitStart(): void {
    this.onstart?.({});
  }

  emitAudioStart(): void {
    this.onaudiostart?.({});
  }

  /** `specs` is the FULL result list as the engine would hold it; `resultIndex` marks the first changed entry. */
  emitResult(specs: readonly FakeResultSpec[], resultIndex = 0): void {
    this.onresult?.({ resultIndex, results: makeResultList(specs) });
  }

  emitError(error: string, message = ""): void {
    this.onerror?.({ error, message });
  }

  emitEnd(): void {
    this.onend?.({});
  }

  emitNoMatch(): void {
    this.onnomatch?.({ resultIndex: 0, results: makeResultList([]) });
  }
}

export interface FakeRecognitionRegistry {
  readonly ctor: SpeechRecognitionCtor;
  readonly instances: FakeRecognition[];
  /** The most recently created instance. */
  readonly last: FakeRecognition;
}

export function createFakeRecognitionCtor(): FakeRecognitionRegistry {
  const instances: FakeRecognition[] = [];
  class Registered extends FakeRecognition {
    constructor() {
      super();
      instances.push(this);
    }
  }
  return {
    ctor: Registered,
    instances,
    get last() {
      const last = instances[instances.length - 1];
      if (!last) throw new Error("no recognizer was created");
      return last;
    },
  };
}
