<script setup lang="ts">
/**
 * 启动页（欢迎界面）
 * ---------------------------------------------------------------
 * 没有打开任何文档时显示：快速新建 / 打开、最近工程、示例工程。
 */
import { onMounted, ref } from 'vue';
import { commands } from '@/composables/useEditor';
import { themeLabel, themeMode, type ThemeMode } from '@/composables/useTheme';
import { SAMPLES } from '@/io/samples';
import { loadRecentProjects } from '@/composables/commands-io';

const recent = ref<string[]>([]);

/** 加载最近工程列表 */
async function loadRecent(): Promise<void> {
  recent.value = await loadRecentProjects();
}

onMounted(loadRecent);

/** 打开示例工程 */
function openSample(id: string): void {
  commands.run('sample', id);
}

/** 切换主题 */
function applyTheme(mode: ThemeMode): void {
  themeMode.value = mode;
  commands.run('setTheme', mode);
}
</script>

<template>
  <div class="start-page">
    <div class="hero">
      <h1>合成器专业版</h1>
      <p class="tagline">跨平台图像编辑器 · 图层 / 蒙版 / 调整层 / PSD / 相机 RAW / .comp 工程</p>
    </div>

    <div class="cards">
      <button class="card primary" @click="commands.run('newCanvas')">
        <span class="icon">＋</span>
        <span class="name">新建画布</span>
        <span class="desc">从空白画布开始</span>
      </button>
      <button class="card" @click="commands.run('openImage')">
        <span class="icon">🖼</span>
        <span class="name">导入图片</span>
        <span class="desc">PNG / JPEG / WebP / TIFF / SVG</span>
      </button>
      <button class="card" @click="commands.run('openComp')">
        <span class="icon">📁</span>
        <span class="name">打开工程</span>
        <span class="desc">.comp 工程包</span>
      </button>
      <button class="card" @click="commands.run('openPsd')">
        <span class="icon">🎨</span>
        <span class="name">导入 PSD</span>
        <span class="desc">Photoshop 图层与蒙版</span>
      </button>
      <button class="card" @click="commands.run('openRaw')">
        <span class="icon">📷</span>
        <span class="name">导入相机 RAW</span>
        <span class="desc">DNG / CR2 / NEF / ARW</span>
      </button>
    </div>

    <div class="sections">
      <section>
        <h3>示例工程</h3>
        <div class="list">
          <button v-for="sample in SAMPLES" :key="sample.id" class="row" @click="openSample(sample.id)">
            <span class="row-name">{{ sample.name }}</span>
            <span class="row-desc">{{ sample.description }}</span>
          </button>
        </div>
      </section>

      <section>
        <h3>最近工程</h3>
        <div class="list">
          <button v-for="path in recent" :key="path" class="row" @click="commands.run('openRecent', path)">
            <span class="row-name">{{ path.split(/[/\\]/).pop() }}</span>
            <span class="row-desc">{{ path }}</span>
          </button>
          <div v-if="recent.length === 0" class="empty">还没有保存过工程</div>
        </div>
      </section>

      <section class="theme">
        <h3>主题</h3>
        <div class="theme-buttons">
          <button
            v-for="mode in (['dark', 'light', 'system'] as ThemeMode[])"
            :key="mode"
            class="theme-button"
            :class="{ active: themeMode === mode }"
            @click="applyTheme(mode)"
          >
            {{ themeLabel[mode] }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.start-page {
  height: 100%;
  overflow-y: auto;
  padding: 48px 32px;
  background: var(--cmp-bg);
}

.hero {
  text-align: center;
  margin-bottom: 28px;
}

.hero h1 {
  margin: 0 0 6px;
  font-size: 28px;
  letter-spacing: 2px;
}

.tagline {
  margin: 0;
  color: var(--cmp-text-dim);
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  max-width: 1080px;
  margin: 0 auto 28px;
}

.card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 14px 16px;
  background: var(--cmp-panel);
  border: 1px solid var(--cmp-border);
  border-radius: 8px;
  color: var(--cmp-text);
  cursor: pointer;
  text-align: left;
}

.card:hover {
  border-color: var(--cmp-accent);
  background: var(--cmp-panel-2);
}

.card.primary {
  border-color: var(--cmp-accent);
}

.card .icon {
  font-size: 20px;
}

.card .name {
  font-size: 13px;
  font-weight: 600;
}

.card .desc {
  font-size: 11px;
  color: var(--cmp-text-dim);
}

.sections {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
  max-width: 1080px;
  margin: 0 auto;
}

section h3 {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--cmp-accent);
}

.list {
  background: var(--cmp-panel);
  border: 1px solid var(--cmp-border);
  border-radius: 6px;
  overflow: hidden;
}

.row {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--cmp-border-soft);
  color: var(--cmp-text);
  cursor: pointer;
  text-align: left;
}

.row:hover {
  background: var(--cmp-hover);
}

.row-name {
  font-size: 12px;
}

.row-desc {
  font-size: 10px;
  color: var(--cmp-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.empty {
  padding: 10px;
  color: var(--cmp-text-faint);
  font-size: 11px;
}

.theme-buttons {
  display: flex;
  gap: 6px;
}

.theme-button {
  padding: 4px 10px;
  background: var(--cmp-panel);
  border: 1px solid var(--cmp-border);
  border-radius: 4px;
  color: var(--cmp-text);
  cursor: pointer;
}

.theme-button.active {
  border-color: var(--cmp-accent);
  color: var(--cmp-accent);
}
</style>
