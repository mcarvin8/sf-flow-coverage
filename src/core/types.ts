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
};

/**
 * Where Flow coverage comes from. Today the only implementation reads FlowTestCoverage
 * through the Tooling API; this seam exists so Flow Builder Test Mode coverage can be
 * added if Salesforce exposes it or starts counting it toward deploy-as-active.
 */
export type CoverageSource = {
  /** Every active Flow version that counts toward the deploy-as-active coverage requirement. */
  listActiveCountedFlows(): Promise<FlowCoverage[]>;
  /** Coverage for the named Flows (active version, else latest). Names missing from the org are omitted. */
  getFlowCoverage(flowNames: string[]): Promise<FlowCoverage[]>;
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
};

export type GateResult = {
  passed: boolean;
  minElementCoverage: number;
  flows: GateFlowResult[];
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
