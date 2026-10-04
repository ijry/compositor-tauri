/**
 * 选区运算
 * ---------------------------------------------------------------
 * 扩展/收缩/边界、图层透明度转选区、魔棒、色彩范围、选择主体。
 * 覆盖率统一保持在 0-255，内部运算用 0/1 的二值图再羽化回软边。
 */
import { fastLuma } from '@/core/color';
import { createSelection, gaussianBlurMask } from '@/core/selection';
import type { MaskBuffer, PixelBuffer, Point, Rect, SelectionMask } from '@/types/document';

/** 取二值图（阈值 128） */
function toBinary(selection: SelectionMask): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(selection.data.length);
  for (let i = 0; i < out.length; i += 1) out[i] = selection.data[i] >= 128 ? 1 : 0;
  return out;
}

function fromBinary(binary: Uint8Array, width: number, height: number, soft = 0.5): SelectionMask {
  const data = new Uint8Array(binary.length);
  const value = Math.round(255 * soft);
  for (let i = 0; i < binary.length; i += 1) data[i] = binary[i] ? value : 0;
  return { width, height, data, outline: null };
}

/** 形态学膨胀（结构元为方形） */
function dilate(binary: Uint8Array<ArrayBuffer>, width: number, height: number, radius: number): Uint8Array<ArrayBuffer> {
  if (radius <= 0) return binary;
  const temp = new Uint8Array(binary.length);
  const out = new Uint8Array(binary.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (let k = -radius; k <= radius && !value; k += 1) {
        const sx = Math.min(width - 1, Math.max(0, x + k));
        if (binary[y * width + sx]) value = 1;
      }
      temp[y * width + x] = value;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (let k = -radius; k <= radius && !value; k += 1) {
        const sy = Math.min(height - 1, Math.max(0, y + k));
        if (temp[sy * width + x]) value = 1;
      }
      out[y * width + x] = value;
    }
  }
  return out;
}

/** 形态学腐蚀 */
function erode(binary: Uint8Array<ArrayBuffer>, width: number, height: number, radius: number): Uint8Array<ArrayBuffer> {
  if (radius <= 0) return binary;
  const inverted = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) inverted[i] = binary[i] ? 0 : 1;
  const grown = dilate(inverted, width, height, radius);
  const out = new Uint8Array(grown.length);
  for (let i = 0; i < grown.length; i += 1) out[i] = grown[i] ? 0 : 1;
  return out;
}

/** 扩展选区 */
export function expandSelection(selection: SelectionMask, amount: number): SelectionMask {
  const binary = toBinary(selection);
  const grown = dilate(binary, selection.width, selection.height, Math.max(1, Math.round(amount)));
  return fromBinary(grown, selection.width, selection.height);
}

/** 收缩选区 */
export function contractSelection(selection: SelectionMask, amount: number): SelectionMask {
  const binary = toBinary(selection);
  const shrunk = erode(binary, selection.width, selection.height, Math.max(1, Math.round(amount)));
  return fromBinary(shrunk, selection.width, selection.height);
}

/** 选区边界 */
export function selectBoundary(selection: SelectionMask): SelectionMask {
  const binary = toBinary(selection);
  const grown = dilate(binary, selection.width, selection.height, 1);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = grown[i] && !binary[i] ? 1 : 0;
  // 边界用软灰表示（Photoshop 边界为半灰）
  const data = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i += 1) data[i] = out[i] ? 128 : 0;
  return { width: selection.width, height: selection.height, data, outline: null };
}

/** 选区羽化 */
export function featherSelectionMask(selection: SelectionMask, radius: number): SelectionMask {
  const data = gaussianBlurMask(selection.data, selection.width, selection.height, radius);
  return { width: selection.width, height: selection.height, data, outline: null };
}

/** 由图层像素的 alpha 生成选区（可选羽化） */
export function selectionFromLayerAlpha(pixels: PixelBuffer, feather = 0): SelectionMask {
  const width = pixels.width;
  const height = pixels.height;
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i += 1) data[i] = pixels.data[i * 4 + 3];
  const base: SelectionMask = { width, height, data, outline: null };
  return feather > 0 ? featherSelectionMask(base, feather) : base;
}

/** 由图层蒙版生成选区 */
export function selectionFromMask(mask: MaskBuffer, feather = 0): SelectionMask {
  const data = new Uint8Array(mask.data);
  const base: SelectionMask = { width: mask.width, height: mask.height, data, outline: null };
  return feather > 0 ? featherSelectionMask(base, feather) : base;
}

/** 魔棒参数 */
export interface WandOptions {
  tolerance: number;
  contiguous: boolean;
  /** 采样所有图层（true）或仅当前图层（false） */
  sampleAllLayers: boolean;
  /** antiAlias 边缘半像素羽化 */
  feather: number;
}

/** 魔棒：按颜色容差选择 */
export function magicWand(source: PixelBuffer, x: number, y: number, options: WandOptions): SelectionMask {
  const { width, height } = source;
  const data = new Uint8Array(width * height);
  if (x < 0 || y < 0 || x >= width || y >= height) return { width, height, data, outline: null };
  const tolerance = Math.max(0, options.tolerance) * 4.4; // 0-100 -> 大致色差阈值
  const index = (y * width + x) * 4;
  const r0 = source.data[index];
  const g0 = source.data[index + 1];
  const b0 = source.data[index + 2];
  const a0 = source.data[index + 3];
  const matches = (index2: number): boolean => {
    const dr = source.data[index2] - r0;
    const dg = source.data[index2 + 1] - g0;
    const db = source.data[index2 + 2] - b0;
    const da = (source.data[index2 + 3] - a0) * 0.5;
    return Math.sqrt(dr * dr + dg * dg + db * db + da * da) <= tolerance;
  };
  if (options.contiguous) {
    // 4 邻域洪水填充，显式栈避免递归爆栈
    const stack: number[] = [x + y * width];
    const visited = new Uint8Array(width * height);
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited[current]) continue;
      visited[current] = 1;
      if (!matches(current * 4)) continue;
      data[current] = 255;
      const cx = current % width;
      const cy = (current / width) | 0;
      if (cx > 0) stack.push(current - 1);
      if (cx < width - 1) stack.push(current + 1);
      if (cy > 0) stack.push(current - width);
      if (cy < height - 1) stack.push(current + width);
    }
  } else {
    for (let i = 0; i < data.length; i += 1) {
      if (matches(i * 4)) data[i] = 255;
    }
  }
  const base: SelectionMask = { width, height, data, outline: null };
  return options.feather > 0 ? featherSelectionMask(base, options.feather) : base;
}

/** 色彩范围参数 */
export interface ColorRangeOptions {
  hue: number;
  hueRange: number;
  saturation: number;
  saturationRange: number;
  /** 预览半径（羽化），模仿 Photoshop 的预览模糊 */
  feather: number;
}

/** 色彩范围：按 HSL 区间选择 */
export function colorRangeSelection(source: PixelBuffer, options: ColorRangeOptions): SelectionMask {
  const { width, height } = source;
  const data = new Uint8Array(width * height);
  const hueRange = Math.max(1, options.hueRange);
  const satRange = Math.max(1, options.saturationRange);
  for (let i = 0; i < data.length; i += 1) {
    const p = i * 4;
    const r = source.data[p] / 255;
    const g = source.data[p + 1] / 255;
    const b = source.data[p + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let hue = 0;
    if (d !== 0) {
      if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      else if (max === g) hue = ((b - r) / d + 2) * 60;
      else hue = ((r - g) / d + 4) * 60;
    }
    const sat = max === 0 ? 0 : d / max;
    const satScore = 100 - Math.min(100, (Math.abs(sat * 100 - options.saturation) / satRange) * 100);
    const hueDistance = Math.abs(((hue - options.hue + 540) % 360) - 180);
    const hueScore = 100 - Math.min(100, (hueDistance / hueRange) * 100);
    const score = Math.min(hueScore, satScore);
    data[i] = Math.max(0, Math.min(255, Math.round(score * 2.55)));
  }
  const base: SelectionMask = { width, height, data, outline: null };
  return options.feather > 0 ? featherSelectionMask(base, options.feather) : base;
}

/**
 * 选择主体
 * ---------------------------------------------------------------
 * 启发式流程（无需模型文件，纯像素分析）：
 *  1. 用四周边框像素建立背景颜色模型（量���直方图 + 最近色距���）；
 *  2. 计算每个像素与背景模型的差异，得到显著图；
 *  3. 阈值 + 形态学闭运算去掉噪点；
 *  4. 取面积最大的连通域作为主体，中心偏置用于排除贴边背景；
 *  5. 最后轻微羽化得到软边。
 */
export function selectSubject(source: PixelBuffer, sensitivity = 50): SelectionMask {
  const { width, height } = source;
  const total = width * height;
  const saliency = new Float32Array(total);
  // 背景模型：边框 5% 区域的量化颜色直方图
  const border = Math.max(2, Math.round(Math.min(width, height) * 0.05));
  const histogram = new Map<number, number>();
  const addSample = (x: number, y: number): void => {
    const p = (y * width + x) * 4;
    if (source.data[p + 3] < 8) return;
    const key = ((source.data[p] >> 4) << 8) | ((source.data[p + 1] >> 4) << 4) | (source.data[p + 2] >> 4);
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < width; x += 1) {
    for (let k = 0; k < border; k += 1) {
      addSample(x, k);
      addSample(x, height - 1 - k);
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let k = 0; k < border; k += 1) {
      addSample(k, y);
      addSample(width - 1 - k, y);
    }
  }
  const isBackground = (r: number, g: number, b: number): boolean => {
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const count = histogram.get(key) ?? 0;
    if (count > 0) return true;
    // 检查 3x3 邻域桶，避免量化边界
    let best = 0;
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dg = -1; dg <= 1; dg += 1) {
        const nr = Math.max(0, Math.min(15, (r >> 4) + dr));
        const ng = Math.max(0, Math.min(15, (g >> 4) + dg));
        const nb = Math.max(0, Math.min(15, b >> 4));
        const k2 = (nr << 8) | (ng << 4) | nb;
        best = Math.max(best, histogram.get(k2) ?? 0);
      }
    }
    return best > 0;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      const r = source.data[p];
      const g = source.data[p + 1];
      const b = source.data[p + 2];
      const a = source.data[p + 3];
      // 中心偏置：越靠中心越可能是主体
      const cx = (x / width - 0.5) * 2;
      const cy = (y / height - 0.5) * 2;
      const centerBias = 1 - Math.min(1, Math.sqrt(cx * cx + cy * cy) / 1.42);
      const background = isBackground(r, g, b) ? 1 : 0;
      let score = background ? 0 : 1;
      // 边缘梯度越高越可能是主体边界
      const right = source.data[p + 4] ?? r;
      const down = source.data[p + width * 4] ?? r;
      const gradient = Math.abs(r - right) + Math.abs(g - (source.data[p + 5] ?? g)) + Math.abs(b - (source.data[p + 6] ?? b));
      const edge = Math.min(1, gradient / 90);
      score = score * (0.55 + 0.45 * centerBias) + edge * 0.25;
      if (a < 8) score *= a / 8;
      saliency[y * width + x] = Math.max(0, Math.min(1, score));
      void down;
    }
  }
  // 阈值化：敏感度越高阈值越低
  const threshold = 0.62 - (sensitivity / 100) * 0.28;
  let binary: Uint8Array<ArrayBuffer> = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) binary[i] = saliency[i] >= threshold ? 1 : 0;
  // 闭运算（先膨胀后腐蚀）与开运算
  binary = erode(dilate(binary, width, height, 3), width, height, 3);
  binary = dilate(erode(binary, width, height, 2), width, height, 2);
  // 取最大连通域
  const labels = new Int32Array(total).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < total; start += 1) {
    if (!binary[start] || labels[start] >= 0) continue;
    const label = sizes.length;
    let size = 0;
    stack.push(start);
    labels[start] = label;
    while (stack.length > 0) {
      const current = stack.pop()!;
      size += 1;
      const cx = current % width;
      const cy = (current / width) | 0;
      const push = (next: number): void => {
        if (binary[next] && labels[next] < 0) {
          labels[next] = label;
          stack.push(next);
        }
      };
      if (cx > 0) push(current - 1);
      if (cx < width - 1) push(current + 1);
      if (cy > 0) push(current - width);
      if (cy < height - 1) push(current + width);
    }
    sizes.push(size);
  }
  let bestLabel = -1;
  let bestSize = 0;
  for (let i = 0; i < sizes.length; i += 1) {
    if (sizes[i] > bestSize) {
      bestSize = sizes[i];
      bestLabel = i;
    }
  }
  const data = new Uint8Array(total);
  if (bestLabel >= 0 && bestSize > total * 0.0005) {
    for (let i = 0; i < total; i += 1) data[i] = labels[i] === bestLabel ? 255 : 0;
  }
  void fastLuma;
  return featherSelectionMask({ width, height, data, outline: null }, 1);
}

/** 选区仿射变换（用于「变换选区」：只移动轮廓，不动像素） */
export function transformSelectionMask(
  selection: SelectionMask,
  matrix: (point: Point) => Point,
  width: number,
  height: number,
): SelectionMask {
  // 反向映射：对目标像素求源坐标，超出原选区则为 0
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = matrix({ x, y });
      const sx = Math.floor(p.x);
      const sy = Math.floor(p.y);
      if (sx < 0 || sy < 0 || sx >= selection.width || sy >= selection.height) continue;
      data[y * width + x] = selection.data[sy * selection.width + sx];
    }
  }
  return { width, height, data, outline: null };
}

/** 选区与矩形的布尔裁剪（用于「与选区交叉」快速判断） */
export function selectionIntersectsRect(selection: SelectionMask | null, rect: Rect): boolean {
  if (!selection) return true;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(selection.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(selection.height, Math.ceil(rect.y + rect.height));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (selection.data[y * selection.width + x] > 0) return true;
    }
  }
  return false;
}
