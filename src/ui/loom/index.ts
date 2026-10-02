/**
 * The loom: Vera's whole screen as DOM plus one Canvas 2D for the warp. It holds no app
 * logic: it renders a view model and reports gestures through callbacks.
 *
 * Institutional register: cold technical paper, graphite rules, one signal tint. The loom
 * mechanics (reed, fell line, shed, guide thread, cloth, selvedge, beam) are kept as
 * geometry, never as drawn wood.
 */

import "./loom.css";

import type { HelpKind, ListenMode, LoomState } from "../../core/session/types";
import type { Lang, SegmentKind, Topic } from "../../core/turn/schema";
import {
  beamLineCount,
  portraitStrokes,
  splitWords,
  stateLabel,
  threadStep,
  thresholdAction,
  thresholdLabel,
  thresholdLooksDisabled,
  unit,
} from "./labels";
import { computeWarp, paintWarp, type WarpBand } from "./warp";

export interface LoomVeraSegment {
  text: string;
  lang: Lang;
  kind: SegmentKind;
  status: "pending" | "speaking" | "done";
  inkedWords: number;
}

export interface LoomRow {
  id: string;
  textEn: string;
  glossIt: string;
  weight: 300 | 500 | 700;
  topic: Topic;
}

export interface LoomNotice {
  level: "info" | "warn" | "error";
  text: string;
  action?: { label: string; id: string };
}

export interface LoomViewModel {
  state: LoomState;
  mode: ListenMode | null;
  textMode: boolean;
  interim: string;
  transcript: string;
  transcriptLang: Lang;
  vera: LoomVeraSegment[];
  rows: LoomRow[];
  /** Share of Italian in Vera's recent words, 0..1: drives the warp opacity. */
  italianShare: number;
  notice: LoomNotice | null;
  offline: boolean;
  /** Kind of the last error (`not-allowed`, `timeout`...): names the cause on the reed. */
  errorKind?: string | null;
  costText: string;
  budgetFraction: number;
  sessionKnots: number;
}

export interface LoomCallbacks {
  onThresholdTap(): void;
  onThresholdPressStart(): void;
  onThresholdPressEnd(): void;
  onStop(): void;
  onInterrupt(): void;
  onHelp(kind: HelpKind): void;
  onTextSubmit(text: string): void;
  onNoticeAction(id: string): void;
  onOpenLabel(): void;
  onRowTap(id: string): void;
}

export interface LoomOptions {
  reducedMotion: () => boolean;
  platformTouch: boolean;
}

export interface Loom {
  render(vm: LoomViewModel): void;
  /** 0..1, drives the shed vibration and the thread under the current word. Call at most per frame. */
  setMicLevel(level: number): void;
  /** From boundary/pacer: inks words incrementally without a full render. */
  setSpeakingWord(segmentIndex: number, wordIndex: number): void;
  destroy(): void;
}

const HELP_BUTTONS: ReadonlyArray<{ kind: HelpKind; label: string }> = [
  { kind: "REPEAT", label: "Ripeti" },
  { kind: "SLOWER", label: "Più lento" },
  { kind: "DIDNT_UNDERSTAND", label: "Non ho capito" },
  { kind: "HOW_TO_SAY", label: "Come si dice…" },
];

const LONG_PRESS_MS = 600;
const THREAD_STEP_MIN_INTERVAL_MS = 250;
const MAX_KNOTS = 240;
const WARP_FALLBACK = "#9aa3ad";
const WARP_STEP_FALLBACK = 8;
const VIBRATION_HZ = 6;

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(doc: Document, className: string, label: string): HTMLButtonElement {
  const node = el(doc, "button", className, label);
  node.type = "button";
  return node;
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function setLang(node: HTMLElement, lang: Lang): void {
  const tag = lang === "IT" ? "it" : "en";
  if (node.getAttribute("lang") !== tag) node.setAttribute("lang", tag);
}

function setHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden;
}

function isTypingTarget(doc: Document): boolean {
  const active = doc.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  const tag = active.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active.isContentEditable;
}

function readToken(node: HTMLElement, name: string, fallback: string): string {
  const view = node.ownerDocument.defaultView;
  if (!view) return fallback;
  const value = view.getComputedStyle(node).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

/** Key that identifies a Vera segment element; a different key means a rebuild. */
function segmentKey(segment: LoomVeraSegment): string {
  return `${segment.kind}|${segment.lang}|${segment.text}`;
}

export function createLoom(container: HTMLElement, callbacks: LoomCallbacks, options: LoomOptions): Loom {
  const doc = container.ownerDocument;
  const win = doc.defaultView;

  // --- static skeleton -------------------------------------------------------------------
  container.classList.add("loom");
  if (options.platformTouch) container.classList.add("loom--touch");

  const column = el(doc, "div", "loom-column");
  const header = el(doc, "header", "loom-header");
  const wordmark = el(doc, "span", "loom-wordmark", "Vera");
  wordmark.setAttribute("lang", "it");
  const portrait = el(doc, "div", "loom-portrait");
  portrait.setAttribute("aria-hidden", "true");
  const meter = button(doc, "loom-meter", "");
  meter.setAttribute("aria-label", "Apri l'etichetta di composizione");
  const cost = el(doc, "span", "loom-cost");
  const mark = el(doc, "span", "loom-mark");
  const markFill = el(doc, "span", "loom-mark-fill");
  mark.append(markFill);
  meter.append(cost, mark);
  header.append(wordmark, portrait, meter);

  const reed = el(doc, "div", "loom-reed");
  const stateLabelNode = el(doc, "div", "loom-state");
  stateLabelNode.setAttribute("role", "status");
  stateLabelNode.setAttribute("aria-live", "polite");
  reed.append(stateLabelNode);

  const fell = el(doc, "section", "loom-fell");
  fell.setAttribute("aria-label", "Linea di battuta");
  const canvas = el(doc, "canvas", "loom-warp");
  canvas.setAttribute("aria-hidden", "true");
  const guide = el(doc, "div", "loom-guide");
  guide.setAttribute("aria-hidden", "true");
  guide.append(el(doc, "span", "loom-guide-a"), el(doc, "span", "loom-guide-b"));
  const fellText = el(doc, "div", "loom-fell-text");
  const transcript = el(doc, "p", "loom-transcript");
  const transcriptFinal = el(doc, "span", "loom-final");
  const transcriptInterim = el(doc, "span", "loom-interim");
  const transcriptThread = el(doc, "span", "loom-thread");
  transcriptThread.setAttribute("aria-hidden", "true");
  transcript.append(transcriptFinal, " ", transcriptInterim, transcriptThread);
  const vera = el(doc, "div", "loom-vera");
  vera.setAttribute("aria-live", "polite");
  fellText.append(transcript, vera);
  fell.append(canvas, guide, fellText);

  const cloth = el(doc, "section", "loom-cloth");
  cloth.setAttribute("aria-label", "Stoffa");
  const selvedge = el(doc, "div", "loom-selvedge");
  selvedge.setAttribute("aria-hidden", "true");
  const rowsList = el(doc, "ul", "loom-rows");
  const ghost = el(doc, "li", "loom-ghost", "La prima riga la tessi tu.");
  ghost.setAttribute("lang", "it");
  const beam = el(doc, "div", "loom-beam");
  beam.setAttribute("aria-hidden", "true");
  cloth.append(selvedge, rowsList, beam);

  const notice = el(doc, "div", "loom-notice");
  notice.setAttribute("role", "status");
  const noticeText = el(doc, "span", "loom-notice-text");
  const noticeAction = button(doc, "loom-notice-action", "");
  notice.append(noticeText, noticeAction);
  notice.hidden = true;

  const thresholdRow = el(doc, "div", "loom-threshold-row");
  const threshold = button(doc, "loom-threshold", "");
  const stop = button(doc, "loom-stop", "Fine");
  thresholdRow.append(threshold, stop);

  const help = el(doc, "div", "loom-help");
  help.setAttribute("role", "group");
  help.setAttribute("aria-label", "Aiuto");
  for (const item of HELP_BUTTONS) {
    const node = button(doc, "loom-help-btn", item.label);
    node.dataset.help = item.kind;
    node.addEventListener("click", () => callbacks.onHelp(item.kind));
    help.append(node);
  }

  const textLine = el(doc, "form", "loom-textline");
  const textInput = el(doc, "input", "loom-textinput");
  textInput.type = "text";
  textInput.placeholder = "Scrivi qui";
  textInput.autocomplete = "off";
  textInput.setAttribute("aria-label", "Scrivi a Vera");
  textInput.setAttribute("enterkeyhint", "send");
  const textSend = button(doc, "loom-textsend", "Invia");
  textSend.type = "submit";
  textLine.append(textInput, textSend);
  textLine.hidden = true;

  const bottom = el(doc, "div", "loom-bottom");
  bottom.append(notice, thresholdRow, help, textLine);

  column.append(header, reed, fell, cloth, bottom);
  const bench = el(doc, "aside", "loom-bench");
  bench.id = "vera-bench";
  container.append(column, bench);

  // --- mutable view state ------------------------------------------------------------------
  let current: LoomViewModel | null = null;
  let micLevel = 0;
  let rafId = 0;
  let lastThreadStepAt = 0;
  let longPressTimer = 0;
  let longPressFired = false;
  let pressing = false;
  let spaceHeld = false;
  let destroyed = false;
  /** Furthest word reached by setSpeakingWord per segment, keyed by segment index. */
  const spokenMark = new Map<number, number>();
  const segmentKeys: string[] = [];
  const rowNodes = new Map<string, HTMLLIElement>();
  let textBand: WarpBand | null = null;
  let warpColor = WARP_FALLBACK;
  let warpStep = WARP_STEP_FALLBACK;

  // --- canvas ------------------------------------------------------------------------------
  const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;

  function measure(): void {
    warpColor = readToken(container, "--warp", WARP_FALLBACK);
    const step = Number.parseFloat(readToken(container, "--warp-step", `${WARP_STEP_FALLBACK}`));
    warpStep = Number.isFinite(step) && step > 0 ? step : WARP_STEP_FALLBACK;
    const fellRect = fell.getBoundingClientRect();
    const textRect = fellText.getBoundingClientRect();
    if (textRect.width > 0 && textRect.height > 0) {
      textBand = {
        top: textRect.top - fellRect.top,
        bottom: textRect.bottom - fellRect.top,
        left: textRect.left - fellRect.left,
        right: textRect.right - fellRect.left,
      };
    } else {
      textBand = null;
    }
  }

  function draw(phase: number): void {
    if (!ctx || !current) return;
    const width = fell.clientWidth;
    const height = fell.clientHeight;
    if (width <= 0 || height <= 0) return;
    const dpr = Math.min(2, win?.devicePixelRatio ?? 1);
    const pw = Math.round(width * dpr);
    const ph = Math.round(height * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const open = current.state === "listening" || current.state === "repeating";
    const vibrating = open && !options.reducedMotion();
    const segments = computeWarp({
      width,
      height,
      step: warpStep,
      open,
      amplitude: vibrating ? 4 * micLevel : 0,
      phase,
      textBand,
    });
    // Scaffold, not a wall: the warp never exceeds half opacity even when Vera speaks only Italian.
    const opacity = 0.12 + 0.4 * unit(current.italianShare);
    paintWarp(ctx, segments, warpColor, opacity, width, height);
  }

  function shouldLoop(): boolean {
    if (destroyed || !current || !win || typeof win.requestAnimationFrame !== "function") return false;
    if (options.reducedMotion()) return false;
    return current.state === "listening" || current.state === "repeating";
  }

  function tick(now: number): void {
    rafId = 0;
    if (!shouldLoop() || !win) return;
    draw((now / 1000) * Math.PI * 2 * VIBRATION_HZ);
    rafId = win.requestAnimationFrame(tick);
  }

  function syncLoop(): void {
    if (shouldLoop()) {
      if (rafId === 0 && win) rafId = win.requestAnimationFrame(tick);
    } else if (rafId !== 0 && win) {
      win.cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  let resizeObserver: ResizeObserver | null = null;
  if (win && typeof win.ResizeObserver === "function") {
    resizeObserver = new win.ResizeObserver(() => {
      measure();
      draw(0);
    });
    resizeObserver.observe(fell);
  }

  // --- threshold gestures --------------------------------------------------------------------
  function clearLongPress(): void {
    if (longPressTimer !== 0 && win) {
      win.clearTimeout(longPressTimer);
      longPressTimer = 0;
    }
  }

  function currentAction() {
    return current ? thresholdAction(current.state, current.mode) : "tap";
  }

  function endPress(): void {
    if (!pressing) return;
    pressing = false;
    container.classList.remove("is-pressing");
    callbacks.onThresholdPressEnd();
  }

  threshold.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    longPressFired = false;
    const action = currentAction();
    if (action === "press") {
      if (pressing) return;
      pressing = true;
      container.classList.add("is-pressing");
      callbacks.onThresholdPressStart();
      return;
    }
    clearLongPress();
    if (win) {
      longPressTimer = win.setTimeout(() => {
        longPressTimer = 0;
        longPressFired = true;
        callbacks.onStop();
      }, LONG_PRESS_MS);
    }
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"] as const) {
    threshold.addEventListener(type, () => {
      clearLongPress();
      endPress();
    });
  }
  threshold.addEventListener("click", (event) => {
    if (longPressFired) {
      longPressFired = false;
      event.preventDefault();
      return;
    }
    switch (currentAction()) {
      case "tap":
        callbacks.onThresholdTap();
        break;
      case "interrupt":
        callbacks.onInterrupt();
        break;
      case "label":
        callbacks.onOpenLabel();
        break;
      case "press":
        // Pointer and Space handle push-to-talk; a synthetic click has no hold to measure.
        break;
    }
  });
  threshold.addEventListener("contextmenu", (event) => event.preventDefault());

  stop.addEventListener("click", () => callbacks.onStop());
  meter.addEventListener("click", () => callbacks.onOpenLabel());
  noticeAction.addEventListener("click", () => {
    const id = noticeAction.dataset.actionId;
    if (id) callbacks.onNoticeAction(id);
  });
  textLine.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = textInput.value.trim();
    if (text.length === 0) return;
    // While Vera thinks the sentence would be dropped: keep it in the field instead.
    if (current?.state === "thinking") return;
    textInput.value = "";
    callbacks.onTextSubmit(text);
  });
  rowsList.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest<HTMLElement>(".loom-row");
    const id = row?.dataset.rowId;
    if (id) callbacks.onRowTap(id);
  });

  // --- keyboard (document level) --------------------------------------------------------------
  function onKeyDown(event: KeyboardEvent): void {
    if (isTypingTarget(doc)) return;
    if (event.code === "Space" || event.key === " ") {
      if (currentAction() !== "press") return;
      event.preventDefault();
      if (event.repeat || spaceHeld) return;
      spaceHeld = true;
      if (!pressing) {
        pressing = true;
        container.classList.add("is-pressing");
        callbacks.onThresholdPressStart();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      callbacks.onInterrupt();
    }
  }
  function onKeyUp(event: KeyboardEvent): void {
    if (event.code === "Space" || event.key === " ") {
      if (!spaceHeld) return;
      spaceHeld = false;
      event.preventDefault();
      endPress();
    }
  }
  doc.addEventListener("keydown", onKeyDown);
  doc.addEventListener("keyup", onKeyUp);

  // --- renderers -------------------------------------------------------------------------------
  function renderHeader(vm: LoomViewModel): void {
    setText(cost, vm.costText);
    const fraction = unit(vm.budgetFraction);
    markFill.style.transform = `scaleX(${fraction.toFixed(3)})`;
    mark.dataset.offline = vm.offline ? "true" : "false";
    mark.dataset.over = vm.budgetFraction >= 1 ? "true" : "false";
    meter.title = vm.offline ? `${vm.costText} · senza rete` : vm.costText;

    const strokes = portraitStrokes(vm.rows);
    while (portrait.childElementCount > strokes.length) portrait.lastElementChild?.remove();
    while (portrait.childElementCount < strokes.length) portrait.append(el(doc, "i", "loom-portrait-stroke"));
    const nodes = portrait.children;
    for (let i = 0; i < strokes.length; i += 1) {
      const stroke = strokes[i];
      const node = nodes[i];
      if (!stroke || !(node instanceof HTMLElement)) continue;
      node.style.transform = `scaleX(${stroke.width.toFixed(3)})`;
      node.style.opacity = stroke.darkness.toFixed(2);
    }
  }

  function renderTranscript(vm: LoomViewModel): void {
    setText(transcriptFinal, vm.transcript);
    setText(transcriptInterim, vm.interim);
    setHidden(transcriptInterim, vm.interim.length === 0);
    setLang(transcript, vm.transcriptLang);
    setHidden(transcript, vm.transcript.length === 0 && vm.interim.length === 0);
  }

  function buildSegment(segment: LoomVeraSegment, index: number): HTMLElement {
    const node = el(doc, "p", "loom-seg");
    node.dataset.kind = segment.kind;
    node.dataset.index = `${index}`;
    setLang(node, segment.lang);
    const words = splitWords(segment.text);
    words.forEach((word, i) => {
      if (i > 0) node.append(" ");
      node.append(el(doc, "span", "loom-word", word));
    });
    return node;
  }

  function inkSegment(node: HTMLElement, inked: number, currentWord: number): void {
    const words = node.querySelectorAll<HTMLElement>(".loom-word");
    words.forEach((word, i) => {
      word.classList.toggle("is-inked", i < inked);
      word.classList.toggle("is-current", i === currentWord);
    });
  }

  function renderVera(vm: LoomViewModel): void {
    const nextKeys = vm.vera.map(segmentKey);
    for (let i = 0; i < nextKeys.length; i += 1) {
      if (segmentKeys[i] !== nextKeys[i]) spokenMark.delete(i);
    }
    while (vera.childElementCount > vm.vera.length) {
      vera.lastElementChild?.remove();
      segmentKeys.pop();
      spokenMark.delete(segmentKeys.length);
    }
    vm.vera.forEach((segment, i) => {
      const key = nextKeys[i] ?? "";
      const existing = vera.children[i];
      let node: HTMLElement;
      if (existing instanceof HTMLElement && segmentKeys[i] === key) {
        node = existing;
      } else {
        node = buildSegment(segment, i);
        if (existing) existing.replaceWith(node);
        else vera.append(node);
        segmentKeys[i] = key;
      }
      if (node.dataset.status !== segment.status) node.dataset.status = segment.status;
      const words = splitWords(segment.text).length;
      const spoken = spokenMark.get(i);
      const inked =
        segment.status === "done"
          ? words
          : Math.max(segment.inkedWords, spoken === undefined ? 0 : spoken + 1);
      const currentWord =
        segment.status === "speaking" && (spoken !== undefined || segment.inkedWords > 0)
          ? (spoken ?? segment.inkedWords - 1)
          : -1;
      inkSegment(node, Math.min(words, inked), currentWord);
    });
    setHidden(vera, vm.vera.length === 0);
  }

  function topicVar(topic: Topic): string {
    switch (topic) {
      case "TRAVEL":
        return "var(--topic-travel)";
      case "TABLE_AND_STAY":
        return "var(--topic-table)";
      case "CITY_AND_TROUBLE":
        return "var(--topic-city)";
      case "SMALL_TALK":
        return "var(--ink-3)";
    }
  }

  function buildRow(row: LoomRow): HTMLLIElement {
    const node = el(doc, "li", "loom-row");
    node.dataset.rowId = row.id;
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.append(el(doc, "span", "loom-row-en", ""), el(doc, "span", "loom-row-it", ""));
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        callbacks.onRowTap(row.id);
      }
    });
    return node;
  }

  function updateRow(node: HTMLLIElement, row: LoomRow): void {
    const en = node.firstElementChild;
    const it = node.lastElementChild;
    if (en instanceof HTMLElement) {
      setText(en, row.textEn);
      en.setAttribute("lang", "en");
    }
    if (it instanceof HTMLElement) {
      setText(it, row.glossIt);
      it.setAttribute("lang", "it");
      setHidden(it, row.glossIt.length === 0);
    }
    const weight = `${row.weight}`;
    if (node.dataset.weight !== weight) {
      node.dataset.weight = weight;
      node.style.fontWeight = weight;
    }
    if (node.dataset.topic !== row.topic) {
      node.dataset.topic = row.topic;
      node.style.setProperty("--loom-row-thread", topicVar(row.topic));
    }
  }

  function renderRows(vm: LoomViewModel): void {
    const seen = new Set<string>();
    let cursor: Element | null = rowsList.firstElementChild;
    for (const row of vm.rows) {
      seen.add(row.id);
      let node = rowNodes.get(row.id);
      if (!node) {
        node = buildRow(row);
        rowNodes.set(row.id, node);
      }
      updateRow(node, row);
      if (cursor === node) {
        cursor = node.nextElementSibling;
      } else {
        rowsList.insertBefore(node, cursor);
      }
    }
    for (const [id, node] of rowNodes) {
      if (!seen.has(id)) {
        node.remove();
        rowNodes.delete(id);
      }
    }
    if (ghost.parentElement) ghost.remove();
    if (vm.rows.length === 0) rowsList.append(ghost);

    const knots = Math.min(MAX_KNOTS, Math.max(0, Math.floor(vm.sessionKnots)));
    while (selvedge.childElementCount > knots) selvedge.lastElementChild?.remove();
    while (selvedge.childElementCount < knots) selvedge.append(el(doc, "i", "loom-knot"));

    const lines = `${beamLineCount(vm.rows.length)}`;
    if (beam.dataset.lines !== lines) {
      beam.dataset.lines = lines;
      beam.style.setProperty("--loom-beam-lines", lines);
    }
  }

  function renderNotice(vm: LoomViewModel): void {
    if (!vm.notice) {
      setHidden(notice, true);
      return;
    }
    setHidden(notice, false);
    notice.dataset.level = vm.notice.level;
    setText(noticeText, vm.notice.text);
    if (vm.notice.action) {
      setHidden(noticeAction, false);
      setText(noticeAction, vm.notice.action.label);
      noticeAction.dataset.actionId = vm.notice.action.id;
    } else {
      setHidden(noticeAction, true);
      delete noticeAction.dataset.actionId;
    }
  }

  function renderControls(vm: LoomViewModel): void {
    setText(threshold, thresholdLabel(vm.state, vm.mode));
    const disabledLook = thresholdLooksDisabled(vm.state);
    threshold.setAttribute("aria-disabled", disabledLook ? "true" : "false");
    threshold.dataset.action = thresholdAction(vm.state, vm.mode);
    setHidden(stop, vm.state === "setup");
    setHidden(textLine, !vm.textMode);
    const helpUseful = vm.state !== "setup";
    setHidden(help, !helpUseful);
    if (thresholdAction(vm.state, vm.mode) !== "press" && pressing) {
      // The app left push-to-talk mid-press: do not leave a dangling press.
      spaceHeld = false;
      endPress();
    }
  }

  function render(vm: LoomViewModel): void {
    if (destroyed) return;
    const previous = current;
    current = vm;
    if (container.dataset.state !== vm.state) container.dataset.state = vm.state;
    const mode = vm.mode ?? "none";
    if (container.dataset.mode !== mode) container.dataset.mode = mode;
    if (previous?.state !== vm.state && vm.state !== "speaking" && vm.state !== "correcting") {
      spokenMark.clear();
    }
    setText(stateLabelNode, stateLabel(vm.state, vm.offline, vm.errorKind ?? null));
    container.dataset.offline = vm.offline ? "true" : "false";
    renderHeader(vm);
    renderTranscript(vm);
    renderVera(vm);
    renderRows(vm);
    renderNotice(vm);
    renderControls(vm);
    measure();
    draw(0);
    syncLoop();
  }

  function setMicLevel(level: number): void {
    micLevel = unit(level);
    if (!current || (current.state !== "listening" && current.state !== "repeating")) return;
    if (options.reducedMotion()) {
      const now = Date.now();
      if (now - lastThreadStepAt < THREAD_STEP_MIN_INTERVAL_MS) return;
      lastThreadStepAt = now;
      container.style.setProperty("--loom-thread-scale", `${threadStep(micLevel)}`);
      return;
    }
    container.style.setProperty("--loom-thread-scale", (1 + 3 * micLevel).toFixed(2));
  }

  function setSpeakingWord(segmentIndex: number, wordIndex: number): void {
    if (!current) return;
    const node = vera.children[segmentIndex];
    if (!(node instanceof HTMLElement)) return;
    const previous = spokenMark.get(segmentIndex) ?? -1;
    const reached = Math.max(previous, wordIndex);
    spokenMark.set(segmentIndex, reached);
    for (let i = 0; i < segmentIndex; i += 1) {
      const earlier = vera.children[i];
      if (earlier instanceof HTMLElement) inkSegment(earlier, Number.POSITIVE_INFINITY, -1);
    }
    inkSegment(node, reached + 1, wordIndex);
    if (node.dataset.status !== "speaking") node.dataset.status = "speaking";
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    clearLongPress();
    if (rafId !== 0 && win) win.cancelAnimationFrame(rafId);
    rafId = 0;
    resizeObserver?.disconnect();
    doc.removeEventListener("keydown", onKeyDown);
    doc.removeEventListener("keyup", onKeyUp);
    column.remove();
    bench.remove();
    container.classList.remove("loom", "loom--touch", "is-pressing");
    delete container.dataset.state;
    delete container.dataset.mode;
    delete container.dataset.offline;
    container.style.removeProperty("--loom-thread-scale");
  }

  return { render, setMicLevel, setSpeakingWord, destroy };
}
