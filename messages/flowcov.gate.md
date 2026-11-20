# summary

Require Apex test coverage for every Flow a pull request changes.

# description

Salesforce only checks that the org-wide total stays at or above 75%, so a single Flow with no tests can still be deployed as active. This gate checks each changed Flow on its own: every active autolaunched Flow or process changed between --from and --to must be run by at least one Apex test, and optionally reach a minimum element coverage.

Coverage is read from FlowTestCoverage in the target org. Deploy the branch to the target org and run Apex tests there with `sf apex run test --code-coverage` before running the gate. Without `--code-coverage`, Salesforce records no Flow coverage. Flows that don't count toward deploy-as-active (screen Flows, inactive Flows) are skipped.

Exits with code 1 when any Flow fails.

# examples

- Check the Flows changed in a pull request:

  <%= config.bin %> <%= command.id %> --target-org ci-sandbox --from origin/main --to HEAD

- Also require 60% element coverage per Flow:

  <%= config.bin %> <%= command.id %> --target-org ci-sandbox --from origin/main --min-element-coverage 60

- Check named Flows without git:

  <%= config.bin %> <%= command.id %> --target-org ci-sandbox --flow Account_After_Save --flow Close_Cases

# flags.from.summary

Git ref the pull request merges into (the gate compares from the merge base of this ref).

# flags.to.summary

Git ref with the changes.

# flags.flow.summary

Flow API name to check. Use instead of --from to skip git.

# flags.project-dir.summary

Git repository to read changed Flows from.

# flags.min-element-coverage.summary

Minimum percentage of each Flow's elements that tests must run.

# error.noInput

Provide --from to check changed Flows, or --flow to check named Flows.
