import { describe, expect, it } from 'vitest';

import { missingCoverageWarning, NO_COVERAGE_WARNING } from '../../src/core/coverageCheck.js';
import { evaluateGate } from '../../src/core/gate.js';
import { buildReadinessReport } from '../../src/core/readiness.js';
import type { CoverageSource, FlowCoverage } from '../../src/core/types.js';
import { coverage, fakeSource } from '../helpers.js';

/** A fake source that answers hasAnyFlowCoverage and counts how often it's asked. */
function sourceWith(flows: FlowCoverage[], hasCoverage: boolean): CoverageSource & { asked: number } {
  const source = {
    ...fakeSource(flows),
    asked: 0,
    hasAnyFlowCoverage: async () => {
      source.asked++;
      return hasCoverage;
    },
  };
  return source;
}

describe('missingCoverageWarning', () => {
  it('warns only when results look suspicious and the org has no coverage at all', async () => {
    expect(await missingCoverageWarning(sourceWith([], false), true)).toBe(NO_COVERAGE_WARNING);
    expect(await missingCoverageWarning(sourceWith([], true), true)).toBeUndefined();
    const notAsked = sourceWith([], false);
    expect(await missingCoverageWarning(notAsked, false)).toBeUndefined();
    expect(notAsked.asked).toBe(0);
    expect(await missingCoverageWarning(fakeSource([]), true)).toBeUndefined();
  });

  it('names the fix', () => {
    expect(NO_COVERAGE_WARNING).toContain('sf apex run test --test-level RunLocalTests --code-coverage');
  });
});

describe('readiness and gate', () => {
  it('readiness asks only when no active Flow is covered', async () => {
    const none = sourceWith([coverage('A', { covered: false })], false);
    expect((await buildReadinessReport({ source: none })).warnings).toEqual([NO_COVERAGE_WARNING]);

    const some = sourceWith([coverage('A', { covered: false }), coverage('B')], false);
    expect((await buildReadinessReport({ source: some })).warnings).toEqual([]);
    expect(some.asked).toBe(0);

    const empty = sourceWith([], false);
    expect((await buildReadinessReport({ source: empty })).warnings).toEqual([]);
    expect(empty.asked).toBe(0);
  });

  it('gate asks only when a counted Flow it checks has no test', async () => {
    const uncovered = sourceWith([coverage('A', { covered: false })], false);
    const result = await evaluateGate({ source: uncovered, candidates: [{ flowName: 'A' }] });
    expect(result.warnings).toEqual([NO_COVERAGE_WARNING]);

    const covered = sourceWith([coverage('A'), coverage('Screen', { processType: 'Flow', covered: false })], false);
    const passing = await evaluateGate({ source: covered, candidates: [{ flowName: 'A' }, { flowName: 'Screen' }] });
    expect(passing.warnings).toEqual([]);
    expect(covered.asked).toBe(0);
  });
});
