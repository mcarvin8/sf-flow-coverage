import { describeElements } from './elementCoverage.js';
import { deployAsActiveAdvice } from './flowSettings.js';
import { isProcessBuilder, PROCESS_BUILDER_ADVICE, processTypeLabel } from './flowTypes.js';
import { coverageLines, ELEMENT_COVERAGE_NOTE } from './readiness.js';
import type { FlowTestRef, GateResult, ReadinessResult } from './types.js';

/** Output formats the `readiness` and `gate` commands print. */
export const OUTPUT_FORMATS = ['human', 'markdown'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Text for a table cell: one line, with pipes escaped. */
function cell(value: string | number | undefined): string {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|');
}

/** An API name as inline code, so underscores and other characters show as typed. */
function code(name: string): string {
  return `\`${name.replace(/`/g, "'")}\``;
}

function table(headers: string[], rows: Array<Array<string | number | undefined>>): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ];
}

/** A GitHub alert block (`> [!WARNING]`), which other Markdown renderers show as a quote. */
function alert(kind: 'NOTE' | 'WARNING', lines: string[]): string[] {
  if (lines.length === 0) return [];
  const body = lines.length === 1 ? lines : lines.map((line) => `- ${line}`);
  return [`> [!${kind}]`, ...body.map((line) => `> ${line}`), ''];
}

function testNames(tests: FlowTestRef[]): string {
  return [...new Set(tests.map((t) => code(`${t.className}.${t.methodName}`)))].join(', ');
}

/**
 * The readiness report as Markdown, for a pull request comment or a GitHub job summary
 * (`$GITHUB_STEP_SUMMARY`).
 */
export function readinessMarkdown(result: ReadinessResult): string {
  const lines = ['## Flow coverage readiness', ''];
  const status = result.ready
    ? '**Ready**: the org meets the coverage needed to deploy Flows as active.'
    : `**Not ready**: add Apex tests for ${result.flowsNeeded} more Flow(s) to reach ${result.threshold}%.`;
  lines.push(status, '', ...coverageLines(result, (text) => `**${text}**`).flatMap((line) => [line, '']));

  const warnings = [...result.warnings];
  if (result.deployAsActive !== undefined) {
    const sandbox = result.isSandbox === true;
    const advice = deployAsActiveAdvice(result.deployAsActive, result.ready, result.threshold, sandbox);
    // On in production but below the threshold, deployments fail: that's worth a warning.
    if (result.deployAsActive && !result.ready && !sandbox) warnings.push(advice);
    else lines.push(advice, '');
  }
  lines.push(...alert('WARNING', warnings));
  if (result.processBuilderProcesses > 0) {
    lines.push(
      ...alert('NOTE', [
        `${result.processBuilderProcesses} of the active Flows are Process Builder processes. ${PROCESS_BUILDER_ADVICE}`,
      ]),
    );
  }

  const uncovered = result.flows.filter((f) => !f.covered);
  if (uncovered.length > 0) {
    const showChanges = result.flows.some((f) => f.changes !== undefined);
    lines.push(
      `### Uncovered Flows (${uncovered.length})`,
      '',
      ...table(
        ['Flow', 'Type', 'Version', ...(showChanges ? ['Changes'] : [])],
        uncovered.map((f) => [
          code(f.flowName),
          processTypeLabel(f.processType),
          f.versionNumber,
          ...(showChanges ? [f.changes] : []),
        ]),
      ),
      '',
    );
  }

  const covered = result.flows.filter((f) => f.covered);
  if (covered.length > 0) {
    const showType = covered.some((f) => isProcessBuilder(f.processType));
    const showUncovered = covered.some((f) => (f.uncoveredElements?.length ?? 0) > 0);
    lines.push(
      `### Covered Flows (${covered.length})`,
      '',
      ...table(
        [
          'Flow',
          ...(showType ? ['Type'] : []),
          'Element Coverage',
          ...(showUncovered ? ['Uncovered Elements'] : []),
          'Tests',
        ],
        covered.map((f) => [
          code(f.flowName),
          ...(showType ? [processTypeLabel(f.processType)] : []),
          `${f.elementCoveragePercent}%`,
          ...(showUncovered ? [describeElements(f.uncoveredElements ?? [])] : []),
          testNames(f.tests),
        ]),
      ),
      '',
      ELEMENT_COVERAGE_NOTE,
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The gate's results as Markdown, for a pull request comment or a GitHub job summary
 * (`$GITHUB_STEP_SUMMARY`).
 */
export function gateMarkdown(result: GateResult): string {
  const lines = ['## Flow coverage gate', ''];
  if (result.flows.length === 0) {
    lines.push('No Flows changed. Nothing to check.');
    return `${lines.join('\n')}\n`;
  }
  const failed = result.flows.filter((f) => f.status === 'fail').length;
  lines.push(
    result.passed
      ? `**Passed** for ${result.flows.length} Flow(s).`
      : `**Failed** for ${failed} of ${result.flows.length} Flow(s). See the Reason column.`,
    '',
  );
  if (result.minElementCoverage > 0) {
    lines.push(`Each Flow needs ${result.minElementCoverage}% element coverage.`, '');
  }
  lines.push(
    ...table(
      ['Flow', 'Result', 'Element Coverage', 'Reason'],
      result.flows.map((f) => [
        code(f.flowName),
        f.status.toUpperCase(),
        f.elementCoveragePercent === undefined ? '' : `${f.elementCoveragePercent}%`,
        f.reason,
      ]),
    ),
    '',
  );
  const warnings = [
    ...result.flows.flatMap((f) => (f.warnings ?? []).map((warning) => `${code(f.flowName)}: ${warning}`)),
    ...result.warnings,
  ];
  lines.push(...alert('WARNING', warnings));
  return `${lines.join('\n').trimEnd()}\n`;
}
