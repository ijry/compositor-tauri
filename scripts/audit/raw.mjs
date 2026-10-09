import {launch,pageFor,saveJSON} from './harness.mjs';
const browser=await launch(),page=await pageFor(browser),results=[];
function add(r){results.push(r);console.log(r.id,r.status,r.reason??'');}
try{
 const rows=await page.evaluate(()=>{
  const {R,pixel,hash}=window.A,raw={data:pixel('RAW参数样本',48,48).pixels,width:48,height:48,cameraModel:'合成样本'},base=R.defaultRawSettings(),out=[];
  const evaluate=(settings)=>{const b=R.developRawImage(raw,settings);return {hash:hash(b.data),width:b.width,height:b.height};};
  const test=(id,name,baseSettings,settings,proof=false)=>{const before=evaluate(baseSettings),after=evaluate(settings),different=JSON.stringify(before)!==JSON.stringify(after);out.push({id,title:name,kind:'raw-parameter',status:different?'部分通过':proof?'失败':'未验证',effectDetected:different,before,after,scope:'合成RGB基底验证参数接线，不代替真实RAW色彩质量与Mac实机验证',reason:different?'有可观察输出差异；UI覆盖另列':'此样本无差异，不能判定参数有效'});};
  for(const [key,value]of Object.entries(base))if(typeof value==='number'){
   const a=JSON.parse(JSON.stringify(base)),b=JSON.parse(JSON.stringify(base));if(['radius','detail'].includes(key)){a.sharpening=b.sharpening=50;}
   b[key]=key==='exposure'?1:key==='radius'?4:key.startsWith('crop')?8:key==='detail'?100:key==='distortion'?20:40;test('RAW-'+key,key,a,b,key==='grain');
  }
  for(const key of Object.keys(base.colorMixer[0])){const b=JSON.parse(JSON.stringify(base));b.colorMixer[0][key]=50;test('RAW-mixer-'+key,'colorMixer.'+key,base,b,['hue','saturation','luminance'].includes(key));}
  for(const key of ['shadows','mids','highlights']){const b=JSON.parse(JSON.stringify(base));b.colorGrading[key]=[40,-20,20];test('RAW-grading-'+key,'colorGrading.'+key,base,b);}
  for(const points of [[[0,32],[255,200]],[[0,0],[128,200],[255,255]]]){const b=JSON.parse(JSON.stringify(base));b.curvePoints=points;test('RAW-curves-'+points.length,'曲线 '+points.length+' 控制点',base,b,points.length===2);}
  const b=JSON.parse(JSON.stringify(base));b.colorMixer[0].red=50;
  const colors=window.A.P.createBuffer(2,1);colors.data.set([128,0,0,255,0,128,128,255]);const rawColors={data:colors,width:2,height:1,cameraModel:'红/青'};const before=R.developRawImage(rawColors,base),after=R.developRawImage(rawColors,b);
  const redChanged=before.data.slice(0,3).some((v,i)=>v!==after.data[i]),cyanChanged=before.data.slice(4,7).some((v,i)=>v!==after.data[i+4]);
  out.push({id:'RAW-mixer-red-semantics',title:'红色混合器只命中红色族',kind:'raw-parameter',status:redChanged&&!cyanChanged?'通过':'失败',before:Array.from(before.data),after:Array.from(after.data),redChanged,cyanChanged});
  return out;
 });rows.forEach(add);
 await page.evaluate(async()=>{window.auditHost.openPath='/audit/input.dng';await window.A.E.commands.run('openRaw');});
 const groups=await page.locator('.raw-group').evaluateAll(nodes=>nodes.map(n=>({title:n.querySelector('h4')?.textContent,controls:n.querySelectorAll('input,select,button,canvas').length,text:n.textContent.trim()})));
 for(const g of groups)add({id:'RAW-UI-'+g.title,title:'RAW 面板 / '+g.title,kind:'raw-ui',status:g.controls?'部分通过':'未实现',...g,reason:g.controls?'控件存在；具体数值接线见参数项':'界面只有占位提示，无法编辑该组参数'});
 const initial=await page.evaluate(()=>({count:window.A.E.api.doc.layers.length,dirty:window.A.E.api.doc.dirty,history:window.A.E.currentHistory().position}));
 await page.locator('.el-dialog:visible').getByRole('button',{name:'关闭',exact:true}).click();
 const afterCancel=await page.evaluate(()=>({count:window.A.E.api.doc.layers.length,dirty:window.A.E.api.doc.dirty,history:window.A.E.currentHistory().position}));
 add({id:'RAW-cancel-import',title:'RAW 取消显影不修改原文档',kind:'raw-workflow',status:afterCancel.count===2?'通过':'失败',initial,afterCancel,expectedLayers:2});
 await saveJSON('raw-results.json',results);
}finally{await page.close();await browser.close();}
