import { test, expect } from '@playwright/test';
// 审计时已经在未修复基线上观察这些反例失败；现在纳入常规CI防止回归。
// @ts-ignore 独立浏览器/内存文件系统夹具，不访问真实用户文件。
import { pageFor, tiffFixture, tool, gesture } from '../../scripts/audit/harness.mjs';

test('ID路径与超大变换在任何写入之前被拒绝',async({browser})=>{
 const page=await pageFor(browser);try{const r=await page.evaluate(async()=>{const {IO}= (window as any).A,H=(window as any).auditHost;H.manifest.layers[0].id='../../bad';H.manifest.activeLayerID='../../bad';H.writeManifest();let rejected=false;try{await IO.loadCompProject('/audit/project.comp');}catch{rejected=true;}return{rejected,writes:H.writes.length};});expect(r).toEqual({rejected:true,writes:0});}finally{await page.close();}
});
for(const mode of ['Overlay','Hard Light','Soft Light','Pin Light'])test('标准混合数值 '+mode,async({browser})=>{
 const page=await pageFor(browser);try{const values=await page.evaluate(async mode=>{const mod=await import('/src/core/blend.ts');return mod.blendPixel([120,90,200],[210,50,80],mode as any);},mode);const expected:Record<string,number[]>={Overlay:[197,36,179],'Hard Light':[207,36,125],'Soft Light':[156,55,184],'Pin Light':[165,90,160]};values.forEach((v:number,i:number)=>expect(Math.abs(v-expected[mode]![i]!)).toBeLessThanOrEqual(2));}finally{await page.close();}
});
for(const kind of ['Gaussian Blur','Motion Blur'])test('空间调整进入合成且蒙版限制有效 '+kind,async({browser})=>{
 const page=await pageFor(browser);try{const r=await page.evaluate(async kind=>{const {E,D,C,hash,P}=(window as any).A,d=E.api.doc,before=hash(C.compositeDocument(d).buffer.data);await E.commands.run('addAdjustment',kind);const changed=hash(C.compositeDocument(d).buffer.data);D.addLayerMask(E.api.activeLayer(),64,64).data.fill(0);const masked=hash(C.compositeDocument(d).buffer.data);return{before,changed,masked};},kind);expect(r.changed).not.toBe(r.before);expect(r.masked).toBe(r.before);}finally{await page.close();}
});
for(const raw of [true,false])test('RAW中性灰不截白并保持三个通道中性 '+raw,async({browser})=>{
 const page=await pageFor(browser);try{const r=await page.evaluate(data=>{const {R}=(window as any).A,b=R.decodeRaw(Uint8Array.from(atob(data),c=>c.charCodeAt(0)).buffer).data;return Array.from(b.data.slice((6*16+6)*4,(6*16+6)*4+4));},tiffFixture({raw,bitDepth:16,constant:64}));expect(r).toEqual([64,64,64,255]);}finally{await page.close();}
});
for(const options of [{tile:true},{raw:true,compression:5}])test('TIFF分块与标准LZW DNG '+JSON.stringify(options),async({browser})=>{
 const page=await pageFor(browser);try{const r=await page.evaluate(async({data,raw})=>{const {R,I}=(window as any).A,bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));const b=raw?R.decodeRaw(bytes.buffer).data:await I.decodeImageBytes(bytes.buffer);return[b.width,b.height];},{data:tiffFixture(options),raw:options.raw});expect(r).toEqual([16,16]);}finally{await page.close();}
});
test('选区布尔操作只执行一次，羽化保留选区',async({browser})=>{
 const page=await pageFor(browser);try{await tool(page,'marquee',{feather:0});await gesture(page,[[20,20],[30,30]]);await gesture(page,[[25,20],[35,30]],{keys:['Shift']});await gesture(page,[[28,20],[38,30]],{keys:['Alt']});expect(await page.evaluate(()=>(window as any).A.E.api.doc.selection.data.filter((v:number)=>v>0).length)).toBe(80);await page.evaluate(()=>{const A=(window as any).A;A.E.api.setSelection(null);A.E.api.setToolOption('feather',3);});await gesture(page,[[20,20],[40,40]]);const r=await page.evaluate(()=>{const m=(window as any).A.E.api.doc.selection.data;return[m.some((v:number)=>v>0),m.some((v:number)=>v>0&&v<255)];});expect(r).toEqual([true,true]);}finally{await page.close();}
});
test('Shift画笔直线画出中点且撤销完整回放',async({browser})=>{
 const page=await pageFor(browser);try{await tool(page,'brush',{size:2,hardness:1,opacity:1});await gesture(page,[[22,22]],{click:true});const before=await page.evaluate(()=>(window as any).A.hash((window as any).A.E.api.activeLayer().pixels.data));await gesture(page,[[42,42]],{click:true,keys:['Shift']});const mid=await page.evaluate(()=>Array.from((window as any).A.E.api.activeLayer().pixels.data.slice((16*32+16)*4,(16*32+16)*4+4)));expect(mid).toEqual([0,255,0,255]);await page.keyboard.press('Control+KeyZ');expect(await page.evaluate(()=>(window as any).A.hash((window as any).A.E.api.activeLayer().pixels.data))).toBe(before);}finally{await page.close();}
});
test('深层子树移动只改变根父级，复制重映射内部父引用',async({browser})=>{
 const page=await pageFor(browser);try{const r=await page.evaluate(async()=>{const {E,D}=(window as any).A,d=E.api.doc,g=D.createGroupLayer('外组'),sub=D.createGroupLayer('内组',g.id),dest=D.createGroupLayer('目标');d.layers[1].parentId=sub.id;d.layers.push(g,sub,dest);await E.commands.run('moveLayerTo',{ids:[g.id],referenceId:dest.id,position:'inside'});return{root:g.parentId,sub:sub.parentId,leaf:d.layers.find((l:any)=>l.name==='前景').parentId,expected:[dest.id,g.id,sub.id]};});expect([r.root,r.sub,r.leaf]).toEqual(r.expected);}finally{await page.close();}
});
test('导入位图标脏且一次撤销删除导入层',async({browser})=>{
 const page=await pageFor(browser);try{const r=await page.evaluate(async()=>{const {E}=(window as any).A;await E.commands.run('openImage');const after={count:E.api.doc.layers.length,dirty:E.api.doc.dirty};await E.commands.run('undo');return{after,count:E.api.doc.layers.length};});expect(r).toEqual({after:{count:3,dirty:true},count:2});}finally{await page.close();}
});
test('取消RAW导入恢复原文档，应用后一条历史可撤销',async({browser})=>{
 const page=await pageFor(browser);try{await page.evaluate(()=>{(window as any).auditHost.openPath='/audit/input.dng';return (window as any).A.E.commands.run('openRaw');});await page.getByRole('button',{name:'关闭',exact:true}).click();expect(await page.evaluate(()=>(window as any).A.E.api.doc.layers.length)).toBe(2);await page.evaluate(()=>(window as any).A.E.commands.run('openRaw'));await page.getByRole('button',{name:'应用',exact:true}).click();expect(await page.evaluate(()=>(window as any).A.E.api.doc.dirty)).toBe(true);await page.keyboard.press('Control+KeyZ');expect(await page.evaluate(()=>(window as any).A.E.api.doc.layers.length)).toBe(2);}finally{await page.close();}
});
test('PSD报告先确认才打开文档，关闭报告不导入',async({browser})=>{
 const page=await pageFor(browser);try{await page.evaluate(()=>{(window as any).auditHost.openPath='/audit/input.psd';return (window as any).A.E.commands.run('openPsd');});expect(await page.evaluate(()=>(window as any).A.E.documents.value.length)).toBe(1);await page.getByRole('button',{name:'关闭',exact:true}).click();expect(await page.evaluate(()=>(window as any).A.E.documents.value.length)).toBe(1);await page.evaluate(()=>(window as any).A.E.commands.run('openPsd'));await page.getByRole('button',{name:'导入文档',exact:true}).click();expect(await page.evaluate(()=>(window as any).A.E.documents.value.length)).toBe(2);}finally{await page.close();}
});
test('滤镜预览不修改源，取消无历史，应用后可撤销',async({browser})=>{
 const page=await pageFor(browser);try{const hash=()=>page.evaluate(()=>(window as any).A.hash((window as any).A.E.api.activeLayer().pixels.data)),before=await hash();await page.evaluate(()=>(window as any).A.E.commands.run('openFilter','filterVignette'));await expect(page.getByAltText('实时预览')).toBeVisible();expect(await hash()).toBe(before);await page.getByRole('button',{name:'取消',exact:true}).click();expect(await hash()).toBe(before);await page.evaluate(()=>(window as any).A.E.commands.run('openFilter','filterVignette'));await page.getByRole('button',{name:'应用',exact:true}).click();expect(await hash()).not.toBe(before);await page.keyboard.press('Control+KeyZ');expect(await hash()).toBe(before);}finally{await page.close();}
});
test('键盘新建显示尺寸表单、CtrlT不新增反相层、JPEG格式与预览正确',async({browser})=>{
 const page=await pageFor(browser);try{await page.keyboard.press('Control+KeyN');await expect(page.getByRole('dialog',{name:'新建画布'})).toBeVisible();await page.getByRole('button',{name:'关闭',exact:true}).click();await page.keyboard.press('Control+KeyT');expect(await page.evaluate(()=>(window as any).A.E.api.doc.layers.length)).toBe(2);await page.keyboard.press('Control+Shift+Alt+KeyS');await expect(page.locator('.el-dialog:visible .el-select__selected-item:not(.is-hidden)').first()).toHaveText('JPEG');await expect(page.getByAltText('实时预览')).toBeVisible();}finally{await page.close();}
});
test('命令面板搜索并执行菜单动作',async({browser})=>{
 const page=await pageFor(browser);try{await page.keyboard.press('Control+KeyF');await page.getByRole('searchbox').fill('新建图层');await page.getByRole('searchbox').press('Enter');expect(await page.evaluate(()=>(window as any).A.E.api.doc.layers.length)).toBe(3);}finally{await page.close();}
});
test('数字透明度、硬度快捷键及冲突拒绝',async({browser})=>{
 const page=await pageFor(browser);try{await page.keyboard.press('Digit5');expect(await page.evaluate(()=>(window as any).A.E.api.activeLayer().opacity)).toBe(.5);await page.keyboard.press('Digit7');await page.keyboard.press('Digit5');expect(await page.evaluate(()=>(window as any).A.E.api.activeLayer().opacity)).toBe(.75);await tool(page,'brush',{hardness:.5});await page.evaluate(()=>document.activeElement instanceof HTMLElement&&document.activeElement.blur());await page.keyboard.press('Shift+BracketLeft');expect(await page.evaluate(()=>(window as any).A.E.api.option('hardness',0))).toBeCloseTo(.4);const r=await page.evaluate(()=>{const S=(window as any).A.S;const conflict=S.setShortcut('file.save',{...S.shortcutItems.find((i:any)=>i.id==='tool.brush').chord});return{conflict,key:S.shortcutItems.find((i:any)=>i.id==='file.save').chord.key};});expect(r.conflict).toBeTruthy();expect(r.key).toBe('s');}finally{await page.close();}
});
for(const width of [960,1440])test('RAW显影应用按钮始终在窗口内 '+width,async({browser})=>{
 const page=await pageFor(browser);try{await page.setViewportSize({width,height:768});await page.evaluate(()=>{(window as any).auditHost.openPath='/audit/input.dng';return (window as any).A.E.commands.run('openRaw');});const button=page.getByRole('button',{name:'应用',exact:true});await expect(button).toBeVisible();const bounds=await button.boundingBox();expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(768);}finally{await page.close();}
});

test('PSD全部24种混合模式不降级为Normal且往返外观不变',async({browser})=>{
 const page=await pageFor(browser);try{const failed=await page.evaluate(()=>{const {E,PSD,C,hash,Types}=(window as any).A;return Types.BLEND_MODES.flatMap((mode:string)=>{const d=(window as any).A.seed();E.api.activeLayer().blendMode=mode;const before=hash(C.compositeDocument(d).buffer.data),loaded=PSD.importPsd(PSD.exportPsd(d)).document;return before===hash(C.compositeDocument(loaded).buffer.data)&&loaded.layers[1].blendMode===mode?[]:[mode];});});expect(failed).toEqual([]);}finally{await page.close();}
});
