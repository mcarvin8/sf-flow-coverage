import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { generateApexTest } from '../../src/core/apexTemplate.js';
import { conditionFromFilters, conditionFromFormula } from '../../src/core/conditions.js';
import { globalValue, type SolveContext, solveCriteria } from '../../src/core/criteria.js';
import { type FlowGraph, walkFlow } from '../../src/core/flowGraph.js';
import { parseFlowXml } from '../../src/core/flowXml.js';
import { scaffoldTests } from '../../src/core/scaffold.js';

describe('globalValue', () => {
  it('reads labels and fields of the running user, their profile, and the org', () => {
    expect(globalValue('$Label.Default_Region')).toBe('System.Label.Default_Region');
    expect(globalValue('$Label.acme__Region')).toBe('System.Label.acme.Region');
    expect(globalValue('$User.Id')).toBe('UserInfo.getUserId()');
    expect(globalValue('$User.Department')).toBe(
      '[SELECT Department FROM User WHERE Id = :UserInfo.getUserId()].Department',
    );
    expect(globalValue('$Profile.Name')).toBe('[SELECT Name FROM Profile WHERE Id = :UserInfo.getProfileId()].Name');
    expect(globalValue('$Organization.Country')).toBe('[SELECT Country FROM Organization].Country');
  });

  it('reads nothing else', () => {
    for (const reference of ['$Permission.Can_Approve', '$Setup.S__c.F__c', '$User.Manager.Name', '$Label.', 'myVar']) {
      expect(globalValue(reference), reference).toBeUndefined();
    }
  });
});

describe('solveCriteria with resources and globals', () => {
  const ctx = (overrides: Partial<SolveContext> = {}): SolveContext => ({
    object: 'Job__c',
    context: 'insert',
    inserted: {},
    fieldValues: { Limit__c: '5', Region__c: "'East'" },
    changedValues: {},
    relationships: {},
    lookups: {},
    parentFieldValues: () => ({}),
    resource: (name) => ({ ClosedStage: "'Closed'", WeekAgo: 'Date.today().addDays(-7)' })[name],
    settingFieldValues: (setting): Record<string, string> => (setting === 'Limits__c' ? { Max__c: '10' } : {}),
    ...overrides,
  });
  const solve = (formula: string, overrides: Partial<SolveContext> = {}) => {
    const plan = solveCriteria(conditionFromFormula(formula), ctx(overrides));
    return {
      set: Object.fromEntries(plan.set),
      settings: Object.fromEntries([...plan.settings].map(([s, fields]) => [s, Object.fromEntries(fields)])),
      unmet: plan.unmet.length,
    };
  };

  it('compares with labels, user, profile, and org fields', () => {
    expect(solve('{!$Record.Region__c} = {!$Label.Default_Region}').set).toEqual({
      Region__c: 'System.Label.Default_Region',
    });
    expect(solve('{!$Record.Department__c} = {!$User.Department}').set).toEqual({
      Department__c: '[SELECT Department FROM User WHERE Id = :UserInfo.getUserId()].Department',
    });
    expect(solve('{!$Record.Region__c} = {!$Permission.Can_Approve}').unmet).toBe(1);
    // Start filters compare with globals the same way.
    const filters = conditionFromFilters(
      [{ field: 'Region__c', operator: 'EqualTo', rawValue: '$Label.Default_Region' }],
      undefined,
    );
    expect(Object.fromEntries(solveCriteria(filters, ctx()).set)).toEqual({ Region__c: 'System.Label.Default_Region' });
  });

  it('compares with constants and formula resources', () => {
    expect(solve('{!$Record.Stage__c} = {!ClosedStage}').set).toEqual({ Stage__c: "'Closed'" });
    expect(solve('{!$Record.Due__c} < {!WeekAgo}').set).toEqual({ Due__c: 'Date.today().addDays(-7).addDays(-1)' });
    expect(solve('{!$Record.Stage__c} = {!unknownVariable}').unmet).toBe(1);
    expect(solve('{!$Record.Stage__c} = {!ClosedStage}', { resource: undefined }).unmet).toBe(1);
  });

  it('inserts custom settings the criteria compare with', () => {
    // The setting's described value, and the field compared with it, past it.
    expect(solve('{!$Record.Limit__c} > {!$Setup.Limits__c.Max__c}')).toEqual({
      set: { Limit__c: '11' },
      settings: { Limits__c: { Max__c: '10' } },
      unmet: 0,
    });
    // Without a described value, the setting gets the value the compared field gets.
    expect(solve('{!$Record.Region__c} = {!$Setup.Defaults__c.Region__c}')).toMatchObject({
      set: { Region__c: "'East'" },
      settings: { Defaults__c: { Region__c: "'East'" } },
    });
    expect(
      solve('AND({!$Setup.Defaults__c.Region__c} = "West", {!$Record.Region__c} = {!$Setup.Defaults__c.Region__c})'),
    ).toMatchObject({ set: { Region__c: "'West'" }, unmet: 0 });
    expect(solve('{!$Record.Other__c} = {!$Setup.Defaults__c.Region__c}').unmet).toBe(1);
    expect(solve('{!$Record.Other__c} = {!$Setup.Limits__c.Max__c}', { settingFieldValues: undefined }).unmet).toBe(1);
    // One org-wide default holds one value per field.
    expect(solve('AND({!$Setup.Limits__c.Max__c} = 1, {!$Setup.Limits__c.Max__c} = 2)').unmet).toBe(1);
  });

  it('turns on, turns off, or leaves out custom settings the criteria check', () => {
    expect(solve('{!$Setup.Flow_Switch__c.Enabled__c}').settings).toEqual({ Flow_Switch__c: { Enabled__c: 'true' } });
    expect(solve('NOT({!$Setup.Bypass__c.Off__c})').settings).toEqual({ Bypass__c: { Off__c: 'false' } });
    expect(solve('ISBLANK({!$Setup.Bypass__c.Note__c})')).toMatchObject({ settings: {}, unmet: 0 });
    expect(solve('AND(ISBLANK({!$Setup.Bypass__c.Note__c}), {!$Setup.Bypass__c.Note__c} = "x")').unmet).toBe(1);
    expect(solve('AND({!$Setup.Bypass__c.Note__c} = "x", ISBLANK({!$Setup.Bypass__c.Note__c}))').unmet).toBe(1);
    expect(solve('ISCHANGED({!$Setup.Bypass__c.Note__c})', { context: 'update' }).unmet).toBe(1);
    expect(solve('{!$Label.Mode} = "On"').unmet).toBe(1);
  });

  it('meets NotEqualTo on a checkbox with the other value', () => {
    expect(solve('{!$Record.Active__c} <> TRUE').set).toEqual({ Active__c: 'false' });
    expect(solve('{!$Record.Active__c} <> FALSE').set).toEqual({ Active__c: 'true' });
  });
});

describe('constants in the Flow', () => {
  const flow = parseFlowXml(
    'Job_Flow',
    `<Flow><processType>AutoLaunchedFlow</processType>
      <constants><name>ClosedStage</name><dataType>String</dataType><value><stringValue>Closed</stringValue></value></constants>
      <constants><name>NoValue</name><dataType>String</dataType></constants>
      <formulas><name>WeekAgo</name><dataType>Date</dataType><expression>TODAY() - 7</expression></formulas>
      <formulas><name>Opaque</name><dataType>Number</dataType><expression>FOO()</expression></formulas>
      <decisions><name>Check</name><rules><name>Closed</name><conditionLogic>and</conditionLogic>
        <conditions><leftValueReference>$Record.Stage__c</leftValueReference><operator>EqualTo</operator><rightValue><elementReference>ClosedStage</elementReference></rightValue></conditions>
        <connector><targetReference>Mark</targetReference></connector></rules></decisions>
      <assignments><name>Mark</name><assignmentItems><assignToReference>$Record.Done__c</assignToReference><operator>Assign</operator><value><booleanValue>true</booleanValue></value></assignmentItems></assignments>
      <start><connector><targetReference>Check</targetReference></connector>
        <filterFormula>AND({!$Record.Stage__c} = {!ClosedStage}, {!$Record.Due__c} &lt; {!WeekAgo}, {!$Setup.Flow_Switch__c.Enabled__c})</filterFormula>
        <object>Job__c</object><recordTriggerType>Create</recordTriggerType><triggerType>RecordBeforeSave</triggerType>
      </start></Flow>`,
  );

  it('reads constant values', () => {
    expect(flow.graph?.constants).toEqual({ ClosedStage: "'Closed'" });
  });

  it('follows decisions that compare with a constant', () => {
    const walk = walkFlow(flow.graph as FlowGraph, new Map([['$Record.Stage__c', "'Closed'"]]));
    expect(walk.writes.map((w) => w.field)).toEqual(['Done__c']);
  });

  it('meets criteria on constants, formulas, and custom settings in a generated test', () => {
    const test = generateApexTest(flow, { requiredFields: { Job__c: {} } });
    expect(test.body).not.toContain('TODO: entry criteria');
    expect(test.body).toContain(
      'insert new Flow_Switch__c(SetupOwnerId = UserInfo.getOrganizationId(), Enabled__c = true);',
    );
    expect(test.body).toContain("Stage__c = 'Closed'");
    expect(test.body).toContain('Due__c = Date.today().addDays(-7).addDays(-1)');
    expect(test.body).toContain("Assert.areEqual(true, result.Done__c, 'Mark should set Done__c');");
  });

  it('inserts custom settings in update, delete, and platform event tests', () => {
    const switchOn = (start: string) =>
      generateApexTest(
        parseFlowXml(
          'F',
          `<Flow><processType>AutoLaunchedFlow</processType><start><filterFormula>{!$Setup.Flow_Switch__c.Enabled__c}</filterFormula>${start}</start></Flow>`,
        ),
        { requiredFields: { Job__c: {}, Job_Event__e: {} } },
      ).body;
    const insert = 'insert new Flow_Switch__c(SetupOwnerId = UserInfo.getOrganizationId(), Enabled__c = true);';
    expect(
      switchOn(
        '<object>Job__c</object><recordTriggerType>Update</recordTriggerType><triggerType>RecordAfterSave</triggerType>',
      ),
    ).toContain(insert);
    expect(
      switchOn(
        '<object>Job__c</object><recordTriggerType>Delete</recordTriggerType><triggerType>RecordBeforeDelete</triggerType>',
      ),
    ).toContain(insert);
    expect(switchOn('<object>Job_Event__e</object><triggerType>PlatformEvent</triggerType>')).toContain(insert);
  });

  it('describes custom settings the criteria read when scaffolding', async () => {
    const project = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-setup-'));
    try {
      mkdirSync(join(project, 'flows'));
      writeFileSync(
        join(project, 'flows', 'Job_Flow.flow-meta.xml'),
        `<Flow><processType>AutoLaunchedFlow</processType><status>Active</status><start>
          <filters><field>Limit__c</field><operator>GreaterThan</operator><value><elementReference>$Setup.Limits__c.Max__c</elementReference></value></filters>
          <filters><field>Name</field><operator>IsChanged</operator></filters>
          <filterLogic>1 OR 2</filterLogic>
          <object>Job__c</object><recordTriggerType>Create</recordTriggerType><triggerType>RecordAfterSave</triggerType>
        </start></Flow>`,
      );
      const field = (name: string, type: string) => ({
        name,
        type,
        nillable: true,
        createable: true,
        defaultedOnCreate: false,
      });
      const described: string[] = [];
      await scaffoldTests({
        flowNames: ['Job_Flow'],
        projectDir: project,
        outputDir: join(project, 'out'),
        describe: async (object) => {
          described.push(object);
          return object === 'Limits__c' ? [field('Max__c', 'double')] : [field('Limit__c', 'double')];
        },
      });
      expect(described).toEqual(['Job__c', 'Limits__c']);
      const test = readFileSync(join(project, 'out', 'Job_Flow_FlowTest.cls'), 'utf8');
      expect(test).toMatch(/insert new Limits__c\(SetupOwnerId = UserInfo.getOrganizationId\(\), Max__c = [\d.]+\);/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
