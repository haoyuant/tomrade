# Releasing the desktop app

`pnpm --filter @tomrade/desktop package` builds the backend and the renderer, then the installers, into `apps/desktop/release/`. On macOS that's a DMG and a ZIP. Add `-- --dir` to build just the unpacked app.

## macOS: signing and notarizing

A build without a Developer ID certificate is unsigned, and macOS warns whoever opens it. The config never signs with any other certificate. Without `identity: Developer ID Application`, electron-builder would take an Apple Development certificate from the keychain instead, and that signature is only for this machine.

### Once

1. Join the Apple Developer Program as the account holder. Only the account holder can create Developer ID certificates.
2. Create the **Developer ID Application** certificate:
   - In Keychain Access, choose Certificate Assistant → Request a Certificate From a Certificate Authority, and save the request to disk.
   - At developer.apple.com, go to Certificates → + → Developer ID Application and upload the request.
   - Download the certificate and double-click it.

   `security find-identity -v -p codesigning` should now list `Developer ID Application: <name> (<TEAM ID>)`. Export the certificate with its private key as a `.p12` and keep it somewhere safe: it is the only copy.
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

The log should show `signing … identityName=Developer ID Application: …` and `notarization successful`. If the keychain holds more than one Developer ID certificate, pick one with `-- -c.mac.identity="<name> (<TEAM ID>)"`.

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
