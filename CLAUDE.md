# sf-flow-coverage

Salesforce CLI plugin (`sf flowcov readiness | gate | scaffold`) that gets orgs ready to deploy Flows as active.

- Logic in `src/core`, thin oclif commands in `src/commands/flowcov`, help text in `messages/*.md`.
- Tooling: npm, Biome, Vitest, knip, wireit, husky + commitlint, release-please. No ESLint, Prettier, Mocha, nyc, or yarn.
- Never add Claude/AI attribution (Co-Authored-By trailers, "Generated with Claude Code") to commits or PRs.

Skills in `.claude/skills`:

- `commit`: Conventional Commits, hooks, no attribution.
- `pull-request`: PR title/description, no attribution.
- `verify`: build, lint, test, snapshots, Windows Vitest gotcha.
- `add-command`: adding or changing a `flowcov` command.
