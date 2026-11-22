import { describe, expect, it } from 'vitest';

import {
  type Condition,
  conditionFromFilters,
  conditionFromFormula,
  conditionFromRule,
  conditionFromValidationRule,
  type EvaluationEnv,
  evaluateCondition,
  evaluateExpr,
  knownOf,
  negate,
  type Operand,
  operandOf,
} from '../../src/core/conditions.js';
import { type Expr, parseFormula } from '../../src/core/formula.js';

/** A compact rendering of a condition, for readable expectations. */
function show(condition: Condition): string {
  switch (condition.kind) {
    case 'and':
    case 'or':
      return `${condition.kind}(${condition.items.map(show).join(', ')})`;
    case 'not':
      return `not(${show(condition.item)})`;
    case 'opaque':
      return `?[${condition.label}] ${condition.text}`;
    default: {
      const side = (o: Operand): string => {
        switch (o.kind) {
          case 'field':
            return `${o.prior ? 'prior.' : ''}${o.path.join('.')}`;
          case 'value':
            return o.apex;
          case 'user':
            return '$User';
          case 'ref':
            return `ref:${o.name}`;
          default:
            return `expr:${o.expr.text}`;
        }
      };
      return `${side(condition.left)} ${condition.op}${condition.right ? ` ${side(condition.right)}` : ''}`;
    }
  }
}

const env = (values: Record<string, string | null>, formulas: Record<string, string> = {}): EvaluationEnv => ({
  get: (reference) => (reference in values ? values[reference] : undefined),
  formula: (name) => (name in formulas ? (parseFormula(formulas[name]) as Expr) : undefined),
});

describe('operandOf', () => {
  it('reads record fields, prior values, the running user, and other references', () => {
    expect(operandOf('$Record.Account.Type')).toEqual({ kind: 'field', path: ['Account', 'Type'], prior: false });
    expect(operandOf('$Record__Prior.Status__c')).toEqual({ kind: 'field', path: ['Status__c'], prior: true });
    expect(operandOf('$User.Id')).toEqual({ kind: 'user' });
    expect(operandOf('Get_Item')).toEqual({ kind: 'ref', name: 'Get_Item' });
  });
});

describe('conditionFromFilters', () => {
  const filters = [
    { field: 'Status__c', operator: 'EqualTo', apexValue: "'Open'", rawValue: 'Open' },
    { field: 'Owner__c', operator: 'EqualTo', rawValue: '$User.Id' },
    { field: 'Due__c', operator: 'IsNull', apexValue: 'false', rawValue: 'false' },
    { field: 'Account.Type', operator: 'EqualTo', apexValue: "'Partner'", rawValue: 'Partner' },
  ];

  it('combines filters with and, or, and custom logic', () => {
    expect(show(conditionFromFilters(filters, undefined))).toBe(
      "and(Status__c EqualTo 'Open', Owner__c EqualTo $User, Due__c IsNull false, Account.Type EqualTo 'Partner')",
    );
    expect(show(conditionFromFilters(filters.slice(0, 2), 'or'))).toBe(
      "or(Status__c EqualTo 'Open', Owner__c EqualTo $User)",
    );
    expect(show(conditionFromFilters(filters, '1 OR (2 AND NOT 3) OR 4'))).toBe(
      "or(Status__c EqualTo 'Open', and(Owner__c EqualTo $User, not(Due__c IsNull false)), Account.Type EqualTo 'Partner')",
    );
    expect(show(conditionFromFilters(filters.slice(0, 1), 'AND'))).toBe("Status__c EqualTo 'Open'");
  });

  it('keeps filters it cannot read, and logic it cannot read, as opaque', () => {
    const odd = [
      { field: 'A__c', operator: 'Matches', apexValue: "'x'", rawValue: 'x' },
      { field: 'B__c', operator: 'IsNull', rawValue: 'maybe' },
      { field: 'C__c', operator: 'EqualTo', rawValue: '2026-01-01T00:00:00Z' },
    ];
    expect(show(conditionFromFilters(odd, '1 AND 2 OR 3'))).toBe(
      'and(?[entry criteria] A__c Matches x, ?[entry criteria] B__c IsNull maybe, ?[entry criteria] C__c EqualTo 2026-01-01T00:00:00Z, ?[entry criteria logic] 1 AND 2 OR 3)',
    );
    for (const logic of ['1 AND', '(1', '1 2', '9', '1 AND x']) {
      expect(show(conditionFromFilters(filters, logic)), logic).toContain('?[entry criteria logic]');
    }
  });
});

describe('conditionFromRule', () => {
  it('reads decision conditions against record fields, variables, and references', () => {
    const rule = conditionFromRule(
      [
        { left: '$Record.Total__c', operator: 'GreaterThan', right: { apexValue: '10', rawValue: '10' } },
        { left: 'Get_Item', operator: 'IsNull', right: { apexValue: 'false', rawValue: 'false' } },
        { left: '$Record.A__c', operator: 'EqualTo', right: { rawValue: '$Record__Prior.A__c' } },
      ],
      '1 AND (2 OR 3)',
    );
    expect(show(rule)).toBe('and(Total__c GreaterThan 10, or(ref:Get_Item IsNull false, A__c EqualTo prior.A__c))');
    expect(show(conditionFromRule([], undefined))).toBe('?[decision] no conditions');
    expect(show(conditionFromRule([{ left: 'x', operator: 'EqualTo', right: {} }], 'or'))).toBe(
      '?[decision] x EqualTo',
    );
    expect(show(conditionFromRule([{ left: 'x', operator: 'EqualTo', right: { apexValue: '1' } }], '1 OR'))).toBe(
      '?[decision] 1 OR',
    );
  });
});

describe('conditionFromFormula', () => {
  const read = (formula: string): string => show(conditionFromFormula(formula));

  it('reads boolean structure and the functions entry criteria use', () => {
    expect(
      read(
        'AND(NOT(ISBLANK({!$Record.Crew__c})), ISPICKVAL({!$Record.Status__c}, "Planned"), OR({!$Record.Flag__c}, ISCHANGED({!$Record.Stage__c})))',
      ),
    ).toBe(
      "and(not(Crew__c IsNull true), Status__c EqualTo 'Planned', or(Flag__c EqualTo true, Stage__c IsChanged true))",
    );
    expect(read('{!$Record.A__c} > 5 && !{!$Record.B__c} || ISNULL({!$Record.C__c})')).toBe(
      'or(and(A__c GreaterThan 5, not(B__c EqualTo true)), C__c IsNull true)',
    );
    expect(read('IF({!$Record.A__c}, {!$Record.B__c} = 1, FALSE)')).toBe(
      'or(and(A__c EqualTo true, B__c EqualTo 1), and(not(A__c EqualTo true), or()))',
    );
    expect(read('CONTAINS({!$Record.Name}, "x") && BEGINS({!$Record.Code__c}, "INV")')).toBe(
      "and(Name Contains 'x', Code__c StartsWith 'INV')",
    );
    expect(read('TRUE')).toBe('and()');
  });

  it('reads comparisons in either order, with nulls, functions, prior values, and the user', () => {
    expect(read('5 < {!$Record.A__c}')).toBe('A__c GreaterThan 5');
    expect(read('{!$Record.A__c} = NULL')).toBe('A__c IsNull true');
    expect(read('NULL <> {!$Record.A__c}')).toBe('A__c IsNull false');
    expect(read('{!$Record.Due__c} < TODAY() + 7')).toBe('Due__c LessThan Date.today().addDays(7)');
    expect(read('PRIORVALUE({!$Record.Stage__c}) <> {!$Record.Stage__c}')).toBe('prior.Stage__c NotEqualTo Stage__c');
    expect(read('{!$Record__Prior.Stage__c} = "Open"')).toBe("prior.Stage__c EqualTo 'Open'");
    expect(read('{!$Record.OwnerId} = {!$User.Id}')).toBe('OwnerId EqualTo $User');
    expect(read('{!$Record.A__c} * 8 < {!$Record.B__c}')).toBe('B__c GreaterThan expr:{!$Record.A__c} * 8');
  });

  it('keeps parts it cannot read as opaque terms, and a formula it cannot read as one', () => {
    expect(read('AND({!$Record.A__c}, LEN({!$Record.B__c}) > 3, FOO())')).toBe(
      'and(A__c EqualTo true, expr:LEN({!$Record.B__c}) GreaterThan 3, ?[entry criteria formula term] FOO())',
    );
    expect(read('AND(1 + 2, -{!$Record.A__c}, ISPICKVAL(a), NOT(a, b), IF(a, b))')).toBe(
      'and(?[entry criteria formula term] 1 + 2, ?[entry criteria formula term] -{!$Record.A__c}, ?[entry criteria formula term] ISPICKVAL(a), ?[entry criteria formula term] NOT(a, b), ?[entry criteria formula term] IF(a, b))',
    );
    expect(read('ISBLANK(a, b)')).toBe('?[entry criteria formula] ISBLANK(a, b)');
    expect(read('AND(')).toBe('?[entry criteria formula] AND(');
    expect(read('"text"')).toBe('?[entry criteria formula] "text"');
    expect(read('ISCHANGED()')).toBe('?[entry criteria formula] ISCHANGED()');
    expect(read('CONTAINS(a)')).toBe('?[entry criteria formula] CONTAINS(a)');
    expect(read('BEGINS(a)')).toBe('?[entry criteria formula] BEGINS(a)');
  });
});

describe('negate', () => {
  it('pushes negation down to the atoms', () => {
    const condition = conditionFromFormula(
      'AND({!$Record.A__c} = 1, OR({!$Record.B__c} > 2, ISBLANK({!$Record.C__c})), NOT({!$Record.D__c} <= 3), ISCHANGED({!$Record.E__c}), CONTAINS({!$Record.F__c}, "x"), FOO())',
    );
    expect(show(negate(condition))).toBe(
      'or(A__c NotEqualTo 1, and(B__c LessThanOrEqualTo 2, C__c IsNull false), D__c LessThanOrEqualTo 3, E__c IsChanged false, ?[entry criteria formula term] NOT(CONTAINS({!$Record.F__c}, "x")), ?[entry criteria formula term] NOT(FOO()))',
    );
    expect(show(negate(negate(conditionFromFormula('{!$Record.A__c} >= 1'))))).toBe('A__c GreaterThanOrEqualTo 1');
    expect(show(negate(conditionFromFormula('{!$Record.A__c} < 1')))).toBe('A__c GreaterThanOrEqualTo 1');
    expect(show(negate(conditionFromFormula('{!$Record.A__c} <> 1')))).toBe('A__c EqualTo 1');
    expect(show(negate(conditionFromFormula('ISBLANK({!$Record.A__c}) = FALSE'))).startsWith('?')).toBe(false);
  });
});

describe('evaluateCondition', () => {
  const check = (formula: string, values: Record<string, string | null>, formulas?: Record<string, string>) =>
    evaluateCondition(conditionFromFormula(formula), env(values, formulas));

  it('settles comparisons on known values', () => {
    const values = { '$Record.N__c': '5', '$Record.S__c': "'Open'", '$Record.B__c': 'true', '$Record.E__c': null };
    expect(
      check('{!$Record.N__c} > 4 && {!$Record.N__c} <= 5 && {!$Record.N__c} >= 5 && {!$Record.N__c} < 6', values),
    ).toBe(true);
    expect(check('ISPICKVAL({!$Record.S__c}, "Open") && {!$Record.B__c}', values)).toBe(true);
    expect(
      check('{!$Record.S__c} <> "Closed" && ISBLANK({!$Record.E__c}) && NOT(ISBLANK({!$Record.N__c}))', values),
    ).toBe(true);
    expect(check('{!$Record.E__c} = "x" || {!$Record.N__c} = 6', values)).toBe(false);
    expect(check('CONTAINS({!$Record.S__c}, "pe") && BEGINS({!$Record.S__c}, "Op")', values)).toBe(true);
    expect(check('{!$Record.S__c} = "open"', values)).toBeUndefined();
    expect(check('{!$Record.S__c} = 5', values)).toBeUndefined();
    expect(check('{!$Record.Unknown__c} = 1 || {!$Record.N__c} = 5', values)).toBe(true);
    expect(check('{!$Record.Unknown__c} = 1 && {!$Record.N__c} = 5', values)).toBeUndefined();
    expect(check('{!$Record.E__c} > 1', values)).toBeUndefined();
    expect(check('CONTAINS({!$Record.N__c}, "5")', values)).toBeUndefined();
    expect(check('FOO()', values)).toBeUndefined();
    expect(check('NOT(FOO())', values)).toBeUndefined();
  });

  it('settles IsChanged from prior values, and the user and dates as set but unknown', () => {
    expect(check('ISCHANGED({!$Record.S__c})', { '$Record.S__c': "'B'", '$Record__Prior.S__c': "'A'" })).toBe(true);
    expect(check('NOT(ISCHANGED({!$Record.S__c}))', { '$Record.S__c': "'A'", '$Record__Prior.S__c': "'A'" })).toBe(
      true,
    );
    expect(check('ISCHANGED({!$Record.S__c})', { '$Record.S__c': "'A'" })).toBeUndefined();
    expect(check('ISBLANK({!$Record.D__c})', { '$Record.D__c': 'Date.today()' })).toBe(false);
    expect(check('{!$Record.OwnerId} = {!$User.Id}', { '$Record.OwnerId': 'x' })).toBeUndefined();
    expect(check('ISBLANK({!$User.Id})', {})).toBe(false);
  });

  it('evaluates formula resources', () => {
    const formulas = { crewTooSmall: 'AND({!$Record.Crew__c} * 8 < {!$Record.Panels__c}, NOT({!$Record.Sent__c}))' };
    const values = { '$Record.Crew__c': '1', '$Record.Panels__c': '10', '$Record.Sent__c': 'false' };
    expect(check('{!crewTooSmall}', values, formulas)).toBe(true);
    expect(check('{!crewTooSmall}', { ...values, '$Record.Panels__c': '2' }, formulas)).toBe(false);
    expect(check('{!crewTooSmall}', { '$Record.Crew__c': '1' }, formulas)).toBeUndefined();
    expect(check('{!plainVar} = 3', { plainVar: '3' })).toBe(true);
    expect(check('{!plainVar} = 3', {})).toBeUndefined();
  });
});

describe('dates relative to today', () => {
  it('compare with each other, but not with fixed dates', () => {
    const check = (formula: string, values: Record<string, string | null>) =>
      evaluateCondition(conditionFromFormula(formula), env(values));
    expect(check('{!$Record.D__c} < TODAY()', { '$Record.D__c': 'Date.today().addDays(-1)' })).toBe(true);
    expect(check('{!$Record.D__c} >= TODAY() + 7', { '$Record.D__c': 'Date.today().addDays(7)' })).toBe(true);
    expect(check('{!$Record.D__c} = TODAY()', { '$Record.D__c': 'Date.today()' })).toBe(true);
    expect(check('{!$Record.D__c} < TODAY()', { '$Record.D__c': "Date.valueOf('2020-01-01')" })).toBeUndefined();
  });
});

describe('conditionFromValidationRule', () => {
  const read = (formula: string, save: 'insert' | 'update') => show(conditionFromValidationRule(formula, save));

  it('reads bare field names as record fields, and settles ISNEW and ISCHANGED for the save', () => {
    const formula =
      'AND(ISCHANGED(Install_Date__c), Install_Date__c < TODAY(), NOT(ISPICKVAL(Status__c, "Completed")))';
    expect(read(formula, 'update')).toBe(
      "and(Install_Date__c IsChanged true, Install_Date__c LessThan Date.today(), not(Status__c EqualTo 'Completed'))",
    );
    expect(read(formula, 'insert')).toBe(
      "and(or(), Install_Date__c LessThan Date.today(), not(Status__c EqualTo 'Completed'))",
    );
    expect(read('AND(ISNEW(), ISBLANK(Account__r.Type), OwnerId <> $User.Id)', 'insert')).toBe(
      'and(and(), Account__r.Type IsNull true, OwnerId NotEqualTo $User)',
    );
    expect(read('AND(ISNEW(), PRIORVALUE(Stage__c) = "Open", -Amount__c > 1)', 'update')).toBe(
      "and(or(), prior.Stage__c EqualTo 'Open', expr:-Amount__c GreaterThan 1)",
    );
    expect(read('AND(', 'insert')).toBe('?[validation rule] AND(');
  });

  it('blocks the save only when the record meets it', () => {
    const rule = conditionFromValidationRule('AND(ISPICKVAL(Status__c, "Closed"), ISBLANK(Closed_Date__c))', 'insert');
    expect(evaluateCondition(rule, env({ '$Record.Status__c': "'Closed'", '$Record.Closed_Date__c': null }))).toBe(
      true,
    );
    expect(evaluateCondition(rule, env({ '$Record.Status__c': "'Open'", '$Record.Closed_Date__c': null }))).toBe(false);
  });
});

describe('evaluateExpr', () => {
  const value = (formula: string, values: Record<string, string | null> = {}) =>
    evaluateExpr(parseFormula(formula) as Expr, env(values));

  it('computes arithmetic, text, and functions', () => {
    expect(value('2 * 3 + 4 - 6 / 2 + 2 ^ 2')).toEqual({ kind: 'number', value: 11 });
    expect(value('-{!a}', { a: '2' })).toEqual({ kind: 'number', value: -2 });
    expect(value('+{!a}', { a: '2' })).toEqual({ kind: 'number', value: 2 });
    expect(value('"a" & {!b} & {!c}', { b: "'b'", c: null })).toEqual({ kind: 'string', value: 'ab' });
    expect(value('IF({!a} > 1, "big", "small")', { a: '2' })).toEqual({ kind: 'string', value: 'big' });
    expect(value('BLANKVALUE({!a}, 7)', { a: null })).toEqual({ kind: 'number', value: 7 });
    expect(value('BLANKVALUE({!a}, 7)', { a: '3' })).toEqual({ kind: 'number', value: 3 });
    expect(value('TEXT({!a})', { a: '3' })).toEqual({ kind: 'string', value: '3' });
    expect(value('TEXT({!a})', { a: "'x'" })).toEqual({ kind: 'string', value: 'x' });
    expect(value('PRIORVALUE({!$Record.S__c})', { '$Record__Prior.S__c': "'A'" })).toEqual({
      kind: 'string',
      value: 'A',
    });
    expect(value('ISBLANK("")')).toEqual({ kind: 'boolean', value: true });
    expect(value('TODAY()')).toEqual({ kind: 'day', value: 0 });
    expect(value('TODAY() - 3 + 1')).toEqual({ kind: 'day', value: -2 });
    expect(value('NOW()')).toEqual({ kind: 'set' });
    expect(value('NULL')).toEqual({ kind: 'null' });
  });

  it('is undefined for what it cannot compute', () => {
    for (const formula of [
      '{!a} + 1',
      '"a" + 1',
      '1 / 0',
      'IF({!a}, 1, 2)',
      'BLANKVALUE({!a}, 1)',
      'TEXT({!d})',
      'LEN("x")',
      '!5',
      '-"x"',
      '"x" & 1',
      'ISBLANK({!a})',
      'NOT({!a})',
      'ISPICKVAL({!a}, "x")',
    ]) {
      expect(value(formula, { d: 'true' }), formula).toBeUndefined();
    }
  });

  it('stops following formulas that refer to themselves', () => {
    const loop: EvaluationEnv = { get: () => undefined, formula: () => parseFormula('{!loop} + 1') };
    expect(evaluateExpr(parseFormula('{!loop}') as Expr, loop)).toBeUndefined();
  });
});

describe('knownOf', () => {
  it('reads Apex values', () => {
    expect(knownOf(null)).toEqual({ kind: 'null' });
    expect(knownOf('null /* TODO */')).toEqual({ kind: 'null' });
    expect(knownOf("'a\\'b'")).toEqual({ kind: 'string', value: "a'b" });
    expect(knownOf('-1.5')).toEqual({ kind: 'number', value: -1.5 });
    expect(knownOf('false')).toEqual({ kind: 'boolean', value: false });
    expect(knownOf('Date.today()')).toEqual({ kind: 'day', value: 0 });
    expect(knownOf('Date.today().addDays(-2).addDays(1)')).toEqual({ kind: 'day', value: -1 });
    expect(knownOf('Date.newInstance(2026, 1, 31)')).toEqual({ kind: 'set' });
  });
});
