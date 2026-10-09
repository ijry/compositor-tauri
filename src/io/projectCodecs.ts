/**
 * 上游 .comp v11 与插件内部模型之间的边界转换。
 * 保存使用上游字段；读取同时接受旧插件的 color/align/矩形蒙版格式。
 */
import { defaultAdjustment } from '@/core/document';
import type { LayerEffects, LayerMask, TextMeta, ShapeMeta, AdjustmentRecord, AdjustmentKind } from '@/types/document';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工程元数据格式无效');
  return value as RecordValue;
}
function finite(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('工程元数据包含无效数字');
  return value;
}
function color(value: RecordValue): [number, number, number] {
  const local = Array.isArray(value.color);
  const values = local ? value.color as unknown[] : [value.red, value.green, value.blue];
  if (values.length !== 3) throw new Error('工程颜色格式无效');
  return values.map(component => {
    const n = finite(component, 0), max = local ? 255 : 1;
    if (n < 0 || n > max) throw new Error('工程颜色超出范围');
    return n * (local ? 1 : 255);
  }) as [number, number, number];
}
function rgb(value: [number, number, number]) {
  return { red: value[0] / 255, green: value[1] / 255, blue: value[2] / 255 };
}
const effectDefaults: Record<keyof LayerEffects, RecordValue> = {
  stroke: { size: 4, inside: false }, shadow: { angle: 90, distance: 20, blur: 20 },
  innerShadow: { angle: 90, distance: 10, blur: 10 }, colorOverlay: {},
  outerGlow: { size: 20 }, innerGlow: { size: 10 },
};
export function decodeEffects(value: unknown): LayerEffects | null {
  if (value == null) return null;
  const source = record(value), effects: RecordValue = {};
  for (const key of Object.keys(effectDefaults) as (keyof LayerEffects)[]) {
    if (source[key] == null) continue;
    const entry = record(source[key]);
    const next: RecordValue = { ...effectDefaults[key], enabled: entry.enabled !== false, color: color(entry), opacity: finite(entry.opacity, 1) };
    for (const [field, fallback] of Object.entries(effectDefaults[key])) {
      next[field] = typeof fallback === 'number' ? finite(entry[field], fallback) : entry[field] ?? fallback;
    }
    // 上游角度表示光源方向，插件内部表示阴影偏移方向；在边界互转。
    if ((key === 'shadow' || key === 'innerShadow') && !Array.isArray(entry.color)) next.angle = 180 - Number(next.angle);
    effects[key] = next;
  }
  return effects as LayerEffects;
}
export function encodeEffects(effects: LayerEffects): RecordValue {
  return Object.fromEntries(Object.entries(effects).filter(([,effect]) => !!effect).map(([key, effect]) => {
    const { color: tint, ...rest } = effect;
    const encoded: RecordValue = { ...rest, ...rgb(tint) };
    if (key === 'shadow' || key === 'innerShadow') encoded.angle = 180 - Number(encoded.angle);
    return [key, encoded];
  }));
}
export function decodeText(value: unknown): TextMeta | null {
  if (value == null) return null;
  const source = record(value);
  const alignment = String(source.align ?? source.alignment ?? 'Left').toLowerCase();
  const box = source.boxSize == null ? null : source.boxSize;
  if (box !== null && (!Array.isArray(box) || box.length !== 2 || box.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0))) throw new Error('文字框尺寸无效');
  const meta: TextMeta = {
    content: String(source.content ?? ''), fontName: String(source.fontName ?? 'Helvetica'), fontSize: finite(source.fontSize, 72),
    color: color(source), align: alignment === 'right' || alignment === 'center' ? alignment : 'left',
    tracking: finite(source.tracking, 0), lineSpacing: finite(source.lineSpacing ?? source.leading, 0),
    boxSize: box as [number, number] | null, bold: source.bold === true, italic: source.italic === true,
  };
  if (meta.content.length > 100_000 || meta.fontSize < 1 || meta.fontSize > 2000) throw new Error('文字内容或字号超出范围');
  if (Array.isArray(source.colorRuns)) meta.colorRuns = source.colorRuns.map(value => {
    const run = record(value);
    return { location: finite(run.location, 0), length: finite(run.length, 0), color: color(run) };
  });
  if (Array.isArray(source.fontRuns)) meta.fontRuns = source.fontRuns.map(value => {
    const run = record(value);
    return { location: finite(run.location, 0), length: finite(run.length, 0), fontName: String(run.fontName ?? meta.fontName) };
  });
  return meta;
}
export function encodeText(meta: TextMeta): RecordValue {
  const { color: tint, align, lineSpacing, colorRuns, ...rest } = meta;
  return { ...rest, ...rgb(tint), alignment: align[0]!.toUpperCase() + align.slice(1), leading: lineSpacing,
    ...(colorRuns ? { colorRuns: colorRuns.map(({ color: c, ...run }) => ({ ...run, ...rgb(c) })) } : {}),
  };
}
export function decodeMaskPlacement(value: unknown): LayerMask['placement'] {
  if (value == null) return null;
  const p = record(value);
  const origin = Array.isArray(p.origin) ? p.origin : [p.x, p.y];
  const size = Array.isArray(p.size) ? p.size : [p.width, p.height];
  const placement: NonNullable<LayerMask['placement']> = { x: finite(origin[0], 0), y: finite(origin[1], 0), width: finite(size[0], 0), height: finite(size[1], 0),
    rotation: finite(p.rotation, 0), flipX: p.flipX === true, flipY: p.flipY === true,
    sampling: p.sampling === 'Smooth' || p.sampling === 'High quality' ? p.sampling : 'Nearest' as const,
  };
  if (placement.width <= 0 || placement.height <= 0) throw new Error('独立蒙版尺寸无效');
  return placement;
}
export function encodeMaskPlacement(p: NonNullable<LayerMask['placement']>): RecordValue {
  return { origin: [p.x,p.y], size: [p.width,p.height], rotation: p.rotation ?? 0, flipX: p.flipX ?? false,
    flipY: p.flipY ?? false, sampling: p.sampling ?? 'Nearest' };
}

/** 曲线/渐变映射在上游和插件内的表示不同，转换只能集中发生在IO边界。 */
export function decodeAdjustment(value: unknown): AdjustmentRecord {
  const source=record(value),base=defaultAdjustment(source.kind as AdjustmentKind);
  const result={...base,...source} as AdjustmentRecord;
  for(const key of ['levels','curves','exposureSettings','gradientMapSettings','grainSettings','blackWhiteSettings','colorBalanceSettings'] as const) {
    (result as unknown as RecordValue)[key]={...base[key],...(source[key]?record(source[key]):{})};
  }
  if(source.curves) {
    const curves=record(source.curves);
    if(Array.isArray(curves.channels))result.curves.channels=base.curves.channels.map((fallback,i)=>{
      const channel=curves.channels as unknown[],raw=channel[i];
      const points=Array.isArray(raw)?raw:raw?record(raw).points:null;
      if(!Array.isArray(points))return fallback;
      return {points:points.map(point=>{
        const p=Array.isArray(point)?point:[record(point).x,record(point).y];
        return [finite(p[0],0),finite(p[1],0)] as [number,number];
      })};
    });
  }
  if(source.gradientMapSettings) {
    const settings=record(source.gradientMapSettings),g=result.gradientMapSettings;
    const decode=(v:unknown,fallback:[number,number,number])=>v==null?fallback:Array.isArray(v)?color({color:v}):color(record(v));
    g.shadows=decode(settings.shadows,g.shadows);g.highlights=decode(settings.highlights,g.highlights);
    g.mids=decode(settings.mids,g.shadows.map((v,i)=>(v+g.highlights[i]!)/2) as [number,number,number]);
    if(Array.isArray(settings.customStops))g.customStops=settings.customStops.map(v=>{const stop=record(v);return{position:finite(stop.position,0),color:decode(stop.color??stop,g.shadows)};});
  }
  return result;
}
export function encodeAdjustment(adjustment: AdjustmentRecord): RecordValue {
  const out={...adjustment} as unknown as RecordValue;
  out.curves={...adjustment.curves,channels:adjustment.curves.channels.map(c=>c.points.map(([x,y])=>({x,y})))};
  const g=adjustment.gradientMapSettings;
  out.gradientMapSettings={...g,shadows:rgb(g.shadows),mids:rgb(g.mids),highlights:rgb(g.highlights),...(g.customStops?{customStops:g.customStops.map(s=>({position:s.position,...rgb(s.color)}))}:{})};
  return out;
}

/** 上游圆角矩形仍为Rectangle，额外描边字段保留为兼容扩展。 */
export function decodeShape(value: unknown): ShapeMeta | null {
  if(value==null)return null;
  const s=record(value),kind=String(s.kind??'rectangle').toLowerCase();
  const point=(v:unknown,fallback:[number,number]):[number,number]=>v==null?fallback:Array.isArray(v)?[finite(v[0],0),finite(v[1],0)]:[finite(record(v).x,0),finite(record(v).y,0)];
  return {kind:kind==='line'?'line':kind==='ellipse'?'ellipse':kind==='roundedrectangle'?'roundedRectangle':'rectangle',color:color(s),cornerRadius:finite(s.cornerRadius,0),fillEnabled:s.fillEnabled!==false,strokeWidth:finite(s.strokeWidth??s.lineWidth,0),strokeColor:Array.isArray(s.strokeColor)?color({color:s.strokeColor}):color(s),start:point(s.start,[0,0]),end:point(s.end,[1,1])};
}
export function encodeShape(s: ShapeMeta): RecordValue {
  return {...s,kind:s.kind==='ellipse'?'Ellipse':s.kind==='line'?'Line':'Rectangle',...rgb(s.color),color:undefined,lineWidth:s.kind==='line'?s.strokeWidth:undefined};
}
