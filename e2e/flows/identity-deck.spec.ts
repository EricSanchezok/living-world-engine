import { expect, test, type Page } from "@playwright/test";
import AdmZip from "adm-zip";
import { parse, stringify } from "yaml";
import { fixtureArchive } from "../support/world-fixture";

async function installLongDeck(page: Page): Promise<void> {
  const zip = new AdmZip(fixtureArchive());
  const script = parse(zip.readAsText("world/script.yaml"));
  script.id = "identity-deck-fixture";
  const participation = parse(zip.readAsText("world/participation.yaml"));
  const origin = participation.origins[0];
  participation.origins = Array.from({ length: 9 }, (_, index) => ({
    ...origin,
    id: `traveler-${index + 1}`,
    title: `旅人 ${index + 1}`,
  }));
  zip.updateFile("world/script.yaml", Buffer.from(stringify(script)));
  zip.updateFile("world/participation.yaml", Buffer.from(stringify(participation)));
  const response = await page.request.post("/api/worlds/import", { multipart: {
    file: { name: "identity-deck.zip", mimeType: "application/zip", buffer: zip.toBuffer() },
    replace: "true",
  } });
  expect(response.status()).toBe(201);
}

const frameSelectors = [
  ".cg-start-dialog",
  ".cg-start-dialog__setup > header",
  ".cg-start-choice-step__footer",
  ".cg-start-dialog .cg-modal-close",
];

async function frameGeometry(page: Page): Promise<number[][]> {
  return page.evaluate(selectors => selectors.map(selector => {
    const element = document.querySelector<HTMLElement>(selector)!;
    const { x, y, width, height } = element.getBoundingClientRect();
    return [x, y, width, height];
  }), frameSelectors);
}

async function expectStableFrame(page: Page, baseline: number[][]): Promise<void> {
  const maximumDrift = await page.evaluate(async ({ selectors, baseline }) => {
    let drift = 0;
    const started = performance.now();
    do {
      selectors.forEach((selector, index) => {
        const element = document.querySelector<HTMLElement>(selector)!;
        const { x, y, width, height } = element.getBoundingClientRect();
        [x, y, width, height].forEach((value, axis) => {
          drift = Math.max(drift, Math.abs(value - baseline[index]![axis]!));
        });
        drift = Math.max(drift, Math.abs(element.scrollLeft));
      });
      const dialog = document.querySelector<HTMLElement>(".cg-start-dialog")!;
      drift = Math.max(drift, dialog.scrollWidth - dialog.clientWidth);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    } while (performance.now() - started < 500);
    return drift;
  }, { selectors: frameSelectors, baseline });
  expect(maximumDrift).toBeLessThanOrEqual(1);
}

for (const scenario of [
  { name: "desktop animation", width: 1440, height: 900, reducedMotion: "no-preference" },
  { name: "mobile reduced motion", width: 390, height: 844, reducedMotion: "reduce" },
] as const) {
  test(`identity selection keeps the dialog frame fixed with ${scenario.name}`, async ({ page }) => {
    await installLongDeck(page);
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.emulateMedia({ reducedMotion: scenario.reducedMotion });
    await page.goto("/worlds/identity-deck-fixture");
    await page.getByRole("button", { name: "开始新游戏", exact: true }).click();
    const chooser = page.getByRole("dialog", { name: "选择你的身份" });
    await expect(chooser.getByRole("radio")).toHaveCount(10);
    await expect(chooser.locator(".cg-start-dialog__setup")).toHaveCSS("opacity", "1");
    const baseline = await frameGeometry(page);

    for (let index = 0; index < 9; index++) {
      await chooser.getByRole("button", { name: "下一张身份卡片", exact: true }).click();
    }
    const cards = chooser.locator(".cg-start-card");
    await expect.poll(() => cards.last().evaluate(element => {
      const card = element.getBoundingClientRect();
      const viewport = element.closest(".cg-start-deck__viewport")!.getBoundingClientRect();
      return Math.max(viewport.left - card.left, card.right - viewport.right, 0);
    })).toBeLessThanOrEqual(1);
    await cards.last().getByText("观察世界", { exact: true }).click();
    await expect(chooser.getByRole("radio").last()).toBeChecked();
    await expectStableFrame(page, baseline);

    await page.keyboard.press("ArrowLeft");
    await expect(chooser.getByRole("radio").nth(8)).toBeChecked();
    await expectStableFrame(page, baseline);
    await page.keyboard.press("ArrowRight");
    await expect(chooser.getByRole("radio").last()).toBeChecked();
    await expectStableFrame(page, baseline);

    for (const index of [0, 4, 9]) {
      await cards.nth(index).locator(".cg-start-card__copy strong").click();
      await expect(chooser.getByRole("radio").nth(index)).toBeChecked();
      await expectStableFrame(page, baseline);
    }
    await chooser.getByRole("button", { name: "取消开始新游戏" }).click();
    await expect(chooser).toBeHidden();
    await expect(page).toHaveURL(/\/worlds\/identity-deck-fixture$/);
  });
}
