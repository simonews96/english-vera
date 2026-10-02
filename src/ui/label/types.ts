/**
 * Contract between the label (settings, cost, diagnostics panel) and the app layer.
 * The label never talks to the engines directly: every capability comes in through `LabelDeps`.
 */

import type { SettingsStore } from "../../storage/settings";
import type { VoiceInfo } from "../../voice/types";

export type LabelSectionId =
  | "voce"
  | "lingua"
  | "microfono"
  | "chiave"
  | "modello"
  | "modalita"
  | "tema"
  | "movimento"
  | "costo"
  | "dati"
  | "composizione";

export type KeyValidationOutcome =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly message: string };

export interface LabelCostSummary {
  readonly todayUsd: number;
  readonly sessionUsd: number;
  readonly totalUsd: number;
  readonly todayTurns: number;
  readonly tableVersion: string;
}

export interface MicTest {
  /** Opens the microphone and reports a 0..1 level; rejects with an Italian message. */
  start(onLevel: (level: number) => void): Promise<void>;
  stop(): void;
}

export interface LabelDeps {
  readonly settings: SettingsStore;
  listVoices(): Promise<readonly VoiceInfo[]>;
  previewVoice(voiceId: string, lang: "en" | "it"): void;
  validateKey(key: string): Promise<KeyValidationOutcome>;
  costSummary(): LabelCostSummary;
  diagnosticsText(): string;
  diagnosticsJson(): string;
  micTest(): MicTest;
  openProbe(): void;
  forgetKey(): void;
  readonly appVersion: string;
}

export type LabelLayout = "sheet" | "side" | "bench";

export interface LabelOptions {
  /** Overrides the viewport detection (tests, or an app that decides the layout itself). */
  readonly layout?: () => "phone" | "desktop";
  /** Storage for the language offset; defaults to localStorage. */
  readonly storage?: Storage | null;
  readonly now?: () => Date;
}

/** One rendered section: built once, refreshed in place. */
export interface Section {
  readonly id: LabelSectionId;
  readonly root: HTMLElement;
  refresh(): void;
  destroy(): void;
}

export interface SectionContext {
  readonly deps: LabelDeps;
  readonly storage: Storage | null;
  readonly now: () => Date;
}

export const TEST_PHRASE_EN = "Where is the gate for Rome?";
export const TEST_PHRASE_IT = "Dove si ritira il bagaglio?";

export const SHARED_ORIGIN_WARNING =
  "La chiave resta solo in questo browser. Attenzione: tutti i siti GitHub Pages dello stesso account condividono l'origine simonews96.github.io e potrebbero leggerla; non pubblicare altri siti su questo account.";
