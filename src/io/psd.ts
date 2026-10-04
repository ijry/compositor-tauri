/**
 * Photoshop PSD / PSB 读写
 * ---------------------------------------------------------------
 * 导入规则与上游一致：
 *  - 8 位 RGB 文档，图层、文件夹、蒙版、混合模式保持可编辑；
 *  - 简单横排文字保留文字元数据，竖排文字与其它矢量对象栅格化；
 *  - 导入后给出转换报告，列出被栅格化与不支持的部分。
 */
import { readPsd, writePsd, type Layer as PsdLayer, type Psd } from 'ag-psd';
import { createBuffer } from '@/core/pixels';
import { createDocument, createGroupLayer, createPixelLayer, defaultTransform } from '@/core/document';
import { compositeInto } from '@/core/engine/compositor';
import type { BlendMode, CompDocument, Layer, MaskBuffer, PixelBuffer, TextMeta } from '@/types/document';

/** 导入结果：文档 + 转换报告 */
export interface PsdImportResult {
  document: CompDocument;
  report: PsdConversionReport;
}

export interface PsdConversionReport {
  totalLayers: number;
  editableLayers: number;
  groups: number;
  masks: number;
  textLayers: number;
  rasterized: number;
  unsupported: string[];
  notes: string[];
}

/** ag-psd 混合模式 -> 内部名称 */
const BLEND_MODE_MAP: Record<string, BlendMode> = {
  normal: 'Normal',
  dissolve: 'Normal',
  darken: 'Darken',
  multiply: 'Multiply',
  colorBurn: 'Color Burn',
  linearBurn: 'Linear Burn',
  lighten: 'Lighten',
  screen: 'Screen',
  colorDodge: 'Color Dodge',
  linearDodge: 'Linear Dodge (Add)',
  overlay: 'Overlay',
  softLight: 'Soft Light',
  hardLight: 'Hard Light',
  vividLight: 'Vivid Light',
  linearLight: 'Linear Light',
  pinLight: 'Pin Light',
  hardMix: 'Hard Mix',
  difference: 'Difference',
  exclusion: 'Exclusion',
  subtract: 'Subtract',
  divide: 'Divide',
  hue: 'Hue',
  saturation: 'Saturation',
  color: 'Color',
  luminosity: 'Luminosity',
};

const INTERNAL_BLEND_NAMES = new Set<string>(Object.values(BLEND_MODE_MAP));

/* ------------------------------ 导入 ------------------------------ */

/** 导入 PSD/PSB */
export function importPsd(data: ArrayBuffer, name = '导入'): PsdImportResult {
  const psd = readPsd(data, {
    useImageData: true,
    skipLayerImageData: false,
    skipCompositeImageData: true,
    skipThumbnail: true,
    throwForMissingFeatures: false,
  });
  const report: PsdConversionReport = {
    totalLayers: 0,
    editableLayers: 0,
    groups: 0,
    masks: 0,
    textLayers: 0,
    rasterized: 0,
    unsupported: [],
    notes: [],
  };
  const document = createDocument(Math.max(1, psd.width), Math.max(1, psd.height), name);
  if (psd.colorMode !== undefined && psd.colorMode !== 3) {
    report.notes.push(`文档颜色模式为 ${psd.colorMode}（3 = RGB），已按 sRGB 近似转换`);
  }
  for (const psdLayer of psd.children ?? []) {
    const layer = convertLayer(psdLayer, null, document, report);
    if (layer) document.layers.push(layer);
  }
  if (document.layers.length === 0) report.notes.push('未找到可导入的图层');
  const topmost = document.layers.filter((layer) => layer.parentId === null).pop();
  document.activeLayerId = topmost?.id ?? null;
  return { document, report };
}

/** 单个 PSD 图层 -> 内部图层（含递归处理文件夹） */
function convertLayer(psdLayer: PsdLayer, parentId: string | null, document: CompDocument, report: PsdConversionReport): Layer | null {
  report.totalLayers += 1;
  const children = psdLayer.children;
  if (children && children.length > 0) {
    report.groups += 1;
    const group = createGroupLayer(psdLayer.name || '组', parentId);
    group.isVisible = !psdLayer.hidden;
    group.opacity = clamp01(psdLayer.opacity ?? 1);
    for (const child of children) {
      const converted = convertLayer(child, group.id, document, report);
      if (converted) document.layers.push(converted);
    }
    return group;
  }
  if (psdLayer.sectionDivider) return null;
  const width = Math.max(0, (psdLayer.right ?? 0) - (psdLayer.left ?? 0));
  const height = Math.max(0, (psdLayer.bottom ?? 0) - (psdLayer.top ?? 0));
  if (width === 0 || height === 0) return null;
  const buffer = extractImageData(psdLayer, width, height);
  if (!buffer) return null;
  const name = psdLayer.name || '图层';
  const rawBlend = String(psdLayer.blendMode ?? 'normal');
  const blendMode = BLEND_MODE_MAP[rawBlend] ?? 'Normal';
  if (!INTERNAL_BLEND_NAMES.has(rawBlend)) {
    report.unsupported.push(`${name}：混合模式 ${rawBlend} 已按 Normal 处理`);
  }

  // 文字图层：横排文字保留元数据
  let text: TextMeta | null = null;
  const details = psdLayer.text;
  if (details) {
    report.textLayers += 1;
    if (isVerticalText(details)) {
      report.rasterized += 1;
      report.notes.push(`${name}：竖排文字已栅格化`);
    } else {
      const transform = details.transform ?? [32, 0, 0, 32, 0, 0];
      text = {
        content: details.text ?? '',
        fontName: extractFontName(details) ?? 'Arial',
        fontSize: Math.max(4, Math.round(transform[0] ?? 32)),
        color: [0, 0, 0],
        align: 'left',
        tracking: 0,
        lineSpacing: 0,
        boxSize: null,
        bold: details.style?.fauxBold ?? false,
        italic: details.style?.fauxItalic ?? false,
      };
    }
  }

  const layer = createPixelLayer(name, buffer, {
    isVisible: !psdLayer.hidden,
    opacity: clamp01(psdLayer.opacity ?? 1),
    blendMode,
    parentId,
  });
  layer.transform = {
    ...defaultTransform(width, height),
    origin: [psdLayer.left ?? 0, psdLayer.top ?? 0],
    size: [width, height],
  };
  layer.text = text;
  report.editableLayers += 1;

  // 图层效果：投影与内投影以近似值保留
  const drop = psdLayer.effects?.dropShadow?.[0];
  const inner = psdLayer.effects?.innerShadow?.[0];
  if (drop) {
    layer.effects = {
      ...(layer.effects ?? {}),
      shadow: {
        enabled: drop.enabled ?? true,
        angle: toNumber(drop.angle),
        distance: toNumber(drop.distance),
        blur: toNumber(drop.size),
        color: toRgb(drop.color),
        opacity: toNumber(drop.opacity ?? 100) / 100,
      },
    };
  }
  if (inner) {
    layer.effects = {
      ...(layer.effects ?? {}),
      innerShadow: {
        enabled: inner.enabled ?? true,
        angle: toNumber(inner.angle),
        distance: toNumber(inner.distance),
        blur: toNumber(inner.size),
        color: toRgb(inner.color),
        opacity: toNumber(inner.opacity ?? 100) / 100,
      },
    };
  }

  if (psdLayer.mask) {
    report.masks += 1;
    const maskData = extractMask(psdLayer.mask, width, height);
    if (maskData) {
      layer.mask = {
        pixels: maskData,
        enabled: true,
        linked: true,
        placement: null,
        target: 'image',
        inverted: false,
      };
    }
  }
  return layer;
}


/** PSD 里部分数值字段可能是带单位的对象，这里统一取出数值 */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'value' in value) {
    const inner = (value as { value?: unknown }).value;
    return typeof inner === 'number' ? inner : 0;
  }
  return 0;
}

/** PSD 颜色可能是数组或 {r,g,b} 对象 */
function toRgb(color: unknown): [number, number, number] {
  if (Array.isArray(color)) return [Number(color[0]) || 0, Number(color[1]) || 0, Number(color[2]) || 0];
  if (color && typeof color === 'object') {
    const value = color as { r?: number; g?: number; b?: number };
    return [value.r ?? 0, value.g ?? 0, value.b ?? 0];
  }
  return [0, 0, 0];
}
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function extractImageData(psdLayer: PsdLayer, width: number, height: number): PixelBuffer | null {
  if (psdLayer.imageData) {
    const source = psdLayer.imageData;
    const data = new Uint8ClampedArray(source.data);
    if (source.width === width && source.height === height) return { width, height, data };
    return resample(data, source.width, source.height, width, height);
  }
  if (psdLayer.canvas) {
    const canvas = psdLayer.canvas as HTMLCanvasElement;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }
  return null;
}

function resample(data: Uint8ClampedArray, sourceWidth: number, sourceHeight: number, width: number, height: number): PixelBuffer {
  const out = createBuffer(width, height);
  for (let y = 0; y < height; y += 1) {
    const fy = ((y + 0.5) * sourceHeight) / height - 0.5;
    const y0 = Math.max(0, Math.min(sourceHeight - 1, Math.floor(fy)));
    const y1 = Math.max(0, Math.min(sourceHeight - 1, y0 + 1));
    const wy = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = ((x + 0.5) * sourceWidth) / width - 0.5;
      const x0 = Math.max(0, Math.min(sourceWidth - 1, Math.floor(fx)));
      const x1 = Math.max(0, Math.min(sourceWidth - 1, x0 + 1));
      const wx = fx - x0;
      const di = (y * width + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const top = (data[(y0 * sourceWidth + x0) * 4 + c] ?? 0) * (1 - wx) + (data[(y0 * sourceWidth + x1) * 4 + c] ?? 0) * wx;
        const bottom = (data[(y1 * sourceWidth + x0) * 4 + c] ?? 0) * (1 - wx) + (data[(y1 * sourceWidth + x1) * 4 + c] ?? 0) * wx;
        out.data[di + c] = top * (1 - wy) + bottom * wy;
      }
    }
  }
  return out;
}

function extractMask(mask: NonNullable<PsdLayer['mask']>, width: number, height: number): MaskBuffer | null {
  let sourceData: Uint8Array | null = null;
  let sourceWidth = width;
  let sourceHeight = height;
  if (mask.imageData) {
    sourceData = new Uint8Array(mask.imageData.data);
    sourceWidth = mask.imageData.width;
    sourceHeight = mask.imageData.height;
  } else if (mask.canvas) {
    const canvas = mask.canvas as HTMLCanvasElement;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      sourceData = new Uint8Array(width * height);
      sourceWidth = width;
      sourceHeight = height;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const sx = Math.min(canvas.width - 1, Math.floor((x * canvas.width) / width));
          const sy = Math.min(canvas.height - 1, Math.floor((y * canvas.height) / height));
          sourceData[y * width + x] = image.data[(sy * canvas.width + sx) * 4] ?? 0;
        }
      }
    }
  }
  if (!sourceData) return null;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(sourceHeight - 1, Math.floor((y * sourceHeight) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(sourceWidth - 1, Math.floor((x * sourceWidth) / width));
      out[y * width + x] = sourceData[sy * sourceWidth + sx] ?? 0;
    }
  }
  return { width, height, data: out };
}

/** 取字体名 */
function extractFontName(details: NonNullable<PsdLayer['text']>): string | null {
  const font = (details as unknown as { font?: string }).font;
  if (typeof font === 'string' && font) return font;
  const engine = (details as unknown as { engineData?: { name?: string } }).engineData;
  if (engine?.name) return engine.name.replace(/-\d+$/, '');
  return null;
}

/** 是否竖排文字（orientation 2/4） */
function isVerticalText(details: NonNullable<PsdLayer['text']>): boolean {
  const orientation = (details as unknown as { orientation?: number }).orientation;
  return orientation === 2 || orientation === 4;
}

/* ------------------------------ 导出 ------------------------------ */

/** 导出为 PSD 二进制（调整层与组会被栅格化为像素层） */
export function exportPsd(document: CompDocument): ArrayBuffer {
  const build = (layer: Layer): PsdLayer => {
    if (layer.kind === 'group') {
      const children = document.layers.filter((item) => item.parentId === layer.id).map(build);
      return {
        name: layer.name,
        opacity: layer.opacity,
        blendMode: toPsdBlendMode(layer.blendMode),
        hidden: !layer.isVisible,
        left: 0,
        top: 0,
        right: document.width,
        bottom: document.height,
        children,
      } as PsdLayer;
    }
    let buffer = layer.pixels;
    if (!buffer || layer.kind === 'adjustment') {
      // 调整层没有像素，用其上方的合成结果填充
      buffer = createBuffer(document.width, document.height);
      const temp: CompDocument = { ...document, layers: document.layers.filter((item) => item.kind !== 'adjustment') };
      compositeInto(buffer, temp, 1);
    }
    const left = Math.round(layer.transform.origin[0]);
    const top = Math.round(layer.transform.origin[1]);
    const result: PsdLayer = {
      name: layer.name,
      opacity: layer.opacity,
      blendMode: toPsdBlendMode(layer.blendMode),
      hidden: !layer.isVisible,
      left,
      top,
      right: left + buffer.width,
      bottom: top + buffer.height,
      imageData: new ImageData(buffer.data as Uint8ClampedArray<ArrayBuffer>, buffer.width, buffer.height),
    } as PsdLayer;
    if (layer.mask) {
      const mask = createBuffer(layer.mask.pixels.width, layer.mask.pixels.height);
      for (let i = 0; i < layer.mask.pixels.data.length; i += 1) {
        const value = layer.mask.pixels.data[i] ?? 0;
        mask.data[i * 4] = value;
        mask.data[i * 4 + 1] = value;
        mask.data[i * 4 + 2] = value;
        mask.data[i * 4 + 3] = 255;
      }
      result.mask = {
        imageData: new ImageData(mask.data as Uint8ClampedArray<ArrayBuffer>, mask.width, mask.height),
        top: 0,
        left: 0,
        bottom: mask.height,
        right: mask.width,
        defaultColor: 0,
      } as NonNullable<PsdLayer['mask']>;
    }
    return result;
  };
  const psd: Psd = {
    width: document.width,
    height: document.height,
    children: document.layers.filter((layer) => layer.parentId === null).map(build),
  };
  return writePsd(psd, { generateThumbnail: false, noBackground: true });
}

function toPsdBlendMode(mode: BlendMode): string {
  const inverse: Record<string, string> = {
    Normal: 'normal', Darken: 'darken', Multiply: 'multiply', 'Color Burn': 'colorBurn',
    'Linear Burn': 'linearBurn', Lighten: 'lighten', Screen: 'screen', 'Color Dodge': 'colorDodge',
    'Linear Dodge (Add)': 'linearDodge', Overlay: 'overlay', 'Soft Light': 'softLight',
    'Hard Light': 'hardLight', 'Vivid Light': 'vividLight', 'Linear Light': 'linearLight',
    'Pin Light': 'pinLight', 'Hard Mix': 'hardMix', Difference: 'difference', Exclusion: 'exclusion',
    Subtract: 'subtract', Divide: 'divide', Hue: 'hue', Saturation: 'saturation',
    Color: 'color', Luminosity: 'luminosity',
  };
  return inverse[mode] ?? 'normal';
}

/** 生成转换报告文本（界面展示用） */
export function formatPsdReport(report: PsdConversionReport): string {
  const lines: string[] = [];
  lines.push(`图层总数：${report.totalLayers}`);
  lines.push(`保持可编辑：${report.editableLayers}`);
  lines.push(`文件夹：${report.groups}`);
  lines.push(`图层蒙版：${report.masks}`);
  lines.push(`文字图层：${report.textLayers}`);
  lines.push(`栅格化图层：${report.rasterized}`);
  for (const item of report.unsupported.slice(0, 8)) lines.push(`需要注意：${item}`);
  for (const note of report.notes.slice(0, 8)) lines.push(`· ${note}`);
  return lines.join('\n');
}
