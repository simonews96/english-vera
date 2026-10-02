import { describe, expect, it } from "vitest";
import {
  buildStandardSections,
  type DiagnosticsInput,
  formatBytes,
  formatLabel,
  type LabelSection,
  labelToJson,
} from "../../src/core/diagnostics/label";

const KEY = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCD";

const SAMPLE: LabelSection[] = [
  {
    title: "Voce",
    entries: [
      { key: "inglese", value: "Google UK English" },
      { key: "locale", value: true },
      { key: "rete", value: false },
      { key: "gradino", value: 3 },
      { key: "italiano", value: null },
      { key: "vuoto", value: "   " },
    ],
  },
  {
    title: "Errori",
    entries: [{ key: "errore 1", value: `invalid-key · 14:31 · Chiave non valida: ${KEY}` }],
  },
];

describe("formatLabel", () => {
  it("aligns every single-line entry to the width with dotted leaders", () => {
    const out = formatLabel([SAMPLE[0] as LabelSection], { width: 40 });
    const lines = out.split("\n");
    expect(lines[0]).toBe("VOCE");
    expect(lines[1]).toBe(`inglese ${".".repeat(14)} Google UK English`);
    expect(lines[2]).toBe(`locale ${".".repeat(30)} sì`);
    expect(lines[3]).toBe(`rete ${".".repeat(32)} no`);
    expect(lines[4]).toBe(`gradino ${".".repeat(30)} 3`);
    expect(lines[5]).toBe(`italiano ${".".repeat(29)} —`);
    expect(lines[6]).toBe(`vuoto ${".".repeat(32)} —`);
    for (const line of lines.slice(1)) expect(line).toHaveLength(40);
  });

  it("wraps long values on indented lines below the key", () => {
    const out = formatLabel(
      [
        {
          title: "x",
          entries: [
            { key: "user agent", value: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130" },
          ],
        },
      ],
      { width: 40 },
    );
    const lines = out.split("\n");
    expect(lines[1]).toBe("user agent .............................");
    expect(lines[1]).toHaveLength(40);
    expect(lines.slice(2)).toEqual(["  Mozilla/5.0 (Linux; Android 14)", "  AppleWebKit/537.36 Chrome/130"]);
    for (const line of lines.slice(2)) expect(line.length).toBeLessThanOrEqual(40);
  });

  it("cuts tokens longer than the width instead of overflowing", () => {
    const out = formatLabel([{ title: "x", entries: [{ key: "k", value: "a".repeat(50) }] }], { width: 30 });
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(30);
    expect(out).toContain("a".repeat(28));
  });

  it("puts the header first, a blank line between sections, and the default width at 56", () => {
    const out = formatLabel(SAMPLE, { header: "Vera · etichetta diagnostica · 2026-10-02 14:31" });
    const lines = out.split("\n");
    expect(lines[0]).toBe("Vera · etichetta diagnostica · 2026-10-02 14:31");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("VOCE");
    expect(lines[3]).toHaveLength(56);
    expect(out).toContain("\n\nERRORI\n");
  });

  it("redacts secrets before layout, so a wrapped key cannot leak in pieces", () => {
    const out = formatLabel(SAMPLE, { width: 40 });
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(KEY.slice(-12));
    expect(out).toContain("sk-ant-…ABCD");
    const titled = formatLabel([{ title: `Chiave ${KEY}`, entries: [{ key: KEY, value: 1 }] }], {
      header: `header ${KEY}`,
    });
    expect(titled).not.toContain(KEY);
  });

  it("never goes below the minimum width", () => {
    const out = formatLabel([{ title: "t", entries: [{ key: "k", value: "v" }] }], { width: 5 });
    expect(out.split("\n")[1]).toHaveLength(24);
  });
});

describe("labelToJson", () => {
  it("keeps sections in order, sorts entries by key and redacts", () => {
    const json = labelToJson(SAMPLE);
    expect(json).not.toContain(KEY);
    const parsed = JSON.parse(json) as Record<string, Record<string, unknown>>;
    expect(Object.keys(parsed)).toEqual(["Voce", "Errori"]);
    expect(Object.keys(parsed.Voce ?? {})).toEqual([
      "gradino",
      "inglese",
      "italiano",
      "locale",
      "rete",
      "vuoto",
    ]);
    expect(parsed.Voce?.locale).toBe(true);
    expect(parsed.Voce?.italiano).toBeNull();
    expect(parsed.Errori?.["errore 1"]).toBe("invalid-key · 14:31 · Chiave non valida: sk-ant-…ABCD");
    expect(json).toBe(JSON.stringify(parsed, null, 2));
  });
});

describe("buildStandardSections", () => {
  it("renders every field as — when nothing is known", () => {
    const sections = buildStandardSections({});
    const out = formatLabel(sections);
    expect(sections.map((s) => s.title)).toEqual([
      "Build",
      "Piattaforma",
      "Ascolto",
      "Voci",
      "Microfono",
      "Rete e modello",
      "Ultimo turno",
      "Ultimi errori",
      "Segnali recenti",
      "Archivio",
      "Sincronizzazione",
      "Schermo e cuffie",
    ]);
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("null");
    for (const section of sections) for (const entry of section.entries) expect(entry.value).toBeNull();
    expect(out).toContain("errori ");
    expect(out).toContain("segnali ");
  });

  it("formats the known values in Italian", () => {
    const input: DiagnosticsInput = {
      build: { version: "0.1.0", hash: "abc1234" },
      platform: { browser: "chrome", os: "android", standalone: true },
      recognizer: { profile: "android-utterance", lang: "en-GB", lastEndCause: "silence", onDevice: false },
      voices: { available: 12, chosenEn: "Google UK English", resolutionStep: "exact", local: true },
      mic: {
        permission: "granted",
        level: 0.42,
        noiseFloor: 0.051,
        reactivitySource: "analyser",
        headphones: "sì (misurate)",
      },
      echoCancellation: "sistema",
      network: { online: true, type: "4g" },
      model: { id: "claude-sonnet-5-5", preset: "sonnet-between-tools", tableVersion: "2026-10-02" },
      lastTurn: { firstTokenMs: 812.4, firstSegmentMs: 1011, firstAudioMs: 1290 },
      pacing: { boundary: "estimated", calibration: 0.94, voiceId: "Google UK English" },
      lastErrors: [
        { code: "invalid-key", at: "14:31", message: `Chiave non valida ${KEY}` },
        { code: "network", at: "14:35" },
      ],
      recentSignals: [
        { signal: "PRODUCED", itemId: "phrase-12", transcript: "two coffees please", at: "14:36" },
      ],
      totals: { rows: 48, sessions: 7, turns: 190 },
      storage: { usedBytes: 1536, quotaBytes: 50 * 1024 * 1024, persisted: false },
      sync: { status: "non configurata" },
      power: { wakeLock: true, mediaSession: "spenta (iOS)" },
    };
    const byKey = new Map<string, unknown>();
    for (const section of buildStandardSections(input)) {
      for (const entry of section.entries) byKey.set(`${section.title}/${entry.key}`, entry.value);
    }
    expect(byKey.get("Piattaforma/modalità")).toBe("app installata");
    expect(byKey.get("Ascolto/sul dispositivo")).toBe(false);
    expect(byKey.get("Voci/disponibili")).toBe(12);
    expect(byKey.get("Voci/italiano")).toBeNull();
    expect(byKey.get("Microfono/livello")).toBe("42%");
    expect(byKey.get("Microfono/rumore di fondo")).toBe("5%");
    expect(byKey.get("Microfono/cancellazione d'eco")).toBe("sistema");
    expect(byKey.get("Rete e modello/in linea")).toBe(true);
    expect(byKey.get("Ultimo turno/prima parola")).toBe("812 ms");
    expect(byKey.get("Ultimo turno/boundary")).toBe("stimati");
    expect(byKey.get("Ultimo turno/calibrazione")).toBe("0,94");
    expect(byKey.get("Ultimi errori/errore 2")).toBe("network · 14:35");
    expect(byKey.get("Segnali recenti/segnale 1")).toBe(
      "PRODUCED · phrase-12 · “two coffees please” · 14:36",
    );
    expect(byKey.get("Archivio/spazio usato")).toBe("1,5 KB");
    expect(byKey.get("Archivio/spazio disponibile")).toBe("50,0 MB");
    expect(byKey.get("Archivio/persistente")).toBe(false);
    expect(byKey.get("Schermo e cuffie/wake lock")).toBe(true);
    expect(byKey.get("Schermo e cuffie/media session")).toBe("spenta (iOS)");

    const text = formatLabel(buildStandardSections(input), { header: "Vera · etichetta diagnostica" });
    expect(text).not.toContain(KEY);
    expect(text).toContain("sk-ant-…ABCD");
    expect(text).toContain("boundary .");
    expect(text).toContain(" sì\n");
    expect(labelToJson(buildStandardSections(input))).not.toContain(KEY);
  });

  it("formats bytes with an Italian decimal comma", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3,0 MB");
    expect(formatBytes(-1)).toBe("—");
  });
});
