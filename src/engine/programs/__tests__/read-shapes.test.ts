import { describe, expect, it } from "vitest";
import { programFixture } from "../../testing/program";
import type { JsonValue } from "../../runtime/json";
import { validateProgramReadShapes } from "../read-shapes";

function check(value: JsonValue, path: string[]) {
  const fixture = programFixture();
  fixture.definition.predicates = [{ ...fixture.definition.predicates[0]!, test: { kind: "mechanical", operator: "gte",
    left: { kind: "read", resource: "inventory", path }, right: { kind: "literal", value: 1 } } }];
  return () => validateProgramReadShapes(fixture.definition, fixture.parameters, { inventory: value });
}

describe("private mechanical read shapes", () => {
  it("rejects invented array and scalar fields before the model program enters execution", () => {
    expect(check({ quantities: [{ amount: 2 }] }, ["quantities", "sealCount", "amount"])).toThrow("invalid array read");
    expect(check(0, ["elapsedSeconds"])).toThrow("invalid scalar read");
    expect(check({ amount: 2 }, ["quantity"])).toThrow("available fields: amount");
    expect(check({ amount: "two" }, ["amount"])).toThrow("numeric operands");
  });
  it("keeps genuine absence unknown while allowing existing numeric data and array cardinality", () => {
    expect(check({ quantities: [] }, ["quantities", "0", "amount"])).not.toThrow();
    expect(check(null, ["amount"])).not.toThrow();
    expect(check({ quantities: [{ amount: 2 }] }, ["quantities", "0", "amount"])).not.toThrow();
    expect(check({ quantities: [] }, ["quantities", "length"])).not.toThrow();
  });
});
