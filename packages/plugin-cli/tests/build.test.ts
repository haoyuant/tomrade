import { expect, it } from "vitest";
import { unpackedPath } from "../src/build.js";

it("points a file inside app.asar at its unpacked copy, and leaves any other path alone", () => {
  expect(unpackedPath("C:\\Program Files\\Tomrade\\resources\\app.asar\\node_modules\\@esbuild\\win32-x64\\esbuild.exe"))
    .toBe("C:\\Program Files\\Tomrade\\resources\\app.asar.unpacked\\node_modules\\@esbuild\\win32-x64\\esbuild.exe");
  expect(unpackedPath("/opt/Tomrade/resources/app.asar/node_modules/esbuild/lib/main.js")).toBe("/opt/Tomrade/resources/app.asar.unpacked/node_modules/esbuild/lib/main.js");
  for (const plain of ["/opt/Tomrade/resources/app/node_modules/esbuild/lib/main.js", "/opt/Tomrade/resources/app.asar.unpacked/x.js", "/repo/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js"]) {
    expect(unpackedPath(plain)).toBe(plain);
  }
});
