/**
 * Service worker registration and install prompt (docs/PIANO.md §1.6).
 * The update found by Workbox is never applied on its own: `registerType: 'prompt'` hands us
 * an `updateSW` function and the app applies it only at rest, because a reload mid-session
 * cuts voice and listening and, on iPhone, loses the voice unlock and the microphone permission.
 * Nothing here throws at import time or in environments without the APIs (tests, old browsers).
 */

import { registerSW } from "virtual:pwa-register";

const HOUR_MS = 60 * 60 * 1000;

export interface PwaOptions {
  /** True when the app is at rest and a reload would not interrupt anything. */
  canApplyNow: () => boolean;
  /** Called once an update is waiting; `apply` reloads only when `canApplyNow()` allows it. */
  onUpdateReady: (apply: () => boolean) => void;
  onOfflineReady?: () => void;
}

export interface PwaHandle {
  /** Asks the registration to look for a new service worker now (in addition to the hourly check). */
  checkForUpdates(): void;
  /** True while an update is waiting to be applied. */
  hasPendingUpdate(): boolean;
  /** Applies the pending update when there is one and the app is at rest; returns whether it did. */
  applyPendingUpdate(): boolean;
}

function hasServiceWorker(): boolean {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  return nav !== undefined && "serviceWorker" in nav;
}

export function setupPwa(options: PwaOptions): PwaHandle {
  let updateSW: ((reload?: boolean) => Promise<void>) | null = null;
  let registration: ServiceWorkerRegistration | null = null;
  let updatePending = false;
  let applied = false;

  const apply = (): boolean => {
    if (!updatePending || applied || !options.canApplyNow()) return false;
    applied = true;
    updatePending = false;
    void updateSW?.(true).catch(() => {
      // The reload did not happen; the next hourly check will offer the update again.
      applied = false;
    });
    return true;
  };

  if (hasServiceWorker()) {
    try {
      updateSW = registerSW({
        immediate: true,
        onNeedRefresh() {
          updatePending = true;
          applied = false;
          options.onUpdateReady(apply);
        },
        onOfflineReady() {
          options.onOfflineReady?.();
        },
        onRegisteredSW(_url, r) {
          if (!r) return;
          registration = r;
          globalThis.setInterval(() => {
            void r.update().catch(() => undefined);
          }, HOUR_MS);
        },
      });
    } catch {
      updateSW = null;
    }
  }

  return {
    checkForUpdates() {
      void registration?.update().catch(() => undefined);
    },
    hasPendingUpdate: () => updatePending,
    applyPendingUpdate: apply,
  };
}

/** The non-standard Chromium event, not in lib.dom. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallOutcome = "accepted" | "dismissed" | "unavailable";

export interface InstallPrompt {
  available(): boolean;
  prompt(): Promise<InstallOutcome>;
  subscribe(fn: (available: boolean) => void): () => void;
}

function isInstallPromptEvent(event: Event): event is BeforeInstallPromptEvent {
  return typeof (event as Partial<BeforeInstallPromptEvent>).prompt === "function";
}

/**
 * Captures `beforeinstallprompt` (Android Chrome) so the app can show its own "Installa" word.
 * On platforms without the event (iOS, desktop Safari) it is simply never available.
 */
export function createInstallPrompt(win: Window | undefined = globalThis.window): InstallPrompt {
  let deferred: BeforeInstallPromptEvent | null = null;
  const listeners = new Set<(available: boolean) => void>();
  const notify = (): void => {
    for (const listener of listeners) listener(deferred !== null);
  };

  win?.addEventListener("beforeinstallprompt", (event) => {
    if (!isInstallPromptEvent(event)) return;
    event.preventDefault();
    deferred = event;
    notify();
  });
  win?.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });

  return {
    available: () => deferred !== null,
    async prompt() {
      const event = deferred;
      if (!event) return "unavailable";
      deferred = null;
      notify();
      try {
        await event.prompt();
        const choice = await event.userChoice;
        return choice.outcome;
      } catch {
        return "unavailable";
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
