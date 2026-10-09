import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
export const baseURL=process.env.AUDIT_URL??'http://127.0.0.1:5194';
export const root=process.cwd();
export const outDir=path.resolve(root,process.env.AUDIT_OUT??'docs/audit');

/** 独立构造最小 TIFF/DNG（不调用被测编码器）。 */
export function tiffFixture({raw=false,compression=1,tile=false,big=false,bitDepth,constant}={}) {
 const width=16,height=16,bits=bitDepth??(raw?16:8);
 let entries=[[256,4,1,width],[257,4,1,height],[258,3,1,bits],[259,3,1,compression],[262,3,1,raw?32803:1],[277,3,1,1],[278,4,1,height],[279,4,1,width*height*(bits/8)],[273,4,1,0]];
 if(raw)entries.push([33421,3,2,2+(2<<16)],[33422,1,4,0x02010100],[50706,1,4,0x00000401]);
 if(tile){entries=entries.filter(e=>![273,278,279].includes(e[0]));entries.push([322,4,1,width],[323,4,1,height],[324,4,1,0],[325,4,1,width*height]);}
 entries.sort((a,b)=>a[0]-b[0]);const offset=8+2+12*entries.length+4;entries.find(e=>e[0]===(tile?324:273))[3]=offset;
 const b=Buffer.alloc(offset+width*height*(bits/8));
 const w16=(v,p)=>big?b.writeUInt16BE(v,p):b.writeUInt16LE(v,p),w32=(v,p)=>big?b.writeUInt32BE(v>>>0,p):b.writeUInt32LE(v>>>0,p);
 b.write(big?'MM':'II');w16(42,2);w32(8,4);w16(entries.length,8);
 entries.forEach((e,i)=>{const p=10+i*12;w16(e[0],p);w16(e[1],p+2);w32(e[2],p+4);if(e[1]===3&&e[2]===1)w16(e[3],p+8);else if(e[0]===33422)b.set([0,1,1,2],p+8);else if(e[0]===50706)b.set([1,4,0,0],p+8);else w32(e[3],p+8);});
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const value=constant??(30+((x*11+y*7)%200)),p=offset+(y*width+x)*(bits/8);if(bits===16)w16(value*257,p);else b[p]=value;}
 if(compression===5||compression===32773){
  const bytes=b.subarray(offset);let encoded;
  if(compression===32773)encoded=Buffer.from([...bytes].flatMap(v=>[0,v]));
  else{const codes=[...bytes].flatMap(v=>[256,v]);codes.push(257);const out=[];let acc=0,n=0;for(const code of codes){acc=(acc<<9)|code;n+=9;while(n>=8){n-=8;out.push((acc>>n)&255);}}if(n)out.push((acc<<(8-n))&255);encoded=Buffer.from(out);}
  const countEntry=entries.findIndex(e=>e[0]===(tile?325:279));w32(encoded.length,10+countEntry*12+8);
  return Buffer.concat([b.subarray(0,offset),encoded]).toString('base64');
 }
 return b.toString('base64');
}

export async function launch(){return chromium.launch({headless:true});}
export async function pageFor(browser,profile='standard') {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.auditErrors=[];page.on('pageerror',e=>page.auditErrors.push(e.message));
 await page.addInitScript(()=>{
  const files={},dirs=new Set(['/audit','/audit/project.comp','/audit/project.comp/images']);
  const normalize=p=>{const absolute=p.startsWith('/'),parts=[];for(const part of p.replaceAll('\\','/').split('/')){if(!part||part==='.')continue;if(part==='..')parts.pop();else parts.push(part);}return(absolute?'/':'')+parts.join('/');};
  const host={files,dirs,writes:[],opens:[],saves:[],messages:[],confirmations:[],openPath:'/audit/input.png',savePath:'/audit/output.png',put:(p,v)=>{p=normalize(p);files[p]=v;let at=p.lastIndexOf('/');while(at>0){dirs.add(p.slice(0,at));at=p.lastIndexOf('/',at-1);}},normalize};
  window.auditHost=host;
  window.otools={
   platform:'windows',
   dialog:{open:async options=>{host.opens.push(options);return options.directory?'/audit/project.comp':[host.openPath];},save:async options=>{host.saves.push(options);return host.savePath;},message:async(message,options)=>host.messages.push({message,options}),confirm:async(message)=>{host.confirmations.push(message);return true;}},
   readHostFile:async p=>{p=normalize(p);if(!(p in files))throw Error('missing virtual file: '+p);return{dataBase64:files[p]};},
   writeHostFile:async({path:p,dataBase64})=>{host.writes.push({requested:p,path:normalize(p),bytes:atob(dataBase64).length});host.put(p,dataBase64);},
   listHostDir:async p=>{p=normalize(p);if(!dirs.has(p))throw Error('missing virtual dir: '+p);return [...Object.entries(files).filter(([f])=>f.startsWith(p+'/')&&!f.slice(p.length+1).includes('/')).map(([f,v])=>({name:f.split('/').pop(),path:f,kind:'file',size:atob(v).length})),...Array.from(dirs).filter(d=>d.startsWith(p+'/')&&!d.slice(p.length+1).includes('/')).map(d=>({name:d.split('/').pop(),path:d,kind:'directory',size:0}))];},
   invokeNativeRaw:async(method,payload)=>{if(method==='tools_webview_rename_entry'){const from=normalize(payload.request.from),to=normalize(payload.request.to);if(!dirs.has(from)||dirs.has(to))throw Error('invalid virtual rename');for(const d of [...dirs])if(d===from||d.startsWith(from+'/')){dirs.delete(d);dirs.add(to+d.slice(from.length));}for(const [p,v]of Object.entries(files))if(p.startsWith(from+'/')){files[to+p.slice(from.length)]=v;delete files[p];}}else if(method==='tools_webview_remove_entry'){const from=normalize(payload.path);for(const p of Object.keys(files))if(p.startsWith(from+'/'))delete files[p];for(const d of [...dirs])if(d===from||d.startsWith(from+'/'))dirs.delete(d);}else throw Error('unexpected native method');},
   getPluginLocalStateValue:async(_,key)=>JSON.parse(localStorage.getItem('audit:'+key)||'null'),
   savePluginLocalStateValue:async(_,key,value)=>localStorage.setItem('audit:'+key,JSON.stringify(value)),
  };
 });
 await page.goto(baseURL,{waitUntil:'networkidle',timeout:30000});
 await page.evaluate(async({profile,tiff,raw})=>{
  // Vite热更新给模块添加?t，必须复用页面实际加载的模块，避免导入第二套编辑器单例。
  const loaded=(path)=>import(performance.getEntriesByType('resource').findLast(r=>new URL(r.name).pathname===path)?.name??path);
  const E=await loaded('/src/composables/useEditor.ts'),D=await loaded('/src/core/document.ts'),P=await loaded('/src/core/pixels.ts'),C=await loaded('/src/core/engine/compositor.ts'),T=await loaded('/src/tools/index.ts'),X=await loaded('/src/tools/transform.ts'),S=await loaded('/src/composables/shortcuts.ts'),R=await loaded('/src/io/raw.ts'),IO=await loaded('/src/io/compProject.ts'),I=await loaded('/src/io/imageIO.ts'),PSD=await loaded('/src/io/psd.ts'),F=await loaded('/src/core/filters/adjust.ts'),Panels=await loaded('/src/composables/usePanels.ts'),Theme=await loaded('/src/composables/useTheme.ts'),Types=await loaded('/src/types/document.ts');
  const hash=b=>{let h=2166136261;for(const v of b??[])h=Math.imul(h^v,16777619);return(h>>>0).toString(16);};
  const summary=b=>({width:b.width,height:b.height,hash:hash(b.data),visible:b.data.filter((v,i)=>i%4===3&&v>0).length,first:Array.from(b.data.slice(0,4))});
  const pixel=(name,w,h,solid)=>{const b=P.createBuffer(w,h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;b.data.set(solid??[30+(x*13+y*3)%195,25+(x*7+y*11)%210,35+(x*17+y*5)%180,255],i);}const l=D.createPixelLayer(name,b);l.transform.sampling='Nearest';return l;};
  const seed=(kind='standard')=>{E.documents.value.splice(0);E.setTool('move');if(kind==='empty')return null;const d=D.createDocument(64,64,'验收临时工程'),bg=pixel('背景',64,64,[20,40,70,255]),l=pixel('前景',32,32,kind==='solid'?[200,60,20,255]:undefined);l.transform.origin=[16,16];d.layers=[bg,l];d.activeLayerId=l.id;E.openDocument(d);E.api.setViewport({zoom:4,centerX:32,centerY:32});E.api.setForeground([0,255,0]);E.api.setBackground([0,0,255]);d.dirty=false;return d;};
  const state=()=>{const d=E.currentDocument.value;if(!d)return{documents:E.documents.value.length,empty:true};let composite,error;try{composite=summary(C.compositeDocument(d).buffer);}catch(e){error=e.message;}return{documents:E.documents.value.length,width:d.width,height:d.height,dirty:d.dirty,history:E.currentHistory()?.position??-1,tool:E.api.toolId,viewport:{...E.api.viewport},selection:d.selection?{width:d.selection.width,height:d.selection.height,hash:hash(d.selection.data),gray:d.selection.data.some(v=>v>0&&v<255),count:d.selection.data.filter(x=>x>0).length}:null,layers:d.layers.map(l=>({id:l.id,kind:l.kind,name:l.name,visible:l.isVisible,opacity:l.opacity,parent:l.parentId,clipping:l.clipping,transform:JSON.parse(JSON.stringify(l.transform)),pixels:l.pixels?summary(l.pixels):null,mask:l.mask?{hash:hash(l.mask.pixels.data),enabled:l.mask.enabled,target:l.mask.target}:null,text:l.text?JSON.parse(JSON.stringify(l.text)):null,effects:l.effects?JSON.parse(JSON.stringify(l.effects)):null,adjustment:l.adjustment?JSON.parse(JSON.stringify(l.adjustment)):null})),composite,error,dialog:E.currentDialog.value?.name??null,status:E.statusMessage.value};};
  window.A={E,D,P,C,T,X,S,R,IO,I,PSD,F,Panels,Theme,Types,hash,summary,pixel,seed,state};seed(profile);
  const canvas=document.createElement('canvas');canvas.width=canvas.height=16;const ctx=canvas.getContext('2d');ctx.fillStyle='rgb(200,60,20)';ctx.fillRect(0,0,16,16);const png=canvas.toDataURL('image/png').split(',')[1];
  window.auditHost.put('/audit/input.png',png);window.auditHost.put('/audit/input.tiff',tiff);window.auditHost.put('/audit/input.dng',raw);
  const id='11111111-1111-4111-8111-111111111111';const manifest={format:'com.compositor.project',version:11,colorSpace:'sRGB',documentID:'22222222-2222-4222-8222-222222222222',width:16,height:16,activeLayerID:id,layers:[{id,name:'参考层',isVisible:true,imageFile:id+'.png',transform:{origin:[0,0],size:[16,16],rotation:0,flipX:false,flipY:false,sampling:'Nearest'}}]};
  window.auditHost.manifest=manifest;window.auditHost.writeManifest=()=>window.auditHost.put('/audit/project.comp/manifest.json',btoa(Array.from(new TextEncoder().encode(JSON.stringify(manifest)),b=>String.fromCharCode(b)).join('')));window.auditHost.writeManifest();window.auditHost.put('/audit/project.comp/images/'+id+'.png',png);
  const psdDoc=D.createDocument(16,16,'独立PSD样本');psdDoc.layers=[pixel('PSD 红层',16,16,[200,60,20,255])];const psd=PSD.exportPsd(psdDoc);window.auditHost.put('/audit/input.psd',btoa(Array.from(new Uint8Array(psd),b=>String.fromCharCode(b)).join('')));
 },{profile,tiff:tiffFixture(),raw:tiffFixture({raw:true})});
 if(profile!=='empty')await page.locator('.cmp-stage').waitFor({state:'visible'});
 return page;
}
export async function capture(page){return page.evaluate(()=>window.A.state());}
export async function tool(page,id,options={}) {
 const info=await page.evaluate(id=>{const t=window.A.T.getTool(id);return{name:t.name,shortcut:t.shortcut,specs:t.specs};},id);
 await page.getByTitle(info.name+'（'+info.shortcut+'）',{exact:true}).click();
 for(const [key,value]of Object.entries(options))await page.evaluate(({key,value})=>window.A.E.api.setToolOption(key,value),{key,value});
 return info;
}
export async function gesture(page,points,{keys=[],click=false,double=false}={}) {
 const coords=await page.evaluate(points=>{const r=document.querySelector('.cmp-stage').getBoundingClientRect();return points.map(p=>{const q=window.A.E.api.toScreen({x:p[0],y:p[1]});return{x:r.left+q.x,y:r.top+q.y};});},points);
 for(const key of keys)await page.keyboard.down(key);
 if(click||double){for(const p of coords){if(double)await page.mouse.dblclick(p.x,p.y);else await page.mouse.click(p.x,p.y);}}
 else{await page.mouse.move(coords[0].x,coords[0].y);await page.mouse.down();for(const p of coords.slice(1))await page.mouse.move(p.x,p.y,{steps:5});await page.mouse.up();}
 for(const key of [...keys].reverse())await page.keyboard.up(key);
}
export async function readRuntime(browser){
 const page=await pageFor(browser);const catalog=await page.evaluate(()=>({tools:window.A.T.TOOLS.map(t=>({id:t.id,name:t.name,group:t.group,shortcut:t.shortcut,defaults:t.defaults,specs:t.specs,handlers:['activate','deactivate','onDown','onMove','onUp','onDblClick','onKeyDown'].filter(k=>typeof t[k]==='function')})),shortcuts:window.A.S.shortcutItems.map(({id,group,title,chord,run})=>({id,group,title,chord,actionSource:run.toString()})),rawDefaults:window.A.R.defaultRawSettings(),rawGroups:window.A.R.RAW_PANEL_GROUPS,blendModes:window.A.Types.BLEND_MODES}));await page.close();return catalog;
}
export async function saveJSON(name,value){await fs.mkdir(outDir,{recursive:true});await fs.writeFile(path.join(outDir,name),JSON.stringify(value,null,2));}
