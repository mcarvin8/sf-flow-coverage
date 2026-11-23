import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { flowFieldReferences, inaccessibleFields } from '../../src/core/fieldReferences.js';
import { scaffoldTests } from '../../src/core/scaffold.js';

const FLOW = `<Flow>
  <processType>AutoLaunchedFlow</processType>
  <variables><name>contactVar</name><dataType>SObject</dataType><objectType>Contact</objectType></variables>
  <variables><name>count</name><dataType>Number</dataType></variables>
  <recordLookups><name>Get_Task</name><object>Task</object><storeOutputAutomatically>true</storeOutputAutomatically>
    <filters><field>Status</field><operator>EqualTo</operator><value><stringValue>Open</stringValue></value></filters>
    <queriedFields>Id</queriedFields><queriedFields>Subject</queriedFields>
  </recordLookups>
  <recordLookups><name>Get_Owner</name><object>User</object><outputReference>ownerVar</outputReference><queriedFields>Email</queriedFields></recordLookups>
  <recordUpdates><name>Save</name><inputReference>contactVar</inputReference></recordUpdates>
  <recordCreates><name>Log</name><object>Note__c</object>
    <inputAssignments><field>Body__c</field><value><elementReference>Get_Task.Description</elementReference></value></inputAssignments>
  </recordCreates>
  <assignments><name>Set</name>
    <assignmentItems><assignToReference>$Record.Score__c</assignToReference><operator>Assign</operator><value><elementReference>contactVar.Rating__c</elementReference></value></assignmentItems>
    <assignmentItems><assignToReference>count</assignToReference><operator>Assign</operator><value><elementReference>$Record.Account.Name</elementReference></value></assignmentItems>
  </assignments>
  <decisions><name>Check</name><rules><name>R</name><conditions><leftValueReference>$Record__Prior.Stage__c</leftValueReference><operator>IsChanged</operator></conditions></rules></decisions>
  <formulas><name>f</name><expression>{!$Record.Amount__c} * 2 + LEN({!$Record.Owner:User.Name})</expression></formulas>
  <start><object>Job__c</object>
    <filters><field>Region__c</field><operator>EqualTo</operator><value><stringValue>East</stringValue></value></filters>
  </start>
</Flow>`;

const asObject = (map: Map<string, Set<string>>) =>
  Object.fromEntries([...map].map(([object, fields]) => [object, [...fields].sort()]));

describe('flowFieldReferences', () => {
  it('collects the fields the Flow reads or writes, per object', () => {
    expect(asObject(flowFieldReferences(FLOW))).toEqual({
      Job__c: ['Amount__c', 'Region__c', 'Score__c', 'Stage__c'],
      Task: ['Description', 'Id', 'Status', 'Subject'],
      User: ['Email'],
      Note__c: ['Body__c'],
      Contact: ['Rating__c'],
    });
  });

  it('reads a Flow with nothing in it', () => {
    expect(flowFieldReferences('<Flow/>').size).toBe(0);
    expect(flowFieldReferences('<NotAFlow/>').size).toBe(0);
  });
});

describe('inaccessibleFields', () => {
  it('lists fields the describe leaves out, ignoring case, for described objects only', () => {
    const references = new Map([
      ['Job__c', new Set(['Region__c', 'Secret__c', 'Amount__c'])],
      ['Task', new Set(['Subject'])],
      ['Unknown__c', new Set(['X__c'])],
    ]);
    expect(inaccessibleFields(references, { Job__c: ['region__c', 'Amount__c'], Task: ['Subject'] })).toEqual({
      Job__c: ['Secret__c'],
    });
  });
});

describe('scaffoldTests and inaccessible fields', () => {
  it('describes the other objects the Flow uses and reports the fields the user cannot see', async () => {
    const project = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-fls-'));
    try {
      mkdirSync(join(project, 'flows'));
      writeFileSync(
        join(project, 'flows', 'Job_Flow.flow-meta.xml'),
        `<Flow><processType>AutoLaunchedFlow</processType><status>Active</status>
          <recordLookups><name>Get_Task</name><object>Task</object><storeOutputAutomatically>true</storeOutputAutomatically><queriedFields>Secret__c</queriedFields></recordLookups>
          <start><object>Job__c</object><recordTriggerType>Create</recordTriggerType><triggerType>RecordAfterSave</triggerType>
            <filters><field>Hidden__c</field><operator>EqualTo</operator><value><stringValue>x</stringValue></value></filters>
          </start></Flow>`,
      );
      const field = (name: string) => ({
        name,
        type: 'string',
        nillable: true,
        createable: true,
        defaultedOnCreate: false,
      });
      const described: string[] = [];
      const ruleQueries: string[] = [];
      const result = await scaffoldTests({
        flowNames: ['Job_Flow'],
        projectDir: project,
        outputDir: join(project, 'out'),
        describe: async (object) => {
          described.push(object);
          return [field('Name')];
        },
        validationRules: async (object) => {
          ruleQueries.push(object);
          return [];
        },
      });
      expect(described).toEqual(['Job__c', 'Task']);
      // Task is described only for its field list, not for test data.
      expect(ruleQueries).toEqual(['Job__c']);
      expect(result.inaccessibleFields).toEqual([
        { flowName: 'Job_Flow', object: 'Job__c', fields: ['Hidden__c'] },
        { flowName: 'Job_Flow', object: 'Task', fields: ['Secret__c'] },
      ]);
      const test = readFileSync(join(project, 'out', 'Job_Flow_FlowTest.cls'), 'utf8');
      expect(test).toContain(
        [
          " * TODO: the Flow uses fields the user who generated this test can't see:",
          ' *   Job__c: Hidden__c',
          ' *   Task: Secret__c',
        ].join('\n'),
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
