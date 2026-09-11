import type { SeededRngState } from "../contracts/model";
import { contentHash } from "../models/model-audit";

export const ORDERED_RANDOM_SCHEDULING = "canonical-component-commitment-order-v2";

/** Independent planning can run ahead; random consumption follows component order. */
export class OrderedRandomStream {
  private readonly gates: Array<{
    promise: Promise<SeededRngState>; resolve: (state: SeededRngState) => void; reject: (error: unknown) => void;
  }> = [];
  private readonly acquired = new Set<number>();
  private readonly finished = new Set<number>();
  private failure: { error: unknown } | undefined;

  constructor(private readonly initial: SeededRngState, count: number) {
    this.initial = structuredClone(initial);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("ordered random stream requires components");
    for (let index = 0; index < count; index += 1) {
      let resolve!: (state: SeededRngState) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<SeededRngState>((done, fail) => { resolve = done; reject = fail; });
      // Cancellation may precede the next component's first acquisition.
      void promise.catch(() => undefined);
      this.gates.push({ promise, resolve, reject });
    }
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure.error;
  }

  private async predecessor(index: number): Promise<SeededRngState> {
    if (!this.gates[index]) throw new Error("unknown random stream component");
    this.throwIfFailed();
    const state = index === 0 ? this.initial : await this.gates[index - 1]!.promise;
    this.throwIfFailed();
    return structuredClone(state);
  }

  async acquire(index: number): Promise<SeededRngState> {
    if (this.acquired.has(index) || this.finished.has(index)) throw new Error("component acquired its random stream twice");
    this.acquired.add(index);
    return this.predecessor(index);
  }

  async finish(index: number, result: SeededRngState): Promise<SeededRngState> {
    if (this.finished.has(index)) throw new Error("component completed its random stream twice");
    this.finished.add(index);
    const previous = await this.predecessor(index);
    if (!this.acquired.has(index) && contentHash(result) !== contentHash(this.initial)) {
      throw new Error("component consumed random state without acquiring the ordered stream");
    }
    const next = this.acquired.has(index) ? result : previous;
    if (next.seed !== previous.seed || next.draws < previous.draws) throw new Error("component random state moved backwards");
    this.gates[index]!.resolve(structuredClone(next));
    return structuredClone(next);
  }

  abort(error: unknown): void {
    this.failure ??= { error };
    for (const gate of this.gates) gate.reject(this.failure.error);
  }
}
