import { describe, expect, it } from "vitest";
import { DEFAULT_PRESET_ID, PRESETS, resolvePreset, TURN_MAX_TOKENS } from "../../src/llm/presets";

describe("model presets", () => {
  it("match the plan table (docs/PIANO.md §1.1)", () => {
    expect(PRESETS["sonnet-between-tools"]).toMatchObject({
      model: "claude-sonnet-5-5",
      thinking: { type: "between_tools" },
      effort: "low",
      maxTokens: 1536,
    });
    expect(PRESETS["sonnet-adaptive-low"]).toMatchObject({
      model: "claude-sonnet-5-5",
      thinking: { type: "adaptive", display: "omitted" },
      effort: "low",
    });
    expect(PRESETS.haiku.model).toBe("claude-haiku-4-5");
    expect(PRESETS.haiku).not.toHaveProperty("thinking");
    expect(PRESETS.haiku).not.toHaveProperty("effort");
    expect(PRESETS.opus).toMatchObject({ model: "claude-opus-5-5", effort: "low" });
    expect(PRESETS.opus).not.toHaveProperty("thinking");
    for (const preset of Object.values(PRESETS)) {
      expect(preset.maxTokens).toBe(TURN_MAX_TOKENS);
      expect(preset.model).not.toMatch(/\d{8}/);
    }
  });

  it("resolves a builtin preset by id", () => {
    expect(resolvePreset({ modelPreset: "haiku", customModel: "ignored" })).toBe(PRESETS.haiku);
  });

  it("resolves a custom model with no reasoning parameters and an Italian label", () => {
    const preset = resolvePreset({ modelPreset: "custom", customModel: "  claude-future-9  " });
    expect(preset).toEqual({
      id: "custom",
      label: "Personalizzato",
      model: "claude-future-9",
      maxTokens: TURN_MAX_TOKENS,
    });
  });

  it("falls back to the default preset when the custom id is blank", () => {
    expect(resolvePreset({ modelPreset: "custom", customModel: "   " })).toBe(PRESETS[DEFAULT_PRESET_ID]);
  });
});
