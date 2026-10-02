import { describe, expect, it } from "vitest";
import { createSettingsStore, DEFAULT_SETTINGS } from "../../src/storage/settings";

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

describe("settings store", () => {
  it("starts from defaults when storage is empty", () => {
    const store = createSettingsStore(fakeStorage());
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it("persists updates and notifies subscribers", () => {
    const storage = fakeStorage();
    const store = createSettingsStore(storage);
    const seen: string[] = [];
    store.subscribe((s) => seen.push(s.learnerName));
    store.update({ learnerName: "Simone" });
    expect(seen).toEqual(["Simone"]);
    expect(createSettingsStore(storage).get().learnerName).toBe("Simone");
  });

  it("forgets only the key", () => {
    const store = createSettingsStore(fakeStorage());
    store.update({ apiKey: "sk-ant-test", learnerName: "Simone", keyValidatedAt: "2026-10-02" });
    const after = store.forgetKey();
    expect(after.apiKey).toBe("");
    expect(after.keyValidatedAt).toBeNull();
    expect(after.learnerName).toBe("Simone");
  });

  it("survives a corrupt storage value", () => {
    const store = createSettingsStore(fakeStorage({ "vera.settings.v1": "{not json" }));
    expect(store.get().modelPreset).toBe("sonnet-between-tools");
  });
});
