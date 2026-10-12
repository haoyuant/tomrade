#!/bin/bash
# Registers one of the Mac's self-hosted runners with a repository
# (docs/releasing.md):
#
#   .github/runners/setup.sh arm64 haoyuant/tomrade
#   .github/runners/setup.sh arm64 haoyuant/tomrade 2       # one more, beside it
#   .github/runners/setup.sh arm64 haoyuant/tomrade-site
#
# A number after the repository adds another Mac runner with the same labels,
# so another job runs at the same time. gh must be signed in as an admin of the
# repository. Running it again replaces that runner.
set -euo pipefail

VERSION=2.338.0
kind=${1:?kind: arm64}
repo=${2:?repository, like haoyuant/tomrade}
instance=${3:+-$3}
case $kind in
  arm64) sha=df4cebda25c86a886ed204e49fee63f5c2e7cec5f447b5c98440a826bbdf9df2 ;;
  *) echo "Unknown kind: $kind" >&2; exit 1 ;;
esac
token=$(gh api -X POST "repos/$repo/actions/runners/registration-token" --jq .token)

dir="$HOME/actions-runners/${repo#*/}-mac-$kind$instance"
if [ -f "$dir/.service" ]; then
  (cd "$dir" && ./svc.sh stop && ./svc.sh uninstall) || true
fi
rm -rf "$dir"
mkdir -p "$dir" && cd "$dir"
curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-osx-$kind-$VERSION.tar.gz"
echo "$sha  runner.tar.gz" | shasum -a 256 -c -
tar xzf runner.tar.gz && rm runner.tar.gz
./config.sh --unattended --replace --url "https://github.com/$repo" --token "$token" \
  --name "$(scutil --get LocalHostName)-mac-$kind$instance"
# A LaunchAgent, so it runs while this user is logged in: codesign needs the
# login session to reach a keychain.
./svc.sh install && ./svc.sh start
