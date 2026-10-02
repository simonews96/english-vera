/**
 * The checks of the "prova del telefono", one function each, with no DOM: they take the
 * engines and return a status word plus an Italian detail line. Every check has a ceiling so
 * the page can never hang on an engine that emits nothing (Chromium's silent utterances,
 * a recogniser that never starts).
 */

import type { PlatformInfo } from "../../platform/detect";
import type { WakeLockOutcome } from "../../platform/wakelock";
import type { SpeechInput, SpeechInputEvent, SpeechOutput, VoiceInfo } from "../../voice/types";
import { resolveVoice } from "../../voice/voices";
import { TEST_PHRASE_EN } from "../label/types";
import type { CheckStatus } from "./results";

export interface CheckOutcome {
  readonly status: CheckStatus;
  readonly detail: string;
}

export const SPEAK_TIMEOUT_MS = 15_000;
export const LISTEN_TIMEOUT_MS = 8_000;
export const VOICE_TEST_IT = "Prova della voce";

const OS_NAMES: Readonly<Record<PlatformInfo["os"], string>> = {
  windows: "Windows",
  macos: "macOS",
  ios: "iOS",
  android: "Android",
  linux: "Linux",
  chromeos: "ChromeOS",
  unknown: "sistema sconosciuto",
};

const BROWSER_NAMES: Readonly<Record<PlatformInfo["browser"], string>> = {
  chrome: "Chrome",
  edge: "Edge",
  safari: "Safari",
  firefox: "Firefox",
  samsung: "Samsung Internet",
  unknown: "browser sconosciuto",
};

export function checkPlatform(platform: PlatformInfo): CheckOutcome {
  const parts = [
    OS_NAMES[platform.os],
    BROWSER_NAMES[platform.browser],
    `installata ${platform.standalone ? "sì" : "no"}`,
    platform.touch ? "touch" : "mouse",
  ];
  return { status: "ok", detail: parts.join(" · ") };
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export interface VoiceChoice {
  readonly englishVariant: "en-GB" | "en-US";
  readonly voiceEn: string | null;
  readonly voiceIt: string | null;
}

/** Speaks the Italian test phrase; `unlock()` must already have run inside the tap. */
export async function checkVoiceUnlocked(
  output: SpeechOutput,
  voiceIt: string | null,
): Promise<CheckOutcome> {
  if (!output.capabilities.available) return { status: "no", detail: "sintesi vocale assente" };
  const started = Date.now();
  const outcome = await withTimeout(
    output.speak(VOICE_TEST_IT, { lang: "it-IT", voiceId: voiceIt ?? undefined }),
    SPEAK_TIMEOUT_MS,
    "error" as const,
  );
  const ms = Date.now() - started;
  if (outcome === "ended") return { status: "ok", detail: `«${VOICE_TEST_IT}» detta in ${ms} ms` };
  if (outcome === "cancelled") return { status: "no", detail: "la frase è stata annullata prima della fine" };
  return { status: "errore", detail: "la frase non è stata detta (nessun evento o errore del motore)" };
}

export async function checkVoices(output: SpeechOutput, choice: VoiceChoice): Promise<CheckOutcome> {
  let voices: readonly VoiceInfo[];
  try {
    voices = await withTimeout(output.listVoices(), SPEAK_TIMEOUT_MS, []);
  } catch {
    voices = [];
  }
  if (voices.length === 0) return { status: "no", detail: "nessuna voce elencata dal browser" };
  const en = resolveVoice(voices, "en", choice.englishVariant, choice.voiceEn);
  const it = resolveVoice(voices, "it", choice.englishVariant, choice.voiceIt);
  const describe = (name: string, r: typeof en): string =>
    r.voice
      ? `${name}: ${r.voice.name} (${r.voice.local ? "locale" : "rete"}, gradino ${r.step})`
      : `${name}: nessuna`;
  return {
    status: en.voice && it.voice ? "ok" : "no",
    detail: `${voices.length} voci · ${describe("en", en)} · ${describe("it", it)}`,
  };
}

export async function checkBoundary(output: SpeechOutput, choice: VoiceChoice): Promise<CheckOutcome> {
  if (!output.capabilities.available) return { status: "no", detail: "sintesi vocale assente" };
  let boundaries = 0;
  const outcome = await withTimeout(
    output.speak(TEST_PHRASE_EN, {
      lang: choice.englishVariant,
      voiceId: choice.voiceEn ?? undefined,
      onBoundary: () => {
        boundaries += 1;
      },
    }),
    SPEAK_TIMEOUT_MS,
    "error" as const,
  );
  if (outcome === "error") return { status: "errore", detail: "la frase inglese non è stata detta" };
  if (boundaries > 0) return { status: "ok", detail: `sì · ${boundaries} eventi su 6 parole` };
  return { status: "no", detail: "nessun evento: l'animazione userà l'orologio stimato" };
}

function describeEvent(event: SpeechInputEvent): string {
  switch (event.type) {
    case "start":
      return "start";
    case "interim":
      return "interim";
    case "final":
      return `final «${event.text}»${event.confidence !== undefined ? ` (${event.confidence.toFixed(2)})` : ""}`;
    case "end":
      return `end:${event.cause}`;
    case "error":
      return `error:${event.code}`;
  }
}

/**
 * One utterance in English: resolves on the first final result, on an error, on `end`
 * without a result, or after the ceiling. Reports the whole event sequence.
 */
export function checkListening(input: SpeechInput, lang: "en-GB" | "en-US"): Promise<CheckOutcome> {
  if (!input.capabilities.available) {
    return Promise.resolve({
      status: "no",
      detail: `riconoscimento non disponibile (${input.capabilities.profile})`,
    });
  }
  return new Promise((resolve) => {
    const sequence: string[] = [];
    let settled = false;
    let unsubscribe = (): void => {};
    const finish = (status: CheckStatus, head: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve({ status, detail: `${head} · ${sequence.join(" → ") || "nessun evento"}` });
    };
    const timer = setTimeout(() => {
      input.abort();
      finish("no", `nessun risultato in ${LISTEN_TIMEOUT_MS / 1000} s`);
    }, LISTEN_TIMEOUT_MS);

    unsubscribe = input.subscribe((event) => {
      sequence.push(describeEvent(event));
      if (event.type === "final") {
        input.stop();
        finish("ok", `capito «${event.text}»`);
      } else if (event.type === "error") {
        finish("errore", `${event.code}: ${event.message}`);
      } else if (event.type === "end") {
        finish("no", "l'ascolto è finito senza una frase");
      }
    });

    input.start({ lang, mode: "utterance" }).catch((error: unknown) => {
      const code =
        typeof error === "object" && error !== null ? String((error as { code?: unknown }).code ?? "") : "";
      const message = error instanceof Error ? error.message : String(error);
      finish("errore", `avvio fallito ${code || message}`.trim());
    });
  });
}

export async function checkWakeLock(request: () => Promise<WakeLockOutcome>): Promise<CheckOutcome> {
  let outcome: WakeLockOutcome;
  try {
    outcome = await withTimeout(request(), 5_000, "unavailable");
  } catch {
    outcome = "unavailable";
  }
  if (outcome === "ok") return { status: "ok", detail: "lo schermo resta acceso durante la sessione" };
  if (outcome === "denied")
    return { status: "no", detail: "richiesta rifiutata (pagina nascosta o risparmio energetico)" };
  return { status: "no", detail: "API assente: lo schermo potrebbe spegnersi" };
}

export function checkVibration(nav: Navigator | undefined): CheckOutcome {
  if (!nav || typeof nav.vibrate !== "function") return { status: "no", detail: "API assente" };
  try {
    const accepted = nav.vibrate(10);
    return accepted ? { status: "ok", detail: "10 ms" } : { status: "no", detail: "rifiutata dal browser" };
  } catch {
    return { status: "errore", detail: "vibrate ha lanciato un errore" };
  }
}

export async function checkMicrophone(nav: Navigator | undefined): Promise<CheckOutcome> {
  const devices = nav?.mediaDevices;
  if (!devices || typeof devices.getUserMedia !== "function")
    return { status: "no", detail: "getUserMedia assente" };
  try {
    const stream = await devices.getUserMedia({ audio: true });
    const tracks = stream.getTracks();
    const label = tracks[0]?.label ?? "";
    for (const track of tracks) track.stop();
    return { status: "ok", detail: label ? `permesso concesso · ${label}` : "permesso concesso" };
  } catch (error) {
    const name =
      typeof error === "object" && error !== null ? String((error as { name?: unknown }).name ?? "") : "";
    if (name === "NotAllowedError" || name === "SecurityError")
      return { status: "no", detail: "permesso negato" };
    if (name === "NotFoundError") return { status: "no", detail: "nessun microfono trovato" };
    if (name === "NotReadableError")
      return { status: "errore", detail: "microfono occupato da un'altra app" };
    return { status: "errore", detail: name || "errore sconosciuto" };
  }
}
