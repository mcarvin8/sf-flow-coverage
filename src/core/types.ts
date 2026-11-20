import type { FlowFingerprint } from './flowFingerprint.js';
import type { FlowGraph } from './flowGraph.js';

/** A Flow element no Apex test ran. */
export type UncoveredElement = {
  /** Element API name, as in the Flow's metadata. */
  name: string;
  /** Element type, such as `decision` or `recordUpdate`. */
  type: string;
};

/** One Apex test method that ran a Flow version. */
export type FlowTestRef = {
  className: string;
  methodName: string;
};

/** Coverage of a single Flow version, as reported by the coverage source. */
export type FlowCoverage = {
  /** Flow API name, prefixed with `namespace__` for managed Flows. */
  flowName: string;
  flowVersionId: string;
  versionNumber?: number;
  processType: string;
  status?: string;
  /** True when at least one Apex test ran this Flow version. */
  covered: boolean;
  elementsCovered: number;
  elementsTotal: number;
  /** Elements covered across all tests, 0-100. */
  elementCoveragePercent: number;
  tests: FlowTestRef[];
  /**
   * Lowercased names of the elements any test ran (FlowElementTestCoverage reports them in lower
   * case). Undefined when element coverage can't be read.
   */
  coveredElementNames?: string[];
  /**
   * How this version relates to the Flow's other versions, when known (set by `getFlowCoverage`):
   * - `current`: it is the active version and the latest one.
   * - `noActiveVersion`: no version is active; this is the latest, inactive version.
   * - `newerInactiveVersion`: it is active, but a newer inactive version exists.
   */
  versionState?: FlowVersionState;
  /** Version number of the Flow's latest version, when it differs from `versionNumber`. */
  latestVersionNumber?: number;
};

export type FlowVersionState = 'current' | 'noActiveVersion' | 'newerInactiveVersion';

/**
 * Where Flow coverage comes from. Today the only implementation reads FlowTestCoverage
 * through the Tooling API; this seam exists so Flow Builder Test Mode coverage can be
 * added if Salesforce exposes it or starts counting it toward deploy-as-active.
 */
export type CoverageSource = {
  /** Every active Flow version that counts toward the deploy-as-active coverage requirement. */
  listActiveCountedFlows(): Promise<FlowCoverage[]>;
  /**
   * Coverage for the named Flows (active version, else latest), with `versionState` set.
   * Names missing from the org are omitted.
   */
  getFlowCoverage(flowNames: string[]): Promise<FlowCoverage[]>;
  /**
   * Fingerprint of a Flow version's content, to compare with source. Undefined when the
   * source can't read the version's content.
   */
  getFlowFingerprint?(flowVersionId: string): Promise<FlowFingerprint | undefined>;
  /**
   * Whether the org has any Flow coverage at all, for any Flow version. False usually means
   * Apex tests ran without code coverage on.
   */
  hasAnyFlowCoverage?(): Promise<boolean>;
};

/** Runs a Tooling API SOQL query and returns every record (all pages). */
export type ToolingQuery = <T extends Record<string, unknown>>(soql: string) => Promise<T[]>;

export type FlowFilter = {
  field: string;
  operator: string;
  /** Apex literal for the filter value, when it can be expressed as one. */
  apexValue?: string;
  /** Raw value text, for TODO comments. */
  rawValue?: string;
  /** The entry-criteria formula term this filter was read from, for TODO comments. */
  formulaTerm?: string;
};

export type FlowVariable = {
  name: string;
  dataType: string;
  isInput: boolean;
  isOutput: boolean;
  isCollection: boolean;
  objectType?: string;
  apexClass?: string;
};

/** The parts of a Flow's metadata XML the tool needs. */
export type FlowMetadata = {
  name: string;
  label?: string;
  processType?: string;
  status?: string;
  /** start.triggerType: RecordAfterSave, RecordBeforeSave, RecordBeforeDelete, PlatformEvent, Scheduled. */
  triggerType?: string;
  /** start.recordTriggerType: Create, Update, CreateAndUpdate, Delete. */
  recordTriggerType?: string;
  /** start.object: the triggering sObject or platform event. */
  object?: string;
  filters: FlowFilter[];
  filterLogic?: string;
  filterFormula?: string;
  /** The Flow's elements, for working out what a test can assert. */
  graph?: FlowGraph;
  variables: FlowVariable[];
};

export type ReadinessFlow = {
  flowName: string;
  processType: string;
  versionNumber?: number;
  covered: boolean;
  elementCoveragePercent: number;
  tests: FlowTestRef[];
  /** Commits that touched the Flow's source file, when the project is a git repo. */
  changes?: number;
  /** Elements no test ran, for Flows some test runs. Undefined when they can't be read. */
  uncoveredElements?: UncoveredElement[];
};

export type ReadinessResult = {
  threshold: number;
  totalFlows: number;
  coveredFlows: number;
  uncoveredFlows: number;
  coveragePercent: number;
  ready: boolean;
  /** Additional Flows that need a test to reach the threshold. */
  flowsNeeded: number;
  /** Active Process Builder processes among the counted Flows. Salesforce no longer supports Process Builder. */
  processBuilderProcesses: number;
  /** Whether "Deploy processes and flows as active" is on. Undefined when it could not be read. */
  deployAsActive?: boolean;
  /** Whether the org is a sandbox or scratch org, where the setting doesn't apply. Undefined when unknown. */
  isSandbox?: boolean;
  /** Problems with the report as a whole, such as no Flow coverage recorded in the org. */
  warnings: string[];
  /** Uncovered first (most-changed first), then covered. */
  flows: ReadinessFlow[];
};

export type GateStatus = 'pass' | 'fail' | 'skip';

export type GateFlowResult = {
  flowName: string;
  status: GateStatus;
  reason: string;
  path?: string;
  versionNumber?: number;
  elementCoveragePercent?: number;
  tests: FlowTestRef[];
  /** Problems that don't change `status`, such as an org version that differs from source. */
  warnings?: string[];
  /** Elements no test ran, for Flows some test runs. Undefined when they can't be read. */
  uncoveredElements?: UncoveredElement[];
};

/** What the gate does when the org's Flow content differs from source. */
export type ContentCheck = 'warn' | 'fail' | 'off';

export type GateResult = {
  passed: boolean;
  minElementCoverage: number;
  flows: GateFlowResult[];
  /** Problems with the run as a whole, such as no Flow coverage recorded in the org. */
  warnings: string[];
};

export type TransformResult = {
  /** Each coverage report written. */
  files: Array<{ format: string; path: string }>;
  /** Flows in the reports, with their element counts. */
  flows: Array<{ flowName: string; path: string; elementsCovered: number; elementsTotal: number }>;
  /** Active Flows left out of the reports, and why. */
  skipped: Array<{ flowName: string; reason: string }>;
  /** Flows whose source file may not match the version the org covered. */
  warnings: string[];
};

export type ScaffoldedTest = {
  flowName: string;
  className: string;
  path: string;
};

export type ScaffoldResult = {
  created: ScaffoldedTest[];
  skipped: Array<{ flowName: string; reason: string }>;
};
