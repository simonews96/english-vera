import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { parseRetryAfterMs, redactSecrets, toLlmError } from "../../src/llm/errors";
import { LlmError } from "../../src/llm/types";

function apiError(
  status: number,
  type: string,
  message: string,
  headers: Record<string, string> = {},
): APIError {
  return APIError.generate(
    status,
    { type: "error", error: { type, message } },
    message,
    new Headers(headers),
  );
}

describe("toLlmError", () => {
  it("passes an LlmError through", () => {
    const original = new LlmError("refusal", "x");
    expect(toLlmError(original)).toBe(original);
  });

  it("maps 401 to invalid-key, or zdr-cors when the organization forbids browser calls", () => {
    expect(toLlmError(apiError(401, "authentication_error", "invalid x-api-key")).kind).toBe("invalid-key");
    const zdr = toLlmError(
      apiError(
        401,
        "authentication_error",
        "CORS requests are not allowed for this Organization because of its settings.",
      ),
    );
    expect(zdr.kind).toBe("zdr-cors");
    expect(zdr.status).toBe(401);
  });

  it("maps the spend-limit 400 and the 429 variants", () => {
    expect(
      toLlmError(apiError(400, "invalid_request_error", "You have reached your specified API usage limits."))
        .kind,
    ).toBe("spend-limit");
    expect(toLlmError(apiError(400, "invalid_request_error", "messages: field required")).kind).toBe(
      "bad-request",
    );
    expect(toLlmError(apiError(429, "rate_limit_error", "enforced_spend_limit_reached")).kind).toBe(
      "spend-limit",
    );
    expect(toLlmError(apiError(429, "rate_limit_error", "Too many requests")).kind).toBe("spend-limit");
    const limited = toLlmError(
      apiError(429, "rate_limit_error", "Too many requests", { "retry-after": "8" }),
    );
    expect(limited.kind).toBe("rate-limited");
    expect(limited.retryAfterMs).toBe(8000);
    expect(limited.status).toBe(429);
  });

  it("maps 529 and overloaded_error to overloaded, other 5xx to server", () => {
    expect(toLlmError(apiError(529, "overloaded_error", "Overloaded")).kind).toBe("overloaded");
    expect(toLlmError(apiError(500, "api_error", "Internal server error")).kind).toBe("server");
    expect(toLlmError(apiError(503, "api_error", "Unavailable")).kind).toBe("server");
    // In-stream `event: error` has no HTTP status, only the error type.
    const inStream = new APIError(
      undefined,
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      undefined,
      undefined,
      "overloaded_error",
    );
    expect(toLlmError(inStream).kind).toBe("overloaded");
  });

  it("maps connection problems, timeouts and aborts", () => {
    expect(toLlmError(new APIConnectionError({ message: "Connection error." })).kind).toBe("network");
    expect(toLlmError(new APIConnectionTimeoutError()).kind).toBe("timeout");
    const aborted = toLlmError(new APIUserAbortError());
    expect(aborted.kind).toBe("network");
    expect(aborted.message).toBe("aborted");
    const dom = new Error("The operation was aborted");
    dom.name = "AbortError";
    expect(toLlmError(dom).message).toBe("aborted");
  });

  it("maps other 4xx to bad-request and anything else to unknown", () => {
    expect(toLlmError(apiError(404, "not_found_error", "model not found")).kind).toBe("bad-request");
    expect(toLlmError(new Error("boom")).kind).toBe("unknown");
    expect(toLlmError("string").kind).toBe("unknown");
  });

  it("never leaks a key through the message", () => {
    const leaked = apiError(401, "authentication_error", "bad key sk-ant-api03-ABCDEF123456-xyz given");
    expect(toLlmError(leaked).message).not.toContain("ABCDEF");
    expect(redactSecrets("sk-ant-api03-ABCDEF123456")).toBe("sk-ant-…");
  });
});

describe("parseRetryAfterMs", () => {
  it("reads seconds, milliseconds and HTTP dates", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "2.5" }))).toBe(2500);
    expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "750" }))).toBe(750);
    const now = Date.UTC(2026, 9, 2, 12, 0, 0);
    const date = new Date(now + 30_000).toUTCString();
    expect(parseRetryAfterMs(new Headers({ "retry-after": date }), now)).toBe(30_000);
    expect(parseRetryAfterMs(new Headers({ "retry-after": "soon" }))).toBeUndefined();
    expect(parseRetryAfterMs(new Headers())).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });
});
