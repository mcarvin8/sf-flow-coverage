import type { Connection } from '@salesforce/core';

import type { CriteriaPlan } from './criteria.js';
import { escapeApexString } from './flowValues.js';
import type { PicklistInfo } from './requiredFields.js';

/** A record type of an object, as the describe reports it for the running user. */
export type RecordTypeInfo = {
  developerName: string;
  recordTypeId: string;
  /** Whether the running user can create records of this type. */
  available: boolean;
  /** Whether it's the running user's default record type for the object. */
  isDefault: boolean;
  master: boolean;
};

/** Values each picklist field allows for a record type, by field. */
export type RecordTypePicklists = Record<string, string[]>;

/** Reads the picklist values a record type allows, by field (the UI API's picklist values). */
export type ReadRecordTypePicklists = (object: string, recordTypeId: string) => Promise<RecordTypePicklists>;

type DescribedRecordType = {
  developerName?: string;
  recordTypeId?: string;
  available?: boolean;
  defaultRecordTypeMapping?: boolean;
  master?: boolean;
};

/** Record types from an object describe's `recordTypeInfos`. */
export function recordTypeInfos(described: unknown[]): RecordTypeInfo[] {
  return (described as DescribedRecordType[]).flatMap((info) =>
    info?.developerName && info.recordTypeId
      ? [
          {
            developerName: info.developerName,
            recordTypeId: info.recordTypeId,
            available: info.available === true,
            isDefault: info.defaultRecordTypeMapping === true,
            master: info.master === true,
          },
        ]
      : [],
  );
}

/** Record types a test could choose between: the ones besides Master. */
export const choosable = (infos: RecordTypeInfo[]): RecordTypeInfo[] => infos.filter((info) => !info.master);

type UiPicklistValues = { picklistFieldValues?: Record<string, { values?: Array<{ value?: string }> }> };

/** Reads picklist values per record type through the UI API. A failed read allows everything. */
export function picklistValueReader(
  connection: Pick<Connection, 'request' | 'getApiVersion'>,
): ReadRecordTypePicklists {
  return async (object, recordTypeId) => {
    try {
      const result = (await connection.request(
        `/services/data/v${connection.getApiVersion()}/ui-api/object-info/${object}/picklist-values/${recordTypeId}`,
      )) as UiPicklistValues;
      const picklists: RecordTypePicklists = {};
      for (const [field, info] of Object.entries(result?.picklistFieldValues ?? {})) {
        picklists[field] = (info.values ?? []).flatMap((v) => (v.value === undefined ? [] : [v.value]));
      }
      return picklists;
    } catch {
      return {};
    }
  };
}

/** The Apex for a record type's Id, by developer name. */
export const recordTypeIdApex = (object: string, developerName: string): string =>
  `Schema.SObjectType.${object}.getRecordTypeInfosByDeveloperName().get('${escapeApexString(developerName)}').getRecordTypeId()`;

const RECORD_TYPE_APEX = /getRecordTypeInfosByDeveloperName\(\)\.get\('((?:[^'\\]|\\.)*)'\)/;

const literal = (apex: string): string | undefined => /^'((?:[^'\\]|\\.)*)'$/.exec(apex)?.[1]?.replace(/\\(.)/g, '$1');

/**
 * Makes the record type a test saves its record with fit the plan:
 * - a record type the criteria name that the running user can't use becomes a TODO;
 * - restricted picklist values the running user's default record type doesn't allow get a record
 *   type that allows all of them and that the user can use, set on insert; with none, a TODO.
 * Picklist values per record type come from `picklists`; without them only availability is checked.
 */
export function withRecordType(
  plan: CriteriaPlan,
  object: string,
  infos: RecordTypeInfo[],
  picklists: Record<string, RecordTypePicklists>,
  restricted: Record<string, PicklistInfo>,
  context: 'insert' | 'update',
): CriteriaPlan {
  const types = choosable(infos);
  if (types.length === 0) return plan;
  const todo = (text: string): CriteriaPlan => ({
    ...plan,
    unmet: [...plan.unmet, { label: 'record type', text }],
  });
  // Restricted picklist values the test saves, on insert or in the update.
  const values = [...plan.prior, ...plan.set].flatMap(([field, apex]) => {
    const value = restricted[field]?.restricted ? literal(apex) : undefined;
    return value === undefined ? [] : [{ field, value }];
  });
  const allows = (type: RecordTypeInfo): boolean =>
    values.every(({ field, value }) => {
      const allowed = picklists[type.developerName]?.[field];
      return !allowed || allowed.some((v) => v.toLowerCase() === value.toLowerCase());
    });
  const describe = (list: typeof values): string => list.map(({ field, value }) => `${field} = '${value}'`).join(', ');

  const named = [...plan.prior, ...plan.set].find(([field]) => field === 'RecordTypeId')?.[1];
  const name = named ? RECORD_TYPE_APEX.exec(named)?.[1] : undefined;
  if (name !== undefined) {
    const type = types.find((t) => t.developerName.toLowerCase() === name.toLowerCase());
    if (type && !type.available) {
      return todo(
        `record type ${type.developerName} isn't available to the running user: assign it to their profile or a permission set`,
      );
    }
    if (type && !allows(type)) return todo(`record type ${type.developerName} doesn't allow ${describe(values)}`);
    return plan;
  }

  const fallback = types.find((t) => t.isDefault);
  if (values.length === 0 || (fallback && allows(fallback))) return plan;
  const fit = types.find((t) => t.available && allows(t));
  if (!fit) return todo(`no record type the running user can use allows ${describe(values)}`);
  const id = recordTypeIdApex(object, fit.developerName);
  // The record type is chosen on insert.
  return context === 'update'
    ? { ...plan, prior: new Map([...plan.prior, ['RecordTypeId', id]]) }
    : { ...plan, set: new Map([...plan.set, ['RecordTypeId', id]]) };
}
