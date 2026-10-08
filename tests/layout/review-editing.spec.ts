import { test, expect } from '@playwright/test';

test.beforeEach(async ({page})=>{
 await page.goto('http://127.0.0.1:5194');
 await page.evaluate(async()=>{
  // @ts-ignore
  const D=await import('/src/core/document.ts'); // @ts-ignore
  const P=await import('/src/core/pixels.ts'); // @ts-ignore
  const C=await import('/src/core/engine/compositor.ts'); // @ts-ignore
  const E=await import('/src/composables/useEditor.ts'); // @ts-ignore
  const B=await import('/src/tools/paint.ts'); // @ts-ignore
  const F=await import('/src/core/filters/blur.ts'); // @ts-ignore
  const Types=await import('/src/types/document.ts');
  const pixel=(name:string,w:number,h:number,color=[255,0,0,255])=>{const l=D.createPixelLayer(name,P.createBuffer(w,h,color));l.transform.sampling='Nearest';return l;};
  const open=(w:number,h:number,layers:any[],active=layers.at(-1)?.id)=>{const d=D.createDocument(w,h);d.layers=layers;d.activeLayerId=active;E.openDocument(d);return d;};
  const render=(d:any)=>Array.from(C.compositeDocument(d).buffer.data);
  const blur=(x:number,y:number,target='pixels')=>{E.setTool('blur');E.api.setToolOption('size',4);E.api.setToolOption('strength',.5);E.api.setToolOption('hardness',1);E.api.setToolOption('target',target);const e={doc:{x,y},screen:{x,y},shift:false,alt:false,ctrl:false,meta:false,button:0,pressure:1};B.blurTool.onDown(E.api,e);B.blurTool.onUp(E.api,e);};
  (window as any).editingReview={D,P,C,E,B,F,Types,pixel,open,render,blur};
 });
});

test('多次粘贴的像素和剪贴板互不共享，清除后撤销不污染其他层',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,E}=(window as any).editingReview,d=open(2,2,[pixel('原图',2,2)]);await E.commands.run('copyMerged');await E.commands.run('paste');await E.commands.run('paste');const a=d.layers[1],b=d.layers[2],shared=a.pixels.data===b.pixels.data;await E.commands.run('clearSelection');const other=a.pixels.data[3];await E.commands.run('undo');const restored=E.api.activeLayer().pixels.data[3];await E.commands.run('paste');return{shared,other,restored,next:E.api.activeLayer().pixels.data[3]};});expect(r).toEqual({shared:false,other:255,restored:255,next:255});
});
test('普通复制取活动图层快照，保留图层属性而非复制遮挡层',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,E}=(window as any).editingReview,a=pixel('选中红层',2,2),b=pixel('蓝层',2,2,[0,0,255,255]);a.opacity=.6;a.transform.origin=[1,2];open(4,4,[a,b],a.id);await E.commands.run('copy');E.api.setForeground([0,255,0]);await E.commands.run('fillForeground');await E.commands.run('paste');const copy=E.api.activeLayer();return{pixel:Array.from(copy.pixels.data.slice(0,4)),opacity:copy.opacity,origin:copy.transform.origin};});expect(r).toEqual({pixel:[255,0,0,255],opacity:.6,origin:[1,2]});
});
test('复制合并裁剪选区并保留位置和软覆盖',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,P,E}=(window as any).editingReview,d=open(4,4,[pixel('原图',4,4)]);d.selection={...P.createMask(4,4,0),outline:null};d.selection.data[2*4+1]=128;await E.commands.run('copyMerged');await E.commands.run('paste');const l=E.api.activeLayer();return{size:[l.pixels.width,l.pixels.height],origin:l.transform.origin,pixel:Array.from(l.pixels.data)};});expect(r).toEqual({size:[1,1],origin:[1,2],pixel:[255,0,0,128]});
});
test('普通选区复制仅取活动层，剪切后可撤销并原位粘贴',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,P,E}=(window as any).editingReview,a=pixel('红层',4,4),b=pixel('蓝层',4,4,[0,0,255,255]),d=open(4,4,[a,b],a.id);d.selection={...P.createMask(4,4,0),outline:null};d.selection.data[5]=255;await E.commands.run('cut');const cleared=a.pixels.data[5*4+3];await E.commands.run('undo');const undo=E.api.activeLayer().pixels.data[5*4+3];await E.commands.run('paste');const l=E.api.activeLayer();return{cleared,undo,origin:l.transform.origin,size:[l.pixels.width,l.pixels.height],pixel:Array.from(l.pixels.data)};});expect(r).toEqual({cleared:0,undo:255,origin:[1,1],size:[1,1],pixel:[255,0,0,255]});
});
test('复制组跨文档粘贴包含子孙，父引用重映射且无共享缓冲',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,D,E}=(window as any).editingReview,g=D.createGroupLayer('组'),n=D.createGroupLayer('子组',g.id),l=pixel('子层',2,2);l.parentId=n.id;open(4,4,[l,n,g],g.id);await E.commands.run('copy');const next=open(4,4,[]);await E.commands.run('paste');const layers=next.layers;return{count:layers.length,groups:layers.filter((l:any)=>l.kind==='group').length,valid:layers.every((l:any)=>!l.parentId||layers.some((p:any)=>p.id===l.parentId)),independent:layers.find((l:any)=>l.pixels)?.pixels.data!==l.pixels.data};});expect(r).toEqual({count:3,groups:2,valid:true,independent:true});
});
test('空选区复制合并不会变成复制全图',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,P,E}=(window as any).editingReview,d=open(2,2,[pixel('原图',2,2)]);d.selection={...P.createMask(2,2,0),outline:null};await E.commands.run('copyMerged');await E.commands.run('paste');return d.layers.length;});expect(r).toBe(1);
});
for(const command of ['fillForeground','clearSelection'])test(command+' 使用完整变换映射文档选区',async({page})=>{
 const r=await page.evaluate(async command=>{const {pixel,open,P,E}=(window as any).editingReview,l=pixel('缩放层',2,2),d=open(4,4,[l]);l.transform.size=[4,4];d.selection={...P.createMask(4,4,0),outline:null};for(let y=2;y<4;y++)for(let x=2;x<4;x++)d.selection.data[y*4+x]=255;E.api.setForeground([0,255,0]);await E.commands.run(command);return{first:Array.from(l.pixels.data.slice(0,4)),selected:Array.from(l.pixels.data.slice(12,16))};},command);expect(r.first).toEqual([255,0,0,255]);expect(r.selected).toEqual(command==='fillForeground'?[0,255,0,255]:[255,0,0,0]);
});
test('灰度清除只降低 alpha，透明处填充不产生暗边',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,P,E}=(window as any).editingReview,l=pixel('层',2,2),d=open(2,2,[l]);d.selection={...P.createMask(2,2,128),outline:null};await E.commands.run('clearSelection');const cleared=Array.from(l.pixels.data.slice(0,4));l.pixels.data.fill(0);E.api.setForeground([255,0,0]);await E.commands.run('fillForeground');return{cleared,filled:Array.from(l.pixels.data.slice(0,4))};});expect(r).toEqual({cleared:[255,0,0,127],filled:[255,0,0,128]});
});
for(const kind of ['pixel','group','adjustment'])test(kind+' 蒙版填充清除只改变蒙版并可撤销',async({page})=>{
 const r=await page.evaluate(async kind=>{const {pixel,open,D,E}=(window as any).editingReview,l=kind==='pixel'?pixel('图层',4,4):kind==='group'?D.createGroupLayer('组'):D.createAdjustmentLayer('Invert',D.createDocument(4,4));open(4,4,[l]);await E.commands.run('addMask');const before=l.pixels?Array.from(l.pixels.data).join(','):'';E.api.setForeground([0,0,0]);E.api.setBackground([255,255,255]);await E.commands.run('fillForeground');const black=l.mask.pixels.data[0];await E.commands.run('clearSelection');const white=l.mask.pixels.data[0];await E.commands.run('undo');return{black,white,undo:l.mask.pixels.data[0],image:!l.pixels||before===Array.from(l.pixels.data).join(',')};},kind);expect(r).toEqual({black:0,white:255,undo:0,image:true});
});
test('模糊蒙版实际平滑灰度而不改写图像',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,D,E,blur}=(window as any).editingReview,l=pixel('图层',16,16);open(16,16,[l]);await E.commands.run('addMask');for(let y=0;y<16;y++)for(let x=0;x<8;x++)l.mask.pixels.data[y*16+x]=0;const before=Array.from(l.pixels.data).join(',');blur(8,12,'mask');const value=l.mask.pixels.data[12*16+8];await E.commands.run('undo');return{changed:value>0&&value<255,image:before===Array.from(l.pixels.data).join(','),undo:l.mask.pixels.data[12*16+8]};});expect(r).toEqual({changed:true,image:true,undo:255});
});
test('区域模糊保持纯色与透明度，越界和空区域不抛错',async({page})=>{
 const r=await page.evaluate(()=>{const {pixel,open,blur,F}=(window as any).editingReview,l=pixel('层',16,16,[0,0,255,255]);for(let y=0;y<8;y++)for(let x=0;x<16;x++)l.pixels.data.set([255,0,0,255],(y*16+x)*4);open(16,16,[l]);blur(8,12);const actual=Array.from(l.pixels.data.slice((12*16+8)*4,(12*16+8)*4+4));let safe=true;try{F.boxBlurRegion(l.pixels,{x:100,y:100,width:4,height:4},2);F.boxBlurRegion(l.pixels,{x:2,y:2,width:0,height:0},0);}catch{safe=false;}return{actual,safe};});expect(r).toEqual({actual:[0,0,255,255],safe:true});
});
test('所有混合模式在透明背景上保留源颜色',async({page})=>{
 const r=await page.evaluate(()=>{const {pixel,open,render,Types}=(window as any).editingReview;return Types.BLEND_MODES.map((mode:string)=>{const l=pixel(mode,2,2,[180,70,30,128]);l.blendMode=mode;return{mode,pixel:render(open(2,2,[l])).slice(0,4)};});});for(const item of r)expect(item.pixel,item.mode).toEqual([180,70,30,128]);
});
test('半透明正片叠底包含未覆盖背景部分的源颜色',async({page})=>{
 const r=await page.evaluate(()=>{const {pixel,open,render}=(window as any).editingReview,a=pixel('蓝底',2,2,[0,0,255,128]),b=pixel('红顶',2,2,[255,0,0,128]);b.blendMode='Multiply';return render(open(2,2,[a,b])).slice(0,4);});expect(r).toEqual([85,0,85,192]);
});
for(const opacity of [1,.5])test('剪贴栈共享基础 alpha，顶层 opacity='+opacity,async({page})=>{
 const r=await page.evaluate(opacity=>{const {pixel,open,render}=(window as any).editingReview,a=pixel('基础',2,2,[0,0,0,255]),b=pixel('剪贴',2,2);[255,128,32,0].forEach((v,i)=>a.pixels.data[i*4+3]=v);b.clipping=true;b.opacity=opacity;return render(open(2,2,[a,b])).filter((_:number,i:number)=>i%4===3);},opacity);expect(r).toEqual([255,128,32,0]);
});
test('剪贴组的蒙版仅应用一次，普通组仍为通过式',async({page})=>{
 const r=await page.evaluate(()=>{const {pixel,open,render,D}=(window as any).editingReview,g=D.createGroupLayer('组'),a=pixel('基础',2,2,[0,0,0,128]),b=pixel('剪贴',2,2);a.parentId=b.parentId=g.id;b.clipping=true;D.addLayerMask(g,2,2).data.fill(128);const clipped=render(open(2,2,[a,b,g],b.id))[3];const g2=D.createGroupLayer('通过式');g2.opacity=.5;const x=pixel('红',2,2),y=pixel('蓝',2,2,[0,0,255,255]);x.parentId=y.parentId=g2.id;const through=render(open(2,2,[x,y,g2],y.id)).slice(0,4);return{clipped,through};});expect(r).toEqual({clipped:64,through:[85,0,170,192]});
});

test('区域模糊读取 halo 且不改写区域外像素',async({page})=>{
 const r=await page.evaluate(()=>{const {P,F}=(window as any).editingReview,b=P.createBuffer(5,5,[0,0,0,255]);b.data.set([255,255,255,255],(1*5+1)*4);F.boxBlurRegion(b,{x:1,y:2,width:2,height:2},1);return{inside:Array.from(b.data.slice((2*5+1)*4,(2*5+1)*4+4)),outside:Array.from(b.data.slice((1*5+1)*4,(1*5+1)*4+4))};});expect(r).toEqual({inside:[28,28,28,255],outside:[255,255,255,255]});
});
test('模糊透明邻域不会被隐藏 RGB 染色',async({page})=>{
 const r=await page.evaluate(()=>{const {P,F}=(window as any).editingReview,b=P.createBuffer(3,1,[0,0,255,0]);b.data.set([255,0,0,255],0);F.boxBlurRegion(b,{x:1,y:0,width:1,height:1},1);return Array.from(b.data.slice(4,8));});expect(r).toEqual([255,0,0,85]);
});
test('填充旋转翻转图层与独立蒙版时使用目标网格',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,P,E}=(window as any).editingReview,l=pixel('旋转层',2,2),d=open(8,6,[l]);l.transform={...l.transform,origin:[1,1],size:[4,4],rotation:90,flipX:true};d.selection={...P.createMask(8,6,0),outline:null};for(let y=3;y<5;y++)for(let x=1;x<3;x++)d.selection.data[y*8+x]=255;E.api.setForeground([0,255,0]);await E.commands.run('fillForeground');const image=Array.from(l.pixels.data);l.mask={pixels:P.createMask(2,2,255),enabled:true,linked:false,placement:{x:4,y:0,width:4,height:4},target:'mask',inverted:false};d.selection.data.fill(0);for(let y=2;y<4;y++)for(let x=6;x<8;x++)d.selection.data[y*8+x]=255;E.api.setForeground([0,0,0]);await E.commands.run('fillForeground');return{image,mask:Array.from(l.mask.pixels.data)};});expect(r).toEqual({image:[255,0,0,255,255,0,0,255,0,255,0,255,255,0,0,255],mask:[255,255,255,0]});
});
test('多个剪贴层共享同一 alpha，剪贴栈用基础层模式混合',async({page})=>{
 const r=await page.evaluate(()=>{const {pixel,open,render}=(window as any).editingReview,bg=pixel('灰底',2,2,[128,128,128,255]),a=pixel('基础',2,2,[255,255,255,128]),b=pixel('红',2,2),c=pixel('蓝',2,2,[0,0,255,255]);a.blendMode='Multiply';b.clipping=c.clipping=true;const withBase=render(open(2,2,[bg,a,b])).slice(0,4);const stackOnly=render(open(2,2,[a,b,c])).slice(0,4);return{withBase,stackOnly};});expect(r).toEqual({withBase:[128,64,64,255],stackOnly:[0,0,255,128]});
});
test('只渲染剪贴层时不额外画出基础层',async({page})=>{
 const r=await page.evaluate(()=>{const {pixel,open,C}=(window as any).editingReview,a=pixel('基础',2,2,[0,0,0,128]),b=pixel('剪贴',2,2);b.clipping=true;const d=open(2,2,[a,b]);return Array.from(C.compositeDocument(d,2,2,{scale:1,onlyLayers:new Set([b.id])}).buffer.data.slice(0,4));});expect(r).toEqual([255,0,0,128]);
});
test('模糊参数栏切回像素后不再改写蒙版',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,E,blur}=(window as any).editingReview,l=pixel('层',16,16,[0,0,255,255]);for(let y=0;y<16;y++)for(let x=0;x<8;x++)l.pixels.data.set([255,0,0,255],(y*16+x)*4);open(16,16,[l]);await E.commands.run('addMask');blur(8,2,'pixels');return{target:l.mask.target,image:Array.from(l.pixels.data.slice((2*16+8)*4,(2*16+8)*4+4)),mask:l.mask.pixels.data.every((v:number)=>v===255)};});expect(r.target).toBe('image');expect(r.image).not.toEqual([0,0,255,255]);expect(r.mask).toBe(true);
});
test('暂不支持蒙版的修复工具明确拒绝，不写原图或产生历史',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,E,B}=(window as any).editingReview,l=pixel('层',8,8);open(8,8,[l]);await E.commands.run('addMask');const before=Array.from(l.pixels.data).join(','),position=E.currentHistory().position;E.setTool('healing');const e={doc:{x:4,y:4},screen:{x:4,y:4},button:0,pressure:1,alt:false,ctrl:false,meta:false,shift:false};B.healingTool.onDown(E.api,e);B.healingTool.onUp(E.api,e);return{same:before===Array.from(l.pixels.data).join(','),position:E.currentHistory().position===position,message:E.statusMessage.value};});expect(r.same&&r.position).toBe(true);expect(r.message).toContain('暂不支持蒙版');
});

test('切换图层后模糊参数栏跟随实际图像或蒙版目标',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,E}=(window as any).editingReview;open(4,4,[pixel('有蒙版',4,4)]);await E.commands.run('addMask');E.setTool('blur');E.api.setToolOption('target','mask');open(4,4,[pixel('普通层',4,4)]);await new Promise(requestAnimationFrame);return E.api.option('target','pixels');});expect(r).toBe('pixels');
});
