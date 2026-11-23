import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { scaffoldTests } from '../../src/core/scaffold.js';

const field = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  type: 'string',
  nillable: true,
  createable: true,
  defaultedOnCreate: false,
  ...extra,
});
const lookup = (name: string, target: string, relationshipName: string) =>
  field(name, { type: 'reference', referenceTo: [target], relationshipName });

describe('scaffoldTests and validation rules that need a parent record', () => {
  it('describes the objects the rules look up, so the test can fill the lookup', async () => {
    const project = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-rule-parents-'));
    try {
      mkdirSync(join(project, 'flows'));
      writeFileSync(
        join(project, 'flows', 'Story_Flow.flow-meta.xml'),
        `<Flow><processType>AutoLaunchedFlow</processType><status>Active</status><start>
          <object>Story__c</object><recordTriggerType>Create</recordTriggerType><triggerType>RecordAfterSave</triggerType>
        </start></Flow>`,
      );
      const described: string[] = [];
      const ruled: string[] = [];
      await scaffoldTests({
        flowNames: ['Story_Flow'],
        projectDir: project,
        outputDir: join(project, 'out'),
        describe: async (object) => {
          described.push(object);
          if (object === 'Story__c') {
            return [
              lookup('Project__c', 'Project__c', 'Project__r'),
              lookup('Milestone__c', 'Milestone__c', 'Milestone__r'),
              lookup('Owner__c', 'User', 'Owner__r'),
            ];
          }
          if (object === 'Project__c')
            return [field('Name', { nillable: false }), lookup('Program__c', 'Program__c', 'Program__r')];
          return [field('Name', { nillable: false })];
        },
        validationRules: async (object) => {
          ruled.push(object);
          if (object === 'Story__c') {
            return [
              { name: 'Needs_Parent', formula: 'AND(ISBLANK(Project__c), ISBLANK(Milestone__c))' },
              { name: 'Owner_Set', formula: 'ISBLANK(Owner__c) && Owner__r.IsActive' },
            ];
          }
          // The project's own rule reaches one relationship further.
          if (object === 'Project__c') return [{ name: 'Program_Open', formula: 'Program__r.Closed__c' }];
          return [];
        },
      });
      expect(described).toEqual(['Story__c', 'Project__c', 'Milestone__c', 'Program__c']);
      expect(ruled).toEqual(['Story__c', 'Project__c', 'Milestone__c', 'Program__c']);
      const test = readFileSync(join(project, 'out', 'Story_Flow_FlowTest.cls'), 'utf8');
      expect(test).toContain('Project__c = projectParent.Id');
      expect(test).toContain('insert projectParent;');
      expect(test).not.toContain('TODO: validation rule: Needs_Parent');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
