/**
 * 文档与图层的构造、增删改查
 * ---------------------------------------------------------------
 * 所有会改变文档的操作都集中在这里，工具与界面只调用这些函数，
 * 保证「一次操作 = 一次历史记录 = 一次重绘」。
 */
import { compositeInto } from '@/core/engine/compositor';
import {
  cloneBuffer, cloneMask, createBuffer, createMask, flipBuffer, resizeBuffer, resizeMask, rotateBuffer,
} from '@/core/pixels';
import { BLEND_MODES } from '@/types/document';
import type {
  AdjustmentKind, AdjustmentLayer, AdjustmentRecord, BlendMode, CompDocument, GridSettings, Layer,
  LayerTransform, MaskBuffer, PixelBuffer, Point, Rect, SamplingMode, SnapSettings,
} from '@/types/document';

/** 生成 UUID（.comp 的 id 字段使用大写 UUID） */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/** 默认变换 */
export function defaultTransform(width: number, height: number): LayerTransform {
  return {
    origin: [0, 0],
    size: [width, height],
    rotation: 0,
    flipX: false,
    flipY: false,
    sampling: 'High quality',
    warp: null,
  };
}

/** 默认网格设置 */
export function defaultGrid(): GridSettings {
  return { enabled: false, spacing: 100, subdivisions: 0, showBorder: true, color: '#8ab4f8' };
}

/** 默认吸附设置 */
export function defaultSnap(): SnapSettings {
  return { guides: true, grid: false, layers: true, document: true };
}

/** 创建空白文档 */
export function createDocument(width = 1920, height = 1080, name = '未命名'): CompDocument {
  const now = Date.now();
  return {
    id: uuid(),
    name,
    width,
    height,
    resolution: 72,
    layers: [],
    activeLayerId: null,
    selection: null,
    guides: [],
    grid: defaultGrid(),
    snap: defaultSnap(),
    foreground: [0, 0, 0],
    background: [255, 255, 255],
    dirty: false,
    packagePath: null,
    saving: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** 像素图层 */
export function createPixelLayer(name: string, pixels: PixelBuffer, options: Partial<Layer> = {}): Layer {
  return {
    id: uuid(),
    kind: 'pixel',
    name,
    isVisible: true,
    opacity: 1,
    blendMode: 'Normal',
    transform: defaultTransform(pixels.width, pixels.height),
    parentId: null,
    clipping: false,
    mask: null,
    effects: null,
    expanded: true,
    locked: false,
    contentKey: 0,
    pixels,
    text: null,
    shape: null,
    adjustment: null,
    ...options,
  } as Layer;
}

/** 空白像素图层 */
export function createBlankLayer(document: CompDocument, name = '图层'): Layer {
  return createPixelLayer(name, createBuffer(document.width, document.height));
}

/** 恒等色阶区间 */
function identityRange() {
  return { black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 };
}

/** 默认的调整记录（levels / curves 为恒等，与 .comp v7 的要求一致） */
export function defaultAdjustment(kind: AdjustmentKind): AdjustmentRecord {
  return {
    kind,
    hue: 0,
    saturation: 0,
    lightness: 0,
    colorize: false,
    levels: {
      channel: 'RGB',
      ranges: [identityRange(), identityRange(), identityRange(), identityRange()],
    },
    curves: {
      channel: 'RGB',
      channels: [
        { points: [[0, 0], [255, 255]] },
        { points: [[0, 0], [255, 255]] },
        { points: [[0, 0], [255, 255]] },
        { points: [[0, 0], [255, 255]] },
      ],
    },
    exposureSettings: { exposure: 0, offset: 0, gamma: 1 },
    gradientMapSettings: {
      shadows: [0, 0, 0],
      mids: [128, 128, 128],
      highlights: [255, 255, 255],
      reversed: false,
    },
    grainSettings: { amount: 0, size: 1, roughness: 0.5, colorAmount: 0, seed: 1 },
    blackWhiteSettings: {
      reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80,
      tintEnabled: false, tintColor: [225, 190, 150],
    },
    colorBalanceSettings: {
      shadowCyanRed: 0, shadowMagentaGreen: 0, shadowYellowBlue: 0,
      midCyanRed: 0, midMagentaGreen: 0, midYellowBlue: 0,
      highlightCyanRed: 0, highlightMagentaGreen: 0, highlightYellowBlue: 0,
      preserveLuminosity: true,
    },
    blurRadius: 4,
    motionAngle: 0,
    motionDistance: 20,
    noiseAmount: 10,
    noiseGaussian: true,
    noiseMonochromatic: false,
    noiseSeed: 1,
  };
}

const ADJUSTMENT_LABELS: Record<AdjustmentKind, string> = {
  'Hue/Saturation': '色相/饱和度',
  Levels: '色阶',
  Curves: '曲线',
  Exposure: '曝光度',
  'Gradient Map': '渐变映射',
  Grain: '颗粒',
  'Black & White': '黑白',
  'Color Balance': '色彩平衡',
  Invert: '反相',
  'Gaussian Blur': '高斯模糊',
  'Motion Blur': '动感模糊',
  'Add Noise': '添加杂色',
};

/** 调整层 */
export function createAdjustmentLayer(kind: AdjustmentKind, document: CompDocument, name?: string): AdjustmentLayer {
  return {
    id: uuid(),
    kind: 'adjustment',
    name: name ?? ADJUSTMENT_LABELS[kind],
    isVisible: true,
    opacity: 1,
    blendMode: 'Normal',
    transform: defaultTransform(document.width, document.height),
    parentId: null,
    clipping: false,
    mask: null,
    effects: null,
    expanded: true,
    locked: false,
    contentKey: 0,
    pixels: null,
    text: null,
    shape: null,
    adjustment: defaultAdjustment(kind),
  };
}

/** 组（文件夹） */
export function createGroupLayer(name = '组', parentId: string | null = null): Layer {
  return {
    id: uuid(),
    kind: 'group',
    name,
    isVisible: true,
    opacity: 1,
    blendMode: 'Normal',
    transform: defaultTransform(1, 1),
    parentId,
    clipping: false,
    mask: null,
    effects: null,
    expanded: true,
    locked: false,
    contentKey: 0,
    pixels: null,
    text: null,
    shape: null,
    adjustment: null,
  };
}

/* ------------------------------ 查询 ------------------------------ */

export function findLayer(document: CompDocument, id: string | null): Layer | null {
  if (!id) return null;
  return document.layers.find((layer) => layer.id === id) ?? null;
}

export function layerIndex(document: CompDocument, id: string): number {
  return document.layers.findIndex((layer) => layer.id === id);
}

export function activeLayer(document: CompDocument): Layer | null {
  return findLayer(document, document.activeLayerId);
}

/** 某图层的直接子层 */
export function childrenOf(document: CompDocument, parentId: string | null): Layer[] {
  return document.layers.filter((layer) => layer.parentId === parentId);
}

/** 某图层的全部后代（用于可见性、删除、合并） */
export function descendantsOf(document: CompDocument, id: string): Layer[] {
  const result: Layer[] = [];
  const walk = (parentId: string): void => {
    for (const layer of document.layers) {
      if (layer.parentId === parentId) {
        result.push(layer);
        walk(layer.id);
      }
    }
  };
  walk(id);
  return result;
}

/** 祖先链（由内到外） */
export function ancestorsOf(document: CompDocument, layer: Layer): Layer[] {
  const result: Layer[] = [];
  let parentId = layer.parentId;
  let guard = 0;
  while (parentId && guard < 64) {
    guard += 1;
    const parent = findLayer(document, parentId);
    if (!parent) break;
    result.push(parent);
    parentId = parent.parentId;
  }
  return result;
}

/** 可见性（含组继承） */
export function isLayerVisible(document: CompDocument, layer: Layer): boolean {
  if (!layer.isVisible) return false;
  return ancestorsOf(document, layer).every((parent) => parent.isVisible);
}

/** 有效不透明度（含组继承） */
export function effectiveOpacity(document: CompDocument, layer: Layer): number {
  return ancestorsOf(document, layer).reduce((value, parent) => value * parent.opacity, layer.opacity);
}

/* ------------------------------ 增删改 ------------------------------ */

/** 插入图层到指定位置（缺省为当前活动图层之上） */
export function insertLayer(document: CompDocument, layer: Layer, index?: number): Layer {
  const insertAt = index ?? defaultInsertIndex(document);
  document.layers.splice(Math.max(0, Math.min(document.layers.length, insertAt)), 0, layer);
  document.activeLayerId = layer.id;
  document.updatedAt = Date.now();
  return layer;
}

function defaultInsertIndex(document: CompDocument): number {
  const index = document.activeLayerId ? layerIndex(document, document.activeLayerId) : -1;
  if (index < 0) return document.layers.length;
  // 插入到活动图层之上（数组中下标更大）
  const parentId = document.layers[index]?.parentId ?? null;
  let target = index + 1;
  while (target < document.layers.length) {
    if ((document.layers[target]?.parentId ?? null) !== parentId) break;
    target += 1;
  }
  return target;
}

/** 深拷贝图层（含蒙版、像素） */
export function duplicateLayer(layer: Layer, nameSuffix = ' 副本'): Layer {
  const copy = JSON.parse(JSON.stringify({ ...layer, pixels: null, mask: null })) as Layer;
  copy.id = uuid();
  copy.name = `${layer.name}${nameSuffix}`;
  copy.pixels = layer.kind === 'pixel' && layer.pixels ? cloneBuffer(layer.pixels) : null;
  copy.mask = layer.mask
    ? { ...layer.mask, pixels: cloneMask(layer.mask.pixels), placement: layer.mask.placement ? { ...layer.mask.placement } : null }
    : null;
  if (copy.kind === 'adjustment' && layer.kind === 'adjustment' && layer.adjustment) {
    copy.adjustment = JSON.parse(JSON.stringify(layer.adjustment));
  }
  if (copy.kind === 'pixel' && layer.kind === 'pixel') {
    copy.text = layer.text ? JSON.parse(JSON.stringify(layer.text)) : null;
    copy.shape = layer.shape ? JSON.parse(JSON.stringify(layer.shape)) : null;
  }
  copy.effects = layer.effects ? JSON.parse(JSON.stringify(layer.effects)) : null;
  return copy;
}

/** 删除图层（含子层），返回被删除的图层 */
export function removeLayers(document: CompDocument, ids: string[]): Layer[] {
  const targets = new Set(ids);
  for (const id of ids) descendantsOf(document, id).forEach((child) => targets.add(child.id));
  const removed = document.layers.filter((layer) => targets.has(layer.id));
  document.layers = document.layers.filter((layer) => !targets.has(layer.id));
  if (document.activeLayerId && targets.has(document.activeLayerId)) {
    const fallback = document.layers.filter((layer) => layer.parentId === null);
    document.activeLayerId = (fallback[fallback.length - 1] ?? document.layers[document.layers.length - 1])?.id ?? null;
  }
  document.updatedAt = Date.now();
  return removed;
}

/**
 * 移动图层到新的位置与父级（拖拽排序与嵌套）。
 * @param index 目标在数组中的下标
 * @param parentId 目标父组
 * @param name 图层名（不传表示保持原名）
 */
export function moveLayer(document: CompDocument, id: string, index: number, parentId: string | null, name?: string): void {
  const current = layerIndex(document, id);
  if (current < 0) return;
  if (parentId && (parentId === id || descendantsOf(document, id).some((child) => child.id === parentId))) return;
  const [layer] = document.layers.splice(current, 1);
  if (!layer) return;
  if (name !== undefined) layer.name = name;
  layer.parentId = parentId;
  const target = Math.max(0, Math.min(document.layers.length, index));
  document.layers.splice(target, 0, layer);
  document.updatedAt = Date.now();
}

/** 上移/下移一层（保持同级） */
export function nudgeLayerOrder(document: CompDocument, id: string, direction: 1 | -1): void {
  const index = layerIndex(document, id);
  if (index < 0) return;
  const parentId = document.layers[index]?.parentId ?? null;
  const siblings = document.layers
    .map((item, position) => ({ item, position }))
    .filter((entry) => (entry.item.parentId ?? null) === parentId);
  const siblingIndex = siblings.findIndex((entry) => entry.item.id === id);
  const target = siblings[siblingIndex + direction];
  if (!target) return;
  const [moved] = document.layers.splice(index, 1);
  const insertAt = target.position > index ? target.position - 1 : target.position;
  document.layers.splice(Math.max(0, Math.min(document.layers.length, insertAt)), 0, moved!);
  document.updatedAt = Date.now();
}

/** 把若干图层打组（组插入到最高层的上方） */
export function groupLayers(document: CompDocument, ids: string[]): Layer | null {
  const set = new Set(ids);
  if (set.size === 0) return null;
  const indices = ids.map((id) => layerIndex(document, id)).filter((index) => index >= 0);
  if (indices.length === 0) return null;
  const topIndex = Math.max(...indices);
  const parentId = document.layers[indices[0]!]?.parentId ?? null;
  const group = createGroupLayer('组', parentId);
  for (const layer of document.layers) {
    if (set.has(layer.id)) layer.parentId = group.id;
  }
  document.layers.splice(topIndex + 1, 0, group);
  document.activeLayerId = group.id;
  document.updatedAt = Date.now();
  return group;
}

/** 解散组：子层上移一层，组本身删除 */
export function ungroupLayers(document: CompDocument, groupId: string): Layer | null {
  const group = findLayer(document, groupId);
  if (!group || group.kind !== 'group') return null;
  const index = layerIndex(document, groupId);
  const children = document.layers.filter((layer) => layer.parentId === groupId);
  const insertAt = index + 1;
  document.layers = document.layers.filter((layer) => layer.id !== groupId);
  let cursor = Math.max(0, Math.min(document.layers.length, insertAt - 1));
  for (const child of children) {
    child.parentId = group.parentId;
    document.layers.splice(cursor, 0, child);
    cursor += 1;
  }
  document.activeLayerId = children[0]?.id ?? group.parentId;
  document.updatedAt = Date.now();
  return group;
}

/** 合并若干图层（自下而上合成到最上面的图层） */
export function mergeLayers(document: CompDocument, ids: string[]): Layer | null {
  const selected = ids
    .map((id) => findLayer(document, id))
    .filter((layer): layer is Layer => Boolean(layer))
    .sort((a, b) => layerIndex(document, a.id) - layerIndex(document, b.id));
  if (selected.length < 2) return null;
  const top = selected[selected.length - 1]!;
  const composite = createBuffer(document.width, document.height);
  const subset = new Set<string>();
  for (const layer of selected) {
    if (layer.kind === 'group') descendantsOf(document, layer.id).forEach((child) => subset.add(child.id));
    subset.add(layer.id);
  }
  const tempDocument: CompDocument = { ...document, layers: document.layers.filter((layer) => subset.has(layer.id)) };
  compositeInto(composite, tempDocument, 1);
  const merged = createPixelLayer(top.name, composite, {
    opacity: top.opacity,
    blendMode: top.blendMode,
    parentId: top.parentId,
  });
  const insertAt = layerIndex(document, top.id);
  removeLayers(document, selected.map((layer) => layer.id));
  document.layers.splice(Math.max(0, Math.min(document.layers.length, insertAt)), 0, merged);
  document.activeLayerId = merged.id;
  document.updatedAt = Date.now();
  return merged;
}

/** 与下方图层合并（⌘E） */
export function mergeDown(document: CompDocument, id: string): Layer | null {
  const index = layerIndex(document, id);
  if (index <= 0) return null;
  const below = document.layers[index - 1];
  if (!below) return null;
  return mergeLayers(document, [below.id, id]);
}

/** 合并整个组为一个像素层 */
export function mergeGroup(document: CompDocument, groupId: string): Layer | null {
  const group = findLayer(document, groupId);
  if (!group || group.kind !== 'group') return null;
  return mergeLayers(document, [groupId]);
}

/** 合并所有可见图层为一个像素层 */
export function flattenVisible(document: CompDocument): Layer | null {
  const composite = createBuffer(document.width, document.height);
  compositeInto(composite, document, 1);
  const flattened = createPixelLayer('合并图层', composite, { parentId: null });
  document.layers = [flattened];
  document.activeLayerId = flattened.id;
  document.updatedAt = Date.now();
  return flattened;
}

/* ------------------------------ 蒙版 ------------------------------ */

/** 为图层添加全白蒙版 */
export function addLayerMask(layer: Layer, canvasWidth = 1, canvasHeight = 1): MaskBuffer {
  const width = layer.kind === 'pixel' && layer.pixels ? layer.pixels.width : canvasWidth;
  const height = layer.kind === 'pixel' && layer.pixels ? layer.pixels.height : canvasHeight;
  if (layer.kind !== 'pixel') layer.transform = defaultTransform(width,height);
  const pixels = createMask(width, height, 255);
  layer.mask = { pixels, enabled: true, linked: true, placement: null, target: 'mask', inverted: false };
  return pixels;
}

/** 应用蒙版：把蒙版并入像素的 alpha 后删除蒙版 */
export function applyLayerMask(layer: Layer): void {
  if (!layer.mask || layer.kind !== 'pixel' || !layer.pixels) return;
  const { pixels } = layer;
  const mask = layer.mask;
  const width = Math.min(pixels.width, mask.pixels.width);
  const height = Math.min(pixels.height, mask.pixels.height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * pixels.width + x) * 4;
      const value = mask.pixels.data[y * mask.pixels.width + x];
      const m = mask.inverted ? 255 - value : value;
      pixels.data[i + 3] = (pixels.data[i + 3] * m) / 255;
    }
  }
  layer.mask = null;
}

/** 反相蒙版 */
export function invertLayerMask(layer: Layer): void {
  if (!layer.mask) return;
  const data = layer.mask.pixels.data;
  for (let i = 0; i < data.length; i += 1) data[i] = 255 - data[i];
}

/** 从选区生成蒙版 */
export function maskFromSelection(layer: Layer, selection: Uint8Array, width: number, height: number): void {
  const targetWidth = layer.kind === 'pixel' && layer.pixels ? layer.pixels.width : width;
  const targetHeight = layer.kind === 'pixel' && layer.pixels ? layer.pixels.height : height;
  const mask = createMask(targetWidth, targetHeight, 0);
  const sx = width > 0 ? width / targetWidth : 1;
  const sy = height > 0 ? height / targetHeight : 1;
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const px = Math.min(width - 1, Math.max(0, Math.floor(x * sx)));
      const py = Math.min(height - 1, Math.max(0, Math.floor(y * sy)));
      mask.data[y * targetWidth + x] = selection.length > 0 ? selection[py * width + px] : 255;
    }
  }
  layer.mask = { pixels: mask, enabled: true, linked: true, placement: null, target: 'mask', inverted: false };
}

/* ------------------------------ 画布操作 ------------------------------ */

/** 变换锚点（九宫格） */
export type Anchor = 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';

function anchorOffset(anchor: Anchor, width: number, height: number): { dx: number; dy: number } {
  const mapX: Record<string, number> = { left: 0, center: 0.5, right: 1 };
  const mapY: Record<string, number> = { top: 0, center: 0.5, bottom: 1 };
  const [vertical, horizontal] = anchor.split('-');
  const fx = horizontal ? (mapX[horizontal] ?? 0.5) : 0.5;
  const fy = vertical ? (mapY[vertical] ?? 0.5) : 0.5;
  return { dx: Math.round(width * fx), dy: Math.round(height * fy) };
}

/** 画布大小：改变文档尺寸，所有图层按锚点平移 */
export function resizeCanvas(document: CompDocument, width: number, height: number, anchor: Anchor = 'top-left'): void {
  const offset = anchorOffset(anchor, width - document.width, height - document.height);
  document.width = width;
  document.height = height;
  for (const layer of document.layers) {
    layer.transform.origin[0] += offset.dx;
    layer.transform.origin[1] += offset.dy;
    layer.transform.size = layer.kind === 'pixel' && layer.pixels
      ? [layer.pixels.width, layer.pixels.height]
      : [width, height];
    layer.transform.origin[0] = Math.round(layer.transform.origin[0]);
    layer.transform.origin[1] = Math.round(layer.transform.origin[1]);
    if (layer.kind === 'pixel' && layer.pixels && layer.mask) {
      layer.mask.pixels = resizeMask(layer.mask.pixels, layer.pixels.width, layer.pixels.height);
    }
  }
  document.selection = resizeSelection(document.selection, width, height);
  document.updatedAt = Date.now();
}

/** 图像大小：按比例重采样所有图层像素 */
export function resizeImage(document: CompDocument, width: number, height: number): void {
  const scaleX = width / document.width;
  const scaleY = height / document.height;
  document.width = width;
  document.height = height;
  for (const layer of document.layers) {
    layer.transform.origin[0] = Math.round(layer.transform.origin[0] * scaleX);
    layer.transform.origin[1] = Math.round(layer.transform.origin[1] * scaleY);
    if (layer.kind === 'pixel' && layer.pixels) {
      const newWidth = Math.max(1, Math.round(layer.pixels.width * scaleX));
      const newHeight = Math.max(1, Math.round(layer.pixels.height * scaleY));
      layer.pixels = resizeBuffer(layer.pixels, newWidth, newHeight);
      layer.transform.size = [newWidth, newHeight];
      if (layer.mask) {
        layer.mask.pixels = resizeMask(layer.mask.pixels, newWidth, newHeight);
        if (layer.mask.placement) {
          layer.mask.placement = {
            x: Math.round(layer.mask.placement.x * scaleX),
            y: Math.round(layer.mask.placement.y * scaleY),
            width: Math.max(1, Math.round(layer.mask.placement.width * scaleX)),
            height: Math.max(1, Math.round(layer.mask.placement.height * scaleY)),
          };
        }
      }
    } else {
      layer.transform.size = [width, height];
      if (layer.mask) layer.mask.pixels = createMask(width, height, 255);
    }
  }
  document.selection = resizeSelection(document.selection, width, height);
  document.updatedAt = Date.now();
}

function resizeSelection<T extends { width: number; height: number; data: Uint8Array<ArrayBuffer>; outline: Point[] | null } | null>(
  selection: T,
  width: number,
  height: number,
): T {
  if (!selection) return selection;
  const mask: MaskBuffer = { width: selection.width, height: selection.height, data: selection.data };
  const resized = resizeMask(mask, width, height);
  return { ...selection, width, height, data: resized.data, outline: null };
}

/** 裁剪：按矩形裁剪画布与所有图层 */
export function cropDocument(document: CompDocument, rect: Rect): void {
  const x = Math.max(0, Math.min(document.width - 1, Math.round(rect.x)));
  const y = Math.max(0, Math.min(document.height - 1, Math.round(rect.y)));
  const width = Math.max(1, Math.min(document.width - x, Math.round(rect.width)));
  const height = Math.max(1, Math.min(document.height - y, Math.round(rect.height)));
  for (const layer of document.layers) {
    layer.transform.origin[0] -= x;
    layer.transform.origin[1] -= y;
    if (layer.kind === 'pixel' && layer.pixels) {
      layer.pixels = cropLayerPixels(layer.pixels, { x: -x, y: -y, width, height });
      layer.transform.size = [layer.pixels.width, layer.pixels.height];
      if (layer.mask) layer.mask.pixels = cropMask(layer.mask.pixels, { x: -x, y: -y, width, height });
    } else {
      layer.transform.size = [width, height];
    }
    const bounds = layerBounds(layer);
    if (bounds && (bounds.x > width || bounds.y > height || bounds.x + bounds.width < 0 || bounds.y + bounds.height < 0)) {
      layer.isVisible = false;
    }
  }
  document.width = width;
  document.height = height;
  document.selection = cropSelection(document.selection, x, y, width, height);
  document.guides = document.guides
    .map((guide) => ({ ...guide, position: guide.axis === 'vertical' ? guide.position - x : guide.position - y }))
    .filter((guide) => guide.position >= 0 && guide.position <= (guide.axis === 'vertical' ? width : height));
  document.updatedAt = Date.now();
}

function cropSelection<T extends { width: number; height: number; data: Uint8Array<ArrayBuffer>; outline: Point[] | null } | null>(
  selection: T,
  x: number,
  y: number,
  width: number,
  height: number,
): T {
  if (!selection) return selection;
  const data = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const sx = column + x;
      const sy = row + y;
      if (sx < 0 || sy < 0 || sx >= selection.width || sy >= selection.height) continue;
      data[row * width + column] = selection.data[sy * selection.width + sx];
    }
  }
  return { ...selection, width, height, data, outline: null } as T;
}

/** 图层像素的文档空间包围盒（未考虑旋转） */
export function layerBounds(layer: Layer): Rect {
  return {
    x: layer.transform.origin[0],
    y: layer.transform.origin[1],
    width: layer.transform.size[0],
    height: layer.transform.size[1],
  };
}

/** 文档中所有可见图层的并集包围盒（修边用） */
export function contentBounds(document: CompDocument): Rect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const layer of document.layers) {
    if (!isLayerVisible(document, layer)) continue;
    const bounds = layerBounds(layer);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: Math.floor(minX), y: Math.floor(minY), width: Math.ceil(maxX - minX), height: Math.ceil(maxY - minY) };
}

/** 修边：按颜色裁掉四周一致的边，返回要裁掉的矩形 */
export function trimDocument(document: CompDocument, tolerance: number, background: [number, number, number]): Rect | null {
  const composite = createBuffer(document.width, document.height);
  compositeInto(composite, document, 1);
  const matches = (index: number): boolean => Math.abs(composite.data[index] - background[0]) <= tolerance
    && Math.abs(composite.data[index + 1] - background[1]) <= tolerance
    && Math.abs(composite.data[index + 2] - background[2]) <= tolerance;
  if (!matches(0)) return null;
  const rowEmpty = (y: number): boolean => {
    for (let x = 0; x < document.width; x += 1) if (!matches((y * document.width + x) * 4)) return false;
    return true;
  };
  const columnEmpty = (x: number): boolean => {
    for (let y = 0; y < document.height; y += 1) if (!matches((y * document.width + x) * 4)) return false;
    return true;
  };
  let top = 0;
  let bottom = document.height - 1;
  let left = 0;
  let right = document.width - 1;
  while (top < bottom && rowEmpty(top)) top += 1;
  while (bottom > top && rowEmpty(bottom)) bottom -= 1;
  while (left < right && columnEmpty(left)) left += 1;
  while (right > left && columnEmpty(right)) right -= 1;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** 旋转画布（顺时针 90 的倍数），像素层会被真正旋转 */
export function rotateCanvas(document: CompDocument, degrees: number): void {
  const rotation = ((degrees % 360) + 360) % 360;
  if (rotation === 0) return;
  for (const layer of document.layers) {
    if (layer.kind === 'pixel' && layer.pixels) {
      layer.pixels = rotateBuffer(layer.pixels, rotation);
      if (layer.mask) layer.mask.pixels = rotateMask(layer.mask.pixels, rotation);
      layer.transform.size = [layer.pixels.width, layer.pixels.height];
      layer.transform.origin = rotatePoint(layer.transform.origin, rotation, document.width, document.height);
    } else {
      layer.transform.size = rotation === 180 ? [layer.transform.size[0], layer.transform.size[1]] : [layer.transform.size[1], layer.transform.size[0]];
      layer.transform.origin = rotatePoint(layer.transform.origin, rotation, document.width, document.height);
    }
  }
  if (document.selection) document.selection = rotateSelection(document.selection, rotation);
  document.guides = document.guides.map((guide) => {
    const old = guide.position;
    if (rotation === 90) return { ...guide, axis: guide.axis === 'horizontal' ? 'horizontal' : 'vertical', position: guide.axis === 'horizontal' ? old : document.height - old };
    if (rotation === 180) return { ...guide, position: guide.axis === 'horizontal' ? document.height - old : document.width - old };
    if (rotation === 270) return { ...guide, axis: guide.axis === 'horizontal' ? 'horizontal' : 'vertical', position: guide.axis === 'horizontal' ? document.width - old : old };
    return guide;
  });
  if (rotation === 90 || rotation === 270) {
    const width = document.height;
    document.height = document.width;
    document.width = width;
  }
  document.updatedAt = Date.now();
}

function rotatePoint(point: [number, number], degrees: number, width: number, height: number): [number, number] {
  const [x, y] = point;
  if (degrees === 90) return [height - y, x];
  if (degrees === 180) return [width - x, height - y];
  if (degrees === 270) return [y, width - x];
  return [x, y];
}

/** 翻转画布（同时翻转所有图层） */
export function flipCanvas(document: CompDocument, horizontal: boolean, vertical: boolean): void {
  for (const layer of document.layers) {
    const transform = layer.transform;
    if (horizontal) {
      transform.origin[0] = document.width - transform.origin[0] - transform.size[0];
      transform.flipX = !transform.flipX;
    }
    if (vertical) {
      transform.origin[1] = document.height - transform.origin[1] - transform.size[1];
      transform.flipY = !transform.flipY;
    }
    if (horizontal !== vertical) transform.rotation = -transform.rotation;
    // 已链接蒙版随变换；独立矩形蒙版单独镜像，不能再次翻转图层原始像素。
    if (layer.mask && !layer.mask.linked && layer.mask.placement) {
      const p = layer.mask.placement;
      if (horizontal) p.x = document.width - p.x - p.width;
      if (vertical) p.y = document.height - p.y - p.height;
      layer.mask.pixels = flipMask(layer.mask.pixels, horizontal, vertical);
    }
    layer.contentKey += 1;
  }
  document.guides = document.guides.map(g => ({ ...g, position: g.axis === 'vertical' && horizontal ? document.width - g.position : g.axis === 'horizontal' && vertical ? document.height - g.position : g.position }));
  if (document.selection) document.selection = flipMaskSelection(document.selection, horizontal, vertical);
  document.updatedAt = Date.now();
}

function cropLayerPixels(buffer: PixelBuffer, rect: Rect): PixelBuffer {
  const out = createBuffer(rect.width, rect.height);
  for (let y = 0; y < rect.height; y += 1) {
    const sy = rect.y + y;
    if (sy < 0 || sy >= buffer.height) continue;
    for (let x = 0; x < rect.width; x += 1) {
      const sx = rect.x + x;
      if (sx < 0 || sx >= buffer.width) continue;
      const si = (sy * buffer.width + sx) * 4;
      const di = (y * rect.width + x) * 4;
      out.data[di] = buffer.data[si];
      out.data[di + 1] = buffer.data[si + 1];
      out.data[di + 2] = buffer.data[si + 2];
      out.data[di + 3] = buffer.data[si + 3];
    }
  }
  return out;
}

function cropMask(mask: MaskBuffer, rect: Rect): MaskBuffer {
  const out = createMask(rect.width, rect.height, 0);
  for (let y = 0; y < rect.height; y += 1) {
    const sy = rect.y + y;
    if (sy < 0 || sy >= mask.height) continue;
    for (let x = 0; x < rect.width; x += 1) {
      const sx = rect.x + x;
      if (sx < 0 || sx >= mask.width) continue;
      out.data[y * rect.width + x] = mask.data[sy * mask.width + sx];
    }
  }
  return out;
}

function flipMask(mask: MaskBuffer, horizontal: boolean, vertical: boolean): MaskBuffer {
  const out = createMask(mask.width, mask.height);
  for (let y = 0; y < mask.height; y += 1) {
    const sy = vertical ? mask.height - 1 - y : y;
    for (let x = 0; x < mask.width; x += 1) {
      const sx = horizontal ? mask.width - 1 - x : x;
      out.data[y * mask.width + x] = mask.data[sy * mask.width + sx];
    }
  }
  return out;
}

function rotateMask(mask: MaskBuffer, degrees: number): MaskBuffer {
  const rotation = ((degrees % 360) + 360) % 360;
  if (rotation === 0) return cloneMask(mask);
  const swap = rotation === 90 || rotation === 270;
  const out = createMask(swap ? mask.height : mask.width, swap ? mask.width : mask.height);
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      let tx = x;
      let ty = y;
      if (rotation === 90) { tx = mask.height - 1 - y; ty = x; }
      else if (rotation === 180) { tx = mask.width - 1 - x; ty = mask.height - 1 - y; }
      else if (rotation === 270) { tx = y; ty = mask.width - 1 - x; }
      out.data[ty * out.width + tx] = mask.data[y * mask.width + x];
    }
  }
  return out;
}

function rotateSelection<T extends { width: number; height: number; data: Uint8Array<ArrayBuffer>; outline: Point[] | null }>(
  selection: T,
  degrees: number,
): T {
  const rotation = ((degrees % 360) + 360) % 360;
  if (rotation === 0) return selection;
  const mask: MaskBuffer = { width: selection.width, height: selection.height, data: selection.data };
  const rotated = rotateMask(mask, rotation);
  const outline = selection.outline?.map((point) => {
    if (rotation === 90) return { x: selection.height - point.y, y: point.x };
    if (rotation === 180) return { x: selection.width - point.x, y: selection.height - point.y };
    return { x: point.y, y: selection.width - point.x };
  }) ?? null;
  return { ...selection, width: rotated.width, height: rotated.height, data: rotated.data, outline };
}

function flipMaskSelection<T extends { width: number; height: number; data: Uint8Array<ArrayBuffer>; outline: Point[] | null }>(
  selection: T,
  horizontal: boolean,
  vertical: boolean,
): T {
  const mask: MaskBuffer = { width: selection.width, height: selection.height, data: selection.data };
  const flipped = flipMask(mask, horizontal, vertical);
  const outline = selection.outline?.map((point) => ({
    x: horizontal ? selection.width - point.x : point.x,
    y: vertical ? selection.height - point.y : point.y,
  })) ?? null;
  return { ...selection, data: flipped.data, outline };
}

/** 混合模式步进（⇧[ / ⇧]） */
export function stepBlendMode(mode: BlendMode, direction: 1 | -1): BlendMode {
  const index = BLEND_MODES.indexOf(mode);
  const next = (index + direction + BLEND_MODES.length) % BLEND_MODES.length;
  return BLEND_MODES[next]!;
}

/** 设置采样方式 */
export function setSampling(layer: Layer, sampling: SamplingMode): void {
  layer.transform.sampling = sampling;
}
