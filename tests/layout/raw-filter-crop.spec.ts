import { expect, test, type Page } from '@playwright/test';
// @ts-ignore 独立测试浏览器/内存文件系统，不操作真实用户文件。
import { pageFor } from '../../scripts/audit/harness.mjs';

async function prepare(page:Page,options:{depth?:8|16;transform?:unknown;mask?:'linked'|'independent'|'different-grid'}={}) {
  await page.evaluate(async options=>{
    const {E,D,P}= (window as any).A,d=D.createDocument(48,48,'RAW几何测试',options.depth??8);
    const b=P.createBuffer(8,6,undefined,options.depth??8);
    for(let y=0;y<6;y++)for(let x=0;x<8;x++)b.data.set([30+x*5,40+y*6,80,255],(y*8+x)*4);
    const layer=D.createPixelLayer('图像',b);layer.transform.sampling='Nearest';
    if(options.transform)Object.assign(layer.transform,options.transform);
    if(options.mask){D.addLayerMask(layer,8,6,options.depth??8);layer.mask.target='image';
      if(options.mask==='different-grid')layer.mask.pixels=P.createMask(16,12,255,options.depth??8);
      for(let i=0;i<layer.mask.pixels.data.length;i++)layer.mask.pixels.data[i]=40+i%150;
      if(options.mask==='independent'){layer.mask.linked=false;layer.mask.placement={x:11,y:17,width:12,height:10,rotation:30,flipX:true,sampling:'Nearest'};}
    }
    d.layers=[layer];d.activeLayerId=layer.id;E.openDocument(d);d.dirty=false;
    const path='/src/composables/filterSession.ts';const url=performance.getEntriesByType('resource').findLast((e:any)=>new URL(e.name).pathname===path)?.name??path;
    const F=await import(url);(window as any).rawRepair={F,docId:d.id,layerId:layer.id};
  },options);
}

for(const depth of [8,16])test(`RAW裁剪同步位置尺寸并保留像素${depth}位`,async({browser})=>{
 const page=await pageFor(browser);try{await prepare(page,{depth});const result=await page.evaluate(()=>{const {E}= (window as any).A,{F}= (window as any).rawRepair;const session=F.createFilterSession(E.api,'cameraRaw');session.raw={...session.raw,cropLeft:2,cropTop:1,cropRight:1,cropBottom:1};const before=E.api.snapshotLayer(E.api.activeLayer().id);const preview=F.filterPreview(session);const previewOnly=JSON.stringify(E.api.snapshotLayer(E.api.activeLayer().id))===JSON.stringify(before);session.apply(preview);const after=E.api.activeLayer();return{previewOnly,width:after.pixels.width,height:after.pixels.height,origin:after.transform.origin,size:after.transform.size,rgba:Array.from(after.pixels.data.slice(0,4)),bitDepth:after.pixels.bitDepth,canvas:[E.api.doc.width,E.api.doc.height]};});expect(result).toEqual({previewOnly:true,width:5,height:4,origin:[2,1],size:[5,4],rgba:[40,46,80,255],bitDepth:depth,canvas:[48,48]});}finally{await page.close();}
});

for(const [name,patch,origin] of [
 ['缩放',{origin:[10,20],size:[16,12]},[14,22]],
 ['旋转90°',{origin:[10,20],size:[16,12],rotation:90},[13,23]],
 ['水平翻转',{origin:[10,20],size:[16,12],flipX:true},[12,22]],
 ['旋转并翻转',{origin:[10,20],size:[16,12],rotation:90,flipX:true},[13,21]],
] as const)test(`RAW裁剪不移动保留区域：${name}`,async({browser})=>{
 const page=await pageFor(browser);try{await prepare(page,{transform:patch});const result=await page.evaluate(()=>{const {E}= (window as any).A,F=(window as any).rawRepair.F,session=F.createFilterSession(E.api,'cameraRaw');session.raw={...session.raw,cropLeft:2,cropTop:1,cropRight:1,cropBottom:1};session.apply(F.filterPreview(session));return E.api.activeLayer().transform;});expect(result.origin[0]).toBeCloseTo(origin[0],8);expect(result.origin[1]).toBeCloseTo(origin[1],8);expect(result.size).toEqual([10,8]);expect(result.rotation).toBe((patch as any).rotation??0);expect(result.flipX).toBe((patch as any).flipX??false);}finally{await page.close();}
});

test('RAW裁剪扭曲图层后角点和内部像素保持原文档映射',async({browser})=>{
 const page=await pageFor(browser);try{await prepare(page,{transform:{origin:[10,20],size:[16,12],rotation:25,flipX:true,warp:[{x:.1,y:.05},{x:.9,y:0},{x:1.1,y:1},{x:0,y:1.2}]}});const result=await page.evaluate(async()=>{const {E}= (window as any).A,F=(window as any).rawRepair.F; // @ts-ignore
 const G=await import('/src/core/geometry.ts');const before=G.layerMatrix(E.api.activeLayer().transform,8,6),session=F.createFilterSession(E.api,'cameraRaw');session.raw={...session.raw,cropLeft:2,cropTop:1,cropRight:1,cropBottom:1};session.apply(F.filterPreview(session));const after=G.layerMatrix(E.api.activeLayer().transform,5,4);return [[0,0],[5,0],[5,4],[0,4],[2.5,2],[1,3]].map(([x,y])=>({old:G.applyMatrix(before,x!+2,y!+1),next:G.applyMatrix(after,x!,y!)}));});for(const p of result){expect(p.next.x).toBeCloseTo(p.old.x,7);expect(p.next.y).toBeCloseTo(p.old.y,7);}}finally{await page.close();}
});

for(const mask of ['linked','different-grid','independent'] as const)for(const depth of [8,16])test(`RAW裁剪保持${mask}蒙版覆盖${depth}位并可撤销重做`,async({browser})=>{
 const page=await pageFor(browser);try{await prepare(page,{depth,mask,transform:{origin:[10,20],size:[16,12],rotation:90,flipX:true}});const result=await page.evaluate(async()=>{
 const {E}= (window as any).A,F=(window as any).rawRepair.F,id=E.api.activeLayer().id;const before=E.api.snapshotLayer(id),position=E.currentHistory().position,session=F.createFilterSession(E.api,'cameraRaw');session.raw={...session.raw,cropLeft:2,cropTop:1,cropRight:1,cropBottom:1};session.apply(F.filterPreview(session));const after=E.api.snapshotLayer(id),afterPosition=E.currentHistory().position;
 await E.commands.run('undo');const undo=E.api.snapshotLayer(id);await E.commands.run('redo');const redo=E.api.snapshotLayer(id);
 const serial=(s:any)=>({pixels:Array.from(s.pixels.data),transform:s.transform,mask:{...s.mask,data:Array.from(s.mask.data)},maskState:s.maskState});
 return {before:serial(before),after:serial(after),undo:serial(undo),redo:serial(redo),historyDelta:afterPosition-position};});
 expect(result.historyDelta).toBe(1);expect(result.undo).toEqual(result.before);expect(result.redo).toEqual(result.after);
 if(mask==='independent'){expect(result.after.mask).toEqual(result.before.mask);expect(result.after.maskState).toEqual(result.before.maskState);}else{const factor=mask==='different-grid'?2:1;expect([result.after.mask.width,result.after.mask.height]).toEqual([5*factor,4*factor]);expect(result.after.maskState.linked).toBe(true);const expected=[];for(let y=0;y<4*factor;y++)for(let x=0;x<5*factor;x++){const mx=x+2*factor,my=y+factor;expected.push(result.before.mask.data[my*result.before.mask.width+mx]);}expect(result.after.mask.data).toEqual(expected);}
 }finally{await page.close();}
});

test('RAW裁剪后的选区颜色调整仍按原图坐标限制',async({browser})=>{
 const page=await pageFor(browser);try{await prepare(page);const result=await page.evaluate(()=>{const {E,P}= (window as any).A,F=(window as any).rawRepair.F;const selection=P.createMask(48,48,0);for(let y=0;y<6;y++)for(let x=4;x<8;x++)selection.data[y*48+x]=255;E.api.doc.selection={...selection,outline:null};const session=F.createFilterSession(E.api,'cameraRaw');session.raw={...session.raw,cropLeft:2,cropRight:1,exposure:1};session.apply(F.filterPreview(session));const data=E.api.activeLayer().pixels.data;return{size:[E.api.activeLayer().pixels.width,E.api.activeLayer().pixels.height],origin:E.api.activeLayer().transform.origin,outside:Array.from(data.slice(0,4)),inside:Array.from(data.slice(8,12)),selection:Array.from(E.api.doc.selection.data)};});expect(result.size).toEqual([5,6]);expect(result.origin).toEqual([2,0]);expect(result.outside).toEqual([40,40,80,255]);expect(result.inside[0]).toBeGreaterThan(50);}finally{await page.close();}
});

test('RAW无裁剪保持原变换，取消裁剪预览不产生历史',async({browser})=>{
 const page=await pageFor(browser);try{await prepare(page,{transform:{origin:[10,20],size:[16,12],rotation:90,flipX:true}});const before=await page.evaluate(()=>{const {E}=(window as any).A;return{layer:E.api.snapshotLayer(E.api.activeLayer().id),position:E.currentHistory().position};});await page.evaluate(()=>(window as any).A.E.commands.run('openFilter','cameraRaw'));const geometry=page.locator('.raw-group').filter({has:page.getByRole('heading',{name:'几何',exact:true})});await geometry.locator('input').first().fill('2');await geometry.locator('input').first().press('Tab');await page.getByRole('button',{name:'取消',exact:true}).click();const cancelled=await page.evaluate(()=>{const {E}=(window as any).A;return{layer:E.api.snapshotLayer(E.api.activeLayer().id),position:E.currentHistory().position};});expect(cancelled).toEqual(before);const unchanged=await page.evaluate(()=>{const {E}=(window as any).A,F=(window as any).rawRepair.F,s=F.createFilterSession(E.api,'cameraRaw');const t=JSON.stringify(E.api.activeLayer().transform);s.raw.exposure=.5;s.apply(F.filterPreview(s));return JSON.stringify(E.api.activeLayer().transform)===t;});expect(unchanged).toBe(true);}finally{await page.close();}
});

test('RAW UI本地设置应用到几何而非读取会话旧设置',async({browser})=>{
 const page=await pageFor(browser);try{await prepare(page);await page.evaluate(()=>(window as any).A.E.commands.run('openFilter','cameraRaw'));const geometry=page.locator('.raw-group').filter({has:page.getByRole('heading',{name:'几何',exact:true})});await geometry.locator('input').nth(0).fill('2');await geometry.locator('input').nth(0).press('Tab');await page.getByRole('button',{name:'应用',exact:true}).click();const after=await page.evaluate(()=>{const {E}=(window as any).A,l=E.api.activeLayer();return{origin:l.transform.origin,size:l.transform.size,width:l.pixels.width,dialog:E.currentDialog.value};});expect(after).toEqual({origin:[2,0],size:[6,6],width:6,dialog:null});}finally{await page.close();}
});

for(const crop of [{cropLeft:8},{cropTop:7},{cropLeft:-1},{cropRight:NaN}])test(`RAW拒绝无效裁剪 ${JSON.stringify(crop)}`,async({browser})=>{
 const page=await pageFor(browser);try{await prepare(page);const result=await page.evaluate(crop=>{const {E}=(window as any).A,F=(window as any).rawRepair.F,before=JSON.stringify(E.api.snapshotLayer(E.api.activeLayer().id)),session=F.createFilterSession(E.api,'cameraRaw');Object.assign(session.raw,crop);let error='';try{session.apply(F.filterPreview(session));}catch(e){error=(e as Error).message;}return{error,unchanged:before===JSON.stringify(E.api.snapshotLayer(E.api.activeLayer().id)),history:E.currentHistory().position};},crop);expect(result.error).toContain('裁剪');expect(result.unchanged).toBe(true);expect(result.history).toBe(-1);}finally{await page.close();}
});

test('RAW UI无效裁剪显示错误并禁用应用',async({browser})=>{
 const page=await pageFor(browser);try{await prepare(page);await page.evaluate(()=>(window as any).A.E.commands.run('openFilter','cameraRaw'));const geometry=page.locator('.raw-group').filter({has:page.getByRole('heading',{name:'几何',exact:true})});await geometry.locator('input').first().fill('8');await geometry.locator('input').first().press('Tab');await expect(page.getByRole('alert')).toContainText('裁剪');await expect(page.getByRole('button',{name:'应用',exact:true})).toBeDisabled();expect(page.auditErrors).toEqual([]);}finally{await page.close();}
});

test('切换文档后迟到的滤镜应用不修改任何文档或历史',async({browser})=>{
 const page=await pageFor(browser);try{await prepare(page);const result=await page.evaluate(()=>{const {E,D,P}=(window as any).A,F=(window as any).rawRepair.F,original=E.api.doc,originalBefore=JSON.stringify(original),s=F.createFilterSession(E.api,'cameraRaw');s.raw.cropLeft=2;const preview=F.filterPreview(s);const other=D.createDocument(4,4,'另一个文档');other.layers=[D.createPixelLayer('另一层',P.createBuffer(4,4,[20,30,40,255]))];other.activeLayerId=other.layers[0].id;E.openDocument(other);const otherBefore=JSON.stringify(other);s.apply(preview);return{unchangedOriginal:JSON.stringify(original)===originalBefore,unchangedOther:JSON.stringify(other)===otherBefore,history:E.currentHistory().position,status:E.statusMessage.value};});expect(result.unchangedOriginal).toBe(true);expect(result.unchangedOther).toBe(true);expect(result.history).toBe(-1);expect(result.status).toMatch(/切换|失效|变化/);}finally{await page.close();}
});

test('RAW导入显影也安全显示无效裁剪，关闭后回滚临时层',async({browser})=>{
 const page=await pageFor(browser);try{await page.evaluate(()=>{(window as any).auditHost.openPath='/audit/input.dng';return (window as any).A.E.commands.run('openRaw');});const geometry=page.locator('.raw-group').filter({has:page.getByRole('heading',{name:'几何',exact:true})});await geometry.locator('input').first().fill('16');await geometry.locator('input').first().press('Tab');await expect(page.getByRole('alert')).toContainText('裁剪');await expect(page.getByRole('button',{name:'应用',exact:true})).toBeDisabled();await page.getByRole('button',{name:'关闭',exact:true}).click();expect(await page.evaluate(()=>(window as any).A.E.api.doc.layers.length)).toBe(2);expect(page.auditErrors).toEqual([]);}finally{await page.close();}
});

test('RAW同一预览只能应用一次，重复调用不再裁剪或添加历史',async({browser})=>{
 const page=await pageFor(browser);try{await prepare(page);const result=await page.evaluate(()=>{const {E}=(window as any).A,F=(window as any).rawRepair.F,s=F.createFilterSession(E.api,'cameraRaw');s.raw.cropLeft=2;const preview=F.filterPreview(s);s.apply(preview);const before=JSON.stringify(E.api.snapshotLayer(E.api.activeLayer().id)),position=E.currentHistory().position;s.apply(preview);return{unchanged:before===JSON.stringify(E.api.snapshotLayer(E.api.activeLayer().id)),delta:E.currentHistory().position-position};});expect(result).toEqual({unchanged:true,delta:0});}finally{await page.close();}
});

test('RAW裁剪后的图层几何和链接蒙版可以保存重开',async({browser})=>{
 const page=await pageFor(browser);try{await prepare(page,{mask:'linked',depth:16,transform:{origin:[10,20],size:[16,12],rotation:90,flipX:true}});const result=await page.evaluate(async()=>{const {E,IO,C}=(window as any).A,F=(window as any).rawRepair.F,s=F.createFilterSession(E.api,'cameraRaw');s.raw={...s.raw,cropLeft:2,cropTop:1,cropRight:1,cropBottom:1};s.apply(F.filterPreview(s));const before=E.api.snapshotLayer(E.api.activeLayer().id),compositeBefore=Array.from(C.compositeDocument(E.api.doc).buffer.data);await IO.saveCompProject(E.api.doc,'/audit/project.comp');const loaded=await IO.loadCompProject('/audit/project.comp'),l=loaded.layers[0];return{beforeTransform:before.transform,afterTransform:l.transform,beforeMask:Array.from(before.mask.data),afterMask:Array.from(l.mask.pixels.data),size:[l.pixels.width,l.pixels.height],maxError:Math.max(...Array.from(C.compositeDocument(loaded).buffer.data,(v:any,i:number)=>Math.abs(v-(compositeBefore[i] as number))))};});expect(result.afterTransform).toEqual(result.beforeTransform);expect(result.size).toEqual([5,4]);expect(result.afterMask).toEqual(result.beforeMask);expect(result.maxError).toBeLessThanOrEqual(1/257);}finally{await page.close();}
});
