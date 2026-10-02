/**
 * Incremental extractor for the streamed structured reply (docs/PIANO.md §1.1).
 * The model streams one JSON object as text deltas that can split anywhere, including inside
 * strings, escape sequences and `\uXXXX` escapes. The extractor emits each element of the
 * top-level `segments` array as soon as it closes, so the voice can start on the first one.
 * It never throws: on malformed input it stops emitting and `isComplete()` stays false.
 */

import type { Segment } from "./schema";
import { normalizeSegment } from "./validate";

export interface SegmentExtractor {
  /** Feeds a delta; returns the segments that became complete with it, in order. */
  push(delta: string): Segment[];
  /** Number of valid segments emitted so far. */
  closedSegmentCount(): number;
  /** Everything pushed so far, verbatim. */
  text(): string;
  /** True once the top-level object has closed. */
  isComplete(): boolean;
}

type Phase =
  /** Nothing structural seen yet: the first non-blank char must be `{`. */
  | "start"
  /** Inside the top-level object, looking for the `segments` key at depth 1. */
  | "scan"
  /** `"segments"` seen, waiting for `:`. */
  | "colon"
  /** `:` seen, waiting for `[`. */
  | "bracket"
  /** Inside the segments array, collecting elements. */
  | "array"
  /** Segments array closed; just tracking brackets until the object closes. */
  | "after"
  | "done"
  | "failed";

const WHITESPACE = /\s/;

export function createSegmentExtractor(): SegmentExtractor {
  let buf = "";
  let phase: Phase = "start";
  let inString = false;
  let inEscape = false;
  let unicodeLeft = 0;
  let stringStart = -1;
  /** Open brackets, innermost last; its length is the nesting depth. */
  const stack: Array<"{" | "["> = [];
  /** At depth 1, whether the next string is a key (start of object or after a comma). */
  let expectKey = false;
  let elementStart = -1;
  let count = 0;

  function fail(): void {
    phase = "failed";
  }

  /** Read through a call so TypeScript does not narrow `phase` across the closures that mutate it. */
  function stopped(): boolean {
    return phase === "failed" || phase === "done";
  }

  function emitElement(raw: string, out: Segment[]): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const result = normalizeSegment(parsed);
    if (result.ok && result.value !== null) {
      out.push(result.value);
      count += 1;
    }
  }

  function onStringEnd(end: number): void {
    if (phase === "scan" && stack.length === 1 && expectKey) {
      expectKey = false;
      if (buf.slice(stringStart + 1, end) === "segments") {
        phase = "colon";
      }
    }
  }

  function onOpen(ch: "{" | "[", pos: number): void {
    if (phase === "start") {
      if (ch !== "{") {
        fail();
        return;
      }
      phase = "scan";
      expectKey = true;
    } else if (phase === "bracket") {
      if (ch !== "[") {
        fail();
        return;
      }
      phase = "array";
    } else if (phase === "array" && stack.length === 2 && ch === "{") {
      elementStart = pos;
    }
    stack.push(ch);
  }

  function onClose(ch: "}" | "]", pos: number, out: Segment[]): void {
    const open = stack.pop();
    if (open === undefined || (open === "{") !== (ch === "}")) {
      fail();
      return;
    }
    if (phase === "array") {
      if (stack.length === 2 && ch === "}" && elementStart >= 0) {
        emitElement(buf.slice(elementStart, pos + 1), out);
        elementStart = -1;
      } else if (stack.length === 1 && ch === "]") {
        phase = "after";
      }
    } else if (phase === "colon" || phase === "bracket") {
      fail();
      return;
    }
    if (stack.length === 0) {
      phase = "done";
    }
  }

  function consume(ch: string, pos: number, out: Segment[]): void {
    if (inString) {
      if (unicodeLeft > 0) {
        unicodeLeft -= 1;
      } else if (inEscape) {
        inEscape = false;
        if (ch === "u") {
          unicodeLeft = 4;
        }
      } else if (ch === "\\") {
        inEscape = true;
      } else if (ch === '"') {
        inString = false;
        onStringEnd(pos);
      }
      return;
    }
    if (WHITESPACE.test(ch)) {
      return;
    }
    if (phase === "start" && ch !== "{") {
      fail();
      return;
    }
    if (phase === "colon") {
      if (ch === ":") {
        phase = "bracket";
      } else {
        fail();
      }
      return;
    }
    if (phase === "bracket" && ch !== "[") {
      fail();
      return;
    }
    switch (ch) {
      case '"':
        inString = true;
        stringStart = pos;
        return;
      case "{":
      case "[":
        onOpen(ch, pos);
        return;
      case "}":
      case "]":
        onClose(ch, pos, out);
        return;
      case ":":
        if (stack.length === 1) {
          expectKey = false;
        }
        return;
      case ",":
        if (stack.length === 1) {
          expectKey = true;
        }
        return;
      default:
        // Literals and numbers: nothing structural to track.
        return;
    }
  }

  return {
    push(delta: string): Segment[] {
      const out: Segment[] = [];
      const offset = buf.length;
      buf += delta;
      if (stopped()) {
        return out;
      }
      for (let k = 0; k < delta.length; k += 1) {
        consume(delta.charAt(k), offset + k, out);
        if (stopped()) {
          break;
        }
      }
      return out;
    },
    closedSegmentCount: () => count,
    text: () => buf,
    isComplete: () => phase === "done",
  };
}
