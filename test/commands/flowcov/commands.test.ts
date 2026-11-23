import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import FlowcovGate from '../../../src/commands/flowcov/gate.js';
import FlowcovReadiness from '../../../src/commands/flowcov/readiness.js';
import FlowcovScaffold from '../../../src/commands/flowcov/scaffold.js';
import FlowcovTransform from '../../../src/commands/flowcov/transform.js';
import type { FlowFingerprint } from '../../../src/core/flowFingerprint.js';
import type { FlowCoverage } from '../../../src/core/types.js';
import { flowXml, TempGitRepo } from '../../gitRepo.js';
import { coverage, FIXTURE_PROJECT } from '../../helpers.js';

const orgFlows = vi.hoisted(() => ({ value: [] as FlowCoverage[] }));
const orgFingerprints = vi.hoisted(() => ({ value: {} as Record<string, FlowFingerprint> }));
const orgHasCoverage = vi.hoisted(() => ({ value: true }));
const orgDescribes = vi.hoisted(() => ({ value: {} as Record<string, Array<Record<string, unknown>>> }));
const orgSettings = vi.hoisted(() => ({ deployAsActive: undefined as boolean | undefined, isSandbox: false }));

vi.mock('../../../src/core/toolingQuery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/toolingQuery.js')>()),
  metadataRead: () => async () =>
    orgSettings.deployAsActive === undefined
      ? undefined
      : { enableFlowDeployAsActiveEnabled: orgSettings.deployAsActive },
  dataQuery: () => async () => [{ IsSandbox: orgSettings.isSandbox }],
  describeObject: () => async (object: string) => orgDescribes.value[object],
}));

vi.mock('../../../src/core/orgCoverageSource.js', () => ({
  OrgCoverageSource: class {
    public async listActiveCountedFlows(): Promise<FlowCoverage[]> {
      return orgFlows.value;
    }
    public async getFlowCoverage(names: string[]): Promise<FlowCoverage[]> {
      return orgFlows.value.filter((f) => names.includes(f.flowName));
    }
    public async getFlowFingerprint(id: string): Promise<FlowFingerprint | undefined> {
      return orgFingerprints.value[id];
    }
    public async hasAnyFlowCoverage(): Promise<boolean> {
      return orgHasCoverage.value;
    }
  },
}));

// Command runs load oclif config and @salesforce/core on first use, which can take
// longer than Vitest's default 5s on slow CI runners (Windows especially).
describe('flowcov commands', { timeout: 30_000 }, () => {
  const $$ = new TestContext({ setup: false });
  const testOrg = new MockTestOrgData();
  let ux: ReturnType<typeof stubSfCommandUx>;
  let out: string;

  const logged = (): string =>
    [...ux.log.getCalls(), ...ux.logSuccess.getCalls(), ...ux.warn.getCalls()].flatMap((c) => c.args).join('\n');
  const tableRows = (): Array<Record<string, unknown>> =>
    ux.table
      .getCalls()
      .flatMap((c: { args: unknown[] }) => (c.args[0] as { data: Array<Record<string, unknown>> }).data);

  beforeEach(async () => {
    $$.init();
    await $$.stubAuths(testOrg);
    ux = stubSfCommandUx($$.SANDBOX);
    out = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-cmd-'));
    process.exitCode = undefined;
  });

  afterEach(() => {
    $$.restore();
    rmSync(out, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  describe('readiness', () => {
    it('reports an org that is not ready', async () => {
      orgFlows.value = [coverage('Covered'), coverage('Uncovered', { covered: false })];
      const result = await FlowcovReadiness.run([
        '--target-org',
        testOrg.username,
        '--project-dir',
        out,
        '--fail-if-not-ready',
      ]);
      expect(result).toMatchObject({ coveragePercent: 50, ready: false, flowsNeeded: 1 });
      expect(logged()).toContain('Flow coverage: 50% (1 of 2 active Flows and processes have a test). Threshold: 75%.');
      expect(logged()).toContain('Not ready: add Apex tests for 1 more Flow(s) to reach 75%.');
      expect(tableRows()).toEqual([
        { Flow: 'Uncovered', Type: 'AutoLaunchedFlow', Version: 1 },
        { Flow: 'Covered', 'Element Coverage': '80%', Tests: 'Covered_Test.runs' },
      ]);
      expect(process.exitCode).toBe(1);
    });

    it('warns when the org has no Flow coverage recorded at all', async () => {
      orgFlows.value = [coverage('A', { covered: false }), coverage('B', { covered: false })];
      orgHasCoverage.value = false;
      try {
        const result = await FlowcovReadiness.run(['--target-org', testOrg.username]);
        expect(result.warnings).toEqual([expect.stringContaining('--code-coverage')]);
        expect(logged()).toContain('The org has no Flow coverage recorded for any Flow.');
        const gate = await FlowcovGate.run(['--target-org', testOrg.username, '--flow', 'A']);
        expect(gate.warnings).toHaveLength(1);
      } finally {
        orgHasCoverage.value = true;
      }
    });

    it('says what the deploy-as-active setting means for the org', async () => {
      orgFlows.value = [coverage('A', { covered: false }), coverage('B')];
      try {
        orgSettings.deployAsActive = true;
        const production = await FlowcovReadiness.run(['--target-org', testOrg.username]);
        expect(production).toMatchObject({ deployAsActive: true, isSandbox: false });
        expect(ux.warn.getCalls().flatMap((c: { args: unknown[] }) => c.args)).toContainEqual(
          expect.stringContaining('Deploy processes and flows as active is on, but coverage is below 75%'),
        );

        orgSettings.isSandbox = true;
        await FlowcovReadiness.run(['--target-org', testOrg.username]);
        expect(ux.log.getCalls().flatMap((c: { args: unknown[] }) => c.args)).toContainEqual(
          expect.stringContaining('Deploy processes and flows as active is on here, but it only affects deployments'),
        );
      } finally {
        orgSettings.deployAsActive = undefined;
        orgSettings.isSandbox = false;
      }
    });

    it('labels Process Builder processes and suggests migrating them', async () => {
      orgFlows.value = [
        coverage('Old_Process', { processType: 'Workflow' }),
        coverage('Event_Process', { processType: 'CustomEvent', covered: false }),
        coverage('Modern_Flow'),
      ];
      const result = await FlowcovReadiness.run(['--target-org', testOrg.username]);
      expect(result.processBuilderProcesses).toBe(2);
      expect(tableRows().map((row) => [row.Flow, row.Type])).toEqual([
        ['Event_Process', 'Process Builder (platform event)'],
        ['Modern_Flow', 'AutoLaunchedFlow'],
        ['Old_Process', 'Process Builder (record change)'],
      ]);
      expect(logged()).toContain(
        '2 of the active Flows are Process Builder processes (Type "Process Builder"). Salesforce no longer supports Process Builder.',
      );
    });

    it('lists the elements no test ran for partly covered Flows', async () => {
      const partial = coverage('Partial', { elementsCovered: 1, elementsTotal: 2, coveredElementNames: ['check'] });
      orgFlows.value = [partial, coverage('Full', { elementsCovered: 5, elementsTotal: 5 })];
      orgFingerprints.value = {
        [partial.flowVersionId]: { filters: [], elements: ['decisions:Check', 'recordUpdates:Save'] },
      };
      const result = await FlowcovReadiness.run(['--target-org', testOrg.username]);
      orgFingerprints.value = {};
      expect(result.flows.find((f) => f.flowName === 'Partial')?.uncoveredElements).toEqual([
        { name: 'Save', type: 'recordUpdate' },
      ]);
      expect(tableRows().map((row) => [row.Flow, row['Uncovered Elements']])).toEqual([
        ['Full', ''],
        ['Partial', 'Save (recordUpdate)'],
      ]);
    });

    it('reports a ready org with git change counts', async () => {
      const repo = new TempGitRepo();
      try {
        repo.commit('add', { 'flows/Uncovered.flow-meta.xml': flowXml() });
        orgFlows.value = [
          coverage('A'),
          coverage('B'),
          coverage('C'),
          coverage('Uncovered', { covered: false, versionNumber: undefined }),
        ];
        const result = await FlowcovReadiness.run(['--target-org', testOrg.username, '--project-dir', repo.dir]);
        expect(result.ready).toBe(true);
        expect(logged()).toContain('Ready: the org meets the coverage needed to deploy Flows as active.');
        expect(tableRows()[0]).toEqual({ Flow: 'Uncovered', Type: 'AutoLaunchedFlow', Version: '', Changes: 1 });
        expect(process.exitCode).toBeUndefined();
      } finally {
        repo.remove();
      }
    });

    it('prints Markdown with --output-format markdown', async () => {
      orgFlows.value = [coverage('Other', { covered: false }), coverage('Uncovered', { covered: false })];
      orgHasCoverage.value = false;
      try {
        const result = await FlowcovReadiness.run([
          '--target-org',
          testOrg.username,
          '--project-dir',
          out,
          '--output-format',
          'markdown',
          '--fail-if-not-ready',
        ]);
        expect(result.ready).toBe(false);
        expect(process.exitCode).toBe(1);
        expect(ux.table.called).toBe(false);
        expect(ux.warn.called).toBe(false);
        expect(logged()).toContain('## Flow coverage readiness\n\n**Not ready**');
        expect(logged()).toContain('> [!WARNING]\n> The org has no Flow coverage recorded for any Flow.');
        expect(logged()).toContain('| `Uncovered` | AutoLaunchedFlow | 1 |');
      } finally {
        orgHasCoverage.value = true;
      }
    });

    it('prints no tables for an org without Flows', async () => {
      orgFlows.value = [];
      await FlowcovReadiness.run(['--target-org', testOrg.username, '--project-dir', out]);
      expect(ux.table.called).toBe(false);
    });
  });

  describe('gate', () => {
    let repo: TempGitRepo;

    beforeAll(() => {
      repo = new TempGitRepo();
      repo.commit('base', { 'README.md': 'x' });
      repo.git('checkout', '-q', '-b', 'feature');
      repo.commit('flows', { 'flows/Good.flow-meta.xml': flowXml(), 'flows/Bad.flow-meta.xml': flowXml() });
    });

    afterAll(() => repo.remove());

    it('passes named Flows that are covered', async () => {
      orgFlows.value = [coverage('Good')];
      const result = await FlowcovGate.run(['--target-org', testOrg.username, '--flow', 'Good']);
      expect(result.passed).toBe(true);
      expect(tableRows()).toEqual([
        { Flow: 'Good', Result: 'PASS', 'Element Coverage': '80%', Reason: 'Covered by 1 test method(s).' },
      ]);
      expect(logged()).toContain('Flow coverage gate passed for 1 Flow(s).');
      expect(process.exitCode).toBeUndefined();
    });

    it('fails changed Flows without coverage', async () => {
      orgFlows.value = [coverage('Good'), coverage('Bad', { covered: false })];
      const result = await FlowcovGate.run([
        '--target-org',
        testOrg.username,
        '--from',
        'main',
        '--to',
        'feature',
        '--project-dir',
        repo.dir,
        '--min-element-coverage',
        '50',
      ]);
      expect(result.passed).toBe(false);
      expect(result.minElementCoverage).toBe(50);
      expect(logged()).toContain('Flow coverage gate failed for 1 Flow(s). See the Reason column.');
      expect(process.exitCode).toBe(1);
    });

    it('warns when a changed Flow differs from the org version, and fails with --content-check fail', async () => {
      const good = coverage('Good');
      orgFlows.value = [good, coverage('Bad')];
      orgFingerprints.value = {
        [good.flowVersionId]: { processType: 'AutoLaunchedFlow', filters: [], elements: ['decisions:Old'] },
      };
      const args = ['--target-org', testOrg.username, '--from', 'main', '--to', 'feature', '--project-dir', repo.dir];

      const warned = await FlowcovGate.run(args);
      expect(warned.passed).toBe(true);
      expect(logged()).toContain(
        "Good: The org's version 1 differs from flows/Good.flow-meta.xml (only in the org: decisions:Old)",
      );
      expect(process.exitCode).toBeUndefined();

      const failed = await FlowcovGate.run([...args, '--content-check', 'fail']);
      expect(failed.passed).toBe(false);
      expect(failed.flows.find((f) => f.flowName === 'Good')?.status).toBe('fail');
      orgFingerprints.value = {};
    });

    it('shows a blank element coverage for Flows missing from the org', async () => {
      orgFlows.value = [];
      await FlowcovGate.run(['--target-org', testOrg.username, '--flow', 'Ghost']);
      expect(tableRows()[0]).toMatchObject({ Flow: 'Ghost', Result: 'FAIL', 'Element Coverage': '' });
    });

    it('does nothing when no Flows changed', async () => {
      const result = await FlowcovGate.run([
        '--target-org',
        testOrg.username,
        '--from',
        'feature',
        '--to',
        'feature',
        '--project-dir',
        repo.dir,
      ]);
      expect(result).toEqual({ passed: true, minElementCoverage: 0, flows: [], warnings: [] });
      expect(logged()).toContain('No Flows changed. Nothing to check.');
    });

    it('skips Flows excluded by .flowcovignore and --exclude', async () => {
      orgFlows.value = [coverage('Good', { covered: false }), coverage('Bad', { covered: false })];
      const project = new TempGitRepo();
      try {
        project.commit('base', { 'README.md': 'x' });
        project.git('checkout', '-q', '-b', 'feature');
        project.commit('flows', {
          '.flowcovignore': 'good  # deferred\n',
          'flows/Good.flow-meta.xml': flowXml(),
          'flows/Bad.flow-meta.xml': flowXml(),
        });
        const args = ['--target-org', testOrg.username, '--from', 'main', '--project-dir', project.dir];
        const ignored = await FlowcovGate.run(args);
        expect(ignored.flows.map((f) => [f.flowName, f.status])).toEqual([
          ['Good', 'skip'],
          ['Bad', 'fail'],
        ]);
        expect(tableRows()).toContainEqual(
          expect.objectContaining({ Reason: 'Excluded by .flowcovignore: good (deferred).' }),
        );

        const result = await FlowcovGate.run([...args, '--exclude', 'flows/Bad.*']);
        expect(result.passed).toBe(true);
        expect(result.flows.find((f) => f.flowName === 'Bad')?.reason).toBe('Excluded by --exclude: flows/Bad.*.');
      } finally {
        project.remove();
      }
    });

    it('prints Markdown with --output-format markdown', async () => {
      orgFlows.value = [coverage('Good'), coverage('Bad', { covered: false })];
      const result = await FlowcovGate.run([
        '--target-org',
        testOrg.username,
        '--flow',
        'Good',
        '--flow',
        'Bad',
        '--output-format',
        'markdown',
      ]);
      expect(result.passed).toBe(false);
      expect(process.exitCode).toBe(1);
      expect(ux.table.called).toBe(false);
      expect(ux.warn.called).toBe(false);
      expect(logged()).toContain('## Flow coverage gate\n\n**Failed** for 1 of 2 Flow(s).');
      expect(logged()).toContain('| `Bad` | FAIL | 0% |');

      await FlowcovGate.run([
        '--target-org',
        testOrg.username,
        '--from',
        'feature',
        '--to',
        'feature',
        '--project-dir',
        repo.dir,
        '--output-format',
        'markdown',
      ]);
      expect(logged()).toContain('## Flow coverage gate\n\nNo Flows changed. Nothing to check.');
    });

    it('requires --from or --flow', async () => {
      await expect(FlowcovGate.run(['--target-org', testOrg.username])).rejects.toThrow(/Provide --from/);
    });
  });

  describe('transform', () => {
    it('writes each requested format and reports skipped Flows and mismatches', async () => {
      writeFileSync(
        join(out, 'Job.flow-meta.xml'),
        [
          '<Flow>',
          '<decisions>',
          '<name>Check</name>',
          '</decisions>',
          '<assignments>',
          '<name>Set</name>',
          '</assignments>',
          '</Flow>',
          '',
        ].join('\n'),
      );
      orgFlows.value = [
        coverage('Job', { versionNumber: 3, elementsCovered: 1, elementsTotal: 3, coveredElementNames: ['check'] }),
        coverage('Elsewhere'),
      ];
      const reports = join(out, 'reports');
      const result = await FlowcovTransform.run([
        '--target-org',
        testOrg.username,
        '--project-dir',
        out,
        '--format',
        'lcov',
        '--format',
        'sonar',
        '--format',
        'lcov',
        '--output-dir',
        reports,
      ]);
      expect(result.files).toEqual([
        { format: 'lcov', path: join(reports, 'flow-coverage.info') },
        { format: 'sonar', path: join(reports, 'flow-coverage-sonar.xml') },
      ]);
      expect(result.flows).toEqual([
        { flowName: 'Job', path: 'Job.flow-meta.xml', elementsCovered: 1, elementsTotal: 2 },
      ]);
      expect(readFileSync(join(reports, 'flow-coverage.info'), 'utf8')).toContain(
        'SF:Job.flow-meta.xml\nDA:3,1\nDA:6,0\n',
      );
      expect(tableRows()).toEqual([{ Flow: 'Job', File: 'Job.flow-meta.xml', 'Elements Covered': '1 of 2' }]);
      expect(logged()).toContain('Job: Job.flow-meta.xml has 2 elements, but version 3 in the org has 3.');
      expect(logged()).toContain('Elsewhere: No source file in the project.');
      expect(logged()).toContain('Wrote sonar coverage for 1 Flow(s) to');
    });

    it('writes empty reports when no Flow has a source file', async () => {
      orgFlows.value = [];
      const result = await FlowcovTransform.run([
        '--target-org',
        testOrg.username,
        '--project-dir',
        out,
        '--format',
        'cobertura',
        '--output-dir',
        out,
      ]);
      expect(result.flows).toEqual([]);
      expect(tableRows()).toEqual([]);
      expect(readFileSync(join(out, 'flow-coverage-cobertura.xml'), 'utf8')).toContain('lines-valid="0"');
    });
  });

  describe('scaffold', () => {
    it('generates tests for named Flows', async () => {
      const result = await FlowcovScaffold.run([
        '--flow',
        'Case_Update',
        '--flow',
        'Intake_Screen',
        '--project-dir',
        FIXTURE_PROJECT,
        '--output-dir',
        out,
      ]);
      expect(result.created.map((c) => c.className)).toEqual(['Case_Update_FlowTest']);
      expect(logged()).toContain(
        `Created Case_Update_FlowTest for Case_Update: ${join(out, 'Case_Update_FlowTest.cls')}`,
      );
      expect(logged()).toContain('Skipped Intake_Screen: Process type Flow');
    });

    it('generates tests for uncovered local Flows on a dry run', async () => {
      orgFlows.value = [
        coverage('Nightly_Cleanup', { covered: false }),
        coverage('ns__Managed', { covered: false }),
        coverage('Case_Update'),
      ];
      const result = await FlowcovScaffold.run([
        '--uncovered',
        '--target-org',
        testOrg.username,
        '--project-dir',
        FIXTURE_PROJECT,
        '--output-dir',
        out,
        '--dry-run',
      ]);
      expect(result.created.map((c) => c.flowName)).toEqual(['Nightly_Cleanup']);
      expect(logged()).toContain('Would create Nightly_Cleanup_FlowTest');
    });

    it("warns about fields the Flow uses that the user can't see", async () => {
      orgDescribes.value = {
        Case: [{ name: 'Priority', type: 'picklist', nillable: true, createable: true, defaultedOnCreate: false }],
      };
      try {
        const result = await FlowcovScaffold.run([
          '--flow',
          'Case_Update',
          '--target-org',
          testOrg.username,
          '--project-dir',
          FIXTURE_PROJECT,
          '--output-dir',
          out,
        ]);
        expect(result.inaccessibleFields).toEqual([
          { flowName: 'Case_Update', object: 'Case', fields: ['IsEscalated'] },
        ]);
        expect(logged()).toContain("Case_Update uses Case fields you can't see: IsEscalated.");
        expect(readFileSync(join(out, 'Case_Update_FlowTest.cls'), 'utf8')).toContain(' *   Case: IsEscalated');
      } finally {
        orgDescribes.value = {};
      }
    });

    it('says so when nothing is uncovered', async () => {
      orgFlows.value = [coverage('Case_Update')];
      await FlowcovScaffold.run(['--uncovered', '--target-org', testOrg.username, '--project-dir', FIXTURE_PROJECT]);
      expect(logged()).toContain('No uncovered Flows to scaffold.');
    });

    it('requires --flow or --uncovered', async () => {
      await expect(FlowcovScaffold.run(['--project-dir', FIXTURE_PROJECT])).rejects.toThrow(
        /Provide --flow or --uncovered/,
      );
    });

    it('requires an org for --uncovered', async () => {
      await $$.stubConfig({});
      await expect(FlowcovScaffold.run(['--uncovered', '--project-dir', FIXTURE_PROJECT])).rejects.toThrow(
        /--uncovered needs --target-org/,
      );
    });
  });
});
