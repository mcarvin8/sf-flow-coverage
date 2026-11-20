import { describe, expect, it } from 'vitest';

import {
  compareFingerprints,
  type FlowFingerprint,
  fingerprintFromMetadata,
  fingerprintFromXml,
} from '../../src/core/flowFingerprint.js';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>64.0</apiVersion>
    <assignments>
        <name>Set_Status</name>
        <label>Set Status</label>
    </assignments>
    <decisions>
        <name>Is_Big</name>
        <label>Is Big</label>
    </decisions>
    <decisions>
        <name>Has_Owner</name>
        <label>Has Owner</label>
    </decisions>
    <processMetadataValues>
        <name>BuilderType</name>
    </processMetadataValues>
    <processType>AutoLaunchedFlow</processType>
    <start>
        <filterFormula>AND(
  ISPICKVAL({!$Record.Status__c}, "Open"),
  {!$Record.Amount__c} &gt; 5
)</filterFormula>
        <filters>
            <field>Amount__c</field>
            <operator>GreaterThan</operator>
            <value>
                <numberValue>5.0</numberValue>
            </value>
        </filters>
        <filters>
            <field>Is_Active__c</field>
            <operator>EqualTo</operator>
            <value>
                <booleanValue>true</booleanValue>
            </value>
        </filters>
        <filters>
            <field>Owner__c</field>
            <operator>IsNull</operator>
        </filters>
        <object>Order__c</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
    </start>
    <status>Active</status>
    <variables>
        <name>recordId</name>
        <dataType>String</dataType>
    </variables>
</Flow>
`;

/** The same Flow as the Tooling API returns it: typed values, nulls, empty lists, other order. */
const METADATA = {
  apiVersion: 64,
  actionCalls: [],
  assignments: [{ name: 'Set_Status', label: 'Set Status', locationX: 0 }],
  decisions: [
    { name: 'Has_Owner', label: 'Has Owner' },
    { name: 'Is_Big', label: 'Is Big' },
  ],
  environments: ['Default'],
  processMetadataValues: [{ name: 'BuilderType' }, { name: 'CanvasMode' }],
  processType: 'AutoLaunchedFlow',
  recordUpdates: [],
  start: {
    filterFormula: 'AND( ISPICKVAL({!$Record.Status__c}, "Open"), {!$Record.Amount__c} > 5 )',
    filterLogic: 'and',
    filters: [
      { field: 'Is_Active__c', operator: 'EqualTo', value: { booleanValue: true, stringValue: null } },
      { field: 'Amount__c', operator: 'GreaterThan', value: { numberValue: 5, stringValue: null } },
      { field: 'Owner__c', operator: 'IsNull', value: null },
    ],
    object: 'Order__c',
    recordTriggerType: 'CreateAndUpdate',
    triggerType: 'RecordAfterSave',
  },
  status: 'Active',
  triggerOrder: null,
  variables: [{ name: 'recordId', dataType: 'String' }],
};

const empty = (overrides: Partial<FlowFingerprint> = {}): FlowFingerprint => ({
  filters: [],
  elements: [],
  ...overrides,
});

describe('fingerprintFromXml and fingerprintFromMetadata', () => {
  it('fingerprint the same Flow the same way from source and from the Tooling API', () => {
    const fromXml = fingerprintFromXml(XML);
    expect(fromXml).toEqual({
      processType: 'AutoLaunchedFlow',
      triggerType: 'RecordAfterSave',
      recordTriggerType: 'CreateAndUpdate',
      object: 'Order__c',
      filters: ['Amount__c GreaterThan 5', 'Is_Active__c EqualTo true', 'Owner__c IsNull'],
      filterFormula: 'AND( ISPICKVAL({!$Record.Status__c}, "Open"), {!$Record.Amount__c} > 5 )',
      elements: ['assignments:Set_Status', 'decisions:Has_Owner', 'decisions:Is_Big', 'variables:recordId'],
    });
    expect(fingerprintFromMetadata(METADATA)).toEqual(fromXml);
    expect(compareFingerprints(fromXml, fingerprintFromMetadata(METADATA))).toEqual([]);
  });

  it('reads other filter value types and skips unnamed elements', () => {
    const fingerprint = fingerprintFromMetadata({
      start: {
        filters: [
          { field: 'A', operator: 'EqualTo', value: { stringValue: '  ', dateValue: '2026-01-31' } },
          { field: 'B', operator: 'EqualTo', value: { numberValue: 'n/a' } },
          { field: 'C', operator: 'EqualTo', value: { elementReference: 'var' } },
          'not a filter',
        ],
      },
      decisions: [{ label: 'No name' }, { name: '' }, null],
      screens: 'not a list',
    });
    expect(fingerprint).toEqual(empty({ filters: ['A EqualTo 2026-01-31', 'B EqualTo n/a', 'C EqualTo var'] }));
  });

  it('fingerprints missing metadata as empty', () => {
    expect(fingerprintFromMetadata(null)).toEqual(empty());
    expect(fingerprintFromMetadata({ start: { filters: [{}] } })).toEqual(empty({ filters: [''] }));
  });

  it('rejects content that is not a Flow', () => {
    expect(() => fingerprintFromXml('<CustomObject/>')).toThrow(/no <Flow> root element/);
  });
});

describe('compareFingerprints', () => {
  it('names each difference', () => {
    const source = empty({
      processType: 'AutoLaunchedFlow',
      triggerType: 'RecordAfterSave',
      object: 'Account',
      elements: ['decisions:A', 'decisions:B'],
    });
    const org = empty({ processType: 'AutoLaunchedFlow', object: 'Contact', elements: ['decisions:A', 'loops:C'] });
    expect(compareFingerprints(source, org)).toEqual([
      'triggerType is RecordAfterSave in source but none in the org',
      'object is Account in source but Contact in the org',
      'only in source: decisions:B',
      'only in the org: loops:C',
    ]);
  });

  it('reports changed entry criteria', () => {
    expect(compareFingerprints(empty({ filters: ['A EqualTo 1'] }), empty({ filters: ['A EqualTo 2'] }))).toEqual([
      'start entry criteria differ',
    ]);
    expect(compareFingerprints(empty({ filterFormula: 'x' }), empty())).toEqual(['start entry criteria differ']);
  });

  it('lists a repeated element name once', () => {
    expect(compareFingerprints(empty({ elements: ['loops:L', 'loops:L'] }), empty())).toEqual([
      'only in source: loops:L',
    ]);
  });

  it('shortens long element lists', () => {
    const elements = Array.from({ length: 7 }, (_, i) => `assignments:A${i}`);
    expect(compareFingerprints(empty({ elements }), empty())).toEqual([
      'only in source: assignments:A0, assignments:A1, assignments:A2, assignments:A3, assignments:A4 and 2 more',
    ]);
  });
});
