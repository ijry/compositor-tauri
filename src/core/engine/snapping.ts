/**
 * 吸附
 * ---------------------------------------------------------------
 * Snap To 支持参考线、网格、图层边缘与中心、文档边界，
 * 命中最近的吸附目标并返回修正后的坐标（带阈值，随缩放换算成屏幕像素）。
 */
import { applyMatrix, layerMatrix } from '@/core/geometry';
import type { EditorApi } from '@/types/editor';
import type { Point } from '@/types/document';

/** 吸附结果 */
export interface SnapResult {
  point: Point;
  /** 命中的参考线（用于绘制提示线） */
  guide: { axis: 'horizontal' | 'vertical'; position: number } | null;
}

/**
 * 对一个点做吸附。
 * @param excludeIds 需要排除的图层（例如正在拖动的图层自身）
 */
export function snapPoint(editor: EditorApi, point: Point, excludeIds: string[] = []): SnapResult {
  const { doc, viewport } = editor;
  const threshold = 6 / Math.max(0.05, viewport.zoom);
  const snap = doc.snap;
  const candidatesX: { value: number; guide: SnapResult['guide'] }[] = [];
  const candidatesY: { value: number; guide: SnapResult['guide'] }[] = [];

  if (snap.document) {
    candidatesX.push({ value: doc.width / 2, guide: null });
    candidatesY.push({ value: doc.height / 2, guide: null });
    candidatesX.push({ value: 0, guide: null });
    candidatesX.push({ value: doc.width, guide: null });
    candidatesY.push({ value: 0, guide: null });
    candidatesY.push({ value: doc.height, guide: null });
  }
  if (snap.guides) {
    for (const guide of doc.guides) {
      if (guide.axis === 'vertical') candidatesX.push({ value: guide.position, guide });
      else candidatesY.push({ value: guide.position, guide });
    }
  }
  if (snap.grid && doc.grid.enabled) {
    const spacing = Math.max(1, doc.grid.spacing);
    candidatesX.push({ value: Math.round(point.x / spacing) * spacing, guide: null });
    candidatesY.push({ value: Math.round(point.y / spacing) * spacing, guide: null });
  }
  if (snap.layers) {
    for (const layer of doc.layers) {
      if (excludeIds.includes(layer.id) || !layer.isVisible) continue;
      const matrix = layer.kind === 'pixel' && layer.pixels
        ? layerMatrix(layer.transform, layer.pixels.width, layer.pixels.height)
        : null;
      if (!matrix) continue;
      const width = layer.transform.size[0];
      const height = layer.transform.size[1];
      const corners = [applyMatrix(matrix, 0, 0), applyMatrix(matrix, width, 0), applyMatrix(matrix, width, height), applyMatrix(matrix, 0, height)];
      const center = applyMatrix(matrix, width / 2, height / 2);
      for (const corner of corners) {
        candidatesX.push({ value: corner.x, guide: null });
        candidatesY.push({ value: corner.y, guide: null });
      }
      candidatesX.push({ value: center.x, guide: null });
      candidatesY.push({ value: center.y, guide: null });
    }
  }

  let bestX: { value: number; distance: number; guide: SnapResult['guide'] } | null = null;
  for (const candidate of candidatesX) {
    const distance = Math.abs(candidate.value - point.x);
    if (distance <= threshold && (!bestX || distance < bestX.distance)) {
      bestX = { value: candidate.value, distance, guide: candidate.guide };
    }
  }
  let bestY: { value: number; distance: number; guide: SnapResult['guide'] } | null = null;
  for (const candidate of candidatesY) {
    const distance = Math.abs(candidate.value - point.y);
    if (distance <= threshold && (!bestY || distance < bestY.distance)) {
      bestY = { value: candidate.value, distance, guide: candidate.guide };
    }
  }
  return {
    point: { x: bestX ? bestX.value : point.x, y: bestY ? bestY.value : point.y },
    guide: bestX?.guide ?? bestY?.guide ?? null,
  };
}
