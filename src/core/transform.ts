import { readFile } from 'node:fs/promises';
import { relative, sep } from 'node:path';

import { missingCoverageWarning } from './coverageCheck.js';
import { flowElementLines } from './flowElementLines.js';
import { findFlowFiles } from './projectFiles.js';
import type { CoverageSource } from './types.js';

/** One executable element of a Flow as a line in its source file. */
export type FlowCoverageLine = {
  line: number;
  covered: boolean;
  element: string;
  type: string;
};

/** Element coverage of one Flow, mapped onto its source file. */
export type FlowFileCoverage = {
  flowName: string;
  /** Source file path relative to the project directory, with `/` separators. */
  path: string;
  lines: FlowCoverageLine[];
};

export type FlowFileCoverageReport = {
  files: FlowFileCoverage[];
  /** Active Flows left out, and why. */
  skipped: Array<{ flowName: string; reason: string }>;
  /** Flows whose source file may not match the version the org covered. */
  warnings: string[];
};

export type FlowFileCoverageOptions = {
  source: CoverageSource;
  /** Project root: searched for Flow files; output paths are relative to it. */
  projectDir: string;
};

/**
 * Maps the org's element coverage onto the project's Flow files: each executable element is a
 * line (the line of its `<name>`), covered when any Apex test ran it. Covers every active Flow
 * that counts toward deploy-as-active and has a source file in the project.
 */
export async function buildFlowFileCoverage(options: FlowFileCoverageOptions): Promise<FlowFileCoverageReport> {
  const flows = await options.source.listActiveCountedFlows();
  const flowFiles = await findFlowFiles(options.projectDir);
  const report: FlowFileCoverageReport = { files: [], skipped: [], warnings: [] };

  for (const flow of [...flows].sort((a, b) => a.flowName.localeCompare(b.flowName))) {
    const file = flowFiles.get(flow.flowName);
    if (!file) {
      report.skipped.push({ flowName: flow.flowName, reason: 'No source file in the project.' });
      continue;
    }
    if (flow.covered && !flow.coveredElementNames) {
      report.skipped.push({ flowName: flow.flowName, reason: 'The org did not report which elements tests ran.' });
      continue;
    }
    const path = relative(options.projectDir, file).split(sep).join('/');
    const elements = flowElementLines(await readFile(file, 'utf8'));
    if (elements.length === 0) {
      report.skipped.push({ flowName: flow.flowName, reason: 'The source file has no elements.' });
      continue;
    }
    const covered = new Set((flow.coveredElementNames ?? []).map((name) => name.toLowerCase()));
    const local = new Set(elements.map((e) => e.name.toLowerCase()));
    // Salesforce counts elements only for versions some test ran, so uncovered Flows can't be compared.
    const version = `version ${flow.versionNumber ?? '?'} in the org`;
    const missing = [...covered].filter((name) => !local.has(name));
    let mismatch: string | undefined;
    if (flow.covered && elements.length !== flow.elementsTotal) {
      mismatch = `${path} has ${elements.length} elements, but ${version} has ${flow.elementsTotal}`;
    } else if (missing.length > 0) {
      mismatch = `tests ran elements of ${version} that ${path} doesn't have (${missing.join(', ')})`;
    }
    if (mismatch) {
      report.warnings.push(
        `${flow.flowName}: ${mismatch}. Its line coverage may be off; retrieve or deploy the Flow so they match.`,
      );
    }
    report.files.push({
      flowName: flow.flowName,
      path,
      lines: elements.map((e) => ({
        line: e.line,
        covered: covered.has(e.name.toLowerCase()),
        element: e.name,
        type: e.type,
      })),
    });
  }
  const warning = await missingCoverageWarning(
    options.source,
    report.files.length > 0 && flows.every((flow) => !flow.covered),
  );
  if (warning) report.warnings.unshift(warning);
  return report;
}
