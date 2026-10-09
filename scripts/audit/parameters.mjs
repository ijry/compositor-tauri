import fs from 'node:fs/promises';
import {launch,pageFor,capture,tool,gesture,saveJSON,root} from './harness.mjs';
const runtime=JSON.parse(await fs.readFile(root+'/docs/audit/catalog-runtime.json','utf8')),toolResults=JSON.parse(await fs.readFile((process.env.AUDIT_OUT?root+'/'+process.env.AUDIT_OUT:root+'/docs/audit')+'/tools-results.json','utf8'));
const selected=process.argv.slice(2);const browser=await launch(),results=selected.length?JSON.parse(await fs.readFile((process.env.AUDIT_OUT?root+'/'+process.env.AUDIT_OUT:root+'/docs/audit')+'/parameters-results.json','utf8').catch(()=> '[]')):[];
const values={size:[4,18],hardness:[20,90],opacity:[20,80],smoothing:[0,90],feather:[0,6],tolerance:[0,200],sensitivity:[1,95],spacing:[8,32],strength:[10,90],cornerRadius:[0,8],strokeWidth:[0,5],fontSize:[12,20],tracking:[0,6],lineSpacing:[0,26],content:['A','ABC'],fontName:['Arial','Courier New']};
function fingerprint(s){return JSON.stringify({width:s.width,height:s.height,image:s.composite?.hash,layers:s.layers?.map(l=>({pixels:l.pixels,mask:l.mask,transform:l.transform})),selection:s.selection});}
async function setUI(page,t,s,value){
 const row=page.locator('.cmp-tool-header label.option').filter({has:page.locator('.label').filter({hasText:new RegExp('^'+s.label+'$')})});
 if(s.type==='number'){const input=row.locator('input[type=number]');await input.fill(String(value));await input.press('Tab');}
 else if(s.type==='boolean'){const input=row.locator('input[type=checkbox]');if(await input.isChecked()!==value)await row.locator('.el-checkbox').click();}
 else if(s.key==='content'){await row.locator('input').fill(value);await row.locator('input').press('Tab');}
 else if(s.key==='fontName'){await row.locator('.el-select').click();await page.locator('.el-select-dropdown__item:visible').filter({hasText:new RegExp('^'+value+'$')}).first().click();}
 else if(s.type==='color'){await row.locator('.el-color-picker').click();const pop=page.locator('.el-color-picker__panel:visible');await pop.locator('input').last().fill(value);await pop.locator('input').last().press('Tab');await pop.getByRole('button',{name:/^(OK|确定)$/}).click();}
 return page.evaluate(key=>window.A.E.api.option(key,null),s.key);
}
async function probe(page,t,s,value){
 await page.evaluate(({id,key})=>{window.A.seed(id==='wand'?'solid':'standard');const {E,D,P}=window.A,d=E.api.doc,l=E.api.activeLayer();
 if(id==='move'){d.guides=[{id:'snap',axis:'vertical',position:45}];}
 if(id==='objectSelect'&&key==='sensitivity'){const l=window.A.pixel('灵敏度样本',64,64,[255,255,255,255]);for(let y=4;y<60;y++)for(let x=4;x<60;x++)l.pixels.data.set([220,20,20,255],(y*64+x)*4);d.layers=[l];d.activeLayerId=l.id;}
 if(id==='healing'){for(let i=0;i<l.pixels.data.length;i+=4)l.pixels.data.set([30,80,160,255],i);for(let y=14;y<19;y++)for(let x=14;x<19;x++)l.pixels.data.set([255,0,0,255],(y*32+x)*4);}
 if(id==='wand'&&key==='sampleAllLayers'){const cover=window.A.pixel('取样遮挡',3,4,[0,255,0,255]);cover.transform.origin=[19,21];d.layers.push(cover);}
 if(id==='clone')for(let y=3;y<8;y++)for(let x=3;x<8;x++)l.pixels.data.set([255,255,0,255],(y*32+x)*4);
 if(id==='wand'&&key==='contiguous'){for(let i=0;i<l.pixels.data.length;i+=4)l.pixels.data.set([0,0,255,255],i);for(const offset of [3,23])for(let y=4;y<9;y++)for(let x=offset;x<offset+5;x++)l.pixels.data.set([255,0,0,255],(y*32+x)*4);}
 E.api.invalidate();
 },{id:t.id,key:s.key});
 const fixed={};if(['brush','eraser','clone','blur','smudge','liquify'].includes(t.id)){fixed.size=14;fixed.hardness=1;fixed.smoothing=0;}
 if(t.id==='type'){fixed.fontSize=14;fixed.content='AB\nCD';}
 if(t.id==='shape'&&s.key==='cornerRadius')fixed.kind='roundedRectangle';
 if(t.id==='shape'&&s.key==='fill')fixed.strokeWidth=2;
 if(t.id==='marquee'&&s.key==='antialias')fixed.shape='ellipse';
 await tool(page,t.id,fixed);
 const stored=await setUI(page,t,s,value);
 if(t.id==='move'&&s.key==='showControls'){
  await page.waitForTimeout(160);const hash=await page.locator('canvas.overlay').evaluate(el=>{let h=2166136261;for(const v of el.getContext('2d').getImageData(0,0,el.width,el.height).data)h=Math.imul(h^v,16777619);return(h>>>0).toString(16);});return{stored,fingerprint:hash};
 }
 if(t.id==='move')await gesture(page,[[32,32],[44,32]]);
 else if(t.id==='marquee')await gesture(page,[[13.2,14.7],[50.8,45.4]]);
 else if(t.id==='lasso')await gesture(page,[[14,14],[48,15],[45,45],[16,43],[14,14]]);
 else if(['wand','objectSelect','eyedropper'].includes(t.id))await gesture(page,[[20,22]],{click:true});
 else if(t.id==='healing')await gesture(page,[[32,32]],{click:true});
 else if(t.id==='clone'){await gesture(page,[[20,20]],{click:true,keys:['Alt']});await gesture(page,[[35,35],[43,38]]);if(s.key==='aligned')await gesture(page,[[42,42]],{click:true});}
 else if(t.id==='shape')await gesture(page,[[20,20],[44,44]]);
 else if(t.id==='type'){await gesture(page,[[10,10]],{click:true});await page.getByRole('textbox',{name:'编辑画布文字'}).press('Control+Enter');}
 else if(t.id==='gradient')await gesture(page,[[18,20],[44,42]]);
 else await gesture(page,[[23,26],[28,36],[32,25],[36,38],[42,28]]);
 await page.waitForTimeout(130);const state=await capture(page);return{stored,fingerprint:t.id==='eyedropper'?JSON.stringify(await page.evaluate(()=>window.A.E.api.foreground)):fingerprint(state),state};
}
const provenIgnored=new Set(); // 原来硬编码的未接线项，修复后以实际差分与专门语义测试验证。
try{for(const t of runtime.tools)for(const s of t.specs){const id='PARAM-'+t.id+'-'+s.key;if(selected.length&&!selected.includes(id))continue;let record={id,kind:'parameter',tool:t.id,key:s.key,title:t.name+' / '+s.label,default:t.defaults[s.key],type:s.type};
 if(s.type==='select'&&s.options?.length){const related=toolResults.filter(r=>r.tool===t.id&&s.options.some(o=>String(o.value)===r.variant));const status=related.some(r=>r.status==='失败')?'失败':related.length===s.options.length?'通过':'未验证';record={...record,status,scope:'枚举项沿用真实下拉选择和工具输出场景',related:related.map(r=>r.id),options:s.options};}
 else{let page;try{page=await pageFor(browser);const pair=t.id==='eyedropper'&&s.key==='size'?[1,9]:s.type==='boolean'?[false,true]:s.type==='color'?['rgb(255, 0, 0)','rgb(0, 0, 255)']:values[s.key];if(!pair){record.status='未验证';record.reason='缺少合适的差分样本，不能判定参数有效';}
 else{const a=await probe(page,t,s,pair[0]),b=await probe(page,t,s,pair[1]);const different=a.fingerprint!==b.fingerprint;
 const normalize=v=>s.type==='number'&&['hardness','opacity','strength'].includes(s.key)&&typeof t.defaults[s.key]==='number'&&t.defaults[s.key]<=1?v/100:v;
 const binding=s.type==='color'?Array.isArray(a.stored)&&Array.isArray(b.stored):JSON.stringify(a.stored)===JSON.stringify(normalize(pair[0]))&&JSON.stringify(b.stored)===JSON.stringify(normalize(pair[1]));
 let semantic=true,reason='';if(t.id==='wand'&&s.key==='sampleAllLayers'){semantic=a.state?.selection?.width===64&&b.state?.selection?.width===64;reason=semantic?'':'单层取样没有转换为文档空间选区';}
 if(t.id==='marquee'&&s.key==='feather'){semantic=(b.state?.selection?.count??0)>0&&b.state.selection.gray;reason=semantic?'':'羽化后选区全部消失，不能以输出有差异视为通过';}
 if(t.id==='clone'){reason='基础仿制取样另由TOOL-clone-default及回放测试验证；此项仅验证参数差分';}
 if(provenIgnored.has(t.id+'.'+s.key)){semantic=false;reason='源码核查：参数未读取或被硬编码/当前模式绕过，差分场景也不满足参数语义';}
 let status=!binding||!semantic?'失败':different?'部分通过':'未验证';
 record={...record,status,binding,effectDetected:different,reason:reason||(!different?'当前场景未观察到效果变化；不据此认定有效':'界面绑定及输出差异已验证；未覆盖全部组合、持久化与原版数值一致性'),values:pair,observed:[a.stored,b.stored],fingerprints:[a.fingerprint,b.fingerprint]};
 }}catch(e){record={...record,status:'失败',reason:String(e.message).slice(0,1200)};}finally{if(page)await page.close();}}
 const existing=results.findIndex(r=>r.id===id);if(existing>=0)results[existing]=record;else results.push(record);await saveJSON('parameters-results.json',results);console.log(id,record.status,record.reason??'');
}}finally{await browser.close();}
