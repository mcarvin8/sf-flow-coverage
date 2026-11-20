import { XMLParser } from 'fast-xml-parser';

import { GRAPH_ARRAY_PATHS, parseFlowGraph } from './flowGraph.js';
import { asArray, asRecord, parseFlowValue, text, type XmlRecord } from './flowValues.js';
import type { FlowFilter, FlowMetadata, FlowVariable } from './types.js';

export { escapeApexString } from './flowValues.js';

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (_name, jpath) => ['Flow.variables', 'Flow.start.filters', ...GRAPH_ARRAY_PATHS].includes(String(jpath)),
});

function parseFilters(start: XmlRecord): FlowFilter[] {
  return asArray(start.filters).flatMap((filter) => {
    const field = text(filter.field);
    const operator = text(filter.operator);
    if (!field || !operator) return [];
    return [{ field, operator, ...parseFlowValue(asRecord(filter.value)) }];
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
 * The fields a Flow reads from each record variable (`{!myRecord.Status__c}`, or a reference to
 * `myRecord.Account__r.Name`), so a test can query them before passing the record in.
 */
function recordReads(xml: string, variables: FlowVariable[]): Record<string, string[]> {
  const reads: Record<string, string[]> = {};
  for (const variable of variables.filter((v) => v.dataType === 'SObject' && !v.isCollection)) {
    // Variable names are API names (letters, digits, underscores), so they need no escaping.
    const pattern = new RegExp(`(?:>|\\{!)\\s*${variable.name}\\.([A-Za-z]\\w*(?:\\.[A-Za-z]\\w*)*)`, 'g');
    const fields = new Set([...xml.matchAll(pattern)].map((m) => m[1]).filter((f) => f !== 'Id'));
    if (fields.size > 0) reads[variable.name] = [...fields].sort();
  }
  return reads;
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
  const variables = parseVariables(flow);
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
    variables,
    graph: parseFlowGraph(flow),
    recordReads: recordReads(xml, variables),
  };
}
