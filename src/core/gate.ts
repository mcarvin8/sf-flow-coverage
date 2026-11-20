import { missingCoverageWarning } from './coverageCheck.js';
import { describeElements, findUncoveredElements } from './elementCoverage.js';
import { compareFingerprints, type FlowFingerprint, fingerprintFromXml } from './flowFingerprint.js';
import {
  flowNameFromPath,
  isCountedProcessType,
  isProcessBuilder,
  PROCESS_BUILDER_ADVICE,
  processTypeLabel,
} from './flowTypes.js';
import { parseFlowXml } from './flowXml.js';
import { getChangedFlowFiles, showFileAtRevision } from './git.js';
import type { ContentCheck, CoverageSource, FlowCoverage, FlowMetadata, GateFlowResult, GateResult } from './types.js';

/** A Flow the gate should check. `metadata` is present when it came from a changed file. */
export type GateCandidate = {
  flowName: string;
  path?: string;
  metadata?: FlowMetadata;
  /** Content fingerprint of the changed file, compared with the org's version. */
  fingerprint?: FlowFingerprint;
  /** Why the changed file couldn't be read as a Flow; the gate fails it. */
  error?: string;
};

/** Reads the Flows changed between `from` and `to` (PR semantics: merge base of `from` to `to`). */
export async function collectChangedFlows(cwd: string, from: string, to: string): Promise<GateCandidate[]> {
  const files = await getChangedFlowFiles(cwd, from, to);
  const candidates: GateCandidate[] = [];
  for (const path of files) {
    const flowName = flowNameFromPath(path) as string;
    const xml = await showFileAtRevision(cwd, to, path);
    try {
      candidates.push({ flowName, path, metadata: parseFlowXml(flowName, xml), fingerprint: fingerprintFromXml(xml) });
    } catch (error) {
      candidates.push({ flowName, path, error: (error as Error).message });
    }
  }
  return candidates;
}

export type GateOptions = {
  source: CoverageSource;
  candidates: GateCandidate[];
  /** Minimum element coverage per Flow, 0-100. 0 means any covering test is enough. */
  minElementCoverage?: number;
  /** What to do when the org's version differs from the changed file. Defaults to `warn`. */
  contentCheck?: ContentCheck;
};

function coverageOutcome(flow: FlowCoverage, minElementCoverage: number): Pick<GateFlowResult, 'status' | 'reason'> {
  if (!flow.covered) {
    return { status: 'fail', reason: `No Apex test runs version ${flow.versionNumber ?? '?'} of this Flow.` };
  }
  if (flow.elementCoveragePercent < minElementCoverage) {
    return {
      status: 'fail',
      reason: `Element coverage ${flow.elementCoveragePercent}% is below the required ${minElementCoverage}%.`,
    };
  }
  return { status: 'pass', reason: `Covered by ${flow.tests.length} test method(s).` };
}

/** Describes how the org's version differs from the changed file, or undefined when it matches or can't be read. */
async function contentMismatch(
  source: CoverageSource,
  candidate: GateCandidate,
  flow: FlowCoverage,
): Promise<string | undefined> {
  if (!candidate.fingerprint || !source.getFlowFingerprint) return undefined;
  const orgFingerprint = await source.getFlowFingerprint(flow.flowVersionId);
  if (!orgFingerprint) return undefined;
  const differences = compareFingerprints(candidate.fingerprint, orgFingerprint);
  if (differences.length === 0) return undefined;
  return `The org's version ${flow.versionNumber ?? '?'} differs from ${candidate.path ?? 'source'} (${differences.join('; ')}), so coverage may be stale. Deploy the branch, run Apex tests, then rerun the gate.`;
}

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
 * Fails a Flow whose org versions suggest the branch was deployed inactive, since the coverage
 * read would then belong to an older version (or to none). When a candidate has a fingerprint,
 * also compares it with the org's version and warns (or fails) when they differ, which catches
 * a branch that was never deployed.
 */
export async function evaluateGate(options: GateOptions): Promise<GateResult> {
  const minElementCoverage = options.minElementCoverage ?? 0;
  const contentCheck = options.contentCheck ?? 'warn';
  const results: GateFlowResult[] = [];
  const toCheck: GateCandidate[] = [];

  for (const candidate of options.candidates) {
    if (candidate.error) {
      results.push({
        flowName: candidate.flowName,
        path: candidate.path,
        status: 'fail',
        reason: candidate.error,
        tests: [],
      });
      continue;
    }
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
    } else if (flow.versionState === 'noActiveVersion') {
      results.push({
        ...details,
        status: 'fail',
        reason: `No version of this Flow is active in the org (latest is version ${flow.versionNumber ?? '?'}, ${flow.status ?? 'inactive'}). Deploy it as active or activate it, run Apex tests, then rerun the gate.`,
      });
    } else if (flow.versionState === 'newerInactiveVersion') {
      results.push({
        ...details,
        status: 'fail',
        reason: `The org's active version ${flow.versionNumber ?? '?'} is older than its latest version ${flow.latestVersionNumber ?? '?'}, which is inactive, so coverage may be stale. Activate the latest version, run Apex tests, then rerun the gate.`,
      });
    } else {
      const result: GateFlowResult = { ...details, ...coverageOutcome(flow, minElementCoverage) };
      const uncovered = await findUncoveredElements(options.source, flow);
      if (uncovered) {
        result.uncoveredElements = uncovered;
        if (result.status === 'fail' && uncovered.length > 0) {
          result.reason = `${result.reason} Not run by any test: ${describeElements(uncovered)}.`;
        }
      }
      const mismatch = contentCheck === 'off' ? undefined : await contentMismatch(options.source, candidate, flow);
      if (mismatch && contentCheck === 'fail' && result.status === 'pass') {
        result.status = 'fail';
        result.reason = mismatch;
      } else if (mismatch) {
        result.warnings = [mismatch];
      }
      if (isProcessBuilder(flow.processType)) {
        result.warnings = [
          ...(result.warnings ?? []),
          `This is a ${processTypeLabel(flow.processType)} process. ${PROCESS_BUILDER_ADVICE}`,
        ];
      }
      results.push(result);
    }
  }

  // A changed Flow with no test is normal; every Flow in the org having none is not.
  const warning = await missingCoverageWarning(
    options.source,
    coverage.some((c) => isCountedProcessType(c.processType) && !c.covered),
  );
  return {
    passed: results.every((r) => r.status !== 'fail'),
    minElementCoverage,
    flows: results,
    warnings: warning ? [warning] : [],
  };
}
