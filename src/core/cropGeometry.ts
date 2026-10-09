/** 裁剪在源像素空间定义；输出几何必须保持剩余像素原来的文档坐标。 */
import { applyMatrix, layerMatrix } from '@/core/geometry';
import { createMask } from '@/core/pixels';
import type { LayerMask, LayerTransform, Point, Rect } from '@/types/document';

export interface CropMargins { left:number; top:number; right:number; bottom:number }

export function sourceCropRect(width:number,height:number,margins:CropMargins):Rect {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)throw new Error('裁剪源图像尺寸无效');
  const values=[margins.left,margins.top,margins.right,margins.bottom];
  if(values.some(value=>!Number.isFinite(value)||value<0))throw new Error('裁剪边距必须是非负有限数值');
  const [left,top,right,bottom]=values.map(Math.round) as [number,number,number,number];
  const rect={x:left,y:top,width:width-left-right,height:height-top-bottom};
  validateSourceCrop(width,height,rect);
  return rect;
}

export function validateSourceCrop(width:number,height:number,rect:Rect):void {
  if(![rect.x,rect.y,rect.width,rect.height].every(Number.isSafeInteger)||rect.x<0||rect.y<0||rect.width<1||rect.height<1
    ||rect.x+rect.width>width||rect.y+rect.height>height)throw new Error('裁剪必须在原图范围内，且至少保留一个像素');
}

export function isFullSourceCrop(width:number,height:number,rect:Rect):boolean {
  return rect.x===0&&rect.y===0&&rect.width===width&&rect.height===height;
}

/** M新(x,y) = M旧(x+左裁剪,y+上裁剪)，不对剩余区域再次缩放。 */
export function croppedLayerTransform(transform:LayerTransform,width:number,height:number,rect:Rect):LayerTransform {
  validateSourceCrop(width,height,rect);
  if(isFullSourceCrop(width,height,rect))return {...transform,origin:[...transform.origin],size:[...transform.size],warp:transform.warp?.map(p=>({...p})) as LayerTransform['warp']??transform.warp};
  const matrix=layerMatrix(transform,width,height);
  if(!transform.warp){
    const size:[number,number]=[transform.size[0]*rect.width/width,transform.size[1]*rect.height/height];
    const center=applyMatrix(matrix,rect.x+rect.width/2,rect.y+rect.height/2);
    return {...transform,size,origin:[center.x-size[0]/2,center.y-size[1]/2]};
  }
  // 裁剪一个透视四边形仍是单应变换，用新的四点表达，不能仅改宽高和origin。
  const local:Point[]=[{x:rect.x,y:rect.y},{x:rect.x+rect.width,y:rect.y},{x:rect.x+rect.width,y:rect.y+rect.height},{x:rect.x,y:rect.y+rect.height}];
  const denominators=local.map(p=>matrix[6]*p.x+matrix[7]*p.y+matrix[8]);
  if(denominators.some(w=>!Number.isFinite(w)||Math.abs(w)<1e-12)||Math.min(...denominators)<0&&Math.max(...denominators)>0)throw new Error('裁剪区域的扭曲变换无效');
  const corners=local.map(p=>applyMatrix(matrix,p.x,p.y)),xs=corners.map(p=>p.x),ys=corners.map(p=>p.y);
  const x=Math.min(...xs),y=Math.min(...ys),w=Math.max(...xs)-x,h=Math.max(...ys)-y;
  if(![x,y,w,h].every(Number.isFinite)||w<=1e-9||h<=1e-9)throw new Error('裁剪后的图层变换无效');
  return {origin:[x,y],size:[w,h],rotation:0,flipX:false,flipY:false,sampling:transform.sampling,
    warp:corners.map(p=>({x:(p.x-x)/w,y:(p.y-y)/h})) as [Point,Point,Point,Point]};
}

/** 链接蒙版跟随同一源区域；独立蒙版留在原文档位置，不随裁剪拉伸。 */
export function croppedLinkedMask(mask:LayerMask|null,width:number,height:number,rect:Rect):LayerMask|null {
  if(!mask||!mask.linked||isFullSourceCrop(width,height,rect))return mask;
  validateSourceCrop(width,height,rect);
  const source=mask.pixels;
  // 蒙版可能比图像更细，裁剪后保留对应的采样密度，不强制降成图像的分辨率。
  const maskWidth=Math.max(1,Math.ceil(source.width*rect.width/width)),maskHeight=Math.max(1,Math.ceil(source.height*rect.height/height));
  const pixels=createMask(maskWidth,maskHeight,0,source.data instanceof Float32Array?16:8);
  for(let y=0;y<maskHeight;y++)for(let x=0;x<maskWidth;x++){
    // 与当前链接蒙版的最近邻覆盖率规则一致，支持蒙版尺寸与图像不同的情况。
    const sx=Math.floor((rect.x+(x+.5)*rect.width/maskWidth)*source.width/width),sy=Math.floor((rect.y+(y+.5)*rect.height/maskHeight)*source.height/height);
    pixels.data[y*maskWidth+x]=source.data[sy*source.width+sx]??(mask.outside??0);
  }
  return {...mask,pixels,placement:mask.placement?{...mask.placement}:null};
}
