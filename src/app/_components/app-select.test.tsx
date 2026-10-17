// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSelect } from "./app-select";

const options = [{ value: "stage", label: "引擎顺序" }, { value: "timestamp", label: "时间" }, { value: "duration", label: "耗时" }] as const;

beforeEach(() => {
  // jsdom does not implement the browser geometry/scroll APIs used by Radix.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
});
afterEach(cleanup);

describe("AppSelect", () => {
  it("opens the shared styled menu and restores focus after Escape", async () => {
    render(<AppSelect ariaLabel="排序" onChange={() => {}} options={options} value="stage" />);
    const trigger = screen.getByRole("combobox", { name: "排序：引擎顺序" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.getByRole("listbox", { name: "排序" })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("option", { name: "引擎顺序" })).toHaveFocus());
    expect(screen.getByRole("option", { name: "引擎顺序" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("retains numeric caller values and does not silently select a missing value", async () => {
    const onChange = vi.fn();
    render(<AppSelect ariaLabel="回放速度" onChange={onChange} options={[{ value: 1, label: "1x" }, { value: 4, label: "4x" }]} value={9} />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "回放速度：无可选项" }), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("option", { name: "4x" }), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(4);
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
  });
});
