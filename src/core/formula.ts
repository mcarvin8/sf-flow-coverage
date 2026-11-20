import { escapeApexString } from './flowValues.js';

/**
 * A parsed Salesforce formula. Every node keeps its source text, so a part the generator can't
 * use can still be quoted in a TODO.
 */
export type Expr = { text: string } & (
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  /** A merge field (`{!$Record.Status__c}`) or a bare reference (`$Record.Status__c`, `myVariable`). */
  | { kind: 'ref'; path: string }
  /** A function call; `name` is upper case. */
  | { kind: 'call'; name: string; args: Expr[] }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }
  | { kind: 'unary'; op: string; operand: Expr }
);

type Token = { kind: 'string' | 'number' | 'ref' | 'ident' | 'op'; value: string; start: number; end: number };

const OPERATORS = [
  '&&',
  '||',
  '==',
  '!=',
  '<>',
  '<=',
  '>=',
  '=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '^',
  '&',
  '(',
  ')',
  ',',
  '!',
];

function tokenize(source: string): Token[] | undefined {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    const start = i;
    if (source.startsWith('{!', i)) {
      const end = source.indexOf('}', i);
      if (end === -1) return undefined;
      tokens.push({ kind: 'ref', value: source.slice(i + 2, end).trim(), start, end: end + 1 });
      i = end + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      let value = '';
      i++;
      while (i < source.length && source[i] !== char) {
        if (source[i] === '\\' && i + 1 < source.length) i++;
        value += source[i];
        i++;
      }
      if (i >= source.length) return undefined;
      i++;
      tokens.push({ kind: 'string', value, start, end: i });
      continue;
    }
    const number = /^\d+(\.\d+)?/.exec(source.slice(i));
    if (number) {
      i += number[0].length;
      tokens.push({ kind: 'number', value: number[0], start, end: i });
      continue;
    }
    const ident = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*/.exec(source.slice(i));
    if (ident) {
      i += ident[0].length;
      tokens.push({ kind: 'ident', value: ident[0], start, end: i });
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (!op) return undefined;
    i += op.length;
    tokens.push({ kind: 'op', value: op, start, end: i });
  }
  return tokens;
}

/** Binary operators from loosest to tightest. */
const LEVELS = [['||'], ['&&'], ['=', '==', '!=', '<>'], ['<', '>', '<=', '>='], ['+', '-', '&'], ['*', '/'], ['^']];

/** Parses a formula. Undefined when it isn't valid formula syntax. */
export function parseFormula(source: string): Expr | undefined {
  const tokens = tokenize(source);
  if (!tokens || tokens.length === 0) return undefined;
  let position = 0;
  const peek = (): Token | undefined => tokens[position];
  const isOp = (value: string): boolean => peek()?.kind === 'op' && peek()?.value === value;
  const fail = (): never => {
    throw new SyntaxError('formula');
  };
  /** Source text from token `first` to the last token read, whitespace collapsed. */
  const textFrom = (first: number): string =>
    source
      .slice(tokens[first].start, tokens[position - 1].end)
      .replace(/\s+/g, ' ')
      .trim();
  const expect = (value: string): void => {
    if (!isOp(value)) fail();
    position++;
  };

  const primary = (): Expr => {
    const first = position;
    const token = peek() ?? fail();
    position++;
    switch (token.kind) {
      case 'string':
        return { kind: 'string', value: token.value, text: textFrom(first) };
      case 'number':
        return { kind: 'number', value: token.value, text: textFrom(first) };
      case 'ref':
        return { kind: 'ref', path: token.value, text: textFrom(first) };
      case 'ident': {
        if (isOp('(')) {
          position++;
          const args: Expr[] = [];
          if (!isOp(')')) {
            args.push(expression(0));
            while (isOp(',')) {
              position++;
              args.push(expression(0));
            }
          }
          expect(')');
          return { kind: 'call', name: token.value.toUpperCase(), args, text: textFrom(first) };
        }
        const upper = token.value.toUpperCase();
        if (upper === 'TRUE' || upper === 'FALSE')
          return { kind: 'boolean', value: upper === 'TRUE', text: textFrom(first) };
        if (upper === 'NULL') return { kind: 'null', text: textFrom(first) };
        return { kind: 'ref', path: token.value, text: textFrom(first) };
      }
      default:
        if (token.value === '(') {
          const inner = expression(0);
          expect(')');
          return inner;
        }
        if (token.value === '-' || token.value === '+' || token.value === '!') {
          const operand = primary();
          return { kind: 'unary', op: token.value, operand, text: textFrom(first) };
        }
        return fail();
    }
  };
  const expression = (level: number): Expr => {
    if (level >= LEVELS.length) return primary();
    const first = position;
    let left = expression(level + 1);
    while (peek()?.kind === 'op' && LEVELS[level].includes(peek()?.value as string)) {
      const op = (tokens[position++] as Token).value;
      const right = expression(level + 1);
      left = { kind: 'binary', op, left, right, text: textFrom(first) };
    }
    return left;
  };

  try {
    const expr = expression(0);
    return position === tokens.length ? expr : undefined;
  } catch {
    return undefined;
  }
}

/** An Apex date or datetime expression, for stepping comparisons by days. */
export const isApexDate = (apex: string): boolean => apex.startsWith('Date.');
export const isApexDatetime = (apex: string): boolean => apex.startsWith('Datetime.');

/**
 * The Apex expression for a formula value: literals, `TODAY()`, `NOW()`, `DATE(y, m, d)`,
 * `DATEVALUE("...")`, a date plus or minus days, and constant arithmetic. Undefined otherwise.
 */
export function formulaToApex(expr: Expr): string | undefined {
  switch (expr.kind) {
    case 'string':
      return `'${escapeApexString(expr.value)}'`;
    case 'number':
      return expr.value;
    case 'boolean':
      return String(expr.value);
    case 'unary': {
      const operand = formulaToApex(expr.operand);
      if (operand === undefined || expr.op === '!') return undefined;
      if (expr.op === '+') return operand;
      return /^-?\d+(\.\d+)?$/.test(operand) ? String(-Number(operand)) : undefined;
    }
    case 'call': {
      const args = expr.args.map(formulaToApex);
      if (expr.name === 'TODAY' && args.length === 0) return 'Date.today()';
      if (expr.name === 'NOW' && args.length === 0) return 'Datetime.now()';
      if (expr.name === 'DATE' && args.length === 3 && args.every((a) => a !== undefined && /^\d+$/.test(a))) {
        return `Date.newInstance(${args.join(', ')})`;
      }
      if (
        expr.name === 'DATEVALUE' &&
        expr.args[0]?.kind === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(expr.args[0].value)
      ) {
        return `Date.valueOf('${expr.args[0].value}')`;
      }
      return undefined;
    }
    case 'binary': {
      if (expr.op !== '+' && expr.op !== '-' && expr.op !== '*' && expr.op !== '/') return undefined;
      const left = formulaToApex(expr.left);
      const right = formulaToApex(expr.right);
      if (left === undefined || right === undefined) return undefined;
      const numeric = /^-?\d+(\.\d+)?$/;
      if (numeric.test(left) && numeric.test(right)) {
        const [a, b] = [Number(left), Number(right)];
        const value =
          expr.op === '+' ? a + b : expr.op === '-' ? a - b : expr.op === '*' ? a * b : b === 0 ? NaN : a / b;
        return Number.isFinite(value) ? String(Number(value.toFixed(10))) : undefined;
      }
      // A date (or datetime) plus or minus a number of days.
      if ((isApexDate(left) || isApexDatetime(left)) && numeric.test(right) && (expr.op === '+' || expr.op === '-')) {
        return `${left}.addDays(${expr.op === '-' ? -Number(right) : Number(right)})`;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
