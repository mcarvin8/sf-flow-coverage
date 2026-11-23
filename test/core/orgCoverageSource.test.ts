import { describe, expect, it, vi } from 'vitest';

import { OrgCoverageSource } from '../../src/core/orgCoverageSource.js';
import type { ToolingQuery } from '../../src/core/types.js';

type Rec = Record<string, unknown>;

const flowRec = (id: string, name: string, extra: Rec = {}): Rec => ({
  Id: id,
  VersionNumber: 2,
  ProcessType: 'AutoLaunchedFlow',
  Status: 'Active',
  Definition: { DeveloperName: name, NamespacePrefix: null },
  ...extra,
});

/** Routes queries by the object in the FROM clause. */
function fakeQuery(tables: Record<string, Rec[] | Error>): { query: ToolingQuery; calls: string[] } {
  const calls: string[] = [];
  const query = vi.fn(async (soql: string) => {
    calls.push(soql);
    const table = /FROM (\w+)/.exec(soql)?.[1] as string;
    const rows = tables[table] ?? [];
    if (rows instanceof Error) throw rows;
    return rows;
  }) as unknown as ToolingQuery;
  return { query, calls };
}

const A = '301000000000001AAA';
const B = '301000000000002AAA';

describe('OrgCoverageSource.listActiveCountedFlows', () => {
  it('combines Flow, coverage, element and class data', async () => {
    const { query, calls } = fakeQuery({
      Flow: [
        flowRec(A, 'Covered_Flow'),
        flowRec(B, 'Bare_Flow', { Definition: { DeveloperName: 'Bare_Flow', NamespacePrefix: 'ns' } }),
      ],
      FlowTestCoverage: [
        {
          Id: 'C1',
          FlowVersionId: A,
          ApexTestClassId: '01p000000000001AAA',
          TestMethodName: 'one',
          NumElementsCovered: 2,
          NumElementsNotCovered: 3,
        },
        {
          Id: 'C2',
          FlowVersionId: A,
          ApexTestClassId: '01p000000000002AAA',
          TestMethodName: 'two',
          NumElementsCovered: 2,
          NumElementsNotCovered: 3,
        },
      ],
      FlowElementTestCoverage: [
        { FlowTestCoverageId: 'C1', ElementName: 'a' },
        { FlowTestCoverageId: 'C1', ElementName: 'b' },
        { FlowTestCoverageId: 'C2', ElementName: 'b' },
        { FlowTestCoverageId: 'C2', ElementName: 'c' },
      ],
      ApexClass: [
        { Id: '01p000000000001AAA', Name: 'FlowTests', NamespacePrefix: null },
        { Id: '01p000000000002AAA', Name: 'MoreTests', NamespacePrefix: 'ns' },
      ],
    });

    const flows = await new OrgCoverageSource(query).listActiveCountedFlows();

    expect(calls[0]).toContain(
      "WHERE Status = 'Active' AND ProcessType IN ('AutoLaunchedFlow', 'Workflow', 'CustomEvent', 'InvocableProcess')",
    );
    expect(flows).toEqual([
      {
        flowName: 'Covered_Flow',
        flowVersionId: A,
        versionNumber: 2,
        processType: 'AutoLaunchedFlow',
        status: 'Active',
        covered: true,
        elementsCovered: 3,
        elementsTotal: 5,
        elementCoveragePercent: 60,
        tests: [
          { className: 'FlowTests', methodName: 'one' },
          { className: 'ns.MoreTests', methodName: 'two' },
        ],
        coveredElementNames: ['a', 'b', 'c'],
      },
      {
        flowName: 'ns__Bare_Flow',
        flowVersionId: B,
        versionNumber: 2,
        processType: 'AutoLaunchedFlow',
        status: 'Active',
        covered: false,
        elementsCovered: 0,
        elementsTotal: 0,
        elementCoveragePercent: 0,
        tests: [],
        coveredElementNames: [],
      },
    ]);
  });

  it('falls back to the best single test when element coverage cannot be queried', async () => {
    const { query } = fakeQuery({
      Flow: [flowRec(A, 'F')],
      FlowTestCoverage: [
        {
          Id: 'C1',
          FlowVersionId: A,
          ApexTestClassId: null,
          TestMethodName: null,
          NumElementsCovered: 3,
          NumElementsNotCovered: 1,
        },
        {
          Id: 'C2',
          FlowVersionId: A,
          ApexTestClassId: '01p000000000009AAA',
          NumElementsCovered: null,
          NumElementsNotCovered: null,
        },
      ],
      FlowElementTestCoverage: new Error('sObject type FlowElementTestCoverage is not supported'),
    });
    const [flow] = await new OrgCoverageSource(query).listActiveCountedFlows();
    expect(flow.elementsCovered).toBe(3);
    expect(flow.elementCoveragePercent).toBe(75);
    expect(flow.coveredElementNames).toBeUndefined();
    expect(flow.tests).toEqual([
      { className: 'unknown', methodName: 'unknown' },
      { className: '01p000000000009AAA', methodName: 'unknown' },
    ]);
  });

  it('uses the Flow Id when the definition is missing and skips coverage queries when there are no Flows', async () => {
    const empty = fakeQuery({});
    expect(await new OrgCoverageSource(empty.query).listActiveCountedFlows()).toEqual([]);
    expect(empty.calls).toHaveLength(1);

    const { query } = fakeQuery({ Flow: [flowRec(A, 'x', { Definition: null })] });
    const [flow] = await new OrgCoverageSource(query).listActiveCountedFlows();
    expect(flow.flowName).toBe(A);
  });

  it('chunks long IN lists', async () => {
    const many = Array.from({ length: 450 }, (_, i) => flowRec(`301${String(i).padStart(12, '0')}AAA`, `F${i}`));
    const { query, calls } = fakeQuery({ Flow: many });
    await new OrgCoverageSource(query).listActiveCountedFlows();
    expect(calls.filter((c) => c.includes('FROM FlowTestCoverage'))).toHaveLength(3);
  });
});

describe('OrgCoverageSource.getFlowCoverage', () => {
  it('reads the active version, or the latest when none is active', async () => {
    const { query, calls } = fakeQuery({
      FlowDefinition: [
        { Id: 'D1', DeveloperName: 'Active_One', NamespacePrefix: null, ActiveVersionId: A, LatestVersionId: B },
        { Id: 'D2', DeveloperName: 'Inactive_One', NamespacePrefix: null, ActiveVersionId: null, LatestVersionId: B },
        { Id: 'D3', DeveloperName: 'Active_One', NamespacePrefix: 'other', ActiveVersionId: 'X', LatestVersionId: 'X' },
        { Id: 'D4', DeveloperName: 'Nothing', NamespacePrefix: null, ActiveVersionId: null, LatestVersionId: null },
      ],
      Flow: [flowRec(A, 'Active_One'), flowRec(B, 'Inactive_One', { Status: 'Draft' })],
    });
    const flows = await new OrgCoverageSource(query).getFlowCoverage([
      'Active_One',
      'Inactive_One',
      'Nothing',
      "O'Neil",
    ]);
    expect(calls[0]).toContain("DeveloperName IN ('Active_One', 'Inactive_One', 'Nothing', 'O\\'Neil')");
    expect(calls[1]).toContain(`Id IN ('${A}', '${B}')`);
    expect(flows.map((f) => f.flowName)).toEqual(['Active_One', 'Inactive_One']);
  });

  it('reports how the version read relates to the latest version', async () => {
    const C = '301000000000003AAA';
    const { query, calls } = fakeQuery({
      FlowDefinition: [
        { Id: 'D1', DeveloperName: 'Current', ActiveVersionId: A, LatestVersionId: A.slice(0, 15) },
        {
          Id: 'D2',
          DeveloperName: 'Newer',
          ActiveVersionId: B,
          LatestVersionId: 'X01000000000009AAA',
          LatestVersion: { VersionNumber: 5 },
        },
        { Id: 'D3', DeveloperName: 'NoActive', ActiveVersionId: null, LatestVersionId: C },
        { Id: 'D4', DeveloperName: 'NoLatestNumber', ActiveVersionId: 'Y', LatestVersionId: 'Z', LatestVersion: null },
      ],
      Flow: [
        flowRec(A, 'Current'),
        flowRec(B, 'Newer'),
        flowRec(C, 'NoActive', { Status: 'Draft' }),
        flowRec('Y', 'NoLatestNumber'),
      ],
    });
    const flows = await new OrgCoverageSource(query).getFlowCoverage([
      'Current',
      'Newer',
      'NoActive',
      'NoLatestNumber',
    ]);
    expect(calls[0]).toContain('LatestVersion.VersionNumber');
    expect(flows.map((f) => [f.flowName, f.versionState, f.latestVersionNumber])).toEqual([
      ['Current', 'current', undefined],
      ['Newer', 'newerInactiveVersion', 5],
      ['NoActive', 'noActiveVersion', undefined],
      ['NoLatestNumber', 'newerInactiveVersion', undefined],
    ]);
  });

  it('leaves versionState unset on a Flow the definitions do not account for', async () => {
    const { query } = fakeQuery({
      FlowDefinition: [{ Id: 'D1', DeveloperName: 'F', ActiveVersionId: A, LatestVersionId: A }],
      Flow: [flowRec(A, 'F'), flowRec(B, 'Stray')],
    });
    const flows = await new OrgCoverageSource(query).getFlowCoverage(['F']);
    expect(flows.map((f) => [f.flowName, f.versionState])).toEqual([
      ['F', 'current'],
      ['Stray', undefined],
    ]);
  });

  it('matches namespaced names', async () => {
    const { query, calls } = fakeQuery({
      FlowDefinition: [{ Id: 'D1', DeveloperName: 'Flow', NamespacePrefix: 'ns', ActiveVersionId: A }],
      Flow: [flowRec(A, 'Flow', { Definition: { DeveloperName: 'Flow', NamespacePrefix: 'ns' } })],
    });
    const flows = await new OrgCoverageSource(query).getFlowCoverage(['ns__Flow']);
    expect(calls[0]).toContain("DeveloperName IN ('Flow')");
    expect(flows[0].flowName).toBe('ns__Flow');
  });

  it('returns nothing without querying for no names, and nothing when no definition matches', async () => {
    const none = fakeQuery({});
    expect(await new OrgCoverageSource(none.query).getFlowCoverage([])).toEqual([]);
    expect(none.calls).toHaveLength(0);

    const missing = fakeQuery({ FlowDefinition: [] });
    expect(await new OrgCoverageSource(missing.query).getFlowCoverage(['Gone'])).toEqual([]);
    expect(missing.calls).toHaveLength(1);
  });
});

describe('OrgCoverageSource.hasAnyFlowCoverage', () => {
  it('reads one coverage row from the org', async () => {
    const some = fakeQuery({ FlowTestCoverage: [{ Id: 'C1' }] });
    expect(await new OrgCoverageSource(some.query).hasAnyFlowCoverage()).toBe(true);
    expect(some.calls).toEqual(['SELECT Id FROM FlowTestCoverage LIMIT 1']);
    expect(await new OrgCoverageSource(fakeQuery({}).query).hasAnyFlowCoverage()).toBe(false);
  });

  it('assumes coverage exists when the query fails', async () => {
    const failing = fakeQuery({ FlowTestCoverage: new Error('INSUFFICIENT_ACCESS') });
    expect(await new OrgCoverageSource(failing.query).hasAnyFlowCoverage()).toBe(true);
  });
});

describe('OrgCoverageSource.getFlowFingerprint', () => {
  it('fingerprints the version metadata, one version per query', async () => {
    const { query, calls } = fakeQuery({
      Flow: [{ Metadata: { processType: 'AutoLaunchedFlow', decisions: [{ name: 'D' }] } }],
    });
    expect(await new OrgCoverageSource(query).getFlowFingerprint(A)).toMatchObject({
      processType: 'AutoLaunchedFlow',
      filters: [],
      elements: ['decisions:D'],
    });
    expect(calls).toEqual([`SELECT Metadata FROM Flow WHERE Id = '${A}'`]);
  });

  it('reads each version once', async () => {
    const { query, calls } = fakeQuery({ Flow: [{ Metadata: { decisions: [{ name: 'D' }] } }] });
    const source = new OrgCoverageSource(query);
    const [first, again] = await Promise.all([source.getFlowFingerprint(A), source.getFlowFingerprint(A.slice(0, 15))]);
    expect(again).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it('returns undefined when the version or its metadata cannot be read', async () => {
    expect(await new OrgCoverageSource(fakeQuery({ Flow: [] }).query).getFlowFingerprint(A)).toBeUndefined();
    expect(
      await new OrgCoverageSource(fakeQuery({ Flow: [{ Metadata: null }] }).query).getFlowFingerprint(A),
    ).toBeUndefined();
    expect(
      await new OrgCoverageSource(fakeQuery({ Flow: new Error('INVALID_FIELD') }).query).getFlowFingerprint(A),
    ).toBeUndefined();
  });
});

describe('OrgCoverageSource.countCoveredInactiveVersions', () => {
  it('counts latest inactive versions of counted Flows that have coverage', async () => {
    const C = '301000000000003AAA';
    const D = '301000000000004AAA';
    const E = '301000000000005AAA';
    const { query, calls } = fakeQuery({
      FlowTestCoverage: [
        { FlowVersionId: A },
        { FlowVersionId: A },
        { FlowVersionId: B },
        { FlowVersionId: C },
        { FlowVersionId: D },
        { FlowVersionId: E },
        {},
      ],
      Flow: [
        // Active: already counted as an active Flow.
        { Id: A, Status: 'Active', ProcessType: 'AutoLaunchedFlow', Definition: { LatestVersionId: A } },
        // Latest and inactive: counts.
        { Id: B, Status: 'Obsolete', ProcessType: 'AutoLaunchedFlow', Definition: { LatestVersionId: B.slice(0, 15) } },
        // Inactive, but a newer version exists.
        { Id: C, Status: 'Obsolete', ProcessType: 'AutoLaunchedFlow', Definition: { LatestVersionId: D } },
        // Latest and inactive, but a screen Flow.
        { Id: D, Status: 'Draft', ProcessType: 'Flow', Definition: { LatestVersionId: D } },
        // No definition.
        { Id: E, Status: 'Draft', ProcessType: 'Workflow', Definition: null },
      ],
    });
    expect(await new OrgCoverageSource(query).countCoveredInactiveVersions()).toBe(1);
    expect(calls[0]).toBe('SELECT FlowVersionId FROM FlowTestCoverage');
    expect(calls[1]).toContain('SELECT Id, Status, ProcessType, Definition.LatestVersionId FROM Flow WHERE Id IN (');
  });

  it("gives no count when it can't read coverage", async () => {
    const failing = fakeQuery({ FlowTestCoverage: new Error('INSUFFICIENT_ACCESS') });
    expect(await new OrgCoverageSource(failing.query).countCoveredInactiveVersions()).toBeUndefined();
  });
});
