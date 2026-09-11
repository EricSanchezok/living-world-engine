import { contentHash } from "./model-audit";
import { duplicateJsonKeys } from "./json-duplicate-keys";

export const UNMATCHED_CLOSER_RECOVERY = "unmatched-closers-v1" as const;
const MAX_DELETIONS = 128;

/** Experimental interpretation only. Never changes a string, opener, valid
 * closer, separator or value, and never salvages a nested or partial root. */
export function recoverUnmatchedClosers(source: string) {
  const first = source.search(/\S/u);
  if (first < 0 || (source[first] !== "{" && source[first] !== "[")) return null;
  const expected: string[] = [];
  // Offsets index the original JavaScript string (UTF-16 code units).
  const removed: Array<{ offset: number; character: "}" | "]" }> = [];
  const pieces: string[] = [];
  let inString = false, escaped = false, complete = false, retainedStart = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (complete) { if (!/\s/u.test(character)) return null; continue; }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") expected.push(character === "{" ? "}" : "]");
    else if (character === "}" || character === "]") {
      if (!expected.length) return null;
      if (expected.at(-1) !== character) {
        removed.push({ offset: index, character });
        if (removed.length > MAX_DELETIONS) return null;
        pieces.push(source.slice(retainedStart, index)); retainedStart = index + 1;
      } else {
        expected.pop();
        if (!expected.length) complete = true;
      }
    }
  }
  if (!complete || inString || expected.length || !removed.length) return null;
  const text = pieces.join("") + source.slice(retainedStart);
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (duplicateJsonKeys(text)) return null;
  return { policy: UNMATCHED_CLOSER_RECOVERY, value, text, removed,
    sourceHash: contentHash(source), recoveredTextHash: contentHash(text) };
}
