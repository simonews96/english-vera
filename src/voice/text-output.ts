/**
 * SpeechOutput for text-only mode: no audio, but the same promise contract, so the session
 * machine does not care which engine is behind it. "Speaking" takes an estimated reading
 * time (so the UI can ink the text at a readable pace) and can be cancelled like real speech.
 */

import type { SpeakOptions, SpeakOutcome, SpeechOutput, SpeechOutputCapabilities, VoiceInfo } from "./types";

export interface TextOutputOptions {
  /** Reading pace; 0 resolves on the next microtask. Default 30 ms per character. */
  readonly msPerChar?: number;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

export const DEFAULT_TEXT_MS_PER_CHAR = 30;

const NO_VOICES: readonly VoiceInfo[] = [];

interface PendingSpeak {
  readonly timer: unknown;
  resolve(outcome: SpeakOutcome): void;
}

export function createTextOutput(options: TextOutputOptions = {}): SpeechOutput {
  const msPerChar = Math.max(0, options.msPerChar ?? DEFAULT_TEXT_MS_PER_CHAR);
  const setTimer = options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer =
    options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const pending = new Set<PendingSpeak>();

  // Not "available" as audio: the probe must not mistake the silent timer for a voice.
  const capabilities: SpeechOutputCapabilities = {
    available: false,
    wordBoundary: "no",
    selectableVoice: false,
    needsGesture: false,
  };

  function speak(text: string, speakOptions: SpeakOptions): Promise<SpeakOutcome> {
    speakOptions.onStart?.();
    const rate = speakOptions.rate !== undefined && speakOptions.rate > 0 ? speakOptions.rate : 1;
    const delay = Math.round((text.length * msPerChar) / rate);
    if (delay <= 0) return Promise.resolve("ended");
    return new Promise<SpeakOutcome>((resolve) => {
      const entry: PendingSpeak = {
        timer: setTimer(() => {
          pending.delete(entry);
          resolve("ended");
        }, delay),
        resolve(outcome) {
          clearTimer(entry.timer);
          pending.delete(entry);
          resolve(outcome);
        },
      };
      pending.add(entry);
    });
  }

  function cancel(): void {
    for (const entry of [...pending]) entry.resolve("cancelled");
  }

  return {
    capabilities,
    listVoices: () => Promise.resolve(NO_VOICES),
    speak,
    cancel,
    unlock: () => {
      // Nothing to unlock without audio.
    },
  };
}
