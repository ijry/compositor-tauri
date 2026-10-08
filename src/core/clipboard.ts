/** 内部剪贴板快照：像素与图层两种载荷互斥，每次粘贴均重新分配缓冲。 */
import { createPixelLayer, descendantsOf, duplicateLayer } from '@/core/document';
import { cloneBuffer, createBuffer, maskToBuffer } from '@/core/pixels';
import { compositeDocument } from '@/core/engine/compositor';
import { placementTransform } from '@/core/engine/maskGeometry';
import type { CompDocument, Layer, PixelBuffer, Rect } from '@/types/document';

export type ClipboardPayload =
  | {kind:'pixels';pixels:PixelBuffer;origin:[number,number]}
  | {kind:'layers';layers:Layer[];active:string};

function selectedRegion(document: CompDocument): Rect | null {
  const s=document.selection;
  if(!s)return{x:0,y:0,width:document.width,height:document.height};
  let left=document.width,top=document.height,right=-1,bottom=-1;
  for(let y=0;y<Math.min(s.height,document.height);y++)for(let x=0;x<Math.min(s.width,document.width);x++) {
    if(s.data[y*s.width+x]===0)continue;
    left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
  }
  return right<left || bottom<top ? null : {x:left,y:top,width:right-left+1,height:bottom-top+1};
}
function pixelsInSelection(document:CompDocument,source:PixelBuffer): ClipboardPayload | null {
  const region=selectedRegion(document);if(!region)return null;
  const pixels=createBuffer(region.width,region.height),s=document.selection;
  for(let y=0;y<region.height;y++)for(let x=0;x<region.width;x++) {
    const dx=x+region.x,dy=y+region.y,si=(dy*source.width+dx)*4,di=(y*region.width+x)*4;
    pixels.data.set(source.data.subarray(si,si+4),di);
    if(s)pixels.data[di+3]=Math.round(pixels.data[di+3]*s.data[dy*s.width+dx]/255);
  }
  return {kind:'pixels',pixels,origin:[region.x,region.y]};
}
export function captureClipboard(document:CompDocument,layer:Layer|null,merged=false): ClipboardPayload | null {
  if(!selectedRegion(document))return null;
  if(merged) return pixelsInSelection(document,compositeDocument(document,document.width,document.height,{scale:1,limitAdjustmentsBySelection:false}).buffer);
  if(!layer)return null;
  const onMask=layer.mask?.target==='mask';
  if(!document.selection && !onMask) {
    const ids=new Set([layer.id,...descendantsOf(document,layer.id).map(child=>child.id)]);
    const layers=document.layers.filter(item=>ids.has(item.id)).map(item=>{
      const copy=duplicateLayer(item,'');copy.id=item.id;
      if(copy.parentId && !ids.has(copy.parentId))copy.parentId=null;
      return copy;
    });
    return {kind:'layers',layers,active:layer.id};
  }
  let image:Layer;
  if(onMask) {
    if(!layer.mask?.enabled)return null;
    const pixels=maskToBuffer(layer.mask.pixels);
    if(layer.mask.inverted)for(let i=0;i<pixels.data.length;i+=4)for(let c=0;c<3;c++)pixels.data[i+c]=255-pixels.data[i+c];
    image=createPixelLayer('蒙版像素',pixels);
    image.transform=!layer.mask.linked&&layer.mask.placement?placementTransform(layer.mask.placement):{...layer.transform};
  } else {
    if(layer.kind!=='pixel')return null;
    // 普通选区复制读取原图像，不包含遮挡层、图层效果或外观不透明度。
    image={...layer,parentId:null,isVisible:true,opacity:1,blendMode:'Normal',mask:null,effects:null,clipping:false};
  }
  return pixelsInSelection(document,compositeDocument({...document,layers:[image],selection:null},document.width,document.height,{scale:1}).buffer);
}
export function pasteClipboard(document:CompDocument,payload:ClipboardPayload): void {
  const active=document.layers.find(layer=>layer.id===document.activeLayerId);
  const parent=active?.parentId??null;
  let layers:Layer[],selected:string;
  if(payload.kind==='pixels') {
    const layer=createPixelLayer('粘贴的像素',cloneBuffer(payload.pixels));
    layer.transform.origin=[...payload.origin];layer.parentId=parent;
    layers=[layer];selected=layer.id;
  } else {
    layers=payload.layers.map(layer=>duplicateLayer(layer,''));
    const mapping=new Map(payload.layers.map((layer,i)=>[layer.id,layers[i]!.id]));
    for(const layer of layers)layer.parentId=layer.parentId?mapping.get(layer.parentId)??parent:parent;
    selected=mapping.get(payload.active)??layers.at(-1)!.id;
  }
  const index=active?document.layers.indexOf(active)+1:document.layers.length;
  document.layers.splice(index,0,...layers);document.activeLayerId=selected;document.updatedAt=Date.now();
}
