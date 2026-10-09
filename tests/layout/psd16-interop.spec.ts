import {test,expect} from '@playwright/test';
import {readPsd} from 'ag-psd';
// @ts-ignore
import {pageFor} from '../../scripts/audit/harness.mjs';

test('独立ag-psd读取器验证16位导出图层大端通道',async({browser})=>{
 const page=await pageFor(browser);try{const fixture=await page.evaluate(()=>{const {D,P,PSD}=(window as any).A,d=D.createDocument(3,2,'独立读取',16),b=P.createBuffer(3,2,undefined,16);for(let p=0;p<6;p++)b.data.set([(33000+p)/257,(20000+p)/257,(10000+p)/257,(40000+p)/257],p*4);const l=D.createPixelLayer('精度层',b);d.layers=[l];d.activeLayerId=l.id;const bytes=new Uint8Array(PSD.exportPsd(d));return btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(''));});const independent=readPsd(Buffer.from(fixture,'base64'),{useImageData:true,skipCompositeImageData:true});expect(independent.bitsPerChannel).toBe(16);const pixels=independent.children![0]!.imageData!.data;expect(pixels).toBeInstanceOf(Uint16Array);expect(Array.from(pixels.slice(0,8))).toEqual([33000,20000,10000,40000,33001,20001,10001,40001]);}finally{await page.close();}
});
