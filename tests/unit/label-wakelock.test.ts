// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createWakeLock } from "../../src/platform/wakelock";
import { fakeWakeLockNavigator } from "../helpers/label-fakes";

function fakeDocument(): Document & { setVisible(visible: boolean): void } {
  const target = new EventTarget();
  let state: DocumentVisibilityState = "visible";
  const doc = {
    get visibilityState() {
      return state;
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    setVisible(visible: boolean) {
      state = visible ? "visible" : "hidden";
      target.dispatchEvent(new Event("visibilitychange"));
    },
  };
  return doc as unknown as Document & { setVisible(visible: boolean): void };
}

describe("createWakeLock", () => {
  it("reports 'unavailable' when the API is missing and never throws", async () => {
    const lock = createWakeLock(fakeDocument(), {} as Navigator);
    await expect(lock.request()).resolves.toBe("unavailable");
    expect(lock.active()).toBe(false);
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("works without a document or navigator at all", async () => {
    const lock = createWakeLock(undefined, undefined);
    await expect(lock.request()).resolves.toBe("unavailable");
  });

  it("reports 'denied' on NotAllowedError and 'unavailable' on other failures", async () => {
    await expect(createWakeLock(fakeDocument(), fakeWakeLockNavigator("deny").nav).request()).resolves.toBe(
      "denied",
    );
    await expect(createWakeLock(fakeDocument(), fakeWakeLockNavigator("throw").nav).request()).resolves.toBe(
      "unavailable",
    );
  });

  it("acquires, tracks the sentinel and releases", async () => {
    const { nav, sentinels } = fakeWakeLockNavigator();
    const lock = createWakeLock(fakeDocument(), nav);
    await expect(lock.request()).resolves.toBe("ok");
    expect(lock.active()).toBe(true);
    expect(sentinels).toHaveLength(1);
    await lock.release();
    expect(lock.active()).toBe(false);
    expect(sentinels[0]?.released).toBe(true);
  });

  it("reacquires when the document becomes visible again and the lock is still wanted", async () => {
    const { nav, sentinels } = fakeWakeLockNavigator();
    const doc = fakeDocument();
    const lock = createWakeLock(doc, nav);
    await lock.request();
    sentinels[0]?.fire(); // the system released it when the page was hidden
    expect(lock.active()).toBe(false);
    doc.setVisible(false);
    doc.setVisible(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(sentinels).toHaveLength(2);
    expect(lock.active()).toBe(true);
  });

  it("does not reacquire after release()", async () => {
    const { nav, sentinels } = fakeWakeLockNavigator();
    const doc = fakeDocument();
    const lock = createWakeLock(doc, nav);
    await lock.request();
    await lock.release();
    doc.setVisible(true);
    await Promise.resolve();
    expect(sentinels).toHaveLength(1);
  });
});
