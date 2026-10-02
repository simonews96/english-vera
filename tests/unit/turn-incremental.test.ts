import { describe, expect, it } from "vitest";
import { createSegmentExtractor } from "../../src/core/turn/incremental";
import type { Segment } from "../../src/core/turn/schema";

const REPLY = {
  segments: [
    { lang: "IT", kind: "say", text: 'Bene! Si dice "I am thirty", non "I have".' },
    { lang: "EN", kind: "MODEL", text: "I am thirty years old. {braces} [and] \\ backslash" },
    { lang: "en", kind: "Ask", text: "Caffè or té? “Quotes” 😀" },
  ],
  listen: { lang: "EN", expect: "REPEAT", target: "I am thirty years old.", alternatives: ["I'm thirty."] },
  correction: {
    heard: "I have thirty years",
    correct: "I am thirty years old",
    note_it: "L'età si dice con to be.",
  },
  items: [{ kind: "PHRASE", id: "p_042", signal: "PRODUCED" }],
  learned: [],
  about_learner: [{ fact: 'Ha detto: "segments": [{ non è un JSON }]', topic: "OTHER" }],
  goal: { id: "g_age", status: "ONGOING" },
  closing: null,
};

const EXPECTED: Segment[] = [
  { lang: "IT", kind: "SAY", text: 'Bene! Si dice "I am thirty", non "I have".' },
  { lang: "EN", kind: "MODEL", text: "I am thirty years old. {braces} [and] \\ backslash" },
  { lang: "EN", kind: "ASK", text: "Caffè or té? “Quotes” 😀" },
];

/** Pretty JSON with explicit escapes, so `\uXXXX` and `\\` sequences really occur in the stream. */
function encodeWithEscapes(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u0080-￿]/g, (ch) => {
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

const FULL = encodeWithEscapes(REPLY);

function run(chunks: readonly string[]): {
  segments: Segment[];
  complete: boolean;
  count: number;
  text: string;
} {
  const extractor = createSegmentExtractor();
  const segments: Segment[] = [];
  for (const chunk of chunks) {
    segments.push(...extractor.push(chunk));
  }
  return {
    segments,
    complete: extractor.isComplete(),
    count: extractor.closedSegmentCount(),
    text: extractor.text(),
  };
}

/** Deterministic PRNG (mulberry32) so a failing split can be reproduced. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSplit(text: string, random: () => number, maxChunk: number): string[] {
  const chunks: string[] = [];
  let at = 0;
  while (at < text.length) {
    const size = 1 + Math.floor(random() * maxChunk);
    chunks.push(text.slice(at, at + size));
    at += size;
  }
  return chunks;
}

describe("segment extractor", () => {
  it("emits every segment, normalized, from a single push", () => {
    const result = run([FULL]);
    expect(result.segments).toEqual(EXPECTED);
    expect(result.count).toBe(3);
    expect(result.complete).toBe(true);
    expect(result.text).toBe(FULL);
  });

  it("gives identical results when split at every single position", () => {
    expect(FULL).toContain("\\u");
    expect(FULL).toContain("\\\\");
    for (let i = 1; i < FULL.length; i += 1) {
      const result = run([FULL.slice(0, i), FULL.slice(i)]);
      expect(result.segments, `split at ${i}`).toEqual(EXPECTED);
      expect(result.complete, `split at ${i}`).toBe(true);
    }
  });

  it("gives identical results under random chunking", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = prng(seed);
      const chunks = randomSplit(FULL, random, 1 + Math.floor(random() * 12));
      const result = run(chunks);
      expect(result.segments, `seed ${seed}`).toEqual(EXPECTED);
      expect(result.complete, `seed ${seed}`).toBe(true);
      expect(result.count, `seed ${seed}`).toBe(3);
    }
  });

  it("emits a segment as soon as its closing brace arrives, before the rest", () => {
    const head = '{"segments": [{"lang": "IT", "kind": "SAY", "text": "Ciao"}';
    const extractor = createSegmentExtractor();
    expect(extractor.push(head.slice(0, -1))).toEqual([]);
    expect(extractor.push("}")).toEqual([{ lang: "IT", kind: "SAY", text: "Ciao" }]);
    expect(extractor.isComplete()).toBe(false);
    expect(extractor.push(', {"lang": "EN", "kind": "ASK", "text": "And you?"}]')).toEqual([
      { lang: "EN", kind: "ASK", text: "And you?" },
    ]);
    expect(extractor.isComplete()).toBe(false);
    expect(extractor.push(', "listen": {"lang": "EN", "expect": "FREE"}}')).toEqual([]);
    expect(extractor.isComplete()).toBe(true);
    expect(extractor.closedSegmentCount()).toBe(2);
  });

  it("finds the segments key even when it is not the first property", () => {
    const text = JSON.stringify({
      listen: { lang: "EN", expect: "FREE", alternatives: ["segments", "{"] },
      nested: { segments: [{ lang: "IT", kind: "SAY", text: "decoy" }] },
      segments: [{ lang: "IT", kind: "SAY", text: "real" }],
    });
    const result = run([text]);
    expect(result.segments).toEqual([{ lang: "IT", kind: "SAY", text: "real" }]);
    expect(result.complete).toBe(true);
  });

  it("skips elements that are not valid segments without stopping", () => {
    const text = JSON.stringify({
      segments: [
        { lang: "IT", kind: "SAY", text: "uno" },
        { lang: "XX", kind: "SAY", text: "lingua sconosciuta" },
        { lang: "IT", kind: "SAY", text: "   " },
        "not an object",
        42,
        [{ lang: "IT", kind: "SAY", text: "nested array" }],
        { lang: "EN", kind: "MODEL", text: "due" },
      ],
    });
    const result = run([text]);
    expect(result.segments).toEqual([
      { lang: "IT", kind: "SAY", text: "uno" },
      { lang: "EN", kind: "MODEL", text: "due" },
    ]);
    expect(result.count).toBe(2);
    expect(result.complete).toBe(true);
  });

  it("never throws on malformed input and never reports completion", () => {
    const cases = [
      "not json at all",
      '["segments"]',
      '{"segments": {"lang": "IT"}}',
      '{"segments" "oops": []}',
      '{"segments": [{"lang": "IT", "kind": "SAY", "text": "x"]}',
      '{"segments": [{"lang": "IT", "kind": "SAY", "text": "x"}}}',
      '{"segments": [{"lang": "IT", "kind": "SAY", "text": "x"}',
      "",
      "   ",
      "}",
    ];
    for (const text of cases) {
      const extractor = createSegmentExtractor();
      expect(() => extractor.push(text), text).not.toThrow();
      expect(() => extractor.push("}}}]]]"), text).not.toThrow();
      expect(extractor.isComplete(), text).toBe(false);
    }
  });

  it("stays lenient on non-structural slips but stops on a bracket mismatch", () => {
    const extractor = createSegmentExtractor();
    const first = extractor.push('{"segments": [{"lang": "IT", "kind": "SAY", "text": "ok"}, ]');
    expect(first).toEqual([{ lang: "IT", kind: "SAY", text: "ok" }]);
    expect(extractor.push("}")).toEqual([]);
    expect(extractor.isComplete()).toBe(true);
    const broken = createSegmentExtractor();
    expect(broken.push('{"segments": [{"lang": "IT", "kind": "SAY", "text": "ok"}')).toHaveLength(1);
    expect(broken.push("}")).toEqual([]);
    expect(broken.isComplete()).toBe(false);
    expect(broken.push("]}")).toEqual([]);
    expect(broken.isComplete()).toBe(false);
  });

  it("ignores trailing content after the object closes", () => {
    const extractor = createSegmentExtractor();
    extractor.push('{"segments": [{"lang": "IT", "kind": "SAY", "text": "ok"}]}');
    expect(extractor.isComplete()).toBe(true);
    expect(extractor.push('\n{"segments": [{"lang": "IT", "kind": "SAY", "text": "again"}]}')).toEqual([]);
    expect(extractor.isComplete()).toBe(true);
    expect(extractor.closedSegmentCount()).toBe(1);
  });
});
