import { expect, test, type Page } from "@playwright/test";
import { fixtureArchive } from "../support/world-fixture";

const screenshotOptions = { animations: "disabled" as const, maxDiffPixelRatio: 0.01 };

async function settleResponsiveOverlay(page: Page): Promise<void> {
  // The control orb measures the sticky viewport footer through a
  // ResizeObserver. Give that measurement and the following frame a chance
  // to settle before taking a mobile visual snapshot on slower CI runners.
  await page.waitForTimeout(300);
}

async function install(page: Page): Promise<void> {
  const imported = await page.request.post("/api/worlds/import", {
    multipart: {
      file: { name: "open-world-fixture.zip", mimeType: "application/zip", buffer: fixtureArchive() },
      replace: "true",
    },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
}

async function preparedInstance(page: Page, kind: "observer" | "origin"): Promise<string> {
  await install(page);
  const created = await page.request.post("/api/instances", {
    data: kind === "observer"
      ? { worldId: "open-world-fixture", seed: 20260828, start: { kind: "observer" } }
      : {
          worldId: "open-world-fixture",
          seed: 20260828,
          start: {
            kind: "origin",
            originId: "courtyard-wanderer",
            displayName: "小明",
            appearance: "背着旧旅行包",
            motivation: "找到石门后的道路",
          },
        },
  });
  expect(created.status()).toBe(201);
  const detail = await created.json() as { summary: { id: string } };
  return detail.summary.id;
}

test("the new-game identity deck and customization form have stable responsive layouts", async ({ page }) => {
  await install(page);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto("/worlds/open-world-fixture");
  await page.getByRole("button", { name: /开始新游戏/ }).click();
  const chooser = page.getByRole("dialog", { name: "选择你的身份" });
  await expect(chooser).toBeVisible();
  const initialDialogBox = await chooser.boundingBox();
  await expect(page).toHaveScreenshot("start-identity-deck-light-desktop.png", screenshotOptions);

  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page).toHaveScreenshot("start-identity-deck-light-mobile.png", screenshotOptions);
  await page.setViewportSize({ width: 1_440, height: 900 });

  await chooser.locator(".cg-start-card").filter({ hasText: "庭院旅人" }).click();
  await chooser.getByRole("button", { name: "继续塑造角色" }).click();
  const customization = page.getByRole("dialog", { name: "成为庭院旅人" });
  await expect(customization).toBeVisible();
  expect(await customization.boundingBox()).toEqual(initialDialogBox);
  await expect(page).toHaveScreenshot("start-customization-light-desktop.png", screenshotOptions);

  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page).toHaveScreenshot("start-customization-light-mobile.png", screenshotOptions);
});

test("the observer conversation matches light and dark responsive baselines", async ({ page }) => {
  for (const colorScheme of ["light", "dark"] as const) {
    const instanceId = await preparedInstance(page, "observer");
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`/play/${instanceId}`);
    await expect(page.getByRole("button", { name: "单步" })).toBeVisible();
    await expect(page.locator(".cg-timeline-rail")).toBeVisible();
    await expect(page.getByLabel("你的行动", { exact: true })).toHaveCount(0);
    await expect(page).toHaveScreenshot(`instance-${colorScheme}-desktop.png`, screenshotOptions);

    await page.getByRole("button", { name: /打开游戏控制/ }).click();
    await expect(page.getByRole("toolbar", { name: "游戏控制" })).toBeVisible();
    await expect(page).toHaveScreenshot(`instance-control-ring-${colorScheme}-desktop.png`, screenshotOptions);
    await page.keyboard.press("Escape");

    let releaseAdvance!: () => void;
    let markAdvanceStarted!: () => void;
    const advanceStarted = new Promise<void>((resolve) => { markAdvanceStarted = resolve; });
    const advanceGate = new Promise<void>((resolve) => { releaseAdvance = resolve; });
    await page.route("**/api/instances/*/advance", async (route) => {
      markAdvanceStarted();
      await advanceGate;
      await route.continue();
    });
    await page.getByRole("button", { name: "单步" }).click();
    await advanceStarted;
    await expect(page.getByRole("combobox", { name: "观察角色" })).toBeEnabled();
    await expect(page.getByText("正在确认你的行动", { exact: true })).toBeVisible();
    await expect(page).toHaveScreenshot(`instance-control-notice-${colorScheme}-desktop.png`, screenshotOptions);
    const selector = page.getByRole("combobox", { name: "观察角色" });
    const originalSelection = (await selector.innerText()).trim();
    await selector.click();
    const otherAgent = page.getByRole("option", { selected: false }).first();
    const nextSelection = (await otherAgent.innerText()).trim();
    await otherAgent.click();
    await expect(selector).toHaveText(nextSelection);
    releaseAdvance();
    await expect(page.locator('[data-role="assistant"]').first()).toContainText("随身物资");
    await expect(page.getByRole("button", { name: "单步" })).toBeEnabled();
    await expect(selector).toHaveText(nextSelection);
    await selector.click();
    await page.getByRole("option", { name: originalSelection, exact: true }).click();
    await expect(selector).toHaveText(originalSelection);
    await expect(page.locator('[data-role="assistant"]').first()).toContainText("随身物资");
    await page.unroute("**/api/instances/*/advance");

    await page.setViewportSize({ width: 320, height: 720 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator(".cg-timeline-rail")).toBeHidden();
    await settleResponsiveOverlay(page);
    await expect(page).toHaveScreenshot(`instance-${colorScheme}-mobile.png`, screenshotOptions);
  }
});

test("the participant conversation, control orb and inspector stay bounded", async ({ page }) => {
  const instanceId = await preparedInstance(page, "origin");
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto(`/play/${instanceId}`);
  await expect(page.locator('[data-role="assistant"] .cg-narrative').filter({ hasText: "此刻，你是小明" }).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "可选的行动建议" })).toHaveCount(0);
  await page.getByRole("button", { name: "行动建议", exact: true }).click();
  await expect(page.getByRole("region", { name: "可选的行动建议" })).toBeVisible();
  await expect(page).toHaveScreenshot("instance-participant-dark-desktop.png", screenshotOptions);
  await expect(page.locator(".cg-timeline-rail")).toBeVisible();
  await expect(page.getByLabel("你的行动", { exact: true })).toBeVisible();

  // Create actual world-decision evidence before inspecting invocations.
  await page.getByLabel("你的行动", { exact: true }).fill("观察四周");
  await page.getByRole("button", { name: "发送行动" }).click();
  await expect(page.getByText(/你查看了眼前的情况/).last()).toBeVisible();
  await page.getByRole("button", { name: "行动建议", exact: true }).click();
  await expect(page.getByRole("button", { name: "询问守门人石门后的道路" })).toBeVisible();

  await page.evaluate(() => {
    localStorage.setItem("livingworld:preferences:v2", JSON.stringify({
      fontScale: "standard",
      reduceMotion: true,
      showWorldInspector: true,
      advancedRoleControl: false,
    }));
    window.dispatchEvent(new CustomEvent("livingworld:preferences-changed"));
  });
  await page.getByRole("button", { name: /打开游戏控制/ }).click();
  await page.getByRole("button", { name: "世界演化" }).click();
  const inspector = page.getByRole("dialog", { name: "世界演化" });
  await expect(inspector).toBeVisible();
  await expect(inspector.locator('.cg-inspector-graph[data-layout-ready="true"]')).toBeVisible();
  await expect.poll(async () => inspector.locator(".react-flow__edge-path").evaluateAll((paths) => (
    paths.some((path) => (path as SVGPathElement).getTotalLength() > 0)
  ))).toBe(true);
  await page.waitForTimeout(200);
  await expect(page).toHaveScreenshot("instance-inspector-dark-desktop.png", screenshotOptions);
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 320, height: 720 });
  // Restore the committed conversation at mobile size, without a desktop dialog's
  // focus restoration or an in-flight message transition choosing the scroll anchor.
  await page.reload();
  await expect(page.getByLabel("你的行动", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await settleResponsiveOverlay(page);
  await page.locator("[data-cg-thread-viewport]").evaluate(element => { element.scrollTo({ top: element.scrollHeight, behavior: "instant" }); });
  await expect(page).toHaveScreenshot("instance-participant-dark-mobile.png", screenshotOptions);

  const debugResponse = await page.request.get(`/api/debug?instance=${instanceId}&limit=1`);
  expect(debugResponse.ok(), await debugResponse.text()).toBe(true);
  const debugResult = await debugResponse.json() as { invocations: Array<{ id: string }> };
  const publicInvocationId = debugResult.invocations[0]?.id;
  expect(publicInvocationId).toBeTruthy();
  await page.getByRole("button", { name: /打开游戏控制/ }).click();
  await page.getByRole("button", { name: "世界演化" }).click();
  const reopenedInspector = page.getByRole("dialog", { name: "世界演化" });
  await reopenedInspector.getByRole("button", { name: "调用", exact: true }).click();
  const inspectorSearch = reopenedInspector.getByRole("searchbox", { name: /public invocation id/ });
  await inspectorSearch.fill(publicInvocationId!);
  await inspectorSearch.press("Enter");
  await expect(reopenedInspector.getByRole("heading", { name: /根调用|语义修复/ })).toBeVisible();
  await expect(reopenedInspector.getByRole("region", { name: "语义修复链" })).toBeVisible();
  await expect(reopenedInspector.getByText("定位证据")).not.toBeVisible();
});
