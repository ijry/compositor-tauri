import { test, expect } from '@playwright/test';

// 真实核心与命令/画笔路径；期望图像用独立坐标公式或明确 RGBA 常量计算。
test.beforeEach(async ({page}) => {
  await page.goto('http://127.0.0.1:5194');
  await page.evaluate(async () => {
    // @ts-ignore
    const D = await import('/src/core/document.ts'); // @ts-ignore
    const P = await import('/src/core/pixels.ts'); // @ts-ignore
    const C = await import('/src/core/engine/compositor.ts'); // @ts-ignore
    const E = await import('/src/composables/useEditor.ts'); // @ts-ignore
    const B = await import('/src/tools/paint.ts'); // @ts-ignore
    const G = await import('/src/core/geometry.ts');
    const pixel = (name:string,w:number,h:number,color=[255,0,0,255]) => {const l=D.createPixelLayer(name,P.createBuffer(w,h,color));l.transform.sampling='Nearest';return l;};
    const open = (w:number,h:number,layers:any[],active=layers.at(-1)?.id) => {const d=D.createDocument(w,h);d.layers=layers;d.activeLayerId=active;E.openDocument(d);return d;};
    const render=(d:any)=>Array.from(C.compositeDocument(d).buffer.data);
    const draw=(x:number,y:number,color:number[],opacity=1)=>{E.setTool('brush');E.api.setForeground(color);E.api.setToolOption('size',4);E.api.setToolOption('hardness',1);E.api.setToolOption('opacity',opacity);E.api.setToolOption('smoothing',0);const e={doc:{x,y},screen:{x,y},shift:false,alt:false,ctrl:false,meta:false,button:0,pressure:1};B.brushTool.onDown(E.api,e);B.brushTool.onUp(E.api,e);};
    (window as any).pixelReview={D,P,C,E,B,G,pixel,open,render,draw};
  });
});
for(const degrees of [90,180,270])test('旋转 '+degrees+' 度保持完整像素并支持撤销重做',async({page})=>{
 const result=await page.evaluate(async degrees=>{
  const {pixel,open,render,E}=(window as any).pixelReview,l=pixel('彩色',4,2);
  for(let i=0;i<8;i++)l.pixels.data.set([i*20,i*10,i*5,255],i*4);
  const d=open(4,2,[l]),before=render(d),expected=new Array(32).fill(0),width=degrees===180?4:2;
  for(let y=0;y<2;y++)for(let x=0;x<4;x++){const tx=degrees===90?1-y:degrees===180?3-x:y,ty=degrees===90?x:degrees===180?1-y:3-x;for(let c=0;c<4;c++)expected[(ty*width+tx)*4+c]=before[(y*4+x)*4+c];}
  await E.commands.run('rotateCanvasAll',degrees);const actual=render(d),raw=Array.from(d.layers[0].pixels.data);await E.commands.run('undo');const undo=JSON.stringify(render(d))===JSON.stringify(before);await E.commands.run('redo');
  return{actual,expected,undo,redo:JSON.stringify(render(d))===JSON.stringify(actual),rawPreserved:JSON.stringify(raw)===JSON.stringify(before)};
 },degrees);expect(result.actual).toEqual(result.expected);expect(result.undo&&result.redo&&result.rawPreserved).toBe(true);
});
test('旋转同时转动独立蒙版、选区与参考线',async({page})=>{
 const r=await page.evaluate(async()=>{
  const {pixel,open,render,D,P,E}=(window as any).pixelReview,l=pixel('图层',4,2);
  l.mask={pixels:P.createMask(2,1,255),enabled:true,linked:false,placement:{x:1,y:0,width:2,height:1},target:'mask',inverted:false};const d=open(4,2,[l]);
  d.selection={...P.createMask(4,2,0),outline:null};d.selection.data[1]=255;d.guides=[{id:'v',axis:'vertical',position:1},{id:'h',axis:'horizontal',position:1}];
  await E.commands.run('rotateCanvasAll',90);return{alpha:render(d).filter((_:number,i:number)=>i%4===3),selection:Array.from(d.selection.data),guides:d.guides.map((g:any)=>[g.axis,g.position])};
 });expect(r).toEqual({alpha:[0,0,0,255,0,255,0,0],selection:[0,0,0,255,0,0,0,0],guides:[['horizontal',1],['vertical',1]]});
});
test('改变画布仅平移图层，保留缩放和蒙版，并同步选区参考线',async({page})=>{
 const r=await page.evaluate(async()=>{
  const {pixel,open,P,E}=(window as any).pixelReview,l=pixel('缩放层',8,8);l.transform.size=[4,4];l.transform.origin=[2,3];l.mask={pixels:P.createMask(3,2,128),enabled:true,linked:false,placement:{x:5,y:6,width:3,height:2,rotation:90},target:'mask',inverted:false};
  const d=open(16,16,[l]);d.selection={...P.createMask(16,16,0),outline:null};d.selection.data[3*16+2]=255;d.guides=[{id:'g',axis:'vertical',position:1}];
  await E.commands.run('canvasSize',{width:32,height:32,anchor:'center'});return{origin:l.transform.origin,size:l.transform.size,maskSize:[l.mask.pixels.width,l.mask.pixels.height],place:l.mask.placement,selection:d.selection.data[11*32+10],guide:d.guides[0].position};
 });expect(r).toMatchObject({origin:[10,11],size:[4,4],maskSize:[3,2],place:{x:13,y:14,width:3,height:2,rotation:90},selection:255,guide:9});
});
test('画布九宫格锚点正确选择水平和垂直偏移',async({page})=>{
 const result=await page.evaluate(()=>{const {pixel,open,D}=(window as any).pixelReview;return ['top-left','top','top-right','left','center','right','bottom-left','bottom','bottom-right'].map(anchor=>{const l=pixel('层',4,4),d=open(16,16,[l]);D.resizeCanvas(d,32,32,anchor);return l.transform.origin;});});
 expect(result).toEqual([[0,0],[8,0],[16,0],[0,8],[8,8],[16,8],[0,16],[8,16],[16,16]]);
});
for(const kind of ['group','adjustment'])test('图像大小保留 '+kind+' 蒙版，而非重建全白',async({page})=>{
 const r=await page.evaluate(async kind=>{const {D,P,pixel,open,E}=(window as any).pixelReview,g=kind==='group'?D.createGroupLayer('组'):D.createAdjustmentLayer('Invert',D.createDocument(16,16)),l=pixel('层',16,16);D.addLayerMask(g,16,16);g.mask.pixels.data.fill(0);g.mask.pixels.data[0]=255;if(kind==='group')l.parentId=g.id;const d=open(16,16,[l,g]);await E.commands.run('imageSize',{width:32,height:32});return{top:g.mask.pixels.data[0],center:g.mask.pixels.data[16*32+16],size:[g.mask.pixels.width,g.mask.pixels.height]};},kind);
 expect(r).toEqual({top:255,center:0,size:[32,32]});
});
test('图像缩放保留已有图层比例，非等比时保持变换后的角点',async({page})=>{
 const r=await page.evaluate(()=>{
  const {pixel,open,D,G}=(window as any).pixelReview,l=pixel('旋转层',8,8);l.transform.size=[4,4];l.transform.origin=[3,3];l.transform.rotation=30;const d=open(16,16,[l]);
  const corners=(layer:any)=>{const m=G.layerMatrix(layer.transform,layer.pixels.width,layer.pixels.height);return [[0,0],[layer.pixels.width,0],[layer.pixels.width,layer.pixels.height],[0,layer.pixels.height]].map(([x,y])=>G.applyMatrix(m,x,y));};
  const expected=corners(l).map((p:any)=>({x:p.x*2,y:p.y}));D.resizeImage(d,32,16);const actual=corners(l);return Math.max(...expected.map((p:any,i:number)=>Math.hypot(p.x-actual[i].x,p.y-actual[i].y)));
 });expect(r).toBeLessThan(0.000001);
});
for(const mode of ['Normal','Multiply'])test('合并 '+mode+' 图层保持像素，不重复透明度且不改变其他图层顺序',async({page})=>{
 const r=await page.evaluate(async mode=>{const {pixel,open,render,E}=(window as any).pixelReview,a=pixel('底',8,8),b=pixel('顶',8,8,[0,0,255,255]),c=pixel('未合并',2,2,[0,255,0,255]);b.opacity=.5;b.blendMode=mode;const d=open(8,8,[a,b,c],b.id),before=render(d);await E.commands.run('mergeDown');return{equal:JSON.stringify(render(d))===JSON.stringify(before),ids:d.layers.map((l:any)=>l.name),opacity:d.layers[0].opacity,mode:d.layers[0].blendMode};},mode);
 expect(r).toEqual({equal:true,ids:['顶','未合并'],opacity:1,mode:'Normal'});
});
test('合并嵌套组保留像素、组透明度和蒙版，支持撤销重做',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,render,D,P,E}=(window as any).pixelReview,g=D.createGroupLayer('组'),n=D.createGroupLayer('子组',g.id),a=pixel('层',8,8);a.parentId=n.id;g.opacity=.5;D.addLayerMask(g,8,8).data.fill(128);const d=open(8,8,[a,n,g],g.id),before=render(d);await E.commands.run('mergeGroup');const merged=d.layers.length===1&&d.layers[0].kind==='pixel';const same=JSON.stringify(render(d))===JSON.stringify(before);await E.commands.run('undo');const undo=d.layers.length===3&&JSON.stringify(render(d))===JSON.stringify(before);await E.commands.run('redo');return{merged,same,undo,redo:d.layers.length===1&&JSON.stringify(render(d))===JSON.stringify(before)};});
 expect(r).toEqual({merged:true,same:true,undo:true,redo:true});
});
for(const disabled of [false,true])test('应用偏移旋转蒙版保持当前像素，disabled='+disabled,async({page})=>{
 const r=await page.evaluate(async disabled=>{const {pixel,open,render,P,E}=(window as any).pixelReview,l=pixel('层',16,16);l.transform.origin=[1,0];l.mask={pixels:P.createMask(8,4,0),enabled:!disabled,linked:false,placement:{x:4,y:4,width:8,height:4,rotation:90,flipX:true},target:'mask',inverted:false};l.mask.pixels.data.fill(255,0,16);const d=open(20,20,[l]),before=render(d);await E.commands.run('applyMask');const same=JSON.stringify(before)===JSON.stringify(render(d));return{same,removed:!l.mask};},disabled);expect(r).toEqual({same:true,removed:true});
});
for(const state of ['black','hidden','disabled'])test('剪贴正确读取基础层蒙版和可见性 '+state,async({page})=>{
 const r=await page.evaluate(state=>{const {pixel,open,render,D}=(window as any).pixelReview,a=pixel('基础',8,8),b=pixel('剪贴',8,8,[0,0,255,255]);D.addLayerMask(a,8,8).data.fill(0);a.mask.enabled=state!=='disabled';a.isVisible=state!=='hidden';b.clipping=true;const d=open(8,8,[a,b]);return render(d).filter((v:number,i:number)=>i%4===3&&v>0).length;},state);expect(r).toBe(state==='disabled'?64:0);
});
test('蒙版黑白灰画笔按覆盖率混合并遵守半透明选区',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,draw,P,E}=(window as any).pixelReview,l=pixel('蒙版',16,16),d=open(16,16,[l]);await E.commands.run('addMask');draw(8,8,[0,0,0]);const black=l.mask.pixels.data[8*16+8];draw(8,8,[255,255,255],.5);const half=l.mask.pixels.data[8*16+8];d.selection={...P.createMask(16,16,128),outline:null};draw(8,8,[0,0,0]);const selected=l.mask.pixels.data[8*16+8];return{black,half,selected};});expect(r).toEqual({black:0,half:128,selected:64});
});
test('独立蒙版画笔使用蒙版网格与旋转翻转',async({page})=>{
 const r=await page.evaluate(()=>{const {pixel,open,draw,P}=(window as any).pixelReview,l=pixel('蒙版',16,16);l.mask={pixels:P.createMask(8,8,0),enabled:true,linked:false,placement:{x:8,y:0,width:8,height:8,rotation:90,flipX:true},target:'mask',inverted:false};open(16,16,[l]);draw(12,4,[255,255,255]);return l.mask.pixels.data[4*8+4];});expect(r).toBe(255);
});
for(const kind of ['group','adjustment'])test(kind+' 蒙版可以绘制且能撤销重做',async({page})=>{
 const r=await page.evaluate(async kind=>{const {D,open,draw,E}=(window as any).pixelReview,l=kind==='group'?D.createGroupLayer('组'):D.createAdjustmentLayer('Invert',D.createDocument(16,16));open(16,16,[l]);await E.commands.run('addMask');draw(8,8,[0,0,0]);const painted=E.api.activeLayer().mask.pixels.data[8*16+8];await E.commands.run('undo');const undo=E.api.activeLayer().mask.pixels.data[8*16+8];await E.commands.run('redo');return{painted,undo,redo:E.api.activeLayer().mask.pixels.data[8*16+8]};},kind);expect(r).toEqual({painted:0,undo:255,redo:0});
});
test('半透明画笔使用非预乘 source-over，不污染透明像素颜色',async({page})=>{
 const r=await page.evaluate(()=>{const {pixel,open,draw}=(window as any).pixelReview,l=pixel('透明',16,16,[0,0,0,0]);open(16,16,[l]);draw(8,8,[255,0,0],.5);const first=Array.from(l.pixels.data.slice(544,548));draw(8,8,[0,0,255],.5);return{first,second:Array.from(l.pixels.data.slice(544,548))};});expect(r.first).toEqual([255,0,0,128]);expect(r.second).toEqual([85,0,170,192]);
});

test('非等比图像缩放保留旋转独立蒙版的实际覆盖图像',async({page})=>{
 const r=await page.evaluate(()=>{const {pixel,open,render,P,D}=(window as any).pixelReview,l=pixel('蒙版',16,16);l.mask={pixels:P.createMask(4,8,0),enabled:true,linked:false,placement:{x:4,y:4,width:4,height:8,rotation:90,flipX:true,sampling:'Nearest'},target:'mask',inverted:false};l.mask.pixels.data.fill(255,0,16);const d=open(16,16,[l]),before=render(d);D.resizeImage(d,32,16);const after=render(d);let equal=true;for(let y=0;y<16;y++)for(let x=0;x<32;x++)if(after[(y*32+x)*4+3]!==before[(y*16+Math.floor(x/2))*4+3])equal=false;return equal;});expect(r).toBe(true);
});
test('独立蒙版的非中心笔触遵循旋转和翻转',async({page})=>{
 const r=await page.evaluate(()=>{const {pixel,open,P,E,B}=(window as any).pixelReview,l=pixel('蒙版',16,16);l.mask={pixels:P.createMask(8,8,0),enabled:true,linked:false,placement:{x:8,y:0,width:8,height:8,rotation:90,flipX:true},target:'mask',inverted:false};open(16,16,[l]);E.setTool('brush');E.api.setForeground([255,255,255]);E.api.setToolOption('size',1);E.api.setToolOption('hardness',1);E.api.setToolOption('opacity',1);const e={doc:{x:11,y:6},screen:{x:11,y:6},button:0,pressure:1,shift:false,alt:false,ctrl:false,meta:false};B.brushTool.onDown(E.api,e);B.brushTool.onUp(E.api,e);return{hit:l.mask.pixels.data[5*8+2],wrong:l.mask.pixels.data[6*8+3]};});expect(r).toEqual({hit:255,wrong:0});
});
test('锁定图层或停用蒙版时画笔不改写图像或蒙版',async({page})=>{
 const r=await page.evaluate(()=>{const {pixel,open,draw,D}=(window as any).pixelReview,l=pixel('锁定',16,16);D.addLayerMask(l,16,16);l.mask.target='mask';open(16,16,[l]);const before=Array.from(l.pixels.data).join(',');l.locked=true;draw(8,8,[0,0,0]);const locked=l.mask.pixels.data[136];l.locked=false;l.mask.enabled=false;draw(8,8,[0,0,0]);return{locked,disabled:l.mask.pixels.data[136],image:before===Array.from(l.pixels.data).join(',')};});expect(r).toEqual({locked:255,disabled:255,image:true});
});

test('缩放图层应用独立蒙版前后保持一致，不因采样网格不同跳变',async({page})=>{
 const r=await page.evaluate(async()=>{const {pixel,open,render,P,E}=(window as any).pixelReview,l=pixel('放大层',2,2);l.transform.size=[8,8];l.mask={pixels:P.createMask(8,8,0),enabled:true,linked:false,placement:{x:0,y:0,width:8,height:8},target:'mask',inverted:false};for(let y=0;y<8;y++)l.mask.pixels.data[y*8+2]=255;const d=open(8,8,[l]),before=render(d);await E.commands.run('applyMask');return JSON.stringify(before)===JSON.stringify(render(d));});expect(r).toBe(true);
});
