import { describe, expect, it } from 'vitest';

import type { ToolingQuery } from '../../src/core/types.js';
import { validationRuleReader } from '../../src/core/validationRules.js';

/** A query that answers by SOQL text, recording each query. */
function fakeQuery(answer: (soql: string) => Array<Record<string, unknown>> | Error): {
  query: ToolingQuery;
  calls: string[];
} {
  const calls: string[] = [];
  const query = (async (soql: string) => {
    calls.push(soql);
    const result = answer(soql);
    if (result instanceof Error) throw result;
    return result;
  }) as ToolingQuery;
  return { query, calls };
}

describe('validationRuleReader', () => {
  it('lists the active rules of an object and reads each formula', async () => {
    const { query, calls } = fakeQuery((soql) => {
      if (soql.includes('FROM ValidationRule WHERE Active')) {
        return [
          { Id: '03d1', ValidationName: 'Date_Not_Past', ErrorMessage: 'Pick today or later.' },
          { Id: '03d2', ValidationName: 'No_Formula', ErrorMessage: null },
          { Id: '03d3', ValidationName: 'Unreadable' },
        ];
      }
      if (soql.includes("'03d1'")) return [{ Metadata: { errorConditionFormula: 'Install_Date__c < TODAY()' } }];
      if (soql.includes("'03d2'")) return [{ Metadata: { errorConditionFormula: null } }];
      return new Error('INVALID_ID');
    });
    expect(await validationRuleReader(query)("Job's__c")).toEqual([
      { name: 'Date_Not_Past', formula: 'Install_Date__c < TODAY()', message: 'Pick today or later.' },
    ]);
    expect(calls[0]).toBe(
      "SELECT Id, ValidationName, ErrorMessage FROM ValidationRule WHERE Active = true AND EntityDefinition.QualifiedApiName = 'Job\\'s__c'",
    );
    expect(calls.slice(1)).toEqual([
      "SELECT Metadata FROM ValidationRule WHERE Id = '03d1'",
      "SELECT Metadata FROM ValidationRule WHERE Id = '03d2'",
      "SELECT Metadata FROM ValidationRule WHERE Id = '03d3'",
    ]);
  });

  it('reads nothing when the rules cannot be listed', async () => {
    const { query } = fakeQuery(() => new Error('INSUFFICIENT_ACCESS'));
    expect(await validationRuleReader(query)('Job__c')).toEqual([]);
  });
});
