/**
 * Per-model request presets (docs/PIANO.md §1.1). The reasoning parameters are
 * model-specific and not interchangeable: Sonnet 5.5 is the only model that accepts
 * `between_tools`, Haiku 4.5 rejects `adaptive` and `effort`, Opus 5.5 cannot turn
 * thinking off. Thinking and effort stay constant for a whole session (changing them
 * invalidates the prompt cache).
 */

import type { ModelPreset, ModelPresetId } from "./types";

export type BuiltinPresetId = Exclude<ModelPresetId, "custom">;

/** ≈1.536 tokens: a full turn JSON with margin (the Sonnet 5.5 tokenizer is ≈30% denser than Haiku's). */
export const TURN_MAX_TOKENS = 1536;

export const DEFAULT_PRESET_ID: BuiltinPresetId = "sonnet-between-tools";

export const PRESETS: Record<BuiltinPresetId, ModelPreset> = {
  "sonnet-between-tools": {
    id: "sonnet-between-tools",
    label: "Sonnet 5.5 (predefinito)",
    model: "claude-sonnet-5-5",
    thinking: { type: "between_tools" },
    effort: "low",
    maxTokens: TURN_MAX_TOKENS,
  },
  "sonnet-adaptive-low": {
    id: "sonnet-adaptive-low",
    label: "Sonnet 5.5, ragionamento adattivo",
    model: "claude-sonnet-5-5",
    thinking: { type: "adaptive", display: "omitted" },
    effort: "low",
    maxTokens: TURN_MAX_TOKENS,
  },
  haiku: {
    id: "haiku",
    label: "Haiku 4.5 (turbo)",
    model: "claude-haiku-4-5",
    maxTokens: TURN_MAX_TOKENS,
  },
  opus: {
    id: "opus",
    label: "Opus 5.5 (qualità)",
    model: "claude-opus-5-5",
    effort: "low",
    maxTokens: TURN_MAX_TOKENS,
  },
};

/**
 * Resolves the preset selected in the settings. A custom model ID gets no reasoning
 * parameters at all (the server would answer 400 on an unsupported one). A blank custom
 * ID falls back to the default preset so that no request ever leaves with an empty model.
 */
export function resolvePreset(settings: { modelPreset: ModelPresetId; customModel: string }): ModelPreset {
  if (settings.modelPreset !== "custom") {
    return PRESETS[settings.modelPreset];
  }
  const model = settings.customModel.trim();
  if (model === "") {
    return PRESETS[DEFAULT_PRESET_ID];
  }
  return { id: "custom", label: "Personalizzato", model, maxTokens: TURN_MAX_TOKENS };
}
