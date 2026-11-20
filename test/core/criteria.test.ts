import { describe, expect, it } from 'vitest';

import { conditionFromFilters, conditionFromFormula, conditionFromRule, negate } from '../../src/core/conditions.js';
import { boundValue, type CriteriaPlan, type SolveContext, solveCriteria } from '../../src/core/criteria.js';

const ctx = (overrides: Partial<SolveContext> = {}): SolveContext => ({
  object: 'Job__c',
  context: 'insert',
  inserted: {},
  fieldValues: {
    Crew__c: '1',
    Due__c: 'Date.today()',
    Status__c: "'Open'",
    Notes__c: "'Test'",
    Max__c: '10',
    Account__c: 'accountParent.Id',
    Contact__c: 'null /* TODO: set a Contact Id */',
  },
  changedValues: { Status__c: "'Closed'", Notes__c: "'Changed'", Crew__c: '2' },
  relationships: { Account__r: 'Account__c', Contact__r: 'Contact__c' },
  lookups: { Account__c: 'Account', Contact__c: 'Contact' },
  parentFieldValues: (object): Record<string, string> => (object === 'Account' ? { Rating: "'Hot'" } : {}),
  ...overrides,
});

/** The plan as plain data, for readable expectations. */
const plain = (plan: CriteriaPlan) => ({
  set: Object.fromEntries(plan.set),
  ...(plan.prior.size > 0 ? { prior: Object.fromEntries(plan.prior) } : {}),
  ...(plan.keep.size > 0 ? { keep: [...plan.keep] } : {}),
  ...(plan.parents.size > 0
    ? { parents: Object.fromEntries([...plan.parents].map(([o, f]) => [o, Object.fromEntries(f)])) }
    : {}),
  ...(plan.unmet.length > 0 ? { unmet: plan.unmet.map((u) => `${u.label}: ${u.text}`) } : {}),
});

const solve = (formula: string, overrides: Partial<SolveContext> = {}) =>
  plain(solveCriteria(conditionFromFormula(formula), ctx(overrides)));

describe('solveCriteria', () => {
  it('meets equality, comparisons, string matches, blanks, and the running user', () => {
    expect(
      solve(
        'AND(ISPICKVAL({!$Record.Stage__c}, "Won"), {!$Record.Hours__c} > 8, {!$Record.Rate__c} <= 0.5, CONTAINS({!$Record.Code__c}, "INV"), NOT(ISBLANK({!$Record.Crew__c})), ISBLANK({!$Record.Notes__c}), {!$Record.Owner__c} = {!$User.Id})',
      ),
    ).toEqual({
      set: {
        Stage__c: "'Won'",
        Hours__c: '9',
        Rate__c: '0.5',
        Code__c: "'INV'",
        Crew__c: '1',
        Owner__c: 'UserInfo.getUserId()',
      },
      keep: ['Notes__c'],
    });
  });

  it('steps dates and datetimes past a bound', () => {
    expect(solve('AND({!$Record.Due__c} < TODAY() + 7, {!$Record.Sent__c} >= NOW())').set).toEqual({
      Due__c: 'Date.today().addDays(7).addDays(-1)',
      Sent__c: 'Datetime.now()',
    });
    expect(solve('{!$Record.Sent__c} > NOW()').set).toEqual({ Sent__c: 'Datetime.now().addSeconds(1)' });
  });

  it('meets NotEqualTo with a described value that differs, and compares two fields', () => {
    expect(solve('{!$Record.Status__c} <> "Open"').set).toEqual({ Status__c: "'Closed'" });
    expect(solve('{!$Record.Status__c} <> "Pending"').set).toEqual({ Status__c: "'Open'" });
    // 'Test' might equal "test" ignoring case, so the changed value is used instead.
    expect(solve('{!$Record.Notes__c} <> "test"').set).toEqual({ Notes__c: "'Changed'" });
    expect(solve('{!$Record.Crew__c} > {!$Record.Max__c}').set).toEqual({ Max__c: '10', Crew__c: '11' });
    expect(solve('AND({!$Record.Max__c} = 3, {!$Record.Crew__c} > {!$Record.Max__c})').set).toEqual({
      Max__c: '3',
      Crew__c: '4',
    });
    expect(solve('{!$Record.Crew__c} > {!$Record.Max__c}', { inserted: { Max__c: '7' } }).set).toEqual({
      Crew__c: '8',
    });
  });

  it('meets one branch of an OR, preferring one it can meet in full', () => {
    expect(solve('OR(FOO(), {!$Record.Stage__c} = "Won")')).toEqual({ set: { Stage__c: "'Won'" } });
    expect(solve('OR(FOO(), BAR(), AND({!$Record.A__c} = 1, BAZ()))')).toEqual({
      set: {},
      unmet: ['entry criteria formula term: FOO()'],
    });
    expect(solve('IF({!$Record.Kind__c} = "A", {!$Record.N__c} = 1, {!$Record.N__c} = 2)').set).toEqual({
      Kind__c: "'A'",
      N__c: '1',
    });
    expect(solve('FALSE')).toEqual({ set: {}, unmet: ['entry criteria formula: FALSE'] });
  });

  it('meets custom filter logic and negated conditions', () => {
    const filters = [
      { field: 'Status__c', operator: 'EqualTo', apexValue: "'Closed'", rawValue: 'Closed' },
      { field: 'Hours__c', operator: 'GreaterThan', rawValue: '$Record.Unknown' },
      { field: 'Crew__c', operator: 'IsNull', apexValue: 'false', rawValue: 'false' },
    ];
    expect(plain(solveCriteria(conditionFromFilters(filters, '(1 AND 2) OR 3'), ctx()))).toEqual({
      set: { Crew__c: '1' },
    });
    expect(solve('NOT(OR({!$Record.Status__c} = "Open", ISBLANK({!$Record.Crew__c})))').set).toEqual({
      Status__c: "'Closed'",
      Crew__c: '1',
    });
  });

  it('reports conflicts and conditions it cannot meet', () => {
    expect(solve('AND({!$Record.Stage__c} = "A", {!$Record.Stage__c} = "B")')).toEqual({
      set: { Stage__c: "'A'" },
      unmet: ['entry criteria formula term: {!$Record.Stage__c} = "B"'],
    });
    expect(solve('AND(ISBLANK({!$Record.Stage__c}), {!$Record.Stage__c} = "B")').unmet).toEqual([
      'entry criteria formula term: {!$Record.Stage__c} = "B"',
    ]);
    expect(solve('AND({!$Record.Stage__c} = "B", ISBLANK({!$Record.Stage__c}))').unmet).toHaveLength(1);
    expect(solve('ISBLANK({!$Record.Crew__c})', { inserted: { Crew__c: '1' } }).unmet).toHaveLength(1);
    expect(solve('ISBLANK({!$Record.Contact__c})', { inserted: { Contact__c: 'null /* TODO */' } }).keep).toEqual([
      'Contact__c',
    ]);
    for (const formula of [
      'NOT(ISBLANK({!$Record.Unknown__c}))',
      '{!$Record.Status__c} <> {!$User.Id}',
      '{!$Record.Kind__c} <> "A"',
      'CONTAINS({!$Record.N__c}, 5)',
      '{!$Record.N__c} > "x"',
      '{!$Record.N__c} > {!$Record__Prior.N__c}',
      '{!$Record.N__c} > {!$Record.Unknown__c}',
      '{!$Record.A.B.C} = 1',
      '{!myVar} = 1',
      '{!$Record.N__c} * 2 = 4',
      'ISCHANGED({!$Record.Status__c})',
      '{!$Record__Prior.Status__c} = "Open"',
    ]) {
      expect(solve(formula).unmet, formula).toHaveLength(1);
    }
  });

  it('meets criteria on related records through their lookup', () => {
    expect(solve('AND({!$Record.Account__r.Rating} = "Hot", NOT(ISBLANK({!$Record.Account__r.Industry})))')).toEqual({
      set: { Account__c: 'accountParent.Id' },
      parents: { Account: { Rating: "'Hot'" } },
      unmet: ['entry criteria formula term: NOT(ISBLANK({!$Record.Account__r.Industry}))'],
    });
    expect(solve('AND({!$Record.Account__r.Rating} <> "Cold", {!$Record.Account__r.Rating} <> "Hot")').unmet).toEqual([
      'entry criteria formula term: {!$Record.Account__r.Rating} <> "Hot"',
    ]);
    expect(solve('{!$Record.RecordType.DeveloperName} = "Install"').set).toEqual({
      RecordTypeId: "Schema.SObjectType.Job__c.getRecordTypeInfosByDeveloperName().get('Install').getRecordTypeId()",
    });
    for (const formula of [
      '{!$Record.Contact__r.Name} = "x"',
      '{!$Record.Missing__r.Name} = "x"',
      'ISBLANK({!$Record.Account__r.Rating})',
      '{!$Record.RecordType.DeveloperName} = 5',
      'AND({!$Record.Account__c} = "001", {!$Record.Account__r.Rating} = "Hot")',
      'AND({!$Record.Account__r.Rating} = "Hot", {!$Record.Account__r.Rating} = "Cold")',
    ]) {
      expect(solve(formula).unmet, formula).toHaveLength(1);
    }
  });

  describe('in an update', () => {
    const update = (formula: string, overrides: Partial<SolveContext> = {}) =>
      solve(formula, { context: 'update', ...overrides });

    it('changes fields for IsChanged, counting fields other conditions set', () => {
      expect(update('ISCHANGED({!$Record.Notes__c})')).toEqual({ set: { Notes__c: "'Changed'" } });
      expect(update('AND(ISCHANGED({!$Record.Status__c}), ISPICKVAL({!$Record.Status__c}, "Done"))')).toEqual({
        set: { Status__c: "'Done'" },
      });
      expect(update('NOT(ISCHANGED({!$Record.Notes__c}))')).toEqual({ set: {}, keep: ['Notes__c'] });
      expect(
        update('AND(ISCHANGED({!$Record.Status__c}), ISPICKVAL({!$Record.Status__c}, "Done"))', {
          inserted: { Status__c: "'Done'" },
        }).unmet,
      ).toHaveLength(1);
      expect(update('AND({!$Record.Notes__c} = "x", NOT(ISCHANGED({!$Record.Notes__c})))').unmet).toHaveLength(1);
      expect(update('ISCHANGED({!$Record.Unknown__c})').unmet).toHaveLength(1);
      expect(update('ISCHANGED({!$Record.Crew__c})', { inserted: { Crew__c: '2' } }).unmet).toHaveLength(1);
    });

    it('sets prior values in the insert', () => {
      expect(update('AND({!$Record.Status__c} = "Closed", {!$Record__Prior.Status__c} <> "Closed")')).toEqual({
        set: { Status__c: "'Closed'" },
        prior: { Status__c: "'Open'" },
      });
      expect(update('AND(PRIORVALUE({!$Record.Crew__c}) = 3, ISBLANK({!$Record__Prior.Notes__c}))')).toEqual({
        set: {},
        prior: { Crew__c: '3' },
      });
      expect(update('{!$Record__Prior.Crew__c} = 3', { inserted: { Crew__c: '1' } }).unmet).toHaveLength(1);
      expect(update('{!$Record__Prior.Crew__c} = 1', { inserted: { Crew__c: '1' } }).unmet).toBeUndefined();
      expect(update('ISBLANK({!$Record__Prior.Crew__c})', { inserted: { Crew__c: '1' } }).unmet).toHaveLength(1);
      expect(
        update('AND({!$Record__Prior.Crew__c} = 3, ISBLANK({!$Record.Crew__c}))').unmet,
        'a field that starts filled cannot be kept empty',
      ).toHaveLength(1);
      expect(update('ISCHANGED({!$Record__Prior.Crew__c})').unmet).toHaveLength(1);
    });

    it('starts from a base plan', () => {
      const base = solveCriteria(conditionFromFormula('{!$Record.Status__c} = "Open"'), ctx());
      const rule = conditionFromRule(
        [{ left: '$Record.Due__c', operator: 'IsNull', right: { apexValue: 'true', rawValue: 'true' } }],
        'and',
      );
      expect(plain(solveCriteria(negate(rule), ctx(), base))).toEqual({
        set: { Status__c: "'Open'", Due__c: 'Date.today()' },
      });
    });
  });
});

describe('boundValue', () => {
  it('steps numbers, dates, and datetimes', () => {
    expect(boundValue('1000.0', 1)).toBe('1001');
    expect(boundValue('0.1', -1)).toBe('-0.9');
    expect(boundValue("Date.valueOf('2026-01-31')", 0)).toBe("Date.valueOf('2026-01-31')");
    expect(boundValue('Datetime.now()', -1)).toBe('Datetime.now().addSeconds(-1)');
    expect(boundValue("'m'", 1)).toBeUndefined();
  });
});
