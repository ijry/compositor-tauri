import fs from 'node:fs/promises';
import {launch,pageFor,capture,tool,gesture,saveJSON,root} from './harness.mjs';
const runtime=JSON.parse(await fs.readFile(root+'/docs/audit/catalog-runtime.json','utf8'));
const cases=[];
const add=(id,variant,options={})=>cases.push({id:'TOOL-'+id+'-'+variant,tool:id,variant,options});
for(const t of runtime.tools){
 if(t.id==='move'){for(const v of ['move','scale','rotate','warp-meta','warp-ctrl'])add(t.id,v,{snap:false});continue;}
 const key={marquee:'shape',lasso:'mode',crop:'ratio',brush:'mode',gradient:'type',blur:'target',liquify:'mode',shape:'kind',type:'align',eyedropper:'sample'}[t.id];
 if(key){for(const o of t.specs.find(s=>s.key===key).options)add(t.id,String(o.value),{[key]:o.value});}
 else add(t.id,'default');
 if(t.id==='type')add(t.id,'point');if(t.id==='zoom')add(t.id,'out');
}
const selected=process.argv.slice(2),results=selected.length?JSON.parse(await fs.readFile((process.env.AUDIT_OUT?root+'/'+process.env.AUDIT_OUT:root+'/docs/audit')+'/tools-results.json','utf8').catch(()=> '[]')):[];
const browser=await launch();const check=(label,pass,actual)=>({label,pass:!!pass,actual});
const semantic=s=>JSON.stringify({width:s.width,height:s.height,layers:s.layers?.map(({id,...l})=>l),selection:s.selection,composite:s.composite});
async function modeSelect(page,t,key,value){const spec=t.specs.find(s=>s.key===key);const label=spec.options.find(o=>o.value===value)?.label;if(!label)return;const row=page.locator('.cmp-tool-header label.option').filter({has:page.locator('.label').filter({hasText:new RegExp('^'+spec.label+'$')})});await row.locator('.el-select').click();await page.locator('.el-select-dropdown__item:visible').filter({hasText:new RegExp('^'+String(label).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')}).first().click();}
try{for(const c of cases.filter(c=>!selected.length||selected.includes(c.id))){let page,res;try{
 page=await pageFor(browser,['wand','objectSelect','eyedropper'].includes(c.tool)?'solid':'standard');
 await page.evaluate(({id,variant})=>{const {E,P}=window.A,l=E.api.activeLayer();
  if(id==='healing'){l.pixels.data.fill(0);for(let i=0;i<l.pixels.data.length;i+=4)l.pixels.data.set([30,80,160,255],i);for(let y=15;y<18;y++)for(let x=15;x<18;x++)l.pixels.data.set([255,0,0,255],(y*32+x)*4);}
  if(id==='clone'){for(let y=3;y<8;y++)for(let x=3;x<8;x++)l.pixels.data.set([255,255,0,255],(y*32+x)*4);}
  if(id==='blur'&&variant==='mask'){window.A.D.addLayerMask(l,64,64);for(let y=0;y<32;y++)for(let x=0;x<16;x++)l.mask.pixels.data[y*32+x]=0;}
  E.api.markLayerDirty(l.id);
 },{id:c.tool,variant:c.variant});
 const fixed={};if(['brush','eraser','clone','blur','smudge','liquify'].includes(c.tool)){fixed.size=12;fixed.hardness=1;fixed.smoothing=0;}
 if(c.tool==='healing'){fixed.size=8;fixed.spacing=20;}
 if(c.tool==='type'){fixed.content='Audit';fixed.fontSize=14;fixed.color=[0,0,0];}
 if(c.tool==='shape'){fixed.strokeWidth=c.variant==='line'?2:0;fixed.cornerRadius=c.variant==='roundedRectangle'?6:0;}
 const t=await tool(page,c.tool,fixed);for(const [key,value]of Object.entries(c.options)){if(t.specs.find(s=>s.key===key)?.type==='select')await modeSelect(page,t,key,value);else await page.evaluate(({key,value})=>window.A.E.api.setToolOption(key,value),{key,value});}
 await page.evaluate(()=>new Promise(requestAnimationFrame));const before=await capture(page),fgBefore=await page.evaluate(()=>[...window.A.E.api.foreground]);
 if(c.tool==='move'){
  const pts=c.variant==='move'?[[32,32],[40,36]]:c.variant==='scale'?[[48,48],[56,56]]:c.variant==='rotate'?[[54,32],[48,48]]:[[48,48],[54,42]];
  await gesture(page,pts,{keys:c.variant==='warp-meta'?['Meta']:c.variant==='warp-ctrl'?['Control']:[]});
 }else if(c.tool==='lasso'&&c.variant==='polygon'){await gesture(page,[[16,16],[44,16],[44,44]],{click:true});await page.keyboard.press('Enter');}
 else if(c.tool==='lasso')await gesture(page,[[16,16],[44,16],[44,44],[16,44],[16,16]]);
 else if(['marquee','crop'].includes(c.tool)){await gesture(page,[[12,12],[52,48]]);if(c.tool==='crop')await page.keyboard.press('Enter');}
 else if(['wand','objectSelect','eyedropper','zoom'].includes(c.tool))await gesture(page,[[28,28]],{click:true,keys:c.variant==='out'?['Alt']:[]});
 else if(c.tool==='healing')await gesture(page,[[32,32]],{click:true});
 else if(c.tool==='clone'){await gesture(page,[[20,20]],{click:true,keys:['Alt']});await gesture(page,[[40,40],[41,40]]);}
 else if(c.tool==='gradient')await gesture(page,[[18,20],[44,42]]);
 else if(c.tool==='shape')await gesture(page,[[20,20],[44,44]]);
 else if(c.tool==='type'){if(c.variant==='point')await gesture(page,[[18,18]],{click:true});else await gesture(page,[[8,8],[56,56]]);const input=page.getByRole('textbox',{name:'编辑画布文字'});await input.fill('Audit\nText');await input.press('Control+Enter');}
 else await gesture(page,[[26,32],[42,36]]);
 await page.waitForTimeout(150);let after=await capture(page);const checks=[check('工具栏选中了目标工具',after.tool===c.tool,after.tool)];
 if(c.tool==='move')checks.push(check('对应变换实际生效',c.variant.startsWith('warp')?!!after.layers.at(-1).transform.warp:JSON.stringify(after.layers.at(-1).transform)!==JSON.stringify(before.layers.at(-1).transform),after.layers.at(-1).transform));
 else if(['marquee','lasso','wand','objectSelect'].includes(c.tool))checks.push(check('建立文档空间的非空选区',after.selection?.count>0&&after.selection.width===64&&after.selection.height===64,after.selection));
 else if(c.tool==='crop'){checks.push(check('裁剪改变文档范围',after.width<64&&after.height<64,[after.width,after.height]));if(c.variant!=='free'){const[a,b]=c.variant.split(':').map(Number);checks.push(check('裁剪比例正确',Math.abs(after.width/after.height-a/b)<.09,after.width/after.height));}}
 else if(['shape','type'].includes(c.tool)){checks.push(check('新增可见图层',after.layers.length===before.layers.length+1&&after.layers.at(-1).pixels.visible>0,after.layers.at(-1)));if(c.tool==='type')checks.push(check('画布内文字编辑生效',after.layers.at(-1).text?.content==='Audit\nText'));}
 else if(c.tool==='eyedropper'){const fg=await page.evaluate(()=>[...window.A.E.api.foreground]);checks.push(check('吸取了点击位置的颜色',JSON.stringify(fg)==='[200,60,20]',fg));}
 else if(c.tool==='hand')checks.push(check('视口平移而不改像素',JSON.stringify(before.viewport)!==JSON.stringify(after.viewport)&&before.composite.hash===after.composite.hash,after.viewport));
 else if(c.tool==='zoom')checks.push(check('缩放方向正确',c.variant==='out'?after.viewport.zoom<before.viewport.zoom:after.viewport.zoom>before.viewport.zoom,[before.viewport.zoom,after.viewport.zoom]));
 else if(c.tool==='blur'&&c.variant==='mask'){checks.push(check('模糊改变蒙版但不改图像',after.layers.at(-1).mask.hash!==before.layers.at(-1).mask.hash&&after.layers.at(-1).pixels.hash===before.layers.at(-1).pixels.hash));}
 else checks.push(check('笔触改变目标像素',after.layers.at(-1).pixels.hash!==before.layers.at(-1).pixels.hash));
 if(!['hand','zoom','eyedropper'].includes(c.tool)){
  checks.push(check('编辑产生历史',after.history>before.history,[before.history,after.history]));
  if(after.history>before.history){await page.evaluate(async n=>{while(window.A.E.currentHistory().position>n)await window.A.E.commands.run('undo');},before.history);const undone=await capture(page);checks.push(check('撤销恢复编辑前内容',semantic(undone)===semantic(before)));await page.evaluate(async n=>{while(window.A.E.currentHistory().position<n&&window.A.E.currentHistory().canRedo)await window.A.E.commands.run('redo');},after.history);const redone=await capture(page);checks.push(check('重做恢复编辑结果',semantic(redone)===semantic(after)));}
 }
 if(page.auditErrors.length)checks.push(check('无页面异常',false,page.auditErrors));
 res={...c,kind:'tool',title:t.name+' / '+c.variant,status:checks.every(x=>x.pass)?'通过':'失败',checks,scope:'工具栏点击、模式下拉、真实画布手势及撤销重做；固定样本参数经 API 设置',before,after};
}catch(e){res={...c,kind:'tool',status:'失败',error:String(e.message).slice(0,1400)};}finally{if(page)await page.close();}
 const i=results.findIndex(r=>r.id===res.id);if(i>=0)results[i]=res;else results.push(res);await saveJSON('tools-results.json',results);console.log(c.id,res.status,res.error??res.checks.filter(x=>!x.pass).map(x=>x.label).join('；'));
}}finally{await browser.close();}
