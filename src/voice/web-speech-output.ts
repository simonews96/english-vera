/**
 * SpeechOutput on top of the browser's speechSynthesis.
 *
 * Verified facts this adapter is built on (docs/ricerca/speech-synthesis.md):
 * - `cancel()` never produces `end`; Chromium gives `error("interrupted")` to the current
 *   utterance only and nothing to page-queued ones, so promises are settled by our own
 *   generation token, not by engine events.
 * - Voice lists load asynchronously everywhere (Chrome, Edge, Android, Safari >= 26.3).
 * - WebKit can deliver a spurious `end` to the utterance spoken right after `cancel()`,
 *   so on WebKit the next speak is deferred to a macrotask and `end` before `start` is ignored.
 * - On iOS the first `speak()` outside a user gesture is dropped with no event: `unlock()`
 *   speaks a near-silent "." synchronously inside the gesture.
 * - Chrome may garbage-collect an utterance mid-speech and lose its `end`: a reference is
 *   kept until the utterance settles; a watchdog resolves utterances that never report back.
 * - Android: `utterance.lang` is what the engine speaks; `pause()` stops silently. Never used.
 */

import type { PlatformInfo } from "../platform/detect";
import { chunkWithOffsets, type TextChunk } from "./chunk";
import type {
  LangTag,
  SpeakOptions,
  SpeakOutcome,
  SpeechOutput,
  SpeechOutputCapabilities,
  VoiceInfo,
} from "./types";
import { type EnglishVariant, type ResolutionStep, resolveVoice, type TutorLanguage } from "./voices";

export const MIN_RATE = 0.7;
export const MAX_RATE = 1.2;
/** Grace added to the estimated duration before an utterance is treated as ended. */
export const WATCHDOG_GRACE_MS = 1500;
/** How long to wait for `voiceschanged` when the first `getVoices()` is empty. */
export const VOICES_TIMEOUT_MS = 2000;
/** After this delay without `start`, an engine that is neither speaking nor pending has dropped the utterance. */
export const START_PROBE_MS = 300;

export type BoundarySupport = "yes" | "no" | "unknown";

export interface VoiceResolutionSummary {
  readonly name: string;
  readonly step: ResolutionStep;
}

export interface WebSpeechDiagnostics {
  readonly voiceCount: number;
  readonly boundary: BoundarySupport;
  readonly lastResolution: { readonly en?: VoiceResolutionSummary; readonly it?: VoiceResolutionSummary };
  readonly unlocked: boolean;
}

export interface WebSpeechOutput extends SpeechOutput {
  /** Snapshot for the diagnostics panel; cheap, synchronous. */
  diagnostics(): WebSpeechDiagnostics;
}

export interface WebSpeechOutputOptions {
  readonly platform: PlatformInfo;
  /** Defaults to `globalThis.speechSynthesis`; `undefined` there means "not available". */
  readonly synth?: SpeechSynthesis;
  /** Defaults to `globalThis.SpeechSynthesisUtterance`. */
  readonly utteranceCtor?: typeof SpeechSynthesisUtterance;
  /** Expected speech duration; the watchdog adds `WATCHDOG_GRACE_MS`. */
  readonly estimateDurationMs?: (text: string, rate: number) => number;
  /** Injectable timers for tests. */
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** 0 disables the dropped-utterance probe. */
  readonly startProbeMs?: number;
}

/** 60 ms per character at rate 1, never below 1.5 s. */
export function defaultEstimateDurationMs(text: string, rate: number): number {
  const safeRate = rate > 0 ? rate : 1;
  return Math.max(1500, Math.round((text.length * 60) / safeRate));
}

export function clampRate(rate: number | undefined): number {
  if (rate === undefined || Number.isNaN(rate)) return 1;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

function toVoiceInfo(voice: SpeechSynthesisVoice): VoiceInfo {
  // Defensive against buggy engines (Edge 150 reports "undefined" names).
  const id = voice.voiceURI || voice.name || "";
  return {
    id: String(id),
    name: String(voice.name || ""),
    lang: String(voice.lang || ""),
    local: voice.localService !== false,
  };
}

function languageOf(lang: LangTag): { language: TutorLanguage; variant: EnglishVariant } {
  if (lang === "it-IT") return { language: "it", variant: "en-GB" };
  return { language: "en", variant: lang };
}

interface Pending {
  settled: boolean;
  resolve(outcome: SpeakOutcome): void;
}

interface ActiveUtterance {
  /** Held until settled: Chrome may garbage-collect a live utterance and lose its `end`. */
  readonly utterance: SpeechSynthesisUtterance;
  started: boolean;
  settle(outcome: SpeakOutcome): void;
}

function globalSynth(): SpeechSynthesis | undefined {
  const g = globalThis as { speechSynthesis?: SpeechSynthesis };
  return g.speechSynthesis;
}

function globalUtteranceCtor(): typeof SpeechSynthesisUtterance | undefined {
  const g = globalThis as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance };
  return typeof g.SpeechSynthesisUtterance === "function" ? g.SpeechSynthesisUtterance : undefined;
}

export function createWebSpeechOutput(options: WebSpeechOutputOptions): WebSpeechOutput {
  const { platform } = options;
  const synth = options.synth ?? globalSynth();
  const utteranceCtor = options.utteranceCtor ?? globalUtteranceCtor();
  const estimate = options.estimateDurationMs ?? defaultEstimateDurationMs;
  const setTimer = options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer =
    options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const startProbeMs = options.startProbeMs ?? START_PROBE_MS;
  const isWebKit = platform.browser === "safari" || platform.os === "ios";
  const available = synth !== undefined && utteranceCtor !== undefined;

  // ---- Voices --------------------------------------------------------------------------
  let voices: readonly VoiceInfo[] = [];
  const nativeById = new Map<string, SpeechSynthesisVoice>();
  let voicesStable = false;
  let resolveVoicesReady: (() => void) | null = null;
  const voicesReady = new Promise<void>((resolve) => {
    resolveVoicesReady = resolve;
  });

  function readVoices(): void {
    if (!synth) return;
    let native: readonly SpeechSynthesisVoice[] = [];
    try {
      const list: unknown = synth.getVoices();
      if (Array.isArray(list)) native = list as SpeechSynthesisVoice[];
    } catch {
      native = [];
    }
    nativeById.clear();
    const list: VoiceInfo[] = [];
    for (const voice of native) {
      const info = toVoiceInfo(voice);
      nativeById.set(info.id, voice);
      list.push(info);
    }
    voices = list;
  }

  function markVoicesStable(): void {
    if (voicesStable) return;
    voicesStable = true;
    resolveVoicesReady?.();
  }

  function bootstrapVoices(): void {
    if (!synth) {
      markVoicesStable();
      return;
    }
    readVoices();
    // Keep listening: Edge adds Natural voices in a later event, Android fires twice.
    try {
      synth.addEventListener("voiceschanged", () => {
        readVoices();
        if (voices.length > 0) markVoicesStable();
      });
    } catch {
      // An engine without addEventListener: the first read is all we get.
    }
    if (voices.length > 0) {
      markVoicesStable();
      return;
    }
    setTimer(() => markVoicesStable(), VOICES_TIMEOUT_MS);
  }

  bootstrapVoices();

  // ---- Speak state ---------------------------------------------------------------------
  let generation = 0;
  let active: ActiveUtterance | null = null;
  const inflight = new Set<Pending>();
  let tail: Promise<void> = Promise.resolve();
  /** WebKit: the first speak after a cancel waits for a macrotask. */
  let deferNextSpeak = false;
  let boundary: BoundarySupport = "unknown";
  let unlocked = false;
  const lastResolution: { en?: VoiceResolutionSummary; it?: VoiceResolutionSummary } = {};
  /** Keeps the iOS unlock utterance referenced until the engine is done with it. */
  const retained = new Set<SpeechSynthesisUtterance>();

  function macrotask(): Promise<void> {
    return new Promise((resolve) => {
      setTimer(resolve, 0);
    });
  }

  function pickVoice(speakOptions: SpeakOptions): SpeechSynthesisVoice | null {
    const { language, variant } = languageOf(speakOptions.lang);
    const resolution = resolveVoice(voices, language, variant, speakOptions.voiceId);
    if (resolution.voice) {
      lastResolution[language] = { name: resolution.voice.name, step: resolution.step };
      return nativeById.get(resolution.voice.id) ?? null;
    }
    lastResolution[language] = { name: "", step: resolution.step };
    return null;
  }

  function speakChunk(
    chunk: TextChunk,
    isFirst: boolean,
    speakOptions: SpeakOptions,
    voice: SpeechSynthesisVoice | null,
    rate: number,
  ): Promise<SpeakOutcome> {
    return new Promise<SpeakOutcome>((resolve) => {
      if (!synth || !utteranceCtor) {
        resolve("error");
        return;
      }
      const utterance = new utteranceCtor(chunk.text);
      utterance.lang = speakOptions.lang;
      if (voice) utterance.voice = voice;
      utterance.rate = rate;
      utterance.pitch = 1;
      utterance.volume = 1;

      const myGeneration = generation;
      const budgetMs = estimate(chunk.text, rate) + WATCHDOG_GRACE_MS;
      let watchdog: unknown = null;
      let probe: unknown = null;
      let graceUsed = false;
      let boundarySeen = false;
      let done = false;

      const record: ActiveUtterance = {
        utterance,
        started: false,
        settle(outcome) {
          if (done) return;
          done = true;
          if (watchdog !== null) clearTimer(watchdog);
          if (probe !== null) clearTimer(probe);
          if (active === record) active = null;
          resolve(outcome);
        },
      };
      const isCurrent = (): boolean => !done && myGeneration === generation;

      const armWatchdog = (ms: number): void => {
        if (watchdog !== null) clearTimer(watchdog);
        watchdog = setTimer(() => {
          watchdog = null;
          if (!isCurrent()) return;
          // The engine still claims to be speaking and had started: allow one extra grace.
          if (record.started && synth.speaking && !graceUsed) {
            graceUsed = true;
            armWatchdog(Math.max(WATCHDOG_GRACE_MS, Math.round(budgetMs / 2)));
            return;
          }
          // Stuck utterance: clear the engine and move on. The resulting error event
          // (if any) is ignored because the record is already settled.
          synth.cancel();
          if (isWebKit) deferNextSpeak = true;
          record.settle("ended");
        }, ms);
      };

      utterance.onstart = () => {
        if (!isCurrent()) return;
        record.started = true;
        if (probe !== null) {
          clearTimer(probe);
          probe = null;
        }
        armWatchdog(budgetMs);
        if (isFirst) speakOptions.onStart?.();
      };
      utterance.onboundary = (event) => {
        if (!isCurrent()) return;
        boundarySeen = true;
        boundary = "yes";
        const charIndex = typeof event.charIndex === "number" ? event.charIndex : 0;
        const remaining = chunk.text.slice(charIndex);
        armWatchdog(estimate(remaining, rate) + WATCHDOG_GRACE_MS);
        speakOptions.onBoundary?.(chunk.offset + charIndex);
      };
      utterance.onend = () => {
        if (!isCurrent()) return;
        // WebKit may deliver the previous utterance's cancel as an `end` to this one.
        if (isWebKit && !record.started) return;
        if (countWords(chunk.text) > 3) boundary = boundarySeen ? "yes" : "no";
        record.settle("ended");
      };
      utterance.onerror = () => {
        // A cancel of ours already settled this record through the generation token;
        // an interrupted/canceled error that still finds us current came from outside.
        if (!isCurrent()) return;
        record.settle("error");
      };

      active = record;
      armWatchdog(budgetMs);
      if (startProbeMs > 0) {
        probe = setTimer(() => {
          probe = null;
          if (!isCurrent() || record.started) return;
          if (!synth.speaking && !synth.pending) {
            // The engine dropped the utterance (iOS without gesture, backgrounded Chrome).
            record.settle("error");
          }
        }, startProbeMs);
      }
      try {
        synth.speak(utterance);
      } catch {
        record.settle("error");
      }
    });
  }

  async function runSpeak(text: string, speakOptions: SpeakOptions, pending: Pending): Promise<void> {
    if (pending.settled) return;
    if (!available) {
      pending.resolve("error");
      return;
    }
    const chunks = chunkWithOffsets(text);
    if (chunks.length === 0) {
      pending.resolve("ended");
      return;
    }
    // Voice selection needs the (async) voice list; bounded by VOICES_TIMEOUT_MS.
    await voicesReady;
    if (pending.settled) return;
    const voice = pickVoice(speakOptions);
    const rate = clampRate(speakOptions.rate);
    if (deferNextSpeak) {
      deferNextSpeak = false;
      await macrotask();
      if (pending.settled) return;
    }
    for (const [index, chunk] of chunks.entries()) {
      if (pending.settled) return;
      const outcome = await speakChunk(chunk, index === 0, speakOptions, voice, rate);
      if (pending.settled) return;
      if (outcome !== "ended") {
        pending.resolve(outcome);
        return;
      }
    }
    pending.resolve("ended");
  }

  function speak(text: string, speakOptions: SpeakOptions): Promise<SpeakOutcome> {
    return new Promise<SpeakOutcome>((resolvePromise) => {
      const pending: Pending = {
        settled: false,
        resolve(outcome) {
          if (pending.settled) return;
          pending.settled = true;
          inflight.delete(pending);
          resolvePromise(outcome);
        },
      };
      inflight.add(pending);
      const run = tail.then(() => runSpeak(text, speakOptions, pending));
      tail = run.catch(() => {
        pending.resolve("error");
      });
    });
  }

  function cancel(): void {
    generation += 1;
    const current = active;
    active = null;
    if (synth) {
      try {
        synth.cancel();
      } catch {
        // Nothing to clear.
      }
    }
    if (isWebKit) deferNextSpeak = true;
    current?.settle("cancelled");
    for (const pending of [...inflight]) pending.resolve("cancelled");
  }

  function unlock(): void {
    if (unlocked) return;
    unlocked = true;
    if (platform.os !== "ios" || !synth || !utteranceCtor) return;
    // Synchronous on purpose: this must run inside the user gesture, before any await.
    cancel();
    const utterance = new utteranceCtor(".");
    utterance.volume = 0.01;
    utterance.rate = 10;
    const release = (): void => {
      retained.delete(utterance);
    };
    utterance.onend = release;
    utterance.onerror = release;
    retained.add(utterance);
    try {
      synth.speak(utterance);
    } catch {
      release();
    }
  }

  const capabilities: SpeechOutputCapabilities = {
    available,
    get wordBoundary() {
      return boundary;
    },
    selectableVoice: platform.os !== "android",
    needsGesture: platform.os === "ios",
  };

  return {
    capabilities,
    listVoices: () => voicesReady.then(() => voices),
    speak,
    cancel,
    unlock,
    diagnostics: () => ({
      voiceCount: voices.length,
      boundary,
      lastResolution: { ...lastResolution },
      unlocked,
    }),
  };
}
