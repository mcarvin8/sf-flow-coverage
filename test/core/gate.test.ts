import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FlowFingerprint } from '../../src/core/flowFingerprint.js';
import { collectChangedFlows, evaluateGate } from '../../src/core/gate.js';
import type { CoverageSource, FlowMetadata } from '../../src/core/types.js';
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

  it('fails Flows whose org versions suggest the branch was deployed inactive', async () => {
    const source = fakeSource([
      coverage('Current', { versionState: 'current' }),
      coverage('NoActive', { versionState: 'noActiveVersion', versionNumber: 4, status: 'Draft' }),
      coverage('Newer', { versionState: 'newerInactiveVersion', versionNumber: 2, latestVersionNumber: 3 }),
      coverage('Unknown', {
        versionState: 'newerInactiveVersion',
        versionNumber: undefined,
        status: undefined,
      }),
      coverage('UnknownNoActive', { versionState: 'noActiveVersion', versionNumber: undefined, status: undefined }),
      coverage('Screen', { versionState: 'noActiveVersion', processType: 'Flow' }),
    ]);
    const result = await evaluateGate({
      source,
      candidates: ['Current', 'NoActive', 'Newer', 'Unknown', 'UnknownNoActive', 'Screen'].map((flowName) => ({
        flowName,
      })),
    });
    expect(result.passed).toBe(false);
    expect(result.flows.map((f) => [f.flowName, f.status])).toEqual([
      ['Current', 'pass'],
      ['NoActive', 'fail'],
      ['Newer', 'fail'],
      ['Unknown', 'fail'],
      ['UnknownNoActive', 'fail'],
      ['Screen', 'skip'],
    ]);
    expect(result.flows[1].reason).toBe(
      'No version of this Flow is active in the org (latest is version 4, Draft). Deploy it as active or activate it, run Apex tests, then rerun the gate.',
    );
    expect(result.flows[2].reason).toBe(
      "The org's active version 2 is older than its latest version 3, which is inactive, so coverage may be stale. Activate the latest version, run Apex tests, then rerun the gate.",
    );
    expect(result.flows[3].reason).toContain('active version ? is older than its latest version ?');
    expect(result.flows[4].reason).toContain('(latest is version ?, inactive)');
  });

  it('reports an unknown version number', async () => {
    const source = fakeSource([coverage('X', { covered: false, versionNumber: undefined })]);
    const result = await evaluateGate({ source, candidates: [{ flowName: 'X' }] });
    expect(result.flows[0].reason).toBe('No Apex test runs version ? of this Flow.');
  });
});

describe('evaluateGate content check', () => {
  const sourcePrint: FlowFingerprint = { processType: 'AutoLaunchedFlow', filters: [], elements: ['decisions:New'] };
  const orgPrint: FlowFingerprint = { processType: 'AutoLaunchedFlow', filters: [], elements: ['decisions:Old'] };
  const mismatch =
    "The org's version 1 differs from flows/F.flow-meta.xml (only in source: decisions:New; only in the org: decisions:Old), so coverage may be stale. Deploy the branch, run Apex tests, then rerun the gate.";

  /** A source whose org fingerprints are looked up by version id, recording each lookup. */
  function sourceWith(
    flows: Parameters<typeof fakeSource>[0],
    prints: Record<string, FlowFingerprint | undefined>,
  ): CoverageSource & { asked: string[] } {
    const asked: string[] = [];
    return {
      ...fakeSource(flows),
      asked,
      getFlowFingerprint: async (id: string) => {
        asked.push(id);
        return prints[id];
      },
    };
  }

  const candidate = (flowName: string, fingerprint: FlowFingerprint | undefined = sourcePrint) => ({
    flowName,
    path: `flows/${flowName}.flow-meta.xml`,
    metadata: meta(flowName),
    fingerprint,
  });

  it('warns by default when the org version differs from source, and stays quiet when it matches', async () => {
    const f = coverage('F');
    const same = coverage('Same');
    const source = sourceWith([f, same], { [f.flowVersionId]: orgPrint, [same.flowVersionId]: sourcePrint });
    const result = await evaluateGate({ source, candidates: [candidate('F'), candidate('Same')] });
    expect(result.passed).toBe(true);
    expect(result.flows[0]).toMatchObject({ status: 'pass', warnings: [mismatch] });
    expect(result.flows[1].warnings).toBeUndefined();
  });

  it('fails a passing Flow with --content-check fail, and keeps a coverage failure as the reason', async () => {
    const f = coverage('F');
    const bare = coverage('Bare', { covered: false });
    const source = sourceWith([f, bare], { [f.flowVersionId]: orgPrint, [bare.flowVersionId]: orgPrint });
    const result = await evaluateGate({
      source,
      candidates: [candidate('F'), candidate('Bare')],
      contentCheck: 'fail',
    });
    expect(result.passed).toBe(false);
    expect(result.flows[0]).toMatchObject({ status: 'fail', reason: mismatch });
    expect(result.flows[0].warnings).toBeUndefined();
    expect(result.flows[1]).toMatchObject({ status: 'fail', reason: 'No Apex test runs version 1 of this Flow.' });
    expect(result.flows[1].warnings?.[0]).toMatch(/^The org's version 1 differs from flows\/Bare\.flow-meta\.xml/);
  });

  it('skips the comparison when it is off, impossible, or the org content cannot be read', async () => {
    const f = coverage('F', { versionNumber: undefined });
    const off = sourceWith([f], { [f.flowVersionId]: orgPrint });
    const offResult = await evaluateGate({ source: off, candidates: [candidate('F')], contentCheck: 'off' });
    expect(off.asked).toEqual([]);
    expect(offResult.flows[0].warnings).toBeUndefined();

    const noFingerprint = sourceWith([f], { [f.flowVersionId]: orgPrint });
    await evaluateGate({ source: noFingerprint, candidates: [{ flowName: 'F' }] });
    expect(noFingerprint.asked).toEqual([]);

    const noMethod = await evaluateGate({ source: fakeSource([f]), candidates: [candidate('F')] });
    expect(noMethod.flows[0].warnings).toBeUndefined();

    const unreadable = await evaluateGate({ source: sourceWith([f], {}), candidates: [candidate('F')] });
    expect(unreadable.flows[0].warnings).toBeUndefined();
  });

  it('names source when the candidate has no path and the version is unknown', async () => {
    const f = coverage('F', { versionNumber: undefined });
    const source = sourceWith([f], { [f.flowVersionId]: orgPrint });
    const result = await evaluateGate({ source, candidates: [{ flowName: 'F', fingerprint: sourcePrint }] });
    expect(result.flows[0].warnings?.[0]).toMatch(/^The org's version \? differs from source \(/);
  });

  it('does not compare Flows that already failed the version check', async () => {
    const f = coverage('F', { versionState: 'noActiveVersion' });
    const source = sourceWith([f], { [f.flowVersionId]: orgPrint });
    await evaluateGate({ source, candidates: [candidate('F')] });
    expect(source.asked).toEqual([]);
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
    expect(candidates[1].fingerprint).toEqual({ processType: 'AutoLaunchedFlow', filters: [], elements: [] });
  });
});
