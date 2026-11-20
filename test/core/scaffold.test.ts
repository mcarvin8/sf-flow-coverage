import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findFlowFiles, readProjectConfig } from '../../src/core/projectFiles.js';
import { DEFAULT_APEX_API_VERSION, scaffoldTests } from '../../src/core/scaffold.js';
import { FIXTURE_FLOWS, FIXTURE_PROJECT } from '../helpers.js';

describe('scaffoldTests', () => {
  let out: string;

  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-out-'));
  });

  afterEach(() => rmSync(out, { recursive: true, force: true }));

  it('writes a class and meta file per counted Flow and skips the rest', async () => {
    const result = await scaffoldTests({
      flowNames: ['Account_After_Save', 'Account_After_Save', 'Intake_Screen', 'Broken', 'Missing'],
      projectDir: FIXTURE_PROJECT,
      outputDir: out,
    });

    expect(result.created).toEqual([
      {
        flowName: 'Account_After_Save',
        className: 'Account_After_Save_FlowTest',
        path: join(out, 'Account_After_Save_FlowTest.cls'),
      },
    ]);
    expect(result.skipped.map((s) => s.flowName)).toEqual(['Intake_Screen', 'Broken', 'Missing']);
    expect(result.skipped[0].reason).toContain('Process type Flow');
    expect(result.skipped[1].reason).toContain('not a Flow metadata file');
    expect(result.skipped[2].reason).toContain('No Missing.flow-meta.xml found');
    expect(readFileSync(join(out, 'Account_After_Save_FlowTest.cls'), 'utf8')).toContain('@IsTest');
    expect(readFileSync(join(out, 'Account_After_Save_FlowTest.cls-meta.xml'), 'utf8')).toContain(
      '<apiVersion>64.0</apiVersion>',
    );
  });

  it('describes the objects each test creates', async () => {
    const described: string[] = [];
    const result = await scaffoldTests({
      flowNames: ['Invoice_Before_Delete', 'Calculate_Discount', 'Order_Event_Handler', 'Weekly_Digest'],
      projectDir: FIXTURE_PROJECT,
      outputDir: out,
      describe: async (name) => {
        described.push(name);
        return [{ name: 'Amount__c', type: 'currency', nillable: false, createable: true, defaultedOnCreate: false }];
      },
    });
    expect(result.created).toHaveLength(4);
    expect(described).toEqual(['Invoice__c', 'Account', 'Widget__c', 'Order_Event__e']);
    const invoice = readFileSync(join(out, 'Invoice_Before_Delete_FlowTest.cls'), 'utf8');
    expect(invoice).toContain('Amount__c = 1');
    expect(invoice).not.toContain('TODO: set the required fields');
  });

  it('describes the parents of required lookups and of lookups in the entry criteria', async () => {
    const project = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-parents-'));
    try {
      mkdirSync(join(project, 'flows'));
      writeFileSync(
        join(project, 'flows', 'Job_Flow.flow-meta.xml'),
        `<Flow><processType>AutoLaunchedFlow</processType><status>Active</status><start>
          <filters><field>Contact__c</field><operator>IsNull</operator><value><booleanValue>false</booleanValue></value></filters>
          <filterFormula>AND(NOT(ISBLANK({!$Record.Site__c})), {!$Record.Region__r.Name} = &quot;West&quot;)</filterFormula>
          <object>Job__c</object><recordTriggerType>Create</recordTriggerType><triggerType>RecordAfterSave</triggerType>
        </start></Flow>`,
      );
      const described: string[] = [];
      const reference = (name: string, target: string, nillable = true) => ({
        name,
        type: 'reference',
        nillable,
        createable: true,
        defaultedOnCreate: false,
        referenceTo: [target],
        relationshipName: name.replace(/__c$/, '__r'),
      });
      await scaffoldTests({
        flowNames: ['Job_Flow'],
        projectDir: project,
        outputDir: out,
        describe: async (name) => {
          described.push(name);
          const name_ = { name: 'Name', type: 'string', nillable: false, createable: true, defaultedOnCreate: false };
          // Account requires a lookup to Territory__c, which the test inserts first.
          if (name === 'Account')
            return { fields: [name_, reference('Territory__c', 'Territory__c', false)], recordTypeInfos: [{}] };
          if (name !== 'Job__c') return [name_];
          return [
            reference('Account__c', 'Account', false),
            reference('Contact__c', 'Contact'),
            reference('Site__c', 'Site__c'),
            reference('Approver__c', 'User', false),
            reference('Other__c', 'Other__c'),
            reference('Region__c', 'Region__c'),
          ];
        },
      });
      expect(described).toEqual(['Job__c', 'Account', 'Contact', 'Site__c', 'Region__c', 'Territory__c']);
      const test = readFileSync(join(out, 'Job_Flow_FlowTest.cls'), 'utf8');
      expect(test).toContain('Account__c = accountParent.Id');
      expect(test).toContain('Territory__c = territoryParent.Id');
      expect(test).toContain('Approver__c = UserInfo.getUserId()');
      expect(test).toContain('Contact__c = contactParent.Id');
      expect(test).toContain('Site__c = siteParent.Id');
      expect(test).toContain("Region__c regionParent = new Region__c(\n            Name = 'West'\n        );");
      expect(test).toContain('Region__c = regionParent.Id');
      expect(test).not.toContain('TODO: entry criteria');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('describes the objects behind text inputs an autolaunched Flow uses as Ids', async () => {
    const project = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-inputs-'));
    try {
      mkdirSync(join(project, 'flows'));
      writeFileSync(
        join(project, 'flows', 'Find_Flow.flow-meta.xml'),
        `<Flow><processType>AutoLaunchedFlow</processType><status>Active</status>
          <variables><name>itemId</name><dataType>String</dataType><isInput>true</isInput><isOutput>false</isOutput><isCollection>false</isCollection></variables>
          <variables><name>siteId</name><dataType>String</dataType><isInput>true</isInput><isOutput>false</isOutput><isCollection>false</isCollection></variables>
          <variables><name>notInput</name><dataType>String</dataType><isInput>false</isInput><isOutput>false</isOutput><isCollection>false</isCollection></variables>
          <recordLookups><name>Find</name><object>Item__c</object><storeOutputAutomatically>true</storeOutputAutomatically>
            <filters><field>Id</field><operator>EqualTo</operator><value><elementReference>itemId</elementReference></value></filters>
            <filters><field>Site__c</field><operator>EqualTo</operator><value><elementReference>siteId</elementReference></value></filters>
            <filters><field>Other__c</field><operator>EqualTo</operator><value><elementReference>notInput</elementReference></value></filters>
          </recordLookups>
          <start><connector><targetReference>Find</targetReference></connector></start>
        </Flow>`,
      );
      const described: string[] = [];
      const required = { name: 'Name', type: 'string', nillable: false, createable: true, defaultedOnCreate: false };
      await scaffoldTests({
        flowNames: ['Find_Flow'],
        projectDir: project,
        outputDir: out,
        describe: async (name) => {
          described.push(name);
          if (name !== 'Item__c') return [required];
          return [
            required,
            { ...required, name: 'Site__c', type: 'reference', nillable: true, referenceTo: ['Site__c'] },
            { ...required, name: 'Other__c', type: 'reference', nillable: true, referenceTo: ['Other__c'] },
          ];
        },
      });
      expect(described).toEqual(['Item__c', 'Site__c']);
      const test = readFileSync(join(out, 'Find_Flow_FlowTest.cls'), 'utf8');
      expect(test).toContain("inputs.put('itemId', itemIdRecord.Id);");
      expect(test).toContain("inputs.put('siteId', siteIdRecord.Id);");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not overwrite existing classes unless forced', async () => {
    const classPath = join(out, 'Contact_Process_FlowTest.cls');
    writeFileSync(classPath, 'existing');
    const skipped = await scaffoldTests({
      flowNames: ['Contact_Process'],
      projectDir: FIXTURE_PROJECT,
      outputDir: out,
    });
    expect(skipped.skipped[0].reason).toContain('already exists');
    expect(readFileSync(classPath, 'utf8')).toBe('existing');

    const forced = await scaffoldTests({
      flowNames: ['Contact_Process'],
      projectDir: FIXTURE_PROJECT,
      outputDir: out,
      force: true,
    });
    expect(forced.created).toHaveLength(1);
    expect(readFileSync(classPath, 'utf8')).toContain('@IsTest');
  });

  it('writes nothing on a dry run', async () => {
    const result = await scaffoldTests({
      flowNames: ['Case_Update'],
      projectDir: FIXTURE_PROJECT,
      outputDir: join(out, 'nested'),
      dryRun: true,
    });
    expect(result.created).toHaveLength(1);
    expect(existsSync(join(out, 'nested'))).toBe(false);
  });

  it('defaults to the default package classes folder and API version', async () => {
    writeFileSync(join(out, 'Solo.flow-meta.xml'), readFileSync(join(FIXTURE_FLOWS, 'Weekly_Digest.flow-meta.xml')));
    const result = await scaffoldTests({ flowNames: ['Solo'], projectDir: out });
    const expected = join(out, 'force-app', 'main', 'default', 'classes', 'Solo_FlowTest.cls');
    expect(result.created[0].path).toBe(expected);
    expect(readFileSync(`${expected}-meta.xml`, 'utf8')).toContain(
      `<apiVersion>${DEFAULT_APEX_API_VERSION}</apiVersion>`,
    );
  });
});

describe('projectFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-proj-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds Flow files and ignores tool folders', async () => {
    const flows = await findFlowFiles(FIXTURE_PROJECT);
    expect(flows.get('Account_After_Save')).toBe(join(FIXTURE_FLOWS, 'Account_After_Save.flow-meta.xml'));
    expect(flows.size).toBe(12);

    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'Hidden.flow-meta.xml'), '');
    writeFileSync(join(dir, 'Visible.flow'), '');
    expect([...(await findFlowFiles(dir)).keys()]).toEqual(['Visible']);
  });

  it('reads sfdx-project.json', async () => {
    expect(await readProjectConfig(FIXTURE_PROJECT)).toEqual({
      defaultPackagePath: 'force-app',
      sourceApiVersion: '64.0',
    });
  });

  it('falls back to the first package directory and ignores bad files', async () => {
    writeFileSync(
      join(dir, 'sfdx-project.json'),
      JSON.stringify({ packageDirectories: [{ path: 'src' }], sourceApiVersion: 64 }),
    );
    expect(await readProjectConfig(dir)).toEqual({ defaultPackagePath: 'src', sourceApiVersion: undefined });

    writeFileSync(join(dir, 'sfdx-project.json'), '{}');
    expect(await readProjectConfig(dir)).toEqual({ defaultPackagePath: undefined, sourceApiVersion: undefined });

    writeFileSync(join(dir, 'sfdx-project.json'), 'not json');
    expect(await readProjectConfig(dir)).toEqual({});

    rmSync(join(dir, 'sfdx-project.json'));
    expect(await readProjectConfig(dir)).toEqual({});
  });
});
