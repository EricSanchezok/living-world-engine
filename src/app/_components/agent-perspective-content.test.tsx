// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentPerspectiveView } from "../../shared/world-api";
import { AgentPerspectiveWorkspace } from "./agent-perspective-workspace";

afterEach(cleanup);

function view(): AgentPerspectiveView {
  return {
    agentId: "reader", revision: 1, step: 1, elapsedSeconds: 12,
    self: { localEntityId: "self", name: "读者", description: "刚来到港口。", lifecycle: "active", location: null },
    mechanics: { meters: [], quantities: [{ name: "钱币", unit: "枚", amount: 0 }], quantityCoverage: "complete-current-self-holdings", ratings: [{ name: "洞察", value: 1, min: -3, max: 8 }], conditions: [] },
    knowledge: {
      entities: [{ ref: "local:guard", name: "守卫", description: "站在门旁的人。", status: "observed", targetable: true }],
      containment: [], exactFacts: [],
      claims: [{ id: "opening", subjectId: "guard", predicate: "says", value: { kind: "text", value: "关门" }, description: "守卫说城门今晚会关闭。", stance: "suspected", confidence: 0.4, evidenceIds: ["heard"] }],
      evidence: [{ id: "heard", kind: "testimony", description: "你听见守卫提醒旅客赶在日落前回来。", sourceId: "guard", step: 1 }],
    },
    character: {
      persona: { summary: "", voice: "", evidenceIds: [], updatedAtStep: 0 }, traits: {}, values: {}, emotions: {}, attitudes: {},
      goals: { shelter: { id: "shelter", description: "找到今晚的住处。", priority: 1, progress: 0, targetIds: [], motivatedByIds: [], status: "active", evidenceIds: [], createdAtStep: 0, updatedAtStep: 0 } },
      commitments: { return: { id: "return", description: "把借来的钥匙还给守卫。", priority: 1, subjectIds: ["guard"], status: "active", evidenceIds: ["heard"], createdAtStep: 1, updatedAtStep: 1 } },
    }, history: [],
  };
}

describe("grouped perspective reading", () => {
  it("reads evidence through the same disclosure as the entity, without a graph or duplicate intentions", () => {
    const perspective = view();
    const original = structuredClone(perspective);
    render(<AgentPerspectiveWorkspace perspective={perspective} reduceMotion />);
    expect(screen.queryByRole("region", { name: "附近的关系图" })).not.toBeInTheDocument();
    expect(screen.getAllByText("找到今晚的住处。")).toHaveLength(1);
    expect(screen.getAllByText("把借来的钥匙还给守卫。")).toHaveLength(1);
    const known = screen.getByRole("region", { name: "已知信息" });
    fireEvent.click(within(known).getByText("守卫"));
    fireEvent.click(within(known).getByText("查看依据 · 1"));
    expect(within(known).getByText("你听见守卫提醒旅客赶在日落前回来。")).toBeVisible();
    expect(within(known).getByText("他人证词")).toBeVisible();
    expect(within(known).getByText("存疑")).toBeVisible();
    expect(screen.queryByText("推测存在")).not.toBeInTheDocument();
    expect(perspective).toEqual(original);
  });

  it("searches information content and clears state when switching characters", () => {
    const { rerender } = render(<AgentPerspectiveWorkspace perspective={view()} reduceMotion />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "今晚会关闭" } });
    expect(screen.getByText("守卫")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "不存在的消息" } });
    expect(screen.getByRole("status")).toHaveTextContent("没有找到");
    const next = view(); next.agentId = "another-reader";
    rerender(<AgentPerspectiveWorkspace perspective={next} reduceMotion />);
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });

  it("keeps zero quantities, explains bounds only with abilities and invents no missing state", () => {
    render(<AgentPerspectiveWorkspace perspective={view()} reduceMotion />);
    expect(within(screen.getByRole("region", { name: "物品" })).getByText("0")).toBeVisible();
    expect(screen.getByText("暂无身体状态记录。")).toBeVisible();
    const ability = screen.getByText("能力");
    fireEvent.click(ability);
    expect(screen.getByText("显示当前能力值，数值范围为 -3 至 8。")).toBeVisible();
    expect(screen.queryByText("-3…8")).not.toBeInTheDocument();
  });
});
