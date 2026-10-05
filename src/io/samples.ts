/**
 * 示例工程
 * ---------------------------------------------------------------
 * 全部由代码即时生成（不依赖任何外部素材），
 * 分别演示渐变与形状、图层组与蒙版与混合模式、调整层三块能力。
 */
import { createAdjustmentLayer, createDocument, createGroupLayer, createPixelLayer, insertLayer } from '@/core/document';
import { createBuffer, createMask } from '@/core/pixels';
import { defaultTextMeta, renderText } from '@/core/engine/text';
import { gradientMapColor } from '@/core/filters/adjust';
import type { CompDocument, PixelBuffer } from '@/types/document';

/** 示例工程定义 */
export interface SampleDefinition {
  id: string;
  name: string;
  description: string;
  build: () => CompDocument;
}

/** 生成一张横向渐变像素层 */
function gradientLayer(width: number, height: number, from: [number, number, number], to: [number, number, number]): PixelBuffer {
  const buffer = createBuffer(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = x / Math.max(1, width - 1);
      const i = (y * width + x) * 4;
      buffer.data[i] = from[0] + (to[0] - from[0]) * t;
      buffer.data[i + 1] = from[1] + (to[1] - from[1]) * t;
      buffer.data[i + 2] = from[2] + (to[2] - from[2]) * t;
      buffer.data[i + 3] = 255;
    }
  }
  return buffer;
}

/** 生成一个同心圆点阵层（演示蒙版） */
function dotsLayer(width: number, height: number, spacing: number, radius: number, color: [number, number, number]): PixelBuffer {
  const buffer = createBuffer(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cx = Math.round(x / spacing) * spacing;
      const cy = Math.round(y / spacing) * spacing;
      if (Math.hypot(x - cx, y - cy) > radius) continue;
      const i = (y * width + x) * 4;
      buffer.data[i] = color[0];
      buffer.data[i + 1] = color[1];
      buffer.data[i + 2] = color[2];
      buffer.data[i + 3] = 255;
    }
  }
  return buffer;
}

/** 示例一：渐变 + 文字 + 形状 */
function buildGradientSample(): CompDocument {
  const document = createDocument(1600, 900, '示例 · 渐变与文字');
  const background = createPixelLayer('背景渐变', gradientLayer(document.width, document.height, [36, 62, 120], [186, 84, 148]));
  insertLayer(document, background);

  const sun = createPixelLayer('圆形', dotsLayer(document.width, document.height, 1000, 220, [250, 210, 120]));
  sun.transform.origin = [1010, 120];
  sun.transform.size = [440, 440];
  sun.pixels = dotsLayer(440, 440, 1000, 220, [250, 210, 120]);
  sun.transform.sampling = 'High quality';
  sun.effects = {
    shadow: { enabled: true, angle: 120, distance: 24, blur: 30, color: [0, 0, 0], opacity: 0.45 },
    colorOverlay: { enabled: true, color: [255, 236, 180], opacity: 0.35 },
  };
  insertLayer(document, sun);

  const meta = defaultTextMeta('合成器');
  meta.fontSize = 220;
  meta.color = [255, 255, 255];
  meta.tracking = 12;
  const textPixels = renderText(meta);
  const textLayer = createPixelLayer('标题文字', textPixels, { text: meta });
  textLayer.transform.origin = [120, 300];
  insertLayer(document, textLayer);

  const subtitle = defaultTextMeta('Vue 3 · otools 插件 · 跨平台图像编辑器');
  subtitle.fontSize = 48;
  subtitle.color = [240, 240, 255];
  const subtitlePixels = renderText(subtitle);
  const subtitleLayer = createPixelLayer('副标题', subtitlePixels, { text: subtitle });
  subtitleLayer.transform.origin = [126, 560];
  insertLayer(document, subtitleLayer);

  document.activeLayerId = subtitleLayer.id;
  document.selection = null;
  return document;
}

/** 示例二：组 + 蒙版 + 混合模式 */
function buildMaskSample(): CompDocument {
  const document = createDocument(1400, 900, '示例 · 图层组与蒙版');
  const background = createPixelLayer('背景', (() => {
    const buffer = createBuffer(document.width, document.height, [22, 26, 38, 255]);
    return buffer;
  })());
  insertLayer(document, background);

  const group = createGroupLayer('光效');
  insertLayer(document, group);

  const glow = createPixelLayer('光斑（Screen）', gradientLayer(document.width, document.height, [255, 120, 40], [255, 220, 120]));
  glow.blendMode = 'Screen';
  glow.opacity = 0.8;
  insertLayer(document, glow);
  glow.parentId = group.id;

  const dots = createPixelLayer('点阵（点住 Alt 拖图层名可测试复制）', dotsLayer(document.width, document.height, 90, 26, [120, 220, 255]));
  dots.blendMode = 'Color Dodge';
  // 给点阵加一个渐隐蒙版，演示蒙版
  const mask = createMask(dots.pixels!.width, dots.pixels!.height, 255);
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      const t = 1 - x / Math.max(1, mask.width);
      mask.data[y * mask.width + x] = Math.round(255 * Math.max(0, t ** 0.6));
    }
  }
  dots.mask = { pixels: mask, enabled: true, linked: true, placement: null, target: 'mask', inverted: false };
  dots.parentId = group.id;
  document.layers.push(dots);

  group.expanded = true;
  document.activeLayerId = dots.id;
  return document;
}

/** 示例三：调整层 */
function buildAdjustmentSample(): CompDocument {
  const document = createDocument(1200, 800, '示例 · 调整层');
  const base = createPixelLayer('原始照片位', (() => {
    const buffer = createBuffer(document.width, document.height);
    for (let y = 0; y < document.height; y += 1) {
      for (let x = 0; x < document.width; x += 1) {
        const t = x / document.width + y / document.height;
        const color = gradientMapColor({ shadows: [20, 30, 60], mids: [190, 90, 70], highlights: [250, 220, 160], reversed: false }, Math.round(t * 255));
        const i = (y * document.width + x) * 4;
        buffer.data[i] = color[0];
        buffer.data[i + 1] = color[1];
        buffer.data[i + 2] = color[2];
        buffer.data[i + 3] = 255;
      }
    }
    return buffer;
  })());
  insertLayer(document, base);

  const hue = createAdjustmentLayer('Hue/Saturation', document, '色相/饱和度');
  hue.adjustment.hue = -18;
  hue.adjustment.saturation = 25;
  insertLayer(document, hue);

  const curves = createAdjustmentLayer('Curves', document, '曲线');
  curves.adjustment.curves.channels[1]!.points = [[0, 0], [90, 70], [200, 215], [255, 255]];
  insertLayer(document, curves);

  const levels = createAdjustmentLayer('Levels', document, '色阶');
  levels.adjustment.levels.ranges[0] = { black: 12, gamma: 1.05, white: 248, outputBlack: 0, outputWhite: 255 };
  insertLayer(document, levels);

  const vignetteLayer = createAdjustmentLayer('Invert', document, '反相（关掉可见性即可对比）');
  vignetteLayer.isVisible = false;
  insertLayer(document, vignetteLayer);

  document.activeLayerId = levels.id;
  return document;
}

/** 全部示例 */
export const SAMPLES: SampleDefinition[] = [
  { id: 'gradient', name: '示例 · 渐变与文字', description: '渐变背景、圆形图层效果、可编辑文字图层', build: buildGradientSample },
  { id: 'mask', name: '示例 · 图层组与蒙版', description: '图层组、Screen / Color Dodge 混合模式、渐隐蒙版', build: buildMaskSample },
  { id: 'adjustment', name: '示例 · 调整层', description: '色相/饱和度、曲线、色阶等调整层叠加', build: buildAdjustmentSample },
];

/** 按 id 生成示例文档 */
export function buildSample(id: string): CompDocument | null {
  const sample = SAMPLES.find((item) => item.id === id);
  return sample ? sample.build() : null;
}
