/** PSD通道的有界解码：保留裁剪区域，不创建完整通道/完整图层的解压副本。 */
import { Inflate } from 'pako';
import type { Rect } from '@/types/document';

export const PSD_ZIP_CHUNK_BYTES = 32 * 1024;
/** 包含pako窗口/输出块等固定工作空间的保守预留，非浏览器RSS测量。 */
export const PSD_DECODE_WORKSPACE_BYTES = 256 * 1024;
export interface PsdChannelInput {
  width: number;
  height: number;
  bitDepth: 8 | 16;
  compression: number;
  large: boolean;
  data: Uint8Array;
}
export interface PsdChannelTarget {
  /** 相对于原始通道左上角的整数矩形。 */
  region: Rect;
  data: Uint8ClampedArray | Uint16Array | Float32Array;
  /** 解码16位至0–255工作值时为1/257。 */
  sampleScale?:number;
  stride: number;
  channel: number;
}

export function decodePsdChannel(input: PsdChannelInput, target: PsdChannelTarget): void {
  const { width, height, bitDepth, compression, data } = input;
  const { region, stride, channel } = target;
  const bytesPerSample = bitDepth / 8;
  const rowBytes = width * bytesPerSample;
  const expected = rowBytes * height;
  if (![width,height,region.x,region.y,region.width,region.height,stride,channel].every(Number.isSafeInteger)
    || width < 1 || height < 1 || !Number.isSafeInteger(expected) || region.x < 0 || region.y < 0
    || region.width < 0 || region.height < 0 || region.x + region.width > width || region.y + region.height > height
    || stride < 1 || channel < 0 || channel >= stride || target.data.length < region.width * region.height * stride) {
    throw new Error('PSD通道尺寸或解码区域无效');
  }
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error('PSD通道位深暂不支持');
  const write = (index: number, value: number): void => {
    const x = index % width, y = Math.floor(index / width);
    if (x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height) {
      target.data[((y-region.y)*region.width+x-region.x)*stride+channel] = value*(target.sampleScale??1);
    }
  };
  if (compression === 0) {
    if (data.byteLength !== expected) throw new Error('PSD未压缩通道长度不符');
    // 不遍历画布外像素，只检查长度后直接访问选中的字节。
    for (let y=region.y;y<region.y+region.height;y++) for (let x=region.x;x<region.x+region.width;x++) {
      const index=y*width+x, at=index*bytesPerSample;
      write(index, bitDepth===8 ? data[at]! : (data[at]!<<8)|data[at+1]!);
    }
    return;
  }
  if (compression === 1) {
    const entryBytes=input.large?4:2, tableBytes=height*entryBytes;
    if (tableBytes>data.byteLength) throw new Error('PSD RLE行长度表不完整');
    const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
    let position=tableBytes;
    for (let y=0;y<height;y++) {
      const length=input.large?view.getUint32(y*4):view.getUint16(y*2), end=position+length;
      if (end>data.byteLength) throw new Error('PSD RLE行超出通道边界');
      if (y<region.y || y>=region.y+region.height) { position=end; continue; }
      let output=0, high=0;
      const byte=(value:number):void=>{
        if(output>=rowBytes)throw new Error('PSD RLE行解压长度超限');
        if(bitDepth===8)write(y*width+output,value);
        else if(output%2===0)high=value;
        else write(y*width+(output-1)/2,(high<<8)|value);
        output++;
      };
      while(position<end) {
        const header=data[position++]!;
        if(header<128) {
          const count=header+1;
          if(position+count>end)throw new Error('PSD RLE字面量不完整');
          for(let i=0;i<count;i++)byte(data[position++]!);
        } else if(header>128) {
          if(position>=end)throw new Error('PSD RLE重复值缺失');
          const value=data[position++]!;
          for(let i=0;i<257-header;i++)byte(value);
        }
      }
      if(output!==rowBytes)throw new Error('PSD RLE行解压长度不足');
    }
    if(position!==data.byteLength)throw new Error('PSD RLE通道包含多余数据');
    return;
  }
  if (compression !== 2 && compression !== 3) throw new Error(`不支持的PSD压缩方式：${compression}`);
  // ZIP不能跳到任意行；限制总解码工作量，同时只保存固定块和目标区域。
  if (expected > 1024 * 1024 * 1024) throw new Error('PSD ZIP通道解码工作量超限，请缩小原图或改用RLE文件');
  const inflater=new Inflate({chunkSize:PSD_ZIP_CHUNK_BYTES,windowBits:15});
  let position=0, high=0, previous=0, ended=false, endCode=0;
  inflater.onData = chunk => {
    const bytes=chunk as Uint8Array;
    if(position+bytes.length>expected)throw new Error('PSD ZIP通道解压长度超限');
    for(const value of bytes) {
      const offset=position++;
      if(bitDepth===16 && offset%2===0){high=value;continue;}
      const index=Math.floor(offset/bytesPerSample);
      let sample=bitDepth===8?value:(high<<8)|value;
      if(compression===3){if(index%width===0)previous=0;sample=(previous+sample)%(bitDepth===8?256:65536);previous=sample;}
      write(index,sample);
    }
  };
  inflater.onEnd=code=>{ended=true;endCode=code;};
  for(let offset=0;offset<data.length;offset+=PSD_ZIP_CHUNK_BYTES) {
    const end=Math.min(data.length,offset+PSD_ZIP_CHUNK_BYTES);
    const ok=inflater.push(data.subarray(offset,end),end===data.length);
    if(!ok||inflater.err||endCode)throw new Error('PSD ZIP压缩流损坏');
    if(ended&&end!==data.length)throw new Error('PSD ZIP压缩流提前结束');
  }
  if(!ended||endCode||position!==expected)throw new Error('PSD ZIP通道不完整');
}
