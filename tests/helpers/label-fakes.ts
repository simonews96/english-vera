/**
 * Fakes for the label and probe tests: an in-memory settings store, scripted speech engines,
 * a fake wake lock navigator and a recording clipboard. jsdom only.
 */

import type { PlatformInfo } from "../../src/platform/detect";
import { createSettingsStore, type Settings, type SettingsStore } from "../../src/storage/settings";
import type { LabelDeps } from "../../src/ui/label";
import type {
  SpeakOutcome,
  SpeechInput,
  SpeechInputEvent,
  SpeechInputStartOptions,
  SpeechOutput,
  VoiceInfo,
} from "../../src/voice/types";

export function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

export function fakeSettings(patch: Partial<Settings> = {}): SettingsStore {
  const store = createSettingsStore(memoryStorage());
  if (Object.keys(patch).length > 0) store.update(patch);
  return store;
}

export const FAKE_VOICES: readonly VoiceInfo[] = [
  { id: "serena", name: "Serena", lang: "en-GB", local: true },
  { id: "samantha", name: "Samantha", lang: "en-US", local: true },
  { id: "alice", name: "Alice", lang: "it-IT", local: true },
  { id: "google-it", name: "Google italiano", lang: "it_IT", local: false },
];

export interface LabelDepsRecord {
  readonly previews: { voiceId: string; lang: "en" | "it" }[];
  validateCalls: string[];
  forgetCalls: number;
  probeOpens: number;
  micStarts: number;
  micStops: number;
  levelCallback: ((level: number) => void) | null;
}

export function fakeLabelDeps(
  settings: SettingsStore = fakeSettings(),
  overrides: Partial<LabelDeps> = {},
): { deps: LabelDeps; record: LabelDepsRecord } {
  const record: LabelDepsRecord = {
    previews: [],
    validateCalls: [],
    forgetCalls: 0,
    probeOpens: 0,
    micStarts: 0,
    micStops: 0,
    levelCallback: null,
  };
  const deps: LabelDeps = {
    settings,
    listVoices: () => Promise.resolve(FAKE_VOICES),
    previewVoice: (voiceId, lang) => {
      record.previews.push({ voiceId, lang });
    },
    validateKey: (key) => {
      record.validateCalls.push(key);
      return Promise.resolve(
        key.startsWith("sk-ant-")
          ? { ok: true, models: ["claude-sonnet-5-5", "claude-haiku-4-5"] }
          : { ok: false, message: "Chiave non valida: controlla l'etichetta" },
      );
    },
    costSummary: () => ({
      todayUsd: 0.1234,
      sessionUsd: 0.0042,
      totalUsd: 3.5,
      todayTurns: 12,
      tableVersion: "2026-10-02",
    }),
    diagnosticsText: () => "VERSIONE\n  build ............ abc123\nVOCE\n  boundary ......... sì",
    diagnosticsJson: () => '{\n  "VERSIONE": {\n    "build": "abc123"\n  }\n}',
    micTest: () => ({
      start: (onLevel) => {
        record.micStarts += 1;
        record.levelCallback = onLevel;
        return Promise.resolve();
      },
      stop: () => {
        record.micStops += 1;
        record.levelCallback = null;
      },
    }),
    openProbe: () => {
      record.probeOpens += 1;
    },
    forgetKey: () => {
      record.forgetCalls += 1;
      settings.forgetKey();
    },
    appVersion: "0.1.0+abc123",
    ...overrides,
  };
  return { deps, record };
}

/** Clipboard double installed on `navigator`; returns the texts written. */
export function installFakeClipboard(): { written: string[]; restore(): void } {
  const written: string[] = [];
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        written.push(text);
        return Promise.resolve();
      },
    },
  });
  return {
    written,
    restore() {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    },
  };
}

export const FAKE_PLATFORM: PlatformInfo = {
  os: "android",
  browser: "chrome",
  standalone: false,
  touch: true,
  hasSpeechRecognition: true,
  hasSpeechSynthesis: true,
  hasGetUserMedia: true,
  hasWakeLock: false,
  hasVibrate: false,
  hasMediaSession: false,
  prefersReducedMotion: false,
  prefersDark: false,
  userAgent: "fake",
};

export interface FakeSpeechOutput extends SpeechOutput {
  readonly spoken: { text: string; lang: string }[];
  unlocks: number;
  cancels: number;
}

export function fakeSpeechOutput(
  options: {
    voices?: readonly VoiceInfo[];
    outcome?: SpeakOutcome;
    boundaries?: number;
    available?: boolean;
  } = {},
): FakeSpeechOutput {
  const output: FakeSpeechOutput = {
    capabilities: {
      available: options.available ?? true,
      wordBoundary: "unknown",
      selectableVoice: true,
      needsGesture: false,
    },
    spoken: [],
    unlocks: 0,
    cancels: 0,
    listVoices: () => Promise.resolve(options.voices ?? FAKE_VOICES),
    speak(text, speakOptions) {
      output.spoken.push({ text, lang: speakOptions.lang });
      speakOptions.onStart?.();
      for (let i = 0; i < (options.boundaries ?? 0); i += 1) speakOptions.onBoundary?.(i * 5);
      return Promise.resolve(options.outcome ?? "ended");
    },
    cancel() {
      output.cancels += 1;
    },
    unlock() {
      output.unlocks += 1;
    },
  };
  return output;
}

export interface FakeSpeechInput extends SpeechInput {
  readonly starts: SpeechInputStartOptions[];
  emit(event: SpeechInputEvent): void;
  aborts: number;
  stops: number;
}

export function fakeSpeechInput(
  options: { available?: boolean; script?: readonly SpeechInputEvent[] } = {},
): FakeSpeechInput {
  const listeners = new Set<(event: SpeechInputEvent) => void>();
  const input: FakeSpeechInput = {
    capabilities: {
      available: options.available ?? true,
      continuous: false,
      interimResults: true,
      onDevice: false,
      profile: "fake-phone",
    },
    starts: [],
    aborts: 0,
    stops: 0,
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    start(startOptions) {
      input.starts.push(startOptions);
      queueMicrotask(() => {
        for (const event of options.script ?? [{ type: "start" }]) input.emit(event);
      });
      return Promise.resolve();
    },
    stop() {
      input.stops += 1;
    },
    abort() {
      input.aborts += 1;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return input;
}

/** A minimal `WakeLockSentinel` plus the navigator that hands it out. */
export function fakeWakeLockNavigator(behaviour: "grant" | "deny" | "throw" = "grant"): {
  nav: Navigator;
  sentinels: { released: boolean; release(): Promise<void>; fire(): void }[];
} {
  const sentinels: { released: boolean; release(): Promise<void>; fire(): void }[] = [];
  const nav = {
    wakeLock: {
      request: () => {
        if (behaviour === "deny") {
          const error = new Error("denied");
          error.name = "NotAllowedError";
          return Promise.reject(error);
        }
        if (behaviour === "throw") return Promise.reject(new Error("boom"));
        const target = new EventTarget();
        const sentinel = {
          released: false,
          type: "screen" as const,
          release() {
            sentinel.released = true;
            target.dispatchEvent(new Event("release"));
            return Promise.resolve();
          },
          fire() {
            sentinel.released = true;
            target.dispatchEvent(new Event("release"));
          },
          addEventListener: target.addEventListener.bind(target),
          removeEventListener: target.removeEventListener.bind(target),
          dispatchEvent: target.dispatchEvent.bind(target),
          onrelease: null,
        };
        sentinels.push(sentinel);
        return Promise.resolve(sentinel as unknown as WakeLockSentinel);
      },
    },
  } as unknown as Navigator;
  return { nav, sentinels };
}
