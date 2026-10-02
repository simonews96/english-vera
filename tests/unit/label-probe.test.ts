// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProbe, formatProbeResults, type Probe, probePassed } from "../../src/ui/probe";
import {
  FAKE_PLATFORM,
  fakeSpeechInput,
  fakeSpeechOutput,
  installFakeClipboard,
} from "../helpers/label-fakes";

let container: HTMLElement;
let probe: Probe | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  probe?.destroy();
  probe = null;
  vi.useRealTimers();
});

function statusOf(id: string): { status: string; detail: string } {
  const row = container.querySelector(`[data-check="${id}"]`) as HTMLElement;
  return {
    status: row.querySelector(".probe-status")?.textContent ?? "",
    detail: row.querySelector(".probe-detail")?.textContent ?? "",
  };
}

function wordNamed(text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button.word")].find((b) => b.textContent === text);
  if (!(match instanceof HTMLButtonElement)) throw new Error(`word "${text}" not found`);
  return match;
}

describe("createProbe", () => {
  it("renders the page with every check waiting and a start control", () => {
    probe = createProbe(container, {
      platform: FAKE_PLATFORM,
      speechInput: fakeSpeechInput(),
      speechOutput: fakeSpeechOutput(),
      requestWakeLock: () => Promise.resolve("ok"),
      onClose: () => {},
      diagnosticsText: () => "diag",
    });
    expect(container.querySelector("#probe-title")?.textContent).toBe("Prova del telefono");
    const rows = [...container.querySelectorAll(".probe-row")] as HTMLElement[];
    expect(rows.map((r) => r.dataset.check)).toEqual([
      "piattaforma",
      "voce-sbloccata",
      "voci",
      "boundary",
      "ascolto",
      "wake-lock",
      "vibrazione",
      "microfono",
    ]);
    expect(rows.every((r) => r.dataset.status === "in attesa")).toBe(true);
    expect(wordNamed("Inizia la prova")).toBeDefined();
    expect(wordNamed("Copia esito")).toBeDefined();
  });

  it("unlocks inside the tap, runs the checks in order and reports each one", async () => {
    const output = fakeSpeechOutput({ boundaries: 6 });
    const input = fakeSpeechInput({
      script: [
        { type: "start" },
        { type: "interim", text: "hello" },
        { type: "final", text: "hello Vera", confidence: 0.91 },
      ],
    });
    const closes: number[] = [];
    probe = createProbe(container, {
      platform: { ...FAKE_PLATFORM, os: "ios", browser: "safari" },
      speechInput: input,
      speechOutput: output,
      requestWakeLock: () => Promise.resolve("unavailable"),
      onClose: () => closes.push(1),
      diagnosticsText: () => "diag",
      voices: { englishVariant: "en-GB", voiceIt: "alice" },
    });
    wordNamed("Inizia la prova").click();
    expect(output.unlocks).toBe(1);
    await vi.waitFor(() => expect(statusOf("microfono").status).not.toBe("in attesa"));

    expect(statusOf("piattaforma")).toEqual({ status: "ok", detail: "iOS · Safari · installata no · touch" });
    expect(statusOf("voce-sbloccata").status).toBe("ok");
    expect(output.spoken[0]).toEqual({ text: "Prova della voce", lang: "it-IT" });
    expect(statusOf("voci").status).toBe("ok");
    expect(statusOf("voci").detail).toContain("4 voci");
    expect(statusOf("voci").detail).toContain("en: Serena");
    expect(statusOf("voci").detail).toContain("it: Alice (locale, gradino 0)");
    expect(statusOf("boundary")).toEqual({ status: "ok", detail: "sì · 6 eventi su 6 parole" });
    expect(output.spoken[1]?.lang).toBe("en-GB");
    expect(statusOf("ascolto").status).toBe("ok");
    expect(statusOf("ascolto").detail).toBe(
      "capito «hello Vera» · start → interim → final «hello Vera» (0.91)",
    );
    expect(input.starts).toEqual([{ lang: "en-GB", mode: "utterance" }]);
    expect(statusOf("wake-lock").status).toBe("no");
    expect(statusOf("vibrazione").status).toBe("no");
    expect(statusOf("microfono")).toEqual({ status: "no", detail: "getUserMedia assente" });
    expect(wordNamed("Ripeti la prova")).toBeDefined();
    wordNamed("Chiudi").click();
    expect(closes).toEqual([1]);
    // The probe did not fully pass (no microphone in jsdom): no iOS install hint yet.
    expect((container.querySelector(".probe-hint") as HTMLElement).hidden).toBe(true);
  });

  it("reports a voice error, a listening error and a denied wake lock", async () => {
    const output = fakeSpeechOutput({ outcome: "error" });
    const input = fakeSpeechInput({
      script: [{ type: "start" }, { type: "error", code: "not-allowed", message: "microfono negato" }],
    });
    probe = createProbe(container, {
      platform: FAKE_PLATFORM,
      speechInput: input,
      speechOutput: output,
      requestWakeLock: () => Promise.resolve("denied"),
      onClose: () => {},
      diagnosticsText: () => "diag",
    });
    await probe.run();
    expect(statusOf("voce-sbloccata").status).toBe("errore");
    expect(statusOf("boundary").status).toBe("errore");
    expect(statusOf("ascolto")).toEqual({
      status: "errore",
      detail: "not-allowed: microfono negato · start → error:not-allowed",
    });
    expect(statusOf("wake-lock").status).toBe("no");
  });

  it("gives up on listening after 8 s without a result", async () => {
    vi.useFakeTimers();
    const input = fakeSpeechInput({ script: [{ type: "start" }] });
    probe = createProbe(container, {
      platform: FAKE_PLATFORM,
      speechInput: input,
      speechOutput: fakeSpeechOutput(),
      requestWakeLock: () => Promise.resolve("ok"),
      onClose: () => {},
      diagnosticsText: () => "diag",
    });
    const run = probe.run();
    await vi.advanceTimersByTimeAsync(8_000);
    await run;
    expect(input.aborts).toBe(1);
    expect(statusOf("ascolto")).toEqual({ status: "no", detail: "nessun risultato in 8 s · start" });
  });

  it("copies the results together with the diagnostics", async () => {
    const clipboard = installFakeClipboard();
    try {
      probe = createProbe(container, {
        platform: FAKE_PLATFORM,
        speechInput: fakeSpeechInput({ script: [{ type: "start" }, { type: "final", text: "hello vera" }] }),
        speechOutput: fakeSpeechOutput(),
        requestWakeLock: () => Promise.resolve("ok"),
        onClose: () => {},
        diagnosticsText: () => "CHIAVE\n  valore ... sk-ant-api03-secretsecretsecret",
        now: () => new Date("2026-10-02T14:31:00Z"),
      });
      await probe.run();
      wordNamed("Copia esito").click();
      await vi.waitFor(() => expect(wordNamed("Copiato")).toBeDefined());
      const text = clipboard.written[0] ?? "";
      expect(text.startsWith("PROVA DEL TELEFONO · 2026-10-02 14:31")).toBe(true);
      expect(text).toContain("Ascolto");
      expect(text).toContain("capito «hello vera»");
      expect(text).not.toContain("secretsecret");
      expect(clipboard.written).toHaveLength(1);
    } finally {
      clipboard.restore();
    }
  });
});

describe("probe results", () => {
  it("formats one line per check with dotted leaders and passes only when the core checks are ok", () => {
    const results = [
      { id: "piattaforma" as const, title: "Piattaforma", status: "ok" as const, detail: "Android" },
      { id: "ascolto" as const, title: "Ascolto", status: "no" as const, detail: "" },
    ];
    const text = formatProbeResults(results, "diag", new Date("2026-10-02T10:00:00Z"));
    expect(text).toBe(
      "PROVA DEL TELEFONO · 2026-10-02 10:00\nPiattaforma.. ok · Android\nAscolto...... no\n\ndiag",
    );
    expect(probePassed(results)).toBe(false);
  });
});
