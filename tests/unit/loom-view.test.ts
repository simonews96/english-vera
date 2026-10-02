// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoom, type Loom, type LoomCallbacks, type LoomViewModel } from "../../src/ui/loom";
import {
  createFakeContext,
  type FakeContext2D,
  giveBox,
  installCanvasFake,
} from "../helpers/loom-canvas-fake";

function baseVm(overrides: Partial<LoomViewModel> = {}): LoomViewModel {
  return {
    state: "idle",
    mode: "handsfree",
    textMode: false,
    interim: "",
    transcript: "",
    transcriptLang: "EN",
    vera: [],
    rows: [],
    italianShare: 0.5,
    notice: null,
    offline: false,
    costText: "$0,04",
    budgetFraction: 0.2,
    sessionKnots: 0,
    ...overrides,
  };
}

function makeCallbacks(): LoomCallbacks & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onThresholdTap: () => calls.push("tap"),
    onThresholdPressStart: () => calls.push("pressStart"),
    onThresholdPressEnd: () => calls.push("pressEnd"),
    onStop: () => calls.push("stop"),
    onInterrupt: () => calls.push("interrupt"),
    onHelp: (kind) => calls.push(`help:${kind}`),
    onTextSubmit: (text) => calls.push(`text:${text}`),
    onNoticeAction: (id) => calls.push(`notice:${id}`),
    onOpenLabel: () => calls.push("label"),
    onRowTap: (id) => calls.push(`row:${id}`),
  };
}

function q<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`missing ${selector}`);
  return node;
}

function key(target: EventTarget, type: "keydown" | "keyup", init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("createLoom", () => {
  let container: HTMLElement;
  let cb: ReturnType<typeof makeCallbacks>;
  let loom: Loom;
  let reduced = false;
  let ctx: FakeContext2D;
  let restoreCanvas: () => void;

  beforeEach(() => {
    reduced = false;
    ctx = createFakeContext();
    restoreCanvas = installCanvasFake(ctx);
    container = document.createElement("div");
    document.body.append(container);
    cb = makeCallbacks();
    loom = createLoom(container, cb, { reducedMotion: () => reduced, platformTouch: false });
  });

  afterEach(() => {
    loom.destroy();
    container.remove();
    restoreCanvas();
    vi.useRealTimers();
  });

  it("builds the anatomy and sets data-state / data-mode on render", () => {
    loom.render(baseVm());
    expect(container.dataset.state).toBe("idle");
    expect(container.dataset.mode).toBe("handsfree");
    expect(q(container, ".loom-state").textContent).toBe("PRONTA");
    expect(q(container, ".loom-wordmark").getAttribute("lang")).toBe("it");
    expect(q(container, "#vera-bench").tagName).toBe("ASIDE");
    expect(q(container, "canvas.loom-warp")).toBeTruthy();

    loom.render(baseVm({ state: "listening", mode: "push" }));
    expect(container.dataset.state).toBe("listening");
    expect(container.dataset.mode).toBe("push");
    expect(q(container, ".loom-state").textContent).toBe("ASCOLTO");

    loom.render(baseVm({ state: "idle", mode: null, offline: true }));
    expect(container.dataset.mode).toBe("none");
    expect(q(container, ".loom-state").textContent).toBe("SENZA RETE");
  });

  it("threshold label and tap behaviour follow state and mode", () => {
    const threshold = q<HTMLButtonElement>(container, ".loom-threshold");
    loom.render(baseVm({ state: "idle", mode: "handsfree" }));
    expect(threshold.textContent).toBe("Tocca per iniziare");
    threshold.click();
    expect(cb.calls).toEqual(["tap"]);

    loom.render(baseVm({ state: "listening", mode: "handsfree" }));
    expect(threshold.textContent).toBe("Ti ascolto · tocca per fermare");

    loom.render(baseVm({ state: "speaking", mode: "handsfree" }));
    expect(threshold.textContent).toBe("Tocca per interrompere");
    threshold.click();
    expect(cb.calls).toEqual(["tap", "interrupt"]);

    loom.render(baseVm({ state: "thinking", mode: "handsfree" }));
    expect(threshold.textContent).toBe("Vera pensa…");
    expect(threshold.getAttribute("aria-disabled")).toBe("true");
    threshold.click();
    expect(cb.calls).toEqual(["tap", "interrupt", "interrupt"]);

    loom.render(baseVm({ state: "error", mode: "handsfree" }));
    expect(threshold.textContent).toBe("Riprova");
    threshold.click();
    expect(cb.calls).toEqual(["tap", "interrupt", "interrupt", "tap"]);

    loom.render(baseVm({ state: "idle", mode: "push" }));
    expect(threshold.textContent).toBe("Tieni premuto e parla");
  });

  it("push mode: pointerdown/up drive the press callbacks; a click alone does nothing", () => {
    const threshold = q<HTMLButtonElement>(container, ".loom-threshold");
    loom.render(baseVm({ state: "idle", mode: "push" }));
    threshold.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(cb.calls).toEqual(["pressStart"]);
    expect(container.classList.contains("is-pressing")).toBe(true);
    threshold.dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(cb.calls).toEqual(["pressStart", "pressEnd"]);
    expect(container.classList.contains("is-pressing")).toBe(false);
    threshold.click();
    expect(cb.calls).toEqual(["pressStart", "pressEnd"]);
  });

  it("long press on the threshold (600 ms) triggers onStop and swallows the click", () => {
    vi.useFakeTimers();
    const threshold = q<HTMLButtonElement>(container, ".loom-threshold");
    loom.render(baseVm({ state: "listening", mode: "handsfree" }));
    threshold.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    vi.advanceTimersByTime(599);
    expect(cb.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(cb.calls).toEqual(["stop"]);
    threshold.dispatchEvent(new Event("pointerup", { bubbles: true }));
    threshold.click();
    expect(cb.calls).toEqual(["stop"]);
    // A short press later is a normal tap again.
    threshold.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    vi.advanceTimersByTime(100);
    threshold.dispatchEvent(new Event("pointerup", { bubbles: true }));
    threshold.click();
    expect(cb.calls).toEqual(["stop", "tap"]);
  });

  it("Fine button and meter reach onStop and onOpenLabel", () => {
    loom.render(baseVm());
    q<HTMLButtonElement>(container, ".loom-stop").click();
    q<HTMLButtonElement>(container, ".loom-meter").click();
    expect(cb.calls).toEqual(["stop", "label"]);
    expect(q(container, ".loom-cost").textContent).toBe("$0,04");
  });

  it("help buttons report their kind", () => {
    loom.render(baseVm());
    const buttons = container.querySelectorAll<HTMLButtonElement>(".loom-help-btn");
    expect(Array.from(buttons, (b) => b.textContent)).toEqual([
      "Ripeti",
      "Più lento",
      "Non ho capito",
      "Come si dice…",
    ]);
    for (const b of buttons) b.click();
    expect(cb.calls).toEqual(["help:REPEAT", "help:SLOWER", "help:DIDNT_UNDERSTAND", "help:HOW_TO_SAY"]);
  });

  it("text line is visible only in text mode and submits trimmed non-empty text on Enter", () => {
    const form = q<HTMLFormElement>(container, ".loom-textline");
    const input = q<HTMLInputElement>(container, ".loom-textinput");
    loom.render(baseVm({ textMode: false }));
    expect(form.hidden).toBe(true);
    loom.render(baseVm({ textMode: true }));
    expect(form.hidden).toBe(false);
    expect(input.placeholder).toBe("Scrivi qui");
    input.value = "   ";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(cb.calls).toEqual([]);
    input.value = "  hello there ";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(cb.calls).toEqual(["text:hello there"]);
    expect(input.value).toBe("");
  });

  it("transcript shows final and interim with the right language voice", () => {
    loom.render(
      baseVm({ state: "listening", transcript: "I would like", interim: "a coffee", transcriptLang: "EN" }),
    );
    const transcript = q(container, ".loom-transcript");
    expect(transcript.hidden).toBe(false);
    expect(q(container, ".loom-final").textContent).toBe("I would like");
    expect(q(container, ".loom-interim").textContent).toBe("a coffee");
    expect(transcript.getAttribute("lang")).toBe("en");
    loom.render(baseVm({ transcript: "come si dice", transcriptLang: "IT" }));
    expect(transcript.getAttribute("lang")).toBe("it");
    expect(q(container, ".loom-interim").hidden).toBe(true);
  });

  it("vera words ink up to inkedWords; setSpeakingWord moves the current word without a render", () => {
    loom.render(
      baseVm({
        state: "speaking",
        vera: [
          {
            text: "Could I have the bill please",
            lang: "EN",
            kind: "SAY",
            status: "speaking",
            inkedWords: 2,
          },
          { text: "Ora dilla tu", lang: "IT", kind: "ASK", status: "pending", inkedWords: 0 },
        ],
      }),
    );
    const segments = container.querySelectorAll<HTMLElement>(".loom-seg");
    expect(segments).toHaveLength(2);
    const first = segments[0];
    const second = segments[1];
    if (!first || !second) throw new Error("segments missing");
    const words = first.querySelectorAll<HTMLElement>(".loom-word");
    expect(words).toHaveLength(6);
    expect(Array.from(words, (w) => w.classList.contains("is-inked"))).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(words[1]?.classList.contains("is-current")).toBe(true);
    expect(second.getAttribute("lang")).toBe("it");
    expect(second.dataset.status).toBe("pending");
    expect(second.querySelectorAll(".is-inked")).toHaveLength(0);

    loom.setSpeakingWord(0, 4);
    expect(Array.from(words, (w) => w.classList.contains("is-inked"))).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(words[4]?.classList.contains("is-current")).toBe(true);
    expect(words[1]?.classList.contains("is-current")).toBe(false);

    // A re-render with a stale inkedWords must not un-ink what the boundary already reached.
    loom.render(
      baseVm({
        state: "speaking",
        vera: [
          {
            text: "Could I have the bill please",
            lang: "EN",
            kind: "SAY",
            status: "speaking",
            inkedWords: 2,
          },
          { text: "Ora dilla tu", lang: "IT", kind: "ASK", status: "pending", inkedWords: 0 },
        ],
      }),
    );
    expect(first.querySelectorAll(".is-inked")).toHaveLength(5);

    // Moving to the second segment inks the first one fully.
    loom.setSpeakingWord(1, 0);
    expect(first.querySelectorAll(".is-inked")).toHaveLength(6);
    expect(second.querySelectorAll(".is-inked")).toHaveLength(1);

    // A new reply rebuilds the segment and forgets the marks.
    loom.render(
      baseVm({
        state: "speaking",
        vera: [{ text: "Good morning", lang: "EN", kind: "MODEL", status: "speaking", inkedWords: 0 }],
      }),
    );
    const fresh = container.querySelectorAll<HTMLElement>(".loom-seg");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.dataset.kind).toBe("MODEL");
    expect(fresh[0]?.querySelectorAll(".is-inked")).toHaveLength(0);
  });

  it("done segments are fully inked regardless of inkedWords", () => {
    loom.render(
      baseVm({
        state: "idle",
        vera: [{ text: "See you soon", lang: "EN", kind: "SAY", status: "done", inkedWords: 0 }],
      }),
    );
    expect(container.querySelectorAll(".loom-word.is-inked")).toHaveLength(3);
    expect(container.querySelectorAll(".loom-word.is-current")).toHaveLength(0);
  });

  it("notice renders level, text and optional action", () => {
    const notice = q(container, ".loom-notice");
    loom.render(baseVm());
    expect(notice.hidden).toBe(true);
    loom.render(
      baseVm({ notice: { level: "warn", text: "Rete lenta", action: { label: "Riannoda", id: "retry" } } }),
    );
    expect(notice.hidden).toBe(false);
    expect(notice.dataset.level).toBe("warn");
    expect(q(container, ".loom-notice-text").textContent).toBe("Rete lenta");
    const action = q<HTMLButtonElement>(container, ".loom-notice-action");
    expect(action.hidden).toBe(false);
    expect(action.textContent).toBe("Riannoda");
    action.click();
    expect(cb.calls).toEqual(["notice:retry"]);
    loom.render(baseVm({ notice: { level: "info", text: "Pronta" } }));
    expect(action.hidden).toBe(true);
    expect(notice.dataset.level).toBe("info");
  });

  it("rows render as the cloth, are reused across renders, and the empty cloth shows the ghost row", () => {
    loom.render(baseVm());
    const ghost = q(container, ".loom-ghost");
    expect(ghost.textContent).toBe("La prima riga la tessi tu.");
    expect(ghost.getAttribute("lang")).toBe("it");

    const rows = [
      {
        id: "a",
        textEn: "Where is the station?",
        glossIt: "Dov'è la stazione?",
        weight: 300 as const,
        topic: "TRAVEL" as const,
      },
      {
        id: "b",
        textEn: "A table for two",
        glossIt: "Un tavolo per due",
        weight: 700 as const,
        topic: "TABLE_AND_STAY" as const,
      },
    ];
    loom.render(baseVm({ rows, sessionKnots: 3 }));
    expect(container.querySelector(".loom-ghost")).toBeNull();
    const items = container.querySelectorAll<HTMLElement>(".loom-row");
    expect(items).toHaveLength(2);
    expect(items[0]?.dataset.rowId).toBe("a");
    expect(items[0]?.style.fontWeight).toBe("300");
    expect(items[1]?.dataset.topic).toBe("TABLE_AND_STAY");
    expect(q(items[1] as HTMLElement, ".loom-row-en").textContent).toBe("A table for two");
    expect(container.querySelectorAll(".loom-knot")).toHaveLength(3);
    expect(q(container, ".loom-beam").dataset.lines).toBe("2");
    expect(container.querySelectorAll(".loom-portrait-stroke")).toHaveLength(2);

    const firstNode = items[0];
    loom.render(
      baseVm({ rows: [rows[1] as (typeof rows)[number], rows[0] as (typeof rows)[number]], sessionKnots: 3 }),
    );
    const reordered = container.querySelectorAll<HTMLElement>(".loom-row");
    expect(reordered[1]).toBe(firstNode);
    expect(reordered[0]?.dataset.rowId).toBe("b");

    q<HTMLElement>(container, '.loom-row[data-row-id="b"] .loom-row-en').click();
    expect(cb.calls).toEqual(["row:b"]);

    loom.render(baseVm({ rows: [] }));
    expect(container.querySelectorAll(".loom-row")).toHaveLength(0);
    expect(container.querySelector(".loom-ghost")).not.toBeNull();
  });

  it("keyboard: Space holds the threshold in push mode, Escape interrupts, both ignore typing", () => {
    loom.render(baseVm({ state: "idle", mode: "push", textMode: true }));
    key(document, "keydown", { code: "Space", key: " " });
    key(document, "keydown", { code: "Space", key: " ", repeat: true });
    expect(cb.calls).toEqual(["pressStart"]);
    key(document, "keyup", { code: "Space", key: " " });
    expect(cb.calls).toEqual(["pressStart", "pressEnd"]);

    key(document, "keydown", { key: "Escape" });
    expect(cb.calls).toEqual(["pressStart", "pressEnd", "interrupt"]);

    const input = q<HTMLInputElement>(container, ".loom-textinput");
    input.focus();
    key(document, "keydown", { code: "Space", key: " " });
    key(document, "keydown", { key: "Escape" });
    expect(cb.calls).toEqual(["pressStart", "pressEnd", "interrupt"]);
    input.blur();

    // Space does nothing in hands-free mode.
    loom.render(baseVm({ state: "idle", mode: "handsfree" }));
    key(document, "keydown", { code: "Space", key: " " });
    key(document, "keyup", { code: "Space", key: " " });
    expect(cb.calls).toEqual(["pressStart", "pressEnd", "interrupt"]);
  });

  it("leaving push mode mid-press ends the press cleanly", () => {
    loom.render(baseVm({ state: "idle", mode: "push" }));
    key(document, "keydown", { code: "Space", key: " " });
    expect(cb.calls).toEqual(["pressStart"]);
    loom.render(baseVm({ state: "thinking", mode: "push" }));
    expect(cb.calls).toEqual(["pressStart", "pressEnd"]);
    key(document, "keyup", { code: "Space", key: " " });
    expect(cb.calls).toEqual(["pressStart", "pressEnd"]);
  });

  it("mic level drives the thread scale: continuous with motion, stepped and throttled when reduced", () => {
    loom.render(baseVm({ state: "listening" }));
    loom.setMicLevel(0.5);
    expect(container.style.getPropertyValue("--loom-thread-scale")).toBe("2.50");

    reduced = true;
    loom.render(baseVm({ state: "listening" }));
    loom.setMicLevel(0.9);
    expect(container.style.getPropertyValue("--loom-thread-scale")).toBe("3");
    loom.setMicLevel(0); // within 250 ms: ignored
    expect(container.style.getPropertyValue("--loom-thread-scale")).toBe("3");

    loom.render(baseVm({ state: "idle" }));
    loom.setMicLevel(1);
    expect(container.style.getPropertyValue("--loom-thread-scale")).toBe("3");
  });

  it("paints the warp on render and runs the frame loop only in listening with motion", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    giveBox(q(container, ".loom-fell"), 320, 200);

    loom.render(baseVm({ state: "idle", italianShare: 1 }));
    expect(ctx.calls.filter((c) => c === "stroke")).toHaveLength(1);
    expect(ctx.calls.filter((c) => c === "moveTo")).toHaveLength(40);
    expect(ctx.globalAlpha).toBeCloseTo(0.52, 5);
    expect(raf).not.toHaveBeenCalled();

    loom.render(baseVm({ state: "listening", italianShare: 0 }));
    expect(ctx.globalAlpha).toBeCloseTo(0.12, 5);
    expect(ctx.calls.filter((c) => c === "moveTo")).toHaveLength(40 + 80);
    expect(raf).toHaveBeenCalledTimes(1);

    loom.render(baseVm({ state: "thinking" }));
    expect(cancel).toHaveBeenCalledWith(1);

    reduced = true;
    raf.mockClear();
    loom.render(baseVm({ state: "listening" }));
    expect(raf).not.toHaveBeenCalled();
  });

  it("survives a browser without 2D canvas support", () => {
    restoreCanvas();
    restoreCanvas = installCanvasFake(null);
    const other = document.createElement("div");
    document.body.append(other);
    const blind = createLoom(other, makeCallbacks(), { reducedMotion: () => false, platformTouch: true });
    expect(() => blind.render(baseVm({ state: "listening" }))).not.toThrow();
    expect(other.classList.contains("loom--touch")).toBe(true);
    blind.destroy();
    other.remove();
  });

  it("destroy removes the DOM and the document key handlers", () => {
    loom.render(baseVm({ state: "idle", mode: "push" }));
    loom.destroy();
    expect(container.children).toHaveLength(0);
    expect(container.dataset.state).toBeUndefined();
    key(document, "keydown", { key: "Escape" });
    expect(cb.calls).toEqual([]);
    // Rendering after destroy is a no-op and does not throw.
    loom.render(baseVm());
    expect(container.children).toHaveLength(0);
    // afterEach calls destroy again: it must be idempotent.
  });
});
