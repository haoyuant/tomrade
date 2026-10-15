#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { attest, generateSigningKey } from "@tomradex/plugin-kit";
import { satisfies } from "@tomradex/plugin-sdk";
import { mcpClient } from "./mcp.js";

const [command = "help", ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const positional = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"));

/** Runs with the service role, so it bypasses RLS: keep the key off shared machines. */
function serviceClient(url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY): SupabaseClient {
  if (!url || !key) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const signingKey = () => {
  const key = process.env.STORE_SIGNING_KEY ?? (process.env.STORE_SIGNING_KEY_FILE ? fs.readFileSync(process.env.STORE_SIGNING_KEY_FILE, "utf8") : undefined);
  if (!key) throw new Error("Set STORE_SIGNING_KEY (PKCS#8 PEM) or STORE_SIGNING_KEY_FILE");
  return key;
};

const ref = (text: string | undefined) => {
  const m = /^([a-z0-9-]+\/[a-z0-9-]+)@(.+)$/.exec(text ?? "");
  if (!m) throw new Error("name a version as publisher/name@1.2.3");
  return { id: m[1]!, version: m[2]! };
};

const usage = `tomrade-store <command>

  keygen [--out dir]              make the store's signing key; put the public key in apps/desktop/src/trust.ts
  reports                         open plugin reports
  diag [--all]                    troubleshooting reports people sent, grouped by fingerprint (new ones; --all for every status)
  diag R-XXXXXX                   one troubleshooting report, as its sender read it
  diag reply R-XXXXXX "text" [--status s] [--in 0.7.0]   answer it; the sender sees it in the app (--ticket TOM-N: every report on that ticket)
  diag status R-XXXXXX fixed [--in 0.7.0]                new, triaged, fixed, wontfix or duplicate (--ticket TOM-N too)
  diag import --project <id> [--mcp url]                 new reports become TOM tickets through a running Tomrade, one per fingerprint
  maintainer [add|remove <email>]  who triages reports from Tomrade's own inbox (the Tomrade feedback source)
  show publisher/name@version     a listed version as the store holds it
  official publisher/name@version sign one of Tomrade's own plugins as official (STORE_SIGNING_KEY)
  revoke publisher/name [--versions range] --reason text   switch it off on every machine
`;

async function main(): Promise<number> {
  switch (command) {
    case "keygen": {
      const key = generateSigningKey();
      const out = flag("out") ?? ".";
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, "store-signing-key.pem"), key.privateKey, { mode: 0o600 });
      fs.writeFileSync(path.join(out, "store-signing-key.pub.pem"), key.publicKey);
      console.log(`keyId ${key.keyId}\nprivate key: ${path.join(out, "store-signing-key.pem")} (keep it off shared machines)\npublic key:\n${key.publicKey}`);
      return 0;
    }
    case "reports": {
      const { data } = await serviceClient().from("tomrade_plugin_reports").select("plugin_id, version, reason, details, created_at").eq("status", "open").order("created_at");
      for (const r of data ?? []) console.log(`${r.plugin_id}${r.version ? `@${r.version}` : ""} · ${r.reason} · ${r.created_at} · ${String(r.details).slice(0, 160)}`);
      return 0;
    }
    case "diag": {
      const client = serviceClient();
      const TABLE = "tomrade_diagnostic_reports";
      const [sub, ...args] = positional;
      if (sub && /^R-[0-9A-Z]{6}$/.test(sub)) {
        const { data } = await client.from(TABLE).select("code, created_at, status, engine, app_version, platform, fingerprint, ticket, reply, fixed_in, report").eq("code", sub).maybeSingle();
        if (!data) throw new Error(`no report ${sub}`);
        console.log(`${data.code} · ${data.status} · ${data.engine ?? "no engine"} · ${data.app_version} · ${data.platform} · ${data.created_at}\nfingerprint ${data.fingerprint}${data.ticket ? ` · ${data.ticket}` : ""}${data.fixed_in ? ` · fixed in ${data.fixed_in}` : ""}${data.reply ? `\nreply: ${data.reply}` : ""}\n`);
        for (const section of (data.report as { sections?: { title: string; text: string }[] }).sections ?? []) console.log(`── ${section.title} ──\n${section.text}\n`);
        return 0;
      }
      // One report by code, or every report on a ticket: the same failure seen by many people gets one answer.
      const update = (code: string | undefined, patch: Record<string, unknown>) => {
        const ticket = flag("ticket");
        if (ticket) return client.from(TABLE).update(patch).eq("ticket", ticket);
        if (!code || !/^R-[0-9A-Z]{6}$/.test(code)) throw new Error("name a report (R-XXXXXX) or --ticket TOM-N");
        return client.from(TABLE).update(patch).eq("code", code);
      };
      const status = flag("status");
      if (status && !["new", "triaged", "fixed", "wontfix", "duplicate"].includes(status)) throw new Error("status is one of new, triaged, fixed, wontfix, duplicate");
      if (sub === "reply") {
        const text = flag("ticket") ? args[0] : args[1];
        if (!text) throw new Error('diag reply R-XXXXXX "text" | diag reply --ticket TOM-N "text" [--status fixed] [--in 0.7.0]');
        const { error } = await update(args[0], { reply: text, replied_at: new Date().toISOString(), ...(status ? { status } : {}), ...(flag("in") ? { fixed_in: flag("in") } : {}) });
        if (error) throw new Error(error.message);
        console.log("replied; the sender sees it in Settings → About → My reports");
        return 0;
      }
      if (sub === "status") {
        const value = flag("ticket") ? args[0] : args[1];
        if (!value || !["new", "triaged", "fixed", "wontfix", "duplicate"].includes(value)) throw new Error("diag status R-XXXXXX fixed [--in 0.7.0] | diag status --ticket TOM-N fixed");
        const { error } = await update(args[0], { status: value, ...(flag("in") ? { fixed_in: flag("in") } : {}) });
        if (error) throw new Error(error.message);
        console.log(`status ${value}${flag("in") ? `, fixed in ${flag("in")}` : ""}`);
        return 0;
      }
      if (sub === "import") {
        const projectId = flag("project");
        if (!projectId) throw new Error("diag import --project <Tomrade project id> [--mcp http://127.0.0.1:19090/mcp]");
        const mcp = await mcpClient(flag("mcp") ?? "http://127.0.0.1:19090/mcp");
        const { data: fresh, error } = await client.from(TABLE).select("code, fingerprint, summary, engine, app_version, platform, created_at").eq("status", "new").is("ticket", null).order("created_at");
        if (error) throw new Error(error.message);
        const { data: filed } = await client.from(TABLE).select("fingerprint, ticket").not("ticket", "is", null);
        const ticketOf = new Map((filed ?? []).map((r) => [r.fingerprint as string, r.ticket as string]));
        const groups = new Map<string, NonNullable<typeof fresh>>();
        for (const r of fresh ?? []) groups.set(r.fingerprint, [...(groups.get(r.fingerprint) ?? []), r]);
        const items = (await mcp.call("list_items", { projectId })) as { id: string; key: string; version: number; body: string | null }[];
        const line = (r: NonNullable<typeof fresh>[number]) => `- ${String(r.created_at).slice(0, 10)} ${r.code} · v${r.app_version} · ${r.platform} · ${r.engine ?? "-"}: ${r.summary}`;
        for (const [fingerprint, rows] of groups) {
          let key = ticketOf.get(fingerprint);
          const item = key ? items.find((i) => i.key === key) : undefined;
          if (item) {
            await mcp.call("update_item", { projectId, id: item.id, baseVersion: item.version, patch: { body: `${(item.body ?? "").trimEnd()}\n\n## 新报告\n\n${rows.map(line).join("\n")}\n` } });
          } else {
            const created = await mcp.call("create_item", {
              projectId, kind: "ticket", status: "backlog", labels: ["报告"],
              title: `[报告] ${rows[0]!.summary || fingerprint}`.slice(0, 120),
              body: `## 来源\n\n用户通过「排查问题」发来的报告，指纹 \`${fingerprint}\`。\n\n${rows.map(line).join("\n")}\n\n## 看报告\n\n\`tomrade-store diag ${rows[0]!.code}\`\n\n回复所有报告：\`tomrade-store diag reply --ticket <本工单号> "…"\`\n\n## 修复记录\n`
            });
            key = (created as { key: string }).key;
          }
          const update = await client.from(TABLE).update({ ticket: key, status: "triaged" }).in("code", rows.map((r) => r.code));
          if (update.error) throw new Error(update.error.message);
          console.log(`${key} ← ${rows.length} report(s) · ${fingerprint}`);
        }
        if (!groups.size) console.log("no new reports");
        return 0;
      }
      let query = client.from(TABLE).select("code, fingerprint, summary, engine, app_version, created_at, status, ticket").order("created_at", { ascending: false }).limit(500);
      if (!rest.includes("--all")) query = query.eq("status", "new");
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const groups = new Map<string, NonNullable<typeof data>>();
      for (const r of data ?? []) groups.set(r.fingerprint, [...(groups.get(r.fingerprint) ?? []), r]);
      for (const [fingerprint, rows] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
        const latest = rows[0]!;
        console.log(`${rows.length}× ${fingerprint}${latest.ticket ? ` · ${latest.ticket}` : ""} · ${latest.engine ?? "-"} · ${latest.summary}\n   ${rows.map((r) => `${r.code} (${r.app_version}, ${String(r.created_at).slice(0, 10)}${rest.includes("--all") ? `, ${r.status}` : ""})`).join(", ")}`);
      }
      return 0;
    }
    case "maintainer": {
      const client = serviceClient();
      const [sub, email] = positional;
      // Few accounts: page through them rather than keep an email index of our own.
      const userByEmail = async (wanted: string) => {
        for (let page = 1; ; page++) {
          const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
          if (error) throw new Error(error.message);
          const hit = data.users.find((u) => u.email?.toLowerCase() === wanted.toLowerCase());
          if (hit || data.users.length < 1000) return hit ?? null;
        }
      };
      if (sub === "add" || sub === "remove") {
        if (!email) throw new Error(`maintainer ${sub} <email>`);
        const user = await userByEmail(email);
        if (!user) throw new Error(`no account ${email}`);
        const { error } = sub === "add"
          ? await client.from("tomrade_maintainers").upsert({ user_id: user.id })
          : await client.from("tomrade_maintainers").delete().eq("user_id", user.id);
        if (error) throw new Error(error.message);
        console.log(sub === "add" ? `${email} now receives Tomrade feedback in the app's inbox` : `${email} no longer does`);
        return 0;
      }
      const { data, error } = await client.from("tomrade_maintainers").select("user_id, created_at").order("created_at");
      if (error) throw new Error(error.message);
      for (const row of data ?? []) {
        const { data: found } = await client.auth.admin.getUserById(row.user_id as string);
        console.log(`${found?.user?.email ?? row.user_id} · since ${String(row.created_at).slice(0, 10)}`);
      }
      return 0;
    }
    case "show": {
      const { id, version } = ref(positional[0]);
      const { data } = await serviceClient().from("tomrade_plugin_versions").select("*").eq("plugin_id", id).eq("version", version).single();
      console.log(JSON.stringify(data, null, 2));
      return data ? 0 : 1;
    }
    case "official": {
      const { id, version } = ref(positional[0]);
      const client = serviceClient();
      const { data: row, error } = await client.from("tomrade_plugin_versions").select("status, digest, risk").eq("plugin_id", id).eq("version", version).single();
      if (error || !row) throw new Error(`${id}@${version} is not in the store`);
      if (row.status !== "listed" || !row.digest) throw new Error(`${id}@${version} is not listed`);
      const attestation = attest({ v: 1, id, version, digest: row.digest, tier: "official", risk: row.risk, issuedAt: Date.now() }, signingKey());
      const update = await client.from("tomrade_plugin_versions").update({ tier: "official", attestation }).eq("plugin_id", id).eq("version", version);
      if (update.error) throw new Error(update.error.message);
      console.log(`${id}@${version} is official`);
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
      await client.from("tomrade_plugin_reports").update({ status: "actioned" }).eq("plugin_id", id).eq("status", "open");
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
