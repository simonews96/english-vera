import { describe, expect, it } from "vitest";
import { levenshtein, matchHelp, normalizedDistance, normalizeHelpText } from "../../src/core/session/help";

describe("help matcher: normalization and distance", () => {
  it("lowercases, strips accents and punctuation", () => {
    expect(normalizeHelpText("  Più LENTO, per favore!  ")).toBe("piu lento per favore");
    expect(normalizeHelpText("I don't understand.")).toBe("i dont understand");
  });

  it("computes Levenshtein and its normalized form", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(normalizedDistance("abcd", "abcd")).toBe(0);
    expect(normalizedDistance("abcd", "abce")).toBe(0.25);
  });
});

describe("help matcher: positives", () => {
  it.each([
    ["Ripeti", "REPEAT"],
    ["ripeti per favore", "REPEAT"],
    ["Puoi ripetere?", "REPEAT"],
    ["repeat", "REPEAT"],
    ["say it again", "REPEAT"],
    ["ancora", "REPEAT"],
    ["più lento", "SLOWER"],
    ["piu lento", "SLOWER"],
    ["più piano", "SLOWER"],
    ["ripeti più lento", "SLOWER"],
    ["slower", "SLOWER"],
    ["slow down", "SLOWER"],
    ["non ho capito", "DIDNT_UNDERSTAND"],
    ["non o capito", "DIDNT_UNDERSTAND"],
    ["non capisco", "DIDNT_UNDERSTAND"],
    ["I don't understand", "DIDNT_UNDERSTAND"],
    ["What?", "DIDNT_UNDERSTAND"],
  ])("'%s' is %s", (text, kind) => {
    expect(matchHelp(text)?.kind).toBe(kind);
  });

  it("tolerates recognizer deformations within 25% of the length", () => {
    expect(matchHelp("non ho capitto")?.kind).toBe("DIDNT_UNDERSTAND");
    expect(matchHelp("ripete")?.kind).toBe("REPEAT");
    expect(matchHelp("pew lento")?.kind).toBe("SLOWER");
  });

  it("prefers the closest variant when several are within tolerance", () => {
    expect(matchHelp("ripeti più piano")?.kind).toBe("SLOWER");
  });
});

describe("help matcher: come si dice / how do you say", () => {
  it("returns the payload after the prefix", () => {
    expect(matchHelp("come si dice grazie")).toEqual({ kind: "HOW_TO_SAY", payload: "grazie" });
    expect(matchHelp("How do you say buongiorno?")).toEqual({ kind: "HOW_TO_SAY", payload: "buongiorno" });
  });

  it("strips 'in inglese' / 'in english' around the payload", () => {
    expect(matchHelp("come si dice in inglese il conto")).toEqual({
      kind: "HOW_TO_SAY",
      payload: "il conto",
    });
    expect(matchHelp("come si dice il conto in inglese")).toEqual({
      kind: "HOW_TO_SAY",
      payload: "il conto",
    });
    expect(matchHelp("how do you say in english thank you")).toEqual({
      kind: "HOW_TO_SAY",
      payload: "thank you",
    });
  });

  it("has no payload when only the prefix was said", () => {
    expect(matchHelp("come si dice")).toEqual({ kind: "HOW_TO_SAY" });
    expect(matchHelp("come si dice in inglese")).toEqual({ kind: "HOW_TO_SAY" });
    expect(matchHelp("how do you say")).toEqual({ kind: "HOW_TO_SAY" });
  });

  it("tolerates a deformed prefix", () => {
    expect(matchHelp("come se dice scusi")).toEqual({ kind: "HOW_TO_SAY", payload: "scusi" });
    expect(matchHelp("comme si dice acqua")).toEqual({ kind: "HOW_TO_SAY", payload: "acqua" });
  });
});

describe("help matcher: negatives", () => {
  it.each([
    "I would like a coffee",
    "non ho capito niente di quello che ha detto il cameriere",
    "What time is it?",
    "that",
    "the train is slow",
    "I would like to repeat the course next year",
    "",
    "   ",
  ])("'%s' is not help", (text) => {
    expect(matchHelp(text)).toBeNull();
  });
});
