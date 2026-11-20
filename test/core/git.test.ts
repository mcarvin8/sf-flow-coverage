import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getChangedFlowFiles, getFlowChurn, isGitRepo, parseSince, showFileAtRevision } from '../../src/core/git.js';
import { flowXml, TempGitRepo } from '../gitRepo.js';

const FLOWS = 'force-app/main/default/flows';

describe('git helpers', () => {
  let repo: TempGitRepo;
  let notRepo: string;

  beforeAll(() => {
    repo = new TempGitRepo();
    repo.commit('one', { [`${FLOWS}/Alpha.flow-meta.xml`]: flowXml(), 'README.md': 'x' }, '2020-01-01T00:00:00Z');
    repo.commit('two', { [`${FLOWS}/Alpha.flow-meta.xml`]: flowXml('AutoLaunchedFlow', 'Active', 'y') });
    repo.git('checkout', '-q', '-b', 'feature');
    repo.commit('three', {
      [`${FLOWS}/Alpha.flow-meta.xml`]: flowXml('AutoLaunchedFlow', 'Active', 'z'),
      'mdapi/flows/Beta.flow': flowXml(),
      'force-app/main/default/classes/A.cls': 'class A {}',
    });
    repo.git('mv', `${FLOWS}/Alpha.flow-meta.xml`, `${FLOWS}/Gamma.flow-meta.xml`);
    repo.commit('rename', {});
    notRepo = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-nogit-'));
  });

  afterAll(() => {
    repo.remove();
    rmSync(notRepo, { recursive: true, force: true });
  });

  it('detects git repositories', async () => {
    expect(await isGitRepo(repo.dir)).toBe(true);
    expect(await isGitRepo(relative(process.cwd(), repo.dir) || '.')).toBe(true);
    expect(await isGitRepo(notRepo)).toBe(false);
  });

  it('counts commits per Flow', async () => {
    const churn = await getFlowChurn(repo.dir);
    expect(Object.fromEntries(churn ?? [])).toEqual({ Alpha: 3, Beta: 1, Gamma: 1 });
  });

  it('limits churn by date', async () => {
    const churn = await getFlowChurn(repo.dir, '2021-01-01');
    expect(churn?.get('Alpha')).toBe(2);
  });

  it('returns empty churn for a repository with no commits', async () => {
    const empty = new TempGitRepo();
    try {
      expect(await getFlowChurn(empty.dir)).toEqual(new Map());
    } finally {
      empty.remove();
    }
  });

  it('returns undefined churn outside git', async () => {
    expect(await getFlowChurn(notRepo)).toBeUndefined();
  });

  it('lists Flows changed since the merge base, following renames', async () => {
    const changed = await getChangedFlowFiles(repo.dir, 'main', 'feature');
    expect(changed.sort()).toEqual([`${FLOWS}/Gamma.flow-meta.xml`, 'mdapi/flows/Beta.flow']);
  });

  it('refuses revisions that do not resolve', async () => {
    await expect(getChangedFlowFiles(repo.dir, 'nope', 'feature')).rejects.toThrow();
  });

  it('refuses revisions with no common history', async () => {
    repo.git('checkout', '-q', '--orphan', 'island');
    repo.commit('island', { 'island.txt': 'x' });
    try {
      await expect(getChangedFlowFiles(repo.dir, 'main', 'island')).rejects.toThrow(/no common history/);
    } finally {
      repo.git('checkout', '-q', 'feature');
    }
  });

  it('reads a file at a revision', async () => {
    expect(await showFileAtRevision(repo.dir, 'main', `${FLOWS}\\Alpha.flow-meta.xml`)).toContain('<label>y</label>');
  });
});

describe('parseSince', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  it('parses relative values', () => {
    expect(parseSince('3 days ago', now).toISOString()).toBe('2026-06-12T12:00:00.000Z');
    expect(parseSince('1 week ago', now).toISOString()).toBe('2026-06-08T12:00:00.000Z');
    expect(parseSince('6 months ago', now).toISOString()).toBe('2025-12-15T12:00:00.000Z');
    expect(parseSince(' 2 Years Ago ', now).toISOString()).toBe('2024-06-15T12:00:00.000Z');
  });

  it('parses ISO dates', () => {
    expect(parseSince('2026-01-31T00:00:00Z').toISOString()).toBe('2026-01-31T00:00:00.000Z');
  });

  it('refuses anything else', () => {
    expect(() => parseSince('last tuesday')).toThrow(/Unsupported --since value "last tuesday"/);
    expect(() => parseSince('2026-13-45')).toThrow(/Unsupported --since value/);
  });
});
