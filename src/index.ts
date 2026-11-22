export { apexClassMetaXml, apexTestClassName, generateApexTest } from './core/apexTemplate.js';
export type { CoverageFormat } from './core/coverageFormats.js';
export { COVERAGE_FORMATS, formatCoverage } from './core/coverageFormats.js';
export type { Exclusion } from './core/exclusions.js';
export { findExclusion, IGNORE_FILE, parseIgnoreFile, readIgnoreFile } from './core/exclusions.js';
export type { DataQuery, MetadataRead } from './core/flowSettings.js';
export { COUNTED_PROCESS_TYPES, DEFAULT_THRESHOLD, isCountedProcessType } from './core/flowTypes.js';
export { parseFlowXml } from './core/flowXml.js';
export type { GateCandidate, GateOptions } from './core/gate.js';
export { collectChangedFlows, evaluateGate } from './core/gate.js';
export type { OutputFormat } from './core/markdown.js';
export { gateMarkdown, OUTPUT_FORMATS, readinessMarkdown } from './core/markdown.js';
export { OrgCoverageSource } from './core/orgCoverageSource.js';
export type { ReadinessOptions } from './core/readiness.js';
export { buildReadinessReport } from './core/readiness.js';
export type { DescribeField, DescribeObject, RequiredFieldMap } from './core/requiredFields.js';
export { requiredFieldValues } from './core/requiredFields.js';
export type { ScaffoldOptions } from './core/scaffold.js';
export { scaffoldTests } from './core/scaffold.js';
export { dataQuery, describeObject, metadataRead, toolingQuery } from './core/toolingQuery.js';
export type {
  FlowCoverageLine,
  FlowFileCoverage,
  FlowFileCoverageOptions,
  FlowFileCoverageReport,
} from './core/transform.js';
export { buildFlowFileCoverage } from './core/transform.js';
export type * from './core/types.js';
