/** Remove one complete Markdown document wrapper, never text within its body.
 * Keep the body's final newline: YAML block scalars may give it meaning. */
export function unwrapExperimentDocument(text: string): { text: string; recovery: "strict" | "wrapper" } {
  const source = text.replace(/^\uFEFF/u, "");
  const fence = /^\x60{3}(?:json|yaml|yml)?[ \t]*\r?\n([\s\S]*\r?\n)\x60{3}$/iu.exec(source.trim());
  return fence ? { text: fence[1]!, recovery: "wrapper" } : { text: source, recovery: "strict" };
}
