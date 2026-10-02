/**
 * Voice interfaces. The rest of the app depends only on these contracts, never on
 * the Web Speech API directly, so the engines can be swapped (browser, text, cloud).
 *
 * Verified facts behind the design (see docs/ricerca/):
 * - `speechSynthesis.cancel()` never produces `end`; on Chromium queued utterances get
 *   no event at all, so `speak()` resolves through an app-side generation token.
 * - Voice lists load asynchronously on every platform.
 * - On iOS the first `speak()` must run synchronously inside a user gesture (`unlock`).
 */

export type LangTag = "en-GB" | "en-US" | "it-IT";

export type SpeechInputErrorCode =
  | "no-speech"
  | "aborted"
  | "audio-capture"
  | "not-allowed"
  | "service-not-allowed"
  | "network"
  | "language-not-supported"
  | "unsupported"
  | "timeout"
  | "unknown";

export interface SpeechInputCapabilities {
  /** The engine exists and can be started on this platform. */
  readonly available: boolean;
  /** `continuous: true` has an effect (desktop Chrome/Edge). */
  readonly continuous: boolean;
  readonly interimResults: boolean;
  /** Recognition can run without sending audio to a server. */
  readonly onDevice: boolean;
  /** Short platform description for diagnostics, e.g. "chrome-desktop". */
  readonly profile: string;
}

export type SpeechInputEvent =
  | { readonly type: "start" }
  | { readonly type: "interim"; readonly text: string }
  | {
      readonly type: "final";
      readonly text: string;
      readonly confidence?: number;
      readonly alternatives?: readonly string[];
    }
  /** The engine stopped; `cause` is a short diagnostic string (e.g. "silence", "own-abort", "error:no-speech"). */
  | { readonly type: "end"; readonly cause: string }
  | { readonly type: "error"; readonly code: SpeechInputErrorCode; readonly message: string };

export interface SpeechInputStartOptions {
  readonly lang: LangTag;
  /** `utterance`: one phrase then stop. `continuous`: keep listening (restart loop on desktop). */
  readonly mode: "utterance" | "continuous";
}

export interface SpeechInput {
  readonly capabilities: SpeechInputCapabilities;
  /** Starts listening. Resolves when the engine reports `start` (or rejects with an error code). */
  start(options: SpeechInputStartOptions): Promise<void>;
  /** Graceful stop: pending audio is still delivered as `final`. */
  stop(): void;
  /** Immediate stop, results discarded. Emits `end` with cause "own-abort". */
  abort(): void;
  subscribe(listener: (event: SpeechInputEvent) => void): () => void;
}

export interface VoiceInfo {
  /** Stable identifier (voiceURI on the web). */
  readonly id: string;
  readonly name: string;
  /** BCP-47-ish tag as reported by the engine; may use underscores on Android. */
  readonly lang: string;
  readonly local: boolean;
}

export type SpeakOutcome = "ended" | "cancelled" | "error";

export interface SpeakOptions {
  readonly lang: LangTag;
  readonly voiceId?: string;
  /** 1 = normal; 0.8 = "più lento". */
  readonly rate?: number;
  readonly onStart?: () => void;
  /** Word boundary, when the engine provides it. */
  readonly onBoundary?: (charIndex: number) => void;
}

export interface SpeechOutputCapabilities {
  readonly available: boolean;
  /** Whether word boundary events are delivered; "unknown" until probed. */
  readonly wordBoundary: "yes" | "no" | "unknown";
  readonly selectableVoice: boolean;
  /** iOS: the first speak must happen inside a user gesture. */
  readonly needsGesture: boolean;
}

export interface SpeechOutput {
  readonly capabilities: SpeechOutputCapabilities;
  /** Resolves once the voice list is stable (async on every platform). */
  listVoices(): Promise<readonly VoiceInfo[]>;
  /**
   * Speaks one chunk. Exactly one utterance is in the engine at a time.
   * Resolves "ended" on natural end, "cancelled" when `cancel()` was called (immediately,
   * without waiting for engine events), "error" on engine failure.
   */
  speak(text: string, options: SpeakOptions): Promise<SpeakOutcome>;
  /** Cancels the current and any pending chunks; resolves their promises as "cancelled". */
  cancel(): void;
  /** Must be called synchronously inside a user gesture handler (iOS). Idempotent. */
  unlock(): void;
}
