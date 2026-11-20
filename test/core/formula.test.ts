import { describe, expect, it } from 'vitest';

import { type Expr, formulaToApex, parseFormula } from '../../src/core/formula.js';

/** A compact rendering of the tree, for readable expectations. */
function show(expr: Expr | undefined): string {
  if (!expr) return 'undefined';
  switch (expr.kind) {
    case 'string':
      return JSON.stringify(expr.value);
    case 'number':
      return expr.value;
    case 'boolean':
      return String(expr.value);
    case 'null':
      return 'null';
    case 'ref':
      return `{${expr.path}}`;
    case 'call':
      return `${expr.name}(${expr.args.map(show).join(', ')})`;
    case 'binary':
      return `(${show(expr.left)} ${expr.op} ${show(expr.right)})`;
    default:
      return `${expr.op}${show(expr.operand)}`;
  }
}

const apex = (formula: string): string | undefined => formulaToApex(parseFormula(formula) as Expr);

describe('parseFormula', () => {
  it('reads merge fields, functions, literals, and operator precedence', () => {
    expect(
      show(parseFormula('AND(NOT(ISBLANK({!$Record.Crew__c})), ISPICKVAL({!$Record.Status__c}, "Planned"))')),
    ).toBe('AND(NOT(ISBLANK({$Record.Crew__c})), ISPICKVAL({$Record.Status__c}, "Planned"))');
    expect(show(parseFormula('{!$Record.A} * 8 < {!$Record.B} && !flag || x = 1'))).toBe(
      '(((({$Record.A} * 8) < {$Record.B}) && !{flag}) || ({x} = 1))',
    );
    expect(show(parseFormula('a + b & c <> "d" == TRUE'))).toBe('(((({a} + {b}) & {c}) <> "d") == true)');
    expect(show(parseFormula('-2 ^ 2 + (1 - 3) / 4 >= NULL'))).toBe('(((-2 ^ 2) + ((1 - 3) / 4)) >= null)');
    expect(show(parseFormula("'it\\'s' != false"))).toBe(`("it's" != false)`);
    expect(show(parseFormula('$Record.Owner.Name'))).toBe('{$Record.Owner.Name}');
    expect(show(parseFormula('TODAY()'))).toBe('TODAY()');
  });

  it('keeps each node source text, whitespace collapsed', () => {
    const expr = parseFormula('AND(\n  {!$Record.A__c}  >  5,\n  ( {!$Record.B__c} )\n)');
    expect(expr?.text).toBe('AND( {!$Record.A__c} > 5, ( {!$Record.B__c} ) )');
    expect(expr?.kind === 'call' && expr.args.map((a) => a.text)).toEqual(['{!$Record.A__c} > 5', '{!$Record.B__c}']);
  });

  it('rejects text that is not a formula', () => {
    for (const bad of ['', 'AND(', 'a b', '{!$Record.A', '"open', 'a ~ b', '(a', 'f(a,', 'a +', ')']) {
      expect(parseFormula(bad), bad).toBeUndefined();
    }
  });
});

describe('formulaToApex', () => {
  it('turns values into Apex', () => {
    expect(apex('"O\'Neil"')).toBe("'O\\'Neil'");
    expect(apex('5')).toBe('5');
    expect(apex('-5')).toBe('-5');
    expect(apex('+5')).toBe('5');
    expect(apex('TRUE')).toBe('true');
    expect(apex('TODAY()')).toBe('Date.today()');
    expect(apex('NOW()')).toBe('Datetime.now()');
    expect(apex('DATE(2026, 1, 31)')).toBe('Date.newInstance(2026, 1, 31)');
    expect(apex('DATEVALUE("2026-01-31")')).toBe("Date.valueOf('2026-01-31')");
    expect(apex('TODAY() - 7')).toBe('Date.today().addDays(-7)');
    expect(apex('NOW() + 1')).toBe('Datetime.now().addDays(1)');
    expect(apex('2 * 3 + 1 - 4 / 2')).toBe('5');
  });

  it('leaves what it cannot express undefined', () => {
    for (const formula of [
      'NULL',
      '{!$Record.A}',
      '!TRUE',
      '-"x"',
      'DATE(2026, x, 1)',
      'DATEVALUE("soon")',
      'TODAY(1)',
      '1 / 0',
      '"a" * 2',
      'TODAY() * 2',
      'a & b',
      'NOW(1)',
    ]) {
      expect(apex(formula), formula).toBeUndefined();
    }
  });
});
