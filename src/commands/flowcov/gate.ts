import { Messages, SfError } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';

import { readIgnoreFile } from '../../core/exclusions.js';
import { collectChangedFlows, evaluateGate, type GateCandidate } from '../../core/gate.js';
import { gateMarkdown, OUTPUT_FORMATS } from '../../core/markdown.js';
import { OrgCoverageSource } from '../../core/orgCoverageSource.js';
import { toolingQuery } from '../../core/toolingQuery.js';
import type { GateResult } from '../../core/types.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-flow-coverage', 'flowcov.gate');

export default class FlowcovGate extends SfCommand<GateResult> {
  public static override readonly summary = messages.getMessage('summary');
  public static override readonly description = messages.getMessage('description');
  public static override readonly examples = messages.getMessages('examples');

  public static override readonly flags = {
    'target-org': Flags.requiredOrg(),
    'api-version': Flags.orgApiVersion(),
    from: Flags.string({
      summary: messages.getMessage('flags.from.summary'),
      exclusive: ['flow'],
    }),
    to: Flags.string({
      summary: messages.getMessage('flags.to.summary'),
      default: 'HEAD',
    }),
    flow: Flags.string({
      summary: messages.getMessage('flags.flow.summary'),
      multiple: true,
      exclusive: ['from'],
    }),
    'project-dir': Flags.directory({
      summary: messages.getMessage('flags.project-dir.summary'),
      char: 'd',
      default: '.',
      exists: true,
    }),
    'min-element-coverage': Flags.integer({
      summary: messages.getMessage('flags.min-element-coverage.summary'),
      default: 0,
      min: 0,
      max: 100,
    }),
    'content-check': Flags.option({
      summary: messages.getMessage('flags.content-check.summary'),
      description: messages.getMessage('flags.content-check.description'),
      options: ['warn', 'fail', 'off'] as const,
      default: 'warn',
    })(),
    exclude: Flags.string({
      summary: messages.getMessage('flags.exclude.summary'),
      description: messages.getMessage('flags.exclude.description'),
      multiple: true,
    }),
    'output-format': Flags.option({
      summary: messages.getMessage('flags.output-format.summary'),
      description: messages.getMessage('flags.output-format.description'),
      options: OUTPUT_FORMATS,
      default: 'human',
    })(),
  };

  public async run(): Promise<GateResult> {
    const { flags } = await this.parse(FlowcovGate);

    let candidates: GateCandidate[];
    if (flags.flow) {
      candidates = flags.flow.map((flowName) => ({ flowName }));
    } else if (flags.from) {
      candidates = await collectChangedFlows(flags['project-dir'], flags.from, flags.to);
    } else {
      throw new SfError(messages.getMessage('error.noInput'));
    }

    const markdown = flags['output-format'] === 'markdown';
    if (candidates.length === 0) {
      const empty = { passed: true, minElementCoverage: flags['min-element-coverage'], flows: [], warnings: [] };
      this.log(markdown ? gateMarkdown(empty) : 'No Flows changed. Nothing to check.');
      return empty;
    }

    const exclusions = [
      ...(await readIgnoreFile(flags['project-dir'])),
      ...(flags.exclude ?? []).map((pattern) => ({ pattern, source: '--exclude' })),
    ];
    const connection = flags['target-org'].getConnection(flags['api-version']);
    const result = await evaluateGate({
      source: new OrgCoverageSource(toolingQuery(connection)),
      candidates,
      minElementCoverage: flags['min-element-coverage'],
      contentCheck: flags['content-check'],
      exclusions,
    });

    if (!result.passed) process.exitCode = 1;
    if (markdown) {
      this.log(gateMarkdown(result));
      return result;
    }
    this.logResult(result);
    return result;
  }

  private logResult(result: GateResult): void {
    this.table({
      data: result.flows.map((f) => ({
        Flow: f.flowName,
        Result: f.status.toUpperCase(),
        'Element Coverage': f.elementCoveragePercent === undefined ? '' : `${f.elementCoveragePercent}%`,
        Reason: f.reason,
      })),
    });

    for (const flow of result.flows) {
      for (const warning of flow.warnings ?? []) this.warn(`${flow.flowName}: ${warning}`);
    }
    for (const warning of result.warnings) this.warn(warning);

    if (result.passed) {
      this.logSuccess(`Flow coverage gate passed for ${result.flows.length} Flow(s).`);
    } else {
      const failed = result.flows.filter((f) => f.status === 'fail').length;
      this.warn(`Flow coverage gate failed for ${failed} Flow(s). See the Reason column.`);
    }
  }
}
