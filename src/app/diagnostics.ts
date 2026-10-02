/**
 * Assembles the diagnostics ("etichetta di composizione") from the live parts of the app.
 * Everything passes through the redacting formatter in core/diagnostics.
 */

import {
  buildStandardSections,
  type DiagnosticsError,
  type DiagnosticsInput,
  formatLabel,
  labelToJson,
} from "../core/diagnostics/label";
import type { TurnTimings } from "../core/session/types";
import type { PlatformInfo } from "../platform/detect";
import type { WebSpeechInput } from "../voice/web-speech-input";
import type { WebSpeechOutput } from "../voice/web-speech-output";

export interface DiagnosticsSource {
  readonly version: string;
  readonly commit: string;
  readonly platform: PlatformInfo;
  readonly webInput: WebSpeechInput | null;
  readonly webOutput: WebSpeechOutput | null;
  readonly textMode: boolean;
  readonly listenLang: string;
  readonly reactivitySource: string;
  readonly micPermission: string;
  readonly online: boolean;
  readonly modelId: string;
  readonly presetId: string;
  readonly tableVersion: string;
  readonly lastTurn: TurnTimings;
  readonly boundaryMode: "yes" | "no" | "estimated";
  readonly calibration: number;
  readonly calibrationVoice: string;
  readonly errors: readonly DiagnosticsError[];
  readonly rows: number;
  readonly turns: number;
  readonly wakeLock: boolean;
}

export function diagnosticsInput(source: DiagnosticsSource): DiagnosticsInput {
  const inputDiag = source.webInput?.diagnostics();
  const outputDiag = source.webOutput?.diagnostics();
  const resolution = outputDiag
    ? [
        outputDiag.lastResolution.en ? `en: gradino ${outputDiag.lastResolution.en.step}` : null,
        outputDiag.lastResolution.it ? `it: gradino ${outputDiag.lastResolution.it.step}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" · ")
    : undefined;
  return {
    build: { version: source.version, hash: source.commit },
    platform: {
      browser: source.platform.browser,
      os: source.platform.os,
      standalone: source.platform.standalone,
      userAgent: source.platform.userAgent,
    },
    recognizer: {
      profile: source.textMode ? "testo" : (inputDiag?.profile ?? "assente"),
      lang: source.listenLang,
      ...(inputDiag?.lastEndCause ? { lastEndCause: inputDiag.lastEndCause } : {}),
      onDevice: false,
    },
    voices: {
      ...(outputDiag ? { available: outputDiag.voiceCount } : {}),
      ...(outputDiag?.lastResolution.en ? { chosenEn: outputDiag.lastResolution.en.name } : {}),
      ...(outputDiag?.lastResolution.it ? { chosenIt: outputDiag.lastResolution.it.name } : {}),
      ...(resolution ? { resolutionStep: resolution } : {}),
    },
    mic: { permission: source.micPermission, reactivitySource: source.reactivitySource },
    echoCancellation: "nessuna: microfono chiuso mentre Vera parla",
    network: { online: source.online },
    model: { id: source.modelId, preset: source.presetId, tableVersion: source.tableVersion },
    lastTurn: source.lastTurn,
    pacing: {
      boundary: source.boundaryMode,
      calibration: source.calibration,
      voiceId: source.calibrationVoice,
    },
    lastErrors: source.errors,
    totals: { rows: source.rows, turns: source.turns },
    power: { wakeLock: source.wakeLock, mediaSession: "spenta" },
  };
}

export function diagnosticsText(source: DiagnosticsSource, now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  return formatLabel(buildStandardSections(diagnosticsInput(source)), {
    header: `Vera · etichetta diagnostica · ${stamp}`,
  });
}

export function diagnosticsJson(source: DiagnosticsSource): string {
  return labelToJson(buildStandardSections(diagnosticsInput(source)));
}
