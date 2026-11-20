/** Helpers for reading values out of Flow metadata XML parsed by fast-xml-parser. */

export type XmlRecord = Record<string, unknown>;

/** A Flow value (`<value>` or `<rightValue>`) as an Apex literal, when it is one, and as raw text. */
export type FlowValue = {
  /** Apex literal for the value, when it can be expressed as one. */
  apexValue?: string;
  /** Raw value text, for TODO comments. */
  rawValue?: string;
};

export function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

export function asRecord(value: unknown): XmlRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as XmlRecord) : undefined;
}

export function asArray(value: unknown): XmlRecord[] {
  return Array.isArray(value) ? value.filter((v): v is XmlRecord => !!asRecord(v)) : [];
}

export function escapeApexString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n');
}

export function parseFlowValue(value: XmlRecord | undefined): FlowValue {
  if (!value) return {};
  const stringValue = text(value.stringValue);
  if (stringValue !== undefined) return { apexValue: `'${escapeApexString(stringValue)}'`, rawValue: stringValue };
  const booleanValue = text(value.booleanValue);
  if (booleanValue !== undefined)
    return { apexValue: booleanValue === 'true' ? 'true' : 'false', rawValue: booleanValue };
  const numberValue = text(value.numberValue);
  if (numberValue !== undefined && !Number.isNaN(Number(numberValue))) {
    return { apexValue: numberValue, rawValue: numberValue };
  }
  const dateValue = text(value.dateValue);
  if (dateValue !== undefined)
    return { apexValue: `Date.valueOf('${escapeApexString(dateValue)}')`, rawValue: dateValue };
  const dateTimeValue = text(value.dateTimeValue);
  const dateTime = dateTimeValue && /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(dateTimeValue);
  if (dateTime) return { apexValue: `Datetime.valueOfGmt('${dateTime[1]} ${dateTime[2]}')`, rawValue: dateTimeValue };
  const raw = text(value.elementReference) ?? text(value.formulaExpression) ?? dateTimeValue;
  return raw === undefined ? {} : { rawValue: raw };
}
