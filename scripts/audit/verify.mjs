import fs from 'node:fs/promises';
import path from 'node:path';
/** 审计资料完整性校验：禁止乱码、重复案例、漏声明、漏命令及未归类失败。 */
const dir='docs/audit';
for(const folder of [dir,'scripts/audit'])for(const name of await fs.readdir(folder))if(/\.(json|mjs|md)$/.test(name)){
 const text=await fs.readFile(path.join(folder,name),'utf8');if(text.includes('\uFFFD'))throw Error('发现替换字符：'+name);
 if(name.endsWith('.json'))JSON.parse(text);
}
const read=name=>fs.readFile(path.join(dir,name),'utf8').then(JSON.parse);
const summary=await read('summary.json'),catalog=await read('catalog-static.json'),runtime=await read('catalog-runtime.json'),mapping=await read('claim-evidence.json'),commands=await read('command-evidence.json'),native=await read('native-evidence.json'),findings=await read('findings-evidence.json');
const all=[];for(const name of (await fs.readdir(dir)).filter(n=>n.endsWith('-results.json')))all.push(...await read(name));
if(new Set(all.map(x=>x.id)).size!==all.length)throw Error('案例ID重复');
if(new Set(findings.map(x=>x.id)).size!==findings.length)throw Error('问题ID重复');
if(all.length!==summary.totalRecords)throw Error('统计条数与原始记录不符');
if(mapping.claims.length!==60||mapping.upstream.length!==51)throw Error('声明覆盖不完整');
if(commands.length!==93||commands.some(x=>!x.evidence.length))throw Error('命令缺少证据');
if(native.shortcuts.length!==115||native.menuNodes.length!==86)throw Error('上游清单未完整展开');
if(summary.unclassifiedFailures.length||summary.uncoveredCommands.length)throw Error('有未归类反例/未覆盖命令');
for(const menu of catalog.menus)if(!all.some(r=>r.id===menu.id))throw Error('漏测菜单 '+menu.id);
for(const tool of runtime.tools)for(const spec of tool.specs)if(!all.some(r=>r.id==='PARAM-'+tool.id+'-'+spec.key))throw Error('漏测工具参数 '+tool.id+'.'+spec.key);
for(const shortcut of runtime.shortcuts)if(!all.some(r=>r.id==='KEY-'+shortcut.id))throw Error('漏测快捷键 '+shortcut.id);
for(const file of ['全量功能验收.md','功能对照总表.md','阻断问题.md','上游快捷键及命令对照.md','验收范围与进度.md','README.md'])if((await fs.stat(path.join(dir,file))).size===0)throw Error('文档为空 '+file);
console.log('审计资料完整性通过：'+all.length+'条记录，'+findings.length+'组问题；这不是业务功能通过。');
