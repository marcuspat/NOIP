/*
 * install-git-hooks.cjs (ADR-0025).
 *
 * Run by `npm run prepare` after `husky` has bootstrapped its
 * `.husky/_/` runner directory. Copies the tracked source-of-truth hook
 * from `scripts/git-hooks/` into `.husky/` and stamps it executable.
 *
 * Why a copy instead of a symlink:
 *  - Windows engineers don't get a usable symlink without admin rights.
 *  - Husky v9 looks for a regular file in `.husky/<hookname>`.
 *
 * Idempotent: re-running just overwrites the destination with the
 * latest tracked version, so a `git pull` followed by `npm install`
 * (which triggers `prepare`) always realigns developer hooks with the
 * checked-in script.
 *
 * Skips silently when run in CI (`CI=1`) or when there is no .git
 * directory (npm install during Docker build).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'scripts', 'git-hooks', 'pre-commit');
const DEST_DIR = path.join(ROOT, '.husky');
const DEST = path.join(DEST_DIR, 'pre-commit');

function shouldSkip() {
  if (process.env.CI) return 'CI environment';
  // Detached worktrees: .git is a file pointing to the real gitdir.
  const gitPath = path.join(ROOT, '.git');
  if (!fs.existsSync(gitPath)) return 'no .git present';
  if (!fs.existsSync(SRC)) return `source hook missing at ${SRC}`;
  return null;
}

function main() {
  const skipReason = shouldSkip();
  if (skipReason) {
    console.log(`[install-git-hooks] skipped: ${skipReason}`);
    return;
  }

  try {
    if (!fs.existsSync(DEST_DIR)) {
      fs.mkdirSync(DEST_DIR, { recursive: true });
    }
    fs.copyFileSync(SRC, DEST);
    fs.chmodSync(DEST, 0o755);
    console.log(`[install-git-hooks] installed ${SRC} -> ${DEST}`);
  } catch (err) {
    // Never fail the install. A broken hook copy is recoverable; a
    // failed `npm install` is not.
    console.warn(
      `[install-git-hooks] could not install pre-commit hook: ${err.message}`
    );
  }
}

main();
