import { describe, expect, it } from "vitest";
import { INITIAL_GOALS } from "../../src/core/prompt/goals";

const LEVELS = ["A0", "A1", "A1+", "A2"] as const;
const DOMAINS = [
  "AIRPORT",
  "HOTEL",
  "RESTAURANT",
  "DIRECTIONS",
  "SHOPPING",
  "TROUBLE",
  "SMALL_TALK",
] as const;

describe("initial micro-goals", () => {
  it("has between 32 and 40 goals", () => {
    expect(INITIAL_GOALS.length).toBeGreaterThanOrEqual(32);
    expect(INITIAL_GOALS.length).toBeLessThanOrEqual(40);
  });

  it("has unique ids and unique orders", () => {
    const ids = new Set(INITIAL_GOALS.map((goal) => goal.id));
    const orders = new Set(INITIAL_GOALS.map((goal) => goal.order));
    expect(ids.size).toBe(INITIAL_GOALS.length);
    expect(orders.size).toBe(INITIAL_GOALS.length);
  });

  it("is listed in ascending order, starting at one, with levels never going down", () => {
    INITIAL_GOALS.forEach((goal, index) => {
      expect(goal.order).toBe(index + 1);
    });
    const ranks = INITIAL_GOALS.map((goal) => LEVELS.indexOf(goal.level));
    for (let index = 1; index < ranks.length; index += 1) {
      expect(ranks[index]).toBeGreaterThanOrEqual(ranks[index - 1] ?? 0);
    }
  });

  it("uses valid levels and domains, with every level and domain represented", () => {
    for (const goal of INITIAL_GOALS) {
      expect(LEVELS).toContain(goal.level);
      expect(DOMAINS).toContain(goal.domain);
    }
    for (const level of LEVELS) expect(INITIAL_GOALS.some((goal) => goal.level === level)).toBe(true);
    for (const domain of DOMAINS) expect(INITIAL_GOALS.some((goal) => goal.domain === domain)).toBe(true);
  });

  it("starts with the A0 basics for the first weeks", () => {
    const a0 = INITIAL_GOALS.filter((goal) => goal.level === "A0");
    expect(a0.length).toBeGreaterThanOrEqual(10);
    expect(a0.map((goal) => goal.id)).toContain("g_a0_greet_name");
    expect(a0.map((goal) => goal.id)).toContain("g_a0_dont_understand");
    expect(a0.map((goal) => goal.id)).toContain("g_a0_order_coffee");
  });

  it("has non-empty English text and Italian gloss, with ids in snake case", () => {
    for (const goal of INITIAL_GOALS) {
      expect(goal.textEn.trim().length).toBeGreaterThan(0);
      expect(goal.textIt.trim().length).toBeGreaterThan(0);
      expect(goal.id).toMatch(/^g_[a-z0-9]+(_[a-z0-9]+)+$/);
      expect(goal.textEn).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
