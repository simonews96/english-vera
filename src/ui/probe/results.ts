/**
 * Probe result model and the plain-text label the user pastes back (never contains secrets:
 * the diagnostics part already passes through `redactSecrets`, the results carry none).
 */

import { redactSecrets } from "../../core/redact/redact";

export type CheckId =
  | "piattaforma"
  | "voce-sbloccata"
  | "voci"
  | "boundary"
  | "ascolto"
  | "wake-lock"
  | "vibrazione"
  | "microfono";

export type CheckStatus = "in attesa" | "in corso" | "ok" | "no" | "errore";

export interface CheckResult {
  readonly id: CheckId;
  readonly title: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export const CHECK_TITLES: Readonly<Record<CheckId, string>> = {
  piattaforma: "Piattaforma",
  "voce-sbloccata": "Voce sbloccata",
  voci: "Voci",
  boundary: "Boundary",
  ascolto: "Ascolto",
  "wake-lock": "Schermo acceso",
  vibrazione: "Vibrazione",
  microfono: "Microfono",
};

export const CHECK_ORDER: readonly CheckId[] = [
  "piattaforma",
  "voce-sbloccata",
  "voci",
  "boundary",
  "ascolto",
  "wake-lock",
  "vibrazione",
  "microfono",
];

export function initialResults(): CheckResult[] {
  return CHECK_ORDER.map((id) => ({ id, title: CHECK_TITLES[id], status: "in attesa", detail: "" }));
}

/** True when every check that matters for a phone session passed. */
export function probePassed(results: readonly CheckResult[]): boolean {
  const required: readonly CheckId[] = ["voce-sbloccata", "voci", "ascolto", "microfono"];
  return required.every((id) => results.find((r) => r.id === id)?.status === "ok");
}

/** "Prova del telefono · 2026-10-02 14:31" plus one line per check, then the diagnostics. */
export function formatProbeResults(
  results: readonly CheckResult[],
  diagnosticsText: string,
  now: Date = new Date(),
): string {
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  const width = Math.max(...results.map((r) => r.title.length)) + 2;
  const lines = results.map((r) => {
    const title = r.title.padEnd(width, ".");
    return r.detail ? `${title} ${r.status} · ${r.detail}` : `${title} ${r.status}`;
  });
  const text = [`PROVA DEL TELEFONO · ${stamp}`, ...lines, "", diagnosticsText.trim()].join("\n");
  return redactSecrets(text);
}
