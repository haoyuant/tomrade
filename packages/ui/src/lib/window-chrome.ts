/**
 * `hiddenInset` gives the header the whole window and puts the traffic lights
 * on top of its left edge — but only while windowed. The shell says which, and
 * `--traffic-inset` reads it off <html>. No shell (a browser tab) means no gutter.
 */
export function watchWindowChrome(): void {
  window.tomrade?.on?.("window.chrome", ({ trafficLights }) => {
    document.documentElement.dataset.trafficLights = trafficLights ? "on" : "off";
  });
}
