import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { generateApexTest } from '../../src/core/apexTemplate.js';
import {
  applyFieldFunction,
  type Condition,
  conditionFromFormula,
  type EvaluationEnv,
  evaluateCondition,
  evaluateExpr,
} from '../../src/core/conditions.js';
import { type SolveContext, solveCriteria } from '../../src/core/criteria.js';
import { parseFlowXml } from '../../src/core/flowXml.js';
import { type Expr, parseFormula } from '../../src/core/formula.js';
import { scaffoldTests } from '../../src/core/scaffold.js';

const env = (values: Record<string, string | null>): EvaluationEnv => ({
  get: (reference) => (reference in values ? values[reference] : undefined),
});

const value = (formula: string, values: Record<string, string | null> = {}) =>
  evaluateExpr(parseFormula(formula) as Expr, env(values));

const holds = (formula: string, values: Record<string, string | null>) =>
  evaluateCondition(conditionFromFormula(formula), env(values));

describe('field functions in conditions', () => {
  it('reads a function of one field as that field, through the function', () => {
    const atom = conditionFromFormula('LEN({!$Record.Name}) > 3') as Extract<Condition, { kind: 'atom' }>;
    expect(atom.left).toEqual({ kind: 'field', path: ['Name'], prior: false, fn: 'LEN' });
    // A constant on the left is moved to the right, with the comparison mirrored.
    const mirrored = conditionFromFormula('3 < LEN({!$Record.Name})') as Extract<Condition, { kind: 'atom' }>;
    expect([mirrored.left.kind, mirrored.op]).toEqual(['field', 'GreaterThan']);
    const prior = conditionFromFormula('TEXT(PRIORVALUE({!$Record.Stage__c})) = "Open"') as Extract<
      Condition,
      { kind: 'atom' }
    >;
    expect(prior.left).toEqual({ kind: 'field', path: ['Stage__c'], prior: true, fn: 'TEXT' });
    // Functions of functions stay expressions.
    const nested = conditionFromFormula('LEN(TRIM({!$Record.Name})) > 3') as Extract<Condition, { kind: 'atom' }>;
    expect(nested.left.kind).toBe('expr');
  });

  it('evaluates each function', () => {
    expect(value('LEN({!a})', { a: "'abcd'" })).toEqual({ kind: 'number', value: 4 });
    expect(value('LEN({!a})', { a: null })).toEqual({ kind: 'number', value: 0 });
    expect(value('UPPER({!a})', { a: "'ab'" })).toEqual({ kind: 'string', value: 'AB' });
    expect(value('LOWER({!a})', { a: "'AB'" })).toEqual({ kind: 'string', value: 'ab' });
    expect(value('TRIM({!a})', { a: "'  '" })).toEqual({ kind: 'null' });
    expect(value('TRIM({!a})', { a: null })).toEqual({ kind: 'null' });
    expect(value('UPPER({!a})', { a: '5' })).toBeUndefined();
    expect(value('VALUE({!a})', { a: "' 12.5 '" })).toEqual({ kind: 'number', value: 12.5 });
    expect(value('VALUE({!a})', { a: "'x'" })).toBeUndefined();
    expect(value('TEXT({!a})', { a: 'true' })).toEqual({ kind: 'string', value: 'true' });
    expect(value('TEXT({!a})', { a: 'Date.today()' })).toBeUndefined();
    expect(value('LEN({!a}, 2)', { a: "'x'" })).toBeUndefined();
    expect(applyFieldFunction('LEN', undefined)).toBeUndefined();
  });

  it('evaluates CASE', () => {
    const stage = (apex: string | null) => ({ s: apex });
    expect(value('CASE({!s}, "A", 1, "B", 2, 0)', stage("'B'"))).toEqual({ kind: 'number', value: 2 });
    expect(value('CASE({!s}, "A", 1, "B", 2, 0)', stage("'C'"))).toEqual({ kind: 'number', value: 0 });
    expect(value('CASE({!s}, "A", 1, 0)', {})).toBeUndefined();
    expect(value('CASE({!s}, "A", 1)', stage("'A'"))).toBeUndefined();
  });

  it('evaluates conditions on functions of fields', () => {
    expect(holds('LEN({!$Record.Name}) > 3', { '$Record.Name': "'Acme'" })).toBe(true);
    expect(holds('ISBLANK(TEXT({!$Record.Stage__c}))', { '$Record.Stage__c': null })).toBe(true);
    expect(holds('ISCHANGED(TEXT({!$Record.Stage__c}))', { '$Record.Stage__c': "'A'" })).toBeUndefined();
    expect(holds('{!$Record.A__c} * 2 > 5', { '$Record.A__c': '3' })).toBe(true);
  });

  it('expands CASE and IF into branches, and folds comparisons of constants', () => {
    const tier = 'CASE({!$Record.Tier__c}, "Gold", 3, "Silver", 2, 1) >= 2';
    expect(holds(tier, { '$Record.Tier__c': "'Silver'" })).toBe(true);
    expect(holds(tier, { '$Record.Tier__c': "'Bronze'" })).toBe(false);
    expect(holds('2 = CASE({!$Record.Tier__c}, "Gold", 3, "Silver", 2, 1)', { '$Record.Tier__c': "'Silver'" })).toBe(
      true,
    );
    expect(holds('CASE({!$Record.Tier__c}, "Gold", TRUE, FALSE)', { '$Record.Tier__c': "'Gold'" })).toBe(true);
    expect(holds('IF({!$Record.Big__c}, 10, 1) > 5', { '$Record.Big__c': 'false' })).toBe(false);
    expect(conditionFromFormula('1 < 2')).toEqual({ kind: 'and', items: [] });
    expect(conditionFromFormula('"a" = "b"')).toEqual({ kind: 'or', items: [] });
    // Constants that can't be settled stay comparisons.
    expect(conditionFromFormula('"a" = "A"').kind).toBe('atom');
    expect(conditionFromFormula('CASE({!$Record.Tier__c}, "Gold")')).toMatchObject({ kind: 'opaque' });
  });
});

describe('solveCriteria with field functions', () => {
  const ctx = (overrides: Partial<SolveContext> = {}): SolveContext => ({
    object: 'Job__c',
    context: 'insert',
    inserted: {},
    fieldValues: { Name: "'Test'", Code__c: "'ab'" },
    changedValues: { Code__c: "'cd'" },
    relationships: {},
    lookups: {},
    parentFieldValues: () => ({}),
    ...overrides,
  });
  const plan = (formula: string, overrides: Partial<SolveContext> = {}) => {
    const result = solveCriteria(conditionFromFormula(formula), ctx(overrides));
    return { set: Object.fromEntries(result.set), keep: [...result.keep], unmet: result.unmet.length };
  };

  it('sets text of the length a LEN comparison needs', () => {
    expect(plan('LEN({!$Record.Name}) > 3')).toEqual({ set: { Name: "'xxxx'" }, keep: [], unmet: 0 });
    expect(plan('LEN({!$Record.Name}) = 2').set).toEqual({ Name: "'xx'" });
    // A blank value has length 0, which isn't 2.
    expect(plan('LEN({!$Record.Name}) <> 2').keep).toEqual(['Name']);
    expect(plan('LEN({!$Record.Name}) <> 2', { inserted: { Name: "'ab'" } }).set).toEqual({ Name: "'xxx'" });
    expect(plan('LEN({!$Record.Name}) < 1')).toEqual({ set: {}, keep: ['Name'], unmet: 0 });
    // A value another condition sets is kept when it meets the comparison.
    expect(plan('AND({!$Record.Name} = "Acme", LEN({!$Record.Name}) > 3)')).toMatchObject({ unmet: 0 });
    expect(plan('AND({!$Record.Name} = "Acme", LEN({!$Record.Name}) > 10)').unmet).toBe(1);
    // A required value can't be emptied, and no text is shorter than nothing.
    expect(plan('LEN({!$Record.Name}) < 1', { inserted: { Name: "'Test'" } }).unmet).toBe(1);
    expect(plan('LEN({!$Record.Name}) > 300').unmet).toBe(1);
    expect(plan('LEN({!$Record.Name}) > {!myVar}').unmet).toBe(1);
    expect(plan('CONTAINS(LEN({!$Record.Name}), 3)').unmet).toBe(1);
  });

  it('sets the value TEXT, UPPER, LOWER, TRIM, and VALUE comparisons need', () => {
    expect(plan('TEXT({!$Record.Stage__c}) = "Won"').set).toEqual({ Stage__c: "'Won'" });
    expect(plan('BEGINS(UPPER({!$Record.Code__c}), "AB")').set).toEqual({ Code__c: "'AB'" });
    expect(plan('UPPER({!$Record.Code__c}) = "ab"').unmet).toBe(1);
    expect(plan('LOWER({!$Record.Code__c}) <> "ab"', { inserted: { Code__c: "'ab'" } }).set).toEqual({
      Code__c: "'cd'",
    });
    expect(plan('TRIM({!$Record.Code__c}) = "x"').set).toEqual({ Code__c: "'x'" });
    expect(plan('VALUE({!$Record.Code__c}) >= 10').set).toEqual({ Code__c: "'10'" });
    expect(plan('VALUE({!$Record.Code__c}) > 1.5').set).toEqual({ Code__c: "'2.5'" });
    expect(plan('VALUE({!$Record.Code__c}) = "x"').unmet).toBe(1);
    // Digits compared with TEXT() of what may be a number field: setting text wouldn't compile.
    expect(plan('TEXT({!$Record.Amount__c}) = "5"').unmet).toBe(1);
    expect(plan('TEXT({!$Record.Stage__c}) > "a"').unmet).toBe(1);
  });

  it('treats blank checks through TEXT as blank checks on the field, and others as TODOs', () => {
    expect(plan('ISBLANK(TEXT({!$Record.Stage__c}))').keep).toEqual(['Stage__c']);
    expect(plan('NOT(ISBLANK(TEXT({!$Record.Code__c})))').set).toEqual({ Code__c: "'ab'" });
    expect(plan('ISBLANK(LEN({!$Record.Name}))').unmet).toBe(1);
    expect(plan('ISCHANGED(TEXT({!$Record.Code__c}))', { context: 'update' }).unmet).toBe(1);
  });

  it('meets functions of prior values in an update', () => {
    const result = solveCriteria(
      conditionFromFormula('AND(LEN(PRIORVALUE({!$Record.Code__c})) = 1, {!$Record.Code__c} = "abc")'),
      ctx({ context: 'update' }),
    );
    expect(Object.fromEntries(result.prior)).toEqual({ Code__c: "'x'" });
    expect(Object.fromEntries(result.set)).toEqual({ Code__c: "'abc'" });
  });

  it('meets CASE and IF comparisons by meeting one branch', () => {
    expect(plan('CASE({!$Record.Tier__c}, "Gold", 3, "Silver", 2, 1) = 2').set).toEqual({ Tier__c: "'Silver'" });
    expect(plan('CASE({!$Record.Code__c}, "Gold", 3, "Silver", 2, 1) = 1')).toMatchObject({ unmet: 0 });
    expect(plan('IF({!$Record.Big__c}, 10, 1) > 5').set).toEqual({ Big__c: 'true' });
  });
});

describe('solveCriteria on records more than one relationship away', () => {
  type Links = { relationships: Record<string, string>; lookups: Record<string, string> };
  const parentValues: Record<string, Record<string, string>> = {
    Contact: { AccountId: 'accountParent.Id' },
    Account: { ParentId: 'accountParent.Id' },
  };
  const links: Record<string, Links> = {
    Contact: { relationships: { Account: 'AccountId' }, lookups: { AccountId: 'Account' } },
    Account: { relationships: { Parent: 'ParentId' }, lookups: { ParentId: 'Account' } },
  };
  const ctx = (overrides: Partial<SolveContext> = {}): SolveContext => ({
    object: 'Job__c',
    context: 'insert',
    inserted: {},
    fieldValues: { Contact__c: 'contactParent.Id' },
    changedValues: {},
    relationships: { Contact__r: 'Contact__c' },
    lookups: { Contact__c: 'Contact' },
    parentFieldValues: (object) => parentValues[object] ?? {},
    parentLinks: (object) => links[object] ?? { relationships: {}, lookups: {} },
    ...overrides,
  });
  const solve = (formula: string, overrides: Partial<SolveContext> = {}) => {
    const plan = solveCriteria(conditionFromFormula(formula), ctx(overrides));
    return {
      set: Object.fromEntries(plan.set),
      parents: Object.fromEntries([...plan.parents].map(([object, fields]) => [object, Object.fromEntries(fields)])),
      unmet: plan.unmet.length,
    };
  };

  it('looks up each parent in turn and sets the field on the last one', () => {
    expect(solve('{!$Record.Contact__r.Account.Type} = "Partner"')).toEqual({
      set: { Contact__c: 'contactParent.Id' },
      parents: { Contact: { AccountId: 'accountParent.Id' }, Account: { Type: "'Partner'" } },
      unmet: 0,
    });
    expect(solve('LEN({!$Record.Contact__r.Account.Name}) > 2').parents.Account).toEqual({ Name: "'xxx'" });
    expect(solve('{!$Record.Contact__r.RecordType.DeveloperName} = "Partner"').parents.Contact).toEqual({
      RecordTypeId: "Schema.SObjectType.Contact.getRecordTypeInfosByDeveloperName().get('Partner').getRecordTypeId()",
    });
  });

  it('leaves paths it cannot follow as TODOs', () => {
    // Through the same object twice: a test inserts one record per parent object.
    expect(solve('{!$Record.Contact__r.Account.Parent.Name} = "A"').unmet).toBe(1);
    expect(solve('{!$Record.A__r.B__r.C__r.D__r.Name} = "A"').unmet).toBe(1);
    expect(solve('{!$Record.Contact__r.Account.Type} = "A"', { parentLinks: undefined }).unmet).toBe(1);
    expect(solve('{!$Record.Contact__r.Owner__r.Name} = "A"').unmet).toBe(1);
    expect(solve('{!$Record.Contact__r.RecordType.Name} = "A"').unmet).toBe(1);
    expect(solve('{!$Record.Contact__r.RecordType.DeveloperName} <> "A"').unmet).toBe(1);
    expect(solve('{!$Record.Contact__r.RecordType.DeveloperName} = {!myVar}').unmet).toBe(1);
    expect(solve('TEXT({!$Record.RecordType.DeveloperName}) = "A"').unmet).toBe(1);
    // Compared with another field of the record, which gets a value too.
    const compared = solve('{!$Record.Contact__r.Account.Type} = {!$Record.Name}', {
      fieldValues: { Contact__c: 'contactParent.Id', Name: "'N'" },
    });
    expect(compared.parents.Account).toEqual({ Type: "'N'" });
  });
});

describe('generated tests for deeper criteria', () => {
  const flow = parseFlowXml(
    'Job_Flow',
    `<Flow><processType>AutoLaunchedFlow</processType><start>
      <filterFormula>AND({!$Record.Contact__r.Account.Type} = "Partner", LEN({!$Record.Name}) > 5)</filterFormula>
      <object>Job__c</object><recordTriggerType>Create</recordTriggerType><triggerType>RecordAfterSave</triggerType>
    </start></Flow>`,
  );

  it('inserts the grandparent with the value, the parent pointing at it, and the record pointing at the parent', () => {
    const test = generateApexTest(flow, {
      requiredFields: { Job__c: { Name: "'Test'" }, Contact: { LastName: "'C'" }, Account: { Name: "'A'" } },
      lookups: { Job__c: { Contact__c: 'Contact' }, Contact: { AccountId: 'Account' } },
      relationships: { Job__c: { Contact__r: 'Contact__c' }, Contact: { Account: 'AccountId' } },
    });
    expect(test.body).not.toContain('TODO: entry criteria');
    expect(test.body).toContain("Type = 'Partner'");
    expect(test.body).toContain('AccountId = accountParent.Id');
    expect(test.body).toContain('Contact__c = contactParent.Id');
    // The required Name is too short for the criteria, so it is replaced.
    expect(test.body).toContain("Name = 'xxxxxx'");
    expect(test.body.indexOf('insert accountParent;')).toBeLessThan(test.body.indexOf('insert contactParent;'));
  });

  it('describes the objects along the path when scaffolding', async () => {
    const project = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-deep-'));
    try {
      mkdirSync(join(project, 'flows'));
      writeFileSync(
        join(project, 'flows', 'Job_Flow.flow-meta.xml'),
        `<Flow><processType>AutoLaunchedFlow</processType><status>Active</status><start>
          <filterFormula>AND({!$Record.Contact__r.Account.Type} = "Partner", {!$Record.Contact__r.Owner.Name} = "x", {!$Record.Unknown__r.Name} = "y")</filterFormula>
          <object>Job__c</object><recordTriggerType>Create</recordTriggerType><triggerType>RecordAfterSave</triggerType>
        </start></Flow>`,
      );
      const field = (name: string, extra: Record<string, unknown> = {}) => ({
        name,
        type: 'string',
        nillable: true,
        createable: true,
        defaultedOnCreate: false,
        ...extra,
      });
      const lookup = (name: string, target: string, relationshipName: string) =>
        field(name, { type: 'reference', referenceTo: [target], relationshipName });
      const described: string[] = [];
      await scaffoldTests({
        flowNames: ['Job_Flow'],
        projectDir: project,
        outputDir: join(project, 'out'),
        describe: async (object) => {
          described.push(object);
          if (object === 'Job__c') return [lookup('Contact__c', 'Contact', 'Contact__r')];
          if (object === 'Contact')
            return [
              field('LastName', { nillable: false }),
              lookup('AccountId', 'Account', 'Account'),
              lookup('OwnerId', 'User', 'Owner'),
            ];
          return [field('Name', { nillable: false }), field('Type')];
        },
      });
      expect(described).toEqual(['Job__c', 'Contact', 'Account']);
      const test = readFileSync(join(project, 'out', 'Job_Flow_FlowTest.cls'), 'utf8');
      expect(test).toContain("Type = 'Partner'");
      expect(test).toContain('AccountId = accountParent.Id');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
