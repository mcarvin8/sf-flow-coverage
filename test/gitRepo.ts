import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A throwaway git repository for tests. */
export class TempGitRepo {
  public readonly dir = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-'));

  public constructor() {
    this.git('init', '-q', '-b', 'main');
    this.git('config', 'user.email', 'test@example.com');
    this.git('config', 'user.name', 'Test');
    this.git('config', 'commit.gpgsign', 'false');
  }

  public git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, encoding: 'utf8' });
  }

  public write(path: string, content: string): void {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  public commit(message: string, files: Record<string, string>, date?: string): void {
    for (const [path, content] of Object.entries(files)) this.write(path, content);
    this.git('add', '-A');
    const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: this.dir, env });
  }

  public remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export const flowXml = (processType = 'AutoLaunchedFlow', status = 'Active', label = 'x'): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\n    <label>${label}</label>\n    <processType>${processType}</processType>\n    <status>${status}</status>\n</Flow>\n`;
