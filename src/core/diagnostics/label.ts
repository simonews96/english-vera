/**
 * The "etichetta di composizione": the copyable diagnostics block (docs/PIANO.md §1.7).
 * Plain text with dotted leaders that pastes cleanly into an email, plus the same data as
 * JSON ("mostra grezzo"). Every output passes through `redactSecrets`.
 */

import { redactSecrets } from "../redact/redact";
import type { TurnTimings } from "../session/types";

export interface LabelEntry {
  readonly key: string;
  readonly value: string | number | boolean | null;
}

export interface LabelSection {
  readonly title: string;
  readonly entries: readonly LabelEntry[];
}

export interface FormatLabelOptions {
  /** Line width in characters (default 56, minimum 24). */
  readonly width?: number;
  /** First line, e.g. "Vera · etichetta diagnostica · 2026-10-02 14:31". */
  readonly header?: string;
}

const MISSING = "—";
const DEFAULT_WIDTH = 56;
const MIN_WIDTH = 24;
const INDENT = "  ";

function renderValue(value: LabelEntry["value"]): string {
  if (value === null) return MISSING;
  if (typeof value === "boolean") return value ? "sì" : "no";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : MISSING;
  const text = value.trim();
  return text === "" ? MISSING : text;
}

/** Breaks a line into chunks of at most `width` characters, preferring spaces; long tokens are cut. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let current = "";
    for (const token of paragraph.split(/\s+/).filter((t) => t !== "")) {
      let piece = token;
      while (piece.length > width) {
        if (current !== "") {
          lines.push(current);
          current = "";
        }
        lines.push(piece.slice(0, width));
        piece = piece.slice(width);
      }
      if (current === "") current = piece;
      else if (current.length + 1 + piece.length <= width) current = `${current} ${piece}`;
      else {
        lines.push(current);
        current = piece;
      }
    }
    lines.push(current);
  }
  return lines;
}

function formatEntry(entry: LabelEntry, width: number): string[] {
  // Redact before layout: wrapping could otherwise split a key into fragments no pattern matches.
  const key = redactSecrets(entry.key.trim());
  const value = redactSecrets(renderValue(entry.value));
  const singleLine = !value.includes("\n");
  // "key ······ value": at least two leader dots between key and value.
  const leaders = width - key.length - value.length - 2;
  if (singleLine && leaders >= 2) return [`${key} ${".".repeat(leaders)} ${value}`];
  // Too long: leaders fill the key line, the value goes below, indented and wrapped.
  const fill = Math.max(2, width - key.length - 1);
  const keyLine = `${key} ${".".repeat(fill)}`;
  return [keyLine, ...wrap(value, width - INDENT.length).map((line) => `${INDENT}${line}`)];
}

/**
 * Two-column text with dotted leaders, one uppercase title line per section, an optional
 * header line first. Monospace-friendly: every full line is exactly `width` characters.
 */
export function formatLabel(sections: readonly LabelSection[], options: FormatLabelOptions = {}): string {
  const width = Math.max(MIN_WIDTH, Math.floor(options.width ?? DEFAULT_WIDTH));
  const blocks: string[] = [];
  if (options.header !== undefined && options.header.trim() !== "")
    blocks.push(redactSecrets(options.header.trim()));
  for (const section of sections) {
    const lines = [redactSecrets(section.title.trim()).toLocaleUpperCase("it-IT")];
    for (const entry of section.entries) lines.push(...formatEntry(entry, width));
    blocks.push(lines.join("\n"));
  }
  return redactSecrets(blocks.join("\n\n"));
}

/**
 * The same data as pretty JSON: sections in the given order, entries sorted by key within
 * each section (deterministic regardless of insertion order; a repeated key keeps the last value).
 */
export function labelToJson(sections: readonly LabelSection[]): string {
  const out: Record<string, Record<string, LabelEntry["value"]>> = {};
  for (const section of sections) {
    const entries: Record<string, LabelEntry["value"]> = {};
    for (const entry of [...section.entries].sort((a, b) => a.key.localeCompare(b.key, "it"))) {
      entries[redactSecrets(entry.key)] =
        typeof entry.value === "string" ? redactSecrets(entry.value) : entry.value;
    }
    out[redactSecrets(section.title)] = entries;
  }
  // JSON escaping cannot split a key (keys have no quotes or backslashes), so a final pass is a safety net.
  return redactSecrets(JSON.stringify(out, null, 2));
}

/* ---------- Standard sections ---------- */

export type BoundaryMode = "yes" | "no" | "estimated";

export interface DiagnosticsError {
  readonly code: string;
  /** ISO timestamp or already-formatted time. */
  readonly at?: string;
  readonly message?: string;
}

export interface DiagnosticsSignal {
  readonly signal: string;
  readonly itemId?: string;
  readonly transcript?: string;
  readonly at?: string;
}

/** Everything the "Composizione" block lists (docs/PIANO.md §1.7). All optional: missing renders as "—". */
export interface DiagnosticsInput {
  readonly build?: { readonly version?: string; readonly hash?: string; readonly builtAt?: string };
  readonly platform?: {
    readonly browser?: string;
    readonly os?: string;
    readonly standalone?: boolean;
    readonly userAgent?: string;
  };
  readonly recognizer?: {
    readonly profile?: string;
    readonly lang?: string;
    readonly lastEndCause?: string;
    readonly onDevice?: boolean;
  };
  readonly voices?: {
    readonly available?: number;
    readonly chosenEn?: string;
    readonly chosenIt?: string;
    readonly resolutionStep?: string;
    readonly local?: boolean;
  };
  readonly mic?: {
    readonly permission?: string;
    /** 0..1 */
    readonly level?: number;
    /** 0..1 */
    readonly noiseFloor?: number;
    readonly reactivitySource?: string;
    readonly headphones?: string;
  };
  readonly echoCancellation?: string | boolean;
  readonly network?: { readonly online?: boolean; readonly type?: string };
  readonly model?: { readonly id?: string; readonly preset?: string; readonly tableVersion?: string };
  readonly lastTurn?: TurnTimings;
  readonly pacing?: {
    readonly boundary?: BoundaryMode;
    readonly calibration?: number;
    readonly voiceId?: string;
  };
  readonly lastErrors?: readonly DiagnosticsError[];
  readonly recentSignals?: readonly DiagnosticsSignal[];
  readonly totals?: { readonly rows?: number; readonly sessions?: number; readonly turns?: number };
  readonly storage?: {
    readonly usedBytes?: number;
    readonly quotaBytes?: number;
    readonly persisted?: boolean;
  };
  readonly sync?: { readonly status?: string; readonly lastAt?: string; readonly error?: string };
  readonly power?: { readonly wakeLock?: boolean | string; readonly mediaSession?: boolean | string };
}

type Value = LabelEntry["value"];

function text(value: string | undefined): Value {
  return value === undefined || value.trim() === "" ? null : value;
}

function flag(value: boolean | string | undefined): Value {
  return value === undefined ? null : typeof value === "boolean" ? value : text(value);
}

function count(value: number | undefined): Value {
  return value === undefined || !Number.isFinite(value) ? null : value;
}

function ms(value: number | undefined): Value {
  return value === undefined || !Number.isFinite(value) ? null : `${Math.round(value)} ms`;
}

function percent(value: number | undefined): Value {
  return value === undefined || !Number.isFinite(value) ? null : `${Math.round(value * 100)}%`;
}

/** Italian decimal comma, two decimals: 0.94 -> "0,94". */
function decimal(value: number | undefined): Value {
  return value === undefined || !Number.isFinite(value) ? null : value.toFixed(2).replace(".", ",");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return MISSING;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

function bytes(value: number | undefined): Value {
  return value === undefined ? null : formatBytes(value);
}

function boundary(mode: BoundaryMode | undefined): Value {
  if (mode === undefined) return null;
  return mode === "yes" ? "sì" : mode === "no" ? "no" : "stimati";
}

function joinParts(parts: readonly (string | undefined)[]): string {
  return parts.filter((p): p is string => p !== undefined && p.trim() !== "").join(" · ");
}

function listEntries(label: string, items: readonly string[] | undefined, emptyKey: string): LabelEntry[] {
  if (!items || items.length === 0) return [{ key: emptyKey, value: null }];
  return items.map((value, i) => ({ key: `${label} ${i + 1}`, value }));
}

/** The standard label: every field of "Composizione", in the plan's order, with Italian keys. */
export function buildStandardSections(input: DiagnosticsInput): LabelSection[] {
  const standalone = input.platform?.standalone;
  const errors = input.lastErrors?.map((e) => joinParts([e.code, e.at, e.message]));
  const signals = input.recentSignals?.map((s) =>
    joinParts([s.signal, s.itemId, s.transcript !== undefined ? `“${s.transcript}”` : undefined, s.at]),
  );
  return [
    {
      title: "Build",
      entries: [
        { key: "versione", value: text(input.build?.version) },
        { key: "hash", value: text(input.build?.hash) },
        { key: "compilata il", value: text(input.build?.builtAt) },
      ],
    },
    {
      title: "Piattaforma",
      entries: [
        { key: "browser", value: text(input.platform?.browser) },
        { key: "sistema", value: text(input.platform?.os) },
        {
          key: "modalità",
          value: standalone === undefined ? null : standalone ? "app installata" : "scheda",
        },
        { key: "user agent", value: text(input.platform?.userAgent) },
      ],
    },
    {
      title: "Ascolto",
      entries: [
        { key: "profilo", value: text(input.recognizer?.profile) },
        { key: "lingua", value: text(input.recognizer?.lang) },
        { key: "ultimo onend", value: text(input.recognizer?.lastEndCause) },
        { key: "sul dispositivo", value: flag(input.recognizer?.onDevice) },
      ],
    },
    {
      title: "Voci",
      entries: [
        { key: "disponibili", value: count(input.voices?.available) },
        { key: "inglese", value: text(input.voices?.chosenEn) },
        { key: "italiano", value: text(input.voices?.chosenIt) },
        { key: "gradino", value: text(input.voices?.resolutionStep) },
        { key: "locale", value: flag(input.voices?.local) },
      ],
    },
    {
      title: "Microfono",
      entries: [
        { key: "permesso", value: text(input.mic?.permission) },
        { key: "livello", value: percent(input.mic?.level) },
        { key: "rumore di fondo", value: percent(input.mic?.noiseFloor) },
        { key: "reattività da", value: text(input.mic?.reactivitySource) },
        { key: "cuffie", value: text(input.mic?.headphones) },
        { key: "cancellazione d'eco", value: flag(input.echoCancellation) },
      ],
    },
    {
      title: "Rete e modello",
      entries: [
        { key: "in linea", value: flag(input.network?.online) },
        { key: "connessione", value: text(input.network?.type) },
        { key: "modello", value: text(input.model?.id) },
        { key: "preset", value: text(input.model?.preset) },
        { key: "listino", value: text(input.model?.tableVersion) },
      ],
    },
    {
      title: "Ultimo turno",
      entries: [
        { key: "prima parola", value: ms(input.lastTurn?.firstTokenMs) },
        { key: "primo segmento", value: ms(input.lastTurn?.firstSegmentMs) },
        { key: "inizio voce", value: ms(input.lastTurn?.firstAudioMs) },
        { key: "boundary", value: boundary(input.pacing?.boundary) },
        { key: "calibrazione", value: decimal(input.pacing?.calibration) },
        { key: "voce calibrata", value: text(input.pacing?.voiceId) },
      ],
    },
    { title: "Ultimi errori", entries: listEntries("errore", errors, "errori") },
    { title: "Segnali recenti", entries: listEntries("segnale", signals, "segnali") },
    {
      title: "Archivio",
      entries: [
        { key: "righe", value: count(input.totals?.rows) },
        { key: "sessioni", value: count(input.totals?.sessions) },
        { key: "turni", value: count(input.totals?.turns) },
        { key: "spazio usato", value: bytes(input.storage?.usedBytes) },
        { key: "spazio disponibile", value: bytes(input.storage?.quotaBytes) },
        { key: "persistente", value: flag(input.storage?.persisted) },
      ],
    },
    {
      title: "Sincronizzazione",
      entries: [
        { key: "stato", value: text(input.sync?.status) },
        { key: "ultima", value: text(input.sync?.lastAt) },
        { key: "errore", value: text(input.sync?.error) },
      ],
    },
    {
      title: "Schermo e cuffie",
      entries: [
        { key: "wake lock", value: flag(input.power?.wakeLock) },
        { key: "media session", value: flag(input.power?.mediaSession) },
      ],
    },
  ];
}
