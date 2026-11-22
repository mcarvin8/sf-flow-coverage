import { describe, expect, it } from 'vitest';

import { gateMarkdown, readinessMarkdown } from '../../src/core/markdown.js';
import type { GateResult, ReadinessResult } from '../../src/core/types.js';

const readiness = (overrides: Partial<ReadinessResult> = {}): ReadinessResult => ({
  threshold: 75,
  totalFlows: 2,
  coveredFlows: 1,
  uncoveredFlows: 1,
  coveragePercent: 50,
  ready: false,
  flowsNeeded: 1,
  processBuilderProcesses: 0,
  warnings: [],
  flows: [
    {
      flowName: 'Close_Cases',
      processType: 'AutoLaunchedFlow',
      versionNumber: 3,
      covered: false,
      elementCoveragePercent: 0,
      tests: [],
    },
    {
      flowName: 'Account_Sync',
      processType: 'AutoLaunchedFlow',
      versionNumber: 1,
      covered: true,
      elementCoveragePercent: 80,
      tests: [
        { className: 'Account_Test', methodName: 'syncs' },
        { className: 'Account_Test', methodName: 'syncs' },
      ],
    },
  ],
  ...overrides,
});

describe('readinessMarkdown', () => {
  it('reports an org that is not ready, with a table for each kind of Flow', () => {
    expect(readinessMarkdown(readiness())).toBe(`## Flow coverage readiness

**Not ready**: add Apex tests for 1 more Flow(s) to reach 75%.

Flow coverage: **50%** (1 of 2 active Flows and processes have a test). Threshold: 75%.

### Uncovered Flows (1)

| Flow | Type | Version |
| --- | --- | --- |
| \`Close_Cases\` | AutoLaunchedFlow | 3 |

### Covered Flows (1)

| Flow | Element Coverage | Tests |
| --- | --- | --- |
| \`Account_Sync\` | 80% | \`Account_Test.syncs\` |
`);
  });

  it('adds change counts, process types, uncovered elements, warnings, and the setting', () => {
    const markdown = readinessMarkdown(
      readiness({
        ready: true,
        processBuilderProcesses: 1,
        deployAsActive: false,
        isSandbox: false,
        warnings: ['The org has no Flow coverage recorded for any Flow.'],
        flows: [
          {
            flowName: 'Close`Cases',
            processType: 'AutoLaunchedFlow',
            covered: false,
            elementCoveragePercent: 0,
            tests: [],
            changes: 4,
          },
          {
            flowName: 'Old_Process',
            processType: 'Workflow',
            covered: true,
            elementCoveragePercent: 50,
            tests: [{ className: 'Old_Test', methodName: 'runs' }],
            uncoveredElements: [{ name: 'Update_A|B', type: 'recordUpdate' }],
          },
          { flowName: 'Plain', processType: 'AutoLaunchedFlow', covered: true, elementCoveragePercent: 100, tests: [] },
        ],
      }),
    );
    expect(markdown).toContain('**Ready**: the org meets the coverage needed to deploy Flows as active.');
    expect(markdown).toContain('Deploy processes and flows as active is off. The org has the coverage it needs');
    expect(markdown).toContain('> [!WARNING]\n> The org has no Flow coverage recorded for any Flow.\n');
    expect(markdown).toContain('> [!NOTE]\n> 1 of the active Flows are Process Builder processes.');
    expect(markdown).toContain("| `Close'Cases` | AutoLaunchedFlow |  | 4 |");
    expect(markdown).toContain('| Flow | Type | Element Coverage | Uncovered Elements | Tests |');
    expect(markdown).toContain(
      '| `Old_Process` | Process Builder (record change) | 50% | Update_A\\|B (recordUpdate) | `Old_Test.runs` |',
    );
    expect(markdown).toContain('| `Plain` | AutoLaunchedFlow | 100% |  |  |');
  });

  it('warns when the setting is on in production below the threshold, and lists several warnings', () => {
    const markdown = readinessMarkdown(readiness({ deployAsActive: true, isSandbox: false, warnings: ['First.'] }));
    expect(markdown).toContain(
      '> [!WARNING]\n> - First.\n> - Deploy processes and flows as active is on, but coverage is below 75%',
    );
  });

  it('reports an org without Flows', () => {
    expect(readinessMarkdown(readiness({ flows: [], totalFlows: 0, coveredFlows: 0, ready: true }))).not.toContain(
      '###',
    );
  });
});

describe('gateMarkdown', () => {
  const gate = (overrides: Partial<GateResult> = {}): GateResult => ({
    passed: false,
    minElementCoverage: 0,
    warnings: [],
    flows: [
      {
        flowName: 'Good',
        status: 'pass',
        reason: 'Covered by 1 test method(s).',
        elementCoveragePercent: 80,
        tests: [],
      },
      { flowName: 'Ghost', status: 'fail', reason: 'Flow not found in the target org.', tests: [] },
    ],
    ...overrides,
  });

  it('reports each Flow in a table', () => {
    expect(gateMarkdown(gate())).toBe(`## Flow coverage gate

**Failed** for 1 of 2 Flow(s). See the Reason column.

| Flow | Result | Element Coverage | Reason |
| --- | --- | --- | --- |
| \`Good\` | PASS | 80% | Covered by 1 test method(s). |
| \`Ghost\` | FAIL |  | Flow not found in the target org. |
`);
  });

  it('adds the minimum element coverage and warnings for Flows and for the run', () => {
    const markdown = gateMarkdown(
      gate({
        passed: true,
        minElementCoverage: 60,
        warnings: ['No Flow coverage at all.'],
        flows: [{ flowName: 'Good', status: 'pass', reason: 'Line one\nline two', tests: [], warnings: ['Stale.'] }],
      }),
    );
    expect(markdown).toContain('**Passed** for 1 Flow(s).\n\nEach Flow needs 60% element coverage.');
    expect(markdown).toContain('| Line one line two |');
    expect(markdown).toContain('> [!WARNING]\n> - `Good`: Stale.\n> - No Flow coverage at all.\n');
  });

  it('says when no Flows changed', () => {
    expect(gateMarkdown(gate({ passed: true, flows: [] }))).toBe(
      '## Flow coverage gate\n\nNo Flows changed. Nothing to check.\n',
    );
  });
});
