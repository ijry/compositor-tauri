/** 蒙版像素网格与文档坐标的唯一映射，预览、应用、剪贴和绘制共用。 */
import { applyMatrix, invertMatrix, layerMatrix, type Matrix } from '@/core/geometry';
import type { Layer, LayerMask, LayerTransform, MaskBuffer } from '@/types/document';

export function placementTransform(p: NonNullable<LayerMask['placement']>): LayerTransform {
  return { origin: [p.x,p.y], size: [p.width,p.height], rotation: p.rotation ?? 0,
    flipX: p.flipX ?? false, flipY: p.flipY ?? false, sampling: p.sampling ?? 'Nearest' };
}
export function maskToDocument(layer: Layer, pixels = layer.mask?.pixels): Matrix {
  if (!pixels) throw new Error('当前图层没有蒙版');
  const transform = !layer.mask?.linked && layer.mask?.placement ? placementTransform(layer.mask.placement) : layer.transform;
  return layerMatrix(transform, pixels.width, pixels.height);
}
export function createMaskSampler(layer: Layer, pixels: MaskBuffer | undefined = layer.mask?.pixels): (x: number, y: number) => number {
  if (!pixels || !layer.mask?.enabled) return () => 1;
  const inverse = invertMatrix(maskToDocument(layer, pixels));
  return (x, y) => {
    const local = applyMatrix(inverse, x, y), px = Math.floor(local.x), py = Math.floor(local.y);
    if (px < 0 || py < 0 || px >= pixels.width || py >= pixels.height) return 0;
    const value = pixels.data[py * pixels.width + px] / 255;
    return layer.mask?.inverted ? 1 - value : value;
  };
}

/** 将蒙版统一采样到图像的原生像素网格，预览与“应用蒙版”使用相同结果。 */
export function applyPixelMask(layer: Layer, pixels: import('@/types/document').PixelBuffer): void {
  const sample = createMaskSampler(layer);
  const imageToDocument = layerMatrix(layer.transform,pixels.width,pixels.height);
  for (let y=0;y<pixels.height;y++) for(let x=0;x<pixels.width;x++) {
    const point = applyMatrix(imageToDocument,x+0.5,y+0.5);
    const i = (y*pixels.width+x)*4+3;
    pixels.data[i] = Math.round(pixels.data[i]*sample(point.x,point.y));
  }
}
