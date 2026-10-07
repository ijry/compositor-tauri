import { test, expect, type Page, type Locator } from '@playwright/test';

/** 只替代宿主存储边界，页面、主题和拖拽逻辑均运行构建后的实际代码。 */
async function hostState(page: Page, values: Record<string, unknown>) {
  await page.addInitScript((initial) => {
    if (!localStorage.getItem('layout-test-state')) localStorage.setItem('layout-test-state', JSON.stringify(initial));
    (window as any).otools = {
      getPluginLocalStateValue: async (_id: unknown, key: string) => JSON.parse(localStorage.getItem('layout-test-state') || '{}')[key] ?? null,
      savePluginLocalStateValue: async (_id: unknown, key: string, value: unknown) => {
        const state = JSON.parse(localStorage.getItem('layout-test-state') || '{}');
        state[key] = value;
        localStorage.setItem('layout-test-state', JSON.stringify(state));
      },
    };
  }, values);
}
async function openEditor(page: Page) {
  await page.goto('/');
  await page.locator('.start-page .list button').first().click();
  await expect(page.locator('.cmp-stage')).toBeVisible();
}
async function dragHandle(page: Page, handle: Locator, dx: number, dy = 0) {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(60, box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}
async function widthOf(locator: Locator) { return (await locator.boundingBox())!.width; }
async function savedPanels(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('layout-test-state') || '{}')['compositor.panels.v1']);
}
async function expectFloatInWindow(page: Page) {
  const viewport = page.viewportSize()!;
  await expect.poll(async () => {
    const header = await page.locator('.float-header').boundingBox();
    const panel = await page.locator('.float-panel').boundingBox();
    return !!header && !!panel && header.x >= 0 && header.y >= 0
      && panel.x + panel.width <= viewport.width && panel.y + panel.height <= viewport.height;
  }).toBe(true);
}

for (const area of ['right', 'left'] as const) {
  test(`${area} 同侧面板同步缩窄并持久化`, async ({ page }) => {
    await page.setViewportSize({ width: 1245, height: 768 });
    await hostState(page, { 'compositor.panels.v1': { properties: { area, size: 288 }, layers: { area, size: 288 } } });
    await openEditor(page);
    const dock = page.locator(`.dock-${area}`);
    await dragHandle(page, dock.locator('.resize-handle').first(), area === 'right' ? 70 : -70);
    await expect.poll(() => widthOf(dock)).toBeCloseTo(218, 0);
    await expect.poll(async () => (await savedPanels(page))?.layers?.size).toBeCloseTo(218, 0);
    // 被折叠的同侧面板也同步，重新展开不能恢复旧宽度。
    await dock.locator('.chev').nth(1).click();
    await dragHandle(page, dock.locator('.resize-handle').first(), area === 'right' ? -20 : 20);
    await dock.locator('.chev').nth(1).click();
    await expect.poll(() => widthOf(dock)).toBeCloseTo(238, 0);
    await expect.poll(async () => (await savedPanels(page))?.properties?.size).toBeCloseTo(238, 0);
    await openEditor(page);
    await expect.poll(() => widthOf(dock)).toBeCloseTo(238, 0);
  });
}

test('被视口限制的侧栏与底栏拖动从实际尺寸起算', async ({ page }) => {
  await page.setViewportSize({ width: 1245, height: 768 });
  await hostState(page, { 'compositor.panels.v1': { properties: { size: 900 }, layers: { size: 900 }, history: { size: 520 } } });
  await openEditor(page);
  const dock = page.locator('.dock-right');
  const before = await widthOf(dock);
  await dragHandle(page, dock.locator('.resize-handle').first(), 80);
  await expect.poll(() => widthOf(dock)).toBeCloseTo(before - 80, 0);
  const bottom = page.locator('.dock-bottom');
  const height = (await bottom.boundingBox())!.height;
  await dragHandle(page, bottom.locator('.resize-handle'), 0, 60);
  await expect.poll(async () => (await bottom.boundingBox())!.height).toBeCloseTo(height - 60, 0);
});

test('恢复大屏浮动坐标时保证面板可见且停靠按钮可点击', async ({ page }) => {
  await page.setViewportSize({ width: 1245, height: 768 });
  await hostState(page, { 'compositor.panels.v1': { history: { area: 'float', float: { x: 1700, y: 900, width: 1400, height: 1000, area: 'bottom' } } } });
  await openEditor(page);
  await expectFloatInWindow(page);
  await page.locator('.float-header button[title="停靠到底部"]').click();
  await expect(page.locator('.float-panel')).toHaveCount(0);
  await expect(page.locator('.dock-bottom')).toBeVisible();
});

test('缩小窗口和重新浮动后面板仍在可操作区域', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await hostState(page, { 'compositor.panels.v1': { history: { area: 'float', float: { x: 1500, y: 720, width: 340, height: 300, area: 'bottom' } } } });
  await openEditor(page);
  await expectFloatInWindow(page);
  await page.setViewportSize({ width: 800, height: 600 });
  await expectFloatInWindow(page);
  await page.locator('.float-header button[title="停靠到底部"]').click();
  await page.locator('.dock-bottom button[title="浮动"]').click();
  await expectFloatInWindow(page);
  await page.screenshot({ path: 'test-results/review-floating-800.png' });
});

for (const theme of ['dark', 'light', 'system'] as const) {
  test(`启动恢复 ${theme} 主题及控件配色`, async ({ page }) => {
    await page.setViewportSize({ width: 1245, height: 768 });
    await page.emulateMedia({ colorScheme: 'light' });
    await hostState(page, theme === 'dark' ? {} : { 'compositor.theme': theme });
    await openEditor(page);
    const expected = theme === 'dark' ? 'dark' : 'light';
    await expect(page.locator('html')).toHaveClass(new RegExp(expected));
    await expect.poll(() => page.locator('html').evaluate(el => getComputedStyle(el).colorScheme)).toBe(expected);
    const bg = await page.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--el-bg-color').trim());
    if (theme === 'dark') expect(bg).not.toMatch(/^#(?:fff|ffffff)$/i);
    if (theme === 'system') {
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(page.locator('html')).toHaveClass(/dark/);
    }
    await page.screenshot({ path: `test-results/review-theme-${theme}.png` });
  });
}
