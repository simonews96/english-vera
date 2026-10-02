/**
 * User settings, stored only in this browser (localStorage). Secrets (the API key) never
 * leave the device: not in exports, not in sync payloads, not in logs.
 */

import type { ModelPresetId } from "../llm/types";

export type ThemeSetting = "system" | "light" | "dark";
export type MotionSetting = "system" | "reduced" | "full";

export interface Settings {
  readonly apiKey: string;
  readonly keyValidatedAt: string | null;
  readonly modelPreset: ModelPresetId;
  /** Used only when `modelPreset` is "custom". */
  readonly customModel: string;
  readonly englishVariant: "en-GB" | "en-US";
  readonly voiceEn: string | null;
  readonly voiceIt: string | null;
  readonly rate: number;
  readonly theme: ThemeSetting;
  readonly motion: MotionSetting;
  readonly textMode: boolean;
  readonly listenMode: "handsfree" | "push";
  readonly dailyBudgetUsd: number;
  readonly learnerName: string;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  keyValidatedAt: null,
  modelPreset: "sonnet-between-tools",
  customModel: "",
  englishVariant: "en-GB",
  voiceEn: null,
  voiceIt: null,
  rate: 1,
  theme: "system",
  motion: "system",
  textMode: false,
  listenMode: "handsfree",
  dailyBudgetUsd: 0.8,
  learnerName: "",
};

const STORAGE_KEY = "vera.settings.v1";

export interface SettingsStore {
  get(): Settings;
  update(patch: Partial<Settings>): Settings;
  subscribe(listener: (settings: Settings) => void): () => void;
  /** Removes the API key (and only the key) from this device. */
  forgetKey(): Settings;
}

function safeRead(storage: Storage | null): Partial<Settings> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Partial<Settings>) : {};
  } catch {
    return {};
  }
}

function safeWrite(storage: Storage | null, settings: Settings): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private mode, quota). Settings then live in memory only.
  }
}

export function createSettingsStore(
  storage: Storage | null = globalThis.localStorage ?? null,
): SettingsStore {
  let current: Settings = { ...DEFAULT_SETTINGS, ...safeRead(storage) };
  const listeners = new Set<(settings: Settings) => void>();
  const emit = (): void => {
    for (const listener of listeners) listener(current);
  };
  return {
    get: () => current,
    update(patch) {
      current = { ...current, ...patch };
      safeWrite(storage, current);
      emit();
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    forgetKey() {
      current = { ...current, apiKey: "", keyValidatedAt: null };
      safeWrite(storage, current);
      emit();
      return current;
    },
  };
}
