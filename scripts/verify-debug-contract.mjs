#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const REQUIRED_FILES = [
  "src/shared/debug-api.ts",
  "src/server/debug-diagnostics.ts",
  "src/server/request-context.ts",
  "scripts/operations/debug-command.ts",
  ".agents/skills/debugging/SKILL.md",
  "docs/debugging.md",
  "src/app/api/debug/route.ts",
  "src/app/api/debug/doctor/route.ts",
];

const REQUIRED_SCRIPTS = ["debug", "debug:doctor"];

export async function verifyDebugContract(repoRoot) {
  const errors = [];
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  for (const script of REQUIRED_SCRIPTS) {
    if (!packageJson.scripts?.[script]) errors.push(`package.json is missing ${script} script`);
  }
  for (const relative of REQUIRED_FILES) {
    try { await access(path.join(repoRoot, relative)); }
    catch { errors.push(`required debug file is missing: ${relative}`); }
  }
  const debugApi = await readFile(path.join(repoRoot, "src/shared/debug-api.ts"), "utf8");
  if (!/DEBUG_API_VERSION\s*=\s*1/u.test(debugApi)) errors.push("debug API version 1 is not declared");
  if (!/DEBUG_INDEX_VERSION\s*=\s*1/u.test(debugApi)) errors.push("debug index version 1 is not declared");
  const database = await readFile(path.join(repoRoot, "src/server/local-database.ts"), "utf8");
  for (const table of ["execution_event_index", "execution_issue_index", "execution_invocation_index", "debug_index_meta"]) {
    if (!database.includes(`CREATE TABLE ${table}`)) errors.push(`local database does not create ${table}`);
  }
  if (!/schema_migrations\(version, applied_at\).*9/u.test(database.replaceAll("\n", " "))) {
    errors.push("local database does not record schema v9");
  }
  const docs = await readFile(path.join(repoRoot, "docs/debugging.md"), "utf8");
  if (!docs.includes("npm run debug -- find")) errors.push("debugging reference has no find example");
  if (!docs.includes("debug:doctor")) errors.push("debugging reference has no doctor example");
  const skill = await readFile(path.join(repoRoot, ".agents/skills/debugging/SKILL.md"), "utf8");
  for (const command of ["debug:doctor", "debug -- find", "debug -- lineage", "check:fast"]) {
    if (!skill.includes(command)) errors.push(`debugging skill is missing ${command} guidance`);
  }
  return { errors };
}

async function main() {
  const repoRoot = path.resolve(process.argv[2] ?? ".");
  const { errors } = await verifyDebugContract(repoRoot);
  if (errors.length > 0) {
    for (const error of errors) console.error(`verify-debug-contract: ${error}`);
    process.exit(1);
  }
  console.log("verify-debug-contract: OK");
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((error) => { console.error(`verify-debug-contract: fatal ${error.message}`); process.exit(2); });
