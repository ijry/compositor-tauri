import {test,expect} from '@playwright/test';

test.beforeEach(async({page})=>{
 await page.goto('http://127.0.0.1:5194');await page.evaluate(async()=>{
  // @ts-ignore
  const D=await import('/src/core/document.ts'); // @ts-ignore
  const P=await import('/src/core/pixels.ts'); // @ts-ignore
  const C=await import('/src/core/engine/compositor.ts'); // @ts-ignore
  const E=await import('/src/composables/useEditor.ts'); // @ts-ignore
  const F=await import('/src/core/filters/adjust.ts');
  const pixel=(name:string,w:number,h:number,color=[128,128,128,255])=>{const l=D.createPixelLayer(name,P.createBuffer(w,h,color));l.transform.sampling='Nearest';return l;};
  const open=(w:number,h:number,layers:any[],active=layers.at(-1)?.id)=>{const d=D.createDocument(w,h);d.layers=layers;d.activeLayerId=active;E.openDocument(d);d.dirty=false;return d;};
  const render=(d:any)=>Array.from(C.compositeDocument(d).buffer.data);
  (window as any).hierarchyReview={D,P,C,E,F,pixel,open,render};
 });
});

for(const command of ['filterAddNoise','filterVignette','filterBloom','filterTonalContrast','filterLensCorrection','filterRemoveBackground','filterSharpen','filterDenoise','filterDither'])test('空选区不执行 '+command,async({page})=>{
 const r=await page.evaluate(async command=>{const {pixel,open,P,E}=(window as any).hierarchyReview,l=pixel('图层',8,8),d=open(8,8,[l]);for(let i=0;i<64;i++)l.pixels.data[i*4]=(i*37)%256;d.selection={...P.createMask(8,8,0),outline:null};const before=Array.from(l.pixels.data).join(',');await E.commands.run(command);return{same:before===Array.from(l.pixels.data).join(','),dirty:d.dirty,history:E.currentHistory().position};},command);expect(r).toEqual({same:true,dirty:false,history:-1});
});
test('滤镜选区映射包含位移、旋转、翻转和缩放',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,P,E,F}=(window as any).hierarchyReview,l=pixel('变换层',2,2);l.transform={...l.transform,origin:[2,2],size:[4,4],rotation:90,flipX:true};const d=open(8,8,[l]);d.selection={...P.createMask(8,8,0),outline:null};for(let y=4;y<6;y++)for(let x=4;x<6;x++)d.selection.data[y*8+x]=255;const control=P.cloneBuffer(l.pixels);F.applyAddNoise(control,10,true,false,7,new Uint8Array([255,0,0,0]));await E.commands.run('filterAddNoise',{amount:10});return{actual:Array.from(l.pixels.data),expected:Array.from(control.data)};});expect(r.actual).toEqual(r.expected);
});
test('滤镜只应用一次灰度覆盖率并保持未选择像素',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,P,E,F}=(window as any).hierarchyReview,l=pixel('图层',2,2),d=open(2,2,[l]);d.selection={...P.createMask(2,2,0),outline:null};d.selection.data[0]=128;const control=P.cloneBuffer(l.pixels);F.applyAddNoise(control,10,true,false,7);await E.commands.run('filterAddNoise',{amount:10});const expected=[0,1,2].map(c=>Math.round(128*(1-128/255)+control.data[c]*128/255));return{actual:Array.from(l.pixels.data.slice(0,3)),expected,rest:Array.from(l.pixels.data.slice(4))};});expect(r.actual).toEqual(r.expected);expect(r.rest).toEqual([128,128,128,255,128,128,128,255,128,128,128,255]);
});
test('图像 Ctrl+I 只反相选区，并完整撤销重做',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,P,E}=(window as any).hierarchyReview,l=pixel('红层',2,2,[255,0,0,255]),d=open(2,2,[l]);d.selection={...P.createMask(2,2,0),outline:null};d.selection.data[0]=255;const before=Array.from(l.pixels.data);await E.commands.run('invertPixels');const after=Array.from(l.pixels.data),dirty=d.dirty;await E.commands.run('undo');const undone=Array.from(E.api.activeLayer().pixels.data).join(',')===before.join(',');await E.commands.run('redo');return{after,dirty,undone,redo:Array.from(E.api.activeLayer().pixels.data).join(',')===after.join(',')};});expect(r).toEqual({after:[0,255,255,255,255,0,0,255,255,0,0,255,255,0,0,255],dirty:true,undone:true,redo:true});
});
for(const kind of ['pixel','group','adjustment'])test(kind+' 蒙版 Ctrl+I 遵守选区且有历史',async({page})=>{
 const r=await page.evaluate(async kind=>{const {pixel,open,D,P,E}=(window as any).hierarchyReview,l=kind==='pixel'?pixel('图层',2,2):kind==='group'?D.createGroupLayer('组'):D.createAdjustmentLayer('Invert',D.createDocument(2,2));D.addLayerMask(l,2,2);l.mask.pixels.data.set([0,64,128,255]);const d=open(2,2,[l]);d.selection={...P.createMask(2,2,0),outline:null};d.selection.data[0]=255;await E.commands.run('invertPixels');const after=Array.from(l.mask.pixels.data),dirty=d.dirty,history=E.currentHistory().canUndo;await E.commands.run('undo');const undone=Array.from(E.api.activeLayer().mask.pixels.data);await E.commands.run('redo');return{after,dirty,history,undone,redo:Array.from(E.api.activeLayer().mask.pixels.data)};},kind);expect(r).toEqual({after:[255,64,128,255],dirty:true,history:true,undone:[0,64,128,255],redo:[255,64,128,255]});
});
for(const state of ['empty','locked','disabled'])test('反相在 '+state+' 状态下不改写数据和历史',async({page})=>{
 const r=await page.evaluate(async state=>{const {pixel,open,D,P,E}=(window as any).hierarchyReview,l=pixel('图层',2,2),d=open(2,2,[l]);if(state==='empty')d.selection={...P.createMask(2,2,0),outline:null};if(state==='locked')l.locked=true;if(state==='disabled'){D.addLayerMask(l,2,2);l.mask.enabled=false;}const before=JSON.stringify({pixels:Array.from(l.pixels.data),mask:l.mask?Array.from(l.mask.pixels.data):null});await E.commands.run('invertPixels');return{same:before===JSON.stringify({pixels:Array.from(l.pixels.data),mask:l.mask?Array.from(l.mask.pixels.data):null}),dirty:d.dirty,history:E.currentHistory().canUndo};},state);expect(r).toEqual({same:true,dirty:false,history:false});
});
test('蒙版开关改变画面时标记未保存并可撤销重做',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,D,E,render}=(window as any).hierarchyReview,l=pixel('图层',2,2);D.addLayerMask(l,2,2).data.fill(0);const d=open(2,2,[l]);await E.commands.run('toggleMask');const after=render(d)[3],dirty=d.dirty;await E.commands.run('undo');const undone=render(d)[3];await E.commands.run('redo');return{after,dirty,undone,redo:render(d)[3]};});expect(r).toEqual({after:255,dirty:true,undone:0,redo:255});
});
for(const command of ['toggleClipping','toggleVisibility','toggleMask'])test(command+' 与结构历史交错后重做作用于新对象',async({page})=>{
 const r=await page.evaluate(async command=>{const {pixel,open,D,E}=(window as any).hierarchyReview,l=pixel('底层',2,2);D.addLayerMask(l,2,2);const d=open(2,2,[l]);await E.commands.run('duplicateLayer');const id=d.activeLayerId;const value=()=>{const target=d.layers.find((l:any)=>l.id===id);return command==='toggleMask'?target.mask.enabled:command==='toggleVisibility'?target.isVisible:target.clipping;};const before=value();await E.commands.run(command);await E.commands.run('undo');await E.commands.run('undo');await E.commands.run('redo');await E.commands.run('redo');return{before,after:value()};},command);expect(r.after).toBe(!r.before);
});
test('上移相邻图层不是原地插回，撤销重做恢复次序',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,E}=(window as any).hierarchyReview,a=pixel('A',2,2),b=pixel('B',2,2),c=pixel('C',2,2),d=open(2,2,[a,b,c],a.id);await E.commands.run('moveLayerUp');const moved=d.layers.map((l:any)=>l.name);await E.commands.run('undo');const undone=d.layers.map((l:any)=>l.name);await E.commands.run('redo');return{moved,undone,redo:d.layers.map((l:any)=>l.name)};});expect(r).toEqual({moved:['B','A','C'],undone:['A','B','C'],redo:['B','A','C']});
});
for(const direction of ['moveLayerUp','moveLayerDown'])test(direction+' 移动组时面板顺序和完整合成一致',async({page})=>{
 const r=await page.evaluate(async direction=>{const {pixel,open,D,E,render}=(window as any).hierarchyReview,a=D.createGroupLayer('红组'),b=D.createGroupLayer('蓝组'),nested=D.createGroupLayer('内组',a.id),red=pixel('红子层',2,2,[255,0,0,255]),blue=pixel('蓝子层',2,2,[0,0,255,255]);red.parentId=nested.id;blue.parentId=b.id;const d=open(2,2,[red,nested,a,blue,b],direction==='moveLayerUp'?a.id:b.id);await E.commands.run(direction);const color=render(d).slice(0,4),parent=d.layers.find((l:any)=>l.id===red.id).parentId;await E.commands.run('undo');const undone=render(d).slice(0,4);await E.commands.run('redo');return{color,parentOk:parent===nested.id,undone,redo:render(d).slice(0,4)};},direction);expect(r).toEqual({color:[255,0,0,255],parentOk:true,undone:[0,0,255,255],redo:[255,0,0,255]});await expect(page.locator('.layer-row .name').first()).toHaveText('红组');
});
test('非连续子层按层级而非扁平数组合成，折叠不隐藏画面',async({page})=>{
 const r=await page.evaluate(()=>{const {pixel,open,D,render}=(window as any).hierarchyReview,a=D.createGroupLayer('红组'),b=D.createGroupLayer('蓝组'),red=pixel('红子层',2,2,[255,0,0,255]),blue=pixel('蓝子层',2,2,[0,0,255,255]);red.parentId=a.id;blue.parentId=b.id;a.expanded=false;return render(open(2,2,[red,blue,b,a],a.id)).slice(0,4);});expect(r).toEqual([255,0,0,255]);await expect(page.locator('.layer-row .name')).toHaveText(['红组','蓝组','蓝子层']);
});
test('从选区生成蒙版正确投影，并把选区与蒙版作为一次历史',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,P,E,render}=(window as any).hierarchyReview,l=pixel('偏移层',2,2,[255,0,0,255]);l.transform.origin=[2,2];const d=open(8,8,[l]);d.selection={...P.createMask(8,8,0),outline:null};for(let y=2;y<4;y++)for(let x=2;x<4;x++)d.selection.data[y*8+x]=255;await E.commands.run('maskFromSelection');const mask=Array.from(l.mask.pixels.data),cleared=d.selection===null,visible=render(d).filter((v:number,i:number)=>i%4===3&&v>0).length;await E.commands.run('undo');const undone=!E.api.activeLayer().mask&&!!d.selection;await E.commands.run('redo');return{mask,cleared,visible,undone,redo:!!E.api.activeLayer().mask&&d.selection===null};});expect(r).toEqual({mask:[255,255,255,255],cleared:true,visible:4,undone:true,redo:true});
});

test('选区生成蒙版后再加载选区，保持原文档位置而非铺满全图',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,P,E}=(window as any).hierarchyReview,l=pixel('偏移层',2,2);l.transform.origin=[2,2];const d=open(8,8,[l]);d.selection={...P.createMask(8,8,0),outline:null};for(let y=2;y<4;y++)for(let x=2;x<4;x++)d.selection.data[y*8+x]=255;const expected=Array.from(d.selection.data);await E.commands.run('maskFromSelection');l.mask.enabled=false;await E.commands.run('loadMaskAsSelection');return{actual:Array.from(d.selection.data),expected,enabled:l.mask.enabled};});expect(r.actual).toEqual(r.expected);expect(r.enabled).toBe(false);
});
for(const kind of ['group','adjustment'])test('从选区生成 '+kind+' 蒙版使用实际文档网格',async({page})=>{
 const r=await page.evaluate(async kind=>{const {pixel,open,D,P,E}=(window as any).hierarchyReview,l=kind==='group'?D.createGroupLayer('组'):D.createAdjustmentLayer('Invert',D.createDocument(8,8));const d=open(8,8,[l]);d.selection={...P.createMask(8,8,0),outline:null};d.selection.data[3*8+2]=255;await E.commands.run('maskFromSelection');return{size:[l.mask.pixels.width,l.mask.pixels.height],hit:l.mask.pixels.data[3*8+2],count:l.mask.pixels.data.filter((v:number)=>v>0).length};},kind);expect(r).toEqual({size:[8,8],hit:255,count:1});
});
