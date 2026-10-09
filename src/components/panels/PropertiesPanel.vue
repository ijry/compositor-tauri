<script setup lang="ts">
/** 属性面板：变换精确数值、外观、蒙版、图层效果、调整层参数 */
import AdjustmentControls from '@/components/controls/AdjustmentControls.vue';
import EffectControls from '@/components/controls/EffectControls.vue';
import { ADJUSTMENT_LABELS } from '@/core/document';
import { computed } from 'vue';
import { api, commands, currentDocument, thumbnailTick } from '@/composables/useEditor';
import { BLEND_MODE_LABELS, BLEND_MODES, SAMPLING_LABELS, type Layer } from '@/types/document';

const layer = computed<Layer | null>(() => {
  void thumbnailTick();
  const document = currentDocument.value;
  if (!document) return null;
  return document.layers.find((item) => item.id === document.activeLayerId) ?? null;
});

/** 采样方式选项（中文显示） */
const samplingOptions = (Object.keys(SAMPLING_LABELS) as (keyof typeof SAMPLING_LABELS)[]).map((value) => ({ value, label: SAMPLING_LABELS[value] }));

/** 更新图层属性并记录历史 */
function update(label: string, apply: (target: Layer) => void): void {
  const target = layer.value;
  if (!target) return;
  const before = api.snapshotLayer(target.id);
  apply(target);
  target.contentKey += 1;
  const after = api.snapshotLayer(target.id);
  api.pushHistory(label, () => { if (before) api.restoreLayer(target.id, before); }, () => { if (after) api.restoreLayer(target.id, after); }, 256);
  api.invalidate();
}

/** 效果清单（可增删改） */
const effectNames = [
  { key: 'stroke', label: '描边' },
  { key: 'shadow', label: '投影' },
  { key: 'innerShadow', label: '内阴影' },
  { key: 'colorOverlay', label: '颜色叠加' },
  { key: 'outerGlow', label: '外发光' },
  { key: 'innerGlow', label: '内发光' },
] as const;

/** 添加默认效果 */
function addEffect(key: string): void {
  update('添加图层效果', (target) => {
    target.effects = target.effects ?? {};
    const colors: Record<string, [number, number, number]> = {
      stroke: [0, 0, 0], shadow: [0, 0, 0], innerShadow: [0, 0, 0],
      colorOverlay: [255, 0, 0], outerGlow: [255, 255, 0], innerGlow: [255, 255, 0],
    };
    const defaults: Record<string, unknown> = {
      stroke: { enabled: true, size: 3, color: colors.stroke, opacity: 1, inside: false },
      shadow: { enabled: true, angle: 120, distance: 8, blur: 8, color: colors.shadow, opacity: 0.6 },
      innerShadow: { enabled: true, angle: 120, distance: 8, blur: 8, color: colors.innerShadow, opacity: 0.6 },
      colorOverlay: { enabled: true, color: colors.colorOverlay, opacity: 1 },
      outerGlow: { enabled: true, size: 10, color: colors.outerGlow, opacity: 0.8 },
      innerGlow: { enabled: true, size: 10, color: colors.innerGlow, opacity: 0.8 },
    };
    // @ts-expect-error 动态键写入
    target.effects[key] = defaults[key];
  });
}

/** 调整层参数写入 */
function setAdjustment(label: string, apply: (record: NonNullable<Extract<Layer, { kind: 'adjustment' }>['adjustment']>) => void): void {
  const target = layer.value;
  if (!target || target.kind !== 'adjustment' || !target.adjustment) return;
  update(label, () => apply(target.adjustment!));
}
</script>

<template>
  <div class="props">
    <div v-if="!layer" class="empty">未选择图层</div>
    <template v-else>
      <section>
        <h4>变换</h4>
        <div class="grid">
          <label>X <input type="number" :value="Math.round(layer.transform.origin[0])" @change="update('移动图层', (l) => { l.transform.origin[0] = Number(($event.target as HTMLInputElement).value); })" /></label>
          <label>Y <input type="number" :value="Math.round(layer.transform.origin[1])" @change="update('移动图层', (l) => { l.transform.origin[1] = Number(($event.target as HTMLInputElement).value); })" /></label>
          <label>宽 <input type="number" :value="Math.round(layer.transform.size[0])" @change="update('缩放图层', (l) => { l.transform.size[0] = Math.max(1, Number(($event.target as HTMLInputElement).value)); })" /></label>
          <label>高 <input type="number" :value="Math.round(layer.transform.size[1])" @change="update('缩放图层', (l) => { l.transform.size[1] = Math.max(1, Number(($event.target as HTMLInputElement).value)); })" /></label>
          <label>角度 <input type="number" :value="layer.transform.rotation" @change="update('旋转图层', (l) => { l.transform.rotation = Number(($event.target as HTMLInputElement).value); })" /></label>
          <label>采样
            <select :value="layer.transform.sampling" @change="update('采样方式', (l) => { l.transform.sampling = ($event.target as HTMLSelectElement).value as never; })">
              <option v-for="item in samplingOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </label>
        </div>
        <div class="row">
          <el-button size="small" @click="update('水平翻转', (l) => { l.transform.flipX = !l.transform.flipX; })">水平翻转</el-button>
          <el-button size="small" @click="update('垂直翻转', (l) => { l.transform.flipY = !l.transform.flipY; })">垂直翻转</el-button>
          <el-button size="small" @click="update('顺时针旋转 90°', (l) => { l.transform.rotation = (l.transform.rotation + 90) % 360; })">旋转 90°</el-button>
          <el-button size="small" @click="update('清空变换', (l) => { l.transform.rotation = 0; l.transform.flipX = false; l.transform.flipY = false; l.transform.warp = null; })">复位</el-button>
        </div>
      </section>

      <section>
        <h4>外观</h4>
        <div class="row">
          <label class="slider">不透明度 {{ Math.round(layer.opacity * 100) }}%
            <input type="range" min="0" max="100" :value="Math.round(layer.opacity * 100)" @input="update('调整不透明度', (l) => { l.opacity = Number(($event.target as HTMLInputElement).value) / 100; })" />
          </label>
        </div>
        <label class="row">混合模式
          <select :value="layer.blendMode" @change="update('混合模式', (l) => { l.blendMode = ($event.target as HTMLSelectElement).value as never; })">
            <option v-for="mode in BLEND_MODES" :key="mode" :value="mode">{{ BLEND_MODE_LABELS[mode] }}</option>
          </select>
        </label>
        <label class="row"><input type="checkbox" :checked="layer.clipping" @change="commands.run('toggleClipping')" /> 剪贴蒙版</label>
      </section>

      <section v-if="layer.kind === 'adjustment' && layer.adjustment" class="active-adjustment">
        <h4>调整：{{ ADJUSTMENT_LABELS[layer.adjustment.kind] }}</h4>
        <AdjustmentControls :model-value="layer.adjustment" :source="api.composite()" @update:model-value="value=>update('修改调整参数',l=>{l.adjustment=value})"/>
      </section>

      <section>
        <h4>图层蒙版</h4>
        <div v-if="layer.mask" class="row">
          <label><input type="checkbox" :checked="layer.mask.enabled" @change="commands.run('toggleMask')" /> 启用</label>
          <label><input type="checkbox" :checked="layer.mask.linked" @change="update('链接蒙版',l=>{if(l.mask){l.mask.linked=($event.target as HTMLInputElement).checked;if(!l.mask.linked&&!l.mask.placement)l.mask.placement={x:l.transform.origin[0],y:l.transform.origin[1],width:l.transform.size[0],height:l.transform.size[1],rotation:l.transform.rotation,flipX:l.transform.flipX,flipY:l.transform.flipY,sampling:l.transform.sampling}}})"/>链接图像</label>
          <el-button size="small" @click="commands.run('maskTarget')">{{ layer.mask.target === 'mask' ? '编辑图像' : '编辑蒙版' }}</el-button>
          <el-button size="small" @click="commands.run('invertMask')">反相</el-button>
          <el-button size="small" @click="commands.run('applyMask')">应用</el-button>
          <el-button size="small" @click="commands.run('deleteMask')">删除</el-button>
        </div>
        <div v-else class="row">
          <el-button size="small" @click="commands.run('addMask')">添加蒙版</el-button>
          <el-button size="small" @click="commands.run('maskFromSelection')">从选区生成</el-button>
        </div>
      </section>

      <section>
        <h4>图层效果</h4>
        <div class="row">
          <el-select size="small" placeholder="添加效果" @change="addEffect">
            <el-option v-for="item in effectNames" :key="item.key" :label="item.label" :value="item.key" />
          </el-select>
        </div>
        <EffectControls v-if="layer.effects" :model-value="layer.effects" @update:model-value="value=>update('修改图层效果',l=>{l.effects=value})"/>
        <div v-for="item in effectNames" :key="item.key">
          <div v-if="layer.effects && layer.effects[item.key]" class="row">
            <label><input type="checkbox" :checked="layer.effects[item.key]?.enabled !== false" @change="update('切换效果', (l) => { const effect = l.effects?.[item.key]; if (effect) effect.enabled = ($event.target as HTMLInputElement).checked; })" /> {{ item.label }}</label>
            <el-button size="small" text @click="update('删除效果', (l) => { if (l.effects) delete l.effects[item.key]; })">移除</el-button>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.props {
  display:flex;flex-direction:column;
  padding: 6px 8px;
  min-width: 0;
  width: 100%;
  border-bottom: 1px solid var(--cmp-border);
}

section {
  flex-shrink:0;
  margin-bottom: 8px;
}

.active-adjustment{order:-1;}

h4 {
  margin: 0 0 4px;
  font-size: 11px;
  color: #8ab4f8;
}

.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 2px 6px;
}

.row { flex-wrap: wrap; }
.row > .el-button { margin-left: 0; }
.grid label { min-width: 0; }
.grid input, .grid select { min-width: 0; max-width: 100%; }

.grid label,
.row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 2px;
}

input[type='number'],
select {
  width: 74px;
  background: var(--cmp-bg);
  border: 1px solid var(--cmp-border);
  color: var(--cmp-text);
  padding: 1px 4px;
  border-radius: 3px;
}

input[type='range'] {
  flex: 1;
}

.slider {
  width: 100%;
}

.empty,
.hint {
  color: var(--cmp-text-faint);
  font-size: 11px;
}
</style>
