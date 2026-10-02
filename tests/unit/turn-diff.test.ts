import { describe, expect, it } from "vitest";
import { diffCorrection, sharesLetters, wordKey } from "../../src/core/turn/diff";

describe("diffCorrection", () => {
  it("handles the canonical example: replace plus insert", () => {
    expect(diffCorrection("I have thirty years", "I am thirty years old")).toEqual({
      kind: "changes",
      words: ["I", "am", "thirty", "years", "old"],
      changes: [
        { op: "replace", index: 1, from: "have", to: "am" },
        { op: "insert", index: 4, to: "old" },
      ],
    });
  });

  it("reports a single replacement", () => {
    const result = diffCorrection("She go to school", "She goes to school");
    expect(result).toEqual({
      kind: "changes",
      words: ["She", "goes", "to", "school"],
      changes: [{ op: "replace", index: 1, from: "go", to: "goes" }],
    });
  });

  it("reports an insertion at the start", () => {
    expect(diffCorrection("want a coffee", "I want a coffee")).toEqual({
      kind: "changes",
      words: ["I", "want", "a", "coffee"],
      changes: [{ op: "insert", index: 0, to: "I" }],
    });
  });

  it("reports a deletion, indexed by the corrected word that follows it", () => {
    expect(diffCorrection("I am agree with you", "I agree with you")).toEqual({
      kind: "changes",
      words: ["I", "agree", "with", "you"],
      changes: [{ op: "delete", index: 1, from: "am" }],
    });
    expect(diffCorrection("I like it much", "I like it")).toEqual({
      kind: "changes",
      words: ["I", "like", "it"],
      changes: [{ op: "delete", index: 3, from: "much" }],
    });
  });

  it("pairs deletions and insertions in the same gap as replacements", () => {
    const result = diffCorrection("He don't like", "He doesn't like it");
    expect(result).toEqual({
      kind: "changes",
      words: ["He", "doesn't", "like", "it"],
      changes: [
        { op: "replace", index: 1, from: "don't", to: "doesn't" },
        { op: "insert", index: 3, to: "it" },
      ],
    });
  });

  it("ignores case and trailing punctuation when matching words", () => {
    expect(diffCorrection("i have thirty years.", "I am thirty years old.")).toEqual({
      kind: "changes",
      words: ["I", "am", "thirty", "years", "old."],
      changes: [
        { op: "replace", index: 1, from: "have", to: "am" },
        { op: "insert", index: 4, to: "old." },
      ],
    });
    expect(diffCorrection("hello , how are you ?", "Hello, how are you?")).toEqual({
      kind: "changes",
      words: ["Hello,", "how", "are", "you?"],
      changes: [
        { op: "delete", index: 1, from: "," },
        { op: "delete", index: 4, from: "?" },
      ],
    });
    expect(wordKey("Years.")).toBe("years");
    expect(wordKey("...")).toBe("...");
  });

  it("returns no changes for sentences that only differ in case or punctuation", () => {
    expect(diffCorrection("i am fine", "I am fine.")).toEqual({
      kind: "changes",
      words: ["I", "am", "fine."],
      changes: [],
    });
  });

  it("falls back to the whole line beyond two changes or on blank input", () => {
    expect(diffCorrection("me want go shop now", "I want to go to the shop")).toEqual({ kind: "whole" });
    expect(diffCorrection("", "I am fine")).toEqual({ kind: "whole" });
    expect(diffCorrection("I am fine", "   ")).toEqual({ kind: "whole" });
    expect(diffCorrection("completely different words here", "nothing in common at all")).toEqual({
      kind: "whole",
    });
  });
});

describe("sharesLetters", () => {
  it("decides between a letter morph and a plain swap", () => {
    expect(sharesLetters("year", "years")).toBe(true);
    expect(sharesLetters("go", "goes")).toBe(true);
    expect(sharesLetters("have", "am")).toBe(false);
    expect(sharesLetters("don't", "doesn't")).toBe(true);
    expect(sharesLetters("", "am")).toBe(false);
    expect(sharesLetters("...", "!!!")).toBe(false);
  });

  it("honors the threshold", () => {
    expect(sharesLetters("cat", "act", 0.3)).toBe(true);
    expect(sharesLetters("cat", "act", 0.9)).toBe(false);
  });
});
