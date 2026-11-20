import { describe, expect, it } from 'vitest';

import { generateApexTest } from '../../src/core/apexTemplate.js';
import {
  apexValueForField,
  canInsertParent,
  changedFieldValues,
  changedValueForField,
  type DescribeField,
  loadObjectFields,
  lookupTargets,
  requiredFieldValues,
  settableFieldValues,
  unsetFieldValues,
} from '../../src/core/requiredFields.js';
import type { FlowMetadata } from '../../src/core/types.js';

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
      changedValues: { Installation__c: { Crew_Size__c: '2' } },
      lookups: { Installation__c: {} },
      unsetValues: { Installation__c: {} },
      relationships: { Installation__c: {} },
      recordTypes: {},
      readOnlyFields: { Installation__c: [] },
      createOnlyFields: { Installation__c: [] },
    });
  });

  it('records fields a test cannot set, and fields it can only set on insert', async () => {
    const map = await loadObjectFields(['Job__c'], async () => [
      field('Name', 'string'),
      field('Region_Name__c', 'string', { createable: false, calculated: true }),
      field('Number__c', 'string', { autoNumber: true }),
      field('Project__c', 'reference', { referenceTo: ['Project__c'], updateable: false }),
      field('Notes__c', 'string', { updateable: true }),
    ]);
    expect(map.readOnlyFields).toEqual({ Job__c: ['Region_Name__c', 'Number__c'] });
    expect(map.createOnlyFields).toEqual({ Job__c: ['Project__c'] });
  });

  it('adds to earlier results without describing an object twice', async () => {
    const calls: string[] = [];
    const describe = async (name: string) => {
      calls.push(name);
      return [field('Name', 'string')];
    };
    const map = await loadObjectFields(['Account'], describe);
    await loadObjectFields(['Account', 'Contact'], describe, map);
    expect(calls).toEqual(['Account', 'Contact']);
    expect(Object.keys(map.requiredFields)).toEqual(['Account', 'Contact']);
  });
});

describe('lookupTargets', () => {
  it('lists createable lookups, picking a target for polymorphic ones', () => {
    expect(
      lookupTargets([
        field('Account__c', 'reference', { referenceTo: ['Account'] }),
        field('WhatId', 'reference', { referenceTo: ['RecordType', 'Opportunity', 'Account'] }),
        field('OwnerId', 'reference', { referenceTo: ['Group', 'User'] }),
        field('Setup__c', 'reference', { referenceTo: ['Group', 'Profile'] }),
        field('CreatedById', 'reference', { referenceTo: ['User'], createable: false }),
        field('Formula__c', 'reference', { referenceTo: ['Account'], calculated: true }),
        field('Other__c', 'reference'),
        field('Name', 'string'),
      ]),
    ).toEqual({ Account__c: 'Account', WhatId: 'Opportunity', OwnerId: 'User' });
  });
});

describe('unsetFieldValues', () => {
  const fields = [
    field('Notes__c', 'string', { nillable: true }),
    field('Name', 'string'),
    field('Stage__c', 'picklist', { nillable: true, defaultedOnCreate: true }),
    field('Type__c', 'picklist', {
      nillable: true,
      defaultedOnCreate: true,
      picklistValues: [
        { value: 'Old', active: false, defaultValue: true },
        { value: "Tile's", active: true, defaultValue: true },
      ],
    }),
    field('Kind__c', 'picklist', { nillable: true, picklistValues: [{ value: 'A', active: true }] }),
    field('Done__c', 'boolean', { defaultedOnCreate: true, defaultValue: false }),
    field('Sent__c', 'boolean', { defaultedOnCreate: true, defaultValue: 'true' }),
    field('Odd__c', 'boolean', { defaultedOnCreate: true, defaultValue: 'maybe' }),
    field('Total__c', 'double', { nillable: true, calculated: true }),
    field('Number__c', 'string', { nillable: true, autoNumber: true }),
    field('Locked__c', 'string', { nillable: true, createable: false }),
  ];

  it('gives empty fields, checkbox defaults, and picklist defaults when no record type can change them', () => {
    expect(unsetFieldValues(fields, 1)).toEqual({
      Notes__c: null,
      Type__c: "'Tile\\'s'",
      Kind__c: null,
      Done__c: 'false',
      Sent__c: 'true',
    });
  });

  it('leaves picklist defaults out when the object has record types, or when that is unknown', () => {
    for (const recordTypes of [3, undefined]) {
      expect(unsetFieldValues(fields, recordTypes)).not.toHaveProperty('Type__c');
    }
  });
});

describe('canInsertParent', () => {
  it('rejects setup objects and objects with an existing record to use', () => {
    expect(canInsertParent('Account')).toBe(true);
    expect(canInsertParent('Installation__c')).toBe(true);
    for (const object of ['User', 'Pricebook2', 'RecordType', 'Profile', 'Group']) {
      expect(canInsertParent(object), object).toBe(false);
    }
  });
});

describe('generateApexTest with lookups', () => {
  const recordFlow = (overrides: Partial<FlowMetadata> = {}): FlowMetadata => ({
    name: 'Job_Flow',
    processType: 'AutoLaunchedFlow',
    triggerType: 'RecordAfterSave',
    recordTriggerType: 'Create',
    object: 'Job__c',
    filters: [],
    variables: [],
    ...overrides,
  });
  const requiredFields = {
    Job__c: { Account__c: 'null /* TODO: set a Account Id */', Name: "'Test'" },
    Account: { Name: "'Test'", Parent__c: 'null /* TODO: set a Account Id */' },
  };

  it('inserts a parent with its own required fields for a required lookup', () => {
    const test = generateApexTest(recordFlow(), {
      requiredFields,
      lookups: { Job__c: { Account__c: 'Account' }, Account: { Parent__c: 'Account' } },
    });
    expect(test.body).toContain(
      [
        '        Account accountParent = new Account(',
        "            Name = 'Test',",
        '            Parent__c = null /* TODO: set a Account Id */',
        '        );',
        '        insert accountParent;',
        '',
        '        Job__c testRecord = new Job__c(',
        '            Account__c = accountParent.Id,',
      ].join('\n'),
    );
  });

  it('fills IsNull false lookups, inserting the parent only in methods that use it', () => {
    const test = generateApexTest(
      recordFlow({
        recordTriggerType: 'Update',
        filters: [{ field: 'Contact__c', operator: 'IsNull', apexValue: 'false', rawValue: 'false' }],
      }),
      { requiredFields: { Contact: { LastName: "'Test'" } }, lookups: { Job__c: { Contact__c: 'Contact' } } },
    );
    expect(test.body).toContain('Contact contactParent = new Contact(');
    expect(test.body).toContain('testRecord.Contact__c = contactParent.Id;');
    expect(test.body).not.toContain('TODO: entry criteria');
    expect(test.body.match(/insert contactParent;/g)).toHaveLength(1);
  });

  it('uses the running user and the standard price book instead of inserting them', () => {
    const test = generateApexTest(
      recordFlow({
        filters: [
          { field: 'Reviewer__c', operator: 'IsNull', apexValue: 'false', rawValue: 'false' },
          { field: 'Pricebook__c', operator: 'IsNull', apexValue: 'false', rawValue: 'false' },
        ],
      }),
      { lookups: { Job__c: { Reviewer__c: 'User', Pricebook__c: 'Pricebook2' } } },
    );
    expect(test.body).toContain('Reviewer__c = UserInfo.getUserId(),');
    expect(test.body).toContain('Pricebook__c = Test.getStandardPricebookId()');
    expect(test.body).not.toContain('Parent =');
  });

  it('keeps the TODO when the parent was not described or cannot be inserted', () => {
    const test = generateApexTest(recordFlow(), {
      requiredFields: {
        Job__c: { Account__c: 'null /* TODO: set a Account Id */', Type__c: 'null /* TODO: set a RecordType Id */' },
      },
      lookups: { Job__c: { Account__c: 'Account', Type__c: 'RecordType' } },
    });
    expect(test.body).toContain('Account__c = null /* TODO: set a Account Id */');
    expect(test.body).toContain('Type__c = null /* TODO: set a RecordType Id */');
    expect(test.body).not.toContain('accountParent');
  });

  it('inserts grandparents first, and keeps the TODO for cycles and past the depth limit', () => {
    const todo = (target: string) => `null /* TODO: set a ${target} Id */`;
    const test = generateApexTest(recordFlow(), {
      requiredFields: {
        Job__c: { Account__c: todo('Account') },
        Account: { Name: "'A'", Region__c: todo('Region__c'), ParentId: todo('Account') },
        Region__c: { Name: "'R'", Zone__c: todo('Zone__c') },
        Zone__c: { Name: "'Z'", Area__c: todo('Area__c') },
        Area__c: { Name: "'X'" },
      },
      lookups: {
        Job__c: { Account__c: 'Account' },
        Account: { Region__c: 'Region__c', ParentId: 'Account' },
        Region__c: { Zone__c: 'Zone__c' },
        Zone__c: { Area__c: 'Area__c' },
      },
    });
    expect(test.body).toContain(
      [
        '        Zone__c zoneParent = new Zone__c(',
        "            Name = 'Z',",
        '            Area__c = null /* TODO: set a Area__c Id */',
        '        );',
        '        insert zoneParent;',
        '        Region__c regionParent = new Region__c(',
        "            Name = 'R',",
        '            Zone__c = zoneParent.Id',
        '        );',
        '        insert regionParent;',
        '        Account accountParent = new Account(',
        "            Name = 'A',",
        '            Region__c = regionParent.Id,',
        '            ParentId = null /* TODO: set a Account Id */',
        '        );',
        '        insert accountParent;',
        '',
        '        Job__c testRecord = new Job__c(',
        '            Account__c = accountParent.Id',
      ].join('\n'),
    );
    expect(test.body).not.toContain('areaParent');
  });

  it('reads business hours and record types the org already has', () => {
    const test = generateApexTest(
      recordFlow({
        filters: [
          { field: 'BusinessHoursId', operator: 'IsNull', apexValue: 'false', rawValue: 'false' },
          { field: 'RecordTypeId', operator: 'IsNull', apexValue: 'false', rawValue: 'false' },
        ],
      }),
      {
        lookups: { Job__c: { BusinessHoursId: 'BusinessHours', RecordTypeId: 'RecordType' } },
        recordTypes: { Job__c: 3 },
      },
    );
    expect(test.body).toContain('BusinessHoursId = [SELECT Id FROM BusinessHours WHERE IsDefault = true LIMIT 1].Id,');
    expect(test.body).toContain(
      "RecordTypeId = [SELECT Id FROM RecordType WHERE SobjectType = 'Job__c' AND IsActive = true LIMIT 1].Id",
    );
    const noTypes = generateApexTest(
      recordFlow({ filters: [{ field: 'RecordTypeId', operator: 'IsNull', apexValue: 'false', rawValue: 'false' }] }),
      { lookups: { Job__c: { RecordTypeId: 'RecordType' } }, recordTypes: { Job__c: 1 } },
    );
    expect(noTypes.body).toContain('// TODO: entry criteria: RecordTypeId IsNull false');
  });

  it('fills required lookups on sObject inputs of autolaunched Flows', () => {
    const test = generateApexTest(
      {
        ...recordFlow({ triggerType: undefined, object: undefined }),
        variables: [
          {
            name: 'job',
            dataType: 'SObject',
            objectType: 'Job__c',
            isInput: true,
            isOutput: false,
            isCollection: false,
          },
        ],
      },
      { requiredFields, lookups: { Job__c: { Account__c: 'Account' } } },
    );
    expect(test.body).toContain('insert accountParent;');
    expect(test.body).toContain('Account__c = accountParent.Id,');
  });
});

describe('changedValueForField', () => {
  it('makes up a value that differs from apexValueForField for each type', () => {
    const types = ['string', 'textarea', 'encryptedstring', 'email', 'phone', 'url', 'int', 'double', 'currency'];
    for (const type of [...types, 'percent', 'date', 'datetime', 'time', 'boolean']) {
      const changed = changedValueForField(field('A', type));
      expect(changed).toBeDefined();
      expect(changed).not.toBe(apexValueForField(field('A', type)));
    }
    expect(changedValueForField(field('A', 'string', { length: 1 }))).toBe("'C'");
    expect(changedValueForField(field('A', 'reference'))).toBeUndefined();
    expect(changedValueForField(field('A', 'base64'))).toBeUndefined();
  });

  it('picks a second active picklist value', () => {
    const picklist = (values: Array<{ value: string; active: boolean; defaultValue?: boolean }>) =>
      changedValueForField(field('A', 'picklist', { picklistValues: values }));
    expect(
      picklist([
        { value: 'Old', active: false },
        { value: 'New', active: true },
        { value: 'Done', active: true, defaultValue: true },
      ]),
    ).toBe("'New'");
    expect(picklist([{ value: 'Only', active: true }])).toBeUndefined();
    expect(changedValueForField(field('A', 'multipicklist'))).toBeUndefined();
  });

  it('keeps fields a test could update', () => {
    expect(
      changedFieldValues([
        field('Name', 'string'),
        field('Formula__c', 'string', { calculated: true }),
        field('Number__c', 'string', { autoNumber: true }),
        field('Locked__c', 'string', { createable: false }),
        field('Account__c', 'reference'),
      ]),
    ).toEqual({ Name: "'Changed'" });
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
    // IsNull true is met by leaving the field empty.
    expect(test.body).not.toContain('Signed_Off_By__c');
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
