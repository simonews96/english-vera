/**
 * SpeechInput on top of the browser's SpeechRecognition.
 *
 * Verified facts this adapter is built on (docs/ricerca/speech-recognition.md, PIANO §1.2):
 * - `lang` is bound when the session starts on every engine, and iOS needs a fresh object
 *   after each synthesis: a NEW recognizer instance is created for every start/restart.
 * - Desktop Chrome/Edge honour `continuous`, end on their own after ~15 s of silence and
 *   fire `no-speech` after ~8 s of initial silence: an onend restart loop is expected.
 * - Chrome Android terminates the session after the recognizer's onResults whatever
 *   `continuous` says, and kills it for good when the page is hidden; iOS Safari is safe
 *   only with one-phrase sessions. Phones therefore run `continuous: false` and
 *   "continuous" mode is emulated by restarting after each final.
 * - Results: only `results[resultIndex..]` are read and only `isFinal` is confirmed;
 *   transcripts are never concatenated across events (duplicates seen on iOS/Android).
 * - On iOS (standalone, WKWebView, after audio playback) `start()` can silently never
 *   fire anything: every start has a 3 s watchdog (retry once, then "timeout").
 * - Restarts are capped (10/min, 5 consecutive `no-speech`, 5 network retries) to avoid
 *   rate limiting and battery drain.
 */

import { type PlatformInfo, usesUtteranceProfile } from "../platform/detect";
import {
  getRecognitionCtor,
  type SpeechRecognitionCtor,
  type SpeechRecognitionErrorEventLike,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
} from "./recognition-types";
import type {
  LangTag,
  SpeechInput,
  SpeechInputCapabilities,
  SpeechInputErrorCode,
  SpeechInputEvent,
  SpeechInputStartOptions,
} from "./types";

export const START_WATCHDOG_MS = 3000;
/** iOS: no WebKit-side silence timeout and a ~60 s cloud cap, so the session ends itself. */
export const IOS_SILENCE_TIMEOUT_MS = 20000;
/** After `stop()`, how long to wait for the engine's `onend` before forcing the end. */
export const STOP_GRACE_MS = 5000;
export const MAX_RESTARTS_PER_MINUTE = 10;
export const MAX_CONSECUTIVE_NO_SPEECH = 5;
export const MAX_NETWORK_RETRIES = 5;
export const MAX_ALTERNATIVES = 3;
export const RESTART_BACKOFF_STEP_MS = 250;
export const RESTART_BACKOFF_CAP_MS = 2000;
const NETWORK_BACKOFF_MS: readonly number[] = [1000, 2000, 4000];
const MINUTE_MS = 60000;

export type RecognitionProfile =
  | "chrome-desktop"
  | "edge-desktop"
  | "safari-desktop"
  | "firefox-desktop"
  | "desktop"
  | "android"
  | "ios-safari"
  | "ios-standalone"
  | "unsupported";

export interface WebSpeechInputDiagnostics {
  /** Cause of the last engine end (restart or session end), null before the first one. */
  readonly lastEndCause: string | null;
  /** Automatic restarts and watchdog retries since creation. */
  readonly restarts: number;
  readonly consecutiveNoSpeech: number;
  readonly lastErrorCode: SpeechInputErrorCode | null;
  readonly profile: RecognitionProfile;
}

export interface WebSpeechInput extends SpeechInput {
  /** Snapshot for the diagnostics panel; cheap, synchronous. */
  diagnostics(): WebSpeechInputDiagnostics;
}

export interface WebSpeechInputOptions {
  readonly platform: PlatformInfo;
  /** Defaults to `SpeechRecognition` / `webkitSpeechRecognition` on `window`; null = unsupported. */
  readonly ctor?: SpeechRecognitionCtor | null;
  readonly now?: () => number;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** Used for the Android "page hidden" rule. Defaults to the global document. */
  readonly document?: Document;
}

/** Rejection of `start()`: the session ended before the engine reported `start`. */
export class SpeechInputStartError extends Error {
  readonly code: SpeechInputErrorCode;
  /** The `end` cause that settled the session, e.g. "start-timeout" or "error:not-allowed". */
  readonly endCause: string;

  constructor(code: SpeechInputErrorCode, endCause: string) {
    super(errorMessage(code, ""));
    this.name = "SpeechInputStartError";
    this.code = code;
    this.endCause = endCause;
  }
}

const FATAL_CODES: ReadonlySet<SpeechInputErrorCode> = new Set([
  "audio-capture",
  "not-allowed",
  "service-not-allowed",
  "language-not-supported",
]);

const KNOWN_CODES: ReadonlySet<string> = new Set([
  "no-speech",
  "aborted",
  "audio-capture",
  "not-allowed",
  "service-not-allowed",
  "network",
  "language-not-supported",
]);

function mapErrorCode(engineCode: string): SpeechInputErrorCode {
  return KNOWN_CODES.has(engineCode) ? (engineCode as SpeechInputErrorCode) : "unknown";
}

function errorMessage(code: SpeechInputErrorCode, detail: string): string {
  switch (code) {
    case "no-speech":
      return "Non ti sento";
    case "aborted":
      return "Ascolto interrotto";
    case "audio-capture":
      return "Nessun microfono: controlla cuffie o Bluetooth";
    case "not-allowed":
      return "Il browser non ha il permesso di usare il microfono";
    case "service-not-allowed":
      return "Il servizio di riconoscimento non è disponibile";
    case "network":
      return "Il riconoscimento ha bisogno di rete";
    case "language-not-supported":
      return "Lingua non disponibile su questo dispositivo";
    case "unsupported":
      return "Questo browser non ascolta";
    case "timeout":
      return "Il riconoscimento non è partito";
    default:
      return detail ? `Errore del riconoscimento: ${detail}` : "Errore del riconoscimento";
  }
}

function recognitionProfile(platform: PlatformInfo, available: boolean): RecognitionProfile {
  if (!available) return "unsupported";
  if (platform.os === "android") return "android";
  if (platform.os === "ios") return platform.standalone ? "ios-standalone" : "ios-safari";
  switch (platform.browser) {
    case "chrome":
      return "chrome-desktop";
    case "edge":
      return "edge-desktop";
    case "safari":
      return "safari-desktop";
    case "firefox":
      return "firefox-desktop";
    default:
      return "desktop";
  }
}

interface ParsedFinal {
  readonly index: number;
  readonly text: string;
  readonly confidence: number | undefined;
  readonly alternatives: readonly string[];
}

interface ParsedResults {
  readonly interim: string;
  readonly finals: readonly ParsedFinal[];
}

/** Reads only `results[resultIndex..]`; finals carry the best alternative and the others as `alternatives`. */
function parseResultEvent(event: SpeechRecognitionEventLike): ParsedResults {
  const results = event.results;
  const from = Math.max(0, Math.floor(event.resultIndex || 0));
  const interimParts: string[] = [];
  const finals: ParsedFinal[] = [];
  for (let i = from; i < results.length; i += 1) {
    const result = results[i];
    const best = result?.[0];
    if (!result || !best) continue;
    const text = String(best.transcript ?? "").trim();
    if (result.isFinal) {
      if (text.length === 0) continue;
      const alternatives: string[] = [];
      for (let j = 1; j < result.length; j += 1) {
        const alt = result[j];
        const altText = alt ? String(alt.transcript ?? "").trim() : "";
        if (altText.length > 0 && altText !== text) alternatives.push(altText);
      }
      const confidence =
        typeof best.confidence === "number" && Number.isFinite(best.confidence) ? best.confidence : undefined;
      finals.push({ index: i, text, confidence, alternatives });
    } else if (text.length > 0) {
      interimParts.push(text);
    }
  }
  return { interim: interimParts.join(" ").trim(), finals };
}

interface Instance {
  readonly recognizer: SpeechRecognitionLike;
  started: boolean;
  gotFinal: boolean;
  /** Once set, no further event from this recognizer is honoured. */
  done: boolean;
  watchdog: unknown;
  readonly emittedFinals: Set<number>;
}

interface Session {
  readonly lang: LangTag;
  readonly mode: "utterance" | "continuous";
  instance: Instance | null;
  startSettled: boolean;
  startAnnounced: boolean;
  stopping: boolean;
  ownAbort: boolean;
  ended: boolean;
  /** Watchdog retries used for the current start (max 1). */
  startRetries: number;
  /** Consecutive restarts without a final: drives the 0/250/500 ms backoff. */
  idleRestarts: number;
  abortedRetries: number;
  networkRetries: number;
  restartTimer: unknown;
  silenceTimer: unknown;
  stopTimer: unknown;
  resolveStart: () => void;
  rejectStart: (error: SpeechInputStartError) => void;
}

export function createWebSpeechInput(options: WebSpeechInputOptions): WebSpeechInput {
  const { platform } = options;
  const ctor = options.ctor === undefined ? getRecognitionCtor() : options.ctor;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer =
    options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const doc = options.document ?? (typeof document !== "undefined" ? document : undefined);
  const phone = usesUtteranceProfile(platform);
  const isIos = platform.os === "ios";
  const isAndroid = platform.os === "android";
  const available = ctor !== null;
  const profile = recognitionProfile(platform, available);

  const capabilities: SpeechInputCapabilities = {
    available,
    continuous: available && !phone,
    interimResults: available,
    onDevice: false,
    profile,
  };

  const listeners = new Set<(event: SpeechInputEvent) => void>();
  let current: Session | null = null;
  let lastEndCause: string | null = null;
  let lastErrorCode: SpeechInputErrorCode | null = null;
  let restarts = 0;
  let consecutiveNoSpeech = 0;
  const restartTimes: number[] = [];
  let visibilityListener: (() => void) | null = null;

  function emit(event: SpeechInputEvent): void {
    for (const listener of [...listeners]) listener(event);
  }

  function emitError(code: SpeechInputErrorCode, detail = ""): void {
    lastErrorCode = code;
    emit({ type: "error", code, message: errorMessage(code, detail) });
  }

  function clearSessionTimers(session: Session): void {
    for (const key of ["restartTimer", "silenceTimer", "stopTimer"] as const) {
      const handle = session[key];
      if (handle !== null && handle !== undefined) clearTimer(handle);
      session[key] = null;
    }
  }

  function retireInstance(instance: Instance | null, abortEngine: boolean): void {
    if (!instance || instance.done) return;
    instance.done = true;
    if (instance.watchdog !== null && instance.watchdog !== undefined) clearTimer(instance.watchdog);
    instance.watchdog = null;
    if (abortEngine) {
      try {
        instance.recognizer.abort();
      } catch {
        // The engine may already be stopped.
      }
    }
  }

  function detachVisibility(): void {
    if (visibilityListener && doc) doc.removeEventListener("visibilitychange", visibilityListener);
    visibilityListener = null;
  }

  function endSession(session: Session, cause: string, abortEngine: boolean): void {
    if (session.ended) return;
    session.ended = true;
    clearSessionTimers(session);
    retireInstance(session.instance, abortEngine);
    session.instance = null;
    if (current === session) {
      current = null;
      detachVisibility();
    }
    lastEndCause = cause;
    emit({ type: "end", cause });
    if (!session.startSettled) {
      session.startSettled = true;
      const code: SpeechInputErrorCode = cause === "start-timeout" ? "timeout" : (lastErrorCode ?? "aborted");
      session.rejectStart(new SpeechInputStartError(code, cause));
    }
  }

  function restartDelayMs(session: Session): number {
    return Math.min(RESTART_BACKOFF_CAP_MS, RESTART_BACKOFF_STEP_MS * session.idleRestarts);
  }

  /** Schedules a fresh instance; enforces the 10/min cap. */
  function scheduleRestart(session: Session, delayMs: number, engineEndCause: string): void {
    if (session.ended) return;
    lastEndCause = engineEndCause;
    const at = now();
    while (restartTimes.length > 0 && at - (restartTimes[0] ?? at) >= MINUTE_MS) restartTimes.shift();
    if (restartTimes.length >= MAX_RESTARTS_PER_MINUTE) {
      endSession(session, "restart-cap", false);
      return;
    }
    restartTimes.push(at);
    restarts += 1;
    session.instance = null;
    session.restartTimer = setTimer(() => {
      session.restartTimer = null;
      if (session.ended) return;
      if (session.stopping) {
        endSession(session, "stop", false);
        return;
      }
      launch(session);
    }, delayMs);
  }

  function armSilenceTimer(session: Session): void {
    if (!isIos) return;
    if (session.silenceTimer !== null && session.silenceTimer !== undefined) clearTimer(session.silenceTimer);
    session.silenceTimer = setTimer(() => {
      session.silenceTimer = null;
      endSession(session, "silence", true);
    }, IOS_SILENCE_TIMEOUT_MS);
  }

  function handleStartFailure(session: Session, instance: Instance): void {
    retireInstance(instance, true);
    session.instance = null;
    if (session.startRetries < 1) {
      session.startRetries += 1;
      restarts += 1;
      lastEndCause = "start-retry";
      launch(session);
      return;
    }
    emitError("timeout");
    endSession(session, "start-timeout", false);
  }

  function handleError(session: Session, instance: Instance, event: SpeechRecognitionErrorEventLike): void {
    if (instance.done) return;
    const code = mapErrorCode(String(event.error ?? ""));
    retireInstance(instance, false);
    session.instance = null;
    if (session.silenceTimer !== null && session.silenceTimer !== undefined) {
      clearTimer(session.silenceTimer);
      session.silenceTimer = null;
    }
    if (code === "aborted") {
      if (session.ownAbort) return;
      if (session.stopping) {
        endSession(session, "stop", false);
        return;
      }
      if (session.abortedRetries < 1) {
        session.abortedRetries += 1;
        scheduleRestart(session, 0, "error:aborted");
        return;
      }
      emitError("aborted");
      endSession(session, "error:aborted", false);
      return;
    }
    if (code === "no-speech") {
      consecutiveNoSpeech += 1;
      emitError("no-speech");
      if (consecutiveNoSpeech >= MAX_CONSECUTIVE_NO_SPEECH) {
        endSession(session, "no-speech-cap", false);
        return;
      }
      if (session.stopping) {
        endSession(session, "stop", false);
        return;
      }
      const delay = restartDelayMs(session);
      session.idleRestarts += 1;
      scheduleRestart(session, delay, "error:no-speech");
      return;
    }
    if (code === "network") {
      session.networkRetries += 1;
      emitError("network");
      if (session.networkRetries > MAX_NETWORK_RETRIES || session.stopping) {
        endSession(session, session.stopping ? "stop" : "network-cap", false);
        return;
      }
      const step = Math.min(session.networkRetries, NETWORK_BACKOFF_MS.length) - 1;
      scheduleRestart(session, NETWORK_BACKOFF_MS[step] ?? RESTART_BACKOFF_CAP_MS, "error:network");
      return;
    }
    if (FATAL_CODES.has(code)) {
      emitError(code);
      endSession(session, `error:${code}`, false);
      return;
    }
    emitError("unknown", String(event.error ?? event.message ?? ""));
    endSession(session, "error:unknown", false);
  }

  function handleResult(session: Session, instance: Instance, event: SpeechRecognitionEventLike): void {
    if (instance.done) return;
    armSilenceTimer(session);
    const parsed = parseResultEvent(event);
    if (parsed.interim.length > 0) emit({ type: "interim", text: parsed.interim });
    for (const final of parsed.finals) {
      // Dedup rule: one final per result index per instance (iOS/Android re-deliver earlier results).
      if (instance.emittedFinals.has(final.index)) continue;
      instance.emittedFinals.add(final.index);
      instance.gotFinal = true;
      session.idleRestarts = 0;
      session.abortedRetries = 0;
      session.networkRetries = 0;
      consecutiveNoSpeech = 0;
      emit({
        type: "final",
        text: final.text,
        ...(final.confidence === undefined ? {} : { confidence: final.confidence }),
        alternatives: final.alternatives,
      });
    }
  }

  function handleEnd(session: Session, instance: Instance): void {
    if (instance.done) return;
    if (!instance.started) {
      handleStartFailure(session, instance);
      return;
    }
    retireInstance(instance, false);
    session.instance = null;
    if (session.silenceTimer !== null && session.silenceTimer !== undefined) {
      clearTimer(session.silenceTimer);
      session.silenceTimer = null;
    }
    if (session.stopping) {
      endSession(session, "stop", false);
      return;
    }
    if (instance.gotFinal) {
      if (session.mode === "continuous") scheduleRestart(session, 0, "final");
      else endSession(session, "complete", false);
      return;
    }
    const delay = restartDelayMs(session);
    session.idleRestarts += 1;
    scheduleRestart(session, delay, "silence");
  }

  function handleStarted(session: Session, instance: Instance): void {
    if (instance.done) return;
    instance.started = true;
    if (instance.watchdog !== null && instance.watchdog !== undefined) clearTimer(instance.watchdog);
    instance.watchdog = null;
    session.startRetries = 0;
    armSilenceTimer(session);
    if (!session.startAnnounced) {
      session.startAnnounced = true;
      emit({ type: "start" });
    }
    if (!session.startSettled) {
      session.startSettled = true;
      session.resolveStart();
    }
  }

  function launch(session: Session): void {
    if (session.ended || !ctor) return;
    let recognizer: SpeechRecognitionLike;
    try {
      recognizer = new ctor();
    } catch (cause) {
      emitError("unknown", cause instanceof Error ? cause.message : "constructor");
      endSession(session, "error:unknown", false);
      return;
    }
    const instance: Instance = {
      recognizer,
      started: false,
      gotFinal: false,
      done: false,
      watchdog: null,
      emittedFinals: new Set(),
    };
    session.instance = instance;
    recognizer.lang = session.lang;
    recognizer.continuous = !phone && session.mode === "continuous";
    recognizer.interimResults = true;
    recognizer.maxAlternatives = MAX_ALTERNATIVES;
    recognizer.onstart = () => handleStarted(session, instance);
    recognizer.onaudiostart = () => handleStarted(session, instance);
    recognizer.onresult = (event) => handleResult(session, instance, event);
    recognizer.onnomatch = () => handleError(session, instance, { error: "no-speech", message: "nomatch" });
    recognizer.onerror = (event) => handleError(session, instance, event);
    recognizer.onend = () => handleEnd(session, instance);
    recognizer.onspeechend = null;
    instance.watchdog = setTimer(() => {
      instance.watchdog = null;
      if (instance.done || instance.started) return;
      handleStartFailure(session, instance);
    }, START_WATCHDOG_MS);
    try {
      recognizer.start();
    } catch (cause) {
      retireInstance(instance, false);
      session.instance = null;
      emitError("unknown", cause instanceof Error ? cause.message : "start");
      endSession(session, "error:unknown", false);
    }
  }

  function attachVisibility(): void {
    if (!isAndroid || !doc || visibilityListener) return;
    visibilityListener = () => {
      if (doc.visibilityState !== "hidden" || !current) return;
      endSession(current, "hidden", true);
    };
    doc.addEventListener("visibilitychange", visibilityListener);
  }

  function abort(): void {
    const session = current;
    if (!session) return;
    session.ownAbort = true;
    endSession(session, "own-abort", true);
  }

  function stop(): void {
    const session = current;
    if (!session || session.stopping) return;
    session.stopping = true;
    const instance = session.instance;
    if (!instance || instance.done) {
      endSession(session, "stop", false);
      return;
    }
    try {
      instance.recognizer.stop();
    } catch {
      endSession(session, "stop", false);
      return;
    }
    session.stopTimer = setTimer(() => {
      session.stopTimer = null;
      endSession(session, "stop", true);
    }, STOP_GRACE_MS);
  }

  function start(startOptions: SpeechInputStartOptions): Promise<void> {
    if (current) abort();
    if (!ctor) {
      emitError("unsupported");
      return Promise.reject(new SpeechInputStartError("unsupported", "unsupported"));
    }
    return new Promise<void>((resolve, reject) => {
      const session: Session = {
        lang: startOptions.lang,
        mode: startOptions.mode,
        instance: null,
        startSettled: false,
        startAnnounced: false,
        stopping: false,
        ownAbort: false,
        ended: false,
        startRetries: 0,
        idleRestarts: 0,
        abortedRetries: 0,
        networkRetries: 0,
        restartTimer: null,
        silenceTimer: null,
        stopTimer: null,
        resolveStart: resolve,
        rejectStart: reject,
      };
      current = session;
      consecutiveNoSpeech = 0;
      attachVisibility();
      launch(session);
    });
  }

  return {
    capabilities,
    start,
    stop,
    abort,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    diagnostics() {
      return { lastEndCause, restarts, consecutiveNoSpeech, lastErrorCode, profile };
    },
  };
}
