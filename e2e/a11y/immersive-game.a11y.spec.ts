import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fixtureArchive } from "../support/world-fixture";

async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

async function installFixture(page: Page): Promise<void> {
  const imported = await page.request.post("/api/worlds/import", {
    multipart: {
      file: { name: "open-world-fixture.zip", mimeType: "application/zip", buffer: fixtureArchive() },
      replace: "true",
    },
  });
  expect(imported.ok()).toBe(true);
}

async function createInstance(page: Page, kind: "observer" | "origin" = "observer"): Promise<string> {
  await installFixture(page);
  const created = await page.request.post("/api/instances", {
    data: kind === "observer"
      ? { worldId: "open-world-fixture", start: { kind: "observer" } }
      : {
          worldId: "open-world-fixture",
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

test("menu, world library, Origin dialog and observer conversation are accessible", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "从哪里开始？" })).toBeVisible();
  await expectNoViolations(page);
  const settingsTrigger = page.getByRole("button", { name: /设置.*外观/ });
  await settingsTrigger.click();
  await expectNoViolations(page);
  await page.keyboard.press("Escape");
  await expect(settingsTrigger).toBeFocused();

  await createInstance(page);
  await page.goto("/worlds/open-world-fixture");
  await expect(page.getByRole("heading", { level: 1, name: "开放世界测试夹具" })).toBeVisible();
  await expectNoViolations(page);
  const startTrigger = page.getByRole("button", { name: /开始新游戏/ });
  await startTrigger.click();
  await expectNoViolations(page);
  const chooser = page.getByRole("dialog", { name: "选择你的身份" });
  await chooser.locator(".cg-start-card").filter({ hasText: "庭院旅人" }).click();
  await chooser.getByRole("button", { name: "继续塑造角色" }).click();
  await expect(page.getByRole("dialog", { name: "成为庭院旅人" })).toBeVisible();
  await expectNoViolations(page);
  await page.keyboard.press("Escape");
  await expect(startTrigger).toBeFocused();

  const instanceId = await createInstance(page);
  await page.goto(`/play/${instanceId}`);
  await expect(page.getByRole("button", { name: "单步" })).toBeVisible();
  await expectNoViolations(page);
});

test("Arrival, player composer, role and control overlays remain accessible", async ({ page }) => {
  const instanceId = await createInstance(page, "origin");
  await page.goto(`/play/${instanceId}`);
  await expect(page.locator('[data-role="assistant"] .cg-narrative').filter({ hasText: "此刻，你是小明" }).first()).toBeVisible();
  await expect(page.getByLabel("你的行动")).toBeVisible();
  const suggestionPanel = page.getByRole("region", { name: "可选的行动建议" });
  await expect(suggestionPanel.getByRole("button")).toHaveCount(3);
  await expectNoViolations(page);

  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.evaluate(() => {
    document.documentElement.dir = "rtl";
    document.documentElement.style.fontSize = "200%";
  });
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);
  expect(await suggestionPanel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expectNoViolations(page);
  await page.evaluate(() => {
    document.documentElement.dir = "ltr";
    document.documentElement.style.removeProperty("font-size");
  });
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1_280, height: 720 });

  await page.getByRole("button", { name: /打开游戏控制/ }).click();
  await expect(page.locator(".cg-orb__menu").getByRole("button")).toHaveCount(4);
  await expect(page.locator(".cg-orb__card")).toHaveCount(0);
  await page.getByRole("button", { name: "视角" }).click();
  await expect(page.getByRole("dialog", { name: "视角" })).toBeVisible();
  await expect(page.getByRole("region", { name: "角色关系星图" })).toBeVisible();
  await expect(page.locator(".cg-orb__menu").getByRole("button")).toHaveCount(0);
  await expectNoViolations(page);
  await page.setViewportSize({ width: 320, height: 720 });
  await expect(page.getByRole("heading", { name: "关系列表" })).toBeVisible();
  await expectNoViolations(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /打开游戏控制/ })).toBeFocused();

  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByRole("button", { name: /打开游戏控制/ }).click();
  const mobileControls = page.locator(".cg-sheet-surface");
  await expect(mobileControls.getByRole("button", { name: /^视角/ })).toBeVisible();
  await expectNoViolations(page);
  await mobileControls.getByRole("button", { name: /^视角/ }).click();
  await expect(page.getByRole("dialog", { name: "视角" })).toBeVisible();
  await expectNoViolations(page);
});

test("world awakening remains accessible when motion, color and space are constrained", async ({ page }) => {
  await installFixture(page);
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/worlds/open-world-fixture");
  await page.evaluate(() => {
    localStorage.setItem("livingworld:preferences:v2", JSON.stringify({
      fontScale: "standard",
      reduceMotion: true,
      showWorldInspector: false,
      advancedRoleControl: false,
    }));
    window.dispatchEvent(new CustomEvent("livingworld:preferences-changed"));
  });
  await page.getByRole("button", { name: /开始新游戏/ }).click();
  const chooser = page.getByRole("dialog", { name: "选择你的身份" });
  await chooser.locator(".cg-start-card").filter({ hasText: "庭院旅人" }).click();
  await chooser.getByRole("button", { name: "继续塑造角色" }).click();
  const customization = page.getByRole("dialog", { name: "成为庭院旅人" });
  await customization.getByLabel("你的名字").fill("小明");

  let releaseRequest!: () => void;
  let markIntercepted!: () => void;
  const intercepted = new Promise<void>((resolve) => { markIntercepted = resolve; });
  const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  await page.route("**/api/instances", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
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
  const stationaryOrbit = awakening.locator(".cg-world-weave__svg > g").first();
  await page.waitForTimeout(200);
  const reducedMotionTransform = await stationaryOrbit.evaluate((element) => getComputedStyle(element).transform);
  await page.waitForTimeout(350);
  expect(await stationaryOrbit.evaluate((element) => getComputedStyle(element).transform)).toBe(reducedMotionTransform);
  await expectNoViolations(page);

  await page.evaluate(() => {
    document.documentElement.dir = "rtl";
    document.documentElement.style.fontSize = "200%";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await awakening.locator(".cg-awakening").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expectNoViolations(page);
  releaseRequest();
  await expect(customization.getByRole("alert")).toHaveText(
    "世界没能被唤醒。你的角色信息仍在，可以检查后重试。",
  );
});

test("the inspector is accessible in forced colors and at 200 percent zoom", async ({ page }) => {
  const instanceId = await createInstance(page);
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.goto(`/play/${instanceId}`);
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
  await expectNoViolations(page);
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoViolations(page);
  await page.evaluate(() => { document.documentElement.dir = "rtl"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoViolations(page);
});
