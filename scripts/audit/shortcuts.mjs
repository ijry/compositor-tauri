import fs from 'node:fs/promises';
import {launch,pageFor,capture,saveJSON,root} from './harness.mjs';
const catalog=JSON.parse(await fs.readFile(root+'/docs/audit/catalog-runtime.json','utf8'));
const selected=process.argv.slice(2),results=selected.length?JSON.parse(await fs.readFile((process.env.AUDIT_OUT?root+'/'+process.env.AUDIT_OUT:root+'/docs/audit')+'/shortcuts-results.json','utf8').catch(()=> '[]').catch(()=> '[]')):[];
const browser=await launch();
const physical={';':'Semicolon',"'":'Quote','[':'BracketLeft',']':'BracketRight','=':'Equal','-':'Minus'};
const chordText=c=>[c.ctrl?'Control':null,c.shift?'Shift':null,c.alt?'Alt':null,physical[c.key]??(/^[a-z]$/.test(c.key)?'Key'+c.key.toUpperCase():/^[0-9]$/.test(c.key)?'Digit'+c.key:c.key)].filter(Boolean).join('+');
async function prepare(page,id){await page.evaluate(async id=>{const {E,D,P}=window.A,d=E.api.doc;
 if(id.startsWith('tool.')&&!id.includes('Colors'))E.setTool(id==='tool.hand'?'move':'hand');
 if(id.startsWith('brush.')){E.setTool('brush');E.api.setToolOption('size',40);E.api.setToolOption('hardness',.5);}
 if(id==='file.save'||id==='file.saveAs')window.auditHost.savePath='/audit/saved.comp';
 if(id==='edit.undo'||id==='edit.redo'){await E.commands.run('newLayer');if(id==='edit.redo')await E.commands.run('undo');}
 if(id==='edit.paste')await E.commands.run('copy');
 if(['edit.cut','edit.copy','edit.copyMerged','edit.clear','edit.contentAware','select.deselect','select.inverse'].includes(id)){d.selection={...P.createMask(64,64,0),outline:null};for(let y=24;y<40;y++)for(let x=24;x<40;x++)d.selection.data[y*64+x]=255;}
 if(id==='layer.up')d.activeLayerId=d.layers[0].id;
 if(id==='layer.ungroup'){await E.commands.run('group',d.layers.map(l=>l.id));}
 if(id==='view.actual')E.api.setViewport({zoom:4});if(id==='view.fit')E.api.setViewport({zoom:.3});
 window.auditKeys=[];document.addEventListener('keydown',event=>window.auditKeys.push({key:event.key,code:event.code,ctrl:event.ctrlKey,shift:event.shiftKey,alt:event.altKey}),true);
 E.api.invalidate();document.activeElement?.blur();
 },id);
 if(id==='layer.group'){await page.locator('.layer-row').filter({hasText:'背景'}).click();await page.locator('.layer-row').filter({hasText:'前景'}).click({modifiers:['Shift']});await page.evaluate(()=>document.activeElement?.blur());}
}
async function extra(page){return page.evaluate(()=>({ui:{...window.A.E.api.ui},foreground:[...window.A.E.api.foreground],background:[...window.A.E.api.background],size:window.A.E.api.option('size',40),hardness:window.A.E.api.option('hardness',70),writes:window.auditHost.writes,opens:window.auditHost.opens,keys:window.auditKeys??[],messages:window.auditHost.messages}));}
function check(item,b,a,x,y){const id=item.id;let pass=false,note='';
 if(id.startsWith('tool.')&&!id.includes('Colors'))pass=a.tool===id.slice(5);
 else if(id==='file.new')pass=a.dialog==='newCanvas';
 else if(id==='file.newLayer')pass=a.layers.length===b.layers.length+1;
 else if(id==='file.open')pass=a.documents===b.documents+1&&a.width===16;
 else if(['file.save','file.saveAs'].includes(id))pass=y.writes.some(w=>w.path.endsWith('/manifest.json'))&&!a.dirty;
 else if(id.startsWith('file.export')){pass=a.dialog==='exportDialog';note='仅验证快捷键打开对话框；格式选择及预览另见工作流验收。';}
 else if(id==='file.close')pass=a.empty===true;
 else if(id==='edit.undo')pass=a.layers.length===b.layers.length-1;
 else if(id==='edit.redo'||id==='edit.paste')pass=a.layers.length===b.layers.length+1;
 else if(id==='edit.copy'||id==='edit.copyMerged')pass=true; // 下方必须实际粘贴并校验内容。
 else if(['edit.cut','edit.clear','edit.contentAware','edit.fillForeground','edit.fillBackground','adjust.invertPixels'].includes(id))pass=a.layers.at(-1)?.pixels?.hash!==b.layers.at(-1)?.pixels?.hash;
 else if(id.startsWith('canvas.'))pass=a.dialog===(id==='canvas.size'?'canvasSize':'imageSize');
 else if(id==='select.all')pass=a.selection?.count===4096;
 else if(id==='select.deselect')pass=a.selection===null;
 else if(id==='select.inverse')pass=a.selection?.count===4096-b.selection.count;
 else if(id==='select.subject')pass=a.selection?.count>0&&a.selection.count<4096;
 else if(id.startsWith('adjust.'))pass=a.layers.length===b.layers.length+1&&a.layers.at(-1)?.kind==='adjustment';
 else if(id==='layer.duplicate')pass=a.layers.length===b.layers.length+1;
 else if(id==='layer.clipping')pass=a.layers.at(-1).clipping!==b.layers.at(-1).clipping;
 else if(id==='layer.group')pass=a.layers.some(l=>l.kind==='group')&&a.layers.filter(l=>l.kind!=='group').every(l=>l.parent);
 else if(id==='layer.ungroup')pass=!a.layers.some(l=>l.kind==='group')&&a.layers.every(l=>!l.parent);
 else if(id==='layer.up'||id==='layer.down')pass=a.layers[0].id!==b.layers[0].id;
 else if(id==='layer.mergeDown')pass=a.layers.length===b.layers.length-1;
 else if(id==='view.fit'||id==='view.zoomIn')pass=a.viewport.zoom>b.viewport.zoom;
 else if(id==='view.actual')pass=a.viewport.zoom===1;
 else if(id==='view.zoomOut')pass=a.viewport.zoom<b.viewport.zoom;
 else if(id==='view.snap')pass=a.dialog==='snapSettings';
 else if(id.startsWith('view.'))pass=y.ui[id.slice(5)]!==x.ui[id.slice(5)];
 else if(id==='brush.smaller')pass=y.size<x.size;
 else if(id==='brush.bigger')pass=y.size>x.size;
 else if(id==='brush.softer')pass=Math.abs(y.hardness-(x.hardness-.1))<1e-6;
 else if(id==='brush.harder')pass=Math.abs(y.hardness-(x.hardness+.1))<1e-6;
 else if(id==='tool.swapColors')pass=JSON.stringify(y.foreground)===JSON.stringify(x.background)&&JSON.stringify(y.background)===JSON.stringify(x.foreground);
 else if(id==='tool.resetColors')pass=JSON.stringify(y.foreground)==='[0,0,0]'&&JSON.stringify(y.background)==='[255,255,255]';
 else if(id==='help.shortcuts')pass=a.dialog==='shortcuts';
 return{pass,note};
}
async function store(row){const i=results.findIndex(r=>r.id===row.id);if(i<0)results.push(row);else results[i]=row;await saveJSON('shortcuts-results.json',results);console.log(row.id,row.status,row.note??row.error??'');}
try{
 for(const item of catalog.shortcuts){const id='KEY-'+item.id;if(selected.length&&!selected.includes(id))continue;const page=await pageFor(browser);let row={id,title:item.title,kind:'shortcut',chord:chordText(item.chord),scope:'独立 Chromium / Windows US 键位真实键盘事件；不是 OTools 宿主或 macOS 实机验证。'};
 try{await prepare(page,item.id);const before=await capture(page),x=await extra(page);await page.keyboard.press(row.chord);if(['file.save','file.saveAs'].includes(item.id))await page.waitForFunction(()=>window.auditHost.writes.some(w=>w.path.endsWith('/manifest.json'))&&!window.A.E.api.doc.saving,{timeout:15000});await page.waitForTimeout(200);const after=await capture(page),y=await extra(page);const result=check(item,before,after,x,y);if(['edit.copy','edit.copyMerged'].includes(item.id)){await page.evaluate(()=>window.A.E.commands.run('paste'));const pasted=await capture(page);result.pass=pasted.layers.length===after.layers.length+1&&pasted.layers.at(-1).pixels.visible>0;result.note='真实快捷键复制后调用粘贴读取内部剪贴内容（系统剪贴板另列未实测）';row.pasted=pasted;}
 Object.assign(row,{status:result.pass?'通过':'失败',...result,before,after,extraBefore:x,extraAfter:y,errors:page.auditErrors});if(page.auditErrors.length){row.status='失败';row.pass=false;}
 }catch(e){row.status='失败';row.error=e.message;}finally{await page.close();}await store(row);}
 // 录制、自定义、重载持久化、恢复、输入框保护分别检查，避免只验证状态表。
 if(!selected.length||selected.includes('KEY-customize-ui')){const page=await pageFor(browser);let row={id:'KEY-customize-ui',title:'快捷键 UI 录制、保存、重载、恢复',kind:'shortcut',scope:'宿主持久化采用独立 localStorage 替身'};try{
 await page.keyboard.press('Control+KeyK');const target=page.locator('.shortcut-editor .row').filter({has:page.locator('.col-title').getByText('画布大小…',{exact:true})});await target.getByText('录制',{exact:true}).click();await page.keyboard.press('Control+Alt+KeyQ');await page.keyboard.press('Enter');await page.waitForTimeout(100);const saved=await page.evaluate(()=>window.A.S.shortcutItems.find(i=>i.id==='canvas.size').chord);
 await page.locator('.el-dialog:visible').getByRole('button',{name:'关闭',exact:true}).click();await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('Control+Alt+KeyQ');const triggered=(await capture(page)).dialog==='canvasSize';
 await page.reload({waitUntil:'networkidle'});const persisted=await page.evaluate(async()=>{const S=await import('/src/composables/shortcuts.ts');return S.shortcutItems.find(i=>i.id==='canvas.size').chord;});
 const restored=await page.evaluate(async()=>{const S=await import('/src/composables/shortcuts.ts');S.resetShortcut('canvas.size');return !S.isOverridden('canvas.size');});Object.assign(row,{pass:triggered&&saved.key==='q'&&persisted.key==='q'&&restored,saved,persisted,triggered,restored});row.status=row.pass?'通过':'失败';
 }catch(e){row.status='失败';row.error=e.message;}finally{await page.close();}await store(row);}
 if(!selected.length||selected.includes('KEY-input-guard')){const page=await pageFor(browser);let row={id:'KEY-input-guard',title:'输入框输入 B 不切换画笔、不触发全局快捷键',kind:'shortcut'};try{await page.keyboard.press('Control+Alt+KeyC');const input=page.locator('.el-dialog:visible input').first();await input.focus();await page.keyboard.press('KeyB');row.pass=(await capture(page)).tool==='move';row.status=row.pass?'通过':'失败';}catch(e){row.status='失败';row.error=e.message;}finally{await page.close();}await store(row);}
}finally{await browser.close();}
