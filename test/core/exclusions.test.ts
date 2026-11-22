import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  type Exclusion,
  exclusionReason,
  findExclusion,
  parseIgnoreFile,
  readIgnoreFile,
} from '../../src/core/exclusions.js';
import { evaluateGate } from '../../src/core/gate.js';
import { coverage, fakeSource } from '../helpers.js';

describe('parseIgnoreFile', () => {
  it('reads one pattern per line with an optional reason, skipping comments and blank lines', () => {
    expect(
      parseIgnoreFile('# Deferred until the rewrite\r\n\nLegacy_*\n  Close_Old_Cases  # replaced next release\n#\n'),
    ).toEqual([
      { pattern: 'Legacy_*', source: '.flowcovignore' },
      { pattern: 'Close_Old_Cases', source: '.flowcovignore', reason: 'replaced next release' },
    ]);
    expect(parseIgnoreFile('A #', 'custom')).toEqual([{ pattern: 'A', source: 'custom' }]);
  });
});

describe('readIgnoreFile', () => {
  it('reads .flowcovignore from the project, and nothing when there is none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-ignore-'));
    try {
      expect(await readIgnoreFile(dir)).toEqual([]);
      writeFileSync(join(dir, '.flowcovignore'), 'Legacy_*\n');
      expect(await readIgnoreFile(dir)).toEqual([{ pattern: 'Legacy_*', source: '.flowcovignore' }]);
      // Anything but a missing file is a real problem.
      const unreadable = join(dir, 'unreadable');
      mkdirSync(join(unreadable, '.flowcovignore'), { recursive: true });
      await expect(readIgnoreFile(unreadable)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('findExclusion', () => {
  const patterns = (...list: string[]): Exclusion[] => list.map((pattern) => ({ pattern, source: '--exclude' }));
  const excluded = (list: Exclusion[], name: string, path?: string) => findExclusion(list, name, path)?.pattern;

  it('matches Flow API names, ignoring case', () => {
    const list = patterns('Legacy_*', 'Close_?ases', 'ns__*');
    expect(excluded(list, 'legacy_account_sync')).toBe('Legacy_*');
    expect(excluded(list, 'Close_Cases')).toBe('Close_?ases');
    expect(excluded(list, 'ns__Partner_Flow')).toBe('ns__*');
    expect(excluded(list, 'Account_Legacy')).toBeUndefined();
    expect(excluded(patterns('Account.Flow'), 'AccountXFlow')).toBeUndefined();
  });

  it('matches file paths when the pattern has a slash', () => {
    const path = 'force-app/main/legacy/flows/Old.flow-meta.xml';
    expect(excluded(patterns('force-app/main/legacy/'), 'Old', path)).toBe('force-app/main/legacy/');
    expect(excluded(patterns('./force-app/**/Old.flow-meta.xml'), 'Old', path)).toBeDefined();
    expect(excluded(patterns('/force-app/*/legacy/flows/*'), 'Old', path)).toBeDefined();
    expect(excluded(patterns('force-app/*/Old.flow-meta.xml'), 'Old', path)).toBeUndefined();
    expect(
      excluded(patterns('force-app/main/legacy/'), 'Old', 'force-app\\main\\legacy\\Old.flow-meta.xml'),
    ).toBeDefined();
    // Paths are case-sensitive, like git's.
    expect(excluded(patterns('Force-App/'), 'Old', path)).toBeUndefined();
    // A Flow named with --flow has no path.
    expect(excluded(patterns('force-app/'), 'Old')).toBeUndefined();
  });

  it('says which pattern excluded a Flow and why', () => {
    expect(exclusionReason({ pattern: 'Legacy_*', source: '.flowcovignore', reason: 'rewrite in Q3' })).toBe(
      'Excluded by .flowcovignore: Legacy_* (rewrite in Q3).',
    );
    expect(exclusionReason({ pattern: 'Old', source: '--exclude' })).toBe('Excluded by --exclude: Old.');
  });
});

describe('evaluateGate with exclusions', () => {
  it('skips excluded Flows before reading their coverage, even ones it cannot read', async () => {
    const asked: string[][] = [];
    const source = fakeSource([coverage('Legacy_Sync', { covered: false }), coverage('New_Flow')]);
    const result = await evaluateGate({
      source: {
        ...source,
        getFlowCoverage: async (names) => {
          asked.push(names);
          return source.getFlowCoverage(names);
        },
      },
      candidates: [
        { flowName: 'Legacy_Sync' },
        { flowName: 'Broken', path: 'force-app/legacy/Broken.flow-meta.xml', error: 'Not a Flow.' },
        { flowName: 'New_Flow' },
      ],
      exclusions: [
        { pattern: 'legacy_*', source: '.flowcovignore', reason: 'deferred' },
        { pattern: 'force-app/legacy/', source: '--exclude' },
      ],
    });
    expect(asked).toEqual([['New_Flow']]);
    expect(result.passed).toBe(true);
    expect(result.flows.map((f) => [f.flowName, f.status, f.reason])).toEqual([
      ['Legacy_Sync', 'skip', 'Excluded by .flowcovignore: legacy_* (deferred).'],
      ['Broken', 'skip', 'Excluded by --exclude: force-app/legacy/.'],
      ['New_Flow', 'pass', 'Covered by 1 test method(s).'],
    ]);
  });
});
