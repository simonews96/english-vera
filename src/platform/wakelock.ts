/**
 * Screen wake lock (docs/PIANO.md §1.6): requested inside the tap that starts a session and
 * reacquired on `visibilitychange` whenever the lock is still wanted. The API is missing on
 * older browsers and on iOS home-screen apps before 18.4, and the request is refused when the
 * page is hidden or the battery saver is on: every failure resolves to a word, never a throw.
 */

export type WakeLockOutcome = "ok" | "unavailable" | "denied";

export interface WakeLock {
  /** Marks the lock as wanted and tries to acquire it. */
  request(): Promise<WakeLockOutcome>;
  /** Marks the lock as not wanted and releases it when held. */
  release(): Promise<void>;
  active(): boolean;
}

interface WakeLockApi {
  request(type: "screen"): Promise<WakeLockSentinel>;
}

function apiOf(nav: Navigator | undefined): WakeLockApi | null {
  if (!nav || !("wakeLock" in nav)) return null;
  const api = (nav as Navigator & { wakeLock?: Partial<WakeLockApi> }).wakeLock;
  return api && typeof api.request === "function" ? (api as WakeLockApi) : null;
}

function outcomeOfError(error: unknown): WakeLockOutcome {
  const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable";
}

export function createWakeLock(
  doc: Document | undefined = globalThis.document,
  nav: Navigator | undefined = globalThis.navigator,
): WakeLock {
  let wanted = false;
  let sentinel: WakeLockSentinel | null = null;
  let pending: Promise<WakeLockOutcome> | null = null;

  const active = (): boolean => sentinel !== null && !sentinel.released;

  const acquire = async (): Promise<WakeLockOutcome> => {
    const api = apiOf(nav);
    if (!api) return "unavailable";
    if (active()) return "ok";
    try {
      const next = await api.request("screen");
      if (!wanted) {
        // release() was called while the request was in flight.
        await next.release().catch(() => undefined);
        return "ok";
      }
      sentinel = next;
      next.addEventListener("release", () => {
        if (sentinel === next) sentinel = null;
      });
      return "ok";
    } catch (error) {
      return outcomeOfError(error);
    }
  };

  const request = (): Promise<WakeLockOutcome> => {
    wanted = true;
    if (pending) return pending;
    pending = acquire().finally(() => {
      pending = null;
    });
    return pending;
  };

  doc?.addEventListener("visibilitychange", () => {
    if (wanted && doc.visibilityState === "visible" && !active()) void request();
  });

  return {
    request,
    async release() {
      wanted = false;
      const held = sentinel;
      sentinel = null;
      if (held && !held.released) await held.release().catch(() => undefined);
    },
    active,
  };
}
