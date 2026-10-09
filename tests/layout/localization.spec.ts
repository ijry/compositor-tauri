import {test,expect} from '@playwright/test';
// @ts-ignore
import {pageFor} from '../../scripts/audit/harness.mjs';

test('调整滤镜标题与提交后的历史记录使用同一中文名',async({browser})=>{
 const page=await pageFor(browser);try{await page.evaluate(()=>(window as any).A.E.commands.run('openFilter','Exposure'));await expect(page.getByRole('dialog',{name:'曝光度'})).toBeVisible();await page.getByRole('button',{name:'应用',exact:true}).click();const label=await page.evaluate(()=>(window as any).A.E.currentHistory().list().at(-1).label);expect(label).toBe('应用滤镜：曝光度');}finally{await page.close();}
});

test('第三方PSD解析失败经命令入口显示中文错误而非未捕获异常',async({browser})=>{
 const page=await pageFor(browser);try{const r=await page.evaluate(async()=>{const {E}=(window as any).A,H=(window as any).auditHost;const b=new Uint8Array(30);b.set([56,66,80,83,0,1]);b[13]=3;b[17]=1;b[21]=1;b[23]=8;b[25]=3;H.put('/audit/broken.psd',btoa(String.fromCharCode(...b)));H.openPath='/audit/broken.psd';let rejected=false;try{await E.commands.run('openPsd');}catch{rejected=true;}return{rejected,status:E.statusMessage.value,docs:E.documents.value.length};});expect(r.rejected).toBe(false);expect(r.docs).toBe(1);expect(r.status).toMatch(/失败.*(?:损坏|不完整|解析)/);expect(r.status).not.toMatch(/RangeError|DataView|Error:|Unexpected|Invalid/);}finally{await page.close();}
});

test('PSD异常转换保留可用中文提示，未知第三方异常不原样回显',async({page})=>{
 await page.goto('http://127.0.0.1:5194',{waitUntil:'networkidle'});const result=await page.evaluate(async()=>{ // @ts-ignore
 const {userErrorMessage}=await import('/src/core/userMessage.ts');return [userErrorMessage(new Error('Invalid signature')),userErrorMessage(new Error('Permission denied')),userErrorMessage(new Error('arbitrary private internal failure')),userErrorMessage(new Error('图层变换尺寸超出安全范围'))];});expect(result).toEqual(['文件数据损坏或格式不支持，请检查文件是否完整','没有文件访问权限，请检查目录授权','操作未完成，请检查文件和设置后重试','图层变换尺寸超出安全范围']);
});
