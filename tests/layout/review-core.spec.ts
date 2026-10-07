import { test, expect } from '@playwright/test';
import { createDocument, createPixelLayer, createGroupLayer, flipCanvas } from '../../src/core/document';
import { createBuffer, createMask } from '../../src/core/pixels';
import { compositeDocument } from '../../src/core/engine/compositor';
const pixel=(b:ReturnType<typeof createBuffer>,x=4,y=4)=>Array.from(b.data.slice((y*b.width+x)*4,(y*b.width+x)*4+4));
test('组隐藏和全黑组蒙版都隐藏子像素',()=>{
 const d=createDocument(16,16), g=createGroupLayer('group'), l=createPixelLayer('red',createBuffer(16,16,[255,0,0,255]));l.parentId=g.id;d.layers.push(g,l);
 g.isVisible=false;expect(pixel(compositeDocument(d).buffer)[3]).toBe(0);
 g.isVisible=true;g.transform.size=[16,16];g.mask={pixels:createMask(16,16,0),enabled:true,linked:true,placement:null,target:'image',inverted:false};expect(pixel(compositeDocument(d).buffer)[3]).toBe(0);
 g.mask.enabled=false;expect(pixel(compositeDocument(d).buffer)).toEqual([255,0,0,255]);
});
test('独立颜色叠加生效且不改变原始透明度',()=>{
 const d=createDocument(16,16), l=createPixelLayer('white',createBuffer(16,16,[255,255,255,128]));d.layers.push(l);
 l.effects={colorOverlay:{enabled:true,color:[255,0,0],opacity:1}};
 expect(pixel(compositeDocument(d).buffer)).toEqual([255,0,0,128]);
});
test('投影不会盖住图层自身不透明像素',()=>{
 const d=createDocument(32,32), l=createPixelLayer('white',createBuffer(16,16,[255,255,255,255]));l.transform.origin=[4,4];d.layers.push(l);
 l.effects={shadow:{enabled:true,angle:0,distance:2,blur:0,color:[0,0,0],opacity:1}};
 expect(pixel(compositeDocument(d).buffer,10,10)).toEqual([255,255,255,255]);
});
test('画布翻转不双重抵消且两次翻转恢复原始像素',()=>{
 const d=createDocument(8,4), b=createBuffer(8,4,[0,0,255,255]);for(let y=0;y<4;y++)for(let x=0;x<4;x++)b.data.set([255,0,0,255],(y*8+x)*4);
 const l=createPixelLayer('halves',b);d.layers.push(l);const before=compositeDocument(d).buffer;
 flipCanvas(d,true,false);expect(pixel(compositeDocument(d).buffer,1,1)).toEqual([0,0,255,255]);
 flipCanvas(d,true,false);expect(compositeDocument(d).buffer.data).toEqual(before.data);expect(l.pixels!.data).toEqual(b.data);
});

test('单独内部描边和内发光在实心矩形边缘可见',()=>{
 const d=createDocument(16,16),l=createPixelLayer('white',createBuffer(16,16,[255,255,255,255]));d.layers.push(l);
 l.effects={stroke:{enabled:true,inside:true,size:2,color:[255,0,0],opacity:1}};
 expect(pixel(compositeDocument(d).buffer,0,0)).toEqual([255,0,0,255]);
 expect(pixel(compositeDocument(d).buffer,8,8)).toEqual([255,255,255,255]);
 l.effects={innerGlow:{enabled:true,size:3,color:[255,0,0],opacity:1}};
 expect(pixel(compositeDocument(d).buffer,0,0)[1]).toBeLessThan(255);
});
