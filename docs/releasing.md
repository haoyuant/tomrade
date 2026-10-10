# Releasing the desktop app

`pnpm --filter @tomrade/desktop package` builds the backend and the renderer, then the installers, into `apps/desktop/release/`. On macOS that's a DMG and a ZIP. Add `-- --dir` to build just the unpacked app.

## CI: a tag builds every installer

Pushing a tag `v<semver>` runs `.github/workflows/release.yml`:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

It builds on four runners: macOS arm64, macOS x64, Windows x64 (NSIS, unsigned), and Linux x64 (AppImage). The version comes from the tag. The Mac builds are signed, notarized, and checked with `codesign`, `spctl`, and `stapler`; the DMG is notarized and stapled too. When every build passes, the installers go on a **draft** release with generated notes. Check them, then publish the release by hand. A tag with a suffix, like `v0.2.0-beta.1`, makes a prerelease.

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
