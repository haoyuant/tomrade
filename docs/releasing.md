# Releasing the desktop app

`pnpm --filter @tomrade/desktop package` builds the backend and the renderer, then the installers, into `apps/desktop/release/`. On macOS that's a DMG and a ZIP. Add `-- --dir` to build just the unpacked app.

## CI: a tag builds every installer

Pushing a tag `v<semver>` runs `.github/workflows/release.yml`:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

Every installer builds on the self-hosted Mac (below), each in a job of its own and all at once: the Mac ones (arm64 and x64), the Windows one (NSIS, unsigned), and the Linux AppImage. The version comes from the tag. The Mac builds are signed, notarized, and checked with `codesign`, `spctl`, and `stapler`; the DMG is notarized and stapled too. When every build passes, the installers and their update manifests go on a **draft** release with generated notes. Check them, then publish the release by hand. A tag with a suffix, like `v0.2.0-beta.1`, makes a prerelease.

A Mac build fails rather than ship unsigned when a secret is missing. Re-running a failed job replaces the files on the existing draft.

The workflow reads five repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `MAC_CERTS` | The Developer ID Application `.p12` (below), base64-encoded |
| `MAC_CERTS_PASSWORD` | The password the `.p12` was exported with |
| `APPLE_API_KEY_P8` | The contents of `AuthKey_<KEY ID>.p8` |
| `APPLE_API_KEY_ID` | Its Key ID |
| `APPLE_API_ISSUER` | The Issuer ID |

```sh
R=haoyuant/tomrade
base64 -i DeveloperID.p12 | gh secret set MAC_CERTS -R $R
gh secret set MAC_CERTS_PASSWORD -R $R          # prompts
gh secret set APPLE_API_KEY_P8 -R $R < AuthKey_XXXXXXXXXX.p8
gh secret set APPLE_API_KEY_ID -R $R --body XXXXXXXXXX
gh secret set APPLE_API_ISSUER -R $R --body xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

## Self-hosted runners: the Mac mini

Hosted macOS minutes count ten times against the account's monthly allowance, and when it runs out GitHub starts no hosted job at all. So every job runs on runners on the Mac mini, which GitHub still schedules then: the Mac, Windows, and Linux builds, the release job, the Website job, and haoyuant/tomrade-site's Deploy. Three Mac runners carry the same labels, so the two Mac builds and the Windows one run side by side, as they would on hosted runners: a release takes about as long as its slowest build, which is mostly waiting for Apple's notary service.

| Runner | Repository | Labels |
| --- | --- | --- |
| `~/actions-runners/tomrade-mac-arm64`, `-2`, `-3` | haoyuant/tomrade | `self-hosted, macOS, ARM64` |
| Docker container `actions-runner-haoyuant-tomrade` | haoyuant/tomrade | `self-hosted, Linux, X64` |
| `~/actions-runners/tomrade-site-mac-arm64` | haoyuant/tomrade-site | `self-hosted, macOS, ARM64` |

The x64 Mac app builds on the arm64 Mac. `pnpm install --cpu=arm64 --cpu=x64` installs both arches' native packages, and `apps/desktop/scripts/after-pack.cjs` leaves the app only its own: the agent SDK's Claude Code binary and esbuild's. better-sqlite3 ships prebuilt binaries for every platform and picks one at run time. Each Mac build writes an update manifest listing only its own zip; the release job merges the two.

The Mac builds sign from one keychain, `~/Library/Keychains/tomrade-signing.keychain-db`, which the workflow's first job remakes from `MAC_CERTS` on every run and adds to the user's keychain search list (codesign builds the certificate chain from that list). Each build unlocks it with `MAC_CERTS_PASSWORD` and hands it to electron-builder as `CSC_KEYCHAIN`. Given `CSC_LINK` instead, electron-builder makes a keychain per build and rewrites the search list to add it, and two builds doing that at once drop each other's: codesign then fails with `errSecInternalComponent`. The Developer ID stays on the Mac between releases, locked after an hour unused. Runs of the workflow wait for each other, so one never remakes the keychain under another's builds.

Windows is cross-built on a Mac runner too. No Wine: electron-builder edits the exe's resources in JavaScript, runs NSIS's macOS `makensis`, and pulls the uninstaller out of the installer itself. `pnpm install --os=darwin --os=win32 --cpu=arm64 --cpu=x64` installs the Mac packages the build runs on beside Windows', and `after-pack.cjs` drops all but win32-x64 (left in, they double the installer). makensis aborts on an include path of 265 characters or more, and electron-builder reports only `makensis process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`. pnpm's folder for app-builder-lib makes that path 262 characters in the runner's work folder, so the job sets `pnpm_config_virtual_store_dir_max_length: 60`, which brings it to 216. It must stay an environment variable: pnpm checks that each later command sees the settings the install used, and a `--config.` flag on the install alone sends `pnpm exec` back to reinstall.

The Mac runners are LaunchAgents, so they run while the user is logged in (codesign needs that session), and jobs run as that user. The release job also needs `yq` (`brew install yq`); `gh` and Xcode come from the machine.

The Linux runner is an x64 Ubuntu 22.04 container (`.github/runners/linux.Dockerfile`) that Docker Desktop runs under Rosetta. It restarts with Docker Desktop, so Docker Desktop must be running for a release. The build peaks around 2 GB of the Docker VM's memory: if a step dies with exit code 137, the VM ran out.

`.github/runners/setup.sh` installs or replaces one:

```sh
export GH_TOKEN=$(gh auth token --user haoyuant)
.github/runners/setup.sh arm64 haoyuant/tomrade
.github/runners/setup.sh arm64 haoyuant/tomrade 2
.github/runners/setup.sh arm64 haoyuant/tomrade 3
.github/runners/setup.sh linux haoyuant/tomrade
.github/runners/setup.sh arm64 haoyuant/tomrade-site
```

Check on them under Settings → Actions → Runners, with `./svc.sh status` in a Mac runner's folder (logs in `~/Library/Logs/actions.runner.*`), or with `docker logs actions-runner-haoyuant-tomrade`. While the Mac is off, jobs wait for it. Only collaborators can start these workflows (tags, releases, manual runs). If the repository goes public, don't add `pull_request` workflows to these runners: a fork's code would run on the Mac.

## Publishing: the website follows

Publishing the draft runs `.github/workflows/website.yml`. It starts the Deploy workflow in haoyuant/tomrade-site with the tag, which copies the installers and update files to download.tomrade.com and writes the update manifests last. For a release it also points `latest.json` at the installers and redeploys tomrade.com so its download buttons name the new version; a prerelease leaves the site alone. Watch it at haoyuant/tomrade-site → Actions → Deploy; a failure is emailed to whoever owns the token. A re-run there, or Run workflow with the tag, repeats it.

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
