<script setup lang="ts">
/**
 * 应用外壳
 * ---------------------------------------------------------------
 * 顶部菜单栏 + 工程标签页 + 工具栏 + 工具选项头 + 画布 + 右侧面板 + 状态栏。
 */
import { computed, onMounted, onBeforeUnmount } from 'vue';
import CanvasStage from '@/components/CanvasStage.vue';
import ToolBar from '@/components/ToolBar.vue';
import ToolHeader from '@/components/ToolHeader.vue';
import DockLayout from '@/components/DockLayout.vue';
import StartPage from '@/components/StartPage.vue';
import { initTheme } from '@/composables/useTheme';
import { loadPanelLayout, resetPanels, constrainFloatingPanels } from '@/composables/usePanels';
import FilterDialog from '@/components/dialogs/FilterDialog.vue';
import type { FilterSession } from '@/composables/filterSession';
import CommandPalette from '@/components/dialogs/CommandPalette.vue';
import DialogHost from '@/components/dialogs/DialogHost.vue';
import { api, currentDialog, closeDocument, commands, currentDocument, documents, handleKeyDown, initialize, selectDocument, statusMessage } from '@/composables/useEditor';
import { ADJUSTMENT_LABELS, descendantsOf } from '@/core/document';
import { captureClipboard } from '@/core/clipboard';
import { toHex } from '@/core/color';

/** 菜单定义 */
const menus: { label: string; items: { label?: string; key?: string; divider?: boolean; run?: () => void | Promise<void> }[] }[] = [
  {
    label: '文件',
    items: [
      { label: '新建画布', key: '1', run: () => commands.run('newCanvas') },
      { label: '打开图片…', key: '2', run: () => commands.run('openImage') },
      { label: '导入 Photoshop 文档…', run: () => commands.run('openPsd') },
      { label: '导入相机 RAW…', run: () => commands.run('openRaw') },
      { label: '打开 .comp 工程包…', key: '3', run: () => commands.run('openComp') },
      { label: '最近工程', run: () => commands.run('recentList') },
      { divider: true },
      { label: '示例 · 渐变与文字', run: () => commands.run('sample', 'gradient') },
      { label: '示例 · 图层组与蒙版', run: () => commands.run('sample', 'mask') },
      { label: '示例 · 调整层', run: () => commands.run('sample', 'adjustment') },
      { divider: true },
      { label: '保存工程', key: '4', run: () => commands.run('saveComp') },
      { label: '另存为…', run: () => commands.run('saveCompAs') },
      { label: '监视工程变化（热重载）', run: () => commands.run('watchComp') },
      { divider: true },
      { label: '导出 PNG…', run: () => commands.run('exportImage', { format: 'png', quality: 1, scale: 1, background: [255, 255, 255] }) },
      { label: '导出 JPEG…', run: () => commands.run('exportImage', { format: 'jpeg', quality: 0.92, scale: 1, background: [255, 255, 255] }) },
      { label: '导出 WebP…', run: () => commands.run('exportImage', { format: 'webp', quality: 0.9, scale: 1, background: [255, 255, 255] }) },
      { label: '导出 PSD…', run: () => commands.run('exportPsd') },
      { divider: true },
      { label: '关闭文档', run: () => commands.run('closeDocument') },
    ],
  },
  {
    label: '编辑',
    items: [
      { label: '撤销', run: () => commands.run('undo') },
      { label: '重做', run: () => commands.run('redo') },
      { divider: true },
      { label: '剪切', run: () => commands.run('cut') },
      { label: '复制', run: () => commands.run('copy') },
      { label: '复制合并', run: () => commands.run('copyMerged') },
      { label: '粘贴', run: () => commands.run('paste') },
      { divider: true },
      { label: '填充前景色', run: () => commands.run('fillForeground') },
      { label: '填充背景色', run: () => commands.run('fillBackground') },
      { label: '清除', run: () => commands.run('clearSelection') },
      { label: '内容识别填充', run: () => commands.run('openFilter','contentAwareFill') },
    ],
  },
  {
    label: '图像',
    items: [
      { label: '画布大小…', run: () => api.openDialog('canvasSize') },
      { label: '图像大小…', run: () => api.openDialog('imageSize') },
      { label: '修边', run: () => commands.run('trim') },
      { divider: true },
      { label: '旋转画布 90°', run: () => commands.run('rotateCanvasAll', 90) },
      { label: '旋转画布 180°', run: () => commands.run('rotateCanvasAll', 180) },
      { label: '水平翻转画布', run: () => commands.run('flipCanvasH') },
      { label: '垂直翻转画布', run: () => commands.run('flipCanvasV') },
    ],
  },
  {
    label: '图层',
    items: [
      { label: '新建图层', run: () => commands.run('newLayer') },
      { label: '新建组', run: () => commands.run('newGroup') },
      { label: '复制图层', run: () => commands.run('duplicateLayer') },
      { label: '删除图层', run: () => commands.run('deleteLayer') },
      { divider: true },
      { label: '上移一层', run: () => commands.run('moveLayerUp') },
      { label: '下移一层', run: () => commands.run('moveLayerDown') },
      { label: '向下合并', run: () => commands.run('mergeDown') },
      { label: '合并所有图层', run: () => commands.run('flatten') },
      { divider: true },
      { label: '添加图层蒙版', run: () => commands.run('addMask') },
      { label: '从选区生成蒙版', run: () => commands.run('maskFromSelection') },
      { label: '应用蒙版', run: () => commands.run('applyMask') },
      { label: '反相蒙版', run: () => commands.run('invertMask') },
    ],
  },
  {
    label: '调整层',
    items: [
      'Hue/Saturation', 'Levels', 'Curves', 'Exposure', 'Gradient Map', 'Grain',
      'Black & White', 'Color Balance', 'Invert', 'Gaussian Blur', 'Motion Blur', 'Add Noise',
    ].map((name) => ({ label: ADJUSTMENT_LABELS[name as keyof typeof ADJUSTMENT_LABELS]??name, run: () => commands.run('addAdjustment', name) })),
  },
  {
    label: '滤镜',
    items: [
      {label:'相机RAW滤镜…',run:()=>commands.run('openFilter','cameraRaw')},
      ...['Hue/Saturation','Levels','Curves','Exposure','Gradient Map','Grain','Black & White','Color Balance','Invert','Gaussian Blur','Motion Blur'].map(kind=>({label:(ADJUSTMENT_LABELS[kind as keyof typeof ADJUSTMENT_LABELS]??kind)+'…',run:()=>commands.run('openFilter',kind)})),
      { label: '添加杂色', run: () => commands.run('openFilter', 'filterAddNoise') },
      { label: '渐晕', run: () => commands.run('openFilter', 'filterVignette') },
      { label: '辉光', run: () => commands.run('openFilter', 'filterBloom') },
      { label: '色调反差', run: () => commands.run('openFilter', 'filterTonalContrast') },
      { label: '镜头校正', run: () => commands.run('openFilter', 'filterLensCorrection') },
      { label: '移除背景', run: () => commands.run('openFilter', 'filterRemoveBackground') },
      { label: 'USM 锐化', run: () => commands.run('openFilter', 'filterSharpen') },
      { label: '降噪', run: () => commands.run('openFilter', 'filterDenoise') },
      { label: '抖动', run: () => commands.run('openFilter', 'filterDither') },
    ],
  },
  {
    label: '选择',
    items: [
      { label: '全选', run: () => commands.run('selectAll') },
      { label: '取消选择', run: () => commands.run('deselect') },
      { label: '反选', run: () => commands.run('inverseSelection') },
      { divider: true },
      { label: '选择主体', run: () => commands.run('selectSubject') },
      { label: '色彩范围…', run: () => api.openDialog('colorRange') },
      { divider: true },
      { label: '扩展 8px', run: () => commands.run('selectionExpand', 8) },
      { label: '收缩 8px', run: () => commands.run('selectionContract', 8) },
      { label: '羽化 8px', run: () => commands.run('selectionFeather', { radius: 8 }) },
      { label: '选区边界', run: () => commands.run('selectionBoundary') },
      { divider: true },
      { label: '由图层像素建立选区', run: () => commands.run('loadLayerPixelsAsSelection') },
      { label: '由蒙版建立选区', run: () => commands.run('loadMaskAsSelection') },
    ],
  },
  {
    label: '视图',
    items: [
      { label: '放大', run: () => commands.run('zoomIn') },
      { label: '缩小', run: () => commands.run('zoomOut') },
      { label: '恢复默认面板布局', run: () => resetPanels() },
      { label: '适配画布', run: () => commands.run('fitCanvas') },
      { label: '实际像素', run: () => commands.run('actualPixels') },
      { divider: true },
      { label: '显示标尺', run: () => commands.run('toggleRulers') },
      { label: '显示网格', run: () => commands.run('toggleGrid') },
      { label: '网格设置…', run: () => commands.run('gridSettings') },
      { label: '显示参考线', run: () => commands.run('toggleGuides') },
      { label: '吸附设置…', run: () => commands.run('snapSettings') },
      { label:'清除参考线',run:()=>commands.run('clearGuides') },
      { label:'锁定参考线',run:()=>{api.doc.guidesLocked=!api.doc.guidesLocked;} },
      { label:'显示像素网格',run:()=>{api.ui.pixelGrid=!api.ui.pixelGrid;api.invalidate();} },
      { label:'仅画布',run:()=>{api.ui.canvasOnly=!api.ui.canvasOnly;} },
      { label:'搜索命令…',run:()=>api.openDialog('commandPalette') },
      { label: '显示变换控件', run: () => commands.run('toggleTransformControls') },
      { divider: true },
      { label: '主题：暗色', run: () => commands.run('setTheme', 'dark') },
      { label: '主题：亮色', run: () => commands.run('setTheme', 'light') },
      { label: '主题：跟随系统', run: () => commands.run('setTheme', 'system') },
    ],
  },
  {
    label: '帮助',
    items: [
      { label: '键盘快捷键（可自定义）…', run: () => commands.run('shortcuts') },
      { label: '关于合成器', run: () => commands.run('about') },
    ],
  },
];

/** 缩放比例显示（跟随视口实时更新） */
const zoomLabel = computed(() => Math.round(api.viewport.zoom * 100) + '%');

/** 键盘事件 */
function onKeyDown(event: KeyboardEvent): void {
  handleKeyDown(event);

}

onMounted(() => {
  initialize();
  void initTheme();
  void loadPanelLayout();
  window.addEventListener('resize', constrainFloatingPanels);
  window.addEventListener('keydown', onKeyDown);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', constrainFloatingPanels);
  window.removeEventListener('keydown', onKeyDown);
});

/** 前景色十六进制 */
function foregroundHex(): string {
  return toHex(...api.foreground).toUpperCase();
}
/** 跨文档拖放只接收当前进程中已打开文档的ID，复制独立像素，目标文档拥有撤销记录。 */
async function dropLayers(event:DragEvent,index:number){
  const raw=event.dataTransfer?.getData('application/x-compositor-layers');if(!raw)return;
  let data:{documentId:string;ids:string[]};try{data=JSON.parse(raw);}catch{return;}
  const source=documents.value.find(d=>d.id===data.documentId),target=documents.value[index];if(!source||!target||source===target||!Array.isArray(data.ids))return;
  const ids=new Set(data.ids.filter(id=>source.layers.some(l=>l.id===id)));
  const roots=source.layers.filter(l=>ids.has(l.id)&&(!l.parentId||!ids.has(l.parentId)));
  selectDocument(index);
  for(const layer of roots){const captured=captureClipboard({...source,selection:null},{...layer,mask:layer.mask?{...layer.mask,target:'image'}:null});if(captured)await commands.run('pastePayload',captured);}
}
</script>

<template>
  <div class="cmp-app" :class="{'canvas-only':api.ui.canvasOnly}">
    <FilterDialog v-if="currentDialog?.name==='filterDialog'" :session="currentDialog.payload as FilterSession"/>
    <CommandPalette v-if="currentDialog?.name==='commandPalette'" :menus="menus"/>
    <!-- 菜单栏 -->
    <header class="menu-bar">
      <el-dropdown v-for="menu in menus" :key="menu.label" trigger="hover" @command="() => undefined">
        <span class="menu-title">{{ menu.label }}</span>
        <template #dropdown>
          <el-dropdown-menu>
            <template v-for="(item, index) in menu.items" :key="index">
              <el-dropdown-item v-if="item.divider" divided />
              <el-dropdown-item v-else @click="item.run?.()">
                {{ item.label }}
                <span v-if="item.key" class="shortcut-hint">{{ item.key }}</span>
              </el-dropdown-item>
            </template>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <span class="spacer" />
      <span class="doc-meta">
        {{ currentDocument?.name }} · {{ currentDocument?.width }} × {{ currentDocument?.height }}
        <span v-if="currentDocument?.dirty" class="dirty">●</span>
        <span v-if="currentDocument?.saving" class="saving">保存中…</span>
      </span>
    </header>

    <!-- 工程标签页 -->
    <nav class="tabs">
      <div
        v-for="(doc, index) in documents"
        :key="doc.id"
        class="tab"
        :class="{ active: index === documents.indexOf(currentDocument!) }"
        @click="selectDocument(index)"
        @dragover.prevent="($event.dataTransfer)&&($event.dataTransfer.dropEffect='copy')" @drop.prevent="dropLayers($event,index)"
      >
        <span>{{ doc.name }}</span>
        <button class="close" @click.stop="closeDocument(doc.id)">×</button>
      </div>
      <button class="add-tab" title="新建画布" @click="commands.run('newCanvas')">＋</button>
    </nav>

    <!-- 主体 -->
    <StartPage v-if="documents.length === 0" />
    <div v-else class="editor-workspace">
      <ToolBar />
      <DockLayout>
        <ToolHeader />
        <CanvasStage />
      </DockLayout>
    </div>

    <!-- 状态栏 -->
    <footer class="status-bar">
      <span>{{ statusMessage }}</span>
      <span class="spacer" />
      <span class="swatch fg" :title="`前景色 ${foregroundHex()}`">●</span>
      <span class="swatch bg" title="背景色">●</span>
      <span class="zoom" @click="commands.run('fitCanvas')">{{ zoomLabel }}</span>
    </footer>

    <DialogHost />
  </div>
</template>

<script lang="ts">
</script>

<style>
.editor-workspace {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.cmp-app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--cmp-bg);
  color: var(--cmp-text);
  font-size: 12px;
}

.menu-bar, .tabs, .status-bar {
  flex-shrink: 0;
}

.menu-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  height: 28px;
  background: var(--cmp-panel);
  border-bottom: 1px solid var(--cmp-border);
}

.menu-title {
  padding: 4px 8px;
  cursor: pointer;
  border-radius: 3px;
}

.menu-title:hover {
  background: var(--cmp-border);
}

.spacer {
  flex: 1;
}

.shortcut-hint {
  margin-left: 16px;
  color: var(--cmp-text-faint);
}

.doc-meta {
  color: var(--cmp-text-dim);
}

.dirty {
  color: #f59e0b;
  margin-left: 4px;
}

.saving {
  color: #38bdf8;
  margin-left: 6px;
}

.tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 6px;
  background: var(--cmp-tabs);
  border-bottom: 1px solid var(--cmp-border);
  overflow-x: auto;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: #2a2a2a;
  border-radius: 4px 4px 0 0;
  cursor: pointer;
  white-space: nowrap;
}

.tab.active {
  background: var(--cmp-border);
  color: #fff;
}

.tab .close {
  background: transparent;
  border: none;
  color: var(--cmp-text-dim);
  cursor: pointer;
}

.add-tab {
  background: transparent;
  border: none;
  color: var(--cmp-text-dim);
  cursor: pointer;
  font-size: 14px;
}





.status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  padding: 0 8px;
  background: var(--cmp-panel);
  border-top: 1px solid var(--cmp-border);
  color: var(--cmp-text-dim);
}

.swatch.fg {
  color: #38bdf8;
}

.swatch.bg {
  color: var(--cmp-text);
}

.zoom {
  cursor: pointer;
  min-width: 52px;
  text-align: right;
}
</style>

<style>
.canvas-only .menu-bar,.canvas-only .tabs,.canvas-only .status-bar,.canvas-only .cmp-toolbar,.canvas-only .cmp-tool-header,.canvas-only .dock-left,.canvas-only .dock-right,.canvas-only .dock-bottom,.canvas-only .float-layer{display:none!important}
.canvas-only{position:fixed;inset:0;z-index:2500;background:black}.canvas-only .dock-layout{grid-template-columns:minmax(0,1fr)!important;grid-template-rows:minmax(0,1fr)!important}.canvas-only .dock-center{grid-area:1 / 1 / 2 / 2!important}
</style>
