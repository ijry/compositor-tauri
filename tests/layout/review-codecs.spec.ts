import {test,expect} from '@playwright/test';
import {projectHost} from './helpers/project-host';
test.beforeEach(async({page})=>projectHost(page));

test('上游颜色叠加可以合成并按原生字段保存，旧插件效果仍能读取',async({page})=>{
 const result=await page.evaluate(async()=>{
  // @ts-ignore
  const IO=await import('/src/io/compProject.ts'); // @ts-ignore
  const C=await import('/src/core/engine/compositor.ts');
  const f=(window as any).projectFixture;f.manifest.layers[0].effects={colorOverlay:{red:1,green:0,blue:0,opacity:1}};f.writeManifest();
  const d=await IO.loadCompProject('review.comp');const pixel=Array.from(C.compositeDocument(d).buffer.data.slice(0,4));
  await IO.saveCompProject(d,'review.comp');const saved=JSON.parse(atob(f.files['review.comp/manifest.json'])).layers[0].effects.colorOverlay;
  f.manifest.layers[0].effects={colorOverlay:{color:[0,255,0],opacity:1,enabled:true}};f.writeManifest();
  const old=await IO.loadCompProject('review.comp');return{pixel,saved,old:Array.from(C.compositeDocument(old).buffer.data.slice(0,4))};
 });expect(result.pixel).toEqual([255,0,0,255]);expect(result.old).toEqual([0,255,0,255]);expect(result.saved).toMatchObject({red:1,green:0,blue:0,opacity:1});
});
test('上游文字颜色、对齐、行距及彩色区间可编辑并原样往返',async({page})=>{
 const result=await page.evaluate(async()=>{
  // @ts-ignore
  const IO=await import('/src/io/compProject.ts'); // @ts-ignore
  const E=await import('/src/composables/useEditor.ts'); // @ts-ignore
  const T=await import('/src/tools/transform.ts');
  const f=(window as any).projectFixture;f.manifest.layers[0].text={content:'AB',fontName:'Helvetica',fontSize:12,red:1,green:0,blue:0,alignment:'Right',leading:18,tracking:0,colorRuns:[{location:1,length:1,red:0,green:1,blue:0}]};f.writeManifest();
  const d=await IO.loadCompProject('review.comp');E.openDocument(d);T.updateTextLayer(E.api,f.id,{fontSize:16});
  const meta=E.api.activeLayer().text;await IO.saveCompProject(E.api.doc,'review.comp');const saved=JSON.parse(atob(f.files['review.comp/manifest.json'])).layers[0].text;
  return{meta,saved,visible:E.api.activeLayer().pixels.data.some((v:number,i:number)=>i%4===3&&v>0)};
 });expect(result.visible).toBe(true);expect(result.meta).toMatchObject({color:[255,0,0],align:'right',lineSpacing:18,colorRuns:[{location:1,length:1,color:[0,255,0]}]});expect(result.saved).toMatchObject({red:1,alignment:'Right',leading:18,fontSize:16,colorRuns:[{location:1,length:1,red:0,green:1,blue:0}]});
});
test('上游独立蒙版变换正确采样，旋转翻转与旧矩形格式均可往返',async({page})=>{
 const result=await page.evaluate(async()=>{
  // @ts-ignore
  const IO=await import('/src/io/compProject.ts'); // @ts-ignore
  const C=await import('/src/core/engine/compositor.ts');
  const f=(window as any).projectFixture,l=f.manifest.layers[0];l.maskFile=f.id+'.mask.png';l.maskEnabled=true;l.maskLinked=false;
  l.maskPlacement={origin:[4,4],size:[8,8],rotation:90,flipX:true,flipY:false,sampling:'Nearest'};f.writeManifest();
  const d=await IO.loadCompProject('review.comp');const b=C.compositeDocument(d).buffer.data;const alpha=(x:number,y:number)=>b[(y*16+x)*4+3];
  await IO.saveCompProject(d,'review.comp');const saved=JSON.parse(atob(f.files['review.comp/manifest.json'])).layers[0].maskPlacement;
  l.maskPlacement={x:0,y:0,width:16,height:16};f.writeManifest();const old=C.compositeDocument(await IO.loadCompProject('review.comp')).buffer.data;
  return{inside:alpha(8,8),outside:alpha(1,1),saved,old:old[3]};
 });expect(result).toMatchObject({inside:255,outside:0,old:255,saved:{origin:[4,4],size:[8,8],rotation:90,flipX:true,flipY:false,sampling:'Nearest'}});
});
