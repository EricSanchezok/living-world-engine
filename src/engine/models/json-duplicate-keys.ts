/** Input is already strict JSON. Decode key spellings so escaped duplicates
 * cannot silently overwrite earlier evidence during JSON.parse. */
export function duplicateJsonKeys(text: string): boolean {
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
