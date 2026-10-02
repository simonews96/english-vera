/** In-memory `Storage` for the cost meter and calibration store tests; can simulate a quota error. */
export function fakeStorage(
  initial: Record<string, string> = {},
  options: { throwOnWrite?: boolean } = {},
): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => {
      if (options.throwOnWrite) throw new Error("QuotaExceededError");
      map.set(key, value);
    },
  };
}
