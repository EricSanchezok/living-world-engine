import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Experiment evidence is append-only; replacing different evidence is drift. */
export function immutableExperimentJson(file: string, value: unknown): void {
  immutableExperimentText(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function immutableExperimentText(file: string, text: string): void {
  if (existsSync(file)) {
    if (readFileSync(file, "utf8") !== text) throw new Error(`immutable experiment artifact drift: ${file}`);
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const stage = `${file}.${randomUUID()}.tmp`;
  writeFileSync(stage, text, { encoding: "utf8", flag: "wx", flush: true });
  renameSync(stage, file);
}

/** One live writer per local experiment. A dead owner's lock is preserved as
 * evidence; unsettled budget reservations independently block resuming sends. */
export function lockExperiment(root: string): () => void {
  mkdirSync(root, { recursive: true });
  const file = path.join(root, "writer.lock.json");
  if (existsSync(file)) {
    const previous = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
    if (!Number.isSafeInteger(previous.pid) || Number(previous.pid) <= 0) throw new Error("invalid experiment writer lock");
    let alive = true;
    try { process.kill(Number(previous.pid), 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw error; }
    if (alive) throw new Error(`experiment is already owned by process ${previous.pid}`);
    renameSync(file, path.join(root, `abandoned-writer-${randomUUID()}.json`));
  }
  const owner = { pid: process.pid, nonce: randomUUID(), acquiredAt: new Date().toISOString() };
  const text = `${JSON.stringify(owner)}\n`;
  writeFileSync(file, text, { encoding: "utf8", flag: "wx", flush: true });
  return () => {
    if (readFileSync(file, "utf8") !== text) throw new Error("experiment writer lock ownership changed");
    unlinkSync(file);
  };
}
