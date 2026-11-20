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

const next = (to?: string): string => (to ? `<connector><targetReference>${to}</targetReference></connector>` : '');

const assign = (name: string, reference: string, value: string, to?: string, operator = 'Assign'): string =>
  `<assignments><name>${name}</name><assignmentItems><assignToReference>${reference}</assignToReference><operator>${operator}</operator><value>${value}</value></assignmentItems>${next(to)}</assignments>`;

const condition = (left: string, operator: string, right: string): string =>
  `<conditions><leftValueReference>${left}</leftValueReference><operator>${operator}</operator><rightValue>${right}</rightValue></conditions>`;

const decision = (name: string, rules: string, defaultNext?: string): string =>
  `<decisions><name>${name}</name><label>${name} label</label>${defaultNext ? `<defaultConnector><targetReference>${defaultNext}</targetReference></defaultConnector>` : ''}${rules}</decisions>`;

const rule = (name: string, conditions: string, to?: string, logic = 'and'): string =>
  `<rules><name>${name}</name><label>${name} label</label><conditionLogic>${logic}</conditionLogic>${conditions}${next(to)}</rules>`;

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
  it('reads writes to $Record and variables from assignments and record updates', () => {
    const graph = graphOf(
      [
        `<assignments><name>First</name>
          <assignmentItems><assignToReference>$Record.Status__c</assignToReference><operator>Assign</operator><value>${str('Done')}</value></assignmentItems>
          <assignmentItems><assignToReference>counter</assignToReference><operator>Assign</operator><value>${num('1')}</value></assignmentItems>
          <assignmentItems><assignToReference>$Record.Count__c</assignToReference><operator>Add</operator><value>${num('2')}</value></assignmentItems>
          <assignmentItems><assignToReference>$Record.Account.Name</assignToReference><operator>Assign</operator><value>${str('x')}</value></assignmentItems>
          ${next('Update_Self')}</assignments>`,
        `<recordUpdates><name>Update_Self</name><inputReference>$Record</inputReference>
          <inputAssignments><field>Flag__c</field><value>${bool(true)}</value></inputAssignments>
          <inputAssignments><value>${bool(true)}</value></inputAssignments>
          ${next('Update_By_Id')}</recordUpdates>`,
        `<recordUpdates><name>Update_By_Id</name><object>Job__c</object>
          <filters><field>Id</field><operator>EqualTo</operator><value>${ref('$Record.Id')}</value></filters>
          <inputAssignments><field>Note__c</field><value>${ref('$Record.Name')}</value></inputAssignments>
          ${next('Update_Other')}</recordUpdates>`,
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
    expect(walkFlow(graph, new Map()).variables).toEqual([
      { variable: 'counter', element: 'First', value: { apexValue: '1', rawValue: '1' } },
    ]);
  });

  it('reads record creates, lookups, and formulas', () => {
    const graph = graphOf(
      [
        `<recordCreates><name>First</name><object>Task</object>
          <inputAssignments><field>Subject</field><value>${str('Call')}</value></inputAssignments>
          <inputAssignments><field>WhatId</field><value>${ref('$Record.Id')}</value></inputAssignments>
          ${next('From_Variable')}</recordCreates>`,
        `<recordCreates><name>From_Variable</name><inputReference>newTask</inputReference>${next('Get_One')}</recordCreates>`,
        `<recordLookups><name>Get_One</name><object>Item__c</object><storeOutputAutomatically>true</storeOutputAutomatically>${next('Get_Into')}</recordLookups>`,
        `<recordLookups><name>Get_Into</name><object>Item__c</object><outputReference>item</outputReference>${next('Get_Fields')}</recordLookups>`,
        `<recordLookups><name>Get_Fields</name><object>Item__c</object></recordLookups>`,
        '<formulas><name>isBig</name><expression>{!$Record.Size__c} &gt; 10</expression></formulas>',
        '<formulas><name>broken</name><expression>AND(</expression></formulas>',
      ].join(''),
    );
    expect(graph.nodes.First).toMatchObject({
      kind: 'create',
      create: {
        object: 'Task',
        fields: [{ field: 'Subject' }, { field: 'WhatId', value: { rawValue: '$Record.Id' } }],
      },
    });
    expect(graph.nodes.From_Variable.kind).toBe('other');
    expect(graph.nodes.Get_One).toMatchObject({ kind: 'lookup', object: 'Item__c', output: 'Get_One' });
    expect(graph.nodes.Get_Into).toMatchObject({ kind: 'lookup', output: 'item' });
    expect(graph.nodes.Get_Fields.kind).toBe('other');
    expect(Object.keys(graph.formulas)).toEqual(['isBig']);
  });

  it('marks creates and updates that have a fault path, and reads filters on variables', () => {
    const fault = '<faultConnector><targetReference>Log</targetReference></faultConnector>';
    const graph = graphOf(
      [
        `<recordCreates><name>First</name><object>Task</object><inputAssignments><field>Subject</field><value>${str('x')}</value></inputAssignments>${fault}${next('Save')}</recordCreates>`,
        `<recordUpdates><name>Save</name><inputReference>$Record</inputReference><inputAssignments><field>Done__c</field><value>${bool(true)}</value></inputAssignments>${fault}${next('Plain')}</recordUpdates>`,
        `<recordCreates><name>Plain</name><object>Task</object>${next('Find')}</recordCreates>`,
        `<recordLookups><name>Find</name><object>Item__c</object><storeOutputAutomatically>true</storeOutputAutomatically>
          <filters><field>Id</field><operator>EqualTo</operator><value>${ref('itemId')}</value></filters>
          <filters><field>Account__c</field><operator>EqualTo</operator><value>${ref('accountId')}</value></filters>
          <filters><field>Name</field><operator>EqualTo</operator><value>${str('x')}</value></filters>
          <filters><field>Owner__c</field><operator>EqualTo</operator><value>${ref('$Record.OwnerId')}</value></filters>
        </recordLookups>`,
        `<recordDeletes><name>Remove</name><object>Old__c</object><filters><field>Id</field><operator>EqualTo</operator><value>${ref('oldId')}</value></filters></recordDeletes>`,
        `<recordDeletes><name>No_Object</name><inputReference>rows</inputReference></recordDeletes>`,
      ].join(''),
    );
    const walk = walkFlow(graph, new Map());
    expect(walk.creates?.map((c) => [c.element, c.mayFail ?? false])).toEqual([
      ['First', true],
      ['Plain', false],
    ]);
    expect(walk.writes).toEqual([
      { field: 'Done__c', element: 'Save', mayFail: true, value: { apexValue: 'true', rawValue: 'true' } },
    ]);
    expect(graph.idFilters).toEqual([
      { variable: 'itemId', object: 'Item__c', field: 'Id' },
      { variable: 'accountId', object: 'Item__c', field: 'Account__c' },
      { variable: 'oldId', object: 'Old__c', field: 'Id' },
    ]);
  });

  it('reads an empty Flow', () => {
    expect(parseFlowXml('F', '<Flow><processType>Flow</processType></Flow>').graph).toEqual({
      nodes: {},
      formulas: {},
      idFilters: [],
    });
  });
});

describe('walkFlow', () => {
  it('follows other elements and stops at the end or on a loop back', () => {
    const graph = graphOf(
      [
        `<subflows><name>First</name>${next('Set')}<faultConnector><targetReference>Gone</targetReference></faultConnector></subflows>`,
        assign('Set', '$Record.A__c', str('a'), 'First'),
      ].join(''),
    );
    expect(written(graph)).toEqual(["Set: A__c = 'a'"]);
    expect(walkFlow(graphOf('', 'Missing'), new Map())).toEqual({
      writes: [],
      variables: [],
      creates: [],
      decisions: [],
    });
  });

  it('takes the first rule that holds, else the default outcome, and records each decision', () => {
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
    const walk = walkFlow(graph, state({ '$Record.Size__c': '10.0', '$Record.Name__c': "'Bob'" }));
    expect(walk.writes.map((w) => w.element)).toEqual(['Set_Named']);
    expect(walk.decisions?.map((d) => [d.element, d.rule?.name])).toEqual([['First', 'Named']]);
    expect(written(graph, state({ '$Record.Size__c': '11', '$Record.Name__c': "'Bob'" }))).toEqual([
      "Set_Big: Out__c = 'big'",
    ]);
    const fallback = walkFlow(graph, state({ '$Record.Size__c': '1', '$Record.Name__c': "'Al'" }));
    expect(fallback.writes.map((w) => w.element)).toEqual(['Set_Default']);
    expect(fallback.decisions).toEqual([{ element: 'First', rule: undefined }]);
  });

  it('uses values the Flow assigned earlier, to fields and variables', () => {
    const graph = graphOf(
      [
        assign('First', '$Record.Stage__c', str('Open'), 'Count'),
        assign('Count', 'total', num('3'), 'Check'),
        decision(
          'Check',
          rule(
            'Is_Open',
            condition('$Record.Stage__c', 'EqualTo', str('Open')) + condition('total', 'EqualTo', num('3')),
            'Set',
          ),
        ),
        assign('Set', '$Record.Out__c', bool(true)),
      ].join(''),
    );
    expect(written(graph)).toEqual(["First: Stage__c = 'Open'", 'Set: Out__c = true']);
  });

  it('decides on formula resources and on lookups the test leaves empty', () => {
    const graph = graphOf(
      [
        `<recordLookups><name>First</name><object>Item__c</object><storeOutputAutomatically>true</storeOutputAutomatically>${next('Check')}</recordLookups>`,
        decision(
          'Check',
          rule('Found', condition('First', 'IsNull', bool(false)), 'Found_Set') +
            rule('Big', condition('isBig', 'EqualTo', bool(true)), 'Big_Set'),
          'Small_Set',
        ),
        assign('Found_Set', '$Record.Out__c', str('found')),
        assign('Big_Set', '$Record.Out__c', str('big')),
        assign('Small_Set', '$Record.Out__c', str('small')),
        '<formulas><name>isBig</name><expression>{!$Record.Size__c} * 2 &gt; 10</expression></formulas>',
      ].join(''),
    );
    const empty = { emptyObject: (object: string) => object === 'Item__c' };
    const out = (initial: FieldState, options = empty) =>
      walkFlow(graph, initial, options).writes.map((w) => w.element);
    expect(out(state({ '$Record.Size__c': '6' }))).toEqual(['Big_Set']);
    expect(out(state({ '$Record.Size__c': '5' }))).toEqual(['Small_Set']);
    expect(walkFlow(graph, state({ '$Record.Size__c': '6' })).undecided?.element).toBe('Check label');
  });

  it('treats a lookup on records the Flow created as unknown', () => {
    const graph = graphOf(
      [
        `<recordCreates><name>First</name><object>Item__c</object><inputAssignments><field>Name</field><value>${str('x')}</value></inputAssignments>${next('Get')}</recordCreates>`,
        `<recordLookups><name>Get</name><object>Item__c</object><storeOutputAutomatically>true</storeOutputAutomatically>${next('Check')}</recordLookups>`,
        decision('Check', rule('Found', condition('Get', 'IsNull', bool(false)), 'Set')),
        assign('Set', '$Record.Out__c', str('found')),
      ].join(''),
    );
    const walk = walkFlow(graph, new Map(), { emptyObject: () => true });
    expect(walk.creates?.map((c) => c.element)).toEqual(['First']);
    expect(walk.undecided?.element).toBe('Check label');
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
        assign('Owner_Set', '$Record.Out__c', str('owned'), 'Note'),
        assign('Note', 'note', str('n'), 'Make'),
        `<recordCreates><name>Make</name><object>Task</object>${next('Owner_Set')}</recordCreates>`,
        customError('Fail', 'Nope'),
      ].join(''),
    );
    const walk = walkFlow(graph, new Map());
    expect(walk.writes.map((w) => w.element)).toEqual(['First']);
    expect(walk.undecided?.element).toBe('Check label');
    expect(
      walk.undecided?.outcomes.map((o) => [
        o.label,
        o.writes.map((w) => w.element),
        o.variables.map((v) => v.variable),
        o.creates.map((c) => c.element),
        o.customError,
      ]),
    ).toEqual([
      ['Has_Owner label', ['Owner_Set'], ['note'], ['Make'], false],
      ['Default Outcome', [], [], [], true],
    ]);
  });

  it('reports a custom error on the path, with or without a message', () => {
    expect(walkFlow(graphOf(customError('First', 'Set the date')), new Map()).customError).toEqual({
      element: 'First',
      message: 'Set the date',
    });
    expect(walkFlow(graphOf(customError('First')), new Map()).customError).toEqual({ element: 'First' });
  });

  it('stops at a loop and lists what can happen after it', () => {
    const graph = graphOf(
      `<loops><name>First</name><nextValueConnector><targetReference>Set</targetReference></nextValueConnector><noMoreValuesConnector><targetReference>Done</targetReference></noMoreValuesConnector></loops>${assign('Set', '$Record.A__c', str('a'), 'First')}${assign('Done', '$Record.B__c', ref('var'))}`,
    );
    const outcome = walkFlow(graph, new Map()).undecided?.outcomes[0];
    expect(outcome?.label).toBe('after First');
    expect(outcome?.writes.map((w) => `${w.field}=${w.value.apexValue ?? w.value.rawValue}`)).toEqual([
      "A__c='a'",
      'B__c=var',
    ]);
  });

  it('forgets a field the Flow sets to something it cannot know', () => {
    const graph = graphOf(
      [
        assign('First', '$Record.A__c', ref('var'), 'Check'),
        decision('Check', rule('R', condition('$Record.A__c', 'IsNull', bool(true)), 'Set')),
        assign('Set', '$Record.Out__c', str('x')),
      ].join(''),
    );
    expect(walkFlow(graph, state({ '$Record.A__c': null })).undecided?.element).toBe('Check label');
  });
});
