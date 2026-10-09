import { expect, test } from '@playwright/test';
import { readPsd, initializeCanvas } from 'ag-psd';
// Node没有Canvas。仅提供图像内存分配器，通道解析仍由独立ag-psd读取器执行。
initializeCanvas(() => { throw new Error('本测试不允许Canvas栅格化兜底'); },
  (width,height) => ({width,height,data:new Uint8ClampedArray(width*height*4),colorSpace:'srgb'}) as ImageData);
// @ts-ignore 隔离浏览器和内存宿主夹具，不接触真实工程。
import { pageFor } from '../../scripts/audit/harness.mjs';

const adjustmentKinds = ['Hue/Saturation','Levels','Curves','Exposure','Gradient Map','Grain','Black & White','Color Balance','Invert','Gaussian Blur','Motion Blur','Add Noise'];

for (const depth of [8,16]) for (const kind of adjustmentKinds) {
  test(`PSD显式合并保留${depth}位${kind}调整效果，不修改原工程`, async ({browser}) => {
    const page = await pageFor(browser);
    try {
      const result = await page.evaluate(({depth,kind}) => {
        const {D,P,C,PSD} = (window as any).A;
        const d = D.createDocument(16,12,'调整层导出',depth);
        const pixels = P.createBuffer(16,12,undefined,depth);
        for(let y=0;y<12;y++)for(let x=0;x<16;x++)pixels.data.set([25+x*9+(depth===16?1/257:0),35+y*8,70+x*3,255],(y*16+x)*4);
        const layer = D.createPixelLayer('原始像素',pixels), adjustment = D.createAdjustmentLayer(kind,d);
        layer.transform.sampling = 'Nearest';
        const a = adjustment.adjustment;
        a.hue=45;a.saturation=20;a.exposureSettings.exposure=1;
        a.levels.ranges[0].gamma=1.6;a.curves.channels[0].points=[[0,0],[128,190],[255,255]];
        a.gradientMapSettings.shadows=[255,0,0];a.gradientMapSettings.highlights=[0,0,255];
        a.grainSettings.amount=35;a.noiseAmount=25;a.colorBalanceSettings.midCyanRed=30;
        a.blurRadius=1.2;a.motionDistance=5;
        d.layers=[layer,adjustment];d.activeLayerId=adjustment.id;
        // 临时选区不能改变已落地的调整层导出。
        d.selection={...P.createMask(16,12,0),outline:null};d.selection.data[0]=255;
        const before=JSON.stringify(d), composite=C.compositeDocument(d).buffer;
        const bytes=PSD.exportPsd(d,{rasterizeAdjustments:true});
        return {unchanged:JSON.stringify(d)===before,expected:Array.from(composite.data).map((v:any)=>Math.round(v*(depth===16?257:1))),bytes:btoa(Array.from(new Uint8Array(bytes),(v:any)=>String.fromCharCode(v)).join(''))};
      },{depth,kind});
      const artifact=readPsd(Buffer.from(result.bytes,'base64'),{useImageData:true,skipCompositeImageData:true});
      expect(artifact.bitsPerChannel).toBe(depth);
      expect(artifact.children).toHaveLength(1);
      expect(artifact.children![0]!.name).toContain('合成');
      expect(Array.from(artifact.children![0]!.imageData!.data)).toEqual(result.expected);
      expect(result.unchanged).toBe(true);
    } finally { await page.close(); }
  });
}

for(const depth of [8,16])test(`PSD合并完整图层栈与透明度${depth}位`,async({browser})=>{
 const page=await pageFor(browser);try{
  const result=await page.evaluate(depth=>{
   const {D,P,C,PSD}= (window as any).A,d=D.createDocument(12,12,'完整堆栈',depth);
   const base=D.createPixelLayer('半透明底图',P.createBuffer(12,12,[30.5,60.25,100,128],depth));
   const group=D.createGroupLayer('调整组'),top=D.createPixelLayer('子像素',P.createBuffer(6,6,[160,80,20,200],depth));
   group.opacity=.6;top.parentId=group.id;top.transform.origin=[3,3];top.blendMode='Multiply';
   const adjustment=D.createAdjustmentLayer('Invert',d);adjustment.parentId=group.id;adjustment.opacity=.5;
   D.addLayerMask(adjustment,12,12,depth).data.fill(128);D.addLayerMask(group,12,12,depth).data.fill(180);
   const hidden=D.createPixelLayer('隐藏层',P.createBuffer(12,12,[255,0,0,255],depth));hidden.isVisible=false;
   d.layers=[base,group,top,adjustment,hidden];
   const expected=Array.from(C.compositeDocument(d).buffer.data).map((v:any)=>Math.round(v*(depth===16?257:1)));
   const bytes=PSD.exportPsd(d,{rasterizeAdjustments:true});
   return {expected,bytes:btoa(Array.from(new Uint8Array(bytes),(v:any)=>String.fromCharCode(v)).join(''))};
  },depth);
  const artifact=readPsd(Buffer.from(result.bytes,'base64'),{useImageData:true,skipCompositeImageData:true});
  expect(artifact.children).toHaveLength(1);expect(Array.from(artifact.children![0]!.imageData!.data)).toEqual(result.expected);
 }finally{await page.close();}
});

test('PSD有调整层时低层API默认拒绝隐式栅格化',async({browser})=>{
 const page=await pageFor(browser);try{const result=await page.evaluate(()=>{const {D,E,PSD}=(window as any).A,d=E.api.doc;d.layers.push(D.createAdjustmentLayer('Invert',d));try{PSD.exportPsd(d);return '';}catch(error){return (error as Error).message;}});expect(result).toMatch(/调整层/);expect(result).toMatch(/确认|显式/);}finally{await page.close();}
});

test('PSD导出取消兼容性确认时不打开保存对话框、不写文件',async({browser})=>{
 const page=await pageFor(browser);try{
  const result=await page.evaluate(async()=>{const {E,D}=(window as any).A,H=(window as any).auditHost;await E.commands.run('addAdjustment','Invert');await new Promise(requestAnimationFrame);const content=()=>JSON.stringify({...E.api.doc,updatedAt:0});const before=content();const beforeState=JSON.parse(before);const historyBefore=E.currentHistory().position;(window as any).otools.dialog.confirm=async(message:string)=>{H.confirmations.push(message);return false;};H.savePath='/audit/adjustments.psd';await E.commands.run('exportPsd');return{messages:H.confirmations,writes:H.writes.length,saves:H.saves.length,unchanged:before===content(),changedFields:Object.keys({...beforeState,...E.api.doc}).filter(key=>key!=='updatedAt'&&JSON.stringify(beforeState[key])!==JSON.stringify(E.api.doc[key])),historyChanged:E.currentHistory().position!==historyBefore};});
  expect(result.messages).toHaveLength(1);expect(result.messages[0]).toMatch(/合并|栅格化/);expect(result.messages[0]).toContain('.comp');expect(result.messages[0]).toContain('隐藏');expect(result.writes).toBe(0);expect(result.saves).toBe(0);expect(result.unchanged,JSON.stringify(result.changedFields)).toBe(true);expect(result.historyChanged).toBe(false);
 }finally{await page.close();}
});

test('PSD导出同意后输出正确合成并在状态中说明栅格化',async({browser})=>{
 const page=await pageFor(browser);try{
  const r=await page.evaluate(async()=>{const {E,D,C}=(window as any).A,H=(window as any).auditHost;E.api.doc.layers.push(D.createAdjustmentLayer('Invert',E.api.doc));const expected=Array.from(C.compositeDocument(E.api.doc).buffer.data);H.savePath='/audit/adjustments.psd';await E.commands.run('exportPsd');return{expected,bytes:H.files['/audit/adjustments.psd'],messages:H.confirmations,status:E.statusMessage.value};});
  expect(r.messages).toHaveLength(1);expect(r.status).toMatch(/合并|栅格化/);
  const psd=readPsd(Buffer.from(r.bytes,'base64'),{useImageData:true});expect(psd.children).toHaveLength(1);expect(Array.from(psd.children![0]!.imageData!.data)).toEqual(r.expected);expect(Array.from(psd.imageData!.data)).toEqual(r.expected);
 }finally{await page.close();}
});

test('PSD普通图层不弹栅格化确认且保留图层结构',async({browser})=>{
 const page=await pageFor(browser);try{const r=await page.evaluate(async()=>{const H=(window as any).auditHost,E=(window as any).A.E;H.savePath='/audit/layers.psd';await E.commands.run('exportPsd');return{messages:H.confirmations,bytes:H.files['/audit/layers.psd']};});expect(r.messages).toHaveLength(0);const psd=readPsd(Buffer.from(r.bytes,'base64'),{useImageData:true,skipCompositeImageData:true});expect(psd.children).toHaveLength(2);}finally{await page.close();}
});

test('PSD保存对话框取消不触发浏览器下载兜底',async({browser})=>{
 const page=await pageFor(browser);try{const result=await page.evaluate(async()=>{const {E,D}=(window as any).A,H=(window as any).auditHost;E.api.doc.layers.push(D.createAdjustmentLayer('Invert',E.api.doc));let downloads=0;const native=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){downloads++;};(window as any).otools.dialog.save=async()=>null;try{await E.commands.run('exportPsd');}finally{HTMLAnchorElement.prototype.click=native;}return{writes:H.writes.length,downloads,status:E.statusMessage.value};});expect(result.writes).toBe(0);expect(result.downloads).toBe(0);expect(result.status).toContain('取消');}finally{await page.close();}
});

test('PSD确认期间切换文档或修改源，不改变已确认的导出快照',async({browser})=>{
 const page=await pageFor(browser);try{
  await page.evaluate(()=>{const {E,D,C}=(window as any).A,H=(window as any).auditHost;E.api.doc.layers.push(D.createAdjustmentLayer('Invert',E.api.doc));(window as any).expectedPsdPixels=Array.from(C.compositeDocument(E.api.doc).buffer.data);H.savePath='/audit/snapshot.psd';(window as any).otools.dialog.confirm=()=>new Promise(resolve=>{(window as any).confirmExport=resolve;});(window as any).pendingExport=E.commands.run('exportPsd');});
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).confirmExport)).toBe('function');
  const result=await page.evaluate(async()=>{const {E,D,P}=(window as any).A;E.api.doc.layers[0].pixels.data.fill(0);const d=D.createDocument(2,2,'另一文档');d.layers=[D.createPixelLayer('新的图像',P.createBuffer(2,2,[255,0,0,255]))];d.activeLayerId=d.layers[0].id;E.openDocument(d);(window as any).confirmExport(true);await (window as any).pendingExport;return{bytes:(window as any).auditHost.files['/audit/snapshot.psd'],expected:(window as any).expectedPsdPixels,current:E.api.doc.name};});
  expect(result.current).toBe('另一文档');const output=readPsd(Buffer.from(result.bytes,'base64'),{useImageData:true,skipCompositeImageData:true});expect(output.width).toBe(64);expect(Array.from(output.children![0]!.imageData!.data)).toEqual(result.expected);
 }finally{await page.close();}
});
