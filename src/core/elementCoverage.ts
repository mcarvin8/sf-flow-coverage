import { executableElements } from './flowFingerprint.js';
import type { CoverageSource, FlowCoverage, UncoveredElement } from './types.js';

/**
 * The elements of a covered Flow version that no Apex test ran, read from the version's content
 * in the org. Undefined for Flows no test runs (every element is uncovered), and when the
 * source can't read element coverage or the version's content.
 */
export async function findUncoveredElements(
  source: CoverageSource,
  flow: FlowCoverage,
): Promise<UncoveredElement[] | undefined> {
  if (!flow.covered) return undefined;
  if (flow.elementsTotal > 0 && flow.elementsCovered >= flow.elementsTotal) return [];
  if (!flow.coveredElementNames || !source.getFlowFingerprint) return undefined;
  const fingerprint = await source.getFlowFingerprint(flow.flowVersionId);
  if (!fingerprint) return undefined;
  // FlowElementTestCoverage reports element names in lower case.
  const covered = new Set(flow.coveredElementNames.map((name) => name.toLowerCase()));
  return executableElements(fingerprint).filter((element) => !covered.has(element.name.toLowerCase()));
}

const MAX_LISTED = 5;

/** `Name (type)` for each element, shortened after the first few. */
export function describeElements(elements: UncoveredElement[], max = MAX_LISTED): string {
  const shown = elements.slice(0, max).map((e) => `${e.name} (${e.type})`);
  return elements.length > max ? `${shown.join(', ')} and ${elements.length - max} more` : shown.join(', ');
}
