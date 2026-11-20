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

  it('updates a record for an Update Flow, meeting custom filter logic through one branch', async () => {
    const test = generateApexTest(await fixture('Case_Update'));
    // 1 OR (2 AND 3): the first filter alone meets it, so the cross-object filter isn't needed.
    expect(test.body).toContain('testRecord.IsEscalated = true;');
    expect(test.body).not.toContain('TODO: entry criteria');
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

  it('deletes a record for a Delete Flow, meeting its formula criteria', async () => {
    const test = generateApexTest(await fixture('Invoice_Before_Delete'));
    expect(test.body).toContain('delete testRecord;');
    expect(test.body).toContain('// TODO: set the required fields for Invoice__c');
    expect(test.body).toContain('Locked__c = true');
    expect(test.body).not.toContain('TODO: entry criteria');
    expect(test.body).toMatchSnapshot();
  });

  it('creates a record for a Create Flow, with date and number criteria', async () => {
    const test = generateApexTest(await fixture('Opportunity_Create'));
    expect(test.body).toContain("CloseDate = Date.valueOf('2026-12-31')");
    expect(test.body).toContain('Probability = 50');
    expect(test.body).toContain('OwnerId = UserInfo.getUserId()');
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
    expect(test.body).toContain(
      [
        '    static void runsProcess() {',
        '        // Salesforce no longer supports Process Builder.',
        '        // Migrate processes to Flows with the Migrate to Flow tool in Setup rather than writing tests for them; each migrated Flow still needs an Apex test.',
        '        // TODO: Process Builder (record change) processes start when a record changes or an event fires.',
      ].join('\n'),
    );
    const unknown = generateApexTest({ ...base, processType: undefined }).body;
    expect(unknown).toContain('Process type unknown.');
    expect(unknown).toContain('    static void runsProcess() {\n        // TODO: These processes');
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

describe('generateApexTest assertions from the Flow', () => {
  /** A before-save Flow on Job__c with the given elements; `First` is the first element. */
  const jobFlow = (elements: string, recordTriggerType = 'Create', filters = ''): FlowMetadata =>
    parseFlowXml(
      'Job_Flow',
      `<Flow><processType>AutoLaunchedFlow</processType>${elements}<start>
        <connector><targetReference>First</targetReference></connector>${filters}
        <object>Job__c</object><recordTriggerType>${recordTriggerType}</recordTriggerType><triggerType>RecordBeforeSave</triggerType>
      </start></Flow>`,
    );
  const assign = (name: string, field: string, value: string, next = ''): string =>
    `<assignments><name>${name}</name><assignmentItems><assignToReference>$Record.${field}</assignToReference><operator>Assign</operator><value>${value}</value></assignmentItems>${next ? `<connector><targetReference>${next}</targetReference></connector>` : ''}</assignments>`;
  const nullCheck = (name: string, field: string, yes: string, no: string): string =>
    `<decisions><name>${name}</name><label>${name.replace(/_/g, ' ')}</label><defaultConnector><targetReference>${no}</targetReference></defaultConnector><defaultConnectorLabel>Has ${field}</defaultConnectorLabel><rules><name>No_${field}</name><label>No ${field}</label><conditionLogic>and</conditionLogic><conditions><leftValueReference>$Record.${field}</leftValueReference><operator>IsNull</operator><rightValue><booleanValue>true</booleanValue></rightValue></conditions><connector><targetReference>${yes}</targetReference></connector></rules></decisions>`;
  const error = (name: string, message: string): string =>
    `<customErrors><name>${name}</name><customErrorMessages><errorMessage>${message}</errorMessage></customErrorMessages></customErrors>`;
  const filter = (field: string, value: string): string =>
    `<filters><field>${field}</field><operator>EqualTo</operator><value><stringValue>${value}</stringValue></value></filters>`;
  const nullWhenUnset = { Job__c: ['Due__c', 'Owner__c'] };

  it('asserts the fields the Flow is certain to set', () => {
    const test = generateApexTest(
      jobFlow(
        assign('First', 'Status__c', '<stringValue>Scheduled</stringValue>', 'Second') +
          assign('Second', 'Hours__c', '<numberValue>3.0</numberValue>', 'Third') +
          assign('Third', 'Note__c', '<elementReference>$Record.Name</elementReference>'),
      ),
    );
    expect(test.body).toContain(
      [
        '        Job__c result = [SELECT Id, Status__c, Hours__c, Note__c FROM Job__c WHERE Id = :testRecord.Id];',
        "        Assert.areEqual('Scheduled', result.Status__c, 'First should set Status__c');",
        "        Assert.areEqual(3.0, result.Hours__c, 'Second should set Hours__c');",
        '        // TODO: Third sets Note__c to $Record.Name; assert it',
      ].join('\n'),
    );
    expect(test.body).not.toContain('Assert.isNotNull');
    expect(test.body).toMatchSnapshot();
  });

  it('follows decisions the record state settles, and comments out what other branches would do', () => {
    const elements =
      nullCheck('First', 'Due__c', 'Set_Due', 'Owner_Check') +
      assign('Set_Due', 'Due__c', '<dateValue>2026-01-31</dateValue>', 'Owner_Check') +
      nullCheck('Owner_Check', 'Reviewer__c', 'Flag', 'Done') +
      assign('Flag', 'Flagged__c', '<booleanValue>true</booleanValue>', 'Done') +
      assign('Done', 'Status__c', '<stringValue>Done</stringValue>');
    const test = generateApexTest(jobFlow(elements), { nullWhenUnset });
    expect(test.body).toContain(
      "Assert.areEqual(Date.valueOf('2026-01-31'), result.Due__c, 'Set_Due should set Due__c');",
    );
    expect(test.body).toContain("        // Assert.areEqual('Done', result.Status__c, 'Done should set Status__c');");
    expect(test.body).not.toContain("        Assert.areEqual('Done', result.Status__c");
    expect(test.body).toContain('// TODO: when Owner Check takes "No Reviewer__c", the Flow also:');
    expect(test.body).toContain("// Assert.areEqual(true, result.Flagged__c, 'Flag should set Flagged__c');");
    expect(test.body).toContain('// TODO: when Owner Check takes "Has Reviewer__c", the Flow also:');
    expect(test.body).toContain('SELECT Id, Due__c, Flagged__c, Status__c FROM');
    expect(test.body).toMatchSnapshot();
  });

  it('expects the custom error the Flow is certain to raise', () => {
    const elements =
      nullCheck('First', 'Due__c', 'No_Date', 'Fine') +
      error('No_Date', "Set the job's due date") +
      assign('Fine', 'Ok__c', '<booleanValue>true</booleanValue>');
    const update = generateApexTest(jobFlow(elements, 'Update', filter('Status__c', 'Closed')), { nullWhenUnset });
    expect(update.body).toContain(
      [
        '        Test.startTest();',
        "        testRecord.Status__c = 'Closed';",
        '        try {',
        '            update testRecord;',
        "            Assert.fail('No_Date should block this save with a custom error');",
        '        } catch (DmlException e) {',
        "            Assert.isTrue(e.getMessage().contains('Set the job\\'s due date'), e.getMessage());",
        '        }',
        '        Test.stopTest();',
        '    }',
      ].join('\n'),
    );
    expect(update.body).not.toContain('result');
    expect(update.body).toMatchSnapshot();

    const merged = generateApexTest(
      jobFlow(
        nullCheck('First', 'Due__c', 'No_Date', 'Fine') + error('No_Date', '{!$Record.Name} needs a date'),
        'Delete',
      ),
      { nullWhenUnset },
    );
    expect(merged.body).toContain('            delete testRecord;');
    expect(merged.body).toContain("Assert.isNotNull(e.getMessage(), 'The custom error should have a message');");
    expect(merged.body).not.toContain('SELECT COUNT()');
  });

  it('keeps the delete test when no custom error is certain', () => {
    const test = generateApexTest(
      jobFlow(nullCheck('First', 'Due__c', 'No_Date', 'Fine') + error('No_Date', 'x'), 'Delete'),
    );
    expect(test.body).toContain('SELECT COUNT() FROM Job__c');
    expect(test.body).not.toContain('try {');
  });

  it('asserts nothing when the test may not meet the entry criteria or change the record', () => {
    const elements = assign('First', 'Status__c', '<stringValue>Done</stringValue>');
    const unmet = generateApexTest(
      jobFlow(
        elements,
        'Create',
        '<filters><field>Total__c</field><operator>EqualTo</operator><value><elementReference>$Record.Limit__c</elementReference></value></filters>',
      ),
    );
    expect(unmet.body).toContain('// TODO: query and assert the fields this Flow sets');
    expect(unmet.body).not.toContain('Assert.areEqual');

    const unchanged = generateApexTest(jobFlow(elements, 'Update', filter('Name', 'Test')), {
      requiredFields: { Job__c: { Name: "'Test'" } },
    });
    expect(unchanged.body).toContain("Assert.isNotNull(result.Id, 'The Job__c should still exist');");
    expect(unchanged.body).not.toContain('Assert.areEqual');

    const noWrites = generateApexTest(jobFlow('<recordLookups><name>First</name></recordLookups>'));
    expect(noWrites.body).toContain('// TODO: query and assert the fields this Flow sets');
  });

  it('treats fields the Flow writes as unknown in the update test of a create-and-update Flow', () => {
    const elements =
      nullCheck('First', 'Due__c', 'Set_Due', 'Done') +
      assign('Set_Due', 'Due__c', '<dateValue>2026-01-31</dateValue>', 'Done') +
      assign('Done', 'Status__c', '<stringValue>Done</stringValue>');
    const test = generateApexTest(jobFlow(elements, 'CreateAndUpdate', filter('Stage__c', 'Open')), { nullWhenUnset });
    const [create, update] = test.body.split('runsFlowOnUpdate');
    expect(create).toContain("Assert.areEqual(Date.valueOf('2026-01-31'), result.Due__c");
    expect(create).toContain("Assert.areEqual('Done', result.Status__c");
    expect(update).toContain('// TODO: when First takes "No Due__c", the Flow also:');
    expect(update).toContain("Assert.areEqual('Done', result.Status__c");
  });

  it('reads a required lookup left empty as null', () => {
    const elements =
      nullCheck('First', 'Account__c', 'Set', 'Other') +
      assign('Set', 'A__c', '<stringValue>a</stringValue>') +
      assign('Other', 'A__c', '<stringValue>b</stringValue>');
    const test = generateApexTest(jobFlow(elements), {
      requiredFields: { Job__c: { Account__c: 'null /* TODO: set a Account Id */' } },
    });
    expect(test.body).toContain("Assert.areEqual('a', result.A__c, 'Set should set A__c');");
  });
});

describe('generateApexTest entry-criteria operators', () => {
  const recordFlow = (filters: FlowMetadata['filters'], recordTriggerType = 'Create'): FlowMetadata => ({
    ...base,
    triggerType: 'RecordAfterSave',
    recordTriggerType,
    object: 'Job__c',
    filters,
  });

  it('picks a value past or at each comparison bound', () => {
    const test = generateApexTest(
      recordFlow([
        { field: 'Hours__c', operator: 'GreaterThan', apexValue: '1000.0', rawValue: '1000.0' },
        { field: 'Rate__c', operator: 'LessThan', apexValue: '0.5', rawValue: '0.5' },
        { field: 'Crew__c', operator: 'GreaterThanOrEqualTo', apexValue: '5', rawValue: '5' },
        { field: 'Due__c', operator: 'LessThan', apexValue: "Date.valueOf('2026-01-31')", rawValue: '2026-01-31' },
        { field: 'Start__c', operator: 'LessThanOrEqualTo', apexValue: "Date.valueOf('2026-02-01')", rawValue: 'x' },
        {
          field: 'Sent__c',
          operator: 'GreaterThan',
          apexValue: "Datetime.valueOfGmt('2026-01-31 09:30:00')",
          rawValue: '2026-01-31T09:30:00Z',
        },
      ]),
    );
    expect(test.body).toContain('Hours__c = 1001,');
    expect(test.body).toContain('Rate__c = -0.5,');
    expect(test.body).toContain('Crew__c = 5,');
    expect(test.body).toContain("Due__c = Date.valueOf('2026-01-31').addDays(-1),");
    expect(test.body).toContain("Start__c = Date.valueOf('2026-02-01'),");
    expect(test.body).toContain("Sent__c = Datetime.valueOfGmt('2026-01-31 09:30:00').addSeconds(1)");
    expect(test.body).not.toContain('TODO: entry criteria');
  });

  it('uses the string itself for Contains, StartsWith, and EndsWith', () => {
    const test = generateApexTest(
      recordFlow([
        { field: 'A__c', operator: 'Contains', apexValue: "'urgent'", rawValue: 'urgent' },
        { field: 'B__c', operator: 'StartsWith', apexValue: "'INV-'", rawValue: 'INV-' },
        { field: 'C__c', operator: 'EndsWith', apexValue: "'.pdf'", rawValue: '.pdf' },
      ]),
    );
    expect(test.body).toContain("A__c = 'urgent',");
    expect(test.body).toContain("B__c = 'INV-',");
    expect(test.body).toContain("C__c = '.pdf'");
    expect(test.body).not.toContain('TODO: entry criteria');
  });

  it('leaves a TODO when no value can meet the filter', () => {
    const test = generateApexTest(
      recordFlow([
        { field: 'A__c', operator: 'GreaterThan', apexValue: "'m'", rawValue: 'm' },
        { field: 'B__c', operator: 'LessThan', rawValue: '$Record.Max__c' },
        { field: 'C__c', operator: 'Contains', apexValue: '5', rawValue: '5' },
        { field: 'D__c', operator: 'Contains', rawValue: 'Other.Field' },
        { field: 'E__c', operator: 'NotEqualTo', apexValue: "'x'", rawValue: 'x' },
      ]),
    );
    for (const todo of [
      'A__c GreaterThan m',
      'B__c LessThan $Record.Max__c',
      'C__c Contains 5',
      'D__c Contains Other.Field',
      'E__c NotEqualTo x',
    ]) {
      expect(test.body).toContain(`// TODO: entry criteria: ${todo}`);
    }
  });

  describe('formulas', () => {
    const formulaFlow = (filterFormula: string, recordTriggerType = 'Create'): FlowMetadata => ({
      ...recordFlow([], recordTriggerType),
      filterFormula,
    });

    it('meets each term of an AND formula it can read, with describe values for ISBLANK', () => {
      const test = generateApexTest(
        formulaFlow(
          `AND(
  NOT(ISBLANK({!$Record.Crew_Size__c})),
  ISPICKVAL({!$Record.Status__c}, "Planned"),
  {!$Record.Hours__c} > 8
)`,
          'Update',
        ),
        { fieldValues: { Job__c: { Crew_Size__c: '1' } } },
      );
      expect(test.body).toContain('testRecord.Crew_Size__c = 1;');
      expect(test.body).toContain("testRecord.Status__c = 'Planned';");
      expect(test.body).toContain('testRecord.Hours__c = 9;');
      expect(test.body).not.toContain('TODO: entry criteria');
    });

    it('leaves a TODO per term it cannot meet', () => {
      const test = generateApexTest(
        formulaFlow(`AND(
  ISPICKVAL({!$Record.Status__c}, "Planned"),
  NOT(ISBLANK({!$Record.Crew_Size__c})),
  {!$Record.Account.Type}   =  "Partner"
)`),
      );
      expect(test.body).toContain("Status__c = 'Planned'");
      expect(test.body).toContain('// TODO: entry criteria formula term: NOT(ISBLANK({!$Record.Crew_Size__c}))');
      expect(test.body).toContain('// TODO: entry criteria formula term: {!$Record.Account.Type} = "Partner"');
      expect(test.body).not.toContain('TODO: entry criteria formula: ');
    });

    it('meets criteria on a related record by setting fields on the parent it inserts', () => {
      const test = generateApexTest(formulaFlow('ISPICKVAL({!$Record.Account__r.Type}, "Partner")'), {
        requiredFields: { Job__c: { Account__c: 'null /* TODO */' }, Account: { Name: "'Test'" } },
        lookups: { Job__c: { Account__c: 'Account' } },
        relationships: { Job__c: { Account__r: 'Account__c' } },
      });
      expect(test.body).toContain(
        [
          '        Account accountParent = new Account(',
          "            Name = 'Test',",
          "            Type = 'Partner'",
          '        );',
          '        insert accountParent;',
          '',
          '        Job__c testRecord = new Job__c(',
          '            Account__c = accountParent.Id',
        ].join('\n'),
      );
      expect(test.body).not.toContain('TODO: entry criteria');
    });

    it('sets prior values in the insert and the new values in the update', () => {
      const test = generateApexTest(
        formulaFlow(
          'AND(ISPICKVAL({!$Record.Stage__c}, "Done"), ISPICKVAL(PRIORVALUE({!$Record.Stage__c}), "Open"))',
          'Update',
        ),
      );
      expect(test.body).toContain("        Job__c testRecord = new Job__c(\n            Stage__c = 'Open'\n        );");
      expect(test.body).toContain("testRecord.Stage__c = 'Done';");
      expect(test.body).not.toContain('TODO: entry criteria');
    });

    it('meets NotEqualTo, field-to-field comparisons, and date functions', () => {
      const test = generateApexTest(
        formulaFlow(
          'AND({!$Record.Kind__c} <> "Draft", {!$Record.Hours__c} > {!$Record.Cap__c}, {!$Record.Due__c} < TODAY())',
        ),
        { fieldValues: { Job__c: { Kind__c: "'Final'", Cap__c: '4' } } },
      );
      expect(test.body).toContain("Kind__c = 'Final',");
      expect(test.body).toContain('Cap__c = 4,');
      expect(test.body).toContain('Hours__c = 5,');
      expect(test.body).toContain('Due__c = Date.today().addDays(-1)');
      expect(test.body).not.toContain('TODO: entry criteria');
    });

    it('meets an OR formula through one branch, and leaves a formula it cannot read as one TODO', () => {
      expect(generateApexTest(formulaFlow('OR({!$Record.A__c}, {!$Record.B__c})')).body).toContain('A__c = true');
      const test = generateApexTest(formulaFlow('OR({!$Record.A__c} ~ 1)', 'Delete'));
      expect(test.body).toContain('delete testRecord;');
      expect(test.body).toContain('// TODO: entry criteria formula: OR({!$Record.A__c} ~ 1)');
    });
  });

  describe('IsChanged', () => {
    const changedValues = { Job__c: { Status__c: "'Done'", Notes__c: "'Changed'" } };

    it('changes the field in the update test, and leaves a TODO in the create test', () => {
      const test = generateApexTest(
        recordFlow(
          [{ field: 'Notes__c', operator: 'IsChanged', apexValue: 'true', rawValue: 'true' }],
          'CreateAndUpdate',
        ),
        { changedValues },
      );
      const [create, update] = test.body.split('runsFlowOnUpdate');
      expect(create).toContain('// TODO: entry criteria: Notes__c IsChanged true');
      expect(update).toContain("testRecord.Notes__c = 'Changed';");
      expect(update).not.toContain('TODO: entry criteria');
    });

    it('counts a field another filter already sets as changed', () => {
      const test = generateApexTest(
        recordFlow(
          [
            { field: 'Status__c', operator: 'EqualTo', apexValue: "'Closed'", rawValue: 'Closed' },
            { field: 'Status__c', operator: 'IsChanged', apexValue: 'true', rawValue: 'true' },
          ],
          'Update',
        ),
        { changedValues },
      );
      expect(test.body).toContain("testRecord.Status__c = 'Closed';");
      expect(test.body).not.toContain("testRecord.Status__c = 'Done';");
      expect(test.body).not.toContain('TODO: entry criteria');
    });

    it('meets IsChanged false by leaving the field alone, unless another filter sets it', () => {
      const test = generateApexTest(
        recordFlow(
          [
            { field: 'Notes__c', operator: 'IsChanged', apexValue: 'false', rawValue: 'false' },
            { field: 'Status__c', operator: 'EqualTo', apexValue: "'Closed'", rawValue: 'Closed' },
            { field: 'Status__c', operator: 'IsChanged', apexValue: 'false', rawValue: 'false' },
            { field: 'Odd__c', operator: 'IsChanged', rawValue: '$Flow.Thing' },
          ],
          'Update',
        ),
      );
      expect(test.body).not.toContain('Notes__c IsChanged false');
      expect(test.body).toContain('// TODO: entry criteria: Status__c IsChanged false');
      expect(test.body).toContain('// TODO: entry criteria: Odd__c IsChanged $Flow.Thing');
    });

    it('leaves a TODO without a changed value from the org describe', () => {
      const test = generateApexTest(
        recordFlow([{ field: 'Rating', operator: 'IsChanged', apexValue: 'true', rawValue: 'true' }], 'Update'),
      );
      expect(test.body).toContain('// TODO: entry criteria: Rating IsChanged true');
    });
  });
});
