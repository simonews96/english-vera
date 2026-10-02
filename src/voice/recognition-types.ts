/**
 * Minimal declarations for the Web Speech recognition API as the browsers expose it.
 * lib.dom does not ship them, so the adapter depends on these shapes only; the fake
 * recognizer used in tests implements the same interfaces.
 */

export interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
  readonly confidence: number;
}

export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike | undefined;
}

export interface SpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultLike | undefined;
}

export interface SpeechRecognitionEventLike {
  /** First index of `results` that changed in this event; earlier entries are history. */
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

export interface SpeechRecognitionErrorEventLike {
  /** Engine error code, e.g. "no-speech", "not-allowed", "network". */
  readonly error: string;
  readonly message: string;
}

export type RecognitionHandler<E> = ((event: E) => void) | null;

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: RecognitionHandler<unknown>;
  onaudiostart: RecognitionHandler<unknown>;
  onresult: RecognitionHandler<SpeechRecognitionEventLike>;
  onerror: RecognitionHandler<SpeechRecognitionErrorEventLike>;
  onend: RecognitionHandler<unknown>;
  onnomatch: RecognitionHandler<SpeechRecognitionEventLike>;
  onspeechend: RecognitionHandler<unknown>;
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface RecognitionGlobals {
  readonly SpeechRecognition?: unknown;
  readonly webkitSpeechRecognition?: unknown;
}

/**
 * Returns the recognition constructor (unprefixed first, then `webkit`), or null.
 * Presence is not function: on iOS standalone and in WKWebView the constructor exists
 * but never delivers events, which is why the adapter also runs a start watchdog.
 */
export function getRecognitionCtor(win?: Window): SpeechRecognitionCtor | null {
  const target: RecognitionGlobals | undefined =
    (win as RecognitionGlobals | undefined) ??
    (typeof window !== "undefined" ? (window as RecognitionGlobals) : undefined);
  if (!target) return null;
  if (typeof target.SpeechRecognition === "function")
    return target.SpeechRecognition as SpeechRecognitionCtor;
  if (typeof target.webkitSpeechRecognition === "function") {
    return target.webkitSpeechRecognition as SpeechRecognitionCtor;
  }
  return null;
}
