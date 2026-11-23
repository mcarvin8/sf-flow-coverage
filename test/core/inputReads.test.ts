import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { generateApexTest } from '../../src/core/apexTemplate.js';
import { parseFlowXml } from '../../src/core/flowXml.js';
import { scaffoldTests } from '../../src/core/scaffold.js';

const readingFlow = (reads: string[]) =>
  `<Flow><processType>AutoLaunchedFlow</processType><status>Active</status>
    <variables><name>original</name><dataType>SObject</dataType><objectType>Form__c</objectType><isInput>true</isInput><isOutput>false</isOutput><isCollection>false</isCollection></variables>
    <variables><name>out</name><dataType>String</dataType><isInput>false</isInput><isOutput>true</isOutput><isCollection>false</isCollection></variables>
    <assignments><name>First</name>${reads
      .map(
        (read) =>
          `<assignmentItems><assignToReference>out</assignToReference><operator>Assign</operator><value><elementReference>original.${read}</elementReference></value></assignmentItems>`,
      )
      .join('')}</assignments>
    <start><connector><targetReference>First</targetReference></connector></start></Flow>`;

const options = {
  requiredFields: { Form__c: { Name: "'F'" }, Product__c: { Name: "'P'" }, Line__c: { Name: "'L'" } },
  fieldValues: {
    Form__c: { Product__c: 'productParent.Id' },
    Product__c: { Evaluate__c: 'true', Line__c: 'lineParent.Id', Name: "'P'" },
    Line__c: { Code__c: "'C1'" },
  },
  lookups: { Form__c: { Product__c: 'Product__c' }, Product__c: { Line__c: 'Line__c' } },
  relationships: { Form__c: { Product__r: 'Product__c' }, Product__c: { Line__r: 'Line__c' } },
};

describe('fields an autolaunched Flow reads through an input record', () => {
  it('fills the lookups behind them with parent records, and queries them', () => {
    const test = generateApexTest(
      parseFlowXml('Calc', readingFlow(['Product__r.Evaluate__c', 'Product__r.Line__r.Code__c', 'Status__c'])),
      options,
    );
    expect(test.body).toContain(
      [
        '        Line__c lineParent = new Line__c(',
        "            Name = 'L',",
        "            Code__c = 'C1'",
        '        );',
        '        insert lineParent;',
        '        Product__c productParent = new Product__c(',
        "            Name = 'P',",
        '            Evaluate__c = true,',
        '            Line__c = lineParent.Id',
        '        );',
        '        insert productParent;',
      ].join('\n'),
    );
    expect(test.body).toContain('Product__c = productParent.Id');
    expect(test.body).toContain(
      'originalInput = [SELECT Id, Product__r.Evaluate__c, Product__r.Line__r.Code__c, Status__c FROM Form__c WHERE Id = :originalInput.Id];',
    );
  });

  it("says which ones it can't fill", () => {
    const test = generateApexTest(parseFlowXml('Calc', readingFlow(['Owner__r.Name'])), options);
    expect(test.body).toContain(
      '        // TODO: fill original.Owner__r.Name: the Flow reads it, and fails if it is empty',
    );
  });

  it('describes the objects along those paths when scaffolding', async () => {
    const project = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-reads-'));
    try {
      mkdirSync(join(project, 'flows'));
      writeFileSync(join(project, 'flows', 'Calc.flow-meta.xml'), readingFlow(['Product__r.Line__r.Code__c']));
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
      const described: string[] = [];
      await scaffoldTests({
        flowNames: ['Calc'],
        projectDir: project,
        outputDir: join(project, 'out'),
        describe: async (object) => {
          described.push(object);
          if (object === 'Form__c') return [lookup('Product__c', 'Product__c', 'Product__r')];
          if (object === 'Product__c') return [lookup('Line__c', 'Line__c', 'Line__r')];
          return [field('Code__c')];
        },
      });
      expect(described).toEqual(['Form__c', 'Product__c', 'Line__c']);
      const test = readFileSync(join(project, 'out', 'Calc_FlowTest.cls'), 'utf8');
      expect(test).toContain('insert lineParent;');
      expect(test).toContain('Line__c = lineParent.Id');
      expect(test).toContain('Product__c = productParent.Id');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
