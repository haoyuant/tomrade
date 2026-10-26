import { safeStorage } from "electron";

/** The OS keychain behind Electron's safeStorage. Never plaintext: Linux's basic_text backend counts as unavailable. */
export const safeCipher = {
  available: () => safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
  encrypt: (value: string) => safeStorage.encryptString(value),
  decrypt: (value: Buffer) => safeStorage.decryptString(value)
};

/** How long the keyring may take before the start says it is waiting on it. */
const KEYRING_WAIT_MS = 1000;

/**
 * Linux opens the keyring on first use, and one that is locked or not made yet
 * asks the person through a system dialog. Met first through the blocking API,
 * that dialog holds the whole main process, splash and all. Opened here through
 * the asynchronous one, the start can say what it waits for, and the blocking
 * calls after it find the keyring open.
 */
export async function openKeyring(waiting: () => void, waitMs = KEYRING_WAIT_MS): Promise<void> {
  if (process.platform !== "linux") return;
  const timer = setTimeout(waiting, waitMs);
  try {
    await safeStorage.isAsyncEncryptionAvailable();
  } catch {
    // The blocking calls meet the same keyring and answer for it.
  } finally {
    clearTimeout(timer);
  }
}
