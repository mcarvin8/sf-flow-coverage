import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { flowNameFromPath } from './flowTypes.js';

const execFileAsync = promisify(execFile);

const FLOW_PATHSPECS = ['*.flow-meta.xml', '*.flow'];
const MAX_BUFFER = 64 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  return stdout;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

async function hasCommits(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Counts commits that touched each Flow file, keyed by Flow API name.
 * Returns undefined when `cwd` is not inside a git repository.
 */
export async function getFlowChurn(cwd: string, since?: string): Promise<Map<string, number> | undefined> {
  if (!(await isGitRepo(cwd))) return undefined;
  // A repository with no commits yet has no history to count (and `git log` would fail).
  if (!(await hasCommits(cwd))) return new Map();
  const args = ['log', '--format=', '--name-only'];
  if (since) args.push(`--since=${since}`);
  const output = await git(cwd, [...args, '--', ...FLOW_PATHSPECS]);
  const churn = new Map<string, number>();
  for (const line of output.split('\n')) {
    const name = flowNameFromPath(line.trim());
    if (name) churn.set(name, (churn.get(name) ?? 0) + 1);
  }
  return churn;
}

/**
 * Flow files added, modified, or renamed between the merge base of `from` and `to`
 * (the same range a pull request shows). Paths are relative to the repository root.
 */
export async function getChangedFlowFiles(cwd: string, from: string, to: string): Promise<string[]> {
  const output = await git(cwd, [
    'diff',
    '--name-status',
    '--diff-filter=AMR',
    `${from}...${to}`,
    '--',
    ...FLOW_PATHSPECS,
  ]);
  const paths: string[] = [];
  for (const line of output.split('\n')) {
    const parts = line.split('\t');
    // Renames are "R100<TAB>old<TAB>new"; everything else is "M<TAB>path".
    const filePath = parts.at(-1)?.trim();
    if (parts.length >= 2 && filePath && flowNameFromPath(filePath)) paths.push(filePath);
  }
  return paths;
}

/** Reads a file's content at a git revision. `filePath` is relative to the repository root. */
export async function showFileAtRevision(cwd: string, revision: string, filePath: string): Promise<string> {
  return git(cwd, ['show', `${revision}:${filePath.replace(/\\/g, '/')}`]);
}
