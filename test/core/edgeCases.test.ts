import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateApexTest } from '../../src/core/apexTemplate.js';
import {
  conditionFromFormula,
  conditionFromRule,
  type EvaluationEnv,
  evaluateCondition,
  evaluateExpr,
  fieldPaths,
  negate,
} from '../../src/core/conditions.js';
import { type SolveContext, solveCriteria } from '../../src/core/criteria.js';
import { type FlowGraph, walkFlow } from '../../src/core/flowGraph.js';
import { text } from '../../src/core/flowValues.js';
import { parseFlowXml } from '../../src/core/flowXml.js';
import { type Expr, parseFormula } from '../../src/core/formula.js';
import { lookupFilterReader } from '../../src/core/lookupFilters.js';
import { OrgCoverageSource } from '../../src/core/orgCoverageSource.js';
import { scaffoldTests } from '../../src/core/scaffold.js';
import { buildFlowFileCoverage } from '../../src/core/transform.js';
import type { FlowMetadata, ToolingQuery } from '../../src/core/types.js';
import { validationRuleReader } from '../../src/core/validationRules.js';
import { coverage, fakeSource } from '../helpers.js';

const env = (values: Record<string, string | null>): EvaluationEnv => ({
  get: (reference) => (reference in values ? values[reference] : undefined),
});

const jobFlow = (elements: string, recordTriggerType = 'Create', start = ''): FlowMetadata =>
  parseFlowXml(
    'Job_Flow',
    `<Flow><processType>AutoLaunchedFlow</processType>${elements}<start>
      <connector><targetReference>First</targetReference></connector>${start}
      <object>Job__c</object><recordTriggerType>${recordTriggerType}</recordTriggerType><triggerType>RecordAfterSave</triggerType>
    </start></Flow>`,
  );

describe('text', () => {
  it('reads strings, numbers, and booleans, and nothing else', () => {
    expect(text('a')).toBe('a');
    expect(text(5)).toBe('5');
    expect(text(true)).toBe('true');
    expect(text({})).toBeUndefined();
    expect(text(null)).toBeUndefined();
  });
});

describe('parseFlowGraph with incomplete metadata', () => {
  it('reads elements that leave out names, operators, and values', () => {
    const graph = parseFlowXml(
      'F',
      `<Flow><processType>AutoLaunchedFlow</processType>
        <assignments><name>First</name>
          <assignmentItems><value><stringValue>x</stringValue></value></assignmentItems>
          <assignmentItems><assignToReference>$Record.A__c</assignToReference><value><stringValue>a</stringValue></value></assignmentItems>
          <assignmentItems><assignToReference>$Record.B__c</assignToReference><operator>Add</operator></assignmentItems>
          <connector><targetReference>Check</targetReference></connector>
        </assignments>
        <assignments><label>No name</label></assignments>
        <decisions><name>Check</name><rules><conditions><rightValue><stringValue>x</stringValue></rightValue></conditions></rules></decisions>
        <formulas><name>noExpression</name></formulas>
        <start><connector><targetReference>First</targetReference></connector></start>
      </Flow>`,
    ).graph as FlowGraph;
    expect(Object.keys(graph.nodes)).toEqual(['First', 'Check']);
    expect(graph.formulas).toEqual({});
    const walk = walkFlow(graph, new Map());
    expect(walk.writes.map((w) => [w.field, w.value.apexValue ?? w.value.rawValue])).toEqual([
      ['A__c', "'a'"],
      ['B__c', 'Add'],
    ]);
    const check = graph.nodes.Check;
    expect(check.kind === 'decision' && check.rules[0].name).toBe('');
  });
});

describe('conditions at the edges', () => {
  it('reads rules without logic, prior values of variables, and mirrored equality', () => {
    const rule = conditionFromRule(
      [{ left: '$Record.A__c', operator: 'EqualTo', right: { apexValue: '1' } }],
      undefined,
    );
    expect(evaluateCondition(rule, env({ '$Record.A__c': '1' }))).toBe(true);
    // PRIORVALUE of something that isn't a record field is an expression.
    const prior = conditionFromFormula('PRIORVALUE(myVar) = 1');
    expect(prior.kind === 'atom' && prior.left.kind).toBe('expr');
    // Equality reads the same either way round.
    const swapped = conditionFromFormula('5 = {!$Record.A__c}');
    expect(swapped.kind === 'atom' && [swapped.op, swapped.left.kind]).toEqual(['EqualTo', 'field']);
  });

  it('finds field paths under NOT and skips opaque parts', () => {
    expect(
      fieldPaths(conditionFromFormula('AND(NOT({!$Record.A__c}), FOO(), {!$Record.B__c} = {!$Record.C__c})')),
    ).toEqual([['A__c'], ['B__c'], ['C__c']]);
  });

  it('negates IsNull false to IsNull true', () => {
    const negated = negate(conditionFromFormula('NOT(ISBLANK({!$Record.A__c}))'));
    expect(negated.kind === 'atom' && negated.right).toEqual({ kind: 'value', apex: 'true' });
  });

  it('evaluates ENDS WITH, boolean operators, and the false branch of IF', () => {
    const value = (formula: string, values: Record<string, string | null> = {}) =>
      evaluateExpr(parseFormula(formula) as Expr, env(values));
    expect(value('!TRUE')).toEqual({ kind: 'boolean', value: false });
    expect(value('TRUE && FALSE')).toEqual({ kind: 'boolean', value: false });
    expect(value('FALSE || TRUE')).toEqual({ kind: 'boolean', value: true });
    expect(value('IF(FALSE, 1, 2)')).toEqual({ kind: 'number', value: 2 });
    expect(value('TODAY(1)')).toBeUndefined();
    const endsWith = conditionFromRule(
      [{ left: '$Record.Code__c', operator: 'EndsWith', right: { apexValue: "'-X'" } }],
      'and',
    );
    expect(evaluateCondition(endsWith, env({ '$Record.Code__c': "'AB-X'" }))).toBe(true);
    // IsChanged on something that isn't a record field can't be decided.
    const changed = conditionFromRule([{ left: 'myVar', operator: 'IsChanged', right: { rawValue: 'true' } }], 'and');
    expect(evaluateCondition(changed, env({ myVar: '1' }))).toBeUndefined();
  });
});

describe('solveCriteria at the edges', () => {
  const ctx = (overrides: Partial<SolveContext> = {}): SolveContext => ({
    object: 'Job__c',
    context: 'insert',
    inserted: {},
    fieldValues: { Count__c: "'many'", Name: "'Test'" },
    changedValues: { Count__c: '2' },
    relationships: { Account__r: 'Account__c' },
    lookups: { Account__c: 'Account' },
    parentFieldValues: () => ({}),
    ...overrides,
  });
  const unmet = (formula: string, overrides: Partial<SolveContext> = {}) =>
    solveCriteria(conditionFromFormula(formula), ctx(overrides)).unmet.length;

  it('keeps a field another condition filled, and compares with variables only by TODO', () => {
    expect(unmet('AND({!$Record.Name} = "A", NOT(ISBLANK({!$Record.Name})))')).toBe(0);
    expect(unmet('{!$Record.Name} <> {!myVar}')).toBe(1);
    // Neither candidate is a number, so neither can be shown to differ from 1.
    expect(unmet('{!$Record.Count__c} <> 1', { changedValues: {} })).toBe(1);
    expect(unmet('{!$Record.RecordType.DeveloperName} = {!myVar}')).toBe(1);
  });

  it('compares with a field the update already sets, and not with one it cannot write', () => {
    const update = ctx({ context: 'update', fieldValues: { Cap__c: '4' } });
    const plan = solveCriteria(
      conditionFromFormula('AND({!$Record.Cap__c} = 6, {!$Record.Hours__c} > {!$Record.Cap__c})'),
      update,
    );
    expect(Object.fromEntries(plan.set)).toEqual({ Cap__c: '6', Hours__c: '7' });
    expect(
      unmet('{!$Record.Hours__c} > {!$Record.Cap__c}', {
        fieldValues: { Cap__c: '4' },
        writable: (_, f) => f !== 'Cap__c',
      }),
    ).toBe(1);
  });

  it('leaves values a restricted picklist lacks as TODOs, before the update and on parents', () => {
    const normalize = (_: string, field: string, apex: string) =>
      field === 'Stage__c' || field === 'Tier__c' ? null : apex;
    expect(unmet('PRIORVALUE({!$Record.Stage__c}) = "Old"', { context: 'update', normalize })).toBe(1);
    expect(
      unmet('{!$Record.Account__r.Tier__c} = "Gold"', { normalize, fieldValues: { Account__c: 'accountParent.Id' } }),
    ).toBe(1);
  });
});

describe('generateApexTest at the edges', () => {
  it('expects a custom error certain on insert, with nothing to check after the insert', () => {
    const test = generateApexTest(
      jobFlow(
        '<customErrors><name>First</name><customErrorMessages><errorMessage>No</errorMessage></customErrorMessages></customErrors>',
      ),
    );
    expect(test.body).toContain("Assert.isTrue(e.getMessage().contains('No'), e.getMessage());");
    expect(test.body).not.toContain('result');
  });

  it('reads a lookup on standard data the test never creates as empty', () => {
    const test = generateApexTest(
      jobFlow(
        `<recordLookups><name>First</name><object>Contact</object><storeOutputAutomatically>true</storeOutputAutomatically><connector><targetReference>Check</targetReference></connector></recordLookups>
         <decisions><name>Check</name><rules><name>Found</name><conditionLogic>and</conditionLogic><conditions><leftValueReference>First</leftValueReference><operator>IsNull</operator><rightValue><booleanValue>false</booleanValue></rightValue></conditions><connector><targetReference>Set</targetReference></connector></rules><defaultConnector><targetReference>Other</targetReference></defaultConnector></decisions>
         <assignments><name>Set</name><assignmentItems><assignToReference>$Record.A__c</assignToReference><operator>Assign</operator><value><stringValue>found</stringValue></value></assignmentItems></assignments>
         <assignments><name>Other</name><assignmentItems><assignToReference>$Record.A__c</assignToReference><operator>Assign</operator><value><stringValue>none</stringValue></value></assignmentItems></assignments>`,
      ),
    );
    expect(test.body).toContain("Assert.areEqual('none', result.A__c, 'Other should set A__c');");
  });

  it('notes writes it cannot name a value for, on certain paths and on other branches', () => {
    const test = generateApexTest(
      jobFlow(
        `<assignments><name>First</name><assignmentItems><assignToReference>$Record.A__c</assignToReference><operator>Assign</operator><value><numberValue>x</numberValue></value></assignmentItems><connector><targetReference>Check</targetReference></connector></assignments>
         <decisions><name>Check</name><rules><name>R</name><conditionLogic>and</conditionLogic><conditions><leftValueReference>$Record.B__c</leftValueReference><operator>IsNull</operator><rightValue><booleanValue>true</booleanValue></rightValue></conditions><connector><targetReference>Later</targetReference></connector></rules></decisions>
         <assignments><name>Later</name><assignmentItems><assignToReference>$Record.C__c</assignToReference><operator>Assign</operator><value><numberValue>y</numberValue></value></assignmentItems></assignments>`,
      ),
    );
    expect(test.body).toContain('// TODO: First sets A__c to a value; assert it');
    expect(test.body).toContain('//   sets C__c to a value (Later)');
  });

  it('merges parent fields both tests of a create-and-update Flow need, once', () => {
    const test = generateApexTest(
      jobFlow('', 'CreateAndUpdate', '<filterFormula>{!$Record.Account__r.Type} = "Partner"</filterFormula>'),
      {
        requiredFields: { Job__c: { Account__c: 'null /* TODO */' }, Account: { Name: "'A'" } },
        lookups: { Job__c: { Account__c: 'Account' } },
        relationships: { Job__c: { Account__r: 'Account__c' } },
      },
    );
    expect(test.body.match(/Type = 'Partner'/g)).toHaveLength(2);
  });

  it('names a validation rule without a message, and a lookup filter without one', () => {
    const test = generateApexTest(
      jobFlow(
        '',
        'Create',
        '<filters><field>Status__c</field><operator>EqualTo</operator><value><stringValue>Closed</stringValue></value></filters>',
      ),
      {
        requiredFields: { Job__c: { Account__c: 'null /* TODO */' }, Account: { Name: "'A'" } },
        lookups: { Job__c: { Account__c: 'Account' } },
        validationRules: { Job__c: [{ name: 'Never_Closed', formula: 'ISPICKVAL(Status__c, "Closed")' }] },
        lookupFilters: {
          Job__c: [
            { lookup: 'Account__c', items: [{ field: 'Account.Tags__c', operation: 'includes', value: 'Gold' }] },
          ],
        },
        relationships: { Job__c: { Account__r: 'Account__c' } },
      },
    );
    expect(test.body).toContain('// TODO: validation rule: Never_Closed\n');
    expect(test.body).toContain('// TODO: lookup filter: Account__c\n');
    // Without relationship names from the describe, the filter can't be read as a condition.
    const noRelationships = generateApexTest(jobFlow(''), {
      requiredFields: { Job__c: { Account__c: 'null /* TODO */' }, Account: { Name: "'A'" } },
      lookups: { Job__c: { Account__c: 'Account' } },
      lookupFilters: { Job__c: [{ lookup: 'Account__c', items: [] }] },
    });
    expect(noRelationships.body).not.toContain('lookup filter');
  });

  it('meets a lookup filter when an update test sets the lookup in the insert', () => {
    const test = generateApexTest(
      jobFlow(
        '',
        'Update',
        '<filters><field>Stage__c</field><operator>EqualTo</operator><value><stringValue>Open</stringValue></value></filters>',
      ),
      {
        requiredFields: { Job__c: { Account__c: 'null /* TODO */' }, Account: { Name: "'A'" } },
        lookups: { Job__c: { Account__c: 'Account' } },
        relationships: { Job__c: { Account__r: 'Account__c' } },
        createOnlyFields: { Job__c: ['Account__c'] },
        lookupFilters: {
          Job__c: [
            { lookup: 'Account__c', items: [{ field: 'Account.Type', operation: 'equals', value: 'Customer' }] },
          ],
        },
      },
    );
    expect(test.body).toContain("Type = 'Customer'");
  });

  it('inserts a parent two lookups share once, before the record', () => {
    const test = generateApexTest(jobFlow(''), {
      requiredFields: {
        Job__c: { Account__c: 'null /* TODO */', Contact__c: 'null /* TODO */' },
        Contact: { LastName: "'C'", AccountId: 'null /* TODO */' },
        Account: { Name: "'A'" },
      },
      lookups: { Job__c: { Contact__c: 'Contact', Account__c: 'Account' }, Contact: { AccountId: 'Account' } },
    });
    expect(test.body.match(/insert accountParent;/g)).toHaveLength(1);
    expect(test.body.indexOf('insert accountParent;')).toBeLessThan(test.body.indexOf('insert contactParent;'));
  });

  it('starts a Flow without an element graph and names oddly named variables', () => {
    const flow: FlowMetadata = {
      name: 'Calc',
      processType: 'AutoLaunchedFlow',
      filters: [],
      variables: [
        { name: '__c', dataType: 'SObject', objectType: 'Job__c', isInput: true, isOutput: false, isCollection: false },
        { name: '_', dataType: 'String', isInput: false, isOutput: true, isCollection: false },
      ],
    };
    const test = generateApexTest(flow, { requiredFields: { Job__c: {} } });
    expect(test.body).toContain('Job__c input = new Job__c();'.replace('input', 'inputInput'));
    expect(test.body).toContain("Object outputOutput = interview.getVariableValue('_');");
  });

  it('asserts no outputs when an autolaunched Flow raises a custom error, or sets them to unknown values', () => {
    const autolaunched = (elements: string) =>
      parseFlowXml(
        'Calc',
        `<Flow><processType>AutoLaunchedFlow</processType>
          <variables><name>out</name><dataType>String</dataType><isInput>false</isInput><isOutput>true</isOutput><isCollection>false</isCollection></variables>
          ${elements}<start><connector><targetReference>First</targetReference></connector></start></Flow>`,
      );
    const failing = generateApexTest(autolaunched('<customErrors><name>First</name></customErrors>'));
    expect(failing.body).toContain("Object outOutput = interview.getVariableValue('out');");
    const unknown = generateApexTest(
      autolaunched(
        `<assignments><name>First</name><assignmentItems><assignToReference>out</assignToReference><operator>Assign</operator><value><stringValue>a</stringValue></value></assignmentItems><assignmentItems><assignToReference>out</assignToReference><operator>Assign</operator><value><elementReference>other</elementReference></value></assignmentItems></assignments>`,
      ),
    );
    expect(unknown.body).toContain("Object outOutput = interview.getVariableValue('out');");
  });
});

describe('readers at the edges', () => {
  const query = (answer: (soql: string) => Array<Record<string, unknown>>) =>
    (async (soql: string) => answer(soql)) as ToolingQuery;

  it('reads a validation rule without an error message', async () => {
    const read = validationRuleReader(
      query((soql) =>
        soql.includes('Active = true')
          ? [{ Id: '03d1', ValidationName: 'Rule' }]
          : [{ Metadata: { errorConditionFormula: 'ISBLANK(Name)' } }],
      ),
    );
    expect(await read('Job__c')).toEqual([{ name: 'Rule', formula: 'ISBLANK(Name)', message: undefined }]);
  });

  it('reads a lookup filter with no items', async () => {
    const read = lookupFilterReader(async () => ({ fullName: 'Job__c.Account__c', lookupFilter: { active: true } }));
    expect(await read('Job__c', ['Account__c'])).toEqual([{ lookup: 'Account__c', items: [] }]);
  });

  it('counts covered elements for a test that ran none of them', async () => {
    const source = new OrgCoverageSource(
      query((soql) => {
        if (soql.includes('FROM Flow ')) {
          return [{ Id: '301000000000001AAA', ProcessType: 'AutoLaunchedFlow', Definition: { DeveloperName: 'F' } }];
        }
        if (soql.includes('FROM FlowTestCoverage')) {
          return [{ Id: 'C1', FlowVersionId: '301000000000001AAA', NumElementsCovered: 0, NumElementsNotCovered: 2 }];
        }
        return [];
      }),
    );
    const [flow] = await source.listActiveCountedFlows();
    expect(flow).toMatchObject({ covered: true, elementsCovered: 0, coveredElementNames: [] });
  });

  it('warns about a source file mismatch without a version number', async () => {
    const project = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-edge-'));
    try {
      writeFileSync(join(project, 'F.flow-meta.xml'), '<Flow><decisions><name>A</name></decisions></Flow>');
      const report = await buildFlowFileCoverage({
        projectDir: project,
        source: fakeSource([
          coverage('F', { versionNumber: undefined, elementsCovered: 1, elementsTotal: 3, coveredElementNames: ['a'] }),
        ]),
      });
      expect(report.warnings[0]).toContain('version ? in the org');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('scaffoldTests at the edges', () => {
  let project: string;
  let out: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-edge-project-'));
    out = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-edge-out-'));
    mkdirSync(join(project, 'flows'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it('skips a Flow with no process type, and describes parents of input records and their parents', async () => {
    writeFileSync(join(project, 'flows', 'No_Type.flow-meta.xml'), '<Flow><status>Active</status></Flow>');
    writeFileSync(
      join(project, 'flows', 'Calc.flow-meta.xml'),
      `<Flow><processType>AutoLaunchedFlow</processType><status>Active</status>
        <variables><name>job</name><dataType>SObject</dataType><objectType>Job__c</objectType><isInput>true</isInput><isOutput>false</isOutput><isCollection>false</isCollection></variables>
        <variables><name>ownerId</name><dataType>String</dataType><isInput>true</isInput><isOutput>false</isOutput><isCollection>false</isCollection></variables>
        <recordLookups><name>Find</name><object>Job__c</object><storeOutputAutomatically>true</storeOutputAutomatically>
          <filters><field>Owner__c</field><operator>EqualTo</operator><value><elementReference>ownerId</elementReference></value></filters>
        </recordLookups>
        <start><connector><targetReference>Find</targetReference></connector><filterFormula>{!$Record.Unknown__r.Name} = "x"</filterFormula></start>
      </Flow>`,
    );
    const described: string[] = [];
    const field = (name: string, extra: Record<string, unknown> = {}) => ({
      name,
      type: 'string',
      nillable: false,
      createable: true,
      defaultedOnCreate: false,
      ...extra,
    });
    const result = await scaffoldTests({
      flowNames: ['No_Type', 'Calc'],
      projectDir: project,
      outputDir: out,
      describe: async (object) => {
        described.push(object);
        if (object === 'Job__c') {
          return [
            field('Account__c', { type: 'reference', referenceTo: ['Account'] }),
            field('Owner__c', { type: 'reference', referenceTo: ['User'], nillable: true }),
          ];
        }
        if (object === 'Account')
          return [field('Name'), field('Region__c', { type: 'reference', referenceTo: ['Region__c'] })];
        return [field('Name')];
      },
      validationRules: async () => [],
      lookupFilters: async () => [],
    });
    expect(result.skipped).toEqual([
      { flowName: 'No_Type', reason: 'Process type unknown does not count toward deploy-as-active coverage.' },
    ]);
    expect(described).toEqual(['Job__c', 'Account', 'Region__c']);
    const test = readFileSync(join(out, 'Calc_FlowTest.cls'), 'utf8');
    expect(test).toContain('Account__c = accountParent.Id');
    expect(test).toContain("inputs.put('ownerId', UserInfo.getUserId());");
  });
});
