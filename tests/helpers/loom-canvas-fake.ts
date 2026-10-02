/**
 * Fake Canvas 2D context for jsdom (which has no canvas implementation and logs a
 * "not implemented" error on getContext). Records the calls the warp painter makes.
 */

export interface FakeContext2D {
  readonly calls: string[];
  globalAlpha: number;
  strokeStyle: string;
  lineWidth: number;
  setTransform(): void;
  clearRect(): void;
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(): void;
  lineTo(): void;
  stroke(): void;
}

export function createFakeContext(): FakeContext2D {
  const calls: string[] = [];
  return {
    calls,
    globalAlpha: 1,
    strokeStyle: "",
    lineWidth: 0,
    setTransform: () => calls.push("setTransform"),
    clearRect: () => calls.push("clearRect"),
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    beginPath: () => calls.push("beginPath"),
    moveTo: () => calls.push("moveTo"),
    lineTo: () => calls.push("lineTo"),
    stroke: () => calls.push("stroke"),
  };
}

/**
 * Replace HTMLCanvasElement.prototype.getContext for the duration of a test. Passing
 * `null` reproduces a browser (or jsdom) without 2D support. Returns a restore function.
 */
export function installCanvasFake(context: FakeContext2D | null): () => void {
  const proto = HTMLCanvasElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "getContext");
  Object.defineProperty(proto, "getContext", {
    configurable: true,
    writable: true,
    value: () => context,
  });
  return () => {
    if (original) Object.defineProperty(proto, "getContext", original);
  };
}

/** Give an element a fixed layout box; jsdom reports 0 for everything otherwise. */
export function giveBox(node: HTMLElement, width: number, height: number): void {
  Object.defineProperty(node, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(node, "clientHeight", { configurable: true, value: height });
}
