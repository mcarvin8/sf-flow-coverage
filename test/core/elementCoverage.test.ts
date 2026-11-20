import { describe, expect, it } from 'vitest';

import { describeElements, findUncoveredElements } from '../../src/core/elementCoverage.js';
import { executableElements, type FlowFingerprint } from '../../src/core/flowFingerprint.js';
import type { CoverageSource } from '../../src/core/types.js';
import { coverage, fakeSource } from '../helpers.js';

const fingerprint: FlowFingerprint = {
  filters: [],
  elements: [
    'assignments:Log_Fault',
    'customErrors:Install_Date_Missing',
    'decisions:No_Install_Date',
    'formulas:isLate',
    'recordLookups:Get_Item',
    'variables:faultMessage',
  ],
};

const withFingerprints = (
  prints: Record<string, FlowFingerprint | undefined>,
): CoverageSource & { asked: string[] } => {
  const asked: string[] = [];
  return {
    ...fakeSource([]),
    asked,
    getFlowFingerprint: async (id: string) => {
      asked.push(id);
      return prints[id];
    },
  };
};

describe('executableElements', () => {
  it('leaves out resources and names each type in the singular', () => {
    expect(executableElements(fingerprint)).toEqual([
      { name: 'Log_Fault', type: 'assignment' },
      { name: 'Install_Date_Missing', type: 'customError' },
      { name: 'No_Install_Date', type: 'decision' },
      { name: 'Get_Item', type: 'recordLookup' },
    ]);
  });
});

describe('findUncoveredElements', () => {
  const partial = coverage('F', {
    elementsCovered: 2,
    elementsTotal: 4,
    coveredElementNames: ['no_install_date', 'get_item'],
  });

  it('lists the elements no test ran, matching names without case', async () => {
    const source = withFingerprints({ [partial.flowVersionId]: fingerprint });
    expect(await findUncoveredElements(source, partial)).toEqual([
      { name: 'Log_Fault', type: 'assignment' },
      { name: 'Install_Date_Missing', type: 'customError' },
    ]);
  });

  it('skips the query for Flows with no test or with every element covered', async () => {
    const source = withFingerprints({});
    expect(await findUncoveredElements(source, coverage('F', { covered: false }))).toBeUndefined();
    expect(await findUncoveredElements(source, coverage('F', { elementsCovered: 5, elementsTotal: 5 }))).toEqual([]);
    expect(source.asked).toEqual([]);
  });

  it('returns undefined when element coverage or the version content cannot be read', async () => {
    expect(
      await findUncoveredElements(withFingerprints({}), { ...partial, coveredElementNames: undefined }),
    ).toBeUndefined();
    expect(await findUncoveredElements(fakeSource([]), partial)).toBeUndefined();
    expect(await findUncoveredElements(withFingerprints({}), partial)).toBeUndefined();
  });
});

describe('describeElements', () => {
  it('names each element with its type, shortening long lists', () => {
    const elements = Array.from({ length: 7 }, (_, i) => ({ name: `E${i}`, type: 'decision' }));
    expect(describeElements(elements.slice(0, 2))).toBe('E0 (decision), E1 (decision)');
    expect(describeElements(elements)).toBe(
      'E0 (decision), E1 (decision), E2 (decision), E3 (decision), E4 (decision) and 2 more',
    );
    expect(describeElements([])).toBe('');
  });
});
