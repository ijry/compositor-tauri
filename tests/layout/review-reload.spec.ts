import {test,expect} from '@playwright/test';
import {projectHost} from './helpers/project-host';
async function openDirty(page:any){await projectHost(page);await page.evaluate(async()=>{ // @ts-ignore
 const E=await import('/src/composables/useEditor.ts'); // @ts-ignore
 const IO=await import('/src/io/compProject.ts');E.openDocument(await IO.loadCompProject('review.comp'));await E.commands.run('newLayer');
});}
for(const accept of [false,true])test('热重载'+(accept?'确认后才替换':'取消保留未保存内容和历史'),async({page})=>{
 await openDirty(page);const result=await page.evaluate(async accept=>{
  // @ts-ignore
  const E=await import('/src/composables/useEditor.ts'); // @ts-ignore
  const IO=await import('/src/io/compProject.ts');
  const f=(window as any).projectFixture;f.confirmMode=accept?'accept':'cancel';f.manifest.layers[0].name='磁盘新版本';f.writeManifest();
  await E.reloadDocument(await IO.loadCompProject('review.comp'));
  return{count:E.api.doc.layers.length,dirty:E.api.doc.dirty,confirm:f.confirmCount,history:E.currentHistory().canUndo};
 },accept);expect(result).toEqual(accept?{count:1,dirty:false,confirm:1,history:false}:{count:2,dirty:true,confirm:1,history:true});
});
test('询问期间继续编辑不能覆盖新的内容',async({page})=>{
 await openDirty(page);await page.evaluate(async()=>{ // @ts-ignore
 const E=await import('/src/composables/useEditor.ts'); // @ts-ignore
 const IO=await import('/src/io/compProject.ts');const f=(window as any).projectFixture;f.confirmMode='defer';(window as any).reloadPending=E.reloadDocument(await IO.loadCompProject('review.comp'));
 });await expect.poll(()=>page.evaluate(()=>typeof (window as any).projectFixture.answer)).toBe('function');
 const result=await page.evaluate(async()=>{ // @ts-ignore
 const E=await import('/src/composables/useEditor.ts');await E.commands.run('newLayer');(window as any).projectFixture.answer(true);await (window as any).reloadPending;return E.api.doc.layers.length;
 });expect(result).toBe(3);
});
test('真实 watcher 外部修改询问一次，取消后保留本地图层',async({page})=>{
 await openDirty(page);await page.evaluate(async()=>{ // @ts-ignore
 const E=await import('/src/composables/useEditor.ts');await E.commands.run('watchComp');
 });await page.waitForTimeout(450);await page.evaluate(()=>{const f=(window as any).projectFixture;f.manifest.layers[0].name='external';f.writeManifest();});
 await expect.poll(()=>page.evaluate(()=>(window as any).projectFixture.confirmCount)).toBe(1);
 await page.waitForTimeout(900);const result=await page.evaluate(async()=>{ // @ts-ignore
 const E=await import('/src/composables/useEditor.ts');await E.commands.run('unwatchComp');return{count:E.api.doc.layers.length,confirms:(window as any).projectFixture.confirmCount};
 });expect(result).toEqual({count:2,confirms:1});
});

test('自身保存不会被当作外部修改清空历史',async({page})=>{
 await openDirty(page);await page.evaluate(async()=>{ // @ts-ignore
  const E=await import('/src/composables/useEditor.ts');(window as any).originalDocument=E.api.doc;await E.commands.run('watchComp');
 });await page.waitForTimeout(450);await page.evaluate(async()=>{ // @ts-ignore
  const E=await import('/src/composables/useEditor.ts');await E.commands.run('saveComp');
 });await page.waitForTimeout(1200);
 const result=await page.evaluate(async()=>{ // @ts-ignore
  const E=await import('/src/composables/useEditor.ts');await E.commands.run('unwatchComp');return{same:E.api.doc===(window as any).originalDocument,dirty:E.api.doc.dirty,undo:E.currentHistory().canUndo};
 });expect(result).toEqual({same:true,dirty:false,undo:true});
});
test('关闭监视后，确认框迟到的同意不能再替换文档',async({page})=>{
 await openDirty(page);await page.evaluate(async()=>{ // @ts-ignore
  const E=await import('/src/composables/useEditor.ts');(window as any).projectFixture.confirmMode='defer';await E.commands.run('watchComp');
 });await page.waitForTimeout(450);await page.evaluate(()=>{const f=(window as any).projectFixture;f.manifest.layers[0].name='external';f.writeManifest();});
 await expect.poll(()=>page.evaluate(()=>typeof (window as any).projectFixture.answer)).toBe('function');
 await page.evaluate(async()=>{ // @ts-ignore
  const E=await import('/src/composables/useEditor.ts');await E.commands.run('unwatchComp');(window as any).projectFixture.answer(true);
 });await page.waitForTimeout(450);const count=await page.evaluate(async()=>{ // @ts-ignore
  const E=await import('/src/composables/useEditor.ts');return E.api.doc.layers.length;
 });expect(count).toBe(2);
});
test('画布交互期间推迟外部重载，结束后重试而不丢失变化通知',async({page})=>{
 await openDirty(page);await page.evaluate(async()=>{ // @ts-ignore
  const E=await import('/src/composables/useEditor.ts');E.api.beginInteraction('绘画');await E.commands.run('watchComp');
 });await page.waitForTimeout(450);await page.evaluate(()=>{const f=(window as any).projectFixture;f.manifest.layers[0].name='external';f.writeManifest();});
 await page.waitForTimeout(900);expect(await page.evaluate(()=>(window as any).projectFixture.confirmCount)).toBe(0);
 await page.evaluate(async()=>{ // @ts-ignore
  const E=await import('/src/composables/useEditor.ts');E.api.endInteraction();
 });await expect.poll(()=>page.evaluate(()=>(window as any).projectFixture.confirmCount)).toBe(1);
});
