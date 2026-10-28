import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { HandoffLine } from "../src/components/workspace/agent-panel/HandoffLine";
import type { HandoffRefusal } from "@tomradex/code-link";

vi.mock("~/components/icons", () => ({ Icon: () => null }));
vi.mock("~/lib/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const render = (running: boolean, transferring = false, reason?: HandoffRefusal) => renderToStaticMarkup(createElement(HandoffLine, {
  view: { where: "here", toTerminal: reason ? { ok: false, reason } : { ok: true }, terminal: null },
  agent: "Pi", running, transferring, busy: transferring,
  onToTerminal() {}, onShow() {}, onBack() {}
}));

it("offers a one-click transfer during a turn and names both busy phases", () => {
  expect(render(true)).toContain("handoff.stopAndTransfer");
  expect(render(true)).not.toContain('disabled=""');
  expect(render(true, true)).toContain("handoff.stopping");
  expect(render(false, true)).toContain("handoff.opening");
  expect(render(true, true)).toContain('disabled=""');
  expect(render(false)).toContain("handoff.toTerminal");
});

it("keeps other refusal reasons even during a turn", () => {
  for (const reason of ["waiting", "archived", "noMcp", "noSession"] as const) {
    expect(render(true, false, reason)).toContain('disabled=""');
  }
  expect(render(true, false, "builtin")).toBe("");
});
