<script setup lang="ts">
/**
 * 面板停靠布局
 * ---------------------------------------------------------------
 * 左侧 / 右侧 / 底部停靠区 + 浮动面板层：
 *  - 停靠面板可折叠、可拖边缘调整厚度；
 *  - 浮动面板可拖动标题栏移动、拖右下角缩放；
 *  - 把浮动面板拖到窗口边缘会出现停靠提示，松开即停靠；
 *  - 标题栏双击在「浮动」与「停靠」之间切换。
 */
import { computed, ref } from 'vue';
import PropertiesPanel from '@/components/panels/PropertiesPanel.vue';
import LayersPanel from '@/components/panels/LayersPanel.vue';
import HistoryPanel from '@/components/panels/HistoryPanel.vue';
import {
  dock, docked, moveFloat, panelOf, resizeDock, resizeFloat, toggleCollapse, toggleFloat, type DockArea, type PanelId,
} from '@/composables/usePanels';

const PANEL_COMPONENTS: Record<PanelId, unknown> = {
  properties: PropertiesPanel,
  layers: LayersPanel,
  history: HistoryPanel,
};

const left = computed(() => docked('left'));
const right = computed(() => docked('right'));
const bottom = computed(() => docked('bottom'));
const floating = computed(() => docked('float'));

/** 浮动面板拖动状态 */
const dragState = ref<{ id: PanelId; offsetX: number; offsetY: number } | null>(null);
/** 缩放状态 */
const resizeState = ref<{ id: PanelId; startX: number; startY: number; width: number; height: number } | null>(null);
/** 停靠区厚度拖动 */
const dockResize = ref<{ id: PanelId; start: number; size: number } | null>(null);
/** 拖到边缘时的停靠提示区 */
const dockHint = ref<Exclude<DockArea, 'float'> | null>(null);

/** 边缘停靠判定阈值 */
const EDGE = 60;

/** 标题栏按下开始拖动浮动面板 */
function startFloatDrag(event: MouseEvent, id: PanelId): void {
  const state = panelOf(id);
  dragState.value = { id, offsetX: event.clientX - state.float.x, offsetY: event.clientY - state.float.y };
  const move = (moveEvent: MouseEvent): void => {
    const current = dragState.value;
    if (!current) return;
    moveFloat(current.id, moveEvent.clientX - current.offsetX, moveEvent.clientY - current.offsetY);
    dockHint.value = detectDockZone(moveEvent.clientX, moveEvent.clientY);
  };
  const up = (upEvent: MouseEvent): void => {
    const current = dragState.value;
    const target = detectDockZone(upEvent.clientX, upEvent.clientY);
    dragState.value = null;
    dockHint.value = null;
    if (current && target) dock(current.id, target);
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/** 判断指针落在哪个停靠区 */
function detectDockZone(x: number, y: number): Exclude<DockArea, 'float'> | null {
  if (x <= EDGE) return 'left';
  if (y >= window.innerHeight - EDGE) return 'bottom';
  if (x >= window.innerWidth - EDGE) return 'right';
  return null;
}

/** 右下角缩放 */
function startResize(event: MouseEvent, id: PanelId): void {
  const state = panelOf(id);
  resizeState.value = { id, startX: event.clientX, startY: event.clientY, width: state.float.width, height: state.float.height };
  const move = (moveEvent: MouseEvent): void => {
    const current = resizeState.value;
    if (!current) return;
    resizeFloat(current.id, current.width + (moveEvent.clientX - current.startX), current.height + (moveEvent.clientY - current.startY));
  };
  const up = (): void => {
    resizeState.value = null;
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/** 停靠面板厚度拖动 */
function startDockResize(event: MouseEvent, id: PanelId): void {
  const state = panelOf(id);
  const horizontal = state.area !== 'bottom';
  dockResize.value = { id, start: horizontal ? event.clientX : event.clientY, size: state.size };
  const move = (moveEvent: MouseEvent): void => {
    const current = dockResize.value;
    if (!current) return;
    const position = currentStart(current, horizontal, moveEvent);
    const delta = position - current.start;
    resizeDock(current.id, current.size + (state.area === 'left' ? delta : -delta));
  };
  const up = (): void => {
    dockResize.value = null;
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/** 当前指针位置（按方向取 X 或 Y） */
function currentStart(current: { start: number }, horizontal: boolean, event: MouseEvent): number {
  void current;
  return horizontal ? event.clientX : event.clientY;
}

/** 停靠面板的宽度/高度样式 */
function panelStyle(id: PanelId): Record<string, string> {
  const state = panelOf(id);
  if (state.area === 'bottom') return { height: `${state.collapsed ? 30 : state.size}px` };
  return { width: '100%', flex: state.collapsed ? '0 0 30px' : '1 1 0' };
}

/** 同一侧面板共用栏宽；窄窗口限制侧栏，给画布保留空间。 */
function dockWidth(area: 'left' | 'right'): string {
  const panels = docked(area);
  if (!panels.length) return '0px';
  const expanded = panels.filter(panel => !panel.collapsed);
  if (!expanded.length) return '34px';
  const width = Math.max(...expanded.map(panel => panel.size));
  return `min(${width}px, 26vw)`;
}
const gridStyle = computed(() => ({ gridTemplateColumns: `${dockWidth('left')} minmax(0, 1fr) ${dockWidth('right')}` }));

/** 标题栏按钮：切换停靠区域 */
function cycleDock(id: PanelId): void {
  const state = panelOf(id);
  if (state.area === 'left') dock(id, 'right');
  else if (state.area === 'right') dock(id, 'bottom');
  else dock(id, 'left');
}
</script>

<template>
  <div class="dock-layout" :style="gridStyle">
    <!-- 左侧停靠 -->
    <div v-if="left.length > 0" class="dock dock-left">
      <div v-for="panel in left" :key="panel.id" class="dock-panel" :style="panelStyle(panel.id)">
        <header class="dock-header" @dblclick="toggleCollapse(panel.id)">
          <button class="chev" :class="{ collapsed: panel.collapsed }" @click="toggleCollapse(panel.id)">{{ panel.collapsed ? '›' : '‹' }}</button>
          <span v-if="!panel.collapsed" class="title">{{ panel.title }}</span>
          <span class="spacer" />
          <template v-if="!panel.collapsed">
            <button class="hbtn" title="在左侧 / 右侧 / 底部之间切换" @click="cycleDock(panel.id)">⇄</button>
            <button class="hbtn" title="浮动" @click="toggleFloat(panel.id)">▣</button>
          </template>
        </header>
        <div v-show="!panel.collapsed" class="dock-body">
          <component :is="PANEL_COMPONENTS[panel.id]" />
        </div>
        <div v-if="!panel.collapsed" class="resize-handle" @mousedown="startDockResize($event, panel.id)" />
      </div>
    </div>

    <!-- 中间：画布区域 -->
    <div class="dock-center">
      <slot />
    </div>

    <!-- 右侧停靠 -->
    <div v-if="right.length > 0" class="dock dock-right">
      <div v-for="panel in right" :key="panel.id" class="dock-panel" :style="panelStyle(panel.id)">
        <header class="dock-header" @dblclick="toggleCollapse(panel.id)">
          <button class="chev" :class="{ collapsed: panel.collapsed }" @click="toggleCollapse(panel.id)">{{ panel.collapsed ? '‹' : '›' }}</button>
          <span v-if="!panel.collapsed" class="title">{{ panel.title }}</span>
          <span class="spacer" />
          <template v-if="!panel.collapsed">
            <button class="hbtn" title="在左侧 / 右侧 / 底部之间切换" @click="cycleDock(panel.id)">⇄</button>
            <button class="hbtn" title="浮动" @click="toggleFloat(panel.id)">▣</button>
          </template>
        </header>
        <div v-show="!panel.collapsed" class="dock-body">
          <component :is="PANEL_COMPONENTS[panel.id]" />
        </div>
        <div v-if="!panel.collapsed" class="resize-handle" @mousedown="startDockResize($event, panel.id)" />
      </div>
    </div>

    <!-- 底部停靠 -->
    <div v-if="bottom.length > 0" class="dock dock-bottom">
      <div v-for="panel in bottom" :key="panel.id" class="dock-panel horizontal" :style="panelStyle(panel.id)">
        <header class="dock-header" @dblclick="toggleCollapse(panel.id)">
          <button class="chev down" :class="{ collapsed: panel.collapsed }" @click="toggleCollapse(panel.id)">{{ panel.collapsed ? '⌄' : '⌃' }}</button>
          <span v-if="!panel.collapsed" class="title">{{ panel.title }}</span>
          <span class="spacer" />
          <template v-if="!panel.collapsed">
            <button class="hbtn" title="在左侧 / 右侧 / 底部之间切换" @click="cycleDock(panel.id)">⇄</button>
            <button class="hbtn" title="浮动" @click="toggleFloat(panel.id)">▣</button>
          </template>
        </header>
        <div v-show="!panel.collapsed" class="dock-body">
          <component :is="PANEL_COMPONENTS[panel.id]" />
        </div>
        <div v-if="!panel.collapsed" class="resize-handle horizontal" @mousedown="startDockResize($event, panel.id)" />
      </div>
    </div>

    <!-- 浮动面板层 -->
    <div class="float-layer">
      <div
        v-for="panel in floating"
        :key="panel.id"
        class="float-panel"
        :class="{ active: dragState?.id === panel.id }"
        :style="{ left: `${panel.float.x}px`, top: `${panel.float.y}px`, width: `${panel.float.width}px`, height: `${panel.float.height}px` }"
      >
        <header class="float-header" @mousedown="startFloatDrag($event, panel.id)" @dblclick="toggleFloat(panel.id)">
          <span class="title">{{ panel.title }}</span>
          <span class="spacer" />
          <button class="hbtn" title="停靠到左侧" @mousedown.stop @click="dock(panel.id, 'left')">◧</button>
          <button class="hbtn" title="停靠到右侧" @mousedown.stop @click="dock(panel.id, 'right')">◨</button>
          <button class="hbtn" title="停靠到底部" @mousedown.stop @click="dock(panel.id, 'bottom')">▤</button>
        </header>
        <div class="float-body">
          <component :is="PANEL_COMPONENTS[panel.id]" />
        </div>
        <div class="float-resize" @mousedown="startResize($event, panel.id)" />
      </div>
    </div>

    <!-- 停靠提示 -->
    <div v-if="dockHint === 'left'" class="dock-hint left" />
    <div v-if="dockHint === 'right'" class="dock-hint right" />
    <div v-if="dockHint === 'bottom'" class="dock-hint bottom" />
  </div>
</template>

<style scoped>
.dock-layout {
  flex: 1;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  grid-template-areas: "left center right" "bottom bottom bottom";
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  position: relative;
}
.dock {
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--cmp-panel);
}
.dock-left { grid-area: left; border-right: 1px solid var(--cmp-border); }
.dock-right { grid-area: right; border-left: 1px solid var(--cmp-border); }
.dock-left, .dock-right { flex-direction: column; }
.dock-bottom {
  grid-area: bottom;
  border-top: 1px solid var(--cmp-border);
  max-height: 30vh;
}
.dock-center {
  grid-area: center;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.dock-panel + .dock-panel { border-top: 1px solid var(--cmp-border); }
.dock-right .resize-handle { left: 0; right: auto; }
.dock-bottom .dock-panel { flex: 1 1 0; min-width: 0; max-height: 30vh; }
.dock-bottom .resize-handle.horizontal { top: 0; bottom: auto; }

.dock-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.dock-panel.horizontal {
  width: 100%;
}

.dock-header,
.float-header {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 4px;
  background: var(--cmp-header);
  border-bottom: 1px solid var(--cmp-border);
  font-size: 11px;
  color: var(--cmp-text-dim);
  user-select: none;
  flex: none;
}

.float-header {
  height: 28px;
  cursor: move;
}

.dock-header .title,
.float-header .title {
  color: var(--cmp-text);
}

.spacer {
  flex: 1;
}

.chev,
.hbtn {
  background: transparent;
  border: none;
  color: var(--cmp-text-dim);
  cursor: pointer;
  padding: 0 4px;
  font-size: 11px;
}

.chev:hover,
.hbtn:hover {
  color: #fff;
}

.dock-body {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

.dock-panel.collapsed .dock-body {
  display: none;
}

/* 停靠面板的厚度拖动条 */
.resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  width: 4px;
  cursor: ew-resize;
  background: transparent;
}

.resize-handle:hover {
  background: #38bdf8;
}

.resize-handle.horizontal {
  top: auto;
  left: 0;
  right: 0;
  bottom: 0;
  width: auto;
  height: 4px;
  cursor: ns-resize;
}

/* 浮动面板 */
.float-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2000;
}

.float-panel {
  position: absolute;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  background: var(--cmp-panel);
  border: 1px solid #4a4a4a;
  border-radius: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.float-panel.active {
  border-color: #38bdf8;
}

.float-body {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

.float-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 12px;
  height: 12px;
  cursor: nwse-resize;
  background: linear-gradient(135deg, transparent 50%, #666 50%);
}

/* 停靠提示 */
.dock-hint {
  position: fixed;
  background: rgba(56, 189, 248, 0.18);
  border: 2px solid #38bdf8;
  border-radius: 4px;
  pointer-events: none;
  z-index: 3000;
}

.dock-hint.left {
  left: 4px;
  top: 4px;
  bottom: 4px;
  width: 220px;
}

.dock-hint.right {
  right: 4px;
  top: 4px;
  bottom: 4px;
  width: 220px;
}

.dock-hint.bottom {
  left: 4px;
  right: 4px;
  bottom: 4px;
  height: 140px;
}
</style>
