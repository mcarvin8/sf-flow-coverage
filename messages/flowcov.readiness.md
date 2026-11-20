# summary

Report how close the org is to the coverage needed to deploy Flows as active.

# description

Salesforce requires 75% of active autolaunched Flows and processes to be run by at least one Apex test before you can turn on "Deploy processes and flows as active". This command reads FlowTestCoverage from the target org, reports the org-wide percentage against the threshold, and lists the uncovered Flows (ranked by how often they change in git) and, for each covered Flow, the Apex tests that run it and the elements no test runs yet. Listing those elements takes one Tooling API query per partly covered Flow. Process Builder processes are labeled and counted, with a suggestion to migrate them to Flows, since Salesforce no longer supports Process Builder.

FlowTestCoverage is filled in when Apex tests run in the org. Run your Apex tests first with coverage turned on (for example, `sf apex run test --test-level RunLocalTests --code-coverage --wait 60`) so the report is current. Without `--code-coverage`, Salesforce records no Flow coverage. When no Flow in the org has any coverage recorded, the command warns that the tests most likely ran without `--code-coverage`.

# examples

- Report readiness for the default org:

  <%= config.bin %> <%= command.id %>

- Rank uncovered Flows by changes in the last 6 months:

  <%= config.bin %> <%= command.id %> --target-org prod --since "6 months ago"

- Fail a CI job unless the org is at or above 75%:

  <%= config.bin %> <%= command.id %> --target-org prod --fail-if-not-ready

# flags.project-dir.summary

Git repository used to rank uncovered Flows by how often they change.

# flags.since.summary

Only count commits after this date: a date (2026-01-31) or "<n> days|weeks|months|years ago".

# flags.threshold.summary

Coverage percentage the org must reach.

# flags.fail-if-not-ready.summary

Exit with code 1 when the org is below the threshold.
