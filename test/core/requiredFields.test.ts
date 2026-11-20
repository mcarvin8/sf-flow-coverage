import { describe, expect, it } from 'vitest';

import { generateApexTest } from '../../src/core/apexTemplate.js';
import {
  apexValueForField,
  type DescribeField,
  loadObjectFields,
  requiredFieldValues,
  settableFieldValues,
} from '../../src/core/requiredFields.js';

const field = (name: string, type: string, extra: Partial<DescribeField> = {}): DescribeField => ({
  name,
  type,
  nillable: false,
  createable: true,
  defaultedOnCreate: false,
  ...extra,
});

describe('apexValueForField', () => {
  it('makes up a value for each field type', () => {
    expect(apexValueForField(field('A', 'string', { length: 2 }))).toBe("'Te'");
    expect(apexValueForField(field('A', 'textarea', { length: 0 }))).toBe("'Test'");
    expect(apexValueForField(field('A', 'encryptedstring'))).toBe("'Test'");
    expect(apexValueForField(field('A', 'email'))).toBe("'test@example.com'");
    expect(apexValueForField(field('A', 'phone'))).toBe("'5555550100'");
    expect(apexValueForField(field('A', 'url'))).toBe("'https://example.com'");
    for (const type of ['int', 'double', 'currency', 'percent']) expect(apexValueForField(field('A', type))).toBe('1');
    expect(apexValueForField(field('A', 'date'))).toBe('Date.today()');
    expect(apexValueForField(field('A', 'datetime'))).toBe('Datetime.now()');
    expect(apexValueForField(field('A', 'time'))).toBe('Time.newInstance(12, 0, 0, 0)');
    expect(apexValueForField(field('A', 'boolean'))).toBe('false');
    expect(apexValueForField(field('A', 'reference', { referenceTo: ['Account', 'Contact'] }))).toBe(
      'null /* TODO: set a Account or Contact Id */',
    );
    expect(apexValueForField(field('A', 'reference'))).toBe('null /* TODO: set a record Id */');
    expect(apexValueForField(field('A', 'base64'))).toBeUndefined();
  });

  it('picks the default active picklist value, else the first active one', () => {
    const values = [
      { value: 'Old', active: false, defaultValue: true },
      { value: "Won't", active: true },
      { value: 'Default', active: true, defaultValue: true },
    ];
    expect(apexValueForField(field('A', 'picklist', { picklistValues: values }))).toBe("'Default'");
    expect(apexValueForField(field('A', 'multipicklist', { picklistValues: values.slice(0, 2) }))).toBe("'Won\\'t'");
    expect(apexValueForField(field('A', 'picklist', { picklistValues: null }))).toBeUndefined();
  });
});

describe('requiredFieldValues', () => {
  it('keeps only fields a test has to set', () => {
    expect(
      requiredFieldValues([
        field('Crew_Size__c', 'double'),
        field('Optional__c', 'string', { nillable: true }),
        field('ReadOnly__c', 'string', { createable: false }),
        field('Defaulted__c', 'boolean', { defaultedOnCreate: true }),
        field('Formula__c', 'string', { calculated: true }),
        field('Name', 'string', { autoNumber: true }),
        field('OwnerId', 'reference'),
        field('Blob__c', 'base64'),
      ]),
    ).toEqual({ Crew_Size__c: '1' });
  });
});

describe('settableFieldValues', () => {
  it('gives a value for every createable field except lookups and computed fields', () => {
    expect(
      settableFieldValues([
        field('Panels_Required__c', 'double', { nillable: true }),
        field('Install_Date__c', 'date', { nillable: true }),
        field('Account__c', 'reference', { nillable: true, referenceTo: ['Account'] }),
        field('ReadOnly__c', 'string', { createable: false }),
        field('Formula__c', 'string', { calculated: true }),
        field('Name', 'string', { autoNumber: true }),
        field('Blob__c', 'base64'),
      ]),
    ).toEqual({ Panels_Required__c: '1', Install_Date__c: 'Date.today()' });
  });
});

describe('loadObjectFields', () => {
  it('describes each object once and skips objects that fail', async () => {
    const calls: string[] = [];
    const map = await loadObjectFields(
      ['Installation__c', 'Installation__c', 'Gone__c', 'Missing__c'],
      async (name) => {
        calls.push(name);
        if (name === 'Gone__c') throw new Error('INVALID_TYPE');
        if (name === 'Missing__c') return undefined;
        return [field('Crew_Size__c', 'double')];
      },
    );
    expect(calls).toEqual(['Installation__c', 'Gone__c', 'Missing__c']);
    expect(map).toEqual({
      requiredFields: { Installation__c: { Crew_Size__c: '1' } },
      fieldValues: { Installation__c: { Crew_Size__c: '1' } },
    });
  });
});

describe('generateApexTest with described fields', () => {
  it('fills required fields and drops the TODO, letting criteria override', () => {
    const test = generateApexTest(
      {
        name: 'Install',
        processType: 'AutoLaunchedFlow',
        triggerType: 'RecordAfterSave',
        recordTriggerType: 'Create',
        object: 'Installation__c',
        filters: [{ field: 'Status__c', operator: 'EqualTo', apexValue: "'Planned'" }],
        variables: [],
      },
      { requiredFields: { Installation__c: { Crew_Size__c: '1', Status__c: "'New'" } } },
    );
    expect(test.body).toContain('Crew_Size__c = 1,');
    expect(test.body).toContain("Status__c = 'Planned'");
    expect(test.body).not.toContain('TODO: set the required fields');
  });

  it('prefers described fields over the built-in list', () => {
    const test = generateApexTest(
      {
        name: 'Acct',
        processType: 'AutoLaunchedFlow',
        triggerType: 'RecordAfterSave',
        object: 'Account',
        filters: [],
        variables: [],
      },
      { requiredFields: { Account: { Name: "'Test'", Region__c: "'East'" } } },
    );
    expect(test.body).toContain("Region__c = 'East'");
  });
});

describe('generateApexTest with IsNull false criteria', () => {
  const flow = (recordTriggerType: string, object = 'Installation__c', triggerType = 'RecordAfterSave') => ({
    name: 'Crew_Warning',
    processType: 'AutoLaunchedFlow',
    triggerType,
    recordTriggerType,
    object,
    filters: [
      { field: 'Crew_Size__c', operator: 'IsNull', apexValue: 'false', rawValue: 'false' },
      { field: 'Panels_Required__c', operator: 'IsNull', apexValue: 'false', rawValue: 'false' },
      { field: 'Account__c', operator: 'IsNull', apexValue: 'false', rawValue: 'false' },
      { field: 'Signed_Off_By__c', operator: 'IsNull', apexValue: 'true', rawValue: 'true' },
    ],
    variables: [],
  });
  const fieldValues = {
    Installation__c: { Crew_Size__c: '1', Panels_Required__c: '1', Signed_Off_By__c: "'Test'" },
    Order_Event__e: { Crew_Size__c: '2' },
  };

  it('sets fields the criteria require to be filled on create', () => {
    const test = generateApexTest(flow('Create'), { fieldValues });
    expect(test.body).toContain('Crew_Size__c = 1,');
    expect(test.body).toContain('Panels_Required__c = 1');
    expect(test.body).not.toContain('TODO: entry criteria: Crew_Size__c');
    expect(test.body).not.toContain('TODO: entry criteria: Panels_Required__c');
    expect(test.body).toContain('// TODO: entry criteria: Account__c IsNull false');
    expect(test.body).toContain('// TODO: entry criteria: Signed_Off_By__c IsNull true');
    expect(test.body).not.toContain("Signed_Off_By__c = 'Test'");
  });

  it('fills the fields in the update so they change', () => {
    const test = generateApexTest(flow('Update'), { fieldValues });
    expect(test.body).toContain('testRecord.Crew_Size__c = 1;');
    expect(test.body).toContain('testRecord.Panels_Required__c = 1;');
  });

  it('does not reassign a value the insert already set', () => {
    const test = generateApexTest(flow('Update'), {
      fieldValues,
      requiredFields: { Installation__c: { Crew_Size__c: '1' } },
    });
    expect(test.body).not.toContain('testRecord.Crew_Size__c = 1;');
    expect(test.body).toContain('testRecord.Panels_Required__c = 1;');
  });

  it('applies to platform event criteria', () => {
    const test = generateApexTest(flow('', 'Order_Event__e', 'PlatformEvent'), { fieldValues });
    expect(test.body).toContain('Crew_Size__c = 2');
    expect(test.body).toContain('// TODO: entry criteria: Panels_Required__c IsNull false');
  });

  it('leaves a TODO without an org describe', () => {
    const test = generateApexTest(flow('Create'));
    expect(test.body).toContain('// TODO: entry criteria: Crew_Size__c IsNull false');
  });
});
