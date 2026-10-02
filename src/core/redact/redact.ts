/**
 * Secret redaction (docs/PIANO.md §1.6): every message that is saved, copied, exported or
 * synced goes through `redactSecrets` first. Masks keep the prefix and the last 4 characters
 * so the user can tell which key was involved without the key leaking.
 */

const ELLIPSIS = "…";
const TAIL = 4;

/** Anthropic keys: `sk-ant-` followed by a run of key characters. */
const ANTHROPIC_KEY = /sk-ant-([A-Za-z0-9_-]+)/g;
/** GitHub tokens: fine-grained (`github_pat_`) and classic (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`). */
const GITHUB_TOKEN = /\b(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)([A-Za-z0-9_]+)/g;
/** Bearer credentials in headers or header-like text; the token must end at a non-token char (never at `…`). */
const BEARER_TOKEN = /\b(Bearer\s+)([\w\-.~+/]+=*)(?![\w\-.~+/=…])/gi;

function tail(secret: string): string {
  return secret.length > TAIL ? secret.slice(-TAIL) : secret;
}

/**
 * Masks Anthropic keys, GitHub tokens and Bearer tokens anywhere in the text (JSON, URLs,
 * headers, prose). Idempotent: masked forms contain `…` right after the prefix, which no
 * pattern matches again.
 */
export function redactSecrets(text: string): string {
  if (text === "") return text;
  // Bearer first: a bearer value that is itself an Anthropic/GitHub token is masked once, as a whole.
  return text
    .replace(BEARER_TOKEN, (_match, prefix: string, body: string) => `${prefix}${ELLIPSIS}${tail(body)}`)
    .replace(ANTHROPIC_KEY, (_match, body: string) => `sk-ant-${ELLIPSIS}${tail(body)}`)
    .replace(GITHUB_TOKEN, (_match, prefix: string, body: string) => `${prefix}${ELLIPSIS}${tail(body)}`);
}

/**
 * Short display form of a stored key for the settings label: `sk-…a1b2` (Anthropic),
 * `github_pat_…a1b2` / `ghp_…a1b2` (GitHub), `…a1b2` otherwise. Short keys (≤ 8 characters)
 * show no tail; an empty key renders as "".
 */
export function maskKey(key: string): string {
  const value = key.trim();
  if (value === "") return "";
  let prefix = "";
  if (value.startsWith("sk-")) prefix = "sk-";
  else {
    const match = /^(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)/.exec(value);
    if (match?.[1]) prefix = match[1];
  }
  const shown = value.length > 8 ? value.slice(-TAIL) : "";
  return `${prefix}${ELLIPSIS}${shown}`;
}
