/**
 * 绘制引擎
 * ---------------------------------------------------------------
 * 所有绘画类工具都落到这里，保证：
 *  - 绘画只发生在活动图层的「图像」或「蒙版」目标上；
 *  - 选区自动成为绘制范围限制；
 *  - 落笔坐标通过逆变换映射到图层局部像素空间，
 *    因此图层被缩放、旋转、扭曲后依然能正确落笔。
 */
import { applyMatrix, invertMatrix, layerMatrix } from '@/core/geometry';
import { sampleScalar } from '@/core/sampler';
import type { CompDocument, Layer, MaskBuffer, PixelBuffer, Point } from '@/types/document';

/** 绘制目标：图层 + 当前编辑面（图像或蒙版） */
export interface PaintTarget {
  layer: Layer;
  /** 正在编辑蒙版时为 true */
  onMask: boolean;
}

/** 落笔参数 */
export interface DabOptions {
  x: number;
  y: number;
  radius: number;
  hardness: number;
  opacity: number;
  color: [number, number, number, number];
  /** 橡皮擦模式：只降低 alpha */
  erase: boolean;
  /** 单调笔刷（画线时每一步都拉一条线） */
  flow: number;
}

/** 图层局部坐标 <-> 文档坐标 */
export function makeLayerMapping(layer: Layer): { toLocal: (p: Point) => Point; toDoc: (p: Point) => Point; scale: number } {
  const width = layer.kind === 'pixel' && layer.pixels ? layer.pixels.width : 1;
  const height = layer.kind === 'pixel' && layer.pixels ? layer.pixels.height : 1;
  const matrix = layerMatrix(layer.transform, width, height);
  const inverse = invertMatrix(matrix);
  return {
    toLocal: (p) => applyMatrix(inverse, p.x, p.y),
    toDoc: (p) => applyMatrix(matrix, p.x, p.y),
    scale: Math.max(0.05, Math.min(
      Math.abs(layer.transform.size[0] / Math.max(1, width)),
      Math.abs(layer.transform.size[1] / Math.max(1, height)),
    )),
  };
}

/** 选区覆盖率（文档坐标，0-1） */
function selectionCoverage(doc: CompDocument | null, x: number, y: number): number {
  const selection = doc?.selection ?? null;
  if (!selection) return 1;
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= selection.width || py >= selection.height) return 0;
  return selection.data[py * selection.width + px]! / 255;
}

/**
 * 画一笔（一个笔尖印记）。
 * @returns 实际影响到的包围盒（局部坐标），便于工具做局部刷新
 */
export function paintDab(document: CompDocument, target: PaintTarget, options: DabOptions): void {
  const { layer } = target;
  const mapping = makeLayerMapping(layer);
  const local = mapping.toLocal({ x: options.x, y: options.y });
  // 文档空间的笔刷半径换算到局部像素
  const radius = Math.max(0.5, options.radius / mapping.scale);
  if (target.onMask && layer.mask) {
    paintIntoMask(layer.mask.pixels, layer, local, radius, options);
    layer.contentKey += 1;
    return;
  }
  if (layer.kind !== 'pixel' || !layer.pixels) return;
  paintIntoPixels(layer.pixels, layer, document, local, radius, options);
  layer.contentKey += 1;
}

/** 在像素缓冲上绘制一个圆形笔尖 */
function paintIntoPixels(
  pixels: PixelBuffer,
  layer: Layer,
  document: CompDocument,
  center: Point,
  radius: number,
  options: DabOptions,
): void {
  const x0 = Math.max(0, Math.floor(center.x - radius));
  const x1 = Math.min(pixels.width - 1, Math.ceil(center.x + radius));
  const y0 = Math.max(0, Math.floor(center.y - radius));
  const y1 = Math.min(pixels.height - 1, Math.ceil(center.y + radius));
  const mapping = makeLayerMapping(layer);
  const inner = Math.max(0, Math.min(1, options.hardness));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x - center.x;
      const dy = y - center.y;
      const distance = Math.hypot(dx, dy) / radius;
      if (distance > 1) continue;
      // 硬度决定笔尖内部的实心比例
      let alpha = 1;
      if (distance > inner) alpha = 1 - (distance - inner) / Math.max(1e-4, 1 - inner);
      alpha *= options.opacity;
      if (alpha <= 0) continue;
      const docPoint = mapping.toDoc({ x, y });
      const coverage = selectionCoverage(document, docPoint.x, docPoint.y);
      if (coverage <= 0) continue;
      const k = alpha * coverage;
      const i = (y * pixels.width + x) * 4;
      if (options.erase) {
        pixels.data[i + 3] = pixels.data[i + 3]! * (1 - k);
      } else {
        pixels.data[i] = pixels.data[i]! * (1 - k) + options.color[0] * k;
        pixels.data[i + 1] = pixels.data[i + 1]! * (1 - k) + options.color[1] * k;
        pixels.data[i + 2] = pixels.data[i + 2]! * (1 - k) + options.color[2] * k;
        pixels.data[i + 3] = Math.min(255, pixels.data[i + 3]! * (1 - k) + options.color[3] * k);
      }
    }
  }
}

/** 在蒙版上绘制（蒙版为灰度，白=显示） */
function paintIntoMask(mask: MaskBuffer, layer: Layer, center: Point, radius: number, options: DabOptions): void {
  const x0 = Math.max(0, Math.floor(center.x - radius));
  const x1 = Math.min(mask.width - 1, Math.ceil(center.x + radius));
  const y0 = Math.max(0, Math.floor(center.y - radius));
  const y1 = Math.min(mask.height - 1, Math.ceil(center.y + radius));
  const mapping = makeLayerMapping(layer);
  const inner = Math.max(0, Math.min(1, options.hardness));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x - center.x;
      const dy = y - center.y;
      const distance = Math.hypot(dx, dy) / radius;
      if (distance > 1) continue;
      let alpha = 1;
      if (distance > inner) alpha = 1 - (distance - inner) / Math.max(1e-4, 1 - inner);
      alpha *= options.opacity;
      if (alpha <= 0) continue;
      const docPoint = mapping.toDoc({ x, y });
      if (selectionCoverage(documentRef.current, docPoint.x, docPoint.y) <= 0) continue;
      const index = y * mask.width + x;
      if (options.erase) {
        mask.data[index] = Math.max(0, mask.data[index]! - alpha * 255);
      } else {
        // 蒙版上绘制前景色：亮度即覆盖率
        const value = Math.max(options.color[0], Math.max(options.color[1], options.color[2]));
        mask.data[index] = Math.min(255, mask.data[index]! + (value / 255) * alpha * 255);
      }
    }
  }
}

// 画蒙版时需要访问文档（用于选区限制），这里用一个模块级引用避免层层传参
const documentRef: { current: CompDocument | null } = { current: null };
export function setPaintDocument(document: CompDocument | null): void {
  documentRef.current = document;
}

/** 仿制图章采样：从源位置取一块颜色 */
export function sampleForClone(
  document: CompDocument,
  layer: Layer,
  docX: number,
  docY: number,
  sampleAllLayers: boolean,
): [number, number, number, number] | null {
  if (sampleAllLayers) {
    void document;
    return null; // 由工具用合成结果采样
  }
  if (layer.kind !== 'pixel' || !layer.pixels) return null;
  const mapping = makeLayerMapping(layer);
  const local = mapping.toLocal({ x: docX, y: docY });
  const x = Math.floor(local.x);
  const y = Math.floor(local.y);
  if (x < 0 || y < 0 || x >= layer.pixels.width || y >= layer.pixels.height) return null;
  const i = (y * layer.pixels.width + x) * 4;
  return [layer.pixels.data[i]!, layer.pixels.data[i + 1]!, layer.pixels.data[i + 2]!, layer.pixels.data[i + 3]!];
}

/** 取局部坐标处的像素颜色 */
export function readLocalPixel(buffer: PixelBuffer, x: number, y: number): [number, number, number, number] {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= buffer.width || py >= buffer.height) return [0, 0, 0, 0];
  const i = (py * buffer.width + px) * 4;
  return [buffer.data[i]!, buffer.data[i + 1]!, buffer.data[i + 2]!, buffer.data[i + 3]!];
}

/** 单线性插值取局部颜色（供仿制与修复使用） */
export function sampleLocalPixel(buffer: PixelBuffer, x: number, y: number): [number, number, number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const c00 = readLocalPixel(buffer, x0, y0);
  const c10 = readLocalPixel(buffer, x0 + 1, y0);
  const c01 = readLocalPixel(buffer, x0, y0 + 1);
  const c11 = readLocalPixel(buffer, x0 + 1, y0 + 1);
  const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
  return [
    mix(mix(c00[0], c10[0], fx), mix(c01[0], c11[0], fx), fy),
    mix(mix(c00[1], c10[1], fx), mix(c01[1], c11[1], fx), fy),
    mix(mix(c00[2], c10[2], fx), mix(c01[2], c11[2], fx), fy),
    mix(mix(c00[3], c10[3], fx), mix(c01[3], c11[3], fx), fy),
  ];
}

/** 涂抹工具：把前一个位置的像素按比例带到当前位置 */
export function smudgeDab(buffer: PixelBuffer, center: Point, radius: number, strength: number): void {
  const x0 = Math.max(1, Math.floor(center.x - radius));
  const x1 = Math.min(buffer.width - 2, Math.ceil(center.x + radius));
  const y0 = Math.max(1, Math.floor(center.y - radius));
  const y1 = Math.min(buffer.height - 2, Math.ceil(center.y + radius));
  const inner = Math.max(0, Math.min(1, (radius - 1) / Math.max(1, radius)));
  const snapshot = new Uint8ClampedArray(buffer.data);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x - center.x;
      const dy = y - center.y;
      const distance = Math.hypot(dx, dy) / radius;
      if (distance > 1) continue;
      const falloff = distance <= inner ? 1 : 1 - (distance - inner) / Math.max(1e-4, 1 - inner);
      const i = (y * buffer.width + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const previous = snapshot[(y * buffer.width + x - 1) * 4 + c]!;
        buffer.data[i + c] = previous * (strength * falloff) + buffer.data[i + c]! * (1 - strength * falloff);
      }
    }
  }
}

/** 变形（液化））：以 center 为中心按 direction 位移像素，twirl 为环绕旋转强度 */
export function warpRegion(buffer: PixelBuffer, center: Point, radius: number, dx: number, dy: number, twirl: number): void {
  const x0 = Math.max(0, Math.floor(center.x - radius));
  const x1 = Math.min(buffer.width - 1, Math.ceil(center.x + radius));
  const y0 = Math.max(0, Math.floor(center.y - radius));
  const y1 = Math.min(buffer.height - 1, Math.ceil(center.y + radius));
  const snapshot = new Uint8ClampedArray(buffer.data);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const px = x - center.x;
      const py = y - center.y;
      const distance = Math.hypot(px, py);
      if (distance > radius) continue;
      const falloff = 1 - distance / radius;
      let sx = x;
      let sy = y;
      if (twirl !== 0) {
        const angle = twirl * falloff;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        sx = center.x + px * cos - py * sin;
        sy = center.y + px * sin + py * cos;
      } else {
        sx = x - dx * falloff;
        sy = y - dy * falloff;
      }
      const sxi = Math.max(0, Math.min(buffer.width - 1, Math.floor(sx)));
      const syi = Math.max(0, Math.min(buffer.height - 1, Math.floor(sy)));
      const si = (syi * buffer.width + sxi) * 4;
      const di = (y * buffer.width + x) * 4;
      for (let c = 0; c < 4; c += 1) buffer.data[di + c] = snapshot[si + c]!;
    }
  }
}

/** 采样选区或像素的单通道值 */
export function sampleMask(mask: MaskBuffer, x: number, y: number): number {
  return sampleScalar(mask.data, mask.width, mask.height, x, y);
}

/** 把画笔笔尖按间距沿线段插值（避免快速拖动时断点） */
export function dabAlongLine(
  document: CompDocument,
  target: PaintTarget,
  from: Point,
  to: Point,
  spacing: number,
  options: Omit<DabOptions, 'x' | 'y'>,
): void {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, spacing)));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    paintDab(document, target, {
      ...options,
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      opacity: options.opacity / Math.max(1, steps * 0.35),
    });
  }
}
