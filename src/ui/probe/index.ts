/**
 * "Prova del telefono": a full-screen page that runs the checks a phone must pass on day one
 * (docs/PIANO.md §4, milestone 1) and produces a label the user pastes back. The run starts
 * from a tap: iOS requires the voice unlock and the microphone permission inside a gesture.
 */

import "./probe.css";
import type { PlatformInfo } from "../../platform/detect";
import type { WakeLockOutcome } from "../../platform/wakelock";
import type { SpeechInput, SpeechOutput } from "../../voice/types";
import { COPIED_FEEDBACK_MS, copyText } from "../label/clipboard";
import { el, heading, setText, word } from "../label/dom";
import {
  checkBoundary,
  checkListening,
  checkMicrophone,
  checkPlatform,
  checkVibration,
  checkVoices,
  checkVoiceUnlocked,
  checkWakeLock,
  type VoiceChoice,
} from "./checks";
import {
  type CheckId,
  type CheckResult,
  type CheckStatus,
  formatProbeResults,
  initialResults,
  probePassed,
} from "./results";

export type { CheckId, CheckResult, CheckStatus } from "./results";
export { formatProbeResults, probePassed } from "./results";

export interface ProbeDeps {
  readonly platform: PlatformInfo;
  readonly speechInput: SpeechInput;
  readonly speechOutput: SpeechOutput;
  requestWakeLock(): Promise<WakeLockOutcome>;
  onClose(): void;
  diagnosticsText(): string;
  /** Saved voice choices; defaults to en-GB with automatic voices. */
  readonly voices?: Partial<VoiceChoice>;
  readonly now?: () => Date;
}

export interface Probe {
  /** Runs every check in order. Call it from a tap handler; a second call while running is ignored. */
  run(): Promise<void>;
  destroy(): void;
}

const IOS_INSTALL_HINT =
  "Su iPhone puoi aggiungere Vera alla schermata Home: Condividi > Aggiungi alla schermata Home. Poi ripeti la prova dall'app installata.";

export function createProbe(container: HTMLElement, deps: ProbeDeps): Probe {
  const now = deps.now ?? (() => new Date());
  const choice: VoiceChoice = {
    englishVariant: deps.voices?.englishVariant ?? "en-GB",
    voiceEn: deps.voices?.voiceEn ?? null,
    voiceIt: deps.voices?.voiceIt ?? null,
  };
  let results: CheckResult[] = initialResults();
  let running: Promise<void> | null = null;
  let destroyed = false;
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  const rows = new Map<CheckId, { row: HTMLElement; status: HTMLElement; detail: HTMLElement }>();
  const list = el("ol", { className: "probe-list" });
  for (const result of results) {
    const status = el("span", { className: "probe-status", text: result.status });
    const detail = el("span", { className: "probe-detail", text: "" });
    const row = el("li", { className: "probe-row", dataset: { check: result.id, status: result.status } }, [
      el("span", { className: "probe-title", text: result.title }),
      status,
      detail,
    ]);
    rows.set(result.id, { row, status, detail });
    list.append(row);
  }

  const instruction = el("p", { className: "probe-instruction", attrs: { "aria-live": "polite" } });
  const hint = el("p", { className: "probe-hint" });
  hint.hidden = true;

  const update = (id: CheckId, status: CheckStatus, detail: string): void => {
    results = results.map((r) => (r.id === id ? { ...r, status, detail } : r));
    const row = rows.get(id);
    if (!row) return;
    row.row.dataset.status = status;
    setText(row.status, status);
    setText(row.detail, detail);
  };

  const startWord = word(
    "Inizia la prova",
    () => {
      void run();
    },
    { className: "probe-start" },
  );
  const copyWord = word("Copia esito", () => {
    void copyText(formatProbeResults(results, deps.diagnosticsText(), now())).then((done) => {
      setText(copyWord, done ? "Copiato" : "Copia non riuscita");
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        setText(copyWord, "Copia esito");
        copiedTimer = null;
      }, COPIED_FEEDBACK_MS);
    });
  });
  const closeWord = word("Chiudi", () => deps.onClose());

  const page = el("section", { className: "probe", attrs: { "aria-labelledby": "probe-title" } }, [
    el("header", { className: "probe-head" }, [
      el("h1", { className: "probe-title-main", text: "Prova del telefono", attrs: { id: "probe-title" } }),
      closeWord,
    ]),
    el("p", {
      className: "probe-intro",
      text: "Otto controlli in sequenza: voce, voci, ascolto, schermo, vibrazione e microfono. Tieni il telefono vicino e, quando te lo chiedo, di' «hello Vera».",
    }),
    el("div", { className: "word-row" }, [startWord]),
    instruction,
    heading("Controlli"),
    list,
    hint,
    el("div", { className: "word-row probe-foot" }, [copyWord]),
  ]);
  container.append(page);

  const runChecks = async (): Promise<void> => {
    results = initialResults();
    for (const r of results) update(r.id, r.status, r.detail);
    hint.hidden = true;
    setText(startWord, "in corso…");
    startWord.disabled = true;

    const step = async (
      id: CheckId,
      work: () => Promise<{ status: CheckStatus; detail: string }>,
    ): Promise<void> => {
      if (destroyed) return;
      update(id, "in corso", "");
      const outcome = await work();
      if (destroyed) return;
      update(id, outcome.status, outcome.detail);
    };

    update("piattaforma", "ok", checkPlatform(deps.platform).detail);
    await step("voce-sbloccata", () => checkVoiceUnlocked(deps.speechOutput, choice.voiceIt));
    await step("voci", () => checkVoices(deps.speechOutput, choice));
    await step("boundary", () => checkBoundary(deps.speechOutput, choice));
    setText(instruction, "Ora di' «hello Vera».");
    await step("ascolto", () => checkListening(deps.speechInput, choice.englishVariant));
    setText(instruction, "");
    await step("wake-lock", () => checkWakeLock(deps.requestWakeLock));
    await step("vibrazione", () => Promise.resolve(checkVibration(globalThis.navigator)));
    await step("microfono", () => checkMicrophone(globalThis.navigator));

    if (destroyed) return;
    const passed = probePassed(results);
    setText(
      instruction,
      passed
        ? "Prova superata: copia l'esito e incollamelo."
        : "Qualcosa non va: copia l'esito e incollamelo.",
    );
    if (passed && deps.platform.os === "ios" && !deps.platform.standalone) {
      setText(hint, IOS_INSTALL_HINT);
      hint.hidden = false;
    }
    setText(startWord, "Ripeti la prova");
    startWord.disabled = false;
  };

  const run = (): Promise<void> => {
    if (destroyed) return Promise.resolve();
    if (running) return running;
    // Inside the tap, before any await: iOS unlocks the synthesizer only here.
    try {
      deps.speechOutput.unlock();
    } catch {
      // A synthesizer that cannot unlock still gets its "voce sbloccata" verdict from the speak below.
    }
    running = runChecks().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    run,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (copiedTimer) clearTimeout(copiedTimer);
      deps.speechInput.abort();
      deps.speechOutput.cancel();
      page.remove();
    },
  };
}
