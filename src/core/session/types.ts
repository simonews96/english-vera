/**
 * Session state machine contract. The machine is pure: it consumes events and returns the
 * next state plus a list of effects that the app layer executes (listen, speak, call the
 * model...). This keeps turn logic testable without DOM or audio.
 */

import type { LlmError, LlmUsage } from "../../llm/types";
import type { LangTag, SpeakOutcome, SpeechInputErrorCode } from "../../voice/types";
import type { Segment, TurnResponse } from "../turn/schema";

/** Visible state, written to `data-state` on the root element. */
export type LoomState =
  | "setup"
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "correcting"
  | "repeating"
  | "error";

export type HelpKind = "REPEAT" | "SLOWER" | "DIDNT_UNDERSTAND" | "HOW_TO_SAY";

export type ListenMode = "handsfree" | "push";

export interface TurnTimings {
  /** ms from the final transcript to the first text delta. */
  readonly firstTokenMs?: number;
  /** ms from the final transcript to the first closed segment. */
  readonly firstSegmentMs?: number;
  /** ms from the final transcript to the first spoken audio start. */
  readonly firstAudioMs?: number;
}

export type SessionEvent =
  | { readonly type: "SETUP_DONE" }
  | { readonly type: "START"; readonly mode: ListenMode }
  | { readonly type: "STOP" }
  | { readonly type: "PRESS" }
  | { readonly type: "RELEASE" }
  | { readonly type: "INPUT_START" }
  | { readonly type: "INTERIM"; readonly text: string }
  | { readonly type: "FINAL"; readonly text: string }
  | { readonly type: "INPUT_END"; readonly cause: string }
  | { readonly type: "INPUT_ERROR"; readonly code: SpeechInputErrorCode; readonly message: string }
  | { readonly type: "TEXT_SUBMIT"; readonly text: string }
  | { readonly type: "HELP"; readonly kind: HelpKind }
  | { readonly type: "LLM_FIRST_TOKEN"; readonly atMs: number }
  | { readonly type: "LLM_SEGMENT"; readonly segment: Segment; readonly index: number; readonly atMs: number }
  | {
      readonly type: "LLM_DONE";
      readonly response: TurnResponse;
      readonly usage: LlmUsage;
      readonly atMs: number;
    }
  | { readonly type: "LLM_ERROR"; readonly error: LlmError }
  | { readonly type: "SPEAK_START"; readonly index: number; readonly atMs: number }
  | { readonly type: "SPEAK_DONE"; readonly index: number; readonly outcome: SpeakOutcome }
  | { readonly type: "INTERRUPT" }
  | { readonly type: "RETRY" }
  | { readonly type: "TICK"; readonly nowMs: number };

export type Effect =
  | { readonly type: "listen"; readonly lang: LangTag; readonly mode: "utterance" | "continuous" }
  | { readonly type: "stopListening" }
  | { readonly type: "abortListening" }
  | { readonly type: "callLlm"; readonly userText: string; readonly help?: HelpKind }
  | { readonly type: "speak"; readonly segment: Segment; readonly index: number; readonly rate: number }
  | { readonly type: "cancelSpeech" }
  | {
      readonly type: "commitTurn";
      readonly response: TurnResponse;
      readonly usage: LlmUsage;
      readonly timings: TurnTimings;
    }
  | { readonly type: "notify"; readonly level: "info" | "warn" | "error"; readonly message: string }
  | { readonly type: "log"; readonly message: string };

export interface SessionSnapshot {
  readonly state: LoomState;
  readonly mode: ListenMode | null;
  /** Language the recognizer is (or will be) listening in. */
  readonly listenLang: LangTag;
  readonly englishVariant: "en-GB" | "en-US";
  readonly slowMode: boolean;
  readonly interim: string;
  /** Last confirmed thing the learner said. */
  readonly transcript: string;
  /** Segments of the current reply, in order; `spokenUpTo` indexes the one being spoken. */
  readonly segments: readonly Segment[];
  readonly spokenUpTo: number;
  readonly lastResponse: TurnResponse | null;
  readonly lastError: { readonly message: string; readonly kind: string } | null;
  readonly turnStartedAtMs: number | null;
  readonly timings: TurnTimings;
  readonly turnsCompleted: number;
}

export interface SessionStepResult {
  readonly snapshot: SessionSnapshot;
  readonly effects: readonly Effect[];
}

export interface SessionMachine {
  readonly snapshot: SessionSnapshot;
  dispatch(event: SessionEvent): SessionStepResult;
}
