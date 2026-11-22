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
  /** Each element's and resource's content in canonical form, by `type:name`. */
  bodies?: Record<string, string>;
  /** The start element's content in canonical form. */
  start?: string;
  /** Flow-level properties (API version, label, run mode, and so on) in canonical form, by name. */
  properties?: Record<string, string>;
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

/** Metadata element types Salesforce counts for element coverage. */
export const EXECUTABLE_ELEMENT_TYPES: ReadonlySet<string> = new Set(
  ELEMENT_TYPES.filter((type) => !RESOURCE_TYPES.has(type)),
);

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

/** Canvas positions, which moving an element changes without changing what the Flow does. */
const LAYOUT_KEYS = new Set(['locationX', 'locationY']);

/** Flow-level values that mean the same as leaving the property out. */
const DEFAULT_PROPERTIES: Record<string, string> = { environments: 'Default', runInMode: 'DefaultMode' };

/**
 * Left out of `properties`: compared on their own (status by the gate's version checks), or
 * Flow Builder's own settings, such as its canvas mode.
 */
const NOT_PROPERTIES = new Set(['processType', 'start', 'status', 'ends', 'processMetadataValues']);

/** The start element without its entry criteria, which are compared on their own. */
function startBody(start: Rec): Rec {
  const { filters: _filters, filterFormula: _formula, filterLogic, ...rest } = start;
  // With no logic given, filters are joined with AND.
  return scalar(filterLogic)?.toLowerCase() === 'and' ? rest : { ...rest, filterLogic };
}

/**
 * Content in one form for both the source XML and the Tooling API's JSON:
 * - keys sorted, and every nested value a list, since XML shows a one-item list as the item;
 * - values as strings with whitespace collapsed, numbers in their shortest form (5.0 is 5);
 * - null, empty, and false values left out, since each side omits some defaults the other shows;
 * - canvas positions left out;
 * - connectors to end elements left out: the JSON adds `ends` elements (END_ELEMENT_1) and
 *   connects to them where the XML has no connector.
 */
function canonical(value: unknown, ends: ReadonlySet<string>): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item, ends)).filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === 'object') {
    const record = value as Rec;
    if (typeof record.targetReference === 'string' && ends.has(record.targetReference)) return undefined;
    const out: Rec = {};
    for (const key of Object.keys(record).sort()) {
      if (LAYOUT_KEYS.has(key)) continue;
      const item = canonical(record[key], ends);
      if (item !== undefined) out[key] = Array.isArray(item) ? item : [item];
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text === '' || text === 'false') return undefined;
  return /^-?\d+(\.\d+)?$/.test(text) ? String(Number(text)) : text;
}

const canonicalText = (value: unknown, ends: ReadonlySet<string>): string =>
  JSON.stringify(canonical(value, ends) ?? null);

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
  const ends = new Set(
    asRecords(Array.isArray(flow.ends) ? flow.ends : [flow.ends])
      .map((end) => scalar(end.name))
      .filter((name): name is string => !!name),
  );
  const bodies: Record<string, string> = {};
  for (const type of ELEMENT_TYPES) {
    for (const element of asRecords(flow[type])) {
      const name = scalar(element.name);
      if (name) bodies[`${type}:${name}`] = canonicalText(element, ends);
    }
  }
  const properties: Record<string, string> = {};
  for (const key of Object.keys(flow)) {
    if (NOT_PROPERTIES.has(key) || (ELEMENT_TYPES as readonly string[]).includes(key)) continue;
    const value = canonical(flow[key], ends);
    if (value === undefined) continue;
    // A one-value list in the JSON is a single value in the XML.
    const text = JSON.stringify(Array.isArray(value) && value.length === 1 ? value[0] : value);
    if (text !== JSON.stringify(DEFAULT_PROPERTIES[key])) properties[key] = text;
  }
  return {
    processType: scalar(flow.processType),
    triggerType: scalar(start.triggerType),
    recordTriggerType: scalar(start.recordTriggerType),
    object: scalar(start.object),
    filters,
    filterFormula: scalar(start.filterFormula)?.replace(/\s+/g, ' '),
    elements,
    bodies,
    start: canonicalText(startBody(start), ends),
    properties,
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
  } else if (source.start !== undefined && org.start !== undefined && source.start !== org.start) {
    differences.push('the start element differs');
  }
  if (source.properties && org.properties) {
    const { properties: a } = source;
    const { properties: b } = org;
    const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => a[key] !== b[key]).sort();
    if (changed.length > 0) differences.push(`Flow properties differ: ${list(changed)}`);
  }
  const orgElements = new Set(org.elements);
  const sourceElements = new Set(source.elements);
  const onlyInSource = [...sourceElements].filter((e) => !orgElements.has(e));
  const onlyInOrg = [...orgElements].filter((e) => !sourceElements.has(e));
  if (onlyInSource.length > 0) differences.push(`only in source: ${list(onlyInSource)}`);
  if (onlyInOrg.length > 0) differences.push(`only in the org: ${list(onlyInOrg)}`);
  if (source.bodies && org.bodies) {
    const { bodies: a } = source;
    const { bodies: b } = org;
    const changed = source.elements.filter((e) => orgElements.has(e) && a[e] !== b[e]);
    if (changed.length > 0) differences.push(`changed: ${list(changed)}`);
  }
  return differences;
}
