import { type FlowFingerprint, fingerprintFromMetadata } from './flowFingerprint.js';
import { COUNTED_PROCESS_TYPES, isCountedProcessType, qualifiedFlowName, splitFlowName } from './flowTypes.js';
import type { CoverageSource, FlowCoverage, FlowTestRef, ToolingQuery } from './types.js';

type FlowRecord = {
  Id: string;
  VersionNumber?: number;
  ProcessType: string;
  Status?: string;
  Definition?: { DeveloperName: string; NamespacePrefix?: string | null } | null;
};

type FlowDefinitionRecord = {
  Id: string;
  DeveloperName: string;
  NamespacePrefix?: string | null;
  ActiveVersionId?: string | null;
  LatestVersionId?: string | null;
  LatestVersion?: { VersionNumber?: number | null } | null;
};

type FlowTestCoverageRecord = {
  Id: string;
  FlowVersionId: string;
  ApexTestClassId?: string | null;
  TestMethodName?: string | null;
  NumElementsCovered?: number | null;
  NumElementsNotCovered?: number | null;
};

type FlowElementTestCoverageRecord = {
  FlowTestCoverageId: string;
  ElementName: string;
};

type ApexClassRecord = { Id: string; Name: string; NamespacePrefix?: string | null };

const CHUNK_SIZE = 200;
const FLOW_FIELDS = 'Id, VersionNumber, ProcessType, Status, Definition.DeveloperName, Definition.NamespacePrefix';

/** Salesforce IDs come back as 18 characters, but compare on the case-sensitive 15-character form to be safe. */
const idKey = (id: string): string => id.slice(0, 15);

function chunk<T>(items: T[], size = CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

const soqlList = (values: string[]): string =>
  values.map((v) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(', ');

/** Whether the version `getFlowCoverage` read is the one a deploy most likely produced. */
function versionInfo(definition: FlowDefinitionRecord): Pick<FlowCoverage, 'versionState' | 'latestVersionNumber'> {
  const { ActiveVersionId: active, LatestVersionId: latest } = definition;
  if (!active) return { versionState: 'noActiveVersion' };
  if (latest && idKey(latest) !== idKey(active)) {
    return {
      versionState: 'newerInactiveVersion',
      latestVersionNumber: definition.LatestVersion?.VersionNumber ?? undefined,
    };
  }
  return { versionState: 'current' };
}

/** Reads Flow coverage from FlowTestCoverage, which Salesforce fills in when Apex tests run in the org. */
export class OrgCoverageSource implements CoverageSource {
  private readonly fingerprints = new Map<string, Promise<FlowFingerprint | undefined>>();

  public constructor(private readonly query: ToolingQuery) {}

  public async listActiveCountedFlows(): Promise<FlowCoverage[]> {
    const flows = await this.query<FlowRecord>(
      `SELECT ${FLOW_FIELDS} FROM Flow WHERE Status = 'Active' AND ProcessType IN (${soqlList([...COUNTED_PROCESS_TYPES])})`,
    );
    return this.buildCoverage(flows);
  }

  public async getFlowCoverage(flowNames: string[]): Promise<FlowCoverage[]> {
    if (flowNames.length === 0) return [];
    const wanted = new Set(flowNames);
    const developerNames = [...new Set(flowNames.map((n) => splitFlowName(n).developerName))];
    const definitions = await this.queryInChunks<FlowDefinitionRecord>(
      developerNames,
      (list) =>
        `SELECT Id, DeveloperName, NamespacePrefix, ActiveVersionId, LatestVersionId, LatestVersion.VersionNumber FROM FlowDefinition WHERE DeveloperName IN (${list})`,
    );
    const definitionByVersion = new Map<string, FlowDefinitionRecord>();
    for (const definition of definitions) {
      if (!wanted.has(qualifiedFlowName(definition.DeveloperName, definition.NamespacePrefix))) continue;
      const versionId = definition.ActiveVersionId ?? definition.LatestVersionId;
      if (versionId) definitionByVersion.set(idKey(versionId), definition);
    }
    if (definitionByVersion.size === 0) return [];
    const flows = await this.queryInChunks<FlowRecord>(
      [...definitionByVersion.values()].map((d) => (d.ActiveVersionId ?? d.LatestVersionId) as string),
      (list) => `SELECT ${FLOW_FIELDS} FROM Flow WHERE Id IN (${list})`,
    );
    const coverage = await this.buildCoverage(flows);
    return coverage.map((flow) => {
      const definition = definitionByVersion.get(idKey(flow.flowVersionId));
      return definition ? { ...flow, ...versionInfo(definition) } : flow;
    });
  }

  /**
   * The Tooling API returns `Flow.Metadata` only when a query returns one row, so this reads one
   * version per query. Returns undefined when the query fails or returns no content.
   */
  public async hasAnyFlowCoverage(): Promise<boolean> {
    try {
      return (await this.query('SELECT Id FROM FlowTestCoverage LIMIT 1')).length > 0;
    } catch {
      // Without an answer, don't claim coverage is missing.
      return true;
    }
  }

  public async countCoveredInactiveVersions(): Promise<number | undefined> {
    try {
      const rows = await this.query<{ FlowVersionId?: string }>('SELECT FlowVersionId FROM FlowTestCoverage');
      const ids = [...new Set(rows.flatMap((r) => (r.FlowVersionId ? [r.FlowVersionId] : [])))];
      const versions = await this.queryInChunks<{
        Id: string;
        Status?: string;
        ProcessType?: string;
        Definition?: { LatestVersionId?: string | null } | null;
      }>(ids, (list) => `SELECT Id, Status, ProcessType, Definition.LatestVersionId FROM Flow WHERE Id IN (${list})`);
      return versions.filter(
        (v) =>
          v.Status !== 'Active' &&
          isCountedProcessType(v.ProcessType) &&
          v.Definition?.LatestVersionId &&
          idKey(v.Definition.LatestVersionId) === idKey(v.Id),
      ).length;
    } catch {
      return undefined;
    }
  }

  public getFlowFingerprint(flowVersionId: string): Promise<FlowFingerprint | undefined> {
    // The gate's content check and its uncovered-element list both ask for the same versions.
    const key = idKey(flowVersionId);
    let fingerprint = this.fingerprints.get(key);
    if (!fingerprint) {
      fingerprint = this.readFingerprint(flowVersionId);
      this.fingerprints.set(key, fingerprint);
    }
    return fingerprint;
  }

  private async readFingerprint(flowVersionId: string): Promise<FlowFingerprint | undefined> {
    try {
      const [record] = await this.query<{ Metadata?: unknown }>(
        `SELECT Metadata FROM Flow WHERE Id = ${soqlList([flowVersionId])}`,
      );
      return record?.Metadata ? fingerprintFromMetadata(record.Metadata) : undefined;
    } catch {
      return undefined;
    }
  }

  private async queryInChunks<T extends Record<string, unknown>>(
    values: string[],
    buildSoql: (list: string) => string,
  ): Promise<T[]> {
    const results: T[] = [];
    for (const part of chunk(values)) {
      // Sequential on purpose: keeps API usage predictable on large orgs.
      results.push(...(await this.query<T>(buildSoql(soqlList(part)))));
    }
    return results;
  }

  private async buildCoverage(flows: FlowRecord[]): Promise<FlowCoverage[]> {
    const coverageRows = await this.queryInChunks<FlowTestCoverageRecord>(
      flows.map((f) => f.Id),
      (list) =>
        `SELECT Id, FlowVersionId, ApexTestClassId, TestMethodName, NumElementsCovered, NumElementsNotCovered FROM FlowTestCoverage WHERE FlowVersionId IN (${list})`,
    );
    const coveredElements = await this.loadCoveredElements(coverageRows);
    const classNames = await this.loadClassNames(coverageRows);

    const rowsByVersion = new Map<string, FlowTestCoverageRecord[]>();
    for (const row of coverageRows) {
      const key = idKey(row.FlowVersionId);
      rowsByVersion.set(key, [...(rowsByVersion.get(key) ?? []), row]);
    }

    return flows.map((flow) => {
      const rows = rowsByVersion.get(idKey(flow.Id)) ?? [];
      const elementsTotal = Math.max(
        0,
        ...rows.map((r) => (r.NumElementsCovered ?? 0) + (r.NumElementsNotCovered ?? 0)),
      );
      const bestSingleTest = Math.max(0, ...rows.map((r) => r.NumElementsCovered ?? 0));
      const coveredNames = coveredElements
        ? new Set(rows.flatMap((r) => [...(coveredElements.get(idKey(r.Id)) ?? [])]))
        : undefined;
      const elementsCovered = Math.min(Math.max(bestSingleTest, coveredNames?.size ?? 0), elementsTotal);
      const tests: FlowTestRef[] = rows.map((r) => ({
        className: (r.ApexTestClassId && classNames.get(idKey(r.ApexTestClassId))) || r.ApexTestClassId || 'unknown',
        methodName: r.TestMethodName ?? 'unknown',
      }));
      return {
        flowName: qualifiedFlowName(flow.Definition?.DeveloperName ?? flow.Id, flow.Definition?.NamespacePrefix),
        flowVersionId: flow.Id,
        versionNumber: flow.VersionNumber,
        processType: flow.ProcessType,
        status: flow.Status,
        covered: rows.length > 0,
        elementsCovered,
        elementsTotal,
        elementCoveragePercent: elementsTotal > 0 ? Math.round((elementsCovered / elementsTotal) * 1000) / 10 : 0,
        tests,
        coveredElementNames: coveredNames && [...coveredNames].sort(),
      };
    });
  }

  /**
   * Union of covered element names per FlowTestCoverage row, so element coverage reflects all
   * tests together. Returns undefined if FlowElementTestCoverage can't be queried, in which case
   * the best single test's count is used instead.
   */
  private async loadCoveredElements(rows: FlowTestCoverageRecord[]): Promise<Map<string, Set<string>> | undefined> {
    if (rows.length === 0) return new Map();
    try {
      const elements = await this.queryInChunks<FlowElementTestCoverageRecord>(
        rows.map((r) => r.Id),
        (list) =>
          `SELECT FlowTestCoverageId, ElementName FROM FlowElementTestCoverage WHERE FlowTestCoverageId IN (${list})`,
      );
      const byRow = new Map<string, Set<string>>();
      for (const element of elements) {
        const key = idKey(element.FlowTestCoverageId);
        byRow.set(key, (byRow.get(key) ?? new Set()).add(element.ElementName));
      }
      return byRow;
    } catch {
      return undefined;
    }
  }

  private async loadClassNames(rows: FlowTestCoverageRecord[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((r) => r.ApexTestClassId).filter((id): id is string => !!id))];
    const classes = await this.queryInChunks<ApexClassRecord>(
      ids,
      (list) => `SELECT Id, Name, NamespacePrefix FROM ApexClass WHERE Id IN (${list})`,
    );
    return new Map(classes.map((c) => [idKey(c.Id), c.NamespacePrefix ? `${c.NamespacePrefix}.${c.Name}` : c.Name]));
  }
}
