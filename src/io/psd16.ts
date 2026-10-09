/** 16位PSD输出：复用ag-psd的图层元数据编码，像素通道与合并预览使用真正的大端16位。 */
import { writePsd, type Psd, type Layer, type LayerRawData } from 'ag-psd';
import { clampChannel } from '@/core/pixelFormat';
import type { PixelBuffer } from '@/types/document';

/** 压缩通道在writePsd里原样写入，不经过8位ImageData。 */
export function raw16Layer(buffer:PixelBuffer):LayerRawData {
  return{bitsPerChannel:16,colorMode:3,large:false,channels:[0,1,2,-1].map(id=>({id,compression:0,data:raw16Channel(buffer,id===-1?3:id)}))};
}
export function raw16Channel(buffer:PixelBuffer,channel:number):Uint8Array<ArrayBuffer> {
  const result=new Uint8Array(buffer.width*buffer.height*2),view=new DataView(result.buffer);
  for(let p=0;p<buffer.width*buffer.height;p++)view.setUint16(p*2,Math.round(clampChannel(buffer.data[p*4+channel]!)*257));
  return result;
}
export function write16BitPsd(psd:Psd,composite:PixelBuffer):ArrayBuffer {
  // 骨架写入器仅处理元数据和已有的rawData通道，不把16位buffer交给它的8位像素编码器。
  const bytes=new Uint8Array(writePsd({...psd,bitsPerChannel:8},{generateThumbnail:false,noBackground:true}));
  const sourceView=new DataView(bytes.buffer);
  let at=26;
  at+=4+sourceView.getUint32(at); // color mode data
  at+=4+sourceView.getUint32(at); // image resources
  const layerMaskStart=at,layerMaskLength=sourceView.getUint32(at),compositeStart=at+4+layerMaskLength;
  if(compositeStart>bytes.length)throw new Error('PSD元数据骨架长度无效');
  const hasAlpha=composite.data.some((v,i)=>i%4===3&&v<255),channels=hasAlpha?4:3,pixels=composite.width*composite.height;
  const out=new Uint8Array(compositeStart+2+pixels*channels*2);out.set(bytes.subarray(0,compositeStart));
  const view=new DataView(out.buffer);view.setUint16(12,channels);view.setUint16(22,16);view.setUint16(compositeStart,0);
  // 图层数负号标记合并透明度通道。预览RGB按PSD约定铺白底；图层原始通道始终非预乘。
  if(layerMaskLength>=6){const layerInfoLength=view.getUint32(layerMaskStart+4);if(layerInfoLength>=2){const count=view.getInt16(layerMaskStart+8);view.setInt16(layerMaskStart+8,hasAlpha?-Math.abs(count):Math.abs(count));}}
  for(let c=0;c<channels;c++)for(let p=0;p<pixels;p++){
    const alpha=clampChannel(composite.data[p*4+3]!)/255;
    const value=c===3?alpha*255:hasAlpha?clampChannel(composite.data[p*4+c]!)*alpha+255*(1-alpha):clampChannel(composite.data[p*4+c]!);
    view.setUint16(compositeStart+2+(c*pixels+p)*2,Math.round(value*257));
  }
  return out.buffer;
}
