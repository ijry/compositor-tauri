<script setup lang="ts">
/** 工具选项头：随当前工具自动切换，数值标签支持拖拽擦洗（scrub） */
import { computed, ref } from 'vue';
import { api, currentTool } from '@/composables/useEditor';

const scrubbing = ref<{ key: string; startX: number; startValue: number } | null>(null);

/** 当前工具的选项定义与当前值 */
const specs = computed(() => currentTool.value?.specs ?? []);
const values = computed(() => currentTool.value ? (api.toolOptions as Record<string, Record<string, unknown>>)[currentTool.value.id] ?? {} : {});

/** 读取选项值 */
function value(key: string): unknown {
  return values.value[key];
}

/** 写入选项值 */
function setValue(key: string, next: unknown): void {
  api.setToolOption(key, next);
}

/** 数字标签拖拽擦洗 */
function startScrub(event: MouseEvent, key: string): void {
  const spec = specs.value.find((item) => item.key === key);
  if (!spec || spec.type !== 'number') return;
  scrubbing.value = { key, startX: event.clientX, startValue: Number(value(key) ?? 0) };
  const move = (moveEvent: MouseEvent): void => {
    if (!scrubbing.value) return;
    const step = spec.step ?? 1;
    const delta = (moveEvent.clientX - scrubbing.value.startX) * (moveEvent.shiftKey ? 10 : 1) * step;
    const next = Math.max(spec.min ?? -Infinity, Math.min(spec.max ?? Infinity, scrubbing.value.startValue + delta));
    setValue(key, Number(next.toFixed(3)));
  };
  const up = (): void => {
    scrubbing.value = null;
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/** 文本类选项（文字内容）走输入框 */
function isTextOption(key: string): boolean {
  return key === 'content' || key === 'fontName';
}
</script>

<template>
  <div class="cmp-tool-header">
    <span class="tool-name">{{ currentTool?.name }}</span>
    <template v-for="spec in specs" :key="spec.key">
      <label class="option">
        <span class="label">{{ spec.label }}</span>
        <el-select
          v-if="spec.type === 'select' && !isTextOption(spec.key)"
          size="small"
          class="control"
          :model-value="value(spec.key) as string"
          @update:model-value="(v: any) => setValue(spec.key, v)"
        >
          <el-option v-for="item in spec.options" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-select
          v-else-if="spec.type === 'select' && spec.key === 'fontName'"
          size="small"
          class="control wide"
          filterable
          allow-create
          :model-value="value(spec.key) as string"
          @update:model-value="(v: any) => setValue(spec.key, v)"
        >
          <el-option v-for="font in ['PingFang SC', 'Microsoft YaHei', 'SimHei', 'SimSun', 'Arial', 'Helvetica', 'Times New Roman', 'Courier New']" :key="font" :label="font" :value="font" />
        </el-select>
        <el-input
          v-else-if="isTextOption(spec.key)"
          size="small"
          class="control wide"
          :model-value="value(spec.key) as string"
          @update:model-value="(v: any) => setValue(spec.key, v)"
        />
        <div v-else-if="spec.type === 'number'" class="number-wrap">
          <input
            class="scrub"
            type="number"
            :min="spec.min"
            :max="spec.max"
            :step="spec.step ?? 1"
            :value="Number(value(spec.key) ?? 0)"
            @mousedown="startScrub($event, spec.key)"
            @input="(e: any) => setValue(spec.key, Number(e.target.value))"
          />
          <span v-if="spec.unit" class="unit">{{ spec.unit }}</span>
        </div>
        <el-checkbox
          v-else-if="spec.type === 'boolean'"
          size="small"
          :model-value="Boolean(value(spec.key))"
          @update:model-value="(v: any) => setValue(spec.key, v)"
        />
      </label>
    </template>
  </div>
</template>

<style scoped>
.cmp-tool-header {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 34px;
  padding: 0 10px;
  background: #2b2b2c;
  border-bottom: 1px solid #3a3a3a;
  font-size: 12px;
  overflow-x: auto;
  white-space: nowrap;
}

.tool-name {
  color: #8ab4f8;
  font-weight: 600;
}

.option {
  display: flex;
  align-items: center;
  gap: 4px;
}

.label {
  color: #9d9d9d;
}

.control {
  width: 96px;
}

.control.wide {
  width: 160px;
}

.number-wrap {
  display: flex;
  align-items: center;
  gap: 2px;
}

.scrub {
  width: 62px;
  height: 22px;
  background: #1e1e1e;
  border: 1px solid #444;
  color: #e5e5e5;
  padding: 0 4px;
  border-radius: 3px;
  cursor: ew-resize;
}

.unit {
  color: #9d9d9d;
}
</style>
