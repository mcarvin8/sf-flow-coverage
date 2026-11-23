import { missingCoverageWarning } from './coverageCheck.js';
import { findUncoveredElements } from './elementCoverage.js';
import { type DataQuery, type MetadataRead, readDeployAsActive, readIsSandbox } from './flowSettings.js';
import { DEFAULT_THRESHOLD, isProcessBuilder } from './flowTypes.js';
import type { CoverageSource, ReadinessFlow, ReadinessResult } from './types.js';

export type ReadinessOptions = {
  source: CoverageSource;
  /** Commit counts per Flow API name, used to rank uncovered Flows. */
  churn?: Map<string, number>;
  threshold?: number;
  /** Reads org settings, to report whether deploy-as-active is already on. */
  metadataRead?: MetadataRead;
  /** Queries org data, to tell production from sandboxes for the deploy-as-active advice. */
  dataQuery?: DataQuery;
};

/** Said under the covered Flows, since their element coverage reads like part of the requirement. */
export const ELEMENT_COVERAGE_NOTE =
  "Element coverage shows how much of each Flow the tests run. It doesn't count toward the threshold: a Flow counts once any test runs it.";

/**
 * The report's coverage lines: the headline the requirement goes by, then any details. `strong`
 * marks the percentage (bold in Markdown).
 */
export function coverageLines(result: ReadinessResult, strong = (text: string): string => text): string[] {
  const threshold = `Threshold: ${result.threshold}%.`;
  const lines =
    result.coveredInactiveVersions === 0
      ? [
          `Flow coverage: ${strong(`${result.coveragePercent}%`)} (${result.coveredFlows} of ${result.totalFlows} active Flows and processes have a test). ${threshold}`,
        ]
      : [
          `Flow coverage: ${strong(`${result.salesforceCoveragePercent}%`)} as Salesforce calculates it (${result.coveredFlows + result.coveredInactiveVersions} of ${result.totalFlows + result.coveredInactiveVersions} Flows: ${result.coveredFlows} active and ${result.coveredInactiveVersions} inactive with a test, ${result.uncoveredFlows} active without one). ${threshold}`,
          `Active Flows with a test: ${result.coveragePercent}% (${result.coveredFlows} of ${result.totalFlows}). Salesforce also counts the latest inactive versions that have a test.`,
        ];
  if (result.thresholdAssumed) {
    lines.push(
      `${result.threshold}% is the usual requirement. Production's Process Automation Settings set the actual percentage: pass --threshold if it differs.`,
    );
  }
  return lines;
}

/**
 * Measures the org against the deploy-as-active coverage requirement the way Salesforce
 * calculates it: the Flow versions an Apex test covers (active ones, and latest inactive ones),
 * divided by the active versions without coverage plus the versions with coverage. A Flow counts
 * once any test runs it; how many of its elements run doesn't matter.
 */
export async function buildReadinessReport(options: ReadinessOptions): Promise<ReadinessResult> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const coveredInactiveVersions = (await options.source.countCoveredInactiveVersions?.()) ?? 0;
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
  // Covering an active Flow moves it from the uncovered part of the denominator to the covered
  // part, so the denominator stays the same.
  const covered = coveredFlows + coveredInactiveVersions;
  const counted = totalFlows + coveredInactiveVersions;
  const salesforceCoveragePercent = counted === 0 ? 100 : Math.round((covered / counted) * 1000) / 10;
  const flowsNeeded = Math.max(0, Math.ceil((threshold * counted) / 100) - covered);
  const warning = await missingCoverageWarning(options.source, totalFlows > 0 && coveredFlows === 0);

  return {
    threshold,
    thresholdAssumed: options.threshold === undefined,
    totalFlows,
    coveredFlows,
    uncoveredFlows: totalFlows - coveredFlows,
    coveragePercent,
    salesforceCoveragePercent,
    coveredInactiveVersions,
    ready: flowsNeeded === 0,
    flowsNeeded,
    processBuilderProcesses: flows.filter((f) => isProcessBuilder(f.processType)).length,
    flows,
    deployAsActive: options.metadataRead ? await readDeployAsActive(options.metadataRead) : undefined,
    isSandbox: options.dataQuery ? await readIsSandbox(options.dataQuery) : undefined,
    warnings: warning ? [warning] : [],
  };
}
