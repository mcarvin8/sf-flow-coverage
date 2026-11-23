import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { apexClassMetaXml, flowKind, generateApexTest } from './apexTemplate.js';
import { type ApprovalSubmit, approvalConflictNote, approvalSubmit, resubmitNote } from './approvals.js';
import { conditionFromValidationRule, entryCondition, fieldPaths } from './conditions.js';
import type { ReadEmailAlerts } from './emailAlerts.js';
import { flowFieldReferences, inaccessibleFields } from './fieldReferences.js';
import { isCountedProcessType } from './flowTypes.js';
import { parseFlowXml } from './flowXml.js';
import type { LookupFilter, ReadLookupFilters } from './lookupFilters.js';
import { findFlowFiles, readProjectConfig } from './projectFiles.js';
import { choosable, type ReadRecordTypePicklists, type RecordTypePicklists } from './recordTypes.js';
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
  /** Reads email alert recipients, so the record gets the addresses an alert the Flow sends needs. */
  emailAlerts?: ReadEmailAlerts;
  /** Reads the picklist values each record type allows, so a test picks a record type that allows its values. */
  recordTypePicklists?: ReadRecordTypePicklists;
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

/** Custom settings the entry criteria read through `$Setup`, which a test inserts with values. */
function settingObjects(flow: FlowMetadata): string[] {
  const text = [flow.filterFormula ?? '', ...flow.filters.map((f) => f.rawValue ?? '')].join('\n');
  return [...text.matchAll(/\$Setup\.([A-Za-z]\w*)\./g)].map((m) => m[1]);
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

/**
 * Field paths that start on a record the test creates: the entry criteria's paths on the
 * triggering record, and the paths an autolaunched Flow reads from its input records
 * (`input.Lookup__r.Field__c`).
 */
function relationshipPaths(flow: FlowMetadata): Array<{ object: string; path: string[] }> {
  const paths: Array<{ object: string; path: string[] }> = [];
  if (flow.object) for (const path of fieldPaths(entryCondition(flow))) paths.push({ object: flow.object, path });
  for (const variable of flow.variables) {
    if (!variable.isInput || variable.isCollection || variable.dataType !== 'SObject' || !variable.objectType) continue;
    for (const read of flow.recordReads?.[variable.name] ?? []) {
      paths.push({ object: variable.objectType, path: read.split('.') });
    }
  }
  return paths;
}

/**
 * Objects along the relationship paths of the records the tests create (`Contact__r.Account.Type` reaches
 * Contact, then Account), as far as the described objects go.
 */
function criteriaPathObjects(flows: FlowMetadata[], fields: ObjectFields): string[] {
  const objects: string[] = [];
  for (const flow of flows) {
    for (const { object: start, path } of relationshipPaths(flow)) {
      let object = start;
      for (const relationship of path.slice(0, Math.min(path.length - 1, MAX_PARENT_DEPTH))) {
        const target = fields.lookups[object]?.[fields.relationships[object]?.[relationship] ?? ''];
        if (!target || !canInsertParent(target)) break;
        objects.push(target);
        object = target;
      }
    }
  }
  return objects;
}

/**
 * Every active Flow and process in the project that submits its record for approval. Read only
 * when a Flow being scaffolded submits one, since it means reading every Flow file.
 */
async function approvalSubmits(flowFiles: Map<string, string>): Promise<ApprovalSubmit[]> {
  const submits: ApprovalSubmit[] = [];
  for (const [name, path] of flowFiles) {
    try {
      const submit = approvalSubmit(name, await readFile(path, 'utf8'));
      if (submit) submits.push(submit);
    } catch {
      // A file that isn't a readable Flow submits nothing.
    }
  }
  return submits;
}

/** Whether the generated test inserts a record and then updates it: record-triggered Flows that run on update. */
const hasUpdateTest = (flow: FlowMetadata): boolean =>
  flowKind(flow) === 'record' && (flow.recordTriggerType === 'Update' || flow.recordTriggerType === 'CreateAndUpdate');

/**
 * Describes parent objects level by level: the given objects, the targets of their required
 * lookups, and the objects along the Flows' relationship paths, up to `MAX_PARENT_DEPTH` levels.
 */
async function describeParents(
  first: string[],
  flows: Array<{ flow: FlowMetadata }>,
  describe: DescribeObject,
  objectFields: ObjectFields,
): Promise<void> {
  let level = first;
  for (let depth = 1; depth <= MAX_PARENT_DEPTH && level.length > 0; depth++) {
    const fresh = [...new Set(level)].filter((object) => !(object in objectFields.requiredFields));
    await loadObjectFields(fresh, describe, objectFields);
    level = [
      ...grandparentObjects(fresh, objectFields),
      ...criteriaPathObjects(
        flows.map((f) => f.flow),
        objectFields,
      ),
    ].filter((object) => !(object in objectFields.requiredFields));
  }
}

/**
 * Objects the validation rules' lookups point to: lookups a rule reads directly (`Project__c`) or
 * through a relationship (`Project__r.Status__c`), on objects whose rules were read.
 */
function ruleParentObjects(rules: Record<string, ValidationRule[]>, fields: ObjectFields): string[] {
  const objects: string[] = [];
  for (const [start, list] of Object.entries(rules)) {
    for (const rule of list) {
      for (const path of fieldPaths(conditionFromValidationRule(rule.formula, 'insert'))) {
        let object = start;
        const hops = path.length === 1 ? path : path.slice(0, -1);
        for (const [i, segment] of hops.entries()) {
          const lookup = path.length === 1 ? segment : fields.relationships[object]?.[segment];
          const target = lookup ? fields.lookups[object]?.[lookup] : undefined;
          if (!target || !canInsertParent(target) || i >= MAX_PARENT_DEPTH) break;
          objects.push(target);
          object = target;
        }
      }
    }
  }
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
  const result: ScaffoldResult = { created: [], skipped: [], inaccessibleFields: [] };

  const flows: Array<{
    flowName: string;
    flow: FlowMetadata;
    references: Map<string, Set<string>>;
    submit?: ApprovalSubmit;
  }> = [];
  for (const flowName of [...new Set(options.flowNames)]) {
    const flowPath = flowFiles.get(flowName);
    if (!flowPath) {
      result.skipped.push({ flowName, reason: `No ${flowName}.flow-meta.xml found under ${options.projectDir}.` });
      continue;
    }
    let flow: FlowMetadata;
    let references: Map<string, Set<string>>;
    let submit: ApprovalSubmit | undefined;
    try {
      const xml = await readFile(flowPath, 'utf8');
      flow = parseFlowXml(flowName, xml);
      references = flowFieldReferences(xml);
      submit = approvalSubmit(flowName, xml);
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
    flows.push({ flowName, flow, references, submit });
  }

  const objectFields = emptyObjectFields();
  if (options.describe) {
    await loadObjectFields(
      flows.flatMap((f) => [...objectsToCreate(f.flow), ...idInputLookupObjects(f.flow), ...settingObjects(f.flow)]),
      options.describe,
      objectFields,
    );
    const level = [
      ...parentObjects(
        flows.map((f) => f.flow),
        objectFields,
      ),
      ...criteriaPathObjects(
        flows.map((f) => f.flow),
        objectFields,
      ),
    ];
    await describeParents(level, flows, options.describe, objectFields);
  }

  // The other objects the Flows read or write, described only to learn which fields the running
  // user can see (not for test data, so their validation rules aren't read).
  const visible: Record<string, string[]> = { ...objectFields.fieldNames };
  if (options.describe) {
    const others = flows.flatMap((f) => [...f.references.keys()]).filter((object) => !(object in visible));
    Object.assign(visible, (await loadObjectFields(others, options.describe)).fieldNames);
  }

  const validationRules: Record<string, ValidationRule[]> = {};
  if (options.validationRules) {
    const read = new Set<string>();
    const readRules = async (reader: ReadValidationRules): Promise<void> => {
      // Sequential on purpose: one Tooling API query per object, then one per rule.
      for (const object of Object.keys(objectFields.requiredFields)) {
        if (read.has(object)) continue;
        read.add(object);
        const rules = await reader(object);
        if (rules.length > 0) validationRules[object] = rules;
      }
    };
    await readRules(options.validationRules);
    // A rule can need a lookup filled ("a parent project or milestone"): describe the objects those
    // lookups point to, so the test can insert one, and read their rules in turn.
    for (let round = 1; options.describe && round <= MAX_PARENT_DEPTH; round++) {
      const needed = ruleParentObjects(validationRules, objectFields).filter(
        (object) => !(object in objectFields.requiredFields),
      );
      if (needed.length === 0) break;
      await describeParents(needed, flows, options.describe, objectFields);
      await readRules(options.validationRules);
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

  // Other automation matters to Flows that submit, and to the update tests of any Flow.
  // Picklist values per record type, for objects whose tests may need a record type other than
  // the default to save a restricted picklist value.
  const recordTypePicklists: Record<string, Record<string, RecordTypePicklists>> = {};
  if (options.recordTypePicklists) {
    for (const [object, infos] of Object.entries(objectFields.recordTypeInfos)) {
      const types = choosable(infos).filter((t) => t.available);
      const restricted = Object.values(objectFields.picklists[object] ?? {}).some((p) => p.restricted);
      if (types.length < 2 || !restricted) continue;
      recordTypePicklists[object] = {};
      for (const type of types) {
        recordTypePicklists[object][type.developerName] = await options.recordTypePicklists(object, type.recordTypeId);
      }
    }
  }

  const alertNames = [...new Set(flows.flatMap((f) => f.flow.graph?.emailAlerts ?? []))];
  const emailAlerts = options.emailAlerts && alertNames.length > 0 ? await options.emailAlerts(alertNames) : {};

  const needed = flows.some((f) => f.submit || hasUpdateTest(f.flow));
  const submits = await approvalSubmits(needed ? flowFiles : new Map());
  for (const { flowName, flow, references, submit } of flows) {
    const hidden = inaccessibleFields(references, visible);
    for (const [object, fields] of Object.entries(hidden)) result.inaccessibleFields.push({ flowName, object, fields });
    const test = generateApexTest(flow, {
      ...objectFields,
      validationRules,
      emailAlerts,
      recordTypePicklists,
      lookupFilters,
      inaccessibleFields: hidden,
      approvalConflict: submit
        ? approvalConflictNote(submit, submits)
        : hasUpdateTest(flow)
          ? resubmitNote(flowName, flow.object as string, submits)
          : undefined,
    });
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
