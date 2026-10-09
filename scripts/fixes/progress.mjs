import fs from 'node:fs/promises';
import path from 'node:path';
const issues=JSON.parse(await fs.readFile('docs/audit/findings.json','utf8'));
const files=(await fs.readdir('docs/fixes/results')).filter(f=>f.endsWith('.json'));
const records=[];for(const file of files){const value=JSON.parse(await fs.readFile(path.join('docs/fixes/results',file),'utf8'));if(Array.isArray(value))for(const row of value)records.push({...row,file});}
const byId=new Map(records.map(r=>[r.id,r]));
const re=s=>new RegExp('^'+s.split('*').map(p=>p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$');
const override={
 'ISSUE-006':['PSD-roundtrip-rotation','PSD-roundtrip-placed-mask','PSD-roundtrip-group-mask','PSD-roundtrip-effects','PSD-roundtrip-text','PSD-effect-stroke','PSD-effect-shadow','PSD-effect-innerShadow','PSD-effect-colorOverlay','PSD-effect-outerGlow','PSD-effect-innerGlow','PSD-blend-*'],
 'ISSUE-021':['UI-adjust-Levels','UI-adjust-Curves','UI-adjust-Gradient Map','UI-adjust-Grain','UI-adjust-Color Balance'],
 'ISSUE-022':['UI-effect-stroke','UI-effect-shadow','UI-effect-innerShadow','UI-effect-colorOverlay','UI-effect-outerGlow','UI-effect-innerGlow'],
 'ISSUE-023':['UI-raw-groups','RAW-UI-曲线','RAW-UI-颜色混合','RAW-UI-颜色分级','RAW-UI-几何'],
 'ISSUE-027':['UI-raw-filter'],
 'ISSUE-028':['FIX-content-aware'],
 'ISSUE-031':['PARAM-marquee-antialias','PARAM-lasso-feather','PARAM-wand-sampleAllLayers','PARAM-wand-antialias','PARAM-objectSelect-feather','PARAM-liquify-strength','PARAM-move-showControls'],
 'ISSUE-034':['FLOW-nested-drag-false','FLOW-nested-drag-true','FLOW-nested-command'],
 'ISSUE-042':['UI-mask-history','PARITY-mask-transform','PARITY-mask-link-ui'],
 'ISSUE-045':['FIX-snap-menu'],
 'ISSUE-048':['FLOW-guide-move','FLOW-guide-history','UI-guides-lock'],
 'ISSUE-050':['PARITY-ctrl-t','PARITY-adjust-Curves','PARITY-adjust-Levels','PARITY-adjust-Hue/Saturation','PARITY-jpeg-shortcut','PARITY-shift-delete','PARITY-layer-via-copy','KEY-layer.group','EDGE-merge-multi-key'],
 'ISSUE-051':['FIX-shift-keys'],
 'ISSUE-053':['UI-command-palette','FLOW-canvas-only','PARITY-select-tool'],
 'ISSUE-054':['UI-jpeg'],
 'ISSUE-055':['UI-filter-preview'],
 'ISSUE-057':['FLOW-toolbar-longpress','FLOW-layer-context','UI-layer-lock'],
 'ISSUE-064':['UI-pixel-grid'],
 'ISSUE-065':['EDGE-chinese-anchor','UI-chinese'],
 'ISSUE-066':['UI-clipboard-flatten'],
 'ISSUE-069':['FIX-new-dialog'],
};
const remaining={'ISSUE-062':'未完成：需要受预算约束的PSD通道解码/裁切路径，不能用解码后裁剪冒充内存降级。','ISSUE-063':'未完成：内部仍为8位缓冲。16位精度贯穿混合、滤镜、历史与导出的改造尚未完成。'};
const partial={'ISSUE-065':'本轮已本地化新增控件、菜单、锚点及Element Plus；全部业务异常/字体名/第三方信息尚未逐句验收。'};
const progress=issues.map(issue=>{const selectors=override[issue.id]??issue.selectors;const matched=records.filter(r=>selectors.some(s=>re(s).test(r.id)));const missing=selectors.filter(s=>!records.some(r=>re(s).test(r.id)));let status=missing.length||!matched.length?'待验证':matched.some(r=>['失败','未验证','未实测','未实现'].includes(r.status))?'待验证':'已修复';if(remaining[issue.id])status='未完成';else if(partial[issue.id])status='部分修复';return{id:issue.id,title:issue.title,status,note:remaining[issue.id]??partial[issue.id]??(status==='已修复'?'审计反例已消除，限定于列出的本地验证；不代表真实宿主/外部格式全面认证。':'需要补齐或重新执行列出的验证。'),evidence:matched.map(r=>({id:r.id,status:r.status,file:r.file})),missing};});
await fs.writeFile('docs/fixes/progress.json',JSON.stringify(progress,null,2));
const states=Object.fromEntries(['已修复','部分修复','待验证','未完成'].map(s=>[s,progress.filter(r=>r.status===s).length]));
let text='# 全量审计问题修复进度\n\n> 原始证据保留于 ../audit；本表只反映本轮实现与验证，不将未测项强行打勾。\n\n'+Object.entries(states).map(([k,v])=>k+' '+v+' 项').join('；')+'。\n\n';
for(const item of progress)text+='- ['+(item.status==='已修复'?'x':' ')+'] **'+item.id+' '+item.title+'** — '+item.status+'\n  - '+item.note+'\n  - '+item.evidence.map(r=>'['+r.id+'](results/'+r.file+')').join('、')+(item.missing.length?'；待补：'+item.missing.join('、'):'')+'\n';
await fs.writeFile('docs/fixes/修复进度.md',text);
console.log(JSON.stringify(states));console.log(progress.filter(p=>p.status==='待验证').map(p=>({id:p.id,missing:p.missing,notPassed:p.evidence.filter(r=>!['通过','部分通过'].includes(r.status)).map(r=>r.id)})));
