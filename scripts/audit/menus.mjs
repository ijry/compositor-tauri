import fs from 'node:fs/promises';
import {launch,pageFor,capture,saveJSON,root} from './harness.mjs';
const catalog=JSON.parse(await fs.readFile(root+'/docs/audit/catalog-static.json','utf8'));
const selected=process.argv.slice(2);const results=selected.length?JSON.parse(await fs.readFile((process.env.AUDIT_OUT?root+'/'+process.env.AUDIT_OUT:root+'/docs/audit')+'/menus-results.json','utf8').catch(()=> '[]')):[];const browser=await launch();
const check=(label,pass,actual)=>({label,pass:!!pass,actual});
const changed=(before,after)=>JSON.stringify(before)!==JSON.stringify(after);
async function prepare(page,item){const cmd=item.action.command;
 await page.evaluate(async cmd=>{const {E,D,P,Panels}=window.A,H=window.auditHost,d=E.api.doc;
  if(cmd==='openPsd')H.openPath='/audit/input.psd';if(cmd==='openRaw')H.openPath='/audit/input.dng';
  if(cmd==='exportPsd')H.savePath='/audit/output.psd';
  if(cmd==='watchComp')d.packagePath='/audit/project.comp';
  if(cmd==='undo'||cmd==='redo'){await E.commands.run('newLayer');if(cmd==='redo')await E.commands.run('undo');}
  if(cmd==='paste')await E.commands.run('copyMerged');
  if(cmd==='moveLayerUp')d.activeLayerId=d.layers[0].id;
  if(['deselect','inverseSelection','copy','copyMerged','cut','fillForeground','fillBackground','clearSelection','contentAwareFill','selectionExpand','selectionContract','selectionFeather','selectionBoundary','maskFromSelection'].includes(cmd)){
   d.selection={...P.createMask(64,64,0),outline:null};for(let y=24;y<40;y++)for(let x=24;x<40;x++)d.selection.data[y*64+x]=255;
  }
  if(['applyMask','invertMask','loadMaskAsSelection'].includes(cmd)){D.addLayerMask(E.api.activeLayer(),64,64);if(cmd==='applyMask')E.api.activeLayer().mask.pixels.data.fill(0,0,512);}
  if(cmd==='closeDocument')d.dirty=true;
  if(cmd==='trim'){const l=window.A.pixel('裁边样本',32,32,[0,0,0,0]);for(let y=8;y<24;y++)for(let x=8;x<24;x++)l.pixels.data.set([255,0,0,255],(y*32+x)*4);d.layers=[l];d.activeLayerId=l.id;d.width=d.height=32;E.api.setBackground([0,0,0]);}
  if(cmd==='fitCanvas')E.api.setViewport({zoom:.3});
  if(cmd==='resetPanels'){Panels.toggleFloat('layers');Panels.moveFloat('layers',200,200);}
  E.api.invalidate();
 },cmd);
 if(item.action.command==='exportImage')await page.evaluate(format=>{window.auditHost.savePath='/audit/output.'+(format==='jpeg'?'jpg':format);},item.action.payload.format);
 await page.evaluate(()=>new Promise(requestAnimationFrame));
}
async function menuClick(page,item){
 await page.locator('.menu-title').filter({hasText:new RegExp('^'+item.category+'$')}).hover();
 const re=new RegExp('^'+item.label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
 await page.locator('.el-dropdown-menu:visible .el-dropdown-menu__item').filter({hasText:re}).first().click({timeout:5000});
}
async function inspect(page,item,before){const c=item.action.command,a=await capture(page);const checks=[];
 const host=await page.evaluate(()=>({writes:window.auditHost.writes,opens:window.auditHost.opens,messages:window.auditHost.messages,confirmations:window.auditHost.confirmations}));
 if(item.action.kind==='dialog'){checks.push(check('打开正确表单',a.dialog===item.action.dialog,a.dialog));
  if(['canvasSize','imageSize'].includes(item.action.dialog)&&a.dialog===item.action.dialog){const dialog=page.locator('.el-dialog:visible');const numbers=dialog.locator('input[type=number]');await numbers.nth(0).fill('80');await numbers.nth(0).press('Tab');await page.waitForTimeout(50);await numbers.nth(1).fill('48');await numbers.nth(1).press('Tab');await dialog.getByRole('button',{name:'确定',exact:true}).click();const next=await capture(page);checks.push(check('提交表单更新尺寸',next.width===80&&next.height===48,[next.width,next.height]));}
  if(item.action.dialog==='colorRange'&&a.dialog==='colorRange'){await page.locator('.el-dialog:visible').getByRole('button',{name:'确定',exact:true}).click();const next=await capture(page);checks.push(check('提交创建选区',next.selection?.count>0,next.selection));}
 }else if(item.action.kind==='layout'){const areas=await page.evaluate(()=>Object.fromEntries(Object.entries(window.A.Panels.panelStates).map(([id,p])=>[id,p.area])));checks.push(check('恢复停靠布局',areas.layers==='right'&&areas.properties==='right'&&areas.history==='bottom',areas));}
 else if(['newCanvas','sample','openPsd','openComp'].includes(c)){checks.push(check('创建或打开文档',a.documents===before.documents+1,a.documents));if(c==='openPsd'||c==='openComp')checks.push(check('读取正确尺寸',a.width===16&&a.height===16,[a.width,a.height]));}
 else if(c==='openImage'){checks.push(check('导入一层像素',a.layers.length===before.layers.length+1,a.layers.length));checks.push(check('图像尺寸正确',a.layers.at(-1)?.pixels?.width===16,a.layers.at(-1)?.pixels));}
 else if(c==='openRaw'){checks.push(check('进入显影界面',a.dialog==='rawDevelop',a.dialog));const last=a.layers.at(-1);checks.push(check('默认显影不是全黑',last?.pixels?.first?.slice(0,3).some(x=>x>0),last?.pixels));}
 else if(c==='saveComp'||c==='saveCompAs'){checks.push(check('保存成功',a.status.includes('已保存到')&&!a.dirty&&host.writes.some(w=>w.path.endsWith('/manifest.json')),{status:a.status,writes:host.writes.length}));}
 else if(c==='watchComp'){
  await page.waitForTimeout(500);await page.evaluate(()=>{window.auditHost.manifest.layers[0].name='外部修改';window.auditHost.writeManifest();});
  await page.waitForFunction(()=>window.A.E.api.activeLayer()?.name==='外部修改',{},{timeout:4000});checks.push(check('稳定变化重载原标签',true));await page.evaluate(()=>window.A.E.commands.run('unwatchComp'));
 }
 else if(c==='exportImage'||c==='exportPsd'){
  await page.waitForFunction(()=>window.auditHost.writes.length>0,{},{timeout:5000});const details=await page.evaluate(async c=>{const h=window.auditHost,p=h.writes.at(-1).path,b=Uint8Array.from(atob(h.files[p]),x=>x.charCodeAt(0));if(c==='exportPsd'){const d=window.A.PSD.importPsd(b.buffer,'校验').document;return{prefix:Array.from(b.slice(0,4)),width:d.width,height:d.height};}const blob=new Blob([b]);const image=await createImageBitmap(blob);const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);return{prefix:Array.from(b.slice(0,4)),width:image.width,height:image.height};},c);
  checks.push(check('导出容器可重新解码且尺寸正确',details.width===before.width&&details.height===before.height,details));
 }
 else if(c==='closeDocument')checks.push(check('关闭并确认未保存文档',a.empty&&host.confirmations.length===1,{empty:a.empty,confirmations:host.confirmations.length}));
 else if(c==='undo'||c==='redo')checks.push(check('历史位置变化正确',a.history===before.history+(c==='undo'?-1:1),[before.history,a.history]));
 else if(c==='copy'||c==='copyMerged'){await page.evaluate(()=>window.A.E.commands.run('paste'));const pasted=await capture(page);checks.push(check('复制后可粘贴独立像素',pasted.layers.length===before.layers.length+1,pasted.layers.at(-1)?.pixels));}
 else if(c==='cut')checks.push(check('剪切只降低活动层覆盖率',a.layers.at(-1).pixels.visible<before.layers.at(-1).pixels.visible,[before.layers.at(-1).pixels.visible,a.layers.at(-1).pixels.visible]));
 else if(c==='paste'||c==='newLayer'||c==='newGroup'||c==='duplicateLayer')checks.push(check('新增目标图层',a.layers.length===before.layers.length+1,a.layers.length));
 else if(c==='deleteLayer')checks.push(check('删除一个活动层',a.layers.length===before.layers.length-1,a.layers.length));
 else if(c==='mergeDown'||c==='flatten'){checks.push(check('合并为单层',a.layers.length===1,a.layers.length));checks.push(check('合并保持图像',a.composite.hash===before.composite.hash,[before.composite.hash,a.composite.hash]));}
 else if(c==='moveLayerUp'||c==='moveLayerDown')checks.push(check('图层次序改变',a.layers.map(l=>l.id).join()!==before.layers.map(l=>l.id).join()));
 else if(c==='trim')checks.push(check('修去空白边界',a.width===16&&a.height===16,[a.width,a.height]));
 else if(c==='rotateCanvasAll')checks.push(check('旋转实际变换',a.layers.at(-1).transform.rotation===item.action.payload,a.layers.at(-1).transform.rotation));
 else if(c==='flipCanvasH'||c==='flipCanvasV')checks.push(check('画布翻转改变相应变换',c==='flipCanvasH'?a.layers.at(-1).transform.flipX!==before.layers.at(-1).transform.flipX:a.layers.at(-1).transform.flipY!==before.layers.at(-1).transform.flipY));
 else if(c==='addMask'||c==='maskFromSelection')checks.push(check('创建蒙版',!!a.layers.at(-1).mask,a.layers.at(-1).mask));
 else if(c==='applyMask'){checks.push(check('移除蒙版并保留图像',!a.layers.at(-1).mask&&a.composite.hash===before.composite.hash));}
 else if(c==='invertMask')checks.push(check('蒙版覆盖实际改变',a.layers.at(-1).mask?.hash!==before.layers.at(-1).mask?.hash));
 else if(c==='addAdjustment'){
  checks.push(check('创建正确调整层',a.layers.at(-1).adjustment?.kind===item.action.payload));
  const section=page.locator('.props section').filter({has:page.locator('h4').filter({hasText:'调整：'+item.action.payload})});
  const inputs=await section.locator('input,select,button').count();const hint=await section.textContent();
  checks.push(check('参数可在界面操作',inputs>0||item.action.payload==='Invert',{inputs,hint}));
 }
 else if(c?.startsWith('filter')||['fillForeground','fillBackground','clearSelection','contentAwareFill'].includes(c)){checks.push(check('操作实际改变像素',a.layers.at(-1).pixels.hash!==before.layers.at(-1).pixels.hash));checks.push(check('操作可撤销',a.history>before.history));}
 else if(c==='selectAll')checks.push(check('全选整张文档',a.selection?.count===4096,a.selection));
 else if(c==='deselect')checks.push(check('取消选择',a.selection===null,a.selection));
 else if(c==='inverseSelection')checks.push(check('反选覆盖正确',a.selection?.count===3840,a.selection));
 else if(['selectSubject','selectionExpand','selectionContract','selectionFeather','selectionBoundary','loadLayerPixelsAsSelection','loadMaskAsSelection'].includes(c)){
  let valid=!!a.selection;
  if(c==='selectionExpand')valid=a.selection?.count>before.selection.count;
  if(c==='selectionContract')valid=a.selection?.count<before.selection.count;
  if(c==='selectionFeather'||c==='selectionBoundary')valid=a.selection?.hash!==before.selection?.hash;
  if(c==='loadLayerPixelsAsSelection'||c==='loadMaskAsSelection')valid=a.selection?.count===1024;
  if(c==='selectSubject')valid=a.selection?.count>0&&a.selection?.count<4096;
  checks.push(check('选区结果符合操作',valid,a.selection));
 }
 else if(c==='zoomIn'||c==='zoomOut')checks.push(check('缩放级别变化',c==='zoomIn'?a.viewport.zoom>before.viewport.zoom:a.viewport.zoom<before.viewport.zoom));
 else if(c==='fitCanvas')checks.push(check('适配画布',a.viewport.zoom>before.viewport.zoom));
 else if(c==='actualPixels')checks.push(check('实际像素为 100%',a.viewport.zoom===1,a.viewport.zoom));
 else if(c?.startsWith('toggle')){
  const key={toggleRulers:'rulers',toggleGrid:'grid',toggleGuides:'guides',toggleTransformControls:'transformControls'}[c];
  const val=await page.evaluate(key=>window.A.E.api.ui[key],key);checks.push(check('开关状态发生改变',val!==before.ui?.[key],val));
 }
 else if(c==='setTheme'){const mode=await page.evaluate(()=>window.A.Theme.themeMode.value);checks.push(check('主题模式设置生效',mode===item.action.payload,mode));}
 else if(['recentList','gridSettings','snapSettings','shortcuts','about'].includes(c)){const expected={recentList:'recent'}[c]??c;checks.push(check('打开目标界面',a.dialog===expected,a.dialog));}
 else checks.push(check('存在可核验结果',false,c));
 return{checks,before:{...before,layers:before.layers?.map(l=>({id:l.id,kind:l.kind,pixels:l.pixels}))},after:a,host};
}
try{
 for(const item of catalog.menus.filter(item=>!selected.length||selected.includes(item.id))){const start=Date.now();let page,result;try{
   page=await pageFor(browser);await prepare(page,item);let before=await capture(page);before.ui=await page.evaluate(()=>({...window.A.E.api.ui}));await menuClick(page,item);await page.waitForTimeout(160);result=await inspect(page,item,before);if(page.auditErrors.length)result.checks.push(check('没有页面异常',false,page.auditErrors));
   result={id:item.id,kind:'menu',title:item.category+' / '+item.label,source:item.source,action:item.action,status:result.checks.every(c=>c.pass)?'通过':'失败',scope:'真实菜单点击与所列结果；宿主文件交互为内存替身',...result};
  }catch(e){result={id:item.id,kind:'menu',title:item.category+' / '+item.label,action:item.action,status:'失败',error:String(e.message).slice(0,1400)};}
  finally{if(page)await page.close();}
  result.durationMs=Date.now()-start;const index=results.findIndex(r=>r.id===result.id);if(index>=0)results[index]=result;else results.push(result);await saveJSON('menus-results.json',results);console.log(item.id,result.status,result.title,result.error??result.checks?.filter(c=>!c.pass).map(c=>c.label).join('；'));
 }
}finally{await browser.close();}
