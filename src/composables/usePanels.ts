/**
 * 浮动面板停靠系统
 * ---------------------------------------------------------------
 * 每个面板可以停靠在左侧 / 右侧 / 底部，也可以浮动在画布之上；
 * 浮动面板可拖动标题栏移动、拖动边缘缩放，双击标题栏可快速停靠/浮动；
 * 布局保存到宿主本地状态，重启后恢复。
 */
import { computed, reactive, watch } from 'vue';
import { loadState, saveState } from '@/platform/host';

/** 面板 id */
export type PanelId = 'properties' | 'layers' | 'history';

/** 停靠区域 */
export type DockArea = 'left' | 'right' | 'bottom' | 'float';

/** 面板状态 */
export interface PanelState {
  id: PanelId;
  /** 面板标题 */
  title: string;
  /** 停靠区域 */
  area: DockArea;
  /** 停靠时的厚度（像素） */
  size: number;
  /** 是否折叠 */
  collapsed: boolean;
  /** 停靠时的排列顺序 */
  order: number;
  /** 浮动时的位置与大小（CSS 像素），area 记录上次停靠的位置 */
  float: { x: number; y: number; width: number; height: number; area: DockArea };
}

const STORAGE_KEY = 'compositor.panels.v1';

/** 默认布局：属性与图层在右侧，历史在底部 */
function defaultPanels(): Record<PanelId, PanelState> {
  return {
    properties: {
      id: 'properties', title: '属性', area: 'right', size: 288, collapsed: false, order: 0,
      float: { x: 320, y: 180, width: 320, height: 420, area: 'right' },
    },
    layers: {
      id: 'layers', title: '图层', area: 'right', size: 288, collapsed: false, order: 1,
      float: { x: 660, y: 220, width: 280, height: 460, area: 'right' },
    },
    history: {
      id: 'history', title: '历史 / 颜色 / 信息', area: 'bottom', size: 148, collapsed: false, order: 0,
      float: { x: 420, y: 320, width: 340, height: 320, area: 'bottom' },
    },
  };
}

/** 所有面板状态 */
export const panelStates = reactive<Record<PanelId, PanelState>>(defaultPanels());

/** 读取持久化布局 */
export async function loadPanelLayout(): Promise<void> {
  const saved = await loadState<Partial<Record<PanelId, Partial<PanelState>>>>(STORAGE_KEY, {});
  const base = defaultPanels();
  for (const key of Object.keys(base) as PanelId[]) {
    const patch = saved[key];
    if (!patch) continue;
    const state = panelStates[key];
    if (patch.area) state.area = patch.area;
    if (typeof patch.size === 'number') state.size = Math.max(120, Math.min(900, patch.size));
    if (typeof patch.collapsed === 'boolean') state.collapsed = patch.collapsed;
    if (typeof patch.order === 'number') state.order = patch.order;
    if (patch.float) state.float = { ...state.float, ...patch.float };
  }
}

/** 保存布局（防抖） */
let saveTimer: number | null = null;
function persist(): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    saveState(STORAGE_KEY, JSON.parse(JSON.stringify(panelStates)) as unknown as Record<PanelId, Partial<PanelState>>);
  }, 400);
}

watch(panelStates, persist, { deep: true });

/** 取面板状态 */
export function panelOf(id: PanelId): PanelState {
  return panelStates[id];
}

/** 切换浮动 / 停靠 */
export function toggleFloat(id: PanelId): void {
  const state = panelStates[id];
  if (state.area === 'float') {
    // 回到上一次停靠的位置，没有记录则放到右侧
    // 上次停靠的位置可能仍是 float（理论不会发生），此时回落到右侧
    dock(id, state.float.area === 'float' ? 'right' : state.float.area);
    return;
  }
  state.float.area = state.area;
  state.area = 'float';
}

/** 停靠到指定区域 */
export function dock(id: PanelId, area: Exclude<DockArea, 'float'>, at?: number): void {
  const state = panelStates[id];
  state.area = area;
  state.float.area = area;
  if (area === 'left' || area === 'right') {
    state.size = Math.max(200, Math.min(560, state.size));
    state.order = at ?? nextOrder(area, id);
  } else {
    state.size = Math.max(100, Math.min(420, state.size));
    state.order = at ?? nextOrder(area, id);
  }
}

/** 计算该区域内的下一个排序号 */
function nextOrder(area: DockArea, exceptId: PanelId): number {
  const peers = Object.values(panelStates).filter((item) => item.area === area && item.id !== exceptId);
  return peers.reduce((max, item) => Math.max(max, item.order + 1), 0);
}

/** 切换折叠 */
export function toggleCollapse(id: PanelId): void {
  panelStates[id].collapsed = !panelStates[id].collapsed;
}

/** 移动浮动面板 */
export function moveFloat(id: PanelId, x: number, y: number): void {
  const state = panelStates[id];
  const size = Math.max(220, Math.min(window.innerWidth - 40, state.float.width));
  state.float.x = Math.max(-size + 80, Math.min(window.innerWidth - 60, x));
  state.float.y = Math.max(0, Math.min(window.innerHeight - 40, y));
}

/** 缩放浮动面板 */
export function resizeFloat(id: PanelId, width: number, height: number): void {
  const state = panelStates[id];
  state.float.width = Math.max(220, Math.min(window.innerWidth - 40, width));
  state.float.height = Math.max(140, Math.min(window.innerHeight - 40, height));
}

/** 调整停靠面板的厚度 */
export function resizeDock(id: PanelId, size: number): void {
  const state = panelStates[id];
  const max = state.area === 'bottom' ? 520 : 640;
  state.size = Math.max(100, Math.min(max, size));
}

/** 按区域取停靠面板（已排序） */
export function docked(area: DockArea): PanelState[] {
  return Object.values(panelStates)
    .filter((item) => item.area === area)
    .sort((a, b) => a.order - b.order);
}

/** 浮动面板列表 */
export const floating = computed<PanelState[]>(() => docked('float'));

/** 恢复默认布局 */
export function resetPanels(): void {
  const base = defaultPanels();
  for (const key of Object.keys(base) as PanelId[]) {
    Object.assign(panelStates[key], base[key]);
  }
}
