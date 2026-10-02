// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLabel, LANG_OFFSET_KEY, type Label, SHARED_ORIGIN_WARNING } from "../../src/ui/label";
import { fakeLabelDeps, fakeSettings, installFakeClipboard, memoryStorage } from "../helpers/label-fakes";

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function headingsOf(root: ParentNode): string[] {
  return [...root.querySelectorAll("h2.label-heading")].map((h) => h.textContent ?? "");
}

function wordIn(root: ParentNode, text: string, within?: string): HTMLButtonElement {
  const scope = within ? root.querySelector(within) : root;
  const match = [...(scope?.querySelectorAll("button.word") ?? [])].find((b) => b.textContent === text);
  if (!(match instanceof HTMLButtonElement)) throw new Error(`word "${text}" not found`);
  return match;
}

let container: HTMLElement;
let label: Label | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.append(container);
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.motion;
});

afterEach(() => {
  label?.destroy();
  label = null;
  vi.useRealTimers();
});

describe("createLabel: sections", () => {
  it("renders every section with an Italian heading, in order", async () => {
    const { deps } = fakeLabelDeps();
    label = createLabel(container, deps, { layout: () => "desktop", storage: memoryStorage() });
    await flush();
    expect(headingsOf(container)).toEqual([
      "Voce",
      "Lingua",
      "Microfono",
      "Chiave",
      "Modello",
      "Modalità",
      "Tema",
      "Movimento",
      "Costo",
      "Dati",
      "Composizione",
    ]);
    const ids = [...container.querySelectorAll("section.label-section")].map(
      (s) => (s as HTMLElement).dataset.section,
    );
    expect(ids).toEqual([
      "voce",
      "lingua",
      "microfono",
      "chiave",
      "modello",
      "modalita",
      "tema",
      "movimento",
      "costo",
      "dati",
      "composizione",
    ]);
  });

  it("lists the voices per language with test phrases and marks the chosen one", async () => {
    const settings = fakeSettings({ voiceIt: "alice" });
    const { deps, record } = fakeLabelDeps(settings);
    label = createLabel(container, deps, { layout: () => "desktop", storage: memoryStorage() });
    expect(container.textContent).toContain("sto cercando le voci");
    await flush();
    const rows = [...container.querySelectorAll('[data-section="voce"] .voice-row')] as HTMLElement[];
    const names = rows.map((row) => row.querySelector(".voice-name")?.textContent);
    expect(names).toEqual(["Automatica", "Serena", "Samantha", "Automatica", "Alice", "Google italiano"]);
    expect(container.textContent).toContain("Where is the gate for Rome?");
    expect(container.textContent).toContain("Dove si ritira il bagaglio?");
    expect(container.querySelector('[data-voice-id="google-it"] .voice-meta')?.textContent).toBe(
      "it-IT · rete",
    );
    const chosen = [...container.querySelectorAll(".voice-row[data-chosen]")] as HTMLElement[];
    expect(chosen.map((row) => row.dataset.voiceId)).toEqual([undefined, "alice"]);

    const serenaRow = container.querySelector('[data-voice-id="serena"]') as HTMLElement;
    wordIn(serenaRow, "Prova").click();
    expect(record.previews).toEqual([{ voiceId: "serena", lang: "en" }]);
    wordIn(serenaRow, "Scegli").click();
    expect(settings.get().voiceEn).toBe("serena");
    expect(serenaRow.dataset.chosen).toBe("");
  });

  it("stores the language offset under its own localStorage key", () => {
    const storage = memoryStorage();
    const { deps } = fakeLabelDeps();
    label = createLabel(container, deps, { layout: () => "desktop", storage });
    const input = container.querySelector('[data-section="lingua"] input[type="range"]') as HTMLInputElement;
    input.value = "7";
    input.dispatchEvent(new Event("input"));
    expect(storage.getItem(LANG_OFFSET_KEY)).toBe("7");
    expect(container.querySelector('[data-section="lingua"] .num')?.textContent).toBe("+7");
  });

  it("starts and stops the microphone test, growing the thread with the level", async () => {
    const { deps, record } = fakeLabelDeps();
    label = createLabel(container, deps, { layout: () => "desktop", storage: memoryStorage() });
    const toggle = wordIn(container, "Prova microfono", '[data-section="microfono"]');
    toggle.click();
    await flush();
    expect(record.micStarts).toBe(1);
    expect(toggle.textContent).toBe("Ferma");
    record.levelCallback?.(0.5);
    const fill = container.querySelector('[data-section="microfono"] .label-thread-fill') as HTMLElement;
    expect(fill.style.transform).toBe("scaleX(0.500)");
    toggle.click();
    expect(record.micStops).toBe(1);
    expect(toggle.textContent).toBe("Prova microfono");
    expect(fill.style.transform).toBe("scaleX(0.000)");
  });
});

describe("createLabel: key", () => {
  it("masks a stored key and shows the shared-origin warning", () => {
    const settings = fakeSettings({
      apiKey: "sk-ant-api03-abcdef1234",
      keyValidatedAt: "2026-10-02T12:31:00Z",
    });
    const { deps } = fakeLabelDeps(settings);
    label = createLabel(container, deps, { layout: () => "desktop", storage: memoryStorage() });
    const status = container.querySelector('[data-role="key-status"]')?.textContent ?? "";
    expect(status).toMatch(/^presente · ultime 4 cifre 1234 · convalidata il /);
    expect(container.innerHTML).not.toContain("sk-ant-api03-abcdef1234");
    expect(container.textContent).toContain(SHARED_ORIGIN_WARNING);
    const input = container.querySelector('[data-section="chiave"] input') as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.hidden).toBe(true);
  });

  it("validates a typed key, saves it only when valid and shows the outcome line", async () => {
    const settings = fakeSettings();
    const { deps, record } = fakeLabelDeps(settings);
    const now = new Date("2026-10-02T14:31:00Z");
    label = createLabel(container, deps, {
      layout: () => "desktop",
      storage: memoryStorage(),
      now: () => now,
    });
    expect(container.querySelector('[data-role="key-status"]')?.textContent).toBe(
      "nessuna chiave su questo dispositivo",
    );
    const input = container.querySelector('[data-section="chiave"] input') as HTMLInputElement;
    expect(input.hidden).toBe(false);

    input.value = "wrong-key";
    wordIn(container, "Convalida").click();
    await flush();
    expect(record.validateCalls).toEqual(["wrong-key"]);
    expect(container.querySelector('[data-role="key-outcome"]')?.textContent).toBe(
      "Chiave non valida: controlla l'etichetta",
    );
    expect(settings.get().apiKey).toBe("");

    input.value = "sk-ant-api03-xyz9876";
    wordIn(container, "Convalida").click();
    await flush();
    expect(container.querySelector('[data-role="key-outcome"]')?.textContent).toBe(
      "Chiave valida · 2 modelli disponibili",
    );
    expect(settings.get().apiKey).toBe("sk-ant-api03-xyz9876");
    expect(settings.get().keyValidatedAt).toBe(now.toISOString());
    expect(input.hidden).toBe(true);
    expect(input.value).toBe("");
    expect(container.querySelector('[data-role="key-status"]')?.textContent).toContain("ultime 4 cifre 9876");
  });

  it("forgets the key through the dependency", () => {
    const settings = fakeSettings({ apiKey: "sk-ant-api03-abcdef1234" });
    const { deps, record } = fakeLabelDeps(settings);
    label = createLabel(container, deps, { layout: () => "desktop", storage: memoryStorage() });
    wordIn(container, "Dimentica chiave").click();
    expect(record.forgetCalls).toBe(1);
    expect(settings.get().apiKey).toBe("");
    expect(container.querySelector('[data-role="key-status"]')?.textContent).toBe(
      "nessuna chiave su questo dispositivo",
    );
  });
});

describe("createLabel: options", () => {
  it("writes the model preset and the custom id to the settings", () => {
    const settings = fakeSettings();
    const { deps } = fakeLabelDeps(settings);
    label = createLabel(container, deps, { layout: () => "desktop", storage: memoryStorage() });
    const section = '[data-section="modello"]';
    expect(wordIn(container, "Sonnet 5.5", section).dataset.active).toBe("");
    wordIn(container, "Haiku 4.5 (turbo)", section).click();
    expect(settings.get().modelPreset).toBe("haiku");
    expect(wordIn(container, "Haiku 4.5 (turbo)", section).dataset.active).toBe("");
    expect(wordIn(container, "Sonnet 5.5", section).dataset.active).toBeUndefined();
    const custom = container.querySelector(`${section} input[type="text"]`) as HTMLInputElement;
    expect(custom.hidden).toBe(true);
    wordIn(container, "Personalizzato", section).click();
    expect(custom.hidden).toBe(false);
    custom.value = "claude-future-1";
    custom.dispatchEvent(new Event("input"));
    expect(settings.get()).toMatchObject({ modelPreset: "custom", customModel: "claude-future-1" });
  });

  it("theme and motion write the settings and the html data attributes", () => {
    const settings = fakeSettings();
    const { deps } = fakeLabelDeps(settings);
    label = createLabel(container, deps, { layout: () => "desktop", storage: memoryStorage() });
    wordIn(container, "scuro", '[data-section="tema"]').click();
    expect(settings.get().theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    wordIn(container, "ridotto", '[data-section="movimento"]').click();
    expect(settings.get().motion).toBe("reduced");
    expect(document.documentElement.dataset.motion).toBe("reduced");
    wordIn(container, "sistema", '[data-section="tema"]').click();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("applies the stored theme at creation", () => {
    const { deps } = fakeLabelDeps(fakeSettings({ theme: "light" }));
    label = createLabel(container, deps, { layout: () => "desktop", storage: memoryStorage() });
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("modes write textMode and listenMode", () => {
    const settings = fakeSettings();
    const { deps } = fakeLabelDeps(settings);
    label = createLabel(container, deps, { layout: () => "desktop", storage: memoryStorage() });
    wordIn(container, "testo", '[data-section="modalita"]').click();
    wordIn(container, "premi e parla", '[data-section="modalita"]').click();
    expect(settings.get()).toMatchObject({ textMode: true, listenMode: "push" });
  });

  it("shows the cost in USD with the estimate label and stores the daily budget", () => {
    const settings = fakeSettings();
    const { deps } = fakeLabelDeps(settings);
    label = createLabel(container, deps, { layout: () => "desktop", storage: memoryStorage() });
    expect(container.querySelector('[data-role="cost-line"]')?.textContent).toBe(
      "oggi $0.12 · sessione $0.0042 · totale $3.50",
    );
    expect(container.querySelector('[data-role="cost-meta"]')?.textContent).toBe(
      "stima · listino del 2026-10-02 · 12 turni oggi",
    );
    const budget = container.querySelector('[data-section="costo"] input[type="number"]') as HTMLInputElement;
    expect(budget.value).toBe("0.8");
    budget.value = "1.5";
    budget.dispatchEvent(new Event("change"));
    expect(settings.get().dailyBudgetUsd).toBe(1.5);
    budget.value = "-3";
    budget.dispatchEvent(new Event("change"));
    expect(settings.get().dailyBudgetUsd).toBe(1.5);
    expect(budget.value).toBe("1.5");
  });

  it("data section: export/import disabled, 'Prova del telefono' opens the probe", () => {
    const { deps, record } = fakeLabelDeps();
    label = createLabel(container, deps, { layout: () => "desktop", storage: memoryStorage() });
    expect(wordIn(container, "Esporta").disabled).toBe(true);
    expect(wordIn(container, "Importa").disabled).toBe(true);
    expect(container.textContent).toContain("dal traguardo 2");
    wordIn(container, "Prova del telefono").click();
    expect(record.probeOpens).toBe(1);
  });
});

describe("createLabel: composizione", () => {
  it("copies the diagnostics text to the clipboard and shows 'Copiato' for 1.5 s", async () => {
    vi.useFakeTimers();
    const clipboard = installFakeClipboard();
    try {
      const { deps } = fakeLabelDeps();
      label = createLabel(container, deps, { layout: () => "desktop", storage: memoryStorage() });
      const block = container.querySelector('[data-role="diagnostics"]') as HTMLElement;
      expect(block.tagName).toBe("PRE");
      expect(block.textContent).toBe(deps.diagnosticsText());
      const copy = wordIn(container, "Copia etichetta");
      copy.click();
      await flush();
      expect(clipboard.written).toEqual([deps.diagnosticsText()]);
      expect(copy.textContent).toBe("Copiato");
      vi.advanceTimersByTime(1500);
      expect(copy.textContent).toBe("Copia etichetta");
    } finally {
      clipboard.restore();
    }
  });

  it("toggles between the text label and the raw JSON", () => {
    const { deps } = fakeLabelDeps();
    label = createLabel(container, deps, { layout: () => "desktop", storage: memoryStorage() });
    const block = container.querySelector('[data-role="diagnostics"]') as HTMLElement;
    const toggle = wordIn(container, "mostra grezzo");
    toggle.click();
    expect(block.textContent).toBe(deps.diagnosticsJson());
    expect(toggle.textContent).toBe("mostra etichetta");
    toggle.click();
    expect(block.textContent).toBe(deps.diagnosticsText());
  });

  it("refresh() re-reads settings and cost", () => {
    const settings = fakeSettings();
    let today = 0.1;
    const { deps } = fakeLabelDeps(settings, {
      costSummary: () => ({
        todayUsd: today,
        sessionUsd: 0,
        totalUsd: today,
        todayTurns: 1,
        tableVersion: "v",
      }),
    });
    label = createLabel(container, deps, { layout: () => "desktop", storage: memoryStorage() });
    today = 0.5;
    settings.update({ theme: "dark" });
    expect(container.querySelector('[data-role="cost-line"]')?.textContent).toContain("oggi $0.50");
    expect(wordIn(container, "scuro", '[data-section="tema"]').dataset.active).toBe("");
  });
});

describe("createLabel: presentation", () => {
  it("phone: a bottom sheet that opens, closes with 'Chiudi' and with Escape", () => {
    const { deps } = fakeLabelDeps();
    label = createLabel(container, deps, { layout: () => "phone", storage: memoryStorage() });
    const panel = container.querySelector(".label-panel") as HTMLElement;
    expect(panel.dataset.layout).toBe("sheet");
    expect(panel.hidden).toBe(true);
    expect(label.isOpen()).toBe(false);

    label.open("chiave");
    expect(label.isOpen()).toBe(true);
    expect(panel.hidden).toBe(false);
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(document.documentElement.dataset.labelOpen).toBe("");

    wordIn(container, "Chiudi").click();
    expect(label.isOpen()).toBe(false);
    expect(panel.hidden).toBe(true);
    expect(document.documentElement.dataset.labelOpen).toBeUndefined();

    label.open();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(label.isOpen()).toBe(false);
    expect(panel.hidden).toBe(true);
  });

  it("desktop without a bench: a hidden side panel until opened", () => {
    const { deps } = fakeLabelDeps();
    label = createLabel(container, deps, { layout: () => "desktop", storage: memoryStorage() });
    const panel = container.querySelector(".label-panel") as HTMLElement;
    expect(panel.dataset.layout).toBe("side");
    expect(panel.hidden).toBe(true);
    label.open();
    expect(panel.hidden).toBe(false);
    label.close();
    expect(panel.hidden).toBe(true);
  });

  it("desktop with #vera-bench: rendered inside the bench, always open, no close word", () => {
    const bench = document.createElement("div");
    bench.id = "vera-bench";
    document.body.append(bench);
    const { deps } = fakeLabelDeps();
    label = createLabel(container, deps, { layout: () => "desktop", storage: memoryStorage() });
    const panel = bench.querySelector(".label-panel") as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.dataset.layout).toBe("bench");
    expect(panel.hidden).toBe(false);
    expect(label.isOpen()).toBe(true);
    expect(wordIn(bench, "Chiudi").hidden).toBe(true);
    label.close();
    expect(label.isOpen()).toBe(true);
    label.destroy();
    label = null;
    expect(bench.querySelector(".label-panel")).toBeNull();
  });
});
