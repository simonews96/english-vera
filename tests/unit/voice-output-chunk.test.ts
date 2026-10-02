import { describe, expect, it } from "vitest";
import { chunkText, chunkWithOffsets } from "../../src/voice/chunk";

describe("chunkText", () => {
  it("splits on sentence terminators and line breaks", () => {
    expect(chunkText("Hello there. How are you? Fine!\nGood: yes; no.")).toEqual([
      "Hello there.",
      "How are you?",
      "Fine!",
      "Good:",
      "yes;",
      "no.",
    ]);
  });

  it("keeps closing quotes and ellipses with their sentence", () => {
    expect(chunkText('She said "Wait..." Then left.')).toEqual(['She said "Wait..."', "Then left."]);
  });

  it("does not split on a dot inside a token or before a lowercase word (3.5, e.g.)", () => {
    expect(chunkText("It costs 3.5 euros e.g. today.")).toEqual(["It costs 3.5 euros e.g. today."]);
    expect(chunkText("Wait... what? Yes; no.")).toEqual(["Wait... what?", "Yes;", "no."]);
  });

  it("never returns empty strings", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
    expect(chunkText("... !!")).toEqual(["...", "!!"]);
  });

  it("splits a long sentence on commas and packs pieces up to the limit", () => {
    const text = "one two, three four, five six, seven eight";
    expect(chunkText(text, 20)).toEqual(["one two, three four,", "five six,", "seven eight"]);
  });

  it("hard-splits on spaces and then by characters when a token is too long", () => {
    expect(chunkText("alpha beta gamma", 10)).toEqual(["alpha beta", "gamma"]);
    expect(chunkText("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
  });

  it("keeps every chunk within the limit", () => {
    const text =
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. ".repeat(
        6,
      );
    for (const chunk of chunkText(text, 60)) expect(chunk.length).toBeLessThanOrEqual(60);
  });
});

describe("chunkWithOffsets", () => {
  it("returns offsets that map each chunk back to the original text", () => {
    const text = "  Hello there.   How are you?\nFine, thanks a lot, really.";
    const chunks = chunkWithOffsets(text, 16);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(text.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(chunk.text);
      expect(chunk.text.trim()).toBe(chunk.text);
    }
    expect(chunks[0]).toEqual({ text: "Hello there.", offset: 2 });
    expect(chunks[1]).toEqual({ text: "How are you?", offset: 17 });
  });
});
