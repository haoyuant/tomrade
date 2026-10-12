#!/bin/bash
# Registers on the container's first start; restarts reuse that registration.
set -euo pipefail
if [ ! -f .runner ]; then
  ./config.sh --unattended --replace --url "https://github.com/$REPO" --token "$TOKEN" --name "$NAME"
fi
exec ./run.sh
