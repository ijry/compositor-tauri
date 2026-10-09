import {crc32,deflateSync} from 'node:zlib';
/** 标准PNG独立夹具：由整数样本生成滤波/Adam7字节，CRC使用Node实现。 */
export function png16Fixture(colorType=6,filter=0,interlaced=false) {
 const width=5,height=5,channels=({0:1,2:3,4:2,6:4} as Record<number,number>)[colorType]!;
 const rgba=Array.from({length:width*height},(_,p)=>[32768+p,16448+p*2,8224+p*3,50000-p]);
 if(colorType===0||colorType===4)for(const px of rgba){px[1]=px[2]=px[0]!;}if(colorType===0||colorType===2)for(const px of rgba)px[3]=65535;
 const chunk=(name:string,data:Buffer)=>{const type=Buffer.from(name),header=Buffer.alloc(4),sum=Buffer.alloc(4);header.writeUInt32BE(data.length);sum.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([header,type,data,sum]);};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=16;ihdr[9]=colorType;ihdr[12]=interlaced?1:0;
 const passes=interlaced?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]],raw:Buffer[]=[];
 for(const [x0,y0,dx,dy]of passes){const pw=Math.max(0,Math.ceil((width-x0!)/dx!)),ph=Math.max(0,Math.ceil((height-y0!)/dy!));if(!pw||!ph)continue;let prior=Buffer.alloc(pw*channels*2);for(let row=0;row<ph;row++){
  const pixels=Buffer.alloc(pw*channels*2),bytes=Buffer.alloc(pixels.length+1);bytes[0]=filter;
  for(let x=0;x<pw;x++){const pixel=rgba[(y0!+row*dy!)*width+x0!+x*dx!]!,values=colorType===0?[pixel[0]!]:colorType===4?[pixel[0]!,pixel[3]!]:pixel.slice(0,channels);values.forEach((v,c)=>pixels.writeUInt16BE(v,(x*channels+c)*2));}
  for(let i=0;i<pixels.length;i++){const left=i>=channels*2?pixels[i-channels*2]!:0,up=prior[i]!,corner=i>=channels*2?prior[i-channels*2]!:0,pred=left+up-corner,dl=Math.abs(pred-left),du=Math.abs(pred-up),dc=Math.abs(pred-corner);const chosen=filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):dl<=du&&dl<=dc?left:du<=dc?up:corner;bytes[i+1]=(pixels[i]!-chosen+256)&255;}
  raw.push(bytes);prior=pixels;
 }}
 const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.concat(raw))),chunk('IEND',Buffer.alloc(0))]);return{base64:png.toString('base64'),expected:rgba.flat().map(v=>v/257),width,height};
}
