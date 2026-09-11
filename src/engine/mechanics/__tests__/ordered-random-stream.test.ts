import { describe, expect, it } from "vitest";
import { OrderedRandomStream } from "../ordered-random-stream";
import { createSeededRng, drawInteger } from "../random";

describe("ordered component random stream", () => {
  it("preserves multiple rounds and skips non-random components without duplicate draws", async () => {
    const initial = createSeededRng(47);
    const stream = new OrderedRandomStream(initial, 3);
    const last = stream.acquire(2);
    const middle = stream.finish(1, initial);
    let first = await stream.acquire(0);
    const [roll, afterFirst] = drawInteger(first, 1, 20);
    first = afterFirst;
    const [, afterConditional] = drawInteger(first, 0, roll);
    await stream.finish(0, afterConditional);
    expect(await middle).toEqual(afterConditional);
    expect(await last).toEqual(afterConditional);
    const [thirdRoll, final] = drawInteger(await last, 1, 20);
    expect(await stream.finish(2, final)).toEqual(final);
    const [serialRoll, serialOne] = drawInteger(initial, 1, 20);
    const [, serialTwo] = drawInteger(serialOne, 0, serialRoll);
    const [serialThird, serialFinal] = drawInteger(serialTwo, 1, 20);
    expect(thirdRoll).toBe(serialThird);
    expect(final).toEqual(serialFinal);
  });

  it("unblocks every waiting component on failure without granting another stream", async () => {
    const stream = new OrderedRandomStream(createSeededRng(1), 3);
    const second = stream.acquire(1);
    const third = stream.acquire(2);
    const pending = Promise.allSettled([second, third]);
    const error = new Error("component failed");
    stream.abort(error);
    expect(await pending).toEqual([{ status: "rejected", reason: error }, { status: "rejected", reason: error }]);
    await expect(stream.acquire(0)).rejects.toBe(error);
  });
});
