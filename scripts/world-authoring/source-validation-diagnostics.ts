import { z } from "zod";

/** Point repairs at the rejected value; the complete allowed source IDs remain in context. */
export function sourceValidationDiagnostics(error: unknown, draft: unknown): string {
  if (!(error instanceof z.ZodError)) return error instanceof Error ? error.message : String(error);
  return JSON.stringify(error.issues.map(issue => {
    let received = draft;
    for (const key of issue.path) {
      received = received !== null && typeof received === "object" ? Reflect.get(received, key) : undefined;
    }
    const encoded = received === undefined ? "<missing>" : JSON.stringify(received);
    return {
      path: issue.path.map(String).join("."), code: issue.code,
      received: encoded.length > 512 ? `${encoded.slice(0, 512)}…` : encoded,
      message: issue.code === "invalid_value"
        ? "Value is not permitted here. Use the complete source paragraphs and review manifest to select the correct value; do not invent or approximate an ID."
        : issue.message,
      ...(issue.code === "invalid_value" ? { allowedValueCount: issue.values.length } : {}),
    };
  }));
}
