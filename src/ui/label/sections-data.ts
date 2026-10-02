/**
 * Sections "costo", "dati" and "composizione" (the copyable diagnostics, never a black console).
 */

import { formatUsd } from "../../core/cost/pricing";
import { COPIED_FEEDBACK_MS, copyText } from "./clipboard";
import { el, heading, setText, word } from "./dom";
import type { Section, SectionContext } from "./types";

function clampBudget(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100) / 100;
}

export function createCostSection(ctx: SectionContext): Section {
  const settings = ctx.deps.settings;
  const today = el("span", { className: "num" });
  const session = el("span", { className: "num" });
  const total = el("span", { className: "num" });
  const meta = el("p", { className: "label-line", dataset: { role: "cost-meta" } });
  const fill = el("div", { className: "label-thread-fill" });
  const thread = el("div", { className: "label-thread", attrs: { "aria-hidden": "true" } }, [fill]);
  const budget = el("input", {
    className: "label-input label-input-num",
    attrs: {
      type: "number",
      min: "0",
      step: "0.1",
      inputmode: "decimal",
      "aria-label": "Budget giornaliero in dollari",
    },
  });
  budget.addEventListener("change", () => {
    const value = clampBudget(Number(budget.value));
    if (value === null) {
      budget.value = String(settings.get().dailyBudgetUsd);
      return;
    }
    settings.update({ dailyBudgetUsd: value });
  });

  const root = el("section", { className: "label-section", dataset: { section: "costo" } }, [
    heading("Costo"),
    el("p", { className: "label-line label-cost", dataset: { role: "cost-line" } }, [
      "oggi ",
      today,
      " · sessione ",
      session,
      " · totale ",
      total,
    ]),
    meta,
    thread,
    el("label", { className: "label-field" }, [
      el("span", { className: "label-caption", text: "Budget giornaliero (USD)" }),
      budget,
    ]),
  ]);

  const refresh = (): void => {
    const cost = ctx.deps.costSummary();
    const current = settings.get();
    setText(today, formatUsd(cost.todayUsd));
    setText(session, formatUsd(cost.sessionUsd));
    setText(total, formatUsd(cost.totalUsd));
    const turns = cost.todayTurns === 1 ? "1 turno oggi" : `${cost.todayTurns} turni oggi`;
    setText(meta, `stima · listino del ${cost.tableVersion} · ${turns}`);
    const ratio = current.dailyBudgetUsd > 0 ? cost.todayUsd / current.dailyBudgetUsd : 0;
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, ratio)).toFixed(3)})`;
    if (ratio > 1) thread.dataset.over = "";
    else delete thread.dataset.over;
    if (document.activeElement !== budget) budget.value = String(current.dailyBudgetUsd);
  };
  refresh();
  return { id: "costo", root, refresh, destroy() {} };
}

export function createDataSection(ctx: SectionContext): Section {
  const root = el("section", { className: "label-section", dataset: { section: "dati" } }, [
    heading("Dati"),
    el("div", { className: "word-row" }, [
      word("Esporta", () => {}, { disabled: true }),
      word("Importa", () => {}, { disabled: true }),
    ]),
    el("p", { className: "label-note", text: "Esporta e importa arrivano dal traguardo 2." }),
    el("div", { className: "word-row" }, [word("Prova del telefono", () => ctx.deps.openProbe())]),
    el("p", {
      className: "label-note",
      text: "Verifica voce, ascolto, schermo acceso e microfono su questo dispositivo e copia l'esito.",
    }),
  ]);
  return { id: "dati", root, refresh() {}, destroy() {} };
}

export function createCompositionSection(ctx: SectionContext): Section {
  let raw = false;
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  const block = el("pre", { className: "label-diag", dataset: { role: "diagnostics" } });

  const copyWord = word("Copia etichetta", () => {
    void copyText(block.textContent ?? "").then((done) => {
      setText(copyWord, done ? "Copiato" : "Copia non riuscita");
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        setText(copyWord, "Copia etichetta");
        copiedTimer = null;
      }, COPIED_FEEDBACK_MS);
    });
  });
  const rawWord = word("mostra grezzo", () => {
    raw = !raw;
    refresh();
  });

  const root = el("section", { className: "label-section", dataset: { section: "composizione" } }, [
    heading("Composizione"),
    el("p", { className: "label-line", text: `Vera ${ctx.deps.appVersion}` }),
    block,
    el("div", { className: "word-row" }, [copyWord, rawWord]),
  ]);

  const refresh = (): void => {
    setText(block, raw ? ctx.deps.diagnosticsJson() : ctx.deps.diagnosticsText());
    setText(rawWord, raw ? "mostra etichetta" : "mostra grezzo");
    block.dataset.raw = raw ? "true" : "false";
  };
  refresh();
  return {
    id: "composizione",
    root,
    refresh,
    destroy() {
      if (copiedTimer) clearTimeout(copiedTimer);
    },
  };
}
