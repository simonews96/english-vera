// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

interface RegisterOptions {
  immediate?: boolean;
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
  onRegisteredSW?: (url: string, registration: ServiceWorkerRegistration | undefined) => void;
}

const registerCalls: RegisterOptions[] = [];
const updateSW = vi.fn(() => Promise.resolve());

vi.mock("virtual:pwa-register", () => ({
  registerSW: (options: RegisterOptions) => {
    registerCalls.push(options);
    return updateSW;
  },
}));

const { createInstallPrompt, setupPwa } = await import("../../src/app/pwa");

afterEach(() => {
  registerCalls.length = 0;
  updateSW.mockClear();
  vi.useRealTimers();
});

describe("createInstallPrompt", () => {
  it("is unavailable by default and resolves 'unavailable' when prompted", async () => {
    const install = createInstallPrompt();
    expect(install.available()).toBe(false);
    await expect(install.prompt()).resolves.toBe("unavailable");
  });

  it("works without a window", async () => {
    const install = createInstallPrompt(undefined);
    expect(install.available()).toBe(false);
    await expect(install.prompt()).resolves.toBe("unavailable");
  });

  it("captures beforeinstallprompt, notifies subscribers and relays the user's choice", async () => {
    const install = createInstallPrompt();
    const seen: boolean[] = [];
    install.subscribe((available) => seen.push(available));
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: () => Promise.resolve(),
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(install.available()).toBe(true);
    expect(seen).toEqual([true]);
    await expect(install.prompt()).resolves.toBe("accepted");
    expect(install.available()).toBe(false);
    expect(seen).toEqual([true, false]);
  });
});

describe("setupPwa", () => {
  function withServiceWorker<T>(run: () => T): T {
    const original = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {} });
    try {
      return run();
    } finally {
      if (original) Object.defineProperty(navigator, "serviceWorker", original);
      else Reflect.deleteProperty(navigator, "serviceWorker");
    }
  }

  it("does not register when service workers are absent and never throws", () => {
    const handle = setupPwa({ canApplyNow: () => true, onUpdateReady: () => {} });
    expect(registerCalls).toHaveLength(0);
    expect(() => handle.checkForUpdates()).not.toThrow();
    expect(handle.applyPendingUpdate()).toBe(false);
  });

  it("applies the update only when the app is at rest", async () => {
    let atRest = false;
    let apply: (() => boolean) | null = null;
    withServiceWorker(() => {
      setupPwa({
        canApplyNow: () => atRest,
        onUpdateReady: (fn) => {
          apply = fn;
        },
      });
    });
    const options = registerCalls[0];
    expect(options?.immediate).toBe(true);
    options?.onNeedRefresh?.();
    expect(apply).not.toBeNull();
    const applyNow = apply as unknown as () => boolean;
    expect(applyNow()).toBe(false);
    expect(updateSW).not.toHaveBeenCalled();
    atRest = true;
    expect(applyNow()).toBe(true);
    expect(updateSW).toHaveBeenCalledWith(true);
    expect(applyNow()).toBe(false);
  });

  it("schedules an hourly update check and exposes a manual one", () => {
    vi.useFakeTimers();
    const update = vi.fn(() => Promise.resolve());
    withServiceWorker(() => {
      const handle = setupPwa({ canApplyNow: () => true, onUpdateReady: () => {} });
      registerCalls[0]?.onRegisteredSW?.("/sw.js", { update } as unknown as ServiceWorkerRegistration);
      handle.checkForUpdates();
      expect(update).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(update).toHaveBeenCalledTimes(2);
    });
  });
});
