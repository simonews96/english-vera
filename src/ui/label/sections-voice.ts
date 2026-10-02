/**
 * Sections "voce", "lingua" and "microfono": voice auditions with a test phrase per language,
 * the English variant, the speaking rate, the Italian/English offset and the microphone test.
 */

import type { Settings } from "../../storage/settings";
import type { VoiceInfo } from "../../voice/types";
import { normalizeLang, primaryLanguage, resolveVoice, type TutorLanguage } from "../../voice/voices";
import { el, heading, setText, word, wordOptions } from "./dom";
import {
  formatLangOffset,
  LANG_OFFSET_MAX,
  LANG_OFFSET_MIN,
  readLangOffset,
  writeLangOffset,
} from "./lang-offset";
import { type MicTest, type Section, type SectionContext, TEST_PHRASE_EN, TEST_PHRASE_IT } from "./types";

const RATE_MIN = 0.8;
const RATE_MAX = 1.2;
const RATE_STEP = 0.05;

const rateFormat = new Intl.NumberFormat("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(RATE_MIN, Math.min(RATE_MAX, Math.round(value / RATE_STEP) * RATE_STEP));
}

function voiceMeta(voice: VoiceInfo): string {
  return `${normalizeLang(voice.lang)} · ${voice.local ? "locale" : "rete"}`;
}

interface VoiceList {
  readonly root: HTMLElement;
  render(voices: readonly VoiceInfo[], settings: Settings): void;
  update(settings: Settings): void;
}

function createVoiceList(ctx: SectionContext, language: TutorLanguage): VoiceList {
  const phrase = language === "en" ? TEST_PHRASE_EN : TEST_PHRASE_IT;
  const settingKey = language === "en" ? "voiceEn" : "voiceIt";
  const rows = new Map<string | null, { row: HTMLElement; choose: HTMLButtonElement }>();
  const list = el("div", { className: "voice-list", attrs: { role: "list" } });
  const empty = el("p", {
    className: "label-line",
    text: "nessuna voce per questa lingua su questo dispositivo",
  });
  empty.hidden = true;
  const root = el("div", { className: "voice-group" }, [
    heading(language === "en" ? "Inglese" : "Italiano", "h3"),
    empty,
    list,
  ]);

  const markChosen = (chosenId: string | null): void => {
    for (const [id, entry] of rows) {
      const chosen = id === chosenId;
      if (chosen) {
        entry.row.dataset.chosen = "";
        entry.choose.dataset.active = "";
      } else {
        delete entry.row.dataset.chosen;
        delete entry.choose.dataset.active;
      }
      entry.choose.setAttribute("aria-pressed", chosen ? "true" : "false");
    }
  };

  const makeRow = (id: string | null, name: string, meta: string, previewId: string | null): void => {
    const choose = word("Scegli", () => {
      ctx.deps.settings.update({ [settingKey]: id });
    });
    const preview = previewId
      ? word("Prova", () => ctx.deps.previewVoice(previewId, language))
      : el("span", { className: "voice-noprova", text: "—" });
    const row = el("div", { className: "voice-row", attrs: { role: "listitem" } }, [
      el("span", { className: "voice-name", text: name }),
      el("span", { className: "voice-meta", text: meta }),
      el("span", { className: "voice-phrase", text: phrase, lang: language }),
      el("span", { className: "voice-actions" }, [preview, choose]),
    ]);
    if (id !== null) row.dataset.voiceId = id;
    rows.set(id, { row, choose });
    list.append(row);
  };

  return {
    root,
    render(voices, settings) {
      rows.clear();
      list.replaceChildren();
      const ofLanguage = voices.filter((voice) => primaryLanguage(voice.lang) === language);
      empty.hidden = ofLanguage.length > 0;
      const automatic = resolveVoice(voices, language, settings.englishVariant, null);
      makeRow(
        null,
        "Automatica",
        automatic.voice ? `sceglie ${automatic.voice.name} · ${voiceMeta(automatic.voice)}` : "nessuna voce",
        automatic.voice?.id ?? null,
      );
      for (const voice of ofLanguage) makeRow(voice.id, voice.name, voiceMeta(voice), voice.id);
      markChosen(settings[settingKey]);
    },
    update(settings) {
      markChosen(settings[settingKey]);
    },
  };
}

export function createVoiceSection(ctx: SectionContext): Section {
  const settings = ctx.deps.settings;
  let voices: readonly VoiceInfo[] | null = null;
  let alive = true;

  const status = el("p", {
    className: "label-line",
    text: "sto cercando le voci",
    attrs: { "aria-live": "polite" },
  });
  const listEn = createVoiceList(ctx, "en");
  const listIt = createVoiceList(ctx, "it");

  const variant = wordOptions(
    [
      { value: "en-GB", text: "en-GB", note: "Inglese britannico: la variante delle voci e dell'ascolto." },
      { value: "en-US", text: "en-US", note: "Inglese americano: la variante delle voci e dell'ascolto." },
    ],
    settings.get().englishVariant,
    (value) => settings.update({ englishVariant: value }),
    "Variante dell'inglese",
  );

  const rateValue = el("span", { className: "num", text: "" });
  const rateInput = el("input", {
    className: "label-range",
    attrs: {
      type: "range",
      min: String(RATE_MIN),
      max: String(RATE_MAX),
      step: String(RATE_STEP),
      "aria-label": "Velocità della voce",
    },
  });
  const showRate = (rate: number): void => setText(rateValue, `${rateFormat.format(rate)}×`);
  rateInput.addEventListener("input", () => {
    const rate = clampRate(Number(rateInput.value));
    showRate(rate);
    settings.update({ rate });
  });

  const reloadWord = word("Aggiorna le voci", () => void load());

  const root = el("section", { className: "label-section", dataset: { section: "voce" } }, [
    heading("Voce"),
    status,
    listEn.root,
    listIt.root,
    el("p", { className: "label-caption", text: "Variante dell'inglese" }),
    variant.root,
    el("label", { className: "label-field" }, [
      el("span", { className: "label-caption", text: "Velocità" }),
      rateInput,
      rateValue,
    ]),
    el("div", { className: "word-row" }, [reloadWord]),
  ]);

  const renderLists = (): void => {
    if (!voices) return;
    const current = settings.get();
    listEn.render(voices, current);
    listIt.render(voices, current);
  };

  const load = async (): Promise<void> => {
    setText(status, "sto cercando le voci");
    status.hidden = false;
    try {
      const found = await ctx.deps.listVoices();
      if (!alive) return;
      voices = found;
      status.hidden = found.length > 0;
      if (found.length === 0) setText(status, "nessuna voce trovata: la voce userà solo la lingua");
      renderLists();
    } catch {
      if (!alive) return;
      voices = [];
      setText(status, "non riesco a leggere le voci di questo browser");
      renderLists();
    }
  };

  const refresh = (): void => {
    const current = settings.get();
    variant.setValue(current.englishVariant);
    const rate = clampRate(current.rate);
    if (document.activeElement !== rateInput) rateInput.value = String(rate);
    showRate(rate);
    listEn.update(current);
    listIt.update(current);
  };

  refresh();
  void load();

  return {
    id: "voce",
    root,
    refresh,
    destroy() {
      alive = false;
    },
  };
}

export function createLanguageSection(ctx: SectionContext): Section {
  const value = el("span", { className: "num", text: "" });
  const input = el("input", {
    className: "label-range",
    attrs: {
      type: "range",
      min: String(LANG_OFFSET_MIN),
      max: String(LANG_OFFSET_MAX),
      step: "1",
      "aria-label": "Quanto inglese usa Vera",
    },
  });
  const show = (offset: number): void => setText(value, formatLangOffset(offset));
  input.addEventListener("input", () => {
    show(writeLangOffset(Number(input.value), ctx.storage));
  });

  const root = el("section", { className: "label-section", dataset: { section: "lingua" } }, [
    heading("Lingua"),
    el("label", { className: "label-field" }, [
      el("span", { className: "label-caption", text: "più italiano ↔ più inglese" }),
      input,
      value,
    ]),
    el("p", {
      className: "label-note",
      text: "Sposta la quota di italiano nelle parole di Vera. Zero è la scelta automatica in base ai tuoi progressi.",
    }),
  ]);

  const refresh = (): void => {
    const offset = readLangOffset(ctx.storage);
    if (document.activeElement !== input) input.value = String(offset);
    show(offset);
  };
  refresh();

  return { id: "lingua", root, refresh, destroy() {} };
}

export function createMicrophoneSection(ctx: SectionContext): Section {
  let test: MicTest | null = null;
  let generation = 0;

  const fill = el("div", { className: "label-thread-fill" });
  const thread = el("div", { className: "label-thread", attrs: { "aria-hidden": "true" } }, [fill]);
  const line = el("p", {
    className: "label-line",
    text: "Parla: il filo cresce con la tua voce.",
    attrs: { "aria-live": "polite" },
  });

  const setLevel = (level: number): void => {
    const clamped = Math.max(0, Math.min(1, level));
    fill.style.transform = `scaleX(${clamped.toFixed(3)})`;
  };

  const stop = (): void => {
    generation += 1;
    test?.stop();
    test = null;
    setLevel(0);
    setText(toggle, "Prova microfono");
  };

  const start = async (): Promise<void> => {
    const current = ctx.deps.micTest();
    const gen = ++generation;
    test = current;
    setText(toggle, "Ferma");
    setText(line, "apro il microfono…");
    try {
      await current.start((level) => {
        if (gen === generation) setLevel(level);
      });
      if (gen !== generation) return;
      setText(line, "Parla: il filo cresce con la tua voce.");
    } catch (error) {
      if (gen !== generation) return;
      const message = error instanceof Error && error.message ? error.message : "microfono non disponibile";
      setText(line, message);
      stop();
    }
  };

  const toggle = word("Prova microfono", () => {
    if (test) stop();
    else void start();
  });

  const root = el("section", { className: "label-section", dataset: { section: "microfono" } }, [
    heading("Microfono"),
    el("div", { className: "word-row" }, [toggle]),
    thread,
    line,
  ]);

  return {
    id: "microfono",
    root,
    refresh() {},
    destroy: stop,
  };
}
