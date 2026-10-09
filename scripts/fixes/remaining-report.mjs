import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 读取完整回归报告，生成剩余3项的闭环证据；任一失败/跳过都不打完成勾。 */
const report=JSON.parse(await fs.readFile('docs/fixes/remaining/playwright-results.json','utf8'));
if(report.stats.unexpected||report.stats.flaky||report.stats.skipped||!report.stats.expected)throw Error('完整回归未全绿，不能关闭剩余项');
const files=new Map();
function walk(suites){for(const suite of suites){for(const spec of suite.specs??[]){const file=path.basename(spec.file??suite.file),list=files.get(file)??[];if(!spec.ok||spec.tests.some(t=>t.status!=='expected'||!t.results.some(r=>r.status==='passed')))throw Error('测试未通过：'+spec.title);list.push(spec.title);files.set(file,list);}walk(suite.suites??[]);}}
walk(report.suites);
const requirements=[
 {id:'REMAINING-psd-budget',issue:'ISSUE-062',title:'PSD/PSB按预算规划与有界通道解码',files:['psd-budget.spec.ts','codec-precision.spec.ts'],note:'分配前估算压缩源文件、像素与固定解码暂存；不足时在解码期间裁到画布，裁后仍超限明确拒绝。Raw/RLE/ZIP/ZIP预测器及PSB行表已验证，估计值不是浏览器进程RSS。'},
 {id:'REMAINING-bit-depth',issue:'ISSUE-063',title:'8/16位像素、蒙版、编辑和文件链路',files:['bit-depth.spec.ts','codec-precision.spec.ts','psd16-interop.spec.ts'],note:'16位文档采用0–255 Float32工作值，覆盖合成、调整、绘画底层、重采样、蒙版、历史、PNG/PSD/工程保存；JPEG/WebP与Canvas显示是明确的8位量化边界。独立样本、最低有效位及独立PSD读取器验证通过，不等于所有厂商格式均实测。'},
 {id:'REMAINING-localization',issue:'ISSUE-065',title:'可控界面/历史/第三方错误边界中文化',files:['localization.spec.ts'],note:'修正滤镜历史名称和错误反馈，第三方英文异常统一转中文；格式缩写、字体名、文件名和用户内容保持原值，不冒称这些数据是待翻译的界面文案。'},
];
for(const item of requirements)for(const file of item.files)if(!files.has(file))throw Error('缺少必需回归文件：'+file);
const hashes=[];
async function sourceFiles(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.posix.join(dir,entry.name);if(entry.isDirectory())await sourceFiles(file);else if(/\.(ts|vue)$/.test(file))hashes.push([file,createHash('sha256').update(await fs.readFile(file)).digest('hex')]);}}
await sourceFiles('src');for(const file of ['package.json','pnpm-lock.yaml','vite.config.ts'])hashes.push([file,createHash('sha256').update(await fs.readFile(file)).digest('hex')]);hashes.sort(([a],[b])=>a.localeCompare(b));
const sourceTreeSha256=createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
const results=requirements.map(item=>({...item,status:'通过',pass:true,tests:item.files.flatMap(file=>files.get(file).map(title=>({file,title}))),fullRegression:{passed:report.stats.expected,failed:0,skipped:0},sourceTreeSha256}));
await fs.writeFile('docs/fixes/results/remaining-completion.json',JSON.stringify(results,null,2));
await fs.writeFile('docs/fixes/remaining/source-hashes.json',JSON.stringify({sourceTreeSha256,files:hashes},null,2));
console.log(JSON.stringify({sourceTreeSha256,passed:report.stats.expected,closed:results.map(r=>r.issue)}));
