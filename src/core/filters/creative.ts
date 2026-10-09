import { copyPixels, pixelDepth, clampPixels } from '@/core/pixelFormat';
/**
 * 创意滤镜
 * ---------------------------------------------------------------
 * 渐晕、辉光/泛光、色调反差、镜头校正、移除背景、USM 锐化、降噪。
 * 这些是「破坏性」滤镜：直接作用在当前像素层的缓冲上（受选区限制）。
 */
import { fastLuma, rgbToHsl, hslToRgb, makeRandom } from '@/core/color';
import { gaussianBlurBuffer } from '@/core/filters/blur';
import type { PixelBuffer } from '@/types/document';
import type { Coverage } from '@/core/filters/adjust';

export interface VignetteOptions {
  amount: number;      // -100 ~ 100
  midpoint: number;    // 0 ~ 100
  roundness: number;   // -100 ~ 100
  feather: number;     // 0 ~ 100
  color: [number, number, number];
  blendMode: 'Blend' | 'Multiply' | 'Screen';
}

export function applyVignette(buffer: PixelBuffer, options: VignetteOptions, coverage: Coverage = null): void {
  const { width, height, data } = buffer;
  const cx = width / 2;
  const cy = height / 2;
  const maxDistance = Math.hypot(cx, cy);
  const amount = options.amount / 100;
  const midpoint = Math.max(0.01, options.midpoint / 100);
  const roundness = options.roundness / 100;
  const feather = Math.max(0.01, options.feather / 100);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      let nx = (x - cx) / maxDistance;
      let ny = (y - cy) / maxDistance;
      if (roundness !== 0) {
        const scale = 1 + roundness * 0.5;
        nx /= scale;
        ny /= scale;
      }
      const distance = Math.hypot(nx, ny) / Math.SQRT2;
      const t = Math.max(0, (distance - midpoint) / (1 - midpoint));
      const shape = Math.min(1, Math.pow(t / feather, 2));
      if (shape <= 0) continue;
      const k = amount * shape;
      const kk = coverage ? (coverage[i / 4] / 255) : 1;
      const v = Math.max(0, Math.min(1, Math.abs(k)));
      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];
      const color = options.color;
      let mixed: [number, number, number];
      if (options.blendMode === 'Blend') {
        mixed = [r * (1 - v) + color[0] * v, g * (1 - v) + color[1] * v, b * (1 - v) + color[2] * v];
      } else if (options.blendMode === 'Multiply') {
        const f = 1 - v * 0.95;
        mixed = [r * f * (1 - v) + color[0] * v, g * f * (1 - v) + color[1] * v, b * f * (1 - v) + color[2] * v];
      } else {
        const f = 1 + v * 0.95;
        mixed = [r + (color[0] - r) * v, g + (color[1] - g) * v, b + (color[2] - b) * v];
        void f;
      }
      data[i] = r * (1 - kk) + mixed[0] * kk;
      data[i + 1] = g * (1 - kk) + mixed[1] * kk;
      data[i + 2] = b * (1 - kk) + mixed[2] * kk;
    }
  }
  clampPixels(buffer);
}

export interface BloomOptions {
  radius: number;
  intensity: number;
  threshold: number;
  color: [number, number, number];
  blendMode: 'Screen' | 'Blend' | 'Add';
}

/** 辉光/泛光：先按阈值取高光，做模糊后再按颜色叠回 */
export function applyBloom(buffer: PixelBuffer, options: BloomOptions, coverage: Coverage = null): void {
  const { width, height, data } = buffer;
  const highlights = gaussianBlurBuffer({ width, height, data: copyPixels(data),bitDepth:pixelDepth(buffer) }, Math.max(1, options.radius));
  const threshold = options.threshold / 100;
  for (let i = 0; i < data.length; i += 4) {
    const kk = coverage ? (coverage[i / 4] / 255) : 1;
    if (kk <= 0) continue;
    const luma = fastLuma(data[i], data[i + 1], data[i + 2]);
    if (luma < threshold) continue;
    const weight = ((luma - threshold) / Math.max(1e-4, 1 - threshold)) * (options.intensity / 100);
    const bloomColor: [number, number, number] = [
      highlights.data[i] * weight,
      highlights.data[i + 1] * weight,
      highlights.data[i + 2] * weight,
    ];
    const tint = options.color;
    let r: number;
    let g: number;
    let b: number;
    if (options.blendMode === 'Add') {
      r = data[i] + bloomColor[0] + tint[0] * weight * 0.5;
      g = data[i + 1] + bloomColor[1] + tint[1] * weight * 0.5;
      b = data[i + 2] + bloomColor[2] + tint[2] * weight * 0.5;
    } else if (options.blendMode === 'Blend') {
      const v = Math.min(1, weight);
      r = data[i] * (1 - v) + (bloomColor[0] + tint[0] * 0.5) * v;
      g = data[i + 1] * (1 - v) + (bloomColor[1] + tint[1] * 0.5) * v;
      b = data[i + 2] * (1 - v) + (bloomColor[2] + tint[2] * 0.5) * v;
    } else {
      // Screen：1 - (1-a)(1-b)
      r = 255 - (255 - data[i]) * (255 - Math.min(255, bloomColor[0] + tint[0] * 0.4)) / 255;
      g = 255 - (255 - data[i + 1]) * (255 - Math.min(255, bloomColor[1] + tint[1] * 0.4)) / 255;
      b = 255 - (255 - data[i + 2]) * (255 - Math.min(255, bloomColor[2] + tint[2] * 0.4)) / 255;
    }
    data[i] = data[i] * (1 - kk) + r * kk;
    data[i + 1] = data[i + 1] * (1 - kk) + g * kk;
    data[i + 2] = data[i + 2] * (1 - kk) + b * kk;
  }
  clampPixels(buffer);
}

export interface TonalContrastOptions {
  shadows: number;
  highlights: number;
  color: boolean;
  /** 中间调保护 */
  protectMidtones: boolean;
}

/** 色调反差：拉开暗部与高光，可同时提升饱和度 */
export function applyTonalContrast(buffer: PixelBuffer, options: TonalContrastOptions, coverage: Coverage = null): void {
  const { data } = buffer;
  const shadows = options.shadows / 100;
  const highlights = options.highlights / 100;
  for (let i = 0; i < data.length; i += 4) {
    const kk = coverage ? (coverage[i / 4] / 255) : 1;
    if (kk <= 0) continue;
    let r = data[i] / 255;
    let g = data[i + 1] / 255;
    let b = data[i + 2] / 255;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const shadowFactor = options.protectMidtones
      ? Math.max(0, 1 - luma * 2)
      : 1;
    const highlightFactor = options.protectMidtones
      ? Math.max(0, (luma - 0.5) * 2)
      : 1;
    const curve = (value: number, factor: number, amount: number): number => {
      const contrast = 1 + amount * factor;
      return Math.max(0, Math.min(1, (value - 0.5) * contrast + 0.5));
    };
    r = curve(r, shadowFactor, shadows);
    g = curve(g, shadowFactor, shadows);
    b = curve(b, shadowFactor, shadows);
    r = curve(r, highlightFactor, highlights);
    g = curve(g, highlightFactor, highlights);
    b = curve(b, highlightFactor, highlights);
    if (options.color) {
      const hsl = rgbToHsl(r * 255, g * 255, b * 255);
      const boosted = hslToRgb(hsl.h, Math.min(1, hsl.s * 1.25), hsl.l);
      r = boosted.r / 255;
      g = boosted.g / 255;
      b = boosted.b / 255;
    }
    data[i] = (data[i] * (1 - kk) + r * 255 * kk);
    data[i + 1] = (data[i + 1] * (1 - kk) + g * 255 * kk);
    data[i + 2] = (data[i + 2] * (1 - kk) + b * 255 * kk);
  }
  clampPixels(buffer);
}

export interface LensCorrectionOptions {
  distortion: number;   // -100 ~ 100
  chromaticAberration: number; // 0 ~ 100
  vignette: number;     // -100 ~ 100
  /** 色差校正方向 */
  correction: boolean;
}

/** 镜头校正：桶形/枕形畸变 + 横向色差 + 暗角 */
export function applyLensCorrection(buffer: PixelBuffer, options: LensCorrectionOptions): void {
  const { width, height } = buffer;
  const source = copyPixels(buffer.data);
  const cx = width / 2;
  const cy = height / 2;
  const k = (options.distortion / 100) * 0.6 * (options.correction ? -1 : 1);
  const ca = (options.chromaticAberration / 100) * 3 * (options.correction ? 1 : 1);
  const vignette = options.vignette / 100;
  const sample = (channel: number, dx: number, dy: number): number => {
    const sx = Math.max(0, Math.min(width - 1, Math.round(cx + dx)));
    const sy = Math.max(0, Math.min(height - 1, Math.round(cy + dy)));
    return source[(sy * width + sx) * 4 + channel];
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const nx = (x - cx) / cx;
      const ny = (y - cy) / cy;
      const r2 = nx * nx + ny * ny;
      const factor = 1 + k * r2;
      const dx = nx * factor * cx;
      const dy = ny * factor * cy;
      if (ca > 0.01) {
        // 红蓝通道不同缩放，得到横向色差
        buffer.data[i] = sample(0, dx * (1 + ca / 100), dy * (1 + ca / 100));
        buffer.data[i + 1] = sample(1, dx, dy);
        buffer.data[i + 2] = sample(2, dx * (1 - ca / 100), dy * (1 - ca / 100));
      } else {
        buffer.data[i] = sample(0, dx, dy);
        buffer.data[i + 1] = sample(1, dx, dy);
        buffer.data[i + 2] = sample(2, dx, dy);
      }
      buffer.data[i + 3] = sample(3, dx, dy);
      if (vignette !== 0) {
        const dark = 1 - Math.max(0, vignette) * Math.min(1, r2 * 0.9);
        buffer.data[i] *= dark;
        buffer.data[i + 1] *= dark;
        buffer.data[i + 2] *= dark;
      }
    }
  }
  clampPixels(buffer);
}

export interface SharpenOptions {
  amount: number;   // 0 ~ 300
  radius: number;   // 0.3 ~ 250
  threshold: number; // 0 ~ 100
}

/** USM 锐化 */
export function applySharpen(buffer: PixelBuffer, options: SharpenOptions, coverage: Coverage = null): void {
  const blurred = gaussianBlurBuffer(buffer, Math.max(0.3, options.radius));
  const threshold = (options.threshold / 100) * 255;
  const amount = options.amount / 100;
  const { data } = buffer;
  for (let i = 0; i < data.length; i += 4) {
    const kk = coverage ? (coverage[i / 4] / 255) : 1;
    if (kk <= 0) continue;
    for (let c = 0; c < 3; c += 1) {
      const detail = data[i + c] - blurred.data[i + c];
      if (Math.abs(detail) < threshold) continue;
      data[i + c] = data[i + c] + detail * amount * kk;
    }
  }
  clampPixels(buffer);
}

export interface DenoiseOptions {
  luminance: number;
  color: number;
  radius: number;
}

/** 降噪：先按亮度平滑，再按颜色分量做中值式去色斑 */
export function applyDenoise(buffer: PixelBuffer, options: DenoiseOptions, coverage: Coverage = null): void {
  const radius = Math.max(0.5, options.radius);
  const smooth = gaussianBlurBuffer(buffer, radius);
  const colorStrength = options.color / 100;
  const lumaStrength = options.luminance / 100;
  const { data } = buffer;
  for (let i = 0; i < data.length; i += 4) {
    const kk = coverage ? (coverage[i / 4] / 255) : 1;
    if (kk <= 0) continue;
    // 亮度平滑：三个通道统一按 lumaStrength 向模糊结果靠拢
    const lr = data[i] * (1 - lumaStrength) + smooth.data[i] * lumaStrength;
    const lg = data[i + 1] * (1 - lumaStrength) + smooth.data[i + 1] * lumaStrength;
    const lb = data[i + 2] * (1 - lumaStrength) + smooth.data[i + 2] * lumaStrength;
    // 颜色降噪：把各通道与平均色的偏差按 colorStrength 压缩
    const average = (lr + lg + lb) / 3;
    const cr = lr + (average - lr) * colorStrength;
    const cg = lg + (average - lg) * colorStrength;
    const cb = lb + (average - lb) * colorStrength;
    data[i] = data[i] * (1 - kk) + cr * kk;
    data[i + 1] = data[i + 1] * (1 - kk) + cg * kk;
    data[i + 2] = data[i + 2] * (1 - kk) + cb * kk;
  }
  clampPixels(buffer);
}

/**
 * 移除背景
 * ---------------------------------------------------------------
 * 与「选择主体」共用显著图思路：找到与边缘背景差异最大的连通域并抠掉，
 * 羽化后写入 alpha。这里返回新的 alpha 通道而不是直接改 RGB。
 */
export function removeBackground(buffer: PixelBuffer, sensitivity = 50): PixelBuffer {
  const { width, height } = buffer;
  const border = Math.max(2, Math.round(Math.min(width, height) * 0.06));
  const histogram = new Map<number, number>();
  const add = (x: number, y: number): void => {
    const p = (y * width + x) * 4;
    if (buffer.data[p + 3] < 8) return;
    const key = ((buffer.data[p] >> 4) << 8) | ((buffer.data[p + 1] >> 4) << 4) | (buffer.data[p + 2] >> 4);
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < width; x += 1) {
    for (let k = 0; k < border; k += 1) { add(x, k); add(x, height - 1 - k); }
  }
  for (let y = 0; y < height; y += 1) {
    for (let k = 0; k < border; k += 1) { add(k, y); add(width - 1 - k, y); }
  }
  const total = width * height;
  const mask = new Uint8Array(total);
  const threshold = 0.55 - (sensitivity / 100) * 0.3;
  for (let i = 0; i < total; i += 1) {
    const p = i * 4;
    const key = ((buffer.data[p] >> 4) << 8) | ((buffer.data[p + 1] >> 4) << 4) | (buffer.data[p + 2] >> 4);
    const isBg = (histogram.get(key) ?? 0) > 0;
    const cx = ((i % width) / width - 0.5) * 2;
    const cy = (((i / width) | 0) / height - 0.5) * 2;
    const centerBias = 1 - Math.min(1, Math.hypot(cx, cy) / 1.42);
    const score = (isBg ? 0 : 1) * (0.4 + 0.6 * centerBias);
    mask[i] = score >= threshold ? 0 : 255; // 0 = 去掉背景
  }
  const feather = 1.5;
  const blurred = (() => {
    // 简单两遍盒式模糊得到软边
    let src = Float32Array.from(mask);
    let dst = new Float32Array(src.length);
    const r = Math.max(1, Math.round(feather));
    for (let pass = 0; pass < 2; pass += 1) {
      for (let y = 0; y < height; y += 1) {
        let sum = 0;
        for (let i = -r; i <= r; i += 1) sum += src[y * width + Math.min(width - 1, Math.max(0, i))];
        for (let x = 0; x < width; x += 1) {
          dst[y * width + x] = sum / (2 * r + 1);
          sum += src[y * width + Math.min(width - 1, x + r + 1)] - src[y * width + Math.max(0, x - r)];
        }
      }
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        for (let i = -r; i <= r; i += 1) sum += src[Math.min(height - 1, Math.max(0, i)) * width + x];
        for (let y = 0; y < height; y += 1) {
          dst[y * width + x] = sum / (2 * r + 1);
          sum += src[Math.min(height - 1, y + r + 1) * width + x] - src[Math.max(0, y - r) * width + x];
        }
      }
      const tmp = src; src = dst; dst = tmp;
    }
    return src;
  })();
  const out = { width, height, data: copyPixels(buffer.data) };
  for (let i = 0; i < total; i += 1) {
    const p = i * 4;
    out.data[p + 3] = Math.max(0, Math.min(255, blurred[i]));
  }
  return out;
}

/** 抖动：模拟有限色深（可选的有序抖动与噪声抖动） */
export function applyDither(buffer: PixelBuffer, levels: number, seed: number): void {
  const random = makeRandom(seed || 7);
  const step = 255 / Math.max(2, levels - 1);
  const { data } = buffer;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const value = data[i + c] + (random() - 0.5) * step;
      data[i + c] = Math.round(value / step) * step;
    }
  }
  clampPixels(buffer);
}
