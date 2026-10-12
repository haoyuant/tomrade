import { safeStorage } from "electron";

/** The OS keychain behind Electron's safeStorage. Never plaintext: Linux's basic_text backend counts as unavailable. */
export const safeCipher = {
  available: () => safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
  encrypt: (value: string) => safeStorage.encryptString(value),
  decrypt: (value: Buffer) => safeStorage.decryptString(value)
};
