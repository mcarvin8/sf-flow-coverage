import { describe, expect, it } from 'vitest';

import { generateApexTest } from '../../src/core/apexTemplate.js';
import { apexTodos } from '../../src/core/apexTodos.js';
import { parseFlowXml } from '../../src/core/flowXml.js';

describe('apexTodos', () => {
  it('reads header, line, and inline TODOs with their method and kind', () => {
    const flow = parseFlowXml(
      'Job_Flow',
      `<Flow><processType>AutoLaunchedFlow</processType><start>
        <filterFormula>AND({!$Record.Status__c} = "Open", FOO())</filterFormula>
        <object>Job__c</object><recordTriggerType>Create</recordTriggerType><triggerType>RecordAfterSave</triggerType>
      </start></Flow>`,
    );
    const body = generateApexTest(flow, {
      requiredFields: { Job__c: { Account__c: 'null /* TODO: set a Account Id */' } },
      inaccessibleFields: { Job__c: ['Secret__c'] },
    }).body;
    const todos = apexTodos(body);
    expect(todos[0]).toEqual({
      text: 'the Flow uses fields the user who generated this test can\'t see: Job__c: Secret__c If the user who runs tests can\'t see them either, the Flow can fail with "Operation failed due to fields being inaccessible". Grant access with a permission set assigned to that user.',
    });
    expect(todos).toContainEqual({ method: 'runsFlowOnCreate', text: 'set a Account Id' });
    expect(todos).toContainEqual({
      method: 'runsFlowOnCreate',
      kind: 'entry criteria formula term',
      text: 'entry criteria formula term: FOO()',
    });
    expect(todos).toContainEqual({ method: 'runsFlowOnCreate', text: 'query and assert the fields this Flow sets' });
  });

  it('reads TODOs at the end of a line, and one header TODO after another', () => {
    const body = [
      '/**',
      ' * Starter test.',
      ' *',
      ' * TODO: first note',
      ' * TODO: second note,',
      ' *   which goes on',
      ' */',
      '@IsTest',
      'private class X {',
      '    @IsTest',
      '    static void runsFlow() {',
      "        inputs.put('a', null); // TODO: the Id of a Job__c record",
      '    }',
      '    private static Id newGroupId() {',
      '    }',
      '}',
    ].join('\n');
    expect(apexTodos(body)).toEqual([
      { text: 'first note' },
      { text: 'second note, which goes on' },
      { method: 'runsFlow', text: 'the Id of a Job__c record' },
    ]);
    expect(apexTodos('')).toEqual([]);
  });
});
