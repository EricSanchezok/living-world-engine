import { describe, expect, it } from "vitest";
import { encodeFullTextWindows, planEncoderTokenWindows, type TokenizedEncoderText } from "./full-text-window-encoder";

const text = (count: number, marker = 100): TokenizedEncoderText => ({
  tokenIds: [0, 41, 1294, 12, ...Array.from({ length: count }, (_, index) => marker + index), 2],
  prefixIds: [41, 1294, 12], bos: 0, eos: 2, pad: 1,
});

describe("complete text windows", () => {
  it("covers every payload token once across model boundaries, including empty input and the final tail", () => {
    for (const count of [0, 1, 27, 28, 507, 508, 1014, 1050]) {
      const source = text(count), windows = planEncoderTokenWindows(source);
      expect(windows.flatMap(window => window.inputIds.slice(4, window.attentionMask.filter(Boolean).length - 1)))
        .toEqual(source.tokenIds.slice(4, -1));
      expect(windows[0]!.payloadStart).toBe(0);
      expect(windows.at(-1)!.payloadEnd).toBe(count);
      windows.forEach((window, index) => {
        expect(window.width).toBeLessThanOrEqual(512);
        expect(window.width % 32).toBe(0);
        expect(window.inputIds).toHaveLength(window.width);
        expect(window.attentionMask).toHaveLength(window.width);
        if (index) expect(window.payloadStart).toBe(windows[index - 1]!.payloadEnd);
      });
    }
    expect(planEncoderTokenWindows(text(507))).toHaveLength(1);
    expect(planEncoderTokenWindows(text(508)).map(window => window.width)).toEqual([512, 32]);
    expect(() => planEncoderTokenWindows({ ...text(10), prefixIds: [999] })).toThrow("prefix contract");
    expect(() => planEncoderTokenWindows({ ...text(1), tokenIds: [0, 41, 1294, 12, NaN, 2] })).toThrow("integers");
  });

  it("groups stable widths while restoring text order and retaining payload-weighted tail influence", async () => {
    const inputs = [text(508), text(10, 800), text(27, 900), ...Array.from({ length: 129 }, () => text(1, 7))];
    const batches: number[][] = [];
    const result = await encodeFullTextWindows(inputs, async windows => {
      batches.push(windows.map(window => window.width));
      expect(new Set(windows.map(window => window.width)).size).toBe(1);
      expect(windows.length).toBeLessThanOrEqual(128);
      return windows.map(window => window.inputIds[4] === 100 ? [1, 0] : [0, 1]);
    }, 2);
    expect(result.vectors[0]).toEqual(Array.from(new Float32Array([507 / Math.hypot(507, 1), 1 / Math.hypot(507, 1)])));
    expect(result.vectors.slice(1)).toEqual(inputs.slice(1).map(() => [0, 1]));
    expect(batches.flat()).toHaveLength(133);
    expect(result.plans[1]).toEqual(planEncoderTokenWindows(inputs[1]!));
    expect(await encodeFullTextWindows([], async () => { throw new Error("unexpected call"); }, 2)).toEqual({ vectors: [], plans: [] });
  });

  it("rejects missing, nonfinite, dimensionally invalid and cancelling embeddings", async () => {
    for (const output of [[], [[NaN, 0]], [[1]], [[0, 0]]]) {
      await expect(encodeFullTextWindows([text(1)], async () => output, 2)).rejects.toThrow();
    }
    await expect(encodeFullTextWindows([text(1014)], async windows => windows.map((_, i) => [i ? -1 : 1, 0]), 2))
      .rejects.toThrow("no finite direction");
  });
});
