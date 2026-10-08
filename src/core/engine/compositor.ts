/**
 * 图层合成器
 * ---------------------------------------------------------------
 * 输入一个文档，输出画布（或任意尺寸）的合成结果。
 * 处理内容：
 *  - 图层可见性与顺序；
 *  - 组（文件夹）的通过式不透明度与组蒙版；
 *  - 图层像素、栅格蒙版、剪贴蒙版（以上一层的不透明度为基础）；
 *  - 调整层（作用于其下方的合成结果，可被选区与自身蒙版限制）；
 *  - 图层效果（在表面烘焙，见 effects.ts）；
 *  - previewScale < 1 时整体降采样，保证大图在缩小时依然流畅。
 */
import { blendFunction } from '@/core/blend';
import { applyAdjustment } from '@/core/filters/adjust';
import { bakeEffects, type Surface } from '@/core/engine/effects';
import { applyMatrix, IDENTITY, invertMatrix, layerMatrix, multiplyMatrix, translation, scaling, type Matrix } from '@/core/geometry';
import { cloneBuffer, createBuffer } from '@/core/pixels';
import { samplingAt } from '@/core/sampler';
import type { CompDocument, Layer, MaskBuffer, PixelBuffer, SelectionMask } from '@/types/document';

/** 合成结果 */
export interface CompositeResult {
  buffer: PixelBuffer;
  /** 实际渲染比例 */
  scale: number;
}

/** 覆盖率采样器：给定文档坐标返回 0-1 的覆盖度 */
export type CoverageSampler = (x: number, y: number) => number;

const FULL_COVERAGE: CoverageSampler = () => 1;

/** 选区采样器 */
export function selectionSampler(selection: SelectionMask | null): CoverageSampler | null {
  if (!selection) return null;
  return (x, y) => {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= selection.width || py >= selection.height) return 0;
    return selection.data[py * selection.width + px] / 255;
  };
}

/**
 * 蒙版采样器：把图层局部像素坐标的蒙版映射到文档坐标。
 * linked = true 时蒙版跟随图层变换（蒙版尺寸与像素一致）；
 * linked = false 时蒙版有自己的文档空间矩形 placement。
 */
export function maskSampler(
  mask: MaskBuffer,
  layer: Layer,
  matrix: Matrix,
): CoverageSampler {
  let inverse = invertMatrix(matrix);
  if (!layer.mask?.linked && layer.mask?.placement) {
    const p = layer.mask.placement;
    inverse = invertMatrix(layerMatrix({ origin: [p.x,p.y], size: [p.width,p.height], rotation: p.rotation ?? 0,
      flipX: p.flipX ?? false, flipY: p.flipY ?? false, sampling: p.sampling ?? 'Nearest' }, mask.width, mask.height));
  }
  return (x, y) => {
    const local = applyMatrix(inverse, x, y);
    const mx = Math.floor(local.x);
    const my = Math.floor(local.y);
    if (mx < 0 || my < 0 || mx >= mask.width || my >= mask.height) return 0;
    return mask.data[my * mask.width + mx] / 255;
  };
}

/** 取图层的「局部像素 -> 文档」矩阵 */
export function layerLocalToDocument(layer: Layer): Matrix {
  if (layer.kind !== 'pixel' || !layer.pixels) return IDENTITY;
  return layerMatrix(layer.transform, layer.pixels.width, layer.pixels.height);
}

/**
 * 把图层像素按变换渲染到表面（表面矩形覆盖变换后的包围盒）。
 * sampling 决定采样方式：High quality 双线性，Nearest 临近。
 */
export function buildLayerSurface(layer: Layer, scale = 1): Surface | null {
  if (layer.kind !== 'pixel' || !layer.pixels) return null;
  const pixels = layer.pixels;
  if (pixels.width === 0 || pixels.height === 0) return null;
  const matrix = layerMatrix(layer.transform, pixels.width, pixels.height);
  // 先算包围盒（变换后四角）
  const corners = [
    applyMatrix(matrix, 0, 0), applyMatrix(matrix, pixels.width, 0),
    applyMatrix(matrix, pixels.width, pixels.height), applyMatrix(matrix, 0, pixels.height),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const rect = {
    x: Math.floor(Math.min(...xs)),
    y: Math.floor(Math.min(...ys)),
    width: Math.max(1, Math.ceil(Math.max(...xs) - Math.min(...xs))),
    height: Math.max(1, Math.ceil(Math.max(...ys) - Math.min(...ys))),
  };
  const buffer = createBuffer(
    Math.max(1, Math.round(rect.width * scale)),
    Math.max(1, Math.round(rect.height * scale)),
  );
  // 图层局部像素 -> 文档 -> 表面原点 -> 缩放后的缓冲；平移也必须随合成比例缩放。
  const local = multiplyMatrix(scaling(scale, scale), multiplyMatrix(translation(-rect.x, -rect.y), matrix));
  fillFromSource(buffer, pixels, local, layer.transform.sampling);
  let surface: Surface = { buffer, rect, scale };
  if (layer.effects) surface = bakeEffects(surface, layer.effects);
  return surface;
}

/** 按矩阵从源缓冲填充目标缓冲（支持 Nearest 与双线性） */
function fillFromSource(target: PixelBuffer, source: PixelBuffer, matrix: Matrix, sampling: string): void {
  const inverse = invertMatrix(matrix);
  const { data: src } = source;
  for (let y = 0; y < target.height; y += 1) {
    for (let x = 0; x < target.width; x += 1) {
      const local = applyMatrix(inverse, x + 0.5, y + 0.5);
      const di = (y * target.width + x) * 4;
      if (local.x < 0 || local.y < 0 || local.x >= source.width || local.y >= source.height) {
        target.data[di + 3] = 0;
        continue;
      }
      if (sampling === 'Nearest') {
        const sx = Math.max(0, Math.min(source.width - 1, Math.floor(local.x)));
        const sy = Math.max(0, Math.min(source.height - 1, Math.floor(local.y)));
        const si = (sy * source.width + sx) * 4;
        target.data[di] = src[si];
        target.data[di + 1] = src[si + 1];
        target.data[di + 2] = src[si + 2];
        target.data[di + 3] = src[si + 3];
      } else {
        // 逆变换坐标为像素边界坐标，双线性采样器以整数表示像素中心。
        samplingAt(src, source.width, source.height, local.x - 0.5, local.y - 0.5, target.data, di);
      }
    }
  }
}

/** 取某图层在文档空间的 alpha 覆盖率采样器（用于剪贴蒙版） */
export function layerAlphaSampler(layer: Layer, scale = 1): CoverageSampler {
  const surface = buildLayerSurface(layer, scale);
  if (!surface) return () => 0;
  const { buffer, rect, scale: s } = surface;
  return (x, y) => {
    const bx = Math.floor((x - rect.x) * s);
    const by = Math.floor((y - rect.y) * s);
    if (bx < 0 || by < 0 || bx >= buffer.width || by >= buffer.height) return 0;
    return buffer.data[(by * buffer.width + bx) * 4 + 3] / 255;
  };
}

/** 合成上下文 */
export interface CompositeOptions {
  scale?: number;
  /** 是否把选区作为调整层的限制（默认 true） */
  limitAdjustmentsBySelection?: boolean;
  /** 只渲染这些图层（例如导出单层） */
  onlyLayers?: Set<string>;
}

/**
 * 合成整个文档。
 * @param document 文档
 * @param width 输出宽度（= 文档宽 × scale）
 * @param height 输出高度
 */
export function compositeDocument(document: CompDocument, width?: number, height?: number, options: CompositeOptions = {}): CompositeResult {
  const scale = options.scale ?? 1;
  const outWidth = width ?? Math.max(1, Math.round(document.width * scale));
  const outHeight = height ?? Math.max(1, Math.round(document.height * scale));
  const target = createBuffer(outWidth, outHeight);
  compositeInto(target, document, scale, options);
  return { buffer: target, scale };
}

/** 把文档合成到已有缓冲（画布渲染、导出都走这里） */
export function compositeInto(
  target: PixelBuffer,
  document: CompDocument,
  scale: number,
  options: CompositeOptions = {},
): void {
  const layers = document.layers;
  const selection = options.limitAdjustmentsBySelection === false ? null : document.selection;
  const selectionSample = selectionSampler(selection);
  const width = target.width;
  const height = target.height;

  // 预计算每个图层的祖先上下文（组不透明度 + 组蒙版）
  const contextCache = new Map<string, { opacity: number; masks: CoverageSampler[] }>();
  const contextFor = (layer: Layer): { opacity: number; masks: CoverageSampler[] } => {
    const cached = contextCache.get(layer.id);
    if (cached) return cached;
    let opacity = 1;
    const masks: CoverageSampler[] = [];
    let parentId = layer.parentId;
    let guard = 0;
    while (parentId && guard < 64) {
      guard += 1;
      const parent = layers.find((item) => item.id === parentId);
      if (!parent) break;
      opacity *= parent.isVisible ? parent.opacity : 0;
      if (parent.mask && parent.mask.enabled) {
        masks.push(maskSampler(parent.mask.pixels, parent, layerMaskMatrix(parent)));
      }
      parentId = parent.parentId;
    }
    const result = { opacity, masks };
    contextCache.set(layer.id, result);
    return result;
  };

  // 剪贴蒙版：同一父级下，紧邻下方的非剪贴图层作为基础
  const clipSamplerCache = new Map<string, CoverageSampler | null>();
  const clipSamplerFor = (layer: Layer): CoverageSampler | null => {
    if (!layer.clipping) return null;
    const cached = clipSamplerCache.get(layer.id);
    if (cached !== undefined) return cached;
    const index = layers.findIndex((item) => item.id === layer.id);
    let base: Layer | null = null;
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = layers[i];
      if (candidate.parentId !== layer.parentId) break;
      if (!candidate.clipping) { base = candidate; break; }
    }
    let sampler: CoverageSampler | null = null;
    if (base) {
      const baseAlpha = layerAlphaSampler(base, scale);
      sampler = (x, y) => baseAlpha(x, y) * base.opacity;
    }
    clipSamplerCache.set(layer.id, sampler);
    return sampler;
  };

  for (const layer of layers) {
    if (options.onlyLayers && !options.onlyLayers.has(layer.id)) continue;
    if (!layer.isVisible) continue;
    if (layer.opacity <= 0) continue;
    if (layer.kind === 'group') continue;
    const context = contextFor(layer);
    if (context.opacity <= 0) continue;
    const alpha = layer.opacity * context.opacity;
    const maskSample = layer.mask && layer.mask.enabled
      ? maskSampler(layer.mask.pixels, layer, layerMaskMatrix(layer))
      : null;
    const clipSample = clipSamplerFor(layer);

    if (layer.kind === 'adjustment' && layer.adjustment) {
      // 调整层：作用于当前 target（其下方已合成的内容）
      const coverage = buildCoverage(width, height, [...context.masks, maskSample, clipSample, selectionSample], alpha);
      applyAdjustment(target, layer.adjustment, coverage);
      continue;
    }

    if (layer.kind !== 'pixel' || !layer.pixels) continue;
    const surface = buildLayerSurface(layer, scale);
    if (!surface) continue;
    blitSurface(target, surface, [...context.masks, maskSample, clipSample], alpha, layer.blendMode, scale);
  }
}

/** 非像素层的蒙版用自身矩形映射，跟随组变换而不是固定在文档原点。 */
function layerMaskMatrix(layer: Layer): Matrix {
  if (layer.kind==='pixel' && layer.pixels) return layerLocalMatrix(layer);
  if (!layer.mask) return IDENTITY;
  return layerMatrix(layer.transform,layer.mask.pixels.width,layer.mask.pixels.height);
}

/** 取像素图层的局部矩阵（无像素时返回单位阵） */
function layerLocalMatrix(layer: Layer): Matrix {
  if (layer.kind !== 'pixel' || !layer.pixels) return IDENTITY;
  return layerMatrix(layer.transform, layer.pixels.width, layer.pixels.height);
}

/** 生成与输出缓冲等大的覆盖率数组（0-255），乘上整体不透明度 */
function buildCoverage(
  width: number,
  height: number,
  samplers: (CoverageSampler | null)[],
  alpha: number,
): Uint8Array | null {
  const list = samplers.filter((item): item is CoverageSampler => Boolean(item));
  const coverage = new Uint8Array(width * height);
  const factor = Math.max(0, Math.min(1, alpha));
  if (list.length === 0) {
    if (factor >= 1) return null;
    for (let i = 0; i < coverage.length; i += 1) coverage[i] = Math.round(factor * 255);
    return coverage;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 1;
      for (const sampler of list) {
        value *= sampler(x + 0.5, y + 0.5);
        if (value <= 0) break;
      }
      coverage[y * width + x] = Math.round(Math.max(0, Math.min(1, value * factor)) * 255);
    }
  }
  return coverage;
}

/**
 * 把表面混合进目标缓冲。
 * @param samplers 额外的覆盖率限制（蒙版、剪贴蒙版），坐标为文档像素
 */
export function blitSurface(
  target: PixelBuffer,
  surface: Surface,
  samplers: (CoverageSampler | null)[],
  alpha: number,
  blendMode: import('@/types/document').BlendMode,
  scale: number,
): void {
  const { buffer, rect } = surface;
  const list = samplers.filter((item): item is CoverageSampler => Boolean(item));
  const blend = blendFunction(blendMode);
  const opacity = Math.max(0, Math.min(1, alpha));
  // 目标像素范围
  const x0 = Math.max(0, Math.floor(rect.x * scale));
  const y0 = Math.max(0, Math.floor(rect.y * scale));
  const x1 = Math.min(target.width, Math.ceil((rect.x + rect.width) * scale));
  const y1 = Math.min(target.height, Math.ceil((rect.y + rect.height) * scale));
  for (let y = y0; y < y1; y += 1) {
    const docY = y / scale;
    const by = Math.floor((docY - rect.y) * surface.scale);
    if (by < 0 || by >= buffer.height) continue;
    for (let x = x0; x < x1; x += 1) {
      const docX = x / scale;
      const bx = Math.floor((docX - rect.x) * surface.scale);
      if (bx < 0 || bx >= buffer.width) continue;
      const si = (by * buffer.width + bx) * 4;
      let as = buffer.data[si + 3] / 255;
      if (as <= 0) continue;
      as *= opacity;
      if (list.length > 0) {
        for (const sampler of list) {
          as *= sampler(docX, docY);
          if (as <= 0) break;
        }
      }
      if (as <= 0) continue;
      const di = (y * target.width + x) * 4;
      const ab = target.data[di + 3] / 255;
      if (blendMode === 'Normal') {
        if (as >= 1 && ab <= 0) {
          target.data[di] = buffer.data[si];
          target.data[di + 1] = buffer.data[si + 1];
          target.data[di + 2] = buffer.data[si + 2];
          target.data[di + 3] = 255;
          continue;
        }
        const outA = as + ab * (1 - as);
        if (outA <= 0) continue;
        target.data[di] = (buffer.data[si] * as + target.data[di] * ab * (1 - as)) / outA;
        target.data[di + 1] = (buffer.data[si + 1] * as + target.data[di + 1] * ab * (1 - as)) / outA;
        target.data[di + 2] = (buffer.data[si + 2] * as + target.data[di + 2] * ab * (1 - as)) / outA;
        target.data[di + 3] = outA * 255;
        continue;
      }
      // 混合模式：按 W3C 合成公式
      const outA = as + ab * (1 - as);
      if (outA <= 0) continue;
      const blended = blend([target.data[di], target.data[di + 1], target.data[di + 2]], [buffer.data[si], buffer.data[si + 1], buffer.data[si + 2]]);
      target.data[di] = (blended[0] * as + target.data[di] * ab * (1 - as)) / outA;
      target.data[di + 1] = (blended[1] * as + target.data[di + 1] * ab * (1 - as)) / outA;
      target.data[di + 2] = (blended[2] * as + target.data[di + 2] * ab * (1 - as)) / outA;
      target.data[di + 3] = outA * 255;
    }
  }
}

/** 合成单个图层的像素（用于图层面板缩略图） */
export function renderLayerThumbnail(layer: Layer, size = 48): PixelBuffer {
  const buffer = createBuffer(size, size);
  if (layer.kind !== 'pixel' || !layer.pixels) return buffer;
  const matrix = layerLocalMatrix(layer);
  void matrix;
  // 直接用变换矩阵把像素映射到缩略图（保持长宽比）
  const scale = Math.min(size / layer.pixels.width, size / layer.pixels.height);
  const offsetX = (size - layer.pixels.width * scale) / 2;
  const offsetY = (size - layer.pixels.height * scale) / 2;
  const matrixThumb = multiplyMatrix(
    multiplyMatrix(translation(offsetX, offsetY), scaling(scale, scale)),
    IDENTITY,
  );
  const source = layer.pixels;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const local = applyMatrix(invertMatrix(matrixThumb), x + 0.5, y + 0.5);
      const di = (y * size + x) * 4;
      if (local.x < 0 || local.y < 0 || local.x >= source.width || local.y >= source.height) continue;
      samplingAt(source.data, source.width, source.height, local.x - 0.5, local.y - 0.5, buffer.data, di);
    }
  }
  return buffer;
}

/** 导出用的全分辨率合并（复制合并） */
export function flattenDocument(document: CompDocument): PixelBuffer {
  const result = compositeDocument(document, document.width, document.height, { scale: 1 });
  return cloneBuffer(result.buffer);
}
