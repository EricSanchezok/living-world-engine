import { contentHash } from "./model-audit";

export const UNMATCHED_CLOSER_RECOVERY = "unmatched-closers-v1" as const;
const MAX_DELETIONS = 128;

/** Input is already strict JSON. Decode key spellings so escaped duplicates
 * cannot silently overwrite earlier evidence during JSON.parse. */
function duplicateKeys(text: string): boolean {
  const containers: Array<Set<string> | null> = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "{") containers.push(new Set());
    else if (character === "[") containers.push(null);
    else if (character === "}" || character === "]") containers.pop();
    else if (character === '"') {
      const start = index++;
      while (index < text.length) {
        if (text[index] === "\\") index += 2;
        else if (text[index] === '"') break;
        else index++;
      }
      let next = index + 1;
      while (/\s/u.test(text[next] ?? "") && next < text.length) next++;
      if (text[next] === ":") {
        const keys = containers.at(-1);
        if (!keys) return true;
        const key: string = JSON.parse(text.slice(start, index + 1));
        if (keys.has(key)) return true;
        keys.add(key);
      }
    }
  }
  return false;
}

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
  if (duplicateKeys(text)) return null;
  return { policy: UNMATCHED_CLOSER_RECOVERY, value, text, removed,
    sourceHash: contentHash(source), recoveredTextHash: contentHash(text) };
}
