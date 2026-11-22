import { describe, expect, it } from 'vitest';

import { deployAsActiveAdvice, readDeployAsActive, readIsSandbox } from '../../src/core/flowSettings.js';
import { buildReadinessReport } from '../../src/core/readiness.js';
import { coverage, fakeSource } from '../helpers.js';

describe('readDeployAsActive', () => {
  it('reads the setting as a boolean or a string', async () => {
    const read = (value: unknown) => readDeployAsActive(async () => ({ enableFlowDeployAsActiveEnabled: value }));
    expect(await read(true)).toBe(true);
    expect(await read('true')).toBe(true);
    expect(await read(false)).toBe(false);
    expect(await read('false')).toBe(false);
    expect(await read(undefined)).toBeUndefined();
    expect(await read('maybe')).toBeUndefined();
  });

  it('asks for the Flow settings and gives up quietly when it cannot read them', async () => {
    const asked: Array<[string, string | string[]]> = [];
    await readDeployAsActive(async (type, fullName) => {
      asked.push([type, fullName]);
      return {};
    });
    expect(asked).toEqual([['FlowSettings', 'Flow']]);
    expect(await readDeployAsActive(async () => undefined)).toBeUndefined();
    expect(
      await readDeployAsActive(async () => {
        throw new Error('INSUFFICIENT_ACCESS');
      }),
    ).toBeUndefined();
  });
});

describe('readIsSandbox', () => {
  it('reads IsSandbox from the Organization record', async () => {
    const queries: string[] = [];
    const query = (rows: Array<Record<string, unknown>>) =>
      (async (soql: string) => {
        queries.push(soql);
        return rows;
      }) as Parameters<typeof readIsSandbox>[0];
    expect(await readIsSandbox(query([{ IsSandbox: true }]))).toBe(true);
    expect(await readIsSandbox(query([{ IsSandbox: false }]))).toBe(false);
    expect(await readIsSandbox(query([]))).toBeUndefined();
    expect(queries[0]).toBe('SELECT IsSandbox FROM Organization');
    expect(
      await readIsSandbox((async () => {
        throw new Error('no access');
      }) as Parameters<typeof readIsSandbox>[0]),
    ).toBeUndefined();
  });
});

describe('deployAsActiveAdvice', () => {
  it('says what to do in production for each combination', () => {
    expect(deployAsActiveAdvice(false, true, 75)).toBe(
      'Deploy processes and flows as active is off. The org has the coverage it needs: turn it on in Setup > Process Automation Settings.',
    );
    expect(deployAsActiveAdvice(false, false, 75)).toBe(
      'Deploy processes and flows as active is off. Reach 75% first, then turn it on in Setup > Process Automation Settings.',
    );
    expect(deployAsActiveAdvice(true, true, 75)).toContain('is on. Keep coverage at or above the threshold');
    expect(deployAsActiveAdvice(true, false, 80)).toContain('is on, but coverage is below 80%');
  });

  it('explains that the setting only matters in production', () => {
    expect(deployAsActiveAdvice(true, false, 75, true)).toBe(
      'Deploy processes and flows as active is on here, but it only affects deployments to production: sandboxes and scratch orgs deploy Flows with the status in their metadata. Check production with this command to see where it stands.',
    );
    expect(deployAsActiveAdvice(false, true, 75, true)).toContain('is off here');
  });
});

describe('buildReadinessReport settings', () => {
  it('reports the setting and the org type when it can read them', async () => {
    const result = await buildReadinessReport({
      source: fakeSource([coverage('A')]),
      metadataRead: async () => ({ enableFlowDeployAsActiveEnabled: 'true' }),
      dataQuery: (async () => [{ IsSandbox: false }]) as never,
    });
    expect(result).toMatchObject({ deployAsActive: true, isSandbox: false });
    const unknown = await buildReadinessReport({ source: fakeSource([coverage('A')]) });
    expect(unknown.deployAsActive).toBeUndefined();
    expect(unknown.isSandbox).toBeUndefined();
  });
});
