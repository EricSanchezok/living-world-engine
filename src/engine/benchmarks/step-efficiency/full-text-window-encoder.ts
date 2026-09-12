export const FULL_TEXT_WINDOW_CONTRACT = {
  version: "e5-fp32-complete-windows-v1",
  maxTokens: 512,
  widthMultiple: 32,
  maxWindowsPerBatch: 128,
  truncation: false,
  overlap: 0,
  pooling: "normalized-window-mean-weighted-by-payload-tokens",
} as const;

export interface TokenizedEncoderText {
  tokenIds: readonly number[];
  prefixIds: readonly number[];
  bos: number;
  eos: number;
  pad: number;
}

export interface EncoderTokenWindow {
  payloadStart: number;
  payloadEnd: number;
  inputIds: number[];
  attentionMask: number[];
  width: number;
}

export function planEncoderTokenWindows(text: TokenizedEncoderText): EncoderTokenWindow[] {
  const { tokenIds, prefixIds, bos, eos, pad } = text;
  if (![...tokenIds, ...prefixIds, bos, eos, pad].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("encoder tokens must be nonnegative integers");
  }
  if (!prefixIds.length || tokenIds.length < prefixIds.length + 2 || tokenIds[0] !== bos || tokenIds.at(-1) !== eos
    || prefixIds.some((value, index) => tokenIds[index + 1] !== value)) {
    throw new Error("complete encoder text does not match its boundary and prefix contract");
  }
  const payload = tokenIds.slice(prefixIds.length + 1, -1);
  const capacity = FULL_TEXT_WINDOW_CONTRACT.maxTokens - prefixIds.length - 2;
  if (capacity < 1) throw new Error("encoder prefix leaves no payload capacity");
  const windows: EncoderTokenWindow[] = [];
  for (let start = 0; start < Math.max(1, payload.length); start += capacity) {
    const end = Math.min(payload.length, start + capacity);
    const ids = [bos, ...prefixIds, ...payload.slice(start, end), eos];
    const width = Math.ceil(ids.length / FULL_TEXT_WINDOW_CONTRACT.widthMultiple) * FULL_TEXT_WINDOW_CONTRACT.widthMultiple;
    windows.push({ payloadStart: start, payloadEnd: end, width,
      inputIds: [...ids, ...Array<number>(width - ids.length).fill(pad)],
      attentionMask: [...Array<number>(ids.length).fill(1), ...Array<number>(width - ids.length).fill(0)] });
  }
  return windows;
}

function combineWindowVectors(windows: readonly EncoderTokenWindow[], vectors: readonly (readonly number[])[], dimensions: number): number[] {
  if (vectors.length !== windows.length || vectors.some(vector => vector.length !== dimensions
    || vector.some(value => !Number.isFinite(value)) || !vector.some(value => value !== 0))) {
    throw new Error("window encoder returned malformed vectors");
  }
  if (vectors.length === 1) return [...vectors[0]!];
  const weighted = Array<number>(dimensions).fill(0);
  vectors.forEach((vector, index) => {
    const weight = Math.max(1, windows[index]!.payloadEnd - windows[index]!.payloadStart);
    vector.forEach((value, dimension) => { weighted[dimension] += value * weight; });
  });
  const norm = Math.hypot(...weighted);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("window aggregate has no finite direction");
  return Array.from(new Float32Array(weighted.map(value => value / norm)));
}

export async function encodeFullTextWindows(
  texts: readonly TokenizedEncoderText[],
  encode: (windows: readonly EncoderTokenWindow[]) => Promise<readonly (readonly number[])[]>,
  dimensions: number,
): Promise<{ vectors: number[][]; plans: EncoderTokenWindow[][] }> {
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) throw new Error("invalid encoder dimensions");
  const plans = texts.map(planEncoderTokenWindows);
  const vectors = plans.map(windows => Array<readonly number[]>(windows.length));
  const groups = new Map<number, Array<{ textIndex: number; windowIndex: number; window: EncoderTokenWindow }>>();
  plans.forEach((windows, textIndex) => windows.forEach((window, windowIndex) => {
    const group = groups.get(window.width) ?? [];
    group.push({ textIndex, windowIndex, window });
    groups.set(window.width, group);
  }));
  for (const [, group] of [...groups].sort(([left], [right]) => left - right)) {
    for (let offset = 0; offset < group.length; offset += FULL_TEXT_WINDOW_CONTRACT.maxWindowsPerBatch) {
      const batch = group.slice(offset, offset + FULL_TEXT_WINDOW_CONTRACT.maxWindowsPerBatch);
      const output = await encode(batch.map(item => item.window));
      if (output.length !== batch.length) throw new Error("window encoder omitted a batch member");
      batch.forEach((item, index) => { vectors[item.textIndex]![item.windowIndex] = output[index]!; });
    }
  }
  return { vectors: vectors.map((rows, index) => combineWindowVectors(plans[index]!, rows, dimensions)), plans };
}
