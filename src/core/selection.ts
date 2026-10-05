/**
 * 选区模型
 * ---------------------------------------------------------------
 * 选区本质是与文档等大的 8 位覆盖率蒙版（0-255），
 * 所有绘制与调整都乘以这张蒙版，从而天然实现「有选区时限制在选区内」。
 * outline 保存矢量工具的轮廓点，供再次编辑与显示使用。
 */
import type { Point, Rect, SelectionMask } from '@/types/document';

/** 创建全选 */
export function createSelection(width: number, height: number, value = 255): SelectionMask {
  const data = new Uint8Array(width * height);
  if (value !== 0) data.fill(value);
  return { width, height, data, outline: null };
}

/** 由矩形生成选区（不含羽化） */
export function selectionFromRect(width: number, height: number, rect: Rect): SelectionMask {
  const selection = createSelection(width, height, 0);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) selection.data[y * width + x] = 255;
  }
  selection.outline = rectToPath(rect);
  return selection;
}

export function rectToPath(rect: Rect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

/** 椭圆选区：rect 为外接矩形 */
export function selectionFromEllipse(width: number, height: number, rect: Rect): SelectionMask {
  const selection = createSelection(width, height, 0);
  const rx = rect.width / 2;
  const ry = rect.height / 2;
  const cx = rect.x + rx;
  const cy = rect.y + ry;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const nx = (x + 0.5 - cx) / Math.max(1e-6, rx);
      const ny = (y + 0.5 - cy) / Math.max(1e-6, ry);
      if (nx * nx + ny * ny <= 1) selection.data[y * width + x] = 255;
    }
  }
  selection.outline = ellipseToPath(rect, 64);
  return selection;
}

export function ellipseToPath(rect: Rect, segments = 64): Point[] {
  const points: Point[] = [];
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    points.push({ x: cx + Math.cos(angle) * rect.width / 2, y: cy + Math.sin(angle) * rect.height / 2 });
  }
  return points;
}

/** 多边形/套索：由路径点填充（even-odd 规则） */
export function selectionFromPath(width: number, height: number, path: Point[]): SelectionMask {
  const selection = createSelection(width, height, 0);
  if (path.length < 3) return selection;
  const minY = Math.max(0, Math.floor(Math.min(...path.map((p) => p.y))));
  const maxY = Math.min(height, Math.ceil(Math.max(...path.map((p) => p.y))) + 1);
  const minX = Math.max(0, Math.floor(Math.min(...path.map((p) => p.x))));
  const maxX = Math.min(width, Math.ceil(Math.max(...path.map((p) => p.x))) + 1);
  const xs: number[] = [];
  for (let y = minY; y < maxY; y += 1) {
    xs.length = 0;
    const py = y + 0.5;
    for (let i = 0, j = path.length - 1; i < path.length; j = i, i += 1) {
      const a = path[i];
      const b = path[j];
      if ((a.y > py) === (b.y > py)) continue;
      xs.push(a.x + ((py - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const sx = Math.max(minX, Math.floor(xs[k]));
      const ex = Math.min(maxX, Math.ceil(xs[k + 1]));
      for (let x = sx; x < ex; x += 1) selection.data[y * width + x] = 255;
    }
  }
  selection.outline = path;
  return selection;
}

/** 选区布尔运算 */
export function combineSelection(
  base: SelectionMask | null,
  next: SelectionMask,
  mode: 'replace' | 'add' | 'subtract' | 'intersect',
): SelectionMask {
  if (!base || mode === 'replace') return next;
  const data = new Uint8Array(base.data.length);
  for (let i = 0; i < data.length; i += 1) {
    const a = base.data[i];
    const b = next.data[i];
    let value = a;
    if (mode === 'add') value = Math.min(255, a + b);
    else if (mode === 'subtract') value = Math.max(0, a - b);
    else if (mode === 'intersect') value = Math.round((a * b) / 255);
    data[i] = value;
  }
  return { width: base.width, height: base.height, data, outline: next.outline };
}

/** 反相 */
export function invertSelection(selection: SelectionMask): SelectionMask {
  const data = new Uint8Array(selection.data.length);
  for (let i = 0; i < data.length; i += 1) data[i] = 255 - selection.data[i];
  return { width: selection.width, height: selection.height, data, outline: selection.outline };
}

/** 羽化：高斯模糊覆盖率蒙版 */
export function featherSelection(selection: SelectionMask, radius: number): SelectionMask {
  if (radius <= 0) return selection;
  const blurred = blurMaskData(selection, radius);
  return { width: selection.width, height: selection.height, data: blurred, outline: null };
}

/** 可分离高斯（三次盒式模糊近似），用于蒙版羽化与模糊类调整 */
export function gaussianBlurMask(data: Uint8Array, width: number, height: number, radius: number): Uint8Array<ArrayBuffer> {
  return blurMaskData({ width, height, data }, radius);
}

function blurMaskData(mask: { width: number; height: number; data: Uint8Array }, radius: number): Uint8Array<ArrayBuffer> {
  const { width, height } = mask;
  // 三次盒式模糊逼近高斯
  const boxes = Math.max(1, Math.min(3, Math.round(Math.sqrt((12 * radius * radius) / 3) + 0.5)));
  const boxRadius = Math.max(1, Math.round((radius * 3 * Math.sqrt(2 * Math.PI) / 4 / boxes) - 0.5));
  let src = Float32Array.from(mask.data);
  let dst = new Float32Array(src.length);
  for (let pass = 0; pass < boxes; pass += 1) {
    boxBlurH(src, dst, width, height, boxRadius);
    boxBlurV(dst, src, width, height, boxRadius);
  }
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 1) out[i] = src[i];
  return out;
}

function boxBlurH(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number): void {
  const window = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    const row = y * width;
    for (let i = -radius; i <= radius; i += 1) sum += src[row + Math.min(width - 1, Math.max(0, i))];
    for (let x = 0; x < width; x += 1) {
      dst[row + x] = sum / window;
      const add = src[row + Math.min(width - 1, x + radius + 1)];
      const sub = src[row + Math.max(0, x - radius)];
      sum += add - sub;
    }
  }
}

function boxBlurV(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number): void {
  const window = radius * 2 + 1;
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let i = -radius; i <= radius; i += 1) sum += src[Math.min(height - 1, Math.max(0, i)) * width + x];
    for (let y = 0; y < height; y += 1) {
      dst[y * width + x] = sum / window;
      const add = src[Math.min(height - 1, y + radius + 1) * width + x];
      const sub = src[Math.max(0, y - radius) * width + x];
      sum += add - sub;
    }
  }
}

/** 选区的紧致包围盒（全透明区域会被排除） */
export function selectionBounds(selection: SelectionMask): Rect | null {
  const { width, height, data } = selection;
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** 选区是否为空 */
export function isSelectionEmpty(selection: SelectionMask | null): boolean {
  if (!selection) return true;
  for (let i = 0; i < selection.data.length; i += 1) if (selection.data[i] > 0) return false;
  return true;
}

/**
 * 游程编码描边：从掩码提取 0.5 级别的等值线段，用于蚂蚁线显示。
 * 返回线段数组（文档坐标）。
 */
export function marchingSegments(selection: SelectionMask, threshold = 128): Point[][] {
  const { width, height, data } = selection;
  const segments: Point[][] = [];
  const inside = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    return data[y * width + x] >= threshold;
  };
  // 采用简单的单元分解：每个像素的四条边分别比较内外
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const center = inside(x, y);
      const top = inside(x, y - 1);
      const bottom = inside(x, y + 1);
      const left = inside(x - 1, y);
      const right = inside(x + 1, y);
      if (center !== top) segments.push([{ x, y }, { x: x + 1, y }]);
      if (center !== bottom) segments.push([{ x, y: y + 1 }, { x: x + 1, y: y + 1 }]);
      if (center !== left) segments.push([{ x, y }, { x, y: y + 1 }]);
      if (center !== right) segments.push([{ x: x + 1, y }, { x: x + 1, y: y + 1 }]);
    }
  }
  return segments;
}

/** 覆盖率采样（0-1），越界返回 0 */
export function sampleSelection(selection: SelectionMask | null, x: number, y: number): number {
  if (!selection) return 1;
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= selection.width || py >= selection.height) return 0;
  return selection.data[py * selection.width + px] / 255;
}

/** 选区统计：像素数与覆盖率 */
export function selectionCoverage(selection: SelectionMask | null, width: number, height: number): { pixels: number; ratio: number } {
  if (!selection) return { pixels: width * height, ratio: 1 };
  let sum = 0;
  for (let i = 0; i < selection.data.length; i += 1) sum += selection.data[i];
  return { pixels: Math.round(sum / 255), ratio: sum / 255 / (width * height) };
}
