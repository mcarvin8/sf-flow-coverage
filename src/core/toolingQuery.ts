import type { Connection } from '@salesforce/core';

import type { DataQuery, MetadataRead } from './flowSettings.js';
import type { DescribeField, DescribeObject, DescribeResult } from './requiredFields.js';
import type { ToolingQuery } from './types.js';

const MAX_FETCH = 1_000_000;

/** Adapts an org connection to the ToolingQuery used by OrgCoverageSource, fetching every page. */
export function toolingQuery(connection: Pick<Connection, 'tooling'>): ToolingQuery {
  return async <T extends Record<string, unknown>>(soql: string): Promise<T[]> => {
    const result = await connection.tooling.query<T>(soql, { autoFetch: true, maxFetch: MAX_FETCH });
    return result.records;
  };
}

/** Adapts an org connection to a data API query, fetching every page. */
export function dataQuery(connection: Pick<Connection, 'query'>): DataQuery {
  return async <T extends Record<string, unknown>>(soql: string): Promise<T[]> =>
    (await connection.query<T>(soql, { autoFetch: true, maxFetch: MAX_FETCH })).records;
}

/** Adapts an org connection to the MetadataRead used to read org settings. */
export function metadataRead(connection: Pick<Connection, 'metadata'>): MetadataRead {
  return async (type: string, fullName: string | string[]): Promise<unknown> =>
    connection.metadata.read(type as Parameters<Connection['metadata']['read']>[0], fullName as string);
}

/** Adapts an org connection to the DescribeObject used by scaffolding to fill required fields. */
export function describeObject(connection: Pick<Connection, 'describe'>): DescribeObject {
  return async (objectName: string): Promise<DescribeResult> => {
    const result = await connection.describe(objectName);
    return { fields: result.fields as unknown as DescribeField[], recordTypeInfos: result.recordTypeInfos };
  };
}
