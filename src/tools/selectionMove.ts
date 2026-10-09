import { cloneBuffer, cloneMask } from '@/core/pixels';
import { compositePixel } from '@/core/blend';
import { makeLayerMapping } from '@/core/engine/paint';
import type { EditorApi, LayerSnapshot } from '@/types/editor';
import type { Point, SelectionMask } from '@/types/document';

/** 选区轮廓/选中像素的拖动事务，整个手势只生成一个可回放历史。 */
let moving: { id:string; before:LayerSnapshot|null; selection:SelectionMask; start:Point; duplicate:boolean; outline:boolean } | null=null;
export function beginSelectionMove(editor:EditorApi,start:Point,duplicate=false,outline=false):boolean {
 const layer=editor.activeLayer(),selection=editor.selectionSnapshot();
 if(!selection||!selection.data.some(v=>v>0)||(!outline&&(!layer?.pixels||layer.locked||layer.mask?.target==='mask')))return false;
 const x=Math.floor(start.x),y=Math.floor(start.y);
 if(x<0||y<0||x>=selection.width||y>=selection.height||selection.data[y*selection.width+x]===0)return false;
 moving={id:layer?.id??'',before:layer?editor.snapshotLayer(layer.id):null,selection,start,duplicate,outline};return true;
}
export function updateSelectionMove(editor:EditorApi,point:Point):boolean {
 if(!moving)return false;
 const {selection,before,id,start,outline,duplicate}=moving,dx=Math.round(point.x-start.x),dy=Math.round(point.y-start.y);
 const next={...selection,data:new Uint8Array(selection.data.length),outline:null};
 for(let y=0;y<selection.height;y++)for(let x=0;x<selection.width;x++) {const sx=x-dx,sy=y-dy;if(sx>=0&&sy>=0&&sx<selection.width&&sy<selection.height)next.data[y*selection.width+x]=selection.data[sy*selection.width+sx]!;}
 if(!outline&&before?.pixels){
  const layer=editor.findLayer(id);if(!layer?.pixels)return false;
  const source=before.pixels,output=cloneBuffer(source),mapping=makeLayerMapping(layer);
  const coverage=(p:Point)=>{const x=Math.floor(p.x),y=Math.floor(p.y);return x>=0&&y>=0&&x<selection.width&&y<selection.height?selection.data[y*selection.width+x]!/255:0;};
  for(let y=0;y<output.height;y++)for(let x=0;x<output.width;x++) {
   const di=(y*output.width+x)*4,p=mapping.toDoc({x:x+.5,y:y+.5});
   if(!duplicate)output.data[di+3]=source.data[di+3]!*(1-coverage(p));
  }
  for(let y=0;y<output.height;y++)for(let x=0;x<output.width;x++) {
   const di=(y*output.width+x)*4,p=mapping.toDoc({x:x+.5,y:y+.5}),from={x:p.x-dx,y:p.y-dy},local=mapping.toLocal(from),sx=Math.floor(local.x),sy=Math.floor(local.y),k=coverage(from);
   if(k>0&&sx>=0&&sy>=0&&sx<source.width&&sy<source.height)compositePixel(output.data,di,source.data,(sy*source.width+sx)*4,k);
  }
  layer.pixels=output;editor.markLayerDirty(id);
 }
 editor.setSelection(next);return true;
}
export function endSelectionMove(editor:EditorApi,cancel=false):boolean {
 const state=moving;if(!state)return false;moving=null;
 const after=state.before?editor.snapshotLayer(state.id):null,next=editor.selectionSnapshot();
 const apply=(snapshot:LayerSnapshot|null,selection:SelectionMask|null)=>{if(snapshot)editor.restoreLayer(state.id,snapshot);editor.restoreSelection(selection);editor.invalidate();};
 if(cancel){apply(state.before,state.selection);return true;}
 editor.pushHistory(state.outline?'移动选区轮廓':state.duplicate?'复制选区像素':'移动选区像素',()=>apply(state.before,state.selection),()=>apply(after,next),(state.before?.pixels?.data.length??0)*2+state.selection.data.length*2);return true;
}
export function nudgeSelectionPixels(editor:EditorApi,dx:number,dy:number):boolean {
 const selection=editor.doc.selection;if(!selection)return false;
 const index=selection.data.findIndex(v=>v>0);if(index<0)return false;
 const p={x:index%selection.width+.5,y:Math.floor(index/selection.width)+.5};
 if(!beginSelectionMove(editor,p))return false;updateSelectionMove(editor,{x:p.x+dx,y:p.y+dy});endSelectionMove(editor);return true;
}
