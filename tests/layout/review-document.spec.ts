import { test, expect } from '@playwright/test';
test('画布尺寸撤销重做完整恢复，蒙版反相即时预览', async({page})=>{
 await page.goto('http://127.0.0.1:5194');
 const result=await page.evaluate(async()=>{
  // @ts-ignore 在隔离 Vite 服务中使用真实编辑器模块。
  const E=await import('/src/composables/useEditor.ts');
  // @ts-ignore
  const D=await import('/src/core/document.ts');
  // @ts-ignore
  const P=await import('/src/core/pixels.ts');
  const doc=D.createDocument(64,32);doc.layers.push(D.createPixelLayer('red',P.createBuffer(64,32,[255,0,0,255])));doc.activeLayerId=doc.layers[0].id;E.openDocument(doc);
  await E.commands.run('imageSize',{width:128,height:64});await E.commands.run('undo');const undo=[doc.width,doc.height];await E.commands.run('redo');const redo=[doc.width,doc.height];
  await E.commands.run('addMask');await E.commands.run('undo');const noMask=!doc.layers[0].mask;await E.commands.run('redo'); E.api.setViewport({zoom:1,centerX:64,centerY:32});
  return {undo,redo,noMask};
 });
 expect(result).toEqual({undo:[64,32],redo:[128,64],noMask:true});
 await expect(page.locator('canvas.main')).toBeVisible();
 await page.evaluate(async()=>{ // @ts-ignore
 const E=await import('/src/composables/useEditor.ts'); E.api.setViewport({zoom:1,centerX:64,centerY:32});});
 await expect.poll(()=>page.locator('canvas.main').evaluate((el:any)=>Array.from(el.getContext('2d').getImageData(el.width/2,el.height/2,1,1).data))).toEqual([255,0,0,255]);
 await page.evaluate(async()=>{ // @ts-ignore
 const E=await import('/src/composables/useEditor.ts');await E.commands.run('invertMask');});
 await expect.poll(()=>page.locator('canvas.main').evaluate((el:any)=>Array.from(el.getContext('2d').getImageData(el.width/2,el.height/2,1,1).data).slice(0,3).join(','))).not.toBe('255,0,0');
});
test('文字点击可见、参数修改生效、可创建第二层且可撤销',async({page})=>{
 await page.goto('http://127.0.0.1:5194');await page.locator('.card.primary').click();await page.getByRole('button',{name:'创建',exact:true}).click();
 await page.locator('.cmp-toolbar button[title^="文字"]').click();
 const content=page.locator('.cmp-tool-header .el-input__inner').first();await content.fill('Hello');
 const box=(await page.locator('.cmp-stage').boundingBox())!;await page.mouse.click(box.x+200,box.y+120);
 const text=()=>page.evaluate(async()=>{ // @ts-ignore
 const E=await import('/src/composables/useEditor.ts');const l=E.api.activeLayer();return {text:l.text?.content,alpha:l.pixels.data.some((v:number,i:number)=>i%4===3&&v>0),color:l.text?.color,count:E.api.doc.layers.length};});
 expect(await text()).toMatchObject({text:'Hello',alpha:true,color:[0,0,0]});
 await content.fill('Updated');await expect.poll(async()=>(await text()).text).toBe('Updated');
 await page.mouse.click(box.x+350,box.y+250);expect((await text()).count).toBe(3);
 await page.evaluate(async()=>{ // @ts-ignore
 const E=await import('/src/composables/useEditor.ts');await E.commands.run('undo');});
 expect((await text()).count).toBe(2);
});
test('画笔参数显示实际值并正确换算百分比',async({page})=>{
 await page.goto('http://127.0.0.1:5194');await page.locator('.card.primary').click();await page.getByRole('button',{name:'创建',exact:true}).click();await page.locator('.cmp-toolbar button[title^="画笔"]').click();
 const numbers=page.locator('.cmp-tool-header input[type=number]');await expect(numbers.nth(0)).toHaveValue('40');await expect(numbers.nth(2)).toHaveValue('100');
 await numbers.nth(2).fill('50');await numbers.nth(2).press('Tab');
 const opacity=await page.evaluate(async()=>{ // @ts-ignore
 const E=await import('/src/composables/useEditor.ts');return E.api.option('opacity',0);});expect(opacity).toBe(0.5);
});

test('画布文字框可直接输入，多次点击已有文字不重复新建',async({page})=>{
 await page.goto('http://127.0.0.1:5194');await page.locator('.card.primary').click();await page.getByRole('button',{name:'创建',exact:true}).click();await page.locator('.cmp-toolbar button[title^="文字"]').click();
 const box=(await page.locator('.cmp-stage').boundingBox())!;await page.mouse.click(box.x+150,box.y+120);
 const input=page.getByRole('textbox',{name:'编辑画布文字'});await expect(input).toBeVisible();await input.fill('画布直接输入');await input.press('Control+Enter');
 const data=await page.evaluate(async()=>{ // @ts-ignore
 const E=await import('/src/composables/useEditor.ts');return {text:E.api.activeLayer().text.content,count:E.api.doc.layers.length};});expect(data).toEqual({text:'画布直接输入',count:2});
 await page.screenshot({path:'test-results/review-text-fixed.png'});
 await page.mouse.click(box.x+155,box.y+125);await expect(input).toBeVisible();expect(await page.locator('.layer-row').count()).toBe(2);
});

test('通过菜单给组添加白蒙版不隐藏内容，反相后全部隐藏',async({page})=>{
 await page.goto('http://127.0.0.1:5194');const result=await page.evaluate(async()=>{ // @ts-ignore
 const E=await import('/src/composables/useEditor.ts'); // @ts-ignore
 const D=await import('/src/core/document.ts'); // @ts-ignore
 const P=await import('/src/core/pixels.ts'); // @ts-ignore
 const {compositeDocument}=await import('/src/core/engine/compositor.ts');
 const d=D.createDocument(16,16),g=D.createGroupLayer('组'),l=D.createPixelLayer('red',P.createBuffer(16,16,[255,0,0,255]));l.parentId=g.id;d.layers.push(g,l);d.activeLayerId=g.id;E.openDocument(d);
 await E.commands.run('addMask');const white=compositeDocument(d).buffer.data[(8*16+8)*4+3];await E.commands.run('invertMask');const black=compositeDocument(d).buffer.data[(8*16+8)*4+3];return {white,black};
 });expect(result).toEqual({white:255,black:0});
});

// 已保存文字再次修改必须提示保存，防止关闭标签时静默丢失编辑。
test('修改已保存的文字会标记未保存且支持撤销重做', async ({ page }) => {
 await page.goto('http://127.0.0.1:5194');
 const result = await page.evaluate(async () => {
  // @ts-ignore
  const E = await import('/src/composables/useEditor.ts');
  // @ts-ignore
  const D = await import('/src/core/document.ts');
  // @ts-ignore
  const T = await import('/src/tools/transform.ts');
  E.openDocument(D.createDocument(256, 256));
  T.commitText(E.api, { x: 10, y: 10, width: 1, height: 1 });
  const layer = E.api.activeLayer(); const original = layer.text.content;
  E.api.doc.dirty = false; E.api.doc.updatedAt = 1;
  T.updateTextLayer(E.api, layer.id, { content: '保存后的新文字' });
  const dirty = E.api.doc.dirty; const touched = E.api.doc.updatedAt > 1;
  await E.commands.run('undo'); const undone = E.api.activeLayer().text.content === original;
  await E.commands.run('redo'); const redone = E.api.activeLayer().text.content === '保存后的新文字';
  return { dirty, touched, undone, redone };
 });
 expect(result).toEqual({ dirty: true, touched: true, undone: true, redone: true });
});
