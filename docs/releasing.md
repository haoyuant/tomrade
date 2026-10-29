# Releasing the desktop app

`pnpm --filter @tomrade/desktop package` builds the backend and the renderer, then the installers, into `apps/desktop/release/`. On macOS that's a DMG and a ZIP. Add `-- --dir` to build just the unpacked app.

To try a checkout in the real app on an Apple-silicon Mac, `pnpm install:dev` builds an unsigned arm64 app stamped with the next release plus `-dev` (`0.23.0-dev` after v0.22.0), replaces `/Applications/Tomrade.app` and starts it. On Windows (x64 or arm64) it builds the unsigned NSIS installer instead, stops the running Tomrade, installs silently over the existing install (the installer's default folder the first time) and starts it. Either way it shares the installed app's data folder.

## Official plugins carried in the app

Packaging needs github.com: after the backend is built and before electron-builder runs, `apps/desktop/scripts/bundle-official-plugins.mjs` puts the official starters into the app, so a machine that cannot reach GitHub (offline, or mainland China without a proxy) still gets them on first run or upgrade. It reads `starters` from the community row in `apps/desktop/tomrade.yml`, fetches the official catalog, and writes to `apps/desktop/official-plugins/` (gitignored):

- `<digest>.tomrade-plugin` for each starter: the version this build would install, downloaded, with its digest checked and its signature verified against the app's keys (`apps/desktop/src/trust.ts`);
- `catalog.json`: the catalog as it was fetched.

electron-builder copies the folder into the app beside `tomrade.yml` (`files` in `electron-builder.yml`), where the community row's `officialBundle` points (`${appDir}/official-plugins`).

The build stops if a starter can't be bundled. That happens when the catalog has no version of it this Tomrade can install (not released yet, revoked, needs a newer SDK, or not signed with a trusted key), when the download fails, or when the package isn't the build the catalog lists. A plugin must be released from tomrade-plugins before `tomrade.yml` names it as a starter. To check the bundle without packaging:

```sh
pnpm build:backend && pnpm --filter @tomrade/desktop bundle:official
```

In the app, the bundle changes nothing while the catalog can be reached. A version whose digest matches a bundled package installs from that package rather than downloading it, and a newer one downloads and updates as before. If the catalog can't be fetched, the app uses its cached copy or the bundled one, whichever is newer. A bundled package that doesn't verify is not used: the reason goes to the log, and that starter is tried from the network at the next check.

## CI: a tag builds every installer

Pushing a tag `v<semver>` runs `.github/workflows/release.yml`:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

Every installer builds on the self-hosted Mac (below), each in a job of its own and all at once: the Mac ones (arm64 and x64), the Windows one (NSIS, unsigned), and the Linux AppImages (x64 and arm64). The version comes from the tag. The Mac builds are signed, notarized, and checked with `codesign`, `spctl`, and `stapler`; the DMG is notarized and stapled too. A **draft** release with generated notes is made first. Each build leaves its installers, update zips, blockmaps and manifests in `~/tomrade-release/<tag>/<build>/` on the Mac, and an upload job per build sends them from there straight to the R2 bucket behind download.tomrade.com, under `<version>/` (`apps/desktop/scripts/upload-r2.mjs`), and puts only the update manifests on the draft. Nothing points at that folder until the release is published. Once every upload has passed, the release job adds the Mac manifest, merged from the two Mac builds; a draft without `latest-mac.yml` had a build fail. Check the files at `https://download.tomrade.com/<version>/Tomrade-<version>-…`, then publish the release by hand. A tag with a suffix, like `v0.2.0-beta.1`, makes a prerelease.

A Mac build fails rather than ship unsigned when a secret is missing. Re-running a failed job replaces its files in R2 and on the existing draft. A failed upload re-runs on its own, without its build: every runner is on the one Mac, so the staged files are still there (the release job removes them once it has passed). The upload tries each file six times, waiting 20 s longer after each failure, since the Mac's line drops for a minute or two at a time. The installers cross the Mac's line once, up to R2: they used to go up to the release, back down to the site's mirror on the same Mac, and up again to R2. Only the two Mac manifests, a few KB, travel as artifacts.

Where the time goes (v0.10.0): a release takes about 15 minutes, nearly all of it in the two Mac builds waiting on Apple. Signing and notarizing the app takes about 9 minutes, the DMG's own notarization about 3, and the rest of the build (tsc, vite, packaging, zip and DMG) about a minute. Windows and Linux finish in 2 minutes.

The same tag publishes the plugin authors' npm packages (`scripts/npm-release.mjs`): the SDK, the CLI, the domain types and the CLI's test host on the SDK's version line, and every other app package as declarations for full-mode plugins at the tag's version. A version npm already has is skipped, so the SDK line publishes only when the SDK's version moved. npm limits how many new packages an account creates in a while: a package it refuses (429) is left for later and the job warns rather than fails, and `.github/workflows/npm-packages.yml` publishes what npm still lacks for the newest release every day (or for a tag you name, run by hand). Without `NPM_TOKEN` the job runs as a dry run and says so; `node scripts/npm-release.mjs --verify` stages, packs and typechecks a full-mode plugin against the packs outside the checkout.

The workflow reads six repository secrets (Settings → Secrets and variables → Actions), and `NPM_TOKEN` for npm:

| Secret | Value |
| --- | --- |
| `MAC_CERTS` | The Developer ID Application `.p12` (below), base64-encoded |
| `MAC_CERTS_PASSWORD` | The password the `.p12` was exported with |
| `APPLE_API_KEY_P8` | The contents of `AuthKey_<KEY ID>.p8` |
| `APPLE_API_KEY_ID` | Its Key ID |
| `APPLE_API_ISSUER` | The Issuer ID |
| `CLOUDFLARE_API_TOKEN` | A Cloudflare API token with Workers R2 Storage: Edit on the account that holds the `tomrade-downloads` bucket; haoyuant/tomrade-site's Deploy uses the same kind |
| `NPM_TOKEN` | An npm granular access token that can publish the `@tomradex` scope (optional: without it the npm job is a dry run); see below |

```sh
R=haoyuant/tomrade
base64 -i DeveloperID.p12 | gh secret set MAC_CERTS -R $R
gh secret set MAC_CERTS_PASSWORD -R $R          # prompts
gh secret set APPLE_API_KEY_P8 -R $R < AuthKey_XXXXXXXXXX.p8
gh secret set APPLE_API_KEY_ID -R $R --body XXXXXXXXXX
gh secret set APPLE_API_ISSUER -R $R --body xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
gh secret set CLOUDFLARE_API_TOKEN -R $R        # prompts
```

`NPM_TOKEN` expires: npm lets a token that can publish live 90 days at most, and the npm job fails with "NPM_TOKEN no longer works" once it has. Make a new one on npmjs.com (avatar → Access Tokens → Generate New Token → Granular Access Token):

- Expiration: up to 90 days.
- Packages and scopes: Read and write, on the scope `@tomradex` rather than on chosen packages, so a package that was never published can be published.
- Bypass 2FA: on, since CI cannot type a one-time code.

Then store it (gh asks for the value):

```sh
gh secret set NPM_TOKEN -R haoyuant/tomrade
```

## Self-hosted runners: the Mac mini

Hosted macOS minutes count ten times against the account's monthly allowance, and when it runs out GitHub starts no hosted job at all. So every job runs on runners on the Mac mini, which GitHub still schedules then: the Mac, Windows, and Linux builds, the release job, the Website job, and haoyuant/tomrade-site's Deploy. Four Mac runners carry the same labels, so four of the five builds run side by side, as they would on hosted runners; the fifth waits for a free runner, and since the Linux and Windows builds take about 2 minutes, that adds little to a release still waiting on Apple. A release takes about as long as its slowest build, which is mostly waiting for Apple's notary service.

| Runner | Repository | Labels |
| --- | --- | --- |
| `~/actions-runners/tomrade-1`, `-2`, `-3`, `-4` | haoyuant/tomrade | `self-hosted, macOS, ARM64` |
| `~/actions-runners/tomrade-site` | haoyuant/tomrade-site | `self-hosted, macOS, ARM64` |

The x64 Mac app builds on the arm64 Mac. `pnpm install --cpu=arm64 --cpu=x64` installs both arches' native packages, and `apps/desktop/scripts/after-pack.cjs` leaves the app only its own esbuild. It also drops the agent SDK's bundled Claude Code binary from every app: the Claude Code engine runs the person's own `claude`, like the other local agents. better-sqlite3 ships prebuilt binaries for every platform and picks one at run time; `after-pack.cjs` keeps only the target's (both arches for a universal Mac app) and drops SQLite's sources, and fails the build when the target's binary is missing. It also drops what no running app reads: TypeScript sources and declarations (except the plugin SDK's), `examples` and `__tests__` folders, third-party readmes and changelogs, and node-addon-api's headers. electron-builder itself leaves every `.d.ts` out of node_modules, so `after-pack.cjs` copies the plugin SDK's back from the workspace build (Plugin Studio's `plugin_reference` hands the agent `contract.d.ts`) and fails the build when `contract.d.ts` is missing. Each Mac build writes an update manifest listing only its own zip; the release job merges the two.

The Mac builds sign from one keychain, `~/Library/Keychains/tomrade-signing.keychain-db`, which the workflow's first job remakes from `MAC_CERTS` on every run and adds to the user's keychain search list (codesign builds the certificate chain from that list). Each build unlocks it with `MAC_CERTS_PASSWORD` and hands it to electron-builder as `CSC_KEYCHAIN`. Given `CSC_LINK` instead, electron-builder makes a keychain per build and rewrites the search list to add it, and two builds doing that at once drop each other's: codesign then fails with `errSecInternalComponent`. The Developer ID stays on the Mac between releases, locked after an hour unused. Runs of the workflow wait for each other, so one never remakes the keychain under another's builds.

Windows is cross-built on a Mac runner too. No Wine: electron-builder edits the exe's resources in JavaScript, runs NSIS's macOS `makensis`, and pulls the uninstaller out of the installer itself. `pnpm install --os=darwin --os=win32 --cpu=arm64 --cpu=x64` installs the Mac packages the build runs on beside Windows', and `after-pack.cjs` drops all but win32-x64 (left in, they double the installer). The Windows app alone is packed into `app.asar` (`win.asar`): its NSIS installer extracts every file to a temp folder and copies it into place, and the virus scanner reads each one, so ~5,600 loose files took 80–100 s to install fresh and 105–110 s to upgrade; in `app.asar` it is ~1,800 files, 35–65 s and 50–60 s (2026-10-26, i5-7600 with 360 Total Security, three runs each). `after-pack.cjs` extracts electron-builder's `app.asar`, prunes it like the other apps, and packs it again keeping as real files only what another program starts or reads by path: `vendor/` (npm and Pi), `official-plugins/`, `assets/`, esbuild's binary, better-sqlite3, and the pty host with node-pty and its ConPTY runtime, which outlives the app. makensis aborts on an include path of 265 characters or more, and electron-builder reports only `makensis process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`. pnpm's folder for app-builder-lib makes that path 262 characters in the runner's work folder, so the job sets `pnpm_config_virtual_store_dir_max_length: 60`, which brings it to 216. It must stay an environment variable: pnpm checks that each later command sees the settings the install used, and a `--config.` flag on the install alone sends `pnpm exec` back to reinstall.

Linux is cross-built on a Mac runner the same way, with `--os=darwin --os=linux`, x64 and arm64 each in a build of its own; each writes its own update manifest (`latest-linux.yml`, `latest-linux-arm64.yml`), so nothing is merged. Nothing is compiled (better-sqlite3 and the AppImage runtime come prebuilt), so the build machine's glibc doesn't matter. esbuild's install fills its CLI with the build machine's binary; `after-pack.cjs` removes that copy, since esbuild's API runs the target's `@esbuild/<platform>` binary and nothing runs the CLI. The Mac-built AppImage matched the one the x64 Ubuntu 22.04 container runner it replaced had built: the same runtime bytes, and the same files except esbuild's CLI and the musl Claude Code builds a Mac's pnpm adds (since dropped with the rest of the agent SDK's binaries); the bundled binaries ran there. That container can't run any AppImage under Rosetta, so the full app was not started.

The Mac's traffic, the runners' included, goes through Clash Verge's TUN (mihomo), so a release is as fast as the node it picks. On v0.10.0 a GitHub download dropped to about 60 KB/s mid-release and the site's mirror ran into its 30-minute timeout; a few minutes later the same file came at 16 MB/s. The builds now send the installers to R2 (`api.cloudflare.com`) and only manifests to GitHub, but if uploads crawl, check the node or give those hosts a rule of their own.

The Mac runners are LaunchAgents, so they run while the user is logged in (codesign needs that session), and jobs run as that user. The release job also needs `yq` (`brew install yq`); `gh` and Xcode come from the machine.

`.github/runners/setup.sh` installs or replaces one:

```sh
export GH_TOKEN=$(gh auth token --user haoyuant)
.github/runners/setup.sh arm64 haoyuant/tomrade 1
.github/runners/setup.sh arm64 haoyuant/tomrade 2
.github/runners/setup.sh arm64 haoyuant/tomrade 3
.github/runners/setup.sh arm64 haoyuant/tomrade 4
.github/runners/setup.sh arm64 haoyuant/tomrade-site
```

The four tomrade runners are interchangeable: each job goes to whichever is free. Check on them under Settings → Actions → Runners, or with `./svc.sh status` in a runner's folder (logs in `~/Library/Logs/actions.runner.*`). While the Mac is off, jobs wait for it. Only collaborators can start these workflows (tags, releases, manual runs). If the repository goes public, don't add `pull_request` workflows to these runners: a fork's code would run on the Mac.

## Publishing: the website follows

Publishing the draft runs `.github/workflows/website.yml`. It starts the Deploy workflow in haoyuant/tomrade-site with the tag. Its mirror checks that the installers and update files are in R2 at the right sizes, copies any that aren't from the release (as for releases made before builds uploaded there), and writes the update manifests last; for a new release that takes seconds. For a release it also points `latest.json` at the installers and redeploys tomrade.com so its download buttons name the new version; a prerelease leaves the site alone. Watch it at haoyuant/tomrade-site → Actions → Deploy; a failure is emailed to whoever owns the token. A re-run there, or Run workflow with the tag, repeats it.

Publish by hand: a release published with `GITHUB_TOKEN` doesn't start other workflows. Marking a prerelease as a full release later starts it again, but a `-beta.N` build stays a beta: it wrote no Stable manifests, so the mirror leaves Stable and the site alone.

## Updates: what installed copies see

An installed build asks download.tomrade.com for its channel's manifest (`apps/desktop/src/updater.ts`): `latest-mac.yml`, `latest.yml` (Windows) or `latest-linux.yml` on Stable, the `beta` ones on Beta. Once published, a release reaches everyone within the hour, as a notice: nothing downloads until the person clicks Download, and the restart asks first.

- Only `-beta.N` tags reach the Beta channel. electron-builder names the manifest after the first word of the suffix, so `v0.3.0-rc.1` writes `rc-mac.yml`, which no copy reads.
- A release also writes the `beta` manifests, so Beta moves on to it. A prerelease writes only its own.
- Nothing is ever downgraded, so a bad release is pulled by publishing a higher version. Leaving Beta waits for the next release.
- One `latest-mac.yml` lists both Mac zips; the release job fails if either arch is missing.
- The mirror never moves a manifest back to an older version, so re-running an old tag cannot roll the channel back.
- Differential downloads use the `.blockmap` files on Windows and Linux. A Mac's first update after installing from the DMG downloads the whole zip.
- A Mac copy updates itself only from Applications; the About pane offers to move it there.

To try a feed without publishing, point a build at any folder served over HTTP (`TOMRADE_UPDATE_URL=http://127.0.0.1:8080/`). A checkout then checks it too, though it can't install what it finds.

It needs one secret here, `SITE_DISPATCH_TOKEN`: a fine-grained GitHub token for haoyuant/tomrade-site with Actions: Read and write. The site repository's own secrets are listed in its README.

## macOS: signing and notarizing

A build without a Developer ID certificate is unsigned, and macOS warns whoever opens it. The config never signs with any other certificate. Without `identity: Developer ID Application`, electron-builder would take an Apple Development certificate from the keychain instead, and that signature is only for this machine.

### Once

1. Join the Apple Developer Program as the account holder. Only the account holder can create Developer ID certificates.
2. Create the **Developer ID Application** certificate:
   - In Keychain Access, choose Certificate Assistant → Request a Certificate From a Certificate Authority, and save the request to disk.
   - At developer.apple.com, go to Certificates → + → Developer ID Application and upload the request.
   - Download the certificate and double-click it.

   `security find-identity -v -p codesigning` should now list `Developer ID Application: <name> (<TEAM ID>)`. Export the certificate with its private key as a `.p12` (Keychain Access → My Certificates → right-click → Export) and keep it somewhere safe: it is the only copy.

   Xcode can do the same in one step: Settings → Accounts → the team → Manage Certificates → + → Developer ID Application.
3. Create the key for notarization:
   - In App Store Connect, go to Users and Access → Integrations → App Store Connect API → Team Keys.
   - Generate a key with Developer access.
   - Download `AuthKey_<KEY ID>.p8`. It can be downloaded only once.
   - Note the Key ID and the Issuer ID.

### Each release

```sh
export APPLE_API_KEY=/path/to/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
pnpm --filter @tomrade/desktop package
```

The log should show `signing … identityName=Developer ID Application: …` and `notarization successful`. Only the app is notarized this way; CI also notarizes the DMG with `xcrun notarytool submit … --wait` and `xcrun stapler staple`. If the keychain holds more than one Developer ID certificate, pick one with `-- -c.mac.identity="<name> (<TEAM ID>)"`.

Check the build:

```sh
APP=apps/desktop/release/mac-arm64/Tomrade.app
codesign --verify --deep --strict --verbose=2 "$APP"
spctl --assess --type execute --verbose "$APP"    # source=Notarized Developer ID
xcrun stapler validate "$APP"
```

Then open the app and run a plugin once: install one, and have Plugin Studio build and test one. The release build keeps library validation on (`apps/desktop/assets/entitlements.mac.plist`), so a plugin cannot load a native module that wasn't signed with Tomrade's Developer ID. A local test build cannot exercise that.

### Trying the hardened runtime without a certificate

An ad-hoc signature (`-`) has no team, so library validation must be off for that build to start. Add `com.apple.security.cs.disable-library-validation` to a copy of the entitlements and pass both:

```sh
pnpm --filter @tomrade/desktop package -- --dir -c.directories.output=/tmp/tomrade-adhoc \
  -c.mac.identity=- -c.mac.entitlements=/tmp/adhoc.plist -c.mac.entitlementsInherit=/tmp/adhoc.plist
```
