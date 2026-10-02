/**
 * The "etichetta di composizione": settings, cost and diagnostics on one sheet of technical
 * paper (docs/PIANO.md §1.7). On phones it is a bottom sheet; on desktop it lives inside
 * `#vera-bench` when that column exists, otherwise it is a side panel on the right.
 * Sections are built once and refreshed in place from the settings store and the cost meter.
 */

import "./label.css";
import { applyAppearance } from "./appearance";
import { el, word } from "./dom";
import {
  createKeySection,
  createModelSection,
  createModeSection,
  createMotionSection,
  createThemeSection,
} from "./sections-account";
import { createCompositionSection, createCostSection, createDataSection } from "./sections-data";
import { createLanguageSection, createMicrophoneSection, createVoiceSection } from "./sections-voice";
import type { LabelDeps, LabelLayout, LabelOptions, LabelSectionId, Section, SectionContext } from "./types";

export { applyAppearance } from "./appearance";
export { LANG_OFFSET_KEY, readLangOffset, writeLangOffset } from "./lang-offset";
export type {
  KeyValidationOutcome,
  LabelCostSummary,
  LabelDeps,
  LabelLayout,
  LabelOptions,
  LabelSectionId,
  MicTest,
} from "./types";
export { SHARED_ORIGIN_WARNING, TEST_PHRASE_EN, TEST_PHRASE_IT } from "./types";

export const DESKTOP_MIN_WIDTH = 760;
export const BENCH_ID = "vera-bench";

export interface Label {
  open(section?: LabelSectionId): void;
  close(): void;
  isOpen(): boolean;
  /** Re-reads settings and cost into the rendered sections. */
  refresh(): void;
  destroy(): void;
}

function detectViewport(): "phone" | "desktop" {
  const win = globalThis.window;
  if (!win) return "desktop";
  if (typeof win.matchMedia === "function") {
    return win.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`).matches ? "desktop" : "phone";
  }
  return win.innerWidth >= DESKTOP_MIN_WIDTH ? "desktop" : "phone";
}

function resolveLayout(viewport: "phone" | "desktop"): { layout: LabelLayout; bench: HTMLElement | null } {
  if (viewport === "phone") return { layout: "sheet", bench: null };
  const bench = document.getElementById(BENCH_ID);
  return bench ? { layout: "bench", bench } : { layout: "side", bench: null };
}

export function createLabel(container: HTMLElement, deps: LabelDeps, options: LabelOptions = {}): Label {
  const ctx: SectionContext = {
    deps,
    storage: options.storage === undefined ? (globalThis.localStorage ?? null) : options.storage,
    now: options.now ?? (() => new Date()),
  };
  const viewportOf = options.layout ?? detectViewport;

  applyAppearance(deps.settings.get());

  const sections: readonly Section[] = [
    createVoiceSection(ctx),
    createLanguageSection(ctx),
    createMicrophoneSection(ctx),
    createKeySection(ctx),
    createModelSection(ctx),
    createModeSection(ctx),
    createThemeSection(ctx),
    createMotionSection(ctx),
    createCostSection(ctx),
    createDataSection(ctx),
    createCompositionSection(ctx),
  ];

  const title = el("h1", {
    className: "label-title",
    text: "Etichetta di composizione",
    attrs: { id: "label-title" },
  });
  const closeWord = word("Chiudi", () => close(), { className: "label-close" });
  const head = el("header", { className: "label-head" }, [title, closeWord]);
  const body = el(
    "div",
    { className: "label-body" },
    sections.map((section) => section.root),
  );
  const panel = el(
    "aside",
    {
      className: "label-panel",
      attrs: { "aria-labelledby": "label-title", tabindex: "-1" },
    },
    [head, body],
  );

  let layout = "side" as LabelLayout;
  let open = false;
  let destroyed = false;
  let lastFocus: Element | null = null;

  const applyLayout = (): void => {
    const resolved = resolveLayout(viewportOf());
    layout = resolved.layout;
    panel.dataset.layout = layout;
    const host = resolved.bench ?? container;
    if (panel.parentElement !== host) host.append(panel);
    const dialog = layout !== "bench";
    closeWord.hidden = !dialog;
    if (dialog) {
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", layout === "sheet" ? "true" : "false");
    } else {
      panel.removeAttribute("role");
      panel.removeAttribute("aria-modal");
    }
    panel.hidden = dialog && !open;
    if (layout === "sheet" && open) document.documentElement.dataset.labelOpen = "";
    else delete document.documentElement.dataset.labelOpen;
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && open && layout !== "bench") {
      event.preventDefault();
      close();
    }
  };

  const refresh = (): void => {
    if (destroyed) return;
    for (const section of sections) section.refresh();
  };

  const scrollTo = (id: LabelSectionId): void => {
    const target = sections.find((section) => section.id === id);
    if (!target) return;
    if (typeof target.root.scrollIntoView === "function") target.root.scrollIntoView({ block: "start" });
    const focusable = target.root.querySelector<HTMLElement>("button:not([disabled]), input");
    focusable?.focus();
  };

  const openPanel = (section?: LabelSectionId): void => {
    if (destroyed) return;
    if (!open) {
      lastFocus = document.activeElement;
      open = true;
      refresh();
    }
    applyLayout();
    if (section) scrollTo(section);
    else if (layout !== "bench") panel.focus();
  };

  const close = (): void => {
    if (!open || layout === "bench") return;
    open = false;
    applyLayout();
    if (lastFocus instanceof HTMLElement) lastFocus.focus();
    lastFocus = null;
  };

  const unsubscribe = deps.settings.subscribe(() => refresh());
  document.addEventListener("keydown", onKeydown);
  applyLayout();
  if (layout === "bench") {
    open = true;
    applyLayout();
  }

  return {
    open: openPanel,
    close,
    isOpen: () => open,
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      document.removeEventListener("keydown", onKeydown);
      for (const section of sections) section.destroy();
      delete document.documentElement.dataset.labelOpen;
      panel.remove();
    },
  };
}
