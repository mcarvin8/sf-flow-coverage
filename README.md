# sf-flow-coverage

[![NPM](https://img.shields.io/npm/v/sf-flow-coverage.svg?label=sf-flow-coverage)](https://www.npmjs.com/package/sf-flow-coverage)
[![Downloads/week](https://img.shields.io/npm/dw/sf-flow-coverage.svg)](https://npmjs.org/package/sf-flow-coverage)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](https://raw.githubusercontent.com/mcarvin8/sf-flow-coverage/refs/heads/main/LICENSE.md)

Get your Salesforce org ready to deploy Flows as active.

Most production orgs deploy Flows as inactive and activate them by hand, because turning on **Deploy processes and flows as active** requires 75% Apex test coverage across every active autolaunched Flow and process, and few teams know how far they are from that bar. `sf-flow-coverage` shows you the gap and helps you close it: it reports your org-wide Flow coverage and which active Flows have none, generates starter Apex tests for uncovered Flows, and adds a per-Flow coverage gate to pull requests so you stay above the threshold once the setting is on. Salesforce only checks that the org-wide total stays above 75%, so a single Flow with no tests can still go live.

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>

  - [Install](#install)
  - [Quick start](#quick-start)
  - [How coverage is measured](#how-coverage-is-measured)
  - [Readiness report](#readiness-report)
  - [Pull request gate](#pull-request-gate)
  - [Test scaffolding](#test-scaffolding)
  - [CLI Command Reference](#cli-command-reference)
  - [Programmatic API](#programmatic-api)
  - [Issues](#issues)
  - [License](#license)
</details>

---

## Install

Requires the [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) and Node.js 22.19 or later.

```bash
sf plugins install sf-flow-coverage@x.y.z
```

## Quick start

```bash
# 1. Run Apex tests so the org's Flow coverage is current
sf apex run test --test-level RunLocalTests --wait 60 --target-org prod

# 2. See how far you are from 75%, and which Flows to cover first
sf flowcov readiness --target-org prod --since "6 months ago"

# 3. Generate starter Apex tests for every uncovered Flow
sf flowcov scaffold --uncovered --target-org prod

# 4. In CI, after deploying the branch and running tests, require coverage for each changed Flow
sf flowcov gate --target-org ci-sandbox --from origin/main --to HEAD
```

## How coverage is measured

- **What counts.** Active Flows with the process types Salesforce counts toward deploy-as-active: autolaunched Flows (including record-triggered, platform event and schedule-triggered Flows) and Process Builder processes. Screen Flows don't count.
- **Where it comes from.** Salesforce records which Flow versions each Apex test runs in the Tooling API `FlowTestCoverage` object when Apex tests run in the org. All three commands read it, so run your Apex tests before using them. Check-only deployments (`sf project deploy validate`) run tests but don't record Flow coverage, so use `sf apex run test` or a real deployment.
- **Only Apex counts.** Flow Builder tests and Flow Test Mode (Winter '27) don't count toward the 75% requirement, so `scaffold` generates Apex tests, not Flow test metadata. The coverage source is pluggable, so if Salesforce starts counting Test Mode coverage it can be added without changing the commands.

## Readiness report

`sf flowcov readiness` reports the org-wide percentage against the threshold and how many more Flows need a test to reach it. Uncovered Flows are ranked by how often their source file changed in git (run it from your Salesforce DX repo, or pass `--project-dir`), so the Flows most likely to be deployed next are at the top. Covered Flows list the Apex test methods that run them and their element coverage.

Pass `--fail-if-not-ready` to exit with code 1 below the threshold.

## Pull request gate

`sf flowcov gate` checks every active autolaunched Flow or process that changed between `--from` and `--to` and fails if no Apex test runs it. Add `--min-element-coverage` to also require a share of each Flow's elements to be covered. Flows that don't count (screen Flows, drafts) are skipped.

Coverage is read from the target org, so in CI:

1. Deploy the branch to a sandbox or scratch org.
2. Run Apex tests there.
3. Run the gate against that org.

The gate checks the Flow's active version in the org (or its latest version if none is active), and prints that version in the result.

## Test scaffolding

`sf flowcov scaffold` reads each Flow's `.flow-meta.xml` from your project and writes `<Flow>_FlowTest.cls` to your default package directory's `main/default/classes` folder (or `--output-dir`).

| Flow type | Generated test |
| --- | --- |
| Record-triggered (create, update, delete) | Builds a record of the trigger object, sets entry criteria that are simple `EqualTo` filters, and inserts, updates, or deletes it. Create-and-update Flows get one test method for each. |
| Autolaunched (no trigger) | Starts the Flow with `Flow.Interview.createInterview`, with a placeholder for every input variable and a read of every output variable. |
| Platform event | Publishes the event and delivers it with `Test.getEventBus().deliver()`. |
| Schedule-triggered | Starts the Flow directly, since Apex tests can't fire the schedule. |
| Process Builder | A placeholder test to fill in. |

With a target org (`--target-org` or your default org), the command describes each object the test creates and fills in its required fields: text, numbers, dates, and the default picklist value. Lookups it can't make up are left as TODOs. Without an org, only common standard objects (Account, Contact, Opportunity, and so on) get required fields.

Every generated test has TODOs for anything it couldn't fill in, entry criteria it couldn't set (formulas, cross-object fields), and real assertions. Expect some generated tests to fail until you fill these in: a failure from the Flow's own validation still shows the Flow ran. Existing classes aren't overwritten unless you pass `--force`.

## CLI Command Reference

<!-- commands -->
* [`sf flowcov gate`](#sf-flowcov-gate)
* [`sf flowcov readiness`](#sf-flowcov-readiness)
* [`sf flowcov scaffold`](#sf-flowcov-scaffold)

## `sf flowcov gate`

Require Apex test coverage for every Flow a pull request changes.

```
USAGE
  $ sf flowcov gate -o <value> [--json] [--flags-dir <value>] [--api-version <value>] [--from <value> | --flow
    <value>...] [--to <value>] [-d <value>] [--min-element-coverage <value>]

FLAGS
  -d, --project-dir=<value>           [default: .] Git repository to read changed Flows from.
  -o, --target-org=<value>            (required) Username or alias of the target org. Not required if the `target-org`
                                      configuration variable is already set.
      --api-version=<value>           Override the api version used for api requests made by this command
      --flow=<value>...               Flow API name to check. Use instead of --from to skip git.
      --from=<value>                  Git ref the pull request merges into (the gate compares from the merge base of
                                      this ref).
      --min-element-coverage=<value>  Minimum percentage of each Flow's elements that tests must run.
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
  before running the gate. Flows that don't count toward deploy-as-active (screen Flows, inactive Flows) are skipped.

  Exits with code 1 when any Flow fails.

EXAMPLES
  Check the Flows changed in a pull request:

    $ sf flowcov gate --target-org ci-sandbox --from origin/main --to HEAD

  Also require 60% element coverage per Flow:

    $ sf flowcov gate --target-org ci-sandbox --from origin/main --min-element-coverage 60

  Check named Flows without git:

    $ sf flowcov gate --target-org ci-sandbox --flow Account_After_Save --flow Close_Cases
```

_See code: [src/commands/flowcov/gate.ts](https://github.com/mcarvin8/sf-flow-coverage/blob/v0.0.0/src/commands/flowcov/gate.ts)_

## `sf flowcov readiness`

Report how close the org is to the coverage needed to deploy Flows as active.

```
USAGE
  $ sf flowcov readiness -o <value> [--json] [--flags-dir <value>] [--api-version <value>] [-d <value>] [--since
    <value>] [--threshold <value>] [--fail-if-not-ready]

FLAGS
  -d, --project-dir=<value>  [default: .] Git repository used to rank uncovered Flows by how often they change.
  -o, --target-org=<value>   (required) Username or alias of the target org. Not required if the `target-org`
                             configuration variable is already set.
      --api-version=<value>  Override the api version used for api requests made by this command
      --fail-if-not-ready    Exit with code 1 when the org is below the threshold.
      --since=<value>        Only count commits after this date (any value `git log --since` accepts).
      --threshold=<value>    [default: 75] Coverage percentage the org must reach.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Report how close the org is to the coverage needed to deploy Flows as active.

  Salesforce requires 75% of active autolaunched Flows and processes to be run by at least one Apex test before you can
  turn on "Deploy processes and flows as active". This command reads FlowTestCoverage from the target org, reports the
  org-wide percentage against the threshold, and lists the uncovered Flows (ranked by how often they change in git) and
  the Apex tests that already run each covered Flow.

  FlowTestCoverage is filled in when Apex tests run in the org. Run your Apex tests first (for example, `sf apex run
  test --test-level RunLocalTests --wait 60`) so the report is current.

EXAMPLES
  Report readiness for the default org:

    $ sf flowcov readiness

  Rank uncovered Flows by changes in the last 6 months:

    $ sf flowcov readiness --target-org prod --since "6 months ago"

  Fail a CI job unless the org is at or above 75%:

    $ sf flowcov readiness --target-org prod --fail-if-not-ready
```

_See code: [src/commands/flowcov/readiness.ts](https://github.com/mcarvin8/sf-flow-coverage/blob/v0.0.0/src/commands/flowcov/readiness.ts)_

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
  required fields. The generated tests have TODOs for anything it can't fill in and placeholder assertions.

  Only Apex tests count toward deploying Flows as active, so this command generates Apex, not Flow Builder tests.

EXAMPLES
  Generate a test for one Flow:

    $ sf flowcov scaffold --flow Account_After_Save

  Generate tests for every active Flow the org has no coverage for:

    $ sf flowcov scaffold --uncovered --target-org prod

  Preview without writing files:

    $ sf flowcov scaffold --flow Account_After_Save --dry-run
```

_See code: [src/commands/flowcov/scaffold.ts](https://github.com/mcarvin8/sf-flow-coverage/blob/v0.0.0/src/commands/flowcov/scaffold.ts)_
<!-- commandsstop -->

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
