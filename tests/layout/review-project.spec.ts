import { test, expect } from '@playwright/test';
test('工程往返保留组引用、剪贴蒙版和扭曲；资源缺失拒绝载入；失败保存保留旧包',async({page})=>{
 await page.goto('http://127.0.0.1:5194');
 const results=await page.evaluate(async()=>{
  // @ts-ignore
  const D=await import('/src/core/document.ts'); // @ts-ignore
  const P=await import('/src/core/pixels.ts'); // @ts-ignore
  const IO=await import('/src/io/compProject.ts');
  const files:Record<string,string>={};let fail='';const key=(p:string)=>p.replaceAll('\\','/');
  (window as any).otools={
   writeHostFile:async({path,dataBase64}:any)=>{path=key(path);if(fail==='write'&&path.endsWith('manifest.json'))throw Error('injected write failure');files[path]=dataBase64;},
   readHostFile:async(path:string)=>{if(!(key(path) in files))throw Error('missing');return {dataBase64:files[key(path)]};},
   listHostDir:async(path:string)=>{path=key(path);return Object.entries(files).filter(([p])=>p.startsWith(path+'/')&&!p.slice(path.length+1).includes('/')).map(([p,v])=>({path:p,name:p.split('/').pop(),kind:'file',size:atob(v).length}));},
   invokeNativeRaw:async(method:string,payload:any)=>{
    if(method==='tools_webview_rename_entry'){
     const from=key(payload.request.from),to=key(payload.request.to);
     if(fail==='commit'&&from.includes('.saving-'))throw Error('injected rename failure');
     const entries=Object.entries(files).filter(([p])=>p===from||p.startsWith(from+'/'));
     // fixture.comp 是已由文件选择器创建的空目录，可以正常备份。
     if(!entries.length && from!=='fixture.comp')throw Error('missing directory');
     for(const [p,v] of entries){files[to+p.slice(from.length)]=v;delete files[p];}
    } else if(method==='tools_webview_remove_entry'){const prefix=key(payload.path);for(const p of Object.keys(files))if(p===prefix||p.startsWith(prefix+'/'))delete files[p];}
    else throw Error('unexpected native method');
   },
  };
  const doc=D.createDocument(16,16);const group=D.createGroupLayer('组');group.mask={pixels:P.createMask(16,16,128),enabled:true,linked:true,placement:null,target:'image',inverted:false};
  const base=D.createPixelLayer('底层',P.createBuffer(16,16,[255,0,0,255]));base.parentId=group.id;
  const clip=D.createPixelLayer('剪贴',P.createBuffer(16,16,[0,0,255,255]));clip.parentId=group.id;clip.clipping=true;clip.transform.warp=[{x:.1,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
  doc.layers.push(group,base,clip);doc.activeLayerId=group.id;
  const path='fixture.comp';await IO.saveCompProject(doc,path);const loaded=await IO.loadCompProject(path);
  const roundtrip={ids:loaded.layers.map((l:any)=>l.id).join(',')===doc.layers.map((l:any)=>l.id).join(','),parent:loaded.layers[1].parentId===loaded.layers[0].id,mask:loaded.layers[0].mask?.pixels.data[0],clip:loaded.layers[2].clipping,warp:loaded.layers[2].transform.warp,active:loaded.activeLayerId===group.id};
  const committed=JSON.stringify(Object.entries(files).filter(([p])=>p.startsWith(path+'/')).sort());
  base.pixels=P.createBuffer(16,16,[0,255,0,255]);let failures=[];
  for(const type of ['write','commit']){fail=type;let result;try{result=await IO.saveCompProject(doc,path);}catch{result=null;}failures.push(result===null && JSON.stringify(Object.entries(files).filter(([p])=>p.startsWith(path+'/')).sort())===committed);}fail='';
  let missingRejected=true;
  for(const suffix of [base.id.toUpperCase()+'.png',group.id.toUpperCase()+'.mask.png']) {
    const file=path+'/images/'+suffix;const old=files[file];delete files[file];let rejected=false;
    try{await IO.loadCompProject(path);}catch{rejected=true;}
    files[file]=old;missingRejected &&= rejected;
  }
  const beforeUnsupported=JSON.stringify(files);const invoke=(window as any).otools.invokeNativeRaw;delete (window as any).otools.invokeNativeRaw;
  let unsupportedRejected=false;try{await IO.saveCompProject(doc,path);}catch{unsupportedRejected=true;}
  const untouched=beforeUnsupported===JSON.stringify(files);(window as any).otools.invokeNativeRaw=invoke;
  files['not-project/readme.txt']=btoa('precious unrelated file');
  let rejectedFolder=false;try{await IO.saveCompProject(doc,'not-project');}catch{rejectedFolder=true;}
  const unrelatedPreserved=files['not-project/readme.txt']===btoa('precious unrelated file');
  return {roundtrip,failures,missingRejected,rejectedFolder,unrelatedPreserved,unsupportedRejected,untouched};
 });
 expect(results.roundtrip).toMatchObject({ids:true,parent:true,mask:128,clip:true,active:true});expect(results.roundtrip.warp).not.toBeNull();expect(results.failures).toEqual([true,true]);expect(results.missingRejected).toBe(true);expect(results.rejectedFolder).toBe(true);expect(results.unrelatedPreserved).toBe(true);expect(results.unsupportedRejected && results.untouched).toBe(true);
});
test('热重载检测同长度清单修改和 images 变化，稳定一次且 stop 后不再回调',async({page})=>{
 await page.goto('http://127.0.0.1:5194');
 const result=await page.evaluate(async()=>{ // @ts-ignore
 const {watchCompProject}=await import('/src/io/compProject.ts');let content='{"value":1}',imageSize=1,calls=0;
 (window as any).otools={readHostFile:async()=>({dataBase64:btoa(content)}),listHostDir:async(path:string)=>path.endsWith('images')?[{name:'test.png',kind:'file',size:imageSize}]:[{name:'manifest.json',kind:'file',size:content.length},{name:'images',kind:'directory'}]};
 const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));const watcher=watchCompProject('test.comp',()=>{calls++;});await pause(450);content='{"value":2}';await pause(1100);const afterManifest=calls;imageSize=2;await pause(1100);const afterImage=calls;content='{"value":3}';await pause(380);watcher.stop();const stopped=calls;await pause(900);return {afterManifest,afterImage,stopped,final:calls};
 });expect(result.afterManifest).toBe(1);expect(result.afterImage).toBe(2);expect(result.final).toBe(result.stopped);
});

test('重载替换原标签并保留视口和选区，不追加新标签',async({page})=>{
 await page.goto('http://127.0.0.1:5194');const result=await page.evaluate(async()=>{ // @ts-ignore
 const E=await import('/src/composables/useEditor.ts'); // @ts-ignore
 const D=await import('/src/core/document.ts'); // @ts-ignore
 const P=await import('/src/core/pixels.ts');
 const doc=D.createDocument(16,16);doc.packagePath='test.comp';const l=D.createPixelLayer('red',P.createBuffer(16,16,[255,0,0,255]));doc.layers.push(l);doc.activeLayerId=l.id;E.openDocument(doc);
 E.api.setViewport({zoom:2,centerX:6,centerY:7});const next=D.createDocument(16,16);next.id=doc.id;next.packagePath=doc.packagePath;next.layers=[{...l,name:'updated'}];
 if(!E.reloadDocument)return null;E.reloadDocument(next);return {count:E.documents.value.length,name:E.api.activeLayer().name,zoom:E.api.viewport.zoom,center:E.api.viewport.centerX};
 });expect(result).toEqual({count:1,name:'updated',zoom:2,center:6});
});

// 已成功读取的空目录仍可能没有重命名权限；此时禁止尝试提交临时包。
test('空目录备份失败必须终止，不再尝试覆盖目标', async ({ page }) => {
 await page.goto('http://127.0.0.1:5194');
 const result = await page.evaluate(async () => {
  // @ts-ignore
  const D = await import('/src/core/document.ts');
  // @ts-ignore
  const IO = await import('/src/io/compProject.ts');
  let committed = false; let rejected = false;
  (window as any).otools = {
   listHostDir: async () => [],
   writeHostFile: async () => {},
   readHostFile: async () => { throw Error('missing manifest in empty directory'); },
   invokeNativeRaw: async (method: string, payload: any) => {
    if (method === 'tools_webview_rename_entry') {
     if (payload.request.from === 'existing-empty.comp') throw Error('permission denied');
     committed = true;
    }
   },
  };
  try { await IO.saveCompProject(D.createDocument(16, 16), 'existing-empty.comp'); }
  catch { rejected = true; }
  return { committed, rejected };
 });
 expect(result).toEqual({ committed: false, rejected: true });
});
