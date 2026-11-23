import { Messages, SfError } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { emailAlertReader } from '../../core/emailAlerts.js';
import { lookupFilterReader } from '../../core/lookupFilters.js';
import { OrgCoverageSource } from '../../core/orgCoverageSource.js';
import { picklistValueReader } from '../../core/recordTypes.js';
import { scaffoldTests } from '../../core/scaffold.js';
import { describeObject, metadataRead, toolingQuery } from '../../core/toolingQuery.js';
import type { ScaffoldResult } from '../../core/types.js';
import { validationRuleReader } from '../../core/validationRules.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-flow-coverage', 'flowcov.scaffold');

export default class FlowcovScaffold extends SfCommand<ScaffoldResult> {
  public static override readonly summary = messages.getMessage('summary');
  public static override readonly description = messages.getMessage('description');
  public static override readonly examples = messages.getMessages('examples');

  public static override readonly flags = {
    flow: Flags.string({
      summary: messages.getMessage('flags.flow.summary'),
      char: 'f',
      multiple: true,
    }),
    uncovered: Flags.boolean({
      summary: messages.getMessage('flags.uncovered.summary'),
      default: false,
    }),
    'target-org': Flags.optionalOrg({ summary: messages.getMessage('flags.target-org.summary') }),
    'api-version': Flags.orgApiVersion(),
    'project-dir': Flags.directory({
      summary: messages.getMessage('flags.project-dir.summary'),
      char: 'd',
      default: '.',
      exists: true,
    }),
    'output-dir': Flags.directory({
      summary: messages.getMessage('flags.output-dir.summary'),
      char: 'r',
    }),
    force: Flags.boolean({
      summary: messages.getMessage('flags.force.summary'),
      default: false,
    }),
    'dry-run': Flags.boolean({
      summary: messages.getMessage('flags.dry-run.summary'),
      default: false,
    }),
  };

  public async run(): Promise<ScaffoldResult> {
    const { flags } = await this.parse(FlowcovScaffold);
    const flowNames = [...(flags.flow ?? [])];
    const connection = flags['target-org']?.getConnection(flags['api-version']);

    if (flags.uncovered) {
      if (!connection) throw new SfError(messages.getMessage('error.uncoveredNeedsOrg'));
      const source = new OrgCoverageSource(toolingQuery(connection));
      const flows = await source.listActiveCountedFlows();
      // Managed (namespaced) Flows are not in the project, so only local names are useful.
      flowNames.push(...flows.filter((f) => !f.covered && !f.flowName.includes('__')).map((f) => f.flowName));
    } else if (flowNames.length === 0) {
      throw new SfError(messages.getMessage('error.noInput'));
    }

    const result = await scaffoldTests({
      flowNames,
      projectDir: flags['project-dir'],
      outputDir: flags['output-dir'],
      force: flags.force,
      dryRun: flags['dry-run'],
      describe: connection ? describeObject(connection) : undefined,
      validationRules: connection ? validationRuleReader(toolingQuery(connection)) : undefined,
      lookupFilters: connection ? lookupFilterReader(metadataRead(connection)) : undefined,
      emailAlerts: connection ? emailAlertReader(metadataRead(connection)) : undefined,
      recordTypePicklists: connection ? picklistValueReader(connection) : undefined,
    });

    const verb = flags['dry-run'] ? 'Would create' : 'Created';
    for (const test of result.created) {
      const todos = test.todos.length === 0 ? '' : ` (${test.todos.length} TODO${test.todos.length === 1 ? '' : 's'})`;
      this.log(`${verb} ${test.className} for ${test.flowName}: ${test.path}${todos}`);
    }
    for (const skip of result.skipped) this.warn(`Skipped ${skip.flowName}: ${skip.reason}`);
    for (const hidden of result.inaccessibleFields) {
      this.warn(
        `${hidden.flowName} uses ${hidden.object} fields you can't see: ${hidden.fields.join(', ')}. If the user who runs tests can't see them either, the test fails with "fields being inaccessible": grant access with a permission set.`,
      );
    }
    if (result.created.length === 0 && result.skipped.length === 0) this.log('No uncovered Flows to scaffold.');
    return result;
  }
}
