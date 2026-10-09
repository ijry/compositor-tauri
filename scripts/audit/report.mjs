import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 汇总审计证据；“通过”只代表各条记录列明的断言与环境，不代表整项功能全覆盖。 */
const root=process.cwd(),dir=path.join(root,'docs/audit');
const read=name=>fs.readFile(path.join(dir,name),'utf8').then(JSON.parse);
const catalog=await read('catalog-static.json'),runtime=await read('catalog-runtime.json'),native=await read('catalog-upstream.json'),mapping=await read('claim-map.json'),findings=await read('findings.json'),validation=await read('validation.json');
const currentSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(currentSha!==catalog.localSha)throw Error('业务基线已变化，必须重跑审计，不能沿用旧结论。');
const files=(await fs.readdir(dir)).filter(name=>name.endsWith('-results.json')).sort();
const groups=[],rows=[];
for(const file of files){const entries=await read(file);groups.push({file,entries});for(const entry of entries)rows.push({...entry,evidenceFile:file});}
if(new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('证据 ID 重复。');
const statuses=['通过','部分通过','失败','未实现','未验证','未实测'];
const counts=list=>Object.fromEntries(statuses.map(s=>[s,list.filter(x=>x.status===s).length]));
const stats=counts(rows),byId=new Map(rows.map(r=>[r.id,r]));
const md=value=>String(value??'').replaceAll('|','\\|').replaceAll('\r','').replaceAll('\n',' ');
const anchor=id=>'case-'+id.replace(/[^a-zA-Z0-9_-]/g,'-');
const evidence=id=>byId.has(id)?'['+md(id)+'](全量功能验收.md#'+anchor(id)+')':'['+md(id)+'](validation.json)';
const pattern=selector=>new RegExp('^'+selector.split('*').map(p=>p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$');
const resolve=selectors=>rows.filter(r=>selectors.some(s=>pattern(s).test(r.id))).map(r=>r.id);
const synthetic=new Set(['VALIDATION-PACKAGE','VALIDATION-BUILD','VALIDATION-TYPES','VALIDATION-STRUCTURE','VALIDATION-README','VALIDATION-RELEASE','REGRESSION-147','HOST-OTOOLS']);
const refs=ids=>{const list=[...new Set(ids)];return list.slice(0,10).map(evidence).join('、')+(list.length>10?' 等 '+list.length+' 条':'');};
const proofSummary=r=>{const failed=(r.checks??[]).filter(x=>x.pass===false).map(x=>x.label).join('；');let s=r.error??failed??'';if(!s)s=r.reason??r.note??r.detail??r.scope??(r.expected?JSON.stringify(r.expected):'具体实际值、预期和快照见原始 JSON。');return md(s).slice(0,230);};
const intro='> 本地业务基线 `'+catalog.localSha+'`；上游 `robbietilton/Compositor@'+catalog.upstreamSha+'`（1.4.6）。\n> 本轮只增加审计证据、文档和脚本，未修复业务、未发布。脚本使用独立 Chromium 与内存 OTools 文件 API 替身，不操作用户真实工程。\n';
const countTable=(list)=>'| 记录集合 | 合计 | '+statuses.join(' | ')+' |\n|---|---:|'+statuses.map(()=>'---:').join('|')+'|\n'+list.map(({name,entries})=>{const c=counts(entries);return '| '+name+' | '+entries.length+' | '+statuses.map(s=>c[s]).join(' | ')+' |';}).join('\n');

// 给每项问题绑定真实源码行与已有证据，拒绝悬空引用。
for(const f of findings){const source=await fs.readFile(path.join(root,f.file),'utf8'),offset=source.indexOf(f.needle);if(offset<0)throw Error(f.id+' 代码定位失效：'+f.needle);f.line=source.slice(0,offset).split('\n').length;f.evidence=resolve(f.selectors);if(!f.evidence.length)throw Error(f.id+' 没有测试证据');f.failedEvidence=f.evidence.filter(id=>['失败','未实现'].includes(byId.get(id).status));if(!f.failedEvidence.length)throw Error(f.id+' 的失败已经不存在，请重新审阅问题而不是沿用旧结论。');}
const unclassified=rows.filter(r=>['失败','未实现'].includes(r.status)&&!findings.some(f=>f.failedEvidence.includes(r.id)));
const perIssue=new Map();for(const f of findings)for(const id of f.evidence){const a=perIssue.get(id)??[];a.push(f.id);perIssue.set(id,a);}
await fs.writeFile(path.join(dir,'findings-evidence.json'),JSON.stringify(findings,null,2));

let matrix='# 全量功能验收矩阵\n\n'+intro+'\n## 结论\n\n**尚不能验收为“全部功能可用”。** 下表记录的是指定场景的结果，不是“通过数 / 按钮数”的完成率。数值差分只说明有输出时标为部分通过；没有真实宿主、真实相机或外部软件样本的项目不冒认通过。\n\n';
matrix+=countTable([...groups.map(g=>({name:'['+g.file+']('+g.file+')',entries:g.entries})),{name:'专项记录总计（有重叠场景）',entries:rows}]);
matrix+='\n\n- '+findings.length+' 组已定位问题（含缺失功能、语义差异和声明不符），见 [阻断问题](阻断问题.md)。\n- 原计划 60 项、上游 README 51 项逐条结论见 [功能对照总表](功能对照总表.md)。\n- 本地93个命令与上游115个快捷键/86个菜单源码节点的覆盖详见 [上游快捷键及命令对照](上游快捷键及命令对照.md)。\n- 此处“通过”是表内限定条件通过，不等于对应整项声明通过；原版控件枚举是静态对照，不假称在 Windows 执行了 macOS。\n- 菜单新建默认画布可触发（MENU-001通过），但尺寸表单不可达（KEY-file.new失败）；此类正例与反例必须同时看。\n\n';
for(const g of groups){matrix+='## '+g.file+'\n\n| ID | 场景 | 结果 | 断言/范围摘要 | 关联问题 |\n|---|---|---|---|---|\n';for(const r of g.entries)matrix+='| <a id="'+anchor(r.id)+'"></a>['+md(r.id)+']('+g.file+') | '+md(r.title??r.label??r.id)+' | '+r.status+' | '+proofSummary(r)+' | '+(perIssue.get(r.id)??[]).map(id=>'['+id+'](阻断问题.md#'+id.toLowerCase()+')').join('、')+' |\n';matrix+='\n';}
await fs.writeFile(path.join(dir,'全量功能验收.md'),matrix);

let problem='# 阻断问题与后续修复清单\n\n'+intro+'\n**以下复选框表示修复进度，本轮均未修复，故不打勾。** P1：内容/文件/核心工作流错误；P2：重要功能或交互缺口；P3：低优先级声明/界面差异。分组数不是不同崩溃数量，多个失败用例可属于同一根因。\n\n';
problem+='优先级统计：'+['P1','P2','P3'].map(p=>p+' '+findings.filter(f=>f.priority===p).length+' 组').join('；')+'。\n\n';
for(const f of findings){problem+='<a id="'+f.id.toLowerCase()+'"></a>\n## '+f.id+' · '+f.priority+' · '+f.title+'\n\n- [ ] 修复并回归：'+f.title+'\n- **定位**：['+f.file+':'+f.line+'](../../'+f.file+'#L'+f.line+')\n- **反例/根因**：'+f.explanation+'\n- **复现证据**：'+refs(f.evidence)+'\n- **验证要求**：使以上失败用例满足既有预期；不能仅删断言或将失败改为通过。随后回归正常路径、撤销/重做、工程往返和相关UI。\n\n';}
problem+='## 未实测条件不是已修复的问题\n\n1. 真实 OTools 窗口/文件授权、系统对话框、系统剪贴板、宿主持久化与安装后的资源加载。\n2. macOS 上游实机、Photoshop/PSB、真实相机 RAW、HEIC/HEIF/AVIF、ICC/EXIF及其他变体样本。\n3. 大画布/极高倍率/内存压力/设备像素比及多平台性能。没有执行危险的巨大分配测试。\n4. 真实磁盘故障、断电、并发外部编辑器、网络盘/权限限制与市场发布环境。\n\n路径越界只验证构造出的写入请求以及内存文件系统结果，未声称绕过真实宿主访问控制。\n';
await fs.writeFile(path.join(dir,'阻断问题.md'),problem);

// 原计划的勾选是历史声明，逐条给出现阶段可辩护的状态。
if(mapping.claims.length!==catalog.claims.length||mapping.upstream.length!==catalog.upstreamFeatures.length)throw Error('声明覆盖数量不一致');
let coverage='# 原计划与上游功能对照总表\n\n'+intro+'\n**原 `复刻计划.md` 的60个完成勾选不能作为当前验收结论。** 本表不修改历史计划，逐条重新给出结论和边界。通过依然仅限记录中的环境；不适用的 macOS 发布要求不计作功能通过。\n\n';
for(const [heading,claims,map]of [['原计划60项',catalog.claims,mapping.claims],['上游README 51项（含环境/发布要求）',catalog.upstreamFeatures,mapping.upstream]]){coverage+='## '+heading+'\n\n| ID | 原声明 | 本次结论 | 证据 | 说明 |\n|---|---|---|---|---|\n';for(const c of claims){const m=map.find(x=>x.id===c.id);if(!m)throw Error('声明无结论 '+c.id);const ids=[...resolve(m.selectors),...m.selectors.filter(s=>synthetic.has(s))];m.evidence=ids;coverage+='| '+c.id+' | '+md(c.text)+' | '+m.status+' | '+refs(ids)+' | '+md(m.note)+' |\n';}coverage+='\n';}
coverage+='## 本轮构建与既有回归\n\n| 命令 | 结果 | 限定范围 |\n|---|---|---|\n'+validation.results.map(v=>'| `'+v.command+'` | '+v.status+(v.total?'（'+v.passed+'/'+v.total+'）':'')+' | '+md(v.note??'仅验证该命令，不代表全功能完成。')+' |').join('\n')+'\n\n现有147项浏览器回归与14项发布脚本测试均通过，但本次专项反例仍大量失败，说明原有回归覆盖不足，不能用绿色CI代替完整功能验收。\n';
await fs.writeFile(path.join(dir,'功能对照总表.md'),coverage);
await fs.writeFile(path.join(dir,'claim-evidence.json'),JSON.stringify(mapping,null,2));

// 本地命令：真实菜单/快捷键、跨功能场景，以及本轮补测命令的证据索引。
const extraCommands={moveLayerTo:['FLOW-nested-command','FLOW-nested-drag-false','FLOW-nested-drag-true'],selectColorRange:['MENU-072'],canvasSize:['MENU-028','FLOW-canvas-width'],imageSize:['MENU-029','FLOW-image-aspect']};
const commandRows=catalog.commands.map(c=>{const ids=catalog.menus.filter(m=>m.action.command===c.name).map(m=>m.id);for(const s of runtime.shortcuts)if(new RegExp('\\.run\\(["\']'+c.name+'["\']').test(s.actionSource))ids.push('KEY-'+s.id);if(byId.has('CMD-'+c.name))ids.push('CMD-'+c.name);ids.push(...extraCommands[c.name]??[]);return{...c,evidence:[...new Set(ids)].filter(id=>byId.has(id))};});
const uncoveredCommands=commandRows.filter(c=>!c.evidence.length);
let nativeDoc='# 本地命令与上游快捷键/菜单对照\n\n'+intro+'\n## 本地93个命令 handler\n\n覆盖表示至少一个实际结果断言，并不保证所有上下文、参数或界面都有入口。特别是“创建成功”与“完整参数可编辑”不同。\n\n| 命令 | 源码 | 证据 | 基础结果 |\n|---|---|---|---|\n';
const worst=ids=>{const s=ids.map(id=>byId.get(id)?.status).filter(Boolean);return s.includes('失败')?'失败':s.includes('未实现')?'未实现':s.includes('未验证')?'未验证':s.includes('未实测')?'未实测':s.includes('部分通过')?'部分通过':s.length?'通过':'未实测';};
for(const c of commandRows)nativeDoc+='| '+c.name+' | ['+c.source+':'+c.line+'](../../'+c.source+'#L'+c.line+') | '+refs(c.evidence)+' | '+worst(c.evidence)+' |\n';

const keyAliases={
'Undo':['KEY-edit.undo'],'Redo':['KEY-edit.redo'],'New Canvas':['KEY-file.new'],'Open Project':['KEY-file.open'],'Save':['KEY-file.save'],'Save As':['KEY-file.saveAs'],'Export PNG':['KEY-file.exportPng','MENU-013'],'Export JPEG':['PARITY-jpeg-shortcut','FLOW-jpeg-format'],'Close Project':['KEY-file.close'],'Fit Canvas':['KEY-view.fit'],'Command Palette':['FLOW-command-palette'],'Actual Pixels':['KEY-view.actual'],'Zoom In':['KEY-view.zoomIn'],'Zoom Out':['KEY-view.zoomOut'],'Show Transform Controls':['KEY-view.transformControls'],'Cut':['KEY-edit.cut'],'Copy':['KEY-edit.copy'],'Copy Merged':['KEY-edit.copyMerged'],'Paste':['KEY-edit.paste'],'Fill with Foreground':['KEY-edit.fillForeground'],'Fill with Background':['KEY-edit.fillBackground'],'Content-Aware Fill':['PARITY-shift-delete','MENU-027'],'Select All':['KEY-select.all'],'Deselect':['KEY-select.deselect'],'Inverse Selection':['KEY-select.inverse'],'Select Subject':['KEY-select.subject'],'Curves':['PARITY-adjust-Curves'],'Levels':['PARITY-adjust-Levels'],'Hue/Saturation':['PARITY-adjust-Hue/Saturation'],'Invert Pixels / Mask':['KEY-adjust.invertPixels'],'Canvas Size':['KEY-canvas.size','FLOW-canvas-width'],'Image Size':['KEY-canvas.imageSize','FLOW-image-aspect'],'Transform Layer / Selection':['PARITY-ctrl-t'],'Duplicate / Layer via Copy':['PARITY-layer-via-copy'],'Toggle Clipping Mask':['KEY-layer.clipping'],'Group Layers':['KEY-layer.group'],'Ungroup Layers':['KEY-layer.ungroup'],'New Blank Layer':['KEY-file.newLayer'],'Move Layer Up':['KEY-layer.up'],'Move Layer Down':['KEY-layer.down'],'Merge Layers':['EDGE-merge-group-key','EDGE-merge-multi-key'],'Show Grid':['KEY-view.grid','FLOW-grid-enable'],'Show Guides':['KEY-view.guides'],'Show Rulers':['KEY-view.rulers'],'Snap':['KEY-view.snap'],'Lock Guides':['EDGE-lock-guides'],'Decrease brush size':['KEY-brush.smaller'],'Increase brush size':['KEY-brush.bigger'],'Decrease brush hardness':['KEY-brush.softer'],'Increase brush hardness':['KEY-brush.harder'],'Previous blend mode':['PARITY-blend-cycle--1'],'Next blend mode':['PARITY-blend-cycle-1'],'Cycle shape kind':['PARITY-shape-cycle'],
'Canvas Only: full screen on black, without panels':['FLOW-canvas-only'],'Select tool':['PARITY-select-tool'],'Move / Transform tool':['KEY-tool.move'],'Hand tool':['KEY-tool.hand'],'Zoom tool':['KEY-tool.zoom'],'Brush tool':['KEY-tool.brush'],'Eraser':['KEY-tool.eraser'],'Spot Healing':['KEY-tool.healing'],'Clone Stamp':['KEY-tool.clone'],'Type tool':['KEY-tool.type'],'Gradient tool':['KEY-tool.gradient'],'Shape tool':['KEY-tool.shape'],'Eyedropper tool':['KEY-tool.eyedropper'],'Marquee / cycle shape':['KEY-tool.marquee','PARITY-cycle-marquee'],'Magic':['KEY-tool.wand','PARITY-cycle-wand'],'Lasso / cycle mode':['KEY-tool.lasso','PARITY-cycle-lasso'],'Blur / Smudge / Liquify':['KEY-tool.blur','PARITY-cycle-blur'],'Crop tool':['KEY-tool.crop'],'Swap foreground/background':['KEY-tool.swapColors'],'Reset colors':['KEY-tool.resetColors'],'Cycle tool mode':['FLOW-tab-tool'],'Temporary Hand tool (hold)':['EDGE-temporary-hand'],'Delete selection / layer / effect / lasso point':['PARITY-delete'],'Apply current canvas operation':['EDGE-crop-selection'],'Cancel current canvas operation':['EDGE-crop-cancel'],'Finish editing text':['PARAM-type-content']};
const specialKeys={'\u007f':'Delete','\r':'Enter','\t':'Tab',' ':'Space','\u001b':'Escape','\uF702':'Left','\uF703':'Right','\uF700':'Up','\uF701':'Down'};
function keyLabel(k){return[(k.bits&1)?'Ctrl/⌘':null,(k.bits&2)?'Alt/⌥':null,(k.bits&4)?'Control(mac)':null,(k.bits&8)?'Shift':null,specialKeys[k.key]??k.key.toUpperCase()].filter(Boolean).join('+');}
const nativeKeys=native.shortcuts.map(k=>{let ids=keyAliases[k.title]??[],note='按原版操作语义对照，具体范围以证据记录为准。',status;
 if(/^Opacity digit (\d)/.test(k.title))ids=['PARITY-opacity-'+k.title.match(/^Opacity digit (\d)/)[1]];
 let m=/^(Nudge|Move selected pixels) (Left|Right|Up|Down) (1|10) px$/.exec(k.title);if(m){ids=['PARITY-arrow-'+m[2]+'-'+(m[3]==='10')+'-'+(m[1]!=='Nudge')];if(m[1]==='Nudge')ids.push('FLOW-nudge-history');}
 if(/^(Decrease|Increase) (tracking|leading)/.test(k.title)){const dir=k.title.includes('tracking')?(k.title.startsWith('Decrease')?'Left':'Right'):(k.title.startsWith('Decrease')?'Up':'Down');ids=['PARITY-text-'+dir+'-'+k.title.endsWith('by 10')];}
 if(k.title==='Hide Compositor'){status='不适用';note='原生Mac应用隐藏行为由OTools宿主管理。';}
 if(k.title==='Toggle Levels preview'){status='未实现';ids=['MENU-048','PARITY-adjust-Levels'];note='完整Levels编辑器及预览不存在。';}
 for(const id of ids)if(!byId.has(id))throw Error('快捷键悬空证据 '+k.title+':'+id);
 status??=worst(ids);if(['Apply current canvas operation','Cancel current canvas operation'].includes(k.title)){status='部分通过';note='只实测裁剪Enter/Escape，不宣称覆盖每一种原版持久编辑操作。';}
 if(!ids.length&&status!=='不适用')note='没有单独实测证据，不能判为通过。';return{...k,evidence:ids,status,note};});
nativeDoc+='\n## 上游115个快捷键定义（固定循环已展开）\n\n这里与“本地68项注册快捷键测试”是两份清单：本地注册执行成功，仍可能执行与上游不同的动作。Mac Command 用 Ctrl 映射进行Windows浏览器验证，真实Mac按键未测。\n\n| ID | 上游操作 | 按键 | 对照结果 | 证据 | 限定条件 |\n|---|---|---|---|---|---|\n';
for(const k of nativeKeys)nativeDoc+='| '+k.id+' | '+md(k.title)+' | '+md(keyLabel(k))+' | '+k.status+' | '+refs(k.evidence)+' | '+md(k.note)+' |\n';

/** 菜单节点是源码库存：按功能组关联，不把动态表达式假装成已点击过的macOS控件。 */
function menuGroup(node){const e=node.expression;
 if(/Hide|Show All|Check for Updates/.test(e))return{status:'不适用',note:'Mac原生应用/更新菜单，OTools宿主职责。'};
 if(/Clear Menu/.test(e))return{status:'未实现',note:'本地最近工程界面无清空列表入口；静态核查。'};
 if(/Clear Guides/.test(e))return{status:'未实现',note:'本地无清除参考线菜单/命令；静态核查。'};
 const tests=[[/Undo|Redo|Keyboard Shortcuts/,'UP-043'],[/Command Palette/,'UP-033'],[/Canvas Only/,'UP-034'],[/New Canvas|Close Project/,'UP-032'],[/Open Project|url\.|Save/,'UP-046'],[/Import/,'UP-039'],[/Export|Copy Merged/,'UP-041'],[/Pixel Grid/,'UP-038'],[/Transform Controls|Fit Canvas|Actual Pixels|Zoom/,'UP-009'],[/Grid|Guides|Rulers|Snap|Document Bounds/,'UP-035'],[/Cut|Copy|Paste/,'UP-008'],[/Foreground|Background Color/,'UP-020'],[/Content-Aware/,'UP-019'],[/All|Deselect|Inverse|Color Range|Subject|Expand|Contract|Feather|Selection Pixels/,'UP-016'],[/Layer's Pixels|Mask's Black Areas/,'UP-018'],[/Curves|Levels|Hue\/Saturation|Invert/,'UP-028'],[/Canvas Size|Image Size|Trim/,'UP-037'],[/Rotate Canvas|Flip Canvas|Flip Layer/,'UP-014'],[/Adjustment/,'UP-004'],[/Transform Selection|Transform Layer/,'UP-010'],[/Duplicate|Layer via Copy/,'UP-008'],[/Clipping/,'UP-003'],[/Group Selected|Ungroup|Move Out of Folder/,'UP-007'],[/New Blank|Rename|isVisible/,'UP-001'],[/Move Layer Up|Move Layer Down/,'UP-007'],[/mergeTitle/,'UP-006'],[/Delete|selectedEffect/,'UP-002']];
 for(const [pattern,id]of tests)if(pattern.test(e)){const item=mapping.upstream.find(x=>x.id===id);return{group:id,status:item.status,note:'关联功能组结论，不是此Mac控件单独点击结果。'};}
 if(/kind.rawValue/.test(e)){const id=node.line>=300?'UP-004':node.line<290?'UP-028':'UP-030';return{group:id,status:mapping.upstream.find(x=>x.id===id).status,note:'ForEach动态条目模板，详见12类调整/滤镜矩阵。'};}
 return{status:'未单独实测',note:'保留源表达式和行号，未通过Mac实机执行此控件。'};
}
const nativeMenu=native.menuNodes.map(n=>({...n,...menuGroup(n)}));
nativeDoc+='\n## 上游86个菜单控件源码节点\n\n**这是源控件节点数，不是动态展开后的菜单总数。** 条件分支可重复，ForEach可展开。下表“关联状态”是所属功能组的结论，不冒认已操作上游原生UI。Windows本地94个菜单点击结果另见菜单专项矩阵。\n\n| 节点 | 源表达式 | 原版行号 | 关联功能组 | 关联状态/边界 |\n|---|---|---:|---|---|\n';
for(const n of nativeMenu)nativeDoc+='| '+n.id+' | '+md(n.expression)+' | ['+n.line+'](https://github.com/robbietilton/Compositor/blob/'+catalog.upstreamSha+'/'+n.source+'#L'+n.line+') | '+(n.group??'—')+' | '+n.status+'：'+n.note+' |\n';
await fs.writeFile(path.join(dir,'上游快捷键及命令对照.md'),nativeDoc);
await fs.writeFile(path.join(dir,'command-evidence.json'),JSON.stringify(commandRows,null,2));
await fs.writeFile(path.join(dir,'native-evidence.json'),JSON.stringify({shortcuts:nativeKeys,menuNodes:nativeMenu},null,2));

const summary={businessSha:catalog.localSha,upstreamSha:catalog.upstreamSha,generatedAt:new Date().toISOString(),totalRecords:rows.length,states:stats,groups:groups.map(g=>({file:g.file,total:g.entries.length,states:counts(g.entries)})),findingGroups:findings.length,priorities:Object.fromEntries(['P1','P2','P3'].map(p=>[p,findings.filter(f=>f.priority===p).length])),catalog:{localMenus:catalog.menus.length,localCommands:catalog.commands.length,localTools:runtime.tools.length,localToolParameters:runtime.tools.reduce((n,t)=>n+t.specs.length,0),localShortcuts:runtime.shortcuts.length,nativeShortcuts:native.shortcuts.length,nativeMenuSourceNodes:native.menuNodes.length,originalClaims:mapping.claims.length,upstreamClaims:mapping.upstream.length},unclassifiedFailures:unclassified.map(r=>r.id),uncoveredCommands:uncoveredCommands.map(c=>c.name),unverifiedNativeKeys:nativeKeys.filter(k=>k.status==='未实测').map(k=>k.title),claimStates:counts(mapping.claims),notes:['通过仅为指定案例/环境，不是无缺陷保证。','源控件库存与原生实机验证分开。','审计脚本默认收集所有失败并正常结束；--strict 才作为非零验收门禁。']};
await fs.writeFile(path.join(dir,'summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
if(unclassified.length||uncoveredCommands.length)process.exitCode=2;
if(process.argv.includes('--strict')&&rows.some(r=>r.status!=='通过'))process.exitCode=1;
