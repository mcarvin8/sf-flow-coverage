import type { MetadataRead } from './flowSettings.js';

/** Who an email alert sends to that depends on the record: fields a test can fill. */
export type AlertRecipients = {
  /** Email fields of the record (`email` recipients). */
  emailFields: string[];
  /** User lookups of the record (`userLookup` recipients). */
  userLookups: string[];
  /**
   * True when the alert also sends to someone the record doesn't decide (a user, role, group, the
   * owner, static addresses), so it has a recipient whatever the test sets.
   */
  hasFixedRecipient: boolean;
};

/** Reads the recipients of email alerts by full name (`Case.Notify_Owner`). Missing alerts are left out. */
export type ReadEmailAlerts = (fullNames: string[]) => Promise<Record<string, AlertRecipients>>;

type RecipientMetadata = { type?: string; field?: string | null };
type AlertMetadata = {
  fullName?: string;
  recipients?: RecipientMetadata | RecipientMetadata[] | null;
  ccEmails?: string | string[] | null;
};

/** The Metadata API reads up to 10 components per call. */
const BATCH = 10;

/** The Metadata API returns a list of one as the item itself. */
const list = <T>(value: T | T[] | undefined | null): T[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

/** Recipient types that send to a field of the record, which is empty unless the test fills it. */
const RECORD_TYPES = new Set(['email', 'userLookup', 'contactLookup']);

function toRecipients(alert: AlertMetadata): AlertRecipients {
  const recipients = list(alert.recipients);
  const fields = (type: string) => recipients.flatMap((r) => (r.type === type && r.field ? [r.field] : []));
  return {
    emailFields: fields('email'),
    userLookups: fields('userLookup'),
    hasFixedRecipient:
      recipients.some((r) => r.type !== undefined && !RECORD_TYPES.has(r.type)) || list(alert.ccEmails).length > 0,
  };
}

/** Reads email alert recipients through the Metadata API, ten alerts per call. */
export function emailAlertReader(read: MetadataRead): ReadEmailAlerts {
  return async (fullNames) => {
    const alerts: Record<string, AlertRecipients> = {};
    for (let i = 0; i < fullNames.length; i += BATCH) {
      const batch = fullNames.slice(i, i + BATCH);
      let result: unknown;
      try {
        result = await read('WorkflowAlert', batch);
      } catch {
        continue;
      }
      // An alert that doesn't exist comes back as an empty record, without a fullName.
      for (const alert of list(result as AlertMetadata | AlertMetadata[])) {
        if (alert?.fullName && batch.includes(alert.fullName)) alerts[alert.fullName] = toRecipients(alert);
      }
    }
    return alerts;
  };
}
