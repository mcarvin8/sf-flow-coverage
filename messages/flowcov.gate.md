# summary

Require Apex test coverage for every Flow a pull request changes.

# description

Salesforce only checks that the org-wide total stays at or above 75%, so a single Flow with no tests can still be deployed as active. This gate checks each changed Flow on its own: every active autolaunched Flow or process changed between --from and --to must be run by at least one Apex test, and optionally reach a minimum element coverage.

Coverage is read from FlowTestCoverage in the target org. Deploy the branch to the target org and run Apex tests there with `sf apex run test --code-coverage` before running the gate. Without `--code-coverage`, Salesforce records no Flow coverage. When no Flow in the org has any coverage recorded, the command warns that the tests most likely ran without `--code-coverage`. Flows that don't count toward deploy-as-active (screen Flows, inactive Flows) are skipped.

The gate also fails a Flow when the org has no active version of it, or when its active version is older than its latest version. Both usually mean the branch was deployed inactive, so the org's coverage doesn't belong to the version in the pull request.

With --from, the gate also compares each changed Flow at --to with the org's version: its process type, start element and entry criteria, Flow properties such as the API version and label, and each element and resource: which ones exist and what each one contains, such as a decision's conditions or an assignment's values. Canvas positions and Flow Builder's own settings are ignored. A difference usually means the branch wasn't deployed to the org. By default this is a warning; use --content-check to fail instead, or to skip the comparison.

To leave out Flows a team has chosen not to test yet, such as legacy Flows, list them in a `.flowcovignore` file in --project-dir or pass --exclude. Excluded Flows are skipped, with the pattern that matched them as the reason. Exclusions only affect the gate: Salesforce still counts every active Flow toward the org-wide total that `sf flowcov readiness` reports.

For a Flow that tests run only in part, the --json output lists the elements no test runs, and a Flow that fails --min-element-coverage names them in its reason.

Exits with code 1 when any Flow fails.

# examples

- Check the Flows changed in a pull request:

  <%= config.bin %> <%= command.id %> --target-org ci-sandbox --from origin/main --to HEAD

- Also require 60% element coverage per Flow:

  <%= config.bin %> <%= command.id %> --target-org ci-sandbox --from origin/main --min-element-coverage 60

- Fail when the org runs a different version of a changed Flow than the branch:

  <%= config.bin %> <%= command.id %> --target-org ci-sandbox --from origin/main --content-check fail

- Skip legacy Flows, and add the results to a GitHub Actions job summary:

  <%= config.bin %> <%= command.id %> --target-org ci-sandbox --from origin/main --exclude "Legacy_*" --output-format markdown >> "$GITHUB_STEP_SUMMARY"

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

# flags.content-check.summary

What to do when a changed Flow's content differs from the org's version.

# flags.content-check.description

"warn" prints a warning, "fail" fails a Flow that would otherwise pass, and "off" skips the comparison (and its one Tooling API query per Flow). Only applies with --from.

# flags.exclude.summary

Flow API name or file path pattern for a Flow the gate skips.

# flags.exclude.description

A pattern without "/" matches Flow API names, ignoring case; a pattern with "/" matches file paths from the repository root. "*" matches any characters except "/", "**" matches any characters, and "?" matches one character. A path ending in "/" matches everything under it. Patterns add to those in .flowcovignore, which lists one pattern per line with an optional "# reason" after it:

  # Deferred until the Q3 rewrite
  Legacy_*
  Close_Old_Cases  # replaced by Case_Closure next release
  force-app/main/legacy/

# error.noInput

Provide --from to check changed Flows, or --flow to check named Flows.

# flags.output-format.summary

Format of the report printed to standard output.

# flags.output-format.description

"human" prints tables and warnings to the terminal. "markdown" prints the results as one Markdown document, warnings included, for a pull request comment or a GitHub Actions job summary. Redirect it to a file, for example `>> "$GITHUB_STEP_SUMMARY"`. --json takes precedence over both.
