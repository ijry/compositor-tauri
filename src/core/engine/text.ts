/**
 * 文字图层渲染
 * ---------------------------------------------------------------
 * 用 Canvas 2D 把 TextMeta 渲染成像素缓冲：
 *  - 支持多行自动换行（boxSize 存在时）、对齐、字距、行距；
 *  - 支持彩色区间（colorRuns）与字体区间（fontRuns），对应 .comp v10 / v11；
 *  - 字体缺失时回退到系统默认字体，导出结果始终以像素为准。
 */
import { createBuffer } from '@/core/pixels';
import type { PixelBuffer, TextMeta } from '@/types/document';

/** 估算文本宽度 */
function measureText(ctx: CanvasRenderingContext2D, text: string, tracking: number): number {
  const base = ctx.measureText(text).width;
  return base + Math.max(0, text.length - 1) * tracking;
}

/** 按段落宽度折行 */
function wrapLines(ctx: CanvasRenderingContext2D, content: string, maxWidth: number | null, tracking: number): string[] {
  const paragraphs = content.split('\n');
  if (!maxWidth || maxWidth <= 0) return paragraphs;
  const result: string[] = [];
  for (const paragraph of paragraphs) {
    // 保留空行
    if (paragraph.length === 0) {
      result.push('');
      continue;
    }
    const words = paragraph.split(/(\s+)/);
    let line = '';
    for (const word of words) {
      const candidate = line + word;
      if (measureText(ctx, candidate, tracking) > maxWidth && line.trim().length > 0) {
        result.push(line);
        line = word.trimStart();
      } else {
        line = candidate;
      }
    }
    result.push(line);
  }
  return result;
}

/** 把内容按 UTF-16 下标切成区间 */
function runAt(runs: { location: number; length: number }[] | undefined, index: number): number | null {
  if (!runs) return null;
  for (const run of runs) {
    if (index >= run.location && index < run.location + run.length) return run.location;
  }
  return null;
}

/**
 * 渲染文字。
 * @param meta 文字元数据
 * @param width 像素宽度（通常取段落框宽度或自动测量）
 */
export function renderText(meta: TextMeta, width?: number, height?: number): PixelBuffer {
  const measureCanvas = document.createElement('canvas');
  measureCanvas.width = 8;
  measureCanvas.height = 8;
  const measureCtx = measureCanvas.getContext('2d')!;
  const fontString = `${meta.italic ? 'italic ' : ''}${meta.bold ? '700 ' : ''}${meta.fontSize}px "${meta.fontName}", sans-serif`;
  measureCtx.font = fontString;

  const lines = wrapLines(measureCtx, meta.content, meta.boxSize ? meta.boxSize[0] : null, meta.tracking);
  const lineHeight = meta.lineSpacing > 0 ? meta.lineSpacing : meta.fontSize * 1.2;
  let measuredWidth = 0;
  for (const line of lines) measuredWidth = Math.max(measuredWidth, measureText(measureCtx, line, meta.tracking));
  const padding = Math.ceil(meta.fontSize * 0.4);
  const boxWidth = Math.max(1, Math.ceil(width ?? (meta.boxSize ? meta.boxSize[0] : measuredWidth + padding * 2)));
  const boxHeight = Math.max(1, Math.ceil(height ?? (lines.length * lineHeight + padding * 2)));

  const buffer = createBuffer(boxWidth, boxHeight);
  const canvas = document.createElement('canvas');
  canvas.width = boxWidth;
  canvas.height = boxHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, boxWidth, boxHeight);
  ctx.font = fontString;
  ctx.textBaseline = 'alphabetic';

  let lineStartIndex = 0;
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row]!;
    const lineWidth = measureText(ctx, line, meta.tracking);
    let x = padding;
    if (meta.align === 'center') x = (boxWidth - lineWidth) / 2;
    else if (meta.align === 'right') x = boxWidth - lineWidth - padding;
    const y = padding + meta.fontSize + row * lineHeight;

    // 逐字绘制以便应用颜色/字体区间
    let cursor = x;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i]!;
      const absoluteIndex = lineStartIndex + i;
      const colorRunStart = runAt(meta.colorRuns, absoluteIndex);
      const fontRunStart = runAt(meta.fontRuns, absoluteIndex);
      if (colorRunStart !== null) {
        const run = meta.colorRuns?.find((item) => item.location === colorRunStart);
        if (run) ctx.fillStyle = `rgb(${run.color[0]}, ${run.color[1]}, ${run.color[2]})`;
      } else {
        ctx.fillStyle = `rgb(${meta.color[0]}, ${meta.color[1]}, ${meta.color[2]})`;
      }
      if (fontRunStart !== null) {
        const run = meta.fontRuns?.find((item) => item.location === fontRunStart);
        if (run) ctx.font = `${meta.italic ? 'italic ' : ''}${meta.bold ? '700 ' : ''}${meta.fontSize}px "${run.fontName}", sans-serif`;
      } else {
        ctx.font = fontString;
      }
      ctx.fillText(char, cursor, y);
      cursor += ctx.measureText(char).width + meta.tracking;
    }
    lineStartIndex += line.length + 1;
  }

  const image = ctx.getImageData(0, 0, boxWidth, boxHeight);
  buffer.data.set(image.data);
  return buffer;
}

/** 计算文字图层的建议尺寸 */
export function measureTextSize(meta: TextMeta): [number, number] {
  const buffer = renderText(meta);
  return [buffer.width, buffer.height];
}

/** 创建默认文字元数据 */
export function defaultTextMeta(content = '', color: [number, number, number] = [255, 255, 255]): TextMeta {
  return {
    content,
    fontName: 'PingFang SC',
    fontSize: 64,
    color,
    align: 'left',
    tracking: 0,
    lineSpacing: 0,
    boxSize: null,
    bold: false,
    italic: false,
  };
}
