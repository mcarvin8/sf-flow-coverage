import { Messages } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { describeElements } from '../../core/elementCoverage.js';
import { DEFAULT_THRESHOLD } from '../../core/flowTypes.js';
import { getFlowChurn } from '../../core/git.js';
import { OrgCoverageSource } from '../../core/orgCoverageSource.js';
import { buildReadinessReport } from '../../core/readiness.js';
import { toolingQuery } from '../../core/toolingQuery.js';
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
      default: DEFAULT_THRESHOLD,
      min: 0,
      max: 100,
    }),
    'fail-if-not-ready': Flags.boolean({
      summary: messages.getMessage('flags.fail-if-not-ready.summary'),
      default: false,
    }),
  };

  public async run(): Promise<ReadinessResult> {
    const { flags } = await this.parse(FlowcovReadiness);
    const connection = flags['target-org'].getConnection(flags['api-version']);

    this.spinner.start('Reading Flow coverage');
    const churn = await getFlowChurn(flags['project-dir'], flags.since);
    const result = await buildReadinessReport({
      source: new OrgCoverageSource(toolingQuery(connection)),
      churn,
      threshold: flags.threshold,
    });
    this.spinner.stop();

    this.logReport(result);
    if (flags['fail-if-not-ready'] && !result.ready) process.exitCode = 1;
    return result;
  }

  private logReport(result: ReadinessResult): void {
    this.log(
      `Flow coverage: ${result.coveragePercent}% (${result.coveredFlows} of ${result.totalFlows} active Flows and processes have a test). Threshold: ${result.threshold}%.`,
    );
    if (result.ready) {
      this.logSuccess('Ready: the org meets the coverage needed to deploy Flows as active.');
    } else {
      this.warn(`Not ready: add Apex tests for ${result.flowsNeeded} more Flow(s) to reach ${result.threshold}%.`);
    }

    const showChanges = result.flows.some((f) => f.changes !== undefined);
    const uncovered = result.flows.filter((f) => !f.covered);
    if (uncovered.length > 0) {
      this.table({
        title: 'Uncovered Flows',
        data: uncovered.map((f) => ({
          Flow: f.flowName,
          Type: f.processType,
          Version: f.versionNumber ?? '',
          ...(showChanges ? { Changes: f.changes ?? 0 } : {}),
        })),
      });
    }

    const covered = result.flows.filter((f) => f.covered);
    const showUncovered = covered.some((f) => (f.uncoveredElements?.length ?? 0) > 0);
    if (covered.length > 0) {
      this.table({
        title: 'Covered Flows',
        data: covered.map((f) => ({
          Flow: f.flowName,
          'Element Coverage': `${f.elementCoveragePercent}%`,
          ...(showUncovered ? { 'Uncovered Elements': describeElements(f.uncoveredElements ?? []) } : {}),
          Tests: [...new Set(f.tests.map((t) => `${t.className}.${t.methodName}`))].join(', '),
        })),
      });
    }
  }
}
