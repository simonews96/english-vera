/**
 * The app controller: wires the pure session machine to the voice engines, the Claude client,
 * the loom view, the composition label and the diagnostics. Every state change goes through
 * the machine; this file only executes its effects and feeds it events.
 */

import { type CostMeter, createCostMeter } from "../core/cost/meter";
import { formatUsd, PRICE_TABLE } from "../core/cost/pricing";
import type { DiagnosticsError } from "../core/diagnostics/label";
import { createCalibrationStore, createPacer, estimateWordTimings } from "../core/pacing/clock";
import { buildLearnerCard, buildUserMessage, FIRST_TURN_TEXT } from "../core/prompt/card";
import { SYSTEM_PROMPT_STABLE } from "../core/prompt/system";
import { createSessionMachine, llmErrorMessage } from "../core/session/machine";
import type {
  Effect,
  HelpKind,
  LoomState,
  SessionEvent,
  SessionSnapshot,
  TurnTimings,
} from "../core/session/types";
import { createSegmentExtractor } from "../core/turn/incremental";
import { type Lang, langToTag, type Segment } from "../core/turn/schema";
import { parseTurnResponse } from "../core/turn/validate";
import { createClaudeClient } from "../llm/client";
import { toLlmError } from "../llm/errors";
import { PRESETS, resolvePreset } from "../llm/presets";
import {
  EMPTY_USAGE,
  type HistoryMessage,
  type LlmClient,
  LlmError,
  type LlmTurnRequest,
  type LlmUsage,
} from "../llm/types";
import { detectPlatform, type PlatformInfo, usesUtteranceProfile } from "../platform/detect";
import { createWakeLock } from "../platform/wakelock";
import { createSettingsStore, type Settings, type SettingsStore } from "../storage/settings";
import {
  applyAppearance,
  createLabel,
  type Label,
  readLangOffset,
  TEST_PHRASE_EN,
  TEST_PHRASE_IT,
} from "../ui/label";
import { createLoom, type Loom, type LoomNotice, type LoomRow, type LoomViewModel } from "../ui/loom";
import { createProbe, type Probe } from "../ui/probe";
import { createMicLevel, type MicLevel } from "../voice/mic-level";
import { createTextInput } from "../voice/text-input";
import { createTextOutput } from "../voice/text-output";
import type { SpeechInput, SpeechOutput } from "../voice/types";
import { createWebSpeechInput, SpeechInputStartError, type WebSpeechInput } from "../voice/web-speech-input";
import { createWebSpeechOutput, type WebSpeechOutput } from "../voice/web-speech-output";
import { type DiagnosticsSource, diagnosticsJson, diagnosticsText } from "./diagnostics";
import { setupPwa } from "./pwa";

export interface AppOptions {
  readonly version?: string;
  readonly commit?: string;
  readonly win?: Window & typeof globalThis;
}

export interface AppHandle {
  dispatch(event: SessionEvent): void;
  snapshot(): SessionSnapshot;
  destroy(): void;
}

const BASE_ITALIAN_SHARE = 0.65;
const THINKING_PATIENCE_MS = 6000;
const MAX_ERRORS = 5;

/** Automatic retries per error kind (docs/PIANO.md §1.1); the SDK itself never retries. */
const RETRY_LIMITS: Partial<Record<LlmError["kind"], number>> = {
  "rate-limited": 3,
  overloaded: 1,
  server: 1,
  network: 1,
  timeout: 1,
  "max-tokens": 1,
};
const RETRY_BACKOFF_MS = 1500;
const RETRY_WAIT_CAP_MS = 60_000;
const RETRY_MESSAGES: Partial<Record<LlmError["kind"], string>> = {
  overloaded: "Il modello è sovraccarico: riprovo",
  server: "Errore del servizio: riprovo",
  network: "Il servizio non risponde: riprovo",
  timeout: "Filo spezzato: riprovo",
  "max-tokens": "Risposta interrotta: riprovo",
};

/** Retry bookkeeping of one turn, carried across the attempts. */
interface Attempt {
  readonly retries: Readonly<Partial<Record<LlmError["kind"], number>>>;
  readonly refusalHandled: boolean;
}

const FIRST_ATTEMPT: Attempt = { retries: {}, refusalHandled: false };

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Where the microphone permission lives, for the browser in use (docs/PIANO.md §1.2). */
export function micSteps(platform: PlatformInfo): string {
  if (platform.os === "ios") {
    return "Su iPhone: tocca «aA» nella barra degli indirizzi, poi Impostazioni sito web > Microfono > Consenti.";
  }
  if (platform.os === "android") {
    return "Su Android: tocca il lucchetto nella barra degli indirizzi, poi Autorizzazioni > Microfono > Consenti.";
  }
  if (platform.browser === "safari") {
    return "In Safari: menu Safari > Impostazioni per questo sito > Microfono > Consenti.";
  }
  return "Sul PC: tocca il lucchetto nella barra degli indirizzi, poi Microfono > Consenti, e ricarica la pagina.";
}

function retryNotice(error: LlmError, leftMs: number): string {
  if (error.kind === "rate-limited") {
    return `Troppe richieste: riprovo tra ${Math.max(1, Math.ceil(leftMs / 1000))} s`;
  }
  return RETRY_MESSAGES[error.kind] ?? "Riprovo";
}

export function startApp(root: HTMLElement, options: AppOptions = {}): AppHandle {
  const win = options.win ?? window;
  const now = (): number => Date.now();
  const version = options.version ?? "dev";
  const commit = options.commit ?? "";

  const settings: SettingsStore = createSettingsStore(win.localStorage);
  const platform: PlatformInfo = detectPlatform(win);
  applyAppearance(settings.get());

  const meter: CostMeter = createCostMeter();
  const calibration = createCalibrationStore();
  const pacer = createPacer();
  const wakeLock = createWakeLock(win.document, win.navigator);

  // ---- Engines -----------------------------------------------------------------------
  let webInput: WebSpeechInput | null = null;
  let webOutput: WebSpeechOutput | null = null;
  let input: SpeechInput;
  let output: SpeechOutput;
  /** The learner types (text mode, or a browser that cannot listen). */
  let typedInput = false;
  let unsubscribeInput: () => void = () => {};
  let micLevel: MicLevel | null = null;
  let micUnsubscribe: () => void = () => {};
  let micPermission = "non richiesto";
  let reactivitySource = "nessuna";

  function ensureWebInput(): WebSpeechInput | null {
    if (!platform.hasSpeechRecognition) return null;
    webInput = webInput ?? createWebSpeechInput({ platform, document: win.document });
    return webInput;
  }

  function ensureWebOutput(): WebSpeechOutput | null {
    if (!platform.hasSpeechSynthesis) return null;
    webOutput = webOutput ?? createWebSpeechOutput({ platform });
    return webOutput;
  }

  /**
   * Text mode only changes the input: Vera keeps her voice whenever the browser has one
   * (the keyboard is for who cannot speak or be heard, docs/PIANO.md §1.7). The silent
   * TextOutput serves browsers without synthesis and the tests.
   */
  function buildEngines(current: Settings): void {
    unsubscribeInput();
    micStop();
    const voiceInput = current.textMode ? null : ensureWebInput();
    typedInput = voiceInput === null;
    input = voiceInput ?? createTextInput();
    output = ensureWebOutput() ?? createTextOutput({ msPerChar: 25 });
    unsubscribeInput = input.subscribe((event) => {
      switch (event.type) {
        case "start":
          dispatch({ type: "INPUT_START" });
          break;
        case "interim":
          pulseFromInterim();
          dispatch({ type: "INTERIM", text: event.text });
          break;
        case "final":
          transcriptLang = snapshot.listenLang.startsWith("it") ? "IT" : "EN";
          dispatch({ type: "FINAL", text: event.text });
          break;
        case "end":
          dispatch({ type: "INPUT_END", cause: event.cause });
          break;
        case "error":
          // Silence and our own aborts are routine: they would push the real errors out of the label.
          if (event.code !== "no-speech" && event.code !== "aborted") {
            rememberError(`ascolto:${event.code}`, event.message);
          }
          dispatch({ type: "INPUT_ERROR", code: event.code, message: event.message });
          break;
      }
    });
    reactivitySource = typedInput
      ? "nessuna (testo)"
      : usesUtteranceProfile(platform)
        ? "risultati provvisori del riconoscitore"
        : "microfono (Web Audio)";
  }

  // ---- Session state -------------------------------------------------------------------
  const machine = createSessionMachine({
    now,
    englishVariant: () => settings.get().englishVariant,
    initialListenLang: "it-IT",
  });
  let snapshot: SessionSnapshot = machine.snapshot;
  let transcriptLang: Lang = "IT";
  const history: HistoryMessage[] = [];
  const rows: LoomRow[] = [];
  let sessionKnots = 0;
  let turnsThisSession = 0;
  let notice: LoomNotice | null = null;
  /** A sticky notice survives the change of phase (e.g. "tocca per sentire Vera"). */
  let noticeSticky = false;
  let offline = !win.navigator.onLine;
  let italianShare = 1;
  let lastTimings: TurnTimings = {};
  let boundaryMode: "yes" | "no" | "estimated" = "estimated";
  let lastCalibrationVoice = "";
  const errors: DiagnosticsError[] = [];
  let pendingUserText = "";
  let activeTurn = 0;
  /** Generation of the utterance in flight: a late outcome of an older one is ignored. */
  let speakSeq = 0;
  /** Model that produced the reply being committed (the refusal fallback changes it). */
  let lastTurnModel = "";
  let thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  let client: LlmClient | null = null;
  let clientKey = "";
  let probe: Probe | null = null;
  let destroyed = false;

  function setNotice(next: LoomNotice | null, sticky = false): void {
    notice = next;
    noticeSticky = next !== null && sticky;
  }

  function rememberError(code: string, message: string): void {
    errors.unshift({ code, at: new Date().toISOString(), message });
    if (errors.length > MAX_ERRORS) errors.length = MAX_ERRORS;
  }

  function getClient(apiKey: string): LlmClient | null {
    if (!apiKey) return null;
    if (!client || clientKey !== apiKey) {
      client = createClaudeClient({ apiKey });
      clientKey = apiKey;
    }
    return client;
  }

  function shareTarget(): number {
    return clamp01(BASE_ITALIAN_SHARE + readLangOffset(win.localStorage) / 100);
  }

  /** At rest: nothing is listening, speaking or pending, so a reload would interrupt nothing. */
  function atRest(): boolean {
    return snapshot.state === "setup" || (snapshot.state === "idle" && snapshot.mode === null);
  }

  // ---- View ----------------------------------------------------------------------------
  const loom: Loom = createLoom(
    root,
    {
      onThresholdTap: thresholdTap,
      onThresholdPressStart: () => {
        output.unlock();
        dispatch({ type: "PRESS" });
      },
      onThresholdPressEnd: () => dispatch({ type: "RELEASE" }),
      onStop: stopSession,
      onInterrupt: () => dispatch({ type: "INTERRUPT" }),
      onHelp: (kind: HelpKind) => {
        output.unlock();
        dispatch({ type: "HELP", kind });
      },
      onTextSubmit: (text) => {
        output.unlock();
        if (snapshot.state === "setup") {
          setNotice({
            level: "warn",
            text: "Prima serve la chiave API.",
            action: { label: "Apri le impostazioni", id: "settings" },
          });
          render();
          return;
        }
        if (snapshot.state === "idle" && snapshot.mode === null) beginSession(true);
        transcriptLang = /[àèéìòù]|\b(?:il|la|di|che|non|per)\b/i.test(text) ? "IT" : "EN";
        dispatch({ type: "TEXT_SUBMIT", text });
      },
      onNoticeAction: (id) => {
        if (id === "settings") label.open("chiave");
        else if (id === "retry") {
          output.unlock();
          setNotice(null);
          dispatch({ type: "RETRY" });
        } else if (id === "text-mode") settings.update({ textMode: true });
        else if (id === "probe") openProbe();
        else if (id === "unlock-replay") {
          // Inside the tap: iOS unlocks the synthesizer only here, then the reply is said again.
          output.unlock();
          setNotice(null);
          dispatch({ type: "HELP", kind: "REPEAT" });
        }
      },
      onOpenLabel: () => label.open(snapshot.state === "setup" ? "chiave" : undefined),
      onRowTap: (id) => {
        const row = rows.find((r) => r.id === id);
        if (!row || snapshot.state !== "idle") return;
        output.unlock();
        const current = settings.get();
        void output.speak(row.textEn, {
          lang: current.englishVariant,
          ...(current.voiceEn ? { voiceId: current.voiceEn } : {}),
          rate: current.rate,
        });
      },
    },
    {
      reducedMotion: () =>
        settings.get().motion === "reduced" ||
        (settings.get().motion === "system" && win.matchMedia("(prefers-reduced-motion: reduce)").matches),
      platformTouch: platform.touch,
    },
  );

  // The engines exist before the label asks them for the voice list.
  buildEngines(settings.get());

  function diagnosticsSource(): DiagnosticsSource {
    const current = settings.get();
    const preset = resolvePreset(current);
    return {
      version,
      commit,
      platform,
      webInput: typedInput ? null : webInput,
      webOutput,
      textMode: current.textMode,
      listenLang: snapshot.listenLang,
      reactivitySource,
      micPermission,
      online: !offline,
      modelId: preset.model,
      presetId: preset.id,
      tableVersion: PRICE_TABLE.version,
      lastTurn: lastTimings,
      boundaryMode,
      calibration: lastCalibrationVoice ? calibration.get(lastCalibrationVoice) : 1,
      calibrationVoice: lastCalibrationVoice,
      errors,
      rows: rows.length,
      turns: turnsThisSession,
      wakeLock: wakeLock.active(),
    };
  }

  const label: Label = createLabel(root, {
    settings,
    listVoices: () => output.listVoices(),
    previewVoice: (voiceId, lang) => {
      if (snapshot.state === "speaking" || snapshot.state === "thinking") {
        // Cancelling the session's utterance would leave the machine waiting for it.
        setNotice({ level: "info", text: "Aspetta che Vera finisca, poi riprova il provino." });
        render();
        return;
      }
      output.unlock();
      output.cancel();
      const current = settings.get();
      void output.speak(lang === "en" ? TEST_PHRASE_EN : TEST_PHRASE_IT, {
        lang: lang === "en" ? current.englishVariant : "it-IT",
        voiceId,
        rate: current.rate,
      });
    },
    validateKey: async (key) => {
      const result = await createClaudeClient({ apiKey: key }).validateKey();
      if (result.ok) {
        client = null;
        return { ok: true, models: result.models };
      }
      rememberError(`chiave:${result.error.kind}`, result.error.message);
      return { ok: false, message: llmErrorMessage(result.error) };
    },
    costSummary: () => meter.summary(),
    diagnosticsText: () => diagnosticsText(diagnosticsSource()),
    diagnosticsJson: () => diagnosticsJson(diagnosticsSource()),
    micTest: () => {
      let test: MicLevel | null = null;
      let unsubscribe: () => void = () => {};
      return {
        async start(onLevel) {
          test = createMicLevel();
          unsubscribe = test.subscribe(onLevel);
          await test.start();
          micPermission = "concesso";
        },
        stop() {
          unsubscribe();
          test?.stop();
          test = null;
        },
      };
    },
    openProbe,
    forgetKey: () => {
      activeTurn += 1;
      settings.forgetKey();
      client = null;
      clientKey = "";
      dispatch({ type: "RESET_SETUP" });
      void wakeLock.release();
      setNotice({
        level: "info",
        text: "Chiave dimenticata su questo dispositivo. Per ricominciare serve una chiave.",
        action: { label: "Apri le impostazioni", id: "settings" },
      });
      render();
    },
    appVersion: version,
  });

  function buildViewModel(): LoomViewModel {
    const current = settings.get();
    const summary = meter.summary();
    const speakingIndex = snapshot.state === "speaking" ? snapshot.spokenUpTo + 1 : -1;
    return {
      state: snapshot.state,
      mode: snapshot.mode,
      textMode: typedInput,
      interim: snapshot.interim,
      transcript: snapshot.transcript === FIRST_TURN_TEXT ? "" : snapshot.transcript,
      transcriptLang,
      vera: snapshot.segments.map((segment, index) => ({
        text: segment.text,
        lang: segment.lang,
        kind: segment.kind,
        status: index <= snapshot.spokenUpTo ? "done" : index === speakingIndex ? "speaking" : "pending",
        inkedWords: index <= snapshot.spokenUpTo ? wordCount(segment.text) : 0,
      })),
      rows,
      italianShare,
      notice,
      offline,
      errorKind: snapshot.lastError?.kind ?? null,
      costText: `oggi ${formatUsd(summary.todayUsd)}`,
      budgetFraction: current.dailyBudgetUsd > 0 ? summary.todayUsd / current.dailyBudgetUsd : 0,
      sessionKnots,
    };
  }

  function render(): void {
    if (destroyed) return;
    loom.render(buildViewModel());
  }

  // ---- Microphone level (desktop only) -----------------------------------------------
  function micStart(): void {
    if (micLevel || typedInput || usesUtteranceProfile(platform) || !platform.hasGetUserMedia) return;
    const level = createMicLevel();
    micLevel = level;
    micUnsubscribe = level.subscribe((value) => loom.setMicLevel(value));
    level.start().then(
      () => {
        micPermission = "concesso";
      },
      () => {
        micPermission = "negato o assente";
        micStop();
      },
    );
  }

  function micStop(): void {
    micUnsubscribe();
    micUnsubscribe = () => {};
    micLevel?.stop();
    micLevel = null;
    loom.setMicLevel(0);
  }

  let pulseTimer: ReturnType<typeof setTimeout> | null = null;
  function pulseFromInterim(): void {
    if (micLevel) return;
    loom.setMicLevel(0.6);
    if (pulseTimer) clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => loom.setMicLevel(0), 400);
  }

  // ---- Effects --------------------------------------------------------------------------
  function runEffect(effect: Effect): void {
    switch (effect.type) {
      case "listen":
        input.start({ lang: effect.lang, mode: effect.mode }).then(
          () => micStart(),
          (error: unknown) => {
            const code = error instanceof SpeechInputStartError ? error.code : "unknown";
            const message = error instanceof Error ? error.message : String(error);
            if (code !== "aborted" && code !== "no-speech") rememberError(`ascolto:${code}`, message);
            dispatch({ type: "INPUT_ERROR", code, message });
          },
        );
        break;
      case "stopListening":
        input.stop();
        break;
      case "abortListening":
        input.abort();
        micStop();
        break;
      case "callLlm":
        void runTurn(effect.userText, effect.help);
        break;
      case "speak":
        speakSegment(effect.segment, effect.index, effect.rate);
        break;
      case "cancelSpeech":
        speakSeq += 1;
        output.cancel();
        pacer.cancel();
        break;
      case "commitTurn":
        commitTurn(effect.response.segments, effect.usage, effect.timings, effect.response.learned);
        break;
      case "notify": {
        const action = noticeAction(effect.level);
        const steps =
          effect.level === "error" && snapshot.lastError?.kind === "not-allowed"
            ? ` ${micSteps(platform)}`
            : "";
        setNotice({
          level: effect.level,
          text: `${effect.message}${steps}`,
          ...(action ? { action } : {}),
        });
        break;
      }
      case "log":
        break;
    }
  }

  function noticeAction(level: "info" | "warn" | "error"): { label: string; id: string } | null {
    if (level !== "error" || !snapshot.lastError) return null;
    const kind = snapshot.lastError.kind;
    if (kind === "invalid-key" || kind === "zdr-cors" || kind === "spend-limit") {
      return { label: "Apri le impostazioni", id: "settings" };
    }
    if (
      kind === "not-allowed" ||
      kind === "audio-capture" ||
      kind === "service-not-allowed" ||
      kind === "unsupported"
    ) {
      return { label: "Oppure scrivi", id: "text-mode" };
    }
    return { label: "Riprova", id: "retry" };
  }

  async function runTurn(userText: string, help?: HelpKind): Promise<void> {
    const turn = ++activeTurn;
    const current = settings.get();
    const llm = getClient(current.apiKey);
    if (!llm) {
      dispatch({ type: "LLM_ERROR", error: new LlmError("invalid-key", "chiave assente") });
      return;
    }
    pendingUserText = userText;
    const card = buildLearnerCard({
      name: current.learnerName,
      level: "A0",
      italianShareTarget: shareTarget(),
      slowMode: snapshot.slowMode,
      turnsThisSession,
      ...(help ? { help } : {}),
    });
    const request: LlmTurnRequest = {
      systemStable: SYSTEM_PROMPT_STABLE,
      learnerCard: "",
      history: [...history],
      userText: buildUserMessage(card, userText, help),
      preset: resolvePreset(current),
    };
    await streamTurn(llm, request, turn, FIRST_ATTEMPT);
  }

  /** Shows the countdown while waiting; returns early when the turn is superseded. */
  async function waitBeforeRetry(error: LlmError, waitMs: number, turn: number): Promise<void> {
    const until = now() + waitMs;
    while (turn === activeTurn && !destroyed) {
      const left = until - now();
      if (left <= 0) return;
      setNotice({ level: "warn", text: retryNotice(error, left) });
      render();
      await sleep(Math.min(1000, left));
    }
  }

  async function streamTurn(
    llm: LlmClient,
    request: LlmTurnRequest,
    turn: number,
    attempt: Attempt,
  ): Promise<void> {
    const extractor = createSegmentExtractor();
    let usage: LlmUsage = EMPTY_USAGE;
    let firstToken = false;
    let index = 0;
    const model = request.preset.model;
    lastTurnModel = model;
    const recordPartial = (): void => {
      if (usage.outputTokens > 0 || usage.inputTokens > 0) meter.record({ usage, model, partial: true });
    };
    try {
      for await (const event of llm.stream(request)) {
        if (turn !== activeTurn) break;
        switch (event.type) {
          case "text": {
            if (!firstToken) {
              firstToken = true;
              dispatch({ type: "LLM_FIRST_TOKEN", atMs: now() });
            }
            for (const segment of extractor.push(event.delta)) {
              dispatch({ type: "LLM_SEGMENT", segment, index: index++, atMs: now() });
            }
            break;
          }
          case "usage":
            usage = { ...usage, ...event.usage };
            break;
          case "done": {
            const parsed = parseTurnResponse(event.fullText);
            if (parsed.ok) {
              dispatch({ type: "LLM_DONE", response: parsed.response, usage: event.usage, atMs: now() });
            } else {
              meter.record({ usage: event.usage, model, partial: true });
              rememberError("risposta", parsed.reason);
              dispatch({ type: "LLM_ERROR", error: new LlmError("bad-request", parsed.reason) });
            }
            return;
          }
          case "error": {
            const error = event.error;
            recordPartial();
            if (error.kind === "refusal" && !attempt.refusalHandled && model !== PRESETS.haiku.model) {
              // One resend of the same context to Haiku; the partial reply is forgotten first.
              rememberError(`modello:${error.kind}`, error.message);
              dispatch({ type: "LLM_RETRY" });
              await streamTurn(llm, { ...request, preset: PRESETS.haiku }, turn, {
                ...attempt,
                refusalHandled: true,
              });
              return;
            }
            const used = attempt.retries[error.kind] ?? 0;
            if (used < (RETRY_LIMITS[error.kind] ?? 0)) {
              rememberError(`modello:${error.kind}`, error.message);
              const waitMs =
                error.kind === "rate-limited" && error.retryAfterMs !== undefined
                  ? Math.min(error.retryAfterMs, RETRY_WAIT_CAP_MS)
                  : RETRY_BACKOFF_MS * (used + 1);
              dispatch({ type: "LLM_RETRY" });
              await waitBeforeRetry(error, waitMs, turn);
              if (turn !== activeTurn || destroyed) return;
              await streamTurn(llm, request, turn, {
                ...attempt,
                retries: { ...attempt.retries, [error.kind]: used + 1 },
              });
              return;
            }
            rememberError(`modello:${error.kind}`, error.message);
            dispatch({ type: "LLM_ERROR", error });
            return;
          }
        }
      }
      // Left by a newer turn or a stop: what the model already produced is still paid for.
      if (turn !== activeTurn) recordPartial();
    } catch (error: unknown) {
      const llmError = toLlmError(error);
      rememberError(`modello:${llmError.kind}`, llmError.message);
      if (turn === activeTurn) dispatch({ type: "LLM_ERROR", error: llmError });
    }
  }

  function speakSegment(segment: Segment, index: number, rate: number): void {
    const current = settings.get();
    const lang = langToTag(segment.lang, current.englishVariant);
    const voiceId = segment.lang === "IT" ? current.voiceIt : current.voiceEn;
    const calibrationKey = voiceId ?? lang;
    const factor = calibration.get(calibrationKey);
    // The calibration compares the real duration with the raw estimate: feeding it the
    // corrected one would make the factor converge to the square root of the truth.
    const rawMs = estimateWordTimings(segment.text, segment.lang, rate, 1).totalMs;
    const seq = ++speakSeq;
    const voiced = output === webOutput;
    let startedAt = 0;
    let sawBoundary = false;
    void output
      .speak(segment.text, {
        lang,
        ...(voiceId ? { voiceId } : {}),
        rate,
        onStart: () => {
          if (seq !== speakSeq) return;
          startedAt = now();
          dispatch({ type: "SPEAK_START", index, atMs: startedAt });
          pacer.start(segment.text, segment.lang, rate, factor, (word) => loom.setSpeakingWord(index, word));
        },
        onBoundary: (charIndex) => {
          if (seq !== speakSeq) return;
          sawBoundary = true;
          pacer.boundary(charIndex);
        },
      })
      .then((outcome) => {
        // An utterance replaced by a newer one (replay, interrupt, stop) has nothing left to
        // report: its late "cancelled" must not pass for the new utterance with the same index.
        if (seq !== speakSeq) return;
        if (outcome === "ended") {
          pacer.end();
          if (startedAt > 0) {
            calibration.observe(calibrationKey, rawMs, now() - startedAt);
            lastCalibrationVoice = calibrationKey;
          }
          if (noticeSticky) setNotice(null);
        } else {
          pacer.cancel();
        }
        if (outcome === "error" && output.capabilities.needsGesture) {
          // iPhone: the utterance was discarded because no gesture unlocked the voice yet.
          setNotice(
            {
              level: "warn",
              text: "La voce non è partita.",
              action: { label: "Tocca per sentire Vera", id: "unlock-replay" },
            },
            true,
          );
        }
        boundaryMode = voiced ? (sawBoundary ? "yes" : "estimated") : "no";
        dispatch({ type: "SPEAK_DONE", index, outcome });
      });
  }

  function commitTurn(
    segments: readonly Segment[],
    usage: LlmUsage,
    timings: TurnTimings,
    learned: readonly { text_en: string; gloss_it: string; topic: LoomRow["topic"] }[],
  ): void {
    history.push({ role: "user", text: pendingUserText });
    history.push({ role: "assistant", text: segments.map((segment) => segment.text).join(" ") });
    turnsThisSession += 1;
    lastTimings = timings;
    meter.record({ usage, model: lastTurnModel || resolvePreset(settings.get()).model });
    for (const item of learned) {
      rows.unshift({
        id: `row-${rows.length + 1}-${now()}`,
        textEn: item.text_en,
        glossIt: item.gloss_it,
        weight: 300,
        topic: item.topic,
      });
    }
    const total = segments.reduce((sum, segment) => sum + segment.text.length, 0);
    const italian = segments
      .filter((segment) => segment.lang === "IT")
      .reduce((sum, segment) => sum + segment.text.length, 0);
    if (total > 0) italianShare = clamp01(italianShare * 0.6 + (italian / total) * 0.4);
    label.refresh();
  }

  // ---- Session control -------------------------------------------------------------------
  /** Starts a session: wake lock, counters, one knot; `deferListen` when Vera speaks first. */
  function beginSession(deferListen = false): void {
    output.unlock();
    void wakeLock.request();
    meter.startSession();
    sessionKnots += 1;
    setNotice(null);
    dispatch({ type: "START", mode: settings.get().listenMode, deferListen });
  }

  function thresholdTap(): void {
    const state = snapshot.state;
    if (state === "setup") {
      label.open("chiave");
      return;
    }
    if (state === "idle") {
      // The first turn is Vera's (greeting and first sentence): the microphone opens after it.
      const greet = history.length === 0;
      if (snapshot.mode === null) beginSession(greet);
      else {
        output.unlock();
        dispatch({ type: "START", mode: snapshot.mode, deferListen: greet });
      }
      if (greet) dispatch({ type: "TEXT_SUBMIT", text: FIRST_TURN_TEXT });
      return;
    }
    if (state === "listening" || state === "repeating") {
      stopSession();
      return;
    }
    if (state === "error") {
      output.unlock();
      setNotice(null);
      dispatch({ type: "RETRY" });
    }
  }

  function stopSession(): void {
    activeTurn += 1;
    dispatch({ type: "STOP" });
    void wakeLock.release();
    pwa.applyPendingUpdate();
  }

  function dispatch(event: SessionEvent): void {
    if (destroyed) return;
    const previous: LoomState = snapshot.state;
    const result = machine.dispatch(event);
    snapshot = result.snapshot;
    const next = snapshot.state;
    // Stale hints go before the effects of this very transition add theirs ("Dimmelo in
    // italiano" must survive the switch to listening that carries it).
    if (previous !== next) {
      const leavingError = previous === "error";
      const newPhase = next === "listening" || next === "speaking";
      if (notice && !noticeSticky && (leavingError || (newPhase && notice.level !== "error")))
        setNotice(null);
    }
    for (const effect of result.effects) runEffect(effect);
    afterTransition(previous, next);
    render();
  }

  function afterTransition(previous: LoomState, next: LoomState): void {
    if (previous === next) return;
    if (thinkingTimer) {
      clearTimeout(thinkingTimer);
      thinkingTimer = null;
    }
    if (next === "thinking") {
      thinkingTimer = setTimeout(() => {
        if (snapshot.state === "thinking" && notice === null) {
          setNotice({ level: "info", text: "Ci sto mettendo più del solito." });
          render();
        }
      }, THINKING_PATIENCE_MS);
    }
    if (atRest()) pwa.applyPendingUpdate();
  }

  // ---- Probe page -------------------------------------------------------------------------
  function openProbe(): void {
    if (probe) return;
    // The probe owns the microphone and the voice while it runs.
    stopSession();
    label.close();
    probe = createProbe(root, {
      platform,
      // Always the real engines when the browser has them, whatever the input mode says.
      speechInput: ensureWebInput() ?? input,
      speechOutput: ensureWebOutput() ?? output,
      requestWakeLock: () => wakeLock.request(),
      onClose: () => {
        probe?.destroy();
        probe = null;
        if (win.location.hash === "#prova") win.history.replaceState(null, "", win.location.pathname);
      },
      diagnosticsText: () => diagnosticsText(diagnosticsSource()),
      voices: {
        englishVariant: settings.get().englishVariant,
        voiceEn: settings.get().voiceEn,
        voiceIt: settings.get().voiceIt,
      },
    });
  }

  // ---- Wiring -----------------------------------------------------------------------------
  const pwa = setupPwa({
    canApplyNow: atRest,
    onUpdateReady: (apply) => {
      if (!apply()) {
        setNotice({ level: "info", text: "Vera si è aggiornata: si ricarica alla prossima pausa." });
        render();
      }
    },
  });

  const onOnline = (): void => {
    offline = false;
    render();
  };
  const onOffline = (): void => {
    offline = true;
    render();
  };
  win.addEventListener("online", onOnline);
  win.addEventListener("offline", onOffline);
  const onHashChange = (): void => {
    if (win.location.hash === "#prova") openProbe();
  };
  win.addEventListener("hashchange", onHashChange);

  let lastSettings = settings.get();
  const unsubscribeSettings = settings.subscribe((current) => {
    applyAppearance(current);
    if (current.textMode !== lastSettings.textMode) {
      stopSession();
      buildEngines(current);
    }
    if (snapshot.state === "setup" && current.apiKey && current.keyValidatedAt) {
      setNotice(null);
      dispatch({ type: "SETUP_DONE" });
    }
    lastSettings = current;
    render();
  });

  const initial = settings.get();
  if (initial.apiKey) {
    // Any listening mode starts at rest: the session begins with the first tap or press.
    dispatch({ type: "SETUP_DONE" });
  }
  if (!initial.apiKey) {
    setNotice({
      level: "info",
      text: "Per cominciare serve la tua chiave API: resta solo su questo dispositivo.",
      action: { label: "Apri le impostazioni", id: "settings" },
    });
  } else if (!platform.hasSpeechRecognition && !initial.textMode) {
    setNotice({
      level: "warn",
      text: "Qui posso parlare ma non ascoltarti: scrivi nella riga in basso. Su PC apri Vera in Chrome o Edge.",
    });
  }
  render();
  onHashChange();

  return {
    dispatch,
    snapshot: () => snapshot,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      activeTurn += 1;
      speakSeq += 1;
      unsubscribeSettings();
      unsubscribeInput();
      input.abort();
      output.cancel();
      pacer.cancel();
      micStop();
      void wakeLock.release();
      if (thinkingTimer) clearTimeout(thinkingTimer);
      if (pulseTimer) clearTimeout(pulseTimer);
      win.removeEventListener("online", onOnline);
      win.removeEventListener("offline", onOffline);
      win.removeEventListener("hashchange", onHashChange);
      probe?.destroy();
      label.destroy();
      loom.destroy();
    },
  };
}
