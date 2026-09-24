import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as tar from "tar";
import type { Outcome, PreviousVersion, Registry, SourceFetcher, Submission } from "./pipeline.js";

const run = promisify(execFile);

/** The worker's view of the store. Runs with the service role, so it bypasses RLS: keep the key on the worker. */
export function serviceClient(url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY): SupabaseClient {
  if (!url || !key) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const must = <T>(result: { data: T; error: { message: string } | null }, what: string): T => {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
};

export function supabaseRegistry(client: SupabaseClient): Registry & { claim(worker: string): Promise<Submission | null> } {
  return {
    async claim(worker) {
      await client.rpc("tomrade_requeue_stale_submissions");
      const rows = must(await client.rpc("tomrade_claim_submission", { p_worker: worker }), "claim") as Submission[] | null;
      return rows?.[0] ?? null;
    },
    async previousListed(pluginId, before) {
      const rows = must(
        await client.from("tomrade_plugin_versions").select("version, tier, reviewed_as, commit_sha, manifest").eq("plugin_id", pluginId).eq("status", "listed").neq("version", before).order("listed_at", { ascending: false }).limit(1),
        "previous version"
      ) as PreviousVersion[];
      return rows[0] ?? null;
    },
    async progress(sub, status) {
      must(await client.from("tomrade_plugin_versions").update({ status }).eq("plugin_id", sub.plugin_id).eq("version", sub.version), "progress");
    },
    async upload(objectPath, bytes) {
      must(await client.storage.from("plugin-packages").upload(objectPath, bytes, { contentType: "application/gzip", upsert: true }), "upload");
    },
    async finish(sub, o: Outcome) {
      must(
        await client
          .from("tomrade_plugin_versions")
          .update({
            status: o.status,
            tier: o.tier,
            risk: o.risk,
            risk_reasons: o.riskReasons,
            manifest: o.manifest,
            digest: o.digest,
            attestation: o.attestation,
            report: o.report,
            reviewed_as: o.reviewedAs,
            package_path: o.packagePath,
            package_size: o.packageSize,
            listed_at: o.status === "listed" ? new Date().toISOString() : null
          })
          .eq("plugin_id", sub.plugin_id)
          .eq("version", sub.version),
        "record the outcome"
      );
      if (o.status === "listed" && o.manifest) {
        must(
          await client.from("tomrade_plugins").update({ latest_version: sub.version, title: o.manifest.title, description: o.manifest.description, license: o.manifest.license, updated_at: new Date().toISOString() }).eq("id", sub.plugin_id),
          "update the listing"
        );
      }
      must(await client.from("tomrade_plugin_submissions").update({ status: "done", finished_at: new Date().toISOString(), error: o.status === "rejected" ? o.report.summary : null }).eq("id", sub.id), "close the submission");
    },
    async fail(sub, error) {
      await client.from("tomrade_plugin_submissions").update({ status: "failed", error, finished_at: new Date().toISOString() }).eq("id", sub.id);
      await client.from("tomrade_plugin_versions").update({ status: "queued" }).eq("plugin_id", sub.plugin_id).eq("version", sub.version).in("status", ["building", "reviewing"]);
    }
  };
}

/** The tree at one commit, from GitHub's archive of it; only files and directories are taken. */
export const githubSource: SourceFetcher = async (repository, commit, dest) => {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/.exec(repository);
  if (!m) throw new Error(`${repository} is not a GitHub repository URL`);
  const res = await fetch(`https://codeload.github.com/${m[1]}/${m[2]}/tar.gz/${commit}`, { signal: AbortSignal.timeout(60_000), headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {} });
  if (!res.ok) throw new Error(`GitHub has no archive of ${commit} in ${repository} (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > 50 * 1024 * 1024) throw new Error("the repository is larger than a plugin source may be");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-source-"));
  try {
    const file = path.join(tmp, "source.tgz");
    fs.writeFileSync(file, bytes);
    await tar.x({ file, cwd: dest, strip: 1, strict: true, filter: (_p, entry) => ("type" in entry ? entry.type === "File" || entry.type === "Directory" : true) });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

/** Production dependencies from the committed lockfile, with every install script switched off. */
export async function installDependencies(dir: string): Promise<void> {
  const env = { ...process.env, npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false" };
  if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) await run("pnpm", ["install", "--prod", "--frozen-lockfile", "--ignore-scripts"], { cwd: dir, env, timeout: 300_000 });
  else if (fs.existsSync(path.join(dir, "package-lock.json"))) await run("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: dir, env, timeout: 300_000 });
  else throw new Error("only npm and pnpm lockfiles are supported");
}
