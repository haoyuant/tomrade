import fs from "node:fs";
import { describe, expect, it } from "vitest";

// Supabase records a migration by its number alone: two files with one number collide on push.
describe("supabase migrations", () => {
  it("each has a number of its own", () => {
    const names = fs.readdirSync(new URL("../../../supabase/migrations/", import.meta.url)).filter((n) => n.endsWith(".sql"));
    const versions = names.map((n) => n.split("_")[0]);
    const repeated = versions.filter((v, i) => versions.indexOf(v) !== i);
    expect(repeated, `repeated: ${names.filter((n) => repeated.includes(n.split("_")[0])).join(", ")}`).toEqual([]);
  });
});
