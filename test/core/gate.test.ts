import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { collectChangedFlows, evaluateGate } from '../../src/core/gate.js';
import type { FlowMetadata } from '../../src/core/types.js';
import { flowXml, TempGitRepo } from '../gitRepo.js';
import { coverage, fakeSource } from '../helpers.js';

const meta = (name: string, overrides: Partial<FlowMetadata> = {}): FlowMetadata => ({
  name,
  processType: 'AutoLaunchedFlow',
  status: 'Active',
  filters: [],
  variables: [],
  ...overrides,
});

describe('evaluateGate', () => {
  it('passes covered Flows and fails uncovered or missing ones', async () => {
    const source = fakeSource([
      coverage('Covered'),
      coverage('Uncovered', { covered: false, versionNumber: 3 }),
      coverage('Screen', { processType: 'Flow' }),
    ]);
    const result = await evaluateGate({
      source,
      candidates: [
        { flowName: 'Covered', path: 'flows/Covered.flow-meta.xml', metadata: meta('Covered') },
        { flowName: 'Uncovered' },
        { flowName: 'Missing' },
        { flowName: 'Screen' },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.minElementCoverage).toBe(0);
    expect(result.flows.map((f) => [f.flowName, f.status])).toEqual([
      ['Covered', 'pass'],
      ['Uncovered', 'fail'],
      ['Missing', 'fail'],
      ['Screen', 'skip'],
    ]);
    expect(result.flows[0]).toMatchObject({
      path: 'flows/Covered.flow-meta.xml',
      reason: 'Covered by 1 test method(s).',
    });
    expect(result.flows[1].reason).toBe('No Apex test runs version 3 of this Flow.');
    expect(result.flows[2].reason).toMatch(/not found in the target org/);
  });

  it('skips Flows whose source does not count, without asking the org', async () => {
    const asked: string[][] = [];
    const source = {
      ...fakeSource([]),
      getFlowCoverage: async (names: string[]) => {
        asked.push(names);
        return [];
      },
    };
    const result = await evaluateGate({
      source,
      candidates: [
        { flowName: 'Screen', metadata: meta('Screen', { processType: 'Flow' }) },
        { flowName: 'NoType', metadata: meta('NoType', { processType: undefined }) },
        { flowName: 'Draft', metadata: meta('Draft', { status: 'Draft' }) },
      ],
    });
    expect(result.passed).toBe(true);
    expect(result.flows.map((f) => f.status)).toEqual(['skip', 'skip', 'skip']);
    expect(result.flows[1].reason).toContain('Process type unknown');
    expect(result.flows[2].reason).toBe('Status is Draft; only active Flows need coverage.');
    expect(asked).toEqual([[]]);
  });

  it('enforces minimum element coverage', async () => {
    const source = fakeSource([
      coverage('Low', { elementCoveragePercent: 40 }),
      coverage('High', { elementCoveragePercent: 90 }),
    ]);
    const result = await evaluateGate({
      source,
      candidates: [{ flowName: 'Low' }, { flowName: 'High' }],
      minElementCoverage: 50,
    });
    expect(result.passed).toBe(false);
    expect(result.flows[0]).toMatchObject({
      status: 'fail',
      reason: 'Element coverage 40% is below the required 50%.',
    });
    expect(result.flows[1].status).toBe('pass');
  });

  it('fails Flows that could not be parsed without asking the org', async () => {
    const result = await evaluateGate({
      source: fakeSource([]),
      candidates: [
        { flowName: 'Broken', path: 'flows/Broken.flow-meta.xml', error: 'Broken is not a Flow metadata file.' },
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.flows[0]).toMatchObject({ status: 'fail', reason: 'Broken is not a Flow metadata file.' });
  });

  it('reports an unknown version number', async () => {
    const source = fakeSource([coverage('X', { covered: false, versionNumber: undefined })]);
    const result = await evaluateGate({ source, candidates: [{ flowName: 'X' }] });
    expect(result.flows[0].reason).toBe('No Apex test runs version ? of this Flow.');
  });
});

describe('collectChangedFlows', () => {
  let repo: TempGitRepo;

  beforeAll(() => {
    repo = new TempGitRepo();
    repo.commit('base', { 'flows/Old.flow-meta.xml': flowXml() });
    repo.git('checkout', '-q', '-b', 'feature');
    repo.commit('change', {
      'flows/New.flow-meta.xml': flowXml('AutoLaunchedFlow', 'Active', 'committed'),
      'flows/Screen.flow-meta.xml': flowXml('Flow'),
      'flows/Broken.flow-meta.xml': '<CustomObject/>',
    });
    // Uncommitted edits must not affect the result: the gate reads the `to` revision.
    repo.write('flows/New.flow-meta.xml', flowXml('AutoLaunchedFlow', 'Active', 'working-tree'));
  });

  afterAll(() => repo.remove());

  it('parses each changed Flow at the target revision', async () => {
    const candidates = await collectChangedFlows(repo.dir, 'main', 'feature');
    expect(candidates.map((c) => [c.flowName, c.path, c.metadata?.processType, c.metadata?.label])).toEqual([
      ['Broken', 'flows/Broken.flow-meta.xml', undefined, undefined],
      ['New', 'flows/New.flow-meta.xml', 'AutoLaunchedFlow', 'committed'],
      ['Screen', 'flows/Screen.flow-meta.xml', 'Flow', 'x'],
    ]);
    expect(candidates[0].error).toMatch(/not a Flow metadata file/);
  });
});
