import { describe, expect, it } from 'vitest';

import { generateApexTest } from '../../src/core/apexTemplate.js';
import { parseFlowXml } from '../../src/core/flowXml.js';

const variable = (name: string, dataType: string, extra = '') =>
  `<variables><name>${name}</name><dataType>${dataType}</dataType><isInput>true</isInput><isOutput>false</isOutput><isCollection>false</isCollection>${extra}</variables>`;

const autolaunched = (elements: string) =>
  parseFlowXml(
    'Calc',
    `<Flow><processType>AutoLaunchedFlow</processType>${elements}<start><connector><targetReference>First</targetReference></connector></start></Flow>`,
  );

describe('placeholder inputs', () => {
  it('gives each text input its own value, none inside another', () => {
    const test = generateApexTest(
      autolaunched(`${variable('a', 'String')}${variable('ab', 'String')}${variable('kind', 'Picklist')}`),
    );
    expect(test.body).toContain("inputs.put('a', '[a]'); // TODO: String");
    expect(test.body).toContain("inputs.put('ab', '[ab]'); // TODO: String");
    expect(test.body).toContain("inputs.put('kind', '[kind]'); // TODO: Picklist");
  });

  it('follows decisions on the value it passes', () => {
    const test = generateApexTest(
      autolaunched(
        `${variable('mode', 'String')}
        <variables><name>out</name><dataType>String</dataType><isInput>false</isInput><isOutput>true</isOutput><isCollection>false</isCollection></variables>
        <decisions><name>First</name><rules><name>Is_Mode</name><conditionLogic>and</conditionLogic>
          <conditions><leftValueReference>mode</leftValueReference><operator>EqualTo</operator><rightValue><stringValue>[mode]</stringValue></rightValue></conditions>
          <connector><targetReference>Set</targetReference></connector></rules></decisions>
        <assignments><name>Set</name><assignmentItems><assignToReference>out</assignToReference><operator>Assign</operator><value><stringValue>yes</stringValue></value></assignmentItems></assignments>`,
      ),
    );
    expect(test.body).toContain("Assert.areEqual('yes', interview.getVariableValue('out'), 'Set should set out');");
  });
});

describe('records for Delete Records to find', () => {
  const deleting = (deletes: string, requiredFields = { Task: { Subject: "'Test'" } }) =>
    generateApexTest(autolaunched(`${variable('subjectInput', 'String')}${deletes}`), { requiredFields });

  it('inserts a record that meets the filters, comparing with the inputs it passes', () => {
    const test = deleting(
      `<recordDeletes><name>First</name><object>Task</object>
        <filters><field>Status</field><operator>EqualTo</operator><value><stringValue>Completed</stringValue></value></filters>
        <filters><field>Subject</field><operator>EqualTo</operator><value><elementReference>subjectInput</elementReference></value></filters>
      </recordDeletes>`,
    );
    expect(test.body).toContain(
      [
        "        inputs.put('subjectInput', '[subjectInput]'); // TODO: String",
        '        // First fails when it finds nothing to delete.',
        '        Task firstMatch = new Task(',
        "            Subject = '[subjectInput]',",
        "            Status = 'Completed'",
        '        );',
        '        insert firstMatch;',
        '',
        '        Test.startTest();',
      ].join('\n'),
    );
  });

  it('inserts a record for a delete without filters, and for one with custom logic', () => {
    expect(deleting('<recordDeletes><name>First</name><object>Task</object></recordDeletes>').body).toContain(
      'insert firstMatch;',
    );
    const logic = deleting(
      `<recordDeletes><name>First</name><object>Task</object><filterLogic>1 OR 2</filterLogic>
        <filters><field>Status</field><operator>EqualTo</operator><value><stringValue>Completed</stringValue></value></filters>
        <filters><field>Priority</field><operator>EqualTo</operator><value><stringValue>Low</stringValue></value></filters>
      </recordDeletes>`,
    );
    expect(logic.body).toContain("Status = 'Completed'");
    expect(logic.body).not.toContain("Priority = 'Low'");
  });

  it("leaves deletes alone that can't fail or that find their record by Id", () => {
    const skipped = [
      // A fault path catches finding nothing.
      `<recordDeletes><name>First</name><object>Task</object><faultConnector><targetReference>Log</targetReference></faultConnector></recordDeletes>
       <assignments><name>Log</name></assignments>`,
      `<recordDeletes><name>First</name><object>Task</object>
        <filters><field>Id</field><operator>EqualTo</operator><value><elementReference>subjectInput</elementReference></value></filters>
      </recordDeletes>`,
      // Deleting a record variable deletes what it holds.
      '<recordDeletes><name>First</name><inputReference>someRecord</inputReference></recordDeletes>',
    ];
    for (const deletes of skipped) expect(deleting(deletes).body, deletes).not.toContain('Match');
  });

  it("says what it couldn't meet", () => {
    const test = deleting(
      `<recordDeletes><name>First</name><object>Task</object>
        <filters><field>OwnerId</field><operator>EqualTo</operator><value><elementReference>someVariable</elementReference></value></filters>
      </recordDeletes>`,
    );
    expect(test.body).toContain('// TODO: insert a Task record for First to delete: OwnerId EqualTo someVariable');
    expect(test.body).not.toContain('insert firstMatch;');
  });
});

describe('Send Email recipients', () => {
  const sending = (parameters: string, inputs: string, actionType = 'emailSimple') =>
    generateApexTest(
      autolaunched(
        `${inputs}<actionCalls><name>First</name><actionName>emailSimple</actionName><actionType>${actionType}</actionType>${parameters}</actionCalls>`,
      ),
      { requiredFields: { Contact: { LastName: "'C'" } } },
    ).body;
  const parameter = (name: string, value: string) =>
    `<inputParameters><name>${name}</name><value>${value}</value></inputParameters>`;
  const reference = (name: string) => `<elementReference>${name}</elementReference>`;

  it('gives the inputs it sends to an address or the running user', () => {
    const body = sending(
      [
        parameter('emailAddresses', reference('toAddress')),
        parameter('recipientId', reference('recipient')),
        parameter('emailAddressesArray', reference('copies')),
        parameter('emailSubject', reference('subject')),
        parameter('ccRecipientAddressList', '<stringValue>cc@example.com</stringValue>'),
      ].join(''),
      [
        variable('toAddress', 'String'),
        variable('recipient', 'String'),
        variable('subject', 'String'),
        '<variables><name>copies</name><dataType>String</dataType><isInput>true</isInput><isOutput>false</isOutput><isCollection>true</isCollection></variables>',
      ].join(''),
    );
    expect(body).toContain("inputs.put('toAddress', 'flowtest@example.com'); // a Send Email action sends to it");
    expect(body).toContain("inputs.put('recipient', UserInfo.getUserId()); // a Send Email action sends to it");
    expect(body).toContain(
      "inputs.put('copies', new List<String>{ 'flowtest@example.com' }); // a Send Email action sends to it",
    );
    expect(body).toContain("inputs.put('subject', '[subject]'); // TODO: String");
  });

  it('sets the address field on an input record it sends to', () => {
    const body = sending(
      parameter('emailAddresses', reference('contactInput.Email')),
      variable('contactInput', 'SObject', '<objectType>Contact</objectType>'),
    );
    expect(body).toContain("Email = 'flowtest@example.com'");
  });

  it('ignores other actions', () => {
    const body = sending(parameter('emailAddresses', reference('toAddress')), variable('toAddress', 'String'), 'apex');
    expect(body).toContain("inputs.put('toAddress', '[toAddress]'); // TODO: String");
  });
});
