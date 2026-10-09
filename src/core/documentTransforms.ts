/** 文档级变换的几何计算，与文档状态和历史记录解耦。 */
import { applyMatrix, invertMatrix, layerMatrix, multiplyMatrix, scaling, transformedBounds } from '@/core/geometry';
import { placementTransform } from '@/core/engine/maskGeometry';
import { createMask, resizeMask } from '@/core/pixels';
import { sampleScalar } from '@/core/sampler';
import type { LayerMask, LayerTransform, Point } from '@/types/document';

/** 围绕画布旋转图层中心，像素网格不重采样。 */
export function rotatedTransform(t: LayerTransform, degrees: number, width: number, height: number): LayerTransform {
  const x = t.origin[0] + t.size[0] / 2, y = t.origin[1] + t.size[1] / 2;
  const center = degrees === 90 ? [height-y,x] : degrees === 180 ? [width-x,height-y] : [y,width-x];
  return { ...t, origin: [center[0]-t.size[0]/2,center[1]-t.size[1]/2], size: [...t.size], rotation: ((t.rotation+degrees)%360+360)%360 };
}

/** 非等比缩放旋转图层会产生剪切，用既有四点变换完整表达，不丢掉原有比例。 */
export function scaledTransform(t: LayerTransform, sx: number, sy: number): LayerTransform {
  if (Math.abs(sx-sy)<1e-12 || Math.abs(Math.sin(t.rotation*Math.PI/180))<1e-12) {
    return { ...t, origin: [t.origin[0]*sx,t.origin[1]*sy], size: [t.size[0]*sx,t.size[1]*sy] };
  }
  const m = multiplyMatrix(scaling(sx,sy),layerMatrix(t,1,1));
  const bounds = transformedBounds(m,1,1);
  const corners = [[0,0],[1,0],[1,1],[0,1]].map(([x,y]) => applyMatrix(m,x,y));
  const warp = corners.map(p => ({x:(p.x-bounds.x)/bounds.width,y:(p.y-bounds.y)/bounds.height})) as [Point,Point,Point,Point];
  return { origin:[bounds.x,bounds.y],size:[bounds.width,bounds.height],rotation:0,flipX:false,flipY:false,sampling:t.sampling,warp };
}

/** 蒙版始终从原灰度数据重采样，绝不能用新白蒙版替换。 */
export function scaledMask(mask: LayerMask, sx: number, sy: number): LayerMask {
  const p = mask.placement;
  if (!mask.linked && p && Math.abs(sx-sy)>1e-12 && Math.abs(Math.sin((p.rotation??0)*Math.PI/180))>1e-12) {
    // 独立蒙版的矩形 placement 不能表示剪切，因此烘焙到缩放后的轴对齐网格。
    const source = mask.pixels;
    const m = multiplyMatrix(scaling(sx,sy),layerMatrix(placementTransform(p),source.width,source.height));
    const bounds = transformedBounds(m,source.width,source.height);
    const x = Math.floor(bounds.x), y = Math.floor(bounds.y);
    const pixels = createMask(Math.max(1,Math.ceil(bounds.x+bounds.width)-x),Math.max(1,Math.ceil(bounds.y+bounds.height)-y),0,mask.pixels.data instanceof Float32Array?16:8);
    const inverse = invertMatrix(m);
    for (let py=0;py<pixels.height;py++) for(let px=0;px<pixels.width;px++) {
      const point = applyMatrix(inverse,x+px+0.5,y+py+0.5);
      if(point.x<0 || point.y<0 || point.x>=source.width || point.y>=source.height)continue;
      pixels.data[py*pixels.width+px] = p.sampling==='Nearest'
        ? source.data[Math.floor(point.y)*source.width+Math.floor(point.x)]
        : sampleScalar(source.data,source.width,source.height,point.x-0.5,point.y-0.5);
    }
    return {...mask,pixels,placement:{x,y,width:pixels.width,height:pixels.height,rotation:0,flipX:false,flipY:false,sampling:p.sampling}};
  }
  return { ...mask,
    pixels: resizeMask(mask.pixels,Math.max(1,Math.round(mask.pixels.width*sx)),Math.max(1,Math.round(mask.pixels.height*sy))),
    placement: p ? {...p,x:p.x*sx,y:p.y*sy,width:p.width*sx,height:p.height*sy} : null,
  };
}
