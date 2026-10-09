import { pixelDepth } from '@/core/pixelFormat';
import type { BitDepth } from '@/types/document';
/**
 * 画布表面（Surface）与图层效果
 * ---------------------------------------------------------------
 * 一个 Surface 表示「某个图层在文档空间中的矩形区域 + 已变换的像素」，
 * 图层效果在 Surface 上烘焙（描边/投影/辉光等），
 * 合成器再把整个 Surface 一次性混合进目标缓冲。
 */
import { createBuffer } from '@/core/pixels';
import type { LayerEffects, PixelBuffer, Rect } from '@/types/document';

/** 表面：rect 为文档空间的矩形，缓冲尺寸 = rect 尺寸 × scale */
export interface Surface {
  buffer: PixelBuffer;
  rect: Rect;
  scale: number;
}

/** 提取 alpha 通道为 0-1 的浮点数组 */
export function alphaChannel(buffer: PixelBuffer): Float32Array {
  const alpha = new Float32Array(buffer.width * buffer.height);
  for (let i = 0, p = 3; i < alpha.length; i += 1, p += 4) alpha[i] = buffer.data[p] / 255;
  return alpha;
}

/** 形态学膨胀（可分离的最大值滤波，结构元为方形） */
export function dilateAlpha(alpha: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius <= 0) return alpha;
  const temp = new Float32Array(alpha.length);
  const out = new Float32Array(alpha.length);
  maxFilterH(alpha, temp, width, height, radius);
  maxFilterV(temp, out, width, height, radius);
  return out;
}

/** 形态学腐蚀（最小值滤波） */
export function erodeAlpha(alpha: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius <= 0) return alpha;
  const inverted = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i += 1) inverted[i] = 1 - alpha[i];
  const temp = new Float32Array(alpha.length);
  const out = new Float32Array(alpha.length);
  maxFilterH(inverted, temp, width, height, radius);
  maxFilterV(temp, out, width, height, radius);
  for (let i = 0; i < out.length; i += 1) out[i] = 1 - out[i];
  return out;
}

function maxFilterH(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number): void {
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let value = src[row + x];
      const start = Math.max(0, x - radius);
      const end = Math.min(width - 1, x + radius);
      for (let i = start; i <= end; i += 1) {
        if (src[row + i] > value) value = src[row + i];
      }
      dst[row + x] = value;
    }
  }
}

function maxFilterV(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number): void {
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      let value = src[y * width + x];
      const start = Math.max(0, y - radius);
      const end = Math.min(height - 1, y + radius);
      for (let i = start; i <= end; i += 1) {
        if (src[i * width + x] > value) value = src[i * width + x];
      }
      dst[y * width + x] = value;
    }
  }
}

/** 双线性模糊 alpha（用于发光/投影的柔化） */
export function blurAlpha(alpha: Float32Array, width: number, height: number, radius: number): Float32Array {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return alpha;
  const temp = new Float32Array(alpha.length);
  const out = new Float32Array(alpha.length);
  boxBlur1D(alpha, temp, width, height, r, true);
  boxBlur1D(temp, out, width, height, r, false);
  return out;
}

function boxBlur1D(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number, horizontal: boolean): void {
  const window = radius * 2 + 1;
  const outer = horizontal ? height : width;
  const inner = horizontal ? width : height;
  for (let o = 0; o < outer; o += 1) {
    let sum = 0;
    for (let i = -radius; i <= radius; i += 1) {
      const p = horizontal ? o * width + Math.min(width - 1, Math.max(0, i)) : Math.min(height - 1, Math.max(0, i)) * width + o;
      sum += src[p];
    }
    for (let i = 0; i < inner; i += 1) {
      const p = horizontal ? o * width + i : i * width + o;
      dst[p] = sum / window;
      const addIndex = horizontal
        ? o * width + Math.min(width - 1, i + radius + 1)
        : Math.min(height - 1, i + radius + 1) * width + o;
      const subIndex = horizontal
        ? o * width + Math.max(0, i - radius)
        : Math.max(0, i - radius) * width + o;
      sum += src[addIndex] - src[subIndex];
    }
  }
}

/** 把 alpha 按颜色着色，返回新的 RGBA 缓冲（alpha 为 0 的位置保持 0） */
export function tintAlpha(alpha: Float32Array, width: number, height: number, color: [number, number, number], opacity: number,bitDepth:BitDepth=8): PixelBuffer {
  const out = createBuffer(width, height,undefined,bitDepth);
  for (let i = 0, p = 0; i < alpha.length; i += 1, p += 4) {
    const a = alpha[i] * opacity;
    if (a <= 0) continue;
    out.data[p] = color[0];
    out.data[p + 1] = color[1];
    out.data[p + 2] = color[2];
    out.data[p + 3] = a * 255;
  }
  return out;
}

/** 表面扩展：把矩形向外扩 n 像素（用于容纳发光与投影） */
export function expandRect(rect: Rect, margin: number): Rect {
  return { x: rect.x - margin, y: rect.y - margin, width: rect.width + margin * 2, height: rect.height + margin * 2 };
}

/** 在表面外侧（投影、外发光）叠加一个着色层 */
function compositeOutside(target: Surface, layer: PixelBuffer, offsetX: number, offsetY: number): void {
  const { buffer, scale } = target;
  for (let y = 0; y < buffer.height; y += 1) {
    const sy = Math.round(y - offsetY * scale);
    if (sy < 0 || sy >= layer.height) continue;
    for (let x = 0; x < buffer.width; x += 1) {
      const sx = Math.round(x - offsetX * scale);
      if (sx < 0 || sx >= layer.width) continue;
      const si = (sy * layer.width + sx) * 4;
      const as = layer.data[si + 3] / 255;
      if (as <= 0) continue;
      const di = (y * buffer.width + x) * 4;
      const ab = buffer.data[di + 3] / 255;
      const outA = ab + as * (1 - ab);
      if (outA <= 0) continue;
      buffer.data[di] = (buffer.data[di] * ab + layer.data[si] * as * (1 - ab)) / outA;
      buffer.data[di + 1] = (buffer.data[di + 1] * ab + layer.data[si + 1] * as * (1 - ab)) / outA;
      buffer.data[di + 2] = (buffer.data[di + 2] * ab + layer.data[si + 2] * as * (1 - ab)) / outA;
      buffer.data[di + 3] = outA * 255;
    }
  }
}

/** 在表面内侧（颜色叠加、内阴影、内发光、描边）叠加一个着色层 */
function compositeInside(target: Surface, layer: PixelBuffer): void {
  const { buffer } = target;
  const { width, height } = buffer;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const si = (y * layer.width + x) * 4;
      const as = layer.data[si + 3] / 255;
      if (as <= 0) continue;
      const di = (y * width + x) * 4;
      const ab = buffer.data[di + 3] / 255;
      // 着色层的 alpha 已由原像素覆盖率生成；内侧效果改变颜色而不增加轮廓 alpha。
      if (ab <= 0) continue;
      const weight = Math.min(1, as / ab);
      for (let c = 0; c < 3; c++) buffer.data[di + c] = layer.data[si + c] * weight + buffer.data[di + c] * (1 - weight);
    }
  }
}

/**
 * 把图层效果烘焙进表面。
 * 顺序与 Photoshop 一致：投影 → 外发光（在下）→ 图层像素 → 颜色叠加 →
 * 内阴影 → 内发光 → 描边。
 * @param surface 已包含图层像素的表面（rect 可被向外扩展以容纳外部效果）
 */
export function bakeEffects(surface: Surface, effects: LayerEffects): Surface {
  const keys = Object.keys(effects).filter((key) => {
    const value = (effects as Record<string, { enabled?: boolean } | undefined>)[key];
    return Boolean(value && value.enabled !== false);
  }) as (keyof LayerEffects)[];
  if (keys.length === 0) return surface;

  // 内部效果也需要一圈透明采样边界，否则实心矩形边缘无法被腐蚀检测。
  let margin = Math.ceil(1 / surface.scale);
  if (effects.shadow && effects.shadow.enabled !== false) margin = Math.max(margin, Math.ceil(effects.shadow.distance + effects.shadow.blur * 2));
  if (effects.outerGlow && effects.outerGlow.enabled !== false) margin = Math.max(margin, Math.ceil(effects.outerGlow.size * 1.5));
  if (effects.stroke && effects.stroke.enabled !== false && !effects.stroke.inside) margin = Math.max(margin, Math.ceil(effects.stroke.size));
  // 内部效果不需要扩边，但仍需执行；不以 margin=0 提前返回。

  // rect/margin 是文档坐标；复制时要转成缓冲像素，不能再把缩小的图像裁一次。
  const expanded = expandRect(surface.rect, margin);
  const buffer = createBuffer(
    Math.max(1, Math.round(expanded.width * surface.scale)),
    Math.max(1, Math.round(expanded.height * surface.scale)),
    undefined,pixelDepth(surface.buffer),
  );
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      const sx = Math.round(x + (expanded.x - surface.rect.x) * surface.scale);
      const sy = Math.round(y + (expanded.y - surface.rect.y) * surface.scale);
      if (sx < 0 || sy < 0 || sx >= surface.buffer.width || sy >= surface.buffer.height) continue;
      const si = (sy * surface.buffer.width + sx) * 4;
      const di = (y * buffer.width + x) * 4;
      buffer.data[di] = surface.buffer.data[si];
      buffer.data[di + 1] = surface.buffer.data[si + 1];
      buffer.data[di + 2] = surface.buffer.data[si + 2];
      buffer.data[di + 3] = surface.buffer.data[si + 3];
    }
  }
  surface = { buffer, rect: expanded, scale: surface.scale };
  const { width, height } = buffer;
  const alpha = alphaChannel(buffer);

  if (effects.shadow && effects.shadow.enabled !== false) {
    const shadow = effects.shadow;
    const angle = (shadow.angle * Math.PI) / 180;
    const dx = Math.cos(angle) * shadow.distance * surface.scale;
    const dy = Math.sin(angle) * shadow.distance * surface.scale;
    const shifted = shiftAlpha(alpha, width, height, Math.round(dx), Math.round(dy));
    const blurred = blurAlpha(shifted, width, height, Math.max(0, shadow.blur * surface.scale));
    const tint = tintAlpha(blurred, width, height, shadow.color, shadow.opacity,pixelDepth(surface.buffer));
    compositeOutside(surface, tint, 0, 0);
  }

  if (effects.outerGlow && effects.outerGlow.enabled !== false) {
    const glow = effects.outerGlow;
    const grown = dilateAlpha(alpha, width, height, Math.max(1, Math.round(glow.size * surface.scale)));
    const blurred = blurAlpha(grown, width, height, Math.max(1, Math.round(glow.size * surface.scale * 0.6)));
    const tint = tintAlpha(blurred, width, height, glow.color, glow.opacity,pixelDepth(surface.buffer));
    compositeOutside(surface, tint, 0, 0);
  }

  if (effects.colorOverlay && effects.colorOverlay.enabled !== false) {
    const overlay = effects.colorOverlay;
    const tint = tintAlpha(alpha, width, height, overlay.color, overlay.opacity,pixelDepth(surface.buffer));
    compositeInside(surface, tint);
  }

  if (effects.innerShadow && effects.innerShadow.enabled !== false) {
    const inner = effects.innerShadow;
    const angle = (inner.angle * Math.PI) / 180;
    const dx = Math.round(Math.cos(angle) * inner.distance * surface.scale);
    const dy = Math.round(Math.sin(angle) * inner.distance * surface.scale);
    const shifted = shiftAlpha(alpha, width, height, -dx, -dy);
    const blurred = blurAlpha(shifted, width, height, Math.max(0, inner.blur * surface.scale));
    const eroded = erodeAlpha(alpha, width, height, 1);
    const insideMask = new Float32Array(width * height);
    for (let i = 0; i < insideMask.length; i += 1) insideMask[i] = Math.max(0, eroded[i] - blurred[i]) * (1 - alpha[i] * 0);
    const tint = tintAlpha(insideMask, width, height, inner.color, inner.opacity,pixelDepth(surface.buffer));
    compositeInside(surface, tint);
  }

  if (effects.innerGlow && effects.innerGlow.enabled !== false) {
    const glow = effects.innerGlow;
    const eroded = erodeAlpha(alpha, width, height, Math.max(1, Math.round(glow.size * surface.scale)));
    const blurred = blurAlpha(eroded, width, height, Math.max(1, Math.round(glow.size * surface.scale * 0.6)));
    const insideMask = new Float32Array(width * height);
    for (let i = 0; i < insideMask.length; i += 1) insideMask[i] = Math.max(0, alpha[i] - blurred[i]);
    const tint = tintAlpha(insideMask, width, height, glow.color, glow.opacity,pixelDepth(surface.buffer));
    compositeInside(surface, tint);
  }

  if (effects.stroke && effects.stroke.enabled !== false) {
    const stroke = effects.stroke;
    const size = Math.max(1, Math.round(stroke.size * surface.scale));
    let strokeAlpha: Float32Array;
    if (stroke.inside) {
      const eroded = erodeAlpha(alpha, width, height, size);
      strokeAlpha = new Float32Array(width * height);
      for (let i = 0; i < strokeAlpha.length; i += 1) strokeAlpha[i] = Math.max(0, alpha[i] - eroded[i]);
    } else {
      const grown = dilateAlpha(alpha, width, height, size);
      strokeAlpha = new Float32Array(width * height);
      for (let i = 0; i < strokeAlpha.length; i += 1) strokeAlpha[i] = Math.max(0, grown[i] - alpha[i]);
    }
    const tint = tintAlpha(strokeAlpha, width, height, stroke.color, stroke.opacity,pixelDepth(surface.buffer));
    if (stroke.inside) compositeInside(surface, tint);
    else compositeOutside(surface, tint, 0, 0);
  }

  return surface;
}

/** 平移 alpha 数组（越界为 0） */
function shiftAlpha(alpha: Float32Array, width: number, height: number, dx: number, dy: number): Float32Array {
  const out = new Float32Array(alpha.length);
  for (let y = 0; y < height; y += 1) {
    const sy = y - dy;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < width; x += 1) {
      const sx = x - dx;
      if (sx < 0 || sx >= width) continue;
      out[y * width + x] = alpha[sy * width + sx];
    }
  }
  return out;
}
