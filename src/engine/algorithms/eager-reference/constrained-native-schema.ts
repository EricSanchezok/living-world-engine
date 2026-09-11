/** Lower only provably disjoint tagged oneOf unions to the provider-supported anyOf. */
export function constrainedNativeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit);
    if (!input || typeof input !== "object") return input;
    const node = input as Record<string, unknown>;
    const result = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, visit(value)]));
    if (Array.isArray(node.oneOf)) {
      const branches = node.oneOf as Array<{ type?: string; required?: string[]; properties?: Record<string, { const?: unknown }> }>;
      const discriminator = Object.keys(branches[0]?.properties ?? {}).find((key) => {
        const values = branches.map((branch) => branch.properties?.[key]?.const);
        return branches.every((branch) => branch.type === "object" && branch.required?.includes(key)) &&
          values.every((value) => typeof value === "string") && new Set(values).size === branches.length;
      });
      if (!discriminator || node.anyOf) throw new Error("native schema lowering requires disjoint required literal tags");
      result.anyOf = result.oneOf;
      delete result.oneOf;
    }
    if (Array.isArray(result.anyOf)) {
      // DeepSeek's union parser requires concrete branches: flatten pure nested
      // unions and inline scalar enum references only at that boundary.
      result.anyOf = result.anyOf.flatMap((branch: Record<string, unknown>) => {
        if (Object.keys(branch).length === 1 && Array.isArray(branch.anyOf)) return branch.anyOf;
        if (Object.keys(branch).length === 1 && typeof branch.$ref === "string" && branch.$ref.startsWith("#/definitions/")) {
          const target = (schema.definitions as Record<string, Record<string, unknown>> | undefined)?.[branch.$ref.slice("#/definitions/".length)];
          if (target?.type === "string" && Array.isArray(target.enum)) return [structuredClone(target)];
        }
        return [branch];
      });
    }
    return result;
  };
  return visit(schema) as Record<string, unknown>;
}
