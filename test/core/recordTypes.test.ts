import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { generateApexTest } from '../../src/core/apexTemplate.js';
import { type CriteriaPlan, emptyPlan } from '../../src/core/criteria.js';
import { parseFlowXml } from '../../src/core/flowXml.js';
import {
  picklistValueReader,
  type RecordTypeInfo,
  recordTypeIdApex,
  recordTypeInfos,
  withRecordType,
} from '../../src/core/recordTypes.js';
import { scaffoldTests } from '../../src/core/scaffold.js';

const type = (developerName: string, extra: Partial<RecordTypeInfo> = {}): RecordTypeInfo => ({
  developerName,
  recordTypeId: `012000000000${developerName.length}AAA`,
  available: true,
  isDefault: false,
  master: false,
  ...extra,
});

const TYPES = [
  type('Master', { master: true }),
  type('General', { isDefault: true }),
  type('Legal'),
  type('Secret', { available: false }),
];
const PICKLISTS = {
  General: { Document_Type__c: ['Memo'] },
  Legal: { Document_Type__c: ['Memo', 'NDA'] },
  Secret: { Document_Type__c: ['Memo', 'NDA', 'Classified'] },
};
const RESTRICTED = { Document_Type__c: { values: ['Memo', 'NDA', 'Classified'], restricted: true } };

const plan = (set: Record<string, string>, prior: Record<string, string> = {}): CriteriaPlan => ({
  ...emptyPlan(),
  set: new Map(Object.entries(set)),
  prior: new Map(Object.entries(prior)),
});

describe('recordTypeInfos', () => {
  it('reads the record types of a describe', () => {
    expect(
      recordTypeInfos([
        {
          developerName: 'Master',
          recordTypeId: '012A',
          available: true,
          defaultRecordTypeMapping: false,
          master: true,
        },
        { developerName: 'Legal', recordTypeId: '012B', available: false, defaultRecordTypeMapping: true },
        { developerName: 'Broken' },
        null,
      ]),
    ).toEqual([
      { developerName: 'Master', recordTypeId: '012A', available: true, isDefault: false, master: true },
      { developerName: 'Legal', recordTypeId: '012B', available: false, isDefault: true, master: false },
    ]);
  });
});

describe('picklistValueReader', () => {
  it('reads picklist values per record type from the UI API, and nothing when it fails', async () => {
    const urls: string[] = [];
    const read = picklistValueReader({
      getApiVersion: () => '64.0',
      request: (async (url: string) => {
        urls.push(url);
        return {
          picklistFieldValues: {
            Document_Type__c: { values: [{ value: 'Memo' }, { label: 'no value' }] },
            Empty__c: {},
          },
        };
      }) as never,
    });
    expect(await read('Document__c', '012B')).toEqual({ Document_Type__c: ['Memo'], Empty__c: [] });
    expect(urls).toEqual(['/services/data/v64.0/ui-api/object-info/Document__c/picklist-values/012B']);
    const failing = picklistValueReader({
      getApiVersion: () => '64.0',
      request: (async () => {
        throw new Error('NOT_FOUND');
      }) as never,
    });
    expect(await failing('Document__c', '012B')).toEqual({});
    const empty = picklistValueReader({ getApiVersion: () => '64.0', request: (async () => null) as never });
    expect(await empty('Document__c', '012B')).toEqual({});
  });
});

describe('withRecordType', () => {
  const fit = (p: CriteriaPlan, context: 'insert' | 'update' = 'insert', types = TYPES) =>
    withRecordType(p, 'Document__c', types, PICKLISTS, RESTRICTED, context);

  it('keeps the default record type when it allows the values', () => {
    const memo = plan({ Document_Type__c: "'Memo'" });
    expect(fit(memo)).toBe(memo);
    expect(fit(plan({ Name: "'x'" }))).toEqual(plan({ Name: "'x'" }));
    expect(fit(memo, 'insert', [])).toBe(memo);
  });

  it('picks a record type the user can use that allows the values, on insert', () => {
    expect(Object.fromEntries(fit(plan({ Document_Type__c: "'nda'" })).set)).toEqual({
      Document_Type__c: "'nda'",
      RecordTypeId: recordTypeIdApex('Document__c', 'Legal'),
    });
    const update = fit(plan({ Document_Type__c: "'NDA'" }), 'update');
    expect(update.prior.get('RecordTypeId')).toBe(recordTypeIdApex('Document__c', 'Legal'));
    expect(update.set.has('RecordTypeId')).toBe(false);
  });

  it('says when no record type the user can use allows the values', () => {
    expect(fit(plan({ Document_Type__c: "'Classified'" })).unmet).toEqual([
      { label: 'record type', text: "no record type the running user can use allows Document_Type__c = 'Classified'" },
    ]);
  });

  it('checks a record type the criteria name', () => {
    expect(fit(plan({ RecordTypeId: recordTypeIdApex('Document__c', 'Secret') })).unmet[0].text).toBe(
      "record type Secret isn't available to the running user: assign it to their profile or a permission set",
    );
    expect(
      fit(plan({ RecordTypeId: recordTypeIdApex('Document__c', 'General'), Document_Type__c: "'NDA'" })).unmet[0].text,
    ).toBe("record type General doesn't allow Document_Type__c = 'NDA'");
    const fine = plan({ RecordTypeId: recordTypeIdApex('Document__c', 'Legal'), Document_Type__c: "'NDA'" });
    expect(fit(fine)).toBe(fine);
    const unknown = plan({ RecordTypeId: recordTypeIdApex('Document__c', 'Gone') });
    expect(fit(unknown)).toBe(unknown);
  });

  it('allows values it has no record type data for, and ignores unrestricted picklists', () => {
    const p = plan({ Document_Type__c: "'NDA'" });
    expect(withRecordType(p, 'Document__c', TYPES, {}, RESTRICTED, 'insert')).toBe(p);
    expect(withRecordType(p, 'Document__c', TYPES, PICKLISTS, {}, 'insert')).toBe(p);
    // Without a default, a record type that allows the values is picked.
    const noDefault = TYPES.map((t) => ({ ...t, isDefault: false }));
    expect(fit(plan({ Document_Type__c: "'Memo'" }), 'insert', noDefault).set.get('RecordTypeId')).toBe(
      recordTypeIdApex('Document__c', 'General'),
    );
  });
});

describe('record types in generated tests', () => {
  const flow = (formula: string, trigger = 'Create') =>
    parseFlowXml(
      'Doc_Flow',
      `<Flow><processType>AutoLaunchedFlow</processType><start><filterFormula>${formula}</filterFormula>
        <object>Document__c</object><recordTriggerType>${trigger}</recordTriggerType><triggerType>RecordAfterSave</triggerType></start></Flow>`,
    );
  const options = {
    requiredFields: { Document__c: {} },
    picklists: { Document__c: RESTRICTED },
    recordTypeInfos: { Document__c: TYPES },
    recordTypePicklists: { Document__c: PICKLISTS },
  };

  it('sets a record type that allows the picklist value the criteria need', () => {
    const body = generateApexTest(flow('ISPICKVAL({!$Record.Document_Type__c}, "NDA")'), options).body;
    expect(body).toContain(`RecordTypeId = ${recordTypeIdApex('Document__c', 'Legal')}`);
    expect(body).not.toContain('TODO: record type');
  });

  it('notes a record type the running user cannot use', () => {
    const body = generateApexTest(flow('{!$Record.RecordType.DeveloperName} = "Secret"'), options).body;
    expect(body).toContain("// TODO: record type: record type Secret isn't available to the running user");
  });
});

describe('scaffoldTests and record types', () => {
  it('reads picklist values per record type only for objects that may need another record type', async () => {
    const project = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-rt-'));
    try {
      mkdirSync(join(project, 'flows'));
      const write = (name: string, object: string) =>
        writeFileSync(
          join(project, 'flows', `${name}.flow-meta.xml`),
          `<Flow><processType>AutoLaunchedFlow</processType><status>Active</status><start>
            <filterFormula>ISPICKVAL({!$Record.Document_Type__c}, "NDA")</filterFormula>
            <object>${object}</object><recordTriggerType>Create</recordTriggerType><triggerType>RecordAfterSave</triggerType>
          </start></Flow>`,
        );
      write('Doc_Flow', 'Document__c');
      write('Plain_Flow', 'Plain__c');
      const picklist = {
        name: 'Document_Type__c',
        type: 'picklist',
        nillable: true,
        createable: true,
        defaultedOnCreate: false,
        restrictedPicklist: true,
        picklistValues: ['Memo', 'NDA'].map((value) => ({ value, active: true })),
      };
      const describedTypes = TYPES.map((t) => ({
        developerName: t.developerName,
        recordTypeId: t.recordTypeId,
        available: t.available,
        defaultRecordTypeMapping: t.isDefault,
        master: t.master,
      }));
      const reads: string[] = [];
      await scaffoldTests({
        flowNames: ['Doc_Flow', 'Plain_Flow'],
        projectDir: project,
        outputDir: join(project, 'out'),
        describe: async (object) =>
          object === 'Document__c'
            ? { fields: [picklist], recordTypeInfos: describedTypes }
            : { fields: [picklist], recordTypeInfos: describedTypes.slice(0, 2) },
        recordTypePicklists: async (object, recordTypeId) => {
          reads.push(`${object}:${recordTypeId}`);
          return PICKLISTS[TYPES.find((t) => t.recordTypeId === recordTypeId)?.developerName as 'General'] ?? {};
        },
      });
      // Only Document__c has two record types the user can use.
      expect(reads).toEqual([`Document__c:${TYPES[1].recordTypeId}`, `Document__c:${TYPES[2].recordTypeId}`]);
      expect(readFileSync(join(project, 'out', 'Doc_Flow_FlowTest.cls'), 'utf8')).toContain(
        `RecordTypeId = ${recordTypeIdApex('Document__c', 'Legal')}`,
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
