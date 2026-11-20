import { XMLParser } from 'fast-xml-parser';

/**
 * The parts of a Flow that identify a version well enough to tell whether the org runs the
 * version in source. Built the same way from the source XML and from the Tooling API's
 * `Flow.Metadata` JSON, which differ in defaults, value types, and element order, so only
 * fields both sides report reliably are kept.
 */
export type FlowFingerprint = {
  processType?: string;
  triggerType?: string;
  recordTriggerType?: string;
  object?: string;
  /** Start filters as `field operator value`, sorted. */
  filters: string[];
  /** Start filter formula with whitespace collapsed. */
  filterFormula?: string;
  /** Elements and resources as `type:name`, sorted. */
  elements: string[];
};

type Rec = Record<string, unknown>;

/** Element and resource lists whose entries carry a `name`. */
const ELEMENT_TYPES = [
  'actionCalls',
  'apexPluginCalls',
  'assignments',
  'choices',
  'collectionProcessors',
  'constants',
  'customErrors',
  'decisions',
  'dynamicChoiceSets',
  'formulas',
  'loops',
  'orchestratedStages',
  'recordCreates',
  'recordDeletes',
  'recordLookups',
  'recordRollbacks',
  'recordUpdates',
  'screens',
  'steps',
  'subflows',
  'textTemplates',
  'transforms',
  'variables',
  'waits',
] as const;

/** Resources, which Salesforce leaves out of a Flow's element coverage. */
const RESOURCE_TYPES = new Set(['choices', 'constants', 'dynamicChoiceSets', 'formulas', 'textTemplates', 'variables']);

/**
 * The elements Salesforce counts for element coverage: every element but the start and
 * resources. Types are singular (`decision`, `recordUpdate`).
 */
export function executableElements(fingerprint: FlowFingerprint): Array<{ name: string; type: string }> {
  return fingerprint.elements.flatMap((element) => {
    const [type, name] = element.split(':');
    return RESOURCE_TYPES.has(type) ? [] : [{ name, type: type.replace(/s$/, '') }];
  });
}

const FILTER_VALUE_KEYS = [
  'stringValue',
  'booleanValue',
  'numberValue',
  'dateValue',
  'dateTimeValue',
  'elementReference',
] as const;

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (_name, jpath) =>
    String(jpath) === 'Flow.start.filters' || ELEMENT_TYPES.some((type) => String(jpath) === `Flow.${type}`),
});

const asRecord = (value: unknown): Rec | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : undefined;

const asRecords = (value: unknown): Rec[] =>
  Array.isArray(value) ? value.map(asRecord).filter((v): v is Rec => !!v) : [];

/** XML gives strings and the JSON gives typed values; both become trimmed strings, empty as undefined. */
function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function filterValue(value: unknown): string {
  const record = asRecord(value);
  if (!record) return '';
  for (const key of FILTER_VALUE_KEYS) {
    const text = scalar(record[key]);
    if (text === undefined) continue;
    // 5 and 5.0 are the same number; the JSON drops the trailing zero.
    if (key === 'numberValue' && !Number.isNaN(Number(text))) return String(Number(text));
    return text;
  }
  return '';
}

function fingerprint(flow: Rec): FlowFingerprint {
  const start = asRecord(flow.start) ?? {};
  const filters = asRecords(start.filters)
    .map((f) => [scalar(f.field) ?? '', scalar(f.operator) ?? '', filterValue(f.value)].join(' ').trim())
    .sort();
  const elements = ELEMENT_TYPES.flatMap((type) =>
    asRecords(flow[type])
      .map((element) => scalar(element.name))
      .filter((name): name is string => !!name)
      .map((name) => `${type}:${name}`),
  ).sort();
  return {
    processType: scalar(flow.processType),
    triggerType: scalar(start.triggerType),
    recordTriggerType: scalar(start.recordTriggerType),
    object: scalar(start.object),
    filters,
    filterFormula: scalar(start.filterFormula)?.replace(/\s+/g, ' '),
    elements,
  };
}

/** Fingerprints a Flow metadata file. Throws when the content is not a Flow. */
export function fingerprintFromXml(xml: string): FlowFingerprint {
  const flow = asRecord(asRecord(parser.parse(xml))?.Flow);
  if (!flow) throw new Error('Not a Flow metadata file (no <Flow> root element).');
  return fingerprint(flow);
}

/** Fingerprints the `Metadata` field of a Tooling API `Flow` record. */
export function fingerprintFromMetadata(metadata: unknown): FlowFingerprint {
  return fingerprint(asRecord(metadata) ?? {});
}

const MAX_LISTED = 5;

function list(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(', ');
  return items.length > MAX_LISTED ? `${shown} and ${items.length - MAX_LISTED} more` : shown;
}

const show = (value: string | undefined): string => value ?? 'none';

/**
 * Describes how the source fingerprint differs from the org's, one phrase per difference.
 * Returns an empty array when they match.
 */
export function compareFingerprints(source: FlowFingerprint, org: FlowFingerprint): string[] {
  const differences: string[] = [];
  for (const field of ['processType', 'triggerType', 'recordTriggerType', 'object'] as const) {
    if (source[field] !== org[field]) {
      differences.push(`${field} is ${show(source[field])} in source but ${show(org[field])} in the org`);
    }
  }
  if (source.filters.join('\n') !== org.filters.join('\n') || source.filterFormula !== org.filterFormula) {
    differences.push('start entry criteria differ');
  }
  const orgElements = new Set(org.elements);
  const sourceElements = new Set(source.elements);
  const onlyInSource = [...sourceElements].filter((e) => !orgElements.has(e));
  const onlyInOrg = [...orgElements].filter((e) => !sourceElements.has(e));
  if (onlyInSource.length > 0) differences.push(`only in source: ${list(onlyInSource)}`);
  if (onlyInOrg.length > 0) differences.push(`only in the org: ${list(onlyInOrg)}`);
  return differences;
}
