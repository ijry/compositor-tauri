/**
 * 工具公共辅助
 * ---------------------------------------------------------------
 * 统一处理：交互快照、矩形/路径取反、选区提交、覆盖层绘制样式。
 */
import { normalizeRect } from '@/core/geometry';
import { createSelection } from '@/core/selection';
import { combineSelection } from '@/core/selection';
import type { EditorApi, LayerSnapshot } from '@/types/editor';
import type { Point, Rect, SelectionMask } from '@/types/document';

/** 交互期快照 */
export interface InteractionSnapshot {
  layers: Map<string, LayerSnapshot>;
  selection: SelectionMask | null;
}

/** 开始交互：记录图层与选区快照 */
export function beginInteraction(editor: EditorApi, layerIds: string[]): InteractionSnapshot {
  const layers = new Map<string, LayerSnapshot>();
  for (const id of layerIds) {
    const snapshot = editor.snapshotLayer(id);
    if (snapshot) layers.set(id, snapshot);
  }
  return { layers, selection: editor.selectionSnapshot() };
}

/** 结束交互：把快照提交为一条历史记录 */
export function endInteraction(editor: EditorApi, label: string, snapshot: InteractionSnapshot, bytes: number): void {
  const after = new Map<string, LayerSnapshot>();
  for (const id of snapshot.layers.keys()) {
    const current = editor.snapshotLayer(id);
    if (current) after.set(id, current);
  }
  const afterSelection = editor.selectionSnapshot();
  editor.pushHistory(
    label,
    () => {
      for (const [id, value] of snapshot.layers) editor.restoreLayer(id, value);
      editor.restoreSelection(snapshot.selection);
      editor.invalidate();
    },
    () => {
      for (const [id, value] of after) editor.restoreLayer(id, value);
      editor.restoreSelection(afterSelection);
      editor.invalidate();
    },
    bytes,
  );
}

/** 估算快照字节数 */
export function snapshotBytes(snapshot: InteractionSnapshot): number {
  let bytes = snapshot.selection ? snapshot.selection.data.length : 0;
  for (const value of snapshot.layers.values()) {
    if (value.pixels) bytes += value.pixels.data.byteLength;
    if (value.mask) bytes += value.mask.data.byteLength;
  }
  return bytes;
}

/** 由两个点得到矩形（已归一化） */
export function rectFromPoints(start: Point, end: Point): Rect {
  return normalizeRect({ x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y });
}

/** 选区提交（带布尔模式） */
export function commitSelection(editor: EditorApi, selection: SelectionMask, mode: 'replace' | 'add' | 'subtract' | 'intersect', label = '建立选区'): void {
  const before = editor.selectionSnapshot();
  const current = editor.doc.selection;
  editor.setSelection(combineSelection(current, selection, mode), 'replace');
  const after = editor.selectionSnapshot();
  editor.pushHistory(
    label,
    () => {
      editor.restoreSelection(before);
      editor.invalidate();
    },
    () => {
      editor.restoreSelection(after);
      editor.invalidate();
    },
    selection.data.length * 2,
  );
}

/** 创建覆盖整个文档的选区 */
export function fullSelection(editor: EditorApi): SelectionMask {
  return createSelection(editor.doc.width, editor.doc.height, 255);
}

/** 蚂蚁线绘制（虚线走线动画） */
export function drawAnts(ctx: CanvasRenderingContext2D, segments: Point[][], phase: number): void {
  if (segments.length === 0) return;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.lineDashOffset = -phase;
  ctx.beginPath();
  for (const [start, end] of segments) {
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
  }
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.lineDashOffset = -phase + 4;
  ctx.strokeStyle = '#000000';
  ctx.stroke();
  ctx.restore();
}

/** 画八个控制手柄 */
export function drawHandles(ctx: CanvasRenderingContext2D, rect: Rect, size = 5): void {
  const handles = handlePositions(rect);
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 1;
  for (const point of handles) {
    ctx.beginPath();
    ctx.rect(point.x - size / 2, point.y - size / 2, size, size);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** 九宫格控制点位置 */
export function handlePositions(rect: Rect): Point[] {
  const { x, y, width, height } = rect;
  return [
    { x, y },
    { x: x + width / 2, y },
    { x: x + width, y },
    { x: x + width, y: y + height / 2 },
    { x: x + width, y: y + height },
    { x: x + width / 2, y: y + height },
    { x, y: y + height },
    { x, y: y + height / 2 },
  ];
}

/** 命中哪个控制点（返回 0-7，未命中返回 -1） */
export function hitHandle(rect: Rect, point: Point, tolerance = 6): number {
  const handles = handlePositions(rect);
  for (let i = 0; i < handles.length; i += 1) {
    if (Math.abs(handles[i]!.x - point.x) <= tolerance && Math.abs(handles[i]!.y - point.y) <= tolerance) return i;
  }
  return -1;
}

/** 命中矩形内部 */
export function hitRect(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}
