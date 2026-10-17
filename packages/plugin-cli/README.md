# @tomradex/plugin-cli

`tomrade-plugin` builds, tests and packs a Tomrade plugin.

```sh
tomrade-plugin init my-plugin --id you/my-plugin   # a plugin that builds, tests and loads as it is
tomrade-plugin dev                                  # rebuild on every change; in Tomrade: Settings → Plugins → Load folder
tomrade-plugin test                                 # src/test.ts against a throwaway project, in a sandbox
tomrade-plugin check                                # what someone installing it will see
tomrade-plugin pack                                 # a .tomrade-plugin file anyone can install
```

`build` bundles `src/index.ts` into one readable file, `dist/index.js`, leaving `@tomradex/plugin-sdk` and `zod` to Tomrade. `test` and `check` run the plugin in a child process under Node's permission model: it reads only the plugin's folder and the CLI's own runtime, writes only a temporary directory, and cannot start programs.

Apache-2.0, like `@tomradex/plugin-host` installed alongside it and the rest of Tomrade. What you build with the CLI is yours, under any license you choose.
