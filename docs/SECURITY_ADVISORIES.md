# Security Advisories — Dependency CVE Audit Trail

This document tracks the state of `npm audit` for the NOIP server. It is
updated whenever the dependency tree changes in a way that affects the
audit posture (new direct dep, transitive bump, new override, advisory
withdrawal).

Companion to `SECURITY.md` — that file describes the disclosure /
response policy; this file is the operator-facing record of which CVEs
have been patched, which are still being tracked, and why any remaining
finding is accepted.

---

## Current state

**Last review:** 2026-05-16
**Branch:** `claude/adr-ddd-documentation-uNdZ2` (worktree
`worktree-agent-a59f0e225a3f5662f`)
**Tooling:** `npm@10.9.7`, `node@22.22.2`, `lockfileVersion: 3`

```
$ npm audit
found 0 vulnerabilities
```

| Severity | Count | Notes |
|----------|-------|-------|
| critical | 0 | — |
| high     | 0 | — |
| moderate | 0 | — |
| low      | 0 | — |

There are **no unpatched vulnerabilities** at the time of this review.
All findings from the prior audit (41 vulnerabilities: 1 low / 26 mod /
12 high / 2 crit) have been remediated via:

  1. Direct-dependency upgrades within the existing major version
     wherever possible.
  2. One direct-dependency major bump (`nodemailer` 7 → 8) that
     was API-compatible for our consumer.
  3. `overrides` entries in `package.json` for transitives that could
     not be reached by upgrading a direct dep.

If a future audit surfaces a CVE we deliberately do not patch (e.g. a
breaking-change requirement that lands as its own work item), add it to
the **Deferred / accepted findings** table below before merging.

---

## Audit baseline (before remediation)

Captured 2026-05-16 from `npm audit --json` against the lockfile at
commit `b68c0fe` ("ran qa pipeline"):

| Severity | Count |
|----------|-------|
| critical | 2     |
| high     | 12    |
| moderate | 26    |
| low      | 1     |
| **total**| **41**|

Direct-dep vulns: `axios`, `mongoose`, `nodemailer`, `express-rate-limit`,
`uuid` (and `jsonwebtoken` for the transitive `jws`). Critical was
`fast-xml-parser` via `@types/nodemailer → @aws-sdk/client-sesv2`;
the other critical was `handlebars` via `ts-jest`.

---

## Remediation by commit

### Commit 1 — `chore(deps): upgrade direct deps with high/critical CVEs`

Direct-dep bumps:

| Package | From | To | Vulnerabilities patched |
|---------|------|----|--------------------------|
| `axios` | `^1.12.2` | `^1.16.1` | 16 high CVEs (SSRF, prototype pollution, CRLF injection, body-length bypass, etc.) |
| `mongoose` | `^8.19.2` | `^8.24.0` | GHSA-wpg9-53fq-2r8h NoSQL injection via `$nor` sanitizeFilter bypass |
| `nodemailer` | `^7.0.10` | `^8.0.7` | addressparser DoS (`GHSA-rcmh-qjqh-p98v`), SMTP command injection via `envelope.size` (`GHSA-c7w3-x93f-qmm8`) and EHLO/HELO `name` (`GHSA-vvjj-xcjg-gr5g`) |
| `express-rate-limit` | `^8.1.0` | `^8.5.2` | `GHSA-46wh-pxpv-q5gq` IPv4-mapped IPv6 rate-limit bypass |
| `uuid` | `^13.0.0` | `^13.0.2` | `GHSA-w5hq-g745-h8pq` missing buffer bounds check in `v3/v5/v6` when `buf` provided |
| `jsonwebtoken` | `^9.0.2` | `^9.0.3` | Transitively patches `jws@3.2.2` `GHSA-869p-cjfg-cm3x` HMAC verify bypass (9.0.3 depends on `jws@^4.0.1`) |
| `@types/nodemailer` | `^7.0.3` | `^7.0.11` | Drops the `@aws-sdk/client-sesv2` transitive that pulled in the critical `fast-xml-parser` advisory + 12 moderate AWS-SDK advisories that all chain through it |

Effect: 41 → 15 vulnerabilities.

The `nodemailer` 7 → 8 bump is the only major-version change. Verified
against `src/utils/auth/email.service.ts` — the consumer uses only
`createTransport`, `sendMail`, and `verify`, all of which are unchanged
across the 7→8 boundary. nodemailer 8 ships with zero runtime deps,
which also shrinks the lockfile.

### Commit 2 — `chore(deps): add overrides for transitive CVEs - audit 0/0/0/0`

Added `overrides` block to `package.json` for transitives we cannot
reach via direct-dep upgrades. All overrides stay within the consumer's
current major to avoid breaking-API churn; nested form is used where
parents pin incompatible ranges.

Top-level overrides:

| Override | Version | Reason |
|----------|---------|--------|
| `handlebars` | `^4.7.9` | ts-jest → handlebars: 8 CVEs incl. **critical** AST type-confusion / prototype-pollution XSS / DoS (`GHSA-3mfm-83xf-c92r`, `GHSA-2w6w-674q-4c4q`, `GHSA-2qvq-rjwj-gvw9`, `GHSA-7rx3-28cr-v5wh`, `GHSA-442j-39wm-28r2`, `GHSA-xhpv-hc6g-r9c6`, `GHSA-9cx6-37pm-9jff`, `GHSA-xjpj-3mr7-gcpf`). 4.7.9 patches all; same major. |
| `flatted` | `^3.4.2` | eslint → file-entry-cache → flat-cache → flatted: prototype pollution + unbounded recursion DoS (`GHSA-25h7-pfq9-p65f`, `GHSA-rf6f-7fwh-wjgh`). Drop-in compatible. |
| `lodash` | `^4.18.1` | express-validator → lodash: 3 high CVEs (`GHSA-xxjr-mmjv-4gpg`, `GHSA-r5fr-rjxr-66jc`, `GHSA-f23m-r3pf-42rh`) — prototype pollution + `_.template` code injection. 4.18.x is forward-compatible with 4.17.x for the surface express-validator consumes. |
| `validator` | `^13.15.35` | express-validator → validator: incomplete filtering of special elements (`GHSA-vghf-hv5q-vc2g`). Same major. |
| `path-to-regexp` | `^8.4.2` | express 5 → router → path-to-regexp: ReDoS via sequential optional groups (`GHSA-j3q9-mxjg-w52f`) and multiple wildcards (`GHSA-27v5-c462-wpq7`). Same major. |
| `body-parser` | `^2.2.2` | express → body-parser: DoS via header parsing (chained via qs). Same major. |
| `qs` | `^6.15.1` | express + supertest → qs: prototype pollution. Semver-compatible. |
| `yaml` | `^2.9.0` | lint-staged → yaml: stack overflow via deeply nested collections (`GHSA-48c2-rrv3-qjmp`). Same major. |
| `glob` | `^10.5.0` | jest internals → glob: command injection via `-c` CLI flag (`GHSA-5j98-mcp5-4vw2`). jest uses glob as a library, not via CLI, so real impact was already nil — patched for hygiene within 10.x. |

Nested (parent-scoped) overrides — required because `minimatch` 3.x and
9.x have incompatible default-export APIs, and `picomatch` 2.x and 4.x
cannot be unified:

| Parent path | Nested override | Reason |
|-------------|-----------------|--------|
| `@eslint/config-array` | `minimatch → { ".": "3.1.5", "brace-expansion": "1.1.14" }` | ESLint internals import `minimatch` as a default export → must stay on 3.x. |
| `@eslint/eslintrc` | `minimatch → { ".": "3.1.5", "brace-expansion": "1.1.14" }`, `ajv → 6.15.0`, `js-yaml → 4.1.1` | Same as above; plus ajv proto-pollution (`<6.14.0`) and js-yaml stack-overflow patches. |
| `eslint` | `minimatch → { ".": "3.1.5", "brace-expansion": "1.1.14" }` | Same default-export constraint. |
| `test-exclude` | `minimatch → 3.1.5` | ts-jest → babel-plugin-istanbul → test-exclude uses 3.x. |
| `@typescript-eslint/typescript-estree` | `minimatch → { ".": "9.0.9", "brace-expansion": "2.1.0" }` | This chain pins 9.x; needs ReDoS patch + brace-expansion 2.x patch. |
| `@jest/reporters`, `jest-config`, `jest-runtime` | `glob → { "minimatch": { ".": "9.0.9", "brace-expansion": "2.1.0" } }` | Same as typescript-estree; jest pins 9.x. |
| `jest-util` | `picomatch → 4.0.4` | jest-util pins 4.x; needs the 4.x ReDoS patch. |
| `micromatch` | `picomatch → 2.3.2` | lint-staged → micromatch pins 2.x; needs the 2.x patch. |
| `anymatch` | `picomatch → 2.3.2` | jest-haste-map → anymatch pins 2.x; same patch. |
| `@istanbuljs/load-nyc-config` | `js-yaml → 3.14.2` | This chain still uses js-yaml 3.x; 3.14.2 is the 3.x patch. |
| `ts-node` | `diff → 4.0.4` | ts-node pins diff 4.x; 4.0.4 patches the ReDoS in the 4.x line. |
| `ajv@6` (selector) | `→ 6.15.0` | Force every ajv 6.x install to the 6.15.0 patch, even outside eslintrc. |

Effect: 15 → 0 vulnerabilities.

---

## Deferred / accepted findings

_None at this time._

If a CVE is later accepted (i.e. left unpatched intentionally), record
it here with the following columns:

| CVE / GHSA | Package | Severity | Path (npm ls) | Reason deferred | Mitigation in place | Planned remediation |
|------------|---------|----------|---------------|-----------------|---------------------|---------------------|

---

## How to refresh this document

1. `npm ci` (deterministic install from lockfile).
2. `npm audit --json > /tmp/audit.json`.
3. Compare against the **Current state** table. If the counts changed,
   update them and add any new entries to the per-commit log or to the
   **Deferred / accepted findings** table.
4. If a top-level or nested override is added/removed, update both the
   table above and the `overridesNotes` block in `package.json` so the
   commit history captures the rationale.
5. Re-run `npm ci && scripts/ci-deps-deterministic.sh` to confirm the
   lockfile still installs cleanly.

---

## CI guard

`scripts/ci-deps-deterministic.sh` runs:

  - `npm ci --ignore-scripts` to confirm the lockfile resolves cleanly
    against the registry without surprises.
  - `npm ls --json` twice and diffs the output as a sanity check that
    install is deterministic.
  - `npm audit --omit=dev --audit-level=high` to fail the build on any
    new runtime-side high/critical CVE.

CI should call this script on every PR; a non-zero exit means either
the lockfile drifted or a new high/critical advisory landed against a
runtime dep — both require human review before merge.
