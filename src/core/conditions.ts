import type { FlowValue } from './flowValues.js';
import { type Expr, formulaToApex, parseFormula } from './formula.js';
import type { FlowFilter, FlowMetadata } from './types.js';

/** One side of a condition. */
export type Operand =
  /** A field of the triggering record (`path` like `['Status__c']` or `['Account', 'Type']`), or its prior value. */
  | { kind: 'field'; path: string[]; prior: boolean }
  /** An Apex expression for a value: a literal, `Date.today()`, and so on. */
  | { kind: 'value'; apex: string }
  /** `$User.Id`: the running user. */
  | { kind: 'user' }
  /** A variable, formula resource, or element output. */
  | { kind: 'ref'; name: string }
  /** A formula expression that is none of the above, such as arithmetic. */
  | { kind: 'expr'; expr: Expr };

export type ConditionOperator =
  | 'EqualTo'
  | 'NotEqualTo'
  | 'GreaterThan'
  | 'GreaterThanOrEqualTo'
  | 'LessThan'
  | 'LessThanOrEqualTo'
  | 'IsNull'
  | 'IsChanged'
  | 'Contains'
  | 'StartsWith'
  | 'EndsWith';

/** Where a condition came from, which decides how a TODO for it reads. */
export type ConditionLabel =
  | 'entry criteria'
  | 'entry criteria formula'
  | 'entry criteria formula term'
  | 'entry criteria logic'
  | 'decision'
  | 'validation rule'
  | 'lookup filter';

export type Atom = {
  kind: 'atom';
  left: Operand;
  op: ConditionOperator;
  /** For `IsNull` and `IsChanged`, the value `'true'` or `'false'`. */
  right?: Operand;
  text: string;
  label: ConditionLabel;
};

/** A condition the generator can't read; it stays a TODO. */
export type Opaque = { kind: 'opaque'; text: string; label: ConditionLabel };

export type Condition = Atom | Opaque | { kind: 'and' | 'or'; items: Condition[] } | { kind: 'not'; item: Condition };

export const TRUE: Condition = { kind: 'and', items: [] };

const and = (items: Condition[]): Condition => (items.length === 1 ? items[0] : { kind: 'and', items });
const or = (items: Condition[]): Condition => (items.length === 1 ? items[0] : { kind: 'or', items });

const RECORD_REF = /^\$Record(__Prior)?\.([A-Za-z][\w]*(?:\.[A-Za-z][\w]*)*)$/;

/** An operand for a Flow reference such as `$Record.Status__c`, `$Record__Prior.Status__c`, `$User.Id`, or `myVar`. */
export function operandOf(reference: string): Operand {
  if (reference === '$User.Id') return { kind: 'user' };
  const match = RECORD_REF.exec(reference);
  if (match) return { kind: 'field', path: match[2].split('.'), prior: !!match[1] };
  return { kind: 'ref', name: reference };
}

const BOOLEAN = (value: boolean): Operand => ({ kind: 'value', apex: String(value) });

/** The operand for a Flow value: a literal, or the element it references. */
function valueOperand(value: FlowValue | undefined): Operand | undefined {
  if (value?.apexValue !== undefined) return { kind: 'value', apex: value.apexValue };
  if (value?.rawValue && /^\$?[A-Za-z_][\w.]*$/.test(value.rawValue)) return operandOf(value.rawValue);
  return undefined;
}

const OPERATORS = new Set<string>([
  'EqualTo',
  'NotEqualTo',
  'GreaterThan',
  'GreaterThanOrEqualTo',
  'LessThan',
  'LessThanOrEqualTo',
  'IsNull',
  'IsChanged',
  'Contains',
  'StartsWith',
  'EndsWith',
]);

/** An atom for a Flow condition (a start filter or a decision condition), or an opaque condition. */
function flowAtom(
  left: Operand,
  operator: string,
  value: FlowValue | undefined,
  text: string,
  label: ConditionLabel,
): Condition {
  if (!OPERATORS.has(operator)) return { kind: 'opaque', text, label };
  const op = operator as ConditionOperator;
  if (op === 'IsNull' || op === 'IsChanged') {
    const raw = value?.rawValue;
    if (raw !== 'true' && raw !== 'false') return { kind: 'opaque', text, label };
    return { kind: 'atom', left, op, right: BOOLEAN(raw === 'true'), text, label };
  }
  const right = valueOperand(value);
  return right ? { kind: 'atom', left, op, right, text, label } : { kind: 'opaque', text, label };
}

/** Reads custom filter logic such as `1 AND (2 OR NOT 3)`. Undefined when it can't. */
export function parseLogic(logic: string, conditions: Condition[]): Condition | undefined {
  const tokens = logic.match(/\d+|AND|OR|NOT|\(|\)/gi);
  if (!tokens || tokens.join('').length !== logic.replace(/\s+/g, '').length) return undefined;
  let position = 0;
  const atom = (): Condition | undefined => {
    const token = tokens[position++]?.toUpperCase();
    if (token === 'NOT') {
      const item = atom();
      return item && { kind: 'not', item };
    }
    if (token === '(') {
      const inner = expression();
      return tokens[position++] === ')' ? inner : undefined;
    }
    return token !== undefined && /^\d+$/.test(token) ? conditions[Number(token) - 1] : undefined;
  };
  const expression = (): Condition | undefined => {
    const items = [atom()];
    let joiner: string | undefined;
    while (tokens[position] && /^(AND|OR)$/i.test(tokens[position])) {
      const next = tokens[position++].toUpperCase();
      // Mixing AND and OR without parentheses is ambiguous; Flow doesn't allow it.
      if (joiner && joiner !== next) return undefined;
      joiner = next;
      items.push(atom());
    }
    if (items.some((item) => !item)) return undefined;
    return joiner === 'OR' ? or(items as Condition[]) : and(items as Condition[]);
  };
  const result = expression();
  return position === tokens.length ? result : undefined;
}

/** The entry criteria of a Flow's start filters, combined with `and`, `or`, or custom logic. */
export function conditionFromFilters(filters: FlowFilter[], logic: string | undefined): Condition {
  const atoms = filters.map((filter) => {
    const value = filter.rawValue === undefined ? '' : ` ${filter.rawValue}`;
    const left: Operand = { kind: 'field', path: filter.field.split('.'), prior: false };
    return flowAtom(left, filter.operator, filter, `${filter.field} ${filter.operator}${value}`, 'entry criteria');
  });
  const lower = logic?.toLowerCase();
  if (!lower || lower === 'and') return and(atoms);
  if (lower === 'or') return or(atoms);
  return (
    parseLogic(logic as string, atoms) ??
    and([...atoms, { kind: 'opaque', text: logic as string, label: 'entry criteria logic' }])
  );
}

/** A decision rule's conditions, combined with its logic. */
export function conditionFromRule(
  conditions: Array<{ left: string; operator: string; right: FlowValue }>,
  logic: string | undefined,
): Condition {
  const atoms = conditions.map((condition) => {
    const value = condition.right.rawValue === undefined ? '' : ` ${condition.right.rawValue}`;
    return flowAtom(
      operandOf(condition.left),
      condition.operator,
      condition.right,
      `${condition.left} ${condition.operator}${value}`,
      'decision',
    );
  });
  if (atoms.length === 0) return { kind: 'opaque', text: 'no conditions', label: 'decision' };
  const lower = (logic ?? 'and').toLowerCase();
  if (lower === 'and') return and(atoms);
  if (lower === 'or') return or(atoms);
  return parseLogic(logic as string, atoms) ?? { kind: 'opaque', text: logic as string, label: 'decision' };
}

const COMPARISONS: Record<string, ConditionOperator> = {
  '=': 'EqualTo',
  '==': 'EqualTo',
  '!=': 'NotEqualTo',
  '<>': 'NotEqualTo',
  '<': 'LessThan',
  '>': 'GreaterThan',
  '<=': 'LessThanOrEqualTo',
  '>=': 'GreaterThanOrEqualTo',
};

const MIRRORED: Partial<Record<ConditionOperator, ConditionOperator>> = {
  LessThan: 'GreaterThan',
  GreaterThan: 'LessThan',
  LessThanOrEqualTo: 'GreaterThanOrEqualTo',
  GreaterThanOrEqualTo: 'LessThanOrEqualTo',
};

/** The operand a formula expression stands for. */
export function formulaOperand(expr: Expr): Operand {
  if (expr.kind === 'ref') return operandOf(expr.path);
  if (expr.kind === 'call' && expr.name === 'PRIORVALUE' && expr.args[0]?.kind === 'ref') {
    const field = operandOf(expr.args[0].path);
    if (field.kind === 'field') return { ...field, prior: true };
  }
  const apex = formulaToApex(expr);
  return apex === undefined ? { kind: 'expr', expr } : { kind: 'value', apex };
}

/** Converts a boolean formula into a condition. Parts it can't read become opaque terms. */
function formulaCondition(expr: Expr, label: ConditionLabel): Condition {
  const opaque: Condition = { kind: 'opaque', text: expr.text, label };
  const atom = (left: Operand, op: ConditionOperator, right?: Operand): Condition => ({
    kind: 'atom',
    left,
    op,
    right,
    text: expr.text,
    label,
  });
  switch (expr.kind) {
    case 'boolean':
      return expr.value ? TRUE : { kind: 'or', items: [] };
    case 'ref':
      return atom(operandOf(expr.path), 'EqualTo', BOOLEAN(true));
    case 'unary':
      return expr.op === '!' ? { kind: 'not', item: formulaCondition(expr.operand, label) } : opaque;
    case 'binary': {
      if (expr.op === '&&' || expr.op === '||') {
        const items = [formulaCondition(expr.left, label), formulaCondition(expr.right, label)];
        return expr.op === '&&' ? and(items) : or(items);
      }
      let op = COMPARISONS[expr.op];
      if (!op) return opaque;
      let [left, right] = [formulaOperand(expr.left), formulaOperand(expr.right)];
      if ((op === 'EqualTo' || op === 'NotEqualTo') && (expr.right.kind === 'null' || expr.left.kind === 'null')) {
        const side = expr.right.kind === 'null' ? left : right;
        return atom(side, 'IsNull', BOOLEAN(op === 'EqualTo'));
      }
      if (left.kind !== 'field' && right.kind === 'field') {
        [left, right] = [right, left];
        op = MIRRORED[op] ?? op;
      }
      return atom(left, op, right);
    }
    case 'call': {
      const args = expr.args;
      switch (expr.name) {
        case 'AND':
          return and(args.map((a) => formulaCondition(a, label)));
        case 'OR':
          return or(args.map((a) => formulaCondition(a, label)));
        case 'NOT':
          return args.length === 1 ? { kind: 'not', item: formulaCondition(args[0], label) } : opaque;
        case 'IF': {
          if (args.length !== 3) return opaque;
          const [test, yes, no] = args.map((a) => formulaCondition(a, label));
          return or([and([test, yes]), and([{ kind: 'not', item: test }, no])]);
        }
        case 'ISPICKVAL':
          return args.length === 2 ? atom(formulaOperand(args[0]), 'EqualTo', formulaOperand(args[1])) : opaque;
        case 'ISBLANK':
        case 'ISNULL':
          return args.length === 1 ? atom(formulaOperand(args[0]), 'IsNull', BOOLEAN(true)) : opaque;
        case 'ISCHANGED':
          return args.length === 1 ? atom(formulaOperand(args[0]), 'IsChanged', BOOLEAN(true)) : opaque;
        case 'CONTAINS':
          return args.length === 2 ? atom(formulaOperand(args[0]), 'Contains', formulaOperand(args[1])) : opaque;
        case 'BEGINS':
          return args.length === 2 ? atom(formulaOperand(args[0]), 'StartsWith', formulaOperand(args[1])) : opaque;
        default:
          return opaque;
      }
    }
    default:
      return opaque;
  }
}

/** The entry criteria of a filter formula. A formula that doesn't parse is one opaque condition. */
export function conditionFromFormula(formula: string): Condition {
  const expr = parseFormula(formula);
  if (!expr) return { kind: 'opaque', text: formula.replace(/\s+/g, ' ').trim(), label: 'entry criteria formula' };
  const condition = formulaCondition(expr, 'entry criteria formula term');
  // A whole formula the reader can't use reads as the formula, not as one of its terms.
  return condition.kind === 'opaque' ? { ...condition, label: 'entry criteria formula' } : condition;
}

/**
 * Rewrites a validation rule formula so it reads like a Flow formula: bare field names
 * (`Status__c`, `Account__r.Type`) become `$Record` fields, `ISNEW()` becomes true or false
 * for the save, and on insert `ISCHANGED` is false (there is no prior value to change from).
 */
function forSave(expr: Expr, save: 'insert' | 'update'): Expr {
  const rewrite = (e: Expr): Expr => {
    switch (e.kind) {
      case 'ref':
        return e.path.startsWith('$') ? e : { ...e, path: `$Record.${e.path}` };
      case 'unary':
        return { ...e, operand: rewrite(e.operand) };
      case 'binary':
        return { ...e, left: rewrite(e.left), right: rewrite(e.right) };
      case 'call':
        if (e.name === 'ISNEW' && e.args.length === 0)
          return { kind: 'boolean', value: save === 'insert', text: e.text };
        if (e.name === 'ISCHANGED' && save === 'insert') return { kind: 'boolean', value: false, text: e.text };
        return { ...e, args: e.args.map(rewrite) };
      default:
        return e;
    }
  };
  return rewrite(expr);
}

/**
 * A validation rule's error condition for an insert or an update: true when the rule blocks the
 * save. A formula that doesn't parse is opaque.
 */
export function conditionFromValidationRule(formula: string, save: 'insert' | 'update'): Condition {
  const expr = parseFormula(formula);
  if (!expr) return { kind: 'opaque', text: formula.replace(/\s+/g, ' ').trim(), label: 'validation rule' };
  return formulaCondition(forSave(expr, save), 'validation rule');
}

/** A Flow's whole entry criteria: its start filters (with their logic) and its filter formula. */
export function entryCondition(flow: Pick<FlowMetadata, 'filters' | 'filterLogic' | 'filterFormula'>): Condition {
  const parts: Condition[] = [];
  if (flow.filters.length > 0) parts.push(conditionFromFilters(flow.filters, flow.filterLogic));
  if (flow.filterFormula) parts.push(conditionFromFormula(flow.filterFormula));
  return parts.length === 1 ? parts[0] : { kind: 'and', items: parts };
}

/** The record field paths a condition reads, such as `['Status__c']` or `['Account__r', 'Type']`. */
export function fieldPaths(condition: Condition): string[][] {
  switch (condition.kind) {
    case 'and':
    case 'or':
      return condition.items.flatMap(fieldPaths);
    case 'not':
      return fieldPaths(condition.item);
    case 'opaque':
      return [];
    default:
      return [condition.left, condition.right].flatMap((operand) => (operand?.kind === 'field' ? [operand.path] : []));
  }
}

const NEGATED: Partial<Record<ConditionOperator, ConditionOperator>> = {
  EqualTo: 'NotEqualTo',
  NotEqualTo: 'EqualTo',
  GreaterThan: 'LessThanOrEqualTo',
  LessThanOrEqualTo: 'GreaterThan',
  LessThan: 'GreaterThanOrEqualTo',
  GreaterThanOrEqualTo: 'LessThan',
};

/** The opposite of a condition, with the negation pushed down to the atoms. */
export function negate(condition: Condition): Condition {
  switch (condition.kind) {
    case 'and':
      return or(condition.items.map(negate));
    case 'or':
      return and(condition.items.map(negate));
    case 'not':
      return condition.item;
    case 'opaque':
      return { ...condition, text: `NOT(${condition.text})` };
    default: {
      const text = `NOT(${condition.text})`;
      if (condition.op === 'IsNull' || condition.op === 'IsChanged') {
        const flipped = condition.right?.kind === 'value' && condition.right.apex === 'true' ? 'false' : 'true';
        return { ...condition, right: BOOLEAN(flipped === 'true'), text };
      }
      const op = NEGATED[condition.op];
      return op ? { ...condition, op, text } : { kind: 'opaque', text, label: condition.label };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Evaluation

/** A value the evaluator knows something about. `set` is non-empty but otherwise unknown. */
export type Known =
  | { kind: 'null' }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  /** A date relative to today, `value` days away (`Date.today().addDays(-1)` is -1). */
  | { kind: 'day'; value: number }
  | { kind: 'set' };

/** What the evaluator can look up while the Flow runs. */
export type EvaluationEnv = {
  /**
   * The Apex literal for a reference (`$Record.Status__c`, `$Record__Prior.Status__c`,
   * `myVar`), `null` for a known-empty one, or undefined when unknown.
   */
  get(reference: string): string | null | undefined;
  /** A formula resource's expression. */
  formula?(name: string): Expr | undefined;
};

/** What an Apex value is known to be. */
export function knownOf(apex: string | null): Known {
  if (apex === null || /^null\b/.test(apex)) return { kind: 'null' };
  const quoted = /^'((?:[^'\\]|\\.)*)'$/.exec(apex);
  if (quoted) return { kind: 'string', value: quoted[1].replace(/\\(.)/g, '$1') };
  if (/^-?\d+(\.\d+)?$/.test(apex)) return { kind: 'number', value: Number(apex) };
  if (apex === 'true' || apex === 'false') return { kind: 'boolean', value: apex === 'true' };
  const today = /^Date\.today\(\)((?:\.addDays\(-?\d+\))*)$/.exec(apex);
  if (today) {
    const offset = [...today[1].matchAll(/-?\d+/g)].reduce((sum, m) => sum + Number(m[0]), 0);
    return { kind: 'day', value: offset };
  }
  return { kind: 'set' };
}

const fieldKey = (path: string[], prior: boolean): string =>
  `${prior ? '$Record__Prior' : '$Record'}.${path.join('.')}`;

function compare(left: Known | undefined, op: ConditionOperator, right: Known | undefined): boolean | undefined {
  if (!left || !right) return undefined;
  if (op === 'EqualTo' || op === 'NotEqualTo') {
    let equal: boolean | undefined;
    if (left.kind === 'null' || right.kind === 'null') equal = left.kind === right.kind;
    else if (left.kind === 'set' || right.kind === 'set' || left.kind !== right.kind) equal = undefined;
    else if (left.kind === 'string' && right.kind === 'string') {
      // Text comparisons may ignore case; don't guess either way.
      equal =
        left.value === right.value ? true : left.value.toLowerCase() === right.value.toLowerCase() ? undefined : false;
    } else equal = left.value === (right as typeof left).value;
    return equal === undefined ? undefined : op === 'EqualTo' ? equal : !equal;
  }
  if (op === 'Contains' || op === 'StartsWith' || op === 'EndsWith') {
    if (left.kind !== 'string' || right.kind !== 'string') return undefined;
    if (op === 'Contains') return left.value.includes(right.value);
    return op === 'StartsWith' ? left.value.startsWith(right.value) : left.value.endsWith(right.value);
  }
  // Numbers compare with numbers, and dates relative to today with each other.
  if (left.kind !== right.kind || (left.kind !== 'number' && left.kind !== 'day')) return undefined;
  const [a, b] = [left.value, (right as typeof left).value];
  switch (op) {
    case 'GreaterThan':
      return a > b;
    case 'GreaterThanOrEqualTo':
      return a >= b;
    case 'LessThan':
      return a < b;
    case 'LessThanOrEqualTo':
      return a <= b;
    default:
      return undefined;
  }
}

const bool = (value: boolean | undefined): Known | undefined =>
  value === undefined ? undefined : { kind: 'boolean', value };

/** Three-valued `and`/`or`: decided by any decisive value, else unknown if any is unknown. */
function combine(values: Array<boolean | undefined>, decisive: boolean): boolean | undefined {
  if (values.includes(decisive)) return decisive;
  return values.includes(undefined) ? undefined : !decisive;
}

const asBoolean = (value: Known | undefined): boolean | undefined =>
  value?.kind === 'boolean' ? value.value : undefined;

/** Evaluates a formula expression. Undefined when the environment doesn't settle it. */
export function evaluateExpr(expr: Expr, env: EvaluationEnv, depth = 0): Known | undefined {
  if (depth > 10) return undefined;
  const sub = (e: Expr): Known | undefined => evaluateExpr(e, env, depth + 1);
  switch (expr.kind) {
    case 'string':
      return { kind: 'string', value: expr.value };
    case 'number':
      return { kind: 'number', value: Number(expr.value) };
    case 'boolean':
      return { kind: 'boolean', value: expr.value };
    case 'null':
      return { kind: 'null' };
    case 'ref':
      return operandValue(operandOf(expr.path), env, depth + 1);
    case 'unary': {
      const value = sub(expr.operand);
      if (expr.op === '!') return value?.kind === 'boolean' ? { kind: 'boolean', value: !value.value } : undefined;
      if (value?.kind !== 'number') return undefined;
      return { kind: 'number', value: expr.op === '-' ? -value.value : value.value };
    }
    case 'binary': {
      if (expr.op === '&&' || expr.op === '||') {
        return bool(combine([asBoolean(sub(expr.left)), asBoolean(sub(expr.right))], expr.op === '||'));
      }
      const [left, right] = [sub(expr.left), sub(expr.right)];
      const comparison = COMPARISONS[expr.op];
      if (comparison) return bool(compare(left, comparison, right));
      if (expr.op === '&') {
        const text = (k: Known | undefined): string | undefined =>
          k?.kind === 'null' ? '' : k?.kind === 'string' ? k.value : undefined;
        const [a, b] = [text(left), text(right)];
        return a === undefined || b === undefined ? undefined : { kind: 'string', value: a + b };
      }
      // A date relative to today, plus or minus days.
      if (left?.kind === 'day' && right?.kind === 'number' && (expr.op === '+' || expr.op === '-')) {
        return { kind: 'day', value: left.value + (expr.op === '+' ? right.value : -right.value) };
      }
      if (left?.kind !== 'number' || right?.kind !== 'number') return undefined;
      const [a, b] = [left.value, right.value];
      const value =
        expr.op === '+' ? a + b : expr.op === '-' ? a - b : expr.op === '*' ? a * b : expr.op === '/' ? a / b : a ** b;
      return Number.isFinite(value) ? { kind: 'number', value } : undefined;
    }
    case 'call': {
      const args = expr.args;
      switch (expr.name) {
        case 'AND':
        case 'OR':
          return bool(
            combine(
              args.map((a) => asBoolean(sub(a))),
              expr.name === 'OR',
            ),
          );
        case 'NOT': {
          const value = asBoolean(sub(args[0]));
          return bool(value === undefined ? undefined : !value);
        }
        case 'IF': {
          const test = asBoolean(sub(args[0]));
          return test === undefined ? undefined : sub(args[test ? 1 : 2]);
        }
        case 'ISBLANK':
        case 'ISNULL': {
          const value = sub(args[0]);
          if (!value) return undefined;
          return { kind: 'boolean', value: value.kind === 'null' || (value.kind === 'string' && value.value === '') };
        }
        case 'ISPICKVAL':
          return bool(compare(sub(args[0]), 'EqualTo', sub(args[1])));
        case 'BLANKVALUE': {
          const value = sub(args[0]);
          if (!value) return undefined;
          return value.kind === 'null' ? sub(args[1]) : value;
        }
        case 'TEXT': {
          const value = sub(args[0]);
          if (value?.kind === 'number') return { kind: 'string', value: String(value.value) };
          return value?.kind === 'string' || value?.kind === 'null' ? value : undefined;
        }
        case 'PRIORVALUE':
          return operandValue(formulaOperand(expr), env, depth + 1);
        case 'TODAY':
          return args.length === 0 ? { kind: 'day', value: 0 } : undefined;
        case 'NOW':
          return { kind: 'set' };
        default:
          return undefined;
      }
    }
  }
}

function operandValue(operand: Operand, env: EvaluationEnv, depth = 0): Known | undefined {
  switch (operand.kind) {
    case 'field': {
      const value = env.get(fieldKey(operand.path, operand.prior));
      return value === undefined ? undefined : knownOf(value);
    }
    case 'value':
      return knownOf(operand.apex);
    case 'user':
      return { kind: 'set' };
    case 'ref': {
      const formula = env.formula?.(operand.name);
      if (formula) return evaluateExpr(formula, env, depth + 1);
      const value = env.get(operand.name);
      return value === undefined ? undefined : knownOf(value);
    }
    default:
      return evaluateExpr(operand.expr, env, depth + 1);
  }
}

/** True or false when the environment settles the condition, else undefined. */
export function evaluateCondition(condition: Condition, env: EvaluationEnv): boolean | undefined {
  switch (condition.kind) {
    case 'and':
    case 'or':
      return combine(
        condition.items.map((item) => evaluateCondition(item, env)),
        condition.kind === 'or',
      );
    case 'not': {
      const value = evaluateCondition(condition.item, env);
      return value === undefined ? undefined : !value;
    }
    case 'opaque':
      return undefined;
    default: {
      const left = operandValue(condition.left, env);
      const wanted = condition.right?.kind === 'value' ? condition.right.apex === 'true' : undefined;
      if (condition.op === 'IsNull') {
        if (!left || wanted === undefined) return undefined;
        return (left.kind === 'null') === wanted;
      }
      if (condition.op === 'IsChanged') {
        if (condition.left.kind !== 'field' || wanted === undefined) return undefined;
        const before = operandValue({ ...condition.left, prior: true }, env);
        const changed = compare(before, 'NotEqualTo', left);
        return changed === undefined ? undefined : changed === wanted;
      }
      return compare(left, condition.op, condition.right && operandValue(condition.right, env));
    }
  }
}
