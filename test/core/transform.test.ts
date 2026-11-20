import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMLValidator } from 'fast-xml-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { formatCoverage } from '../../src/core/coverageFormats.js';
import { buildFlowFileCoverage, type FlowFileCoverage } from '../../src/core/transform.js';
import { coverage, fakeSource } from '../helpers.js';

const flowFile = (...elements: string[]): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Flow>',
    ...elements.map((e) => `    <decisions><name>${e}</name></decisions>`),
    '</Flow>',
    '',
  ].join('\n');

describe('buildFlowFileCoverage', () => {
  let project: string;

  beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-transform-'));
    const flows = join(project, 'force-app', 'main', 'default', 'flows');
    mkdirSync(flows, { recursive: true });
    writeFileSync(join(flows, 'Partial.flow-meta.xml'), flowFile('First', 'Second', 'Third'));
    writeFileSync(join(flows, 'Bare.flow-meta.xml'), flowFile('Only'));
    writeFileSync(join(flows, 'Stale.flow-meta.xml'), flowFile('Old'));
    writeFileSync(join(flows, 'Renamed.flow-meta.xml'), flowFile('New_Name'));
    writeFileSync(join(flows, 'Empty.flow-meta.xml'), '<Flow><variables><name>x</name></variables></Flow>');
    writeFileSync(join(flows, 'Unread.flow-meta.xml'), flowFile('A'));
  });

  afterAll(() => rmSync(project, { recursive: true, force: true }));

  it('maps element coverage onto each Flow file, skipping Flows it cannot map', async () => {
    const report = await buildFlowFileCoverage({
      projectDir: project,
      source: fakeSource([
        coverage('Partial', { elementsCovered: 2, elementsTotal: 3, coveredElementNames: ['first', 'third'] }),
        coverage('Bare', { covered: false, elementsTotal: 0 }),
        coverage('Stale', { versionNumber: 4, elementsCovered: 1, elementsTotal: 2, coveredElementNames: ['old'] }),
        coverage('Renamed', { elementsCovered: 1, elementsTotal: 1, coveredElementNames: ['old_name'] }),
        coverage('Empty', { covered: false }),
        coverage('Unread', { coveredElementNames: undefined }),
        coverage('Not_In_Project'),
      ]),
    });
    expect(report.files.map((f) => [f.flowName, f.path, f.lines.map((l) => `${l.line}:${l.covered ? 1 : 0}`)])).toEqual(
      [
        ['Bare', 'force-app/main/default/flows/Bare.flow-meta.xml', ['3:0']],
        ['Partial', 'force-app/main/default/flows/Partial.flow-meta.xml', ['3:1', '4:0', '5:1']],
        ['Renamed', 'force-app/main/default/flows/Renamed.flow-meta.xml', ['3:0']],
        ['Stale', 'force-app/main/default/flows/Stale.flow-meta.xml', ['3:1']],
      ],
    );
    expect(report.files[1].lines[1]).toEqual({ line: 4, covered: false, element: 'Second', type: 'decision' });
    expect(report.skipped).toEqual([
      { flowName: 'Empty', reason: 'The source file has no elements.' },
      { flowName: 'Not_In_Project', reason: 'No source file in the project.' },
      { flowName: 'Unread', reason: 'The org did not report which elements tests ran.' },
    ]);
    expect(report.warnings).toEqual([
      "Renamed: tests ran elements of version 1 in the org that force-app/main/default/flows/Renamed.flow-meta.xml doesn't have (old_name). Its line coverage may be off; retrieve or deploy the Flow so they match.",
      'Stale: force-app/main/default/flows/Stale.flow-meta.xml has 1 elements, but version 4 in the org has 2. Its line coverage may be off; retrieve or deploy the Flow so they match.',
    ]);
  });
});

describe('buildFlowFileCoverage without any coverage in the org', () => {
  it('warns first, before any per-Flow warning', async () => {
    const project = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-transform-'));
    try {
      writeFileSync(join(project, 'Bare.flow-meta.xml'), flowFile('Only'));
      const report = await buildFlowFileCoverage({
        projectDir: project,
        source: { ...fakeSource([coverage('Bare', { covered: false })]), hasAnyFlowCoverage: async () => false },
      });
      expect(report.warnings).toEqual([expect.stringContaining('--code-coverage')]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('formatCoverage', () => {
  const files: FlowFileCoverage[] = [
    {
      flowName: 'A&B',
      path: 'flows/A&B.flow-meta.xml',
      lines: [
        { line: 3, covered: true, element: 'One', type: 'decision' },
        { line: 9, covered: false, element: 'Two', type: 'assignment' },
      ],
    },
    { flowName: 'Root', path: 'Root.flow-meta.xml', lines: [{ line: 2, covered: false, element: 'X', type: 'loop' }] },
  ];

  it('writes SonarQube generic coverage', () => {
    const xml = formatCoverage('sonar', files);
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<coverage version="1">',
        '  <file path="flows/A&amp;B.flow-meta.xml">',
        '    <lineToCover lineNumber="3" covered="true"/>',
        '    <lineToCover lineNumber="9" covered="false"/>',
        '  </file>',
        '  <file path="Root.flow-meta.xml">',
        '    <lineToCover lineNumber="2" covered="false"/>',
        '  </file>',
        '</coverage>',
        '',
      ].join('\n'),
    );
  });

  it('writes Cobertura with a package per folder', () => {
    const xml = formatCoverage('cobertura', files, new Date(1_700_000_000_000));
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toContain(
      '<coverage line-rate="0.3333" branch-rate="0" lines-covered="1" lines-valid="3" branches-covered="0" branches-valid="0" complexity="0" version="1" timestamp="1700000000000">',
    );
    expect(xml).toContain('<package name="flows" line-rate="0.5000"');
    expect(xml).toContain('<class name="A&amp;B" filename="flows/A&amp;B.flow-meta.xml" line-rate="0.5000"');
    expect(xml).toContain('<line number="9" hits="0" branch="false"/>');
    expect(xml).toContain('<package name="." line-rate="0.0000"');
    expect(formatCoverage('cobertura', [])).toContain(
      'line-rate="1" branch-rate="0" lines-covered="0" lines-valid="0"',
    );
  });

  it('writes an lcov tracefile', () => {
    expect(formatCoverage('lcov', files)).toBe(
      [
        'TN:',
        'SF:flows/A&B.flow-meta.xml',
        'DA:3,1',
        'DA:9,0',
        'LF:2',
        'LH:1',
        'end_of_record',
        'TN:',
        'SF:Root.flow-meta.xml',
        'DA:2,0',
        'LF:1',
        'LH:0',
        'end_of_record',
        '',
      ].join('\n'),
    );
    expect(formatCoverage('lcov', [])).toBe('');
  });
});
