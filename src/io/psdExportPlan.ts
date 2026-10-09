/** PSD导出策略：调整层依赖整个下方合成，不允许把它当作独立空像素层写入。 */
import { documentDepth } from '@/core/pixelFormat';
import type { BitDepth, CompDocument } from '@/types/document';

export interface PsdExportOptions {
  /** 调用方已明确接受丢失可编辑图层结构，只导出当前可见合成。默认拒绝隐式降级。 */
  rasterizeAdjustments?: boolean;
}
export interface PsdExportPlan {
  mode: 'layers' | 'visible-composite';
  bitDepth: BitDepth;
  adjustmentCount: number;
  sourceLayerCount: number;
  warning: string | null;
}

export function planPsdExport(document: CompDocument): PsdExportPlan {
  // 隐藏调整层也不能伪装成“已保存的可编辑调整层”，因此同样需要说明结构丢失。
  const adjustmentCount = document.layers.filter(layer => layer.kind === 'adjustment').length;
  const bitDepth = documentDepth(document);
  return {
    mode: adjustmentCount ? 'visible-composite' : 'layers',
    bitDepth,
    adjustmentCount,
    sourceLayerCount: document.layers.length,
    warning: adjustmentCount
      ? `工程「${document.name}」含 ${adjustmentCount} 个调整层。当前 PSD 导出不能无损保存这些调整层的可编辑结构。\n\n继续将完整的当前可见效果合并为一张 ${bitDepth} 位像素层。调整层、组、蒙版和隐藏图层不会作为可编辑图层保留在此 PSD 中，画布外内容也不在合并结果内。原工程不会修改，建议先保存 .comp 工程。\n\n是否继续导出合并结果？`
      : null,
  };
}
