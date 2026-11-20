import { XMLParser } from 'fast-xml-parser';

import type { FlowFilter, FlowMetadata, FlowVariable } from './types.js';

type XmlRecord = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (_name, jpath) => ['Flow.variables', 'Flow.start.filters'].includes(String(jpath)),
});

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function asRecord(value: unknown): XmlRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as XmlRecord) : undefined;
}

function asArray(value: unknown): XmlRecord[] {
  return Array.isArray(value) ? value.filter((v): v is XmlRecord => !!asRecord(v)) : [];
}

export function escapeApexString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n');
}

function parseFilterValue(value: XmlRecord | undefined): Pick<FlowFilter, 'apexValue' | 'rawValue'> {
  if (!value) return {};
  const stringValue = text(value.stringValue);
  if (stringValue !== undefined) return { apexValue: `'${escapeApexString(stringValue)}'`, rawValue: stringValue };
  const booleanValue = text(value.booleanValue);
  if (booleanValue !== undefined)
    return { apexValue: booleanValue === 'true' ? 'true' : 'false', rawValue: booleanValue };
  const numberValue = text(value.numberValue);
  if (numberValue !== undefined && !Number.isNaN(Number(numberValue))) {
    return { apexValue: numberValue, rawValue: numberValue };
  }
  const dateValue = text(value.dateValue);
  if (dateValue !== undefined)
    return { apexValue: `Date.valueOf('${escapeApexString(dateValue)}')`, rawValue: dateValue };
  const raw = text(value.elementReference) ?? text(value.dateTimeValue);
  return raw === undefined ? {} : { rawValue: raw };
}

function parseFilters(start: XmlRecord): FlowFilter[] {
  return asArray(start.filters).flatMap((filter) => {
    const field = text(filter.field);
    const operator = text(filter.operator);
    if (!field || !operator) return [];
    return [{ field, operator, ...parseFilterValue(asRecord(filter.value)) }];
  });
}

function parseVariables(flow: XmlRecord): FlowVariable[] {
  return asArray(flow.variables).flatMap((variable) => {
    const name = text(variable.name);
    if (!name) return [];
    return [
      {
        name,
        dataType: text(variable.dataType) ?? 'String',
        isInput: text(variable.isInput) === 'true',
        isOutput: text(variable.isOutput) === 'true',
        isCollection: text(variable.isCollection) === 'true',
        objectType: text(variable.objectType),
        apexClass: text(variable.apexClass),
      },
    ];
  });
}

/**
 * Reads the parts of a Flow metadata file needed to judge whether it counts toward
 * the deploy-as-active coverage requirement and to scaffold an Apex test for it.
 * Throws when the content is not a Flow.
 */
export function parseFlowXml(name: string, xml: string): FlowMetadata {
  const doc = asRecord(parser.parse(xml));
  const flow = asRecord(doc?.Flow);
  if (!flow) throw new Error(`${name} is not a Flow metadata file (no <Flow> root element).`);
  const start = asRecord(flow.start) ?? {};
  return {
    name,
    label: text(flow.label),
    processType: text(flow.processType),
    status: text(flow.status),
    triggerType: text(start.triggerType),
    recordTriggerType: text(start.recordTriggerType),
    object: text(start.object),
    filters: parseFilters(start),
    filterLogic: text(start.filterLogic),
    filterFormula: text(start.filterFormula),
    variables: parseVariables(flow),
  };
}
