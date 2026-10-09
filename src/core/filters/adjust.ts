import { pixelDepth, clampChannel, clampPixels } from '@/core/pixelFormat';
import type { PixelArray } from '@/types/document';
/**
 * 调整算法内核
 * ---------------------------------------------------------------
 * 12 种调整层的像素实现：
 * 色相/饱和度、色阶、曲线、曝光度、渐变映射、颗粒、黑白、色彩平衡、反相、
 * 高斯模糊、动感模糊、添加杂色。
 * 每个函数都支持「覆盖率」参数（来自选区与调整层蒙版），
 * 计算出新颜色后按覆盖率与原像素混合，因此调整永远不会越过选区边界。
 */
import { rgbToHsl, hslToRgb, makeRandom, fastLuma, srgbToLinear, linearToSrgb } from '@/core/color';
import { gaussianBlurBuffer, motionBlurBuffer } from '@/core/filters/blur';
import { cloneBuffer, createBuffer } from '@/core/pixels';
import type {
  AdjustmentKind,
  AdjustmentRecord,
  GrainSettings,
  CurvesSettings,
  GradientMapSettings,
  LevelRange,
  LevelsSettings,
  PixelBuffer,
} from '@/types/document';

/** 覆盖率：0-255 的数组，与缓冲等大；缺省表示全部生效 */
export type Coverage = Uint8Array | Float32Array | null;

/* ------------------------------ 查找表工具 ------------------------------ */

/** 由色阶区间生成 0-255 查找表 */
export function buildLevelsLut(range: LevelRange,precise=false): PixelArray {
  const lut = precise?new Float32Array(65536):new Uint8ClampedArray(256);
  const black = Math.min(range.black, range.white - 1);
  const white = Math.max(range.white, black + 1);
  const gamma = Math.max(0.01, range.gamma);
  const span = Math.max(1e-6, white - black);
  const outSpan = range.outputWhite - range.outputBlack;
  for (let i = 0; i < lut.length; i += 1) {
    let value = (i/(precise?257:1) - black) / span;
    value = value < 0 ? 0 : value > 1 ? 1 : value;
    value = Math.pow(value, 1 / gamma);
    lut[i] = clampChannel(range.outputBlack + value * outSpan);
  }
  return lut;
}

/** 由曲线生成 0-255 查找表（点按 x 递增，分段线性） */
export function buildCurveLut(points: [number, number][],precise=false): PixelArray {
  const lut = precise?new Float32Array(65536):new Uint8ClampedArray(256);
  const sorted = [...new Map(points.filter(p=>Number.isFinite(p[0])&&Number.isFinite(p[1])).map(p=>[p[0],p])).values()].sort((a,b)=>a[0]-b[0]);
  if (!sorted.length) { for(let i=0;i<lut.length;i++)lut[i]=i/(precise?257:1); return lut; }
  if(sorted.length===1)return lut.fill(sorted[0]![1]);
  const slopes=sorted.slice(1).map((p,i)=>(p[1]-sorted[i]![1])/(p[0]-sorted[i]![0]));
  const tangents=sorted.map((_,i)=>i===0?slopes[0]!:i===sorted.length-1?slopes.at(-1)!:slopes[i-1]!*slopes[i]!<=0?0:2/(1/slopes[i-1]!+1/slopes[i]!));
  let at=0;
  for(let index=0;index<lut.length;index++) {
    const x=index/(precise?257:1);
    if(x<=sorted[0]![0]){lut[index]=sorted[0]![1];continue;}
    if(x>=sorted.at(-1)![0]){lut[index]=sorted.at(-1)![1];continue;}
    while(at<sorted.length-2&&sorted[at+1]![0]<x)at++;
    const [x0,y0]=sorted[at]!,[x1,y1]=sorted[at+1]!,span=x1-x0,t=(x-x0)/span,t2=t*t,t3=t2*t;
    lut[index]=clampChannel((2*t3-3*t2+1)*y0+(t3-2*t2+t)*span*tangents[at]!+(-2*t3+3*t2)*y1+(t3-t2)*span*tangents[at+1]!);
  }
  return lut;
}

/** 渐变映射的色标列表（自定义优先，否则用阴影/中间调/高光三段） */
function gradientStops(settings: GradientMapSettings): { position: number; color: [number, number, number] }[] {
  if (settings.customStops && settings.customStops.length >= 2) {
    return [...settings.customStops].sort((a, b) => a.position - b.position);
  }
  return [
    { position: 0, color: settings.shadows },
    { position: 0.5, color: settings.mids },
    { position: 1, color: settings.highlights },
  ];
}

/** 渐变映射取值：按亮度在色标之间插值，`reversed` 反转明暗 */
export function gradientMapColor(settings: GradientMapSettings, value: number): [number, number, number] {
  const stops = gradientStops(settings);
  const t = Math.max(0, Math.min(1, settings.reversed ? 1-value/255 : value/255));
  let index = 0;
  while (index < stops.length - 2 && stops[index + 1].position < t) index += 1;
  const a = stops[index];
  const b = stops[index + 1];
  const span = Math.max(1e-6, b.position - a.position);
  const k = Math.max(0, Math.min(1, (t - a.position) / span));
  const color: [number, number, number] = [
    a.color[0] + (b.color[0] - a.color[0]) * k,
    a.color[1] + (b.color[1] - a.color[1]) * k,
    a.color[2] + (b.color[2] - a.color[2]) * k,
  ];
  return color;
}
/* ------------------------------ 各类调整 ------------------------------ */

/** 应用色阶（4 组区间：RGB 合成 + 红绿蓝） */
export function applyLevels(buffer: PixelBuffer, settings: LevelsSettings, coverage: Coverage = null): void {
  const [composite, red, green, blue] = settings.ranges;
  const precise=pixelDepth(buffer)===16;
  const read=(lut:PixelArray,value:number)=>lut[Math.round(clampChannel(value)*(precise?257:1))]!;
  const luts = [buildLevelsLut(composite,precise), buildLevelsLut(red,precise), buildLevelsLut(green,precise), buildLevelsLut(blue,precise)];
  const { data } = buffer;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    r = read(luts[0]!,r); g = read(luts[0]!,g); b = read(luts[0]!,b);
    r = read(luts[1]!,r); g = read(luts[2]!,g); b = read(luts[3]!,b);
    writeWithCoverage(data, i, r, g, b, coverage);
  }
}

/** 应用曲线 */
export function applyCurves(buffer: PixelBuffer, settings: CurvesSettings, coverage: Coverage = null): void {
  const [composite, red, green, blue] = settings.channels;
  const precise=pixelDepth(buffer)===16;
  const read=(lut:PixelArray,value:number)=>lut[Math.round(clampChannel(value)*(precise?257:1))]!;
  const luts = [buildCurveLut(composite.points,precise), buildCurveLut(red.points,precise), buildCurveLut(green.points,precise), buildCurveLut(blue.points,precise)];
  const { data } = buffer;
  for (let i = 0; i < data.length; i += 4) {
    let r = read(luts[0]!,data[i]!);
    let g = read(luts[0]!,data[i + 1]!);
    let b = read(luts[0]!,data[i + 2]!);
    r = read(luts[1]!,r); g = read(luts[2]!,g); b = read(luts[3]!,b);
    writeWithCoverage(data, i, r, g, b, coverage);
  }
}

/** 应用色相/饱和度（含「着色」） */
export function applyHueSaturation(
  buffer: PixelBuffer,
  hueShift: number,
  saturation: number,
  lightness: number,
  colorize: boolean,
  coverage: Coverage = null,
): void {
  const { data } = buffer;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    if (colorize) {
      // 着色：用明度保持原色相，用给定的色相/饱和度重建颜色
      const hsl = rgbToHsl(r, g, b);
      const rgb = hslToRgb(hueShift, Math.max(0, saturation / 100), hsl.l);
      r = rgb.r; g = rgb.g; b = rgb.b;
    } else {
      const hsl = rgbToHsl(r, g, b);
      const s = Math.max(0, Math.min(100, hsl.s * 100 + saturation));
      const l = Math.max(0, Math.min(100, hsl.l * 100 + lightness));
      const rgb = hslToRgb(hsl.h + hueShift, s / 100, l / 100);
      r = rgb.r; g = rgb.g; b = rgb.b;
    }
    writeWithCoverage(data, i, r, g, b, coverage);
  }
}

/** 应用曝光度 */
export function applyExposure(
  buffer: PixelBuffer,
  exposure: number,
  offset: number,
  gamma: number,
  coverage: Coverage = null,
): void {
  const factor = Math.pow(2, exposure);
  const gammaValue = Math.max(0.01, gamma);
  const { data } = buffer;
  for (let i = 0; i < data.length; i += 4) {
    // 在未编码的线性光中加档位，然后重新编码为sRGB。
    const expose=(v:number)=>linearToSrgb(Math.pow(Math.max(0,srgbToLinear(v)*factor+offset),1/gammaValue));
    const r=expose(data[i]!),g=expose(data[i+1]!),b=expose(data[i+2]!);
    writeWithCoverage(data, i, r, g, b, coverage);
  }
}

/** 应用渐变映射 */
export function applyGradientMap(buffer: PixelBuffer, settings: GradientMapSettings, coverage: Coverage = null): void {
  const { data } = buffer;
  const lut: [number, number, number][] = new Array(256);
  for (let i = 0; i < 256; i += 1) lut[i] = gradientMapColor(settings, i);
  for (let i = 0; i < data.length; i += 4) {
    const gray = fastLuma(data[i], data[i + 1], data[i + 2]) * 255;
    const color = pixelDepth(buffer)===16?gradientMapColor(settings,gray):lut[Math.round(gray)]!;
    writeWithCoverage(data, i, color[0], color[1], color[2], coverage);
  }
}

/** 应用颗粒：噪点强度按中间调加权，size 控制噪点颗粒粗细 */
export function applyGrain(buffer: PixelBuffer, settings: GrainSettings, coverage: Coverage = null): void {
  const { width, height, data } = buffer;
  const random = makeRandom(settings.seed || 1);
  const cell = Math.max(1, Math.round(settings.size));
  const gridW = Math.ceil(width / cell);
  const gridH = Math.ceil(height / cell);
  const noise = new Float32Array(gridW * gridH * 3);
  for (let i = 0; i < noise.length; i += 1) {
    // 粗糙度越高，分布越接近高斯
    const u = random();
    const shaped = settings.roughness > 0
      ? (settings.roughness / 100) * ((u + u + u - 1.5) / 1.5) + (1 - settings.roughness / 100) * (u - 0.5)
      : u - 0.5;
    noise[i] = shaped;
  }
  const sampleNoise = (gx: number, gy: number, channel: number): number => {
    const fx = Math.min(gridW - 1, Math.max(0, gx));
    const fy = Math.min(gridH - 1, Math.max(0, gy));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(gridW - 1, x0 + 1);
    const y1 = Math.min(gridH - 1, y0 + 1);
    const wx = fx - x0;
    const wy = fy - y0;
    const at = (x: number, y: number): number => noise[(y * gridW + x) * 3 + channel];
    const top = at(x0, y0) * (1 - wx) + at(x1, y0) * wx;
    const bottom = at(x0, y1) * (1 - wx) + at(x1, y1) * wx;
    return top * (1 - wy) + bottom * wy;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const gray = fastLuma(data[i], data[i + 1], data[i + 2]);
      // 中间调颗粒最重，两端衰减
      const weight = 1 - Math.abs(gray - 0.5) * 1.6;
      const amount = settings.amount * 0.5 * Math.max(0, weight);
      const colorMix = settings.colorAmount / 100;
      const nr = sampleNoise(x / cell, y / cell, 0) * amount * 255;
      const ng = sampleNoise(x / cell, y / cell, 1) * amount * 255;
      const nb = sampleNoise(x / cell, y / cell, 2) * amount * 255;
      const mono = (nr + ng + nb) / 3;
      const r = data[i] + nr * colorMix + mono * (1 - colorMix);
      const g = data[i + 1] + ng * colorMix + mono * (1 - colorMix);
      const b = data[i + 2] + nb * colorMix + mono * (1 - colorMix);
      writeWithCoverage(data, i, r, g, b, coverage);
    }
  }
}

/** 应用黑白（六色族权重近似 Photoshop 的转换矩阵） */
export function applyBlackWhite(buffer: PixelBuffer, settings: import('@/types/document').BlackWhiteSettings, coverage: Coverage = null): void {
  const { data } = buffer;
  const { reds, yellows, greens, cyans, blues, magentas } = settings;
  const gray = (r: number, g: number, b: number): number => {
    const rn = r / 255; const gn = g / 255; const bn = b / 255;
    const contribution =
      reds * Math.max(0, rn - Math.max(gn, bn))
      + yellows * Math.max(0, Math.min(rn, gn) - bn)
      + greens * Math.max(0, gn - Math.max(rn, bn))
      + cyans * Math.max(0, Math.min(gn, bn) - rn)
      + blues * Math.max(0, bn - Math.max(rn, gn))
      + magentas * Math.max(0, Math.min(rn, bn) - gn);
    const chroma = Math.max(0, Math.min(255, contribution));
    const base = fastLuma(r, g, b) * 255;
    // 亮度基底 + 色族权重，得到稳定的黑白映射
    return Math.max(0, Math.min(255, base * (0.35 + chroma / 255 * 1.6)));
  };
  const tint = settings.tintEnabled ? settings.tintColor : null;
  for (let i = 0; i < data.length; i += 4) {
    const v = gray(data[i], data[i + 1], data[i + 2]);
    let r = v; let g = v; let b = v;
    if (tint) {
      // 着色：用原色相给灰度上色
      const hsl = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      const tinted = hslToRgb(hsl.h, Math.min(0.6, hsl.s), v / 255);
      r = tinted.r; g = tinted.g; b = tinted.b;
    }
    writeWithCoverage(data, i, r, g, b, coverage);
  }
}

/** 应用色彩平衡 */
export function applyColorBalance(
  buffer: PixelBuffer,
  settings: import('@/types/document').ColorBalanceSettings,
  coverage: Coverage = null,
): void {
  const { data } = buffer;
  const clamp = (v: number): number => Math.max(-100, Math.min(100, v));
  const weights = (luma: number): [number, number, number] => {
    // 三段权重：暗部（0）、中间调（0.5）、高光（1）
    const shadow = Math.max(0, 1 - luma * 2.2);
    const highlight = Math.max(0, (luma - 0.72) * 3.6);
    const mid = Math.max(0, 1 - Math.abs(luma - 0.5) * 2.2);
    return [shadow, mid, highlight];
  };
  for (let i = 0; i < data.length; i += 4) {
    const r0 = data[i];
    const g0 = data[i + 1];
    const b0 = data[i + 2];
    const [ws, wm, wh] = weights(fastLuma(r0, g0, b0));
    const cr = clamp(settings.shadowCyanRed) * ws + clamp(settings.midCyanRed) * wm + clamp(settings.highlightCyanRed) * wh;
    const mg = clamp(settings.shadowMagentaGreen) * ws + clamp(settings.midMagentaGreen) * wm + clamp(settings.highlightMagentaGreen) * wh;
    const yb = clamp(settings.shadowYellowBlue) * ws + clamp(settings.midYellowBlue) * wm + clamp(settings.highlightYellowBlue) * wh;
    let r = r0 + cr * 0.6 - yb * 0.3;
    let g = g0 + mg * 0.6 + yb * 0.3;
    let b = b0 - cr * 0.6 - mg * 0.6;
    if (settings.preserveLuminosity) {
      const before = 0.3 * r0 + 0.59 * g0 + 0.11 * b0;
      const after = 0.3 * r + 0.59 * g + 0.11 * b;
      const d = before - after;
      r += d; g += d; b += d;
    }
    writeWithCoverage(data, i, r, g, b, coverage);
  }
}

/** 应用反相 */
export function applyInvert(buffer: PixelBuffer, coverage: Coverage = null): void {
  const { data } = buffer;
  for (let i = 0; i < data.length; i += 4) {
    writeWithCoverage(data, i, 255 - data[i], 255 - data[i + 1], 255 - data[i + 2], coverage);
  }
}

/** 应用添加杂色 */
export function applyAddNoise(
  buffer: PixelBuffer,
  amount: number,
  gaussian: boolean,
  monochromatic: boolean,
  seed: number,
  coverage: Coverage = null,
): void {
  const { data } = buffer;
  const random = makeRandom(seed || 1);
  const amplitude = amount * 0.35;
  for (let i = 0; i < data.length; i += 4) {
    const sample = (): number => {
      const u = random();
      if (!gaussian) return (u - 0.5) * 2;
      // Box-Muller 得到近似高斯
      const v = Math.max(1e-6, random());
      return Math.max(-2.5, Math.min(2.5, Math.sqrt(-2 * Math.log(v)) * Math.cos(2 * Math.PI * u)));
    };
    if (monochromatic) {
      const n = sample() * amplitude * 255;
      writeWithCoverage(data, i, data[i] + n, data[i + 1] + n, data[i + 2] + n, coverage);
    } else {
      writeWithCoverage(
        data, i,
        data[i] + sample() * amplitude * 255,
        data[i + 1] + sample() * amplitude * 255,
        data[i + 2] + sample() * amplitude * 255,
        coverage,
      );
    }
  }
}

/* ------------------------------ 分发器 ------------------------------ */

/** 邻域采样类（会返回新的缓冲） */
export function isSamplingAdjustment(kind: AdjustmentKind): boolean {
  return kind === 'Gaussian Blur' || kind === 'Motion Blur';
}

/** 对缓冲应用指定的调整；返回新缓冲（模糊类会替换整块像素） */
export function applyAdjustment(buffer: PixelBuffer, record: AdjustmentRecord, coverage: Coverage = null): PixelBuffer {
  switch (record.kind) {
    case 'Hue/Saturation':
      applyHueSaturation(buffer, record.hue, record.saturation, record.lightness, record.colorize, coverage);
      return buffer;
    case 'Levels':
      applyLevels(buffer, record.levels, coverage);
      return buffer;
    case 'Curves':
      applyCurves(buffer, record.curves, coverage);
      return buffer;
    case 'Exposure':
      applyExposure(buffer, record.exposureSettings.exposure, record.exposureSettings.offset, record.exposureSettings.gamma, coverage);
      return buffer;
    case 'Gradient Map':
      applyGradientMap(buffer, record.gradientMapSettings, coverage);
      return buffer;
    case 'Grain':
      applyGrain(buffer, record.grainSettings, coverage);
      return buffer;
    case 'Black & White':
      applyBlackWhite(buffer, record.blackWhiteSettings, coverage);
      return buffer;
    case 'Color Balance':
      applyColorBalance(buffer, record.colorBalanceSettings, coverage);
      return buffer;
    case 'Invert':
      applyInvert(buffer, coverage);
      return buffer;
    case 'Add Noise':
      applyAddNoise(buffer, record.noiseAmount, record.noiseGaussian, record.noiseMonochromatic, record.noiseSeed, coverage);
      return buffer;
    case 'Gaussian Blur': {
      const blurred = gaussianBlurBuffer(cloneBuffer(buffer), record.blurRadius);
      return mixBuffers(buffer, blurred, coverage);
    }
    case 'Motion Blur': {
      const blurred = motionBlurBuffer(cloneBuffer(buffer), record.motionAngle, record.motionDistance);
      return mixBuffers(buffer, blurred, coverage);
    }
    default:
      return buffer;
  }
}

/** 按覆盖率把新缓冲混合回原缓冲 */
function mixBuffers(base: PixelBuffer, layer: PixelBuffer, coverage: Coverage): PixelBuffer {
  if (!coverage) return layer;
  const out = cloneBuffer(base);
  for (let i = 0; i < out.data.length; i += 4) {
    const k = coverage[i / 4] / 255;
    if (k <= 0) continue;
    out.data[i] = base.data[i] * (1 - k) + layer.data[i] * k;
    out.data[i + 1] = base.data[i + 1] * (1 - k) + layer.data[i + 1] * k;
    out.data[i + 2] = base.data[i + 2] * (1 - k) + layer.data[i + 2] * k;
  }
  return out;
}

/** 按覆盖率写回像素（覆盖率 255 表示完全替换） */
function writeWithCoverage(data: PixelArray, index: number, r: number, g: number, b: number, coverage: Coverage): void {
  r=clampChannel(r);g=clampChannel(g);b=clampChannel(b);
  if (coverage) {
    const k = coverage[index / 4] / 255;
    if (k <= 0) return;
    if (k < 1) {
      data[index] = data[index] * (1 - k) + r * k;
      data[index + 1] = data[index + 1] * (1 - k) + g * k;
      data[index + 2] = data[index + 2] * (1 - k) + b * k;
      return;
    }
  }
  data[index] = r;
  data[index + 1] = g;
  data[index + 2] = b;
}

/** 自动色阶：按 0.1% 裁剪点计算黑白场 */
export function autoLevelsRange(buffer: PixelBuffer, channel: 'RGB' | 'Red' | 'Green' | 'Blue'): LevelRange {
  const histogram = new Uint32Array(256);
  const { data } = buffer;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    if (channel === 'Red' || channel === 'RGB') histogram[Math.round(clampChannel(data[i]!))] += 1;
    if (channel === 'Green' || channel === 'RGB') histogram[Math.round(clampChannel(data[i+1]!))] += 1;
    if (channel === 'Blue' || channel === 'RGB') histogram[Math.round(clampChannel(data[i+2]!))] += 1;
  }
  let total = 0;
  for (let i = 0; i < 256; i += 1) total += histogram[i];
  const clip = total * 0.001;
  let acc = 0;
  let black = 0;
  let white = 255;
  for (let i = 0; i < 256; i += 1) {
    acc += histogram[i];
    if (acc > clip) { black = i; break; }
  }
  acc = 0;
  for (let i = 255; i >= 0; i -= 1) {
    acc += histogram[i];
    if (acc > clip) { white = i; break; }
  }
  if (white - black < 4) { black = 0; white = 255; }
  return { black, gamma: 1, white, outputBlack: 0, outputWhite: 255 };
}

/** 空缓冲（用于调整层占位） */
export function emptyBuffer(width: number, height: number): PixelBuffer {
  return createBuffer(width, height);
}
