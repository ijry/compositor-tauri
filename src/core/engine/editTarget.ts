/** 图像/蒙版编辑的统一入口，所有选区均从目标网格映射到文档坐标。 */
import { applyMatrix, layerMatrix, type Matrix } from '@/core/geometry';
import { maskToDocument } from './maskGeometry';
import { compositePixel } from '@/core/blend';
import type { CompDocument, Layer, MaskBuffer, PixelBuffer } from '@/types/document';

export type EditTarget = {layer:Layer;matrix:Matrix} & (
  {onMask:true;buffer:MaskBuffer} | {onMask:false;buffer:PixelBuffer}
);
export function resolveEditTarget(layer: Layer | null, preference: 'auto'|'pixels'|'mask' = 'auto'): EditTarget | null {
  if (!layer || layer.locked) return null;
  const mask = preference==='mask' || (preference==='auto' && layer.mask?.target==='mask');
  if (mask) return layer.mask?.enabled ? {layer,onMask:true,buffer:layer.mask.pixels,matrix:maskToDocument(layer)} : null;
  if (layer.kind!=='pixel' || !layer.pixels) return null;
  return {layer,onMask:false,buffer:layer.pixels,matrix:layerMatrix(layer.transform,layer.pixels.width,layer.pixels.height)};
}
export function editSelectionCoverage(document: CompDocument, target: EditTarget, x:number, y:number): number {
  if (!document.selection) return 1;
  const p = applyMatrix(target.matrix,x+0.5,y+0.5), px=Math.floor(p.x), py=Math.floor(p.y);
  const selection=document.selection;
  return px<0 || py<0 || px>=selection.width || py>=selection.height ? 0 : selection.data[py*selection.width+px]/255;
}
/** 图像采用 source-over；蒙版采用灰度插值。clear 只降低图像 alpha。 */
export function fillEditTarget(document: CompDocument, target: EditTarget, color:[number,number,number], clear=false): boolean {
  const {buffer}=target;let changed=false;
  const rgba:[number,number,number,number]=[...color,255];
  const gray=0.299*color[0]+0.587*color[1]+0.114*color[2];
  for(let y=0;y<buffer.height;y++)for(let x=0;x<buffer.width;x++) {
    const coverage=editSelectionCoverage(document,target,x,y);
    if(coverage<=0)continue;
    changed=true;
    if(target.onMask) {
      const i=y*buffer.width+x,value=target.layer.mask?.inverted?255-gray:gray;
      target.buffer.data[i]=Math.round(target.buffer.data[i]*(1-coverage)+value*coverage);
    } else {
      const i=(y*buffer.width+x)*4;
      if(clear)target.buffer.data[i+3]=target.buffer.data[i+3]*(1-coverage);
      else compositePixel(target.buffer.data,i,rgba,0,coverage);
    }
  }
  return changed;
}
