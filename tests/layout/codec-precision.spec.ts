import {test,expect} from '@playwright/test';
import {deflateSync} from 'node:zlib';
import {png16Fixture} from './helpers/png16-fixture';

for(const colorType of [0,2,4,6])for(const filter of [0,1,2,3,4])test(`PNG16独立样本颜色${colorType}滤波${filter}`,async({page})=>{
 await page.goto('http://127.0.0.1:5194',{waitUntil:'networkidle'});const fixture=png16Fixture(colorType,filter,filter===4);const actual=await page.evaluate(async base64=>{ // @ts-ignore
 const {decodeImageBytes}=await import('/src/io/imageIO.ts');const b=await decodeImageBytes(Uint8Array.from(atob(base64),c=>c.charCodeAt(0)).buffer);return{depth:b.bitDepth,data:Array.from(b.data)};},fixture.base64);expect(actual.depth).toBe(16);fixture.expected.forEach((v,i)=>expect(actual.data[i]).toBeCloseTo(v,4));
});

test('PNG16坏CRC必须拒绝而不是当成普通PNG降级加载',async({page})=>{
 await page.goto('http://127.0.0.1:5194',{waitUntil:'networkidle'});const bytes=Buffer.from(png16Fixture().base64,'base64');bytes[44]^=1;const error=await page.evaluate(async base64=>{ // @ts-ignore
 const {decodeImageBytes}=await import('/src/io/imageIO.ts');try{await decodeImageBytes(Uint8Array.from(atob(base64),c=>c.charCodeAt(0)).buffer);return '';}catch(e){return (e as Error).message;}},bytes.toString('base64'));expect(error).toContain('校验失败');
});

for(const compression of [0,1,2,3])test('PSD16独立通道裁剪与预测还原 '+compression,async({page})=>{
 const width=8,height=3,raw=Buffer.alloc(width*height*2),expected:number[]=[];
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const v=32768+y*16+x;raw.writeUInt16BE(compression===3?(x?1:v):v,(y*width+x)*2);if(y>=1&&x>=2&&x<5)expected.push(v);}
 let encoded:Buffer;if(compression===0)encoded=raw;else if(compression===1){const table=Buffer.alloc(height*2),rows:Buffer[]=[];for(let y=0;y<height;y++){const row=Buffer.concat([Buffer.from([width*2-1]),raw.subarray(y*width*2,(y+1)*width*2)]);table.writeUInt16BE(row.length,y*2);rows.push(row);}encoded=Buffer.concat([table,...rows]);}else encoded=deflateSync(raw);
 await page.goto('http://127.0.0.1:5194',{waitUntil:'networkidle'});const actual=await page.evaluate(async({compression,base64})=>{ // @ts-ignore
 const {decodePsdChannel}=await import('/src/io/psdChannel.ts');const out=new Uint16Array(6);decodePsdChannel({width:8,height:3,bitDepth:16,large:false,compression,data:Uint8Array.from(atob(base64),c=>c.charCodeAt(0))},{region:{x:2,y:1,width:3,height:2},data:out,stride:1,channel:0});return Array.from(out);},{compression,base64:encoded.toString('base64')});expect(actual).toEqual(expected);
});

for(const malformed of ['raw-short','rle-short','zip-long','zip-truncated','compression'])test('PSD损坏通道拒绝 '+malformed,async({page})=>{
 let compression=0,data=Buffer.from([1,2]);if(malformed==='rle-short'){compression=1;data=Buffer.from([0,2,0,7]);}if(malformed==='zip-long'){compression=2;data=deflateSync(Buffer.alloc(20));}if(malformed==='zip-truncated'){compression=2;data=deflateSync(Buffer.from([1,2,3,4])).subarray(0,6);}if(malformed==='compression'){compression=9;data=Buffer.alloc(4);}
 await page.goto('http://127.0.0.1:5194',{waitUntil:'networkidle'});const error=await page.evaluate(async({compression,base64})=>{ // @ts-ignore
 const {decodePsdChannel}=await import('/src/io/psdChannel.ts');try{decodePsdChannel({width:4,height:1,bitDepth:8,large:false,compression,data:Uint8Array.from(atob(base64),c=>c.charCodeAt(0))},{region:{x:0,y:0,width:4,height:1},data:new Uint8ClampedArray(4),stride:1,channel:0});return '';}catch(e){return (e as Error).message;}},{compression,base64:data.toString('base64')});expect(error).toMatch(/PSD/);expect(error).not.toBe('');
});

for(const bits of [8,16])for(const big of [false,true])test(`TIFF水平预测还原 ${bits}位 ${big?'大端':'小端'}`,async({page})=>{
 const width=3,height=2,samples=3,entries=[[256,4,1,width],[257,4,1,height],[258,3,1,bits],[259,3,1,1],[262,3,1,2],[273,4,1,0],[277,3,1,3],[278,4,1,height],[279,4,1,width*height*samples*bits/8],[317,3,1,2]],offset=8+2+entries.length*12+4;entries[5]![3]=offset;
 const bytes=Buffer.alloc(offset+width*height*samples*bits/8),set16=(n:number,o:number)=>big?bytes.writeUInt16BE(n,o):bytes.writeUInt16LE(n,o),set32=(n:number,o:number)=>big?bytes.writeUInt32BE(n,o):bytes.writeUInt32LE(n,o);
 bytes.write(big?'MM':'II');set16(42,2);set32(8,4);set16(entries.length,8);entries.forEach(([tag,type,count,value],i)=>{const o=10+i*12;set16(tag!,o);set16(type!,o+2);set32(count!,o+4);if(type===3)set16(value!,o+8);else set32(value!,o+8);});
 const expected:number[]=[];for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<samples;c++){const base=bits===16?1000:40,value=base+c*10+y*5+x,delta=x?1:value,at=offset+((y*width+x)*samples+c)*bits/8;if(bits===16)set16(delta,at);else bytes[at]=delta;expected.push(value*(bits===16?1/257:1));}
 await page.goto('http://127.0.0.1:5194',{waitUntil:'networkidle'});const actual=await page.evaluate(async base64=>{ // @ts-ignore
 const {decodeImageBytes}=await import('/src/io/imageIO.ts');const b=await decodeImageBytes(Uint8Array.from(atob(base64),c=>c.charCodeAt(0)).buffer);return Array.from(b.data).filter((_,i)=>i%4!==3);},bytes.toString('base64'));expected.forEach((v,i)=>expect(actual[i]).toBeCloseTo(v,4));
});
