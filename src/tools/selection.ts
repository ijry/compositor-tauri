import { pixelDepth } from '@/core/pixelFormat';
import { createBuffer } from '@/core/pixels';
/**
 * 选区类工具
 * ---------------------------------------------------------------
 * 矩形/椭圆框选、自由套索、多边形套索、魔棒、对象选择。
 * 所有工具都遵循：⇧ 加选、⌥ 减选、⇧⌥ 交叉选。
 */
import { selectionFromEllipse, selectionFromPath, selectionFromRect } from '@/core/selection';
import {
  colorRangeSelection, contractSelection, expandSelection, magicWand, selectBoundary, selectSubject,
} from '@/core/ops/selectionOps';
import { beginSelectionMove, updateSelectionMove, endSelectionMove } from './selectionMove';
import { compositeDocument } from '@/core/engine/compositor';
import { createSelection, featherSelection } from '@/core/selection';
import { beginInteraction, commitSelection, drawAnts, drawHandles, endInteraction, rectFromPoints, snapshotBytes } from '@/tools/helpers';
import type { EditorApi } from '@/types/editor';
import type { ToolDefinition, ToolOverlayContext, ToolPointerEvent } from '@/tools/types';
import type { Point, Rect } from '@/types/document';
import { marchingSegments } from '@/core/selection';

/** 根据修饰键推导布尔模式 */
export function booleanMode(event: { shift: boolean; alt: boolean }): 'replace' | 'add' | 'subtract' | 'intersect' {
  if (event.shift && event.alt) return 'intersect';
  if (event.shift) return 'add';
  if (event.alt) return 'subtract';
  return 'replace';
}

/** 当前正在拖动的选区形状（矩形/椭圆/套索共用） */
interface DragState {
  start: Point;
  points: Point[];
  active: boolean;
}

const dragState: DragState = { start: { x: 0, y: 0 }, points: [], active: false };

/** 框选工具（矩形 / 椭圆） */
export const marqueeTool: ToolDefinition = {
  id: 'marquee',
  name: '矩形框选',
  shortcut: 'M',
  group: 'select',
  icon: '▭',
  cursor: 'crosshair',
  defaults: { shape: 'rect', feather: 0, antialias: true },
  specs: [
    { key: 'shape', label: '形状', type: 'select', options: [{ value: 'rect', label: '矩形' }, { value: 'ellipse', label: '椭圆' }] },
    { key: 'feather', label: '羽化', type: 'number', min: 0, max: 250, step: 0.5, unit: 'px' },
    { key: 'antialias', label: '消除锯齿', type: 'boolean' },
  ],
  onDown(editor, event) {
    if(!event.shift&&!event.alt&&beginSelectionMove(editor,event.doc,false,true)){dragState.active=false;return;}
    dragState.start = event.doc;
    dragState.points = [event.doc];
    dragState.active = true;
  },
  onMove(editor, event) {
    if(updateSelectionMove(editor,event.doc))return;
    if (!dragState.active) return;
    dragState.points.push(event.doc);
  },
  onUp(editor, event) {
    if(endSelectionMove(editor))return;
    if (!dragState.active) return;
    dragState.active = false;
    const rect = rectFromPoints(dragState.start, event.doc);
    if (rect.width < 1 || rect.height < 1) {
      editor.setSelection(createSelection(editor.doc.width, editor.doc.height, 0));
      return;
    }
    const feather = editor.option<number>('feather', 0);
    const shape = editor.option<string>('shape', 'rect');
    let selection = shape === 'ellipse'
      ? selectionFromEllipse(editor.doc.width, editor.doc.height, rect, editor.option<boolean>('antialias',true))
      : selectionFromRect(editor.doc.width, editor.doc.height, rect);
    if (feather > 0) {
      const data = new Uint8Array(selection.data);
      // 简单羽化：对覆盖率做两次盒式模糊
      blurInPlace(data, editor.doc.width, editor.doc.height, Math.max(1, Math.round(feather)));
      selection = { ...selection, data, outline: null };
    }
    commitSelection(editor, selection, booleanMode(event));
  },
  drawOverlay(context) {
    if (!dragState.active) return;
    const rect = rectFromPoints(dragState.start, dragState.points[dragState.points.length - 1] ?? dragState.start);
    const a = context.toScreen({ x: rect.x, y: rect.y });
    const b = context.toScreen({ x: rect.x + rect.width, y: rect.y + rect.height });
    context.ctx.save();
    context.ctx.strokeStyle = '#38bdf8';
    context.ctx.lineWidth = 1;
    if (editor0(context).option<string>('shape', 'rect') === 'ellipse') {
      context.ctx.beginPath();
      context.ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      context.ctx.stroke();
    } else {
      context.ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    }
    context.ctx.restore();
  },
};

/** 简易盒式模糊（用于选区羽化） */
function blurInPlace(data: Uint8Array, width: number, height: number, radius: number): void {
  const temp = new Float32Array(data.length);
  const out = new Float32Array(data.length);
  const window = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) sum += data[y * width + Math.min(width - 1, Math.max(0, k))]!;
    for (let x = 0; x < width; x += 1) {
      temp[y * width + x] = sum / window;
      sum += data[y * width + Math.min(width - 1, x + radius + 1)]! - data[y * width + Math.max(0, x - radius)]!;
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) sum += temp[Math.min(height - 1, Math.max(0, k)) * width + x]!;
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum / window;
      sum += temp[Math.min(height - 1, y + radius + 1) * width + x]! - temp[Math.max(0, y - radius) * width + x]!;
    }
  }
  for (let i = 0; i < data.length; i += 1) data[i] = Math.max(0, Math.min(255, out[i]!));
}

/** 工具上下文里取编辑器（避免重复传参） */
function editor0(context: ToolOverlayContext): EditorApi {
  return context.editor;
}

/** 套索工具（自由 / 多边形） */
export const lassoTool: ToolDefinition = {
  id: 'lasso',
  name: '套索',
  shortcut: 'L',
  group: 'select',
  icon: '⌇',
  cursor: 'crosshair',
  defaults: { mode: 'free', feather: 0 },
  specs: [
    { key: 'mode', label: '模式', type: 'select', options: [{ value: 'free', label: '自由' }, { value: 'polygon', label: '多边形' }] },
    { key: 'feather', label: '羽化', type: 'number', min: 0, max: 250, step: 0.5, unit: 'px' },
  ],
  deactivate() { dragState.active=false;dragState.points=[]; },
  onDown(editor,event) {
    if(editor.option<string>('mode','free')==='polygon' && dragState.active) {
      if(dragState.points.length>2 && Math.hypot(event.doc.x-dragState.start.x,event.doc.y-dragState.start.y)<6/editor.viewport.zoom){finishLasso(editor,booleanMode(event));return;}
      dragState.points.push(event.doc);return;
    }
    dragState.start=event.doc;dragState.points=[event.doc];dragState.active=true;
  },
  onMove(editor,event) { if(dragState.active&&editor.option<string>('mode','free')==='free')dragState.points.push(event.doc); },
  onUp(editor,event) { if(dragState.active&&editor.option<string>('mode','free')==='free')finishLasso(editor,booleanMode(event)); },
  onDblClick(editor,event) { if(dragState.active&&dragState.points.length>=3)finishLasso(editor,booleanMode(event));else{dragState.active=false;dragState.points=[];editor.invalidate();} },
  onKeyDown(editor,event) {
    if(!dragState.active)return false;
    if(event.key==='Escape'){dragState.active=false;dragState.points=[];editor.invalidate();return true;}
    if(event.key==='Backspace'||event.key==='Delete'){dragState.points.pop();editor.invalidate();return true;}
    if(event.key==='Enter'){finishLasso(editor,booleanMode({shift:event.shiftKey,alt:event.altKey}));return true;}
    return false;
  },
  drawOverlay(context) {
    if (!dragState.active || dragState.points.length === 0) return;
    const points = dragState.points.map((p) => context.toScreen(p));
    context.ctx.save();
    context.ctx.strokeStyle = '#38bdf8';
    context.ctx.lineWidth = 1;
    context.ctx.beginPath();
    context.ctx.moveTo(points[0]!.x, points[0]!.y);
    for (const point of points.slice(1)) context.ctx.lineTo(point.x, point.y);
    context.ctx.stroke();
    context.ctx.restore();
  },
};

/** 自由套索和多边形闭合共用提交路径，羽化在布尔合并前执行。 */
function finishLasso(editor:EditorApi,mode:ReturnType<typeof booleanMode>):void {
  if(dragState.points.length<3)return;
  dragState.active=false;
  const selection=selectionFromPath(editor.doc.width,editor.doc.height,dragState.points);
  commitSelection(editor,featherSelection(selection,editor.option<number>('feather',0)),mode);
  dragState.points=[];editor.invalidate();
}

/** 魔棒工具 */
export const wandTool: ToolDefinition = {
  id: 'wand',
  name: '魔棒',
  shortcut: 'W',
  group: 'magic',
  icon: '✦',
  cursor: 'crosshair',
  defaults: { tolerance: 32, contiguous: true, sampleAllLayers: true, feather: 0, antialias: true },
  specs: [
    { key: 'tolerance', label: '容差', type: 'number', min: 0, max: 100, step: 1 },
    { key: 'contiguous', label: '连续', type: 'boolean' },
    { key: 'sampleAllLayers', label: '所有图层取样', type: 'boolean' },
    { key: 'feather', label: '羽化', type: 'number', min: 0, max: 250, step: 0.5, unit: 'px' },
    { key: 'antialias', label: '消除锯齿', type: 'boolean' },
  ],
  onDown(editor, event) {
    const layer=editor.activeLayer();
    const composite = editor.option<boolean>('sampleAllLayers',true)||!layer?editor.composite():compositeDocument({...editor.doc,layers:[{...layer,parentId:null,clipping:false}],selection:null},editor.doc.width,editor.doc.height,{scale:1}).buffer;
    const selection = magicWand(composite, event.doc.x, event.doc.y, {
      tolerance: editor.option<number>('tolerance', 32),
      contiguous: editor.option<boolean>('contiguous', true),
      sampleAllLayers: true,
      feather: editor.option<number>('feather', 0),
    });
    commitSelection(editor, editor.option<boolean>('antialias',true)?featherSelection(selection,0.5):selection, booleanMode(event), '魔棒选区');
  },
  drawOverlay(context) {
    drawSelectionAnts(context);
  },
};

/** 对象选择工具：点击自动抠出主体 */
export const objectSelectTool: ToolDefinition = {
  id: 'objectSelect',
  name: '对象选择',
  shortcut: 'W',
  group: 'magic',
  icon: '◈',
  cursor: 'crosshair',
  defaults: { sensitivity: 50, feather: 1 },
  specs: [
    { key: 'sensitivity', label: '灵敏度', type: 'number', min: 0, max: 100, step: 1 },
    { key: 'feather', label: '羽化', type: 'number', min: 0, max: 20, step: 0.5, unit: 'px' },
  ],
  onDown(editor, event) {
    editor.status('正在分析主体区域…');
    const composite = editor.composite();
    // 以点击位置为中心裁剪局部区域分析，速度更快
    const radius = Math.max(120, Math.round(Math.min(editor.doc.width, editor.doc.height) / 2));
    const rect: Rect = {
      x: Math.max(0, Math.round(event.doc.x - radius)),
      y: Math.max(0, Math.round(event.doc.y - radius)),
      width: Math.min(editor.doc.width - Math.max(0, Math.round(event.doc.x - radius)), radius * 2),
      height: Math.min(editor.doc.height - Math.max(0, Math.round(event.doc.y - radius)), radius * 2),
    };
    if (rect.width < 8 || rect.height < 8) return;
    const patch = crop(composite, rect);
    const local = selectSubject(patch, editor.option<number>('sensitivity', 50));
    const merged = createSelection(editor.doc.width, editor.doc.height, 0);
    for (let y = 0; y < local.height; y += 1) {
      for (let x = 0; x < local.width; x += 1) {
        merged.data[(rect.y + y) * editor.doc.width + rect.x + x] = local.data[y * local.width + x]!;
      }
    }
    commitSelection(editor, featherSelection(merged,editor.option<number>('feather',1)), booleanMode(event), '对象选择');
    editor.status('已建立对象选区');
  },
  drawOverlay(context) {
    drawSelectionAnts(context);
  },
};

/** 裁剪局部区域 */
function crop(buffer: import('@/types/document').PixelBuffer, rect: Rect): import('@/types/document').PixelBuffer {
  const out = createBuffer(rect.width,rect.height,undefined,pixelDepth(buffer));
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      const si = ((rect.y + y) * buffer.width + rect.x + x) * 4;
      const di = (y * rect.width + x) * 4;
      out.data[di] = buffer.data[si]!;
      out.data[di + 1] = buffer.data[si + 1]!;
      out.data[di + 2] = buffer.data[si + 2]!;
      out.data[di + 3] = buffer.data[si + 3]!;
    }
  }
  return out;
}

/** 绘制当前选区蚂蚁线 */
export function drawSelectionAnts(context: ToolOverlayContext): void {
  const selection = context.editor.doc.selection;
  if (!selection) return;
  const phase = (Date.now() / 60) % 8;
  const segments = marchingSegments(selection).map(([start, end]) => [context.toScreen(start), context.toScreen(end)] as [Point, Point]);
  drawAnts(context.ctx, segments, phase);
}

/** 选区扩展 / 收缩 / 边界（供命令调用） */
export function applySelectionOperation(editor: EditorApi, operation: 'expand' | 'contract' | 'boundary', amount: number): void {
  const selection = editor.doc.selection;
  if (!selection) return;
  const before = editor.selectionSnapshot();
  let next = selection;
  if (operation === 'expand') next = expandSelection(selection, amount);
  else if (operation === 'contract') next = contractSelection(selection, amount);
  else next = selectBoundary(selection);
  editor.setSelection(next, 'replace');
  const after = editor.selectionSnapshot();
  const label = operation === 'expand' ? '扩展选区' : operation === 'contract' ? '收缩选区' : '选区边界';
  editor.pushHistory(
    label,
    () => { editor.restoreSelection(before); editor.invalidate(); },
    () => { editor.restoreSelection(after); editor.invalidate(); },
    selection.data.length * 2,
  );
}

/** 色彩范围（由对话框调用） */
export function applyColorRange(
  editor: EditorApi,
  options: { hue: number; hueRange: number; saturation: number; saturationRange: number; feather: number },
): void {
  const composite = editor.composite();
  const selection = colorRangeSelection(composite, options);
  commitSelection(editor, selection, 'replace', '色彩范围');
}

/** 变换选区轮廓（移动轮廓而不动像素） */
export function transformSelectionOutline(editor: EditorApi, offset: Point): void {
  const selection = editor.doc.selection;
  if (!selection) return;
  const before = editor.selectionSnapshot();
  const data = new Uint8Array(selection.data);
  for (let y = 0; y < selection.height; y += 1) {
    for (let x = 0; x < selection.width; x += 1) {
      const sx = Math.round(x - offset.x);
      const sy = Math.round(y - offset.y);
      if (sx < 0 || sy < 0 || sx >= selection.width || sy >= selection.height) continue;
      data[y * selection.width + x] = selection.data[sy * selection.width + sx]!;
    }
  }
  editor.setSelection({ ...selection, data, outline: null }, 'replace');
  const after = editor.selectionSnapshot();
  editor.pushHistory(
    '变换选区',
    () => { editor.restoreSelection(before); editor.invalidate(); },
    () => { editor.restoreSelection(after); editor.invalidate(); },
    selection.data.length * 2,
  );
}

export { beginInteraction, endInteraction, snapshotBytes, drawHandles };
export type { ToolPointerEvent };

/** 独立选择工具用于框选和移动选区轮廓。 */
export const selectTool:ToolDefinition={...marqueeTool,id:'select',name:'选择',shortcut:'A',icon:'↖'};
