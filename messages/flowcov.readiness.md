# summary

Report how close the org is to the coverage needed to deploy Flows as active.

# description

Salesforce requires 75% of active autolaunched Flows and processes to be run by at least one Apex test before you can turn on "Deploy processes and flows as active". This command reads FlowTestCoverage from the target org, reports the org-wide percentage against the threshold, and lists the uncovered Flows (ranked by how often they change in git) and, for each covered Flow, the Apex tests that run it and the elements no test runs yet. Listing those elements takes one Tooling API query per partly covered Flow. Process Builder processes are labeled and counted, with a suggestion to migrate them to Flows, since Salesforce no longer supports Process Builder.

FlowTestCoverage is filled in when Apex tests run in the org. Run your Apex tests first with coverage turned on (for example, `sf apex run test --test-level RunLocalTests --code-coverage --wait 60`) so the report is current. Without `--code-coverage`, Salesforce records no Flow coverage. When no Flow in the org has any coverage recorded, the command warns that the tests most likely ran without `--code-coverage`.

The report also says whether "Deploy processes and flows as active" is already on, and what that means: turn it on once the org is ready, or keep coverage up so deployments of active Flows keep working. The setting only affects production; in a sandbox or scratch org the report says so.

# examples

- Report readiness for the default org:

  <%= config.bin %> <%= command.id %>

- Rank uncovered Flows by changes in the last 6 months:

  <%= config.bin %> <%= command.id %> --target-org prod --since "6 months ago"

- Fail a CI job unless the org is at or above 75%:

  <%= config.bin %> <%= command.id %> --target-org prod --fail-if-not-ready

- Add the report to a GitHub Actions job summary:

  <%= config.bin %> <%= command.id %> --target-org prod --output-format markdown >> "$GITHUB_STEP_SUMMARY"

# flags.project-dir.summary

Git repository used to rank uncovered Flows by how often they change.

# flags.since.summary

Only count commits after this date: a date (2026-01-31) or "<n> days|weeks|months|years ago".

# flags.threshold.summary

Coverage percentage the org must reach.

# flags.fail-if-not-ready.summary

Exit with code 1 when the org is below the threshold.

# flags.output-format.summary

Format of the report printed to standard output.

# flags.output-format.description

"human" prints tables and warnings to the terminal. "markdown" prints the report as one Markdown document, warnings included, for a pull request comment or a GitHub Actions job summary. Redirect it to a file, for example `>> "$GITHUB_STEP_SUMMARY"`. --json takes precedence over both.
