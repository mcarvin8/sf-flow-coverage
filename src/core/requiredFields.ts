import { escapeApexString } from './flowXml.js';

/** The parts of an sObject describe field result needed to fill required fields. */
export type DescribeField = {
  name: string;
  type: string;
  nillable: boolean;
  createable: boolean;
  defaultedOnCreate: boolean;
  calculated?: boolean;
  autoNumber?: boolean;
  length?: number;
  picklistValues?: Array<{ value: string; active: boolean; defaultValue?: boolean }> | null;
  referenceTo?: string[] | null;
};

/** Describes an sObject's fields. Returns undefined when the object can't be described. */
export type DescribeObject = (objectName: string) => Promise<DescribeField[] | undefined>;

/** Field name to Apex literal, per object. */
export type RequiredFieldMap = Record<string, Record<string, string>>;

const SKIPPED_SYSTEM_FIELDS = new Set(['OwnerId', 'CurrencyIsoCode']);

function textValue(field: DescribeField, text: string): string {
  const max = field.length && field.length > 0 ? field.length : text.length;
  return `'${escapeApexString(text.slice(0, max))}'`;
}

/** An Apex literal for a required field, or undefined when no safe value can be made up. */
export function apexValueForField(field: DescribeField): string | undefined {
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
  /** Fields that stay empty when a test doesn't set them (no default value), per object. */
  nullWhenUnset: Record<string, string[]>;
};

export const emptyObjectFields = (): ObjectFields => ({
  requiredFields: {},
  fieldValues: {},
  changedValues: {},
  lookups: {},
  nullWhenUnset: {},
});

/** Lookup targets a test points at an existing record instead of inserting one. */
export const EXISTING_RECORD_IDS: Record<string, string> = {
  User: 'UserInfo.getUserId()',
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

/** Whether a generated test can insert a record of `object` to fill a lookup to it. */
export const canInsertParent = (object: string): boolean =>
  !NOT_INSERTABLE.has(object) && !(object in EXISTING_RECORD_IDS);

/**
 * Fields a new record leaves empty unless the test sets them: createable, nillable, and with no
 * default value. Lets a test know how the Flow's decisions read the fields it doesn't set.
 */
export function nullWhenUnsetFields(fields: DescribeField[]): string[] {
  return fields
    .filter(
      (field) =>
        field.createable &&
        field.nillable &&
        !field.defaultedOnCreate &&
        !field.calculated &&
        !field.autoNumber &&
        !(field.picklistValues ?? []).some((value) => value.defaultValue),
    )
    .map((field) => field.name);
}

/** Createable lookups to exactly one object (polymorphic lookups like `WhatId` are left out). */
export function lookupTargets(fields: DescribeField[]): Record<string, string> {
  const targets: Record<string, string> = {};
  for (const field of fields) {
    if (field.type !== 'reference' || !field.createable || field.calculated) continue;
    if (field.referenceTo?.length === 1) targets[field.name] = field.referenceTo[0];
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
    let fields: DescribeField[] | undefined;
    try {
      fields = await describe(object);
    } catch {
      fields = undefined;
    }
    if (fields) {
      into.requiredFields[object] = requiredFieldValues(fields);
      into.fieldValues[object] = settableFieldValues(fields);
      into.changedValues[object] = changedFieldValues(fields);
      into.lookups[object] = lookupTargets(fields);
      into.nullWhenUnset[object] = nullWhenUnsetFields(fields);
    }
  }
  return into;
}
