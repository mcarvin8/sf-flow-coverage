import { describe, expect, it } from 'vitest';

import { generateApexTest } from '../../src/core/apexTemplate.js';
import { conditionFromFormula } from '../../src/core/conditions.js';
import { type SolveContext, solveCriteria } from '../../src/core/criteria.js';
import { parseFlowXml } from '../../src/core/flowXml.js';

const ctx = (overrides: Partial<SolveContext> = {}): SolveContext => ({
  object: 'Form__c',
  context: 'insert',
  inserted: {},
  fieldValues: { Product__c: 'productParent.Id', Reviewer__c: 'UserInfo.getUserId()' },
  changedValues: {},
  relationships: { Product__r: 'Product__c', Reviewer__r: 'Reviewer__c' },
  lookups: { Product__c: 'Product__c', Reviewer__c: 'User' },
  parentFieldValues: () => ({}),
  ...overrides,
});

const solve = (formula: string) => {
  const plan = solveCriteria(conditionFromFormula(formula), ctx());
  return { set: Object.fromEntries(plan.set), unmet: plan.unmet.length };
};

describe('fields a test never has to fill', () => {
  it('counts the running user as the creator, last modifier, and owner', () => {
    expect(solve('NOT(ISBLANK({!$Record.CreatedBy.Email}))')).toEqual({ set: {}, unmet: 0 });
    expect(solve('NOT(ISBLANK({!$Record.LastModifiedBy.Name}))')).toEqual({ set: {}, unmet: 0 });
    expect(solve('NOT(ISBLANK({!$Record.Owner.Username}))')).toEqual({ set: {}, unmet: 0 });
    // A user field the running user may not have filled in stays a TODO.
    expect(solve('NOT(ISBLANK({!$Record.CreatedBy.Department}))').unmet).toBe(1);
    // Only "not blank" is certain: a particular value isn't.
    expect(solve('{!$Record.CreatedBy.Email} = "a@example.com"').unmet).toBe(1);
  });

  it('counts record type fields as filled', () => {
    expect(solve('NOT(ISBLANK({!$Record.RecordType.Name}))')).toEqual({ set: {}, unmet: 0 });
    expect(solve('NOT(ISBLANK({!$Record.RecordType.Description}))').unmet).toBe(1);
  });

  it("fills a lookup when only the related record's Id is read", () => {
    expect(solve('NOT(ISBLANK({!$Record.Product__r.Id}))')).toEqual({
      set: { Product__c: 'productParent.Id' },
      unmet: 0,
    });
  });

  it('points a lookup to a user at the running user', () => {
    expect(solve('NOT(ISBLANK({!$Record.Reviewer__r.Email}))')).toEqual({
      set: { Reviewer__c: 'UserInfo.getUserId()' },
      unmet: 0,
    });
    expect(solve('NOT(ISBLANK({!$Record.Reviewer__r.Department}))').unmet).toBe(1);
  });
});

describe('reads from input records that need no TODO', () => {
  it('fills only what it must, and says nothing about what is always set', () => {
    const reads = ['CreatedBy.Email', 'RecordType.Name', 'Product__r.Id', 'Reviewer__r.Id']
      .map(
        (read) =>
          `<assignmentItems><assignToReference>out</assignToReference><operator>Assign</operator><value><elementReference>form.${read}</elementReference></value></assignmentItems>`,
      )
      .join('');
    const test = generateApexTest(
      parseFlowXml(
        'Calc',
        `<Flow><processType>AutoLaunchedFlow</processType>
          <variables><name>form</name><dataType>SObject</dataType><objectType>Form__c</objectType><isInput>true</isInput><isOutput>false</isOutput><isCollection>false</isCollection></variables>
          <variables><name>out</name><dataType>String</dataType><isInput>false</isInput><isOutput>true</isOutput><isCollection>false</isCollection></variables>
          <assignments><name>First</name>${reads}</assignments>
          <start><connector><targetReference>First</targetReference></connector></start></Flow>`,
      ),
      {
        requiredFields: { Form__c: { Name: "'F'" }, Product__c: { Name: "'P'" } },
        lookups: { Form__c: { Product__c: 'Product__c', Reviewer__c: 'User' } },
        relationships: { Form__c: { Product__r: 'Product__c', Reviewer__r: 'Reviewer__c' } },
      },
    );
    expect(test.body).not.toContain('TODO: fill');
    expect(test.body).toContain('Product__c = productParent.Id');
    expect(test.body).toContain('Reviewer__c = UserInfo.getUserId()');
  });
});
