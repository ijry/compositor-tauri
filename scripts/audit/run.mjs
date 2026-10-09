import { execFileSync } from 'node:child_process';
/** 顺序执行，以免大量浏览器实例争抢内存导致不稳定测试。需要先启动5194端口的本地Vite。 */
const upstream=process.argv[2];
try{execFileSync('git',['diff','--exit-code','--','src'],{stdio:'ignore'});}catch{throw Error('业务代码已修改，不能覆盖原始审计证据；请使用scripts/fixes及AUDIT_OUT指定的新目录。');}
if(!upstream)throw Error('用法：node scripts/audit/run.mjs <固定版本上游仓库路径>');
for(const [script,args]of [['extract',[upstream]],['upstream',[upstream]],...['runtime','menus','tools','parameters','kernels','raw','formats','shortcuts','contracts','parity','edges','raw-contract','render','report','verify'].map(s=>[s,[]])]){
 console.log('\n=== 审计 '+script+' ===');
 execFileSync(process.execPath,['scripts/audit/'+script+'.mjs',...args],{stdio:'inherit',cwd:process.cwd()});
}
console.log('已生成全部证据。此处退出成功只代表收集完成；使用 report.mjs --strict 判断严格验收是否通过。');
