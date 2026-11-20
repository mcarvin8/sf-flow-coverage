import { describe, expect, it } from 'vitest';

import { buildReadinessReport } from '../../src/core/readiness.js';
import { coverage, fakeSource } from '../helpers.js';

describe('buildReadinessReport', () => {
  it('reports coverage below the threshold and how many Flows are needed', async () => {
    const source = fakeSource([
      coverage('A_Covered'),
      coverage('B_Uncovered', { covered: false }),
      coverage('C_Uncovered', { covered: false }),
      coverage('D_Uncovered', { covered: false }),
    ]);
    const churn = new Map([
      ['C_Uncovered', 9],
      ['B_Uncovered', 2],
    ]);
    const result = await buildReadinessReport({ source, churn });

    expect(result).toMatchObject({
      threshold: 75,
      totalFlows: 4,
      coveredFlows: 1,
      uncoveredFlows: 3,
      coveragePercent: 25,
      ready: false,
      flowsNeeded: 2,
    });
    expect(result.flows.map((f) => [f.flowName, f.changes])).toEqual([
      ['C_Uncovered', 9],
      ['B_Uncovered', 2],
      ['D_Uncovered', 0],
      ['A_Covered', 0],
    ]);
  });

  it('is ready at the threshold and leaves changes undefined without git', async () => {
    const source = fakeSource([coverage('B'), coverage('A'), coverage('C'), coverage('D', { covered: false })]);
    const result = await buildReadinessReport({ source });
    expect(result.ready).toBe(true);
    expect(result.flowsNeeded).toBe(0);
    expect(result.coveragePercent).toBe(75);
    expect(result.flows.map((f) => f.flowName)).toEqual(['D', 'A', 'B', 'C']);
    expect(result.flows.every((f) => f.changes === undefined)).toBe(true);
  });

  it('uses a custom threshold without float rounding errors', async () => {
    const flows = Array.from({ length: 10 }, (_, i) => coverage(`F${i}`, { covered: i < 7 }));
    const result = await buildReadinessReport({ source: fakeSource(flows), threshold: 70 });
    expect(result.flowsNeeded).toBe(0);
    expect(result.ready).toBe(true);
    expect((await buildReadinessReport({ source: fakeSource(flows), threshold: 71 })).flowsNeeded).toBe(1);
  });

  it('lists the elements no test ran for partly covered Flows', async () => {
    const partial = coverage('Partial', { elementsCovered: 1, elementsTotal: 2, coveredElementNames: ['check'] });
    const result = await buildReadinessReport({
      source: {
        ...fakeSource([partial, coverage('Bare', { covered: false })]),
        getFlowFingerprint: async () => ({ filters: [], elements: ['decisions:Check', 'assignments:Set'] }),
      },
    });
    expect(result.flows.map((f) => [f.flowName, f.uncoveredElements])).toEqual([
      ['Bare', undefined],
      ['Partial', [{ name: 'Set', type: 'assignment' }]],
    ]);
  });

  it('treats an org with no active Flows as ready', async () => {
    const result = await buildReadinessReport({ source: fakeSource([]) });
    expect(result).toMatchObject({ totalFlows: 0, coveragePercent: 100, ready: true, flowsNeeded: 0 });
  });
});
