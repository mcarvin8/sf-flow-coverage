import { describe, expect, it } from 'vitest';

import { type Condition, type Operand } from '../../src/core/conditions.js';
import { conditionFromLookupFilter, type LookupFilter, lookupFilterReader } from '../../src/core/lookupFilters.js';

function show(condition: Condition): string {
  const side = (o: Operand): string =>
    o.kind === 'field' ? o.path.join('.') : o.kind === 'value' ? o.apex : o.kind === 'user' ? '$User' : o.kind;
  switch (condition.kind) {
    case 'and':
    case 'or':
      return `${condition.kind}(${condition.items.map(show).join(', ')})`;
    case 'not':
      return `not(${show(condition.item)})`;
    case 'opaque':
      return `?${condition.text}`;
    default:
      return `${side(condition.left)} ${condition.op}${condition.right ? ` ${side(condition.right)}` : ''}`;
  }
}

const filter = (items: LookupFilter['items'], booleanFilter?: string): LookupFilter => ({
  lookup: 'Account__c',
  items,
  ...(booleanFilter ? { booleanFilter } : {}),
});

describe('conditionFromLookupFilter', () => {
  it('reads fields of the looked-up record through the relationship, and $Source fields as the record', () => {
    const condition = conditionFromLookupFilter(
      filter([
        { field: 'Account.Type', operation: 'equals', value: 'Customer, Partner' },
        { field: 'Account.Active__c', operation: 'equals', value: 'True' },
        { field: 'Account.Employees__c', operation: 'greaterThan', value: '10' },
        { field: 'Account.Region__c', operation: 'equals', valueField: '$Source.Region__c' },
        { field: 'Account.OwnerId', operation: 'equals', valueField: '$User.Id' },
        { field: '$Source.Status__c', operation: 'notEqual', value: 'Closed, Lost' },
        { field: 'Account.Name', operation: 'notContain', value: 'Test' },
        { field: 'Account.Rating', operation: 'equals' },
        { field: 'Account.Site', operation: 'notEqual' },
        { field: 'Account.Description', operation: 'startsWith', value: 'A' },
      ]),
      'Account__r',
    );
    expect(show(condition)).toBe(
      [
        "and(or(Account__r.Type EqualTo 'Customer', Account__r.Type EqualTo 'Partner')",
        'Account__r.Active__c EqualTo true',
        'Account__r.Employees__c GreaterThan 10',
        'Account__r.Region__c EqualTo Region__c',
        'Account__r.OwnerId EqualTo $User',
        "and(Status__c NotEqualTo 'Closed', Status__c NotEqualTo 'Lost')",
        "not(Account__r.Name Contains 'Test')",
        'Account__r.Rating IsNull true',
        'Account__r.Site IsNull false',
        "Account__r.Description StartsWith 'A')",
      ].join(', '),
    );
  });

  it('uses the boolean filter, and keeps items it cannot read as opaque', () => {
    const items = [
      { field: 'Account.Type', operation: 'equals', value: 'Customer' },
      { field: '$Source.Kind__c', operation: 'equals', value: 'A' },
      { field: '$User.Department', operation: 'equals', value: 'Sales' },
      { field: 'Account', operation: 'equals', value: 'x' },
      { field: 'Account.Tags__c', operation: 'includes', value: 'Gold' },
      { field: 'Account.Rating', operation: 'lessThan' },
      { field: 'Account.Region__c', operation: 'equals', valueField: '$Profile.Name' },
      { field: 'Account.Region__c', operation: 'equals', valueField: 'myVariable' },
    ];
    expect(show(conditionFromLookupFilter(filter(items.slice(0, 2), '1 OR 2'), 'Account__r'))).toBe(
      "or(Account__r.Type EqualTo 'Customer', Kind__c EqualTo 'A')",
    );
    expect(show(conditionFromLookupFilter(filter(items.slice(2)), 'Account__r'))).toBe(
      'and(?$User.Department equals Sales, ?Account equals x, ?Account.Tags__c includes Gold, ?Account.Rating lessThan, ?Account.Region__c equals $Profile.Name, ?Account.Region__c equals myVariable)',
    );
    expect(show(conditionFromLookupFilter(filter(items.slice(0, 2), '1 OR'), 'Account__r'))).toBe('?1 OR');
    expect(show(conditionFromLookupFilter(filter([]), 'Account__r'))).toBe('and()');
  });
});

describe('lookupFilterReader', () => {
  /** A Metadata API read that answers from a map of full names, recording each call. */
  const reader = (records: Record<string, unknown>, fail = false) => {
    const calls: Array<[string, string[]]> = [];
    const read = async (type: string, fullNames: string | string[]) => {
      const names = ([] as string[]).concat(fullNames);
      calls.push([type, names]);
      if (fail) throw new Error('INSUFFICIENT_ACCESS');
      // One component comes back as the record itself; several as a list. Unknown ones are empty.
      const found = names.map((name) => records[name] ?? {});
      return found.length === 1 ? found[0] : found;
    };
    return { read: lookupFilterReader(read), calls };
  };

  it('reads required filters on standard and custom lookups from their field metadata', async () => {
    const { read, calls } = reader({
      'Contact.AccountId': {
        fullName: 'Contact.AccountId',
        lookupFilter: {
          active: 'true',
          isOptional: 'false',
          booleanFilter: '1 OR 2',
          errorMessage: 'Pick a customer.',
          filterItems: [
            { field: 'Account.Type', operation: 'equals', value: 'Customer', valueField: null },
            { field: 'Account.Rating' },
          ],
        },
      },
      'Contact.ns__Site__c': {
        fullName: 'Contact.ns__Site__c',
        // A single filter item comes back as the item itself, not a list.
        lookupFilter: {
          active: true,
          filterItems: { field: '$Source.A__c', operation: 'equals', valueField: '$User.Id' },
        },
      },
      'Contact.Optional__c': { fullName: 'Contact.Optional__c', lookupFilter: { active: true, isOptional: true } },
      'Contact.Inactive__c': { fullName: 'Contact.Inactive__c', lookupFilter: { active: 'false' } },
      'Contact.Plain__c': { fullName: 'Contact.Plain__c', lookupFilter: null },
    });
    expect(
      await read('Contact', ['AccountId', 'ns__Site__c', 'Optional__c', 'Inactive__c', 'Plain__c', 'Missing__c']),
    ).toEqual([
      {
        lookup: 'AccountId',
        items: [{ field: 'Account.Type', operation: 'equals', value: 'Customer' }],
        booleanFilter: '1 OR 2',
        errorMessage: 'Pick a customer.',
      },
      { lookup: 'ns__Site__c', items: [{ field: '$Source.A__c', operation: 'equals', valueField: '$User.Id' }] },
    ]);
    expect(calls).toEqual([
      [
        'CustomField',
        [
          'Contact.AccountId',
          'Contact.ns__Site__c',
          'Contact.Optional__c',
          'Contact.Inactive__c',
          'Contact.Plain__c',
          'Contact.Missing__c',
        ],
      ],
    ]);
  });

  it('reads ten fields per call, handles a single result, and skips calls that fail', async () => {
    const fields = Array.from({ length: 12 }, (_, i) => `F${i}__c`);
    const many = reader({});
    expect(await many.read('Job__c', fields)).toEqual([]);
    expect(many.calls.map(([, names]) => names.length)).toEqual([10, 2]);

    const one = reader({
      'Job__c.Account__c': {
        fullName: 'Job__c.Account__c',
        lookupFilter: { filterItems: { field: 'Account.Type', operation: 'equals', value: 'X' } },
      },
    });
    expect(await one.read('Job__c', ['Account__c'])).toEqual([
      { lookup: 'Account__c', items: [{ field: 'Account.Type', operation: 'equals', value: 'X' }] },
    ]);

    expect(await reader({}, true).read('Job__c', ['Account__c'])).toEqual([]);
    expect(await reader({}).read('Job__c', [])).toEqual([]);
    // A record for another field is ignored.
    const stray = reader({
      'Job__c.Account__c': { fullName: 'Other__c.Account__c', lookupFilter: { filterItems: [] } },
    });
    expect(await stray.read('Job__c', ['Account__c'])).toEqual([]);
  });
});
