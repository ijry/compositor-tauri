/**
 * 绘画与修复类工具
 * ---------------------------------------------------------------
 * 画笔、橡皮擦、污点修复、仿制图章、模糊、涂抹、液化。
 * 所有工具都会：
 *  - 通过编辑器接口拿到当前绘制目标（图层像素或图层蒙版）；
 *  - 按下时开始交互（记录快照），松开时提交为一条历史记录。
 */
import { compositeDocument } from '@/core/engine/compositor';
import { spotHeal } from '@/core/filters/contentAware';
import { cloneBuffer, maskToBuffer } from '@/core/pixels';
import { applyMatrix } from '@/core/geometry';
import { resolveEditTarget, editSelectionCoverage } from '@/core/engine/editTarget';
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
  const target=resolveEditTarget(editor.activeLayer());
  return target?{layer:target.layer,onMask:target.onMask}:null;
}

/** 前景色（带 alpha 的画笔颜色） */
function brushColor(editor: EditorApi, erase: boolean): [number, number, number, number] {
  if (erase) return [0, 0, 0, 0];
  const [r, g, b] = editor.foreground;
  return [r, g, b, 255];
}

/** 启动一次绘画 */
function startPaint(editor: EditorApi, point: Point, preference: 'auto'|'mask' = 'auto'): void {
  const resolved=resolveEditTarget(editor.activeLayer(),preference);
  const target=resolved?{layer:resolved.layer,onMask:resolved.onMask}:null;
  if(target?.onMask && !['brush','eraser','blur'].includes(editor.toolId)) {
    state.active=false;state.target=null;state.snapshot=null;
    editor.status('此修复工具暂不支持蒙版，请使用画笔或模糊工具；原图未修改');return;
  }
  if (!target) {
    state.active=false;state.target=null;state.snapshot=null;
    editor.status('当前绘制目标不可用，请检查图层锁定及蒙版是否启用');
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

/** 上一次笔画端点只在同文档同图层使用，Shift点击可连接直线。 */
let brushEndpoint: {docId:string;layerId:string;point:Point}|null=null;

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
    startPaint(editor,event.doc);if(!state.active||!state.target)return;
    const params=paintParams(editor),erase=editor.option<string>('mode','paint')==='erase';
    const options={...params,color:brushColor(editor,erase),erase,flow:1};
    if(event.shift&&brushEndpoint?.docId===editor.doc.id&&brushEndpoint.layerId===state.target.layer.id)dabAlongLine(editor.doc,state.target,brushEndpoint.point,event.doc,Math.max(.5,params.radius*.12),options);
    else paintDab(editor.doc,state.target,{x:event.doc.x,y:event.doc.y,...options});
    state.last=event.doc;
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
    if(state.target)brushEndpoint={docId:editor.doc.id,layerId:state.target.layer.id,point:{...state.last}};
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
  onDown(editor,event) {
    if(event.alt){state.cloneSource={...event.doc};cloneOffset=null;editor.status('已设置仿制源');return;}
    if(!state.cloneSource){editor.status('请先按Alt点击设置仿制源');return;}
    startPaint(editor,event.doc);if(!state.active||!state.target)return;
    const layer=state.target.layer;
    if(!editor.option<boolean>('aligned',true)||!cloneOffset)cloneOffset={x:state.cloneSource.x-event.doc.x,y:state.cloneSource.y-event.doc.y};
    cloneSample=cloneBuffer(editor.option<boolean>('sampleAllLayers',true)?editor.composite():compositeDocument({...editor.doc,layers:[{...layer,parentId:null,clipping:false}]},editor.doc.width,editor.doc.height,{scale:1}).buffer);
    cloneDab(editor,event.doc);state.last=event.doc;
  },
  onMove(editor,event) {
    if(!state.active||!state.target||!cloneSample||!cloneOffset)return;
    const distance=Math.hypot(event.doc.x-state.last.x,event.doc.y-state.last.y),steps=Math.max(1,Math.ceil(distance/Math.max(1,paintParams(editor).radius*.2)));
    for(let i=1;i<=steps;i++)cloneDab(editor,{x:state.last.x+(event.doc.x-state.last.x)*i/steps,y:state.last.y+(event.doc.y-state.last.y)*i/steps});
    state.last=event.doc;editor.markLayerDirty(state.target.layer.id);
  },
  onUp(editor){finishPaint(editor,'仿制图章');cloneSample=null;},
  animate() {
    return true;
  },
};

let cloneOffset:Point|null=null;
let cloneSample:import('@/types/document').PixelBuffer|null=null;
/** 从笔画开始时的不可变文档样本采样，避免边画边污染仿制源。 */
function cloneDab(editor:EditorApi,point:Point):void {
  const layer=state.target?.layer;if(!layer?.pixels||!cloneOffset||!cloneSample)return;
  const map=makeLayerMapping(layer),center=map.toLocal(point),params=paintParams(editor),radius=params.radius/map.scale,inner=radius*params.hardness,pixels=layer.pixels;
  for(let y=Math.max(0,Math.floor(center.y-radius));y<Math.min(pixels.height,Math.ceil(center.y+radius));y++)for(let x=Math.max(0,Math.floor(center.x-radius));x<Math.min(pixels.width,Math.ceil(center.x+radius));x++) {
    const distance=Math.hypot(x+.5-center.x,y+.5-center.y);if(distance>radius)continue;
    const doc=map.toDoc({x:x+.5,y:y+.5}),sx=Math.floor(doc.x+cloneOffset.x),sy=Math.floor(doc.y+cloneOffset.y);
    if(sx<0||sy<0||sx>=cloneSample.width||sy>=cloneSample.height)continue;
    let amount=(distance<=inner?1:(radius-distance)/Math.max(.001,radius-inner))*params.opacity;
    const selection=editor.doc.selection;if(selection){const px=Math.floor(doc.x),py=Math.floor(doc.y);amount*=px>=0&&py>=0&&px<selection.width&&py<selection.height?selection.data[py*selection.width+px]!/255:0;}
    const di=(y*pixels.width+x)*4,si=(sy*cloneSample.width+sx)*4;
    for(let c=0;c<4;c++)pixels.data[di+c]=pixels.data[di+c]!*(1-amount)+cloneSample.data[si+c]!*amount;
  }
  editor.markLayerDirty(layer.id);
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
    startPaint(editor,event.doc,editor.option<string>('target','pixels')==='mask'?'mask':'auto');
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

/** 模糊只修改明确选中的网格；临时 RGBA 用于复用预乘滤波内核。 */
function applyBlur(editor: EditorApi, point: Point): void {
  if(!state.target)return;
  const target=resolveEditTarget(state.target.layer,state.target.onMask?'mask':'pixels');
  if(!target)return;
  const strength=Math.max(0,Math.min(1,editor.option<number>('strength',.5)));
  if(strength<=0)return;
  const mapping=makeLayerMapping(target.layer,target.onMask),local=mapping.toLocal(point);
  const docRadius=Math.max(.5,editor.option<number>('size',40)/2),radius=Math.max(.5,docRadius/mapping.scale);
  const work=target.onMask?maskToBuffer(target.buffer):cloneBuffer(target.buffer);
  const x0=Math.max(0,Math.floor(local.x-radius)),y0=Math.max(0,Math.floor(local.y-radius));
  const x1=Math.min(work.width,Math.ceil(local.x+radius)),y1=Math.min(work.height,Math.ceil(local.y+radius));
  boxBlurRegion(work,{x:x0,y:y0,width:x1-x0,height:y1-y0},Math.max(1,Math.round(radius*strength)));
  const hardness=Math.max(0,Math.min(1,editor.option<number>('hardness',.5)));
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++) {
    const doc=applyMatrix(target.matrix,x+.5,y+.5),distance=Math.hypot(doc.x-point.x,doc.y-point.y)/docRadius;
    if(distance>1)continue;
    const taper=distance<=hardness?1:(1-distance)/Math.max(1e-6,1-hardness);
    const k=taper*editSelectionCoverage(editor.doc,target,x,y);if(k<=0)continue;
    const i=(y*work.width+x)*4;
    if(target.onMask) {
      const j=y*work.width+x;const next=target.buffer.data[j]*(1-k)+work.data[i]*k;target.buffer.data[j]=target.buffer.data instanceof Float32Array?next:Math.round(next);
    } else {
      const data=target.buffer.data,ab=data[i+3]/255,af=work.data[i+3]/255,alpha=ab*(1-k)+af*k;
      for(let c=0;c<3;c++)data[i+c]=alpha>0?(data[i+c]*ab*(1-k)+work.data[i+c]*af*k)/alpha:0;
      data[i+3]=alpha*255;
    }
  }
  editor.markLayerDirty(target.layer.id);
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
    if (mode === 'push') warpRegion(layer.pixels, local, radius, dx * strength / mapping.scale, dy * strength / mapping.scale, 0);
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
