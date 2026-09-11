import { contentHash } from "./model-audit";
import { duplicateJsonKeys } from "./json-duplicate-keys";

export const TERMINAL_ROOT_CLOSER_RECOVERY = "terminal-root-closer-v1" as const;

/** Interpret exactly one redundant terminal root closer; never salvage a
 * descendant or change the complete root's data or internal structure. */
export function recoverTerminalRootCloser(source: string) {
  const opening = source[source.search(/\S/u)];
  if (opening !== "{" && opening !== "[") return null;
  const offset = source.trimEnd().length - 1;
  const character = source[offset];
  if (character !== (opening === "{" ? "}" : "]")) return null;
  const text = source.slice(0, offset) + source.slice(offset + 1);
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (duplicateJsonKeys(text)) return null;
  return { policy: TERMINAL_ROOT_CLOSER_RECOVERY, value, text,
    removed: [{ offset, character: character as "}" | "]" }],
    sourceHash: contentHash(source), recoveredTextHash: contentHash(text) };
}
