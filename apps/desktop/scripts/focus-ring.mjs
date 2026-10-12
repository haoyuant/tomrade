/**
 * True when a focused search field shows one ring — the field's own — and
 * none on the input inside it (the global :focus-visible would draw a second).
 * A hidden harness window never holds focus, so this turns on CDP focus
 * emulation for the moment it looks.
 */
export async function oneFocusRing(win, input, field) {
  const cdp = win.webContents.debugger;
  cdp.attach();
  try {
    await cdp.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    return await win.webContents.executeJavaScript(
      `(() => {
        const i = document.querySelector(${JSON.stringify(input)});
        if (!i) return false;
        i.blur();
        i.focus();
        return i.matches(':focus-visible') && getComputedStyle(i).boxShadow === 'none' && !!i.closest(${JSON.stringify(field)})?.matches(':focus-within');
      })()`,
      true,
    );
  } finally {
    await cdp.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
    cdp.detach();
  }
}
