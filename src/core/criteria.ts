import {
  type Atom,
  type Condition,
  type ConditionLabel,
  type ConditionOperator,
  knownOf,
  negate,
  type Operand,
} from './conditions.js';
import { escapeApexString } from './flowValues.js';
import { isApexDate, isApexDatetime } from './formula.js';

/** What the solver knows about the record a test builds. */
export type SolveContext = {
  /** The triggering object. */
  object: string;
  /** `insert` for create, delete, and platform event tests; `update` when the test updates an inserted record. */
  context: 'insert' | 'update';
  /** Values the insert sets anyway (required fields). */
  inserted: Record<string, string>;
  /** A value per field the test can set, including lookup Ids (`accountParent.Id`). */
  fieldValues: Record<string, string>;
  /** A second value per field, different from `fieldValues`. */
  changedValues: Record<string, string>;
  /** Lookup field per relationship name, such as `Account` to `AccountId`. */
  relationships: Record<string, string>;
  /** The object each lookup field points to. */
  lookups: Record<string, string>;
  /** Values for a parent object's fields, for criteria on related records. */
  parentFieldValues(object: string): Record<string, string>;
  /**
   * Whether a test can set a field of `object` on insert, or change it in an update. Formula
   * fields can't be set at all; master-detail fields usually can't change after the insert.
   * Without it, every field counts as writable.
   */
  writable?(object: string, field: string, when: 'insert' | 'update'): boolean;
};

const canWrite = (ctx: SolveContext, object: string, field: string, when: 'insert' | 'update'): boolean =>
  ctx.writable?.(object, field, when) ?? true;

/** Field values that meet a condition, and what they couldn't meet. */
export type CriteriaPlan = {
  /** Record fields to set: in the insert, or in the update. */
  set: Map<string, string>;
  /** In an update, values the insert sets so `$Record__Prior` conditions hold. */
  prior: Map<string, string>;
  /** Record fields that must stay empty or unchanged. */
  keep: Set<string>;
  /** Fields to set on parent records, per parent object. */
  parents: Map<string, Map<string, string>>;
  /** Conditions the plan doesn't meet, for TODOs. */
  unmet: Array<{ label: ConditionLabel; text: string }>;
};

const emptyPlan = (): CriteriaPlan => ({
  set: new Map(),
  prior: new Map(),
  keep: new Set(),
  parents: new Map(),
  unmet: [],
});

const clonePlan = (plan: CriteriaPlan): CriteriaPlan => ({
  set: new Map(plan.set),
  prior: new Map(plan.prior),
  keep: new Set(plan.keep),
  parents: new Map([...plan.parents].map(([object, fields]) => [object, new Map(fields)])),
  unmet: [...plan.unmet],
});

const STEPS: Partial<Record<ConditionOperator, number>> = {
  GreaterThan: 1,
  GreaterThanOrEqualTo: 0,
  LessThan: -1,
  LessThanOrEqualTo: 0,
};

/** A value past (or at) a comparison bound: numbers step by 1, dates by a day, datetimes by a second. */
export function boundValue(apex: string, step: number): string | undefined {
  if (/^-?\d+(\.\d+)?$/.test(apex)) return String(Number((Number(apex) + step).toFixed(10)));
  if (!isApexDate(apex) && !isApexDatetime(apex)) return undefined;
  if (step === 0) return apex;
  return isApexDate(apex) ? `${apex}.addDays(${step})` : `${apex}.addSeconds(${step})`;
}

const isNullish = (apex: string | undefined): boolean => apex === undefined || /^null\b/.test(apex);

/** A candidate whose value is known to differ from `right`. */
function differentValue(right: string, candidates: Array<string | undefined>): string | undefined {
  const target = knownOf(right);
  if (target.kind === 'set') return undefined;
  return candidates.find((candidate) => {
    if (candidate === undefined) return false;
    const known = knownOf(candidate);
    if (target.kind === 'null') return known.kind !== 'null';
    // An empty candidate (a lookup TODO) or one whose value isn't known can't be shown to differ.
    if (known.kind === 'null' || known.kind === 'set' || known.kind !== target.kind) return false;
    // Text that differs only in case might compare equal.
    return known.kind === 'string' && target.kind === 'string'
      ? known.value.toLowerCase() !== target.value.toLowerCase()
      : known.value !== (target as typeof known).value;
  });
}

type Side = {
  /** The value already planned for the field, if any. */
  current(): string | undefined;
  /** Plans a value; false on a conflict. */
  assign(value: string): boolean;
  /** Plans that the field stays empty; false when something sets it. */
  keepEmpty(): boolean;
  values: Record<string, string>;
  alternates: Record<string, string>;
  field: string;
};

/** Meets one comparison on one side (a record field, its prior value, or a parent field). */
function meet(side: Side, op: ConditionOperator, right: string | undefined, wanted?: boolean): boolean {
  const current = side.current();
  switch (op) {
    case 'IsNull':
      if (wanted) return side.keepEmpty();
      if (current !== undefined && !isNullish(current)) return true;
      return side.values[side.field] !== undefined && side.assign(side.values[side.field]);
    case 'EqualTo':
      return right !== undefined && side.assign(right);
    case 'NotEqualTo': {
      if (right === undefined) return false;
      if (current !== undefined) return differentValue(right, [current]) !== undefined;
      const value = differentValue(right, [side.values[side.field], side.alternates[side.field]]);
      return value !== undefined && side.assign(value);
    }
    case 'Contains':
    case 'StartsWith':
    case 'EndsWith':
      // A string contains, starts with, and ends with itself.
      return right?.startsWith("'") === true && side.assign(right);
    default: {
      const step = STEPS[op];
      const value = right === undefined || step === undefined ? undefined : boundValue(right, step);
      return value !== undefined && side.assign(value);
    }
  }
}

/** The Apex value of the right-hand side, planning a value for a field it compares with. */
function rightValue(right: Operand | undefined, plan: CriteriaPlan, ctx: SolveContext): string | undefined {
  if (!right) return undefined;
  if (right.kind === 'value') return right.apex;
  if (right.kind === 'user') return 'UserInfo.getUserId()';
  if (right.kind !== 'field' || right.prior || right.path.length !== 1) return undefined;
  const field = right.path[0];
  const planned = plan.set.get(field) ?? (ctx.context === 'insert' ? ctx.inserted[field] : undefined);
  if (planned !== undefined && !isNullish(planned)) return planned;
  const value = ctx.fieldValues[field];
  if (value === undefined || plan.keep.has(field)) return undefined;
  if (!recordSide(field, plan, ctx).assign(value)) return undefined;
  return value;
}

function recordSide(field: string, plan: CriteriaPlan, ctx: SolveContext): Side {
  return {
    field,
    values: ctx.fieldValues,
    alternates: ctx.changedValues,
    current: () => plan.set.get(field) ?? (ctx.context === 'insert' ? ctx.inserted[field] : undefined),
    assign: (value) => {
      const existing = plan.set.get(field);
      if (existing !== undefined) return existing === value;
      if (plan.keep.has(field)) return false;
      if (!canWrite(ctx, ctx.object, field, 'insert')) return false;
      if (ctx.context === 'update' && !canWrite(ctx, ctx.object, field, 'update')) {
        // The insert sets it, and it keeps that value through the update.
        return priorSide(field, plan, ctx).assign(value);
      }
      plan.set.set(field, value);
      return true;
    },
    keepEmpty: () => {
      if (plan.set.has(field)) return false;
      // The insert sets required fields; in an update the field must also start empty.
      if (!isNullish(ctx.inserted[field]) || !isNullish(plan.prior.get(field))) return false;
      plan.keep.add(field);
      return true;
    },
  };
}

function priorSide(field: string, plan: CriteriaPlan, ctx: SolveContext): Side {
  return {
    field,
    values: ctx.fieldValues,
    alternates: ctx.changedValues,
    current: () => plan.prior.get(field) ?? ctx.inserted[field],
    assign: (value) => {
      const existing = plan.prior.get(field) ?? ctx.inserted[field];
      if (existing !== undefined && !isNullish(existing)) return existing === value;
      if (!canWrite(ctx, ctx.object, field, 'insert')) return false;
      plan.prior.set(field, value);
      return true;
    },
    keepEmpty: () => isNullish(plan.prior.get(field) ?? ctx.inserted[field]),
  };
}

function parentSide(object: string, field: string, plan: CriteriaPlan, ctx: SolveContext): Side {
  const fields = (): Map<string, string> => {
    if (!plan.parents.has(object)) plan.parents.set(object, new Map());
    return plan.parents.get(object) as Map<string, string>;
  };
  const values = ctx.parentFieldValues(object);
  return {
    field,
    values,
    alternates: {},
    current: () => plan.parents.get(object)?.get(field),
    assign: (value) => {
      const existing = fields().get(field);
      if (existing !== undefined) return existing === value;
      if (!canWrite(ctx, object, field, 'insert')) return false;
      fields().set(field, value);
      return true;
    },
    // The parent's own required fields may set it; don't promise it stays empty.
    keepEmpty: () => false,
  };
}

/** Meets an atom, or returns false. */
function meetAtom(atom: Atom, plan: CriteriaPlan, ctx: SolveContext): boolean {
  const { left, op } = atom;
  if (left.kind !== 'field') return false;
  const wanted = atom.right?.kind === 'value' ? atom.right.apex === 'true' : undefined;

  if (left.prior) {
    if (ctx.context !== 'update' || left.path.length !== 1 || op === 'IsChanged') return false;
    return meet(priorSide(left.path[0], plan, ctx), op, rightValue(atom.right, plan, ctx), wanted);
  }

  if (left.path.length === 2) {
    const [relationship, field] = left.path;
    if (relationship === 'RecordType' && field === 'DeveloperName' && op === 'EqualTo') {
      const name = atom.right?.kind === 'value' ? knownOf(atom.right.apex) : undefined;
      if (name?.kind !== 'string') return false;
      const id = `Schema.SObjectType.${ctx.object}.getRecordTypeInfosByDeveloperName().get('${escapeApexString(name.value)}').getRecordTypeId()`;
      return recordSide('RecordTypeId', plan, ctx).assign(id);
    }
    const lookup = ctx.relationships[relationship];
    const parent = lookup ? ctx.lookups[lookup] : undefined;
    const id = lookup ? ctx.fieldValues[lookup] : undefined;
    if (!lookup || !parent || !id || !/Parent\.Id$/.test(id)) return false;
    if (!recordSide(lookup, plan, ctx).assign(id)) return false;
    return meet(parentSide(parent, field, plan, ctx), op, rightValue(atom.right, plan, ctx), wanted);
  }
  if (left.path.length !== 1) return false;

  const field = left.path[0];
  const side = recordSide(field, plan, ctx);
  if (op === 'IsChanged') {
    if (ctx.context !== 'update' || wanted === undefined) return false;
    if (!wanted) {
      if (plan.set.has(field)) return false;
      plan.keep.add(field);
      return true;
    }
    if (!canWrite(ctx, ctx.object, field, 'update')) return false;
    const before = plan.prior.get(field) ?? ctx.inserted[field];
    const planned = plan.set.get(field);
    if (planned !== undefined) return planned !== before;
    const value = ctx.changedValues[field];
    return value !== undefined && value !== before && side.assign(value);
  }
  return meet(side, op, rightValue(atom.right, plan, ctx), wanted);
}

/** `IsChanged` atoms go last, so a field another condition sets counts as changed. */
const changeLast = (items: Condition[]): Condition[] => [
  ...items.filter((c) => !(c.kind === 'atom' && c.op === 'IsChanged')),
  ...items.filter((c) => c.kind === 'atom' && c.op === 'IsChanged'),
];

function solveInto(condition: Condition, plan: CriteriaPlan, ctx: SolveContext): CriteriaPlan {
  switch (condition.kind) {
    case 'and':
      return changeLast(condition.items).reduce((current, item) => solveInto(item, current, ctx), plan);
    case 'or': {
      if (condition.items.length === 0)
        return { ...plan, unmet: [...plan.unmet, { label: 'entry criteria formula', text: 'FALSE' }] };
      // Meet the first branch that can be met in full; otherwise the one with the fewest TODOs.
      let best: CriteriaPlan | undefined;
      for (const item of condition.items) {
        const attempt = solveInto(item, clonePlan(plan), ctx);
        if (attempt.unmet.length === plan.unmet.length) return attempt;
        if (!best || attempt.unmet.length < best.unmet.length) best = attempt;
      }
      return best as CriteriaPlan;
    }
    case 'not':
      return solveInto(negate(condition.item), plan, ctx);
    case 'opaque':
      return { ...plan, unmet: [...plan.unmet, { label: condition.label, text: condition.text }] };
    default: {
      const attempt = clonePlan(plan);
      if (meetAtom(condition, attempt, ctx)) return attempt;
      return { ...plan, unmet: [...plan.unmet, { label: condition.label, text: condition.text }] };
    }
  }
}

/** Plans field values that meet `condition`, starting from `base` when given. */
export function solveCriteria(condition: Condition, ctx: SolveContext, base: CriteriaPlan = emptyPlan()): CriteriaPlan {
  return solveInto(condition, clonePlan(base), ctx);
}
