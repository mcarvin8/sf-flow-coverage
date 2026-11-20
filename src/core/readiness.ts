import { findUncoveredElements } from './elementCoverage.js';
import { DEFAULT_THRESHOLD, isProcessBuilder } from './flowTypes.js';
import type { CoverageSource, ReadinessFlow, ReadinessResult } from './types.js';

export type ReadinessOptions = {
  source: CoverageSource;
  /** Commit counts per Flow API name, used to rank uncovered Flows. */
  churn?: Map<string, number>;
  threshold?: number;
};

/**
 * Measures the org against the deploy-as-active coverage requirement: the share of
 * active autolaunched Flows and processes that at least one Apex test runs.
 */
export async function buildReadinessReport(options: ReadinessOptions): Promise<ReadinessResult> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const coverage = await options.source.listActiveCountedFlows();

  const flows: ReadinessFlow[] = [];
  for (const c of coverage) {
    // Sequential on purpose: one Tooling API query per partly covered Flow.
    const uncoveredElements = await findUncoveredElements(options.source, c);
    flows.push({
      flowName: c.flowName,
      processType: c.processType,
      versionNumber: c.versionNumber,
      covered: c.covered,
      elementCoveragePercent: c.elementCoveragePercent,
      tests: c.tests,
      changes: options.churn ? (options.churn.get(c.flowName) ?? 0) : undefined,
      ...(uncoveredElements ? { uncoveredElements } : {}),
    });
  }

  flows.sort(
    (a, b) =>
      Number(a.covered) - Number(b.covered) ||
      (b.changes ?? 0) - (a.changes ?? 0) ||
      a.flowName.localeCompare(b.flowName),
  );

  const totalFlows = flows.length;
  const coveredFlows = flows.filter((f) => f.covered).length;
  // With no active Flows to cover, Salesforce has nothing to block.
  const coveragePercent = totalFlows === 0 ? 100 : Math.round((coveredFlows / totalFlows) * 1000) / 10;
  const flowsNeeded = Math.max(0, Math.ceil((threshold * totalFlows) / 100) - coveredFlows);

  return {
    threshold,
    totalFlows,
    coveredFlows,
    uncoveredFlows: totalFlows - coveredFlows,
    coveragePercent,
    ready: flowsNeeded === 0,
    flowsNeeded,
    processBuilderProcesses: flows.filter((f) => isProcessBuilder(f.processType)).length,
    flows,
  };
}
