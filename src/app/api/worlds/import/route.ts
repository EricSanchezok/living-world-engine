import { WorldHost } from "../../../../server/world-host";
import { MAX_ARCHIVE_BYTES, publicWorldImportResult } from "../../../../server/world-import";
import { createHash } from "node:crypto";
import { json, observeHttpArchiveBody, observedRoute } from "../../h";

export async function POST(request: Request): Promise<Response> {
  return observedRoute(request, async (scope) => {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "zip file is required" }, 400);
    const replace = form.get("replace") === "true";
    const expectedWorldIdValue = form.get("expectedWorldId");
    const expectedWorldId = typeof expectedWorldIdValue === "string" && expectedWorldIdValue.trim()
      ? expectedWorldIdValue.trim()
      : undefined;
    let buffer: Buffer | undefined;
    if (scope.observe) {
      buffer = Buffer.from(await file.arrayBuffer());
      observeHttpArchiveBody(scope, {
        filename: file.name,
        size: file.size,
        hash: createHash("sha256").update(buffer).digest("hex"),
        replace,
        expectedWorldId,
      });
    }
    if (file.size > MAX_ARCHIVE_BYTES) return json({ error: "archive exceeds 50 MiB" }, 413);
    buffer ??= Buffer.from(await file.arrayBuffer());
    const result = WorldHost.get().importWorld(buffer, replace, expectedWorldId);
    return json(publicWorldImportResult(result), 201);
  });
}
