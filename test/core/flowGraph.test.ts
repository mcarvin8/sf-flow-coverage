import { describe, expect, it } from 'vitest';

import { type FieldState, type FlowGraph, walkFlow } from '../../src/core/flowGraph.js';
import { parseFlowXml } from '../../src/core/flowXml.js';

const graphOf = (elements: string, start = 'First'): FlowGraph => {
  const flow = parseFlowXml(
    'F',
    `<Flow><processType>AutoLaunchedFlow</processType>${elements}<start><connector><targetReference>${start}</targetReference></connector></start></Flow>`,
  );
  return flow.graph as FlowGraph;
};

const assign = (name: string, field: string, value: string, next?: string, operator = 'Assign'): string =>
  `<assignments><name>${name}</name><assignmentItems><assignToReference>${field}</assignToReference><operator>${operator}</operator><value>${value}</value></assignmentItems>${next ? `<connector><targetReference>${next}</targetReference></connector>` : ''}</assignments>`;

const condition = (left: string, operator: string, right: string): string =>
  `<conditions><leftValueReference>${left}</leftValueReference><operator>${operator}</operator><rightValue>${right}</rightValue></conditions>`;

const decision = (name: string, rules: string, defaultNext?: string): string =>
  `<decisions><name>${name}</name><label>${name} label</label>${defaultNext ? `<defaultConnector><targetReference>${defaultNext}</targetReference></defaultConnector>` : ''}${rules}</decisions>`;

const rule = (name: string, conditions: string, next?: string, logic = 'and'): string =>
  `<rules><name>${name}</name><label>${name} label</label><conditionLogic>${logic}</conditionLogic>${conditions}${next ? `<connector><targetReference>${next}</targetReference></connector>` : ''}</rules>`;

const customError = (name: string, message?: string): string =>
  `<customErrors><name>${name}</name>${message ? `<customErrorMessages><errorMessage>${message}</errorMessage></customErrorMessages>` : ''}</customErrors>`;

const str = (value: string): string => `<stringValue>${value}</stringValue>`;
const num = (value: string): string => `<numberValue>${value}</numberValue>`;
const bool = (value: boolean): string => `<booleanValue>${value}</booleanValue>`;
const ref = (value: string): string => `<elementReference>${value}</elementReference>`;

const state = (entries: Record<string, string | null>): FieldState => new Map(Object.entries(entries));
const written = (graph: FlowGraph, initial: FieldState = new Map()): string[] =>
  walkFlow(graph, initial).writes.map((w) => `${w.element}: ${w.field} = ${w.value.apexValue ?? w.value.rawValue}`);

describe('parseFlowGraph', () => {
  it('reads writes to $Record from assignments and record updates', () => {
    const graph = graphOf(
      [
        `<assignments><name>First</name>
          <assignmentItems><assignToReference>$Record.Status__c</assignToReference><operator>Assign</operator><value>${str('Done')}</value></assignmentItems>
          <assignmentItems><assignToReference>counter</assignToReference><operator>Assign</operator><value>${num('1')}</value></assignmentItems>
          <assignmentItems><assignToReference>$Record.Count__c</assignToReference><operator>Add</operator><value>${num('2')}</value></assignmentItems>
          <assignmentItems><assignToReference>$Record.Account.Name</assignToReference><operator>Assign</operator><value>${str('x')}</value></assignmentItems>
          <connector><targetReference>Update_Self</targetReference></connector></assignments>`,
        `<recordUpdates><name>Update_Self</name><inputReference>$Record</inputReference>
          <inputAssignments><field>Flag__c</field><value>${bool(true)}</value></inputAssignments>
          <inputAssignments><value>${bool(true)}</value></inputAssignments>
          <connector><targetReference>Update_By_Id</targetReference></connector></recordUpdates>`,
        `<recordUpdates><name>Update_By_Id</name><object>Job__c</object>
          <filters><field>Id</field><operator>EqualTo</operator><value>${ref('$Record.Id')}</value></filters>
          <inputAssignments><field>Note__c</field><value>${ref('$Record.Name')}</value></inputAssignments>
          <connector><targetReference>Update_Other</targetReference></connector></recordUpdates>`,
        `<recordUpdates><name>Update_Other</name><object>Account</object>
          <filters><field>Id</field><operator>EqualTo</operator><value>${ref('$Record.Account__c')}</value></filters>
          <inputAssignments><field>Rating</field><value>${str('Hot')}</value></inputAssignments></recordUpdates>`,
      ].join(''),
    );
    expect(graph.start).toBe('First');
    expect(graph.nodes.Update_Other.kind).toBe('other');
    expect(written(graph)).toEqual([
      "First: Status__c = 'Done'",
      'First: Count__c = Add 2',
      'Update_Self: Flag__c = true',
      'Update_By_Id: Note__c = $Record.Name',
    ]);
  });

  it('reads an empty Flow', () => {
    expect(parseFlowXml('F', '<Flow><processType>Flow</processType></Flow>').graph).toEqual({ nodes: {} });
  });
});

describe('walkFlow', () => {
  it('follows other elements and stops at the end or on a loop back', () => {
    const graph = graphOf(
      [
        `<recordLookups><name>First</name><connector><targetReference>Set</targetReference></connector><faultConnector><targetReference>Gone</targetReference></faultConnector></recordLookups>`,
        assign('Set', '$Record.A__c', str('a'), 'First'),
      ].join(''),
    );
    expect(written(graph)).toEqual(["Set: A__c = 'a'"]);
    expect(walkFlow(graphOf('', 'Missing'), new Map())).toEqual({ writes: [] });
  });

  it('takes the first rule that holds, else the default outcome', () => {
    const graph = graphOf(
      [
        decision(
          'First',
          rule('Big', condition('$Record.Size__c', 'GreaterThan', num('10')), 'Set_Big') +
            rule('Named', condition('$Record.Name__c', 'EqualTo', str('Bob')), 'Set_Named'),
          'Set_Default',
        ),
        assign('Set_Big', '$Record.Out__c', str('big')),
        assign('Set_Named', '$Record.Out__c', str('named')),
        assign('Set_Default', '$Record.Out__c', str('default')),
      ].join(''),
    );
    expect(written(graph, state({ Size__c: '11', Name__c: "'Bob'" }))).toEqual(["Set_Big: Out__c = 'big'"]);
    expect(written(graph, state({ Size__c: '10.0', Name__c: "'Bob'" }))).toEqual(["Set_Named: Out__c = 'named'"]);
    expect(written(graph, state({ Size__c: '1', Name__c: "'Al'" }))).toEqual(["Set_Default: Out__c = 'default'"]);
  });

  it('uses values the Flow assigned earlier', () => {
    const graph = graphOf(
      [
        assign('First', '$Record.Stage__c', str('Open'), 'Check'),
        decision('Check', rule('Is_Open', condition('$Record.Stage__c', 'EqualTo', str('Open')), 'Set')),
        assign('Set', '$Record.Out__c', bool(true)),
      ].join(''),
    );
    expect(written(graph)).toEqual(["First: Stage__c = 'Open'", 'Set: Out__c = true']);
  });

  it('decides IsNull, null comparisons, numbers, booleans, and and/or logic', () => {
    const decide = (conditions: string, initial: FieldState, logic = 'and'): string[] =>
      written(
        graphOf(
          decision('First', rule('Yes', conditions, 'Yes_Set', logic), 'No_Set') +
            assign('Yes_Set', '$Record.Out__c', str('yes')) +
            assign('No_Set', '$Record.Out__c', str('no')),
        ),
        initial,
      ).map((w) => w.split(' = ')[1]);
    const isNull = (field: string, value: boolean) => condition(`$Record.${field}`, 'IsNull', bool(value));
    expect(decide(isNull('A__c', true), state({ A__c: null }))).toEqual(["'yes'"]);
    expect(decide(isNull('A__c', false), state({ A__c: null }))).toEqual(["'no'"]);
    expect(decide(isNull('A__c', false), state({ A__c: 'Date.today()' }))).toEqual(["'yes'"]);
    expect(decide(condition('$Record.A__c', 'EqualTo', str('x')), state({ A__c: null }))).toEqual(["'no'"]);
    expect(decide(condition('$Record.A__c', 'NotEqualTo', str('x')), state({ A__c: null }))).toEqual(["'yes'"]);
    expect(decide(condition('$Record.A__c', 'NotEqualTo', str('x')), state({ A__c: "'y'" }))).toEqual(["'yes'"]);
    expect(decide(condition('$Record.A__c', 'EqualTo', bool(true)), state({ A__c: 'true' }))).toEqual(["'yes'"]);
    expect(decide(condition('$Record.A__c', 'LessThan', num('5')), state({ A__c: '4' }))).toEqual(["'yes'"]);
    expect(decide(condition('$Record.A__c', 'LessThanOrEqualTo', num('5')), state({ A__c: '6' }))).toEqual(["'no'"]);
    expect(decide(condition('$Record.A__c', 'GreaterThanOrEqualTo', num('5')), state({ A__c: '5' }))).toEqual([
      "'yes'",
    ]);
    const both = isNull('A__c', true) + isNull('B__c', true);
    expect(decide(both, state({ A__c: null, B__c: "'b'" }))).toEqual(["'no'"]);
    expect(decide(both, state({ A__c: null, B__c: "'b'" }), 'or')).toEqual(["'yes'"]);
    expect(decide(both, state({ A__c: "'a'" }))).toEqual(["'no'"]);
    expect(decide(both, state({ B__c: null }), 'or')).toEqual(["'yes'"]);
  });

  it('stops at a decision it cannot decide and lists what each outcome can do', () => {
    const graph = graphOf(
      [
        assign('First', '$Record.Before__c', str('b'), 'Check'),
        decision(
          'Check',
          rule('Has_Owner', condition('$Record.Owner__c', 'IsNull', bool(false)), 'Owner_Set') +
            rule('Unused', condition('$Record.X__c', 'IsNull', bool(true))),
          'Fail',
        ),
        assign('Owner_Set', '$Record.Out__c', str('owned'), 'Loop_Back'),
        assign('Loop_Back', '$Record.Before__c', str('again'), 'Owner_Set'),
        customError('Fail', 'Nope'),
      ].join(''),
    );
    expect(walkFlow(graph, new Map())).toEqual({
      writes: [{ element: 'First', field: 'Before__c', value: { apexValue: "'b'", rawValue: 'b' } }],
      undecided: {
        element: 'Check label',
        outcomes: [
          {
            label: 'Has_Owner label',
            customError: false,
            writes: [
              { element: 'Owner_Set', field: 'Out__c', value: { apexValue: "'owned'", rawValue: 'owned' } },
              { element: 'Loop_Back', field: 'Before__c', value: { apexValue: "'again'", rawValue: 'again' } },
            ],
          },
          { label: 'Default Outcome', customError: true, writes: [] },
        ],
      },
    });
  });

  it('cannot decide conditions it does not understand', () => {
    const undecided = (conditions: string, initial: FieldState = state({ A__c: "'a'" }), logic = 'and'): boolean =>
      !!walkFlow(
        graphOf(decision('First', rule('R', conditions, 'Set', logic)) + assign('Set', '$Record.Out__c', str('x'))),
        initial,
      ).undecided;
    expect(undecided(condition('formulaVar', 'EqualTo', bool(true)))).toBe(true);
    expect(undecided(condition('$Record.B__c', 'IsNull', bool(true)))).toBe(true);
    expect(undecided(condition('$Record.A__c', 'IsNull', ref('other')))).toBe(true);
    expect(undecided(condition('$Record.A__c', 'EqualTo', ref('$Record.B__c')))).toBe(true);
    expect(undecided(condition('$Record.A__c', 'EqualTo', str('A')))).toBe(true);
    expect(undecided(condition('$Record.A__c', 'EqualTo', num('1')))).toBe(true);
    expect(undecided(condition('$Record.A__c', 'GreaterThan', str('a')))).toBe(true);
    expect(undecided(condition('$Record.A__c', 'Contains', str('a')))).toBe(true);
    expect(undecided(condition('$Record.A__c', 'StartsWith', str('a')), state({ A__c: 'Date.today()' }))).toBe(true);
    expect(undecided(condition('$Record.A__c', 'GreaterThan', num('1')), state({ A__c: null }))).toBe(true);
    expect(undecided(condition('$Record.A__c', 'Contains', num('1')), state({ A__c: '1' }))).toBe(true);
    expect(undecided(condition('$Record.A__c', 'EqualTo', str('a')), state({ A__c: "'a'" }), '1 AND 2')).toBe(true);
    expect(undecided('')).toBe(true);
  });

  it('reports a custom error on the path, with or without a message', () => {
    expect(walkFlow(graphOf(customError('First', 'Set the date')), new Map())).toEqual({
      writes: [],
      customError: { element: 'First', message: 'Set the date' },
    });
    expect(walkFlow(graphOf(customError('First')), new Map()).customError).toEqual({ element: 'First' });
  });

  it('stops at a loop and lists what can happen after it', () => {
    const graph = graphOf(
      `<loops><name>First</name><nextValueConnector><targetReference>Set</targetReference></nextValueConnector><noMoreValuesConnector><targetReference>Done</targetReference></noMoreValuesConnector></loops>${assign('Set', '$Record.A__c', str('a'), 'First')}${assign('Done', '$Record.B__c', ref('var'))}`,
    );
    expect(walkFlow(graph, new Map()).undecided).toEqual({
      element: 'First',
      outcomes: [
        {
          label: 'after First',
          customError: false,
          writes: [
            { element: 'Set', field: 'A__c', value: { apexValue: "'a'", rawValue: 'a' } },
            { element: 'Done', field: 'B__c', value: { rawValue: 'var' } },
          ],
        },
      ],
    });
  });

  it('forgets a field the Flow sets to something it cannot know', () => {
    const graph = graphOf(
      [
        assign('First', '$Record.A__c', ref('var'), 'Check'),
        decision('Check', rule('R', condition('$Record.A__c', 'IsNull', bool(true)), 'Set')),
        assign('Set', '$Record.Out__c', str('x')),
      ].join(''),
    );
    expect(walkFlow(graph, state({ A__c: null })).undecided?.element).toBe('Check label');
  });
});
