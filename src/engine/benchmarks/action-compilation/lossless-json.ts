/** Accept only a complete JSON value or a complete single Markdown fence.
 * No syntax repair, field insertion, nested salvage, or last-answer selection. */
export function parseLosslessExperimentJson(text: string): { value: unknown; recovery: "strict" | "wrapper" } {
  const source = text.replace(/^\uFEFF/u, "").trim();
  try { return { value: JSON.parse(source), recovery: "strict" }; }
  catch (original) {
    const fence = /^\x60{3}(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\x60{3}$/iu.exec(source);
    if (!fence) throw original;
    return { value: JSON.parse(fence[1]!), recovery: "wrapper" };
  }
}
