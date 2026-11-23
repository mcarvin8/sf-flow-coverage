# sf-flow-coverage

[![NPM](https://img.shields.io/npm/v/sf-flow-coverage.svg?label=sf-flow-coverage)](https://www.npmjs.com/package/sf-flow-coverage)
[![Downloads/week](https://img.shields.io/npm/dw/sf-flow-coverage.svg)](https://npmjs.org/package/sf-flow-coverage)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](https://raw.githubusercontent.com/mcarvin8/sf-flow-coverage/refs/heads/main/LICENSE.md)
[![codecov](https://codecov.io/gh/mcarvin8/sf-flow-coverage/graph/badge.svg?token=7R49P3RQ47)](https://codecov.io/gh/mcarvin8/sf-flow-coverage)
[![Mutation testing badge](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fmcarvin8%2Fsf-flow-coverage%2Fmain)](https://dashboard.stryker-mutator.io/reports/github.com/mcarvin8/sf-flow-coverage/main)

Get your Salesforce org ready to deploy Flows as active.

Most production orgs deploy Flows as inactive and activate them by hand, because turning on **Deploy processes and flows as active** requires 75% Apex test coverage across every active autolaunched Flow and process, and few teams know how far they are from that bar. `sf-flow-coverage` shows you the gap and helps you close it: it reports your org-wide Flow coverage and which active Flows have none, generates starter Apex tests for uncovered Flows, adds a per-Flow coverage gate to pull requests so you stay above the threshold once the setting is on, and exports Flow coverage to SonarQube, Cobertura, and lcov so it shows up next to your Apex coverage. Salesforce only checks that the org-wide total stays above 75%, so a single Flow with no tests can still go live.

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>

  - [Requirements](#requirements)
  - [Install](#install)
  - [Quick start](#quick-start)
  - [How coverage is measured](#how-coverage-is-measured)
  - [Readiness report](#readiness-report)
  - [Pull request gate](#pull-request-gate)
  - [Test scaffolding](#test-scaffolding)
  - [Coverage reports](#coverage-reports)
  - [CLI Command Reference](#cli-command-reference)
  - [Programmatic API](#programmatic-api)
  - [Issues](#issues)
  - [License](#license)
</details>

---

## Requirements

- [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli)
- Node.js 22.22 or later
- An authenticated Salesforce org for `readiness`, `gate`, and `transform`. `scaffold` works without one, but with one it fills in required fields from the org.
- No `git` binary. Git history is read with [tsgit](https://github.com/scolladon/tsgit), a pure TypeScript git implementation. `gate --from` and the change counts in `readiness` still need to run inside a git repository checkout.

## Install

```bash
sf plugins install sf-flow-coverage@x.y.z
```

## Quick start

```bash
# 1. Run Apex tests so the org's Flow coverage is current
sf apex run test --test-level RunLocalTests --code-coverage --wait 60 --target-org prod

# 2. See how far you are from 75%, and which Flows to cover first
sf flowcov readiness --target-org prod --since "6 months ago"

# 3. Generate starter Apex tests for every uncovered Flow
sf flowcov scaffold --uncovered --target-org prod

# 4. In CI, after deploying the branch and running tests, require coverage for each changed Flow
sf flowcov gate --target-org ci-sandbox --from origin/main --to HEAD

# 5. Publish Flow coverage to SonarQube next to your Apex coverage
sf flowcov transform --target-org ci-sandbox --format sonar   # writes coverage/flow-coverage-sonar.xml
```

For the Apex side of step 5, see [Alongside Apex coverage](#alongside-apex-coverage).

## How coverage is measured

- **What counts.** Active Flows with the process types Salesforce counts toward deploy-as-active: autolaunched Flows (including record-triggered, platform event and schedule-triggered Flows) and Process Builder processes. Screen Flows don't count.
- **Where it comes from.** Salesforce records which Flow versions each Apex test runs in the Tooling API `FlowTestCoverage` object when Apex tests run in the org. `readiness`, `gate`, and `transform` read it, so run your Apex tests before using them.
- **Run tests with `--code-coverage`.** Without `--code-coverage`, `sf apex run test` skips coverage and Salesforce records no Flow coverage. Check-only deployments (`sf project deploy validate`) don't record it either. When no Flow in the org has any coverage, `readiness`, `gate`, and `transform` warn that this is the likely cause instead of just reporting 0%.
- **Only Apex counts.** Flow Builder tests and Flow Test Mode (Winter '27) don't count toward the 75% requirement, so `scaffold` generates Apex tests, not Flow test metadata. The coverage source is pluggable, so if Salesforce starts counting Test Mode coverage it can be added without changing the commands.

## Readiness report

`sf flowcov readiness` reports the org-wide percentage against the threshold and how many more Flows need a test to reach it. Uncovered Flows are ranked by how often their source file changed in git (run it from your Salesforce DX repo, or pass `--project-dir`), so the Flows most likely to be deployed next are at the top. Covered Flows list the Apex test methods that run them, their element coverage, and the elements no test runs yet. Process Builder processes are labeled, with a suggestion to migrate them to Flows (Salesforce no longer supports Process Builder) rather than write tests for them.

It also reads whether **Deploy processes and flows as active** is already on and says what to do: turn it on once production is ready, or keep coverage up so deployments of active Flows keep working. The setting only affects production, so in a sandbox or scratch org the report points you to production instead.

Pass `--fail-if-not-ready` to exit with code 1 below the threshold. For CI, see [Markdown output](#markdown-output).

## Pull request gate

`sf flowcov gate` checks every active autolaunched Flow or process that changed between `--from` and `--to` and fails if no Apex test runs it. Add `--min-element-coverage` to also require a share of each Flow's elements to be covered. Flows that don't count (screen Flows, drafts) are skipped.

Coverage is read from the target org, so in CI:

1. Deploy the branch to a sandbox or scratch org.
2. Run Apex tests there with `sf apex run test --code-coverage`.
3. Run the gate against that org.

The gate checks the Flow's active version in the org (or its latest version if none is active), and prints that version in the result. It fails a Flow when the org has no active version of it, or a newer inactive one: both usually mean the branch was deployed inactive. With `--from`, it also compares each changed Flow with the org's version, down to the content of each element, and warns (or, with `--content-check fail`, fails) when the branch wasn't deployed. The warning names the elements that differ, such as `changed: decisions:Is_Big`. A Flow that fails `--min-element-coverage` names the elements no test runs.

### Excluding Flows

To leave out Flows your team has chosen not to test yet, such as legacy Flows, add a `.flowcovignore` file to the project directory, or pass `--exclude`. Each line holds one pattern, with an optional `# reason` after it:

```text
# Deferred until the Q3 rewrite
Legacy_*
Close_Old_Cases  # replaced by Case_Closure next release
force-app/main/legacy/
```

A pattern without `/` matches Flow API names, ignoring case. A pattern with `/` matches file paths from the repository root, and a path ending in `/` matches everything under it. In patterns, `*` matches any characters except `/`, `**` matches any characters, and `?` matches one character. The gate skips an excluded Flow and gives the matching pattern as the reason. Exclusions only affect the gate: Salesforce still counts every active Flow toward the org-wide total.

## Markdown output

`readiness` and `gate` take `--output-format markdown`. With it, the report goes to standard output as one Markdown document, with its warnings included, so CI can post it as a pull request comment or add it to a GitHub Actions job summary:

```bash
sf flowcov gate --target-org ci-sandbox --from origin/main --output-format markdown >> "$GITHUB_STEP_SUMMARY"
```

The exit code is the same as with the default output, and `--json` takes precedence over both.

## Test scaffolding

`sf flowcov scaffold` reads each Flow's `.flow-meta.xml` from your project and writes `<Flow>_FlowTest.cls` to your default package directory's `main/default/classes` folder (or `--output-dir`).

| Flow type | Generated test |
| --- | --- |
| Record-triggered (create, update, delete) | Builds a record of the trigger object that meets the entry criteria, inserts, updates, or deletes it, and asserts what the Flow does (see below). Create-and-update Flows get one test method for each. |
| Autolaunched (no trigger) | Starts the Flow with `Flow.Interview.createInterview`, with a placeholder for every input variable (a different one for each text input, an address for each input a Send Email action sends to), inserts a record for each Delete Records element to find, and asserts the output variables it is certain to set. |
| Platform event | Publishes the event and delivers it with `Test.getEventBus().deliver()`. |
| Schedule-triggered | Starts the Flow directly, since Apex tests can't fire the schedule. |
| Process Builder | A placeholder test to fill in. |

Entry criteria are read as one condition, whether they are filters (with AND, OR, or custom logic such as `1 OR (2 AND 3)`) or a formula. The command meets one branch of an `OR`, `IF`, or `CASE`, and handles every filter operator, comparisons with literals, other fields, the Flow's constants and formula resources, custom labels (`$Label`), fields of the running user, their profile, and the org (`$User`, `$Profile`, `$Organization`), and `TODAY()`/`NOW()`/`DATE()`, `$Record__Prior` and `PRIORVALUE` in update tests, and `TEXT`, `LEN`, `UPPER`, `LOWER`, `TRIM`, and `VALUE` of a field (`LEN({!$Record.Name}) > 3` gets a name four characters long). Fields on related records, such as `{!$Record.Account__r.Type}` or `{!$Record.Contact__r.Account.Type}` up to five relationships away, are set on the parent records it inserts, each one looking up the next. Criteria that read a hierarchy custom setting through `$Setup`, such as a switch that turns the Flow on, get the setting's org-wide default inserted with the values they need, since a test sees no custom setting records it doesn't insert.

With a target org (`--target-org` or your default org), the command describes each object the test creates and fills in its required fields: text, numbers, dates, and the default picklist value. It meets "is not null" criteria by giving those fields a value, and fills required lookups with a parent record it inserts, up to five levels of parents deep (or the running user and their profile, the standard price book, the default business hours, one of the object's record types, or a public group or role it inserts as the running user, to keep setup records out of the test's own transaction). A required lookup it can't fill, such as two objects that each require the other, gets a TODO that says why. It also reads each object's active validation rules and gives every record the test saves the field values that keep a rule from blocking it, such as the status a rule exempts. When a rule needs a lookup filled, the command also describes the object it points to, so the test can insert a parent record for it. A rule it can't avoid gets a TODO that names it. Required lookup filters, on standard and custom lookup fields, work the same way: the parent records the test inserts get the field values the filter needs. The describe only shows fields the user running the command can see, so the command also warns about each field a Flow reads or writes that is missing from it, and lists them in a TODO at the top of the test. If the user who runs tests can't see those fields either, the Flow can fail with "Operation failed due to fields being inaccessible": grant access with a permission set assigned to that user. When a Flow submits its record for approval and other automation in the project (another Flow, or a Process Builder process) submits the same object's records when they are created, the test gets a TODO that names it: the record may already be in an approval process, so the submit fails with `ALREADY_IN_PROCESS`. The update test of any Flow gets the same kind of TODO when other automation submits the object's records both when they're created and when they're updated, since the test's update then submits a record its insert already submitted. Record fields that a Send Email action or an email alert sends to get a test address (or the running user, for user lookups), so the email doesn't fail with "0 recipients". When the record's restricted picklist values aren't allowed by the running user's default record type, the test uses a record type that allows them (read per record type from the UI API), and a record type the user can't use gets a TODO. Without an org, only common standard objects (Account, Contact, Opportunity, and so on) get required fields.

For record-triggered Flows, the command follows the Flow's elements for the record the test creates, deciding each decision the record settles. That includes formula resources, checkbox defaults, picklist defaults on objects without record types, and lookups on data the test doesn't create, which find nothing in an Apex test. It asserts the fields the Flow is certain to set and the records it is certain to create. When the Flow is certain to block the save with a custom error, the test expects that error, and a second test sets the fields that avoid it. What the Flow does only on a decision outcome it can't predict gets commented-out assertions.

Every generated test has TODOs for anything it couldn't fill in, such as entry criteria it couldn't meet and assertions it couldn't work out. Expect some generated tests to fail until you fill these in: a failure from the Flow's own validation still shows the Flow ran. Existing classes aren't overwritten unless you pass `--force`. The command says how many TODOs each class has, and `--json` lists them for each class (the test method, the kind, such as `validation rule` or `lookup filter`, and the text), so a script or a coding agent can work through them.

## Coverage reports

`sf flowcov transform` writes the org's Flow coverage as files other coverage tools read, so Flow coverage shows up next to Apex coverage in SonarQube, GitLab, Azure DevOps, or Codecov:

| `--format` | File | Read by |
| --- | --- | --- |
| `sonar` | `flow-coverage-sonar.xml` | SonarQube `sonar.coverageReportPaths` |
| `cobertura` | `flow-coverage-cobertura.xml` | GitLab, Azure DevOps, Codecov |
| `lcov` | `flow-coverage.info` | Codecov, Coveralls, most lcov tools |

Each executable element of a Flow becomes one line: the line of its `<name>` in the `.flow-meta.xml` file, covered when any Apex test ran it. A Flow's line coverage therefore equals its element coverage. Paths are relative to `--project-dir`. For SonarQube, the Flow files must be indexed (for example, `sonar.inclusions=**/*.cls,**/*.trigger,**/*.flow-meta.xml`) for their coverage to be imported.

The command warns when a Flow file's elements don't match the version the org covered, since the line numbers would then point at the wrong elements.

### Alongside Apex coverage

Salesforce reports Flow coverage separately from Apex coverage: the code coverage JSON from `sf apex run test` has Apex classes and triggers only. For the Apex side, [apex-code-coverage-transformer](https://github.com/mcarvin8/apex-code-coverage-transformer) converts that JSON into the same formats. Run both and give your coverage tool both files:

```bash
sf apex run test --test-level RunLocalTests --code-coverage --result-format json --output-dir coverage --wait 60 --target-org ci-sandbox
sf acc-transformer transform -j coverage/test-result-codecoverage.json -r coverage/apex-coverage-sonar.xml -f sonar
sf flowcov transform --target-org ci-sandbox --format sonar   # writes coverage/flow-coverage-sonar.xml
```

Then list both reports, comma-separated, in `sonar-project.properties`:

```properties
sonar.coverageReportPaths=coverage/apex-coverage-sonar.xml,coverage/flow-coverage-sonar.xml
```

Codecov, GitLab, and Azure DevOps take several Cobertura or lcov files in the same way.

## CLI Command Reference

<!-- commands -->
* [`sf flowcov gate`](#sf-flowcov-gate)
* [`sf flowcov readiness`](#sf-flowcov-readiness)
* [`sf flowcov scaffold`](#sf-flowcov-scaffold)
* [`sf flowcov transform`](#sf-flowcov-transform)

## `sf flowcov gate`

Require Apex test coverage for every Flow a pull request changes.

```
USAGE
  $ sf flowcov gate -o <value> [--json] [--flags-dir <value>] [--api-version <value>] [--from <value> | --flow
    <value>...] [--to <value>] [-d <value>] [--min-element-coverage <value>] [--content-check warn|fail|off] [--exclude
    <value>...] [--output-format human|markdown]

FLAGS
  -d, --project-dir=<value>           [default: .] Git repository to read changed Flows from.
  -o, --target-org=<value>            (required) Username or alias of the target org. Not required if the `target-org`
                                      configuration variable is already set.
      --api-version=<value>           Override the api version used for api requests made by this command
      --content-check=<option>        [default: warn] What to do when a changed Flow's content differs from the org's
                                      version.
                                      <options: warn|fail|off>
      --exclude=<value>...            Flow API name or file path pattern for a Flow the gate skips.
      --flow=<value>...               Flow API name to check. Use instead of --from to skip git.
      --from=<value>                  Git ref the pull request merges into (the gate compares from the merge base of
                                      this ref).
      --min-element-coverage=<value>  Minimum percentage of each Flow's elements that tests must run.
      --output-format=<option>        [default: human] Format of the report printed to standard output.
                                      <options: human|markdown>
      --to=<value>                    [default: HEAD] Git ref with the changes.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Require Apex test coverage for every Flow a pull request changes.

  Salesforce only checks that the org-wide total stays at or above 75%, so a single Flow with no tests can still be
  deployed as active. This gate checks each changed Flow on its own: every active autolaunched Flow or process changed
  between --from and --to must be run by at least one Apex test, and optionally reach a minimum element coverage.

  Coverage is read from FlowTestCoverage in the target org. Deploy the branch to the target org and run Apex tests there
  with `sf apex run test --code-coverage` before running the gate. Without `--code-coverage`, Salesforce records no Flow
  coverage. When no Flow in the org has any coverage recorded, the command warns that the tests most likely ran without
  `--code-coverage`. Flows that don't count toward deploy-as-active (screen Flows, inactive Flows) are skipped.

  The gate also fails a Flow when the org has no active version of it, or when its active version is older than its
  latest version. Both usually mean the branch was deployed inactive, so the org's coverage doesn't belong to the
  version in the pull request.

  With --from, the gate also compares each changed Flow at --to with the org's version: its process type, start element
  and entry criteria, Flow properties such as the API version and label, and each element and resource: which ones exist
  and what each one contains, such as a decision's conditions or an assignment's values. Canvas positions and Flow
  Builder's own settings are ignored. A difference usually means the branch wasn't deployed to the org. By default this
  is a warning; use --content-check to fail instead, or to skip the comparison.

  To leave out Flows a team has chosen not to test yet, such as legacy Flows, list them in a `.flowcovignore` file in
  --project-dir or pass --exclude. Excluded Flows are skipped, with the pattern that matched them as the reason.
  Exclusions only affect the gate: Salesforce still counts every active Flow toward the org-wide total that `sf flowcov
  readiness` reports.

  For a Flow that tests run only in part, the --json output lists the elements no test runs, and a Flow that fails
  --min-element-coverage names them in its reason.

  Exits with code 1 when any Flow fails.

EXAMPLES
  Check the Flows changed in a pull request:

    $ sf flowcov gate --target-org ci-sandbox --from origin/main --to HEAD

  Also require 60% element coverage per Flow:

    $ sf flowcov gate --target-org ci-sandbox --from origin/main --min-element-coverage 60

  Fail when the org runs a different version of a changed Flow than the branch:

    $ sf flowcov gate --target-org ci-sandbox --from origin/main --content-check fail

  Skip legacy Flows, and print the results as Markdown for a pull request comment or job summary:

    $ sf flowcov gate --target-org ci-sandbox --from origin/main --exclude "Legacy_*" --output-format markdown

  Check named Flows without git:

    $ sf flowcov gate --target-org ci-sandbox --flow Account_After_Save --flow Close_Cases

FLAG DESCRIPTIONS
  --content-check=warn|fail|off  What to do when a changed Flow's content differs from the org's version.

    "warn" prints a warning, "fail" fails a Flow that would otherwise pass, and "off" skips the comparison (and its one
    Tooling API query per Flow). Only applies with --from.

  --exclude=<value>...  Flow API name or file path pattern for a Flow the gate skips.

    A pattern without "/" matches Flow API names, ignoring case; a pattern with "/" matches file paths from the
    repository root. "*" matches any characters except "/", "**" matches any characters, and "?" matches one character.
    A path ending in "/" matches everything under it. Patterns add to those in .flowcovignore, which lists one pattern
    per line with an optional "# reason" after it:

    # Deferred until the Q3 rewrite
    Legacy_*
    Close_Old_Cases  # replaced by Case_Closure next release
    force-app/main/legacy/

  --output-format=human|markdown  Format of the report printed to standard output.

    "human" prints tables and warnings to the terminal. "markdown" prints the results as one Markdown document, warnings
    included, for a pull request comment or a GitHub Actions job summary. Redirect it to a file, for example `>>
    "$GITHUB_STEP_SUMMARY"`. --json takes precedence over both.
```

_See code: [src/commands/flowcov/gate.ts](https://github.com/mcarvin8/sf-flow-coverage/blob/main/src/commands/flowcov/gate.ts)_

## `sf flowcov readiness`

Report how close the org is to the coverage needed to deploy Flows as active.

```
USAGE
  $ sf flowcov readiness -o <value> [--json] [--flags-dir <value>] [--api-version <value>] [-d <value>] [--since
    <value>] [--threshold <value>] [--fail-if-not-ready] [--output-format human|markdown]

FLAGS
  -d, --project-dir=<value>     [default: .] Git repository used to rank uncovered Flows by how often they change.
  -o, --target-org=<value>      (required) Username or alias of the target org. Not required if the `target-org`
                                configuration variable is already set.
      --api-version=<value>     Override the api version used for api requests made by this command
      --fail-if-not-ready       Exit with code 1 when the org is below the threshold.
      --output-format=<option>  [default: human] Format of the report printed to standard output.
                                <options: human|markdown>
      --since=<value>           Only count commits after this date: a date (2026-01-31) or "<n> days|weeks|months|years
                                ago".
      --threshold=<value>       [default: 75] Coverage percentage the org must reach.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Report how close the org is to the coverage needed to deploy Flows as active.

  Salesforce requires 75% of active autolaunched Flows and processes to be run by at least one Apex test before you can
  turn on "Deploy processes and flows as active". This command reads FlowTestCoverage from the target org, reports the
  org-wide percentage against the threshold, and lists the uncovered Flows (ranked by how often they change in git) and,
  for each covered Flow, the Apex tests that run it and the elements no test runs yet. Listing those elements takes one
  Tooling API query per partly covered Flow. Process Builder processes are labeled and counted, with a suggestion to
  migrate them to Flows, since Salesforce no longer supports Process Builder.

  FlowTestCoverage is filled in when Apex tests run in the org. Run your Apex tests first with coverage turned on (for
  example, `sf apex run test --test-level RunLocalTests --code-coverage --wait 60`) so the report is current. Without
  `--code-coverage`, Salesforce records no Flow coverage. When no Flow in the org has any coverage recorded, the command
  warns that the tests most likely ran without `--code-coverage`.

  The report also says whether "Deploy processes and flows as active" is already on, and what that means: turn it on
  once the org is ready, or keep coverage up so deployments of active Flows keep working. The setting only affects
  production; in a sandbox or scratch org the report says so.

EXAMPLES
  Report readiness for the default org:

    $ sf flowcov readiness

  Rank uncovered Flows by changes in the last 6 months:

    $ sf flowcov readiness --target-org prod --since "6 months ago"

  Fail a CI job unless the org is at or above 75%:

    $ sf flowcov readiness --target-org prod --fail-if-not-ready

  Save the report as JSON:

    $ sf flowcov readiness --target-org prod --json > readiness.json

  Save the report as Markdown:

    $ sf flowcov readiness --target-org prod --output-format markdown > readiness.md

  Add the report to a GitHub Actions job summary:

    $ sf flowcov readiness --target-org prod --output-format markdown >> "$GITHUB_STEP_SUMMARY"

FLAG DESCRIPTIONS
  --output-format=human|markdown  Format of the report printed to standard output.

    "human" prints tables and warnings to the terminal. "markdown" prints the report as one Markdown document, warnings
    included, for a pull request comment or a GitHub Actions job summary. Redirect it to a file, for example `>>
    "$GITHUB_STEP_SUMMARY"`. --json takes precedence over both.
```

_See code: [src/commands/flowcov/readiness.ts](https://github.com/mcarvin8/sf-flow-coverage/blob/main/src/commands/flowcov/readiness.ts)_

## `sf flowcov scaffold`

Generate starter Apex tests for Flows.

```
USAGE
  $ sf flowcov scaffold [--json] [--flags-dir <value>] [-f <value>...] [--uncovered] [-o <value>] [--api-version
    <value>] [-d <value>] [-r <value>] [--force] [--dry-run]

FLAGS
  -d, --project-dir=<value>  [default: .] Salesforce DX project to read Flow metadata from.
  -f, --flow=<value>...      Flow API name to generate a test for.
  -o, --target-org=<value>   Org used to find uncovered Flows (--uncovered) and to describe objects so generated records
                             set their required fields.
  -r, --output-dir=<value>   Directory to write test classes to. Defaults to the default package directory's
                             main/default/classes.
      --api-version=<value>  Override the api version used for api requests made by this command
      --dry-run              Show what would be generated without writing files.
      --force                Overwrite test classes that already exist.
      --uncovered            Generate tests for every active Flow in the target org that no Apex test runs.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Generate starter Apex tests for Flows.

  Reads each Flow's metadata file from the project and writes an Apex test class named `<Flow>_FlowTest` that runs it:
  record-triggered Flows get a record built from the trigger object and entry criteria, autolaunched Flows are started
  with Flow.Interview and their input variables, and platform event Flows publish the event. When a target org is
  available (--target-org or a default org), the command describes each object the test creates and fills in its
  required fields, the fields the entry criteria need, and parent records (and their parents) for required lookups. It
  also reads each object's active validation rules: a record the test saves (the triggering record on insert and on
  update, parents, and input records) gets the field values that keep a rule from blocking it, and a rule it can't avoid
  gets a TODO that names it. Required lookup filters (on standard and custom lookups) are met the same way: a parent
  record the test inserts gets the field values the filter needs. The describe only shows fields you can see, so the
  command warns about each field a Flow uses that is missing from it, and lists them at the top of the test: if the user
  who runs tests can't see them either, the Flow can fail with "fields being inaccessible" until a permission set grants
  access.

  Entry criteria are read as one condition, whether they are filters (with AND, OR, or custom logic) or a formula. The
  command meets one branch of an OR, and handles comparisons with literals, other fields, `$User.Id`, and `TODAY()`;
  `$Record__Prior` values in update tests; and fields on related records, which it sets on the parent record it inserts.

  For record-triggered Flows, the command follows the Flow's elements for the record the test creates, deciding each
  decision the record settles (including formula resources, and lookups on data the test doesn't create, which find
  nothing in an Apex test). It asserts the fields the Flow is certain to set and the records it is certain to create.
  When the Flow is certain to stop the save with a custom error, the test expects that error, and a second test sets the
  fields that avoid it. For autolaunched Flows, it asserts output variables the Flow is certain to set. What the Flow
  does only on a decision outcome the command can't predict gets commented-out assertions. The generated tests have
  TODOs for anything the command can't fill in. The output gives each class's TODO count, and --json lists every TODO
  with its test method and kind.

  Only Apex tests count toward deploying Flows as active, so this command generates Apex, not Flow Builder tests.

EXAMPLES
  Generate a test for one Flow:

    $ sf flowcov scaffold --flow Account_After_Save

  Generate tests for every active Flow the org has no coverage for:

    $ sf flowcov scaffold --uncovered --target-org prod

  Preview without writing files:

    $ sf flowcov scaffold --flow Account_After_Save --dry-run
```

_See code: [src/commands/flowcov/scaffold.ts](https://github.com/mcarvin8/sf-flow-coverage/blob/main/src/commands/flowcov/scaffold.ts)_

## `sf flowcov transform`

Write Flow element coverage as SonarQube, Cobertura, or lcov coverage reports.

```
USAGE
  $ sf flowcov transform -o <value> --format sonar|cobertura|lcov... [--json] [--flags-dir <value>] [--api-version
    <value>] [--output-dir <value>] [-d <value>]

FLAGS
  -d, --project-dir=<value>  [default: .] Project root with the Flow metadata files. Report paths are relative to it.
  -o, --target-org=<value>   (required) Username or alias of the target org. Not required if the `target-org`
                             configuration variable is already set.
      --api-version=<value>  Override the api version used for api requests made by this command
      --format=<option>...   (required) Coverage format to write: sonar (SonarQube generic coverage), cobertura, or
                             lcov.
                             <options: sonar|cobertura|lcov>
      --output-dir=<value>   [default: coverage] Folder to write the coverage reports to.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Write Flow element coverage as SonarQube, Cobertura, or lcov coverage reports.

  Reads Flow coverage from the target org and maps it onto the project's Flow metadata files, so Flow coverage shows up
  next to Apex coverage in tools such as SonarQube, GitLab, Azure DevOps, or Codecov. Each executable element of a Flow
  (every element except the start element and resources such as variables and formulas) becomes one line: the line of
  its `<name>` in the `.flow-meta.xml` file, covered when any Apex test ran the element. A Flow's line coverage
  therefore equals its element coverage.

  Covers every active Flow and process that counts toward "Deploy processes and flows as active" and has a source file
  in the project. Paths in the reports are relative to --project-dir; run the command from the root your coverage tool
  expects. For SonarQube, the Flow files must be indexed (for example, include `**/*.flow-meta.xml` in
  `sonar.inclusions`) for their coverage to be imported.

  Coverage is read from FlowTestCoverage, which Salesforce fills in when Apex tests run in the org with coverage on (`sf
  apex run test --code-coverage`). Without `--code-coverage`, and in check-only deployments, Salesforce records no Flow
  coverage. When no Flow in the org has any coverage recorded, the command warns that the tests most likely ran without
  `--code-coverage`. When a Flow file's elements don't match the version the org covered, the command warns that its
  line coverage may be off.

EXAMPLES
  Write a SonarQube generic coverage report to the coverage folder:

    $ sf flowcov transform --target-org ci-sandbox --format sonar

  Write Cobertura and lcov reports to a folder of your choice:

    $ sf flowcov transform --target-org ci-sandbox --format cobertura --format lcov --output-dir reports
```

_See code: [src/commands/flowcov/transform.ts](https://github.com/mcarvin8/sf-flow-coverage/blob/main/src/commands/flowcov/transform.ts)_
<!-- commandsstop -->

## AI coding agent skill

Generated tests leave TODOs for what the command can't work out on its own. The `flowcov-fix-tests` [Agent Skill](https://agentskills.io) lets a coding agent work through them, in Claude Code, GitHub Copilot, or another agent that supports skills:

1. Run `sf flowcov scaffold --json` and read each class's TODOs.
2. Fill them in from the Flow's metadata, the validation rules, and the lookup filters.
3. Deploy the tests to a sandbox or scratch org and run them.
4. Fix failures caused by the test's data.
5. Report what needs a change in the org instead, such as field access or a record type assignment.

It works only in sandboxes and scratch orgs, and changes only the generated test classes.

```sh
# Claude Code (type these inside a Claude Code session)
/plugin marketplace add mcarvin8/sf-flow-coverage
/plugin install sf-flow-coverage@sf-flow-coverage

# GitHub Copilot CLI
copilot plugin marketplace add mcarvin8/sf-flow-coverage
copilot plugin install sf-flow-coverage@sf-flow-coverage

# Any agent, with the skills CLI
npx skills add mcarvin8/sf-flow-coverage
```

Then ask your agent to "fix the generated Flow tests" or "work through the flowcov TODOs". The agent reads your org's metadata and test results, so use an AI tool your organization allows for that org's data.

## Programmatic API

The core logic is exported for use in your own scripts:

```typescript
import { OrgCoverageSource, buildReadinessReport, toolingQuery } from 'sf-flow-coverage';
import { Org } from '@salesforce/core';

const org = await Org.create({ aliasOrUsername: 'prod' });
const source = new OrgCoverageSource(toolingQuery(org.getConnection()));
const report = await buildReadinessReport({ source });
console.log(`${report.coveragePercent}% of active Flows are covered`);
```

## Issues

Bugs or feature requests? Submit an [issue](https://github.com/mcarvin8/sf-flow-coverage/issues).

---

## License

[MIT](LICENSE.md)
