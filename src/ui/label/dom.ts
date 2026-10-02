/**
 * Tiny DOM helpers for the label and the probe. No framework: nodes are created once and
 * updated in place, so inputs keep focus and the DOM stays small.
 */

export type Child = Node | string | null | undefined;

export interface ElementAttrs {
  readonly className?: string;
  readonly text?: string;
  readonly lang?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly dataset?: Readonly<Record<string, string>>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementAttrs = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.lang) node.lang = options.lang;
  if (options.attrs) for (const [key, value] of Object.entries(options.attrs)) node.setAttribute(key, value);
  if (options.dataset) for (const [key, value] of Object.entries(options.dataset)) node.dataset[key] = value;
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

/** A word used as a control: a real button, styled as text with a rule under it. */
export function word(
  text: string,
  onClick: () => void,
  options: { readonly className?: string; readonly disabled?: boolean } = {},
): HTMLButtonElement {
  const button = el("button", {
    className: ["word", options.className].filter(Boolean).join(" "),
    text,
    attrs: { type: "button" },
  });
  if (options.disabled) button.disabled = true;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    onClick();
  });
  return button;
}

/** Uppercase spaced heading of a section, as on an official form. */
export function heading(text: string, level: "h2" | "h3" = "h2"): HTMLElement {
  return el(level, { className: "label-heading", text });
}

export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export interface WordOption<T extends string> {
  readonly value: T;
  readonly text: string;
  readonly note?: string;
}

export interface WordOptions<T extends string> {
  readonly root: HTMLElement;
  /** Underlines the active value; the matching note (if any) is shown under the row. */
  setValue(value: T): void;
}

/**
 * A row of words where exactly one is active (underlined): the institutional alternative to
 * an iOS-style toggle. `onPick` fires only for a different value.
 */
export function wordOptions<T extends string>(
  options: readonly WordOption<T>[],
  initial: T,
  onPick: (value: T) => void,
  ariaLabel?: string,
): WordOptions<T> {
  let current = initial;
  const buttons = new Map<T, HTMLButtonElement>();
  const row = el("div", { className: "word-row", attrs: { role: "radiogroup" } });
  if (ariaLabel) row.setAttribute("aria-label", ariaLabel);
  const note = el("p", { className: "label-note" });
  note.hidden = true;

  const render = (): void => {
    for (const [value, button] of buttons) {
      const active = value === current;
      button.setAttribute("aria-checked", active ? "true" : "false");
      if (active) button.dataset.active = "";
      else delete button.dataset.active;
    }
    const activeNote = options.find((option) => option.value === current)?.note;
    note.hidden = !activeNote;
    setText(note, activeNote ?? "");
  };

  for (const option of options) {
    const button = word(option.text, () => {
      if (option.value === current) return;
      current = option.value;
      render();
      onPick(option.value);
    });
    button.setAttribute("role", "radio");
    buttons.set(option.value, button);
    row.append(button);
  }
  const root = el("div", { className: "word-options" }, [row, note]);
  render();
  return {
    root,
    setValue(value) {
      if (value === current) return;
      current = value;
      render();
    },
  };
}
