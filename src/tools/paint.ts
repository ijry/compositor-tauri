/**
 * 绘画与修复类工具
 * ---------------------------------------------------------------
 * 画笔、橡皮擦、污点修复、仿制图章、模糊、涂抹、液化。
 * 所有工具都会：
 *  - 通过编辑器接口拿到当前绘制目标（图层像素或图层蒙版）；
 *  - 按下时开始交互（记录快照），松开时提交为一条历史记录。
 */
import { spotHeal } from '@/core/filters/contentAware';
import { boxBlurRegion } from '@/core/filters/blur';
import { dabAlongLine, makeLayerMapping, paintDab, readLocalPixel, setPaintDocument, smudgeDab, warpRegion } from '@/core/engine/paint';
import type { PaintTarget } from '@/core/engine/paint';
import { beginInteraction, endInteraction, snapshotBytes } from '@/tools/helpers';
import type { EditorApi } from '@/types/editor';
import type { ToolDefinition } from '@/tools/types';
import type { Point } from '@/types/document';

/** 绘画过程状态 */
interface PaintState {
  active: boolean;
  last: Point;
  /** 平滑后的位置 */
  smoothed: Point;
  target: PaintTarget | null;
  snapshot: ReturnType<typeof beginInteraction> | null;
  /** 仿制图章的采样源 */
  cloneSource: Point | null;
  /** 仿制图章按下的起点 */
  cloneOrigin: Point | null;
  lastStamp: number;
}

const state: PaintState = {
  active: false,
  last: { x: 0, y: 0 },
  smoothed: { x: 0, y: 0 },
  target: null,
  snapshot: null,
  cloneSource: null,
  cloneOrigin: null,
  lastStamp: 0,
};

/** 取当前绘制目标 */
export function currentPaintTarget(editor: EditorApi): PaintTarget | null {
  const layer = editor.activeLayer();
  if (!layer || layer.kind !== 'pixel' || layer.locked) return null;
  const onMask = Boolean(layer.mask && layer.mask.target === 'mask' && layer.mask.enabled);
  return { layer, onMask };
}

/** 前景色（带 alpha 的画笔颜色） */
function brushColor(editor: EditorApi, erase: boolean): [number, number, number, number] {
  if (erase) return [0, 0, 0, 0];
  const [r, g, b] = editor.foreground;
  return [r, g, b, 255];
}

/** 启动一次绘画 */
function startPaint(editor: EditorApi, point: Point): void {
  const target = currentPaintTarget(editor);
  if (!target) {
    editor.status('请先选择一个像素图层（新建或切换到像素图层）');
    return;
  }
  setPaintDocument(editor.doc);
  state.target = target;
  state.snapshot = beginInteraction(editor, [target.layer.id]);
  state.active = true;
  state.last = point;
  state.smoothed = point;
}

/** 结束绘画并提交历史 */
function finishPaint(editor: EditorApi, label: string): void {
  if (!state.active || !state.snapshot) return;
  state.active = false;
  endInteraction(editor, label, state.snapshot, snapshotBytes(state.snapshot));
  state.snapshot = null;
  state.target = null;
  editor.invalidate();
}

/** 通用绘画参数读取 */
function paintParams(editor: EditorApi) {
  return {
    radius: Math.max(0.5, editor.option<number>('size', 40) / 2),
    hardness: Math.max(0, Math.min(1, editor.option<number>('hardness', 0.7))),
    opacity: Math.max(0, Math.min(1, editor.option<number>('opacity', 1))),
  };
}

/** 应用位置平滑（Photoshop 的「平滑」参数） */
function smoothPoint(editor: EditorApi, point: Point): Point {
  const smoothing = Math.max(0, Math.min(100, editor.option<number>('smoothing', 50)));
  const factor = 1 - smoothing / 100 * 0.85;
  state.smoothed = {
    x: state.smoothed.x + (point.x - state.smoothed.x) * factor,
    y: state.smoothed.y + (point.y - state.smoothed.y) * factor,
  };
  return state.smoothed;
}

/** 画笔工具 */
export const brushTool: ToolDefinition = {
  id: 'brush',
  name: '画笔',
  shortcut: 'B',
  group: 'paint',
  icon: '✎',
  cursor: 'none',
  defaults: { size: 40, hardness: 0.7, opacity: 1, smoothing: 50, mode: 'paint' },
  specs: [
    { key: 'size', label: '大小', type: 'number', min: 1, max: 2500, step: 1, unit: 'px' },
    { key: 'hardness', label: '硬度', type: 'number', min: 0, max: 100, step: 1, unit: '%' },
    { key: 'opacity', label: '不透明度', type: 'number', min: 0, max: 100, step: 1, unit: '%' },
    { key: 'smoothing', label: '平滑', type: 'number', min: 0, max: 100, step: 1, unit: '%' },
    { key: 'mode', label: '模式', type: 'select', options: [{ value: 'paint', label: '绘制' }, { value: 'erase', label: '擦除' }] },
  ],
  onDown(editor, event) {
    startPaint(editor, event.doc);
    if (!state.active) return;
    const params = paintParams(editor);
    const erase = editor.option<string>('mode', 'paint') === 'erase';
    paintDab(editor.doc, state.target!, {
      x: event.doc.x,
      y: event.doc.y,
      ...params,
      color: brushColor(editor, erase),
      erase,
      flow: 1,
    });
    editor.markLayerDirty(state.target!.layer.id);
  },
  onMove(editor, event) {
    if (!state.active || !state.target) return;
    const point = editor.option<number>('smoothing', 50) > 0 ? smoothPoint(editor, event.doc) : event.doc;
    const params = paintParams(editor);
    const erase = editor.option<string>('mode', 'paint') === 'erase';
    // 按间距插值，快速拖动也不会断
    const spacing = Math.max(1, params.radius * 0.12);
    dabAlongLine(editor.doc, state.target, state.last, point, spacing, {
      radius: params.radius,
      hardness: params.hardness,
      opacity: params.opacity,
      color: brushColor(editor, erase),
      erase,
      flow: 1,
    });
    state.last = point;
    editor.markLayerDirty(state.target.layer.id);
  },
  onUp(editor) {
    finishPaint(editor, '画笔');
  },
  drawOverlay(context) {
    drawBrushCursor(context);
  },
  animate() {
    return true;
  },
};

/** 橡皮擦工具（与画笔共用实现，模式固定为擦除） */
export const eraserTool: ToolDefinition = {
  ...brushTool,
  id: 'eraser',
  name: '橡皮擦',
  shortcut: 'E',
  icon: '⌫',
  defaults: { size: 40, hardness: 0.7, opacity: 1, smoothing: 50, mode: 'erase' },
  specs: [
    { key: 'size', label: '大小', type: 'number', min: 1, max: 2500, step: 1, unit: 'px' },
    { key: 'hardness', label: '硬度', type: 'number', min: 0, max: 100, step: 1, unit: '%' },
    { key: 'opacity', label: '不透明度', type: 'number', min: 0, max: 100, step: 1, unit: '%' },
    { key: 'smoothing', label: '平滑', type: 'number', min: 0, max: 100, step: 1, unit: '%' },
  ],
};

/** 绘制笔尖光标：黑白双线描边，保证在任何背景上都可见 */
export function drawBrushCursor(context: { ctx: CanvasRenderingContext2D; editor: EditorApi; toScreen: (p: Point) => Point }): void {
  const pointer = context.editor.pointer;
  if (!pointer) return;
  const radius = Math.max(0.5, context.editor.option<number>('size', 40) / 2) * context.editor.viewport.zoom;
  if (radius < 0.4) return;
  const center = context.toScreen(pointer);
  context.ctx.save();
  context.ctx.lineWidth = 1;
  context.ctx.beginPath();
  context.ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  context.ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  context.ctx.stroke();
  context.ctx.beginPath();
  context.ctx.arc(center.x, center.y, radius + 1, 0, Math.PI * 2);
  context.ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  context.ctx.stroke();
  context.ctx.restore();
}

/** 污点修复画笔 */
export const healingTool: ToolDefinition = {
  id: 'healing',
  name: '污点修复',
  shortcut: 'J',
  group: 'retouch',
  icon: '✚',
  cursor: 'none',
  defaults: { size: 30, spacing: 200 },
  specs: [
    { key: 'size', label: '大小', type: 'number', min: 1, max: 500, step: 1, unit: 'px' },
    { key: 'spacing', label: '采样范围', type: 'number', min: 5, max: 200, step: 1, unit: 'px' },
  ],
  onDown(editor, event) {
    startPaint(editor, event.doc);
    applyHeal(editor, event.doc);
  },
  onMove(editor, event) {
    if (!state.active || !state.target) return;
    if (Date.now() - state.lastStamp < 60) return;
    state.lastStamp = Date.now();
    applyHeal(editor, event.doc);
    editor.markLayerDirty(state.target.layer.id);
  },
  onUp(editor) {
    finishPaint(editor, '污点修复');
  },
  animate() {
    return true;
  },
};

/** 执行一次修复 */
function applyHeal(editor: EditorApi, point: Point): void {
  const target = state.target;
  if (!target) return;
  const layer = target.layer;
  if (layer.kind !== 'pixel' || !layer.pixels) return;
  const mapping = makeLayerMapping(layer);
  const local = mapping.toLocal(point);
  const radius = Math.max(1, editor.option<number>('size', 30) / 2 / mapping.scale);
  spotHeal(layer.pixels, local.x, local.y, radius, Math.max(4, editor.option<number>('spacing', 200) / mapping.scale));
  layer.contentKey += 1;
}

/** 仿制图章 */
export const cloneTool: ToolDefinition = {
  id: 'clone',
  name: '仿制图章',
  shortcut: 'S',
  group: 'retouch',
  icon: '⎘',
  cursor: 'none',
  defaults: { size: 40, hardness: 0.5, opacity: 1, aligned: true, sampleAllLayers: true },
  specs: [
    { key: 'size', label: '大小', type: 'number', min: 1, max: 1000, step: 1, unit: 'px' },
    { key: 'hardness', label: '硬度', type: 'number', min: 0, max: 100, step: 1, unit: '%' },
    { key: 'opacity', label: '不透明度', type: 'number', min: 0, max: 100, step: 1, unit: '%' },
    { key: 'aligned', label: '对齐', type: 'boolean' },
    { key: 'sampleAllLayers', label: '所有图层取样', type: 'boolean' },
  ],
  onDown(editor, event) {
    // ⌥ 点击设置采样源
    if (event.alt) {
      state.cloneSource = event.doc;
      editor.status('已设置仿制源');
      return;
    }
    startPaint(editor, event.doc);
    state.cloneOrigin = state.cloneSource ? event.doc : null;
  },
  onMove(editor, event) {
    if (!state.active || !state.target || !state.cloneSource || !state.cloneOrigin) return;
    const aligned = editor.option<boolean>('aligned', true);
    const origin = aligned ? state.cloneOrigin : state.cloneSource;
    const offset = { x: event.doc.x - origin.x, y: event.doc.y - origin.y };
    const params = paintParams(editor);
    // 直接把源区域的像素复制到当前位置（按笔尖圆形范围取样）
    const layer = state.target.layer;
    if (layer.kind !== 'pixel' || !layer.pixels) return;
    const mapping = makeLayerMapping(layer);
    const radius = params.radius / mapping.scale;
    stampClone(editor, layer.pixels, mapping.toLocal(event.doc), offset, radius, params);
    state.cloneOrigin = event.doc;
    editor.markLayerDirty(layer.id);
  },
  onUp(editor) {
    finishPaint(editor, '仿制图章');
  },
  animate() {
    return true;
  },
};

/**
 * 仿制落笔：以当前笔尖位置为中心，按偏移量从图层自身像素取样复制。
 * 硬度决定笔尖边缘羽化，不透明度决定与原像素的混合比例。
 */
function stampClone(
  editor: EditorApi,
  pixels: import('@/types/document').PixelBuffer,
  center: Point,
  offset: Point,
  radius: number,
  params: { hardness: number; opacity: number },
): void {
  const snapshot = new Uint8ClampedArray(pixels.data);
  const selection = editor.doc.selection;
  const inner = radius * Math.max(0, Math.min(1, params.hardness));
  const x0 = Math.max(0, Math.floor(center.x - radius));
  const x1 = Math.min(pixels.width - 1, Math.ceil(center.x + radius));
  const y0 = Math.max(0, Math.floor(center.y - radius));
  const y1 = Math.min(pixels.height - 1, Math.ceil(center.y + radius));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const distance = Math.hypot(x - center.x, y - center.y);
      if (distance > radius) continue;
      const falloff = distance <= inner ? 1 : 1 - (distance - inner) / Math.max(1e-4, radius - inner);
      const sx = Math.round(x + offset.x);
      const sy = Math.round(y + offset.y);
      if (sx < 0 || sy < 0 || sx >= pixels.width || sy >= pixels.height) continue;
      let coverage = falloff * params.opacity;
      if (selection) {
        const px = Math.min(selection.width - 1, Math.max(0, Math.floor(x)));
        const py = Math.min(selection.height - 1, Math.max(0, Math.floor(y)));
        coverage *= selection.data[py * selection.width + px]! / 255;
      }
      if (coverage <= 0) continue;
      const si = (sy * pixels.width + sx) * 4;
      const di = (y * pixels.width + x) * 4;
      for (let k = 0; k < 4; k += 1) {
        pixels.data[di + k] = snapshot[di + k]! * (1 - coverage) + snapshot[si + k]! * coverage;
      }
    }
  }
}

/** 模糊工具 */
export const blurTool: ToolDefinition = {
  id: 'blur',
  name: '模糊',
  shortcut: 'R',
  group: 'retouch',
  icon: '💧',
  cursor: 'none',
  defaults: { size: 40, hardness: 0.5, strength: 0.5, target: 'pixels' },
  specs: [
    { key: 'size', label: '大小', type: 'number', min: 1, max: 1000, step: 1, unit: 'px' },
    { key: 'hardness', label: '硬度', type: 'number', min: 0, max: 100, step: 1, unit: '%' },
    { key: 'strength', label: '强度', type: 'number', min: 0, max: 100, step: 1, unit: '%' },
    { key: 'target', label: '目标', type: 'select', options: [{ value: 'pixels', label: '像素' }, { value: 'mask', label: '蒙版' }] },
  ],
  onDown(editor, event) {
    startPaint(editor, event.doc);
    applyBlur(editor, event.doc);
  },
  onMove(editor, event) {
    if (!state.active || !state.target) return;
    applyBlur(editor, event.doc);
    editor.markLayerDirty(state.target.layer.id);
  },
  onUp(editor) {
    finishPaint(editor, '模糊工具');
  },
  animate() {
    return true;
  },
};

/** 模糊落笔（按笔尖分块处理，避免整图模糊） */
function applyBlur(editor: EditorApi, point: Point): void {
  const target = state.target;
  if (!target) return;
  const layer = target.layer;
  if (layer.kind !== 'pixel' || !layer.pixels) return;
  const mapping = makeLayerMapping(layer);
  const local = mapping.toLocal(point);
  const radius = Math.max(1, editor.option<number>('size', 40) / 2 / mapping.scale);
  const box = Math.max(1, Math.round(radius * editor.option<number>('strength', 50) / 50));
  const rect = {
    x: Math.round(local.x - radius),
    y: Math.round(local.y - radius),
    width: Math.round(radius * 2),
    height: Math.round(radius * 2),
  };
  const snapshot = new Uint8ClampedArray(layer.pixels.data);
  boxBlurRegion(layer.pixels, rect, box);
  // 限制在笔尖范围内并按选区限制
  applyBrushLimit(editor, layer.pixels, snapshot, local, radius, mapping.toLocal);
  layer.contentKey += 1;
}

/** 只保留笔尖范围内的变化 */
function applyBrushLimit(
  editor: EditorApi,
  pixels: import('@/types/document').PixelBuffer,
  snapshot: Uint8ClampedArray,
  center: Point,
  radius: number,
  toLocal: (p: Point) => Point,
): void {
  const hardness = editor.option<number>('hardness', 50) / 100;
  const selection = editor.doc.selection;
  const origin = toLocal({ x: 0, y: 0 });
  void origin;
  for (let y = 0; y < pixels.height; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      const distance = Math.hypot(x - center.x, y - center.y);
      if (distance > radius) {
        const i = (y * pixels.width + x) * 4;
        pixels.data[i] = snapshot[i]!;
        pixels.data[i + 1] = snapshot[i + 1]!;
        pixels.data[i + 2] = snapshot[i + 2]!;
        pixels.data[i + 3] = snapshot[i + 3]!;
        continue;
      }
      const falloff = distance <= radius * hardness ? 1 : 1 - (distance - radius * hardness) / Math.max(1, radius * (1 - hardness));
      const i = (y * pixels.width + x) * 4;
      pixels.data[i] = snapshot[i]! * (1 - falloff) + pixels.data[i]! * falloff;
      pixels.data[i + 1] = snapshot[i + 1]! * (1 - falloff) + pixels.data[i + 1]! * falloff;
      pixels.data[i + 2] = snapshot[i + 2]! * (1 - falloff) + pixels.data[i + 2]! * falloff;
      pixels.data[i + 3] = snapshot[i + 3]! * (1 - falloff) + pixels.data[i + 3]! * falloff;
      if (selection) {
        const doc = toLocal({ x, y });
        const sx = Math.floor(doc.x);
        const sy = Math.floor(doc.y);
        const coverage = sx < 0 || sy < 0 || sx >= selection.width || sy >= selection.height ? 0 : selection.data[sy * selection.width + sx]! / 255;
        if (coverage <= 0) {
          pixels.data[i] = snapshot[i]!;
          pixels.data[i + 1] = snapshot[i + 1]!;
          pixels.data[i + 2] = snapshot[i + 2]!;
          pixels.data[i + 3] = snapshot[i + 3]!;
        }
      }
    }
  }
}

/** 涂抹工具 */
export const smudgeTool: ToolDefinition = {
  id: 'smudge',
  name: '涂抹',
  shortcut: 'R',
  group: 'retouch',
  icon: '☝',
  cursor: 'none',
  defaults: { size: 40, strength: 50 },
  specs: [
    { key: 'size', label: '大小', type: 'number', min: 1, max: 1000, step: 1, unit: 'px' },
    { key: 'strength', label: '强度', type: 'number', min: 0, max: 100, step: 1, unit: '%' },
  ],
  onDown(editor, event) {
    startPaint(editor, event.doc);
  },
  onMove(editor, event) {
    if (!state.active || !state.target) return;
    const layer = state.target.layer;
    if (layer.kind !== 'pixel' || !layer.pixels) return;
    const mapping = makeLayerMapping(layer);
    const local = mapping.toLocal(event.doc);
    const radius = Math.max(1, editor.option<number>('size', 40) / 2 / mapping.scale);
    smudgeDab(layer.pixels, local, radius, editor.option<number>('strength', 50) / 100);
    layer.contentKey += 1;
    editor.markLayerDirty(layer.id);
  },
  onUp(editor) {
    finishPaint(editor, '涂抹');
  },
  animate() {
    return true;
  },
};

/** 液化工具 */
export const liquifyTool: ToolDefinition = {
  id: 'liquify',
  name: '液化',
  shortcut: 'R',
  group: 'retouch',
  icon: '〰',
  cursor: 'none',
  defaults: { size: 60, mode: 'push', strength: 50 },
  specs: [
    { key: 'mode', label: '模式', type: 'select', options: [{ value: 'push', label: '向前变形' }, { value: 'twirl', label: '旋转' }, { value: 'bloat', label: '膨胀' }] },
    { key: 'size', label: '大小', type: 'number', min: 5, max: 500, step: 1, unit: 'px' },
    { key: 'strength', label: '强度', type: 'number', min: 1, max: 100, step: 1, unit: '%' },
  ],
  onDown(editor, event) {
    startPaint(editor, event.doc);
    state.last = event.doc;
  },
  onMove(editor, event) {
    if (!state.active || !state.target) return;
    const layer = state.target.layer;
    if (layer.kind !== 'pixel' || !layer.pixels) return;
    const mapping = makeLayerMapping(layer);
    const local = mapping.toLocal(event.doc);
    const radius = Math.max(2, editor.option<number>('size', 60) / 2 / mapping.scale);
    const strength = editor.option<number>('strength', 50) / 100;
    const mode = editor.option<string>('mode', 'push');
    const dx = event.doc.x - state.last.x;
    const dy = event.doc.y - state.last.y;
    if (mode === 'push') warpRegion(layer.pixels, local, radius, dx / mapping.scale, dy / mapping.scale, 0);
    else if (mode === 'twirl') warpRegion(layer.pixels, local, radius, 0, 0, strength * 0.3);
    else warpRegion(layer.pixels, local, radius, -dx / mapping.scale * 0.5, -dy / mapping.scale * 0.5, strength * 0.05);
    layer.contentKey += 1;
    state.last = event.doc;
    editor.markLayerDirty(layer.id);
  },
  onUp(editor) {
    finishPaint(editor, '液化');
  },
  animate() {
    return true;
  },
};

export { readLocalPixel };
export type { PaintTarget };
