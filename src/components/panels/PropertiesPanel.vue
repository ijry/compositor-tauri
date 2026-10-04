<script setup lang="ts">
/** 属性面板：变换精确数值、外观、蒙版、图层效果、调整层参数 */
import { computed } from 'vue';
import { api, commands, currentDocument, thumbnailTick } from '@/composables/useEditor';
import { BLEND_MODES, type Layer } from '@/types/document';

const layer = computed<Layer | null>(() => {
  void thumbnailTick();
  const document = currentDocument.value;
  if (!document) return null;
  return document.layers.find((item) => item.id === document.activeLayerId) ?? null;
});

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
              <option value="High quality">高质量</option>
              <option value="Smooth">平滑</option>
              <option value="Nearest">邻近</option>
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
            <option v-for="mode in BLEND_MODES" :key="mode" :value="mode">{{ mode }}</option>
          </select>
        </label>
        <label class="row"><input type="checkbox" :checked="layer.clipping" @change="commands.run('toggleClipping')" /> 剪贴蒙版</label>
      </section>

      <section v-if="layer.kind === 'adjustment' && layer.adjustment">
        <h4>调整：{{ layer.adjustment.kind }}</h4>
        <template v-if="layer.adjustment.kind === 'Hue/Saturation'">
          <label class="row">色相 <input type="range" min="-180" max="180" :value="layer.adjustment.hue" @input="setAdjustment('色相', (a) => { a.hue = Number(($event.target as HTMLInputElement).value); })" /></label>
          <label class="row">饱和度 <input type="range" min="-100" max="100" :value="layer.adjustment.saturation" @input="setAdjustment('饱和度', (a) => { a.saturation = Number(($event.target as HTMLInputElement).value); })" /></label>
          <label class="row">明度 <input type="range" min="-100" max="100" :value="layer.adjustment.lightness" @input="setAdjustment('明度', (a) => { a.lightness = Number(($event.target as HTMLInputElement).value); })" /></label>
        </template>
        <template v-else-if="layer.adjustment.kind === 'Exposure'">
          <label class="row">曝光 <input type="range" min="-5" max="5" step="0.05" :value="layer.adjustment.exposureSettings.exposure" @input="setAdjustment('曝光度', (a) => { a.exposureSettings.exposure = Number(($event.target as HTMLInputElement).value); })" /></label>
          <label class="row">偏移 <input type="range" min="-0.5" max="0.5" step="0.01" :value="layer.adjustment.exposureSettings.offset" @input="setAdjustment('偏移', (a) => { a.exposureSettings.offset = Number(($event.target as HTMLInputElement).value); })" /></label>
        </template>
        <template v-else-if="layer.adjustment.kind === 'Gaussian Blur'">
          <label class="row">半径 <input type="range" min="0.1" max="250" step="0.5" :value="layer.adjustment.blurRadius" @input="setAdjustment('模糊半径', (a) => { a.blurRadius = Number(($event.target as HTMLInputElement).value); })" /></label>
        </template>
        <template v-else-if="layer.adjustment.kind === 'Motion Blur'">
          <label class="row">角度 <input type="range" min="-90" max="90" :value="layer.adjustment.motionAngle" @input="setAdjustment('模糊角度', (a) => { a.motionAngle = Number(($event.target as HTMLInputElement).value); })" /></label>
          <label class="row">距离 <input type="range" min="1" max="2000" :value="layer.adjustment.motionDistance" @input="setAdjustment('模糊距离', (a) => { a.motionDistance = Number(($event.target as HTMLInputElement).value); })" /></label>
        </template>
        <template v-else-if="layer.adjustment.kind === 'Add Noise'">
          <label class="row">数量 <input type="range" min="0.1" max="400" :value="layer.adjustment.noiseAmount" @input="setAdjustment('杂色数量', (a) => { a.noiseAmount = Number(($event.target as HTMLInputElement).value); })" /></label>
          <label class="row"><input type="checkbox" :checked="layer.adjustment.noiseGaussian" @change="setAdjustment('高斯杂色', (a) => { a.noiseGaussian = ($event.target as HTMLInputElement).checked; })" /> 高斯分布</label>
          <label class="row"><input type="checkbox" :checked="layer.adjustment.noiseMonochromatic" @change="setAdjustment('单色杂色', (a) => { a.noiseMonochromatic = ($event.target as HTMLInputElement).checked; })" /> 单色</label>
        </template>
        <template v-else-if="layer.adjustment.kind === 'Black & White'">
          <label v-for="key in ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas']" :key="key" class="row">{{ key }}
            <input type="range" min="-200" max="300" :value="(layer.adjustment.blackWhiteSettings as never as Record<string, number>)[key]" @input="setAdjustment('黑白权重', (a) => { (a.blackWhiteSettings as never as Record<string, number>)[key] = Number(($event.target as HTMLInputElement).value); })" />
          </label>
        </template>
        <template v-else>
          <p class="hint">该调整类型的完整参数可在 .comp 工程文件中编辑（与上游一致：保存后可在 manifest 中修改）。</p>
        </template>
      </section>

      <section>
        <h4>图层蒙版</h4>
        <div v-if="layer.mask" class="row">
          <label><input type="checkbox" :checked="layer.mask.enabled" @change="commands.run('toggleMask')" /> 启用</label>
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
  padding: 6px 8px;
  overflow-y: auto;
  max-height: 46%;
  border-bottom: 1px solid #3a3a3a;
}

section {
  margin-bottom: 8px;
}

h4 {
  margin: 0 0 4px;
  font-size: 11px;
  color: #8ab4f8;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 6px;
}

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
  background: #1e1e1e;
  border: 1px solid #444;
  color: #e5e5e5;
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
  color: #888;
  font-size: 11px;
}
</style>
