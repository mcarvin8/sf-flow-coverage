import { describe, expect, it } from 'vitest';

import { apexClassMetaXml, apexTestClassName, flowKind, generateApexTest } from '../../src/core/apexTemplate.js';
import { parseFlowXml } from '../../src/core/flowXml.js';
import type { FlowMetadata } from '../../src/core/types.js';
import { readFlowFixture } from '../helpers.js';

const fixture = async (name: string): Promise<FlowMetadata> => parseFlowXml(name, await readFlowFixture(name));

const base: FlowMetadata = { name: 'X', processType: 'AutoLaunchedFlow', filters: [], variables: [] };

describe('apexTestClassName', () => {
  it('appends _FlowTest', () => {
    expect(apexTestClassName('Account_After_Save')).toBe('Account_After_Save_FlowTest');
  });

  it('keeps names within 40 characters', () => {
    const name = apexTestClassName('A_Very_Long_Flow_Name_That_Goes_On_And_On_Forever');
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name).toMatch(/^A_Very_Long.*_FlowTest$/);
    expect(name).not.toContain('__');
  });

  it('produces a valid identifier', () => {
    expect(apexTestClassName('1st-Flow')).toBe('F1st_Flow_FlowTest');
    expect(apexTestClassName('_x__y_')).toBe('x_y_FlowTest');
  });
});

describe('flowKind', () => {
  it('classifies Flows', () => {
    expect(flowKind({ ...base, triggerType: 'RecordAfterSave', object: 'Account' })).toBe('record');
    expect(flowKind({ ...base, triggerType: 'RecordAfterSave' })).toBe('autolaunched');
    expect(flowKind({ ...base, triggerType: 'PlatformEvent', object: 'E__e' })).toBe('platformEvent');
    expect(flowKind({ ...base, triggerType: 'Scheduled' })).toBe('scheduled');
    expect(flowKind(base)).toBe('autolaunched');
    expect(flowKind({ ...base, processType: 'Workflow' })).toBe('process');
    expect(flowKind({ ...base, processType: undefined })).toBe('process');
  });
});

describe('generateApexTest', () => {
  it('creates and updates a record for a CreateAndUpdate Flow', async () => {
    const test = generateApexTest(await fixture('Account_After_Save'));
    expect(test.className).toBe('Account_After_Save_FlowTest');
    expect(test.kind).toBe('record');
    expect(test.body).toMatchSnapshot();
  });

  it('updates a record for an Update Flow and leaves cross-object criteria as TODOs', async () => {
    const test = generateApexTest(await fixture('Case_Update'));
    expect(test.body).toContain('testRecord.IsEscalated = true;');
    expect(test.body).toContain('// TODO: entry criteria: Account.Name EqualTo Acme');
    expect(test.body).toContain('// TODO: entry criteria logic: 1 OR (2 AND 3)');
    expect(test.body).not.toContain('runsFlowOnCreate');
    expect(test.body).toMatchSnapshot();
  });

  it('adds a TODO to change fields when an Update Flow has no criteria', () => {
    const test = generateApexTest({
      ...base,
      triggerType: 'RecordAfterSave',
      recordTriggerType: 'Update',
      object: 'Account',
    });
    expect(test.body).toContain('// TODO: change the fields this Flow reacts to');
  });

  it('deletes a record for a Delete Flow', async () => {
    const test = generateApexTest(await fixture('Invoice_Before_Delete'));
    expect(test.body).toContain('delete testRecord;');
    expect(test.body).toContain('// TODO: set the required fields for Invoice__c');
    expect(test.body).toContain('// TODO: entry criteria formula: {!$Record.Locked__c} = true');
    expect(test.body).toMatchSnapshot();
  });

  it('creates a record for a Create Flow, with date and number criteria', async () => {
    const test = generateApexTest(await fixture('Opportunity_Create'));
    expect(test.body).toContain("CloseDate = Date.valueOf('2026-12-31')");
    expect(test.body).toContain('Probability = 50');
    expect(test.body).toContain('// TODO: entry criteria: OwnerId EqualTo $User.Id');
    expect(test.body).toContain('// TODO: entry criteria: Description IsNull');
    expect(test.body).toMatchSnapshot();
  });

  it('starts an autolaunched Flow with its inputs and reads its outputs', async () => {
    const test = generateApexTest(await fixture('Calculate_Discount'));
    expect(test.kind).toBe('autolaunched');
    expect(test.body).toContain("Flow.Interview.createInterview('Calculate_Discount', inputs);");
    expect(test.body).toContain("Object discountOutput = interview.getVariableValue('discount');");
    expect(test.body).not.toContain('internalCounter');
    expect(test.body).toMatchSnapshot();
  });

  it('maps collection inputs by type', () => {
    const variable = { isInput: true, isOutput: false, isCollection: true };
    const test = generateApexTest({
      ...base,
      variables: [
        { ...variable, name: 'nums', dataType: 'Number' },
        { ...variable, name: 'flags', dataType: 'Boolean' },
        { ...variable, name: 'days', dataType: 'Date' },
        { ...variable, name: 'times', dataType: 'DateTime' },
        { ...variable, name: 'recs', dataType: 'SObject' },
      ],
    });
    expect(test.body).toContain("inputs.put('nums', new List<Decimal>());");
    expect(test.body).toContain("inputs.put('flags', new List<Boolean>());");
    expect(test.body).toContain("inputs.put('days', new List<Date>());");
    expect(test.body).toContain("inputs.put('times', new List<Datetime>());");
    expect(test.body).toContain("inputs.put('recs', null); // TODO: SObject collection");
  });

  it('publishes the event for a platform event Flow', async () => {
    const test = generateApexTest(await fixture('Order_Event_Handler'));
    expect(test.kind).toBe('platformEvent');
    expect(test.body).toContain("Status__c = 'Shipped'");
    expect(test.body).toContain('Test.getEventBus().deliver();');
    expect(test.body).not.toContain('TODO: set the required fields');
    expect(test.body).toMatchSnapshot();
  });

  it('starts a scheduled Flow directly, noting the $Record limitation', async () => {
    const withObject = generateApexTest(await fixture('Nightly_Cleanup'));
    expect(withObject.kind).toBe('scheduled');
    expect(withObject.body).toContain('runs for Lead records on a schedule');
    const withoutObject = generateApexTest(await fixture('Weekly_Digest'));
    expect(withoutObject.body).toContain('this Flow runs on a schedule; it is started directly here.');
  });

  it('writes a placeholder for Process Builder processes', async () => {
    const test = generateApexTest(await fixture('Contact_Process'));
    expect(test.kind).toBe('process');
    expect(test.body).toContain('// TODO: Workflow processes start when a record changes');
    expect(generateApexTest({ ...base, processType: undefined }).body).toContain('Process type unknown.');
    expect(generateApexTest({ ...base, processType: undefined }).body).toContain('// TODO: This processes');
  });

  it('omits the label when there is none and escapes the Flow name', () => {
    const test = generateApexTest({ ...base, name: "O'Brien" });
    expect(test.body).toContain("for the Flow O'Brien.\n");
    expect(test.body).toContain("createInterview('O\\'Brien', inputs)");
  });
});

describe('apexClassMetaXml', () => {
  it('writes the API version', () => {
    expect(apexClassMetaXml('64.0')).toContain('<apiVersion>64.0</apiVersion>');
  });
});
