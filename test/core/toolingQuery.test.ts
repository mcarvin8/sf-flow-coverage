import { describe, expect, it, vi } from 'vitest';

import { describeObject, toolingQuery } from '../../src/core/toolingQuery.js';
import * as api from '../../src/index.js';

describe('toolingQuery', () => {
  it('fetches every page through the tooling API', async () => {
    const query = vi.fn().mockResolvedValue({ records: [{ Id: '1' }], done: true, totalSize: 1 });
    const connection = { tooling: { query } } as unknown as Parameters<typeof toolingQuery>[0];
    expect(await toolingQuery(connection)('SELECT Id FROM Flow')).toEqual([{ Id: '1' }]);
    expect(query).toHaveBeenCalledWith('SELECT Id FROM Flow', { autoFetch: true, maxFetch: 1_000_000 });
  });
});

describe('describeObject', () => {
  it('returns the describe fields', async () => {
    const describe = vi.fn().mockResolvedValue({ fields: [{ name: 'Name' }] });
    const connection = { describe } as unknown as Parameters<typeof describeObject>[0];
    expect(await describeObject(connection)('Account')).toEqual([{ name: 'Name' }]);
    expect(describe).toHaveBeenCalledWith('Account');
  });
});

describe('package entry point', () => {
  it('exports the programmatic API', () => {
    expect(Object.keys(api).sort()).toEqual([
      'COUNTED_PROCESS_TYPES',
      'DEFAULT_THRESHOLD',
      'OrgCoverageSource',
      'apexClassMetaXml',
      'apexTestClassName',
      'buildReadinessReport',
      'collectChangedFlows',
      'describeObject',
      'evaluateGate',
      'generateApexTest',
      'isCountedProcessType',
      'parseFlowXml',
      'requiredFieldValues',
      'scaffoldTests',
      'toolingQuery',
    ]);
  });
});
