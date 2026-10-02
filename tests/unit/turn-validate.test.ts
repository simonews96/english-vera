import { describe, expect, it } from "vitest";
import { normalizeTurnResponse, parseTurnResponse, TURN_LIMITS } from "../../src/core/turn/validate";

const MINIMAL = {
  segments: [{ lang: "IT", kind: "SAY", text: "Ciao" }],
  listen: { lang: "EN", expect: "FREE" },
  correction: null,
  items: [],
  learned: [],
  about_learner: [],
  goal: null,
  closing: null,
};

function expectOk(json: string) {
  const result = parseTurnResponse(json);
  if (!result.ok) {
    throw new Error(`expected ok, got: ${result.reason}`);
  }
  return result.response;
}

function expectReason(value: unknown): string {
  const result = normalizeTurnResponse(value);
  if (result.ok) {
    throw new Error("expected a rejection");
  }
  return result.reason;
}

describe("parseTurnResponse", () => {
  it("accepts a minimal reply and fills optional parts", () => {
    const response = expectOk(JSON.stringify(MINIMAL));
    expect(response).toEqual(MINIMAL);
  });

  it("rejects invalid JSON without throwing", () => {
    const result = parseTurnResponse('{"segments": [');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/JSON non valido/);
    }
  });

  it("normalizes enum case and separators everywhere", () => {
    const response = expectOk(
      JSON.stringify({
        ...MINIMAL,
        segments: [{ lang: "en", kind: " model ", text: "Hi" }],
        listen: { lang: "it", expect: "Repeat" },
        items: [{ kind: "phrase", id: "p_1", signal: "not observed" }],
        learned: [{ text_en: "the bill", gloss_it: "il conto", topic: "table-and-stay" }],
        about_learner: [{ fact: "Va a Londra", topic: "trip" }],
        goal: { id: "g_1", status: "done" },
      }),
    );
    expect(response.segments).toEqual([{ lang: "EN", kind: "MODEL", text: "Hi" }]);
    expect(response.listen).toEqual({ lang: "IT", expect: "REPEAT" });
    expect(response.items).toEqual([{ kind: "PHRASE", id: "p_1", signal: "NOT_OBSERVED" }]);
    expect(response.learned[0]?.topic).toBe("TABLE_AND_STAY");
    expect(response.about_learner[0]?.topic).toBe("TRIP");
    expect(response.goal).toEqual({ id: "g_1", status: "DONE" });
  });

  it("rejects unknown enum values with the path in the reason", () => {
    expect(expectReason({ ...MINIMAL, segments: [{ lang: "FR", kind: "SAY", text: "x" }] })).toBe(
      'segments[0].lang: valore sconosciuto "FR"',
    );
    expect(expectReason({ ...MINIMAL, listen: { lang: "EN", expect: "WAIT" } })).toMatch(/^listen\.expect/);
    expect(expectReason({ ...MINIMAL, items: [{ kind: "PHRASE", id: "p", signal: "GOOD" }] })).toMatch(
      /^items\[0\]\.signal/,
    );
    expect(expectReason({ ...MINIMAL, goal: { id: "g", status: "PAUSED" } })).toMatch(/^goal\.status/);
  });

  it("requires at least one segment with text and a listen block", () => {
    expect(expectReason({ ...MINIMAL, segments: [] })).toBe("segments: nessun segmento con testo");
    expect(expectReason({ ...MINIMAL, segments: [{ lang: "IT", kind: "SAY", text: "  " }] })).toBe(
      "segments: nessun segmento con testo",
    );
    expect(expectReason({ ...MINIMAL, segments: "ciao" })).toBe("segments: atteso un elenco");
    expect(expectReason({ ...MINIMAL, listen: undefined })).toBe("listen: atteso un oggetto");
    expect(expectReason("nope")).toBe("risposta: atteso un oggetto");
    expect(expectReason(null)).toBe("risposta: atteso un oggetto");
  });

  it("drops blank segments but keeps the others", () => {
    const response = expectOk(
      JSON.stringify({
        ...MINIMAL,
        segments: [
          { lang: "IT", kind: "SAY", text: "" },
          { lang: "EN", kind: "ASK", text: "  Ready?  " },
        ],
      }),
    );
    expect(response.segments).toEqual([{ lang: "EN", kind: "ASK", text: "Ready?" }]);
  });

  it("truncates lists silently, keeping the first entries", () => {
    const many = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i));
    const response = expectOk(
      JSON.stringify({
        ...MINIMAL,
        listen: { lang: "EN", expect: "REPEAT", target: " Hi ", alternatives: many(8, (i) => `alt ${i}`) },
        items: many(9, (i) => ({ kind: "ERROR", id: `e_${i}`, signal: "HARD" })),
        learned: many(7, (i) => ({ text_en: `w${i}`, gloss_it: `g${i}`, topic: "TRAVEL" })),
        about_learner: many(3, (i) => ({ fact: `f${i}`, topic: "OTHER" })),
        closing: { remember: many(5, (i) => `r${i}`) },
      }),
    );
    expect(response.listen.target).toBe("Hi");
    expect(response.listen.alternatives).toHaveLength(TURN_LIMITS.alternatives);
    expect(response.items).toHaveLength(TURN_LIMITS.items);
    expect(response.items[0]?.id).toBe("e_0");
    expect(response.learned).toHaveLength(TURN_LIMITS.learned);
    expect(response.about_learner).toEqual([{ fact: "f0", topic: "OTHER" }]);
    expect(response.closing?.remember).toEqual(["r0", "r1", "r2"]);
  });

  it("drops unknown extra fields and trims strings", () => {
    const response = expectOk(
      JSON.stringify({
        ...MINIMAL,
        reasoning: "should vanish",
        segments: [{ lang: "IT", kind: "SAY", text: "  Ciao  ", extra: 1 }],
        listen: { lang: "EN", expect: "FREE", target: "   ", alternatives: ["", 3, " ok "], mood: "x" },
        correction: { heard: " I have ", correct: " I am ", note_it: " nota ", severity: 9 },
      }),
    );
    expect(Object.keys(response).sort()).toEqual(Object.keys(MINIMAL).sort());
    expect(response.segments[0]).toEqual({ lang: "IT", kind: "SAY", text: "Ciao" });
    expect(response.listen).toEqual({ lang: "EN", expect: "FREE", alternatives: ["ok"] });
    expect(response.correction).toEqual({ heard: "I have", correct: "I am", note_it: "nota" });
  });

  it("treats empty correction/goal/closing content as absent and bad shapes as errors", () => {
    expect(
      expectOk(JSON.stringify({ ...MINIMAL, correction: { heard: "", correct: "x", note_it: "" } }))
        .correction,
    ).toBeNull();
    expect(expectOk(JSON.stringify({ ...MINIMAL, goal: { id: " ", status: "ONGOING" } })).goal).toBeNull();
    expect(expectOk(JSON.stringify({ ...MINIMAL, closing: {} })).closing).toEqual({ remember: [] });
    expect(expectReason({ ...MINIMAL, correction: "oops" })).toBe("correction: atteso un oggetto o null");
    expect(expectReason({ ...MINIMAL, correction: { heard: 1, correct: "x" } })).toBe(
      "correction.heard: attesa una stringa",
    );
    expect(expectReason({ ...MINIMAL, items: [{ kind: "PHRASE", signal: "HARD" }] })).toBe(
      "items[0].id: attesa una stringa",
    );
    expect(expectReason({ ...MINIMAL, items: [null] })).toBe("items[0]: atteso un oggetto");
    expect(expectReason({ ...MINIMAL, closing: { remember: "x" } })).toBe(
      "closing.remember: atteso un elenco",
    );
  });

  it("skips items and learned entries whose key text is blank", () => {
    const response = expectOk(
      JSON.stringify({
        ...MINIMAL,
        items: [
          { kind: "PHRASE", id: "", signal: "HARD" },
          { kind: "ERROR", id: "e_1", signal: "FAILED" },
        ],
        learned: [{ text_en: " ", gloss_it: "x", topic: "TRAVEL" }],
      }),
    );
    expect(response.items).toEqual([{ kind: "ERROR", id: "e_1", signal: "FAILED" }]);
    expect(response.learned).toEqual([]);
  });
});
