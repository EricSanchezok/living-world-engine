import type { FactValue, WorldFact } from "../contracts/model";

const stateLabels: Record<string, string> = {
  open: "开启", closed: "关闭", working: "运行中", stopped: "停止", damaged: "损坏", repaired: "已修复",
  leaking: "泄漏", sealed: "已封闭", "temporarily sealed": "暂时封闭", tested: "已测试", untested: "尚未测试",
  stable: "稳定", unstable: "不稳定", available: "可用", unavailable: "不可用",
};
export function directValueLabel(value: Exclude<FactValue, { kind: "entity" }>): string {
  if (value.kind === "none") return "无";
  if (value.kind === "boolean") return value.value ? "是" : "否";
  return value.kind === "text" ? stateLabels[value.value] ?? value.value : String(value.value);
}
/** A previous description cannot continue asserting the old value after an effect. */
export function changedFact(fact: WorldFact, value: FactValue): WorldFact {
  return { ...fact, value, description: value.kind === "entity" ? "关联对象已改变。" : `当前状态：${directValueLabel(value)}。` };
}
export function observedKindLabel(kind: string): string {
  const labels: Record<string, string> = { person: "人", door: "门", object: "物品", item: "物品", shop: "商铺", building: "建筑", location: "地点", place: "地点" };
  return `附近的${labels[kind] ?? "对象"}`;
}
