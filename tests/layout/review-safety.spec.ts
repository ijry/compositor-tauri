import { test, expect, type Page } from '@playwright/test';

// 使用真实编辑器与组件，仅创建临时浏览器文档。
async function setup(page: Page) {
 await page.goto('http://127.0.0.1:5194');
 await page.evaluate(async () => {
  // @ts-ignore
  const E = await import('/src/composables/useEditor.ts');
  // @ts-ignore
  const D = await import('/src/core/document.ts');
  // @ts-ignore
  const P = await import('/src/core/pixels.ts');
  const d = D.createDocument(64, 64, '审查临时文档');
  d.layers = [D.createPixelLayer('底层', P.createBuffer(64,64,[255,0,0,255])), D.createPixelLayer('顶层', P.createBuffer(64,64,[0,0,255,128]))];
  d.activeLayerId=d.layers[1].id; E.openDocument(d); d.dirty=false;
 });
}
for (const command of ['newLayer','duplicateLayer','group','ungroup','mergeDown','deleteLayer']) {
 test(command+' 的撤销重做恢复图层对象、像素、父引用和活动层', async ({page}) => {
  await setup(page);
  const result=await page.evaluate(async command=>{
   // @ts-ignore
   const E=await import('/src/composables/useEditor.ts');
   if(command==='ungroup') await E.commands.run('group',E.api.doc.layers.map((l:any)=>l.id));
   const capture=()=>JSON.stringify({active:E.api.doc.activeLayerId,layers:E.api.doc.layers.map((l:any)=>({id:l.id,parent:l.parentId,kind:l.kind,pixels:l.pixels?Array.from(l.pixels.data):null}))});
   const before=capture(); await E.commands.run(command,command==='group'?E.api.doc.layers.map((l:any)=>l.id):undefined);
   const after=capture(); await E.commands.run('undo'); const undone=capture(); await E.commands.run('redo');
   return {changed:before!==after,undo:undone===before,redo:capture()===after};
  },command);
  expect(result).toEqual({changed:true,undo:true,redo:true});
 });
}
test('关闭未保存标签取消时保留，确认时只关闭原标签',async({page})=>{
 await setup(page);
 await page.evaluate(async()=>{
  // @ts-ignore
  const E=await import('/src/composables/useEditor.ts');E.api.doc.dirty=true;
  (window as any).otools={dialog:{confirm:async()=>false}};
 });
 await page.locator('.tabs .close').click();await expect(page.locator('.tabs .tab')).toHaveCount(1);
 await page.evaluate(()=>{(window as any).otools.dialog.confirm=()=>new Promise(resolve=>{(window as any).answerClose=resolve;});});
 await page.locator('.tabs .close').click();await expect.poll(()=>page.evaluate(()=>typeof (window as any).answerClose)).toBe('function');
 await page.locator('.add-tab').click();await page.evaluate(()=>{(window as any).answerClose(true);});
 await expect(page.locator('.tabs .tab')).toHaveCount(1);await expect(page.locator('.tabs .tab')).not.toContainText('审查临时文档');
});
test('面板缺省只删除活动层，切换文档不沿用旧选择',async({page})=>{
 await setup(page);await page.locator('.layers-panel .panel-bar').getByRole('button',{name:'删除',exact:true}).click();
 await expect(page.locator('.layer-row')).toHaveCount(1);await expect(page.locator('.layer-row')).toContainText('底层');
 await page.locator('.layer-row').click();await page.locator('.add-tab').click();
 await page.locator('.layers-panel .panel-bar').getByRole('button',{name:'删除',exact:true}).click();
 await expect(page.locator('.layer-row')).toHaveCount(0);
});
test('属性、可见性、重命名以及撤销重做标记未保存，视口选择不标记',async({page})=>{
 await setup(page);await page.locator('.layer-row').first().click();
 const dirty=()=>page.evaluate(async()=>{ // @ts-ignore
  const E=await import('/src/composables/useEditor.ts');return E.api.doc.dirty;
 });
 const clean=()=>page.evaluate(async()=>{ // @ts-ignore
  const E=await import('/src/composables/useEditor.ts');E.api.doc.dirty=false;
 });
 expect(await dirty()).toBe(false);
 await page.locator('.props .grid input').first().fill('12');await page.locator('.props .grid input').first().press('Tab');expect(await dirty()).toBe(true);
 await clean();await page.locator('.layer-row').first().locator('.icon-btn').first().click();expect(await dirty()).toBe(true);
 await clean();await page.locator('.layer-row .name').first().dblclick();await page.locator('.layer-row input').fill('重命名');await page.locator('.layer-row input').press('Enter');expect(await dirty()).toBe(true);
 await clean();await page.evaluate(async()=>{ // @ts-ignore
  const E=await import('/src/composables/useEditor.ts');await E.commands.run('undo');
 });expect(await dirty()).toBe(true);
 await clean();await page.evaluate(async()=>{ // @ts-ignore
  const E=await import('/src/composables/useEditor.ts');await E.commands.run('redo');
 });expect(await dirty()).toBe(true);
});
test('行更多菜单只给点击行添加蒙版及删除该行',async({page})=>{
 await setup(page);const bottom=page.locator('.layer-row').filter({hasText:'底层'});
 await bottom.locator('.more').click();await page.getByRole('menuitem',{name:'添加图层蒙版',exact:true}).click();
 await expect(bottom.locator('.badge')).toHaveCount(1);await expect(page.locator('.layer-row').filter({hasText:'顶层'}).locator('.badge')).toHaveCount(0);
 await page.locator('.layer-row').filter({hasText:'顶层'}).click();await bottom.locator('.more').click();await page.getByRole('menuitem',{name:'删除图层',exact:true}).click();
 await expect(page.locator('.layer-row')).toHaveCount(1);await expect(page.locator('.layer-row')).toContainText('顶层');
});
test('复制嵌套组包含全部子孙与蒙版，像素独立且能完整撤销重做',async({page})=>{
 await setup(page);const result=await page.evaluate(async()=>{
  // @ts-ignore
  const E=await import('/src/composables/useEditor.ts'); // @ts-ignore
  const D=await import('/src/core/document.ts'); // @ts-ignore
  const P=await import('/src/core/pixels.ts');
  const d=E.api.doc,g=D.createGroupLayer('组'),nested=D.createGroupLayer('子组',g.id);
  d.layers[0].parentId=nested.id;d.layers[1].parentId=g.id;d.layers[1].clipping=true;d.layers[0].mask={pixels:P.createMask(64,64,255),enabled:true,linked:true,placement:null,target:'image',inverted:false};
  d.layers.push(nested,g);d.activeLayerId=g.id;const original=d.layers.map((l:any)=>l.id);
  await E.commands.run('duplicateLayer');const copyId=d.activeLayerId;const copies=d.layers.filter((l:any)=>!original.includes(l.id));
  const parentsValid=copies.every((l:any)=>l.id===copyId || copies.some((p:any)=>p.id===l.parentId));
  const pixelCopy=copies.find((l:any)=>l.pixels&&l.mask);const independent=!!pixelCopy&&pixelCopy.pixels.data!==d.layers[0].pixels.data&&pixelCopy.mask.pixels.data!==d.layers[0].mask.pixels.data;
  await E.commands.run('undo');const undo=d.layers.length===4;await E.commands.run('redo');
  return {copies:copies.length,parentsValid,independent,undo,redo:d.layers.length===8};
 });expect(result).toEqual({copies:4,parentsValid:true,independent:true,undo:true,redo:true});
});

test('结构历史与画布尺寸历史交错时不复用已被修改的图层对象',async({page})=>{
 await setup(page);const result=await page.evaluate(async()=>{ // @ts-ignore
  const E=await import('/src/composables/useEditor.ts');await E.commands.run('newLayer');const id=E.api.activeLayer().id;
  await E.commands.run('imageSize',{width:128,height:128});await E.commands.run('undo');await E.commands.run('undo');await E.commands.run('redo');
  return{width:E.api.doc.width,size:E.api.doc.layers.find((l:any)=>l.id===id).transform.size};
 });expect(result).toEqual({width:64,size:[64,64]});
});

test('图层可见性历史在结构撤销重做后仍操作当前图层',async({page})=>{
 await setup(page);await page.locator('.layers-panel .panel-bar').getByRole('button',{name:'新建',exact:true}).click();
 await page.locator('.layer-row').first().locator('.icon-btn').first().click();
 const result=await page.evaluate(async()=>{ // @ts-ignore
  const E=await import('/src/composables/useEditor.ts');const id=E.api.activeLayer().id;
  await E.commands.run('undo');await E.commands.run('undo');await E.commands.run('redo');await E.commands.run('redo');
  return E.api.doc.layers.find((l:any)=>l.id===id).isVisible;
 });expect(result).toBe(false);
});
