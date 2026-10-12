import type { JsonValue } from "../runtime/json";
import type { ProgramDefinition, ValueExpression } from "./definition";

const absent = Symbol("absent-program-data");
type ShapeValue = JsonValue | typeof absent;

/** Reject structural mistakes while retaining genuine null or not-yet-present array data. */
export function validateProgramReadShapes(definition: ProgramDefinition, parameters: Record<string, JsonValue>,
  resources: Record<string, JsonValue>): void {
  const inspect = (expression: ValueExpression): ShapeValue => {
    if (expression.kind === "literal") return expression.value;
    if (expression.kind === "parameter") {
      if (!Object.hasOwn(parameters, expression.name)) throw new Error("missing program parameter " + expression.name);
      return parameters[expression.name]!;
    }
    if (expression.kind === "read") {
      if (!Object.hasOwn(resources, expression.resource)) throw new Error("missing program resource " + expression.resource);
      let value = resources[expression.resource]!;
      for (const [index, key] of expression.path.entries()) {
        if (value === null) return absent;
        const address = expression.resource + "." + expression.path.slice(0, index + 1).join(".");
        if (Array.isArray(value)) {
          if (key === "length") { value = value.length; continue; }
          if (!/^(0|[1-9]\d*)$/u.test(key)) throw new Error("invalid array read " + address + ": use a numeric index; parameter names do not address array members");
          const offset = Number(key);
          if (!Number.isSafeInteger(offset) || offset >= value.length) return absent;
          value = value[offset]!;
        } else if (typeof value !== "object") {
          throw new Error("invalid scalar read " + address + ": this value is " + typeof value + "; read the scalar with its existing path");
        } else if (!Object.hasOwn(value, key)) {
          // Open character dictionaries may acquire records later; fixed view objects cannot acquire arbitrary fields.
          if (index === 0 && ["traits", "values", "emotions", "attitudes", "goals", "commitments"].includes(expression.resource)) return absent;
          throw new Error("invalid object read " + address + "; available fields: " + Object.keys(value).sort().join(", "));
        } else value = (value as Readonly<Record<string, JsonValue>>)[key]!;
      }
      return value;
    }
    const values = expression.values.map(inspect);
    if (values.some(value => value === absent || value === null)) return absent;
    if (values.some(value => typeof value !== "number")) throw new Error("program arithmetic reads a nonnumeric value");
    // Division by zero can depend on future data; shape validation does not invent a result.
    return 0;
  };
  for (const predicate of definition.predicates) if (predicate.test.kind === "mechanical") {
    try {
      const left = inspect(predicate.test.left), right = inspect(predicate.test.right);
      if (["lt", "lte", "gt", "gte"].includes(predicate.test.operator) &&
        [left, right].some(value => value !== absent && value !== null && typeof value !== "number")) {
        throw new Error("ordered comparison requires numeric operands");
      }
    } catch (error) {
      throw new Error("Program condition " + predicate.id + " (" + predicate.description + "): " +
        (error instanceof Error ? error.message : String(error)));
    }
  }
}
