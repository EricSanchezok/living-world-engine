const chineseDigit = new Map([
  ["零", 0], ["〇", 0], ["一", 1], ["二", 2], ["两", 2], ["三", 3], ["四", 4],
  ["五", 5], ["六", 6], ["七", 7], ["八", 8], ["九", 9],
]);
const chineseUnit = new Map([["十", 10], ["百", 100], ["千", 1_000]]);
const smallWords = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
  "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const tens = new Map([["twenty", 20], ["thirty", 30], ["forty", 40], ["fifty", 50], ["sixty", 60], ["seventy", 70], ["eighty", 80], ["ninety", 90]]);
const scales = new Map([["thousand", 1_000], ["million", 1_000_000], ["billion", 1_000_000_000]]);
const numberWords = new Set([...smallWords, ...tens.keys(), ...scales.keys(), "hundred", "point"]);

function underHundred(words: string[]): number | null {
  if (words.length === 1 && smallWords.includes(words[0]!)) return smallWords.indexOf(words[0]!);
  const decade = tens.get(words[0]!);
  if (decade !== undefined && words.length === 1) return decade;
  const unit = smallWords.indexOf(words[1]!);
  return decade !== undefined && words.length === 2 && unit > 0 && unit < 10 ? decade + unit : null;
}
function underThousand(words: string[]): number | null {
  if (words[1] !== "hundred") return underHundred(words);
  const hundreds = smallWords.indexOf(words[0]!);
  if (hundreds < 1 || hundreds > 9) return null;
  if (words.length === 2) return hundreds * 100;
  const remainder = underHundred(words.slice(words[2] === "and" ? 3 : 2));
  return remainder !== null && remainder > 0 ? hundreds * 100 + remainder : null;
}
function englishInteger(words: string[]): number | null {
  let total = 0, lastScale = Infinity, from = 0;
  for (let i = 0; i < words.length; i++) {
    const scale = scales.get(words[i]!); if (!scale) continue;
    const group = underThousand(words.slice(from, i));
    if (scale >= lastScale || group === null || group <= 0) return null;
    total += group * scale; lastScale = scale; from = i + 1;
  }
  if (from === words.length) return total;
  const tail = words.slice(from);
  if (total > 0 && tail[0] === "and") tail.shift();
  const group = underThousand(tail);
  return group === null || total > 0 && group === 0 ? null : total + group;
}

/** A finite grammar binds model-selected amounts to actual written numbers. */
export function parseExplicitNumber(text: string): number | null {
  if (/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(text)) return Number(text);
  if (/^[a-z]+(?:[ -][a-z]+)*$/iu.test(text)) {
    const words = text.toLowerCase().split(/[ -]/u), point = words.indexOf("point");
    if (point < 0) return englishInteger(words);
    const integer = englishInteger(words.slice(0, point)), decimal = words.slice(point + 1);
    if (integer === null || !decimal.length || decimal.some(word => smallWords.indexOf(word) < 0 || smallWords.indexOf(word) > 9)) return null;
    return Number(`${integer}.${decimal.map(word => smallWords.indexOf(word)).join("")}`);
  }
  if (!text.length || ![...text].every(character => chineseDigit.has(character) || chineseUnit.has(character))) return null;
  if (![...text].some(character => chineseUnit.has(character))) return Number([...text].map(character => chineseDigit.get(character)!).join(""));
  let total = 0, current = 0;
  for (const character of text) {
    const digit = chineseDigit.get(character);
    if (digit !== undefined) { current = digit; continue; }
    total += (current || 1) * chineseUnit.get(character)!; current = 0;
  }
  return total + current;
}

export function containsStandaloneExplicitNumber(source: string, quoted: string): boolean {
  if (!quoted.length) return false;
  const wordQuote = /^[a-z]/iu.test(quoted), numericCharacter = /[0-9.+\-零〇一二两三四五六七八九十百千万亿]/u;
  let offset = source.indexOf(quoted);
  while (offset >= 0) {
    const prefix = source.slice(0, offset), suffix = source.slice(offset + quoted.length);
    const before = prefix.at(-1) ?? "", after = suffix[0] ?? "";
    const priorWord = prefix.match(/([a-z]+)(?:\s+and)?[\s-]+$/iu)?.[1]?.toLowerCase();
    const nextWord = suffix.match(/^[\s-]+(?:and\s+)?([a-z]+)/iu)?.[1]?.toLowerCase();
    if (!numericCharacter.test(before) && !numericCharacter.test(after) && !/[a-z_]/iu.test(before) && (!wordQuote ||
      !/[a-z0-9_'-]/iu.test(before) && !/[a-z0-9_'-]/iu.test(after) &&
      !numberWords.has(priorWord ?? "") && !numberWords.has(nextWord ?? ""))) return true;
    offset = source.indexOf(quoted, offset + 1);
  }
  return false;
}
