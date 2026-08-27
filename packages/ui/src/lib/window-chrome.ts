/**
 * `titleBarStyle: "hiddenInset"` buys us the whole window for our own header,
 * and charges for it: macOS draws the traffic lights on top of that header's
 * left edge. So the header keeps a gutter for them — but only while the window
 * is windowed. In full screen the buttons retreat into the auto-hiding menu
 * bar, and a gutter that stayed behind would read as a dent in the breadcrumb.
 *
 * CSS cannot ask about any of that, so the shell pushes the answer and this
 * parks it on <html> for `--traffic-inset` to read. No listener (a browser tab,
 * the regression harness' framed window) means no gutter, which is right.
 */
export function watchWindowChrome(): void {
  window.tomrade?.onWindowChrome?.(({ trafficLights }) => {
    document.documentElement.dataset.trafficLights = trafficLights ? "on" : "off";
  });
}
