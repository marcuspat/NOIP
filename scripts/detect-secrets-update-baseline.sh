#!/usr/bin/env bash
# detect-secrets-update-baseline.sh — refresh `.secrets.baseline` (ADR-0025).
#
# When detect-secrets surfaces a new finding that has been audited and
# accepted as a false positive (test fixture, ADR placeholder, etc.),
# the operator runs this script to fold the finding into the baseline.
# The diff is then reviewed in the PR so the audit trail is preserved.
#
# Usage:
#   scripts/detect-secrets-update-baseline.sh
#   scripts/detect-secrets-update-baseline.sh --audit   # interactive
#
# Requires `detect-secrets` >= 1.5.0 on PATH:
#   pip install --user detect-secrets
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v detect-secrets >/dev/null 2>&1; then
  echo "detect-secrets not found. Install with: pip install --user detect-secrets" >&2
  exit 1
fi

BASELINE=".secrets.baseline"

# Same excludes as .pre-commit-config.yaml so the baseline matches the
# CI scan exactly. Keep them in sync when editing either file.
EXCLUDE_REGEX='(package-lock\.json|node_modules/.*|coverage/.*|dist/.*|.*\.enc\.(yaml|yml|json|env)|.*\.snap)'

echo "Scanning repo and rewriting ${BASELINE}..."
detect-secrets scan \
  --baseline "${BASELINE}" \
  --exclude-files "${EXCLUDE_REGEX}"

if [[ "${1:-}" == "--audit" ]]; then
  echo "Launching interactive audit..."
  detect-secrets audit "${BASELINE}"
fi

echo "Done. Review the diff and commit:"
echo "  git diff ${BASELINE}"
