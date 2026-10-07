import { test, expect } from '@playwright/test';
import { createDocument, createPixelLayer } from '../../src/core/document';
import { buildLayerSurface, compositeDocument, renderLayerThumbnail } from '../../src/core/engine/compositor';
import { resolveRenderScale } from '../../src/core/engine/renderer';
import type { PixelBuffer } from '../../src/types/document';

function quadrantPixels(width: number, height: number): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  const colors = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    data.set(colors[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)], (y * width + x) * 4);
  }
  return { width, height, data };
}
function rgba(buffer: PixelBuffer, x: number, y: number) {
  return Array.from(buffer.data.slice((y * buffer.width + x) * 4, (y * buffer.width + x) * 4 + 4));
}

for (const scale of [0.25, 0.5, 1, 2]) {
  test(`图层四象限在合成比例 ${scale} 下保持完整位置`, () => {
    const doc = createDocument(64, 32);
    doc.layers.push(createPixelLayer('四象限', quadrantPixels(64, 32)));
    const buffer = compositeDocument(doc, undefined, undefined, { scale }).buffer;
    expect(rgba(buffer, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(rgba(buffer, buffer.width - 3, 2)).toEqual([0, 255, 0, 255]);
    expect(rgba(buffer, 2, buffer.height - 3)).toEqual([0, 0, 255, 255]);
    expect(rgba(buffer, buffer.width - 3, buffer.height - 3)).toEqual([255, 255, 255, 255]);
    for (let i = 3; i < buffer.data.length; i += 4) expect(buffer.data[i]).toBe(255);
  });
}

test('平移且缩放的图层在预览中保持正确文档边界', () => {
  const doc = createDocument(128, 96);
  const layer = createPixelLayer('偏移', quadrantPixels(32, 16));
  layer.transform.origin = [16, 24];
  layer.transform.size = [64, 32];
  doc.layers.push(layer);
  const buffer = compositeDocument(doc, undefined, undefined, { scale: 0.5 }).buffer;
  expect(rgba(buffer, 10, 14)).toEqual([255, 0, 0, 255]);
  expect(rgba(buffer, 37, 14)).toEqual([0, 255, 0, 255]);
  expect(rgba(buffer, 10, 25)).toEqual([0, 0, 255, 255]);
  expect(rgba(buffer, 37, 25)).toEqual([255, 255, 255, 255]);
  expect(rgba(buffer, 5, 5)[3]).toBe(0);
  expect(rgba(buffer, 45, 30)[3]).toBe(0);
});

test('1:1 高质量采样不偏移、不混合相邻像素', () => {
  const source = { width: 3, height: 2, data: new Uint8ClampedArray([
    255,0,0,255, 0,255,0,255, 0,0,255,255,
    255,255,0,255, 0,255,255,255, 255,0,255,255,
  ]) };
  const surface = buildLayerSurface(createPixelLayer('原像素', source))!;
  expect(Array.from(surface.buffer.data)).toEqual(Array.from(source.data));
});

test('缩略图显示整幅图像而不是左上角裁切', () => {
  const buffer = renderLayerThumbnail(createPixelLayer('四象限', quadrantPixels(128, 64)), 32);
  expect(rgba(buffer, 4, 10)).toEqual([255, 0, 0, 255]);
  expect(rgba(buffer, 27, 10)).toEqual([0, 255, 0, 255]);
  expect(rgba(buffer, 4, 21)).toEqual([0, 0, 255, 255]);
  expect(rgba(buffer, 27, 21)).toEqual([255, 255, 255, 255]);
  expect(rgba(buffer, 16, 2)[3]).toBe(0);
});

for (const dpr of [1, 2]) {
  test(`新建白色画布全区域无透明棋盘格 DPR=${dpr}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1245, height: 768 }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    try {
      await page.goto('/');
      await page.locator('.start-page .card.primary').click();
      await expect(page.locator('.cmp-stage canvas.main')).toBeVisible();
      const pixels = async () => page.locator('.cmp-stage canvas.main').evaluate((el) => {
        const canvas = el as HTMLCanvasElement;
        const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        let white = 0; let checker = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] === 255 && data[i+1] === 255 && data[i+2] === 255) white++;
          if (data[i] === 204 && data[i+1] === 204 && data[i+2] === 204) checker++;
        }
        return { white, checker };
      });
      await expect.poll(async () => (await pixels()).white).toBeGreaterThan(100000);
      await expect.poll(async () => (await pixels()).checker).toBe(0);
      await page.screenshot({ path: `test-results/white-canvas-dpr-${dpr}.png` });
      await page.locator('.menu-title').filter({ hasText: '视图' }).hover();
      await page.getByText('缩小', { exact: true }).click();
      await expect.poll(async () => (await pixels()).checker).toBe(0);
      await page.locator('.menu-title').filter({ hasText: '视图' }).hover();
      await page.getByText('实际像素', { exact: true }).click();
      await expect(page.locator('.zoom')).toHaveText('100%');
      await expect.poll(async () => (await pixels()).checker).toBe(0);
      // 真正隐藏背景仍显示透明棋盘格，不能用整块白色覆盖来掩盖合成错误。
      await page.locator('.layer-row .icon-btn').first().click();
      await expect.poll(async () => (await pixels()).checker).toBeGreaterThan(100000);
      await page.locator('.layer-row .icon-btn').first().click();
      await expect.poll(async () => (await pixels()).checker).toBe(0);
    } finally { await context.close(); }
  });
}


test('预览分辨率随缩放减小，不把缩小视图变成放大合成', () => {
  const doc = { width: 1920, height: 1080 };
  expect(resolveRenderScale(doc, 0.55)).toBe(0.5);
  expect(resolveRenderScale(doc, 0.3)).toBe(0.25);
  expect(resolveRenderScale(doc, 0.15)).toBe(0.125);
  expect(resolveRenderScale(doc, 1)).toBe(1);
  expect(resolveRenderScale(doc, 2)).toBe(1);
  const large = { width: 12000, height: 8000 };
  const scale = resolveRenderScale(large, 1);
  expect(large.width * large.height * scale * scale).toBeLessThanOrEqual(16000000);
});


for (const scale of [0.25, 0.5, 1, 2]) {
  test(`带外部效果的图层在比例 ${scale} 下不再次缩放或裁切`, () => {
    const doc = createDocument(64, 64);
    const layer = createPixelLayer('白块与红色投影', { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4).fill(255) });
    layer.transform.origin = [16, 16];
    layer.effects = { shadow: { enabled: true, angle: 0, distance: 8, blur: 0, color: [255, 0, 0], opacity: 1 } };
    doc.layers.push(layer);
    const buffer = compositeDocument(doc, undefined, undefined, { scale }).buffer;
    expect(rgba(buffer, 20 * scale, 24 * scale)).toEqual([255, 255, 255, 255]);
    expect(rgba(buffer, 36 * scale, 24 * scale)).toEqual([255, 0, 0, 255]);
    expect(rgba(buffer, 44 * scale, 24 * scale)[3]).toBe(0);
    layer.effects.shadow!.opacity = 0;
    const withoutShadow = compositeDocument(doc, undefined, undefined, { scale }).buffer;
    expect(rgba(withoutShadow, 28 * scale, 28 * scale)).toEqual([255, 255, 255, 255]);
  });
}
