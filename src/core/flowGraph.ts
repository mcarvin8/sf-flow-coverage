import { asArray, asRecord, type FlowValue, parseFlowValue, text, type XmlRecord } from './flowValues.js';

/**
 * The parts of a Flow's elements that decide what a test can assert: which `$Record` fields
 * each element writes, how decisions branch, and where custom errors stop the save.
 */
export type FlowGraph = {
  /** The element the start element connects to. */
  start?: string;
  nodes: Record<string, FlowNode>;
};

/** A write to a field of the triggering record. */
export type FieldWrite = {
  field: string;
  value: FlowValue;
  /** The element that writes it. */
  element: string;
};

export type FlowCondition = { left: string; operator: string; right: FlowValue };

export type DecisionRule = {
  name: string;
  label: string;
  /** `and`, `or`, or custom logic such as `1 AND (2 OR 3)`. */
  logic?: string;
  conditions: FlowCondition[];
  next?: string;
};

export type FlowNode =
  | { kind: 'write'; name: string; writes: FieldWrite[]; nexts: string[] }
  | {
      kind: 'decision';
      name: string;
      label: string;
      rules: DecisionRule[];
      defaultNext?: string;
      defaultLabel: string;
      nexts: string[];
    }
  | { kind: 'customError'; name: string; message?: string; nexts: string[] }
  /** Loops, waits, screens: a walk can't tell what happens past them. */
  | { kind: 'stop'; name: string; nexts: string[] }
  | { kind: 'other'; name: string; nexts: string[] };

const PASS_THROUGH_TYPES = [
  'actionCalls',
  'apexPluginCalls',
  'collectionProcessors',
  'recordCreates',
  'recordDeletes',
  'recordLookups',
  'recordRollbacks',
  'subflows',
  'transforms',
] as const;

const STOP_TYPES = ['loops', 'orchestratedStages', 'screens', 'steps', 'waits'] as const;

/** XML paths the parser must read as lists even when they hold one element. */
export const GRAPH_ARRAY_PATHS = [
  ...[...PASS_THROUGH_TYPES, ...STOP_TYPES, 'assignments', 'decisions', 'recordUpdates', 'customErrors'].map(
    (type) => `Flow.${type}`,
  ),
  'Flow.assignments.assignmentItems',
  'Flow.decisions.rules',
  'Flow.decisions.rules.conditions',
  'Flow.recordUpdates.inputAssignments',
  'Flow.recordUpdates.filters',
  'Flow.customErrors.customErrorMessages',
];

const RECORD_FIELD = /^\$Record\.([A-Za-z][A-Za-z0-9_]*)$/;

const target = (connector: unknown): string | undefined => text(asRecord(connector)?.targetReference);

/** Every element an element can continue to, apart from its fault path. */
function nextsOf(element: XmlRecord): string[] {
  const nexts = [
    target(element.connector),
    target(element.defaultConnector),
    target(element.nextValueConnector),
    target(element.noMoreValuesConnector),
    ...asArray(element.rules).map((rule) => target(rule.connector)),
  ];
  return nexts.filter((next): next is string => !!next);
}

function assignmentWrites(name: string, element: XmlRecord): FieldWrite[] {
  return asArray(element.assignmentItems).flatMap((item) => {
    const field = RECORD_FIELD.exec(text(item.assignToReference) ?? '')?.[1];
    if (!field) return [];
    const operator = text(item.operator) ?? 'Assign';
    const value = parseFlowValue(asRecord(item.value));
    // Add, Subtract and the like depend on the field's current value.
    return [
      {
        field,
        element: name,
        value: operator === 'Assign' ? value : { rawValue: `${operator} ${value.rawValue ?? ''}`.trim() },
      },
    ];
  });
}

/** Update Records on the triggering record: `$Record` itself, or the record whose Id is `$Record.Id`. */
function updatesRecord(element: XmlRecord): boolean {
  if (text(element.inputReference) === '$Record') return true;
  const filters = asArray(element.filters);
  return (
    filters.length === 1 &&
    text(filters[0].field) === 'Id' &&
    text(filters[0].operator) === 'EqualTo' &&
    text(asRecord(filters[0].value)?.elementReference) === '$Record.Id'
  );
}

function updateWrites(name: string, element: XmlRecord): FieldWrite[] {
  return asArray(element.inputAssignments).flatMap((assignment) => {
    const field = text(assignment.field);
    return field ? [{ field, element: name, value: parseFlowValue(asRecord(assignment.value)) }] : [];
  });
}

function parseDecision(name: string, element: XmlRecord): FlowNode {
  const rules = asArray(element.rules).map((rule) => {
    const ruleName = text(rule.name) ?? '';
    return {
      name: ruleName,
      label: text(rule.label) ?? ruleName,
      logic: text(rule.conditionLogic),
      conditions: asArray(rule.conditions).map((condition) => ({
        left: text(condition.leftValueReference) ?? '',
        operator: text(condition.operator) ?? '',
        right: parseFlowValue(asRecord(condition.rightValue)),
      })),
      next: target(rule.connector),
    };
  });
  return {
    kind: 'decision',
    name,
    label: text(element.label) ?? name,
    rules,
    defaultNext: target(element.defaultConnector),
    defaultLabel: text(element.defaultConnectorLabel) ?? 'Default Outcome',
    nexts: nextsOf(element),
  };
}

/** Reads the element graph from a parsed `<Flow>` record. */
export function parseFlowGraph(flow: XmlRecord): FlowGraph {
  const nodes: Record<string, FlowNode> = {};
  const each = (type: string, build: (name: string, element: XmlRecord) => FlowNode): void => {
    for (const element of asArray(flow[type])) {
      const name = text(element.name);
      if (name) nodes[name] = build(name, element);
    }
  };
  each('assignments', (name, element) => ({
    kind: 'write',
    name,
    writes: assignmentWrites(name, element),
    nexts: nextsOf(element),
  }));
  each('recordUpdates', (name, element) =>
    updatesRecord(element)
      ? { kind: 'write', name, writes: updateWrites(name, element), nexts: nextsOf(element) }
      : { kind: 'other', name, nexts: nextsOf(element) },
  );
  each('decisions', parseDecision);
  each('customErrors', (name, element) => ({
    kind: 'customError',
    name,
    message: text(asArray(element.customErrorMessages)[0]?.errorMessage),
    nexts: nextsOf(element),
  }));
  for (const type of PASS_THROUGH_TYPES)
    each(type, (name, element) => ({ kind: 'other', name, nexts: nextsOf(element) }));
  for (const type of STOP_TYPES) each(type, (name, element) => ({ kind: 'stop', name, nexts: nextsOf(element) }));
  return { start: target(asRecord(flow.start)?.connector), nodes };
}

/**
 * What the test knows about the triggering record's fields when the Flow runs: an Apex literal,
 * `null` for a field known to be empty, and no entry for a field it can't know.
 */
export type FieldState = Map<string, string | null>;

/** Effects on one outcome of a decision the walk couldn't decide. */
export type UndecidedOutcome = {
  label: string;
  writes: FieldWrite[];
  /** True when a custom error can stop the save on this outcome. */
  customError: boolean;
};

export type FlowWalk = {
  /** Writes certain to happen, in order. */
  writes: FieldWrite[];
  /** A custom error certain to stop the save. */
  customError?: { element: string; message?: string };
  /** Where the walk stopped, and what each way on can do. */
  undecided?: { element: string; outcomes: UndecidedOutcome[] };
};

type Literal = { kind: 'string' | 'number' | 'boolean'; value: string };

function literal(apexValue: string): Literal | undefined {
  const quoted = /^'((?:[^'\\]|\\.)*)'$/.exec(apexValue);
  if (quoted) return { kind: 'string', value: quoted[1].replace(/\\(.)/g, '$1') };
  if (/^-?\d+(\.\d+)?$/.test(apexValue)) return { kind: 'number', value: String(Number(apexValue)) };
  if (apexValue === 'true' || apexValue === 'false') return { kind: 'boolean', value: apexValue };
  return undefined;
}

/** True or false when the state decides the comparison, undefined when it can't. */
function compare(value: string, operator: string, right: string): boolean | undefined {
  const left = literal(value);
  const other = literal(right);
  if (!left || !other || left.kind !== other.kind) return undefined;
  if (operator === 'EqualTo' || operator === 'NotEqualTo') {
    let equal: boolean | undefined = left.value === other.value;
    // Text comparisons may ignore case; don't guess either way.
    if (!equal && left.kind === 'string' && left.value.toLowerCase() === other.value.toLowerCase()) equal = undefined;
    if (equal === undefined) return undefined;
    return operator === 'EqualTo' ? equal : !equal;
  }
  if (left.kind !== 'number') return undefined;
  const [a, b] = [Number(left.value), Number(other.value)];
  switch (operator) {
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

function evaluateCondition(condition: FlowCondition, state: FieldState): boolean | undefined {
  const field = RECORD_FIELD.exec(condition.left)?.[1];
  if (!field || !state.has(field)) return undefined;
  const value = state.get(field) ?? null;
  if (condition.operator === 'IsNull') {
    const raw = condition.right.rawValue;
    if (raw !== 'true' && raw !== 'false') return undefined;
    return raw === 'true' ? value === null : value !== null;
  }
  const right = condition.right.apexValue;
  if (right === undefined) return undefined;
  if (value === null) {
    if (condition.operator === 'EqualTo') return false;
    if (condition.operator === 'NotEqualTo') return true;
    return undefined;
  }
  return compare(value, condition.operator, right);
}

function evaluateRule(rule: DecisionRule, state: FieldState): boolean | undefined {
  if (rule.conditions.length === 0) return undefined;
  const logic = (rule.logic ?? 'and').toLowerCase();
  if (logic !== 'and' && logic !== 'or') return undefined;
  const results = rule.conditions.map((condition) => evaluateCondition(condition, state));
  const decisive = logic === 'and' ? false : true;
  if (results.includes(decisive)) return decisive;
  return results.includes(undefined) ? undefined : !decisive;
}

/** Every write and custom error reachable from `starts`, along any path. */
function reachable(graph: FlowGraph, starts: Array<string | undefined>): Omit<UndecidedOutcome, 'label'> {
  const writes: FieldWrite[] = [];
  let customError = false;
  const seen = new Set<string>();
  const queue = starts.filter((s): s is string => !!s);
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const node = graph.nodes[name];
    if (!node) continue;
    if (node.kind === 'write') writes.push(...node.writes);
    if (node.kind === 'customError') customError = true;
    queue.push(...node.nexts);
  }
  return { writes, customError };
}

function undecidedAt(graph: FlowGraph, node: FlowNode): FlowWalk['undecided'] {
  const outcomes: UndecidedOutcome[] =
    node.kind === 'decision'
      ? [
          ...node.rules.map((rule) => ({ label: rule.label, ...reachable(graph, [rule.next]) })),
          { label: node.defaultLabel, ...reachable(graph, [node.defaultNext]) },
        ]
      : [{ label: `after ${node.name}`, ...reachable(graph, node.nexts) }];
  return {
    element: node.kind === 'decision' ? node.label : node.name,
    outcomes: outcomes.filter((o) => o.writes.length > 0 || o.customError),
  };
}

/**
 * Follows the Flow from its start for a record in the given state, through every decision the
 * state decides, and reports what is certain to happen.
 */
export function walkFlow(graph: FlowGraph, initial: FieldState): FlowWalk {
  const state = new Map(initial);
  const writes: FieldWrite[] = [];
  const seen = new Set<string>();
  let current = graph.start;
  while (current && !seen.has(current)) {
    seen.add(current);
    const node: FlowNode | undefined = graph.nodes[current];
    if (!node) break;
    switch (node.kind) {
      case 'write':
        for (const write of node.writes) {
          writes.push(write);
          if (write.value.apexValue === undefined) state.delete(write.field);
          else state.set(write.field, write.value.apexValue);
        }
        current = node.nexts[0];
        break;
      case 'customError':
        return { writes, customError: { element: node.name, message: node.message } };
      case 'decision': {
        let next: string | undefined;
        let decided = false;
        for (const rule of node.rules) {
          const result = evaluateRule(rule, state);
          if (result === undefined) return { writes, undecided: undecidedAt(graph, node) };
          if (result) {
            next = rule.next;
            decided = true;
            break;
          }
        }
        current = decided ? next : node.defaultNext;
        break;
      }
      case 'stop':
        return { writes, undecided: undecidedAt(graph, node) };
      default:
        current = node.nexts[0];
    }
  }
  return { writes };
}
