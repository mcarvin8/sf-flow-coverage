import { resolve as resolvePath } from 'node:path';

import { openRepository, type Repository } from '@scolladon/tsgit';

import { flowNameFromPath } from './flowTypes.js';

type Change = Awaited<ReturnType<Repository['diff']>>['changes'][number];
type ObjectId = Extract<Awaited<ReturnType<Repository['revParse']>>[number], { kind: 'object' }>['id'];

async function withRepo<T>(cwd: string, work: (repo: Repository) => Promise<T>): Promise<T> {
  // tsgit requires an absolute path; --project-dir defaults to '.'.
  const repo = await openRepository({ cwd: resolvePath(cwd) });
  try {
    return await work(repo);
  } finally {
    await repo.dispose();
  }
}

/** Resolves a revision (branch, tag, `HEAD~1`, oid...) to an object id. */
async function resolve(repo: Repository, revision: string): Promise<ObjectId> {
  const [entry] = await repo.revParse(revision);
  if (entry?.kind !== 'object') throw new Error(`Git revision "${revision}" does not resolve to a commit.`);
  return entry.id;
}

/** The path a change leaves behind (its old path for deletions). */
function changedPath(change: Change): string {
  switch (change.type) {
    case 'add':
    case 'rename':
    case 'copy':
      return String(change.newPath);
    case 'delete':
      return String(change.oldPath);
    default:
      return String(change.path);
  }
}

const RELATIVE_SINCE = /^(\d+)\s+(day|week|month|year)s?\s+ago$/i;

/**
 * Parses a `--since` value: an ISO date (`2026-01-31`, `2026-01-31T12:00:00Z`) or
 * `<n> days|weeks|months|years ago`. Throws for anything else.
 */
export function parseSince(value: string, now: Date = new Date()): Date {
  const trimmed = value.trim();
  const relative = RELATIVE_SINCE.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const date = new Date(now);
    const unit = relative[2].toLowerCase();
    if (unit === 'day') date.setUTCDate(date.getUTCDate() - amount);
    else if (unit === 'week') date.setUTCDate(date.getUTCDate() - amount * 7);
    else if (unit === 'month') date.setUTCMonth(date.getUTCMonth() - amount);
    else date.setUTCFullYear(date.getUTCFullYear() - amount);
    return date;
  }
  const date = /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? new Date(trimmed) : undefined;
  if (!date || Number.isNaN(date.getTime())) {
    throw new Error(
      `Unsupported --since value "${value}". Use a date (2026-01-31) or "<n> days|weeks|months|years ago".`,
    );
  }
  return date;
}

const errorCode = (error: unknown): string | undefined =>
  (error as { data?: { code?: string } } | undefined)?.data?.code;

type HeadState = 'none' | 'unborn' | 'born';

/** Whether `cwd` is in a repository, and whether that repository has commits. Opening is lazy, so ask for HEAD. */
async function headState(repo: Repository): Promise<HeadState> {
  try {
    await resolve(repo, 'HEAD');
    return 'born';
  } catch (error) {
    return errorCode(error) === 'NOT_A_REPOSITORY' ? 'none' : 'unborn';
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return withRepo(cwd, async (repo) => (await headState(repo)) !== 'none');
}

/**
 * Counts commits that touched each Flow file, keyed by Flow API name. Merge commits are not
 * counted, as with `git log --name-only`. Returns undefined when `cwd` is not inside a git repository.
 */
export async function getFlowChurn(cwd: string, since?: string): Promise<Map<string, number> | undefined> {
  const sinceSeconds = since === undefined ? undefined : parseSince(since).getTime() / 1000;
  return withRepo(cwd, async (repo) => {
    const state = await headState(repo);
    if (state === 'none') return undefined;
    const churn = new Map<string, number>();
    // A repository with no commits yet has no history to count.
    if (state === 'unborn') return churn;
    for (const entry of await repo.whatchanged()) {
      if (sinceSeconds !== undefined && entry.committer.timestamp < sinceSeconds) continue;
      for (const change of entry.changes.changes) {
        const name = flowNameFromPath(changedPath(change));
        if (name) churn.set(name, (churn.get(name) ?? 0) + 1);
      }
    }
    return churn;
  });
}

/**
 * Flow files added, modified, or renamed between the merge base of `from` and `to`
 * (the same range a pull request shows). Paths are relative to the repository root.
 */
export async function getChangedFlowFiles(cwd: string, from: string, to: string): Promise<string[]> {
  return withRepo(cwd, async (repo) => {
    const fromId = await resolve(repo, from);
    const toId = await resolve(repo, to);
    const [base] = await repo.primitives.mergeBase([fromId, toId]);
    if (!base) throw new Error(`Git revisions "${from}" and "${to}" have no common history.`);
    const diff = await repo.diff({ from: String(base), to: String(toId), recursive: true, detectRenames: true });
    return diff.changes
      .filter((change) => change.type === 'add' || change.type === 'modify' || change.type === 'rename')
      .map(changedPath)
      .filter((path) => flowNameFromPath(path) !== undefined);
  });
}

/** Reads a file's content at a git revision. `filePath` is relative to the repository root. */
export async function showFileAtRevision(cwd: string, revision: string, filePath: string): Promise<string> {
  return withRepo(cwd, async (repo) => {
    const file = await repo.readFileAt(revision, filePath.replace(/\\/g, '/'));
    return new TextDecoder().decode(file.content);
  });
}
