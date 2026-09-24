import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scaffold } from "@tomrade/plugin-cli";
import { generateSigningKey, unpackPlugin, verifyAttestation } from "@tomrade/plugin-kit";
import { processSubmission, type Judge, type JudgeResult, type Outcome, type PreviousVersion, type Registry, type Submission, type Verdict } from "@tomrade/review";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-review-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const key = generateSigningKey();

const clean: Verdict = { summary: "Counts open issues.", malicious: { verdict: "none", confidence: "high", evidence: [] }, matchesDescription: true, concerns: [], promptInjection: [], diff: null };
const judgeWith = (verdict: Partial<Verdict> | null, extra: Partial<JudgeResult> = {}): Judge & { seen: Parameters<Judge>[0][] } => {
  const seen: Parameters<Judge>[0][] = [];
  const fn = (async (input) => {
    seen.push(input);
    return { verdict: verdict ? { ...clean, ...verdict } : null, model: "test-model", refused: null, tooLarge: false, ...extra };
  }) as Judge & { seen: Parameters<Judge>[0][] };
  fn.seen = seen;
  return fn;
};

/** A plugin source tree per commit, as GitHub would hand it over. */
const commits = new Map<string, string>();
function commitOf(name: string, edit?: (dir: string) => void, version = "1.0.0") {
  const dir = path.join(tmp, "src", `${name}-${commits.size}`);
  scaffold(dir, { id: `alice/${name}`, description: "Counts open issues." });
  const manifestFile = path.join(dir, "tomrade-plugin.json");
  const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...m, version, repository: `https://github.com/alice/${name}` }, null, 2));
  edit?.(dir);
  const sha = (commits.size + 1).toString(16).padStart(40, "a");
  commits.set(sha, dir);
  return { sha, submission: { id: `sub-${commits.size}`, plugin_id: `alice/${name}`, version, repository: `https://github.com/alice/${name}`, commit_sha: sha, tag: `v${version}` } satisfies Submission };
}

function registry(previous: PreviousVersion | null = null) {
  const uploads = new Map<string, Buffer>();
  const finished: Outcome[] = [];
  const failures: string[] = [];
  const reg: Registry = {
    previousListed: async () => previous,
    progress: async () => {},
    upload: async (p, bytes) => void uploads.set(p, bytes),
    finish: async (_s, o) => void finished.push(o),
    fail: async (_s, e) => void failures.push(e)
  };
  return { reg, uploads, finished, failures };
}

const fetchSource = async (_repo: string, commit: string, dest: string) => fs.cpSync(commits.get(commit)!, dest, { recursive: true, filter: (src) => !src.includes(`${path.sep}dist`) });

const deps = (reg: Registry, judge: Judge) => ({ registry: reg, fetchSource, judge, signingKey: key.privateKey, workDir: path.join(tmp, "work") });

describe("the review pipeline", () => {
  it("lists a clean plugin as AI-reviewed, signing and uploading exactly what it built", async () => {
    const { submission } = commitOf("counter");
    const { reg, uploads, finished } = registry();
    const judge = judgeWith({});
    const outcome = await processSubmission(submission, deps(reg, judge));
    expect(outcome).toMatchObject({ status: "listed", tier: "ai-reviewed", risk: "low", reviewedAs: null });
    expect(finished).toHaveLength(1);
    expect(Object.keys(judge.seen[0]!.files)).toEqual(expect.arrayContaining(["src/index.ts", "src/test.ts", "tomrade-plugin.json", "README.md"]));
    const [objectPath, bytes] = [...uploads][0]!;
    expect(objectPath).toBe(`alice/counter/1.0.0/${outcome!.digest}.tomrade-plugin`);
    const file = path.join(tmp, "downloaded.tomrade-plugin");
    fs.writeFileSync(file, bytes);
    const unpacked = await unpackPlugin(file);
    expect(unpacked.digest).toBe(outcome!.digest);
    expect(verifyAttestation(unpacked.attestation, unpacked.digest, { [key.keyId]: key.publicKey })).toMatchObject({ tier: "ai-reviewed", id: "alice/counter" });
  }, 60_000);

  it("refuses only what it judges clearly malicious, and holds what it cannot clear for a person", async () => {
    const bad = registry();
    expect(await processSubmission(commitOf("miner").submission, deps(bad.reg, judgeWith({ malicious: { verdict: "clear", confidence: "high", evidence: [{ file: "src/index.ts", line: 3, explanation: "mines" }] } })))).toMatchObject({ status: "rejected" });
    expect(bad.uploads.size).toBe(0);

    const suspicious = registry();
    const held = await processSubmission(
      commitOf("peek", (dir) => fs.appendFileSync(path.join(dir, "src/index.ts"), `\nexport const where = "~/.ssh/id_rsa";\n`)).submission,
      deps(suspicious.reg, judgeWith({}))
    );
    expect(held).toMatchObject({ status: "held", attestation: null });
    expect(held!.report.findings.map((f) => f.rule)).toContain("credential-paths");

    const refused = registry();
    expect(await processSubmission(commitOf("declined").submission, deps(refused.reg, judgeWith(null, { refused: "cyber" })))).toMatchObject({ status: "held" });
  }, 90_000);

  it("labels high risk and still lists it", async () => {
    const { submission } = commitOf("runner", (dir) => {
      fs.writeFileSync(path.join(dir, "src/index.ts"), fs.readFileSync(path.join(dir, "src/index.ts"), "utf8").replace('import { z } from "zod";', 'import { z } from "zod";\nimport { execFile } from "node:child_process";\nexport const run = () => execFile("ls");'));
      const f = path.join(dir, "tomrade-plugin.json");
      fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), permissions: { network: [], fs: "none", exec: true } }));
    });
    const { reg } = registry();
    expect(await processSubmission(submission, deps(reg, judgeWith({})))).toMatchObject({ status: "listed", risk: "high", riskReasons: expect.arrayContaining(["exec"]) });
  }, 60_000);

  it("carries a human review over a small, low-risk change that reaches no further — and only then", async () => {
    const first = commitOf("carry");
    const next = commitOf("carry", (dir) => fs.appendFileSync(path.join(dir, "README.md"), "\nTypo fixed.\n"), "1.0.1");
    const previous: PreviousVersion = { version: "1.0.0", tier: "reviewed", reviewed_as: null, commit_sha: first.sha, manifest: null };
    const small = judgeWith({ diff: { risk: "low", carryOver: true, summary: "README only" } });
    // The store keeps the manifest as the build stamped it.
    const stamped = { ...JSON.parse(fs.readFileSync(path.join(commits.get(first.sha)!, "tomrade-plugin.json"), "utf8")), inject: ["items", "tools", "contributions"], optional: [] };
    const { reg } = registry({ ...previous, manifest: stamped });
    const carried = await processSubmission(next.submission, deps(reg, small));
    expect(small.seen[0]!.diff).toMatchObject({ from: "1.0.0", fromReviewedByHuman: true });
    expect(small.seen[0]!.diff!.patch).toContain("Typo fixed.");
    expect(carried).toMatchObject({ status: "listed", tier: "reviewed", reviewedAs: "1.0.0" });

    const wider = commitOf("carry", (dir) => {
      const f = path.join(dir, "tomrade-plugin.json");
      fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), permissions: { network: ["api.example.com"], fs: "none", exec: false } }));
    }, "1.0.2");
    const again = registry({ ...previous, manifest: stamped });
    expect(await processSubmission(wider.submission, deps(again.reg, small))).toMatchObject({ status: "listed", tier: "ai-reviewed", reviewedAs: null });
  }, 90_000);

  it("rejects a commit that does not build or does not match its submission", async () => {
    const broken = registry();
    expect(await processSubmission(commitOf("broken", (dir) => fs.writeFileSync(path.join(dir, "src/index.ts"), "export default {{{")).submission, deps(broken.reg, judgeWith({})))).toMatchObject({
      status: "rejected",
      report: { summary: expect.stringMatching(/does not build/) }
    });
    const other = commitOf("other");
    const mismatch = registry();
    expect(await processSubmission({ ...other.submission, version: "9.9.9" }, deps(mismatch.reg, judgeWith({})))).toMatchObject({ status: "rejected", report: { summary: expect.stringMatching(/not alice\/other 9.9.9/) } });
  }, 60_000);
});
