import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The file, in the project directory, that lists Flows the gate doesn't check. */
export const IGNORE_FILE = '.flowcovignore';

/** A pattern for Flows a team has chosen not to check, and where it came from. */
export type Exclusion = {
  /**
   * A Flow API name, or a file path when it contains `/`. `*` matches any characters except `/`,
   * `**` matches any characters, and `?` matches one character. A path ending in `/` matches
   * everything under it.
   */
  pattern: string;
  /** Where the pattern came from: `.flowcovignore` or `--exclude`. */
  source: string;
  /** Why the Flow is excluded: the comment after the pattern in `.flowcovignore`. */
  reason?: string;
};

/**
 * Reads exclusions from `.flowcovignore` text: one pattern per line, with an optional `# reason`
 * after it. Blank lines and lines starting with `#` are ignored.
 */
export function parseIgnoreFile(text: string, source = IGNORE_FILE): Exclusion[] {
  const exclusions: Exclusion[] = [];
  for (const line of text.split(/\r?\n/)) {
    const hash = line.indexOf('#');
    const pattern = (hash === -1 ? line : line.slice(0, hash)).trim();
    if (!pattern) continue;
    const reason = hash === -1 ? '' : line.slice(hash + 1).trim();
    exclusions.push({ pattern, source, ...(reason ? { reason } : {}) });
  }
  return exclusions;
}

/** Reads `.flowcovignore` from the project directory. No file means no exclusions. */
export async function readIgnoreFile(projectDir: string): Promise<Exclusion[]> {
  try {
    return parseIgnoreFile(await readFile(join(projectDir, IGNORE_FILE), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function globToRegExp(glob: string, flags: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      source += '.*';
      i++;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, flags);
}

/** True when the pattern matches the Flow: by API name (ignoring case, as Salesforce does) or by path. */
function matches(pattern: string, flowName: string, path: string | undefined): boolean {
  if (!pattern.includes('/')) return globToRegExp(pattern, 'i').test(flowName);
  if (!path) return false;
  const glob = pattern.replace(/^\.?\//, '');
  return globToRegExp(glob.endsWith('/') ? `${glob}**` : glob, '').test(path.replace(/\\/g, '/'));
}

/** The first exclusion that matches the Flow, if any. */
export function findExclusion(exclusions: Exclusion[], flowName: string, path?: string): Exclusion | undefined {
  return exclusions.find((exclusion) => matches(exclusion.pattern, flowName, path));
}

/** Says why a Flow is skipped, for the gate's Reason column. */
export function exclusionReason(exclusion: Exclusion): string {
  const reason = exclusion.reason ? ` (${exclusion.reason})` : '';
  return `Excluded by ${exclusion.source}: ${exclusion.pattern}${reason}.`;
}
