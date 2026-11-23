import { describe, expect, it } from 'vitest';

import { buildReadinessReport, coverageLines } from '../../src/core/readiness.js';
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
    expect(result).toMatchObject({
      totalFlows: 0,
      coveragePercent: 100,
      ready: true,
      flowsNeeded: 0,
      processBuilderProcesses: 0,
    });
  });
});

describe('buildReadinessReport and Salesforce coverage', () => {
  it('counts latest inactive versions with coverage the way Salesforce does', async () => {
    // The example in Salesforce's help: one active version without a test, five active versions
    // with one, and five latest inactive versions with one, so 10 of 11.
    const flows = [coverage('A', { covered: false }), ...['F', 'G', 'H', 'I', 'J'].map((name) => coverage(name))];
    const result = await buildReadinessReport({
      source: { ...fakeSource(flows), countCoveredInactiveVersions: async () => 5 },
      threshold: 95,
    });
    expect(result).toMatchObject({
      coveragePercent: 83.3,
      salesforceCoveragePercent: 90.9,
      coveredInactiveVersions: 5,
      thresholdAssumed: false,
      ready: false,
      // ceil(95% of 11) = 11, and 10 are covered.
      flowsNeeded: 1,
    });
  });

  it('says when it assumed the threshold, and counts nothing extra when the source can not tell', async () => {
    const result = await buildReadinessReport({
      source: { ...fakeSource([coverage('A')]), countCoveredInactiveVersions: async () => undefined },
    });
    expect(result).toMatchObject({
      threshold: 75,
      thresholdAssumed: true,
      coveredInactiveVersions: 0,
      salesforceCoveragePercent: 100,
    });
  });
});

describe('coverageLines', () => {
  const base = {
    threshold: 75,
    thresholdAssumed: false,
    totalFlows: 6,
    coveredFlows: 5,
    uncoveredFlows: 1,
    coveragePercent: 83.3,
    salesforceCoveragePercent: 83.3,
    coveredInactiveVersions: 0,
    ready: true,
    flowsNeeded: 0,
    processBuilderProcesses: 0,
    warnings: [],
    flows: [],
  };

  it('shows one line when no inactive version has coverage', () => {
    expect(coverageLines(base)).toEqual([
      'Flow coverage: 83.3% (5 of 6 active Flows and processes have a test). Threshold: 75%.',
    ]);
  });

  it('shows how Salesforce counts inactive versions, and when the threshold was assumed', () => {
    expect(
      coverageLines(
        { ...base, salesforceCoveragePercent: 90.9, coveredInactiveVersions: 5, thresholdAssumed: true },
        (t) => `*${t}*`,
      ),
    ).toEqual([
      'Flow coverage: *90.9%* as Salesforce calculates it (10 of 11 Flows: 5 active and 5 inactive with a test, 1 active without one). Threshold: 75%.',
      'Active Flows with a test: 83.3% (5 of 6). Salesforce also counts the latest inactive versions that have a test.',
      "75% is the usual requirement. Production's Process Automation Settings set the actual percentage: pass --threshold if it differs.",
    ]);
  });
});
