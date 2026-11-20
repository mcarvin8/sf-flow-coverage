import { describe, expect, it } from 'vitest';

import { escapeApexString, parseFlowXml } from '../../src/core/flowXml.js';
import { readFlowFixture } from '../helpers.js';

describe('parseFlowXml', () => {
  it('reads a record-triggered Flow start, filters and status', async () => {
    const flow = parseFlowXml('Account_After_Save', await readFlowFixture('Account_After_Save'));
    expect(flow).toMatchObject({
      name: 'Account_After_Save',
      label: 'Account After Save',
      processType: 'AutoLaunchedFlow',
      status: 'Active',
      triggerType: 'RecordAfterSave',
      recordTriggerType: 'CreateAndUpdate',
      object: 'Account',
      filterLogic: 'and',
    });
    expect(flow.filters).toEqual([
      { field: 'Type', operator: 'EqualTo', apexValue: "'Customer - Direct'", rawValue: 'Customer - Direct' },
      { field: 'AnnualRevenue', operator: 'GreaterThan', apexValue: '1000.0', rawValue: '1000.0' },
      { field: 'Rating', operator: 'IsChanged', apexValue: 'true', rawValue: 'true' },
    ]);
  });

  it('turns filter values into Apex literals where possible', async () => {
    const flow = parseFlowXml('Opportunity_Create', await readFlowFixture('Opportunity_Create'));
    expect(flow.filters).toEqual([
      { field: 'CloseDate', operator: 'EqualTo', apexValue: "Date.valueOf('2026-12-31')", rawValue: '2026-12-31' },
      { field: 'Probability', operator: 'EqualTo', apexValue: '50', rawValue: '50' },
      { field: 'OwnerId', operator: 'EqualTo', rawValue: '$User.Id' },
      { field: 'Description', operator: 'IsNull' },
    ]);
  });

  it('reads booleans as false unless true, and skips incomplete filters', () => {
    const xml = `<Flow><processType>AutoLaunchedFlow</processType><start>
      <filters><field>A</field><operator>EqualTo</operator><value><booleanValue>false</booleanValue></value></filters>
      <filters><field>B</field><operator>EqualTo</operator><value><numberValue>abc</numberValue></value></filters>
      <filters><field>C</field><operator>EqualTo</operator><value><dateTimeValue>2026-01-01T00:00:00Z</dateTimeValue></value></filters>
      <filters><operator>EqualTo</operator></filters>
    </start></Flow>`;
    expect(parseFlowXml('X', xml).filters).toEqual([
      { field: 'A', operator: 'EqualTo', apexValue: 'false', rawValue: 'false' },
      { field: 'B', operator: 'EqualTo' },
      { field: 'C', operator: 'EqualTo', rawValue: '2026-01-01T00:00:00Z' },
    ]);
  });

  it('reads variables', async () => {
    const flow = parseFlowXml('Calculate_Discount', await readFlowFixture('Calculate_Discount'));
    expect(flow.triggerType).toBeUndefined();
    expect(flow.variables).toHaveLength(13);
    expect(flow.variables[0]).toEqual({
      name: 'accountRecord',
      dataType: 'SObject',
      isInput: true,
      isOutput: false,
      isCollection: false,
      objectType: 'Account',
      apexClass: undefined,
    });
    expect(flow.variables.find((v) => v.name === 'discount')).toMatchObject({ isOutput: true, isInput: false });
  });

  it('defaults variable data type and skips unnamed variables', () => {
    const xml = '<Flow><variables><name>v</name></variables><variables><dataType>String</dataType></variables></Flow>';
    expect(parseFlowXml('X', xml).variables).toEqual([
      {
        name: 'v',
        dataType: 'String',
        isInput: false,
        isOutput: false,
        isCollection: false,
        objectType: undefined,
        apexClass: undefined,
      },
    ]);
  });

  it('handles a Flow with no start element', () => {
    const flow = parseFlowXml('X', '<Flow><processType>Workflow</processType></Flow>');
    expect(flow.filters).toEqual([]);
    expect(flow.object).toBeUndefined();
  });

  it('throws for non-Flow XML', async () => {
    expect(() => parseFlowXml('Broken', '<CustomObject/>')).toThrow(/not a Flow metadata file/);
    expect(() => parseFlowXml('Empty', '')).toThrow(/not a Flow metadata file/);
  });

  it('escapes Apex strings', () => {
    expect(escapeApexString("it's a\\b\nc")).toBe("it\\'s a\\\\b\\nc");
  });
});
