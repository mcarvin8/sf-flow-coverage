import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { apexClassMetaXml, flowKind, generateApexTest } from './apexTemplate.js';
import { isCountedProcessType } from './flowTypes.js';
import { parseFlowXml } from './flowXml.js';
import { findFlowFiles, readProjectConfig } from './projectFiles.js';
import { type DescribeObject, loadObjectFields, type ObjectFields } from './requiredFields.js';
import type { FlowMetadata, ScaffoldResult } from './types.js';

export const DEFAULT_APEX_API_VERSION = '65.0';

export type ScaffoldOptions = {
  flowNames: string[];
  /** Project root: searched for Flow files and sfdx-project.json. */
  projectDir: string;
  /** Where to write classes. Defaults to `<default package>/main/default/classes`. */
  outputDir?: string;
  /** Overwrite test classes that already exist. */
  force?: boolean;
  /** Report what would be generated without writing files. */
  dryRun?: boolean;
  /** Describes sObjects in the org so generated records set their required fields. */
  describe?: DescribeObject;
};

/** sObjects a generated test creates records of. */
function objectsToCreate(flow: FlowMetadata): string[] {
  const kind = flowKind(flow);
  const objects = flow.variables
    .filter((v) => v.isInput && !v.isCollection && v.dataType === 'SObject' && v.objectType)
    .map((v) => v.objectType as string);
  if ((kind === 'record' || kind === 'platformEvent') && flow.object) objects.push(flow.object);
  return objects;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Generates starter Apex tests for the named Flows from their metadata files in the project. */
export async function scaffoldTests(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const project = await readProjectConfig(options.projectDir);
  const outputDir =
    options.outputDir ??
    join(options.projectDir, project.defaultPackagePath ?? 'force-app', 'main', 'default', 'classes');
  const apiVersion = project.sourceApiVersion ?? DEFAULT_APEX_API_VERSION;
  const flowFiles = await findFlowFiles(options.projectDir);
  const result: ScaffoldResult = { created: [], skipped: [] };

  const flows: Array<{ flowName: string; flow: FlowMetadata }> = [];
  for (const flowName of [...new Set(options.flowNames)]) {
    const flowPath = flowFiles.get(flowName);
    if (!flowPath) {
      result.skipped.push({ flowName, reason: `No ${flowName}.flow-meta.xml found under ${options.projectDir}.` });
      continue;
    }
    let flow: FlowMetadata;
    try {
      flow = parseFlowXml(flowName, await readFile(flowPath, 'utf8'));
    } catch (error) {
      result.skipped.push({ flowName, reason: (error as Error).message });
      continue;
    }
    if (!isCountedProcessType(flow.processType)) {
      result.skipped.push({
        flowName,
        reason: `Process type ${flow.processType ?? 'unknown'} does not count toward deploy-as-active coverage.`,
      });
      continue;
    }
    flows.push({ flowName, flow });
  }

  const objectFields: ObjectFields = options.describe
    ? await loadObjectFields(
        flows.flatMap((f) => objectsToCreate(f.flow)),
        options.describe,
      )
    : { requiredFields: {}, fieldValues: {}, changedValues: {} };

  for (const { flowName, flow } of flows) {
    const test = generateApexTest(flow, objectFields);
    const classPath = join(outputDir, `${test.className}.cls`);
    if (!options.force && (await exists(classPath))) {
      result.skipped.push({ flowName, reason: `${classPath} already exists. Use --force to overwrite.` });
      continue;
    }
    if (!options.dryRun) {
      await mkdir(outputDir, { recursive: true });
      await writeFile(classPath, test.body, 'utf8');
      await writeFile(`${classPath}-meta.xml`, apexClassMetaXml(apiVersion), 'utf8');
    }
    result.created.push({ flowName, className: test.className, path: classPath });
  }
  return result;
}
