import { userErrorMessage } from '@/core/userMessage';
import { clampPixels } from '@/core/pixelFormat';
/**
 * 编辑器状态中枢
 * ---------------------------------------------------------------
 * 负责：
 *  - 多文档（标签页）管理、视口、工具与工具选项；
 *  - 撤销/重做（每个文档一条历史栈，内存预算按设备内存自适应）；
 *  - 实现 EditorApi，工具与面板只依赖它；
 *  - 汇总所有命令（菜单、快捷键、面板共用同一套实现）。
 */
import { computed, reactive, ref, shallowRef, triggerRef, toRaw, watch } from 'vue';
import { History, recommendedBudget } from '@/core/engine/history';
import { CanvasRenderer, nextZoom, type Viewport } from '@/core/engine/renderer';
import { setPaintDocument } from '@/core/engine/paint';
import { compositeDocument } from '@/core/engine/compositor';
import {
  activeLayer as pickActiveLayer, adoptDocumentDepth, createDocument, duplicateLayer, findLayer, mergeDown, mergeGroup, mergeLayers,
  createGroupLayer, insertLayer, nudgeLayerOrder, removeLayers, flattenVisible, groupLayers, ungroupLayers,
} from '@/core/document';
import { createSelection, combineSelection, invertSelection, isSelectionEmpty } from '@/core/selection';
import { cloneBuffer, cloneMask } from '@/core/pixels';
import { getTool, cycleTool, TOOLS } from '@/tools';
import { bindShortcuts, chordFromEvent, findShortcut, loadShortcutOverrides } from '@/composables/shortcuts';
import type { ToolDefinition, ToolPointerEvent } from '@/tools/types';
import type { EditorApi, LayerSnapshot } from '@/types/editor';
import type { CompDocument, Layer, PixelBuffer, SelectionMask } from '@/types/document';
import { createCommands } from '@/composables/commands';
import { confirmMessage } from '@/platform/host';
import { stopWatchingDocument, type ReloadGuard, type ReloadResult } from '@/composables/commands-io';

/** 全局状态（单例） */
/** 打开的文档列表 */
export const documents = ref<CompDocument[]>([]);
const activeIndex = ref(0);
const renderer = shallowRef<CanvasRenderer | null>(null);
/** 是否已打开文档（启动页与命令守卫使用） */
export function hasDocument(): boolean {
  return currentDocument.value !== null;
}
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
  canvasOnly: false,
  pixelGrid: true,
});

/** 画布尺寸（由画布组件注册） */
let stageSize = { width: 1200, height: 800 };

/** 当前文档 */
export const currentDocument = computed<CompDocument | null>(() => documents.value[activeIndex.value] ?? null);
/** 切换图层/标签后同步模糊目标，避免沿用上一层的“蒙版”参数。 */
watch(() => [currentToolId.value,currentDocument.value?.id,currentDocument.value?.activeLayerId,
  currentDocument.value?.layers.find(layer=>layer.id===currentDocument.value?.activeLayerId)?.mask?.target], () => {
  if(currentToolId.value!=='blur' || !toolOptions.blur)return;
  const layer=currentDocument.value?.layers.find(item=>item.id===currentDocument.value?.activeLayerId);
  toolOptions.blur.target=layer?.mask?.target==='mask'?'mask':'pixels';
});

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
  // 画布还没完成布局时 clientWidth/clientHeight 可能为 0，这里退回默认尺寸
  const width = Math.max(320, stageSize.width || 1200);
  const height = Math.max(240, stageSize.height || 800);
  const zoom = Math.min((width - padding) / Math.max(1, document.width), (height - padding) / Math.max(1, document.height));
  return Math.max(0.02, Math.min(16, zoom));
}

/** 工具定义 */
/** 当前工具 id */
export const toolId = currentToolId;

/** 当前工具定义 */
export const currentTool = computed<ToolDefinition | undefined>(() => getTool(currentToolId.value));

/** 打开文档（新建或导入后调用） */
export function openDocument(document: CompDocument): void {
  adoptDocumentDepth(document);
  documents.value.push(document);
  activeIndex.value = documents.value.length - 1;
  viewportOf(document);
  statusMessage.value = `已打开 ${document.name}`;
}

/** 内容修订号不受视口重绘影响，用于异步保存/重载的并发保护。 */
const revisions = new WeakMap<CompDocument, number>();
let interactionDocument: CompDocument | null = null;
const pendingReloads = new Set<string>();
export function documentRevision(document: CompDocument): number { return revisions.get(toRaw(document)) ?? 0; }
function markDocumentModified(document: CompDocument): void {
  revisions.set(toRaw(document), documentRevision(document) + 1);
  document.dirty = true;
  document.updatedAt = Date.now();
}
export function findOpenProject(path: string): CompDocument | undefined {
  return documents.value.find(document => document.packagePath === path);
}
export function canReloadDocument(document: CompDocument): boolean {
  return !document.saving && !pendingCloses.has(document.id) && interactionDocument?.id !== document.id;
}
/** 先确认未保存内容，再复核文档身份和修订号；用户等待时的新编辑绝不被覆盖。 */
export async function reloadDocument(document: CompDocument, guard?: ReloadGuard): Promise<ReloadResult> {
  const old = findOpenProject(document.packagePath ?? '');
  if (!old || guard?.isCurrent?.() === false) return 'closed';
  if (guard && (old !== guard.target || documentRevision(old) !== guard.revision)) return 'retry';
  if (!canReloadDocument(old) || pendingReloads.has(old.id)) return 'retry';
  const revision = documentRevision(old), wasDirty = old.dirty;
  pendingReloads.add(old.id);
  try {
    if (old.dirty && !await confirmMessage('「' + old.name + '」已被外部修改。重新载入将丢弃尚未保存的编辑，是否继续？', '工程发生外部修改')) return 'kept';
    const index = documents.value.indexOf(old);
    if (index < 0 || guard?.isCurrent?.() === false) return 'closed';
    if (documentRevision(old) !== revision || old.dirty !== wasDirty || !canReloadDocument(old)) {
      setStatus('等待期间文档发生变化，已保留本地内容');
      return 'kept';
    }
    document.id = old.id;
    if (old.width === document.width && old.height === document.height) document.selection = old.selection;
    if (document.layers.some(layer => layer.id === old.activeLayerId)) document.activeLayerId = old.activeLayerId;
    for (const layer of document.layers) {
      const previous = old.layers.find(item => item.id === layer.id);
      if (previous) layer.expanded = previous.expanded;
    }
    histories.delete(old.id);
    historyVersion.value += 1;
    documents.value[index] = document;
    invalidate();
    return 'reloaded';
  } finally { pendingReloads.delete(old.id); }
}

/** 统一关闭入口：菜单与标签按钮均确认未保存内容，始终按原文档 ID 关闭。 */
const pendingCloses = new Set<string>();
export async function closeDocument(id: string): Promise<boolean> {
  const target = documents.value.find(item => item.id === id);
  if (!target || pendingCloses.has(id) || target.saving) return false;
  pendingCloses.add(id);
  const revision = documentRevision(target);
  try {
    if (target.dirty && !await confirmMessage('「' + target.name + '」有未保存的修改，确定关闭吗？', '关闭文档')) return false;
    if (documentRevision(target) !== revision || target.saving) return false;
    return removeDocument(target);
  } finally { pendingCloses.delete(id); }
}
function removeDocument(target: CompDocument): boolean {
  const id = target.id;
  const index = documents.value.findIndex((item) => item.id === id);
  if (index < 0 || documents.value[index] !== target) return false;
  stopWatchingDocument(id);
  documents.value.splice(index, 1);
  histories.delete(id);
  delete viewports[id];
  activeIndex.value = Math.max(0, Math.min(documents.value.length - 1, activeIndex.value - (index <= activeIndex.value ? 1 : 0)));
  return true;
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
  compositeCache = null;
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
  const id=currentToolId.value,mode=id==='marquee'?'shape':id==='lasso'?'mode':id==='shape'?'kind':null;
  const values=id==='marquee'?['rect','ellipse']:id==='lasso'?['free','polygon']:['rectangle','roundedRectangle','ellipse','line'];
  if(mode){const at=values.indexOf(api.option<string>(mode,values[0]!));api.setToolOption(mode,values[(at+direction+values.length)%values.length]);return;}
  if(['blur','smudge','liquify'].includes(id)){const ids=['blur','smudge','liquify'],i=ids.indexOf(id);setTool(ids[(i+direction+ids.length)%ids.length]!);return;}
  setTool(cycleTool(currentToolId.value,direction));
}
export function activateShortcutTool(id:string):void {
  if(currentToolId.value===id || id==='blur'&&['blur','smudge','liquify'].includes(currentToolId.value) || id==='wand'&&currentToolId.value==='objectSelect')cycleCurrentTool();
  else setTool(id);
}


/** 注册画布渲染器与尺寸 */
export function registerStage(canvas: HTMLCanvasElement | null, size: { width: number; height: number }, stageRenderer?: CanvasRenderer): void {
  renderer.value = canvas ? stageRenderer ?? new CanvasRenderer(canvas) : null;
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
  const cancel=(dialog.value?.payload as {onCancel?:()=>void}|undefined)?.onCancel;
  dialog.value = null;
  cancel?.();
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
    // 还没有打开的文档时（例如首帧渲染）返回一个安全的默认视口
    const document = currentDocument.value;
    if (!document) return { zoom: 1, centerX: 0, centerY: 0 };
    return viewportOf(document);
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
      markDocumentModified(document);
    }
  },
  pushHistory(label, undo, redo, bytes = 4096, mergeKey) {
    const document = currentDocument.value;
    if (!document) return;
    // 所有历史提交与回放都标记实际所属文档，不能依赖各面板自行记得 touch。
    const modified = (): void => markDocumentModified(document);
    historyOf(document).push({ label, undo: () => { undo(); modified(); }, redo: () => { redo(); modified(); }, bytes, mergeKey });
    modified();
    historyVersion.value += 1;
    invalidate();
  },
  beginInteraction() {
    interactionDocument = currentDocument.value;
    /* 交互快照由工具自己维护，这里仅保证文档指针最新 */
    setPaintDocument(currentDocument.value ?? null);
  },
  endInteraction() {
    interactionDocument = null;
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
      maskState: layer.mask ? {enabled:layer.mask.enabled,linked:layer.mask.linked,placement:layer.mask.placement ? {...layer.mask.placement} : null,target:layer.mask.target,inverted:layer.mask.inverted} : null,
      clipping:layer.clipping,
      transform: JSON.parse(JSON.stringify(layer.transform)),
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      text: layer.text ? JSON.parse(JSON.stringify(layer.text)) : null,
      gradient: layer.gradient ? {...layer.gradient,base:cloneBuffer(layer.gradient.base),settings:JSON.parse(JSON.stringify(layer.gradient.settings)),selection:layer.gradient.selection?{...layer.gradient.selection,data:new Uint8Array(layer.gradient.selection.data)}:null}:null,
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
    layer.mask = snapshot.mask ? { pixels:cloneMask(snapshot.mask),enabled:true,linked:true,placement:null,target:'image',inverted:false,...snapshot.maskState } : null;
    if (snapshot.clipping !== undefined) layer.clipping = snapshot.clipping;
    layer.maskSourceId=snapshot.maskSourceId;
    layer.transform = JSON.parse(JSON.stringify(snapshot.transform));
    layer.opacity = snapshot.opacity;
    layer.blendMode = snapshot.blendMode;
    layer.text = snapshot.text ? JSON.parse(JSON.stringify(snapshot.text)) : null;
    layer.gradient = snapshot.gradient ? {...snapshot.gradient,base:cloneBuffer(snapshot.gradient.base),settings:JSON.parse(JSON.stringify(snapshot.gradient.settings)),selection:snapshot.gradient.selection?{...snapshot.gradient.selection,data:new Uint8Array(snapshot.gradient.selection.data)}:null}:null;
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
    if(layer.pixels)clampPixels(layer.pixels);
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
    // 模糊参数栏与图层面板的目标选择保持一致，避免界面选蒙版却写到图像。
    if(id==='blur' && key==='target') {
      const layer=this.activeLayer();
      if(layer?.mask)layer.mask.target=value==='mask'?'mask':'image';
    }
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
export async function closeCurrent(): Promise<boolean> {
  const document = currentDocument.value;
  if (!document) return false;
  return closeDocument(document.id);
}

/** 命令对象（延迟创建，避免循环初始化） */
export const commands = {
  async run(name:string,payload?:unknown):Promise<void> {
    try{await commandsImpl.run(name,payload);}
    catch(error){setStatus('操作失败：'+userErrorMessage(error));}
  },
};

/** 命令实现 */
export const commandsImpl = createCommands(api);

/** 把编辑器接口注入快捷键表（避免循环依赖） */
bindShortcuts(api);

/** 叠加界面开关的读取（面板用） */
export const uiState = ui;

/* ------------------------------ 快捷键 ------------------------------ */

/** 记录当前按键的 Shift 状态（供 Tab 循环使用） */
let eventShift = false;

/** 全局键盘处理（由 App.vue 挂到 window 上） */
export function handleKeyDown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  // 输入框内不拦截
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  if(dialog.value && !['Escape'].includes(event.key))return;
  eventShift = event.shiftKey;
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (dispatchKey(event)) {
    event.preventDefault();
    return;
  }
  // 可重映射的全局快捷键
  const matched = findShortcut(chordFromEvent(event));
  if (matched) {
    if (matched.id === 'tool.brush' || matched.id.startsWith('tool.')) {
      // 工具快捷键需要走统一的 setTool，交给各自的 run 处理即可
    }
    matched.run();
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
let opacityTime=0;
function applyOpacityBuffer():void {
  const layer=api.activeLayer(),document=currentDocument.value;if(!layer||!document)return;
  const now=performance.now();if(now-opacityTime>700)opacityBuffer=opacityBuffer.slice(-1);opacityTime=now;
  opacityBuffer=opacityBuffer.slice(-2);
  const value=opacityBuffer.length===1?(opacityBuffer==='0'?1:Number(opacityBuffer)/10):Number(opacityBuffer)/100;
  const before=layer.opacity,id=layer.id;
  const apply=(v:number)=>{const target=document.layers.find(l=>l.id===id);if(target)target.opacity=v;api.invalidate();};
  apply(value);api.pushHistory('调整不透明度',()=>apply(before),()=>apply(value),16,'opacity');
}

/** 初始化：注册默认文档 */
export function initialize(): void {
  initToolOptions();
  void loadShortcutOverrides();
}
