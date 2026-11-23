import { XMLParser } from 'fast-xml-parser';

type Rec = Record<string, unknown>;

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });

const asRecord = (value: unknown): Rec | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : undefined;
const asRecords = (value: unknown): Rec[] =>
  (Array.isArray(value) ? value : [value]).map(asRecord).filter((v): v is Rec => !!v);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Elements that read or write records of the object they name. */
const RECORD_ELEMENTS = ['recordLookups', 'recordUpdates', 'recordDeletes', 'recordCreates'];

/** Keys whose whole value is a reference, such as `$Record.Status__c` or `Get_Account.Name`. */
const REFERENCE_KEYS = new Set(['elementReference', 'leftValueReference', 'assignToReference', 'collectionReference']);

const FIELD = /^[A-Za-z]\w*$/;

/**
 * The fields a Flow reads or writes, per object: fields of `$Record`, of record variables, and of
 * the records Get Records elements find, plus the fields that record elements filter on, set, or
 * query. Fields reached through a relationship (`$Record.Account.Name`) are left out.
 */
export function flowFieldReferences(xml: string): Map<string, Set<string>> {
  const flow = asRecord(asRecord(parser.parse(xml))?.Flow) ?? {};
  const fields = new Map<string, Set<string>>();
  const add = (object: string | undefined, field: string | undefined): void => {
    if (!object || !field || !FIELD.test(field)) return;
    if (!fields.has(object)) fields.set(object, new Set());
    fields.get(object)?.add(field);
  };

  // What each reference prefix holds a record of.
  const owners = new Map<string, string>();
  const start = asRecord(flow.start) ?? {};
  const triggering = text(start.object);
  if (triggering) {
    owners.set('$Record', triggering);
    owners.set('$Record__Prior', triggering);
  }
  for (const variable of asRecords(flow.variables)) {
    const name = text(variable.name);
    const object = text(variable.objectType);
    if (name && object && text(variable.dataType) === 'SObject') owners.set(name, object);
  }
  for (const filter of asRecords(start.filters)) add(triggering, text(filter.field));

  for (const type of RECORD_ELEMENTS) {
    for (const element of asRecords(flow[type])) {
      const object = text(element.object);
      if (!object) continue;
      const name = text(element.name);
      if (name && type === 'recordLookups' && text(element.storeOutputAutomatically) === 'true') {
        owners.set(name, object);
      }
      for (const key of ['filters', 'inputAssignments', 'outputAssignments']) {
        for (const item of asRecords(element[key])) add(object, text(item.field));
      }
      const queried = element.queriedFields;
      for (const field of Array.isArray(queried) ? queried : [queried]) add(object, text(field));
    }
  }

  const references: string[] = [];
  const collect = (value: unknown, key: string): void => {
    if (typeof value === 'string') {
      if (REFERENCE_KEYS.has(key)) references.push(value.trim());
      for (const merge of value.matchAll(/\{!([^}]+)\}/g)) references.push(merge[1].trim());
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item, key);
    } else if (value && typeof value === 'object') {
      for (const [child, item] of Object.entries(value)) collect(item, child);
    }
  };
  collect(flow, 'Flow');
  for (const reference of references) {
    const [prefix, field, ...rest] = reference.split('.');
    if (field && rest.length === 0) add(owners.get(prefix), field);
  }
  return fields;
}

/**
 * Fields a Flow uses that the describe doesn't show, per object. The describe lists only the
 * fields the running user can see, so these are fields that user can't access: automation running
 * as that user fails with "Operation failed due to fields being inaccessible". Objects the
 * describe didn't cover are skipped.
 */
export function inaccessibleFields(
  references: Map<string, Set<string>>,
  visible: Record<string, string[]>,
): Record<string, string[]> {
  const missing: Record<string, string[]> = {};
  for (const [object, fields] of references) {
    const known = visible[object];
    if (!known) continue;
    const names = new Set(known.map((name) => name.toLowerCase()));
    const hidden = [...fields].filter((field) => !names.has(field.toLowerCase())).sort();
    if (hidden.length > 0) missing[object] = hidden;
  }
  return missing;
}
