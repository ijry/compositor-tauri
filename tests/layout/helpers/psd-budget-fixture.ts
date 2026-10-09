import { writePsd, type Layer, type Psd } from 'ag-psd';
import { deflateSync } from 'node:zlib';

/** 独立合成压缩通道，不由被测解码器生成；不用分配巨型RGBA模拟OOM。 */
export function channelFixture(width:number,height:number,channel:number,compression=1,large=false):Uint8Array {
  const sample=(y:number)=>(channel===-1?255:20+(y%80)+channel*40);
  if(compression===1){
    const packets=Math.ceil(width/128),rowLength=packets*2,tableBytes=height*(large?4:2),out=Buffer.alloc(tableBytes+height*rowLength);
    for(let y=0;y<height;y++){if(large)out.writeUInt32BE(rowLength,y*4);else out.writeUInt16BE(rowLength,y*2);for(let p=0;p<packets;p++){const count=Math.min(128,width-p*128),at=tableBytes+y*rowLength+p*2;out[at]=257-count;out[at+1]=sample(y);}}
    return out;
  }
  const raw=Buffer.alloc(width*height);
  for(let y=0;y<height;y++){raw.fill(sample(y),y*width,(y+1)*width);if(compression===3)raw.fill(0,y*width+1,(y+1)*width);}
  return compression===0?raw:deflateSync(raw);
}
export function oversizedPsdFixture({compression=1,large=false,mask=false,offCanvas=false}={}) {
  const width=4096,height=256,left=offCanvas?5000:-24,top=-8;
  const layer:Layer={name:'超画布层',left,top,right:left+width,bottom:top+height,blendMode:'multiply',rawData:{bitsPerChannel:8,colorMode:3,large,channels:[0,1,2,-1].map(id=>({id,compression,data:channelFixture(width,height,id,compression,large)}))}};
  if(mask){layer.mask={left:-16,top:-4,right:4080,bottom:252,defaultColor:255};layer.rawData!.channels.push({id:-2,compression,data:channelFixture(width,height,0,compression,large)});}
  const psd:Psd={width:32,height:24,children:[{name:'组',children:[layer]}]};
  return Buffer.from(writePsd(psd,{noBackground:true,psb:large})).toString('base64');
}
