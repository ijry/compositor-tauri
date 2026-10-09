import { documentDepth, pixelDepth, toImageData, fromUint16Pixels, displayBytes } from '@/core/pixelFormat';
import { raw16Layer, raw16Channel, write16BitPsd } from './psd16';
/**
 * Photoshop PSD / PSB 读写
 * ---------------------------------------------------------------
 * 导入规则与上游一致：
 *  - 8/16位 RGB 文档，图层、文件夹、蒙版、混合模式保持可编辑；
 *  - 简单横排文字保留文字元数据，竖排文字与其它矢量对象栅格化；
 *  - 导入后给出转换报告，列出被栅格化与不支持的部分。
 */
import { writePsd, type Layer as PsdLayer, type Psd } from 'ag-psd';
import { readPsdWithinBudget, type PsdImportOptions, type PsdMemoryReport } from './psdBudget';
import { createBuffer } from '@/core/pixels';
import { createDocument, createGroupLayer, createPixelLayer, defaultTransform } from '@/core/document';
import { createMaskSampler } from '@/core/engine/maskGeometry';
import { compositeDocument, compositeInto } from '@/core/engine/compositor';
import type { BlendMode, CompDocument, Layer, MaskBuffer, PixelBuffer, TextMeta } from '@/types/document';

/** 导入结果：文档 + 转换报告 */
export interface PsdImportResult {
  document: CompDocument;
  report: PsdConversionReport;
}

export interface PsdConversionReport {
  totalLayers: number;
  editableLayers: number;
  groups: number;
  masks: number;
  textLayers: number;
  rasterized: number;
  unsupported: string[];
  notes: string[];
  memory?:PsdMemoryReport;
}

/** ag-psd 混合模式 -> 内部名称 */
const BLEND_MODE_MAP: Record<string, BlendMode> = {
  normal: 'Normal',
  dissolve: 'Normal',
  darken: 'Darken',
  multiply: 'Multiply',
  colorBurn: 'Color Burn',
  linearBurn: 'Linear Burn',
  lighten: 'Lighten',
  screen: 'Screen',
  colorDodge: 'Color Dodge',
  linearDodge: 'Linear Dodge (Add)',
  overlay: 'Overlay',
  softLight: 'Soft Light',
  hardLight: 'Hard Light',
  vividLight: 'Vivid Light',
  linearLight: 'Linear Light',
  pinLight: 'Pin Light',
  hardMix: 'Hard Mix',
  difference: 'Difference',
  exclusion: 'Exclusion',
  subtract: 'Subtract',
  divide: 'Divide',
  hue: 'Hue',
  saturation: 'Saturation',
  color: 'Color',
  luminosity: 'Luminosity',
};

const INTERNAL_BLEND_NAMES = new Set<string>(Object.values(BLEND_MODE_MAP));

/* ------------------------------ 导入 ------------------------------ */

/** 导入 PSD/PSB */
export function importPsd(data: ArrayBuffer, name = '导入', options:PsdImportOptions={}): PsdImportResult {
  const {psd,memory}=readPsdWithinBudget(data,options);
  const report: PsdConversionReport = {
    totalLayers: 0,
    editableLayers: 0,
    groups: 0,
    masks: 0,
    textLayers: 0,
    rasterized: 0,
    unsupported: [],
    notes: [],
    memory,
  };
  if(memory.mode==='canvas')report.notes.push(`受内存预算限制，${memory.croppedLayers}个图层和${memory.croppedMasks}个蒙版在解码时裁剪到画布；${memory.skippedLayers}个画布外空交集图层已跳过。原文件未修改。`);
  const document = createDocument(Math.max(1, psd.width), Math.max(1, psd.height), name,psd.bitsPerChannel===16?16:8);
  if (psd.colorMode !== undefined && psd.colorMode !== 3) {
    report.notes.push(`文档颜色模式为 ${psd.colorMode}（3 = RGB），已按 sRGB 近似转换`);
  }
  for (const psdLayer of psd.children ?? []) {
    const layer = convertLayer(psdLayer, null, document, report);
    if (layer) document.layers.push(layer);
  }
  if (document.layers.length === 0) report.notes.push('未找到可导入的图层');
  const topmost = document.layers.filter((layer) => layer.parentId === null).pop();
  document.activeLayerId = topmost?.id ?? null;
  return { document, report };
}

/** 单个 PSD 图层 -> 内部图层（含递归处理文件夹） */
function convertLayer(psdLayer: PsdLayer, parentId: string | null, document: CompDocument, report: PsdConversionReport): Layer | null {
  report.totalLayers += 1;
  const children = psdLayer.children;
  if (children) {
    report.groups += 1;
    const group = createGroupLayer(psdLayer.name || '组', parentId);
    group.isVisible = !psdLayer.hidden;
    group.opacity = clamp01(psdLayer.opacity ?? 1);
    attachPsdMask(group,psdLayer,report);
    for (const child of children) {
      const converted = convertLayer(child, group.id, document, report);
      if (converted) document.layers.push(converted);
    }
    return group;
  }
  if (psdLayer.sectionDivider) return null;
  const width = Math.max(0, (psdLayer.right ?? 0) - (psdLayer.left ?? 0));
  const height = Math.max(0, (psdLayer.bottom ?? 0) - (psdLayer.top ?? 0));
  if (width === 0 || height === 0) return null;
  const buffer = extractImageData(psdLayer, width, height);
  if (!buffer) return null;
  const name = psdLayer.name || '图层';
  const rawBlend = String(psdLayer.blendMode ?? 'normal');
  const blendKey=rawBlend.replace(/ ([a-z])/g,(_,letter:string)=>letter.toUpperCase());
  const blendMode = BLEND_MODE_MAP[rawBlend] ?? BLEND_MODE_MAP[blendKey] ?? 'Normal';
  if (!BLEND_MODE_MAP[rawBlend]&&!BLEND_MODE_MAP[blendKey]) {
    report.unsupported.push(`${name}：混合模式 ${rawBlend} 已按正常模式处理`);
  }

  // 文字图层：横排文字保留元数据
  let text: TextMeta | null = null;
  const details = psdLayer.text;
  if (details) {
    report.textLayers += 1;
    if (isVerticalText(details)) {
      report.rasterized += 1;
      report.notes.push(`${name}：竖排文字已栅格化`);
    } else {
      const transform = details.transform ?? [32, 0, 0, 32, 0, 0];
      text = {
        content: details.text ?? '',
        fontName: extractFontName(details) ?? 'Arial',
        fontSize: Math.max(4, details.style?.fontSize ?? Math.abs(transform[0] ?? 32)),
        color: toRgb(details.style?.fillColor),
        align: details.paragraphStyle?.justification==='right'?'right':details.paragraphStyle?.justification==='center'?'center':'left',
        tracking: details.style?.tracking??0,
        lineSpacing: details.style?.leading??0,
        boxSize: null,
        bold: details.style?.fauxBold ?? false,
        italic: details.style?.fauxItalic ?? false,
      };
    }
  }

  const layer = createPixelLayer(name, buffer, {
    isVisible: !psdLayer.hidden,
    opacity: clamp01(psdLayer.opacity ?? 1),
    blendMode,
    parentId,
  });
  layer.transform = {
    ...defaultTransform(width, height),
    origin: [psdLayer.left ?? 0, psdLayer.top ?? 0],
    size: [width, height],
  };
  layer.text = text;
  report.editableLayers += 1;

  // 图层效果：投影与内投影以近似值保留
  const drop = psdLayer.effects?.dropShadow?.[0];
  const inner = psdLayer.effects?.innerShadow?.[0];
  if (drop) {
    layer.effects = {
      ...(layer.effects ?? {}),
      shadow: {
        enabled: drop.enabled ?? true,
        angle: 180-toNumber(drop.angle),
        distance: toNumber(drop.distance),
        blur: toNumber(drop.size),
        color: toRgb(drop.color),
        opacity: toNumber(drop.opacity ?? 1),
      },
    };
  }
  if (inner) {
    layer.effects = {
      ...(layer.effects ?? {}),
      innerShadow: {
        enabled: inner.enabled ?? true,
        angle: 180-toNumber(inner.angle),
        distance: toNumber(inner.distance),
        blur: toNumber(inner.size),
        color: toRgb(inner.color),
        opacity: toNumber(inner.opacity ?? 1),
      },
    };
  }

  const fill=psdLayer.effects?.solidFill?.[0];
  if(fill)layer.effects={...layer.effects,colorOverlay:{enabled:fill.enabled!==false,color:toRgb(fill.color),opacity:fill.opacity??1}};
  const stroke=psdLayer.effects?.stroke?.[0];
  if(stroke)layer.effects={...layer.effects,stroke:{enabled:stroke.enabled!==false,color:toRgb(stroke.color),opacity:stroke.opacity??1,size:toNumber(stroke.size),inside:stroke.position==='inside'}};
  for(const key of ['outerGlow','innerGlow'] as const){const e=psdLayer.effects?.[key];if(e)layer.effects={...layer.effects,[key]:{enabled:e.enabled!==false,color:toRgb(e.color),opacity:e.opacity??1,size:toNumber(e.size)}};}
  attachPsdMask(layer,psdLayer,report);

  return layer;
}


/** PSD蒙版有独立文档放置，不能强制拉伸成图层大小；组同样可持有蒙版。 */
function attachPsdMask(layer:Layer,psdLayer:PsdLayer,report:PsdConversionReport):void {
  const mask=psdLayer.mask;if(!mask)return;
  const w=mask.imageData?.width??Math.max(1,(mask.right??1)-(mask.left??0)),h=mask.imageData?.height??Math.max(1,(mask.bottom??1)-(mask.top??0));
  const pixels=extractMask(mask,w,h);if(!pixels)return;
  report.masks++;
  const relative=mask.positionRelativeToLayer;
  layer.mask={pixels,enabled:!mask.disabled,linked:false,placement:{x:(mask.left??0)+(relative?psdLayer.left??0:0),y:(mask.top??0)+(relative?psdLayer.top??0:0),width:w,height:h},target:'image',inverted:false,outside:mask.defaultColor??0};
}

/** PSD 里部分数值字段可能是带单位的对象，这里统一取出数值 */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'value' in value) {
    const inner = (value as { value?: unknown }).value;
    return typeof inner === 'number' ? inner : 0;
  }
  return 0;
}

/** PSD 颜色可能是数组或 {r,g,b} 对象 */
function toRgb(color: unknown): [number, number, number] {
  if (Array.isArray(color)) return [Number(color[0]) || 0, Number(color[1]) || 0, Number(color[2]) || 0];
  if (color && typeof color === 'object') {
    const value = color as { r?: number; g?: number; b?: number };
    return [value.r ?? 0, value.g ?? 0, value.b ?? 0];
  }
  return [0, 0, 0];
}
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function extractImageData(psdLayer: PsdLayer, width: number, height: number): PixelBuffer | null {
  if (psdLayer.imageData) {
    const source = psdLayer.imageData;
    if(source.data instanceof Uint16Array)return fromUint16Pixels(source.width,source.height,source.data);
    if(source.data instanceof Float32Array)return {width:source.width,height:source.height,data:source.data as Float32Array<ArrayBuffer>,bitDepth:16};
    const data = source.data instanceof Uint8ClampedArray && source.data.buffer instanceof ArrayBuffer ? source.data as Uint8ClampedArray<ArrayBuffer> : new Uint8ClampedArray(source.data);
    if (source.width === width && source.height === height) return { width, height, data };
    return resample(data, source.width, source.height, width, height);
  }
  if (psdLayer.canvas) {
    const canvas = psdLayer.canvas as HTMLCanvasElement;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }
  return null;
}

function resample(data: Uint8ClampedArray, sourceWidth: number, sourceHeight: number, width: number, height: number): PixelBuffer {
  const out = createBuffer(width, height);
  for (let y = 0; y < height; y += 1) {
    const fy = ((y + 0.5) * sourceHeight) / height - 0.5;
    const y0 = Math.max(0, Math.min(sourceHeight - 1, Math.floor(fy)));
    const y1 = Math.max(0, Math.min(sourceHeight - 1, y0 + 1));
    const wy = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = ((x + 0.5) * sourceWidth) / width - 0.5;
      const x0 = Math.max(0, Math.min(sourceWidth - 1, Math.floor(fx)));
      const x1 = Math.max(0, Math.min(sourceWidth - 1, x0 + 1));
      const wx = fx - x0;
      const di = (y * width + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const top = (data[(y0 * sourceWidth + x0) * 4 + c] ?? 0) * (1 - wx) + (data[(y0 * sourceWidth + x1) * 4 + c] ?? 0) * wx;
        const bottom = (data[(y1 * sourceWidth + x0) * 4 + c] ?? 0) * (1 - wx) + (data[(y1 * sourceWidth + x1) * 4 + c] ?? 0) * wx;
        out.data[di + c] = top * (1 - wy) + bottom * wy;
      }
    }
  }
  return out;
}

function extractMask(mask: NonNullable<PsdLayer['mask']>, width: number, height: number): MaskBuffer | null {
  let sourceData: Uint8Array | Uint8ClampedArray | Float32Array | Uint16Array | null = null;
  let sourceWidth = width;
  let sourceHeight = height;
  if (mask.imageData) {
    sourceData = mask.imageData.data;
    sourceWidth = mask.imageData.width;
    sourceHeight = mask.imageData.height;
  } else if (mask.canvas) {
    const canvas = mask.canvas as HTMLCanvasElement;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      sourceData = new Uint8Array(width * height);
      sourceWidth = width;
      sourceHeight = height;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const sx = Math.min(canvas.width - 1, Math.floor((x * canvas.width) / width));
          const sy = Math.min(canvas.height - 1, Math.floor((y * canvas.height) / height));
          sourceData[y * width + x] = image.data[(sy * canvas.width + sx) * 4] ?? 0;
        }
      }
    }
  }
  if (!sourceData) return null;
  const out = sourceData instanceof Float32Array||sourceData instanceof Uint16Array?new Float32Array(width*height):new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(sourceHeight - 1, Math.floor((y * sourceHeight) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(sourceWidth - 1, Math.floor((x * sourceWidth) / width));
      out[y * width + x] = (sourceData[(sy * sourceWidth + sx)*(sourceData.length>=sourceWidth*sourceHeight*4?4:1)] ?? 0)/(sourceData instanceof Uint16Array?257:1);
    }
  }
  return { width, height, data: out,bitDepth:out instanceof Float32Array?16:8 };
}

/** 取字体名 */
function extractFontName(details: NonNullable<PsdLayer['text']>): string | null {
  if(details.style?.font?.name)return details.style.font.name;
  const font = (details as unknown as { font?: string }).font;
  if (typeof font === 'string' && font) return font;
  const engine = (details as unknown as { engineData?: { name?: string } }).engineData;
  if (engine?.name) return engine.name.replace(/-\d+$/, '');
  return null;
}

/** 是否竖排文字（orientation 2/4） */
function isVerticalText(details: NonNullable<PsdLayer['text']>): boolean {
  const orientation = (details as unknown as { orientation?: number }).orientation;
  return orientation === 2 || orientation === 4;
}

/* ------------------------------ 导出 ------------------------------ */

/** 导出为 PSD 二进制（调整层与组会被栅格化为像素层） */
export function exportPsd(document: CompDocument): ArrayBuffer {
  const depth=documentDepth(document);
  const build=(layer:Layer):PsdLayer=>{
    const result:PsdLayer={name:layer.name,opacity:layer.opacity,hidden:!layer.isVisible,blendMode:toPsdBlendMode(layer.blendMode),clipping:layer.clipping} as PsdLayer;
    if(layer.kind==='group')result.children=document.layers.filter(l=>l.parentId===layer.id).map(build);
    else {
      const transformed=layer.kind==='adjustment'||!layer.pixels||layer.transform.rotation!==0||layer.transform.flipX||layer.transform.flipY||!!layer.transform.warp||layer.transform.size[0]!==layer.pixels.width||layer.transform.size[1]!==layer.pixels.height;
      // PSD普通像素层没有单独的仿射属性，导出文档空间的栅格保持当前外观。
      const buffer=transformed?compositeDocument({...document,selection:null,layers:[{...layer,parentId:null,opacity:1,blendMode:'Normal',mask:null,effects:null,clipping:false}]},document.width,document.height,{scale:1}).buffer:layer.pixels!;
      const left=transformed?0:Math.round(layer.transform.origin[0]),top=transformed?0:Math.round(layer.transform.origin[1]);
      Object.assign(result,{left,top,right:left+buffer.width,bottom:top+buffer.height,...(depth===16?{rawData:raw16Layer(buffer)}:{imageData:toImageData(buffer)})});
      if(layer.text){const t=layer.text;result.text={text:t.content,transform:[1,0,0,1,left,top],orientation:'horizontal',style:{font:{name:t.fontName},fontSize:t.fontSize,fillColor:{r:t.color[0],g:t.color[1],b:t.color[2]},fauxBold:t.bold,fauxItalic:t.italic,tracking:t.tracking,leading:t.lineSpacing||t.fontSize*1.2},paragraphStyle:{justification:t.align},shapeType:t.boxSize?'box':'point',...(t.boxSize?{boxBounds:[0,0,...t.boxSize]}:{})};}
    }
    if(layer.mask){
      const sample=createMaskSampler({...layer,mask:{...layer.mask,enabled:true}})!;
      const mask=createBuffer(document.width,document.height,undefined,depth);
      for(let y=0;y<mask.height;y++)for(let x=0;x<mask.width;x++){const i=(y*mask.width+x)*4,v=depth===16?sample(x+.5,y+.5)*255:Math.round(sample(x+.5,y+.5)*255);mask.data.set([v,v,v,255],i);}
      result.mask={...(depth===16?{}:{imageData:toImageData(mask)}),left:0,top:0,right:mask.width,bottom:mask.height,defaultColor:layer.mask.outside??0,disabled:!layer.mask.enabled};
      if(depth===16){result.rawData??={bitsPerChannel:16,colorMode:3,large:false,channels:[]};result.rawData.channels.push({id:-2,compression:0,data:raw16Channel(mask,0)});}
    }
    if(layer.effects){const fx=layer.effects;result.effects={};
      const rgb=(color:[number,number,number])=>({r:color[0],g:color[1],b:color[2]});
      if(fx.stroke){const e=fx.stroke;result.effects.stroke=[{enabled:e.enabled!==false,opacity:e.opacity,color:rgb(e.color),size:{units:'Pixels',value:e.size},position:e.inside?'inside':'outside',fillType:'color',blendMode:'normal'}];}
      for(const key of ['outerGlow','innerGlow'] as const){const e=fx[key];if(e)result.effects[key]={enabled:e.enabled!==false,opacity:e.opacity,color:rgb(e.color),size:{units:'Pixels',value:e.size},blendMode:'normal',source:'edge'};}
      if(fx.colorOverlay){const e=fx.colorOverlay;result.effects.solidFill=[{enabled:e.enabled!==false,opacity:e.opacity,color:rgb(e.color),blendMode:'normal'}];}
      for(const [key,psdKey]of [['shadow','dropShadow'],['innerShadow','innerShadow']] as const){const e=fx[key];if(e)result.effects[psdKey]=[{enabled:e.enabled!==false,opacity:e.opacity,color:rgb(e.color),angle:180-e.angle,distance:{units:'Pixels',value:e.distance},size:{units:'Pixels',value:e.blur},blendMode:'normal',useGlobalLight:false}];}
    }
    return result;
  };
  const psd:Psd={width:document.width,height:document.height,children:document.layers.filter(l=>l.parentId===null).map(build)};
  return depth===16?write16BitPsd(psd,compositeDocument(document,document.width,document.height,{scale:1,limitAdjustmentsBySelection:false}).buffer):writePsd(psd,{generateThumbnail:false,noBackground:true});
}

/** ag-psd的公开枚举使用空格分词，不能把内部camelCase映射直接交给写入器。 */
function toPsdBlendMode(mode:BlendMode):string {
  return mode==='Linear Dodge (Add)'?'linear dodge':mode.toLowerCase();
}

/** 生成转换报告文本（界面展示用） */
export function formatPsdReport(report: PsdConversionReport): string {
  const lines: string[] = [];
  lines.push(`图层总数：${report.totalLayers}`);
  lines.push(`保持可编辑：${report.editableLayers}`);
  lines.push(`文件夹：${report.groups}`);
  lines.push(`图层蒙版：${report.masks}`);
  lines.push(`文字图层：${report.textLayers}`);
  lines.push(`栅格化图层：${report.rasterized}`);
  for (const item of report.unsupported.slice(0, 8)) lines.push(`需要注意：${item}`);
  for (const note of report.notes.slice(0, 8)) lines.push(`· ${note}`);
  return lines.join('\n');
}
