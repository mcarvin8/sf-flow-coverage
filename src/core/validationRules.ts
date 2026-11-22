import type { ToolingQuery } from './types.js';

/** An active validation rule: its name, error condition formula, and message. */
export type ValidationRule = { name: string; formula: string; message?: string };

/** Reads the active validation rules of an object. Empty when they can't be read. */
export type ReadValidationRules = (object: string) => Promise<ValidationRule[]>;

const quote = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

type RuleRecord = { Id: string; ValidationName: string; ErrorMessage?: string | null };

/**
 * Reads validation rules through the Tooling API. The error condition formula is only in a
 * rule's `Metadata`, which the Tooling API returns one row at a time, so each rule takes a query.
 */
export function validationRuleReader(query: ToolingQuery): ReadValidationRules {
  return async (object) => {
    let rules: RuleRecord[];
    try {
      rules = await query<RuleRecord>(
        `SELECT Id, ValidationName, ErrorMessage FROM ValidationRule WHERE Active = true AND EntityDefinition.QualifiedApiName = ${quote(object)}`,
      );
    } catch {
      return [];
    }
    const result: ValidationRule[] = [];
    for (const rule of rules) {
      try {
        const [record] = await query<{ Metadata?: { errorConditionFormula?: string | null } }>(
          `SELECT Metadata FROM ValidationRule WHERE Id = ${quote(rule.Id)}`,
        );
        const formula = record?.Metadata?.errorConditionFormula;
        if (formula) result.push({ name: rule.ValidationName, formula, message: rule.ErrorMessage ?? undefined });
      } catch {
        // A rule whose formula can't be read is left out.
      }
    }
    return result;
  };
}
