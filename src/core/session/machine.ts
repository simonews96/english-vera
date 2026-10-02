/**
 * The session state machine (docs/PIANO.md §1.2, §1.3, §1.4). Pure: no timers, no DOM,
 * no audio. Every `dispatch` returns a fresh snapshot plus the effects the app layer must
 * execute in order (listen, speak, call the model, commit the turn...).
 *
 * Invariants worth knowing:
 * - half-duplex: the machine never asks to listen and speak at the same time; leaving
 *   `listening` always emits `abortListening`, leaving `speaking` emits `cancelSpeech`;
 * - the model request is never aborted by a barge-in: after an INTERRUPT the turn keeps
 *   streaming in the background and is committed (usage counted) when LLM_DONE arrives;
 * - exactly one `speak` is in flight at a time (`speakingIndex`); the next segment starts
 *   from SPEAK_DONE, never from a bare engine event.
 */

import type { LlmError, LlmUsage } from "../../llm/types";
import type { LangTag, SpeechInputErrorCode } from "../../voice/types";
import type { Segment, TurnResponse } from "../turn/schema";
import { langToTag } from "../turn/schema";
import { matchHelp } from "./help";
import type {
  Effect,
  HelpKind,
  SessionEvent,
  SessionMachine,
  SessionSnapshot,
  SessionStepResult,
  TurnTimings,
} from "./types";

export type EnglishVariant = "en-GB" | "en-US";

export interface SessionMachineOptions {
  readonly now: () => number;
  /** A value, or a getter so a change in the settings is honoured at the next turn. */
  readonly englishVariant: EnglishVariant | (() => EnglishVariant);
  readonly initialListenLang?: LangTag;
}

function variantOf(options: SessionMachineOptions): EnglishVariant {
  return typeof options.englishVariant === "function" ? options.englishVariant() : options.englishVariant;
}

export const SLOW_RATE = 0.8;
export const NORMAL_RATE = 1;

/** Text sent to the model when "non ho capito" came from a tap rather than from speech. */
const DIDNT_UNDERSTAND_TEXT = "Non ho capito";

/** Private bookkeeping that is not part of the visible snapshot. */
interface Internal {
  /** Index of the segment whose `speak` effect is in flight, or null. */
  readonly speakingIndex: number | null;
  /** A model request for the current transcript is in flight (not yet LLM_DONE/LLM_ERROR). */
  readonly turnActive: boolean;
  /** LLM_DONE arrived for the current turn (the response is `snapshot.lastResponse`). */
  readonly turnDone: boolean;
  /** The current turn was already committed (so a re-speak must not commit it again). */
  readonly turnCommitted: boolean;
  readonly usage: LlmUsage | null;
  /** When re-speaking an already committed reply: last index to speak before relistening. */
  readonly replayUpTo: number | null;
  /** The next final transcript is the Italian request of a "come si dice". */
  readonly pendingHowToSay: boolean;
  /** "Non ho capito" count for the current reply (first is local, second goes to the model). */
  readonly didntUnderstandCount: number;
  /** Last model request, so RETRY can resend exactly the same thing. */
  readonly lastRequest: { readonly userText: string; readonly help?: HelpKind } | null;
  readonly errorOrigin: "llm" | "input" | null;
}

interface Ctx {
  snap: SessionSnapshot;
  int: Internal;
  readonly effects: Effect[];
}

const INITIAL_INTERNAL: Internal = {
  speakingIndex: null,
  turnActive: false,
  turnDone: false,
  turnCommitted: false,
  usage: null,
  replayUpTo: null,
  pendingHowToSay: false,
  didntUnderstandCount: 0,
  lastRequest: null,
  errorOrigin: null,
};

export function llmErrorMessage(error: LlmError): string {
  switch (error.kind) {
    case "invalid-key":
      return "Chiave non valida: controlla l'etichetta";
    case "zdr-cors":
      return "Questa chiave non può essere usata dal browser (organizzazione con ritenzione zero)";
    case "spend-limit":
      return "Hai raggiunto il limite di spesa impostato in Settings > Billing";
    case "rate-limited": {
      const seconds =
        error.retryAfterMs === undefined ? null : Math.max(1, Math.ceil(error.retryAfterMs / 1000));
      return seconds === null
        ? "Troppe richieste: riprova tra poco"
        : `Troppe richieste: riprova tra ${seconds} s`;
    }
    case "overloaded":
      return "Il modello è sovraccarico, riprova tra poco";
    case "server":
      return "Errore del servizio, riprova";
    case "network":
      return "Il servizio non risponde";
    case "timeout":
      return "Filo spezzato: nessuna risposta";
    case "refusal":
      return "Vera non può rispondere a questo: proviamo un'altra frase";
    case "max-tokens":
      return "Risposta interrotta: riprova";
    case "bad-request":
      return "Richiesta non valida: riprova";
    default:
      return "Errore sconosciuto";
  }
}

/** Italian messages for recognizer errors that stop the session (docs/PIANO.md §1.2). */
export function inputErrorMessage(code: SpeechInputErrorCode): string {
  switch (code) {
    case "audio-capture":
      return "Nessun microfono: controlla cuffie o Bluetooth";
    case "not-allowed":
      return "Microfono chiuso: consenti il microfono nel browser e riprova, oppure scrivi";
    case "service-not-allowed":
      return "Attiva Siri o la Dettatura, oppure scrivi";
    case "unsupported":
      return "Questo browser non ascolta: usa la modalità testo";
    case "network":
      return "Il riconoscimento ha bisogno di rete";
    case "timeout":
      return "Non ti sento: tocca per riprovare";
    case "language-not-supported":
      return "Lingua non disponibile su questo dispositivo";
    default:
      return "Errore del riconoscimento: tocca per riprovare";
  }
}

const NOT_HEARD_MESSAGE = "Non ti sento: tocca per riprovare";

export function createSessionMachine(options: SessionMachineOptions): SessionMachine {
  const initial: SessionSnapshot = {
    state: "setup",
    mode: null,
    listenLang: options.initialListenLang ?? "it-IT",
    englishVariant: variantOf(options),
    slowMode: false,
    interim: "",
    transcript: "",
    segments: [],
    spokenUpTo: -1,
    lastResponse: null,
    lastError: null,
    turnStartedAtMs: null,
    timings: {},
    turnsCompleted: 0,
  };
  let snapshot = initial;
  let internal = INITIAL_INTERNAL;

  return {
    get snapshot() {
      return snapshot;
    },
    dispatch(event: SessionEvent): SessionStepResult {
      const ctx: Ctx = { snap: snapshot, int: internal, effects: [] };
      reduce(ctx, event, options);
      snapshot = ctx.snap;
      internal = ctx.int;
      return { snapshot, effects: ctx.effects };
    },
  };
}

function set(ctx: Ctx, patch: Partial<SessionSnapshot>): void {
  ctx.snap = { ...ctx.snap, ...patch };
}

function setInt(ctx: Ctx, patch: Partial<Internal>): void {
  ctx.int = { ...ctx.int, ...patch };
}

function rateFor(ctx: Ctx): number {
  return ctx.snap.slowMode ? SLOW_RATE : NORMAL_RATE;
}

function speak(ctx: Ctx, index: number, rate: number): void {
  const segment = ctx.snap.segments[index];
  if (segment === undefined) return;
  ctx.effects.push({ type: "speak", segment, index, rate });
  setInt(ctx, { speakingIndex: index });
}

/**
 * Leaves the current state cleanly: no recognizer, no utterance left behind. With
 * `alwaysAbort` the recognizer is aborted even when the machine believes it is closed
 * (cheap, and it protects the half-duplex invariant against a late restart).
 */
function quiesce(ctx: Ctx, alwaysAbort = false): void {
  if (ctx.snap.state === "listening" || alwaysAbort) ctx.effects.push({ type: "abortListening" });
  if (ctx.snap.state === "speaking") ctx.effects.push({ type: "cancelSpeech" });
  setInt(ctx, { speakingIndex: null, replayUpTo: null });
}

/** Opens the microphone (handsfree) or waits for a press (push / text). */
function relisten(ctx: Ctx): void {
  if (ctx.snap.mode === "handsfree") {
    set(ctx, { state: "listening" });
    ctx.effects.push({ type: "listen", lang: ctx.snap.listenLang, mode: "continuous" });
  } else {
    set(ctx, { state: "idle" });
  }
}

function startRequest(
  ctx: Ctx,
  request: { readonly userText: string; readonly help?: HelpKind },
  now: number,
): void {
  quiesce(ctx, true);
  set(ctx, {
    state: "thinking",
    interim: "",
    lastError: null,
    turnStartedAtMs: now,
    timings: {},
    segments: [],
    spokenUpTo: -1,
  });
  setInt(ctx, {
    speakingIndex: null,
    turnActive: true,
    turnDone: false,
    turnCommitted: false,
    usage: null,
    replayUpTo: null,
    pendingHowToSay: false,
    didntUnderstandCount: 0,
    lastRequest: request,
    errorOrigin: null,
  });
  const effect: Effect =
    request.help === undefined
      ? { type: "callLlm", userText: request.userText }
      : { type: "callLlm", userText: request.userText, help: request.help };
  ctx.effects.push(effect);
}

/** Commits the finished turn exactly once (usage, timings, history). */
function commitTurn(ctx: Ctx): boolean {
  const response = ctx.snap.lastResponse;
  const usage = ctx.int.usage;
  if (response === null || usage === null || ctx.int.turnCommitted) return false;
  ctx.effects.push({ type: "commitTurn", response, usage, timings: ctx.snap.timings });
  set(ctx, { turnsCompleted: ctx.snap.turnsCompleted + 1 });
  setInt(ctx, { turnActive: false, turnCommitted: true, speakingIndex: null });
  return true;
}

function finishTurn(ctx: Ctx): void {
  if (commitTurn(ctx)) relisten(ctx);
}

function indexOfLastEnglish(segments: readonly Segment[]): number {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (segment !== undefined && segment.lang === "EN" && segment.kind !== "ASK") return i;
  }
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i]?.lang === "EN") return i;
  }
  return segments.length - 1;
}

/**
 * What "ripeti" repeats: the reply being streamed or spoken (even if LLM_DONE has not
 * arrived yet), otherwise the last committed reply.
 */
function replaySource(ctx: Ctx): readonly Segment[] {
  if (ctx.int.turnActive) return ctx.snap.segments;
  return ctx.snap.lastResponse?.segments ?? [];
}

/** Re-speaks from `from` to `upTo` (inclusive, null = to the end) at `rate`, then relistens. */
function replay(ctx: Ctx, from: number, upTo: number | null, rate: number): boolean {
  const segments = replaySource(ctx);
  if (segments.length === 0 || from < 0 || from >= segments.length) return false;
  const committed = ctx.int.turnCommitted || !ctx.int.turnActive;
  quiesce(ctx);
  // While the turn is active `segments` is already the current list: later LLM_SEGMENTs
  // keep appending in order. After a commit the list is restored from the last response.
  set(ctx, { state: "speaking", interim: "", segments, spokenUpTo: from - 1 });
  // A reply still streaming is restarted and keeps the normal flow (commit at the end);
  // a committed one is a pure replay that must not be committed twice.
  const last = upTo === null ? segments.length - 1 : Math.min(upTo, segments.length - 1);
  setInt(ctx, { replayUpTo: committed ? last : null });
  speak(ctx, from, rate);
  return true;
}

function applyHelp(ctx: Ctx, kind: HelpKind, payload: string | undefined, text: string, now: number): void {
  switch (kind) {
    case "REPEAT": {
      if (!replay(ctx, 0, null, rateFor(ctx))) {
        ctx.effects.push({ type: "notify", level: "info", message: "Non c'è ancora niente da ripetere" });
      }
      return;
    }
    case "SLOWER": {
      set(ctx, { slowMode: true });
      if (!replay(ctx, 0, null, SLOW_RATE)) {
        ctx.effects.push({ type: "notify", level: "info", message: "Non c'è ancora niente da ripetere" });
      }
      return;
    }
    case "DIDNT_UNDERSTAND": {
      const count = ctx.int.didntUnderstandCount + 1;
      setInt(ctx, { didntUnderstandCount: count });
      const segments = replaySource(ctx);
      if (count === 1 && segments.length > 0) {
        const index = indexOfLastEnglish(segments);
        replay(ctx, index, index, SLOW_RATE);
        return;
      }
      startRequest(ctx, { userText: text.trim() || DIDNT_UNDERSTAND_TEXT, help: "DIDNT_UNDERSTAND" }, now);
      return;
    }
    case "HOW_TO_SAY": {
      if (payload !== undefined && payload.trim().length > 0) {
        startRequest(ctx, { userText: payload.trim(), help: "HOW_TO_SAY" }, now);
        return;
      }
      quiesce(ctx);
      set(ctx, { state: "listening", interim: "" });
      setInt(ctx, { pendingHowToSay: true });
      ctx.effects.push({ type: "notify", level: "info", message: "Dimmelo in italiano" });
      ctx.effects.push({ type: "listen", lang: "it-IT", mode: "utterance" });
      return;
    }
  }
}

function acceptsInput(ctx: Ctx, event: SessionEvent): boolean {
  const { state } = ctx.snap;
  if (event.type === "FINAL") return state === "listening";
  // Typed text is accepted while listening, at rest (text mode), while Vera speaks and
  // after an error (a new sentence is the most natural way out of it).
  return state === "listening" || state === "idle" || state === "speaking" || state === "error";
}

function handleInput(ctx: Ctx, text: string, now: number): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  if (ctx.int.pendingHowToSay) {
    startRequest(ctx, { userText: trimmed, help: "HOW_TO_SAY" }, now);
    return;
  }
  const help = matchHelp(trimmed);
  if (help !== null) {
    applyHelp(ctx, help.kind, help.payload, trimmed, now);
    return;
  }
  set(ctx, { transcript: trimmed });
  startRequest(ctx, { userText: trimmed }, now);
}

function appendSegment(ctx: Ctx, segment: Segment, index: number, atMs: number): void {
  if (index !== ctx.snap.segments.length) {
    ctx.effects.push({
      type: "log",
      message: `segment ${index} out of order (have ${ctx.snap.segments.length})`,
    });
    return;
  }
  const timings: TurnTimings =
    index === 0 && ctx.snap.turnStartedAtMs !== null && ctx.snap.timings.firstSegmentMs === undefined
      ? { ...ctx.snap.timings, firstSegmentMs: atMs - ctx.snap.turnStartedAtMs }
      : ctx.snap.timings;
  set(ctx, { segments: [...ctx.snap.segments, segment], timings });
  const { state } = ctx.snap;
  if (state === "thinking") {
    set(ctx, { state: "speaking" });
    speak(ctx, index, rateFor(ctx));
  } else if (state === "speaking" && ctx.int.speakingIndex === null && index === ctx.snap.spokenUpTo + 1) {
    speak(ctx, index, rateFor(ctx));
  }
  // Otherwise (speaking with an utterance in flight, or interrupted) the segment waits.
}

function fail(ctx: Ctx, origin: "llm" | "input", kind: string, message: string): void {
  quiesce(ctx, origin === "llm");
  set(ctx, { state: "error", interim: "", lastError: { message, kind } });
  setInt(ctx, { errorOrigin: origin, turnActive: false, pendingHowToSay: false });
  ctx.effects.push({ type: "notify", level: "error", message });
}

function reduce(ctx: Ctx, event: SessionEvent, options: SessionMachineOptions): void {
  const { state } = ctx.snap;
  switch (event.type) {
    case "SETUP_DONE": {
      if (state === "setup") set(ctx, { state: "idle" });
      return;
    }
    case "START": {
      if (state !== "idle" && state !== "error") return;
      set(ctx, { mode: event.mode, lastError: null, interim: "" });
      setInt(ctx, { errorOrigin: null, pendingHowToSay: false });
      if (event.mode === "handsfree" && event.deferListen !== true) {
        set(ctx, { state: "listening" });
        ctx.effects.push({ type: "listen", lang: ctx.snap.listenLang, mode: "continuous" });
      } else {
        set(ctx, { state: "idle" });
      }
      return;
    }
    case "RESET_SETUP": {
      if (state === "setup") return;
      ctx.effects.push({ type: "abortListening" }, { type: "cancelSpeech" });
      set(ctx, { state: "setup", mode: null, interim: "", lastError: null, segments: [], spokenUpTo: -1 });
      setInt(ctx, INITIAL_INTERNAL);
      return;
    }
    case "STOP": {
      if (state === "setup") return;
      ctx.effects.push({ type: "abortListening" }, { type: "cancelSpeech" });
      set(ctx, { state: "idle", mode: null, interim: "", lastError: null });
      setInt(ctx, {
        speakingIndex: null,
        replayUpTo: null,
        pendingHowToSay: false,
        turnActive: false,
        errorOrigin: null,
      });
      return;
    }
    case "PRESS": {
      if (state !== "idle" || ctx.snap.mode !== "push") return;
      set(ctx, { state: "listening", interim: "" });
      ctx.effects.push({ type: "listen", lang: ctx.snap.listenLang, mode: "utterance" });
      return;
    }
    case "RELEASE": {
      if (state !== "listening" || ctx.snap.mode !== "push") return;
      ctx.effects.push({ type: "stopListening" });
      return;
    }
    case "INPUT_START":
    case "TICK":
      return;
    case "INTERIM": {
      if (state === "listening") set(ctx, { interim: event.text });
      return;
    }
    case "FINAL":
    case "TEXT_SUBMIT": {
      if (!acceptsInput(ctx, event)) return;
      handleInput(ctx, event.text, options.now());
      return;
    }
    case "HELP": {
      if (state === "thinking") {
        ctx.effects.push({ type: "notify", level: "info", message: "Aspetta: Vera sta pensando" });
        return;
      }
      if (state !== "listening" && state !== "idle" && state !== "speaking") return;
      applyHelp(ctx, event.kind, undefined, "", options.now());
      return;
    }
    case "INPUT_ERROR": {
      if (state !== "listening") return;
      if (event.code === "no-speech" || event.code === "aborted") return;
      fail(ctx, "input", event.code, inputErrorMessage(event.code));
      return;
    }
    case "INPUT_END": {
      if (state !== "listening" || event.cause === "own-abort") return;
      // Idempotent on a closed recognizer; it also closes the level meter in the app.
      ctx.effects.push({ type: "abortListening" });
      set(ctx, { state: "idle", interim: "" });
      setInt(ctx, { pendingHowToSay: false });
      ctx.effects.push({ type: "notify", level: "info", message: NOT_HEARD_MESSAGE });
      return;
    }
    case "INTERRUPT": {
      if (state !== "speaking") return;
      ctx.effects.push({ type: "cancelSpeech" });
      setInt(ctx, { speakingIndex: null, replayUpTo: null });
      relisten(ctx);
      return;
    }
    case "LLM_FIRST_TOKEN": {
      if (!ctx.int.turnActive || ctx.snap.turnStartedAtMs === null) return;
      if (ctx.snap.timings.firstTokenMs !== undefined) return;
      set(ctx, { timings: { ...ctx.snap.timings, firstTokenMs: event.atMs - ctx.snap.turnStartedAtMs } });
      return;
    }
    case "LLM_SEGMENT": {
      if (!ctx.int.turnActive) return;
      appendSegment(ctx, event.segment, event.index, event.atMs);
      return;
    }
    case "LLM_DONE": {
      if (!ctx.int.turnActive) return;
      handleLlmDone(ctx, event.response, event.usage, event.atMs, options);
      return;
    }
    case "LLM_RETRY": {
      if (!ctx.int.turnActive) return;
      if (state === "speaking") {
        ctx.effects.push({ type: "cancelSpeech" });
        set(ctx, { state: "thinking" });
      }
      // The partial reply is forgotten; the timings restart from the original request.
      set(ctx, { segments: [], spokenUpTo: -1, timings: {} });
      setInt(ctx, { speakingIndex: null, turnDone: false, usage: null, replayUpTo: null });
      return;
    }
    case "LLM_ERROR": {
      if (!ctx.int.turnActive) return;
      const message = llmErrorMessage(event.error);
      if (state !== "thinking" && state !== "speaking") {
        // The learner already walked away from this turn (barge-in): report, do not block.
        setInt(ctx, { turnActive: false });
        ctx.effects.push({ type: "notify", level: "warn", message });
        return;
      }
      fail(ctx, "llm", event.error.kind, message);
      return;
    }
    case "SPEAK_START": {
      if (ctx.int.speakingIndex !== event.index) return;
      if (event.index !== 0 || ctx.int.replayUpTo !== null || ctx.snap.turnStartedAtMs === null) return;
      if (ctx.snap.timings.firstAudioMs !== undefined) return;
      set(ctx, { timings: { ...ctx.snap.timings, firstAudioMs: event.atMs - ctx.snap.turnStartedAtMs } });
      return;
    }
    case "SPEAK_DONE": {
      if (state !== "speaking" || ctx.int.speakingIndex !== event.index) return;
      set(ctx, { spokenUpTo: event.index });
      setInt(ctx, { speakingIndex: null });
      if (event.outcome === "cancelled") return;
      if (event.outcome === "error")
        ctx.effects.push({ type: "log", message: `speak ${event.index} failed` });
      const replayUpTo = ctx.int.replayUpTo;
      if (replayUpTo !== null) {
        if (event.index < replayUpTo && ctx.snap.segments[event.index + 1] !== undefined) {
          speak(ctx, event.index + 1, rateFor(ctx));
        } else {
          setInt(ctx, { replayUpTo: null });
          relisten(ctx);
        }
        return;
      }
      if (ctx.snap.segments[event.index + 1] !== undefined) {
        speak(ctx, event.index + 1, rateFor(ctx));
      } else if (ctx.int.turnDone) {
        finishTurn(ctx);
      }
      // Otherwise more segments may still come: wait for them.
      return;
    }
    case "RETRY": {
      if (state !== "error") return;
      set(ctx, { lastError: null });
      if (ctx.int.errorOrigin === "llm" && ctx.int.lastRequest !== null) {
        startRequest(ctx, ctx.int.lastRequest, options.now());
        return;
      }
      setInt(ctx, { errorOrigin: null });
      relisten(ctx);
      return;
    }
  }
}

function handleLlmDone(
  ctx: Ctx,
  response: TurnResponse,
  usage: LlmUsage,
  atMs: number,
  options: SessionMachineOptions,
): void {
  const previousLang = ctx.snap.listenLang;
  const variant = variantOf(options);
  set(ctx, {
    lastResponse: response,
    englishVariant: variant,
    listenLang: langToTag(response.listen.lang, variant),
  });
  setInt(ctx, { turnDone: true, usage });
  // Segments the stream did not deliver one by one (or that closed with the final JSON).
  for (let i = ctx.snap.segments.length; i < response.segments.length; i += 1) {
    const segment = response.segments[i];
    if (segment !== undefined) appendSegment(ctx, segment, i, atMs);
  }
  const { state } = ctx.snap;
  if (state === "thinking" || state === "speaking") {
    if (ctx.int.speakingIndex === null && ctx.snap.spokenUpTo === ctx.snap.segments.length - 1)
      finishTurn(ctx);
    return;
  }
  // Interrupted (barge-in): commit without speaking so the usage is counted and the
  // history stays append-only; keep listening, in the new language if it changed.
  commitTurn(ctx);
  if (state === "listening" && ctx.snap.listenLang !== previousLang && ctx.snap.mode === "handsfree") {
    ctx.effects.push({ type: "listen", lang: ctx.snap.listenLang, mode: "continuous" });
  }
}
