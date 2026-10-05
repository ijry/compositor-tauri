<script setup lang="ts">
/** 对话框宿主：新建画布 / 画布大小 / 图像大小 / 导出 / PSD 报告 / RAW 显影 / 色彩范围 / 网格 / 吸附 / 快捷键 / 关于 / 最近工程 */
import { computed, ref, watch } from 'vue';
import { api, closeDialog, commands, currentDialog, currentDocument, openDialog } from '@/composables/useEditor';
import { defaultRawSettings, RAW_PANEL_GROUPS } from '@/io/raw';
import { formatPsdReport } from '@/io/psd';
import ShortcutDialog from '@/components/dialogs/ShortcutDialog.vue';
import type { CameraRawSettings, RawImage } from '@/types/document';

const name = computed(() => currentDialog.value?.name ?? '');
const visible = computed({
  get: () => Boolean(currentDialog.value),
  set: (value: boolean) => { if (!value) closeDialog(); },
});

/** PSD 转换报告文本 */
const psdReportText = computed(() => {
  const report = (currentDialog.value?.payload as { report: Parameters<typeof formatPsdReport>[0] } | undefined)?.report;
  return report ? formatPsdReport(report) : '';
});

/** 最近工程列表 */
const recentItems = computed<string[]>(() => (currentDialog.value?.payload as { items?: string[] } | undefined)?.items ?? []);
/* 新建画布 */
const newForm = ref({ width: 1920, height: 1080, name: '未命名', resolution: 72 });
/* 画布大小 / 图像大小 */
const canvasForm = ref({ width: 0, height: 0, anchor: 'center' });
const imageForm = ref({ width: 0, height: 0, lock: true });
/* 导出 */
const exportForm = ref({ format: 'png', quality: 0.92, scale: 1 });
/* 色彩范围 */
const rangeForm = ref({ hue: 0, hueRange: 60, saturation: 50, saturationRange: 60, feather: 10 });
/* RAW 显影 */
const rawState = ref<{ layerId: string; raw: RawImage; settings: CameraRawSettings } | null>(null);

/** 打开对话框时准备表单 */
watch(name, (value) => {
  const document = currentDocument.value;
  if (value === 'canvasSize' && document) canvasForm.value = { width: document.width, height: document.height, anchor: 'center' };
  if (value === 'imageSize' && document) imageForm.value = { width: document.width, height: document.height, lock: true };
  if (value === 'rawDevelop') {
    const payload = currentDialog.value?.payload as { layerId: string } | undefined;
    if (payload) {
      const layer = document?.layers.find((item) => item.id === payload.layerId);
      const raw = (layer as unknown as { rawData?: RawImage } | undefined)?.rawData;
      if (raw) rawState.value = { layerId: payload.layerId, raw, settings: { ...raw.settings } };
    }
  }
});

/** 新建画布 */
function submitNew(): void {
  commands.run('newCanvas', newForm.value);
  closeDialog();
}

/** 应用画布大小 */
function submitCanvas(): void {
  commands.run('canvasSize', canvasForm.value);
  closeDialog();
}

/** 应用图像大小 */
function submitImage(): void {
  commands.run('imageSize', imageForm.value);
  closeDialog();
}

/** 导出 */
function submitExport(): void {
  commands.run('exportImage', {
    format: exportForm.value.format,
    quality: exportForm.value.quality,
    scale: exportForm.value.scale,
    background: api.background,
  });
  closeDialog();
}

</script>

<template>
  <el-dialog v-model="visible" :title="name === 'newCanvas' ? '新建画布' : name === 'canvasSize' ? '画布大小' : name === 'imageSize' ? '图像大小' : name === 'rawDevelop' ? '相机 RAW 显影' : name === 'psdReport' ? 'Photoshop 转换报告' : name === 'colorRange' ? '色彩范围' : name === 'gridSettings' ? '网格设置' : name === 'snapSettings' ? '吸附设置' : name === 'shortcuts' ? '键盘快捷键' : name === 'recent' ? '最近工程' : name === 'exportDialog' ? '导出图片' : '关于合成器'"
    width="640px" append-to-body>
    <!-- 新建画布 -->
    <el-form v-if="name === 'newCanvas'" label-width="70px" size="small">
      <el-form-item label="名称"><el-input v-model="newForm.name" /></el-form-item>
      <el-form-item label="宽度"><el-input-number v-model="newForm.width" :min="1" :max="30000" /></el-form-item>
      <el-form-item label="高度"><el-input-number v-model="newForm.height" :min="1" :max="30000" /></el-form-item>
      <el-form-item label="分辨率"><el-input-number v-model="newForm.resolution" :min="1" :max="9600" /></el-form-item>
    </el-form>

    <!-- 画布大小 -->
    <el-form v-else-if="name === 'canvasSize'" label-width="70px" size="small">
      <el-form-item label="宽度"><el-input-number v-model="canvasForm.width" :min="1" :max="30000" @change="canvasForm.height = canvasForm.width" /></el-form-item>
      <el-form-item label="高度"><el-input-number v-model="canvasForm.height" :min="1" :max="30000" /></el-form-item>
      <el-form-item label="定位">
        <el-select v-model="canvasForm.anchor">
          <el-option v-for="anchor in ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right']" :key="anchor" :label="anchor" :value="anchor" />
        </el-select>
      </el-form-item>
    </el-form>

    <!-- 图像大小 -->
    <el-form v-else-if="name === 'imageSize'" label-width="70px" size="small">
      <el-form-item label="宽度"><el-input-number v-model="imageForm.width" :min="1" :max="30000" @change="imageForm.height = imageForm.width" /></el-form-item>
      <el-form-item label="高度"><el-input-number v-model="imageForm.height" :min="1" :max="30000" /></el-form-item>
    </el-form>

    <!-- 导出 -->
    <el-form v-else-if="name === 'exportDialog'" label-width="70px" size="small">
      <el-form-item label="格式">
        <el-select v-model="exportForm.format">
          <el-option label="PNG" value="png" /><el-option label="JPEG" value="jpeg" /><el-option label="WebP" value="webp" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="exportForm.format !== 'png'" label="质量">
        <el-slider v-model="exportForm.quality" :min="0.1" :max="1" :step="0.01" />
      </el-form-item>
      <el-form-item label="缩放"><el-slider v-model="exportForm.scale" :min="0.1" :max="2" :step="0.05" /></el-form-item>
    </el-form>

    <!-- 色彩范围 -->
    <el-form v-else-if="name === 'colorRange'" label-width="80px" size="small">
      <el-form-item label="色相"><el-slider v-model="rangeForm.hue" :min="0" :max="360" /></el-form-item>
      <el-form-item label="色相范围"><el-slider v-model="rangeForm.hueRange" :min="1" :max="180" /></el-form-item>
      <el-form-item label="饱和度"><el-slider v-model="rangeForm.saturation" :min="0" :max="100" /></el-form-item>
      <el-form-item label="饱和度范围"><el-slider v-model="rangeForm.saturationRange" :min="1" :max="100" /></el-form-item>
      <el-form-item label="羽化"><el-slider v-model="rangeForm.feather" :min="0" :max="100" /></el-form-item>
    </el-form>

    <!-- 网格 -->
    <el-form v-else-if="name === 'gridSettings' && currentDocument" label-width="80px" size="small">
      <el-form-item label="启用"><el-switch v-model="currentDocument.grid.enabled" @change="api.invalidate()" /></el-form-item>
      <el-form-item label="间距"><el-input-number v-model="currentDocument.grid.spacing" :min="1" :max="2000" @change="api.invalidate()" /></el-form-item>
      <el-form-item label="细分"><el-input-number v-model="currentDocument.grid.subdivisions" :min="0" :max="10" @change="api.invalidate()" /></el-form-item>
    </el-form>

    <!-- 吸附 -->
    <div v-else-if="name === 'snapSettings' && currentDocument" class="snap">
      <label v-for="key in ['guides', 'grid', 'layers', 'document']" :key="key">
        <input type="checkbox" v-model="currentDocument.snap[key as 'guides']" /> {{ { guides: '参考线', grid: '网格', layers: '图层', document: '文档边界' }[key as 'guides'] }}
      </label>
    </div>

    <!-- RAW 显影 -->
    <div v-else-if="name === 'rawDevelop' && rawState" class="raw">
      <p class="hint">{{ rawState.raw.cameraModel }} · {{ rawState.raw.width }} × {{ rawState.raw.height }}</p>
      <div v-for="group in RAW_PANEL_GROUPS" :key="group.id" class="raw-group">
        <h4>{{ group.label }}</h4>
        <template v-if="group.id === 'light'">
          <label v-for="key in ['exposure', 'highlights', 'shadows', 'whites', 'blacks', 'brightness', 'contrast']" :key="key">{{ key }}
            <input type="range" min="-100" max="100" :value="(rawState.settings as unknown as Record<string, number>)[key]" @input="(rawState.settings as unknown as Record<string, number>)[key] = Number(($event.target as HTMLInputElement).value)" />
          </label>
        </template>
        <template v-else-if="group.id === 'color'">
          <label v-for="key in ['temperature', 'tint', 'vibrance', 'saturation', 'clarity', 'dehaze']" :key="key">{{ key }}
            <input type="range" min="-100" max="100" :value="(rawState.settings as unknown as Record<string, number>)[key]" @input="(rawState.settings as unknown as Record<string, number>)[key] = Number(($event.target as HTMLInputElement).value)" />
          </label>
        </template>
        <template v-else-if="group.id === 'detail'">
          <label v-for="key in ['sharpening', 'detail', 'denoise', 'radius']" :key="key">{{ key }}
            <input type="range" min="0" max="100" :value="(rawState.settings as unknown as Record<string, number>)[key]" @input="(rawState.settings as unknown as Record<string, number>)[key] = Number(($event.target as HTMLInputElement).value)" />
          </label>
        </template>
        <template v-else-if="group.id === 'optics'">
          <label v-for="key in ['removeCA', 'distortion', 'defringe', 'vignette', 'grain']" :key="key">{{ key }}
            <input type="range" min="-100" max="100" :value="(rawState.settings as unknown as Record<string, number>)[key]" @input="(rawState.settings as unknown as Record<string, number>)[key] = Number(($event.target as HTMLInputElement).value)" />
          </label>
        </template>
        <template v-else>
          <p class="hint">该分组参数已实现（见 io/raw.ts 的显影流程）。</p>
        </template>
      </div>
    </div>

    <!-- PSD 报告 -->
    <pre v-else-if="name === 'psdReport'" class="report">{{ psdReportText }}</pre>

    <!-- 快捷键（可重映射） -->
    <ShortcutDialog v-else-if="name === 'shortcuts'" />
    <!-- 最近工程 -->
    <div v-else-if="name === 'recent'" class="recent">
      <div v-for="item in recentItems" :key="item" class="recent-item" @click="commands.run('openRecent', item); closeDialog()">
        {{ item }}
      </div>
      <p v-if="recentItems.length === 0" class="hint">还没有保存过工程</p>
    </div>

    <!-- 关于 -->
    <div v-else class="about">
      <h3>合成器专业版</h3>
      <p>otools 插件版的跨平台图像编辑器，参考 robbietilton/Compositor 复刻实现。</p>
      <p class="hint">支持图层 / 蒙版 / 剪贴蒙版 / 调整层 / 图层效果 / 选区 / 绘画修复 / PSD / .comp 工程 / 相机 RAW。</p>
    </div>

    <template #footer>
      <el-button size="small" @click="closeDialog">关闭</el-button>
      <el-button v-if="name === 'newCanvas'" type="primary" size="small" @click="submitNew">创建</el-button>
      <el-button v-if="name === 'canvasSize'" type="primary" size="small" @click="submitCanvas">确定</el-button>
      <el-button v-if="name === 'imageSize'" type="primary" size="small" @click="submitImage">确定</el-button>
      <el-button v-if="name === 'exportDialog'" type="primary" size="small" @click="submitExport">导出</el-button>
      <el-button v-if="name === 'colorRange'" type="primary" size="small" @click="commands.run('selectColorRange', rangeForm); closeDialog()">确定</el-button>
      <el-button
        v-if="name === 'rawDevelop' && rawState"
        type="primary"
        size="small"
        @click="commands.run('applyRawDevelop', { layerId: rawState.layerId, raw: rawState.raw, settings: rawState.settings }); closeDialog()"
      >应用</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.report,
.hint {
  font-size: 12px;
  color: var(--cmp-text-dim);
  white-space: pre-wrap;
}

.raw-group h4 {
  margin: 6px 0 2px;
  font-size: 12px;
  color: #8ab4f8;
}

.raw-group label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}

.shortcuts {
  max-height: 380px;
  overflow-y: auto;
  columns: 2;
}

.shortcut-row {
  display: flex;
  gap: 8px;
  padding: 1px 0;
  break-inside: avoid;
}

kbd {
  background: var(--cmp-bg);
  border: 1px solid var(--cmp-border);
  border-radius: 3px;
  padding: 0 4px;
  min-width: 108px;
  text-align: center;
}

.recent-item {
  padding: 4px;
  cursor: pointer;
  border-bottom: 1px solid var(--cmp-border-soft);
}

.recent-item:hover {
  background: var(--cmp-border-soft);
}

.about h3 {
  margin: 0 0 6px;
}
</style>
