import { escapeApexString } from './flowXml.js';
import type { FlowFilter } from './types.js';

/**
 * Reads simple entry-criteria formulas as filters: a single condition, or `AND(...)` of terms
 * (nested `AND`s flatten). Each term the reader understands becomes a filter with the same
 * operators the Flow builder's filter conditions use; each term it doesn't (an `OR` inside the
 * `AND`, a cross-object field, a function call) becomes a filter with no field, so it stays a
 * TODO on its own. Returns undefined when the whole formula is another shape (`OR(...)`,
 * `IF(...)`, `a && b`), which leaves it as one TODO.
 */
export function parseFilterFormula(formula: string): FlowFilter[] | undefined {
  const terms = andTerms(formula.trim());
  if (!terms) return undefined;
  return terms.map((term) => ({ ...(parseTerm(term) ?? { field: '', operator: '' }), formulaTerm: term }));
}

const FIELD = String.raw`\{!\$Record\.([A-Za-z][A-Za-z0-9_]*)\}`;
const STRING = String.raw`"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'`;
const NUMBER = String.raw`-?\d+(?:\.\d+)?`;

const PICKLIST = new RegExp(String.raw`^ISPICKVAL\(\s*${FIELD}\s*,\s*(?:${STRING})\s*\)$`, 'i');
const BLANK = new RegExp(String.raw`^(NOT\(\s*)?(?:ISBLANK|ISNULL)\(\s*${FIELD}\s*\)(\s*\))?$`, 'i');
const CHANGED = new RegExp(String.raw`^(NOT\(\s*)?ISCHANGED\(\s*${FIELD}\s*\)(\s*\))?$`, 'i');
const CHECKBOX = new RegExp(String.raw`^(NOT\(\s*)?${FIELD}(\s*\))?$`, 'i');
const COMPARISON = new RegExp(
  String.raw`^${FIELD}\s*(==|=|!=|<>|>=|<=|>|<)\s*(?:${STRING}|(${NUMBER})|(TRUE|FALSE))$`,
  'i',
);

const OPERATORS: Record<string, string> = {
  '=': 'EqualTo',
  '==': 'EqualTo',
  '!=': 'NotEqualTo',
  '<>': 'NotEqualTo',
  '>': 'GreaterThan',
  '<': 'LessThan',
  '>=': 'GreaterThanOrEqualTo',
  '<=': 'LessThanOrEqualTo',
};

/** `NOT(` and its closing `)` must come together. */
const negated = (open: string | undefined, close: string | undefined): boolean | undefined =>
  !!open === !!close ? !!open : undefined;

const unescapeFormula = (value: string): string => value.replace(/\\(.)/g, '$1');

const stringFilter = (field: string, operator: string, value: string): FlowFilter => ({
  field,
  operator,
  apexValue: `'${escapeApexString(value)}'`,
  rawValue: value,
});

const booleanFilter = (field: string, operator: string, value: boolean): FlowFilter => ({
  field,
  operator,
  apexValue: String(value),
  rawValue: String(value),
});

function parseTerm(term: string): FlowFilter | undefined {
  let match = PICKLIST.exec(term);
  if (match) return stringFilter(match[1], 'EqualTo', unescapeFormula(match[2] ?? match[3]));

  match = BLANK.exec(term);
  if (match) {
    const not = negated(match[1], match[3]);
    return not === undefined ? undefined : booleanFilter(match[2], 'IsNull', !not);
  }

  match = CHANGED.exec(term);
  if (match) {
    const not = negated(match[1], match[3]);
    return not === undefined ? undefined : booleanFilter(match[2], 'IsChanged', !not);
  }

  match = CHECKBOX.exec(term);
  if (match) {
    const not = negated(match[1], match[3]);
    return not === undefined ? undefined : booleanFilter(match[2], 'EqualTo', !not);
  }

  match = COMPARISON.exec(term);
  if (match) {
    const [, field, symbol, double, single, number, bool] = match;
    const operator = OPERATORS[symbol];
    if (double !== undefined || single !== undefined)
      return stringFilter(field, operator, unescapeFormula(double ?? single));
    if (number !== undefined) return { field, operator, apexValue: number, rawValue: number };
    return booleanFilter(field, operator, bool.toUpperCase() === 'TRUE');
  }
  return undefined;
}

/**
 * The terms of `AND(...)`, flattening nested `AND`s. Each argument of an `AND` is a term on its
 * own, whatever it contains. A whole formula that isn't an `AND` is one term only when it's a
 * simple condition; undefined otherwise.
 */
function andTerms(expression: string, topLevel = true): string[] | undefined {
  const inner = callArguments(expression, 'AND');
  if (inner === undefined) {
    if (topLevel) return isSimpleCondition(expression) ? [expression] : undefined;
    return expression === '' ? undefined : [expression];
  }
  const terms: string[] = [];
  for (const arg of inner) {
    const nested = andTerms(arg, false);
    if (!nested) return undefined;
    terms.push(...nested);
  }
  return terms;
}

/** Not empty, not a malformed `AND`, and no `OR`/`IF`/`CASE`/`&&`/`||` at the top. */
function isSimpleCondition(expression: string): boolean {
  if (expression === '') return false;
  if (/^(AND|OR|IF|CASE)\s*\(/i.test(expression)) return false;
  return !/&&|\|\|/.test(stripLiterals(expression));
}

/** Replaces string literals with empty ones, so operators inside them don't count. */
const stripLiterals = (expression: string): string => expression.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

/**
 * The top-level comma-separated arguments of `NAME(...)` when the whole expression is that one
 * call, else undefined. Respects quotes, braces, and nested parentheses.
 */
function callArguments(expression: string, name: string): string[] | undefined {
  const open = new RegExp(`^${name}\\s*\\(`, 'i').exec(expression);
  if (!open) return undefined;
  const args: string[] = [];
  let depth = 0;
  let start = open[0].length;
  let quote: string | undefined;
  for (let i = start; i < expression.length; i++) {
    const char = expression[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '{') depth++;
    else if (char === ')' || char === '}') {
      if (depth === 0) {
        // The call must end the expression: `AND(a, b) || c` is not an AND of terms.
        if (char === '}' || expression.slice(i + 1).trim() !== '') return undefined;
        args.push(expression.slice(start, i).trim());
        return args;
      }
      depth--;
    } else if (char === ',' && depth === 0) {
      args.push(expression.slice(start, i).trim());
      start = i + 1;
    }
  }
  return undefined;
}
