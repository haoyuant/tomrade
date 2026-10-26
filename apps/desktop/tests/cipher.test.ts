import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keyring = vi.hoisted(() => ({ open: (): Promise<boolean> => Promise.resolve(true), asked: 0 }));
vi.mock("electron", () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: () => {
      keyring.asked++;
      return keyring.open();
    }
  }
}));

const { openKeyring } = await import("../src/cipher.js");

const platform = process.platform;
const runOn = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { value });

beforeEach(() => {
  vi.useFakeTimers();
  keyring.asked = 0;
  runOn("linux");
});
afterEach(() => {
  vi.useRealTimers();
  runOn(platform);
});

describe("openKeyring", () => {
  it("says it is waiting once the keyring takes longer than a moment, and goes on when it opens", async () => {
    let open!: (yes: boolean) => void;
    keyring.open = () => new Promise((done) => (open = done));
    const waiting = vi.fn();
    const opened = openKeyring(waiting, 1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(waiting).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(waiting).toHaveBeenCalledOnce();
    open(true);
    await expect(opened).resolves.toBeUndefined();
  });

  it("says nothing when the keyring opens at once", async () => {
    keyring.open = () => Promise.resolve(true);
    const waiting = vi.fn();
    await openKeyring(waiting, 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(waiting).not.toHaveBeenCalled();
  });

  it("lets the start go on when the keyring refuses", async () => {
    keyring.open = () => Promise.reject(new Error("dismissed"));
    const waiting = vi.fn();
    await expect(openKeyring(waiting, 1000)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(waiting).not.toHaveBeenCalled();
  });

  it("leaves other systems' keychains to their first use", async () => {
    runOn("darwin");
    await openKeyring(vi.fn(), 1000);
    expect(keyring.asked).toBe(0);
  });
});
