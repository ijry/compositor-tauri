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
import { decodeImageBytes, encodeImage } from '@/io/imageIO';
import { fileExtension, joinPath, listDirectory, readFile, writeFile } from '@/platform/host';
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
  };
  maskFile?: string;
  maskEnabled?: boolean;
  maskPlacement?: { x: number; y: number; width: number; height: number };
  maskLinked?: boolean;
  adjustment?: Record<string, unknown> & { kind: AdjustmentKind };
  effects?: LayerEffects;
  text?: TextMeta;
  shape?: ShapeMeta;
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
export async function saveCompProject(document: CompDocument, directory: string, onProgress?: (done: number, total: number) => void): Promise<string | null> {
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
      transform: {
        origin: layer.transform.origin,
        size: layer.transform.size,
        rotation: layer.transform.rotation,
        flipX: layer.transform.flipX,
        flipY: layer.transform.flipY,
        sampling: layer.transform.sampling,
      },
    };
    if (layer.kind === 'pixel' && layer.pixels) {
      const fileName = `${layer.id.toUpperCase()}.png`;
      const ok = await writeFile(joinPath(imagesDir, fileName), await bufferToPngBytes(layer.pixels));
      if (!ok) return null;
      entry.imageFile = fileName;
      if (layer.mask) {
        const maskName = `${layer.id.toUpperCase()}.mask.png`;
        const maskOk = await writeFile(joinPath(imagesDir, maskName), await bufferToPngBytes(maskToPngBytes(layer.mask.pixels)));
        if (!maskOk) return null;
        entry.maskFile = maskName;
        entry.maskEnabled = layer.mask.enabled;
        if (!layer.mask.linked && layer.mask.placement) {
          entry.maskLinked = false;
          entry.maskPlacement = layer.mask.placement;
        }
      }
      if (layer.text) entry.text = layer.text;
      if (layer.shape) entry.shape = layer.shape;
    } else if (layer.kind === 'adjustment' && layer.adjustment) {
      entry.adjustment = layer.adjustment as unknown as ManifestLayer['adjustment'];
    }
    if (layer.effects) entry.effects = layer.effects;
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

/* ------------------------------ 读 ------------------------------ */

/** 读取工程包目录 */
export async function loadCompProject(directory: string): Promise<CompDocument> {
  const manifestBuffer = await readFile(joinPath(directory, 'manifest.json'));
  if (!manifestBuffer) throw new Error('manifest.json 读取失败');
  const manifest = JSON.parse(new TextDecoder().decode(manifestBuffer)) as ProjectManifest;
  if (manifest.format !== 'com.compositor.project') throw new Error('不是有效的 .comp 工程');
  if (!Number.isFinite(manifest.version) || manifest.version > PROJECT_VERSION) {
    throw new Error(`工程版本 ${manifest.version} 高于当前支持的 ${PROJECT_VERSION}`);
  }
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

async function buildLayer(entry: ManifestLayer, directory: string, manifest: ProjectManifest): Promise<Layer | null> {
  const base = {
    isVisible: entry.isVisible !== false,
    opacity: typeof entry.opacity === 'number' ? Math.max(0, Math.min(1, entry.opacity)) : 1,
    blendMode: (entry.blendMode ?? 'Normal') as BlendMode,
    parentId: entry.parentID ?? null,
  };
  if (entry.isGroup) {
    const group = createGroupLayer(entry.name, base.parentId);
    group.opacity = base.opacity;
    group.isVisible = base.isVisible;
    return group;
  }
  if (entry.adjustment) {
    const adjustment = { ...defaultAdjustment(entry.adjustment.kind), ...entry.adjustment } as ReturnType<typeof defaultAdjustment>;
    return {
      id: entry.id,
      kind: 'adjustment',
      name: entry.name,
      isVisible: base.isVisible,
      opacity: base.opacity,
      blendMode: base.blendMode,
      transform: {
        origin: entry.transform?.origin ?? [0, 0],
        size: entry.transform?.size ?? [manifest.width, manifest.height],
        rotation: entry.transform?.rotation ?? 0,
        flipX: entry.transform?.flipX ?? false,
        flipY: entry.transform?.flipY ?? false,
        sampling: (entry.transform?.sampling ?? 'High quality') as 'High quality' | 'Smooth' | 'Nearest',
        warp: null,
      },
      parentId: base.parentId,
      clipping: false,
      mask: null,
      effects: entry.effects ?? null,
      expanded: true,
      locked: false,
      contentKey: 0,
      pixels: null,
      text: null,
      shape: null,
      adjustment,
    };
  }
  if (!entry.imageFile) return null;
  // 文件名必须是 <ID>.png，且 ID 大写
  const expected = `${entry.id.toUpperCase()}.png`;
  if (entry.imageFile.toUpperCase() !== expected.toUpperCase()) {
    console.warn('图层图片文件名与 ID 不一致，已按记录名读取：', entry.imageFile);
  }
  const buffer = await readFile(joinPath(joinPath(directory, 'images'), entry.imageFile));
  if (!buffer) return null;
  const pixels = await decodeImageBytes(buffer);
  const layer = createPixelLayer(entry.name, pixels, base);
  layer.id = entry.id;
  layer.transform = {
    origin: entry.transform?.origin ?? [0, 0],
    size: entry.transform?.size ?? [pixels.width, pixels.height],
    rotation: entry.transform?.rotation ?? 0,
    flipX: entry.transform?.flipX ?? false,
    flipY: entry.transform?.flipY ?? false,
    sampling: (entry.transform?.sampling ?? 'High quality') as 'High quality' | 'Smooth' | 'Nearest',
    warp: null,
  };
  layer.text = entry.text ?? null;
  layer.shape = entry.shape ?? null;
  layer.effects = entry.effects ?? null;
  if (entry.maskFile) {
    const maskBuffer = await readFile(joinPath(joinPath(directory, 'images'), entry.maskFile));
    if (maskBuffer) {
      const decoded = await decodeImageBytes(maskBuffer);
      const mask = createMask(decoded.width, decoded.height, 0);
      for (let i = 0; i < mask.data.length; i += 1) mask.data[i] = decoded.data[i * 4] ?? 0;
      layer.mask = {
        pixels: mask,
        enabled: entry.maskEnabled !== false,
        linked: entry.maskLinked !== false,
        placement: entry.maskPlacement ?? null,
        target: 'image',
        inverted: false,
      };
    }
  }
  return layer;
}

/* ------------------------------ 热重载 ------------------------------ */

/** 监视器句柄 */
export interface CompWatcher {
  stop: () => void;
}

/**
 * 轮询工程包变化（约 1/3 秒一次）：
 * 以 manifest 内容 + 图片文件名/大小为判断依据，写入停止约 300ms 后触发一次回调。
 */
export function watchCompProject(
  directory: string,
  onChange: () => void,
  onError?: (error: Error) => void,
): CompWatcher {
  let timer: number | null = null;
  let signature = '';
  let pending = false;

  const poll = async (): Promise<void> => {
    try {
      const entries = await listDirectory(directory);
      const manifest = entries.find((entry) => entry.name === 'manifest.json');
      const images = entries
        .filter((entry) => entry.kind === 'file' && entry.name.endsWith('.png'))
        .map((entry) => `${entry.name}:${entry.size}`)
        .sort()
        .join('|');
      const next = `${manifest?.size ?? 0}:${images}`;
      if (signature === '') {
        signature = next;
        return;
      }
      if (next !== signature) {
        if (!pending) {
          pending = true;
          // 等写入停止再重载，连续多次写入会合并成一次更新
          window.setTimeout(() => {
            pending = false;
            poll().finally(() => onChange());
          }, 320);
        }
      } else {
        pending = false;
        signature = next;
      }
    } catch (error) {
      onError?.(error as Error);
    }
  };

  timer = window.setInterval(() => { void poll(); }, 340);
  return {
    stop: () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
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
