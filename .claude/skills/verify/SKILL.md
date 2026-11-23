---
name: verify
description: Build, lint, and test sf-flow-coverage. Use before committing, before opening a PR, after changing src/ or test/, or when asked to run the tests, check coverage, update snapshots, or run mutation testing.
# Maintenance skill for this repo: hidden from the skills CLI, which installs only flowcov-fix-tests.
metadata:
  internal: true
---

# Verifying changes

Uses npm (not yarn), Biome (not ESLint/Prettier), and Vitest (not Mocha/nyc). Scripts run through wireit, which caches results.

| Command | What it does |
| --- | --- |
| `npm run build` | `tsc` compile + `biome check` |
| `npm run test` | Type-checks tests, runs Vitest with coverage, lints |
| `npm run test:only` | Vitest with coverage only |
| `npm run lint:dependencies` | knip: unused files, exports, dependencies |
| `npm run format` | Biome format `src` and `test` |
| `npm run test:nuts` | NUTs through the real CLI (`*.nut.ts`) |
| `npm run test:mutation:incremental` | Stryker on `src` files changed vs `origin/main` |
| `npm run readme` | Regenerate the README command reference |

Coverage thresholds (in `vitest.config.ts`): 95% on lines, statements, branches, and functions. CI fails below them.

## Windows gotcha

Run Vitest from a path with an upper-case drive letter (`C:\...`). From `c:\...`, Vitest loads two copies of itself and every file fails with `TypeError: Cannot read properties of undefined (reading 'config')`. In PowerShell: `Set-Location 'C:\Users\...\sf-flow-coverage'` first.

## Snapshots

Generated Apex is snapshot-tested in `test/core/__snapshots__/apexTemplate.test.ts.snap`. When a template change is intended, run `npx vitest run test/core/apexTemplate.test.ts -u`, then read the snapshot diff before committing: the generated Apex must still compile (watch for reserved words like `case`, `order`, `group` as variable names).

## Test layout

- `test/core/*.test.ts`: unit tests for `src/core`. Use `fakeSource`/`coverage` from `test/helpers.ts` instead of a real org.
- `test/commands/flowcov/commands.test.ts`: command tests with `TestContext({ setup: false })` and a mocked `OrgCoverageSource`.
- `test/gitRepo.ts`: `TempGitRepo` for tests that need real git history.
- `test/fixtures/project`: a DX project with one Flow per supported type.
