import type { TemporalProfileDefinition } from "./temporal";

export type ActionTemporalEvidence =
  | {
      key: string;
      kind: "duration";
      sourceText: string;
      start: number;
      end: number;
      amount: number;
      unit: string;
      seconds: number;
      compatibleProfileIds: string[];
    }
  | {
      key: string;
      kind: "quantity";
      sourceText: string;
      start: number;
      end: number;
      amount: number;
      unit: string;
      compatibleProfileIds: string[];
    };

const durationUnits: Array<{ unit: string; aliases: string[]; seconds: number }> = [
  { unit: "second", aliases: ["seconds", "second", "secs", "sec", "秒"], seconds: 1 },
  { unit: "minute", aliases: ["minutes", "minute", "mins", "min", "分钟", "分"], seconds: 60 },
  { unit: "hour", aliases: ["hours", "hour", "hrs", "hr", "小时", "时"], seconds: 3_600 },
  { unit: "day", aliases: ["days", "day", "天", "日"], seconds: 86_400 },
  { unit: "week", aliases: ["weeks", "week", "星期", "周"], seconds: 604_800 },
];

const numericSource = "([0-9]+(?:\\.[0-9]+)?|[零一二两三四五六七八九十半]{1,3})";

function chineseNumber(value: string): number | null {
  const direct: Record<string, number> = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5,
  };
  if (value in direct) return direct[value]!;
  if (/^十[一二三四五六七八九]$/u.test(value)) return 10 + direct[value[1]!]!;
  if (/^[二三四五六七八九]十$/u.test(value)) return direct[value[0]!]! * 10;
  if (/^[二三四五六七八九]十[一二三四五六七八九]$/u.test(value)) {
    return direct[value[0]!]! * 10 + direct[value[2]!]!;
  }
  return null;
}

function numericToken(value: string): number | null {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  return chineseNumber(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactQuantityMatches(
  text: string,
  aliases: readonly string[],
): Array<{ sourceText: string; start: number; end: number; amount: number; matchedAlias: string }> {
  const alternatives = [...new Set(aliases.map((alias) => alias.normalize("NFC")))]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|");
  if (!alternatives) return [];
  const pattern = new RegExp(`${numericSource}\\s*(${alternatives})`, "giu");
  const matches: Array<{ sourceText: string; start: number; end: number; amount: number; matchedAlias: string }> = [];
  for (const match of text.matchAll(pattern)) {
    const amount = numericToken(match[1]!);
    if (match.index === undefined || amount === null || amount <= 0 || !Number.isFinite(amount)) continue;
    matches.push({
      sourceText: match[0],
      start: match.index,
      end: match.index + match[0].length,
      amount,
      matchedAlias: match[2]!,
    });
  }
  return matches;
}

/** A stated upper bound is not an exact interval to commit as action duration.
 * This lexical exclusion does not establish whose work any remaining span describes. */
function isDurationUpperBound(text: string, start: number, end: number): boolean {
  const before = text.slice(0, start);
  const after = text.slice(end);
  return /^\s*(?:以内|内)/u.test(after) ||
    /(?:最多|至多|不超过|不多于)\s*$/u.test(before) ||
    /\b(?:within(?:\s+the\s+next)?|at\s+most|up\s+to|no\s+more\s+than|less\s+than)\s*$/iu.test(before);
}

/** Travel-time measures can locate a place without scheduling the current action. */
function isTravelDistance(text: string, end: number): boolean {
  const after = text.slice(end);
  return /^\s*(?:的\s*)?(?:路程|脚程|车程|航程)/u.test(after) ||
    /^\s*(?:['’]\s*)?(?:(?:of\s+)?(?:travel|journey|walk|ride|drive|flight|march)\s+(?:away\s+)?(?:from|to)\b|(?:away|distant)\s+from\b)/iu.test(after);
}

export function extractActionTemporalEvidence(
  text: string,
  profiles: Readonly<Record<string, TemporalProfileDefinition>>,
): ActionTemporalEvidence[] {
  const durationProfileIds = Object.values(profiles)
    .filter((profile) => profile.selection.evidenceRequirement === "explicit_duration")
    .map((profile) => profile.id)
    .sort();
  const evidence: ActionTemporalEvidence[] = durationUnits.flatMap((definition) =>
    exactQuantityMatches(text, definition.aliases).flatMap((match) => {
      if (isDurationUpperBound(text, match.start, match.end) || isTravelDistance(text, match.end)) return [];
      const seconds = match.amount * definition.seconds;
      return Number.isSafeInteger(seconds) && seconds > 0 ? [{
        key: `duration:${match.start}:${match.end}`,
        kind: "duration" as const,
        sourceText: match.sourceText,
        start: match.start,
        end: match.end,
        amount: match.amount,
        unit: definition.unit,
        seconds,
        compatibleProfileIds: durationProfileIds,
      }] : [];
    }));
  const quantityBySpan = new Map<string, Extract<ActionTemporalEvidence, { kind: "quantity" }>>();
  for (const profile of Object.values(profiles).filter((candidate) => candidate.kind === "rate")) {
    for (const match of exactQuantityMatches(text, [profile.unit, ...profile.unitAliases])) {
      const identity = `${match.start}:${match.end}:${profile.unit.normalize("NFC").toLocaleLowerCase("en")}`;
      const existing = quantityBySpan.get(identity);
      if (existing) {
        existing.compatibleProfileIds = [...new Set([...existing.compatibleProfileIds, profile.id])].sort();
        continue;
      }
      quantityBySpan.set(identity, {
        key: `quantity:${identity}`,
        kind: "quantity",
        sourceText: match.sourceText,
        start: match.start,
        end: match.end,
        amount: match.amount,
        unit: profile.unit,
        compatibleProfileIds: [profile.id],
      });
    }
  }
  return [...evidence, ...quantityBySpan.values()].sort((left, right) =>
    left.start - right.start || left.end - right.end || left.key.localeCompare(right.key));
}

export function explicitDurationSeconds(text: string): number | null {
  return extractActionTemporalEvidence(text, {}).find((evidence) => evidence.kind === "duration")?.seconds ?? null;
}
