import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
const root=process.cwd(),up=process.argv[2];
if(!up)throw Error('用法：node scripts/audit/extract.mjs <上游工作区>');
const text=await fs.readFile(path.join(root,'src/App.vue'),'utf8');
const script=text.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1];
const ast=ts.createSourceFile('App.ts',script,ts.ScriptTarget.Latest,true);
let declaration;
function walk(n){if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='menus')declaration=n;ts.forEachChild(n,walk);}walk(ast);
const ctx={commands:{run:(command,payload)=>({kind:'command',command,payload})},api:{openDialog:(dialog,payload)=>({kind:'dialog',dialog,payload})},resetPanels:()=>({kind:'layout',command:'resetPanels'})};
vm.runInNewContext(ts.transpileModule('const menus='+declaration.initializer.getText(ast)+';globalThis.catalog=menus;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx,{timeout:1000});
const menus=[];for(const menu of ctx.catalog)for(const item of menu.items)if(!item.divider)menus.push({id:'MENU-'+String(menus.length+1).padStart(3,'0'),category:menu.label,label:item.label,action:item.run(),source:'src/App.vue'});
const commands=[];
for(const file of ['src/composables/commands.ts','src/composables/commands-io.ts']){
 const source=await fs.readFile(path.join(root,file),'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
 const visit=n=>{if(ts.isCaseClause(n)&&ts.isStringLiteral(n.expression))commands.push({name:n.expression.text,source:file,line:tree.getLineAndCharacterOfPosition(n.getStart(tree)).line+1});ts.forEachChild(n,visit);};visit(tree);
}
const allSrc=[];
async function files(dir){for(const e of await fs.readdir(path.join(root,dir),{withFileTypes:true})){const p=path.posix.join(dir,e.name);if(e.isDirectory())await files(p);else if(/\.(vue|ts)$/.test(e.name))allSrc.push({file:p,text:await fs.readFile(path.join(root,p),'utf8')});}}await files('src');
const bindings=[];for(const f of allSrc)for(const match of f.text.matchAll(/commands\.run\(\s*['"]([^'"]+)['"]/g))bindings.push({command:match[1],source:f.file,line:f.text.slice(0,match.index).split('\n').length});
const claims=(await fs.readFile(path.join(root,'docs/复刻计划.md'),'utf8')).split(/\r?\n/).filter(line=>/^- \[[ x]\] \d+\.\d+/.test(line)).map((line,i)=>({id:'CLAIM-'+String(i+1).padStart(3,'0'),text:line.replace(/^- \[[ x]\] /,'')}));
const upstream=(await fs.readFile(path.join(up,'README.md'),'utf8')).split(/\r?\n/);let section='';const upstreamFeatures=[];
for(const line of upstream){if(/^#{2,3} /.test(line))section=line.replace(/^#{2,3} /,'');if(line.startsWith('- ')&&section)upstreamFeatures.push({id:'UP-'+String(upstreamFeatures.length+1).padStart(3,'0'),section,text:line.slice(2)});}
const sha=(cwd)=>execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim();
const catalog={generatedAt:new Date().toISOString(),localSha:sha(root),upstreamSha:sha(up),menus,commands,bindings,missingBindings:bindings.filter(b=>!commands.some(c=>c.name===b.command)),claims,upstreamFeatures};
await fs.mkdir(path.join(root,'docs/audit'),{recursive:true});await fs.writeFile(path.join(root,'docs/audit/catalog-static.json'),JSON.stringify(catalog,null,2));
console.log(JSON.stringify({menus:menus.length,commands:commands.length,claims:claims.length,upstream:upstreamFeatures.length,missing:catalog.missingBindings},null,2));
