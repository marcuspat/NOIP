# ADR-0022: ESLint + Prettier as the code-quality gate

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Platform engineering
- **Tags:** quality, tooling

## Context and Problem Statement

Code style and lint drift makes review noisy and obscures real issues. We
want a single canonical formatting and linting setup, enforced automatically.

## Decision Drivers

- One source of truth for formatting (no debates).
- TypeScript-aware lint rules (incl. `@typescript-eslint`).
- Pre-commit hooks to keep the tree clean.
- Lint as a build-time gate so broken style cannot land.

## Considered Options

1. **ESLint with `@typescript-eslint` + Prettier + Husky + lint-staged.**
2. **Biome** (single tool replacing both).
3. **No enforcement, code review only.**

## Decision Outcome

**Chosen option:** Option 1 (already in `package.json`).

### Configuration

- `eslint.config.mjs` is the canonical flat config.
- `.prettierrc` defines: single quotes, semi, 2-space indent, 100-col
  print width, trailing commas `all`.
- `prebuild` hook runs `lint:check && typecheck`; CI also runs `format:check`.
- Husky `pre-commit` runs `lint-staged` over modified files only.

### Architecture-enforcement rules

Beyond style, we enforce architectural boundaries (ADR-0010 / ADR-0011) via
`eslint-plugin-import`:

```jsonc
"import/no-restricted-paths": [
  "error",
  {
    "zones": [
      { "target": "src/models",    "from": "src/services|src/controllers|src/routes" },
      { "target": "src/types",     "from": "src/services|src/controllers|src/routes" },
      { "target": "src/services",  "from": "express|src/routes" },
      { "target": "src/controllers", "from": "src/database" }
    ]
  }
]
```

Each context's `api/` barrel is the only public surface for cross-context
imports.

- **Implementation:** Complete (2026-05-16) — boundary zones enforced in
  `eslint.config.mjs` (ADR-0010 layer zones, ADR-0011 cross-context
  Public-API zones, domain-purity `no-restricted-imports` for
  `express`/`mongoose`/`ioredis`/`@kubernetes/client-node`/`@anthropic-ai/sdk`/`@aws-sdk/**`,
  application-layer `no-restricted-imports` for `express`); per-zone
  regression tests in `tests/unit/architecture/`.

### Positive Consequences

- Style is automatic; reviews stay focused on substance.
- Architectural drift is caught at lint time.

### Negative Consequences / Trade-offs

- Initial cost of fixing existing violations on the migration to the
  context-folder layout.

## References

- `eslint.config.mjs`, `.prettierrc`, `package.json` scripts.
- ADR-0010, ADR-0011.
