<script setup lang="ts">
/**
 * 键盘快捷键编辑器
 * ---------------------------------------------------------------
 * 点击快捷键单元格开始录制，按 Enter 确认、Esc 取消；
 * 修改后立即生效并写入宿主本地状态，可单条恢复或全部恢复默认。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import {
  chordFromEvent, chordLabel, groupedShortcuts, isOverridden, resetAllShortcuts, resetShortcut, setShortcut,
  type ShortcutChord,
} from '@/composables/shortcuts';

/** 正在录制的命令 id */
const recording = ref<string | null>(null);
/** 录制中的按键组合 */
const pending = ref<ShortcutChord | null>(null);

const groups = computed(() => groupedShortcuts());

/** 开始录制 */
function startRecording(id: string): void {
  recording.value = id;
  pending.value = null;
}

/** 取消录制 */
function cancelRecording(): void {
  recording.value = null;
  pending.value = null;
}

/** 录制中的按键处理 */
function onKeyDown(event: KeyboardEvent): void {
  if (!recording.value) return;
  // 忽略纯修饰键
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelRecording();
    return;
  }
  if (event.key === 'Enter' && pending.value) {
    event.preventDefault();
    const conflict = setShortcut(recording.value, pending.value);
    if (conflict) ElMessage.warning(`与「${conflict}」冲突，两条命令会同时触发`);
    else ElMessage.success('快捷键已更新');
    cancelRecording();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  pending.value = chordFromEvent(event);
}

/** 单条恢复默认 */
function restore(id: string, title: string): void {
  resetShortcut(id);
  ElMessage.success(`已恢复「${title}」的默认快捷键`);
}

/** 全部恢复默认 */
function restoreAll(): void {
  resetAllShortcuts();
  ElMessage.success('已恢复全部默认快捷键');
}

/** 录制状态下挂载全局监听 */
let attached = false;
function attach(): void {
  if (attached) return;
  window.addEventListener('keydown', onKeyDown, true);
  attached = true;
}
function detach(): void {
  if (!attached) return;
  window.removeEventListener('keydown', onKeyDown, true);
  attached = false;
}

watch(recording, (value) => {
  if (value) attach();
  else detach();
});

onBeforeUnmount(detach);
</script>

<template>
  <div class="shortcut-editor">
    <div class="toolbar">
      <span class="hint">点击「快捷键」列开始录制，按 Enter 确认、Esc 取消</span>
      <el-button size="small" @click="restoreAll">恢复全部默认</el-button>
    </div>
    <div v-for="group in groups" :key="group.group" class="group">
      <h4>{{ group.group }}</h4>
      <div class="row head">
        <span class="col-title">命令</span>
        <span class="col-key">快捷键</span>
        <span class="col-state">状态</span>
        <span class="col-action">操作</span>
      </div>
      <div v-for="item in group.items" :key="item.id" class="row">
        <span class="col-title">{{ item.title }}</span>
        <span class="col-key">
          <el-tag
            :type="recording === item.id ? 'warning' : isOverridden(item.id) ? 'success' : 'info'"
            class="key-tag"
            effect="dark"
            @click="startRecording(item.id)"
          >
            {{ recording === item.id
              ? (pending ? chordLabel(pending) : '按下按键…')
              : chordLabel(item.chord) }}
          </el-tag>
          <span v-if="isOverridden(item.id)" class="default">默认 {{ chordLabel(item.default) }}</span>
        </span>
        <span class="col-state">{{ isOverridden(item.id) ? '已自定义' : '默认' }}</span>
        <span class="col-action">
          <el-button v-if="recording === item.id" size="small" text @click="cancelRecording">取消</el-button>
          <el-button v-else size="small" text @click="startRecording(item.id)">{{ isOverridden(item.id) ? '重录' : '录制' }}</el-button>
          <el-button v-if="isOverridden(item.id) && recording !== item.id" size="small" text @click="restore(item.id, item.title)">恢复</el-button>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shortcut-editor {
  max-height: 420px;
  overflow-y: auto;
  padding-right: 4px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.hint {
  color: #8ab4f8;
  font-size: 11px;
}

.group h4 {
  margin: 8px 0 4px;
  font-size: 12px;
  color: #8ab4f8;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 4px;
  border-bottom: 1px solid var(--cmp-border-soft);
}

.row.head {
  color: var(--cmp-text-faint);
  font-size: 11px;
  border-bottom-color: var(--cmp-border);
}

.col-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-key {
  width: 190px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.col-state {
  width: 56px;
  color: var(--cmp-text-dim);
  font-size: 11px;
}

.col-action {
  width: 48px;
}

.key-tag {
  cursor: pointer;
  min-width: 72px;
  text-align: center;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}

.default {
  color: var(--cmp-text-faint);
  font-size: 10px;
}
</style>
