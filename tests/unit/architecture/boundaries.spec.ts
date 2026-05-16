// Architecture-boundary lint tests for ADR-0010 (layered architecture) and
// ADR-0011 (bounded contexts / modular monolith), as wired up in
// eslint.config.mjs per ADR-0022.
//
// Each test case lints a fixture snippet under a *virtual* filename that
// places the snippet inside the layer or context whose boundary it is
// designed to violate. We assert the expected ESLint rule fires (or, for
// the happy-path control, that no rule fires). This way the zones in
// eslint.config.mjs are continuously regression-tested: deleting or
// weakening a zone makes the matching fixture suddenly pass lint, which
// flips this suite red.
//
// Why a subprocess instead of the ESLint Node API?
// `new ESLint({ overrideConfigFile: '...mjs' }).lintText(...)` ends up
// doing a dynamic `import()` of the .mjs flat config, which Jest's CJS
// VM rejects with "A dynamic import callback was invoked without
// --experimental-vm-modules". Shelling out to the real `eslint` binary
// sidesteps the VM-modules constraint entirely while still exercising the
// production config end-to-end.
//
// The fixtures live in `./fixtures/` and are globally ignored by
// eslint.config.mjs so a regular `npm run lint:check` does not flag them.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const ESLINT_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'eslint');

interface BoundaryCase {
  /** Fixture filename inside ./fixtures/. */
  fixture: string;
  /** Virtual path the fixture pretends to live at (relative to repo root). */
  virtualSrcPath: string;
  /** Rule id the fixture must trigger; `null` = happy path (no error). */
  expectedRuleId: string | null;
  /** Short description used in the test name. */
  description: string;
}

const cases: BoundaryCase[] = [
  {
    fixture: 'models-imports-controller.ts',
    virtualSrcPath: 'src/models/_fixture_models_imports_controller.ts',
    expectedRuleId: 'import/no-restricted-paths',
    description: 'models/ cannot import from controllers/ (ADR-0010)',
  },
  {
    fixture: 'shared-kernel-imports-services.ts',
    virtualSrcPath: 'src/shared/kernel/_fixture_kernel_imports_services.ts',
    expectedRuleId: 'import/no-restricted-paths',
    description: 'shared/kernel/ cannot import from services/ (ADR-0011)',
  },
  {
    fixture: 'discovery-domain-imports-mongoose.ts',
    virtualSrcPath:
      'src/contexts/discovery/domain/_fixture_domain_imports_mongoose.ts',
    expectedRuleId: 'no-restricted-imports',
    description: 'discovery/domain/ cannot import mongoose (ADR-0011)',
  },
  {
    fixture: 'security-imports-discovery-internals.ts',
    virtualSrcPath:
      'src/contexts/security/application/_fixture_security_imports_discovery_internals.ts',
    expectedRuleId: 'import/no-restricted-paths',
    description:
      'security/ cannot reach into discovery/ internals; must go via api/ (ADR-0011 Public-API rule)',
  },
  {
    fixture: 'security-imports-discovery-api.ts',
    virtualSrcPath:
      'src/contexts/security/application/_fixture_security_imports_discovery_api.ts',
    expectedRuleId: null,
    description:
      'security/ importing discovery/api is allowed (happy-path control)',
  },
  {
    fixture: 'dashboard-application-imports-express.ts',
    virtualSrcPath:
      'src/contexts/dashboard/application/_fixture_dashboard_app_imports_express.ts',
    expectedRuleId: 'no-restricted-imports',
    description:
      'dashboard/application cannot import express (ADR-0010 services-no-HTTP rule)',
  },
];

interface EslintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  line: number;
  column: number;
}

interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
  errorCount: number;
  warningCount: number;
}

/**
 * Lint a fixture by *staging* it at the virtual src path, running the
 * production `eslint` CLI on that path, then removing the temp file.
 *
 * We have to place a real file at the virtual location because the
 * `import/no-restricted-paths` rule resolves imports relative to the
 * importer's real filesystem location — it cannot lint a path that does
 * not exist on disk. The fixture stays self-contained on tests/, and we
 * just copy it into src/ for the duration of one lint invocation.
 */
function lintFixtureAtVirtualPath(
  fixtureFile: string,
  virtualSrcPath: string,
): EslintFileResult {
  const fixturePath = path.join(FIXTURE_DIR, fixtureFile);
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Missing fixture: ${fixturePath}`);
  }
  const code = fs.readFileSync(fixturePath, 'utf-8');

  const stagedPath = path.join(REPO_ROOT, virtualSrcPath);
  const stagedDir = path.dirname(stagedPath);
  // The staged file must live inside an *existing* src/ subtree because
  // the eslint.config.mjs `files: ['src/**/*.ts']` glob is rooted there.
  if (!fs.existsSync(stagedDir)) {
    throw new Error(
      `Virtual src path's parent does not exist: ${stagedDir} (the fixture relies on a real folder being present).`,
    );
  }

  // Use an obvious `_fixture_` prefix in the filename so a crash that
  // leaves the file behind is trivially attributable + cleanable.
  fs.writeFileSync(stagedPath, code, 'utf-8');
  try {
    const out = spawnSync(
      ESLINT_BIN,
      ['--format=json', '--no-warn-ignored', stagedPath],
      {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        // Inherit env so the user's PATH/HOME etc. are intact; bump
        // stdout cap because eslint --format=json can be large when
        // unrelated warnings are present.
        maxBuffer: 16 * 1024 * 1024,
      },
    );

    // ESLint exits non-zero when it finds errors — that's *expected* here
    // for violation cases, so we only fail the test on stderr parse
    // problems, not on a non-zero exit code per se.
    if (out.stdout.trim() === '') {
      throw new Error(
        `ESLint produced no JSON output (status=${out.status}). stderr:\n${out.stderr}`,
      );
    }
    const parsed = JSON.parse(out.stdout) as EslintFileResult[];
    // ESLint --format=json returns one entry per file; we lint one file
    // at a time, so the array always has exactly one entry.
    if (parsed.length !== 1) {
      throw new Error(
        `Expected exactly 1 result from eslint, got ${parsed.length}: ${out.stdout}`,
      );
    }
    return parsed[0]!;
  } finally {
    // Best-effort cleanup; ignore ENOENT if the test never wrote it.
    try {
      fs.unlinkSync(stagedPath);
    } catch {
      /* swallow */
    }
  }
}

describe('architecture boundary enforcement (ADR-0010 + ADR-0011 + ADR-0022)', () => {
  // Smoke check that the eslint binary is reachable so a missing-bin
  // failure surfaces as a clear setup error rather than per-case noise.
  beforeAll(() => {
    if (!fs.existsSync(ESLINT_BIN)) {
      throw new Error(
        `ESLint binary not found at ${ESLINT_BIN}; run \`npm ci\` first.`,
      );
    }
  });

  it.each(cases)('$description', ({ fixture, virtualSrcPath, expectedRuleId }) => {
    const result = lintFixtureAtVirtualPath(fixture, virtualSrcPath);

    // Only boundary-rule messages are load-bearing here; unrelated
    // warnings (e.g. no-console) are ignored so tweaks to those rules
    // never destabilise this suite.
    const boundaryRuleIds = new Set([
      'import/no-restricted-paths',
      'no-restricted-imports',
    ]);
    const boundaryMessages = result.messages.filter(
      (m) => m.ruleId !== null && boundaryRuleIds.has(m.ruleId),
    );

    if (expectedRuleId === null) {
      // Happy-path control: no boundary-rule violations of any kind.
      expect(boundaryMessages).toEqual([]);
      return;
    }

    const matching = boundaryMessages.filter((m) => m.ruleId === expectedRuleId);
    expect(matching).toHaveLength(1);
    expect(matching[0]!.severity).toBe(2);
    // And no *other* boundary rule should fire on the same fixture, so
    // each test exercises exactly the zone it claims to.
    expect(boundaryMessages).toHaveLength(1);
  });

  it('every fixture leaves no stale staged file behind', () => {
    // Defensive: confirm none of the virtual src paths still exist (in
    // case a previous run crashed mid-test). The list is built from the
    // canonical `cases` array so it stays in sync automatically.
    const leftovers = cases
      .map((c) => path.join(REPO_ROOT, c.virtualSrcPath))
      .filter((p) => fs.existsSync(p));
    if (leftovers.length > 0) {
      // Surface what's left and clean up so the next run isn't tainted.
      for (const p of leftovers) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* swallow */
        }
      }
    }
    expect(leftovers).toEqual([]);
  });
});
