import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execCmd, TestSession } from '@salesforce/cli-plugins-testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ScaffoldResult } from '../../../src/core/types.js';

describe('flowcov scaffold NUTs', () => {
  let session: TestSession;
  let out: string;
  const project = resolve('test/fixtures/project');

  beforeAll(async () => {
    session = await TestSession.create({ devhubAuthStrategy: 'NONE' });
    out = mkdtempSync(join(tmpdir(), 'sf-flow-coverage-nut-'));
  });

  afterAll(async () => {
    await session?.clean();
    rmSync(out, { recursive: true, force: true });
  });

  it('generates an Apex test class for a record-triggered Flow', () => {
    const result = execCmd<ScaffoldResult>(
      `flowcov scaffold --flow Account_After_Save --project-dir ${project} --output-dir ${out} --json`,
      { ensureExitCode: 0 },
    ).jsonOutput?.result;

    expect(result?.created.map((c) => c.className)).toEqual(['Account_After_Save_FlowTest']);
    const classPath = join(out, 'Account_After_Save_FlowTest.cls');
    expect(readFileSync(classPath, 'utf8')).toContain('private class Account_After_Save_FlowTest');
    expect(existsSync(`${classPath}-meta.xml`)).toBe(true);
  });

  it('skips Flows that do not count toward deploy-as-active coverage', () => {
    const result = execCmd<ScaffoldResult>(
      `flowcov scaffold --flow Intake_Screen --project-dir ${project} --output-dir ${out} --json`,
      { ensureExitCode: 0 },
    ).jsonOutput?.result;
    expect(result?.created).toEqual([]);
    expect(result?.skipped[0].flowName).toBe('Intake_Screen');
  });

  it('fails without --flow or --uncovered', () => {
    execCmd(`flowcov scaffold --project-dir ${project}`, { ensureExitCode: 1 });
  });
});
