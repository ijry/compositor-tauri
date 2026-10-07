import { test, expect } from '@playwright/test';

for (const width of [1245, 960]) {
  test(`编辑器布局不换行、不挤压工具栏 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.goto('/');
    await page.locator('.start-page .list button').first().click();
    await expect(page.locator('.cmp-stage')).toBeVisible();
    const toolbar = (await page.locator('.cmp-toolbar').boundingBox())!;
    const header = (await page.locator('.cmp-tool-header').boundingBox())!;
    const canvas = (await page.locator('.cmp-stage').boundingBox())!;
    const right = (await page.locator('.dock-right').boundingBox())!;
    const footer = (await page.locator('.status-bar').boundingBox())!;
    expect(toolbar.x).toBeLessThan(2);
    expect(toolbar.width).toBeGreaterThanOrEqual(51);
    expect(header.y).toBeLessThan(90);
    expect(header.x).toBeGreaterThanOrEqual(toolbar.x + toolbar.width - 1);
    expect(canvas.y).toBeLessThan(130);
    expect(canvas.width).toBeGreaterThan(400);
    expect(canvas.height).toBeGreaterThan(350);
    expect(right.x).toBeGreaterThanOrEqual(canvas.x + canvas.width - 1);
    const panels = await page.locator('.dock-right > .dock-panel').all();
    const a = (await panels[0].boundingBox())!;
    const b = (await panels[1].boundingBox())!;
    expect(Math.abs(a.x - b.x)).toBeLessThan(2);
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
    expect(footer.y + footer.height).toBeLessThanOrEqual(769);
    expect(await page.locator('.cmp-toolbar').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.locator('.panel-bar').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.locator('.props').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.locator('.props').evaluate(el => el.clientHeight)).toBeGreaterThan(150);
    const zoom = Number((await page.locator('.zoom').innerText()).replace('%', '')) / 100;
    expect(1600 * zoom).toBeLessThan(canvas.width + 10);
    expect(900 * zoom).toBeLessThan(canvas.height + 10);
    await page.screenshot({ path: `test-results/editor-${width}.png` });
  });
}
test('浮动面板松开后实际停靠到窗口边缘', async ({ page }) => {
  await page.setViewportSize({ width: 1245, height: 768 });
  await page.goto('/');
  await page.locator('.start-page .list button').first().click();
  await page.locator('.dock-bottom button[title="浮动"]').click();
  const box = (await page.locator('.float-header').boundingBox())!;
  await page.mouse.move(box.x + 70, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(20, 220, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.dock-left')).toBeVisible();
  await expect(page.locator('.float-panel')).toHaveCount(0);
});

test('旧的宽侧栏布局不会把工具栏或画布挤到下一行，并可恢复默认', async ({ page }) => {
  await page.setViewportSize({ width: 1245, height: 768 });
  await page.addInitScript(() => {
    (window as any).otools = {
      getPluginLocalStateValue: async (_id: unknown, key: string) => key === 'compositor.panels.v1'
        ? { history: { area: 'left', size: 900 }, properties: { area: 'right', size: 900 }, layers: { area: 'right', size: 900 } }
        : null,
      savePluginLocalStateValue: async () => {},
    };
  });
  await page.goto('/');
  await page.locator('.start-page .list button').first().click();
  const toolbar = (await page.locator('.cmp-toolbar').boundingBox())!;
  const canvas = (await page.locator('.cmp-stage').boundingBox())!;
  expect(toolbar.x).toBeLessThan(2);
  expect(canvas.y).toBeLessThan(130);
  expect(canvas.width).toBeGreaterThan(400);
  await page.locator('.menu-title').filter({ hasText: '视图' }).hover();
  await page.getByText('恢复默认面板布局', { exact: true }).click();
  await expect(page.locator('.dock-left')).toHaveCount(0);
  await expect(page.locator('.dock-bottom')).toBeVisible();
});
