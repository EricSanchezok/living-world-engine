import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.each(["deepseek-sse", "deepseek-json", "typesafe"])("owns the %s deadline through GC, cancellation and complete HTTP settlement", async kind => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", "--import", "tsx",
    path.resolve("src/engine/models/__tests__/fixtures/model-deadline-probe.ts"), kind], { cwd: process.cwd(), timeout: 20_000 });
  const report = JSON.parse(stdout.trim());
  expect(report.results).toHaveLength(3);
  expect(report.results.every((result: { active: number; queued: number; sends: number }) =>
    result.active === 0 && result.queued === 0 && result.sends === 2)).toBe(true);
}, 25_000);
