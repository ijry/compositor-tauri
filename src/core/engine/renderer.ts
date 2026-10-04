/**
 * 画布渲染器
 * ---------------------------------------------------------------
 * 职责：
 *  - 把文档合成结果画到主画布（含棋盘格背景、像素网格、缩放下的高质量降采样）；
 *  - 缓存最近一次的合成缓冲，缩放/平移变化时直接重绘，避免重复合成；
 *  - 提供文档坐标 <-> 屏幕坐标的换算（屏幕坐标以画布中心为原点）。
 */
import { compositeDocument } from '@/core/engine/compositor';
import { drawCheckerboard } from '@/io/imageIO';
import type { CompDocument, Point } from '@/types/document';

/** 视口状态 */
export interface Viewport {
  zoom: number;
  /** 视图中心的文档坐标 */
  centerX: number;
  centerY: number;
}

export interface RenderOptions {
  /** 画布 CSS 尺寸 */
  width: number;
  height: number;
  /** ���备像素比 */
  devicePixelRatio: number;
  /** 棋盘格大小（屏幕像素） */
  checkerSize?: number;
  /** 棋盘格颜色 */
  checkerLight?: string;
  checkerDark?: string;
  /** 是否显示像素网格 */
  showPixelGrid?: boolean;
  /** 背景色（画布外区域） */
  workspaceColor?: string;
}

/** 缩放级别序列（与 Photoshop 一致） */
export const ZOOM_STEPS = [
  0.0033, 0.005, 0.0067, 0.01, 0.0167, 0.025, 0.0333, 0.05, 0.0667, 0.1, 0.125, 0.167, 0.25, 0.333, 0.5,
  0.6667, 1, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32, 64, 100, 200, 300, 400, 800, 1600, 3200,
];

/** 下一个缩放级别 */
export function nextZoom(zoom: number, direction: 1 | -1): number {
  const index = ZOOM_STEPS.findIndex((step) => step >= zoom - 1e-6);
  const current = index >= 0 ? index : ZOOM_STEPS.length - 1;
  const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, (index >= 0 ? current : current) + direction));
  return ZOOM_STEPS[next]!;
}

/** 文档坐标 -> 屏幕坐标（相对画布左上角） */
export function docToScreen(viewport: Viewport, point: Point, width: number, height: number): Point {
  return {
    x: (point.x - viewport.centerX) * viewport.zoom + width / 2,
    y: (point.y - viewport.centerY) * viewport.zoom + height / 2,
  };
}

/** 屏幕坐标 -> 文档坐标 */
export function screenToDoc(viewport: Viewport, point: Point, width: number, height: number): Point {
  return {
    x: (point.x - width / 2) / viewport.zoom + viewport.centerX,
    y: (point.y - height / 2) / viewport.zoom + viewport.centerY,
  };
}

/** 合成缓存：缩放变化不大时复用上次的缓冲 */
export interface RenderCache {
  key: string;
  buffer: ReturnType<typeof compositeDocument>['buffer'];
  scale: number;
}

export class CanvasRenderer {
  private readonly canvas: HTMLCanvasElement;
  private cache: RenderCache | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  /** 让缓存失效（文档被修改时调用） */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * 渲染文档。
   * 合成比例 renderScale 的选择：缩小时按缩放比降采样以保证流畅，
   * 放大时按 1:1 合成再由浏览器放大，保证像素级清晰。
   */
  render(doc: CompDocument, viewport: Viewport, options: RenderOptions): void {
    const { width, height, devicePixelRatio } = options;
    const pixelWidth = Math.max(1, Math.round(width * devicePixelRatio));
    const pixelHeight = Math.max(1, Math.round(height * devicePixelRatio));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pixelWidth, pixelHeight);
    ctx.fillStyle = options.workspaceColor ?? '#1b1b1b';
    ctx.fillRect(0, 0, pixelWidth, pixelHeight);

    // 画布在屏幕上的位置与尺寸
    const topLeft = docToScreen(viewport, { x: 0, y: 0 }, width, height);
    const zoom = viewport.zoom;
    const canvasWidth = doc.width * zoom;
    const canvasHeight = doc.height * zoom;
    const x = Math.round(topLeft.x * devicePixelRatio);
    const y = Math.round(topLeft.y * devicePixelRatio);
    const drawWidth = Math.round(canvasWidth * devicePixelRatio);
    const drawHeight = Math.round(canvasHeight * devicePixelRatio);

    // 棋盘格
    const checkerCanvas = document.createElement('canvas');
    checkerCanvas.width = Math.max(1, drawWidth);
    checkerCanvas.height = Math.max(1, drawHeight);
    const checkerCtx = checkerCanvas.getContext('2d')!;
    drawCheckerboardCustom(checkerCtx, drawWidth, drawHeight, Math.max(4, Math.round((options.checkerSize ?? 8) * devicePixelRatio)), options.checkerLight ?? '#ffffff', options.checkerDark ?? '#cccccc');
    ctx.drawImage(checkerCanvas, x, y);

    // 合成内容
    const renderScale = this.resolveRenderScale(doc, zoom);
    const key = this.cacheKey(doc, renderScale);
    if (!this.cache || this.cache.key !== key) {
      const widthOut = Math.max(1, Math.round(doc.width * renderScale));
      const heightOut = Math.max(1, Math.round(doc.height * renderScale));
      const result = compositeDocument(doc, widthOut, heightOut, { scale: renderScale });
      this.cache = { key, buffer: result.buffer, scale: renderScale };
    }
    const composite = this.cache.buffer;
    const compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = composite.width;
    compositeCanvas.height = composite.height;
    compositeCanvas.getContext('2d')!.putImageData(new ImageData(composite.data as Uint8ClampedArray<ArrayBuffer>, composite.width, composite.height), 0, 0);
    ctx.imageSmoothingEnabled = zoom < 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(compositeCanvas, x, y, drawWidth, drawHeight);

    // 画布边框
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, drawWidth - 1, drawHeight - 1);

    // 放大到 800% 以上时显示像素网格
    if (options.showPixelGrid && zoom >= 6) {
      ctx.strokeStyle = 'rgba(120,120,120,0.5)';
      ctx.beginPath();
      const startX = Math.max(0, Math.floor(-topLeft.x));
      const endX = Math.min(doc.width, Math.ceil((-topLeft.x + width / zoom)));
      const startY = Math.max(0, Math.floor(-topLeft.y));
      const endY = Math.min(doc.height, Math.ceil((-topLeft.y + height / zoom)));
      if ((endX - startX) * (endY - startY) < 200000) {
        for (let column = startX; column <= endX; column += 1) {
          const sx = x + column * zoom * devicePixelRatio;
          ctx.moveTo(Math.round(sx) + 0.5, y);
          ctx.lineTo(Math.round(sx) + 0.5, y + drawHeight);
        }
        for (let row = startY; row <= endY; row += 1) {
          const sy = y + row * zoom * devicePixelRatio;
          ctx.moveTo(x, Math.round(sy) + 0.5);
          ctx.lineTo(x + drawWidth, Math.round(sy) + 0.5);
        }
        ctx.stroke();
      }
    }
  }

  /**
   * 选择合成比例
   * ---------------------------------------------------------------
   * 缩小时按 2 的幂降采样，同时受像素预算约束：
   * 预算内最多合成 16 megapixels，否则浏览器会分配不出缓冲。
   */
  private resolveRenderScale(doc: CompDocument, zoom: number): number {
    const budget = 16_000_000;
    const totalPixels = Math.max(1, doc.width * doc.height);
    let scale = 1;
    if (zoom < 1) scale = Math.min(64, Math.pow(2, Math.ceil(Math.log2(1 / zoom))));
    // 超出预算继续减半，保证缓冲一定分配得出来
    while (totalPixels * scale * scale > budget && scale > 0.02) scale /= 2;
    return Math.max(0.02, scale);
  }

  /** 缓存键：文档内容摘要 + 比例 */
  private cacheKey(doc: CompDocument, scale: number): string {
    let signature = `${doc.width}x${doc.height}@${scale}`;
    for (const layer of doc.layers) {
      signature += `|${layer.id}:${layer.isVisible ? 1 : 0}:${layer.opacity}:${layer.blendMode}:${layer.clipping ? 1 : 0}:${layer.contentKey}`;
      signature += `:${layer.transform.origin.join(',')}:${layer.transform.size.join(',')}:${layer.transform.rotation}`;
      signature += `:${layer.mask ? `${layer.mask.enabled ? 1 : 0}:${layer.mask.pixels.data.length}` : '0'}`;
      signature += `:${layer.adjustment ? JSON.stringify(layer.adjustment) : ''}`;
      signature += `:${layer.effects ? JSON.stringify(layer.effects) : ''}`;
    }
    signature += `|sel:${doc.selection ? selectionSignature(doc) : '0'}`;
    return signature;
  }
}

/** 选区内容签名（抽样若干像素，避免每次全量比较） */
function selectionSignature(doc: CompDocument): string {
  const selection = doc.selection;
  if (!selection) return '0';
  let sum = 0;
  const step = Math.max(1, Math.floor(selection.data.length / 4096));
  for (let i = 0; i < selection.data.length; i += step) sum += selection.data[i]!;
  return `${selection.data.length}:${sum}`;
}

/** 自定义棋盘格（避免每帧创建大 canvas 的重复计算） */
function drawCheckerboardCustom(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  size: number,
  light: string,
  dark: string,
): void {
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = dark;
  const columns = Math.min(Math.ceil(width / size) + 1, 512);
  const rows = Math.min(Math.ceil(height / size) + 1, 512);
  for (let row = 0; row < rows; row += 1) {
    for (let column = row % 2; column < columns; column += 2) {
      ctx.fillRect(column * size, row * size, size, size);
    }
  }
}

export { drawCheckerboard };
