/** Infrastructure availability is separate from a world's semantic outcome. */
export type ModelServiceLimitCode = "request-limit" | "spending-limit" | "token-limit" | "usage-unresolved";
export interface ModelServicePause {
  code: ModelServiceLimitCode;
  message: string;
  retry: "after-service-change";
}

const messages: Record<ModelServiceLimitCode, string> = {
  "request-limit": "模型调用次数已达到本轮上限，世界已暂停自动推进。已有进展已保存；增加调用额度后可以继续。",
  "spending-limit": "本轮模型费用额度已用完，世界已暂停自动推进。已有进展已保存；增加预算后可以继续。",
  "token-limit": "本轮模型用量已达到上限，世界已暂停自动推进。已有进展已保存；调整用量额度后可以继续。",
  "usage-unresolved": "上一次模型调用的费用尚未确认，后续调用已暂停。已有进展已保存；费用核对完成后可以继续。",
};

/** Provider adapters wrap transport errors; follow causes without parsing user or model text. */
export function modelServicePause(error: unknown): ModelServicePause | null {
  const visited = new Set<unknown>();
  for (let current = error; current instanceof Error && !visited.has(current); current = current.cause) {
    visited.add(current);
    const candidate = current as Error & { limitCode?: unknown };
    if (candidate.name === "ExperimentBudgetError" && typeof candidate.limitCode === "string" &&
      Object.hasOwn(messages, candidate.limitCode)) {
      const code = candidate.limitCode as ModelServiceLimitCode;
      return { code, message: messages[code], retry: "after-service-change" };
    }
  }
  return null;
}
