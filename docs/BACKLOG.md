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

Entry criteria go through one condition engine: `AND`/`OR`/`NOT`/`IF`, comparisons with literals, other fields, `$User.Id`, and date functions, `$Record__Prior`, and fields one relationship away. Still left as TODOs:

- Functions on fields, such as `LEN({!$Record.Name}) > 3` or `TEXT(...)`, and `CASE`.
- Fields more than one relationship away (`{!$Record.Account__r.Owner.Name}`).

### 5. More filter operators

Every filter operator is handled, compared with a literal, another field, or `$User.Id`. Still left as TODOs:

- Filters compared with other resources, such as `$Setup` custom settings or `$Label`.

### 6. Deeper parent records

Required and `IsNull false` lookups get parent records up to three levels deep, polymorphic lookups use the running user or the first object a test can insert, and `RecordType` and `BusinessHours` lookups read what the org has. Still left as TODOs:

- `Profile`, `Group` (queues), and `UserRole` lookups, which need localized names or setup DML.
- Lookups back into their own chain (self-lookups) and parents past three levels.

### 7. Real assertions

Tests follow the Flow's elements and assert what it is certain to do: `$Record` fields, records it creates, output variables, and custom errors (with a second test that avoids the error). Decisions on formula resources, checkbox and picklist defaults, prior values, and empty lookups are decided. Next steps:

- Steer a test down a branch it would otherwise skip, so the Flow's other elements get covered (for example the branch that creates a Task when a crew is too small). Needs the solver to work backwards through formula resources.
- Assert updates to related records.
- Follow loops.

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
