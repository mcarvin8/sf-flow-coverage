import { describe, expect, it } from 'vitest';

import { parseFilterFormula } from '../../src/core/filterFormula.js';

/** Each filter as `field operator apexValue`, or the formula term when it couldn't be read. */
const read = (formula: string): string[] | undefined =>
  parseFilterFormula(formula)?.map((f) => (f.field ? `${f.field} ${f.operator} ${f.apexValue}` : `? ${f.formulaTerm}`));

describe('parseFilterFormula', () => {
  it('reads the AND of terms from a real Flow', () => {
    const formula = `AND(
  NOT(ISBLANK({!$Record.Crew_Size__c})),
  NOT(ISBLANK({!$Record.Install_Date__c})),
  ISPICKVAL({!$Record.Status__c}, "Planned")
)`;
    expect(parseFilterFormula(formula)).toEqual([
      {
        field: 'Crew_Size__c',
        operator: 'IsNull',
        apexValue: 'false',
        rawValue: 'false',
        formulaTerm: 'NOT(ISBLANK({!$Record.Crew_Size__c}))',
      },
      {
        field: 'Install_Date__c',
        operator: 'IsNull',
        apexValue: 'false',
        rawValue: 'false',
        formulaTerm: 'NOT(ISBLANK({!$Record.Install_Date__c}))',
      },
      {
        field: 'Status__c',
        operator: 'EqualTo',
        apexValue: "'Planned'",
        rawValue: 'Planned',
        formulaTerm: 'ISPICKVAL({!$Record.Status__c}, "Planned")',
      },
    ]);
  });

  it('reads each kind of term', () => {
    expect(
      read(`and(
        ISBLANK({!$Record.A__c}), isnull({!$Record.B__c}), NOT(ISNULL({!$Record.C__c})),
        ISCHANGED({!$Record.D__c}), NOT( ISCHANGED({!$Record.E__c}) ),
        {!$Record.F__c}, NOT({!$Record.G__c}),
        ISPICKVAL({!$Record.H__c}, 'It\\'s'),
        {!$Record.I__c} = "Say \\"hi\\"", {!$Record.J__c} == 'x', {!$Record.K__c} != "y", {!$Record.L__c} <> 'z',
        {!$Record.M__c} > 10, {!$Record.N__c} < -2.5, {!$Record.O__c} >= 0, {!$Record.P__c} <= 3,
        {!$Record.Q__c} = TRUE, {!$Record.R__c} = false
      )`),
    ).toEqual([
      'A__c IsNull true',
      'B__c IsNull true',
      'C__c IsNull false',
      'D__c IsChanged true',
      'E__c IsChanged false',
      'F__c EqualTo true',
      'G__c EqualTo false',
      "H__c EqualTo 'It\\'s'",
      'I__c EqualTo \'Say "hi"\'',
      "J__c EqualTo 'x'",
      "K__c NotEqualTo 'y'",
      "L__c NotEqualTo 'z'",
      'M__c GreaterThan 10',
      'N__c LessThan -2.5',
      'O__c GreaterThanOrEqualTo 0',
      'P__c LessThanOrEqualTo 3',
      'Q__c EqualTo true',
      'R__c EqualTo false',
    ]);
  });

  it('flattens nested ANDs and reads a single term', () => {
    expect(read('AND({!$Record.A__c}, AND({!$Record.B__c} = 1, {!$Record.C__c}))')).toEqual([
      'A__c EqualTo true',
      'B__c EqualTo 1',
      'C__c EqualTo true',
    ]);
    expect(read('  ISPICKVAL({!$Record.Stage__c}, "Won")  ')).toEqual(["Stage__c EqualTo 'Won'"]);
  });

  it('keeps terms it cannot read, so they stay TODOs', () => {
    expect(
      read(`AND(
        {!$Record.Account.Name} = "Acme",
        {!$Record__Prior.Status__c} = "Open",
        {!$Record.Amount__c} > {!$Record.Limit__c},
        NOT(OR({!$Record.B__c}, {!$Record.C__c})),
        OR({!$Record.D__c}, {!$Record.E__c}) && {!$Record.F__c},
        IF({!$Record.G__c}, true, false),
        TODAY() > {!$Record.Due__c},
        ISPICKVAL({!$Record.Stage__c}, "Won")
      )`),
    ).toEqual([
      '? {!$Record.Account.Name} = "Acme"',
      '? {!$Record__Prior.Status__c} = "Open"',
      '? {!$Record.Amount__c} > {!$Record.Limit__c}',
      '? NOT(OR({!$Record.B__c}, {!$Record.C__c}))',
      '? OR({!$Record.D__c}, {!$Record.E__c}) && {!$Record.F__c}',
      '? IF({!$Record.G__c}, true, false)',
      '? TODAY() > {!$Record.Due__c}',
      "Stage__c EqualTo 'Won'",
    ]);
  });

  it('does not read a NOT without its closing parenthesis, or the reverse', () => {
    for (const term of [
      'NOT(ISBLANK({!$Record.A__c})',
      'ISBLANK({!$Record.A__c}))',
      'NOT(ISCHANGED({!$Record.B__c})',
      'ISCHANGED({!$Record.B__c}))',
      'NOT({!$Record.C__c}',
      '{!$Record.C__c})',
    ]) {
      expect(read(term), term).toEqual([`? ${term}`]);
    }
  });

  it('leaves formulas that are not an AND of terms alone', () => {
    for (const formula of [
      'OR({!$Record.A__c}, {!$Record.B__c})',
      'IF({!$Record.A__c}, true, false)',
      'CASE({!$Record.A__c}, 1, true, false)',
      '{!$Record.A__c} && {!$Record.B__c}',
      '{!$Record.A__c} || {!$Record.B__c}',
      'AND({!$Record.A__c}, {!$Record.B__c}) || {!$Record.C__c}',
      'AND({!$Record.A__c}',
      'AND()',
      'AND({!$Record.A__c}, )',
      'AND(}',
      '',
    ]) {
      expect(read(formula), formula).toBeUndefined();
    }
    expect(read('{!$Record.A__c} = "a && b"')).toEqual(["A__c EqualTo 'a && b'"]);
  });
});
