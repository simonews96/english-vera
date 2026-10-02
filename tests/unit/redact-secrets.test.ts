import { describe, expect, it } from "vitest";
import { maskKey, redactSecrets } from "../../src/core/redact/redact";

const ANTHROPIC = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_ABCDEFGHIJ1234";

const CASES: Array<[name: string, input: string, expected: string]> = [
  ["key inside JSON", `{"apiKey":"${ANTHROPIC}","model":"x"}`, '{"apiKey":"sk-ant-…1234","model":"x"}'],
  ["key inside a URL", `https://x.test/?key=${ANTHROPIC}&v=1`, "https://x.test/?key=sk-ant-…1234&v=1"],
  ["key in an x-api-key header", `x-api-key: ${ANTHROPIC}`, "x-api-key: sk-ant-…1234"],
  [
    "bearer token",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdWXYZ",
    "Authorization: Bearer …WXYZ",
  ],
  [
    "bearer token that is an Anthropic key",
    `Authorization: Bearer ${ANTHROPIC}`,
    "Authorization: Bearer …1234",
  ],
  [
    "fine-grained GitHub token",
    "token github_pat_11ABCDEF0_abcdefghijklmnopQRST ok",
    "token github_pat_…QRST ok",
  ],
  ["classic GitHub token", '{"token":"ghp_abcdefghijklmnopqrstuvwxyz9876"}', '{"token":"ghp_…9876"}'],
  ["OAuth GitHub token", "gho_abcdefghijklmnop5555", "gho_…5555"],
  [
    "several secrets in one message",
    `key ${ANTHROPIC} and ghp_abcdefghijklmnop0001 and Bearer tok_abcd`,
    "key sk-ant-…1234 and ghp_…0001 and Bearer …abcd",
  ],
  ["Italian error text with a key", `Chiave non valida: ${ANTHROPIC}.`, "Chiave non valida: sk-ant-…1234."],
  ["short key", "sk-ant-abc", "sk-ant-…abc"],
  [
    "no secrets",
    "Filo spezzato: nessuna risposta (status 529)",
    "Filo spezzato: nessuna risposta (status 529)",
  ],
  ["empty", "", ""],
];

describe("redactSecrets", () => {
  it.each(CASES)("%s", (_name, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("is idempotent", () => {
    for (const [, input] of CASES) {
      const once = redactSecrets(input);
      expect(redactSecrets(once)).toBe(once);
    }
  });

  it("never leaves the full secret in the output", () => {
    for (const [, input] of CASES) {
      const out = redactSecrets(input);
      expect(out).not.toContain(ANTHROPIC);
      expect(out).not.toMatch(/ghp_[A-Za-z0-9]{10,}/);
    }
  });

  it("does not touch words that merely contain the prefixes", () => {
    expect(redactSecrets("ask-anthropic about gho_ and sk-ant-")).toBe(
      "ask-anthropic about gho_ and sk-ant-",
    );
  });
});

describe("maskKey", () => {
  it.each([
    ["", ""],
    ["   ", ""],
    [ANTHROPIC, "sk-…1234"],
    ["sk-live-abcdefgh9999", "sk-…9999"],
    ["github_pat_11ABCDEFGHIJ", "github_pat_…GHIJ"],
    ["ghp_abcdefghijkl", "ghp_…ijkl"],
    ["short", "…"],
    ["sk-ab", "sk-…"],
    ["some-other-token-value-7777", "…7777"],
  ])("maskKey(%j) -> %j", (key, expected) => {
    expect(maskKey(key)).toBe(expected);
  });

  it("produces output that redaction leaves alone", () => {
    const masked = maskKey(ANTHROPIC);
    expect(redactSecrets(masked)).toBe(masked);
  });
});
