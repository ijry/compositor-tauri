<script setup lang="ts">
/** 历史 / 颜色 / 信息面板 */
import { computed, ref } from 'vue';
import { api, commands, currentDocument, currentHistory, historyTick } from '@/composables/useEditor';
import { toHex } from '@/core/color';

const tick = computed(() => historyTick());
const entries = computed(() => {
  void tick.value;
  return currentHistory()?.list() ?? [];
});
const position = computed(() => {
  void tick.value;
  return currentHistory()?.position ?? -1;
});

const hex = ref(toHex(...api.foreground));
/** 应用十六进制前景色 */
function applyHex(value: string): void {
  const clean = value.replace('#', '').trim();
  if (clean.length !== 6) return;
  const value2 = Number.parseInt(clean, 16);
  if (Number.isNaN(value2)) return;
  api.setForeground([(value2 >> 16) & 255, (value2 >> 8) & 255, value2 & 255]);
  hex.value = toHex(...api.foreground).toUpperCase();
}

/** 文档统计 */
const stats = computed(() => {
  void tick.value;
  const document = currentDocument.value;
  if (!document) return '';
  let bytes = 0;
  for (const layer of document.layers) {
    if (layer.pixels) bytes += layer.pixels.data.length;
    if (layer.mask) bytes += layer.mask.pixels.data.length;
  }
  return `${document.width} × ${document.height} 像素 · ${document.layers.length} 个图层 · 约 ${(bytes / 1048576).toFixed(1)} MB`;
});
</script>

<template>
  <div class="side-panels">
    <div class="block">
      <h4>历史记录</h4>
      <div class="history">
        <button
          v-for="(entry, index) in entries"
          :key="index"
          class="entry"
          :class="{ current: index === position }"
          @click="index < position ? commands.run('undo') : commands.run('redo')"
        >
          {{ entry.label }}
        </button>
        <div v-if="entries.length === 0" class="hint">还没有可撤销的操作</div>
      </div>
    </div>
    <div class="block">
      <h4>颜色</h4>
      <div class="row">
        <span class="chip fg" :style="{ background: `rgb(${api.foreground.join(',')})` }" />
        <el-input size="small" v-model="hex" style="width: 92px" @change="applyHex" @blur="applyHex" />
        <span class="chip bg" :style="{ background: `rgb(${api.background.join(',')})` }" />
        <el-button size="small" text @click="api.setForeground(api.background); api.setBackground([0, 0, 0])">交换 (X)</el-button>
      </div>
    </div>
    <div class="block">
      <h4>文档信息</h4>
      <p class="hint">{{ stats }}</p>
    </div>
  </div>
</template>

<style scoped>
.side-panels {
  container-type: inline-size;
  padding: 6px 8px;
}

.block {
  margin-bottom: 10px;
}

h4 {
  margin: 0 0 4px;
  font-size: 11px;
  color: #8ab4f8;
}

.history {
  max-height: 120px;
  overflow-y: auto;
  border: 1px solid var(--cmp-border);
}

.entry {
  display: block;
  width: 100%;
  text-align: left;
  padding: 3px 6px;
  background: transparent;
  border: none;
  color: var(--cmp-text);
  cursor: pointer;
}

.entry.current {
  background: var(--cmp-active);
  color: #fff;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.chip {
  width: 18px;
  height: 18px;
  border: 1px solid var(--cmp-border);
  display: inline-block;
}

.hint {
  color: var(--cmp-text-faint);
  font-size: 11px;
  margin: 0;
}
/* 底部停靠时横向分栏，浮动或侧边停靠时保持纵向布局。 */
@container (min-width: 560px) {
  .block { display: inline-block; vertical-align: top; width: 32%; padding-right: 16px; }
  .history { max-height: 92px; }
}
</style>
