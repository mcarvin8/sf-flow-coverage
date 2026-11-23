import { XMLParser } from 'fast-xml-parser';

type Rec = Record<string, unknown>;

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });

const asRecord = (value: unknown): Rec | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : undefined;
const asRecords = (value: unknown): Rec[] =>
  (Array.isArray(value) ? value : [value]).map(asRecord).filter((v): v is Rec => !!v);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** A Flow or process that submits the record it runs on for approval, and on which saves. */
export type ApprovalSubmit = {
  flowName: string;
  object: string;
  onCreate: boolean;
  onUpdate: boolean;
};

/** References to the record a Flow or process runs on, as a Submit for Approval action names it. */
const TRIGGERING_RECORD = /^(\$Record|myVariable_current)(\.Id)?$/;

/** A Process Builder setting (`ObjectType`, `TriggerType`) from its process metadata values. */
function processValue(flow: Rec, name: string): string | undefined {
  const value = asRecords(flow.processMetadataValues).find((v) => text(v.name) === name)?.value;
  return text(asRecord(value)?.stringValue);
}

/**
 * When an active record-triggered Flow or Process Builder process submits the record it runs on
 * for approval: the object and whether it does so when a record is created, updated, or both.
 * Undefined for anything else.
 */
export function approvalSubmit(flowName: string, xml: string): ApprovalSubmit | undefined {
  const flow = asRecord(asRecord(parser.parse(xml))?.Flow);
  if (!flow || text(flow.status) !== 'Active') return undefined;
  const submits = asRecords(flow.actionCalls).some((action) => {
    if (text(action.actionType) !== 'submit') return false;
    const objectId = asRecords(action.inputParameters).find((p) => text(p.name) === 'objectId');
    const reference = text(asRecord(objectId?.value)?.elementReference);
    return reference !== undefined && TRIGGERING_RECORD.test(reference);
  });
  if (!submits) return undefined;
  const start = asRecord(flow.start) ?? {};
  const startObject = text(start.object);
  if (startObject) {
    const trigger = text(start.recordTriggerType) ?? 'Create';
    return {
      flowName,
      object: startObject,
      onCreate: trigger === 'Create' || trigger === 'CreateAndUpdate',
      onUpdate: trigger === 'Update' || trigger === 'CreateAndUpdate',
    };
  }
  const object = processValue(flow, 'ObjectType');
  const trigger = processValue(flow, 'TriggerType');
  if (!object || (trigger !== 'onCreateOnly' && trigger !== 'onAllChanges')) return undefined;
  return { flowName, object, onCreate: true, onUpdate: trigger === 'onAllChanges' };
}

/**
 * Explains why an update test of a Flow that doesn't submit for approval can fail with
 * ALREADY_IN_PROCESS: other automation submits the record when the test inserts it and again when
 * the test updates it. Undefined when no automation submits the object on both saves.
 */
export function resubmitNote(flowName: string, object: string, all: ApprovalSubmit[]): string[] | undefined {
  const others = all
    .filter((s) => s.flowName !== flowName && s.object === object && s.onCreate && s.onUpdate)
    .map((s) => s.flowName);
  if (others.length === 0) return undefined;
  const verb = others.length === 1 ? 'submits' : 'submit';
  return [
    `TODO: ${others.join(', ')} ${verb} a ${object} for approval when it's created and again when it's updated.`,
    "The update test's insert submits the record, so its update fails with ALREADY_IN_PROCESS.",
    "Set the record up so that automation's entry criteria are unmet on insert or on update.",
  ];
}

/**
 * Explains why a test of a Flow that submits its record for approval can fail with
 * ALREADY_IN_PROCESS: other automation submits the same record when it's created (in the create
 * test's save, or the update test's insert), or the Flow itself does, on create, before the update
 * test's update. Undefined when nothing else submits it. Doesn't work around it: whether a new
 * record should be submitted is the org's business rule.
 */
export function approvalConflictNote(subject: ApprovalSubmit, all: ApprovalSubmit[]): string[] | undefined {
  const others = all
    .filter((s) => s.flowName !== subject.flowName && s.object === subject.object && s.onCreate)
    .map((s) => s.flowName);
  const self = subject.onCreate && subject.onUpdate;
  if (others.length === 0 && !self) return undefined;
  const reasons = [
    ...(others.length > 0
      ? [
          `${others.join(', ')} also submit${others.length === 1 ? 's' : ''} a ${subject.object} for approval when one is created`,
        ]
      : []),
    ...(self ? [`the update test's insert already runs this Flow on create, which submits it`] : []),
  ];
  return [
    `TODO: this Flow submits the ${subject.object} for approval, and ${reasons.join(', and ')}.`,
    'A record already in an approval process makes the submit fail with ALREADY_IN_PROCESS.',
    "Whether a new record should be submitted is the org's rule: set the record up so only one",
    "submit runs, for example by leaving the other automation's entry criteria unmet.",
  ];
}
