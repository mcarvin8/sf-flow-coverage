import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Messages } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';

import { COVERAGE_FILE_NAMES, COVERAGE_FORMATS, formatCoverage } from '../../core/coverageFormats.js';
import { OrgCoverageSource } from '../../core/orgCoverageSource.js';
import { toolingQuery } from '../../core/toolingQuery.js';
import { buildFlowFileCoverage } from '../../core/transform.js';
import type { TransformResult } from '../../core/types.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-flow-coverage', 'flowcov.transform');

export default class FlowcovTransform extends SfCommand<TransformResult> {
  public static override readonly summary = messages.getMessage('summary');
  public static override readonly description = messages.getMessage('description');
  public static override readonly examples = messages.getMessages('examples');

  public static override readonly flags = {
    'target-org': Flags.requiredOrg(),
    'api-version': Flags.orgApiVersion(),
    format: Flags.option({
      summary: messages.getMessage('flags.format.summary'),
      options: COVERAGE_FORMATS,
      multiple: true,
      required: true,
    })(),
    'output-dir': Flags.directory({
      summary: messages.getMessage('flags.output-dir.summary'),
      default: 'coverage',
    }),
    'project-dir': Flags.directory({
      summary: messages.getMessage('flags.project-dir.summary'),
      char: 'd',
      default: '.',
      exists: true,
    }),
  };

  public async run(): Promise<TransformResult> {
    const { flags } = await this.parse(FlowcovTransform);
    const connection = flags['target-org'].getConnection(flags['api-version']);

    this.spinner.start('Reading Flow coverage');
    const report = await buildFlowFileCoverage({
      source: new OrgCoverageSource(toolingQuery(connection)),
      projectDir: flags['project-dir'],
    });
    this.spinner.stop();

    await mkdir(flags['output-dir'], { recursive: true });
    const files: TransformResult['files'] = [];
    for (const format of [...new Set(flags.format)]) {
      const path = join(flags['output-dir'], COVERAGE_FILE_NAMES[format]);
      await writeFile(path, formatCoverage(format, report.files), 'utf8');
      files.push({ format, path });
    }

    for (const warning of report.warnings) this.warn(warning);
    const flows = report.files.map((file) => ({
      flowName: file.flowName,
      path: file.path,
      elementsCovered: file.lines.filter((l) => l.covered).length,
      elementsTotal: file.lines.length,
    }));
    if (flows.length > 0) {
      this.table({
        data: flows.map((f) => ({
          Flow: f.flowName,
          File: f.path,
          'Elements Covered': `${f.elementsCovered} of ${f.elementsTotal}`,
        })),
      });
    }
    if (report.skipped.length > 0) {
      this.log(`Skipped ${report.skipped.length} active Flow(s):`);
      for (const skipped of report.skipped) this.log(`  ${skipped.flowName}: ${skipped.reason}`);
    }
    for (const file of files)
      this.logSuccess(`Wrote ${file.format} coverage for ${flows.length} Flow(s) to ${file.path}.`);
    return { files, flows, skipped: report.skipped, warnings: report.warnings };
  }
}
