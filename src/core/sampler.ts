import type { PixelArray } from '@/types/document';
/**
 * 像素采样
 * ---------------------------------------------------------------
 * 双线性插值（坐标以像素中心为整数点，与 ImageData 一致），
 * 在缩放、旋转、扭曲重采样时保证边缘平滑。
 */

/** 双线性采样并写入目标数组的 di 位置 */
export function samplingAt(
  source: PixelArray,
  sourceWidth: number,
  sourceHeight: number,
  x: number,
  y: number,
  target: PixelArray,
  di: number,
): void {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const cx0 = Math.max(0, Math.min(sourceWidth - 1, x0));
  const cy0 = Math.max(0, Math.min(sourceHeight - 1, y0));
  const cx1 = Math.max(0, Math.min(sourceWidth - 1, x0 + 1));
  const cy1 = Math.max(0, Math.min(sourceHeight - 1, y0 + 1));
  const i00 = (cy0 * sourceWidth + cx0) * 4;
  const i10 = (cy0 * sourceWidth + cx1) * 4;
  const i01 = (cy1 * sourceWidth + cx0) * 4;
  const i11 = (cy1 * sourceWidth + cx1) * 4;
  for (let c = 0; c < 4; c += 1) {
    const top = source[i00 + c] * (1 - fx) + source[i10 + c] * fx;
    const bottom = source[i01 + c] * (1 - fx) + source[i11 + c] * fx;
    target[di + c] = top * (1 - fy) + bottom * fy;
  }
}

/** 单通道双线性采样（蒙版/选区用） */
export function sampleScalar(
  source: Uint8Array<ArrayBuffer> | PixelArray,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const cx0 = Math.max(0, Math.min(width - 1, x0));
  const cy0 = Math.max(0, Math.min(height - 1, y0));
  const cx1 = Math.max(0, Math.min(width - 1, x0 + 1));
  const cy1 = Math.max(0, Math.min(height - 1, y0 + 1));
  const top = source[cy0 * width + cx0] * (1 - fx) + source[cy0 * width + cx1] * fx;
  const bottom = source[cy1 * width + cx0] * (1 - fx) + source[cy1 * width + cx1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/** 最近邻采样（不做插值） */
export function sampleNearest(
  source: Uint8Array<ArrayBuffer> | PixelArray,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const px = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const py = Math.max(0, Math.min(height - 1, Math.floor(y)));
  return source[py * width + px];
}
