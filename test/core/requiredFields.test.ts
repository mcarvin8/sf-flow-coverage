import { describe, expect, it } from 'vitest';

import { generateApexTest } from '../../src/core/apexTemplate.js';
import {
  apexValueForField,
  type DescribeField,
  loadRequiredFields,
  requiredFieldValues,
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

describe('loadRequiredFields', () => {
  it('describes each object once and skips objects that fail', async () => {
    const calls: string[] = [];
    const map = await loadRequiredFields(
      ['Installation__c', 'Installation__c', 'Gone__c', 'Missing__c'],
      async (name) => {
        calls.push(name);
        if (name === 'Gone__c') throw new Error('INVALID_TYPE');
        if (name === 'Missing__c') return undefined;
        return [field('Crew_Size__c', 'double')];
      },
    );
    expect(calls).toEqual(['Installation__c', 'Gone__c', 'Missing__c']);
    expect(map).toEqual({ Installation__c: { Crew_Size__c: '1' } });
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
