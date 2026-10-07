<script setup lang="ts">
/**
 * 画布舞台
 * ---------------------------------------------------------------
 * 两层画布：底层渲染文档合成结果，上层绘制参考线、网格、选区蚂蚁线与工具覆盖层。
 * 指针事件统一换算成文档坐标后交给当前工具处理。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api, currentDocument, currentTool, dispatchPointer, getStageSize, fitCanvas, invalidate, registerStage, uiState } from '@/composables/useEditor';
import { drawSelectionAnts } from '@/tools/selection';
import { drawTransformControls } from '@/tools/transform';
import { drawBrushCursor } from '@/tools/paint';
import InlineTextEditor from '@/components/InlineTextEditor.vue';
import { CanvasRenderer } from '@/core/engine/renderer';
import type { ToolPointerEvent } from '@/tools/types';

const host = ref<HTMLDivElement | null>(null);
const mainCanvas = ref<HTMLCanvasElement | null>(null);
const overlay = ref<HTMLCanvasElement | null>(null);
const size = ref({ width: 1200, height: 800 });
const cursorStyle = ref('default');
let raf = 0;
let spaceDown = false;
let temporaryHand = false;
/** 参考线拖拽 */
let guideDrag: { axis: 'horizontal' | 'vertical'; position: number; offset: number } | null = null;

/** 触发重绘 */
function scheduleRender(): void {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    render();
  });
}

/** 渲染两层画布 */
function render(): void {
  const document = currentDocument.value;
  const canvas = mainCanvas.value;
  if (!canvas || !document) return;
  if (!stageRenderer) {
    stageRenderer = new CanvasRenderer(canvas);
    registerStage(canvas, size.value, stageRenderer);
  }
  stageRenderer.render(document, api.viewport, {
    width: size.value.width,
    height: size.value.height,
    devicePixelRatio: window.devicePixelRatio || 1,
    showPixelGrid: true,
  });
  const overlayCanvas = overlay.value;
  if (!overlayCanvas) return;
  const dpr = window.devicePixelRatio || 1;
  overlayCanvas.width = Math.round(size.value.width * dpr);
  overlayCanvas.height = Math.round(size.value.height * dpr);
  const ctx = overlayCanvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size.value.width, size.value.height);
  drawGridAndGuides(ctx);
  if (api.ui.selection && document.selection) drawSelectionAnts({ ctx, editor: api, viewport: api.viewport, width: size.value.width, height: size.value.height, toScreen: api.toScreen, toDoc: api.toDoc });
  const tool = currentTool.value;
  if (tool?.drawOverlay) {
    tool.drawOverlay({ ctx, editor: api, viewport: api.viewport, width: size.value.width, height: size.value.height, toScreen: api.toScreen, toDoc: api.toDoc });
  }
  if (['brush', 'eraser', 'healing', 'clone', 'blur', 'smudge', 'liquify'].includes(api.toolId)) {
    drawBrushCursor({ ctx, editor: api, toScreen: api.toScreen });
  }
  if (api.toolId === 'move') drawTransformControls({ ctx, editor: api, viewport: api.viewport, width: size.value.width, height: size.value.height, toScreen: api.toScreen, toDoc: api.toDoc });
}

/** 渲染器实例 */
let stageRenderer: CanvasRenderer | null = null;


/** 绘制网格与参考线 */
function drawGridAndGuides(ctx: CanvasRenderingContext2D): void {
  const document = currentDocument.value;
  if (!document) return;
  const zoom = api.viewport.zoom;
  const viewport = api.viewport;
  const origin = api.toScreen({ x: 0, y: 0 });
  // 网格
  if (document.grid.enabled && uiState.grid) {
    const spacing = Math.max(4, document.grid.spacing) * zoom;
    if (spacing >= 4) {
      ctx.save();
      ctx.strokeStyle = document.grid.color;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= document.width; x += document.grid.spacing) {
        const sx = origin.x + x * zoom;
        if (sx < 0 || sx > size.value.width) continue;
        ctx.moveTo(Math.round(sx) + 0.5, origin.y);
        ctx.lineTo(Math.round(sx) + 0.5, origin.y + document.height * zoom);
      }
      for (let y = 0; y <= document.height; y += document.grid.spacing) {
        const sy = origin.y + y * zoom;
        if (sy < 0 || sy > size.value.height) continue;
        ctx.moveTo(origin.x, Math.round(sy) + 0.5);
        ctx.lineTo(origin.x + document.width * zoom, Math.round(sy) + 0.5);
      }
      ctx.stroke();
      ctx.restore();
    }
  }
  // 参考线
  if (uiState.guides) {
    ctx.save();
    for (const guide of document.guides) {
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (guide.axis === 'vertical') {
        const sx = origin.x + guide.position * zoom;
        ctx.moveTo(Math.round(sx) + 0.5, 0);
        ctx.lineTo(Math.round(sx) + 0.5, size.value.height);
      } else {
        const sy = origin.y + guide.position * zoom;
        ctx.moveTo(0, Math.round(sy) + 0.5);
        ctx.lineTo(size.value.width, Math.round(sy) + 0.5);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  void viewport;
}

/** 指针事件 -> 工具事件 */
function toToolEvent(event: PointerEvent | MouseEvent): ToolPointerEvent {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  const doc = api.toDoc(screen);
  return {
    doc,
    screen,
    shift: event.shiftKey,
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    button: event.button,
    pressure: 'pressure' in event ? (event as PointerEvent).pressure || 1 : 1,
  };
}

/** 指针按下 */
function onPointerDown(event: PointerEvent): void {
  if (api.toolId === 'type') event.preventDefault();
  const element = event.currentTarget as HTMLElement;
  element.setPointerCapture(event.pointerId);
  // 中键或按住空格 -> 平移
  if (event.button === 1 || temporaryHand) {
    panState.active = true;
    panState.start = { x: event.clientX, y: event.clientY };
    panState.center = { x: api.viewport.centerX, y: api.viewport.centerY };
    return;
  }
  if (event.button !== 0) return;
  // 标尺上按下 -> 拖出参考线
  const rulerHit = hitRuler(event);
  if (rulerHit) {
    const document = currentDocument.value;
    if (!document) return;
    guideDrag = { axis: rulerHit.axis, position: rulerHit.axis === 'vertical' ? api.toDoc({ x: event.clientX - element.getBoundingClientRect().left, y: 0 }).x : api.toDoc({ x: 0, y: event.clientY - element.getBoundingClientRect().top }).y, offset: 0 };
    document.guides.push({ id: `guide-${Date.now().toString(36)}`, axis: guideDrag.axis, position: guideDrag.position });
    invalidate();
    return;
  }
  dispatchPointer('down', toToolEvent(event));
}

/** 指针移动 */
function onPointerMove(event: PointerEvent): void {
  if (panState.active) {
    const zoom = api.viewport.zoom;
    api.setViewport({
      centerX: panState.center.x - (event.clientX - panState.start.x) / zoom,
      centerY: panState.center.y - (event.clientY - panState.start.y) / zoom,
    });
    return;
  }
  if (guideDrag) {
    const element = event.currentTarget as HTMLElement;
    const rect = element.getBoundingClientRect();
    const position = guideDrag.axis === 'vertical'
      ? api.toDoc({ x: event.clientX - rect.left, y: 0 }).x
      : api.toDoc({ x: 0, y: event.clientY - rect.top }).y;
    const document = currentDocument.value;
    if (document) {
      const guide = document.guides[document.guides.length - 1];
      if (guide) guide.position = Math.round(position);
      invalidate();
    }
    return;
  }
  dispatchPointer('move', toToolEvent(event));
}

/** 指针抬起 */
function onPointerUp(event: PointerEvent): void {
  if (panState.active) {
    panState.active = false;
    return;
  }
  if (guideDrag) {
    guideDrag = null;
    return;
  }
  dispatchPointer('up', toToolEvent(event));
}

/** 双击 */
function onDblClick(event: MouseEvent): void {
  dispatchPointer('dblclick', toToolEvent(event));
}

/** 滚轮：⌘/Ctrl + 滚轮缩放，空格 + 滚轮平移 */
function onWheel(event: WheelEvent): void {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    api.setViewport({ zoom: Math.max(0.0033, Math.min(32, api.viewport.zoom * factor)) });
    return;
  }
  if (event.shiftKey) {
    api.setViewport({ centerX: api.viewport.centerX + event.deltaY / api.viewport.zoom });
    return;
  }
  api.setViewport({
    centerX: api.viewport.centerX + event.deltaX / api.viewport.zoom,
    centerY: api.viewport.centerY + event.deltaY / api.viewport.zoom,
  });
}

/** 命中标尺区域 */
function hitRuler(event: PointerEvent): { axis: 'horizontal' | 'vertical' } | null {
  const element = event.currentTarget as HTMLElement;
  const rect = element.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (uiState.rulers) {
    if (y < 18 && x > 18) return { axis: 'horizontal' };
    if (x < 18 && y > 18) return { axis: 'vertical' };
  }
  return null;
}

/** 平移状态 */
const panState = { active: false, start: { x: 0, y: 0 }, center: { x: 0, y: 0 } };

/** 尺寸同步 */
function syncSize(): void {
  const element = host.value;
  if (!element) return;
  size.value = { width: element.clientWidth, height: element.clientHeight };
  if (mainCanvas.value && !stageRenderer) stageRenderer = new CanvasRenderer(mainCanvas.value);
  registerStage(mainCanvas.value, size.value, stageRenderer ?? undefined);
  scheduleRender();
}

/** 全局按键：空格临时抓手 */
function onKeyDown(event: KeyboardEvent): void {
  if (event.code === 'Space' && !(event.target as HTMLElement)?.matches?.('input,textarea')) {
    spaceDown = true;
    temporaryHand = true;
    cursorStyle.value = 'grab';
  }
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.code === 'Space') {
    spaceDown = false;
    temporaryHand = false;
    cursorStyle.value = currentTool.value?.cursor ?? 'default';
  }
}

onMounted(() => {
  syncSize();
  // 首次挂载前默认舞台尺寸尚未更新，须在真实布局就绪后适配。
  fitCanvas();
  const observer = new ResizeObserver(syncSize);
  if (host.value) observer.observe(host.value);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  const timer = window.setInterval(scheduleRender, 120);
  onBeforeUnmount(() => {
    observer.disconnect();
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.clearInterval(timer);
  });
});

watch(() => currentDocument.value?.updatedAt, scheduleRender);
watch(() => api.toolId, () => {
  cursorStyle.value = currentTool.value?.cursor ?? 'default';
  scheduleRender();
});
watch(() => size.value.width, scheduleRender);
void spaceDown;
void getStageSize;
</script>

<template>
  <div
    ref="host"
    class="cmp-stage"
    :style="{ cursor: cursorStyle }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointerleave="onPointerUp"
    @dblclick="onDblClick"
    @wheel="onWheel"
    @contextmenu.prevent
  >
    <canvas ref="mainCanvas" class="layer main" />
    <canvas ref="overlay" class="layer overlay" />
    <InlineTextEditor />
    <!-- 标尺 -->
    <template v-if="uiState.rulers">
      <div class="ruler-corner" />
      <div class="ruler ruler-top"><canvas ref="rulerTop" class="ruler-canvas" /></div>
      <div class="ruler ruler-left"><canvas ref="rulerLeft" class="ruler-canvas" /></div>
    </template>
  </div>
</template>

<style scoped>
.cmp-stage {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  position: relative;
  width: 100%;
  height: auto;
  overflow: hidden;
  background: var(--cmp-canvas);
  touch-action: none;
}

.layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.overlay {
  pointer-events: none;
}

.ruler {
  position: absolute;
  background: var(--cmp-panel);
  border: 1px solid var(--cmp-border);
}

.ruler-top {
  left: 18px;
  top: 0;
  right: 0;
  height: 18px;
}

.ruler-left {
  left: 0;
  top: 18px;
  bottom: 0;
  width: 18px;
}

.ruler-canvas {
  width: 100%;
  height: 100%;
}

.ruler-corner {
  position: absolute;
  left: 0;
  top: 0;
  width: 18px;
  height: 18px;
  background: var(--cmp-panel);
  border: 1px solid var(--cmp-border);
  z-index: 2;
}
</style>
