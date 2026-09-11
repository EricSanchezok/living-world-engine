#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const root = process.cwd();
const failures = [];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(target));
    else if (/\.(?:ts|tsx)$/u.test(entry.name) && !/(?:\.test\.|__tests__)/u.test(target)) files.push(target);
  }
  return files;
}

for (const area of ["runtime", "mechanics", "cognition"]) {
  const directory = path.join(root, "src", "engine", area);
  for (const file of await sourceFiles(directory)) {
    const source = await readFile(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (specifier.includes("algorithms/eager-reference") || specifier.includes("../algorithms/registry")) {
        failures.push(`${path.relative(root, file)} imports concrete algorithm code: ${specifier}`);
      }
    }
  }
}

const roleContractsPath = path.join(root, "src/engine/algorithms/roles.ts");
const roleContractsSource = await readFile(roleContractsPath, "utf8");
const roleContractsAst = ts.createSourceFile(roleContractsPath, roleContractsSource, ts.ScriptTarget.Latest, true);
for (const statement of roleContractsAst.statements) {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
  const specifier = statement.moduleSpecifier.text;
  if (specifier.includes("eager-reference")) {
    failures.push(`src/engine/algorithms/roles.ts imports concrete algorithm code: ${specifier}`);
  }
}

const registry = await readFile(path.join(root, "src/engine/algorithms/registry.ts"), "utf8");
for (const identity of [
  "eager-reference", "model-agent-cognition", "model-action-compilation", "full-catalog",
  "relational-rrf", "typed-channel-rrf", "coverage-aware-joint-budget",
  "bounded-symbol-repair", "model-interaction-grounding", "onset-reaction",
  "model-onset-perception", "model-reaction-decision", "model-truth-resolution",
  "model-observation-rendering", "bounded-slot-batching", "bounded-concurrency", "localized-repair-bisect",
]) {
  if (!registry.includes(`\"${identity}\"`)) failures.push(`built-in algorithm is not registered: ${identity}`);
}

const benchmarkCatalog = await readFile(path.join(root, "src/engine/benchmarks/action-compilation/retrievers/catalog.ts"), "utf8");
for (const family of [
  "ACTION_COMPILATION_RETRIEVER_STRATEGIES",
  "ADVANCED_ACTION_COMPILATION_RETRIEVER_STRATEGIES",
  "GRAPH_AWARE_CANDIDATE_SELECTION_STRATEGIES",
]) {
  if (!benchmarkCatalog.includes(family)) failures.push(`benchmark algorithm catalog is not derived from ${family}`);
}

const catalog = spawnSync(process.execPath, ["--import", "tsx", "scripts/operations/algorithm-command.ts", "catalog", "--check"], {
  cwd: root,
  encoding: "utf8",
});
if (catalog.status !== 0) failures.push((catalog.stderr || catalog.stdout).trim() || "algorithm catalog check failed");

if (failures.length > 0) {
  for (const failure of failures) console.error(`verify-algorithms: ${failure}`);
  process.exit(1);
}
console.log("verify-algorithms: OK");
