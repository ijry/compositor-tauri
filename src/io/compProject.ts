/**
 * .comp 工程包读写（manifest v11）
 * ---------------------------------------------------------------
 * 一个 .comp 是「manifest.json + images/ 目录」的文件夹：
 *  - images/<图层ID>.png 为图层的 RGBA 像素；
 *  - images/<图层ID>.mask.png 为 8 位灰度蒙版；
 *  - manifest 记录画布、图层顺序、变换、外观、蒙版、调整层、效果与文字元数据。
 * 任何能写文件的程序（含 AI 代理）都能生成或修改工程，打开中的工程会自动热重载。
 */
import {
  createDocument, createGroupLayer, createPixelLayer, defaultAdjustment, uuid,
} from '@/core/document';
import { createBuffer, createMask } from '@/core/pixels';
import { decodeAdjustment, encodeAdjustment, decodeShape, encodeShape, decodeEffects, encodeEffects, decodeText, encodeText, decodeMaskPlacement, encodeMaskPlacement } from './projectCodecs';
import { decodeImageBytes, encodeImage } from '@/io/imageIO';
import { canRenameHostEntry, renameHostEntry, removeTemporaryEntry, fileExtension, joinPath, listDirectory, readFile, writeFile } from '@/platform/host';
import type {
  AdjustmentKind, BlendMode, CompDocument, Layer, LayerEffects, LevelRange, PixelBuffer, ShapeMeta, TextMeta,
} from '@/types/document';

/** 工程格式版本（与上游一致） */
export const PROJECT_VERSION = 11;

/** manifest 结构 */
interface ProjectManifest {
  format: string;
  version: number;
  colorSpace: string;
  documentID: string;
  width: number;
  height: number;
  resolution: number;
  activeLayerID: string | null;
  guides?: { id: string; axis: 'horizontal' | 'vertical'; position: number }[];
  layers: ManifestLayer[];
}

interface ManifestLayer {
  id: string;
  name: string;
  imageFile?: string;
  isVisible: boolean;
  isGroup?: boolean;
  parentID?: string | null;
  opacity?: number;
  blendMode?: BlendMode;
  transform: {
    origin: [number, number];
    size: [number, number];
    rotation: number;
    flipX: boolean;
    flipY: boolean;
    sampling: string;
    warp?: Layer['transform']['warp'];
  };
  clipping?: boolean;
  maskSourceID?: string | null;
  maskInverted?: boolean;
  maskFile?: string;
  maskEnabled?: boolean;
  maskPlacement?: unknown;
  maskLinked?: boolean;
  adjustment?: Record<string, unknown> & { kind: AdjustmentKind };
  effects?: unknown;
  text?: unknown;
  shape?: unknown;
  gradient?: {start:import('@/types/document').Point;end:import('@/types/document').Point;settings:import('@/types/document').GradientMeta['settings'];baseFile:string;selectionFile?:string};
}

/* ------------------------------ 写 ------------------------------ */

/** 缓存：图层 ID -> PNG 文件名，避免同一层重复编码 */
async function bufferToPngBytes(buffer: PixelBuffer): Promise<Uint8Array> {
  const blob = await encodeImage(buffer, { format: 'png', quality: 1, scale: 1, background: [255, 255, 255] });
  return new Uint8Array(await blob.arrayBuffer());
}

function maskToPngBytes(mask: { width: number; height: number; data: Uint8Array<ArrayBuffer> }): PixelBuffer {
  const buffer = createBuffer(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i += 1) {
    const value = mask.data[i] ?? 0;
    buffer.data[i * 4] = value;
    buffer.data[i * 4 + 1] = value;
    buffer.data[i * 4 + 2] = value;
    buffer.data[i * 4 + 3] = 255;
  }
  return buffer;
}

/**
 * 保存工程包。
 * 写入顺序：先写所有 PNG，再写 manifest（AI 代理也遵循同样的顺序，避免读到半成品）。
 */
async function writeProjectFiles(document: CompDocument, directory: string, onProgress?: (done: number, total: number) => void): Promise<string | null> {
  const imagesDir = joinPath(directory, 'images');
  const layers: ManifestLayer[] = [];
  let index = 0;
  for (const layer of document.layers) {
    index += 1;
    onProgress?.(index, document.layers.length + 1);
    const entry: ManifestLayer = {
      id: layer.id,
      name: layer.name,
      isVisible: layer.isVisible,
      isGroup: layer.kind === 'group',
      parentID: layer.parentId,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      clipping: layer.clipping,
      transform: {
        origin: layer.transform.origin,
        size: layer.transform.size,
        rotation: layer.transform.rotation,
        flipX: layer.transform.flipX,
        flipY: layer.transform.flipY,
        sampling: layer.transform.sampling,
        warp: layer.transform.warp,
      },
    };
    if (layer.kind === 'pixel' && layer.pixels) {
      const fileName = `${layer.id.toUpperCase()}.png`;
      const ok = await writeFile(joinPath(imagesDir, fileName), await bufferToPngBytes(layer.pixels));
      if (!ok) return null;
      entry.imageFile = fileName;
      if (layer.text) entry.text = encodeText(layer.text);
      if (layer.shape) entry.shape = encodeShape(layer.shape);
      if(layer.gradient){const baseFile=layer.id.toUpperCase()+'.gradient.png';if(!await writeFile(joinPath(imagesDir,baseFile),await bufferToPngBytes(layer.gradient.base)))return null;entry.gradient={start:layer.gradient.start,end:layer.gradient.end,settings:layer.gradient.settings,baseFile};if(layer.gradient.selection){const selectionFile=layer.id.toUpperCase()+'.gradient-selection.png';if(!await writeFile(joinPath(imagesDir,selectionFile),await bufferToPngBytes(maskToPngBytes(layer.gradient.selection))))return null;entry.gradient.selectionFile=selectionFile;}}
    } else if (layer.kind === 'adjustment' && layer.adjustment) {
      entry.adjustment = encodeAdjustment(layer.adjustment) as ManifestLayer['adjustment'];
    }
    if (layer.mask) {
      const maskName = `${layer.id.toUpperCase()}.mask.png`;
      const maskOk = await writeFile(joinPath(imagesDir, maskName), await bufferToPngBytes(maskToPngBytes(layer.mask.pixels)));
      if (!maskOk) return null;
      entry.maskFile = maskName;
      entry.maskEnabled = layer.mask.enabled;
      entry.maskInverted = layer.mask.inverted;
      entry.maskLinked = layer.mask.linked;
      if (!layer.mask.linked && layer.mask.placement) {
        entry.maskLinked = false;
        entry.maskPlacement = encodeMaskPlacement(layer.mask.placement);
      }
    }
    if (layer.clipping) {
      const previous = document.layers.slice(0,index-1).reverse().find(candidate => candidate.parentId === layer.parentId && !candidate.clipping && candidate.kind === 'pixel');
      if(layer.maskSourceId)entry.maskSourceID=layer.maskSourceId;
      else if (previous) entry.maskSourceID = previous.id;
    }
    if (layer.effects) entry.effects = encodeEffects(layer.effects);
    layers.push(entry);
  }
  const manifest: ProjectManifest = {
    format: 'com.compositor.project',
    version: PROJECT_VERSION,
    colorSpace: 'sRGB',
    documentID: document.id,
    width: document.width,
    height: document.height,
    resolution: document.resolution,
    activeLayerID: document.activeLayerId,
    guides: document.guides.map((guide) => ({ id: guide.id, axis: guide.axis, position: guide.position })),
    layers,
  };
  const ok = await writeFile(joinPath(directory, 'manifest.json'), new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
  onProgress?.(index + 1, index + 1);
  return ok ? directory : null;
}

/** 序列化保存并使用同级临时包+备份提交；失败不覆盖原图片，不删除备份。 */
let saveQueue: Promise<unknown> = Promise.resolve();
export function saveCompProject(document: CompDocument, directory: string, onProgress?: (done: number, total: number) => void): Promise<string | null> {
  for(const layer of document.layers){validateLayerId(layer.id);validateTransform(layer.transform);}
  const snapshot = cloneProjectValue(document);
  const save = async (): Promise<string | null> => {
    if (!canRenameHostEntry()) throw new Error('当前宿主缺少安全重命名接口，已拒绝覆盖工程');
    const target = directory.replace(/[/\\]+$/, '');
    if (!target || target==='/' || target==='.' || target==='..' || target.split(/[/\\]/).includes('..') || /^[A-Za-z]:$/.test(target)) throw new Error('不能将根目录作为工程目录');
    const entries = await window.otools!.listHostDir?.(target);
    if (!entries) throw new Error('无法检查保存目录，已取消安全保存');
    if (entries.length) {
      if (!entries.some(entry => entry.name === 'manifest.json')) throw new Error('只能保存到空文件夹或已有 .comp 工程目录');
      const previous = await readFile(joinPath(target, 'manifest.json'));
      if (!previous || JSON.parse(new TextDecoder().decode(previous)).format !== 'com.compositor.project') throw new Error('目标目录不是有效工程，已取消替换');
    }
    const suffix=uuid();const staging=target+'.saving-'+suffix;const backup=target+'.backup-'+suffix;
    let backedUp=false;
    try {
      if (!await writeProjectFiles(snapshot,staging,onProgress)) return null;
      // 用户可能选中已创建的空文件夹，因此统一先尝试移动目标；失败时不继续替换。
      try { await renameHostEntry(target,backup); backedUp=true; }
      catch { throw new Error('目标目录无法备份，保存已取消；请检查目录权限'); }
      try { await renameHostEntry(staging,target); }
      catch (error) {
        if (backedUp) {
          try { await renameHostEntry(backup,target); backedUp=false; }
          catch { throw new Error('工程提交与回滚失败，旧工程完整保留于：'+backup); }
        }
        throw error;
      }
      // 保留上一版完整备份：宿主只有普通 rename，进程中断可由用户恢复备份，不能宣称原子替换。
      return target;
    } finally { await removeTemporaryEntry(staging).catch(()=>undefined); }
  };
  const result=saveQueue.then(save);saveQueue=result.catch(()=>undefined);return result;
}
function cloneProjectValue<T>(value: T): T {
  if (value instanceof Uint8ClampedArray) return new Uint8ClampedArray(value) as T;
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (Array.isArray(value)) return value.map(cloneProjectValue) as T;
  if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,cloneProjectValue(v)])) as T;
  return value;
}

/* ------------------------------ 读 ------------------------------ */

/** 读取工程包目录 */
export async function loadCompProject(directory: string): Promise<CompDocument> {
  const manifestBuffer = await readFile(joinPath(directory, 'manifest.json'));
  if (!manifestBuffer) throw new Error('manifest.json 读取失败');
  const manifest = JSON.parse(new TextDecoder().decode(manifestBuffer)) as ProjectManifest;
  if (manifest.format !== 'com.compositor.project') throw new Error('不是有效的 .comp 工程');
  if (!Number.isInteger(manifest.version) || manifest.version < 1 || manifest.version > PROJECT_VERSION) {
    throw new Error(`工程版本 ${manifest.version} 高于当前支持的 ${PROJECT_VERSION}`);
  }
  validateManifest(manifest);
  const document = createDocument(manifest.width, manifest.height, directory.split(/[/\\]/).pop() ?? '未命名');
  document.id = manifest.documentID || document.id;
  document.resolution = manifest.resolution ?? 72;
  document.packagePath = directory;
  document.guides = (manifest.guides ?? []).map((guide) => ({ ...guide }));

  for (const entry of manifest.layers) {
    const layer = await buildLayer(entry, directory, manifest);
    if (layer) document.layers.push(layer);
  }
  document.activeLayerId = manifest.activeLayerID && document.layers.some((item) => item.id === manifest.activeLayerID)
    ? manifest.activeLayerID
    : document.layers[document.layers.length - 1]?.id ?? null;
  return document;
}

/** ID不仅用于引用，也会作为文件名。读写两端均在产生任何写入前校验。 */
function validateLayerId(id: unknown): asserts id is string {
  if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(id))throw new Error('工程图层 ID 无效，不能包含路径字符');
}
function validateTransform(t: Partial<Omit<Layer['transform'],'sampling'>>): void {
  const pair=(v:unknown,positive:boolean):boolean=>Array.isArray(v)&&v.length===2&&v.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=1_000_000&&(!positive||n>0));
  if(t.origin&&!pair(t.origin,false))throw new Error('图层位置无效');
  if(t.size&&(!pair(t.size,true)||t.size[0]*t.size[1]>100_000_000))throw new Error('图层变换尺寸超出安全范围');
  if(t.rotation!==undefined&&!Number.isFinite(t.rotation))throw new Error('图层旋转无效');
  if(t.warp && (t.warp.length!==4||t.warp.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>1024||Math.abs(p.y)>1024)))throw new Error('图层扭曲坐标无效');
}

function validateManifest(manifest: ProjectManifest): void {
  if (!Number.isInteger(manifest.width) || !Number.isInteger(manifest.height) || manifest.width<1 || manifest.height<1 || manifest.width*manifest.height>100_000_000 || !Array.isArray(manifest.layers)) throw new Error('工程尺寸或图层列表无效');
  const ids=new Map<string,ManifestLayer>();
  for (const entry of manifest.layers) {
    validateLayerId(entry.id);
    if(entry.transform)validateTransform(entry.transform);
    if (!entry.id || ids.has(entry.id)) throw new Error('工程图层 ID 重复或缺失');
    ids.set(entry.id,entry);
    for (const name of [entry.imageFile,entry.maskFile,entry.gradient?.baseFile,entry.gradient?.selectionFile]) if (name && (!/^[a-zA-Z0-9_.-]+\.png$/i.test(name) || name.includes('..'))) throw new Error('工程资源路径无效');
  }
  for (const entry of manifest.layers) {
    if(entry.maskSourceID && (!ids.has(entry.maskSourceID)||entry.maskSourceID===entry.id))throw new Error('剪贴源引用无效');
    const seen=new Set([entry.id]);let parent=entry.parentID;
    while(parent){if(seen.has(parent)||!ids.get(parent)?.isGroup)throw new Error('工程图层层级无效');seen.add(parent);parent=ids.get(parent)!.parentID;}
  }
}

async function buildLayer(entry: ManifestLayer, directory: string, manifest: ProjectManifest): Promise<Layer | null> {
  const base = {
    isVisible: entry.isVisible !== false,
    opacity: typeof entry.opacity === 'number' ? Math.max(0, Math.min(1, entry.opacity)) : 1,
    blendMode: (entry.blendMode ?? 'Normal') as BlendMode,
    parentId: entry.parentID ?? null,
  };
  let layer: Layer;
  if (entry.isGroup) {
    layer = createGroupLayer(entry.name, base.parentId);
  } else if (entry.adjustment) {
    const adjustment = decodeAdjustment(entry.adjustment);
    layer = { ...createGroupLayer(entry.name, base.parentId), kind:'adjustment', adjustment } as Layer;
  } else {
    if (!entry.imageFile) throw new Error('图层缺少图片资源：' + entry.name);
    // 文件名必须是 <ID>.png，且 ID 大写
    const expected = `${entry.id.toUpperCase()}.png`;
    if (entry.imageFile.toUpperCase() !== expected.toUpperCase()) {
      console.warn('图层图片文件名与 ID 不一致，已按记录名读取：', entry.imageFile);
    }
    const buffer = await readFile(joinPath(joinPath(directory, 'images'), entry.imageFile));
    if (!buffer) throw new Error('工程图片读取失败，未载入不完整工程：' + entry.imageFile);
    const pixels = await decodeImageBytes(buffer);
    layer = createPixelLayer(entry.name, pixels, base);
  }
  Object.assign(layer, base);
  layer.id = entry.id;
  layer.clipping = entry.clipping === true || !!entry.maskSourceID;
  layer.maskSourceId = entry.maskSourceID ?? null;
  layer.transform = {
    origin: entry.transform?.origin ?? [0, 0],
    size: entry.transform?.size ?? [layer.pixels?.width ?? manifest.width, layer.pixels?.height ?? manifest.height],
    rotation: entry.transform?.rotation ?? 0,
    flipX: entry.transform?.flipX ?? false,
    flipY: entry.transform?.flipY ?? false,
    sampling: (entry.transform?.sampling ?? 'High quality') as 'High quality' | 'Smooth' | 'Nearest',
    warp: entry.transform?.warp ?? null,
  };
  layer.text = decodeText(entry.text);
  layer.shape = decodeShape(entry.shape);
  if(entry.gradient){const bytes=await readFile(joinPath(joinPath(directory,'images'),entry.gradient.baseFile));if(!bytes)throw new Error('渐变底图缺失');layer.gradient={...entry.gradient,base:await decodeImageBytes(bytes),selection:null};if(entry.gradient.selectionFile){const encoded=await readFile(joinPath(joinPath(directory,'images'),entry.gradient.selectionFile));if(!encoded)throw new Error('渐变选区缺失');const image=await decodeImageBytes(encoded),mask=createMask(image.width,image.height,0);for(let i=0;i<mask.data.length;i++)mask.data[i]=image.data[i*4]!;layer.gradient.selection={...mask,outline:null};}}
  layer.effects = decodeEffects(entry.effects);
  if (entry.maskFile) {
    const maskBuffer = await readFile(joinPath(joinPath(directory, 'images'), entry.maskFile));
    if (!maskBuffer) throw new Error('工程蒙版读取失败：' + entry.maskFile);
    {
      const decoded = await decodeImageBytes(maskBuffer);
      const mask = createMask(decoded.width, decoded.height, 0);
      for (let i = 0; i < mask.data.length; i += 1) mask.data[i] = decoded.data[i * 4] ?? 0;
      layer.mask = {
        pixels: mask,
        enabled: entry.maskEnabled !== false,
        linked: entry.maskLinked !== false,
        placement: decodeMaskPlacement(entry.maskPlacement),
        target: 'image',
        inverted: entry.maskInverted === true,
      };
    }
  }
  return layer;
}

/* ------------------------------ 热重载 ------------------------------ */

/** 监视器句柄 */
export interface CompWatcher {
  stop: () => void;
  /** 自身保存成功后更新基线，避免把自己的写入当成外部修改。 */
  acknowledge: () => Promise<void>;
}

/**
 * 轮询工程包变化（约 1/3 秒一次）：
 * 以 manifest 内容 + 图片文件名/大小为判断依据，写入停止约 300ms 后触发一次回调。
 */
export function watchCompProject(
  directory: string,
  onChange: () => void | boolean | Promise<void | boolean>,
  onError?: (error: Error) => void,
): CompWatcher {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false, accepted = '', candidate = '', epoch = 0;
  const signature = async (): Promise<string> => {
    const bytes = await readFile(joinPath(directory, 'manifest.json'));
    if (!bytes) throw new Error('工程清单暂不可读');
    const entries = await listDirectory(joinPath(directory, 'images'));
    return new TextDecoder().decode(bytes) + '|' + entries.filter(e => e.kind === 'file').map(e => e.name + ':' + e.size).sort().join('|');
  };
  const poll = async (): Promise<void> => {
    const started = epoch;
    try {
      const next = await signature();
      if (stopped || started !== epoch) return;
      if (!accepted) accepted = next;
      else if (next === accepted) candidate = '';
      else if (candidate === next) {
        // false 表示忙碌或半成品；不消费通知，下轮继续重试。
        const handled = await onChange();
        if (!stopped && started === epoch && handled !== false) { accepted = next; candidate = ''; }
      } else candidate = next;
    } catch (error) { if (!stopped) onError?.(error as Error); }
    finally { if (!stopped) timer = setTimeout(() => void poll(), 340); }
  };
  void poll();
  return {
    stop: () => { stopped = true; epoch++; if (timer !== null) clearTimeout(timer); timer = null; },
    acknowledge: async () => {
      const started = ++epoch;
      const next = await signature();
      if (!stopped && started === epoch) { accepted = next; candidate = ''; }
    },
  };
}

/** 判断文件是否是工程包目录的 manifest */
export function isManifestFile(name: string): boolean {
  return name === 'manifest.json';
}

/** 供「打开」对话框使用的过滤器 */
export const COMP_OPEN_FILTERS = [{ name: '工程清单', extensions: ['json'] }];

/** 从路径猜测是否为相机 RAW 文件 */
export function isRawExtension(name: string): boolean {
  return ['dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'pef', 'srw'].includes(fileExtension(name));
}

/** 生成一个新的空工程 ID（AI 代理可复用） */
export function newDocumentId(): string {
  return uuid();
}

export type { LevelRange };
