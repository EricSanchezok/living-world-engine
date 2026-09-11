import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";

type Value = Record<string, unknown>;
export interface FactorProductChoice { factorType: string; fields: Value }
export type FactorProductDomain = ReadonlyMap<string, FactorProductChoice>;
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new ModelConfigurationError(`factor choice products: ${message}`); };
const instruction = loadPromptAsset("shared/factor-choice-products.md");
export const FACTOR_CHOICE_PRODUCTS = `complete-finite-factor-choices-v1@${contentHash(instruction).slice(0, 16)}`;

function finite(schema: unknown): Array<string | number> {
  if (!object(schema)) return fail("missing finite field schema");
  if (typeof schema.const === "string" || typeof schema.const === "number") return [schema.const];
  if (Array.isArray(schema.enum) && schema.enum.length && schema.enum.every(v => typeof v === "string" || typeof v === "number")) return schema.enum;
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union) && union.length) return [...new Set(union.flatMap(finite))];
  return fail("factor field is not a complete finite domain");
}

/** Enumerate the existing product without removing any semantic or magnitude choice. */
export function factorProductSchema(source: Record<string, unknown>) {
  const schema = structuredClone(source), domain = new Map<string, FactorProductChoice>();
  let branches = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!object(node)) return;
    const fields = node.properties;
    if (object(fields) && object(fields.factorType) && typeof fields.factorType.const === "string") {
      if (!Array.isArray(node.required) || !node.required.includes("factorType")) return fail("factor type is not required");
      const base = fields.factorType.const, axes = ["direction", "steps"].filter(key => Object.hasOwn(fields, key));
      let products: Array<{ suffix: Array<string | number>; fields: Value }> = [{ suffix: [], fields: {} }];
      for (const axis of axes) {
        if (!node.required.includes(axis)) return fail("optional factor axis cannot be silently completed");
        products = products.flatMap(product => finite(fields[axis]).map(value => ({
          suffix: [...product.suffix, value], fields: { ...product.fields, [axis]: value },
        })));
      }
      const choices = products.map(product => {
        const key = [base, ...product.suffix].join(":"), choice = { factorType: base, fields: product.fields };
        if (domain.has(key) && contentHash(domain.get(key)) !== contentHash(choice)) return fail("ambiguous factor product key");
        domain.set(key, choice);
        return key;
      });
      node.properties = { factorType: choices.length === 1 ? { type: "string", const: choices[0] } : { type: "string", enum: choices },
        ...Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "factorType" && !axes.includes(key))) };
      node.required = ["factorType", ...node.required.filter(key => key !== "factorType" && !axes.includes(String(key)))];
      branches++;
      return;
    }
    Object.values(node).forEach(visit);
  };
  visit(schema);
  if (!branches) return fail("no source factor alternatives");
  return { schema, domain };
}

function mapFactors(raw: unknown, transform: (factor: Value) => Value): unknown {
  const value = structuredClone(raw);
  const visit = (node: unknown): void => {
    if (!object(node)) return;
    if (Array.isArray(node.slots)) for (const slot of node.slots) if (object(slot)) visit(slot.result);
    if (node.kind === "commit_plans" && Array.isArray(node.plans)) for (const plan of node.plans) {
      if (object(plan) && Array.isArray(plan.factors)) plan.factors = plan.factors.map(factor => object(factor) ? transform(factor) : factor);
    }
  };
  visit(value);
  return value;
}

export function encodeFactorProducts(raw: unknown, domain: FactorProductDomain): unknown {
  return mapFactors(raw, factor => {
    const match = [...domain].filter(([, choice]) => choice.factorType === factor.factorType &&
      Object.entries(choice.fields).every(([key, value]) => Object.hasOwn(factor, key) && factor[key] === value));
    if (match.length !== 1) return fail("source factor lacks a complete explicit choice");
    const [key, choice] = match[0]!;
    return { factorType: key, ...Object.fromEntries(Object.entries(factor)
      .filter(([field]) => field !== "factorType" && !Object.hasOwn(choice.fields, field))) };
  });
}

export function decodeFactorProducts(raw: unknown, domain: FactorProductDomain): unknown {
  return mapFactors(raw, factor => {
    const choice = typeof factor.factorType === "string" ? domain.get(factor.factorType) : undefined;
    if (!choice || ["direction", "steps"].some(key => Object.hasOwn(factor, key))) {
      return { ...factor, invalidFactorProduct: { rejectedChoice: factor.factorType ?? null } };
    }
    return { ...factor, factorType: choice.factorType, ...structuredClone(choice.fields) };
  });
}

export function factorChoiceProductsRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || request.schemaName !== "truth_resolution_plan_commit_batch") return request;
  if (request.promptVersion.includes(FACTOR_CHOICE_PRODUCTS)) return fail("already applied");
  const { schema, domain } = factorProductSchema(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
  const system = [request.system, instruction].join("\n\n");
  return { ...request, system, wireJsonSchema: schema,
    promptVersion: `${request.promptVersion}/${FACTOR_CHOICE_PRODUCTS}@${contentHash([...domain]).slice(0, 16)}`,
    preprocessOutput: raw => {
      const value = decodeFactorProducts(raw, domain);
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    } };
}
