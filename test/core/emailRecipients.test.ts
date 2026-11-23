import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { generateApexTest } from '../../src/core/apexTemplate.js';
import { emailAlertReader } from '../../src/core/emailAlerts.js';
import { parseFlowXml } from '../../src/core/flowXml.js';
import { scaffoldTests } from '../../src/core/scaffold.js';

const sendEmail = (reference: string, parameter = 'emailAddresses') =>
  `<actionCalls><name>Send</name><actionName>emailSimple</actionName><actionType>emailSimple</actionType>
    <inputParameters><name>${parameter}</name><value><elementReference>${reference}</elementReference></value></inputParameters>
  </actionCalls>`;
const alert = (name: string) =>
  `<actionCalls><name>Alert</name><actionName>${name}</actionName><actionType>emailAlert</actionType></actionCalls>`;

const jobFlow = (actions: string, trigger = 'Create') =>
  parseFlowXml(
    'Job_Flow',
    `<Flow><processType>AutoLaunchedFlow</processType>${actions}<start><connector><targetReference>Send</targetReference></connector>
      <object>Job__c</object><recordTriggerType>${trigger}</recordTriggerType><triggerType>RecordAfterSave</triggerType></start></Flow>`,
  );

describe('emailAlertReader', () => {
  it('reads the record fields alerts send to, ten alerts per call, and skips failures', async () => {
    const calls: string[][] = [];
    const records: Record<string, unknown> = {
      'Job__c.Notify': {
        fullName: 'Job__c.Notify',
        recipients: [
          { type: 'email', field: 'Contact_Email__c' },
          { type: 'userLookup', field: 'Reviewer__c' },
          { type: 'contactLookup', field: 'Contact__c' },
        ],
      },
      'Job__c.Owner': { fullName: 'Job__c.Owner', recipients: { type: 'owner' } },
      'Job__c.Cc': { fullName: 'Job__c.Cc', recipients: { type: 'email', field: 'A__c' }, ccEmails: 'x@example.com' },
    };
    const read = emailAlertReader(async (type, names) => {
      const list = ([] as string[]).concat(names);
      calls.push(list);
      expect(type).toBe('WorkflowAlert');
      if (list.includes('Job__c.Fails')) throw new Error('INSUFFICIENT_ACCESS');
      const found = list.map((name) => records[name] ?? {});
      return found.length === 1 ? found[0] : found;
    });
    expect(await read(['Job__c.Notify', 'Job__c.Owner', 'Job__c.Cc', 'Job__c.Missing'])).toEqual({
      'Job__c.Notify': { emailFields: ['Contact_Email__c'], userLookups: ['Reviewer__c'], hasFixedRecipient: false },
      'Job__c.Owner': { emailFields: [], userLookups: [], hasFixedRecipient: true },
      'Job__c.Cc': { emailFields: ['A__c'], userLookups: [], hasFixedRecipient: true },
    });
    expect(await read(['Job__c.Notify'])).toHaveProperty(['Job__c.Notify']);
    expect(await read(['Job__c.Fails'])).toEqual({});
    calls.length = 0;
    await read(Array.from({ length: 12 }, (_, i) => `Job__c.A${i}`));
    expect(calls.map((c) => c.length)).toEqual([10, 2]);
  });

  it('reads an alert without recipients', async () => {
    const read = emailAlertReader(async () => ({ fullName: 'Job__c.Empty', recipients: null }));
    expect(await read(['Job__c.Empty'])).toEqual({
      'Job__c.Empty': { emailFields: [], userLookups: [], hasFixedRecipient: false },
    });
  });
});

describe('addresses for the emails a record-triggered Flow sends', () => {
  it('reads the alerts a Flow sends', () => {
    expect(jobFlow(`${alert('Job__c.Notify')}${alert('Job__c.Notify')}`).graph?.emailAlerts).toEqual(['Job__c.Notify']);
  });

  it('fills record fields a Send Email action sends to, directly or on a parent', () => {
    const body = generateApexTest(
      jobFlow(
        `${sendEmail('$Record.Contact_Email__c')}${sendEmail('$Record.OwnerId', 'recipientId')}${sendEmail('someVariable')}`,
      ),
    ).body;
    expect(body).toContain("Contact_Email__c = 'flowtest@example.com'");
    expect(body).not.toContain('OwnerId =');

    const parent = generateApexTest(jobFlow(sendEmail('$Record.Contact__r.Email')), {
      requiredFields: { Job__c: {}, Contact: { LastName: "'C'" } },
      lookups: { Job__c: { Contact__c: 'Contact' } },
      relationships: { Job__c: { Contact__r: 'Contact__c' } },
    }).body;
    expect(parent).toContain("Email = 'flowtest@example.com'");
    expect(parent).toContain('Contact__c = contactParent.Id');
  });

  it("says which recipient it couldn't fill", () => {
    const body = generateApexTest(jobFlow(sendEmail('$Record.Formula_Email__c')), {
      readOnlyFields: { Job__c: ['Formula_Email__c'] },
    }).body;
    expect(body).toContain('// TODO: email recipient: give $Record.Formula_Email__c an address');
  });

  it('fills the fields an email alert sends to, unless it always has a recipient', () => {
    const emailAlerts = {
      'Job__c.Notify': { emailFields: ['Contact_Email__c'], userLookups: ['Reviewer__c'], hasFixedRecipient: false },
      'Job__c.Owner': { emailFields: ['Backup_Email__c'], userLookups: [], hasFixedRecipient: true },
      'Case.Other': { emailFields: ['SuppliedEmail'], userLookups: [], hasFixedRecipient: false },
    };
    const body = generateApexTest(
      jobFlow(`${alert('Job__c.Notify')}${alert('Job__c.Owner')}${alert('Case.Other')}${alert('Job__c.Unread')}`),
      { emailAlerts },
    ).body;
    expect(body).toContain("Contact_Email__c = 'flowtest@example.com'");
    expect(body).toContain('Reviewer__c = UserInfo.getUserId()');
    expect(body).not.toContain('Backup_Email__c');
    expect(body).not.toContain('SuppliedEmail');
  });

  it('gives the update test insert the addresses too', () => {
    const body = generateApexTest(jobFlow(sendEmail('$Record.Contact_Email__c'), 'CreateAndUpdate')).body;
    const update = body.slice(body.indexOf('runsFlowOnUpdate'));
    expect(update).toContain(
      ['        Job__c testRecord = new Job__c(', "            Contact_Email__c = 'flowtest@example.com'"].join('\n'),
    );
  });
});

describe('scaffoldTests and email alerts', () => {
  it('reads the alerts the scaffolded Flows send, and nothing when they send none', async () => {
    const project = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-alerts-'));
    try {
      mkdirSync(join(project, 'flows'));
      const xml = (actions: string) =>
        `<Flow><processType>AutoLaunchedFlow</processType><status>Active</status>${actions}<start><object>Job__c</object><recordTriggerType>Create</recordTriggerType><triggerType>RecordAfterSave</triggerType></start></Flow>`;
      writeFileSync(join(project, 'flows', 'Alerting.flow-meta.xml'), xml(alert('Job__c.Notify')));
      writeFileSync(join(project, 'flows', 'Quiet.flow-meta.xml'), xml(''));
      const asked: string[][] = [];
      const emailAlerts = async (names: string[]) => {
        asked.push(names);
        return { 'Job__c.Notify': { emailFields: ['Contact_Email__c'], userLookups: [], hasFixedRecipient: false } };
      };
      const out = join(project, 'out');
      await scaffoldTests({ flowNames: ['Alerting'], projectDir: project, outputDir: out, emailAlerts });
      await scaffoldTests({ flowNames: ['Quiet'], projectDir: project, outputDir: out, emailAlerts });
      expect(asked).toEqual([['Job__c.Notify']]);
      expect(readFileSync(join(out, 'Alerting_FlowTest.cls'), 'utf8')).toContain(
        "Contact_Email__c = 'flowtest@example.com'",
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
