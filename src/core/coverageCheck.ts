import type { CoverageSource } from './types.js';

export const NO_COVERAGE_WARNING =
  'The org has no Flow coverage recorded for any Flow. Salesforce records Flow coverage only when Apex tests run with code coverage on, so the tests most likely ran without it: run them with `sf apex run test --test-level RunLocalTests --code-coverage --wait 60`, then run this command again. Check-only deployments (`sf project deploy validate`) record no coverage either.';

/**
 * A warning when the org has no Flow coverage at all, which usually means Apex tests ran without
 * `--code-coverage` rather than that no test runs a Flow. Only asks the org when `suspicious`
 * (results that look like missing coverage), so a healthy org pays no extra query.
 */
export async function missingCoverageWarning(source: CoverageSource, suspicious: boolean): Promise<string | undefined> {
  if (!suspicious || !source.hasAnyFlowCoverage) return undefined;
  return (await source.hasAnyFlowCoverage()) ? undefined : NO_COVERAGE_WARNING;
}
