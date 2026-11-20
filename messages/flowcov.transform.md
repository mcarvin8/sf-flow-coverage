# summary

Write Flow element coverage as SonarQube, Cobertura, or lcov coverage reports.

# description

Reads Flow coverage from the target org and maps it onto the project's Flow metadata files, so Flow coverage shows up next to Apex coverage in tools such as SonarQube, GitLab, Azure DevOps, or Codecov. Each executable element of a Flow (every element except the start element and resources such as variables and formulas) becomes one line: the line of its `<name>` in the `.flow-meta.xml` file, covered when any Apex test ran the element. A Flow's line coverage therefore equals its element coverage.

Covers every active Flow and process that counts toward "Deploy processes and flows as active" and has a source file in the project. Paths in the reports are relative to --project-dir; run the command from the root your coverage tool expects. For SonarQube, the Flow files must be indexed (for example, include `**/*.flow-meta.xml` in `sonar.inclusions`) for their coverage to be imported.

Coverage is read from FlowTestCoverage, which Salesforce fills in when Apex tests run in the org with coverage on (`sf apex run test --code-coverage`). Without `--code-coverage`, and in check-only deployments, Salesforce records no Flow coverage. When a Flow file's elements don't match the version the org covered, the command warns that its line coverage may be off.

# examples

- Write a SonarQube generic coverage report to the coverage folder:

  <%= config.bin %> <%= command.id %> --target-org ci-sandbox --format sonar

- Write Cobertura and lcov reports to a folder of your choice:

  <%= config.bin %> <%= command.id %> --target-org ci-sandbox --format cobertura --format lcov --output-dir reports

# flags.format.summary

Coverage format to write: sonar (SonarQube generic coverage), cobertura, or lcov.

# flags.output-dir.summary

Folder to write the coverage reports to.

# flags.project-dir.summary

Project root with the Flow metadata files. Report paths are relative to it.
