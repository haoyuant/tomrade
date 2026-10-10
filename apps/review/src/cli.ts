#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attest, generateSigningKey, type Attestation } from "@tomradex/plugin-kit";
import { satisfies } from "@tomradex/plugin-sdk";
import { claudeJudge } from "./judge.js";
import { processSubmission } from "./pipeline.js";
import { githubSource, installDependencies, serviceClient, supabaseRegistry } from "./supabase.js";

const [command = "help", ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const positional = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"));

const signingKey = () => {
  const key = process.env.REVIEW_SIGNING_KEY ?? (process.env.REVIEW_SIGNING_KEY_FILE ? fs.readFileSync(process.env.REVIEW_SIGNING_KEY_FILE, "utf8") : undefined);
  if (!key) throw new Error("Set REVIEW_SIGNING_KEY (PKCS#8 PEM) or REVIEW_SIGNING_KEY_FILE");
  return key;
};

const ref = (text: string | undefined) => {
  const m = /^([a-z0-9-]+\/[a-z0-9-]+)@(.+)$/.exec(text ?? "");
  if (!m) throw new Error("name a version as publisher/name@1.2.3");
  return { id: m[1]!, version: m[2]! };
};

const usage = `tomrade-review <command>

  worker [--once]                 review queued submissions (REVIEW_MODEL, REVIEW_EFFORT, ANTHROPIC_API_KEY, SUPABASE_*, REVIEW_SIGNING_KEY)
  keygen [--out dir]              make the store's signing key; put the public key in apps/desktop/src/trust.ts
  queue                           held versions and open official-review requests
  show publisher/name@version     the review report
  approve publisher/name@version [--notes text]   a person at Tomrade reviewed it: list it with the reviewed badge
  reject publisher/name@version --notes text      refuse it, with the reason the publisher sees
  revoke publisher/name [--versions range] --reason text   switch it off on every machine
`;

async function worker(once: boolean) {
  const client = serviceClient();
  const registry = supabaseRegistry(client);
  const judge = claudeJudge({ model: process.env.REVIEW_MODEL, effort: (process.env.REVIEW_EFFORT as "high" | undefined) ?? "high" });
  const name = `${os.hostname()}-${process.pid}`;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-review-"));
  for (;;) {
    const sub = await registry.claim(name);
    if (!sub) {
      if (once) return;
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    console.log(`reviewing ${sub.plugin_id}@${sub.version} (${sub.commit_sha.slice(0, 12)})`);
    const outcome = await processSubmission(sub, { registry, fetchSource: githubSource, judge, signingKey: signingKey(), workDir, installDependencies });
    console.log(outcome ? `  ${outcome.status}${outcome.tier ? ` · ${outcome.tier}` : ""} · risk ${outcome.risk}` : "  failed; see the submission's error");
  }
}

async function main(): Promise<number> {
  switch (command) {
    case "worker":
      await worker(rest.includes("--once"));
      return 0;
    case "keygen": {
      const key = generateSigningKey();
      const out = flag("out") ?? ".";
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, "review-signing-key.pem"), key.privateKey, { mode: 0o600 });
      fs.writeFileSync(path.join(out, "review-signing-key.pub.pem"), key.publicKey);
      console.log(`keyId ${key.keyId}\nprivate key: ${path.join(out, "review-signing-key.pem")} (keep it only on the review worker)\npublic key:\n${key.publicKey}`);
      return 0;
    }
    case "queue": {
      const client = serviceClient();
      const held = await client.from("tomrade_plugin_versions").select("plugin_id, version, risk, report").eq("status", "held");
      const requests = await client.from("tomrade_plugin_review_requests").select("plugin_id, version, created_at").eq("status", "open");
      const reports = await client.from("tomrade_plugin_reports").select("plugin_id, version, reason, details, created_at").eq("status", "open");
      for (const v of held.data ?? []) console.log(`held      ${v.plugin_id}@${v.version} · risk ${v.risk} · ${(v.report as { summary?: string } | null)?.summary?.slice(0, 120) ?? ""}`);
      for (const r of requests.data ?? []) console.log(`requested ${r.plugin_id}@${r.version} · since ${r.created_at}`);
      for (const r of reports.data ?? []) console.log(`reported  ${r.plugin_id}${r.version ? `@${r.version}` : ""} · ${r.reason} · ${String(r.details).slice(0, 120)}`);
      return 0;
    }
    case "show": {
      const { id, version } = ref(positional[0]);
      const { data } = await serviceClient().from("tomrade_plugin_versions").select("*").eq("plugin_id", id).eq("version", version).single();
      console.log(JSON.stringify(data, null, 2));
      return data ? 0 : 1;
    }
    case "approve": {
      const { id, version } = ref(positional[0]);
      const client = serviceClient();
      const { data: row, error } = await client.from("tomrade_plugin_versions").select("*").eq("plugin_id", id).eq("version", version).single();
      if (error || !row) throw new Error(`${id}@${version} is not in the store`);
      if (!row.digest || !row.package_path) throw new Error(`${id}@${version} was never built; it cannot be approved`);
      const attestation: Attestation = attest({ v: 1, id, version, digest: row.digest, tier: "reviewed", risk: row.risk ?? "low", issuedAt: Date.now() }, signingKey());
      await client.from("tomrade_plugin_versions").update({ status: "listed", tier: "reviewed", attestation, reviewed_as: null, listed_at: row.listed_at ?? new Date().toISOString() }).eq("plugin_id", id).eq("version", version);
      await client.from("tomrade_plugin_reviews").insert({ plugin_id: id, version, reviewer: process.env.REVIEWER ?? os.userInfo().username, decision: "approved", notes: flag("notes") ?? "" });
      await client.from("tomrade_plugin_review_requests").update({ status: "done" }).eq("plugin_id", id).eq("version", version);
      await client.from("tomrade_plugins").update({ latest_version: version, updated_at: new Date().toISOString() }).eq("id", id);
      console.log(`${id}@${version} is listed as reviewed by Tomrade`);
      return 0;
    }
    case "reject": {
      const { id, version } = ref(positional[0]);
      const notes = flag("notes");
      if (!notes) throw new Error("say why with --notes; the publisher reads it");
      const client = serviceClient();
      await client.from("tomrade_plugin_versions").update({ status: "rejected", attestation: null, listed_at: null }).eq("plugin_id", id).eq("version", version);
      await client.from("tomrade_plugin_reviews").insert({ plugin_id: id, version, reviewer: process.env.REVIEWER ?? os.userInfo().username, decision: "rejected", notes });
      await client.from("tomrade_plugin_review_requests").update({ status: "done" }).eq("plugin_id", id).eq("version", version);
      console.log(`${id}@${version} is rejected`);
      return 0;
    }
    case "revoke": {
      const id = positional[0];
      const reason = flag("reason");
      if (!id || !reason) throw new Error("revoke publisher/name --reason text [--versions range]");
      const versions = flag("versions") ?? "*";
      const client = serviceClient();
      await client.from("tomrade_plugin_revocations").upsert({ plugin_id: id, versions, reason });
      const { data } = await client.from("tomrade_plugin_versions").select("version").eq("plugin_id", id).eq("status", "listed");
      for (const v of data ?? []) if (versions === "*" || satisfies(v.version, versions)) await client.from("tomrade_plugin_versions").update({ status: "revoked" }).eq("plugin_id", id).eq("version", v.version);
      console.log(`${id} ${versions} is revoked; machines switch it off at their next check`);
      return 0;
    }
    default:
      console.log(usage);
      return command === "help" ? 0 : 1;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
);
