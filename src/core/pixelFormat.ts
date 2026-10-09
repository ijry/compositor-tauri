/** 像素数值约定：8位整数或16位文档的0–255浮点工作值。显示/文件编码才量化。 */
import type { BitDepth, CompDocument, PixelArray, PixelBuffer } from '@/types/document';

export function pixelDepth(buffer: Pick<PixelBuffer,'data'|'bitDepth'>):BitDepth {
  return buffer.bitDepth===16||buffer.data instanceof Float32Array?16:8;
}
export function documentDepth(document:Pick<CompDocument,'layers'|'bitDepth'>):BitDepth {
  return document.bitDepth===16||document.layers.some(l=>l.pixels&&pixelDepth(l.pixels)===16||l.mask?.pixels.data instanceof Float32Array)?16:8;
}
export function allocatePixels(length:number,depth:BitDepth=8):PixelArray {
  if(!Number.isSafeInteger(length)||length<0||length*(depth===16?4:1)>1024*1024*1024)throw new Error('像素缓冲超出安全范围');
  return depth===16?new Float32Array(length):new Uint8ClampedArray(length);
}
export function copyPixels(data:PixelArray):PixelArray {
  return data instanceof Float32Array?new Float32Array(data):new Uint8ClampedArray(data);
}
export function clampChannel(value:number):number { return Number.isFinite(value)?Math.max(0,Math.min(255,value)):0; }
/** 逻辑操作提交前截断越界值，不做8位舍入。 */
export function clampPixels(buffer:PixelBuffer):PixelBuffer {
  if(buffer.data instanceof Float32Array)for(let i=0;i<buffer.data.length;i++)buffer.data[i]=clampChannel(buffer.data[i]!);
  return buffer;
}
export function convertBufferDepth(buffer:PixelBuffer,depth:BitDepth):PixelBuffer {
  if(pixelDepth(buffer)===depth)return buffer;
  const data=allocatePixels(buffer.data.length,depth);data.set(buffer.data);
  return clampPixels({width:buffer.width,height:buffer.height,bitDepth:depth,data});
}
/** Canvas/ImageData为8位边界。调用方不得把此副本写回高位深源图层。 */
export function displayBytes(buffer:PixelBuffer):Uint8ClampedArray<ArrayBuffer> {
  return buffer.data instanceof Uint8ClampedArray?buffer.data:new Uint8ClampedArray(buffer.data);
}
export function toImageData(buffer:PixelBuffer):ImageData { return new ImageData(displayBytes(buffer),buffer.width,buffer.height); }
export function uint16Pixels(buffer:PixelBuffer):Uint16Array<ArrayBuffer> {
  const result=new Uint16Array(buffer.data.length);
  for(let i=0;i<result.length;i++)result[i]=Math.round(clampChannel(buffer.data[i]!)*257);
  return result;
}
export function fromUint16Pixels(width:number,height:number,pixels:Uint16Array):PixelBuffer {
  if(pixels.length!==width*height*4)throw new Error('16位像素长度不符');
  const data=new Float32Array(pixels.length);
  for(let i=0;i<data.length;i++)data[i]=pixels[i]!/257;
  return{width,height,data,bitDepth:16};
}
