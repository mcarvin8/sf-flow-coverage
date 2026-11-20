import { type Condition, conditionFromRule, type EvaluationEnv, evaluateCondition } from './conditions.js';
import { asArray, asRecord, type FlowValue, parseFlowValue, text, type XmlRecord } from './flowValues.js';
import { type Expr, parseFormula } from './formula.js';

/**
 * The parts of a Flow's elements that decide what a test can assert: which `$Record` fields and
 * variables each element writes, which records it creates or looks up, how decisions branch,
 * and where custom errors stop the save.
 */
export type FlowGraph = {
  /** The element the start element connects to. */
  start?: string;
  nodes: Record<string, FlowNode>;
  /** Formula resources by name, for decisions that read them. */
  formulas: Record<string, Expr>;
};

/** A write to a field of the triggering record. */
export type FieldWrite = {
  field: string;
  value: FlowValue;
  /** The element that writes it. */
  element: string;
};

/** A write to a variable. */
export type VariableWrite = { variable: string; value: FlowValue; element: string };

/** A record the Flow creates, with the fields it sets. */
export type RecordCreate = { element: string; object: string; fields: Array<{ field: string; value: FlowValue }> };

export type DecisionRule = { name: string; label: string; condition: Condition; next?: string };

export type FlowNode =
  | { kind: 'write'; name: string; writes: FieldWrite[]; variables: VariableWrite[]; nexts: string[] }
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
  /** Get Records that stores its result in `output`. */
  | { kind: 'lookup'; name: string; object: string; output: string; nexts: string[] }
  /** Create Records with its fields set one by one. */
  | { kind: 'create'; name: string; create: RecordCreate; nexts: string[] }
  /** Loops, waits, screens: a walk can't tell what happens past them. */
  | { kind: 'stop'; name: string; nexts: string[] }
  | { kind: 'other'; name: string; nexts: string[] };

const PASS_THROUGH_TYPES = [
  'actionCalls',
  'apexPluginCalls',
  'collectionProcessors',
  'recordDeletes',
  'recordRollbacks',
  'subflows',
  'transforms',
] as const;

const STOP_TYPES = ['loops', 'orchestratedStages', 'screens', 'steps', 'waits'] as const;

/** XML paths the parser must read as lists even when they hold one element. */
export const GRAPH_ARRAY_PATHS = [
  ...[
    ...PASS_THROUGH_TYPES,
    ...STOP_TYPES,
    'assignments',
    'decisions',
    'recordUpdates',
    'recordCreates',
    'recordLookups',
    'customErrors',
    'formulas',
  ].map((type) => `Flow.${type}`),
  'Flow.assignments.assignmentItems',
  'Flow.decisions.rules',
  'Flow.decisions.rules.conditions',
  'Flow.recordUpdates.inputAssignments',
  'Flow.recordUpdates.filters',
  'Flow.recordCreates.inputAssignments',
  'Flow.customErrors.customErrorMessages',
];

const RECORD_FIELD = /^\$Record\.([A-Za-z][A-Za-z0-9_]*)$/;
const VARIABLE = /^[A-Za-z][A-Za-z0-9_]*$/;

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

function parseAssignment(name: string, element: XmlRecord): FlowNode {
  const writes: FieldWrite[] = [];
  const variables: VariableWrite[] = [];
  for (const item of asArray(element.assignmentItems)) {
    const reference = text(item.assignToReference) ?? '';
    const operator = text(item.operator) ?? 'Assign';
    const parsed = parseFlowValue(asRecord(item.value));
    // Add, Subtract and the like depend on the current value.
    const value = operator === 'Assign' ? parsed : { rawValue: `${operator} ${parsed.rawValue ?? ''}`.trim() };
    const field = RECORD_FIELD.exec(reference)?.[1];
    if (field) writes.push({ field, element: name, value });
    else if (VARIABLE.test(reference)) variables.push({ variable: reference, element: name, value });
  }
  return { kind: 'write', name, writes, variables, nexts: nextsOf(element) };
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

function fieldAssignments(element: XmlRecord): Array<{ field: string; value: FlowValue }> {
  return asArray(element.inputAssignments).flatMap((assignment) => {
    const field = text(assignment.field);
    return field ? [{ field, value: parseFlowValue(asRecord(assignment.value)) }] : [];
  });
}

function parseDecision(name: string, element: XmlRecord): FlowNode {
  const rules = asArray(element.rules).map((rule) => {
    const ruleName = text(rule.name) ?? '';
    const conditions = asArray(rule.conditions).map((condition) => ({
      left: text(condition.leftValueReference) ?? '',
      operator: text(condition.operator) ?? '',
      right: parseFlowValue(asRecord(condition.rightValue)),
    }));
    return {
      name: ruleName,
      label: text(rule.label) ?? ruleName,
      condition: conditionFromRule(conditions, text(rule.conditionLogic)),
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
  each('assignments', parseAssignment);
  each('recordUpdates', (name, element) =>
    updatesRecord(element)
      ? {
          kind: 'write',
          name,
          writes: fieldAssignments(element).map((a) => ({ ...a, element: name })),
          variables: [],
          nexts: nextsOf(element),
        }
      : { kind: 'other', name, nexts: nextsOf(element) },
  );
  each('recordCreates', (name, element) => {
    const object = text(element.object);
    // A create from a record variable doesn't say which fields it sets.
    if (!object || text(element.inputReference)) return { kind: 'other', name, nexts: nextsOf(element) };
    return {
      kind: 'create',
      name,
      create: { element: name, object, fields: fieldAssignments(element) },
      nexts: nextsOf(element),
    };
  });
  each('recordLookups', (name, element) => {
    const object = text(element.object);
    const output = text(element.storeOutputAutomatically) === 'true' ? name : text(element.outputReference);
    return object && output
      ? { kind: 'lookup', name, object, output, nexts: nextsOf(element) }
      : { kind: 'other', name, nexts: nextsOf(element) };
  });
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

  const formulas: Record<string, Expr> = {};
  for (const formula of asArray(flow.formulas)) {
    const name = text(formula.name);
    const expr = parseFormula(text(formula.expression) ?? '');
    if (name && expr) formulas[name] = expr;
  }
  return { start: target(asRecord(flow.start)?.connector), nodes, formulas };
}

/**
 * What the test knows when the Flow runs, by reference (`$Record.Status__c`,
 * `$Record__Prior.Status__c`, `myVariable`): an Apex literal, `null` for a known-empty value, and
 * no entry for a value it can't know.
 */
export type FieldState = Map<string, string | null>;

/** Effects on one outcome of a decision the walk couldn't decide. */
export type UndecidedOutcome = {
  label: string;
  writes: FieldWrite[];
  variables: VariableWrite[];
  creates: RecordCreate[];
  /** True when a custom error can stop the save on this outcome. */
  customError: boolean;
};

/** A decision the walk took, and the rule it took (undefined for the default outcome). */
export type DecisionTaken = { element: string; rule?: DecisionRule };

export type FlowWalk = {
  /** `$Record` writes certain to happen, in order. */
  writes: FieldWrite[];
  /** Variable writes certain to happen, in order. */
  variables?: VariableWrite[];
  /** Records the Flow is certain to create. */
  creates?: RecordCreate[];
  /** Decisions taken, in order. */
  decisions?: DecisionTaken[];
  /** A custom error certain to stop the save. */
  customError?: { element: string; message?: string };
  /** Where the walk stopped, and what each way on can do. */
  undecided?: { element: string; outcomes: UndecidedOutcome[] };
};

export type WalkOptions = {
  /**
   * Whether the org has no records of `object` the Flow could find. Apex tests see no org data,
   * so this holds for data the test (and the Flow, before the lookup) doesn't create.
   */
  emptyObject?(object: string): boolean;
};

/** Every write, create, and custom error reachable from `starts`, along any path. */
function reachable(graph: FlowGraph, starts: Array<string | undefined>): Omit<UndecidedOutcome, 'label'> {
  const outcome: Omit<UndecidedOutcome, 'label'> = { writes: [], variables: [], creates: [], customError: false };
  const seen = new Set<string>();
  const queue = starts.filter((s): s is string => !!s);
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const node = graph.nodes[name];
    if (!node) continue;
    if (node.kind === 'write') {
      outcome.writes.push(...node.writes);
      outcome.variables.push(...node.variables);
    }
    if (node.kind === 'create') outcome.creates.push(node.create);
    if (node.kind === 'customError') outcome.customError = true;
    queue.push(...node.nexts);
  }
  return outcome;
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
    outcomes: outcomes.filter((o) => o.writes.length + o.variables.length + o.creates.length > 0 || o.customError),
  };
}

/**
 * Follows the Flow from its start for a record in the given state, through every decision the
 * state decides, and reports what is certain to happen.
 */
export function walkFlow(graph: FlowGraph, initial: FieldState, options: WalkOptions = {}): FlowWalk {
  const state = new Map(initial);
  const env: EvaluationEnv = { get: (reference) => state.get(reference), formula: (name) => graph.formulas[name] };
  const walk: Required<Omit<FlowWalk, 'customError' | 'undecided'>> = {
    writes: [],
    variables: [],
    creates: [],
    decisions: [],
  };
  const created = new Set<string>();
  const set = (reference: string, value: FlowValue): void => {
    if (value.apexValue === undefined) state.delete(reference);
    else state.set(reference, value.apexValue);
  };
  const seen = new Set<string>();
  let current = graph.start;
  while (current && !seen.has(current)) {
    seen.add(current);
    const node: FlowNode | undefined = graph.nodes[current];
    if (!node) break;
    switch (node.kind) {
      case 'write':
        for (const write of node.writes) {
          walk.writes.push(write);
          set(`$Record.${write.field}`, write.value);
        }
        for (const write of node.variables) {
          walk.variables.push(write);
          set(write.variable, write.value);
        }
        current = node.nexts[0];
        break;
      case 'create':
        walk.creates.push(node.create);
        created.add(node.create.object);
        current = node.nexts[0];
        break;
      case 'lookup':
        if (!created.has(node.object) && options.emptyObject?.(node.object)) state.set(node.output, null);
        else state.delete(node.output);
        current = node.nexts[0];
        break;
      case 'customError':
        return { ...walk, customError: { element: node.name, message: node.message } };
      case 'decision': {
        let taken: DecisionRule | undefined;
        for (const rule of node.rules) {
          const result = evaluateCondition(rule.condition, env);
          if (result === undefined) return { ...walk, undecided: undecidedAt(graph, node) };
          if (result) {
            taken = rule;
            break;
          }
        }
        walk.decisions.push({ element: node.name, rule: taken });
        current = taken ? taken.next : node.defaultNext;
        break;
      }
      case 'stop':
        return { ...walk, undecided: undecidedAt(graph, node) };
      default:
        current = node.nexts[0];
    }
  }
  return walk;
}
