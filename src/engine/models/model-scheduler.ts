export class ModelOverloadedError extends Error {
  readonly retriable = true;

  constructor(message: string) {
    super(message);
    this.name = "ModelOverloadedError";
  }
}

export class ModelScheduledExecutionError extends Error {
  constructor(
    readonly cause: unknown,
    readonly queueWaitMs: number,
    readonly executionMs: number,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ModelScheduledExecutionError";
  }
}

export interface ModelScheduleRequest<T> {
  priority?: "foreground" | "background";
  providerId: string;
  workloadId: string;
  abortSignal?: AbortSignal;
  execute: () => Promise<T>;
}

export interface ModelScheduleResult<T> {
  value: T;
  queueWaitMs: number;
  executionMs: number;
}

interface QueuedJob {
  priority: "foreground" | "background";
  providerId: string;
  workloadId: string;
  enqueuedAt: number;
  execute: () => Promise<unknown>;
  resolve: (result: ModelScheduleResult<unknown>) => void;
  reject: (error: unknown) => void;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface FairModelSchedulerOptions {
  globalConcurrency: number;
  maxQueuedRequests: number;
  queueTimeoutMs: number;
  providerConcurrency: Readonly<Record<string, number>>;
  now?: () => number;
}

function abortError(): Error {
  const error = new Error("model request aborted");
  error.name = "AbortError";
  return error;
}

export class FairModelScheduler {
  private readonly lanes = new Map<string, QueuedJob[]>();
  private readonly rotation: string[] = [];
  private readonly activeByProvider = new Map<string, number>();
  private readonly activeByWorkload = new Map<string, number>();
  private readonly now: () => number;
  private nextRotationIndex = 0;
  private active = 0;
  private queued = 0;

  constructor(private readonly options: FairModelSchedulerOptions) {
    if (!Number.isSafeInteger(options.globalConcurrency) || options.globalConcurrency <= 0) {
      throw new Error("global model concurrency must be a positive integer");
    }
    if (!Number.isSafeInteger(options.maxQueuedRequests) ||
      options.maxQueuedRequests < options.globalConcurrency) {
      throw new Error("model queue capacity must cover global concurrency");
    }
    if (!Number.isSafeInteger(options.queueTimeoutMs) || options.queueTimeoutMs <= 0) {
      throw new Error("model queue timeout must be a positive integer");
    }
    for (const [providerId, concurrency] of Object.entries(options.providerConcurrency)) {
      if (!providerId.trim() || !Number.isSafeInteger(concurrency) || concurrency <= 0) {
        throw new Error(`invalid concurrency for provider ${providerId}`);
      }
    }
    this.now = options.now ?? Date.now;
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queued;
  }

  schedule<T>(request: ModelScheduleRequest<T>): Promise<ModelScheduleResult<T>> {
    if (!this.options.providerConcurrency[request.providerId]) {
      return Promise.reject(new Error(`scheduler does not know provider ${request.providerId}`));
    }
    if (!request.workloadId.trim()) return Promise.reject(new Error("model workload id is required"));
    if (request.abortSignal?.aborted) return Promise.reject(abortError());
    if (this.queued >= this.options.maxQueuedRequests) {
      return Promise.reject(new ModelOverloadedError("model queue is full"));
    }

    return new Promise<ModelScheduleResult<T>>((resolve, reject) => {
      const job: QueuedJob = {
        priority: request.priority ?? "foreground",
        providerId: request.providerId,
        workloadId: request.workloadId,
        enqueuedAt: this.now(),
        execute: request.execute,
        resolve: (result) => resolve(result as ModelScheduleResult<T>),
        reject,
        abortSignal: request.abortSignal,
        timeout: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      job.timeout = setTimeout(() => {
        if (!this.remove(job)) return;
        reject(new ModelOverloadedError("model request exceeded queue wait timeout"));
      }, this.options.queueTimeoutMs);
      if (request.abortSignal) {
        job.abortListener = () => {
          if (!this.remove(job)) return;
          reject(abortError());
        };
        request.abortSignal.addEventListener("abort", job.abortListener, { once: true });
      }
      const lane = this.lanes.get(request.workloadId);
      if (lane) lane.push(job);
      else {
        this.lanes.set(request.workloadId, [job]);
        this.rotation.push(request.workloadId);
      }
      this.queued += 1;
      this.drain();
    });
  }

  private remove(job: QueuedJob): boolean {
    const lane = this.lanes.get(job.workloadId);
    if (!lane) return false;
    const index = lane.indexOf(job);
    if (index < 0) return false;
    lane.splice(index, 1);
    this.queued -= 1;
    clearTimeout(job.timeout);
    if (job.abortListener) job.abortSignal?.removeEventListener("abort", job.abortListener);
    if (lane.length === 0 && (this.activeByWorkload.get(job.workloadId) ?? 0) === 0) {
      this.removeLane(job.workloadId);
    }
    this.drain();
    return true;
  }

  private takeNext(): QueuedJob | undefined {
    const laneCount = this.rotation.length;
    if (laneCount === 0) return undefined;
    const startIndex = this.nextRotationIndex % laneCount;
    const foregroundReady = [...this.lanes.values()].some(lane => lane.some(job => job.priority === "foreground" &&
      (this.activeByProvider.get(job.providerId) ?? 0) < this.options.providerConcurrency[job.providerId]!));
    for (let offset = 0; offset < laneCount; offset += 1) {
      const index = (startIndex + offset) % laneCount;
      const workloadId = this.rotation[index];
      const lane = this.lanes.get(workloadId);
      if (!lane || lane.length === 0) continue;
      const position = foregroundReady ? lane.findIndex(job => job.priority === "foreground") : 0;
      if (position < 0) continue;
      const job = lane[position]!;
      const providerLimit = this.options.providerConcurrency[job.providerId];
      const providerActive = this.activeByProvider.get(job.providerId) ?? 0;
      if (providerActive >= providerLimit) continue;
      lane.splice(position, 1);
      this.queued -= 1;
      this.nextRotationIndex = index + 1;
      clearTimeout(job.timeout);
      if (job.abortListener) job.abortSignal?.removeEventListener("abort", job.abortListener);
      return job;
    }
    return undefined;
  }

  private removeLane(workloadId: string): void {
    this.lanes.delete(workloadId);
    const index = this.rotation.indexOf(workloadId);
    if (index < 0) return;
    this.rotation.splice(index, 1);
    if (index < this.nextRotationIndex) this.nextRotationIndex -= 1;
    if (this.rotation.length === 0) this.nextRotationIndex = 0;
  }

  private cleanupWorkload(workloadId: string): void {
    if ((this.activeByWorkload.get(workloadId) ?? 0) === 0 && !this.lanes.has(workloadId)) {
      this.activeByWorkload.delete(workloadId);
      return;
    }
    if ((this.activeByWorkload.get(workloadId) ?? 0) === 0 &&
      (this.lanes.get(workloadId)?.length ?? 0) === 0) {
      this.activeByWorkload.delete(workloadId);
      this.removeLane(workloadId);
    }
  }

  private drain(): void {
    while (this.active < this.options.globalConcurrency) {
      const job = this.takeNext();
      if (!job) return;
      const startedAt = this.now();
      this.active += 1;
      this.activeByProvider.set(job.providerId, (this.activeByProvider.get(job.providerId) ?? 0) + 1);
      this.activeByWorkload.set(job.workloadId, (this.activeByWorkload.get(job.workloadId) ?? 0) + 1);
      void job.execute()
        .then((value) => job.resolve({
          value,
          queueWaitMs: Math.max(0, startedAt - job.enqueuedAt),
          executionMs: Math.max(0, this.now() - startedAt),
        }))
        .catch((error) => job.reject(new ModelScheduledExecutionError(
          error,
          Math.max(0, startedAt - job.enqueuedAt),
          Math.max(0, this.now() - startedAt),
        )))
        .finally(() => {
          this.active -= 1;
          this.activeByProvider.set(job.providerId, (this.activeByProvider.get(job.providerId) ?? 1) - 1);
          this.activeByWorkload.set(job.workloadId, (this.activeByWorkload.get(job.workloadId) ?? 1) - 1);
          this.cleanupWorkload(job.workloadId);
          this.drain();
        });
    }
  }
}
