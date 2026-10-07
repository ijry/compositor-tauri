<script setup lang="ts">
/**
 * 图层面板
 * ---------------------------------------------------------------
 * - 缩略图、可见性、编组展开、双击重命名、右键菜单；
 * - 拖拽排序：拖到行的上/下边缘插入，拖到组的中部嵌套进组，
 *   拖到列表空白处移动到根层最底部，Option(⌥) 拖拽复制；
 * - 拖到收起的组中部会自动展开，便于继续放入子图层。
 */
import { computed, ref } from 'vue';
import { api, commands, currentDocument, thumbnailTick } from '@/composables/useEditor';
import { renderLayerThumbnail } from '@/core/engine/compositor';
import type { Layer } from '@/types/document';

/** 缩略图缓存（按图层 id + 内容版本） */
const cache = new Map<string, string>();

interface Row {
  layer: Layer;
  depth: number;
}

/** 图层树（自顶向下） */
const rows = computed<Row[]>(() => {
  void thumbnailTick();
  const document = currentDocument.value;
  if (!document) return [];
  const result: Row[] = [];
  const walk = (parentId: string | null, depth: number): void => {
    const children = document.layers.filter((layer) => (layer.parentId ?? null) === parentId);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const layer = children[i]!;
      result.push({ layer, depth });
      if (layer.kind === 'group' && layer.expanded) walk(layer.id, depth + 1);
    }
  };
  walk(null, 0);
  return result;
});

/** 缩略图 */
function thumbnail(layer: Layer): string {
  const key = `${layer.id}:${layer.contentKey}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const buffer = renderLayerThumbnail(layer, 40);
  const canvas = document.createElement('canvas');
  canvas.width = buffer.width;
  canvas.height = buffer.height;
  canvas.getContext('2d')!.putImageData(new ImageData(buffer.data, buffer.width, buffer.height), 0, 0);
  const url = canvas.toDataURL('image/png');
  cache.set(key, url);
  if (cache.size > 300) cache.clear();
  return url;
}

const renaming = ref<string | null>(null);
const renameText = ref('');
const selectedIds = ref<string[]>([]);

/** 选中图层（支持 ⇧/⌃ 多选） */
function select(layer: Layer, event: MouseEvent): void {
  const document = currentDocument.value;
  if (!document) return;
  if (event.shiftKey || event.ctrlKey || event.metaKey) {
    const index = selectedIds.value.indexOf(layer.id);
    if (index >= 0) selectedIds.value = selectedIds.value.filter((id) => id !== layer.id);
    else selectedIds.value = [...selectedIds.value, layer.id];
    document.activeLayerId = layer.id;
  } else {
    selectedIds.value = [layer.id];
    document.activeLayerId = layer.id;
  }
  api.invalidate();
}

/** 批量操作：删除 / 编组 */
function runOnSelection(command: string): void {
  const document = currentDocument.value;
  if (!document) return;
  const ids = selectedIds.value.length > 0 ? selectedIds.value : document.layers.map((item) => item.id);
  commands.run(command, ids);
}

/** 双击重命名 */
function startRename(layer: Layer): void {
  renaming.value = layer.id;
  renameText.value = layer.name;
}

function commitRename(layer: Layer): void {
  layer.name = renameText.value.trim() || layer.name;
  renaming.value = null;
  api.invalidate();
}

/* ------------------------------ 拖拽排序 ------------------------------ */

/** 拖拽状态 */
const dragging = ref<{ ids: string[]; duplicate: boolean } | null>(null);
/** 拖拽悬停目标 */
const dropTarget = ref<{ id: string | null; position: 'above' | 'below' | 'inside' } | null>(null);
/** 悬停展开计时器 */
let expandTimer: number | null = null;

/** 行高（用于计算落点） */
const ROW_HEIGHT = 44;

/** 开始拖拽 */
function onDragStart(event: DragEvent, layer: Layer): void {
  const document = currentDocument.value;
  if (!document || renaming.value) {
    event.preventDefault();
    return;
  }
  let ids = selectedIds.value.includes(layer.id) ? [...selectedIds.value] : [layer.id];
  if (!selectedIds.value.includes(layer.id)) ids = [layer.id];
  selectedIds.value = ids;
  document.activeLayerId = layer.id;
  // ⌥（macOS Option / Windows Alt）拖拽 = 复制
  const duplicate = event.altKey;
  dragging.value = { ids, duplicate };
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = duplicate ? 'copy' : 'move';
    event.dataTransfer.setData('text/plain', ids.join(','));
  }
}

/** 拖到某一行上：判断插入位置 */
function onDragOver(event: DragEvent, layer: Layer): void {
  if (!dragging.value) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const offset = event.clientY - rect.top;
  const isGroup = layer.kind === 'group';
  // 组的中间 60% 视为「放入组内」
  const inside = isGroup && offset > rect.height * 0.25 && offset < rect.height * 0.75;
  const position = inside ? 'inside' : (offset < rect.height / 2 ? 'above' : 'below');
  dropTarget.value = { id: layer.id, position };
  // 悬停在收起的组上时自动展开
  if (isGroup && !layer.expanded) {
    if (expandTimer !== null) window.clearTimeout(expandTimer);
    expandTimer = window.setTimeout(() => {
      layer.expanded = true;
      api.invalidate();
    }, 600);
  } else if (expandTimer !== null) {
    window.clearTimeout(expandTimer);
    expandTimer = null;
  }
}

/** 离开某一行 */
function onDragLeave(event: DragEvent): void {
  const related = event.relatedTarget as Node | null;
  if (related && (event.currentTarget as HTMLElement).contains(related)) return;
  if (expandTimer !== null) {
    window.clearTimeout(expandTimer);
    expandTimer = null;
  }
  dropTarget.value = null;
}

/** 放置 */
function onDrop(event: DragEvent, referenceId: string | null): void {
  if (!dragging.value) return;
  const target = dropTarget.value;
  const position = referenceId === null ? 'below' : (target?.id === referenceId ? target.position : 'below');
  commands.run('moveLayerTo', {
    ids: dragging.value.ids,
    referenceId,
    position,
    duplicate: dragging.value.duplicate,
  });
  dragging.value = null;
  dropTarget.value = null;
  if (expandTimer !== null) {
    window.clearTimeout(expandTimer);
    expandTimer = null;
  }
}

/** 拖拽结束（兜底清理） */
function onDragEnd(): void {
  dragging.value = null;
  dropTarget.value = null;
  if (expandTimer !== null) {
    window.clearTimeout(expandTimer);
    expandTimer = null;
  }
}

/** 是否正在被拖拽 */
function isDragging(layer: Layer): boolean {
  return dragging.value?.ids.includes(layer.id) ?? false;
}
</script>

<template>
  <div class="layers-panel">
    <div class="panel-bar">
      <el-button size="small" text @click="commands.run('newLayer')">新建</el-button>
      <el-button size="small" text @click="commands.run('duplicateLayer')">复制</el-button>
      <el-button size="small" text @click="runOnSelection('group')">编组</el-button>
      <el-button size="small" text @click="commands.run('mergeDown')">合并</el-button>
      <el-button size="small" text @click="runOnSelection('deleteLayer')">删除</el-button>
    </div>
    <div
      class="layer-list"
      :class="{ 'drop-root': dragging !== null && dropTarget?.id === null }"
      @dragover.prevent
      @drop.prevent="onDrop($event, null)"
    >
      <div
        v-for="row in rows"
        :key="row.layer.id"
        class="layer-row"
        :class="{
          active: currentDocument?.activeLayerId === row.layer.id,
          selected: selectedIds.includes(row.layer.id),
          hidden: !row.layer.isVisible,
          clipped: row.layer.clipping,
          dragging: isDragging(row.layer),
          'drop-inside': dropTarget?.id === row.layer.id && dropTarget.position === 'inside',
          'drop-above': dropTarget?.id === row.layer.id && dropTarget.position === 'above',
          'drop-below': dropTarget?.id === row.layer.id && dropTarget.position === 'below',
        }"
        :style="{ paddingLeft: `${4 + row.depth * 14}px` }"
        draggable="true"
        @click="select(row.layer, $event)"
        @dblclick="startRename(row.layer)"
        @dragstart="onDragStart($event, row.layer)"
        @dragover.prevent="onDragOver($event, row.layer)"
        @dragleave="onDragLeave"
        @drop.prevent.stop="onDrop($event, row.layer.id)"
        @dragend="onDragEnd"
      >
        <button class="icon-btn" @click.stop="row.layer.isVisible = !row.layer.isVisible; api.invalidate()">
          {{ row.layer.isVisible ? '👁' : '—' }}
        </button>
        <button v-if="row.layer.kind === 'group'" class="icon-btn" @click.stop="row.layer.expanded = !row.layer.expanded">
          {{ row.layer.expanded ? '▾' : '▸' }}
        </button>
        <img v-else class="thumb" :src="thumbnail(row.layer)" alt="" draggable="false" />
        <el-input
          v-if="renaming === row.layer.id"
          v-model="renameText"
          size="small"
          class="rename"
          @blur="commitRename(row.layer)"
          @keyup.enter="commitRename(row.layer)"
          @click.stop
        />
        <span v-else class="name">{{ row.layer.name }}<span v-if="row.layer.kind === 'group' && !row.layer.name.endsWith('组')" class="kind">组</span></span>
        <span v-if="row.layer.mask" class="badge" title="含图层蒙版" />
        <el-dropdown trigger="click" @command="(cmd: string) => commands.run(cmd)">
          <span class="more" @click.stop>⋯</span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="duplicateLayer">复制图层</el-dropdown-item>
              <el-dropdown-item command="toggleClipping">创建剪贴蒙版</el-dropdown-item>
              <el-dropdown-item command="addMask">添加图层蒙版</el-dropdown-item>
              <el-dropdown-item command="maskFromSelection">从选区生成蒙版</el-dropdown-item>
              <el-dropdown-item command="applyMask">应用蒙版</el-dropdown-item>
              <el-dropdown-item command="deleteMask">删除蒙版</el-dropdown-item>
              <el-dropdown-item command="ungroup" divided>取消编组</el-dropdown-item>
              <el-dropdown-item command="mergeGroup">合并组</el-dropdown-item>
              <el-dropdown-item command="flatten">合并所有图层</el-dropdown-item>
              <el-dropdown-item command="deleteLayer" divided>删除图层</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
      <div v-if="rows.length === 0" class="empty">没有图层，点击「新建」开始</div>
      <div v-if="dragging !== null" class="drop-hint">
        拖到行边缘排序 · 拖到组中部嵌入 · ⌥ 拖拽复制 · 拖到空白处移到最底
      </div>
    </div>
  </div>
</template>

<style scoped>
.layers-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--cmp-panel);
}

.panel-bar {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  gap: 2px;
  padding: 4px;
  border-bottom: 1px solid var(--cmp-border);
}

.panel-bar > .el-button {
  margin-left: 0;
  padding-inline: 8px;
}

.layer-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.layer-list.drop-root {
  box-shadow: inset 0 -3px 0 #38bdf8;
}

.layer-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding-right: 6px;
  cursor: default;
  border-bottom: 1px solid var(--cmp-border-soft);
  user-select: none;
}

.layer-row.active {
  background: var(--cmp-active);
}

.layer-row.selected {
  outline: 1px solid #38bdf8;
  outline-offset: -1px;
}

.layer-row.dragging {
  opacity: 0.45;
}

.layer-row.hidden .name {
  opacity: 0.45;
}

.layer-row.clipped {
  font-style: italic;
}

.layer-row.drop-inside {
  background: #14532d;
  box-shadow: inset 0 0 0 2px #22c55e;
}

.layer-row.drop-above::before,
.layer-row.drop-below::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: #38bdf8;
}

.layer-row.drop-above::before {
  top: -1px;
}

.layer-row.drop-below::after {
  bottom: -1px;
}

.thumb {
  width: 34px;
  height: 34px;
  border: 1px solid var(--cmp-border);
  background: repeating-conic-gradient(#555 0% 25%, #777 0% 50%) 0 0 / 8px 8px;
  object-fit: contain;
}

.badge {
  width: 12px;
  height: 12px;
  border-radius: 2px;
  background: #fff;
}

.name {
  flex: 1;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kind {
  margin-left: 4px;
  font-size: 10px;
  color: #8ab4f8;
}

.rename {
  flex: 1;
}

.icon-btn {
  background: transparent;
  border: none;
  color: var(--cmp-text-dim);
  cursor: pointer;
  font-size: 12px;
  width: 18px;
}

.more {
  color: var(--cmp-text-dim);
  cursor: pointer;
  padding: 0 4px;
}

.drop-hint {
  padding: 6px 8px;
  font-size: 11px;
  color: #8ab4f8;
  border-top: 1px dashed #3a3a3a;
}

.empty {
  padding: 12px;
  color: var(--cmp-text-faint);
  font-size: 12px;
}
</style>
