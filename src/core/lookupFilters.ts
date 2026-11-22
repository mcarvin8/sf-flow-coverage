import { type Condition, type ConditionOperator, type Operand, operandOf, parseLogic } from './conditions.js';
import { escapeApexString } from './flowValues.js';
import type { ToolingQuery } from './types.js';

/** One criterion of a lookup filter, as the field's metadata stores it. */
export type LookupFilterItem = {
  /** `Account.Type` (a field of the record looked up) or `$Source.Status__c` (the record being saved). */
  field: string;
  operation: string;
  value?: string;
  /** Compare with another field instead of a value, such as `$Source.Region__c`. */
  valueField?: string;
};

/** A required lookup filter on a lookup field. */
export type LookupFilter = {
  /** The lookup field it filters. */
  lookup: string;
  items: LookupFilterItem[];
  /** Custom logic such as `1 AND (2 OR 3)`; all items must hold without it. */
  booleanFilter?: string;
  errorMessage?: string;
};

/** Reads the required lookup filters on the given custom lookup fields of an object. */
export type ReadLookupFilters = (object: string, lookups: string[]) => Promise<LookupFilter[]>;

const quote = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

type FilterMetadata = {
  active?: boolean;
  isOptional?: boolean;
  booleanFilter?: string | null;
  errorMessage?: string | null;
  filterItems?: Array<{ field?: string; operation?: string; value?: string | null; valueField?: string | null }>;
};

/**
 * Reads lookup filters through the Tooling API: a filter's criteria are only in its field's
 * `CustomField` metadata, which the Tooling API returns one row at a time. Standard lookup
 * fields have no `CustomField` record, so only custom lookups (`__c`) are read.
 */
export function lookupFilterReader(query: ToolingQuery): ReadLookupFilters {
  return async (object, lookups) => {
    const custom = lookups.filter((field) => field.endsWith('__c'));
    if (custom.length === 0) return [];
    let tableId: string | undefined;
    try {
      const [entity] = await query<{ DurableId?: string }>(
        `SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = ${quote(object)}`,
      );
      tableId = entity?.DurableId;
    } catch {
      return [];
    }
    if (!tableId) return [];
    const filters: LookupFilter[] = [];
    for (const lookup of custom) {
      // `ns__Field__c` is DeveloperName `Field` in namespace `ns`.
      const parts = lookup.replace(/__c$/, '').split('__');
      const developerName = parts.pop() as string;
      const namespace = parts[0];
      try {
        const [field] = await query<{ Id: string }>(
          `SELECT Id FROM CustomField WHERE TableEnumOrId = ${quote(tableId)} AND DeveloperName = ${quote(developerName)}${namespace ? ` AND NamespacePrefix = ${quote(namespace)}` : ''}`,
        );
        if (!field) continue;
        const [record] = await query<{ Metadata?: { lookupFilter?: FilterMetadata | null } }>(
          `SELECT Metadata FROM CustomField WHERE Id = ${quote(field.Id)}`,
        );
        const filter = record?.Metadata?.lookupFilter;
        if (!filter || filter.active === false || filter.isOptional) continue;
        filters.push({
          lookup,
          items: (filter.filterItems ?? []).flatMap((item) =>
            item.field && item.operation
              ? [
                  {
                    field: item.field,
                    operation: item.operation,
                    ...(item.value ? { value: item.value } : {}),
                    ...(item.valueField ? { valueField: item.valueField } : {}),
                  },
                ]
              : [],
          ),
          ...(filter.booleanFilter ? { booleanFilter: filter.booleanFilter } : {}),
          ...(filter.errorMessage ? { errorMessage: filter.errorMessage } : {}),
        });
      } catch {
        // A field whose filter can't be read is left out.
      }
    }
    return filters;
  };
}

const OPERATIONS: Record<string, ConditionOperator> = {
  equals: 'EqualTo',
  notEqual: 'NotEqualTo',
  lessThan: 'LessThan',
  greaterThan: 'GreaterThan',
  lessOrEqual: 'LessThanOrEqualTo',
  greaterOrEqual: 'GreaterThanOrEqualTo',
  contains: 'Contains',
  startsWith: 'StartsWith',
};

/** A filter value as an Apex literal: booleans and numbers as such, anything else as text. */
function literal(value: string): string {
  if (/^(true|false)$/i.test(value)) return value.toLowerCase();
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  return `'${escapeApexString(value)}'`;
}

/**
 * A lookup filter as a condition on the record being saved: fields of the record looked up
 * (`Account.Type`) become fields reached through the lookup's relationship (`Account__r.Type`),
 * and `$Source` fields are the record's own. Items it can't read are opaque.
 */
export function conditionFromLookupFilter(filter: LookupFilter, relationship: string): Condition {
  const label = 'lookup filter';
  const side = (path: string): Operand | undefined => {
    if (path.startsWith('$Source.'))
      return { kind: 'field', path: path.slice('$Source.'.length).split('.'), prior: false };
    if (path === '$User.Id') return { kind: 'user' };
    if (path.startsWith('$')) return undefined;
    const [, ...rest] = path.split('.');
    return rest.length > 0 ? { kind: 'field', path: [relationship, ...rest], prior: false } : undefined;
  };
  const items: Condition[] = filter.items.map((item) => {
    const text = `${item.field} ${item.operation} ${item.valueField ?? item.value ?? ''}`.trim();
    const opaque: Condition = { kind: 'opaque', text, label };
    const left = side(item.field);
    const negated = item.operation === 'notContain';
    const op = negated ? 'Contains' : OPERATIONS[item.operation];
    if (!left || !op) return opaque;
    const atom = (right: Operand): Condition => ({ kind: 'atom', left, op, right, text, label });
    let condition: Condition;
    if (item.valueField) {
      const right = side(item.valueField) ?? (item.valueField.startsWith('$') ? undefined : operandOf(item.valueField));
      if (!right || right.kind === 'ref') return opaque;
      condition = atom(right);
    } else if (item.value === undefined) {
      // An empty value means the field is (or isn't) blank.
      if (op !== 'EqualTo' && op !== 'NotEqualTo') return opaque;
      condition = {
        kind: 'atom',
        left,
        op: 'IsNull',
        right: { kind: 'value', apex: String(op === 'EqualTo') },
        text,
        label,
      };
    } else {
      // "equals A, B" means any of them; "not equal to A, B" means none of them.
      const values = item.value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v !== '');
      const atoms = values.map((v) => atom({ kind: 'value', apex: literal(v) }));
      condition = atoms.length === 1 ? atoms[0] : { kind: op === 'NotEqualTo' ? 'and' : 'or', items: atoms };
    }
    return negated ? { kind: 'not', item: condition } : condition;
  });
  if (items.length === 0) return { kind: 'and', items: [] };
  if (filter.booleanFilter) {
    return parseLogic(filter.booleanFilter, items) ?? { kind: 'opaque', text: filter.booleanFilter, label };
  }
  return items.length === 1 ? items[0] : { kind: 'and', items };
}
