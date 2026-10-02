/**
 * Sections "chiave", "modello", "modalita", "tema" and "movimento".
 * The key is never shown after saving: only "presente · ultime 4 cifre · convalidata il …".
 */

import { redactSecrets } from "../../core/redact/redact";
import type { ModelPresetId } from "../../llm/types";
import type { MotionSetting, ThemeSetting } from "../../storage/settings";
import { applyAppearance } from "./appearance";
import { el, heading, setText, word, wordOptions } from "./dom";
import { type Section, type SectionContext, SHARED_ORIGIN_WARNING } from "./types";

const dateFormat = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" });

/** "presente · ultime 4 cifre a1b2 · convalidata il 2 ott 2026, 14:31" (or "mai convalidata"). */
export function describeStoredKey(apiKey: string, validatedAt: string | null): string {
  const key = apiKey.trim();
  if (key === "") return "nessuna chiave su questo dispositivo";
  const tail = key.length >= 4 ? key.slice(-4) : key;
  let validated = "mai convalidata";
  if (validatedAt) {
    const date = new Date(validatedAt);
    validated = Number.isNaN(date.getTime()) ? "convalidata" : `convalidata il ${dateFormat.format(date)}`;
  }
  return `presente · ultime 4 cifre ${tail} · ${validated}`;
}

export function createKeySection(ctx: SectionContext): Section {
  const settings = ctx.deps.settings;
  let editing = settings.get().apiKey.trim() === "";
  let validating = 0;

  const status = el("p", { className: "label-line", dataset: { role: "key-status" } });
  const input = el("input", {
    className: "label-input",
    // Masked, but kept out of the password managers: "one-time-code" is never offered for
    // saving (and syncing) by Chrome/Edge; the data attributes stop the third-party ones.
    attrs: {
      type: "password",
      autocomplete: "one-time-code",
      autocapitalize: "off",
      spellcheck: "false",
      placeholder: "sk-ant-…",
      "aria-label": "Chiave API",
      "data-lpignore": "true",
      "data-1p-ignore": "true",
      "data-bwignore": "true",
    },
  });
  const outcome = el("p", {
    className: "label-line",
    dataset: { role: "key-outcome" },
    attrs: { "aria-live": "polite" },
  });
  outcome.hidden = true;

  const showOutcome = (text: string): void => {
    outcome.hidden = text === "";
    setText(outcome, text);
  };

  const validate = async (): Promise<void> => {
    const typed = editing ? input.value.trim() : "";
    const key = typed !== "" ? typed : settings.get().apiKey.trim();
    if (key === "") {
      showOutcome("Inserisci la chiave prima di convalidarla.");
      return;
    }
    const gen = ++validating;
    validateWord.disabled = true;
    showOutcome("convalida in corso…");
    try {
      const result = await ctx.deps.validateKey(key);
      if (gen !== validating) return;
      if (result.ok) {
        settings.update({ apiKey: key, keyValidatedAt: ctx.now().toISOString() });
        input.value = "";
        editing = false;
        const count = result.models.length;
        showOutcome(
          count > 0
            ? `Chiave valida · ${count} ${count === 1 ? "modello" : "modelli"} disponibili`
            : "Chiave valida",
        );
      } else {
        showOutcome(result.message);
      }
    } catch (error) {
      if (gen !== validating) return;
      showOutcome(
        error instanceof Error && error.message ? redactSecrets(error.message) : "Convalida non riuscita.",
      );
    } finally {
      if (gen === validating) validateWord.disabled = false;
      render();
    }
  };

  const validateWord = word("Convalida", () => void validate());
  const replaceWord = word("Sostituisci", () => {
    editing = true;
    render();
    input.focus();
  });
  const forgetWord = word("Dimentica chiave", () => {
    input.value = "";
    editing = true;
    showOutcome("Chiave dimenticata su questo dispositivo.");
    ctx.deps.forgetKey();
    render();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void validate();
    }
  });

  const root = el("section", { className: "label-section", dataset: { section: "chiave" } }, [
    heading("Chiave"),
    status,
    input,
    el("div", { className: "word-row" }, [validateWord, replaceWord, forgetWord]),
    outcome,
    el("p", { className: "label-note", text: SHARED_ORIGIN_WARNING }),
  ]);

  const render = (): void => {
    const current = settings.get();
    const present = current.apiKey.trim() !== "";
    if (!present) editing = true;
    setText(status, describeStoredKey(current.apiKey, current.keyValidatedAt));
    input.hidden = !editing;
    replaceWord.hidden = !present || editing;
    forgetWord.hidden = !present;
  };

  render();
  return {
    id: "chiave",
    root,
    refresh: render,
    destroy() {
      validating += 1;
    },
  };
}

const MODEL_OPTIONS: readonly { value: ModelPresetId; text: string; note: string }[] = [
  {
    value: "sonnet-between-tools",
    text: "Sonnet 5.5",
    note: "Predefinito: nessun ragionamento prima della frase, prima parola rapida. $2 / $10 per milione di token.",
  },
  {
    value: "sonnet-adaptive-low",
    text: "Sonnet 5.5 adaptive",
    note: "Ragiona solo quando serve: da confrontare con il predefinito sui tempi e sulle correzioni.",
  },
  {
    value: "haiku",
    text: "Haiku 4.5 (turbo)",
    note: "Il più rapido ed economico ($1 / $5); insegnante più debole.",
  },
  {
    value: "opus",
    text: "Opus 5.5 (qualità)",
    note: "Qualità massima; prima parola più lenta e costo doppio ($4 / $20).",
  },
  {
    value: "custom",
    text: "Personalizzato",
    note: "Un ID di modello a tua scelta, senza parametri di ragionamento.",
  },
];

export function createModelSection(ctx: SectionContext): Section {
  const settings = ctx.deps.settings;
  const custom = el("input", {
    className: "label-input",
    attrs: {
      type: "text",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      placeholder: "claude-…",
      "aria-label": "ID del modello personalizzato",
    },
  });
  custom.addEventListener("input", () => settings.update({ customModel: custom.value }));

  const options = wordOptions(
    MODEL_OPTIONS,
    settings.get().modelPreset,
    (value) => {
      settings.update({ modelPreset: value });
      if (value === "custom") custom.focus();
    },
    "Modello",
  );

  const root = el("section", { className: "label-section", dataset: { section: "modello" } }, [
    heading("Modello"),
    options.root,
    custom,
  ]);

  const refresh = (): void => {
    const current = settings.get();
    options.setValue(current.modelPreset);
    custom.hidden = current.modelPreset !== "custom";
    if (document.activeElement !== custom && custom.value !== current.customModel)
      custom.value = current.customModel;
  };
  refresh();
  return { id: "modello", root, refresh, destroy() {} };
}

export function createModeSection(ctx: SectionContext): Section {
  const settings = ctx.deps.settings;
  const input = wordOptions<"voce" | "testo">(
    [
      { value: "voce", text: "voce" },
      { value: "testo", text: "testo", note: "Scrivi invece di parlare; Vera risponde comunque a voce." },
    ],
    settings.get().textMode ? "testo" : "voce",
    (value) => settings.update({ textMode: value === "testo" }),
    "Ingresso",
  );
  const listen = wordOptions<"handsfree" | "push">(
    [
      {
        value: "handsfree",
        text: "mani libere",
        note: "Il microfono si riapre da solo dopo ogni frase di Vera.",
      },
      { value: "push", text: "premi e parla", note: "Il microfono ascolta solo mentre tieni premuto." },
    ],
    settings.get().listenMode,
    (value) => settings.update({ listenMode: value }),
    "Ascolto",
  );
  const root = el("section", { className: "label-section", dataset: { section: "modalita" } }, [
    heading("Modalità"),
    el("p", { className: "label-caption", text: "Ingresso" }),
    input.root,
    el("p", { className: "label-caption", text: "Ascolto" }),
    listen.root,
  ]);
  const refresh = (): void => {
    const current = settings.get();
    input.setValue(current.textMode ? "testo" : "voce");
    listen.setValue(current.listenMode);
  };
  return { id: "modalita", root, refresh, destroy() {} };
}

export function createThemeSection(ctx: SectionContext): Section {
  const settings = ctx.deps.settings;
  const options = wordOptions<ThemeSetting>(
    [
      { value: "system", text: "sistema" },
      { value: "light", text: "chiaro" },
      { value: "dark", text: "scuro" },
    ],
    settings.get().theme,
    (value) => applyAppearance(settings.update({ theme: value })),
    "Tema",
  );
  const root = el("section", { className: "label-section", dataset: { section: "tema" } }, [
    heading("Tema"),
    options.root,
  ]);
  return {
    id: "tema",
    root,
    refresh() {
      options.setValue(settings.get().theme);
    },
    destroy() {},
  };
}

export function createMotionSection(ctx: SectionContext): Section {
  const settings = ctx.deps.settings;
  const options = wordOptions<MotionSetting>(
    [
      { value: "system", text: "sistema" },
      {
        value: "reduced",
        text: "ridotto",
        note: "Nessun movimento: gli stati si distinguono dalla sola geometria.",
      },
      { value: "full", text: "completo" },
    ],
    settings.get().motion,
    (value) => applyAppearance(settings.update({ motion: value })),
    "Movimento",
  );
  const root = el("section", { className: "label-section", dataset: { section: "movimento" } }, [
    heading("Movimento"),
    options.root,
  ]);
  return {
    id: "movimento",
    root,
    refresh() {
      options.setValue(settings.get().motion);
    },
    destroy() {},
  };
}
