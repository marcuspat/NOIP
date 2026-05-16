#!/usr/bin/env bash
#
# scripts/ci-deps-deterministic.sh
#
# CI guard that verifies the npm dependency tree is reproducible and
# free of high/critical runtime CVEs. Designed to run on every PR.
#
# Exits non-zero if:
#   1. `npm ci` does not install cleanly from the committed lockfile
#      (drift between package.json and package-lock.json).
#   2. Two consecutive `npm ls --json` runs produce different trees
#      (non-determinism somewhere in resolution).
#   3. `npm audit --omit=dev --audit-level=high` finds any unpatched
#      high or critical CVE on runtime deps. Dev-only findings are
#      tracked in `docs/SECURITY_ADVISORIES.md` and do not fail the
#      build (override them in code review if you want to gate dev
#      deps too).
#
# Usage:
#   scripts/ci-deps-deterministic.sh          # from repo root
#
# Companion docs: docs/SECURITY_ADVISORIES.md, SECURITY.md.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> [1/4] verifying package-lock.json is committed and v3"
if [ ! -f package-lock.json ]; then
  echo "ERROR: package-lock.json missing — npm ci cannot run deterministically" >&2
  exit 1
fi
LOCKFILE_VERSION="$(node -e "console.log(require('./package-lock.json').lockfileVersion)")"
if [ "$LOCKFILE_VERSION" != "3" ]; then
  echo "ERROR: lockfileVersion is $LOCKFILE_VERSION; this project requires v3 (npm@>=7)." >&2
  echo "Regenerate via 'npm install' on npm 10.x and recommit." >&2
  exit 1
fi
echo "    ok: lockfileVersion=3"

echo "==> [2/4] npm ci --ignore-scripts (clean install, no postinstall hooks)"
# --ignore-scripts protects CI from rogue postinstall in a transitive
# dep. We re-run scripts for production deploys via a separate gate.
npm ci --ignore-scripts --no-audit --no-fund >/tmp/ci-deps-install.log 2>&1 || {
  cat /tmp/ci-deps-install.log >&2
  echo "ERROR: 'npm ci' failed — likely lockfile drift." >&2
  exit 1
}
echo "    ok: clean install completed"

echo "==> [3/4] determinism sanity (npm ls --json diffed against itself)"
TREE_A="$(mktemp)"
TREE_B="$(mktemp)"
trap 'rm -f "$TREE_A" "$TREE_B"' EXIT
npm ls --json --all >"$TREE_A" 2>/dev/null || true
npm ls --json --all >"$TREE_B" 2>/dev/null || true
if ! diff -q "$TREE_A" "$TREE_B" >/dev/null; then
  echo "ERROR: npm ls --json produced different output across two runs — non-deterministic resolution." >&2
  diff "$TREE_A" "$TREE_B" | head -40 >&2
  exit 1
fi
echo "    ok: dependency tree is stable across two npm ls runs"

echo "==> [4/4] npm audit --omit=dev --audit-level=high"
# Runtime-side high/critical CVEs gate the PR.
# Dev-only CVEs are tracked in docs/SECURITY_ADVISORIES.md.
if ! npm audit --omit=dev --audit-level=high; then
  echo "ERROR: npm audit found high/critical runtime CVEs." >&2
  echo "       Either upgrade the affected dep / add an override," >&2
  echo "       or document the decision in docs/SECURITY_ADVISORIES.md." >&2
  exit 1
fi
echo "    ok: no high/critical runtime CVEs"

echo
echo "==> deterministic-deps check PASSED"
