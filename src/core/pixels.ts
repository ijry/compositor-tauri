/**
 * 像素缓冲工具
 * ---------------------------------------------------------------
 * 8位RGBA使用Uint8ClampedArray，16位文档使用0–255 Float32工作值，不做预乘，
 * 所有混合、蒙版、调整都在 unpremultiplied 空间进行，保证与 Photoshop 一致。
 */
import { allocatePixels, copyPixels, pixelDepth, toImageData } from './pixelFormat';
import type { BitDepth, MaskBuffer, PixelBuffer, Rect } from '@/types/document';

/** 创建一个全透明缓冲 */
export function createBuffer(width: number, height: number, fill?: [number, number, number, number], bitDepth:BitDepth=8): PixelBuffer {
  const data = allocatePixels(width * height * 4,bitDepth);
  if (fill) {
    const [r, g, b, a] = fill;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return { width, height, data, bitDepth };
}

/** 深拷贝缓冲 */
export function cloneBuffer(buffer: PixelBuffer): PixelBuffer {
  return { width: buffer.width, height: buffer.height, data: copyPixels(buffer.data),bitDepth:pixelDepth(buffer) };
}

/** 深拷贝蒙版 */
export function cloneMask(mask: MaskBuffer): MaskBuffer {
  return { width: mask.width, height: mask.height, data: mask.data instanceof Float32Array?new Float32Array(mask.data):new Uint8Array(mask.data),bitDepth:mask.data instanceof Float32Array?16:8 };
}

/** 由矩形创建全白蒙版 */
export function createMask(width:number,height:number,value?:number,depth?:8):MaskBuffer & {data:Uint8Array<ArrayBuffer>};
export function createMask(width:number,height:number,value:number|undefined,depth:BitDepth):MaskBuffer;
export function createMask(width: number, height: number, value = 255,depth:BitDepth=8): MaskBuffer {
  if(!Number.isSafeInteger(width*height)||width<0||height<0||width*height*(depth===16?4:1)>1024*1024*1024)throw new Error('蒙版缓冲超出安全范围');
  const data = depth===16?new Float32Array(width*height):new Uint8Array(width * height);
  if (value !== 0) data.fill(value);
  return { width, height, data,bitDepth:depth };
}

/** 布尔填充 */
export function fillBuffer(buffer: PixelBuffer, color: [number, number, number, number]): void {
  const { data } = buffer;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2]; data[i + 3] = color[3];
  }
}

/** 取像素（越界返回全 0） */
export function getPixel(buffer: PixelBuffer, x: number, y: number): [number, number, number, number] {
  if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) return [0, 0, 0, 0];
  const i = (y * buffer.width + x) * 4;
  return [buffer.data[i], buffer.data[i + 1], buffer.data[i + 2], buffer.data[i + 3]];
}

/** 写像素（越界忽略） */
export function setPixel(buffer: PixelBuffer, x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) return;
  const i = (y * buffer.width + x) * 4;
  buffer.data[i] = r; buffer.data[i + 1] = g; buffer.data[i + 2] = b; buffer.data[i + 3] = a;
}

/** 缓冲的估算内存占用（字节） */
export function bufferBytes(buffer: PixelBuffer | MaskBuffer | null | undefined): number {
  if (!buffer) return 0;
  return buffer.data.byteLength;
}

/** 与画布互转 */
export function bufferToCanvas(buffer: PixelBuffer): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = buffer.width;
  canvas.height = buffer.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.putImageData(toImageData(buffer), 0, 0);
  return canvas;
}

/** 从画布读取缓冲 */
export function canvasToBuffer(canvas: HTMLCanvasElement): PixelBuffer {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: image.data };
}

/** 从 ImageBitmap / HTMLImageElement 等来源解码为缓冲 */
export async function sourceToBuffer(source: CanvasImageSource, width?: number, height?: number): Promise<PixelBuffer> {
  const w = width ?? (source as HTMLImageElement).naturalWidth ?? (source as ImageBitmap).width;
  const h = height ?? (source as HTMLImageElement).naturalHeight ?? (source as ImageBitmap).height;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvasToBuffer(canvas);
}

/** 提取子区域为新缓冲 */
export function cropBuffer(buffer: PixelBuffer, rect: Rect): PixelBuffer {
  const out = createBuffer(rect.width, rect.height,undefined,pixelDepth(buffer));
  for (let y = 0; y < rect.height; y += 1) {
    const sy = rect.y + y;
    if (sy < 0 || sy >= buffer.height) continue;
    for (let x = 0; x < rect.width; x += 1) {
      const sx = rect.x + x;
      if (sx < 0 || sx >= buffer.width) continue;
      const si = (sy * buffer.width + sx) * 4;
      const di = (y * rect.width + x) * 4;
      out.data[di] = buffer.data[si];
      out.data[di + 1] = buffer.data[si + 1];
      out.data[di + 2] = buffer.data[si + 2];
      out.data[di + 3] = buffer.data[si + 3];
    }
  }
  return out;
}

/** 把 src 贴到 dst 的 (dx, dy)，自动裁剪越界 */
export function blitBuffer(dst: PixelBuffer, src: PixelBuffer, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y += 1) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x += 1) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const si = (y * src.width + x) * 4;
      const di = (ty * dst.width + tx) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
}

/** 蒙版转 RGBA 缓冲（用于可视化与效果计算） */
export function maskToBuffer(mask: MaskBuffer): PixelBuffer {
  const out = createBuffer(mask.width, mask.height,undefined,mask.data instanceof Float32Array?16:8);
  for (let i = 0, p = 0; i < mask.data.length; i += 1, p += 4) {
    const v = mask.data[i];
    out.data[p] = v; out.data[p + 1] = v; out.data[p + 2] = v; out.data[p + 3] = 255;
  }
  return out;
}

/** 缩放缓冲（双线性），用于导入时改变尺寸 */
export function resizeBuffer(buffer: PixelBuffer, width: number, height: number): PixelBuffer {
  const out = createBuffer(width, height,undefined,pixelDepth(buffer));
  const sx = buffer.width / width;
  const sy = buffer.height / height;
  for (let y = 0; y < height; y += 1) {
    const fy = Math.min(buffer.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(buffer.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = Math.min(buffer.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(buffer.width - 1, x0 + 1);
      const wx = fx - x0;
      const i00 = (y0 * buffer.width + x0) * 4;
      const i10 = (y0 * buffer.width + x1) * 4;
      const i01 = (y1 * buffer.width + x0) * 4;
      const i11 = (y1 * buffer.width + x1) * 4;
      const di = (y * width + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const top = buffer.data[i00 + c] * (1 - wx) + buffer.data[i10 + c] * wx;
        const bottom = buffer.data[i01 + c] * (1 - wx) + buffer.data[i11 + c] * wx;
        out.data[di + c] = top * (1 - wy) + bottom * wy;
      }
    }
  }
  return out;
}

/** 缩放蒙版（双线性） */
export function resizeMask(mask: MaskBuffer, width: number, height: number): MaskBuffer {
  const out = createMask(width, height,255,mask.data instanceof Float32Array?16:8);
  const sx = mask.width / width;
  const sy = mask.height / height;
  for (let y = 0; y < height; y += 1) {
    const fy = Math.min(mask.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(mask.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = Math.min(mask.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(mask.width - 1, x0 + 1);
      const wx = fx - x0;
      const v = (mask.data[y0 * mask.width + x0] * (1 - wx) + mask.data[y0 * mask.width + x1] * wx) * (1 - wy)
        + (mask.data[y1 * mask.width + x0] * (1 - wx) + mask.data[y1 * mask.width + x1] * wx) * wy;
      out.data[y * width + x] = v;
    }
  }
  return out;
}

/** 镜像（水平/垂直） */
export function flipBuffer(buffer: PixelBuffer, horizontal: boolean, vertical: boolean): PixelBuffer {
  const out = createBuffer(buffer.width, buffer.height,undefined,pixelDepth(buffer));
  for (let y = 0; y < buffer.height; y += 1) {
    const sy = vertical ? buffer.height - 1 - y : y;
    for (let x = 0; x < buffer.width; x += 1) {
      const sx = horizontal ? buffer.width - 1 - x : x;
      const si = (sy * buffer.width + sx) * 4;
      const di = (y * buffer.width + x) * 4;
      out.data[di] = buffer.data[si];
      out.data[di + 1] = buffer.data[si + 1];
      out.data[di + 2] = buffer.data[si + 2];
      out.data[di + 3] = buffer.data[si + 3];
    }
  }
  return out;
}

/** 旋转（0/90/180/270，顺时针） */
export function rotateBuffer(buffer: PixelBuffer, degrees: number): PixelBuffer {
  const turn = ((degrees % 360) + 360) % 360;
  if (turn === 0) return cloneBuffer(buffer);
  const swap = turn === 90 || turn === 270;
  const out = createBuffer(swap ? buffer.height : buffer.width, swap ? buffer.width : buffer.height,undefined,pixelDepth(buffer));
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      let tx = x; let ty = y;
      if (turn === 90) { tx = buffer.height - 1 - y; ty = x; }
      else if (turn === 180) { tx = buffer.width - 1 - x; ty = buffer.height - 1 - y; }
      else if (turn === 270) { tx = y; ty = buffer.width - 1 - x; }
      const si = (y * buffer.width + x) * 4;
      const di = (ty * out.width + tx) * 4;
      out.data[di] = buffer.data[si];
      out.data[di + 1] = buffer.data[si + 1];
      out.data[di + 2] = buffer.data[si + 2];
      out.data[di + 3] = buffer.data[si + 3];
    }
  }
  return out;
}

/** 像素对齐：向上取整到 0.5 像素，保证变换时像素不被反复重采样 */
export function roundHalf(value: number): number {
  return Math.round(value * 2) / 2;
}
