/**
 * 编辑器状态中枢
 * ---------------------------------------------------------------
 * 负责：
 *  - 多文档（标签页）管理、视口、工具与工具选项；
 *  - 撤销/重做（每个文档一条历史栈，内存预算按设备内存自适应）；
 *  - 实现 EditorApi，工具与面板只依赖它；
 *  - 汇总所有命令（菜单、快捷键、面板共用同一套实现）。
 */
import { computed, reactive, ref, shallowRef, triggerRef } from 'vue';
import { History, recommendedBudget } from '@/core/engine/history';
import { CanvasRenderer, nextZoom, type Viewport } from '@/core/engine/renderer';
import { setPaintDocument } from '@/core/engine/paint';
import { compositeDocument } from '@/core/engine/compositor';
import {
  activeLayer as pickActiveLayer, createDocument, duplicateLayer, findLayer, mergeDown, mergeGroup, mergeLayers,
  createGroupLayer, insertLayer, nudgeLayerOrder, removeLayers, flattenVisible, groupLayers, ungroupLayers,
} from '@/core/document';
import { createSelection, combineSelection, invertSelection, isSelectionEmpty } from '@/core/selection';
import { cloneBuffer, cloneMask } from '@/core/pixels';
import { getTool, cycleTool, TOOLS, TOOL_SHORTCUTS } from '@/tools';
import type { ToolDefinition, ToolPointerEvent } from '@/tools/types';
import type { EditorApi, LayerSnapshot } from '@/types/editor';
import type { CompDocument, Layer, PixelBuffer, SelectionMask } from '@/types/document';
import { createCommands } from '@/composables/commands';

/** 全局状态（单例） */
/** 打开的文档列表 */
export const documents = ref<CompDocument[]>([]);
const activeIndex = ref(0);
const renderer = shallowRef<CanvasRenderer | null>(null);
/** 当前工具 id（界面绑定用） */
export const currentToolId = ref<string>('move');
const toolOptions = reactive<Record<string, Record<string, unknown>>>({});
/** 状态栏消息 */
export const statusMessage = ref('');
const historyVersion = ref(0);
/** 打开的对话框 */
const dialog = ref<{ name: string; payload?: unknown } | null>(null);
/** 图层缩略图版本号 */
const thumbnailVersion = ref(0);

/** 每个文档一条历史栈 */
const histories = new Map<string, History>();
const viewports = reactive<Record<string, Viewport>>({});
const foreground = ref<[number, number, number]>([0, 0, 0]);
const background = ref<[number, number, number]>([255, 255, 255]);
const pointer = ref<{ x: number; y: number } | null>(null);

const ui = reactive({
  rulers: false,
  grid: false,
  guides: true,
  transformControls: true,
  selection: true,
});

/** 画布尺寸（由画布组件注册） */
let stageSize = { width: 1200, height: 800 };

/** 当前文档 */
export const currentDocument = computed<CompDocument | null>(() => documents.value[activeIndex.value] ?? null);

/** 历史栈 */
function historyOf(document: CompDocument): History {
  let history = histories.get(document.id);
  if (!history) {
    history = new History(recommendedBudget());
    history.subscribe(() => { historyVersion.value += 1; });
    histories.set(document.id, history);
  }
  return history;
}

/** 视口 */
function viewportOf(document: CompDocument): Viewport {
  let viewport = viewports[document.id];
  if (!viewport) {
    viewport = { zoom: fitZoom(document), centerX: document.width / 2, centerY: document.height / 2 };
    viewports[document.id] = viewport;
  }
  return viewport;
}

/** 适配画布的缩放 */
export function fitZoom(document: CompDocument): number {
  const padding = 64;
  const zoom = Math.min((stageSize.width - padding) / Math.max(1, document.width), (stageSize.height - padding) / Math.max(1, document.height));
  return Math.max(0.01, Math.min(16, zoom));
}

/** 工具定义 */
/** 当前工具 id */
export const toolId = currentToolId;

/** 当前工具定义 */
export const currentTool = computed<ToolDefinition | undefined>(() => getTool(currentToolId.value));

/** 打开文档（新建或导入后调用） */
export function openDocument(document: CompDocument): void {
  documents.value.push(document);
  activeIndex.value = documents.value.length - 1;
  viewportOf(document);
  statusMessage.value = `已打开 ${document.name}`;
}

/** 关闭标签页 */
export function closeDocument(id: string): void {
  const index = documents.value.findIndex((item) => item.id === id);
  if (index < 0) return;
  documents.value.splice(index, 1);
  histories.delete(id);
  delete viewports[id];
  activeIndex.value = Math.max(0, Math.min(documents.value.length - 1, activeIndex.value - (index <= activeIndex.value ? 1 : 0)));
}

/** 切换标签页 */
export function selectDocument(index: number): void {
  if (index < 0 || index >= documents.value.length) return;
  activeIndex.value = index;
}

/** 重绘当前文档 */
export function invalidate(): void {
  const document = currentDocument.value;
  if (!document) return;
  renderer.value?.invalidate();
  thumbnailVersion.value += 1;
  document.updatedAt = Date.now();
  if (typeof requestAnimationFrame === 'function') {
    // 触发 Vue 更新（依赖 updatedAt / contentKey 的计算属性会重算）
  }
}

/** 切换工具 */
export function setTool(id: string): void {
  const tool = getTool(id);
  if (!tool) return;
  const previous = getTool(currentToolId.value);
  if (previous && previous.id !== tool.id) previous.deactivate?.(api);
  currentToolId.value = id;
  ensureToolOptions(tool);
  tool.activate?.(api);
  invalidate();
}

/** 确保工具选项已初始化 */
export function ensureToolOptions(tool: ToolDefinition): void {
  if (!toolOptions[tool.id]) toolOptions[tool.id] = { ...tool.defaults };
  // 补齐新增选项
  for (const [key, value] of Object.entries(tool.defaults)) {
    if (toolOptions[tool.id]![key] === undefined) toolOptions[tool.id]![key] = value;
  }
}

/** 全部工具的选项初始化 */
export function initToolOptions(): void {
  for (const tool of TOOLS) ensureToolOptions(tool);
}

/** 键盘快捷键切换工具 */
function toolFromShortcut(key: string): string | null {
  const id = TOOL_SHORTCUTS[key];
  if (!id) return null;
  const group = TOOLS.find((tool) => tool.id === id)?.group;
  void group;
  return id;
}

/** 指针事件分发 */
export function dispatchPointer(phase: 'down' | 'move' | 'up' | 'dblclick', event: ToolPointerEvent): void {
  const tool = currentTool.value;
  const document = currentDocument.value;
  if (!tool || !document) return;
  pointer.value = { x: event.doc.x, y: event.doc.y };
  if (phase === 'down') tool.onDown?.(api, event);
  else if (phase === 'move') tool.onMove?.(api, event);
  else if (phase === 'up') tool.onUp?.(api, event);
  else tool.onDblClick?.(api, event);
  invalidate();
}

/** 工具内键盘事件 */
export function dispatchKey(event: KeyboardEvent): boolean {
  const tool = currentTool.value;
  if (!tool) return false;
  return tool.onKeyDown?.(api, event) ?? false;
}

/** Tab 循环当前分组内的工具 */
export function cycleCurrentTool(direction: 1 | -1 = 1): void {
  setTool(cycleTool(currentToolId.value, direction));
}

/** 注册画布渲染器与尺寸 */
export function registerStage(canvas: HTMLCanvasElement | null, size: { width: number; height: number }): void {
  renderer.value = canvas ? new CanvasRenderer(canvas) : null;
  stageSize = size;
}

/** 画布尺寸 */
export function getStageSize(): { width: number; height: number } {
  return stageSize;
}

/** 状态栏消息 */
export function setStatus(message: string): void {
  statusMessage.value = message;
}

/** 打开对话框 */
export function openDialog(name: string, payload?: unknown): void {
  dialog.value = { name, payload };
}

/** 关闭对话框 */
export function closeDialog(): void {
  dialog.value = null;
}

/** 打开的对话框（界面用） */
export const currentDialog = dialog;

/** 历史（界面用） */
export function currentHistory(): History | null {
  const document = currentDocument.value;
  return document ? historyOf(document) : null;
}

export function historyTick(): number {
  return historyVersion.value;
}

export function thumbnailTick(): number {
  return thumbnailVersion.value;
}

/** 编辑器 API 实现 */
/** 合成结果缓存（魔棒、吸管、全图层仿制都会用到） */
let compositeCache: PixelBuffer | null = null;
let compositeCacheKey = '';

/** 文档内容签名（用于缓存失效判断） */
function documentSignature(document: CompDocument): string {
  let signature = `${document.width}x${document.height}`;
  for (const layer of document.layers) {
    signature += `|${layer.id}${layer.contentKey}${layer.isVisible ? 1 : 0}${layer.opacity}${layer.blendMode}${layer.clipping ? 1 : 0}:${layer.transform.origin.join(',')}:${layer.transform.size.join(',')}:${layer.transform.rotation}`;
    if (layer.mask) signature += `:m${layer.mask.enabled ? 1 : 0}${layer.mask.inverted ? 1 : 0}`;
    if (layer.adjustment) signature += `:a${JSON.stringify(layer.adjustment)}`;
    if (layer.effects) signature += `:e${JSON.stringify(layer.effects)}`;
  }
  return signature;
}

export const api: EditorApi = {
  get doc(): CompDocument {
    const document = currentDocument.value;
    if (!document) throw new Error('没有打开的文档');
    return document;
  },
  get toolId(): string {
    return currentToolId.value;
  },
  get toolOptions(): Record<string, unknown> {
    return toolOptions[currentToolId.value] ?? {};
  },
  get viewport(): Viewport {
    return viewportOf(currentDocument.value!);
  },
  get ui(): typeof ui {
    return ui;
  },
  get pointer(): { x: number; y: number } | null {
    return pointer.value;
  },
  get foreground(): [number, number, number] {
    return foreground.value;
  },
  get background(): [number, number, number] {
    return background.value;
  },
  set foreground(value: [number, number, number]) {
    foreground.value = value;
  },
  set background(value: [number, number, number]) {
    background.value = value;
  },
  invalidate,
  setViewport(patch) {
    const document = currentDocument.value;
    if (!document) return;
    const viewport = viewportOf(document);
    if (typeof patch.zoom === 'number') viewport.zoom = Math.max(0.0033, Math.min(32, patch.zoom));
    if (typeof patch.centerX === 'number') viewport.centerX = patch.centerX;
    if (typeof patch.centerY === 'number') viewport.centerY = patch.centerY;
    invalidate();
  },
  status: setStatus,
  openDialog,
  touch() {
    const document = currentDocument.value;
    if (document) {
      document.dirty = true;
      document.updatedAt = Date.now();
    }
  },
  pushHistory(label, undo, redo, bytes = 4096, mergeKey) {
    const document = currentDocument.value;
    if (!document) return;
    historyOf(document).push({ label, undo, redo, bytes, mergeKey });
    historyVersion.value += 1;
    invalidate();
  },
  beginInteraction() {
    /* 交互快照由工具自己维���，这里仅保证文档指针最新 */
    setPaintDocument(currentDocument.value ?? null);
  },
  endInteraction() {
    setPaintDocument(currentDocument.value ?? null);
  },
  activeLayer(): Layer | null {
    const document = currentDocument.value;
    return document ? pickActiveLayer(document) : null;
  },
  findLayer(id: string): Layer | null {
    const document = currentDocument.value;
    return document ? findLayer(document, id) : null;
  },
  snapshotLayer(id: string): LayerSnapshot | null {
    const layer = this.findLayer(id);
    if (!layer) return null;
    return {
      pixels: layer.pixels ? cloneBuffer(layer.pixels) : null,
      mask: layer.mask ? cloneMask(layer.mask.pixels) : null,
      transform: JSON.parse(JSON.stringify(layer.transform)),
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      text: layer.text ? JSON.parse(JSON.stringify(layer.text)) : null,
      shape: layer.shape ? JSON.parse(JSON.stringify(layer.shape)) : null,
      effects: layer.effects ? JSON.parse(JSON.stringify(layer.effects)) : null,
      adjustment: layer.adjustment ? JSON.parse(JSON.stringify(layer.adjustment)) : null,
    };
  },
  restoreLayer(id: string, snapshot: LayerSnapshot): void {
    const layer = this.findLayer(id);
    if (!layer) return;
    if (snapshot.pixels) {
      layer.pixels = cloneBuffer(snapshot.pixels) as PixelBuffer;
    }
    if (snapshot.mask && layer.mask) layer.mask.pixels = cloneMask(snapshot.mask);
    layer.transform = JSON.parse(JSON.stringify(snapshot.transform));
    layer.opacity = snapshot.opacity;
    layer.blendMode = snapshot.blendMode;
    layer.text = snapshot.text ? JSON.parse(JSON.stringify(snapshot.text)) : null;
    layer.shape = snapshot.shape ? JSON.parse(JSON.stringify(snapshot.shape)) : null;
    layer.effects = snapshot.effects ? JSON.parse(JSON.stringify(snapshot.effects)) : null;
    layer.adjustment = snapshot.adjustment ? JSON.parse(JSON.stringify(snapshot.adjustment)) : null;
    layer.contentKey += 1;
    thumbnailVersion.value += 1;
    invalidate();
  },
  markLayerDirty(id: string): void {
    const layer = this.findLayer(id);
    if (!layer) return;
    layer.contentKey += 1;
    thumbnailVersion.value += 1;
    renderer.value?.invalidate();
  },
  selectionSnapshot(): SelectionMask | null {
    const document = currentDocument.value;
    return document?.selection ? { ...document.selection, data: new Uint8Array(document.selection.data), outline: document.selection.outline } : null;
  },
  restoreSelection(selection: SelectionMask | null): void {
    const document = currentDocument.value;
    if (!document) return;
    document.selection = selection ? { ...selection, data: new Uint8Array(selection.data) } : null;
    invalidate();
  },
  setSelection(selection: SelectionMask | null, mode: 'replace' | 'add' | 'subtract' | 'intersect' = 'replace'): void {
    const document = currentDocument.value;
    if (!document) return;
    if (!selection) document.selection = null;
    else if (mode === 'replace' || !document.selection) document.selection = selection;
    else document.selection = combineSelection(document.selection, selection, mode);
    invalidate();
  },
  setForeground(color: [number, number, number]): void {
    foreground.value = color;
    invalidate();
  },
  setBackground(color: [number, number, number]): void {
    background.value = color;
    invalidate();
  },
  composite(): PixelBuffer {
    const document = currentDocument.value;
    if (!document) return { width: 1, height: 1, data: new Uint8ClampedArray(4) };
    if (!compositeCache || compositeCacheKey !== documentSignature(document)) {
      compositeCache = compositeDocument(document, document.width, document.height, { scale: 1, limitAdjustmentsBySelection: false }).buffer;
      compositeCacheKey = documentSignature(document);
    }
    return compositeCache;
  },
  stageSize: getStageSize,
  toScreen(point) {
    const document = currentDocument.value;
    if (!document) return point;
    const viewport = viewportOf(document);
    return {
      x: (point.x - viewport.centerX) * viewport.zoom + stageSize.width / 2,
      y: (point.y - viewport.centerY) * viewport.zoom + stageSize.height / 2,
    };
  },
  toDoc(point) {
    const document = currentDocument.value;
    if (!document) return point;
    const viewport = viewportOf(document);
    return {
      x: (point.x - stageSize.width / 2) / viewport.zoom + viewport.centerX,
      y: (point.y - stageSize.height / 2) / viewport.zoom + viewport.centerY,
    };
  },
  setToolOption(key: string, value: unknown): void {
    const id = currentToolId.value;
    if (!toolOptions[id]) toolOptions[id] = {};
    toolOptions[id]![key] = value;
    invalidate();
  },
  option<T>(key: string, fallback: T): T {
    const value = toolOptions[currentToolId.value]?.[key];
    return (value === undefined ? fallback : value) as T;
  },
  command: (name: string, payload?: unknown) => commands.run(name, payload),
};

/* ------------------------------ 视图辅助 ------------------------------ */

/** 适配画布 */
export function fitCanvas(): void {
  const document = currentDocument.value;
  if (!document) return;
  api.setViewport({ zoom: fitZoom(document), centerX: document.width / 2, centerY: document.height / 2 });
}

/** 实际像素 */
export function actualPixels(): void {
  api.setViewport({ zoom: 1 });
}

/** 按缩放级别步进 */
export function zoomStep(direction: 1 | -1): void {
  const document = currentDocument.value;
  if (!document) return;
  api.setViewport({ zoom: nextZoom(api.viewport.zoom, direction) });
}

/** 切换界面开关 */
export function toggleUi(key: 'rulers' | 'grid' | 'guides' | 'transformControls'): void {
  if (key === 'grid') {
    const document = currentDocument.value;
    if (document) document.grid.enabled = !document.grid.enabled;
    ui.grid = document?.grid.enabled ?? ui.grid;
  } else {
    ui[key] = !ui[key];
  }
  invalidate();
}

/** 关闭当前文档 */
export function closeCurrent(): void {
  const document = currentDocument.value;
  if (!document) return;
  closeDocument(document.id);
}

/** 命令对象（延迟创建，避免循环初始化） */
export const commands = { run: (name: string, payload?: unknown) => commandsImpl.run(name, payload) };

/** 命令实现 */
export const commandsImpl = createCommands(api);

/** 叠加界面开关的读取（面板用） */
export const uiState = ui;

/* ------------------------------ 快捷键 ------------------------------ */

/** 快捷键定义（与上游 Photoshop 风格一致，⌘/Ctrl 均可用） */
interface Shortcut {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  run: () => void;
}

/** 全局快捷键表 */
function buildShortcuts(): Shortcut[] {
  const list: Shortcut[] = [];
  const push = (key: string, run: () => void, modifiers: Partial<Omit<Shortcut, 'key' | 'run'>> = {}): void => {
    list.push({ key, run, ...modifiers });
  };
  // 工具
  for (const [key, id] of Object.entries(TOOL_SHORTCUTS)) push(key, () => setTool(id));
  push('Tab', () => cycleCurrentTool(eventShift ? -1 : 1));
  // 编辑
  push('z', () => commands.run('undo'), { ctrl: true });
  push('z', () => commands.run('redo'), { ctrl: true, shift: true });
  push('y', () => commands.run('redo'), { ctrl: true });
  push('x', () => commands.run('cut'), { ctrl: true });
  push('c', () => commands.run('copy'), { ctrl: true });
  push('c', () => commands.run('copyMerged'), { ctrl: true, shift: true });
  push('v', () => commands.run('paste'), { ctrl: true });
  // 文件
  push('n', () => commands.run('newCanvas'), { ctrl: true });
  push('o', () => commands.run('openComp'), { ctrl: true });
  push('s', () => commands.run('saveComp'), { ctrl: true });
  push('s', () => commands.run('saveCompAs'), { ctrl: true, shift: true });
  push('e', () => openDialog('exportDialog', { format: 'png' }), { ctrl: true, shift: true });
  push('s', () => openDialog('exportDialog', { format: 'jpeg' }), { ctrl: true, alt: true });
  push('w', () => commands.run('closeDocument'), { ctrl: true });
  // 视图
  push('0', fitCanvas, { ctrl: true });
  push('1', actualPixels, { ctrl: true });
  push('=', () => zoomStep(1), { ctrl: true });
  push('-', () => zoomStep(-1), { ctrl: true });
  push('r', () => toggleUi('rulers'), { ctrl: true });
  push("'", () => toggleUi('grid'), { ctrl: true });
  push(';', () => toggleUi('guides'), { ctrl: true });
  push(';', () => openDialog('snapSettings'), { ctrl: true, shift: true });
  push('h', () => toggleUi('transformControls'), { ctrl: true });
  // 选区
  push('a', () => commands.run('selectAll'), { ctrl: true });
  push('d', () => commands.run('deselect'), { ctrl: true });
  push('i', () => commands.run('inverseSelection'), { ctrl: true, shift: true });
  push('a', () => commands.run('selectSubject'), { ctrl: true, alt: true });
  // 调整
  push('m', () => commands.run('addAdjustment', 'Curves'), { ctrl: true });
  push('l', () => commands.run('addAdjustment', 'Levels'), { ctrl: true });
  push('u', () => commands.run('addAdjustment', 'Hue/Saturation'), { ctrl: true });
  push('i', () => invertLayerOrMask(), { ctrl: true });
  // 画布
  push('c', () => openDialog('canvasSize'), { ctrl: true, alt: true });
  push('i', () => openDialog('imageSize'), { ctrl: true, alt: true });
  // 图层
  push('t', () => commands.run('addAdjustment', 'Invert'), { ctrl: true });
  push('j', () => commands.run('duplicateLayer'), { ctrl: true });
  push('g', () => commands.run('toggleClipping'), { ctrl: true, alt: true });
  push('g', () => commands.run('group'), { ctrl: true });
  push('g', () => commands.run('ungroup'), { ctrl: true, shift: true });
  push('n', () => commands.run('newLayer'), { ctrl: true, shift: true });
  push(']', () => commands.run('moveLayerUp'), { ctrl: true });
  push('[', () => commands.run('moveLayerDown'), { ctrl: true });
  push('e', () => commands.run('mergeDown'), { ctrl: true });
  // 填充
  push('Delete', () => commands.run('fillForeground'), { alt: true });
  push('Delete', () => commands.run('fillBackground'), { ctrl: true });
  push('Delete', () => commands.run('clearSelection'), { shift: true });
  push('Backspace', () => commands.run('fillForeground'), { alt: true });
  // 帮助
  push('k', () => openDialog('shortcuts'), { ctrl: true });
  return list;
}

/** 记录当前按键的 Shift 状态（供 Tab 循环使用） */
let eventShift = false;

/** 反相像素或蒙版 */
function invertLayerOrMask(): void {
  const layer = api.activeLayer();
  if (!layer) return;
  if (layer.mask && layer.mask.target === 'mask') {
    commands.run('invertMask');
    return;
  }
  if (layer.kind !== 'pixel' || !layer.pixels) {
    commands.run('addAdjustment', 'Invert');
    return;
  }
  const before = api.snapshotLayer(layer.id);
  const pixels = layer.pixels;
  for (let i = 0; i < pixels.data.length; i += 4) {
    pixels.data[i] = 255 - pixels.data[i]!;
    pixels.data[i + 1] = 255 - pixels.data[i + 1]!;
    pixels.data[i + 2] = 255 - pixels.data[i + 2]!;
  }
  layer.contentKey += 1;
  api.markLayerDirty(layer.id);
  const after = api.snapshotLayer(layer.id);
  api.pushHistory(
    '反相',
    () => { if (before) api.restoreLayer(layer.id, before); },
    () => { if (after) api.restoreLayer(layer.id, after); },
    (before?.pixels?.data.length ?? 0) * 2,
  );
}

/** 全局键盘处理（由 App.vue 挂到 window 上） */
export function handleKeyDown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  // 输入框内不拦截
  if (target && ['INPUT', 'TEXTAREA', 'el-input'].includes(target.tagName) || target?.isContentEditable) return;
  eventShift = event.shiftKey;
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (dispatchKey(event)) {
    event.preventDefault();
    return;
  }
  for (const shortcut of buildShortcuts()) {
    if (shortcut.key !== key) continue;
    if (Boolean(shortcut.ctrl) !== (ctrl && !shortcut.meta) && !(shortcut.meta && event.metaKey)) continue;
    if (Boolean(shortcut.shift) !== event.shiftKey && key !== 'Tab') continue;
    if (Boolean(shortcut.alt) !== event.altKey) continue;
    shortcut.run();
    event.preventDefault();
    return;
  }
  // 数字键快速设置不透明度（输入两位数为精确百分比）
  if (!ctrl && !event.altKey && /^[0-9]$/.test(key) && !event.shiftKey) {
    opacityBuffer += key;
    applyOpacityBuffer();
  }
}

/** 不透明度快速输入缓冲 */
let opacityBuffer = '';

/** 应用不透明度快速输入 */
function applyOpacityBuffer(): void {
  const layer = api.activeLayer();
  if (!layer) return;
  const value = opacityBuffer.length === 1 ? Number(opacityBuffer) : Number(opacityBuffer) / 100;
  opacityBuffer = '';
  const before = layer.opacity;
  layer.opacity = Math.max(0, Math.min(1, value));
  api.pushHistory(
    '调整不透明度',
    () => { layer.opacity = before; api.invalidate(); },
    () => { layer.opacity = value; api.invalidate(); },
    16,
    'opacity',
  );
}

/** 初始化：注册默认文档 */
export function initialize(): void {
  initToolOptions();
  if (documents.value.length === 0) {
    commands.run('newCanvas');
  }
}
