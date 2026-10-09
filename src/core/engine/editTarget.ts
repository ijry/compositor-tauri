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
/** 在文档选区中查询目标网格的一点；蒙版生成也使用同一坐标规则。 */
export function selectionCoverageAt(selection:{width:number;height:number;data:Uint8Array}|null,matrix:Matrix,x:number,y:number):number {
  if(!selection)return 1;
  const point=applyMatrix(matrix,x+0.5,y+0.5),px=Math.floor(point.x),py=Math.floor(point.y);
  return px<0 || py<0 || px>=selection.width || py>=selection.height?0:selection.data[py*selection.width+px]/255;
}
export function editSelectionCoverage(document:CompDocument,target:EditTarget,x:number,y:number):number {
  return selectionCoverageAt(document.selection,target.matrix,x,y);
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
      const next=target.buffer.data[i]*(1-coverage)+value*coverage;
      target.buffer.data[i]=target.buffer.data instanceof Float32Array?next:Math.round(next);
    } else {
      const i=(y*buffer.width+x)*4;
      if(clear)target.buffer.data[i+3]=target.buffer.data[i+3]*(1-coverage);
      else compositePixel(target.buffer.data,i,rgba,0,coverage);
    }
  }
  return changed;
}

/** 空选区返回全零覆盖率而不是 null；null 只表示没有选区限制。 */
export function projectEditSelection(document: CompDocument, target: EditTarget): Uint8Array | null {
  if(!document.selection)return null;
  const {width,height}=target.buffer,coverage=new Uint8Array(width*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)coverage[y*width+x]=Math.round(editSelectionCoverage(document,target,x,y)*255);
  return coverage;
}
/** 将滤镜的完整结果按目标网格覆盖率混合，只混合一次，避免羽化边缘重复衰减。 */
export function blendFilterResult(target: Extract<EditTarget,{onMask:false}>, result: PixelBuffer, coverage: Uint8Array | null): boolean {
  const {buffer}=target;
  if(result.width!==buffer.width || result.height!==buffer.height)throw new Error('滤镜输出尺寸与目标图层不一致');
  let changed=false;
  for(let p=0;p<buffer.width*buffer.height;p++) {
    const k=coverage?coverage[p]/255:1;if(k<=0)continue;
    const i=p*4,ab=buffer.data[i+3]/255,af=result.data[i+3]/255,alpha=ab*(1-k)+af*k;
    for(let c=0;c<4;c++) {
      const before=buffer.data[i+c];
      buffer.data[i+c]=k>=1?result.data[i+c]:c===3?alpha*255:alpha>0?(before*ab*(1-k)+result.data[i+c]*af*k)/alpha:0;
      if(buffer.data[i+c]!==before)changed=true;
    }
  }
  return changed;
}
/** 图像与蒙版共享反相路径：保留图像 alpha，按实际选区覆盖率改变颜色或灰度。 */
export function invertEditTarget(document: CompDocument, target: EditTarget): boolean {
  const {buffer}=target,stride=target.onMask?1:4,channels=target.onMask?1:3;let changed=false;
  for(let y=0;y<buffer.height;y++)for(let x=0;x<buffer.width;x++) {
    const k=editSelectionCoverage(document,target,x,y);if(k<=0)continue;
    for(let c=0;c<channels;c++) {
      const i=(y*buffer.width+x)*stride+c,before=buffer.data[i];
      const value=before*(1-k)+(255-before)*k;
      buffer.data[i]=buffer.data instanceof Float32Array?value:Math.round(value);
      if(buffer.data[i]!==before)changed=true;
    }
  }
  return changed;
}
