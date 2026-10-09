import { userErrorMessage } from '@/core/userMessage';
/** PSD导入预算：先读取压缩通道视图，完成整份文档规划后才允许分配任何像素。 */
import { readPsd, getCompositeImageData, type Layer, type LayerMaskData, type Psd } from 'ag-psd';
import { recommendedBudget } from '@/core/engine/history';
import { decodePsdChannel, PSD_DECODE_WORKSPACE_BYTES } from './psdChannel';
import type { Rect } from '@/types/document';

export interface PsdImportOptions { memoryBudgetBytes?: number }
export interface PsdMemoryReport {
  mode:'full'|'canvas';
  budgetBytes:number;
  sourceBytes:number;
  estimatedPeakBytes:number;
  uncroppedPeakBytes:number;
  retainedPixelBytes:number;
  workspaceBytes:number;
  croppedLayers:number;
  croppedMasks:number;
  skippedLayers:number;
}
interface PlannedSurface { bounds:Rect; region:Rect; imageBytes:number; channel:number|null }
interface LayerPlan { layer:Layer; image:PlannedSurface|null; mask:PlannedSurface|null; maskBounds:Rect|null }
function bounds(value:{left?:number;top?:number;right?:number;bottom?:number}):Rect {
  const x=value.left??0,y=value.top??0,width=(value.right??x)-x,height=(value.bottom??y)-y;
  if(![x,y,width,height].every(Number.isSafeInteger)||width<0||height<0||width>300000||height>300000)throw new Error('PSD图层或蒙版范围无效');
  return{x,y,width,height};
}
function cropToCanvas(rect:Rect,canvas:Rect):Rect {
  const x=Math.max(rect.x,canvas.x),y=Math.max(rect.y,canvas.y),right=Math.min(rect.x+rect.width,canvas.width),bottom=Math.min(rect.y+rect.height,canvas.height);
  return{x,y,width:Math.max(0,right-x),height:Math.max(0,bottom-y)};
}
function planSurface(rect:Rect,canvas:Rect,crop:boolean,channel:number|null,bytesPerPixel=4):PlannedSurface {
  const area=crop?cropToCanvas(rect,canvas):rect;
  return{bounds:area,region:{x:Math.max(0,area.x-rect.x),y:Math.max(0,area.y-rect.y),width:area.width,height:area.height},imageBytes:area.width*area.height*bytesPerPixel,channel};
}

export function readPsdWithinBudget(data:ArrayBuffer,options:PsdImportOptions={}):{psd:Psd;memory:PsdMemoryReport} {
  const budget=options.memoryBudgetBytes??recommendedBudget();
  if(!Number.isSafeInteger(budget)||budget<=0)throw new Error('PSD内存预算无效');
  if(data.byteLength+PSD_DECODE_WORKSPACE_BYTES>budget)throw new Error('PSD文件与解码暂存超出内存预算');
  if(data.byteLength<26)throw new Error('PSD文件头不完整');
  const header=new DataView(data),bitDepth=header.getUint16(22),mode=header.getUint16(24);
  if(bitDepth!==8&&bitDepth!==16)throw new Error('当前PSD编辑器仅支持8位或16位文档，不支持32位HDR');
  if(mode!==3&&mode!==1)throw new Error('当前PSD编辑器仅支持RGB或灰度文档，不支持此颜色模式');
  const width=header.getUint32(18),height=header.getUint32(14);
  if(!width||!height||width*height>100_000_000)throw new Error('PSD画布尺寸超出安全范围');
  // strict阻止依赖修补截断通道时分配原始尺寸的零缓冲；linked/thumbnail不参与像素编辑。
  let psd:Psd;
  try{psd=readPsd(data,{useRawData:true,useImageData:true,skipCompositeImageData:true,skipThumbnail:true,skipLinkedFilesData:true,strict:true,totalMemoryLimit:budget-data.byteLength});}catch(error){throw new Error(userErrorMessage(error));}
  const layers:Layer[]=[];
  function visit(nodes:Layer[],depth=0):void {
    if(depth>64)throw new Error('PSD图层嵌套过深');
    for(const layer of nodes){layers.push(layer);if(layers.length>10000)throw new Error('PSD图层数量超限');if(layer.children)visit(layer.children,depth+1);}
  }
  visit(psd.children??[]);
  const canvas={x:0,y:0,width:psd.width,height:psd.height};
  const workspace=PSD_DECODE_WORKSPACE_BYTES+layers.length*2048+psd.width*psd.height*(bitDepth===16?32:8);
  const makePlan=(crop:boolean):LayerPlan[]=>layers.map(layer=>{
    const rect=bounds(layer),raw=layer.rawData;
    const hasImage=!layer.children&&rect.width>0&&rect.height>0&&!!raw?.channels.some(c=>c.id>=0&&c.data?.length);
    let maskBounds:Rect|null=null;
    if(layer.mask){maskBounds=bounds(layer.mask);if(layer.mask.positionRelativeToLayer){maskBounds.x+=rect.x;maskBounds.y+=rect.y;}}
    return{layer,image:hasImage?planSurface(rect,canvas,crop,null,bitDepth===16?16:4):null,maskBounds,mask:maskBounds&&maskBounds.width>0&&maskBounds.height>0?planSurface(maskBounds,canvas,crop,-2,bitDepth===16?16:4):null};
  });
  const peak=(plans:LayerPlan[])=>data.byteLength+workspace+plans.reduce((sum,p)=>sum+(p.image?.imageBytes??0)+(p.mask?.imageBytes??0)*1.25,0);
  const full=makePlan(false),uncropped=peak(full);let plans=full,modeName:'full'|'canvas'='full';
  if(uncropped>budget){plans=makePlan(true);modeName='canvas';}
  const estimated=peak(plans);
  if(estimated>budget)throw new Error('PSD图层裁剪到画布后仍超出内存预算，请减少图层或画布大小');
  const memory:PsdMemoryReport={mode:modeName,budgetBytes:budget,sourceBytes:data.byteLength,estimatedPeakBytes:estimated,uncroppedPeakBytes:uncropped,retainedPixelBytes:estimated-data.byteLength-workspace,workspaceBytes:workspace,croppedLayers:0,croppedMasks:0,skippedLayers:0};
  for(const plan of plans) {
    const {layer,image,mask,maskBounds}=plan,original=bounds(layer),raw=layer.rawData;
    if(image){
      if(!image.bounds.width||!image.bounds.height){layer.imageData=undefined;layer.right=layer.left;layer.bottom=layer.top;memory.skippedLayers++;}
      else {
        const pixels=bitDepth===16?new Float32Array(image.imageBytes/4):new Uint8ClampedArray(image.imageBytes);
        for(let i=3;i<pixels.length;i+=4)pixels[i]=255;
        for(const c of raw!.channels){
          const offset=c.id===-1?3:c.id>=0&&c.id<(mode===1?1:3)?c.id:-1;
          if(offset<0||offset>3||!c.data)continue;
          decodePsdChannel({width:original.width,height:original.height,bitDepth,compression:c.compression,large:raw!.large,data:c.data},{region:image.region,data:pixels,stride:4,channel:offset,sampleScale:bitDepth===16?1/257:1});
        }
        if(mode===1)for(let i=0;i<pixels.length;i+=4)pixels[i+1]=pixels[i+2]=pixels[i]!;
        layer.imageData={width:image.bounds.width,height:image.bounds.height,data:pixels};
        if(image.region.x||image.region.y||image.bounds.width!==original.width||image.bounds.height!==original.height)memory.croppedLayers++;
        Object.assign(layer,{left:image.bounds.x,top:image.bounds.y,right:image.bounds.x+image.bounds.width,bottom:image.bounds.y+image.bounds.height});
      }
    }
    if(mask&&maskBounds&&layer.mask){
      const target=layer.mask,channel=raw?.channels.find(c=>c.id===-2);
      if(!channel?.data)throw new Error('PSD蒙版通道数据缺失');
      if(mask.bounds.width&&mask.bounds.height){
        const pixels=bitDepth===16?new Float32Array(mask.imageBytes/4):new Uint8ClampedArray(mask.imageBytes);
        decodePsdChannel({width:maskBounds.width,height:maskBounds.height,bitDepth,compression:channel.compression,large:raw!.large,data:channel.data},{region:mask.region,data:pixels,stride:4,channel:0,sampleScale:bitDepth===16?1/257:1});
        for(let i=0;i<pixels.length;i+=4){pixels[i+1]=pixels[i+2]=pixels[i]!;pixels[i+3]=255;}
        target.imageData={width:mask.bounds.width,height:mask.bounds.height,data:pixels};
        Object.assign(target,{left:mask.bounds.x,top:mask.bounds.y,right:mask.bounds.x+mask.bounds.width,bottom:mask.bounds.y+mask.bounds.height,positionRelativeToLayer:false});
      } else {
        // 全部在画布外的蒙版只需要保存默认覆盖值，不需要巨型像素面。
        const value=target.defaultColor??0;
        target.imageData={width:1,height:1,data:bitDepth===16?new Float32Array([value,value,value,255]):new Uint8ClampedArray([value,value,value,255])};
        Object.assign(target,{left:0,top:0,right:1,bottom:1,positionRelativeToLayer:false});
      }
      if(mask.region.x||mask.region.y||mask.bounds.width!==maskBounds.width||mask.bounds.height!==maskBounds.height)memory.croppedMasks++;
    }
    // 当前层已解码，避免转换后的文档继续持有整份源文件的压缩视图。
    delete layer.rawData;
  }
  if(!layers.length&&psd.rawCompositeData){
    const required=data.byteLength+workspace+psd.width*psd.height*(bitDepth===16?32:8);
    if(required>budget)throw new Error('PSD合并图像超出内存预算');
    const imageData=getCompositeImageData(psd);
    if(imageData)psd.children=[{name:'合并图像',left:0,top:0,right:psd.width,bottom:psd.height,imageData}];
    delete psd.rawCompositeData;
    memory.estimatedPeakBytes=required;
  }
  return{psd,memory};
}
