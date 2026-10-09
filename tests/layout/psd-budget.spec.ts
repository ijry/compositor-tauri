import { test, expect } from '@playwright/test';
import { oversizedPsdFixture } from './helpers/psd-budget-fixture';

for(const compression of [0,1,2,3])test(`PSD预算内只解码画布交集 compression=${compression}`,async({page})=>{
  await page.goto('http://127.0.0.1:5194',{waitUntil:'networkidle'});
  const data=oversizedPsdFixture({compression});
  const result=await page.evaluate(async base64=>{
    // @ts-ignore 在独立开发页加载真实模块。
    const {importPsd}=await import('/src/io/psd.ts');
    const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),budget=bytes.byteLength+512*1024;
    const Native=window.Uint8ClampedArray,allocations:number[]=[];
    window.Uint8ClampedArray=new Proxy(Native,{construct(target,args){const result=Reflect.construct(target,args);allocations.push(result.byteLength);return result;}});
    try{const imported=importPsd(bytes.buffer,'预算测试',{memoryBudgetBytes:budget});const layer=imported.document.layers.find((l:any)=>l.kind==='pixel');return{memory:imported.report.memory,notes:imported.report.notes,budget,largest:Math.max(...allocations,0),size:[layer.pixels.width,layer.pixels.height],origin:layer.transform.origin,rgba:Array.from(layer.pixels.data.slice(0,4)),blend:layer.blendMode,parent:!!layer.parentId};}finally{window.Uint8ClampedArray=Native;}
  },data);
  expect(result.size).toEqual([32,24]);expect(result.origin).toEqual([0,0]);expect(result.rgba).toEqual([28,68,108,255]);expect(result.blend).toBe('Multiply');expect(result.parent).toBe(true);
  expect(result.largest).toBeLessThanOrEqual(32*24*4);expect(result.memory.mode).toBe('canvas');expect(result.memory.estimatedPeakBytes).toBeLessThanOrEqual(result.budget);expect(result.notes.join('')).toContain('裁剪');
});

test('PSB四字节RLE行表与独立蒙版一起裁剪且保留默认覆盖率',async({page})=>{
 await page.goto('http://127.0.0.1:5194',{waitUntil:'networkidle'});const data=oversizedPsdFixture({large:true,mask:true});
 const result=await page.evaluate(async data=>{ // @ts-ignore
 const IO=await import('/src/io/psd.ts');const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));const r=IO.importPsd(bytes.buffer,'PSB',{memoryBudgetBytes:bytes.length+512*1024});const l=r.document.layers.find((l:any)=>l.kind==='pixel');return{size:[l.pixels.width,l.pixels.height],maskSize:[l.mask.pixels.width,l.mask.pixels.height],placement:l.mask.placement,first:l.mask.pixels.data[0],outside:l.mask.outside,memory:r.report.memory};},data);
 expect(result.size).toEqual([32,24]);expect(result.maskSize).toEqual([32,24]);expect(result.placement).toMatchObject({x:0,y:0,width:32,height:24});expect(result.first).toBe(24);expect(result.outside).toBe(255);expect(result.memory.croppedMasks).toBe(1);
});

test('裁剪后仍超过预算时先拒绝，不分配图层像素',async({page})=>{
 await page.goto('http://127.0.0.1:5194',{waitUntil:'networkidle'});const result=await page.evaluate(async data=>{ // @ts-ignore
 const {importPsd}=await import('/src/io/psd.ts');const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));const Native=window.Uint8ClampedArray,allocations:number[]=[];window.Uint8ClampedArray=new Proxy(Native,{construct(t,a){const r=Reflect.construct(t,a);allocations.push(r.byteLength);return r;}});let error='';try{importPsd(bytes.buffer,'预算不足',{memoryBudgetBytes:bytes.length+64});}catch(e){error=(e as Error).message;}finally{window.Uint8ClampedArray=Native;}return{error,allocations};},oversizedPsdFixture());
 expect(result.error).toMatch(/内存预算/);expect(result.allocations).toEqual([]);
});

test('充足预算保留画布外像素，整层在画布外时报告跳过而不是崩溃',async({page})=>{
 await page.goto('http://127.0.0.1:5194',{waitUntil:'networkidle'});const result=await page.evaluate(async({full,outside})=>{ // @ts-ignore
 const {importPsd}=await import('/src/io/psd.ts');const b=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));const a=b(full),o=b(outside);const keep=importPsd(a.buffer,'完整',{memoryBudgetBytes:a.length+16*1024*1024}),crop=importPsd(o.buffer,'空交集',{memoryBudgetBytes:o.length+512*1024});const layer=keep.document.layers.find((l:any)=>l.kind==='pixel');return{size:[layer.pixels.width,layer.pixels.height],origin:layer.transform.origin,mode:keep.report.memory?.mode,remaining:crop.document.layers.filter((l:any)=>l.kind==='pixel').length,skipped:crop.report.memory?.skippedLayers};},{full:oversizedPsdFixture(),outside:oversizedPsdFixture({offCanvas:true})});
 expect(result).toEqual({size:[4096,256],origin:[-24,-8],mode:'full',remaining:0,skipped:1});
});

test('PSD额外专色通道不覆盖图层透明度通道',async({page})=>{
 const {writePsd}=await import('ag-psd');const {channelFixture}=await import('./helpers/psd-budget-fixture');const bytes=writePsd({width:4,height:2,children:[{name:'含额外通道',left:0,top:0,right:4,bottom:2,rawData:{colorMode:3,bitsPerChannel:8,large:false,channels:[0,1,2,-1,3].map(id=>({id,compression:1,data:channelFixture(4,2,id)}))}}]},{noBackground:true});
 await page.goto('http://127.0.0.1:5194',{waitUntil:'networkidle'});const alpha=await page.evaluate(async base64=>{ // @ts-ignore
 const {importPsd}=await import('/src/io/psd.ts');return importPsd(Uint8Array.from(atob(base64),c=>c.charCodeAt(0)).buffer).document.layers[0].pixels.data[3];},Buffer.from(bytes).toString('base64'));expect(alpha).toBe(255);
});
