/**
 * 变换与裁剪工具
 * ---------------------------------------------------------------
 * 移动/变换是非破坏性的：只改图层 transform（必要时改 warp 四点），
 * 因此图层缩放到 5% 仍保持原始分辨率。
 */
import { reactive } from 'vue';
import { cloneBuffer } from '@/core/pixels';
import { compositeDocument } from '@/core/engine/compositor';
import { cropDocument, uuid, descendantsOf } from '@/core/document';
import { beginSelectionMove, updateSelectionMove, endSelectionMove, nudgeSelectionPixels } from './selectionMove';
import { placementTransform } from '@/core/engine/maskGeometry';
import { snapPoint, snapTranslation } from '@/core/engine/snapping';
import { defaultTextMeta, renderText } from '@/core/engine/text';
import { beginInteraction, drawHandles, endInteraction, hitHandle, hitRect, rectFromPoints, snapshotBytes } from '@/tools/helpers';
import type { EditorApi } from '@/types/editor';
import type { ToolDefinition, ToolOverlayContext } from '@/tools/types';
import type { LayerTransform, Point, Rect } from '@/types/document';

interface TransformState {
  mode: 'idle' | 'move' | 'scale' | 'rotate' | 'warp';
  handle: number;
  start: Point;
  origins: Map<string, LayerTransform>;
  ids: string[];
  center: Point;
  startAngle: number;
  rect: Rect;
  basis:LayerTransform|null;
  masks:Set<string>;
}

const transformState: TransformState = {
  mode: 'idle', handle: -1, start: { x: 0, y: 0 }, origins: new Map(), ids: [], center: { x: 0, y: 0 }, startAngle: 0, rect:{x:0,y:0,width:1,height:1},basis:null,masks:new Set(),
};

/** 图层在文档空间的四个角（含旋转与翻转） */
export function layerCorners(layer: import('@/types/document').Layer): Point[] {
  const width = layer.transform.size[0];
  const height = layer.transform.size[1];
  const origin = layer.transform.origin;
  const angle = (layer.transform.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const flipX = layer.transform.flipX ? -1 : 1;
  const flipY = layer.transform.flipY ? -1 : 1;
  return ([[0, 0], [width, 0], [width, height], [0, height]] as [number, number][]).map(([x, y]) => {
    const dx = (x - width / 2) * flipX;
    const dy = (y - height / 2) * flipY;
    return {
      x: origin[0] + width / 2 + dx * cos - dy * sin,
      y: origin[1] + height / 2 + dx * sin + dy * cos,
    };
  });
}

/** 由四点得到外接矩形 */
export function cornersRect(points: Point[]): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/** 文档 -> 图层局部的近似逆变换（扭曲取点用） */
function invertSimple(transform: LayerTransform): (p: Point) => Point {
  const angle = (-transform.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const center = { x: transform.origin[0] + transform.size[0] / 2, y: transform.origin[1] + transform.size[1] / 2 };
  const flipX = transform.flipX ? -1 : 1;
  const flipY = transform.flipY ? -1 : 1;
  return (p: Point): Point => {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    return {
      x: ((dx * cos - dy * sin) * flipX) + transform.size[0] / 2,
      y: ((dx * sin + dy * cos) * flipY) + transform.size[1] / 2,
    };
  };
}

/** 独立蒙版的变换映射到placement，不改动原图像。 */
function readTransform(layer:import('@/types/document').Layer):LayerTransform {
  return layer.mask?.target==='mask'&&!layer.mask.linked&&layer.mask.placement?placementTransform(layer.mask.placement):layer.transform;
}
function writeTransform(layer:import('@/types/document').Layer,t:LayerTransform,mask=layer.mask?.target==='mask'&&!layer.mask.linked):void {
  if(mask&&layer.mask?.placement)layer.mask.placement={x:t.origin[0],y:t.origin[1],width:t.size[0],height:t.size[1],rotation:t.rotation,flipX:t.flipX,flipY:t.flipY,sampling:t.sampling};
  else layer.transform=t;
}

/** 移动 / 变换工具 */
export const moveTool: ToolDefinition = {
  id: 'move',
  name: '移动 / 变换',
  shortcut: 'V',
  group: 'move',
  icon: '✥',
  cursor: 'default',
  defaults: { snap: true, transformAll: false, showControls: true },
  specs: [
    { key: 'snap', label: '自动对齐', type: 'boolean' },
    { key: 'transformAll', label: '变换所有图层', type: 'boolean' },
    { key: 'showControls', label: '显示变换控件', type: 'boolean' },
  ],
  onDown(editor, event) {
    const layer = editor.activeLayer();
    if (!layer || layer.locked) return;
    if(beginSelectionMove(editor,event.doc,event.alt)){transformState.mode='idle';return;}
    let ids = editor.option<boolean>('transformAll', false)
      ? editor.doc.layers.filter((item) => item.isVisible).map((item) => item.id)
      : [...new Set((editor.doc.selectedLayerIds?.includes(layer.id)?editor.doc.selectedLayerIds:[layer.id]).flatMap(id=>{const item=editor.findLayer(id);return item?.kind==='group'?[id,...descendantsOf(editor.doc,id).map(c=>c.id)]:[id];}))];
    if(layer.mask?.target==='mask')ids=[layer.id];
    const visible=ids.map(id=>editor.findLayer(id)).filter(l=>l&&l.kind!=='group');
    const rect=layer.kind==='group'&&layer.mask?.target!=='mask'&&visible.length?cornersRect(visible.flatMap(l=>layerCorners(l!))):cornersRect(layerCorners({...layer,transform:readTransform(layer)}));
    transformState.basis=layer.kind==='group'&&layer.mask?.target!=='mask'?{...layer.transform,origin:[rect.x,rect.y],size:[rect.width,rect.height]}:JSON.parse(JSON.stringify(readTransform(layer)));
    transformState.masks=new Set(ids.filter(id=>{const l=editor.findLayer(id);return l?.mask?.target==='mask'&&!l.mask.linked;}));
    transformState.rect=rect;
    const tolerance = 7 / Math.max(0.05, editor.viewport.zoom);
    const handle = hitHandle(rect, event.doc, tolerance);
    transformState.ids = ids;
    transformState.origins = new Map();
    for (const id of ids) {
      const target = editor.findLayer(id);
      if (target) transformState.origins.set(id, JSON.parse(JSON.stringify(readTransform(target))) as LayerTransform);
    }
    transformState.start = event.doc;
    transformState.center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    transformState.startAngle = Math.atan2(event.doc.y - transformState.center.y, event.doc.x - transformState.center.x) * 180 / Math.PI;
    if (handle >= 0) {
      transformState.mode = event.meta ? 'warp' : 'scale';
      transformState.handle = handle;
    } else if (hitRect(rect, event.doc)) {
      transformState.mode = 'move';
      transformState.handle = -1;
    } else {
      transformState.mode = 'rotate';
      transformState.handle = -1;
    }
  },
  onMove(editor, event) {
    if(updateSelectionMove(editor,event.doc))return;
    if (transformState.mode === 'idle') return;
    const active = editor.activeLayer();
    if (!active) return;
    const ids = transformState.ids;
    if (transformState.mode === 'move') {
      let delta = { x: event.doc.x - transformState.start.x, y: event.doc.y - transformState.start.y };
      if (editor.option<boolean>('snap', true) && !event.meta) {
        delta=snapTranslation(editor,transformState.rect,delta,ids);
      }
      if (event.shift) {
        if (Math.abs(delta.x) > Math.abs(delta.y)) delta.y = 0;
        else delta.x = 0;
      }
      for (const id of ids) {
        const origin = transformState.origins.get(id);
        const layer = editor.findLayer(id);
        if (!origin || !layer) continue;
        writeTransform(layer,{...origin,origin:[origin.origin[0]+delta.x,origin.origin[1]+delta.y]});
      }
      editor.invalidate();
      return;
    }
    if (transformState.mode === 'scale') {
      const origin = transformState.basis;
      if (!origin) return;
      const handle = transformState.handle;
      const sx = origin.size[0] === 0 ? 1 : Math.max(0.01, (event.doc.x - origin.origin[0]) / origin.size[0]);
      const sy = origin.size[1] === 0 ? 1 : Math.max(0.01, (event.doc.y - origin.origin[1]) / origin.size[1]);
      let width = origin.size[0];
      let height = origin.size[1];
      if (handle === 0 || handle === 1 || handle === 2) width = origin.size[0] * sx;
      if (handle >= 3) height = origin.size[1] * sy;
      if (event.shift) {
        const ratio = origin.size[0] / Math.max(1, origin.size[1]);
        if (handle <= 2) height = width / ratio;
        else width = height * ratio;
      }
      const kx=Math.max(1,width)/origin.size[0],ky=Math.max(1,height)/origin.size[1];
      for(const id of ids){const target=editor.findLayer(id),base=transformState.origins.get(id);if(!target||!base)continue;writeTransform(target,{...base,origin:[origin.origin[0]+(base.origin[0]-origin.origin[0])*kx,origin.origin[1]+(base.origin[1]-origin.origin[1])*ky],size:[Math.max(1,base.size[0]*kx),Math.max(1,base.size[1]*ky)]});}
      editor.invalidate();
      return;
    }
    if (transformState.mode === 'rotate') {
      const origin = transformState.basis;
      if (!origin) return;
      const angle = Math.atan2(event.doc.y - transformState.center.y, event.doc.x - transformState.center.x) * 180 / Math.PI;
      let next = origin.rotation + (angle - transformState.startAngle);
      if (event.shift) next = Math.round(next / 15) * 15;
      else if (editor.option<boolean>('snap', true)) next = Math.round(next);
      const delta=(next-origin.rotation)*Math.PI/180,center=transformState.center;
      for(const id of ids){const target=editor.findLayer(id),base=transformState.origins.get(id);if(!target||!base)continue;const x=base.origin[0]+base.size[0]/2-center.x,y=base.origin[1]+base.size[1]/2-center.y;writeTransform(target,{...base,origin:[center.x+x*Math.cos(delta)-y*Math.sin(delta)-base.size[0]/2,center.y+x*Math.sin(delta)+y*Math.cos(delta)-base.size[1]/2],rotation:base.rotation+next-origin.rotation});}
      editor.invalidate();
      return;
    }
    // 自由扭曲：拖动角点改变 warp 的分数坐标
    const origin = transformState.origins.get(active.id);
    if (!origin || active.kind !== 'pixel' || !active.pixels) return;
    const warp = origin.warp ?? [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const cornerIndex = transformState.handle >= 0 ? [0, 1, 2, 3][Math.floor(transformState.handle / 2)] ?? 0 : 0;
    let point=event.doc;
    if(event.shift){const dx=point.x-transformState.start.x,dy=point.y-transformState.start.y;point=Math.abs(dx)>=Math.abs(dy)?{x:point.x,y:transformState.start.y}:{x:transformState.start.x,y:point.y};}
    const local = invertSimple(origin)(point);
    const next = [...warp] as [Point, Point, Point, Point];
    next[cornerIndex] = {
      x: local.x / Math.max(1, active.pixels.width),
      y: local.y / Math.max(1, active.pixels.height),
    };
    active.transform.warp = next;
    editor.invalidate();
  },
  onUp(editor) {
    if(endSelectionMove(editor))return;
    if (transformState.mode === 'idle') return;
    transformState.mode = 'idle';
    // 记录历史：提交一次变换
    const label = '变换图层';
    const maskTargets=new Set(transformState.masks);
    const before = new Map<string, LayerTransform>();
    for (const [id, value] of transformState.origins) before.set(id, value);
    const after = new Map<string, LayerTransform>();
    for (const id of before.keys()) {
      const layer = editor.findLayer(id);
      if (layer) after.set(id, JSON.parse(JSON.stringify(readTransform(layer))) as LayerTransform);
    }
    let changed = false;
    for (const [id, value] of before) {
      const current = after.get(id);
      if (current && JSON.stringify(current) !== JSON.stringify(value)) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    editor.pushHistory(
      label,
      () => {
        for (const [id, value] of before) {
          const layer = editor.findLayer(id);
          if (layer) writeTransform(layer,JSON.parse(JSON.stringify(value)) as LayerTransform,maskTargets.has(id));
        }
        editor.invalidate();
      },
      () => {
        for (const [id, value] of after) {
          const layer = editor.findLayer(id);
          if (layer) writeTransform(layer,JSON.parse(JSON.stringify(value)) as LayerTransform,maskTargets.has(id));
        }
        editor.invalidate();
      },
      128 * before.size,
    );
  },
  onKeyDown(editor, event) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return false;
    const layer = editor.activeLayer();
    if (!layer) return false;
    const step = event.shiftKey ? 10 : 1;
    if((event.ctrlKey||event.metaKey)&&editor.doc.selection)return nudgeSelectionPixels(editor,event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0);
    const ids=editor.doc.selectedLayerIds?.includes(layer.id)?editor.doc.selectedLayerIds:[layer.id];
    const targets=layer.mask?.target==='mask'?[layer.id]:[...new Set(ids.flatMap(id=>[id,...descendantsOf(editor.doc,id).map(l=>l.id)]))];
    const maskTargets=new Set(targets.filter(id=>{const l=editor.findLayer(id);return l?.mask?.target==='mask'&&!l.mask.linked;}));
    const before=new Map(targets.map(id=>[id,JSON.parse(JSON.stringify(readTransform(editor.findLayer(id)!))) as LayerTransform]));
    const dx=event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,dy=event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0;
    const after=new Map([...before].map(([id,t])=>[id,{...t,origin:[t.origin[0]+dx,t.origin[1]+dy] as [number,number]}]));
    const apply=(map:Map<string,LayerTransform>)=>{for(const [id,t]of map){const target=editor.findLayer(id);if(target)writeTransform(target,JSON.parse(JSON.stringify(t)),maskTargets.has(id));}editor.invalidate();};
    apply(after);editor.pushHistory('微移图层',()=>apply(before),()=>apply(after),targets.length*128);
    editor.invalidate();
    return true;
  },
  drawOverlay(context) {
    drawTransformControls(context);
  },
};

/** 绘制变换控件 */
export function drawTransformControls(context: ToolOverlayContext): void {
  if(!context.editor.option<boolean>('showControls',true))return;
  const { editor } = context;
  if (!editor.ui.transformControls) return;
  const ids = editor.option<boolean>('transformAll', false)
    ? editor.doc.layers.filter((layer) => layer.isVisible).map((layer) => layer.id)
    : [editor.doc.activeLayerId ?? ''];
  for (const id of ids) {
    const layer = editor.findLayer(id);
    if (!layer) continue;
    let local=layerCorners({...layer,transform:readTransform(layer)});
    if(layer.kind==='group'&&layer.mask?.target!=='mask'){const children=descendantsOf(editor.doc,layer.id).filter(l=>l.kind!=='group');if(children.length){const r=cornersRect(children.flatMap(l=>layerCorners(l)));local=[{x:r.x,y:r.y},{x:r.x+r.width,y:r.y},{x:r.x+r.width,y:r.y+r.height},{x:r.x,y:r.y+r.height}];}}
    const corners = local.map((p) => context.toScreen(p));
    const ctx = context.ctx;
    ctx.save();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(corners[0]!.x, corners[0]!.y);
    for (const point of corners.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.closePath();
    ctx.stroke();
    drawHandles(ctx, cornersRect(corners), 6);
    ctx.restore();
  }
}

/** 文档级快照（画布操作使用） */
export interface DocumentSnapshot {
  layers: Map<string, import('@/types/editor').LayerSnapshot>;
  selection: import('@/types/document').SelectionMask | null;
  width: number;
  height: number;
  guides: import('@/types/document').Guide[];
}

export function snapshotDocument(editor: EditorApi): DocumentSnapshot {
  const layers = new Map<string, import('@/types/editor').LayerSnapshot>();
  for (const layer of editor.doc.layers) {
    const snapshot = editor.snapshotLayer(layer.id);
    if (snapshot) layers.set(layer.id, snapshot);
  }
  return {
    layers,
    selection: editor.selectionSnapshot(),
    width: editor.doc.width,
    height: editor.doc.height,
    guides: editor.doc.guides.map((guide) => ({ ...guide })),
  };
}

/** 恢复文档快照并记录历史 */
export function restoreAndRecord(editor: EditorApi, snapshot: DocumentSnapshot, label: string, bytes = 1024): void {
  const after = snapshotDocument(editor);
  const restore = (state: DocumentSnapshot): void => {
    editor.doc.width = state.width;
    editor.doc.height = state.height;
    editor.doc.guides = state.guides.map((guide) => ({ ...guide }));
    for (const [id, value] of state.layers) editor.restoreLayer(id, value);
    editor.restoreSelection(state.selection);
    editor.invalidate();
  };
  editor.pushHistory(label, () => restore(snapshot), () => restore(after), bytes);
}

/* ------------------------------ 裁剪 ------------------------------ */

const cropState = { rect: null as Rect | null, dragging: false, start: { x: 0, y: 0 } };

export const cropTool: ToolDefinition = {
  id: 'crop',
  name: '裁剪',
  shortcut: 'C',
  group: 'crop',
  icon: '⌗',
  cursor: 'crosshair',
  defaults: { ratio: 'free' },
  specs: [
    {
      key: 'ratio',
      label: '比例',
      type: 'select',
      options: [
        { value: 'free', label: '自由' },
        { value: '1:1', label: '1:1' },
        { value: '4:3', label: '4:3' },
        { value: '3:4', label: '3:4' },
        { value: '16:9', label: '16:9' },
        { value: '9:16', label: '9:16' },
        { value: '3:2', label: '3:2' },
        { value: '2:3', label: '2:3' },
      ],
    },
  ],
  activate(editor) {
    // 有选区时从选区开始裁剪
    const selection = editor.doc.selection;
    if (selection) {
      let minX = selection.width;
      let minY = selection.height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < selection.height; y += 1) {
        for (let x = 0; x < selection.width; x += 1) {
          if (selection.data[y * selection.width + x]! > 128) {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          }
        }
      }
      if (maxX >= 0) {
        cropState.rect = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
        editor.invalidate();
        return;
      }
    }
    cropState.rect = { x: 0, y: 0, width: editor.doc.width, height: editor.doc.height };
    editor.invalidate();
  },
  deactivate(editor) {
    cropState.rect = null;
    editor.invalidate();
  },
  onDown(editor, event) {
    cropState.dragging = true;
    cropState.start = event.doc;
    cropState.rect = { x: event.doc.x, y: event.doc.y, width: 0, height: 0 };
  },
  onMove(editor, event) {
    if (!cropState.dragging) return;
    const start=cropState.start,end=snapPoint(editor,event.doc).point;
    const signX=end.x>=start.x?1:-1,signY=end.y>=start.y?1:-1;
    let width=Math.abs(end.x-start.x),height=Math.abs(end.y-start.y);
    const parts=editor.option<string>('ratio','free').split(':').map(Number),ratio=parts[0]&&parts[1]?parts[0]/parts[1]:null;
    const maxW=event.alt?Math.min(start.x,editor.doc.width-start.x):signX>0?editor.doc.width-start.x:start.x;
    const maxH=event.alt?Math.min(start.y,editor.doc.height-start.y):signY>0?editor.doc.height-start.y:start.y;
    if(ratio){if(width/Math.max(.001,height)>ratio)height=width/ratio;else width=height*ratio;const k=Math.min(1,maxW/Math.max(.001,width),maxH/Math.max(.001,height));width*=k;height*=k;}
    else {width=Math.min(width,maxW);height=Math.min(height,maxH);}
    const rect=event.alt?{x:start.x-width,y:start.y-height,width:width*2,height:height*2}:{x:signX>0?start.x:start.x-width,y:signY>0?start.y:start.y-height,width,height};
    cropState.rect = rect;
    editor.invalidate();
  },
  onUp(editor) {
    cropState.dragging = false;
    editor.invalidate();
  },
  onKeyDown(editor, event) {
    if (event.key === 'Enter') {
      applyCrop(editor);
      return true;
    }
    if (event.key === 'Escape') {
      cropState.rect = null;
      editor.invalidate();
      return true;
    }
    return false;
  },
  onDblClick(editor) {
    applyCrop(editor);
  },
  drawOverlay(context) {
    const rect = cropState.rect;
    if (!rect) return;
    const { ctx, toScreen } = context;
    const a = toScreen({ x: rect.x, y: rect.y });
    const b = toScreen({ x: rect.x + rect.width, y: rect.y + rect.height });
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, context.width, context.height);
    ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    for (let i = 1; i <= 2; i += 1) {
      ctx.moveTo(a.x + ((b.x - a.x) * i) / 3, a.y);
      ctx.lineTo(a.x + ((b.x - a.x) * i) / 3, b.y);
      ctx.moveTo(a.x, a.y + ((b.y - a.y) * i) / 3);
      ctx.lineTo(b.x, a.y + ((b.y - a.y) * i) / 3);
    }
    ctx.stroke();
    drawHandles(ctx, { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y }, 6);
    ctx.restore();
  },
};

/** 执行裁剪 */
export function applyCrop(editor: EditorApi): void {
  const rect = cropState.rect;
  if (!rect || rect.width < 1 || rect.height < 1) return;
  const snapshot = snapshotDocument(editor);
  const parts=editor.option<string>('ratio','free').split(':').map(Number);
  if(parts[0]&&parts[1]){const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a,div=gcd(parts[0],parts[1]),w=parts[0]/div,h=parts[1]/div,k=Math.floor(Math.min(rect.width/w,rect.height/h));if(k<1)return;rect.width=w*k;rect.height=h*k;}
  cropDocument(editor.doc, rect);
  cropState.rect = null;
  restoreAndRecord(editor, snapshot, '裁剪');
  editor.invalidate();
}

/* ------------------------------ 渐变 ------------------------------ */

const gradientState = { start: null as Point | null, end: null as Point | null };

export interface GradientSettings {
  type: 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';
  opacity: number;
  reverse: boolean;
  dither: boolean;
  from: [number, number, number];
  to: [number, number, number];
}

export const gradientTool: ToolDefinition = {
  id: 'gradient',
  name: '渐变',
  shortcut: 'G',
  group: 'paint',
  icon: '▤',
  cursor: 'crosshair',
  defaults: {
    type: 'linear', opacity: 100, reverse: false, dither: true,
    from: [255, 255, 255] as [number, number, number], to: [0, 0, 0] as [number, number, number],
  },
  specs: [
    {
      key: 'type',
      label: '类型',
      type: 'select',
      options: [
        { value: 'linear', label: '线性' }, { value: 'radial', label: '径向' },
        { value: 'angle', label: '角度' }, { value: 'reflected', label: '对称' }, { value: 'diamond', label: '菱形' },
      ],
    },
    { key: 'opacity', label: '不透明度', type: 'number', min: 0, max: 100, step: 1, unit: '%' },
    { key: 'reverse', label: '反向', type: 'boolean' },
    { key: 'dither', label: '抖动', type: 'boolean' },
  ],
  onDown(editor, event) {
    gradientState.start = event.doc;
    gradientState.end = event.doc;
  },
  onMove(editor, event) {
    if (!gradientState.start) return;
    gradientState.end = event.doc;
    editor.invalidate();
  },
  onUp(editor, event) {
    const start = gradientState.start;
    const end = event.doc;
    gradientState.start = null;
    gradientState.end = null;
    if (!start) return;
    if (Math.hypot(end.x - start.x, end.y - start.y) < 1) return;
    const layer = editor.activeLayer();
    if (!layer || layer.kind !== 'pixel') return;
    const snapshot = beginInteraction(editor, [layer.id]);
    const settings: GradientSettings = {
      type: editor.option<GradientSettings['type']>('type', 'linear'),
      opacity: editor.option<number>('opacity', 100) / 100,
      reverse: editor.option<boolean>('reverse', false),
      dither: editor.option<boolean>('dither', true),
      from: editor.option<[number, number, number]>('from', [255, 255, 255]),
      to: editor.option<[number, number, number]>('to', [0, 0, 0]),
    };
    layer.gradient={start:{...start},end:{...end},settings,base:cloneBuffer(layer.pixels),selection:editor.selectionSnapshot()};
    paintGradient(editor, layer, start, end, settings);
    editor.markLayerDirty(layer.id);
    endInteraction(editor, '渐变', snapshot, snapshotBytes(snapshot));
    editor.invalidate();
  },
  drawOverlay(context) {
    if (!gradientState.start || !gradientState.end) return;
    const a = context.toScreen(gradientState.start);
    const b = context.toScreen(gradientState.end);
    context.ctx.save();
    context.ctx.strokeStyle = '#38bdf8';
    context.ctx.lineWidth = 1;
    context.ctx.beginPath();
    context.ctx.moveTo(a.x, a.y);
    context.ctx.lineTo(b.x, b.y);
    context.ctx.stroke();
    context.ctx.restore();
  },
};

/** 修改已有渐变时从底图重算，不能反复把半透明渐变叠到前一次结果上。 */
export function updateGradientLayer(editor:EditorApi,id:string,patch:Partial<GradientSettings>):void {
  const layer=editor.findLayer(id);if(layer?.kind!=='pixel'||!layer.gradient)return;
  const before=beginInteraction(editor,[id]);layer.gradient.settings={...layer.gradient.settings,...patch};layer.pixels=cloneBuffer(layer.gradient.base);
  paintGradient({...editor,doc:{...editor.doc,selection:layer.gradient.selection}},layer,layer.gradient.start,layer.gradient.end,layer.gradient.settings);
  editor.markLayerDirty(id);endInteraction(editor,'修改渐变',before,snapshotBytes(before));editor.invalidate();
}
export function updateShapeLayer(editor:EditorApi,id:string,patch:Partial<import('@/types/document').ShapeMeta>):void {
  const layer=editor.findLayer(id);if(layer?.kind!=='pixel'||!layer.shape)return;
  const before=beginInteraction(editor,[id]);layer.shape={...layer.shape,...patch};layer.pixels=renderShape({x:0,y:0,width:layer.pixels.width,height:layer.pixels.height},layer.shape);
  editor.markLayerDirty(id);endInteraction(editor,'修改形状',before,snapshotBytes(before));editor.invalidate();
}

/** 把渐变画进图层像素（文档坐标先转成图层局部坐标） */
function paintGradient(
  editor: EditorApi,
  layer: import('@/types/document').PixelLayer,
  start: Point,
  end: Point,
  options: GradientSettings,
): void {
  const pixels = layer.pixels;
  if (!pixels) return;
  const origin = layer.transform.origin;
  const angle = (-layer.transform.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const scaleX = pixels.width / Math.max(1, layer.transform.size[0]);
  const scaleY = pixels.height / Math.max(1, layer.transform.size[1]);
  const toLocal = (p: Point): Point => {
    const dx = p.x - origin[0];
    const dy = p.y - origin[1];
    return { x: (dx * cos - dy * sin) * scaleX, y: (dx * sin + dy * cos) * scaleY };
  };
  const localStart = toLocal(start);
  const localEnd = toLocal(end);
  const length = Math.max(1e-6, Math.hypot(localEnd.x - localStart.x, localEnd.y - localStart.y));
  const dx = localEnd.x - localStart.x;
  const dy = localEnd.y - localStart.y;
  const selection = editor.doc.selection;
  for (let y = 0; y < pixels.height; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      const px = x - localStart.x;
      const py = y - localStart.y;
      let t: number;
      if (options.type === 'radial') t = Math.hypot(px, py) / length;
      else if (options.type === 'angle') t = (Math.atan2(py, px) + Math.PI) / (Math.PI * 2);
      else if (options.type === 'reflected') t = Math.abs(((px * dx + py * dy) / (length * length)) * 2 - 1);
      else if (options.type === 'diamond') t = (Math.abs(px) + Math.abs(py)) / length;
      else t = (px * dx + py * dy) / (length * length);
      if (options.reverse) t = 1 - t;
      if (options.dither) t += ((((x*73856093)^(y*19349663))>>>0)%1024/1024-.5)*.004;
      t = Math.max(0, Math.min(1, t));
      const color: [number, number, number] = [
        options.from[0] + (options.to[0] - options.from[0]) * t,
        options.from[1] + (options.to[1] - options.from[1]) * t,
        options.from[2] + (options.to[2] - options.from[2]) * t,
      ];
      let coverage = options.opacity;
      if (selection) {
        const doc = editor.toDoc({ x: x / scaleX, y: y / scaleY });
        const sx = Math.floor(doc.x);
        const sy = Math.floor(doc.y);
        coverage *= sx < 0 || sy < 0 || sx >= selection.width || sy >= selection.height ? 0 : selection.data[sy * selection.width + sx]! / 255;
      }
      if (coverage <= 0) continue;
      const i = (y * pixels.width + x) * 4;
      pixels.data[i] = pixels.data[i]! * (1 - coverage) + color[0] * coverage;
      pixels.data[i + 1] = pixels.data[i + 1]! * (1 - coverage) + color[1] * coverage;
      pixels.data[i + 2] = pixels.data[i + 2]! * (1 - coverage) + color[2] * coverage;
      pixels.data[i + 3] = Math.min(255, pixels.data[i + 3]! + coverage * 255);
    }
  }
  layer.contentKey += 1;
}

/* ------------------------------ 形状 ------------------------------ */

const shapeState = { start: null as Point | null, end: null as Point | null };

export const shapeTool: ToolDefinition = {
  id: 'shape',
  name: '形状',
  shortcut: 'U',
  group: 'draw',
  icon: '◱',
  cursor: 'crosshair',
  defaults: { kind: 'rectangle', fill: true, cornerRadius: 0, strokeWidth: 0 },
  specs: [
    {
      key: 'kind',
      label: '形状',
      type: 'select',
      options: [
        { value: 'rectangle', label: '矩形' },
        { value: 'roundedRectangle', label: '圆角矩形' },
        { value: 'ellipse', label: '椭圆' },
        { value: 'line', label: '直线' },
      ],
    },
    { key: 'fill', label: '填充', type: 'boolean' },
    { key: 'cornerRadius', label: '圆角', type: 'number', min: 0, max: 500, step: 1, unit: 'px' },
    { key: 'strokeWidth', label: '描边宽度', type: 'number', min: 0, max: 100, step: 1, unit: 'px' },
  ],
  onDown(editor, event) {
    shapeState.start = event.doc;
    shapeState.end = event.doc;
  },
  onMove(editor, event) {
    if (!shapeState.start) return;
    shapeState.end = event.doc;
    editor.invalidate();
  },
  onUp(editor, event) {
    const start = shapeState.start;
    const end = event.doc;
    shapeState.start = null;
    shapeState.end = null;
    if (!start) return;
    const rect = rectFromPoints(start, end);
    if (rect.width < 1 || rect.height < 1) return;
    const kind = editor.option<'rectangle' | 'roundedRectangle' | 'ellipse' | 'line'>('kind', 'rectangle');
    const shape = {
      kind,
      color: [...editor.foreground] as [number, number, number],
      cornerRadius: editor.option<number>('cornerRadius', 0),
      fillEnabled: editor.option<boolean>('fill', true),
      strokeWidth: editor.option<number>('strokeWidth', 0),
      strokeColor: [255, 255, 255] as [number, number, number],
      start: [0, 0] as [number, number],
      end: [1, 1] as [number, number],
    };
    const buffer = renderShape(rect, shape);
    const layer = createShapeLayer(kind === 'line' ? '直线' : '形状', buffer, shape);
    layer.transform.origin = [rect.x, rect.y];
    const layerId = layer.id;
    editor.doc.layers.push(layer);
    editor.doc.activeLayerId = layerId;
    editor.pushHistory(
      '绘制形状',
      () => {
        const index = editor.doc.layers.findIndex((item) => item.id === layerId);
        if (index >= 0) editor.doc.layers.splice(index, 1);
        editor.doc.activeLayerId = editor.doc.layers[editor.doc.layers.length - 1]?.id ?? null;
        editor.invalidate();
      },
      () => {
        editor.doc.layers.push(layer);
        editor.doc.activeLayerId = layerId;
        editor.invalidate();
      },
      buffer.data.length * 2,
    );
    editor.invalidate();
  },
  drawOverlay(context) {
    if (!shapeState.start || !shapeState.end) return;
    const rect = rectFromPoints(shapeState.start, shapeState.end);
    const a = context.toScreen({ x: rect.x, y: rect.y });
    const b = context.toScreen({ x: rect.x + rect.width, y: rect.y + rect.height });
    context.ctx.save();
    context.ctx.strokeStyle = '#38bdf8';
    context.ctx.setLineDash([4, 3]);
    context.ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    context.ctx.restore();
  },
};

/** 创建带形状元数据的图层 */
function createShapeLayer(name: string, buffer: import('@/types/document').PixelBuffer, shape: import('@/types/document').ShapeMeta): import('@/types/document').Layer {
  const layer = {
    id: createShapeLayerId(),
    kind: 'pixel' as const,
    name,
    isVisible: true,
    opacity: 1,
    blendMode: 'Normal' as const,
    transform: {
      origin: [0, 0] as [number, number],
      size: [buffer.width, buffer.height] as [number, number],
      rotation: 0,
      flipX: false,
      flipY: false,
      sampling: 'High quality' as const,
      warp: null,
    },
    parentId: null,
    clipping: false,
    mask: null,
    effects: null,
    expanded: true,
    locked: false,
    contentKey: 0,
    pixels: buffer,
    text: null,
    shape,
    adjustment: null,
  };
  return layer;
}

function createShapeLayerId(): string {
  return uuid();
}

/** 按形状元数据渲染像素（形状图层保持可编辑：元数据 + 像素并存） */
export function renderShape(
  rect: Rect,
  shape: import('@/types/document').ShapeMeta,
): import('@/types/document').PixelBuffer {
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.beginPath();
  if (shape.kind === 'ellipse') {
    ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  } else if (shape.kind === 'roundedRectangle') {
    const radius = Math.min(shape.cornerRadius, width / 2, height / 2);
    ctx.roundRect(0, 0, width, height, radius);
  } else if (shape.kind === 'line') {
    ctx.moveTo(0, 0);
    ctx.lineTo(width, height);
  } else {
    ctx.rect(0, 0, width, height);
  }
  if (shape.fillEnabled) {
    ctx.fillStyle = `rgb(${shape.color[0]}, ${shape.color[1]}, ${shape.color[2]})`;
    ctx.fill();
  }
  if (shape.strokeWidth > 0) {
    ctx.strokeStyle = `rgb(${shape.strokeColor[0]}, ${shape.strokeColor[1]}, ${shape.strokeColor[2]})`;
    ctx.lineWidth = shape.strokeWidth;
    ctx.stroke();
  }
  const image = ctx.getImageData(0, 0, width, height);
  return { width, height, data: image.data };
}

/* ------------------------------ 文字 ------------------------------ */

/** 文字工具的编辑状态（供画布与工具选项头共享） */
export const textToolState = reactive({ box: null as Rect | null, layerId: null as string | null, editingId: null as string | null });

export const typeTool: ToolDefinition = {
  id: 'type',
  name: '文字',
  shortcut: 'T',
  group: 'draw',
  icon: 'T',
  cursor: 'text',
  defaults: {
    content: '文字',
    fontName: 'PingFang SC',
    fontSize: 72,
    color: [0, 0, 0] as [number, number, number],
    align: 'left',
    tracking: 0,
    lineSpacing: 0,
    bold: false,
    italic: false,
  },
  specs: [
    { key: 'content', label: '内容', type: 'select', options: [] },
    { key: 'fontName', label: '字体', type: 'select', options: [] },
    { key: 'fontSize', label: '字号', type: 'number', min: 6, max: 800, step: 1, unit: 'px' },
    { key: 'color', label: '颜色', type: 'color' },
    { key: 'align', label: '对齐', type: 'select', options: [{ value: 'left', label: '左' }, { value: 'center', label: '中' }, { value: 'right', label: '右' }] },
    { key: 'tracking', label: '字距', type: 'number', min: -100, max: 500, step: 1 },
    { key: 'lineSpacing', label: '行距', type: 'number', min: 0, max: 800, step: 1, unit: 'px' },
    { key: 'bold', label: '加粗', type: 'boolean' },
    { key: 'italic', label: '倾斜', type: 'boolean' },
  ],
  activate(editor) {
    textToolState.layerId = null;
    const layer = editor.activeLayer();
    if (layer?.text) for (const [key,value] of Object.entries(layer.text)) editor.setToolOption(key,value);
    else editor.setToolOption('color', [...editor.foreground]);
  },
  deactivate() { textToolState.editingId = null; textToolState.box = null; },
  onDown(editor, event) {
    const hit = [...editor.doc.layers].reverse().find(layer => {
      if (!layer.text || !layer.isVisible || layer.locked) return false;
      const point = invertSimple(layer.transform)(event.doc);
      return point.x>=0 && point.y>=0 && point.x<=layer.transform.size[0] && point.y<=layer.transform.size[1];
    });
    if (hit?.text) {
      editor.doc.activeLayerId = hit.id;
      for (const [key,value] of Object.entries(hit.text)) editor.setToolOption(key,value);
      textToolState.editingId = hit.id;
      textToolState.box = null;
      return;
    }
    textToolState.editingId = null;
    textToolState.box = { x: event.doc.x, y: event.doc.y, width: 8, height: 8 };
  },
  onMove(editor, event) {
    if (!textToolState.box) return;
    textToolState.box = rectFromPoints({ x: textToolState.box.x, y: textToolState.box.y }, event.doc);
    editor.invalidate();
  },
  onUp(editor, event) {
    if (!textToolState.box) return;
    const box = textToolState.box;
    textToolState.box = null;
    commitText(editor, box);
  },
  onDblClick(editor) {
    // 单击已经创建或选中，双击只继续编辑，不能再添加一层。
    if (editor.activeLayer()?.text) textToolState.editingId = editor.doc.activeLayerId;
  },
  onKeyDown(editor, event) {
    if (event.key === 'Escape') {
      textToolState.box = null;
      editor.invalidate();
      return true;
    }
    if (event.key === 'Enter' && textToolState.box) {
      const box = textToolState.box;
      textToolState.box = null;
      commitText(editor, box);
      return true;
    }
    return false;
  },
  drawOverlay(context) {
    const box = textToolState.box;
    if (!box) return;
    const a = context.toScreen({ x: box.x, y: box.y });
    const b = context.toScreen({ x: box.x + box.width, y: box.y + box.height });
    context.ctx.save();
    context.ctx.strokeStyle = '#38bdf8';
    context.ctx.setLineDash([4, 3]);
    context.ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    context.ctx.restore();
  },
};

/** 创建或更新文字图层（内容取自工具选项） */
export function commitText(editor: EditorApi, box: Rect): void {
  const meta = defaultTextMeta(String(editor.option<string>('content', '文字')));
  meta.fontName = editor.option<string>('fontName', meta.fontName);
  meta.fontSize = editor.option<number>('fontSize', meta.fontSize);
  meta.color = editor.option<[number, number, number]>('color', meta.color);
  meta.align = editor.option<'left' | 'center' | 'right'>('align', 'left');
  meta.tracking = editor.option<number>('tracking', 0);
  meta.lineSpacing = editor.option<number>('lineSpacing', 0);
  meta.bold = editor.option<boolean>('bold', false);
  meta.italic = editor.option<boolean>('italic', false);
  const pointText = box.width <= 8 && box.height <= 8;
  meta.boxSize = pointText ? null : [Math.max(24, box.width), Math.max(24, box.height)];
  const buffer = meta.boxSize ? renderText(meta, meta.boxSize[0], meta.boxSize[1]) : renderText(meta);
  const layer = {
    id: crypto.randomUUID(),
    kind: 'pixel' as const,
    name: '文字',
    isVisible: true,
    opacity: 1,
    blendMode: 'Normal' as const,
    transform: {
      origin: [Math.round(box.x), Math.round(box.y)] as [number, number],
      size: [buffer.width, buffer.height] as [number, number],
      rotation: 0,
      flipX: false,
      flipY: false,
      sampling: 'High quality' as const,
      warp: null,
    },
    parentId: null,
    clipping: false,
    mask: null,
    effects: null,
    expanded: true,
    locked: false,
    contentKey: 0,
    pixels: buffer,
    text: meta,
    shape: null,
    adjustment: null,
  };
  const layerId = layer.id;
  const document = editor.doc;
  const previousActive = document.activeLayerId;
  editor.doc.layers.push(layer);
  editor.doc.activeLayerId = layerId;
  textToolState.layerId = layerId;
  textToolState.editingId = layerId;
  editor.touch();
  editor.pushHistory(
    '添加文字',
    () => {
      const index = document.layers.findIndex((item) => item.id === layerId);
      if (index >= 0) document.layers.splice(index, 1);
      document.activeLayerId = previousActive;
      editor.invalidate();
    },
    () => {
      document.layers.push(layer);
      document.activeLayerId = layerId;
      editor.invalidate();
    },
    buffer.data.length * 2,
  );
  editor.invalidate();
}

/** 修改已有文字图层（面板里改字号/颜色等） */
export function updateTextLayer(editor: EditorApi, layerId: string, patch: Partial<import('@/types/document').TextMeta>): void {
  const layer = editor.findLayer(layerId);
  if (!layer || layer.kind !== 'pixel' || !layer.text) return;
  const snapshot = beginInteraction(editor, [layerId]);
  const meta = { ...layer.text, ...patch };
  layer.text = meta;
  const box = meta.boxSize;
  layer.pixels = box ? renderText(meta, box[0], box[1]) : renderText(meta);
  layer.transform.size = [layer.pixels.width, layer.pixels.height];
  layer.contentKey += 1;
  editor.markLayerDirty(layerId);
  // 参数栏与画布文字框都会进入此路径，必须提示保存此次编辑。
  editor.touch();
  endInteraction(editor, '修改文字', snapshot, snapshotBytes(snapshot));
  editor.invalidate();
}

/* ------------------------------ 吸管 ------------------------------ */

export const eyedropperTool: ToolDefinition = {
  id: 'eyedropper',
  name: '吸管',
  shortcut: 'I',
  group: 'sample',
  icon: '⌾',
  cursor: 'crosshair',
  defaults: { sample: 'composite', size: 1 },
  specs: [
    { key: 'sample', label: '取样', type: 'select', options: [{ value: 'composite', label: '所有图层' }, { value: 'layer', label: '当前图层' }] },
    { key: 'size', label: '取样大小', type: 'number', min: 1, max: 51, step: 2, unit: 'px' },
  ],
  onDown(editor, event) {
    pickColor(editor, event.doc);
  },
  onMove(editor, event) {
    pickColor(editor, event.doc);
  },
  onKeyDown(editor, event) {
    if (event.key === 'x') {
      const temp = editor.foreground;
      editor.setForeground(editor.background);
      editor.setBackground(temp);
      return true;
    }
    if (event.key === 'd') {
      editor.setForeground([0, 0, 0]);
      editor.setBackground([255, 255, 255]);
      return true;
    }
    return false;
  },
};

/** 取色（可带取样范围） */
function pickColor(editor: EditorApi, point: Point): void {
  const size = Math.max(1, Math.round(editor.option<number>('size', 1)));
  const half = Math.floor(size / 2);
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const layer=editor.activeLayer();
  const composite=editor.option<string>('sample','composite')==='composite'||!layer?editor.composite():compositeDocument({...editor.doc,layers:[{...layer,parentId:null,clipping:false}]},editor.doc.width,editor.doc.height,{scale:1}).buffer;
  for(let dy=-half;dy<=half;dy++)for(let dx=-half;dx<=half;dx++){const x=Math.floor(point.x)+dx,y=Math.floor(point.y)+dy;if(x<0||y<0||x>=composite.width||y>=composite.height)continue;const i=(y*composite.width+x)*4;r+=composite.data[i]!;g+=composite.data[i+1]!;b+=composite.data[i+2]!;count++;}
  if (count === 0) return;
  const color: [number, number, number] = [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
  editor.setForeground(color);
  editor.status(`前景色 rgb(${color.join(', ')})`);
}

/* ------------------------------ 手形 / 缩放 ------------------------------ */

const panState = { active: false, start: { x: 0, y: 0 }, center: { x: 0, y: 0 } };

export const handTool: ToolDefinition = {
  id: 'hand',
  name: '抓手',
  shortcut: 'H',
  group: 'view',
  icon: '✋',
  cursor: 'grab',
  defaults: {},
  specs: [],
  onDown(editor, event) {
    panState.active = true;
    panState.start = event.screen;
    panState.center = { x: editor.viewport.centerX, y: editor.viewport.centerY };
  },
  onMove(editor, event) {
    if (!panState.active) return;
    const zoom = editor.viewport.zoom;
    editor.setViewport({
      centerX: panState.center.x - (event.screen.x - panState.start.x) / zoom,
      centerY: panState.center.y - (event.screen.y - panState.start.y) / zoom,
    });
  },
  onUp() {
    panState.active = false;
  },
};

export const zoomTool: ToolDefinition = {
  id: 'zoom',
  name: '缩放',
  shortcut: 'Z',
  group: 'view',
  icon: '🔍',
  cursor: 'zoom-in',
  defaults: {},
  specs: [],
  onDown(editor, event) {
    const factor = event.alt ? 1 / 1.5 : 1.5;
    editor.setViewport({ zoom: Math.max(0.0033, Math.min(32, editor.viewport.zoom * factor)) });
  },
};

/** 以某点为中心缩放（⌘ + 滚轮 / 缩放工具使用） */
export function zoomAt(editor: EditorApi, factor: number): void {
  editor.setViewport({ zoom: Math.max(0.0033, Math.min(32, editor.viewport.zoom * factor)) });
}
