# Backlog

Ideas for sf-flow-coverage, ordered by value within each section. Open an issue before starting anything large.

Suggested first picks: [Warn when coverage is missing entirely](#1-warn-when-coverage-is-missing-entirely), [Real assertions](#7-real-assertions), and [`sf flowcov transform`](#8-sf-flowcov-transform).

## Gaps found in live testing

### 1. Warn when coverage is missing entirely

If no active Flow version in the org has any `FlowTestCoverage` rows, the tests were most likely run without `--code-coverage`. Today `readiness` and `gate` just report 0%. Print a warning that names the fix (`sf apex run test --code-coverage`).

### 2. Deeper version comparison in the gate

The gate fails when the org has no active version or a newer inactive one, and `--content-check` compares process type, start trigger, entry criteria, and element names with the file at `--to`. It still misses a change that only edits an existing element (a new decision condition, a changed assignment value). Extend the fingerprint into element bodies, normalizing the Tooling API's JSON and the source XML the same way (defaults, nulls, value types, ordering) so matching versions don't warn.

### 3. Show the deploy-as-active setting in readiness

Read `FlowSettings` and report whether "Deploy processes and flows as active" is already on, so users know whether they are working toward the setting or protecting it.

## Scaffold: fewer TODOs

### 4. Simple entry-criteria formulas

Handle `AND(...)` of `ISPICKVAL(field, "value")`, `NOT(ISBLANK(field))`, and `field = literal`. Example from a real org:

```
AND(
  NOT(ISBLANK({!$Record.Crew_Size__c})),
  NOT(ISBLANK({!$Record.Install_Date__c})),
  ISPICKVAL({!$Record.Status__c}, "Planned")
)
```

### 5. More filter operators

- `GreaterThan` / `LessThan` (and the `OrEqualTo` forms): pick a value past the bound.
- `IsChanged`: set a different value in the update test.
- `Contains`, `StartsWith`, `EndsWith`: build a matching string.

### 6. Parent records for lookups

For a required or `IsNull false` lookup (for example `Account__c`), insert the parent record with its own required fields filled, and use its Id instead of leaving a TODO.

### 7. Real assertions

Read the Flow's record updates and assignments on `$Record`, then assert those fields after the DML, replacing the placeholder `Assert.isNotNull`. Of everything here, this makes generated tests most useful.

## CI and reporting

### 8. `sf flowcov transform`

Convert Flow coverage into SonarQube generic, Cobertura, or lcov format, so Flow coverage shows up next to Apex coverage in existing tools.

### 9. Markdown output

Add `--output-format markdown` (or write to `$GITHUB_STEP_SUMMARY`) for `readiness` and `gate`, so CI can post results as a pull request comment or job summary.

### 10. Native GitHub Action

Run the gate as a GitHub Action, following sf-package-combiner's setup (bundled `dist/action`, floating major tag).

### 11. Gate exclusions

Support a `.flowcovignore` file or `--exclude` flag for legacy Flows a team has deliberately deferred.

## Smaller items

### 12. List uncovered elements

Compare the Flow XML's elements with `FlowElementTestCoverage` and list the elements no test ran, in `readiness` and in `gate` failures.

### 13. Process Builder notice

Mark Process Builder processes (`Workflow` process type) in `readiness` and suggest migrating them, since Salesforce has retired Process Builder.

### 14. Core package

Publish the programmatic API as a dependency-free package, like `sf-package-combiner-core`, if there's demand for using it outside the CLI.

### 15. Flow Test Mode

When Flow Test Mode leaves beta, check whether its coverage can be queried or counts toward the deploy-as-active requirement. If so, add a second `CoverageSource` implementation. Don't generate Flow test metadata until then: it requires the beta in every target org.
