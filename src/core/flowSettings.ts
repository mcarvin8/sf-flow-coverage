/** Reads one metadata component, as `connection.metadata.read(type, fullName)` does. */
/** Reads one or more components (up to 10). */
export type MetadataRead = (type: string, fullName: string | string[]) => Promise<unknown>;

/**
 * Whether "Deploy processes and flows as active" is on (`FlowSettings.enableFlowDeployAsActiveEnabled`).
 * Undefined when the setting can't be read, for example without access to settings metadata.
 */
export async function readDeployAsActive(read: MetadataRead): Promise<boolean | undefined> {
  let settings: unknown;
  try {
    settings = await read('FlowSettings', 'Flow');
  } catch {
    return undefined;
  }
  // The Metadata API returns some settings as booleans and others as "true"/"false" strings.
  const value = (settings as { enableFlowDeployAsActiveEnabled?: unknown } | undefined)
    ?.enableFlowDeployAsActiveEnabled;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

/** Runs a SOQL query against the org's data API (not the Tooling API). */
export type DataQuery = <T extends Record<string, unknown>>(soql: string) => Promise<T[]>;

/** Whether the org is a sandbox or scratch org. Undefined when it can't be read. */
export async function readIsSandbox(query: DataQuery): Promise<boolean | undefined> {
  try {
    const [org] = await query<{ IsSandbox?: boolean }>('SELECT IsSandbox FROM Organization');
    return typeof org?.IsSandbox === 'boolean' ? org.IsSandbox : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the setting means for the org, given whether coverage meets the threshold. The setting
 * only affects production: sandboxes and scratch orgs deploy Flows with the status in their metadata.
 */
export function deployAsActiveAdvice(on: boolean, ready: boolean, threshold: number, sandbox = false): string {
  if (sandbox) {
    return `Deploy processes and flows as active is ${on ? 'on' : 'off'} here, but it only affects deployments to production: sandboxes and scratch orgs deploy Flows with the status in their metadata. Check production with this command to see where it stands.`;
  }
  if (on) {
    return ready
      ? 'Deploy processes and flows as active is on. Keep coverage at or above the threshold: deployments that include active Flows fail below it.'
      : `Deploy processes and flows as active is on, but coverage is below ${threshold}%: deployments that include active Flows will fail until it is back up.`;
  }
  return ready
    ? 'Deploy processes and flows as active is off. The org has the coverage it needs: turn it on in Setup > Process Automation Settings.'
    : `Deploy processes and flows as active is off. Reach ${threshold}% first, then turn it on in Setup > Process Automation Settings.`;
}
