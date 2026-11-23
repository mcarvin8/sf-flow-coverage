import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { approvalConflictNote, approvalSubmit } from '../../src/core/approvals.js';
import { scaffoldTests } from '../../src/core/scaffold.js';

const submitAction = (record = '$Record.Id') =>
  `<actionCalls><name>Submit</name><actionName>submit</actionName><actionType>submit</actionType>
    <inputParameters><name>objectId</name><value><elementReference>${record}</elementReference></value></inputParameters>
  </actionCalls>`;

const recordFlow = (trigger: string, body = submitAction(), status = 'Active', object = 'Job__c') =>
  `<Flow><processType>AutoLaunchedFlow</processType><status>${status}</status>${body}
    <start><connector><targetReference>Submit</targetReference></connector><object>${object}</object>
      <recordTriggerType>${trigger}</recordTriggerType><triggerType>RecordAfterSave</triggerType></start></Flow>`;

const process = (trigger: string) =>
  `<Flow><processType>Workflow</processType><status>Active</status>${submitAction('myVariable_current.Id')}
    <processMetadataValues><name>ObjectType</name><value><stringValue>Job__c</stringValue></value></processMetadataValues>
    <processMetadataValues><name>TriggerType</name><value><stringValue>${trigger}</stringValue></value></processMetadataValues>
  </Flow>`;

describe('approvalSubmit', () => {
  it('reads when a record-triggered Flow submits its record', () => {
    expect(approvalSubmit('A', recordFlow('Create'))).toEqual({
      flowName: 'A',
      object: 'Job__c',
      onCreate: true,
      onUpdate: false,
    });
    expect(approvalSubmit('A', recordFlow('Update'))).toMatchObject({ onCreate: false, onUpdate: true });
    expect(approvalSubmit('A', recordFlow('CreateAndUpdate'))).toMatchObject({ onCreate: true, onUpdate: true });
    expect(
      approvalSubmit('A', recordFlow('Create').replace(/<recordTriggerType>Create<\/recordTriggerType>/, '')),
    ).toMatchObject({
      onCreate: true,
    });
  });

  it('reads when a Process Builder process submits its record', () => {
    expect(approvalSubmit('P', process('onCreateOnly'))).toEqual({
      flowName: 'P',
      object: 'Job__c',
      onCreate: true,
      onUpdate: false,
    });
    expect(approvalSubmit('P', process('onAllChanges'))).toMatchObject({ onCreate: true, onUpdate: true });
    expect(approvalSubmit('P', process('onSomething'))).toBeUndefined();
  });

  it('ignores inactive Flows, other actions, other records, and Flows without a trigger', () => {
    expect(approvalSubmit('A', recordFlow('Create', submitAction(), 'Draft'))).toBeUndefined();
    expect(approvalSubmit('A', recordFlow('Create', submitAction('Get_Parent.Id')))).toBeUndefined();
    expect(
      approvalSubmit(
        'A',
        recordFlow('Create', '<actionCalls><name>Submit</name><actionType>apex</actionType></actionCalls>'),
      ),
    ).toBeUndefined();
    expect(
      approvalSubmit(
        'A',
        recordFlow('Create', '<actionCalls><name>Submit</name><actionType>submit</actionType></actionCalls>'),
      ),
    ).toBeUndefined();
    expect(
      approvalSubmit(
        'A',
        `<Flow><processType>AutoLaunchedFlow</processType><status>Active</status>${submitAction()}</Flow>`,
      ),
    ).toBeUndefined();
    expect(approvalSubmit('A', '<NotAFlow/>')).toBeUndefined();
  });
});

describe('approvalConflictNote', () => {
  const submit = (flowName: string, onCreate: boolean, onUpdate: boolean, object = 'Job__c') => ({
    flowName,
    object,
    onCreate,
    onUpdate,
  });

  it('names other automation that submits the record when it is created', () => {
    const subject = submit('Mine', false, true);
    expect(
      approvalConflictNote(subject, [subject, submit('Other', true, false), submit('Elsewhere', true, false, 'Case')]),
    ).toEqual([
      'TODO: this Flow submits the Job__c for approval, and Other also submits a Job__c for approval when one is created.',
      'A record already in an approval process makes the submit fail with ALREADY_IN_PROCESS.',
      "Whether a new record should be submitted is the org's rule: set the record up so only one",
      "submit runs, for example by leaving the other automation's entry criteria unmet.",
    ]);
    expect(approvalConflictNote(subject, [submit('A', true, false), submit('B', true, true)])?.[0]).toContain(
      'A, B also submit a Job__c',
    );
  });

  it('explains a create-and-update Flow submitting on the update test insert', () => {
    const subject = submit('Mine', true, true);
    expect(approvalConflictNote(subject, [subject])?.[0]).toBe(
      "TODO: this Flow submits the Job__c for approval, and the update test's insert already runs this Flow on create, which submits it.",
    );
  });

  it('says nothing when nothing else submits the record', () => {
    const subject = submit('Mine', false, true);
    expect(approvalConflictNote(subject, [subject, submit('Updates', false, true)])).toBeUndefined();
  });
});

describe('scaffoldTests and approval submits', () => {
  it('reads the other Flows in the project only when a Flow it scaffolds submits for approval', async () => {
    const project = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-approval-'));
    try {
      mkdirSync(join(project, 'flows'));
      const write = (name: string, xml: string) => writeFileSync(join(project, 'flows', `${name}.flow-meta.xml`), xml);
      write('Submit_On_Update', recordFlow('Update'));
      write('Submit_On_Create', recordFlow('Create'));
      write('Plain', recordFlow('Update', ''));
      write('Broken', '<Flow><unclosed>');
      const run = async (flowNames: string[]) => {
        await scaffoldTests({ flowNames, projectDir: project, outputDir: join(project, 'out'), force: true });
        return (name: string) => readFileSync(join(project, 'out', `${name}_FlowTest.cls`), 'utf8');
      };
      const read = await run(['Submit_On_Update', 'Plain']);
      expect(read('Submit_On_Update')).toContain(
        ' * TODO: this Flow submits the Job__c for approval, and Submit_On_Create also submits a Job__c for approval when one is created.',
      );
      expect(read('Plain')).not.toContain('approval');
      expect((await run(['Plain']))('Plain')).not.toContain('approval');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
