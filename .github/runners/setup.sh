#!/bin/bash
# Registers one of the Mac's self-hosted runners with a repository
# (docs/releasing.md):
#
#   .github/runners/setup.sh arm64 haoyuant/tomrade
#   .github/runners/setup.sh x64   haoyuant/tomrade
#   .github/runners/setup.sh arm64 haoyuant/tomrade-site
#
# gh must be signed in as an admin of the repository. Running it again replaces
# that runner.
set -euo pipefail

VERSION=2.338.0
arch=${1:?arch: arm64 or x64}
repo=${2:?repository, like haoyuant/tomrade}
case $arch in
  arm64) sha=df4cebda25c86a886ed204e49fee63f5c2e7cec5f447b5c98440a826bbdf9df2 ;;
  # An x64 runner runs under Rosetta and so does everything it starts, so a
  # job sees an Intel Mac: setup-node installs x64 Node, pnpm the x64 packages.
  x64) sha=dea7a58796ce215fc424a8b27c0fdd9b813fa5fc03d109a4a1d38131d6bfa1a3 ;;
  *) echo "Unknown arch: $arch" >&2; exit 1 ;;
esac
token=$(gh api -X POST "repos/$repo/actions/runners/registration-token" --jq .token)

dir="$HOME/actions-runners/${repo#*/}-mac-$arch"
if [ -f "$dir/.service" ]; then
  (cd "$dir" && ./svc.sh stop && ./svc.sh uninstall) || true
fi
rm -rf "$dir"
mkdir -p "$dir" && cd "$dir"
curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-osx-$arch-$VERSION.tar.gz"
echo "$sha  runner.tar.gz" | shasum -a 256 -c -
tar xzf runner.tar.gz && rm runner.tar.gz
./config.sh --unattended --replace --url "https://github.com/$repo" --token "$token" \
  --name "$(scutil --get LocalHostName)-mac-$arch"
# A LaunchAgent, so it runs while this user is logged in: codesign needs the
# login session to reach a keychain.
./svc.sh install && ./svc.sh start
