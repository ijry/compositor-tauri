import { pixelDepth, displayBytes, toImageData } from '@/core/pixelFormat';
import { is16BitPng, decode16BitPng, encode16BitPng } from './png16';
/**
 * 位图导入导出
 * ---------------------------------------------------------------
 * 导入：JPEG / PNG / WebP / BMP / GIF 首帧 / SVG / TIFF（自带解码器）
 * 导出：PNG / JPEG（质量可调，带实时预览）/ WebP
 */
import { canvasToBuffer, cloneBuffer, createBuffer, resizeBuffer } from '@/core/pixels';
import { decodeTiff, isTiff } from '@/io/tiff';
import type { PixelBuffer } from '@/types/document';

/** 导入过滤器 */
export const IMAGE_OPEN_FILTERS = [
  { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'svg', 'tif', 'tiff', 'avif', 'heic', 'heif', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2'] },
  { name: 'Photoshop', extensions: ['psd', 'psb'] },
  { name: '工程包', extensions: ['comp', 'json'] },
];

/** 导出过滤器 */
export const IMAGE_SAVE_FILTERS = [
  { name: 'PNG', extensions: ['png'] },
  { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
  { name: 'WebP', extensions: ['webp'] },
];

/** 判断字节流是否为 SVG */
function isSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trim().toLowerCase();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

/**
 * 从二进制数据解码为像素缓冲。
 * TIFF 使用自带解码器（浏览器无法直接解码 TIFF）。
 */
export async function decodeImageBytes(data: ArrayBuffer): Promise<PixelBuffer> {
  const bytes = new Uint8Array(data);
  if(is16BitPng(bytes))return decode16BitPng(bytes);
  if (isTiff(bytes)) {
    const decoded = await decodeTiff(bytes);
    if (decoded) return decoded;
  }
  if (isSvg(bytes)) return decodeSvg(bytes);
  const blob = new Blob([bytes as BlobPart]);
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    const buffer = await bitmapToBuffer(bitmap);
    bitmap.close();
    return buffer;
  }
  return decodeViaImageElement(blob);
}

async function bitmapToBuffer(bitmap: ImageBitmap): Promise<PixelBuffer> {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  return canvasToBuffer(canvas);
}

function decodeViaImageElement(blob: Blob): Promise<PixelBuffer> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(image, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvasToBuffer(canvas));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解码失败，浏览器可能不支持该格式'));
    };
    image.src = url;
  });
}

/** SVG 解码：用 Image 按原始尺寸栅格化 */
function decodeSvg(bytes: Uint8Array): Promise<PixelBuffer> {
  const text = new TextDecoder().decode(bytes);
  const blob = new Blob([text as BlobPart], { type: 'image/svg+xml' });
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      // 没有明确尺寸时按 2048 宽栅格化
      const width = image.naturalWidth || 2048;
      const height = image.naturalHeight || 2048;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(image, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(canvasToBuffer(canvas));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('SVG 解析失败'));
    };
    image.src = url;
  });
}

/** 缩放到指定尺寸（保持比例时传 0） */
export function scaleBuffer(buffer: PixelBuffer, width: number, height: number): PixelBuffer {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (w === buffer.width && h === buffer.height) return cloneBuffer(buffer);
  if(pixelDepth(buffer)===16)return resizeBuffer(buffer,w,h);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const source = document.createElement('canvas');
  source.width = buffer.width;
  source.height = buffer.height;
  source.getContext('2d', { willReadFrequently: true })!.putImageData(
    toImageData(buffer), 0, 0,
  );
  ctx.drawImage(source, 0, 0, w, h);
  return canvasToBuffer(canvas);
}

export type ExportFormat = 'png' | 'jpeg' | 'webp';

export interface ExportOptions {
  format: ExportFormat;
  /** JPEG / WebP 质量 0-1 */
  quality: number;
  /** 输出缩放（1 = 原始尺寸） */
  scale: number;
  /** JPEG 背景色（无 alpha 通道时填充） */
  background: [number, number, number];
}

/** 把缓冲编码为二进制 */
export async function encodeImage(buffer: PixelBuffer, options: ExportOptions): Promise<Blob> {
  const width = Math.max(1, Math.round(buffer.width * options.scale));
  const height = Math.max(1, Math.round(buffer.height * options.scale));
  const scaled=buffer.width===width&&buffer.height===height?buffer:scaleBuffer(buffer,width,height);
  if(options.format==='png'&&pixelDepth(scaled)===16)return encode16BitPng(scaled);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  if (options.format === 'jpeg') {
    // JPEG 不支持透明，先铺背景色
    ctx.fillStyle = `rgb(${options.background[0]}, ${options.background[1]}, ${options.background[2]})`;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingQuality = 'high';
  const bytes=new Uint8ClampedArray(displayBytes(scaled));
  if(options.format==='jpeg')for(let i=0;i<bytes.length;i+=4){const alpha=bytes[i+3]!/255;for(let c=0;c<3;c++)bytes[i+c]=bytes[i+c]!*alpha+options.background[c]!*(1-alpha);bytes[i+3]=255;}
  ctx.putImageData(new ImageData(bytes,width,height),0,0);
  const mime = options.format === 'png' ? 'image/png' : options.format === 'jpeg' ? 'image/jpeg' : 'image/webp';
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('导出失败'));
    }, mime, options.format === 'png' ? undefined : options.quality);
  });
}

function resizeIfNeeded(buffer: PixelBuffer, width: number, height: number): Uint8ClampedArray {
  if (buffer.width === width && buffer.height === height) return displayBytes(buffer);
  return displayBytes(scaleBuffer(buffer, width, height));
}

/** 估算导出后的字节数（用于确认对话框） */
export async function estimateSize(buffer: PixelBuffer, options: ExportOptions): Promise<number> {
  const blob = await encodeImage(buffer, { ...options, scale: Math.min(options.scale, 0.25) });
  return Math.round(blob.size / Math.min(options.scale, 0.25) ** 2);
}

/** 生成缩略图 dataURL（图层面板用） */
export function thumbnailDataUrl(buffer: PixelBuffer, size: number): string {
  const scaled = scaleBuffer(buffer, size, size);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(toImageData(scaled), 0, 0);
  return canvas.toDataURL('image/png');
}

/** 透明棋盘格（画布背景） */
export function drawCheckerboard(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, size = 8): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = '#cccccc';
  for (let row = 0; row * size < height; row += 1) {
    for (let column = 0; column * size < width; column += 1) {
      if ((row + column) % 2 === 0) continue;
      ctx.fillRect(x + column * size, y + row * size, size, size);
    }
  }
  ctx.restore();
}

/** 生成一个空白（透明）缓冲 */
export function transparentBuffer(width: number, height: number): PixelBuffer {
  return createBuffer(width, height);
}
