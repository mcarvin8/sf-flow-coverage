# Backlog

Ideas for sf-flow-coverage, ordered by value within each section. Open an issue before starting anything large. Item numbers stay fixed because pull requests refer to them, so removed items leave gaps.

Suggested first pick: [Markdown output](#9-markdown-output).

## Gaps found in live testing

### 1. Warn when coverage is missing entirely

Done: when results look like missing coverage (no active Flow covered in `readiness` and `transform`, an uncovered Flow in `gate`) and the org has no `FlowTestCoverage` rows at all, the commands warn that tests most likely ran without `--code-coverage` and name the fix.

### 2. Deeper version comparison in the gate

The gate fails when the org has no active version or a newer inactive one, and `--content-check` compares process type, start trigger, entry criteria, and element names with the file at `--to`. It still misses a change that only edits an existing element (a new decision condition, a changed assignment value). Extend the fingerprint into element bodies, normalizing the Tooling API's JSON and the source XML the same way (defaults, nulls, value types, ordering) so matching versions don't warn.

### 3. Show the deploy-as-active setting in readiness

Done: `readiness` reads `FlowSettings.enableFlowDeployAsActiveEnabled` and `Organization.IsSandbox`, and says whether the org is working toward the setting or protecting it (or, in a sandbox, that the setting only applies to production).

## Scaffold: fewer TODOs

### 4. More entry-criteria formulas

`AND(...)` of simple terms on `$Record` fields (`ISPICKVAL`, `ISBLANK`, `ISCHANGED`, comparisons with a literal, checkboxes) is handled. Still left as TODOs:

- `OR(...)` and `IF(...)`: meet one branch.
- Cross-object fields (`{!$Record.Account.Type}`) and `$Record__Prior`.
- Function calls such as `TODAY()` or `DATE(2026, 1, 31)` in comparisons.

### 5. More filter operators

Comparisons, `Contains`/`StartsWith`/`EndsWith`, and `IsChanged` are handled. Still left as TODOs:

- `NotEqualTo`: use a described value that differs from the literal.
- Filters compared with another field or a resource (`$Record.Max__c`, `$User.Id`) instead of a literal.

### 6. Deeper parent records

Required and `IsNull false` lookups get a parent record (or the running user, or the standard price book). Still left as TODOs:

- A parent's own required lookups (parents are one level deep).
- Polymorphic lookups (`WhatId`) and setup objects (`RecordType`, `Profile`, `Group`).

### 7. Real assertions

Record-triggered tests now follow the Flow's elements: they assert the `$Record` fields the Flow is certain to set, expect a custom error the Flow is certain to raise, and comment out assertions for decision outcomes they can't predict. Next steps:

- When a test expects a custom error, add a second test that sets the fields the decision checks so the save succeeds.
- Decide more decisions: picklist defaults (only safe when the object has no record types that change them), checkbox defaults, and formula resources.
- Assert records the Flow creates (for example a Task) and updates to related records.
- Assert output variables of autolaunched Flows started with `Flow.Interview`.

## CI and reporting

### 8. `sf flowcov transform`

Done: writes SonarQube generic, Cobertura, and lcov reports, one line per element. Possible next steps: decision outcomes as branches (Cobertura `branch-rate`, lcov `BRDA`) if Salesforce ever reports which outcomes ran, and merging with Apex coverage reports into a single file.

### 9. Markdown output

Add `--output-format markdown` (or write to `$GITHUB_STEP_SUMMARY`) for `readiness` and `gate`, so CI can post results as a pull request comment or job summary.

### 11. Gate exclusions

Support a `.flowcovignore` file or `--exclude` flag for legacy Flows a team has deliberately deferred.

## Smaller items

### 12. List uncovered elements

Done: `readiness` and `gate` list the elements no test ran, compared with the org version's content. `transform` (#8) builds on the same element coverage.

### 13. Process Builder notice

Done: `readiness` labels Process Builder processes (`Workflow`, `CustomEvent`, and `InvocableProcess` process types), counts them, and suggests migrating them with Migrate to Flow; `gate` warns on a changed process, and `scaffold`'s placeholder test says the same.

### 15. Flow Test Mode

When Flow Test Mode leaves beta, check whether its coverage can be queried or counts toward the deploy-as-active requirement. If so, add a second `CoverageSource` implementation. Don't generate Flow test metadata until then: it requires the beta in every target org.

## Not planned

Kept so the reasoning isn't lost if they come up again.

- **10. Native GitHub Action.** `@salesforce/core` logs with pino, which breaks inside a bundled, frozen GitHub Action. The plugin already runs in any CI that has the Salesforce CLI.
- **14. Core package.** Every useful result needs an authenticated org connection, which the CLI provides. Scripts that already have a connection can use the plugin's exported functions (`src/index.ts`); `OrgCoverageSource` only needs a Tooling API query function.
