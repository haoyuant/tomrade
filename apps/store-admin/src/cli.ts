#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { attest, generateSigningKey } from "@tomradex/plugin-kit";
import { satisfies } from "@tomradex/plugin-sdk";

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
  reports                         open reports
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
