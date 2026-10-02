import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT_STABLE, SYSTEM_PROMPT_VERSION } from "../../src/core/prompt/system";

const SOURCE_PATH = resolve(__dirname, "../../src/core/prompt/system.ts");

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

describe("system prompt: size", () => {
  it("is between 900 and 1400 words (above the 512-token cache minimum, below the budget)", () => {
    const words = wordCount(SYSTEM_PROMPT_STABLE);
    expect(words).toBeGreaterThanOrEqual(900);
    expect(words).toBeLessThanOrEqual(1400);
  });

  it("has a version tag for the milestone", () => {
    expect(SYSTEM_PROMPT_VERSION).toBe("m1.0");
  });
});

describe("system prompt: protocol vocabulary", () => {
  it.each([
    "MODEL",
    "REPEAT",
    "ANSWER",
    "FREE",
    "FAILED",
    "HARD",
    "PRODUCED",
    "SPONTANEOUS",
    "NOT_OBSERVED",
    "closing",
    "closing.remember",
    "note_it",
    "heard",
    "about_learner",
    "learned",
    "listen.lang",
    "listen.expect",
    "listen.target",
    "goal.status",
    "DIDNT_UNDERSTAND",
    "HOW_TO_SAY",
    "SLOW",
    "WARMUP",
    "SCENARIO",
    "CLOSING",
    "[inizio sessione]",
    "<learner_card>",
    "<help>",
    "<learner_says>",
    "TRAVEL",
    "TABLE_AND_STAY",
    "CITY_AND_TROUBLE",
    "SMALL_TALK",
  ])("mentions %s", (token) => {
    expect(SYSTEM_PROMPT_STABLE).toContain(token);
  });

  it("states the key teaching rules", () => {
    expect(SYSTEM_PROMPT_STABLE).toMatch(/two word changes/i);
    expect(SYSTEM_PROMPT_STABLE).toMatch(/one error per turn/i);
    expect(SYSTEM_PROMPT_STABLE).toMatch(/NEXT turn/);
    expect(SYSTEM_PROMPT_STABLE).toMatch(/never invent/i);
    expect(SYSTEM_PROMPT_STABLE).toMatch(/failed first attempt is FAILED, never HARD/);
    expect(SYSTEM_PROMPT_STABLE).toMatch(/three things/i);
    expect(SYSTEM_PROMPT_STABLE).toMatch(/No emojis/);
    expect(SYSTEM_PROMPT_STABLE).toMatch(/numbers as words/i);
    expect(SYSTEM_PROMPT_STABLE).toMatch(/A0:/);
    expect(SYSTEM_PROMPT_STABLE).toMatch(/A1:/);
    expect(SYSTEM_PROMPT_STABLE).toMatch(/A1\+:/);
    expect(SYSTEM_PROMPT_STABLE).toMatch(/A2:/);
  });
});

describe("system prompt: byte stability", () => {
  it("is a plain constant: the source uses no clock, randomness or interpolation", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/Math\.random/);
    expect(source).not.toMatch(/\$\{/);
    expect(source).not.toMatch(/\bimport\b/);
  });

  it("contains no dates, emojis or learner placeholders", () => {
    expect(SYSTEM_PROMPT_STABLE).not.toMatch(/\b20\d\d\b/);
    expect(SYSTEM_PROMPT_STABLE).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(SYSTEM_PROMPT_STABLE).not.toMatch(/\{\{|\}\}/);
  });

  it("is the same string on repeated reads", () => {
    const first = SYSTEM_PROMPT_STABLE;
    const second = `${SYSTEM_PROMPT_STABLE}`;
    expect(second).toBe(first);
    expect(second.length).toBe(first.length);
  });
});
