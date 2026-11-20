import { describe, expect, it, vi } from 'vitest';

import { dataQuery, describeObject, metadataRead, toolingQuery } from '../../src/core/toolingQuery.js';
import * as api from '../../src/index.js';

describe('toolingQuery', () => {
  it('fetches every page through the tooling API', async () => {
    const query = vi.fn().mockResolvedValue({ records: [{ Id: '1' }], done: true, totalSize: 1 });
    const connection = { tooling: { query } } as unknown as Parameters<typeof toolingQuery>[0];
    expect(await toolingQuery(connection)('SELECT Id FROM Flow')).toEqual([{ Id: '1' }]);
    expect(query).toHaveBeenCalledWith('SELECT Id FROM Flow', { autoFetch: true, maxFetch: 1_000_000 });
  });
});

describe('dataQuery and metadataRead', () => {
  it('query org data and read metadata through the connection', async () => {
    const query = vi.fn().mockResolvedValue({ records: [{ IsSandbox: true }], done: true, totalSize: 1 });
    const read = vi.fn().mockResolvedValue({ fullName: 'Flow' });
    const connection = { query, metadata: { read } } as unknown as Parameters<typeof dataQuery>[0] &
      Parameters<typeof metadataRead>[0];
    expect(await dataQuery(connection)('SELECT IsSandbox FROM Organization')).toEqual([{ IsSandbox: true }]);
    expect(query).toHaveBeenCalledWith('SELECT IsSandbox FROM Organization', { autoFetch: true, maxFetch: 1_000_000 });
    expect(await metadataRead(connection)('FlowSettings', 'Flow')).toEqual({ fullName: 'Flow' });
    expect(read).toHaveBeenCalledWith('FlowSettings', 'Flow');
  });
});

describe('describeObject', () => {
  it('returns the describe fields', async () => {
    const describe = vi.fn().mockResolvedValue({ fields: [{ name: 'Name' }], recordTypeInfos: [{}, {}] });
    const connection = { describe } as unknown as Parameters<typeof describeObject>[0];
    expect(await describeObject(connection)('Account')).toEqual({
      fields: [{ name: 'Name' }],
      recordTypeInfos: [{}, {}],
    });
    expect(describe).toHaveBeenCalledWith('Account');
  });
});

describe('package entry point', () => {
  it('exports the programmatic API', () => {
    expect(Object.keys(api).sort()).toEqual([
      'COUNTED_PROCESS_TYPES',
      'COVERAGE_FORMATS',
      'DEFAULT_THRESHOLD',
      'OrgCoverageSource',
      'apexClassMetaXml',
      'apexTestClassName',
      'buildFlowFileCoverage',
      'buildReadinessReport',
      'collectChangedFlows',
      'dataQuery',
      'describeObject',
      'evaluateGate',
      'formatCoverage',
      'generateApexTest',
      'isCountedProcessType',
      'metadataRead',
      'parseFlowXml',
      'requiredFieldValues',
      'scaffoldTests',
      'toolingQuery',
    ]);
  });
});
