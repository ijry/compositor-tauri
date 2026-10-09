/** 16位PNG读写边界；逐行还原滤波，不借助会降为8位的Canvas解码。 */
import { Deflate, Inflate } from 'pako';
import { createBuffer } from '@/core/pixels';
import { clampChannel } from '@/core/pixelFormat';
import type { PixelBuffer } from '@/types/document';

const SIGNATURE=new Uint8Array([137,80,78,71,13,10,26,10]);
const CRC_TABLE=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let n=0;n<8;n++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc(bytes:Uint8Array):number {let c=0xffffffff;for(const b of bytes)c=CRC_TABLE[(c^b)&255]!^(c>>>8);return (c^0xffffffff)>>>0;}
function chunk(name:string,data:Uint8Array):Uint8Array<ArrayBuffer> {
  const out=new Uint8Array(data.length+12),view=new DataView(out.buffer);
  view.setUint32(0,data.length);for(let i=0;i<4;i++)out[4+i]=name.charCodeAt(i);out.set(data,8);
  view.setUint32(data.length+8,crc(out.subarray(4,data.length+8)));return out;
}
export function is16BitPng(bytes:Uint8Array):boolean {
  return bytes.length>=26&&SIGNATURE.every((n,i)=>bytes[i]===n)&&bytes[24]===16;
}
/** 输出标准RGBA16、无交错PNG；工作值只在这里量化到16位整数。 */
export function encode16BitPng(buffer:PixelBuffer):Blob {
  const {width,height}=buffer;
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)throw new Error('PNG图像尺寸无效');
  const header=new Uint8Array(13),view=new DataView(header.buffer);view.setUint32(0,width);view.setUint32(4,height);header[8]=16;header[9]=6;
  const parts:BlobPart[]=[SIGNATURE,chunk('IHDR',header)];
  const compressor=new Deflate({level:6,chunkSize:32768});
  compressor.onData=bytes=>{parts.push(chunk('IDAT',bytes as Uint8Array));};
  for(let y=0;y<height;y++) {
    const row=new Uint8Array(1+width*8),rowView=new DataView(row.buffer);
    for(let x=0;x<width*4;x++)rowView.setUint16(1+x*2,Math.round(clampChannel(buffer.data[y*width*4+x]!)*257));
    if(!compressor.push(row,y===height-1))throw new Error('16位PNG压缩失败');
  }
  if(compressor.err)throw new Error('16位PNG压缩失败');
  parts.push(chunk('IEND',new Uint8Array()));return new Blob(parts,{type:'image/png'});
}
function paeth(a:number,b:number,c:number):number {const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;}

/** 支持16位灰度/RGB/灰度透明/RGBA及Adam7；未支持的关键块明确拒绝。 */
export function decode16BitPng(bytes:Uint8Array):PixelBuffer {
  if(!is16BitPng(bytes))throw new Error('不是16位PNG图像');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),idat:Uint8Array[]=[];
  let width=0,height=0,channels=0,colorType=-1,interlaced=0,offset=8,ended=false,transparency:Uint8Array|null=null;
  while(offset+12<=bytes.length) {
    const length=view.getUint32(offset),end=offset+length+12;
    if(end>bytes.length)throw new Error('PNG数据块不完整');
    const type=String.fromCharCode(...bytes.subarray(offset+4,offset+8)),data=bytes.subarray(offset+8,end-4);
    if(crc(bytes.subarray(offset+4,end-4))!==view.getUint32(end-4))throw new Error('PNG数据块校验失败');
    if(type==='IHDR') {
      if(width||offset!==8||length!==13)throw new Error('PNG头部无效');
      width=view.getUint32(offset+8);height=view.getUint32(offset+12);colorType=data[9]!;interlaced=data[12]!;
      channels=({0:1,2:3,4:2,6:4} as Record<number,number>)[colorType]??0;
      if(!width||!height||width*height>64_000_000||!channels||data[8]!==16||data[10]!==0||data[11]!==0||interlaced>1)throw new Error('PNG尺寸、位深或颜色类型不支持');
    } else if(type==='IDAT'){if(!width)throw new Error('PNG缺少图像头');idat.push(data);}
    else if(type==='tRNS')transparency=data;
    else if(type==='IEND'){if(length)throw new Error('PNG结束块无效');ended=true;offset=end;break;}
    else if(type[0]===type[0]!.toUpperCase()&&type!=='PLTE')throw new Error(`PNG关键数据块暂不支持：${type}`);
    offset=end;
  }
  if(!ended||offset!==bytes.length||!idat.length)throw new Error('PNG图像数据不完整');
  const out=createBuffer(width,height,undefined,16);
  const passList=interlaced?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]];
  const passes=passList.map(([x,y,dx,dy])=>({x:x!,y:y!,dx:dx!,dy:dy!,width:Math.max(0,Math.ceil((width-x!)/dx!)),height:Math.max(0,Math.ceil((height-y!)/dy!))})).filter(p=>p.width&&p.height);
  let pass=0,rowIndex=0,position=0,previous:Uint8Array=new Uint8Array(0),row:Uint8Array=new Uint8Array(0);
  function prepare():void {const p=passes[pass];if(!p)return;previous=new Uint8Array(p.width*channels*2);row=new Uint8Array(previous.length+1);position=0;rowIndex=0;}
  prepare();
  const transparent=transparency?new DataView(transparency.buffer,transparency.byteOffset,transparency.byteLength):null;
  const consumeRow=():void=>{
    const p=passes[pass]!;const filter=row[0]!;
    if(filter>4)throw new Error('PNG滤波器无效');
    const data=row.subarray(1),bpp=channels*2;
    for(let i=0;i<data.length;i++){const a=i>=bpp?data[i-bpp]!:0,b=previous[i]??0,c=i>=bpp?previous[i-bpp]??0:0;data[i]=(data[i]!+(filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c)))&255;}
    const current=new DataView(data.buffer,data.byteOffset,data.length);
    for(let x=0;x<p.width;x++) {
      const at=x*bpp,v=current.getUint16(at),di=((p.y+rowIndex*p.dy)*width+p.x+x*p.dx)*4;
      const r=v,g=colorType===0||colorType===4?v:current.getUint16(at+2),b=colorType===0||colorType===4?v:current.getUint16(at+4);
      let a=colorType===4?current.getUint16(at+2):colorType===6?current.getUint16(at+6):65535;
      if(transparent&&colorType===0&&transparent.byteLength===2&&v===transparent.getUint16(0))a=0;
      if(transparent&&colorType===2&&transparent.byteLength===6&&r===transparent.getUint16(0)&&g===transparent.getUint16(2)&&b===transparent.getUint16(4))a=0;
      out.data.set([r/257,g/257,b/257,a/257],di);
    }
    previous.set(data);position=0;rowIndex++;
    if(rowIndex>=p.height){pass++;prepare();}
  };
  const inflater=new Inflate({chunkSize:32768,windowBits:15});let streamEnded=false,endCode=0;
  inflater.onData=chunk=>{for(const byte of chunk as Uint8Array){if(pass>=passes.length)throw new Error('PNG解压数据超出尺寸');row[position++]=byte;if(position===row.length)consumeRow();}};
  inflater.onEnd=code=>{streamEnded=true;endCode=code;};
  for(let i=0;i<idat.length;i++){if(!inflater.push(idat[i]!,i===idat.length-1)||inflater.err||endCode)throw new Error('PNG压缩流损坏');if(streamEnded&&i!==idat.length-1)throw new Error('PNG压缩流提前结束');}
  if(!streamEnded||endCode||pass!==passes.length||position!==0)throw new Error('PNG像素数据不完整');
  return out;
}
