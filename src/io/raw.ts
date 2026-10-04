/**
 * 相机 RAW 导入与显影
 * ---------------------------------------------------------------
 * 支持 TIFF 容器的 RAW（DNG / CR2 / NEF / ARW / ORF / PEF / SRW / RW2）：
 *  1. 解析 TIFF 目录，定位原始像素 IFD；
 *  2. 读取黑电平、白电平、AsShotNeutral 白平衡、色彩矩阵、BaselineExposure；
 *  3. 按 CFA 图案做双线性去马赛克，得到线性 sRGB；
 *  4. 套用「相机 RAW 显影」面板参数（光效 / 颜色 / 曲线 / 颜色混合 / 颜色分级 /
 *     细节 / 光学 / 几何），输出 8 位 sRGB 图层。
 * 非 TIFF 容器（如 CR3 的 ISO-BMFF、RAF 的 Fujifilm 私有格式）无法解码，
 * 会在导入时给出明确提示。
 */
import { fastLuma, hslToRgb, rgbToHsl } from '@/core/color';
import { cloneBuffer, createBuffer } from '@/core/pixels';
import type { CameraRawSettings, PixelBuffer, RawImage } from '@/types/document';

const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

interface RawEntry {
  tag: number;
  type: number;
  count: number;
  offset: number;
}

interface TiffTree {
  entries: Map<number, RawEntry[]>;
  nextIfd: number;
  view: DataView;
  bytes: Uint8Array;
  little: boolean;
}

/** 读取 TIFF 目录树（IFD0 及其 SubIFD） */
function readTiff(bytes: Uint8Array): TiffTree {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = view.getUint16(0, false) === 0x4949;
  const magic = view.getUint16(2, little);
  if (magic === 43) throw new Error('暂不支持 BigTIFF 格式的 RAW 文件');
  if (magic !== 42) throw new Error('不是 TIFF 容器的 RAW 文件（CR3 / RAF 请先转换为 DNG 或 TIFF）');
  const entries = new Map<number, RawEntry[]>();
  const visited = new Set<number>();
  let nextIfd = 0;

  const readIfd = (offset: number): void => {
    if (offset <= 0 || visited.has(offset) || offset + 2 > bytes.length) return;
    visited.add(offset);
    const count = view.getUint16(offset, little);
    for (let i = 0; i < count; i += 1) {
      const base = offset + 2 + i * 12;
      if (base + 12 > bytes.length) break;
      const tag = view.getUint16(base, little);
      const type = view.getUint16(base + 2, little);
      const valueCount = view.getUint32(base + 4, little);
      const size = (TYPE_SIZES[type] ?? 1) * valueCount;
      const valueOffset = size <= 4 ? base + 8 : view.getUint32(base + 8, little);
      const list = entries.get(tag) ?? [];
      list.push({ tag, type, count: valueCount, offset: valueOffset });
      entries.set(tag, list);
      // SubIFDs（330）：DNG 的原始像素常放在子目录
      if (tag === 330) {
        const subOffset = view.getUint32(base + 8, little);
        readIfd(subOffset);
      }
    }
    if (offset + 2 + count * 12 + 4 <= bytes.length) {
      const pointer = view.getUint32(offset + 2 + count * 12, little);
      if (pointer > 0 && visited.size < 8) {
        if (nextIfd === 0) nextIfd = pointer;
        readIfd(pointer);
      }
    }
  };
  readIfd(view.getUint32(4, little));
  return { entries, nextIfd, view, bytes, little };
}

function readValues(tree: TiffTree, tag: number): number[] {
  const list = tree.entries.get(tag);
  if (!list || list.length === 0) return [];
  const entry = list[0]!;
  const size = TYPE_SIZES[entry.type] ?? 1;
  const values: number[] = [];
  for (let i = 0; i < entry.count && i < 4096; i += 1) {
    const position = entry.offset + i * size;
    if (position + size > tree.bytes.length) break;
    switch (entry.type) {
      case 1: case 2: case 6: case 7: values.push(tree.view.getUint8(position)); break;
      case 3: values.push(tree.view.getUint16(position, tree.little)); break;
      case 4: values.push(tree.view.getUint32(position, tree.little)); break;
      case 8: values.push(tree.view.getInt16(position, tree.little)); break;
      case 9: values.push(tree.view.getInt32(position, tree.little)); break;
      case 5: {
        const numerator = tree.view.getUint32(position, tree.little);
        const denominator = tree.view.getUint32(position + 4, tree.little);
        values.push(denominator === 0 ? 0 : numerator / denominator);
        break;
      }
      case 11: values.push(tree.view.getFloat32(position, tree.little)); break;
      case 12: values.push(tree.view.getFloat64(position, tree.little)); break;
      default: values.push(0);
    }
  }
  return values;
}

function readAscii(tree: TiffTree, tag: number): string {
  const list = tree.entries.get(tag);
  if (!list || list.length === 0) return '';
  const entry = list[0]!;
  if (entry.type !== 2) return '';
  let text = '';
  for (let i = 0; i < entry.count; i += 1) {
    const code = tree.view.getUint8(entry.offset + i);
    if (code === 0) break;
    text += String.fromCharCode(code);
  }
  return text;
}

/** 支持的 CFA 图案（0=R,1=G,2=B） */
const CFA_PATTERNS: Record<string, [number, number, number, number]> = {
  RGGB: [0, 1, 1, 2],
  BGGR: [2, 1, 1, 0],
  GRBG: [1, 0, 2, 1],
  GBRG: [1, 2, 0, 1],
};

/** 解码 RAW，返回线性图像与默认显影设置 */
export function decodeRaw(data: ArrayBuffer): RawImage {
  const bytes = new Uint8Array(data);
  const tree = readTiff(bytes);
  const width = readValues(tree, 256)[0] ?? 0;
  const height = readValues(tree, 257)[0] ?? 0;
  const samples = readValues(tree, 277)[0] ?? 1;
  const bits = readValues(tree, 258)[0] ?? 16;
  const compression = readValues(tree, 259)[0] ?? 1;
  const photometric = readValues(tree, 262)[0] ?? 32803;
  const rowsPerStrip = readValues(tree, 278)[0] ?? height;
  const stripOffsets = readValues(tree, 273);
  const stripCounts = readValues(tree, 279);
  const cfaPattern = readValues(tree, 33422);
  const cfaRepeat = readValues(tree, 33421)[0] ?? 1;
  const make = readAscii(tree, 271);
  const model = readAscii(tree, 272);
  const uniqueModel = readAscii(tree, 50808) || `${make} ${model}`.trim();

  if (width <= 0 || height <= 0 || stripOffsets.length === 0) {
    throw new Error('未在文件中找到原始像素数据');
  }
  if (compression !== 1 && compression !== 7 && compression !== 32773) {
    throw new Error(`暂不支持的 RAW 压缩方式（${compression}），请使用未压缩或 LZW 的 DNG`);
  }

  const bytesPerSample = Math.max(1, Math.ceil(bits / 8));
  const rowBytes = Math.ceil((width * samples * bits) / 8);
  // 解压所有条带
  const raw = new Uint8Array(rowBytes * height);
  let offset = 0;
  for (let strip = 0; strip < stripOffsets.length; strip += 1) {
    const start = stripOffsets[strip]!;
    const count = stripCounts[strip] ?? 0;
    const rows = Math.min(rowsPerStrip, height - strip * rowsPerStrip);
    const expected = rowBytes * rows;
    const chunk = bytes.subarray(start, start + count);
    let decoded: Uint8Array;
    if (compression === 1) decoded = chunk;
    else if (compression === 32773) decoded = decodePackBits(chunk, expected);
    else decoded = decodeLzwRaw(chunk, expected);
    raw.set(decoded.subarray(0, Math.min(decoded.length, expected)), offset);
    offset += expected;
  }

  // CFA 图案
  let pattern: [number, number, number, number] | null = null;
  if (cfaPattern.length >= 4 && cfaRepeat === 2 && photometric === 32803) {
    pattern = [cfaPattern[0]!, cfaPattern[1]!, cfaPattern[2]!, cfaPattern[3]!] as [number, number, number, number];
    if (!CFA_PATTERNS[`${cfaPattern[0]}${cfaPattern[1]}${cfaPattern[2]}${cfaPattern[3]}`] && cfaPattern.every((v) => v <= 2)) {
      // 已是通道号，直接使用
    } else if (cfaPattern.every((v) => v >= 0 && v <= 3)) {
      // 颜色枚举（0=红 1=绿 2=蓝），映射成通道号
      const map = [0, 1, 2, 1];
      pattern = [map[cfaPattern[0]!]!, map[cfaPattern[1]!]!, map[cfaPattern[2]!]!, map[cfaPattern[3]!]!] as [number, number, number, number];
    }
  }

  // 黑电平 / 白电平（可能是每个通道一组）
  const blackLevels = readValues(tree, 50714);
  const whiteLevels = readValues(tree, 50717);
  const black = blackLevels.length >= samples ? blackLevels.slice(0, samples) : [blackLevels[0] ?? 0];
  const white = whiteLevels.length >= samples ? whiteLevels.slice(0, samples) : [whiteLevels[0] ?? (1 << bits) - 1];
  const maxValue = (1 << Math.min(16, bits)) - 1;
  const asShotNeutral = readValues(tree, 50728);
  const whiteBalance: [number, number, number] = asShotNeutral.length >= 3
    ? [asShotNeutral[0]!, asShotNeutral[1]!, asShotNeutral[2]!]
    : [1, 1, 1];
  const baselineExposure = readValues(tree, 50730)[0] ?? 0;
  const colorMatrix1 = readValues(tree, 50721);
  const colorMatrix2 = readValues(tree, 50722);
  const forwardMatrix = readValues(tree, 50964);
  const cropOrigin = readValues(tree, 51119).length >= 2 ? readValues(tree, 51119) : (readValues(tree, 50719).length >= 2 ? readValues(tree, 50719) : [0, 0]);
  const cropSize = readValues(tree, 51120).length >= 2 ? readValues(tree, 51120) : (readValues(tree, 50720).length >= 2 ? readValues(tree, 50720) : [width, height]);

  const linear = demosaic(raw, width, height, samples, bytesPerSample, pattern, tree.little, maxValue);
  const balanced = applyWhiteBalanceAndMatrix(
    linear,
    black,
    white,
    whiteBalance,
    colorMatrix1.length >= 9 ? colorMatrix1 : (colorMatrix2.length >= 9 ? colorMatrix2 : null),
    forwardMatrix.length >= 9 ? forwardMatrix : null,
    baselineExposure,
  );

  // 按默认裁剪区域裁剪
  const originX = Math.max(0, Math.round(cropOrigin[0] ?? 0));
  const originY = Math.max(0, Math.round(cropOrigin[1] ?? 0));
  const cropWidth = Math.max(1, Math.min(width - originX, Math.round(cropSize[0] ?? width)));
  const cropHeight = Math.max(1, Math.min(height - originY, Math.round(cropSize[1] ?? height)));
  const cropped = cropBuffer(balanced, originX, originY, cropWidth, cropHeight);

  return {
    data: cropped,
    width: cropped.width,
    height: cropped.height,
    cameraModel: uniqueModel || '未知相机',
    settings: defaultRawSettings(),
  };
}

/** 默认显影参数（全部为中性） */
export function defaultRawSettings(): CameraRawSettings {
  return {
    exposure: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    brightness: 0, contrast: 0, saturation: 0,
    temperature: 0, tint: 0, vibrance: 0, clarity: 0, dehaze: 0,
    curvePoints: [[0, 0], [255, 255]],
    colorMixer: [
      { hue: 0, saturation: 0, luminance: 0, red: 0, orange: 0, yellow: 0, green: 0, aqua: 0, blue: 0, purple: 0, magenta: 0 },
    ],
    colorGrading: { shadows: [0, 0, 0], mids: [0, 0, 0], highlights: [0, 0, 0] },
    sharpening: 0, radius: 1, detail: 25, denoise: 0, vignette: 0, grain: 0,
    removeCA: 0, distortion: 0, defringe: 0,
    cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0,
  };
}

/** 双线性去马赛克：Bayer 走 3x3 插值，已全彩则直接复制 */
function demosaic(
  raw: Uint8Array,
  width: number,
  height: number,
  samples: number,
  bytesPerSample: number,
  pattern: [number, number, number, number] | null,
  little: boolean,
  maxValue: number,
): PixelBuffer {
  const out = createBuffer(width, height);
  const read = (x: number, y: number, channel: number): number => {
    const px = Math.max(0, Math.min(width - 1, x));
    const py = Math.max(0, Math.min(height - 1, y));
    const index = py * Math.ceil((width * samples * (bytesPerSample * 8)) / 8) + px * samples * bytesPerSample + channel * bytesPerSample;
    if (index + bytesPerSample > raw.length) return 0;
    if (bytesPerSample === 1) return raw[index] ?? 0;
    if (bytesPerSample === 2) return little ? ((raw[index] ?? 0) | ((raw[index + 1] ?? 0) << 8)) : (((raw[index] ?? 0) << 8) | (raw[index + 1] ?? 0));
    return raw[index] ?? 0;
  };
  const scale = maxValue === 0 ? 1 : 1 / maxValue;
  if (samples >= 3 || !pattern) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        out.data[i] = Math.min(255, read(x, y, 0) * scale * 255);
        out.data[i + 1] = Math.min(255, read(x, y, Math.min(1, samples - 1)) * scale * 255);
        out.data[i + 2] = Math.min(255, read(x, y, Math.min(2, samples - 1)) * scale * 255);
        out.data[i + 3] = 255;
      }
    }
    return out;
  }
  // Bayer：先按 CFA 位置取出两个通道值
  const red = new Float32Array(width * height);
  const green = new Float32Array(width * height);
  const blue = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const channel = pattern[(y % 2) * 2 + (x % 2)]!;
      const value = read(x, y, 0) * scale * 255;
      const index = y * width + x;
      if (channel === 0) red[index] = value;
      else if (channel === 2) blue[index] = value;
      else green[index] = value;
    }
  }
  const at = (data: Float32Array, x: number, y: number): number => {
    const px = Math.max(0, Math.min(width - 1, x));
    const py = Math.max(0, Math.min(height - 1, y));
    return data[py * width + px]!;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const i = index * 4;
      if (red[index] !== 0 || pattern[(y % 2) * 2 + (x % 2)] !== 0) {
        out.data[i] = red[index] !== 0 ? red[index]! : averageNeighbors(red, x, y, width, height, at);
      }
      if (blue[index] !== 0 || pattern[(y % 2) * 2 + (x % 2)] !== 2) {
        out.data[i + 2] = blue[index] !== 0 ? blue[index]! : averageNeighbors(blue, x, y, width, height, at);
      }
      out.data[i + 1] = at(green, x, y);
      out.data[i + 3] = 255;
    }
  }
  return out;
}

function averageNeighbors(
  data: Float32Array,
  x: number,
  y: number,
  width: number,
  height: number,
  at: (data: Float32Array, x: number, y: number) => number,
): number {
  const pattern = ((y % 2) * 2 + (x % 2));
  // 水平方向取样
  const left = at(data, x - 1, y);
  const right = at(data, x + 1, y);
  if (pattern === 0 || pattern === 2) return (left + right) / 2;
  const up = at(data, x, y - 1);
  const down = at(data, x, y + 1);
  void width; void height;
  return (up + down) / 2;
}

/** 白平衡 + 色彩矩阵 + 基准曝光 */
function applyWhiteBalanceAndMatrix(
  buffer: PixelBuffer,
  black: number[],
  white: number[],
  whiteBalance: [number, number, number],
  colorMatrix: number[] | null,
  forwardMatrix: number[] | null,
  baselineExposure: number,
): PixelBuffer {
  const out = createBuffer(buffer.width, buffer.height);
  const blackR = black[0] ?? 0;
  const blackG = black[1] ?? blackR;
  const blackB = black[2] ?? blackR;
  const whiteR = white[0] ?? 65535;
  const whiteG = white[1] ?? whiteR;
  const whiteB = white[2] ?? whiteR;
  const exposure = Math.pow(2, baselineExposure);
  const matrix = colorMatrix ?? forwardMatrix ?? null;
  // 白平衡增益：以绿色为基准
  const gainR = whiteBalance[1] / Math.max(1e-6, whiteBalance[0]);
  const gainB = whiteBalance[1] / Math.max(1e-6, whiteBalance[2]);
  for (let i = 0; i < buffer.data.length; i += 4) {
    let r = ((buffer.data[i]! - (blackR / 65535) * 255) / Math.max(1e-6, (whiteR - blackR) / 65535)) * exposure;
    let g = ((buffer.data[i + 1]! - (blackG / 65535) * 255) / Math.max(1e-6, (whiteG - blackG) / 65535)) * exposure;
    let b = ((buffer.data[i + 2]! - (blackB / 65535) * 255) / Math.max(1e-6, (whiteB - blackB) / 65535)) * exposure;
    r *= gainR;
    b *= gainB;
    if (matrix) {
      const nr = matrix[0]! * r + matrix[1]! * g + matrix[2]! * b;
      const ng = matrix[3]! * r + matrix[4]! * g + matrix[5]! * b;
      const nb = matrix[6]! * r + matrix[7]! * g + matrix[8]! * b;
      r = nr; g = ng; b = nb;
    }
    out.data[i] = Math.max(0, Math.min(255, r * 255));
    out.data[i + 1] = Math.max(0, Math.min(255, g * 255));
    out.data[i + 2] = Math.max(0, Math.min(255, b * 255));
    out.data[i + 3] = 255;
  }
  return out;
}

function cropBuffer(buffer: PixelBuffer, x: number, y: number, width: number, height: number): PixelBuffer {
  const out = createBuffer(width, height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const sx = Math.min(buffer.width - 1, x + column);
      const sy = Math.min(buffer.height - 1, y + row);
      const si = (sy * buffer.width + sx) * 4;
      const di = (row * width + column) * 4;
      out.data[di] = buffer.data[si];
      out.data[di + 1] = buffer.data[si + 1];
      out.data[di + 2] = buffer.data[si + 2];
      out.data[di + 3] = buffer.data[si + 3];
    }
  }
  return out;
}

function decodePackBits(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let offset = 0;
  let write = 0;
  while (offset < input.length && write < expected) {
    const header = (input[offset]! << 24) >> 24;
    offset += 1;
    if (header >= 0) {
      const count = header + 1;
      for (let i = 0; i < count && write < expected; i += 1) {
        out[write] = input[offset] ?? 0;
        offset += 1; write += 1;
      }
    } else if (header !== -128) {
      const count = 1 - header;
      const value = input[offset] ?? 0;
      offset += 1;
      for (let i = 0; i < count && write < expected; i += 1) {
        out[write] = value; write += 1;
      }
    }
  }
  return out;
}

function decodeLzwRaw(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  const dictionary: Uint8Array[] = [];
  const reset = (): void => {
    dictionary.length = 0;
    for (let i = 0; i < 256; i += 1) dictionary.push(new Uint8Array([i]));
    dictionary.push(new Uint8Array([]));
    dictionary.push(new Uint8Array([]));
  };
  reset();
  let codeWidth = 9;
  let bitBuffer = 0;
  let bitCount = 0;
  let write = 0;
  let previous: Uint8Array | null = null;
  for (let i = 0; i + 1 < input.length && write < expected; i += 1) {
    bitBuffer = (bitBuffer << 8) | input[i]!;
    bitCount += 8;
    while (bitCount >= codeWidth) {
      const code = (bitBuffer >> (bitCount - codeWidth)) & ((1 << codeWidth) - 1);
      bitCount -= codeWidth;
      if (code === 257) return out;
      if (code === 256) {
        reset(); codeWidth = 9; previous = null; continue;
      }
      let entry: Uint8Array;
      if (code < dictionary.length && dictionary[code]) entry = dictionary[code]!;
      else if (previous) {
        entry = new Uint8Array(previous.length + 1);
        entry.set(previous);
        entry[previous.length] = previous[0]!;
      } else return out;
      for (let k = 0; k < entry.length && write < expected; k += 1) {
        out[write] = entry[k]!; write += 1;
      }
      if (previous) {
        const added = new Uint8Array(previous.length + 1);
        added.set(previous);
        added[previous.length] = entry[0]!;
        dictionary.push(added);
      }
      previous = entry;
      if (dictionary.length + 1 >= (1 << codeWidth) && codeWidth < 12) codeWidth += 1;
    }
  }
  return out;
}

/* ------------------------------ 显影 ------------------------------ */

/** 相机 RAW 面板分组 */
export interface RawPanelGroup {
  id: 'light' | 'color' | 'curve' | 'mixer' | 'grading' | 'detail' | 'optics' | 'geometry';
  label: string;
}

/** 显影面板的分组顺序（与上游 Camera Raw 面板一致） */
export const RAW_PANEL_GROUPS: RawPanelGroup[] = [
  { id: 'light', label: '光效' },
  { id: 'color', label: '颜色' },
  { id: 'curve', label: '曲线' },
  { id: 'mixer', label: '颜色混合' },
  { id: 'grading', label: '颜色分级' },
  { id: 'detail', label: '细节' },
  { id: 'optics', label: '光学' },
  { id: 'geometry', label: '几何' },
];

/** 颜色混合的 11 个色轮 */
export const COLOR_WHEELS = [
  { key: 'red', label: '红色', hue: 0 },
  { key: 'orange', label: '橙色', hue: 30 },
  { key: 'yellow', label: '黄色', hue: 60 },
  { key: 'green', label: '绿色', hue: 120 },
  { key: 'aqua', label: '青色', hue: 180 },
  { key: 'blue', label: '蓝色', hue: 240 },
  { key: 'purple', label: '紫色', hue: 280 },
  { key: 'magenta', label: '洋红', hue: 320 },
] as const;

/** 套用显影参数，把线性图像转成 8 位 sRGB */
export function developRawImage(raw: RawImage, settings: CameraRawSettings): PixelBuffer {
  const working = cloneBuffer(raw.data);
  const { width, height, data } = working;

  /* 光效：曝光度 */
  const exposureFactor = Math.pow(2, settings.exposure);
  for (let i = 0; i < data.length; i += 4) {
    data[i] *= exposureFactor;
    data[i + 1] *= exposureFactor;
    data[i + 2] *= exposureFactor;
  }

  /* 颜色：色温与色调（在 HSL 的色相上做偏移） */
  const tempShift = settings.temperature * 0.3;
  const tintShift = settings.tint * 0.2;
  if (tempShift !== 0 || tintShift !== 0) {
    for (let i = 0; i < data.length; i += 4) {
      const hsl = rgbToHsl(data[i]!, data[i + 1]!, data[i + 2]);
      const rgb = hslToRgb(hsl.h + tintShift, hsl.s, hsl.l);
      // 色温：暖 = 偏黄绿方向抬红降蓝
      data[i] = Math.max(0, Math.min(255, rgb.r + tempShift * 0.9));
      data[i + 1] = Math.max(0, Math.min(255, rgb.g + tempShift * 0.15));
      data[i + 2] = Math.max(0, Math.min(255, rgb.b - tempShift * 0.9));
    }
  }

  /* 光效：黑白场、对比度、亮度、高光、阴影 */
  const blackPoint = settings.blacks / 100 * 40;
  const whitePoint = 255 - Math.max(0, settings.whites) / 100 * 40;
  const contrast = 1 + settings.contrast / 100 * 0.6;
  const brightness = settings.brightness / 100 * 40;
  const highlight = settings.highlights / 100;
  const shadow = settings.shadows / 100;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      let value = data[i + c]!;
      // 黑白场
      value = ((value - blackPoint) / Math.max(1, whitePoint - blackPoint)) * 255;
      // 对比度与亮度
      value = (value - 128) * contrast + 128 + brightness;
      // 高光/阴影：按亮度权重分别处理
      const luma = Math.max(0, Math.min(1, (data[i]! + data[i + 1]! + data[i + 2]!) / 765));
      if (highlight !== 0) {
        const weight = Math.max(0, (luma - 0.5) * 2);
        value += highlight * weight * (value - 128) * 0.6;
      }
      if (shadow !== 0) {
        const weight = Math.max(0, 1 - luma * 2);
        value += shadow * weight * (128 - value) * 0.6;
      }
      data[i + c] = value;
    }
  }

  /* 颜色：自然饱和度与饱和度 */
  if (settings.vibrance !== 0 || settings.saturation !== 0) {
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max === 0 ? 0 : (max - min) / max;
      // 自然饱和度对低饱和像素作用更强
      const vibranceWeight = 1 - saturation;
      const factor = 1 + settings.vibrance / 100 * vibranceWeight + settings.saturation / 100;
      const average = (r + g + b) / 3;
      data[i] = average + (r - average) * factor;
      data[i + 1] = average + (g - average) * factor;
      data[i + 2] = average + (b - average) * factor;
    }
  }

  /* 清晰度与去雾：局部对比增强（用邻域平均近似） */
  if (settings.clarity !== 0 || settings.dehaze !== 0) {
    const blurred = blurBufferLocal(working, Math.max(1, Math.round(Math.min(width, height) / 200)));
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        const detail = data[i + c]! - blurred.data[i + c]!;
        if (settings.clarity !== 0) {
          data[i + c] = data[i + c]! + detail * (settings.clarity / 100) * 0.8;
        }
        if (settings.dehaze !== 0) {
          // 去雾：按亮度向中灰压缩，再按深度提对比
          const luma = (data[i]! + data[i + 1]! + data[i + 2]!) / 765;
          const haze = 1 - Math.min(1, Math.abs(luma - 0.5) * 2.2);
          data[i + c] = (data[i + c]! - 128) * (1 + haze * (settings.dehaze / 100) * 0.6) + 128;
        }
      }
    }
  }

  /* 曲线 */
  if (settings.curvePoints.length > 2) {
    const lut = buildCurve(settings.curvePoints);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = lut[data[i]!]!;
      data[i + 1] = lut[data[i + 1]!]!;
      data[i + 2] = lut[data[i + 2]!]!;
    }
  }

  /* 颜色混合：按色相对每个色轮调整饱和度与亮度 */
  if (settings.colorMixer.length > 0) {
    for (let i = 0; i < data.length; i += 4) {
      const hsl = rgbToHsl(data[i]!, data[i + 1]!, data[i + 2]!);
      if (hsl.s < 0.06) continue;
      let saturationDelta = 0;
      let luminanceDelta = 0;
      let hueDelta = 0;
      for (const wheel of COLOR_WHEELS) {
        const settingsValue = settings.colorMixer[0] ?? {
          hue: 0, saturation: 0, luminance: 0, red: 0, orange: 0, yellow: 0, green: 0, aqua: 0, blue: 0, purple: 0, magenta: 0,
        };
        const amount = settingsValue[wheel.key];
        if (amount === 0) continue;
        let distance = Math.abs(((hsl.h - wheel.hue + 540) % 360) - 180);
        distance = 180 - distance; // 0 = 完全命中
        const weight = Math.max(0, 1 - distance / 60) * hsl.s;
        saturationDelta += amount / 100 * weight;
        luminanceDelta += amount / 100 * weight * 0.6;
        hueDelta += amount / 100 * weight * 0.25;
      }
      const rgb = hslToRgb(hsl.h + hueDelta, Math.max(0, Math.min(1, hsl.s * (1 + saturationDelta))), Math.max(0, Math.min(1, hsl.l + luminanceDelta * 0.5)));
      data[i] = rgb.r;
      data[i + 1] = rgb.g;
      data[i + 2] = rgb.b;
    }
  }

  /* 颜色分级：阴影/中间调/高光各加一种色 */
  if (hasGrading(settings)) {
    for (let i = 0; i < data.length; i += 4) {
      const luma = (data[i]! + data[i + 1]! + data[i + 2]!) / 765;
      const weight = luma < 0.4
        ? gradingWeight(luma / 0.4)
        : (luma > 0.6 ? gradingWeight((luma - 0.6) / 0.4) : gradingWeight((luma - 0.4) / 0.2) * 0.6);
      if (weight <= 0) continue;
      const tone = luma < 0.4 ? settings.colorGrading.shadows : (luma > 0.6 ? settings.colorGrading.highlights : settings.colorGrading.mids);
      data[i] = data[i]! + tone[0] * weight;
      data[i + 1] = data[i + 1]! + tone[1] * weight;
      data[i + 2] = data[i + 2]! + tone[2] * weight;
    }
  }

  /* 细节：降噪与锐化 */
  if (settings.denoise > 0) {
    const smoothed = blurBufferLocal(working, 1 + Math.round(settings.denoise / 25));
    const weight = settings.denoise / 100;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = data[i]! * (1 - weight) + smoothed.data[i]! * weight;
      data[i + 1] = data[i + 1]! * (1 - weight) + smoothed.data[i + 1]! * weight;
      data[i + 2] = data[i + 2]! * (1 - weight) + smoothed.data[i + 2]! * weight;
    }
  }
  if (settings.sharpening > 0) {
    const radius = Math.max(0.5, settings.radius);
    const blurred = blurBufferLocal(working, radius);
    const amount = settings.sharpening / 100 * (settings.detail / 25);
    const threshold = 2;
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        const detail = data[i + c]! - blurred.data[i + c]!;
        if (Math.abs(detail) < threshold) continue;
        data[i + c] = data[i + c]! + detail * amount;
      }
    }
  }

  /* 光学：镜头畸变与去色边 */
  if (settings.distortion !== 0) applyRawDistortion(working, settings.distortion);
  if (settings.removeCA > 0) applyRawChromaticAberration(working, settings.removeCA);
  if (settings.defringe > 0) applyRawDefringe(working, settings.defringe);
  if (settings.vignette !== 0) applyRawVignette(working, settings.vignette);

  /* 收尾：裁剪与钳制 */
  const left = Math.round(settings.cropLeft);
  const top = Math.round(settings.cropTop);
  const right = Math.round(settings.cropRight);
  const bottom = Math.round(settings.cropBottom);
  let result = working;
  if (left > 0 || top > 0 || right > 0 || bottom > 0) {
    result = cropBuffer(
      working,
      Math.max(0, left),
      Math.max(0, top),
      Math.max(1, width - left - right),
      Math.max(1, height - top - bottom),
    );
  }
  for (let i = 0; i < result.data.length; i += 4) {
    result.data[i] = Math.max(0, Math.min(255, result.data[i]!));
    result.data[i + 1] = Math.max(0, Math.min(255, result.data[i + 1]!));
    result.data[i + 2] = Math.max(0, Math.min(255, result.data[i + 2]!));
  }
  return result;
}

function hasGrading(settings: CameraRawSettings): boolean {
  const values = [...settings.colorGrading.shadows, ...settings.colorGrading.mids, ...settings.colorGrading.highlights];
  return values.some((value) => value !== 0);
}

function gradingWeight(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function buildCurve(points: [number, number][]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  let index = 0;
  for (let i = 0; i < 256; i += 1) {
    while (index < sorted.length - 2 && sorted[index + 1]![0] < i) index += 1;
    const a = sorted[index]!;
    const b = sorted[index + 1]!;
    lut[i] = b[0] === a[0] ? b[1] : a[1] + ((i - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
  }
  return lut;
}

/** 简易盒式模糊（用于清晰度、降噪、锐化） */
function blurBufferLocal(buffer: PixelBuffer, radius: number): PixelBuffer {
  const out = createBuffer(buffer.width, buffer.height);
  const window = radius * 2 + 1;
  const temp = new Float32Array(buffer.data.length);
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      let r = 0; let g = 0; let b = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sx = Math.max(0, Math.min(buffer.width - 1, x + k));
        const i = (y * buffer.width + sx) * 4;
        r += buffer.data[i]!; g += buffer.data[i + 1]!; b += buffer.data[i + 2]!;
      }
      const di = (y * buffer.width + x) * 4;
      temp[di] = r / window; temp[di + 1] = g / window; temp[di + 2] = b / window; temp[di + 3] = buffer.data[di + 3]!;
    }
  }
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      let r = 0; let g = 0; let b = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sy = Math.max(0, Math.min(buffer.height - 1, y + k));
        const i = (sy * buffer.width + x) * 4;
        r += temp[i]!; g += temp[i + 1]!; b += temp[i + 2]!;
      }
      const di = (y * buffer.width + x) * 4;
      out.data[di] = r / window; out.data[di + 1] = g / window; out.data[di + 2] = b / window; out.data[di + 3] = buffer.data[di + 3]!;
    }
  }
  return out;
}

function applyRawDistortion(buffer: PixelBuffer, amount: number): void {
  const source = new Uint8ClampedArray(buffer.data);
  const { width, height } = buffer;
  const cx = width / 2;
  const cy = height / 2;
  const k = (amount / 100) * 0.4;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = (x - cx) / cx;
      const ny = (y - cy) / cy;
      const factor = 1 + k * (nx * nx + ny * ny);
      const sx = Math.max(0, Math.min(width - 1, Math.round(cx + nx * factor * cx)));
      const sy = Math.max(0, Math.min(height - 1, Math.round(cy + ny * factor * cy)));
      const si = (sy * width + sx) * 4;
      const di = (y * width + x) * 4;
      buffer.data[di] = source[si]!;
      buffer.data[di + 1] = source[si + 1]!;
      buffer.data[di + 2] = source[si + 2]!;
      buffer.data[di + 3] = source[si + 3]!;
    }
  }
}

function applyRawChromaticAberration(buffer: PixelBuffer, amount: number): void {
  const source = new Uint8ClampedArray(buffer.data);
  const { width, height } = buffer;
  const shift = Math.round((amount / 100) * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const di = (y * width + x) * 4;
      const rx = Math.max(0, Math.min(width - 1, x + shift));
      const bx = Math.max(0, Math.min(width - 1, x - shift));
      buffer.data[di] = source[(y * width + rx) * 4]!;
      buffer.data[di + 2] = source[(y * width + bx) * 4 + 2]!;
    }
  }
}

function applyRawDefringe(buffer: PixelBuffer, amount: number): void {
  const { data } = buffer;
  const threshold = 255 - (amount / 100) * 160;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i]! > threshold && data[i + 1]! > threshold && data[i + 2]! <= threshold) {
      data[i + 1] = Math.max(data[i + 1]!, data[i]!);
      data[i + 2] = Math.max(data[i + 2]!, data[i + 1]!);
    } else if (data[i + 2]! > threshold && data[i + 1]! > threshold && data[i]! <= threshold) {
      data[i] = Math.max(data[i]!, data[i + 1]!);
    }
  }
}

function applyRawVignette(buffer: PixelBuffer, amount: number): void {
  const { width, height, data } = buffer;
  const cx = width / 2;
  const cy = height / 2;
  const maxDistance = Math.hypot(cx, cy);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const distance = Math.hypot(x - cx, y - cy) / maxDistance;
      const factor = 1 - Math.max(0, amount / 100) * Math.max(0, distance - 0.55) * 1.6;
      const i = (y * width + x) * 4;
      data[i] *= factor;
      data[i + 1] *= factor;
      data[i + 2] *= factor;
    }
  }
  void fastLuma;
}
