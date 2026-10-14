import { expect, test, type Page } from "@playwright/test";
import { fixtureArchive } from "../support/world-fixture";
import type { PublicInstanceDetail, PublicModelServicePause } from "../../src/shared/world-api";

async function installFixture(page: Page): Promise<void> {
  const response = await page.request.post("/api/worlds/import", {
    multipart: {
      file: { name: "open-world-fixture.zip", mimeType: "application/zip", buffer: fixtureArchive() },
      replace: "true",
    },
  });
  expect(response.ok()).toBe(true);
}

async function createObserver(page: Page): Promise<{ id: string; revision: number }> {
  const response = await page.request.post("/api/instances", {
    data: { worldId: "open-world-fixture", seed: 20260827, start: { kind: "observer" } },
  });
  expect(response.status()).toBe(201);
  const detail = await response.json() as { summary: { id: string; revision: number } };
  return detail.summary;
}

async function startOrigin(page: Page): Promise<void> {
  await page.goto("/worlds/open-world-fixture");
  await page.getByRole("button", { name: /开始新游戏/ }).click();
  const dialog = page.getByRole("dialog", { name: "选择你的身份" });
  await expect(page).toHaveURL(/\/worlds\/open-world-fixture$/);
  await expect(dialog).toBeVisible();
  await dialog.locator(".cg-start-card").filter({ hasText: "庭院旅人" }).click();
  await dialog.getByRole("button", { name: "继续塑造角色" }).click();
  const customization = page.getByRole("dialog", { name: "成为庭院旅人" });
  await customization.getByLabel("你的名字").fill("小明");
  await customization.getByLabel("外观描述").fill("背着旧旅行包");
  await customization.getByLabel("一个自由动机").fill("找到石门后的道路");
  await customization.getByRole("button", { name: "进入世界" }).click();
  await expect(page).toHaveURL(/\/play\/[^/]+$/);
  await expect(page.locator('[data-role="assistant"] .cg-narrative').filter({ hasText: "此刻，你是小明" }).first()).toBeVisible();
}

async function openOrb(page: Page): Promise<void> {
  await page.getByRole("button", { name: /打开游戏控制/ }).click();
}

test("world awakening locks the committed identity and restores it after failure", async ({ page }) => {
  await installFixture(page);
  await page.goto("/worlds/open-world-fixture");
  await page.getByRole("button", { name: /开始新游戏/ }).click();
  const chooser = page.getByRole("dialog", { name: "选择你的身份" });
  await chooser.locator(".cg-start-card").filter({ hasText: "庭院旅人" }).click();
  await chooser.getByRole("button", { name: "继续塑造角色" }).click();
  const customization = page.getByRole("dialog", { name: "成为庭院旅人" });
  await customization.getByLabel("你的名字").fill("小明");
  await customization.getByLabel("外观描述").fill("背着旧旅行包");
  await customization.getByLabel("一个自由动机").fill("找到石门后的道路");

  let releaseRequest!: () => void;
  let markIntercepted!: () => void;
  let createRequests = 0;
  const intercepted = new Promise<void>((resolve) => { markIntercepted = resolve; });
  const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  await page.route("**/api/instances", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    createRequests += 1;
    markIntercepted();
    await requestGate;
    await route.fulfill({
      body: JSON.stringify({ error: "forced creation failure" }),
      contentType: "application/json",
      status: 500,
    });
  });

  await customization.getByRole("button", { name: "进入世界" }).click();
  await intercepted;
  const awakening = page.getByRole("dialog", { name: "世界正在苏醒" });
  await expect(awakening).toBeVisible();
  await expect(awakening).toHaveAttribute("aria-busy", "true");
  await expect(awakening.getByText(/正在将「小明」带到「石门前庭」/)).toBeVisible();
  const movingOrbit = awakening.locator(".cg-world-weave__svg > g").first();
  const initialOrbitTransform = await movingOrbit.evaluate((element) => getComputedStyle(element).transform);
  await expect.poll(
    () => movingOrbit.evaluate((element) => getComputedStyle(element).transform),
    { timeout: 2_000 },
  ).not.toBe(initialOrbitTransform);
  await expect(page.getByRole("button", { name: "取消开始新游戏" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "进入世界" })).toHaveCount(0);
  await page.locator(".cg-modal-overlay").click({ force: true, position: { x: 2, y: 2 } });
  await expect(awakening).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(awakening).toBeVisible();
  expect(await awakening.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  expect(createRequests).toBe(1);
  expect(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);

  releaseRequest();
  const recoveryAlert = page
    .getByRole("dialog", { name: "成为庭院旅人" })
    .getByRole("alert");
  await expect(recoveryAlert).toHaveText("世界没能被唤醒。你的角色信息仍在，可以检查后重试。");
  await expect(recoveryAlert).toBeFocused();
  await expect(page.getByLabel("你的名字")).toHaveValue("小明");
  await expect(page.getByLabel("外观描述")).toHaveValue("背着旧旅行包");
  await expect(page.getByLabel("一个自由动机")).toHaveValue("找到石门后的道路");
});

test("world detail keeps historical saves in a scrollable middle panel", async ({ page }) => {
  await installFixture(page);
  const initialResponse = await page.request.get("/api/instances");
  expect(initialResponse.ok()).toBe(true);
  const initialPayload = await initialResponse.json() as { instances: Array<{ worldId: string }> };
  const initialCount = initialPayload.instances.filter((instance) => instance.worldId === "open-world-fixture").length;
  for (let index = 0; index < 7; index += 1) {
    const response = await page.request.post("/api/instances", {
      data: {
        seed: 20260830 + index,
        start: { kind: "observer" },
        worldId: "open-world-fixture",
      },
    });
    expect(response.status()).toBe(201);
  }

  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto("/worlds/open-world-fixture");
  await expect(page.getByRole("button", { exact: true, name: "开始新游戏" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "历史存档" })).toBeVisible();
  const history = page.getByRole("region", { name: "历史存档列表" });
  await expect(history.locator("li")).toHaveCount(initialCount + 7);
  expect(await history.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const firstRow = history.locator("li").first();
  const statusBox = await firstRow.locator(".cg-instance-state").boundingBox();
  const deleteIconBox = await firstRow.locator(".cg-instance-delete svg").boundingBox();
  expect(statusBox).not.toBeNull();
  expect(deleteIconBox).not.toBeNull();
  const statusCenter = statusBox!.y + statusBox!.height / 2;
  const deleteIconCenter = deleteIconBox!.y + deleteIconBox!.height / 2;
  expect(Math.abs(statusCenter - deleteIconCenter)).toBeLessThanOrEqual(1);
  await history.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  expect(await history.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  const historyBox = await page.locator(".cg-world-saves").boundingBox();
  const packageBox = await page.locator(".cg-world-package").boundingBox();
  expect(historyBox).not.toBeNull();
  expect(packageBox).not.toBeNull();
  expect(packageBox!.y).toBeGreaterThan(historyBox!.y + historyBox!.height);
  expect(packageBox!.y + packageBox!.height).toBeLessThanOrEqual(900);

  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await history.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const mobileHistoryBox = await page.locator(".cg-world-saves").boundingBox();
  const mobileDeleteBox = await firstRow.locator(".cg-instance-delete").boundingBox();
  expect(mobileHistoryBox).not.toBeNull();
  expect(mobileDeleteBox).not.toBeNull();
  expect(mobileHistoryBox!.x + mobileHistoryBox!.width).toBeLessThanOrEqual(320);
  expect(mobileDeleteBox!.x + mobileDeleteBox!.width).toBeLessThanOrEqual(320);

  let deleteRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "DELETE" && request.url().includes("/api/instances/")) deleteRequests += 1;
  });
  await firstRow.locator(".cg-instance-delete").click();
  const deleteDialog = page.getByRole("dialog", { name: "删除存档" });
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog.getByText(/确定要删除/)).toBeVisible();
  expect(deleteRequests).toBe(0);
  await page.keyboard.press("Escape");
  await expect(deleteDialog).toBeHidden();
  expect(deleteRequests).toBe(0);
  await expect(firstRow.locator(".cg-instance-delete")).toBeFocused();

  await firstRow.locator(".cg-instance-delete").click();
  const deleteResponse = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().includes("/api/instances/"));
  await page.getByRole("dialog", { name: "删除存档" }).getByRole("button", { name: "删除存档", exact: true }).click();
  await expect((await deleteResponse).ok()).toBe(true);
  await expect(deleteDialog).toBeHidden();
  expect(deleteRequests).toBe(1);
  await expect(history.locator("li")).toHaveCount(initialCount + 6);
});

test("a world starts in observer mode without replacing the conversation core", async ({ page }) => {
  await installFixture(page);
  let releaseRequest!: () => void;
  let markIntercepted!: () => void;
  let createRequests = 0;
  const intercepted = new Promise<void>((resolve) => { markIntercepted = resolve; });
  const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  await page.route("**/api/instances", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    createRequests += 1;
    markIntercepted();
    await requestGate;
    await route.continue();
  });

  await page.goto("/worlds/open-world-fixture");
  await page.getByRole("button", { name: /开始新游戏/ }).click();
  const dialog = page.getByRole("dialog", { name: "选择你的身份" });
  await dialog.locator(".cg-start-card").filter({ hasText: "观察世界" }).click();
  await dialog.getByRole("button", { name: "开始观察" }).click();
  await intercepted;
  const awakening = page.getByRole("dialog", { name: "世界正在苏醒" });
  await expect(awakening.getByText("观察方式已确认")).toBeVisible();
  await expect(awakening.getByText("正在唤醒世界中的行动者，并准备第一个可观察视角。")).toBeVisible();
  releaseRequest();
  await expect(page).toHaveURL(/\/play\/[^/]+$/);
  expect(createRequests).toBe(1);
  await expect(page.getByRole("button", { name: "单步" })).toBeVisible();
  await expect(page.getByText("世界正在发生什么")).toHaveCount(0);

  await page.getByRole("button", { name: "单步" }).click();
  await expect(page.getByText(/你查看了眼前的情况/).first()).toBeVisible();

  await page.getByRole("button", { name: "实时" }).click();
  await expect(page.getByRole("button", { name: "暂停" })).toBeVisible();
  await page.getByRole("button", { name: "暂停" }).click();

  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a Participant starts from an Origin, receives Arrival, acts, detaches and takes over", async ({ page }) => {
  await installFixture(page);
  await startOrigin(page);

  const composer = page.getByLabel("你的行动");
  const lastWorldMessage = page.locator('[data-role="assistant"]').last();
  const suggestionPanel = lastWorldMessage.getByRole("region", { name: "可选的行动建议" });
  await expect(suggestionPanel).toBeVisible();
  await expect(suggestionPanel.getByRole("button")).toHaveCount(3);
  expect(await suggestionPanel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(composer).toHaveAttribute("placeholder", "自由描述你的行动…");
  const suggestionBox = await suggestionPanel.boundingBox();
  const composerBox = await page.locator(".aui-composer-shell").boundingBox();
  const viewport = page.locator("[data-cg-thread-viewport]");
  const footer = page.locator('[data-slot="aui-thread-viewport-footer"]');
  expect(await page.locator(".cg-thread-root").evaluate((element) => getComputedStyle(element).overflow)).toBe("hidden");
  expect(await viewport.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
  expect(await footer.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
  expect(await footer.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderTop: style.borderTopWidth, borderRight: style.borderRightWidth, borderBottom: style.borderBottomWidth, borderLeft: style.borderLeftWidth, boxShadow: style.boxShadow };
  })).toEqual({ borderTop: "0px", borderRight: "0px", borderBottom: "0px", borderLeft: "0px", boxShadow: "none" });
  const composerFrame = await page.locator(".aui-composer-shell").evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderRadius: style.borderRadius, minHeight: style.minHeight };
  });
  expect(suggestionBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(suggestionBox!.y + suggestionBox!.height).toBeLessThan(composerBox!.y);
  await page.locator(".cg-thread-messages").evaluate((element) => { element.setAttribute("style", "min-height: 200vh"); });
  await viewport.evaluate((element) => { element.scrollTop = Math.min(500, element.scrollHeight - element.clientHeight); });
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const scrolledComposerBox = await page.locator(".aui-composer-shell").boundingBox();
  expect(scrolledComposerBox).not.toBeNull();
  expect(Math.abs(scrolledComposerBox!.y - composerBox!.y)).toBeLessThanOrEqual(1);
  await page.locator(".cg-thread-messages").evaluate((element) => { element.removeAttribute("style"); });
  await page.getByRole("button", { name: "确认自己所在的位置" }).click();
  await expect(composer).toHaveValue("确认自己所在的位置");
  await expect(composer).toBeFocused();
  await composer.fill("我现在在哪里？");
  let releaseAction!: () => void;
  let markActionStarted!: () => void;
  const actionStarted = new Promise<void>((resolve) => { markActionStarted = resolve; });
  const actionGate = new Promise<void>((resolve) => { releaseAction = resolve; });
  await page.route("**/api/instances/*/participants/*/actions", async (route) => {
    markActionStarted();
    await actionGate;
    await route.continue();
  });
  await page.getByRole("button", { name: "发送行动" }).click();
  await actionStarted;
  const submitStatus = page.getByText("正在确认行动", { exact: true });
  await expect(submitStatus).toBeVisible();
  const statusFrame = await submitStatus.locator("..").evaluate((element) => {
    const frame = element.closest(".cg-thread-status");
    if (!frame) throw new Error("missing action submit frame");
    const style = getComputedStyle(frame);
    return { borderRadius: style.borderRadius, minHeight: style.minHeight };
  });
  expect(statusFrame).toEqual(composerFrame);
  await expect(page.getByLabel("你的行动")).toHaveCount(0);
  releaseAction();
  await expect(page.getByText(/你查看了眼前的情况/).last()).toBeVisible();
  await page.unroute("**/api/instances/*/participants/*/actions");

  await openOrb(page);
  await page.getByRole("button", { name: "视角" }).click();
  const perspective = page.getByRole("dialog", { name: "视角" });
  await expect(perspective.getByRole("region", { name: "角色关系星图" })).toBeVisible();
  await expect(perspective.getByText("精确关系", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 720 });
  await expect(perspective.getByRole("heading", { name: "关系列表" })).toBeVisible();
  await expect(perspective.getByRole("region", { name: "角色关系星图" })).toBeHidden();
  expect(await perspective.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1_280, height: 720 });

  await openOrb(page);
  await page.getByRole("button", { name: "设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("switch", { name: "高级角色控制" }).click();
  await expect(settings.getByRole("switch", { name: "高级角色控制" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByText("轮到你决定下一步", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "切换或离开角色" }).click();
  const control = page.getByRole("dialog", { name: "切换或离开角色" });
  await control.getByRole("button", { name: /进入观察模式/ }).click();
  await expect(page.getByRole("button", { name: "接管" })).toBeVisible();

  await page.getByLabel("观察角色").selectOption("keeper");
  await page.getByRole("button", { name: "接管" }).click();
  await expect(page.locator('[data-role="assistant"] .cg-narrative').filter({ hasText: "此刻，你是守门人" }).first()).toBeVisible();
  await expect(page.getByLabel("你的行动")).toBeVisible();
});

test("the world spirit freely drags, persists, gazes and opens a complete desktop ring", async ({ page }) => {
  await installFixture(page);
  const instance = await createObserver(page);
  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto(`/play/${instance.id}`);
  await expect(page.getByRole("button", { name: "单步" })).toBeVisible();

  const trigger = page.getByRole("button", { name: /打开游戏控制/ });
  const spirit = page.locator(".cg-world-spirit");
  await expect(spirit.locator("svg")).toBeVisible();
  await expect(spirit.locator(".mo-eyes")).toHaveCount(1);
  await expect(trigger).not.toHaveAttribute("title", /.+/);
  await expect(page.locator(".cg-orb__status")).toContainText("已保存");

  const initial = await trigger.boundingBox();
  expect(initial).not.toBeNull();
  await page.mouse.move(initial!.x + initial!.width / 2, initial!.y + initial!.height / 2);
  await page.mouse.down();
  await page.mouse.move(950, 380, { steps: 8 });
  await page.mouse.up();
  const dragged = await trigger.boundingBox();
  expect(dragged).not.toBeNull();
  expect(Math.abs(dragged!.x - 950)).toBeLessThan(48);
  expect(dragged!.x).toBeGreaterThan(100);
  expect(dragged!.x + dragged!.width).toBeLessThan(1_180);
  const draggedStatus = await page.locator(".cg-orb__status").boundingBox();
  expect(draggedStatus).not.toBeNull();
  expect(Math.abs(
    (draggedStatus!.x + draggedStatus!.width / 2) - (dragged!.x + dragged!.width / 2),
  )).toBeLessThanOrEqual(1);

  await page.reload();
  await expect(page.getByRole("button", { name: "单步" })).toBeVisible();
  const persisted = await trigger.boundingBox();
  expect(persisted).not.toBeNull();
  expect(Math.abs(persisted!.x - dragged!.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(persisted!.y - dragged!.y)).toBeLessThanOrEqual(2);

  await trigger.click();
  const toolbar = page.getByRole("toolbar", { name: "游戏控制" });
  await expect(toolbar.getByRole("button")).toHaveCount(4);
  await expect(page.locator(".cg-orb__card")).toHaveCount(0);
  const actionBounds = await toolbar.getByRole("button").evaluateAll((buttons) => buttons.map((button) => {
    const bounds = button.getBoundingClientRect();
    return { top: bounds.top, right: bounds.right, bottom: bounds.bottom, left: bounds.left };
  }));
  for (const bounds of actionBounds) {
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(1_280);
    expect(bounds.bottom).toBeLessThanOrEqual(800);
  }

  const perspectiveAction = toolbar.getByRole("button", { name: "视角" });
  const actionSurface = perspectiveAction.locator(".cg-orb__action-surface");
  await page.waitForTimeout(350);
  const actionBoundsBeforeHover = await perspectiveAction.boundingBox();
  const beforeHover = await actionSurface.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color };
  });
  await perspectiveAction.hover();
  await expect(perspectiveAction.locator(".cg-orb__action-label")).toBeVisible();
  await expect.poll(() => actionSurface.evaluate((element) => getComputedStyle(element).scale)).toBe("1.08");
  const actionBoundsAfterHover = await perspectiveAction.boundingBox();
  expect(actionBoundsBeforeHover).not.toBeNull();
  expect(actionBoundsAfterHover).toEqual(actionBoundsBeforeHover);
  const afterHover = await actionSurface.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color };
  });
  expect(afterHover).not.toEqual(beforeHover);
  await expect.poll(() => spirit.locator(".mo-eyes").evaluate((element) => getComputedStyle(element).transform))
    .not.toBe("none");

  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(perspectiveAction).toBeFocused();
  await perspectiveAction.press("ArrowRight");
  await expect(toolbar.getByRole("button", { name: "存档" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  await trigger.press("Alt+Home");
  const reset = await trigger.boundingBox();
  expect(reset).not.toBeNull();
  expect(reset!.x).toBeGreaterThan(900);
  await trigger.click();
  await page.waitForTimeout(100);
  const afterResetClick = await page.locator(".cg-orb__trigger").boundingBox();
  expect(afterResetClick).not.toBeNull();
  expect(Math.abs(afterResetClick!.x - reset!.x)).toBeLessThan(80);
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 320, height: 720 });
  await trigger.click();
  const mobileControls = page.locator(".cg-sheet-surface");
  await expect(mobileControls.getByRole("button", { name: /^视角/ })).toBeVisible();
  await expect(page.locator(".cg-orb__action")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("failed execution stays atomic and long diagnostics never widen the inspector", async ({ page }) => {
  await installFixture(page);
  await startOrigin(page);
  await page.getByLabel("你的行动").fill("触发 E2E 快速失败");
  await page.getByRole("button", { name: "发送行动" }).click();
  await expect(page.getByText("这次尝试暂时没有得到完整回应。已经发生的变化会保留，你可以继续或重试。")).toBeVisible();

  await page.evaluate(() => {
    localStorage.setItem("livingworld:preferences:v2", JSON.stringify({
      fontScale: "standard",
      reduceMotion: false,
      showWorldInspector: true,
      advancedRoleControl: false,
    }));
    window.dispatchEvent(new CustomEvent("livingworld:preferences-changed"));
  });
  await openOrb(page);
  await page.getByRole("button", { name: "世界演化" }).click();
  const inspector = page.getByRole("dialog", { name: "世界演化" });
  await expect(inspector.getByText("世界状态已提交")).toBeVisible();
  const instanceId = new URL(page.url()).pathname.split("/").at(-1)!;
  const detail = await (await page.request.get(`/api/instances/${instanceId}`)).json() as { summary: { revision: number } };
  const step = await (await page.request.get(`/api/instances/${instanceId}/inspector/steps/${detail.summary.revision}`)).json() as {
    directRuntime: { intents: Record<string, { failure: unknown }> };
  };
  expect(Object.values(step.directRuntime.intents).some(intent => intent.failure)).toBe(true);
  expect(await inspector.locator(".cg-inspector-detail").evaluate((element) => (
    element.scrollWidth <= element.clientWidth
  ))).toBe(true);

  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("a typed service pause preserves scene text and explains why automatic play stopped", async ({ page }) => {
  await installFixture(page); await startOrigin(page);
  await page.getByLabel("你的行动").fill("观察四周");
  await page.getByRole("button", { name: "发送行动" }).click();
  await expect(page.getByText(/你查看了眼前的情况/).last()).toBeVisible();
  const instanceId = new URL(page.url()).pathname.split("/").at(-1)!;
  const pause: PublicModelServicePause = { code: "request-limit", retry: "after-service-change",
    message: "模型调用次数已达到本轮上限，世界已暂停自动推进。已有进展已保存；增加调用额度后可以继续。" };
  // The host's transport-boundary tests own cap production. This boundary owns DTO rendering.
  await page.route(`**/api/instances/${instanceId}`, async route => {
    const response = await route.fetch(); const detail = await response.json() as PublicInstanceDetail;
    detail.servicePause = pause;
    const turn = detail.conversation!.turns.at(-1)!; turn.status = "failed"; turn.servicePause = pause;
    await route.fulfill({ response, json: detail });
  });
  await page.reload();
  await expect(page.getByText(pause.message, { exact: true })).toHaveCount(1);
  await expect(page.getByText(/你查看了眼前的情况/).last()).toBeVisible();
  await expect(page.getByRole("status", { name: "模型服务状态" })).toContainText("自动推进已暂停");
  await expect(page.getByText("这次尝试暂时没有得到完整回应。已经发生的变化会保留，你可以继续或重试。")).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("instance APIs expose only Agent-scoped views", async ({ page }) => {
  await installFixture(page);
  const instance = await createObserver(page);
  const response = await page.request.get(`/api/instances/${instance.id}/observer`);
  expect(response.ok()).toBe(true);
  const text = await response.text();
  expect(text).not.toContain("canonicalEntityIds");
  expect(text).not.toContain("key-is-authentic");
  expect(text).not.toContain("providerId");
});

test("the global theme preference persists across product routes", async ({ page }) => {
  await page.goto("/");
  const settingsTrigger = page.getByRole("button", { name: /设置.*外观/ });
  await settingsTrigger.click();
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await settingsDialog.getByRole("button", { name: "深色" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.keyboard.press("Escape");
  await expect(settingsTrigger).toBeFocused();
  await page.goto("/worlds");
  await expect(page.locator("html")).toHaveClass(/dark/);
});
