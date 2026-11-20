import { escapeApexString } from './flowXml.js';

/** The parts of an sObject describe field result needed to fill required fields. */
export type DescribeField = {
  name: string;
  type: string;
  nillable: boolean;
  createable: boolean;
  /** False for fields that can be set on insert but not changed later, such as most master-detail fields. */
  updateable?: boolean;
  defaultedOnCreate: boolean;
  calculated?: boolean;
  autoNumber?: boolean;
  length?: number;
  picklistValues?: Array<{ value: string; active: boolean; defaultValue?: boolean }> | null;
  referenceTo?: string[] | null;
  /** True when no two records may share a value. */
  unique?: boolean;
  /** True for picklists that reject values not in their list. */
  restrictedPicklist?: boolean;
  /** The field's default value, such as a checkbox's `true` or `false`. */
  defaultValue?: unknown;
  /** For lookups, the relationship name used in paths such as `Account__r.Type`. */
  relationshipName?: string | null;
};

/** Describes an sObject's fields. Returns undefined when the object can't be described. */
export type DescribeObject = (objectName: string) => Promise<DescribeField[] | DescribeResult | undefined>;

/** An sObject describe: its fields, and its record types when known. */
export type DescribeResult = { fields: DescribeField[]; recordTypeInfos?: unknown[] };

/** Field name to Apex literal, per object. */
export type RequiredFieldMap = Record<string, Record<string, string>>;

const SKIPPED_SYSTEM_FIELDS = new Set(['OwnerId', 'CurrencyIsoCode']);

function textValue(field: DescribeField, text: string): string {
  const max = field.length && field.length > 0 ? field.length : text.length;
  return `'${escapeApexString(text.slice(0, max))}'`;
}

/** A value no other record in the test shares, for unique fields. */
function uniqueValue(field: DescribeField, prefix: string): string | undefined {
  const random = 'Math.abs(Crypto.getRandomInteger())';
  if (field.name === 'Username' || field.type === 'email')
    return `'${prefix.toLowerCase()}' + ${random} + '@example.com.flowtest'`;
  if (['string', 'textarea', 'encryptedstring', 'phone', 'url'].includes(field.type)) {
    const max = field.length && field.length > 0 ? field.length : 255;
    return `('${prefix}' + ${random}).left(${max})`;
  }
  return undefined;
}

/** An Apex literal for a required field, or undefined when no safe value can be made up. */
export function apexValueForField(field: DescribeField): string | undefined {
  // A username must look like an email address and be unique across every org.
  if (field.unique || field.name === 'Username') {
    const value = uniqueValue(field, 'Test');
    if (value) return value;
  }
  switch (field.type) {
    case 'string':
    case 'textarea':
    case 'encryptedstring':
      return textValue(field, 'Test');
    case 'email':
      return "'test@example.com'";
    case 'phone':
      return "'5555550100'";
    case 'url':
      return "'https://example.com'";
    case 'int':
    case 'double':
    case 'currency':
    case 'percent':
      return '1';
    case 'date':
      return 'Date.today()';
    case 'datetime':
      return 'Datetime.now()';
    case 'time':
      return 'Time.newInstance(12, 0, 0, 0)';
    case 'boolean':
      return 'false';
    case 'picklist':
    case 'multipicklist': {
      const values = (field.picklistValues ?? []).filter((v) => v.active);
      const chosen = values.find((v) => v.defaultValue) ?? values[0];
      return chosen ? `'${escapeApexString(chosen.value)}'` : undefined;
    }
    case 'reference':
      return `null /* TODO: set a ${(field.referenceTo ?? []).join(' or ') || 'record'} Id */`;
    default:
      return undefined;
  }
}

/** Fields a test must set to insert a record: createable, not nillable, and not defaulted by the platform. */
export function requiredFieldValues(fields: DescribeField[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (!field.createable || field.nillable || field.defaultedOnCreate) continue;
    if (field.calculated || field.autoNumber || SKIPPED_SYSTEM_FIELDS.has(field.name)) continue;
    const value = apexValueForField(field);
    if (value !== undefined) values[field.name] = value;
  }
  return values;
}

/**
 * A value for every field a test could set, used to meet `IsNull false` entry criteria.
 * Lookups are left out: a made-up null Id can't satisfy "is not null".
 */
export function settableFieldValues(fields: DescribeField[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (!field.createable || field.calculated || field.autoNumber || field.type === 'reference') continue;
    const value = apexValueForField(field);
    if (value !== undefined) values[field.name] = value;
  }
  return values;
}

/**
 * An Apex literal that differs from `apexValueForField`'s value for the same field, so an update
 * changes the field whether the insert left it empty or filled it. Undefined when there's no safe
 * second value (lookups, single-value picklists, unknown types).
 */
export function changedValueForField(field: DescribeField): string | undefined {
  if (field.unique || field.name === 'Username') {
    const value = uniqueValue(field, 'Changed');
    if (value) return value;
  }
  switch (field.type) {
    case 'string':
    case 'textarea':
    case 'encryptedstring':
      return textValue(field, 'Changed');
    case 'email':
      return "'changed@example.com'";
    case 'phone':
      return "'5555550199'";
    case 'url':
      return "'https://example.org'";
    case 'int':
    case 'double':
    case 'currency':
    case 'percent':
      return '2';
    case 'date':
      return 'Date.today().addDays(1)';
    case 'datetime':
      return 'Datetime.now().addDays(1)';
    case 'time':
      return 'Time.newInstance(13, 0, 0, 0)';
    case 'boolean':
      return 'true';
    case 'picklist':
    case 'multipicklist': {
      const first = apexValueForField(field);
      const other = (field.picklistValues ?? []).find((v) => v.active && `'${escapeApexString(v.value)}'` !== first);
      return other ? `'${escapeApexString(other.value)}'` : undefined;
    }
    default:
      return undefined;
  }
}

/** A changed value for every field a test could update, used to meet `IsChanged` entry criteria. */
export function changedFieldValues(fields: DescribeField[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (!field.createable || field.calculated || field.autoNumber) continue;
    const value = changedValueForField(field);
    if (value !== undefined) values[field.name] = value;
  }
  return values;
}

export type ObjectFields = {
  requiredFields: RequiredFieldMap;
  fieldValues: RequiredFieldMap;
  changedValues: RequiredFieldMap;
  /** The object each lookup field points to, per object. Only lookups to a single object are listed. */
  lookups: Record<string, Record<string, string>>;
  /** Lookup field per relationship name (`Account__r` to `Account__c`), per object. */
  relationships: Record<string, Record<string, string>>;
  /** How many record types each object has, including Master, when the describe says. */
  recordTypes: Record<string, number>;
  /** Fields a test can't set at all (formula, auto-number, system fields), per object. */
  readOnlyFields: Record<string, string[]>;
  /** Fields a test can set on insert but not change in an update, per object. */
  createOnlyFields: Record<string, string[]>;
  /** Active picklist values per picklist field, per object, and whether the picklist rejects others. */
  picklists: Record<string, Record<string, PicklistInfo>>;
  /** What a new record holds in each field a test doesn't set, per object (see `unsetFieldValues`). */
  unsetValues: Record<string, Record<string, string | null>>;
};

/** A picklist's active values, and whether it rejects values not among them. */
export type PicklistInfo = { values: string[]; restricted: boolean };

/** Active values of each single-select picklist. */
export function picklistInfo(fields: DescribeField[]): Record<string, PicklistInfo> {
  const picklists: Record<string, PicklistInfo> = {};
  for (const field of fields) {
    if (field.type !== 'picklist') continue;
    const values = (field.picklistValues ?? []).filter((v) => v.active).map((v) => v.value);
    picklists[field.name] = { values, restricted: field.restrictedPicklist === true };
  }
  return picklists;
}

export const emptyObjectFields = (): ObjectFields => ({
  requiredFields: {},
  fieldValues: {},
  changedValues: {},
  lookups: {},
  relationships: {},
  recordTypes: {},
  readOnlyFields: {},
  createOnlyFields: {},
  picklists: {},
  unsetValues: {},
});

/** Lookup targets a test points at an existing record instead of inserting one. */
export const EXISTING_RECORD_IDS: Record<string, string> = {
  User: 'UserInfo.getUserId()',
  Profile: 'UserInfo.getProfileId()',
  Pricebook2: 'Test.getStandardPricebookId()',
};

/** Setup objects a test can't simply insert (or would hit mixed DML with); their lookups stay TODOs. */
const NOT_INSERTABLE = new Set([
  'BusinessHours',
  'Group',
  'Organization',
  'PermissionSet',
  'Profile',
  'RecordType',
  'UserRole',
]);

/** Parents are inserted this many levels deep at most: parent, grandparent, great-grandparent. */
export const MAX_PARENT_DEPTH = 3;

/** Whether a generated test can insert a record of `object` to fill a lookup to it. */
export const canInsertParent = (object: string): boolean =>
  !NOT_INSERTABLE.has(object) && !(object in EXISTING_RECORD_IDS);

/**
 * What a new record holds in each field the test doesn't set, as an Apex literal (or `null`):
 * empty for nillable fields with no default, a checkbox's default, and the default picklist
 * value when the object has no record types that could change it (`recordTypes` of 1 or
 * fewer). Lets a test follow the Flow's decisions on fields it doesn't set.
 */
export function unsetFieldValues(fields: DescribeField[], recordTypes?: number): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  for (const field of fields) {
    if (!field.createable || field.calculated || field.autoNumber) continue;
    const pickDefault = (field.picklistValues ?? []).find((value) => value.active && value.defaultValue);
    if (field.type === 'boolean' && (field.defaultValue === true || field.defaultValue === false)) {
      values[field.name] = String(field.defaultValue);
    } else if (field.type === 'boolean' && (field.defaultValue === 'true' || field.defaultValue === 'false')) {
      values[field.name] = field.defaultValue;
    } else if (pickDefault) {
      // Record types can give a picklist a different default.
      if (field.type === 'picklist' && recordTypes !== undefined && recordTypes <= 1) {
        values[field.name] = `'${escapeApexString(pickDefault.value)}'`;
      }
    } else if (field.nillable && !field.defaultedOnCreate) {
      values[field.name] = null;
    }
  }
  return values;
}

/** Lookup field per relationship name, for criteria on related records. */
export function relationshipLookups(fields: DescribeField[]): Record<string, string> {
  const relationships: Record<string, string> = {};
  for (const field of fields) {
    if (field.type === 'reference' && field.relationshipName) relationships[field.relationshipName] = field.name;
  }
  return relationships;
}

/**
 * The object each createable lookup points to. A polymorphic lookup (`WhatId`, `OwnerId`) gets
 * the running user when it can point at users, else the first object a test can insert.
 */
export function lookupTargets(fields: DescribeField[]): Record<string, string> {
  const targets: Record<string, string> = {};
  for (const field of fields) {
    if (field.type !== 'reference' || !field.createable || field.calculated) continue;
    const options = field.referenceTo ?? [];
    const target =
      options.length === 1
        ? options[0]
        : (options.find((o) => o in EXISTING_RECORD_IDS) ?? options.find((o) => canInsertParent(o)));
    if (target) targets[field.name] = target;
  }
  return targets;
}

/**
 * Describes each object once, adding to `into` when given. Objects already in `into`, and
 * objects that can't be described, are skipped.
 */
export async function loadObjectFields(
  objects: string[],
  describe: DescribeObject,
  into: ObjectFields = emptyObjectFields(),
): Promise<ObjectFields> {
  for (const object of [...new Set(objects)]) {
    if (object in into.requiredFields) continue;
    let result: DescribeField[] | DescribeResult | undefined;
    try {
      result = await describe(object);
    } catch {
      result = undefined;
    }
    const fields = Array.isArray(result) ? result : result?.fields;
    if (result && !Array.isArray(result) && result.recordTypeInfos) {
      into.recordTypes[object] = result.recordTypeInfos.length;
    }
    if (fields) {
      into.requiredFields[object] = requiredFieldValues(fields);
      into.fieldValues[object] = settableFieldValues(fields);
      into.changedValues[object] = changedFieldValues(fields);
      into.lookups[object] = lookupTargets(fields);
      into.relationships[object] = relationshipLookups(fields);
      into.unsetValues[object] = unsetFieldValues(fields, into.recordTypes[object]);
      into.readOnlyFields[object] = fields
        .filter((f) => !f.createable || f.calculated || f.autoNumber)
        .map((f) => f.name);
      into.picklists[object] = picklistInfo(fields);
      into.createOnlyFields[object] = fields
        .filter((f) => f.createable && !f.calculated && !f.autoNumber && f.updateable === false)
        .map((f) => f.name);
    }
  }
  return into;
}
