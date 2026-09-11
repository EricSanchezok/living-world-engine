import type { z } from "zod";

type Path = Array<string | number>;
type Constraint = { path: Path; options: string[] };
type Issue = { code: string; path: PropertyKey[]; message: string; errors?: Issue[][]; options?: unknown[] };
type AlternativeFailure = { anyOf: Array<{ allOf: AlternativeFailure[] }> } | { path: Path; code: string; message: string };
const publicPath = (path: PropertyKey[]): Path => path.map(part => typeof part === "symbol" ? part.description ?? "symbol" : part);

/** Keep only discriminator failures necessary in every union alternative.
 * Within one alternative constraints intersect; across alternatives they union.
 * No branch is selected and no candidate value is corrected. */
function necessaryDiscriminators(issue: Issue, prefix: Path): Map<string, Constraint> {
  const path = [...prefix, ...publicPath(issue.path)];
  if (issue.code !== "invalid_union") return new Map();
  if (!issue.errors?.length) {
    return issue.options?.length && issue.options.every(value => typeof value === "string")
      ? new Map([[JSON.stringify(path), { path, options: issue.options as string[] }]]) : new Map();
  }
  const branches = issue.errors.map(issues => {
    const constraints = new Map<string, Constraint>();
    for (const child of issues) for (const [key, value] of necessaryDiscriminators(child, path)) {
      const prior = constraints.get(key);
      constraints.set(key, prior ? { path: value.path, options: value.options.filter(option => prior.options.includes(option)) } : value);
    }
    return constraints;
  });
  const common = new Map<string, Constraint>();
  for (const [key, value] of branches[0]!) {
    if (branches.every(branch => branch.has(key))) common.set(key, { path: value.path,
      options: [...new Set(branches.flatMap(branch => branch.get(key)!.options))].sort() });
  }
  return common;
}

function valueAt(value: unknown, path: Path): { originalValue?: unknown } {
  for (const part of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return {};
    value = (value as Record<string | number, unknown>)[part];
  }
  return value === undefined ? {} : { originalValue: structuredClone(value) };
}

/** Retain AND/OR grouping when different choices require different repairs.
 * These are reported failures, not sufficient conditions for acceptance. */
function alternativeFailures(issue: Issue, prefix: Path): AlternativeFailure {
  const path = [...prefix, ...publicPath(issue.path)];
  if (issue.code === "invalid_union" && issue.errors?.length) return {
    anyOf: issue.errors.map(branch => ({ allOf: branch.map(child => alternativeFailures(child, path)) })),
  };
  return { path, code: issue.code, message: issue.code === "invalid_union" && issue.options?.length
    ? `Discriminator must be one of ${issue.options.map(value => JSON.stringify(value)).join(", ")}.` : issue.message };
}

/** Preserve each original issue, then expose provable common nested failures. */
export function schemaValidationIssues(error: z.ZodError, rawValue?: unknown) {
  return error.issues.flatMap(original => {
    const issue = original as Issue;
    const path = publicPath(issue.path);
    const result = [{ code: issue.code, path, message: issue.message, ...valueAt(rawValue, path) }];
    if (issue.code === "invalid_union" && issue.errors?.length) {
      const constraints = [...necessaryDiscriminators(issue, []).values()].filter(value => value.options.length);
      for (const constraint of constraints) {
        if (!constraint.options.length) continue;
        result.push({ code: "invalid_union_discriminator", path: constraint.path,
          message: `Every schema alternative requires this discriminator to be one of ${constraint.options.map(value => JSON.stringify(value)).join(", ")}.`,
          ...valueAt(rawValue, constraint.path) });
      }
      if (!constraints.length) result.push({ code: "invalid_union_alternatives", path,
        message: "Alternative-specific validation failures are grouped below. Preserve the intended meaning and resolve the reported failures of an applicable alternative: anyOf means alternatives, allOf means failures within that alternative. Full validation still applies; satisfying a listed failure can expose further checks. No alternative is selected automatically. " + JSON.stringify(alternativeFailures(issue, [])) });
    }
    return result;
  });
}
