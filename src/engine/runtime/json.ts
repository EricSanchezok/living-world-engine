export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = Readonly<{ [key: string]: JsonValue }>;

export function assertJsonValue(value: unknown, label: string, seen = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite JSON numbers`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${label} must be JSON-safe`);
  if (seen.has(value)) throw new Error(`${label} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    const allowedKeys = new Set<PropertyKey>([
      "length",
      ...Array.from({ length: value.length }, (_, index) => String(index)),
    ]);
    for (const key of Reflect.ownKeys(value)) {
      if (!allowedKeys.has(key)) throw new Error(`${label} must not contain non-JSON array properties`);
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new Error(`${label} must not contain sparse arrays`);
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) throw new Error(`${label}[${index}] must be a data property`);
      assertJsonValue(descriptor.value, `${label}[${index}]`, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must contain only plain objects`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new Error(`${label} must not contain symbol keys`);
      if (!key.trim()) throw new Error(`${label} keys must be non-empty`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error(`${label}.${key} must be an enumerable data property`);
      }
      assertJsonValue(descriptor.value, `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
}

export function assertJsonObject(value: unknown, label: string): asserts value is JsonObject {
  assertJsonValue(value, label);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

export function frozenClone<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (entry: unknown): void => {
    if (!entry || typeof entry !== "object" || Object.isFrozen(entry)) return;
    for (const child of Object.values(entry)) freeze(child);
    Object.freeze(entry);
  };
  freeze(clone);
  return clone;
}

export function assertExactKeys(value: object, required: readonly string[], optional: readonly string[] = [], label = "object"): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.has(key))) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}
