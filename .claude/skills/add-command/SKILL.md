---
name: add-command
description: Add or change an `sf flowcov` command or flag in sf-flow-coverage. Use when creating a new subcommand (e.g. `sf flowcov transform`), adding a flag, or changing a command's output.
# Maintenance skill for this repo: hidden from the skills CLI, which installs only flowcov-fix-tests.
metadata:
  internal: true
---

# Adding a flowcov command

Commands stay thin. Logic lives in `src/core` where it's unit-tested without an org.

1. **Core logic**: `src/core/<feature>.ts`. Take a `CoverageSource` (see `src/core/types.ts`) rather than a connection, so tests can pass `fakeSource(...)`. Put shared result types in `src/core/types.ts`.
2. **Messages**: `messages/flowcov.<name>.md` with `# summary`, `# description`, `# examples` (use `<%= config.bin %> <%= command.id %>`), and `# flags.<flag>.summary` per flag. Write summaries as one plain sentence.
3. **Command**: `src/commands/flowcov/<name>.ts`, copying the shape of `gate.ts`:
   - `Messages.loadMessages('sf-flow-coverage', 'flowcov.<name>')`
   - `Flags.requiredOrg()` / `Flags.optionalOrg()` + `Flags.orgApiVersion()` when it reads the org; build the source with `new OrgCoverageSource(toolingQuery(connection))`.
   - Don't reuse `-o` (target-org) or `-d` (project-dir) for anything else.
   - Return a JSON-serializable result; for a failing check set `process.exitCode = 1` and still return the result so `--json` output is complete.
4. **Exports**: add public functions/types to `src/index.ts` and update the export list test in `test/core/toolingQuery.test.ts`.
5. **Tests**: unit tests in `test/core/`, command tests in `test/commands/flowcov/commands.test.ts`, and a NUT only if it can run without an org.
6. **Docs**: `npm run readme` regenerates the command reference; update the prose sections of `README.md` by hand.
7. Run the `verify` skill, then commit with the `commit` skill (`feat(<name>): ...`).

## Domain rules to keep

- Only Apex tests count toward deploy-as-active coverage. Don't generate Flow test metadata: it needs the Test Mode beta in every target org.
- Counted process types are in `COUNTED_PROCESS_TYPES` (`src/core/flowTypes.ts`). Screen Flows never count.
- Coverage comes from Tooling API `FlowTestCoverage`; it's only recorded when Apex tests run in the org with coverage on (`sf apex run test --code-coverage`). Plain `sf apex run test` and check-only deploys record none. Say so in any new command's description.
