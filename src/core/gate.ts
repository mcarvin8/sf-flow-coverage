import { flowNameFromPath, isCountedProcessType } from './flowTypes.js';
import { parseFlowXml } from './flowXml.js';
import { getChangedFlowFiles, showFileAtRevision } from './git.js';
import type { CoverageSource, FlowMetadata, GateFlowResult, GateResult } from './types.js';

/** A Flow the gate should check. `metadata` is present when it came from a changed file. */
export type GateCandidate = {
  flowName: string;
  path?: string;
  metadata?: FlowMetadata;
};

/** Reads the Flows changed between `from` and `to` (PR semantics: merge base of `from` to `to`). */
export async function collectChangedFlows(cwd: string, from: string, to: string): Promise<GateCandidate[]> {
  const files = await getChangedFlowFiles(cwd, from, to);
  const candidates: GateCandidate[] = [];
  for (const path of files) {
    const flowName = flowNameFromPath(path) as string;
    const xml = await showFileAtRevision(cwd, to, path);
    candidates.push({ flowName, path, metadata: parseFlowXml(flowName, xml) });
  }
  return candidates;
}

export type GateOptions = {
  source: CoverageSource;
  candidates: GateCandidate[];
  /** Minimum element coverage per Flow, 0-100. 0 means any covering test is enough. */
  minElementCoverage?: number;
};

function skipReason(metadata: FlowMetadata | undefined): string | undefined {
  if (!metadata) return undefined;
  if (!isCountedProcessType(metadata.processType)) {
    return `Process type ${metadata.processType ?? 'unknown'} does not count toward deploy-as-active coverage.`;
  }
  if (metadata.status && metadata.status !== 'Active') {
    return `Status is ${metadata.status}; only active Flows need coverage.`;
  }
  return undefined;
}

/**
 * Requires coverage for each changed Flow, not just the org-wide total Salesforce checks.
 * Coverage is read from the org, so run this after deploying the branch and running Apex tests.
 */
export async function evaluateGate(options: GateOptions): Promise<GateResult> {
  const minElementCoverage = options.minElementCoverage ?? 0;
  const results: GateFlowResult[] = [];
  const toCheck: GateCandidate[] = [];

  for (const candidate of options.candidates) {
    const reason = skipReason(candidate.metadata);
    if (reason) results.push({ flowName: candidate.flowName, path: candidate.path, status: 'skip', reason, tests: [] });
    else toCheck.push(candidate);
  }

  const coverage = await options.source.getFlowCoverage(toCheck.map((c) => c.flowName));
  const byName = new Map(coverage.map((c) => [c.flowName, c]));

  for (const candidate of toCheck) {
    const flow = byName.get(candidate.flowName);
    const base = { flowName: candidate.flowName, path: candidate.path };
    if (!flow) {
      results.push({
        ...base,
        status: 'fail',
        reason: 'Flow not found in the target org. Deploy the branch and run Apex tests before running the gate.',
        tests: [],
      });
      continue;
    }
    const details = {
      ...base,
      versionNumber: flow.versionNumber,
      elementCoveragePercent: flow.elementCoveragePercent,
      tests: flow.tests,
    };
    if (!isCountedProcessType(flow.processType)) {
      results.push({
        ...details,
        status: 'skip',
        reason: `Process type ${flow.processType} does not count toward deploy-as-active coverage.`,
      });
    } else if (!flow.covered) {
      results.push({
        ...details,
        status: 'fail',
        reason: `No Apex test runs version ${flow.versionNumber ?? '?'} of this Flow.`,
      });
    } else if (flow.elementCoveragePercent < minElementCoverage) {
      results.push({
        ...details,
        status: 'fail',
        reason: `Element coverage ${flow.elementCoveragePercent}% is below the required ${minElementCoverage}%.`,
      });
    } else {
      results.push({ ...details, status: 'pass', reason: `Covered by ${flow.tests.length} test method(s).` });
    }
  }

  return {
    passed: results.every((r) => r.status !== 'fail'),
    minElementCoverage,
    flows: results,
  };
}
