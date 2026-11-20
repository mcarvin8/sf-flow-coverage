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

/** Describes each object once and returns its required fields. Objects that can't be described are left out. */
export async function loadRequiredFields(objects: string[], describe: DescribeObject): Promise<RequiredFieldMap> {
  const map: RequiredFieldMap = {};
  for (const object of [...new Set(objects)]) {
    let fields: DescribeField[] | undefined;
    try {
      fields = await describe(object);
    } catch {
      fields = undefined;
    }
    if (fields) map[object] = requiredFieldValues(fields);
  }
  return map;
}
