/**
 * Flow process types that count toward the 75% coverage requirement for
 * "Deploy processes and flows as active": autolaunched Flows (including
 * record-triggered, platform event and scheduled), and Process Builder processes.
 */
export const COUNTED_PROCESS_TYPES = ['AutoLaunchedFlow', 'Workflow', 'CustomEvent', 'InvocableProcess'] as const;

export const DEFAULT_THRESHOLD = 75;

export function isCountedProcessType(processType: string | undefined): boolean {
  if (!processType) return false;
  const lower = processType.toLowerCase();
  return COUNTED_PROCESS_TYPES.some((t) => t.toLowerCase() === lower);
}

export function qualifiedFlowName(developerName: string, namespacePrefix?: string | null): string {
  return namespacePrefix ? `${namespacePrefix}__${developerName}` : developerName;
}

/** Splits `ns__Flow_Name` into namespace and developer name. Flow names cannot contain `__`, so the first one is the separator. */
export function splitFlowName(flowName: string): { namespacePrefix?: string; developerName: string } {
  const index = flowName.indexOf('__');
  if (index <= 0) return { developerName: flowName };
  return { namespacePrefix: flowName.slice(0, index), developerName: flowName.slice(index + 2) };
}

const FLOW_FILE = /([^/\\]+)\.flow(?:-meta\.xml)?$/;

/** Returns the Flow API name for a source-format (`.flow-meta.xml`) or metadata-format (`.flow`) file path, or undefined. */
export function flowNameFromPath(filePath: string): string | undefined {
  return FLOW_FILE.exec(filePath)?.[1];
}
