/** 破坏性滤镜会话：预览只使用克隆缓冲，确认后一次性提交与记录历史。 */
import { cloneBuffer } from '@/core/pixels';
import { defaultAdjustment, ADJUSTMENT_LABELS } from '@/core/document';
import { applyAdjustment, applyAddNoise } from '@/core/filters/adjust';
import { applyVignette, applyBloom, applyTonalContrast, applyLensCorrection, applySharpen, applyDenoise, applyDither, removeBackground } from '@/core/filters/creative';
import { contentAwareFill } from '@/core/filters/contentAware';
import { resolveEditTarget, projectEditSelection } from '@/core/engine/editTarget';
import { defaultRawSettings, developRawImage } from '@/io/raw';
import type { EditorApi } from '@/types/editor';
import type { AdjustmentKind, AdjustmentRecord, PixelBuffer, CameraRawSettings } from '@/types/document';
export const ADJUSTMENT_KINDS:AdjustmentKind[]=['Hue/Saturation','Levels','Curves','Exposure','Gradient Map','Grain','Black & White','Color Balance','Invert','Gaussian Blur','Motion Blur','Add Noise'];
export const FILTER_LABELS:Record<string,string>={filterAddNoise:'添加杂色',filterVignette:'渐晕',filterBloom:'辉光',filterTonalContrast:'色调反差',filterLensCorrection:'镜头校正',filterRemoveBackground:'移除背景',filterSharpen:'USM锐化',filterDenoise:'降噪',filterDither:'抖动',contentAwareFill:'内容识别填充',cameraRaw:'相机RAW滤镜'};
export const FILTER_FIELDS:Record<string,[string,string,number,number,number?][]>= {
 filterVignette:[['amount','数量',-100,100],['midpoint','中点',0,100],['roundness','圆度',-100,100],['feather','羽化',0,100]],
 filterBloom:[['radius','半径',0,250],['intensity','强度',0,100],['threshold','阈值',0,100]],
 filterTonalContrast:[['shadows','阴影',-100,100],['highlights','高光',-100,100]],filterLensCorrection:[['distortion','畸变',-100,100],['chromaticAberration','色差',0,100],['vignette','渐晕',-100,100]],
 filterRemoveBackground:[['sensitivity','灵敏度',0,100]],filterSharpen:[['amount','数量',0,500],['radius','半径',.1,100,.1],['threshold','阈值',0,255]],filterDenoise:[['luminance','亮度降噪',0,100],['color','彩色降噪',0,100],['radius','半径',1,20]],filterDither:[['levels','色阶数量',2,256],['seed','种子',0,100000]],
};
export interface FilterSession {kind:string;title:string;source:PixelBuffer;coverage:Uint8Array|null;adjustment:AdjustmentRecord|null;raw:CameraRawSettings;values:Record<string,any>;apply:(output:PixelBuffer)=>void}
export function createFilterSession(api:EditorApi,kind:string):FilterSession|null {
 const target=resolveEditTarget(api.activeLayer());if(!target||target.onMask)return null;
 const layer=target.layer,before=api.snapshotLayer(layer.id);if(!before)return null;
 const source=cloneBuffer(target.buffer),doc=api.doc;
 return{kind,title:FILTER_LABELS[kind]??ADJUSTMENT_LABELS[kind as AdjustmentKind]??kind,source,coverage:projectEditSelection(doc,target),adjustment:ADJUSTMENT_KINDS.includes(kind as AdjustmentKind)?defaultAdjustment(kind as AdjustmentKind):kind==='filterAddNoise'?defaultAdjustment('Add Noise'):null,raw:defaultRawSettings(),values:{amount:kind==='filterVignette'?-40:80,midpoint:50,roundness:0,feather:60,radius:kind==='filterBloom'?12:1.2,intensity:40,threshold:kind==='filterBloom'?65:0,shadows:40,highlights:-30,color:40,protectMidtones:true,distortion:20,chromaticAberration:30,vignette:0,correction:true,sensitivity:50,luminance:30,levels:6,seed:11},apply:output=>{
   if(!doc.layers.includes(layer))return;layer.pixels=cloneBuffer(output);layer.shape=null;layer.gradient=null;api.markLayerDirty(layer.id);const after=api.snapshotLayer(layer.id);api.pushHistory('应用滤镜：'+(FILTER_LABELS[kind]??kind),()=>api.restoreLayer(layer.id,before),()=>{if(after)api.restoreLayer(layer.id,after);},source.data.length*2);
 }};
}
export function filterPreview(session:FilterSession):PixelBuffer {
 let result=cloneBuffer(session.source);const v=session.values;
 if(session.adjustment)result=applyAdjustment(result,session.adjustment);
 else switch(session.kind){
  case 'cameraRaw':result=developRawImage({data:session.source,width:session.source.width,height:session.source.height,cameraModel:'图层滤镜',settings:session.raw},session.raw);break;
  case 'filterVignette':applyVignette(result,{amount:v.amount,midpoint:v.midpoint,roundness:v.roundness,feather:v.feather,color:[0,0,0],blendMode:'Multiply'});break;
  case 'filterBloom':applyBloom(result,{radius:v.radius,intensity:v.intensity,threshold:v.threshold,color:[255,240,220],blendMode:'Screen'});break;
  case 'filterTonalContrast':applyTonalContrast(result,{shadows:v.shadows,highlights:v.highlights,color:true,protectMidtones:true});break;
  case 'filterLensCorrection':applyLensCorrection(result,{distortion:v.distortion,chromaticAberration:v.chromaticAberration,vignette:v.vignette,correction:true});break;
  case 'filterRemoveBackground':result=removeBackground(result,v.sensitivity);break;
  case 'filterSharpen':applySharpen(result,{amount:v.amount,radius:v.radius,threshold:v.threshold});break;
  case 'filterDenoise':applyDenoise(result,{luminance:v.luminance,color:v.color,radius:v.radius});break;
  case 'filterDither':applyDither(result,v.levels,v.seed);break;
  case 'contentAwareFill':if(session.coverage)contentAwareFill(result,session.coverage);break;
 }
 const coverage=session.coverage;if(coverage&&result.width===session.source.width&&result.height===session.source.height)for(let i=0;i<coverage.length;i++){const k=coverage[i]!/255;for(let c=0;c<4;c++)result.data[i*4+c]=session.source.data[i*4+c]!*(1-k)+result.data[i*4+c]!*k;}
 return result;
}
