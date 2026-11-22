import {
  type Atom,
  applyFieldFunction,
  type Condition,
  type ConditionLabel,
  type ConditionOperator,
  compare,
  type FieldFunction,
  type Known,
  knownOf,
  negate,
  type Operand,
} from './conditions.js';
import { escapeApexString } from './flowValues.js';
import { isApexDate, isApexDatetime } from './formula.js';
import { MAX_PARENT_DEPTH } from './requiredFields.js';

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
   * A parent object's relationships and lookups, for criteria on records more than one
   * relationship away (`Contact__r.Account.Type`). Without it, criteria reach only the parents.
   */
  parentLinks?(object: string): { relationships: Record<string, string>; lookups: Record<string, string> };
  /** The Apex value of a Flow resource a condition compares with: a constant, or a formula. */
  resource?(name: string): string | undefined;
  /** Values for a custom setting's fields, for a `$Setup` value the test inserts. */
  settingFieldValues?(setting: string): Record<string, string>;
  /**
   * Whether a test can set a field of `object` on insert, or change it in an update. Formula
   * fields can't be set at all; master-detail fields usually can't change after the insert.
   * Without it, every field counts as writable.
   */
  writable?(object: string, field: string, when: 'insert' | 'update'): boolean;
  /**
   * The value to set for a field: a picklist value spelled as the picklist spells it (criteria
   * compare text ignoring case), or `null` when the field can't hold the value (a restricted
   * picklist without it). Without it, values are set as they are.
   */
  normalize?(object: string, field: string, apex: string): string | null;
};

const normalized = (ctx: SolveContext, object: string, field: string, apex: string): string | null =>
  ctx.normalize ? ctx.normalize(object, field, apex) : apex;

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
  /** Fields to set on each custom setting's org-wide default, which the test inserts first. */
  settings: Map<string, Map<string, string>>;
  /** Conditions the plan doesn't meet, for TODOs. */
  unmet: Array<{ label: ConditionLabel; text: string }>;
};

export const emptyPlan = (): CriteriaPlan => ({
  set: new Map(),
  prior: new Map(),
  keep: new Set(),
  parents: new Map(),
  settings: new Map(),
  unmet: [],
});

const cloneFields = (map: Map<string, Map<string, string>>): Map<string, Map<string, string>> =>
  new Map([...map].map(([object, fields]) => [object, new Map(fields)]));

const clonePlan = (plan: CriteriaPlan): CriteriaPlan => ({
  set: new Map(plan.set),
  prior: new Map(plan.prior),
  keep: new Set(plan.keep),
  parents: cloneFields(plan.parents),
  settings: cloneFields(plan.settings),
  unmet: [...plan.unmet],
});

/** `$Setup.Settings__c.Field__c`, split into the custom setting and its field. */
const SETUP_REF = /^\$Setup\.([A-Za-z]\w*)\.([A-Za-z]\w*)$/;

/**
 * Apex for a global value a test reads but can't set: a custom label, or a field of the running
 * user, their profile, or the org. Undefined for anything else.
 */
export function globalValue(reference: string): string | undefined {
  const [scope, ...rest] = reference.split('.');
  const name = rest.join('.');
  if (rest.length !== 1 || !/^[A-Za-z]\w*$/.test(name)) return undefined;
  switch (scope) {
    case '$Label': {
      // A packaged label, `ns__Name` in a formula, is `System.Label.ns.Name` in Apex.
      const packaged = /^([A-Za-z][A-Za-z0-9]*)__(\w+)$/.exec(name);
      return packaged ? `System.Label.${packaged[1]}.${packaged[2]}` : `System.Label.${name}`;
    }
    case '$User':
      return name === 'Id'
        ? 'UserInfo.getUserId()'
        : `[SELECT ${name} FROM User WHERE Id = :UserInfo.getUserId()].${name}`;
    case '$Profile':
      return `[SELECT ${name} FROM Profile WHERE Id = :UserInfo.getProfileId()].${name}`;
    case '$Organization':
      return `[SELECT ${name} FROM Organization].${name}`;
    default:
      return undefined;
  }
}

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

/** The longest text value a test sets to meet a `LEN` comparison. */
const MAX_LENGTH = 255;

/** A first guess at a field value whose function result meets the comparison. */
function functionGuess(fn: FieldFunction, op: ConditionOperator, target: Known): string | undefined {
  if (fn === 'LEN' || fn === 'VALUE') {
    if (target.kind !== 'number') return undefined;
    const n = target.value;
    const steps: Partial<Record<ConditionOperator, number>> = { ...STEPS, EqualTo: 0, NotEqualTo: 1 };
    const step = steps[op];
    if (step === undefined) return undefined;
    if (fn === 'VALUE') return `'${String(Number((n + step).toFixed(10)))}'`;
    const length = n + step;
    return Number.isInteger(length) && length >= 1 && length <= MAX_LENGTH ? `'${'x'.repeat(length)}'` : undefined;
  }
  if (target.kind !== 'string' || !['EqualTo', 'Contains', 'StartsWith', 'EndsWith'].includes(op)) return undefined;
  // TEXT() of a number field compared with digits: setting text there wouldn't compile.
  if (fn === 'TEXT' && /^\s*-?\d/.test(target.value)) return undefined;
  return `'${escapeApexString(target.value)}'`;
}

/**
 * Meets a comparison of a function of the field (`LEN(Name) > 3`, `TEXT(Stage__c) = 'Won'`):
 * keeps a planned value that already meets it, or sets one that does.
 */
function meetThrough(side: Side, fn: FieldFunction, op: ConditionOperator, right: string | undefined): boolean {
  if (right === undefined || op === 'IsChanged') return false;
  const target = knownOf(right);
  const holds = (apex: string): boolean => compare(applyFieldFunction(fn, knownOf(apex)), op, target) === true;
  const current = side.current();
  if (current !== undefined && !isNullish(current) && holds(current)) return true;
  if (holds('null') && side.keepEmpty()) return true;
  // A value the plan already set can't change; one the insert sets anyway (a required field's) can.
  const value = [functionGuess(fn, op, target), side.values[side.field], side.alternates[side.field]].find(
    (candidate) => candidate !== undefined && holds(candidate),
  );
  return value !== undefined && side.assign(value);
}

/** Functions that leave a blank value blank, so `ISBLANK(TEXT(f))` is `ISBLANK(f)`. */
const BLANK_PRESERVING = new Set<FieldFunction>(['TEXT', 'UPPER', 'LOWER', 'TRIM']);

/** Meets one comparison on one side (a record field, its prior value, or a parent field). */
function meet(
  side: Side,
  op: ConditionOperator,
  right: string | undefined,
  wanted?: boolean,
  fn?: FieldFunction,
): boolean {
  if (fn && !(op === 'IsNull' && BLANK_PRESERVING.has(fn))) {
    return op === 'IsNull' ? false : meetThrough(side, fn, op, right);
  }
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
      // A checkbox differs from true when false, and the other way round.
      const flipped = right === 'true' ? 'false' : right === 'false' ? 'true' : undefined;
      const value = differentValue(right, [side.values[side.field], side.alternates[side.field], flipped]);
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
function rightValue(
  right: Operand | undefined,
  plan: CriteriaPlan,
  ctx: SolveContext,
  left?: Side,
): string | undefined {
  if (!right) return undefined;
  if (right.kind === 'value') return right.apex;
  if (right.kind === 'user') return 'UserInfo.getUserId()';
  if (right.kind === 'ref') {
    const setup = SETUP_REF.exec(right.name);
    if (!setup) return globalValue(right.name) ?? ctx.resource?.(right.name);
    // The test inserts the setting with the value it gives the compared field.
    const side = settingSide(setup[1], setup[2], plan, ctx);
    const planned = side.current();
    if (planned !== undefined) return planned;
    const value = side.values[side.field] ?? left?.current() ?? left?.values[left.field];
    return value !== undefined && !isNullish(value) && side.assign(value) ? value : undefined;
  }
  if (right.kind !== 'field' || right.prior || right.fn || right.path.length !== 1) return undefined;
  const field = right.path[0];
  const planned = plan.set.get(field) ?? (ctx.context === 'insert' ? ctx.inserted[field] : undefined);
  if (planned !== undefined && !isNullish(planned)) return planned;
  const value = ctx.fieldValues[field];
  if (value === undefined || plan.keep.has(field)) return undefined;
  if (!recordSide(field, plan, ctx).assign(value)) return undefined;
  return value;
}

/** A field of a custom setting's org-wide default, which the test inserts when the plan sets any. */
function settingSide(setting: string, field: string, plan: CriteriaPlan, ctx: SolveContext): Side {
  const key = `$Setup.${setting}.${field}`;
  return {
    field,
    values: ctx.settingFieldValues?.(setting) ?? {},
    alternates: {},
    current: () => plan.settings.get(setting)?.get(field),
    assign: (value) => {
      const fields = plan.settings.get(setting) ?? new Map<string, string>();
      const existing = fields.get(field);
      if (existing !== undefined) return existing === value;
      if (plan.keep.has(key)) return false;
      fields.set(field, value);
      plan.settings.set(setting, fields);
      return true;
    },
    // Without the setting, a test reads every field as empty.
    keepEmpty: () => {
      if (plan.settings.get(setting)?.has(field)) return false;
      plan.keep.add(key);
      return true;
    },
  };
}

function recordSide(field: string, plan: CriteriaPlan, ctx: SolveContext): Side {
  return {
    field,
    values: ctx.fieldValues,
    alternates: ctx.changedValues,
    current: () => plan.set.get(field) ?? (ctx.context === 'insert' ? ctx.inserted[field] : undefined),
    assign: (raw) => {
      const value = normalized(ctx, ctx.object, field, raw);
      if (value === null) return false;
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
    assign: (raw) => {
      const value = normalized(ctx, ctx.object, field, raw);
      if (value === null) return false;
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
    assign: (raw) => {
      const value = normalized(ctx, object, field, raw);
      if (value === null) return false;
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

/** Relationships a test can follow from the record: as many as it inserts parents deep. */
const MAX_RELATIONSHIPS = MAX_PARENT_DEPTH;

/**
 * Meets an atom on a related record's field (`Account__r.Type`, `Contact__r.Account.Type`): the
 * record looks up a parent the test inserts, which looks up the next one, and the last one gets
 * the value. `RecordType.DeveloperName` at the end sets that record's record type instead.
 */
function meetRelated(atom: Atom, plan: CriteriaPlan, ctx: SolveContext): boolean {
  const left = atom.left as Extract<Operand, { kind: 'field' }>;
  const hops = left.path.slice(0, -1);
  const field = left.path[left.path.length - 1];
  if (hops.length > MAX_RELATIONSHIPS) return false;
  let object = ctx.object;
  let side = (name: string): Side => recordSide(name, plan, ctx);
  const visited = new Set<string>();
  for (let i = 0; i < hops.length; i++) {
    const relationship = hops[i];
    if (relationship === 'RecordType' && i === hops.length - 1) {
      if (field !== 'DeveloperName' || atom.op !== 'EqualTo' || left.fn) return false;
      const name = atom.right?.kind === 'value' ? knownOf(atom.right.apex) : undefined;
      if (name?.kind !== 'string') return false;
      return side('RecordTypeId').assign(
        `Schema.SObjectType.${object}.getRecordTypeInfosByDeveloperName().get('${escapeApexString(name.value)}').getRecordTypeId()`,
      );
    }
    const links = i === 0 ? { relationships: ctx.relationships, lookups: ctx.lookups } : ctx.parentLinks?.(object);
    const lookup = links?.relationships[relationship];
    const parent = lookup ? links?.lookups[lookup] : undefined;
    const id = lookup ? (i === 0 ? ctx.fieldValues : ctx.parentFieldValues(object))[lookup] : undefined;
    // A test inserts one record per parent object, so a chain can't pass through an object twice.
    if (!lookup || !parent || !id || !/Parent\.Id$/.test(id) || visited.has(parent)) return false;
    if (!side(lookup).assign(id)) return false;
    visited.add(parent);
    object = parent;
    side = (name) => parentSide(parent, name, plan, ctx);
  }
  const last = side(field);
  return meet(
    last,
    atom.op,
    rightValue(atom.right, plan, ctx, last),
    atom.right?.kind === 'value' ? atom.right.apex === 'true' : undefined,
    left.fn,
  );
}

/** Meets an atom, or returns false. */
function meetAtom(atom: Atom, plan: CriteriaPlan, ctx: SolveContext): boolean {
  const { left, op } = atom;
  const wanted = atom.right?.kind === 'value' ? atom.right.apex === 'true' : undefined;
  if (left.kind === 'ref') {
    // A custom setting the test can insert, such as a switch that turns the Flow on.
    const setup = SETUP_REF.exec(left.name);
    if (!setup || op === 'IsChanged') return false;
    const side = settingSide(setup[1], setup[2], plan, ctx);
    return meet(side, op, rightValue(atom.right, plan, ctx, side), wanted);
  }
  if (left.kind !== 'field') return false;

  if (left.prior) {
    if (ctx.context !== 'update' || left.path.length !== 1 || op === 'IsChanged') return false;
    const prior = priorSide(left.path[0], plan, ctx);
    return meet(prior, op, rightValue(atom.right, plan, ctx, prior), wanted, left.fn);
  }

  if (left.path.length > 1) return meetRelated(atom, plan, ctx);

  const field = left.path[0];
  const side = recordSide(field, plan, ctx);
  if (left.fn) return meet(side, op, rightValue(atom.right, plan, ctx, side), wanted, left.fn);
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
  return meet(side, op, rightValue(atom.right, plan, ctx, side), wanted);
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
