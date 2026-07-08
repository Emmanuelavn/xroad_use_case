#!/usr/bin/env bash
set -euo pipefail

if ! command -v pwsh >/dev/null 2>&1; then
  cat >&2 <<'EOF'
This full bootstrap is implemented in PowerShell because the project is run from Windows too.
Install PowerShell on Linux, then rerun:
  pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-xroad-official-full.ps1
EOF
  exit 1
fi

pwsh -NoProfile -ExecutionPolicy Bypass -File "$(dirname "$0")/bootstrap-xroad-official-full.ps1" "$@"
