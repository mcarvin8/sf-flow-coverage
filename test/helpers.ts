import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { CoverageSource, FlowCoverage } from '../src/core/types.js';

export const FIXTURE_PROJECT = resolve('test/fixtures/project');
export const FIXTURE_FLOWS = resolve(FIXTURE_PROJECT, 'force-app/main/default/flows');

export async function readFlowFixture(name: string): Promise<string> {
  return readFile(resolve(FIXTURE_FLOWS, `${name}.flow-meta.xml`), 'utf8');
}

export function coverage(flowName: string, overrides: Partial<FlowCoverage> = {}): FlowCoverage {
  const covered = overrides.covered ?? true;
  return {
    flowName,
    flowVersionId: `301000000000${flowName.length.toString().padStart(3, '0')}AAA`,
    versionNumber: 1,
    processType: 'AutoLaunchedFlow',
    status: 'Active',
    covered,
    elementsCovered: covered ? 4 : 0,
    elementsTotal: 5,
    elementCoveragePercent: covered ? 80 : 0,
    tests: covered ? [{ className: `${flowName}_Test`, methodName: 'runs' }] : [],
    ...overrides,
  };
}

export function fakeSource(flows: FlowCoverage[]): CoverageSource {
  return {
    listActiveCountedFlows: async () => flows,
    getFlowCoverage: async (names) => flows.filter((f) => names.includes(f.flowName)),
  };
}
