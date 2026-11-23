import { describe, expect, it } from 'vitest';

import { generateApexTest } from '../../src/core/apexTemplate.js';
import { parseFlowXml } from '../../src/core/flowXml.js';

const recordFlow = (formula: string) =>
  parseFlowXml(
    'Job_Flow',
    `<Flow><processType>AutoLaunchedFlow</processType><start>
      <filterFormula>${formula}</filterFormula>
      <object>Job__c</object><recordTriggerType>Create</recordTriggerType><triggerType>RecordAfterSave</triggerType>
    </start></Flow>`,
  );

const textInput = (name: string) =>
  `<variables><name>${name}</name><dataType>String</dataType><isInput>true</isInput><isOutput>false</isOutput><isCollection>false</isCollection></variables>`;

const autolaunched = (elements: string) =>
  parseFlowXml(
    'Calc',
    `<Flow><processType>AutoLaunchedFlow</processType>${elements}<start><connector><targetReference>First</targetReference></connector></start></Flow>`,
  );

describe('text in Id and lookup fields', () => {
  it("doesn't set text that isn't an Id on a lookup the describe names", () => {
    const test = generateApexTest(recordFlow('{!$Record.Queue__c} = "Support Queue"'), {
      referenceFields: { Job__c: ['Queue__c'] },
    });
    expect(test.body).toContain('// TODO: entry criteria formula term: {!$Record.Queue__c} = "Support Queue"');
    expect(test.body).not.toContain("Queue__c = 'Support Queue'");
  });

  it('sets a real Id, and text on fields that hold text', () => {
    const options = { referenceFields: { Job__c: ['Queue__c'] } };
    expect(generateApexTest(recordFlow('{!$Record.Queue__c} = "00G000000000001AAA"'), options).body).toContain(
      "Queue__c = '00G000000000001AAA'",
    );
    expect(generateApexTest(recordFlow('{!$Record.Region__c} = "East"'), options).body).toContain("Region__c = 'East'");
  });

  it('goes by the name of standard Id fields when the object was not described', () => {
    expect(generateApexTest(recordFlow('{!$Record.OwnerId} = "Support Queue"')).body).toContain(
      '// TODO: entry criteria formula term: {!$Record.OwnerId} = "Support Queue"',
    );
    expect(generateApexTest(recordFlow('{!$Record.Queue__c} = "Support"')).body).toContain("Queue__c = 'Support'");
  });
});

describe('text inputs compared with Id and lookup fields', () => {
  const lookup = (field: string, variable = 'productId') =>
    `<recordLookups><name>First</name><object>Answer__c</object><storeOutputAutomatically>true</storeOutputAutomatically>
      <filters><field>${field}</field><operator>EqualTo</operator><value><elementReference>${variable}</elementReference></value></filters>
    </recordLookups>`;

  it('passes nothing, with a TODO, when the lookup target is unknown', () => {
    const test = generateApexTest(autolaunched(`${textInput('productId')}${lookup('Product__c')}`), {
      referenceFields: { Answer__c: ['Product__c'] },
    });
    expect(test.body).toContain(
      "inputs.put('productId', null); // TODO: the Id of the record Answer__c.Product__c points to",
    );
  });

  it('keeps placeholder text for inputs compared with text fields', () => {
    const test = generateApexTest(autolaunched(`${textInput('productId')}${lookup('Name')}`), {
      referenceFields: { Answer__c: ['Product__c'] },
    });
    expect(test.body).toContain("inputs.put('productId', '[productId]'); // TODO: String");
  });

  it("treats an input assigned to a record variable's Id as that object's record Id", () => {
    const flow = autolaunched(
      `${textInput('recordId')}
      <variables><name>contract</name><dataType>SObject</dataType><objectType>Contract__c</objectType><isInput>false</isInput><isOutput>false</isOutput><isCollection>false</isCollection></variables>
      <assignments><name>First</name>
        <assignmentItems><assignToReference>contract.Id</assignToReference><operator>Assign</operator><value><elementReference>recordId</elementReference></value></assignmentItems>
        <assignmentItems><assignToReference>contract.Name</assignToReference><operator>Assign</operator><value><elementReference>recordId</elementReference></value></assignmentItems>
        <assignmentItems><assignToReference>unknown.Id</assignToReference><operator>Assign</operator><value><elementReference>recordId</elementReference></value></assignmentItems>
      </assignments>`,
    );
    expect(flow.graph?.idFilters).toEqual([{ variable: 'recordId', object: 'Contract__c', field: 'Id' }]);
    const test = generateApexTest(flow, { requiredFields: { Contract__c: { Name: "'C'" } } });
    expect(test.body).toContain('insert recordIdRecord;');
    expect(test.body).toContain("inputs.put('recordId', recordIdRecord.Id);");
  });
});
