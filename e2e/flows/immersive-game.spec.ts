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
  await expect(page.locator(".cg-observer-heading")).toContainText("正在观察");

  await page.getByRole("button", { name: "单步" }).click();
  await expect(page.locator('[data-role="assistant"]').first()).toContainText("随身物资");

  await page.getByRole("button", { name: "实时" }).click();
  await expect(page.getByRole("button", { name: "暂停" })).toBeVisible();
  await page.getByRole("button", { name: "暂停" }).click();

  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a Participant starts from an Origin, receives Arrival, acts, detaches and takes over", async ({ page }) => {
  await installFixture(page);
  await startOrigin(page);

  const composer = page.getByRole("textbox", { name: "你的行动", exact: true });
  const lastWorldMessage = page.locator('[data-role="assistant"]').last();
  const suggestionPanel = lastWorldMessage.getByRole("region", { name: "可选的行动建议" });
  await expect(suggestionPanel).toHaveCount(0);
  await lastWorldMessage.getByRole("button", { name: "行动建议", exact: true }).click();
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
  await expect(suggestionPanel).toHaveCount(0);
  await composer.fill(" ");
  await expect(suggestionPanel).toBeVisible();
  await composer.fill("我现在在哪里？\n请描述眼前的环境。");
  let releaseAction!: () => void;
  let markActionStarted!: () => void;
  const actionStarted = new Promise<void>((resolve) => { markActionStarted = resolve; });
  const actionGate = new Promise<void>((resolve) => { releaseAction = resolve; });
  await page.route("**/api/instances/*/participants/*/actions", async (route) => {
    markActionStarted();
    await actionGate;
    await route.continue();
  });
  const frameBefore = await page.locator(".aui-composer-shell").boundingBox();
  await page.evaluate(() => {
    const frame = document.querySelector(".aui-composer-shell")!;
    const samples: Array<{ x: number; y: number; width: number; height: number; connected: boolean; text: string }> = [];
    let running = true;
    const sample = () => {
      if (!running) return;
      if (frame.querySelector('[data-mode="progress"]')) {
        const { x, y, width, height } = frame.getBoundingClientRect();
        samples.push({ x, y, width, height, connected: frame.isConnected, text: frame.textContent ?? "" });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    Object.assign(window, { stopFrameSamples: () => { running = false; return samples; } });
  });
  await page.locator(".aui-composer-shell").evaluate(element => { element.setAttribute("data-frame-identity", "original"); });
  await page.getByRole("button", { name: "发送行动" }).click();
  await actionStarted;
  await expect(page.locator(".aui-composer-shell")).toHaveAttribute("data-frame-identity", "original");
  expect(await page.locator(".aui-composer-shell").boundingBox()).toEqual(frameBefore);
  const sentAction = page.locator('[data-role="user"]').last();
  const sentId = await sentAction.getAttribute("id");
  expect((await sentAction.boundingBox())!.y).toBeGreaterThan(48);
  await expect(page.locator('[data-role="assistant"]').first()).toBeInViewport();
  const submitStatus = page.getByText("正在确认行动", { exact: true });
  await expect(submitStatus).toBeVisible();
  const statusFrame = await submitStatus.locator("..").evaluate((element) => {
    const frame = element.closest(".aui-composer-shell");
    if (!frame) throw new Error("missing action submit frame");
    const style = getComputedStyle(frame);
    return { borderRadius: style.borderRadius, minHeight: style.minHeight };
  });
  expect(statusFrame).toEqual(composerFrame);
  await expect(page.getByRole("textbox", { name: "你的行动", exact: true })).toHaveCount(0);
  await page.locator(".cg-thread-messages").evaluate(element => { element.style.minHeight = "200vh"; });
  await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
  await viewport.hover();
  await page.mouse.wheel(0, -400);
  await expect(page.getByRole("button", { name: "滚动到最新消息" })).toBeVisible();
  const readingPosition = await viewport.evaluate(element => element.scrollTop);
  releaseAction();
  await expect(page.getByText(/你查看了眼前的情况/).last()).toBeAttached();
  await expect(page.getByRole("textbox", { name: "你的行动", exact: true })).toBeVisible();
  expect(await viewport.evaluate(element => element.scrollTop)).toBe(readingPosition);
  const samples = await page.evaluate(() => (window as unknown as {
    stopFrameSamples: () => Array<{ x: number; y: number; width: number; height: number; connected: boolean; text: string }>;
  }).stopFrameSamples());
  expect(samples.length).toBeGreaterThan(1);
  for (const sample of samples) {
    expect(sample.connected).toBe(true);
    for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(sample[key] - frameBefore![key])).toBeLessThanOrEqual(1);
  }
  await page.locator(".cg-thread-messages").evaluate(element => { element.style.removeProperty("min-height"); });
  await expect(page.locator('[data-role="user"]').last()).toHaveAttribute("id", sentId!);
  await expect(page.getByText("轮到你决定下一步")).toHaveCount(0);
  await expect(page.getByText("世界推进已暂停", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "恢复", exact: true })).toHaveCount(0);
  const idle = await (await page.request.get(new URL(page.url()).pathname.replace("/play/", "/api/instances/"))).json() as PublicInstanceDetail;
  expect(idle.run?.status).toBe("awaiting-decision");
  expect(idle.actionWindow?.deadlineAt).toBeNull();
  const updatedSuggestions = page.getByRole("region", { name: "可选的行动建议" });
  await expect(updatedSuggestions).toHaveCount(0);
  await page.getByRole("button", { name: "行动建议", exact: true }).click();
  await expect(updatedSuggestions.getByRole("button", { name: "询问守门人石门后的道路" })).toBeVisible();
  await expect(updatedSuggestions.getByRole("button", { name: "确认自己所在的位置" })).toHaveCount(0);
  await composer.fill("我想自己写下一步");
  await expect(updatedSuggestions).toHaveCount(0);
  await page.request.get(new URL(page.url()).pathname.replace("/play/", "/api/instances/"));
  await expect(composer).toHaveValue("我想自己写下一步");
  await composer.fill("");
  await page.unroute("**/api/instances/*/participants/*/actions");

  await openOrb(page);
  await page.getByRole("button", { name: "视角" }).click();
  const perspective = page.getByRole("dialog", { name: "视角" });
  await expect(perspective.getByRole("button", { name: "关闭视角" })).toBeFocused();
  await expect(perspective.getByRole("region", { name: "状态", exact: true })).toBeVisible();
  await expect(perspective.getByRole("region", { name: "附近的关系图" })).toHaveCount(0);
  await perspective.getByRole("button", { name: "关系图", exact: true }).click();
  await expect(perspective.getByRole("region", { name: "附近的关系图" })).toBeVisible();
  await perspective.getByRole("button", { name: "卡片", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 720 });
  const known = perspective.getByRole("region", { name: "已知信息", exact: true });
  await expect(known).toBeVisible();
  const firstEntry = known.getByRole("button", { name: /^查看/ }).first();
  await firstEntry.scrollIntoViewIfNeeded();
  const beforeReading = await perspective.boundingBox();
  const readingScroll = await perspective.locator(".cg-modal-scroll").evaluate((element) => element.scrollTop);
  await firstEntry.click();
  await expect(perspective.getByRole("button", { name: "返回视角" })).toBeVisible();
  expect(await perspective.boundingBox()).toEqual(beforeReading);
  await perspective.getByRole("button", { name: "返回视角" }).click();
  await expect(firstEntry).toBeFocused();
  expect(await perspective.locator(".cg-modal-scroll").evaluate((element) => element.scrollTop)).toBe(readingScroll);
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
  await expect(page.getByRole("textbox", { name: "你的行动", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "切换或离开角色" }).click();
  const control = page.getByRole("dialog", { name: "切换或离开角色" });
  await control.getByRole("button", { name: /进入观察模式/ }).click();
  await expect(page.getByRole("button", { name: "接管" })).toBeVisible();

  await page.getByRole("combobox", { name: /^观察角色/ }).click();
  await page.getByRole("option", { name: /^守门人/ }).click();
  await page.getByRole("button", { name: "接管" }).click();
  await expect(page.locator('[data-role="assistant"] .cg-narrative').filter({ hasText: "此刻，你是守门人" }).first()).toBeVisible();
  await expect(page.getByRole("textbox", { name: "你的行动", exact: true })).toBeVisible();
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
  await page.getByRole("textbox", { name: "你的行动", exact: true }).fill("触发 E2E 快速失败");
  await page.getByRole("button", { name: "发送行动" }).click();
  await expect(page.getByText("这一步的动作判定中断了，还没有产生新的变化。你仍在庭院里，可以接着说明想做的事。")).toBeVisible();
  await expect(page.getByText("这次尝试暂时没有得到完整回应。已经发生的变化会保留，你可以继续或重试。")).toHaveCount(0);
  await expect(page.getByText("世界时间 0s", { exact: true })).toBeVisible();

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

test("live stages follow actual model work in one stationary composer until publication finishes", async ({ page }) => {
  await installFixture(page);
  await startOrigin(page);
  const instanceId = new URL(page.url()).pathname.split("/").at(-1)!;
  const detailUrl = `/api/instances/${instanceId}`;
  const initial = await (await page.request.get(detailUrl)).json() as PublicInstanceDetail;
  const gateUrl = `http://127.0.0.1:${process.env.LIVINGWORLD_E2E_MODEL_PORT ?? 32128}/progress-gates/${initial.conversation!.participantId}`;
  const actionText = "观察四周，留意石门。";
  expect((await page.request.post(gateUrl, { data: { actionText } })).ok()).toBe(true);
  const frame = page.locator(".aui-composer-shell");
  const composer = page.getByRole("textbox", { name: "你的行动", exact: true });
  const progress = page.getByRole("group", { name: "世界运行控制台" });
  const phases = [
    ["interpreting", "正在理解行动与情境"], ["resolving", "正在处理现场互动"],
    ["composing", "正在生成本轮回应"], ["verifying", "正在核对回应内容"],
  ];
  try {
    await composer.fill(actionText);
    await frame.evaluate(element => { element.setAttribute("data-frame-identity", "original"); });
    const originalBox = await frame.boundingBox();
    await page.getByRole("button", { name: "发送行动" }).click();
    for (const [stage, label] of phases) {
      await expect(progress).toHaveAttribute("data-progress-stage", stage!);
      await expect(progress).toContainText(label!);
      await expect(composer).toHaveCount(0);
      await expect(frame).toHaveAttribute("data-frame-identity", "original");
      const currentBox = await frame.boundingBox();
      for (const key of ["x", "y", "width", "height"] as const) {
        expect(Math.abs(currentBox![key] - originalBox![key])).toBeLessThanOrEqual(1);
      }
      if (stage === "interpreting") {
        await expect(progress).toContainText("本阶段 1 秒");
        await expect(progress).toHaveAttribute("data-progress-stage", "interpreting");
        await page.reload();
        await expect(progress).toHaveAttribute("data-progress-stage", "interpreting");
        await frame.evaluate(element => { element.setAttribute("data-frame-identity", "original"); });
      }
      if (stage === "composing") {
        const detail = await (await page.request.get(detailUrl)).json() as PublicInstanceDetail;
        expect(detail.run?.status).not.toMatch(/^(queued|running|pausing)$/);
      }
      expect((await page.request.delete(`${gateUrl}/${stage}`)).ok()).toBe(true);
    }
    await expect(composer).toBeVisible();
    await expect(progress).toHaveCount(0);
    const finished = await (await page.request.get(detailUrl)).json() as PublicInstanceDetail;
    expect(finished.progress).toBeNull();
    expect(finished.conversation!.turns.at(-1)!.status).toBe("committed");
    await page.setViewportSize({ width: 320, height: 720 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect((await page.request.post(gateUrl, { data: { actionText } })).ok()).toBe(true);
    await composer.fill(actionText);
    const mobileBox = await frame.boundingBox();
    await page.getByRole("button", { name: "发送行动" }).click();
    await expect(progress).toHaveAttribute("data-progress-stage", "interpreting");
    await expect(progress.getByRole("status")).toHaveText("正在理解行动与情境");
    expect(await progress.getByRole("status").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const mobileProgressBox = await frame.boundingBox();
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(mobileProgressBox![key] - mobileBox![key])).toBeLessThanOrEqual(1);
    }
  } finally {
    await page.request.delete(gateUrl);
    await expect(composer).toBeVisible();
  }
});

for (const partial of [false, true]) {
  test(`the whole turn stays in progress until ${partial ? "a partial" : "an unpublished"} reply completes, even without events`, async ({ page }) => {
    await installFixture(page);
    await startOrigin(page);
    const instanceId = new URL(page.url()).pathname.split("/").at(-1)!;
    const detailUrl = `/api/instances/${instanceId}`;
    const readDetail = async () => (await (await page.request.get(detailUrl)).json()) as PublicInstanceDetail;
    const initial = await readDetail();
    const gateUrl = `http://127.0.0.1:${process.env.LIVINGWORLD_E2E_MODEL_PORT ?? 32128}/narrative-gates/${initial.conversation!.participantId}`;
    expect((await page.request.post(gateUrl, { data: { partial } })).ok()).toBe(true);

    // Hold the event transport open before its handshake: only the real GET fallback can synchronize this page.
    let releaseEvents!: () => void;
    const eventGate = new Promise<void>(resolve => { releaseEvents = resolve; });
    await page.route(`**${detailUrl}/events`, async route => {
      await eventGate;
      await route.abort().catch(() => undefined);
    });
    try {
      await page.reload();
      const composer = page.getByRole("textbox", { name: "你的行动", exact: true });
      await composer.fill("观察四周");
      const frame = page.locator(".aui-composer-shell");
      const originalBox = await frame.boundingBox();
      await frame.evaluate(element => { element.setAttribute("data-frame-identity", "original"); });
      await page.getByRole("button", { name: "发送行动" }).click();
      await expect.poll(async () => {
        const detail = await readDetail();
        return { run: detail.run?.status, turn: detail.conversation!.turns.at(-1)!.status,
          segments: detail.conversation!.turns.at(-1)!.response?.segmentCount ?? 0 };
      }).toEqual({ run: "awaiting-decision", turn: "running", segments: partial ? 1 : 0 });

      const progress = page.getByRole("group", { name: "世界运行控制台" });
      await expect(progress).toContainText("世界正在推演");
      await expect(progress).toContainText("正在生成本轮回应");
      await expect(composer).toHaveCount(0);
      await expect(page.getByRole("button", { name: /打开游戏控制；世界正在推演/ })).toBeVisible();
      await expect(frame).toHaveAttribute("data-frame-identity", "original");
      const progressBox = await frame.boundingBox();
      for (const key of ["x", "y", "width", "height"] as const) {
        expect(Math.abs(progressBox![key] - originalBox![key])).toBeLessThanOrEqual(1);
      }
      if (partial) await expect(page.getByText("你查看了眼前的情况。", { exact: true })).toBeVisible();

      // Loading the same saved turn while prose is pending must not unlock an empty composer.
      await page.reload();
      await expect(progress).toBeVisible();
      await expect(composer).toHaveCount(0);
      await page.setViewportSize({ width: 320, height: 720 });
      expect(await progress.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(progress).toBeInViewport();

      // Lose one ordinary refresh as well as the completion event; the following GET must recover.
      let failNextRead = true;
      await page.route(`**${detailUrl}`, async route => {
        if (failNextRead) {
          failNextRead = false;
          await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"temporary disconnect"}' });
        } else await route.continue();
      });
      const missedRead = page.waitForResponse(response => response.url().endsWith(detailUrl) && response.status() === 503);
      expect((await page.request.delete(gateUrl)).ok()).toBe(true);
      await missedRead;
      await expect(composer).toBeVisible({ timeout: 10_000 });
      await expect(progress).toHaveCount(0);
      await expect(page.getByRole("button", { name: /打开游戏控制；已保存/ })).toBeVisible();
      await expect(page.getByText(/石门仍在面前，随身物资也清点清楚了/).last()).toBeVisible();
      await expect(page.getByText("最新进度暂时无法同步，正在自动重试。", { exact: true })).toHaveCount(0);
      await composer.fill("下一步行动草稿");
      await expect(composer).toHaveValue("下一步行动草稿");
      const completed = await readDetail();
      expect(completed.conversation!.turns.at(-1)!.status).toBe("committed");
      expect(completed.conversation!.turns.filter(turn => turn.action)).toHaveLength(1);
    } finally {
      releaseEvents();
      await page.request.delete(gateUrl);
    }
  });
}

test("a typed service pause preserves scene text and explains why automatic play stopped", async ({ page }) => {
  await installFixture(page); await startOrigin(page);
  await page.getByRole("textbox", { name: "你的行动", exact: true }).fill("观察四周");
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

test("suggestions are requested explicitly, preserve drafts and replace only after success", async ({ page }) => {
  await installFixture(page);
  await startOrigin(page);
  const endpoint = new URL(page.url()).pathname.replace("/play/", "/api/instances/");
  const initial = await (await page.request.get(endpoint)).json() as PublicInstanceDetail;
  expect(initial.conversation?.suggestions).toMatchObject({ status: "idle", requestId: null, items: [] });
  const composer = page.getByRole("textbox", { name: "你的行动", exact: true });
  const panel = page.getByRole("region", { name: "可选的行动建议" });
  let requests = 0;
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/instances/*/participants/*/suggestions", async route => {
    requests++;
    await gate;
    if (requests === 2) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary fixture failure" }) });
    else await route.continue();
  });
  await page.getByRole("button", { name: "行动建议", exact: true }).click();
  await expect(page.getByRole("button", { name: "生成中…", exact: true })).toBeDisabled();
  await expect(composer).toBeEnabled();
  await composer.fill("我先写下自己的想法");
  release();
  await expect.poll(async () => ((await (await page.request.get(endpoint)).json()) as PublicInstanceDetail).conversation?.suggestions?.status).toBe("ready");
  await expect(panel).toHaveCount(0);
  await expect(composer).toHaveValue("我先写下自己的想法");
  await expect(composer).toBeFocused();
  await composer.fill("");
  await expect(panel.getByRole("button")).toHaveCount(3);
  const previous = await panel.getByRole("button").allTextContents();
  gate = new Promise<void>(resolve => { release = resolve; });
  await page.getByRole("button", { name: "换一组", exact: true }).click();
  await expect(page.getByRole("button", { name: "生成中…", exact: true })).toBeDisabled();
  expect(await panel.getByRole("button").allTextContents()).toEqual(previous);
  release();
  await expect(panel.getByRole("status")).toContainText("可以再试一次");
  expect(await panel.getByRole("button").allTextContents()).toEqual(previous);
  await page.getByRole("button", { name: "换一组", exact: true }).click();
  await expect(panel.getByRole("button", { name: "查看石门上可见的纹路" })).toBeVisible();
  await expect(panel.getByRole("status")).toHaveCount(0);
  expect(await panel.getByRole("button").allTextContents()).not.toEqual(previous);
  await page.reload();
  await expect(panel.getByRole("button", { name: "查看石门上可见的纹路" })).toBeVisible();
  expect(requests).toBe(3);
  const final = await (await page.request.get(endpoint)).json() as PublicInstanceDetail;
  expect(final.summary.revision).toBe(initial.summary.revision);
  expect(final.summary.elapsedSeconds).toBe(initial.summary.elapsedSeconds);
});
