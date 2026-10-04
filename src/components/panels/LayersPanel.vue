<script setup lang="ts">
/** 图层面板：缩略图、排序、嵌套、组、重命名、右键菜单 */
import { computed, ref } from 'vue';
import { api, commands, currentDocument, thumbnailTick } from '@/composables/useEditor';
import { renderLayerThumbnail } from '@/core/engine/compositor';
import type { Layer } from '@/types/document';

/** 缩略图缓存（按图层 id + 内容版本） */
const cache = new Map<string, string>();

/** 面板需要展示的图层树（自顶向下） */
interface Row {
  layer: Layer;
  depth: number;
}

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

/** 生成/读取缩略图 */
function thumbnail(layer: Layer): string {
  const key = `${layer.id}:${layer.contentKey}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const buffer = renderLayerThumbnail(layer, 40);
  const canvas = document_createCanvas(buffer);
  cache.set(key, canvas);
  if (cache.size > 300) cache.clear();
  return canvas;
}

function document_createCanvas(buffer: { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }): string {
  const canvas = document.createElement('canvas');
  canvas.width = buffer.width;
  canvas.height = buffer.height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(buffer.data, buffer.width, buffer.height), 0, 0);
  return canvas.toDataURL('image/png');
}

const renaming = ref<string | null>(null);
const renameText = ref('');

/** 双击重命名 */
function startRename(layer: Layer): void {
  renaming.value = layer.id;
  renameText.value = layer.name;
}

/** 提交重命名 */
function commitRename(layer: Layer): void {
  layer.name = renameText.value.trim() || layer.name;
  renaming.value = null;
  api.invalidate();
}
</script>

<template>
  <div class="layers-panel">
    <div class="panel-bar">
      <el-button size="small" text @click="commands.run('newLayer')">新建</el-button>
      <el-button size="small" text @click="commands.run('duplicateLayer')">复制</el-button>
      <el-button size="small" text @click="commands.run('group')">编组</el-button>
      <el-button size="small" text @click="commands.run('mergeDown')">合并</el-button>
      <el-button size="small" text @click="commands.run('deleteLayer')">删除</el-button>
    </div>
    <div class="layer-list">
      <div
        v-for="row in rows"
        :key="row.layer.id"
        class="layer-row"
        :class="{ active: currentDocument?.activeLayerId === row.layer.id, hidden: !row.layer.isVisible, clipped: row.layer.clipping }"
        :style="{ paddingLeft: `${4 + row.depth * 14}px` }"
        @click="currentDocument && (currentDocument.activeLayerId = row.layer.id)"
        @dblclick="startRename(row.layer)"
      >
        <button class="icon-btn" @click.stop="row.layer.isVisible = !row.layer.isVisible; api.invalidate()">
          {{ row.layer.isVisible ? '👁' : '—' }}
        </button>
        <button v-if="row.layer.kind === 'group'" class="icon-btn" @click.stop="row.layer.expanded = !row.layer.expanded">
          {{ row.layer.expanded ? '▾' : '▸' }}
        </button>
        <img v-else class="thumb" :src="thumbnail(row.layer)" alt="" />
        <el-input
          v-if="renaming === row.layer.id"
          v-model="renameText"
          size="small"
          class="rename"
          @blur="commitRename(row.layer)"
          @keyup.enter="commitRename(row.layer)"
          @click.stop
        />
        <span v-else class="name">{{ row.layer.name }}</span>
        <span v-if="row.layer.mask" class="badge" title="含图层蒙版" />
        <el-dropdown trigger="click" @command="(cmd: string) => commands.run(cmd)">
          <span class="more">⋯</span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="duplicateLayer">复制图层</el-dropdown-item>
              <el-dropdown-item command="toggleClipping">创建剪贴蒙版</el-dropdown-item>
              <el-dropdown-item command="addMask">添加图层蒙版</el-dropdown-item>
              <el-dropdown-item command="maskFromSelection">从选区生成蒙版</el-dropdown-item>
              <el-dropdown-item command="applyMask">应用蒙版</el-dropdown-item>
              <el-dropdown-item command="deleteMask">删除蒙版</el-dropdown-item>
              <el-dropdown-item command="mergeGroup" divided>合并组</el-dropdown-item>
              <el-dropdown-item command="flatten">合并所有图层</el-dropdown-item>
              <el-dropdown-item command="deleteLayer" divided>删除图层</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
      <div v-if="rows.length === 0" class="empty">没有图层，点击「新建」开始</div>
    </div>
  </div>
</template>

<style scoped>
.layers-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #252526;
}

.panel-bar {
  display: flex;
  gap: 2px;
  padding: 4px;
  border-bottom: 1px solid #3a3a3a;
}

.layer-list {
  flex: 1;
  overflow-y: auto;
}

.layer-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding-right: 6px;
  cursor: pointer;
  border-bottom: 1px solid #303030;
}

.layer-row.active {
  background: #0f4c81;
}

.layer-row.hidden .name {
  opacity: 0.45;
}

.layer-row.clipped {
  font-style: italic;
}

.thumb {
  width: 34px;
  height: 34px;
  border: 1px solid #444;
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

.rename {
  flex: 1;
}

.icon-btn {
  background: transparent;
  border: none;
  color: #bbb;
  cursor: pointer;
  font-size: 12px;
  width: 18px;
}

.more {
  color: #999;
  cursor: pointer;
  padding: 0 4px;
}

.empty {
  padding: 12px;
  color: #777;
  font-size: 12px;
}
</style>
