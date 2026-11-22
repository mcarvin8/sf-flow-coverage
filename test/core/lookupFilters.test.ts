import { describe, expect, it } from 'vitest';

import { type Condition, type Operand } from '../../src/core/conditions.js';
import { conditionFromLookupFilter, type LookupFilter, lookupFilterReader } from '../../src/core/lookupFilters.js';
import type { ToolingQuery } from '../../src/core/types.js';

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
  const reader = (answer: (soql: string) => Array<Record<string, unknown>> | Error) => {
    const calls: string[] = [];
    const query = (async (soql: string) => {
      calls.push(soql);
      const result = answer(soql);
      if (result instanceof Error) throw result;
      return result;
    }) as ToolingQuery;
    return { read: lookupFilterReader(query), calls };
  };

  it('reads required filters on custom lookups from their field metadata', async () => {
    const { read, calls } = reader((soql) => {
      if (soql.includes('FROM EntityDefinition')) return [{ DurableId: '01I1' }];
      if (soql.includes("DeveloperName = 'Account'")) return [{ Id: '00N1' }];
      if (soql.includes("DeveloperName = 'Site' AND NamespacePrefix = 'ns'")) return [{ Id: '00N2' }];
      if (soql.includes("DeveloperName = 'Optional'")) return [{ Id: '00N3' }];
      if (soql.includes("DeveloperName = 'Missing'")) return [];
      if (soql.includes("Id = '00N1'")) {
        return [
          {
            Metadata: {
              lookupFilter: {
                active: true,
                isOptional: false,
                booleanFilter: '1 OR 2',
                errorMessage: 'Pick a customer.',
                filterItems: [
                  { field: 'Account.Type', operation: 'equals', value: 'Customer', valueField: null },
                  { field: 'Account.Rating' },
                ],
              },
            },
          },
        ];
      }
      if (soql.includes("Id = '00N2'")) {
        return [
          {
            Metadata: {
              lookupFilter: {
                active: true,
                filterItems: [{ field: '$Source.A__c', operation: 'equals', valueField: '$User.Id' }],
              },
            },
          },
        ];
      }
      if (soql.includes("Id = '00N3'"))
        return [{ Metadata: { lookupFilter: { active: true, isOptional: true, filterItems: [] } } }];
      return new Error('unexpected');
    });
    expect(
      await read('Job__c', ['Account__c', 'ns__Site__c', 'Optional__c', 'Missing__c', 'OwnerId', 'Broken__c']),
    ).toEqual([
      {
        lookup: 'Account__c',
        items: [{ field: 'Account.Type', operation: 'equals', value: 'Customer' }],
        booleanFilter: '1 OR 2',
        errorMessage: 'Pick a customer.',
      },
      { lookup: 'ns__Site__c', items: [{ field: '$Source.A__c', operation: 'equals', valueField: '$User.Id' }] },
    ]);
    expect(calls[0]).toBe("SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = 'Job__c'");
    expect(calls[1]).toBe("SELECT Id FROM CustomField WHERE TableEnumOrId = '01I1' AND DeveloperName = 'Account'");
  });

  it('reads nothing for standard lookups or an object it cannot find', async () => {
    const none = reader(() => new Error('should not query'));
    expect(await none.read('Job__c', ['OwnerId'])).toEqual([]);
    expect(none.calls).toEqual([]);
    expect(await reader(() => []).read('Job__c', ['Account__c'])).toEqual([]);
    expect(await reader(() => new Error('no access')).read('Job__c', ['Account__c'])).toEqual([]);
    const inactive = reader((soql) =>
      soql.includes('EntityDefinition')
        ? [{ DurableId: '01I1' }]
        : soql.includes('SELECT Id FROM')
          ? [{ Id: '00N1' }]
          : [{ Metadata: { lookupFilter: { active: false, filterItems: [] } } }],
    );
    expect(await inactive.read('Job__c', ['Account__c'])).toEqual([]);
    const noFilter = reader((soql) =>
      soql.includes('EntityDefinition')
        ? [{ DurableId: '01I1' }]
        : soql.includes('SELECT Id FROM')
          ? [{ Id: '00N1' }]
          : [{ Metadata: {} }],
    );
    expect(await noFilter.read('Job__c', ['Account__c'])).toEqual([]);
  });
});
