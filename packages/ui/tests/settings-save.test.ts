import { MutationObserver } from "@tanstack/react-query";
import type { AppSettings } from "@tomradex/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keys } from "../src/lib/queries/keys";
import { saveSettingsOptions } from "../src/lib/queries/settings";
import { createQueryClient } from "../src/lib/queryClient";
import { reportError } from "../src/lib/toast";

vi.mock("../src/lib/toast", () => ({ reportError: vi.fn() }));

const saved = { language: "en" } as unknown as AppSettings;
const next = { language: "zh" } as unknown as AppSettings;

describe("saving settings", () => {
  afterEach(() => {
    vi.mocked(reportError).mockClear();
    delete (globalThis as { window?: unknown }).window;
  });

  const failing = () => {
    (globalThis as { window?: unknown }).window = { tomrade: { invoke: async () => { throw new Error("Error invoking remote method 'settings.set': Error: EACCES: settings.json") } } };
    const qc = createQueryClient({});
    qc.setQueryData(keys.settings, saved);
    return qc;
  };

  it("says so when the save fails, and goes back to what is saved", async () => {
    const qc = failing();
    await new MutationObserver(qc, saveSettingsOptions(qc)).mutate(next).catch(() => undefined);
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("EACCES: settings.json") }));
    expect(qc.getQueryState(keys.settings)?.isInvalidated).toBe(true);
    expect(qc.getQueryData(keys.settings)).toBe(saved);
  });

  it("leaves the telling to a caller that shows the failure itself", async () => {
    const qc = failing();
    await new MutationObserver(qc, saveSettingsOptions(qc, false)).mutate(next).catch(() => undefined);
    expect(reportError).not.toHaveBeenCalled();
    expect(qc.getQueryState(keys.settings)?.isInvalidated).toBe(true);
  });
});
