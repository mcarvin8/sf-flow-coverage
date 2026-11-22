import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { apexClassMetaXml, flowKind, generateApexTest } from './apexTemplate.js';
import { entryCondition, fieldPaths } from './conditions.js';
import { isCountedProcessType } from './flowTypes.js';
import { parseFlowXml } from './flowXml.js';
import type { LookupFilter, ReadLookupFilters } from './lookupFilters.js';
import { findFlowFiles, readProjectConfig } from './projectFiles.js';
import {
  canInsertParent,
  type DescribeObject,
  emptyObjectFields,
  loadObjectFields,
  MAX_PARENT_DEPTH,
  type ObjectFields,
} from './requiredFields.js';
import type { FlowMetadata, ScaffoldResult } from './types.js';
import type { ReadValidationRules, ValidationRule } from './validationRules.js';

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
  /** Reads each object's active validation rules, so generated records meet them where they can. */
  validationRules?: ReadValidationRules;
  /** Reads required lookup filters, so the parent records a test inserts meet them where they can. */
  lookupFilters?: ReadLookupFilters;
};

/** sObjects a generated test creates records of. */
function objectsToCreate(flow: FlowMetadata): string[] {
  const kind = flowKind(flow);
  const objects = flow.variables
    .filter((v) => v.isInput && !v.isCollection && v.dataType === 'SObject' && v.objectType)
    .map((v) => v.objectType as string);
  if ((kind === 'record' || kind === 'platformEvent') && flow.object) objects.push(flow.object);
  // A text input the Flow filters records by (`Id = {!recordId}`) gets a record of that object.
  for (const filter of idInputFilters(flow)) if (filter.field === 'Id') objects.push(filter.object);
  return objects;
}

/** Filters that compare a field with one of the Flow's text input variables. */
function idInputFilters(flow: FlowMetadata): Array<{ variable: string; object: string; field: string }> {
  if (flowKind(flow) !== 'autolaunched') return [];
  const inputs = new Set(
    flow.variables
      .filter((v) => v.isInput && !v.isCollection && ['String', 'Text'].includes(v.dataType))
      .map((v) => v.name),
  );
  return (flow.graph?.idFilters ?? []).filter((f) => inputs.has(f.variable));
}

/** Objects filtered by a lookup field compared with a text input, to learn what the lookup points to. */
function idInputLookupObjects(flow: FlowMetadata): string[] {
  return idInputFilters(flow)
    .filter((f) => f.field !== 'Id')
    .map((f) => f.object);
}

/**
 * Lookup fields the entry criteria read on the triggering record: lookups compared directly
 * (`Account__c`) and the lookups behind related fields (`Account__r.Type`).
 */
function criteriaLookups(flow: FlowMetadata, relationships: Record<string, string>): Set<string> {
  const lookups = new Set<string>();
  for (const path of fieldPaths(entryCondition(flow))) {
    if (path.length === 1) lookups.add(path[0]);
    else if (relationships[path[0]]) lookups.add(relationships[path[0]]);
  }
  return lookups;
}

/**
 * Objects a generated test inserts as parents: targets of lookups that are required, or that
 * the entry criteria reference, on the records the test creates.
 */
function parentObjects(flows: FlowMetadata[], fields: ObjectFields): string[] {
  const parents: string[] = [];
  for (const flow of flows) {
    // An input compared with a lookup field holds an Id of the lookup's target.
    for (const filter of idInputFilters(flow).filter((f) => f.field !== 'Id')) {
      const target = fields.lookups[filter.object]?.[filter.field];
      if (target && canInsertParent(target)) parents.push(target);
    }
    for (const object of objectsToCreate(flow)) {
      const criteria = object === flow.object ? criteriaLookups(flow, fields.relationships[object] ?? {}) : new Set();
      for (const [field, target] of Object.entries(fields.lookups[object] ?? {})) {
        const used = field in (fields.requiredFields[object] ?? {}) || criteria.has(field);
        if (used && canInsertParent(target)) parents.push(target);
      }
    }
  }
  return parents;
}

/** Targets of the required lookups on the given (already described) parent objects. */
function grandparentObjects(objects: string[], fields: ObjectFields): string[] {
  return objects.flatMap((object) =>
    Object.entries(fields.lookups[object] ?? {})
      .filter(([field, target]) => field in (fields.requiredFields[object] ?? {}) && canInsertParent(target))
      .map(([, target]) => target),
  );
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

  const objectFields = emptyObjectFields();
  if (options.describe) {
    await loadObjectFields(
      flows.flatMap((f) => [...objectsToCreate(f.flow), ...idInputLookupObjects(f.flow)]),
      options.describe,
      objectFields,
    );
    let level = parentObjects(
      flows.map((f) => f.flow),
      objectFields,
    );
    for (let depth = 1; depth <= MAX_PARENT_DEPTH && level.length > 0; depth++) {
      const fresh = [...new Set(level)].filter((object) => !(object in objectFields.requiredFields));
      await loadObjectFields(fresh, options.describe, objectFields);
      level = grandparentObjects(fresh, objectFields);
    }
  }

  const validationRules: Record<string, ValidationRule[]> = {};
  if (options.validationRules) {
    // Sequential on purpose: one Tooling API query per object, then one per rule.
    for (const object of Object.keys(objectFields.requiredFields)) {
      const rules = await options.validationRules(object);
      if (rules.length > 0) validationRules[object] = rules;
    }
  }
  const lookupFilters: Record<string, LookupFilter[]> = {};
  if (options.lookupFilters) {
    for (const [object, lookups] of Object.entries(objectFields.filteredLookups)) {
      if (lookups.length === 0) continue;
      const filters = await options.lookupFilters(object, lookups);
      if (filters.length > 0) lookupFilters[object] = filters;
    }
  }

  for (const { flowName, flow } of flows) {
    const test = generateApexTest(flow, { ...objectFields, validationRules, lookupFilters });
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
