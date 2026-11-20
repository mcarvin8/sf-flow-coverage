import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { flowNameFromPath } from './flowTypes.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.sf', '.sfdx', '.wireit', 'lib', 'coverage']);

/** Recursively finds Flow metadata files under `root`, keyed by Flow API name. First match wins. */
export async function findFlowFiles(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(fullPath);
      } else {
        const name = flowNameFromPath(entry.name);
        if (name && !found.has(name)) found.set(name, fullPath);
      }
    }
  };
  await walk(root);
  return found;
}

export type ProjectConfig = {
  /** Path of the default package directory in sfdx-project.json. */
  defaultPackagePath?: string;
  sourceApiVersion?: string;
};

type PackageDirectory = { path?: string; default?: boolean };

/** Reads sfdx-project.json from `root`. Returns an empty config when it is missing or unreadable. */
export async function readProjectConfig(root: string): Promise<ProjectConfig> {
  let raw: string;
  try {
    raw = await readFile(join(root, 'sfdx-project.json'), 'utf8');
  } catch {
    return {};
  }
  try {
    const project = JSON.parse(raw) as { packageDirectories?: PackageDirectory[]; sourceApiVersion?: unknown };
    const dirs = project.packageDirectories ?? [];
    const defaultDir = dirs.find((d) => d.default) ?? dirs[0];
    return {
      defaultPackagePath: defaultDir?.path,
      sourceApiVersion: typeof project.sourceApiVersion === 'string' ? project.sourceApiVersion : undefined,
    };
  } catch {
    return {};
  }
}
