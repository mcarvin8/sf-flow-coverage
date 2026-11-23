import { Messages } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { describeElements } from '../../core/elementCoverage.js';
import { deployAsActiveAdvice } from '../../core/flowSettings.js';
import { isProcessBuilder, PROCESS_BUILDER_ADVICE, processTypeLabel } from '../../core/flowTypes.js';
import { getFlowChurn } from '../../core/git.js';
import { OUTPUT_FORMATS, readinessMarkdown } from '../../core/markdown.js';
import { OrgCoverageSource } from '../../core/orgCoverageSource.js';
import { buildReadinessReport, coverageLines, ELEMENT_COVERAGE_NOTE } from '../../core/readiness.js';
import { dataQuery, metadataRead, toolingQuery } from '../../core/toolingQuery.js';
import type { ReadinessResult } from '../../core/types.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-flow-coverage', 'flowcov.readiness');

export default class FlowcovReadiness extends SfCommand<ReadinessResult> {
  public static override readonly summary = messages.getMessage('summary');
  public static override readonly description = messages.getMessage('description');
  public static override readonly examples = messages.getMessages('examples');

  public static override readonly flags = {
    'target-org': Flags.requiredOrg(),
    'api-version': Flags.orgApiVersion(),
    'project-dir': Flags.directory({
      summary: messages.getMessage('flags.project-dir.summary'),
      char: 'd',
      default: '.',
      exists: true,
    }),
    since: Flags.string({
      summary: messages.getMessage('flags.since.summary'),
    }),
    threshold: Flags.integer({
      summary: messages.getMessage('flags.threshold.summary'),
      description: messages.getMessage('flags.threshold.description'),
      min: 0,
      max: 100,
    }),
    'fail-if-not-ready': Flags.boolean({
      summary: messages.getMessage('flags.fail-if-not-ready.summary'),
      default: false,
    }),
    'output-format': Flags.option({
      summary: messages.getMessage('flags.output-format.summary'),
      description: messages.getMessage('flags.output-format.description'),
      options: OUTPUT_FORMATS,
      default: 'human',
    })(),
  };

  public async run(): Promise<ReadinessResult> {
    const { flags } = await this.parse(FlowcovReadiness);
    const connection = flags['target-org'].getConnection(flags['api-version']);

    this.spinner.start('Reading Flow coverage');
    const churn = await getFlowChurn(flags['project-dir'], flags.since);
    const result = await buildReadinessReport({
      source: new OrgCoverageSource(toolingQuery(connection)),
      metadataRead: metadataRead(connection),
      dataQuery: dataQuery(connection),
      churn,
      threshold: flags.threshold,
    });
    this.spinner.stop();

    if (flags['output-format'] === 'markdown') {
      this.log(readinessMarkdown(result));
    } else {
      for (const warning of result.warnings) this.warn(warning);
      this.logReport(result);
    }
    if (flags['fail-if-not-ready'] && !result.ready) process.exitCode = 1;
    return result;
  }

  private logReport(result: ReadinessResult): void {
    for (const line of coverageLines(result)) this.log(line);
    if (result.ready) {
      this.logSuccess('Ready: the org meets the coverage needed to deploy Flows as active.');
    } else {
      this.warn(`Not ready: add Apex tests for ${result.flowsNeeded} more Flow(s) to reach ${result.threshold}%.`);
    }
    if (result.deployAsActive !== undefined) {
      const sandbox = result.isSandbox === true;
      const advice = deployAsActiveAdvice(result.deployAsActive, result.ready, result.threshold, sandbox);
      // On in production but below the threshold, deployments fail: that's worth a warning.
      if (result.deployAsActive && !result.ready && !sandbox) this.warn(advice);
      else this.log(advice);
    }

    const showChanges = result.flows.some((f) => f.changes !== undefined);
    const uncovered = result.flows.filter((f) => !f.covered);
    if (uncovered.length > 0) {
      this.table({
        title: 'Uncovered Flows',
        data: uncovered.map((f) => ({
          Flow: f.flowName,
          Type: processTypeLabel(f.processType),
          Version: f.versionNumber ?? '',
          ...(showChanges ? { Changes: f.changes } : {}),
        })),
      });
    }

    const covered = result.flows.filter((f) => f.covered);
    const showUncovered = covered.some((f) => (f.uncoveredElements?.length ?? 0) > 0);
    const showType = covered.some((f) => isProcessBuilder(f.processType));
    if (covered.length > 0) {
      this.table({
        title: 'Covered Flows',
        data: covered.map((f) => ({
          Flow: f.flowName,
          ...(showType ? { Type: processTypeLabel(f.processType) } : {}),
          'Element Coverage': `${f.elementCoveragePercent}%`,
          ...(showUncovered ? { 'Uncovered Elements': describeElements(f.uncoveredElements ?? []) } : {}),
          Tests: [...new Set(f.tests.map((t) => `${t.className}.${t.methodName}`))].join(', '),
        })),
      });
      this.log(ELEMENT_COVERAGE_NOTE);
    }

    if (result.processBuilderProcesses > 0) {
      this.warn(
        `${result.processBuilderProcesses} of the active Flows are Process Builder processes (Type "Process Builder"). ${PROCESS_BUILDER_ADVICE}`,
      );
    }
  }
}
