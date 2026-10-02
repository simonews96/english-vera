/**
 * Maps whatever the SDK (or the platform) throws to the app's `LlmError` table
 * (docs/PIANO.md §1.1). Messages never carry the API key: anything that looks like
 * one is redacted before it reaches a log or a diagnostic label.
 */

import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import { LlmError } from "./types";

const ZDR_CORS_TEXT = "CORS requests are not allowed";
const SPEND_LIMIT_400_TEXT = "specified API usage limits";
const SPEND_LIMIT_429_TYPE = "enforced_spend_limit_reached";
const OVERLOADED_STATUS = 529;

/** Redacts anything shaped like an Anthropic key. Exported for the diagnostics label. */
export function redactSecrets(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]{4,}/g, "sk-ant-…");
}

function readBodyErrorType(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
  const inner: unknown = body.error;
  if (typeof inner !== "object" || inner === null || !("type" in inner)) return undefined;
  return typeof inner.type === "string" ? inner.type : undefined;
}

/**
 * Parses `retry-after-ms` or `retry-after` (seconds or HTTP date). Returns undefined when
 * the header is missing or unreadable.
 */
export function parseRetryAfterMs(
  headers: Headers | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!headers) return undefined;
  const millis = headers.get("retry-after-ms");
  if (millis !== null) {
    const parsed = Number.parseFloat(millis);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  }
  const header = headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number.parseFloat(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

function fromApiError(err: APIError): LlmError {
  const status = err.status;
  const message = redactSecrets(err.message);
  const bodyType = err.type ?? readBodyErrorType(err.error);
  const options = status === undefined ? {} : { status };

  if (bodyType === "overloaded_error" || status === OVERLOADED_STATUS) {
    return new LlmError("overloaded", message, options);
  }
  if (status === 401 || bodyType === "authentication_error") {
    return message.includes(ZDR_CORS_TEXT)
      ? new LlmError("zdr-cors", message, options)
      : new LlmError("invalid-key", message, options);
  }
  if (status === 429 || bodyType === "rate_limit_error") {
    const retryAfterMs = parseRetryAfterMs(err.headers);
    const spendLimit = bodyType === SPEND_LIMIT_429_TYPE || message.includes(SPEND_LIMIT_429_TYPE);
    if (spendLimit || retryAfterMs === undefined) {
      return new LlmError("spend-limit", message, options);
    }
    return new LlmError("rate-limited", message, { ...options, retryAfterMs });
  }
  if (bodyType === "billing_error") {
    return new LlmError("spend-limit", message, options);
  }
  if (status === 400 && message.includes(SPEND_LIMIT_400_TEXT)) {
    return new LlmError("spend-limit", message, options);
  }
  if (bodyType === "timeout_error") {
    return new LlmError("timeout", message, options);
  }
  if ((status !== undefined && status >= 500) || bodyType === "api_error") {
    return new LlmError("server", message, options);
  }
  if ((status !== undefined && status >= 400) || bodyType === "invalid_request_error") {
    return new LlmError("bad-request", message, options);
  }
  return new LlmError("unknown", message, options);
}

export function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof APIUserAbortError) return new LlmError("network", "aborted");
  if (err instanceof APIConnectionTimeoutError) return new LlmError("timeout", redactSecrets(err.message));
  if (err instanceof APIConnectionError) return new LlmError("network", redactSecrets(err.message));
  if (err instanceof APIError) return fromApiError(err);
  if (err instanceof Error) {
    if (err.name === "AbortError") return new LlmError("network", "aborted");
    if (err.name === "TimeoutError") return new LlmError("timeout", redactSecrets(err.message));
    return new LlmError("unknown", redactSecrets(err.message));
  }
  return new LlmError("unknown", redactSecrets(String(err)));
}
