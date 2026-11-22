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
- Meet the org's lookup filters on the records the test inserts, the way it already meets validation rules: read each lookup field's filter criteria from its metadata and solve them on the parent record.

## Generated tests in real orgs

Found by running generated tests in a large real org. Each one makes generated tests fail for reasons outside the Flow under test.

### 16. Report inaccessible fields

Tests fail with "Operation failed due to fields being inaccessible" when automation that runs in user mode touches fields the user running the tests can't access. The fix is on the org side: a permission set that grants access to those fields, assigned to the user who runs tests. Help by reporting which fields are affected, from the describe's field accessibility for the running user, in `readiness` or `scaffold`, instead of letting the tests fail without saying why.

### 17. Explain approval process conflicts

An update test's insert can already trigger automation that submits the record for approval, so when the Flow under test submits it too, the save fails with `ALREADY_IN_PROCESS`. Detect other Flows in the project that submit records of the same object on create, and add a TODO to the generated test that explains the conflict. Don't try to work around it: whether the insert should submit the record is the org's business rule.

### 18. Realistic data for autolaunched Flows

- Placeholder inputs can send a Flow into a loop until it hits the CPU limit, for example splitting a string on a placeholder delimiter. Give each text input a distinct placeholder.
- Delete Flows fail with "No records in Salesforce match your delete criteria" because the test has nothing to delete. Insert records that match the Flow's delete filters first.
- Send Email actions fail with no recipients. Fill in the email fields and addresses the Flow sends to.

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
