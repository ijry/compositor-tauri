import type { Page } from '@playwright/test';

/** 仅在测试浏览器安装内存文件系统，生产包不包含此代码。 */
export async function projectHost(page: Page) {
 await page.goto('http://127.0.0.1:5194');
 await page.evaluate(()=>{
  const files: Record<string,string>={};
  const dirs=new Set(['review.comp','review.comp/images']);
  const path=(p:string)=>p.replaceAll('\\','/');
  const put=(p:string,v:string)=>{files[p]=v;let parent=p.slice(0,p.lastIndexOf('/'));while(parent){dirs.add(parent);const slash=parent.lastIndexOf('/');if(slash<0)break;parent=parent.slice(0,slash);}};
  const text=(value:unknown)=>btoa(Array.from(new TextEncoder().encode(JSON.stringify(value)), b=>String.fromCharCode(b)).join(''));
  const id='11111111-1111-4111-8111-111111111111';
  const canvas=document.createElement('canvas');canvas.width=canvas.height=16;
  const ctx=canvas.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,16,16);
  const png=canvas.toDataURL().split(',')[1]!;
  const layer={id,name:'磁盘图层',isVisible:true,imageFile:id.toUpperCase()+'.png',transform:{origin:[0,0],size:[16,16],rotation:0,flipX:false,flipY:false,sampling:'Nearest'}};
  const manifest={format:'com.compositor.project',version:11,colorSpace:'sRGB',documentID:'22222222-2222-4222-8222-222222222222',width:16,height:16,activeLayerID:id,layers:[layer]};
  const state={files,manifest,id,png,confirmCount:0,confirmMode:'cancel',answer:null as null|((value:boolean)=>void),writeManifest:()=>put('review.comp/manifest.json',text(manifest))};
  state.writeManifest();put('review.comp/images/'+layer.imageFile,png);put('review.comp/images/'+id+'.mask.png',png);
  (window as any).projectFixture=state;
  (window as any).otools={
   readHostFile:async(p:string)=>{if(!(path(p) in files))throw Error('missing');return{dataBase64:files[path(p)]};},
   writeHostFile:async({path:p,dataBase64}:any)=>put(path(p),dataBase64),
   listHostDir:async(p:string)=>{p=path(p);if(!dirs.has(p))throw Error('missing directory');return Object.entries(files).filter(([f])=>f.startsWith(p+'/')&&!f.slice(p.length+1).includes('/')).map(([f,v])=>({name:f.split('/').pop(),kind:'file',size:atob(v).length}));},
   invokeNativeRaw:async(method:string,payload:any)=>{
    if(method==='tools_webview_rename_entry'){
     const from=path(payload.request.from),to=path(payload.request.to);if(!dirs.has(from)||dirs.has(to))throw Error('invalid rename');
     for(const dir of [...dirs])if(dir===from||dir.startsWith(from+'/')){dirs.delete(dir);dirs.add(to+dir.slice(from.length));}
     for(const [f,v] of Object.entries(files))if(f.startsWith(from+'/')){files[to+f.slice(from.length)]=v;delete files[f];}
    }else if(method==='tools_webview_remove_entry'){
     const p=path(payload.path);for(const f of Object.keys(files))if(f.startsWith(p+'/'))delete files[f];for(const d of [...dirs])if(d===p||d.startsWith(p+'/'))dirs.delete(d);
    }else throw Error('unexpected native call');
   },
   dialog:{confirm:async()=>{state.confirmCount++;if(state.confirmMode==='defer')return new Promise<boolean>(resolve=>{state.answer=resolve;});return state.confirmMode==='accept';}},
  };
 });
}
