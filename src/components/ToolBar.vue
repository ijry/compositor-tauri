<script setup lang="ts">
/** 左侧工具栏：分组显示，组内长按可切换工具 */
import { computed, ref, onBeforeUnmount } from 'vue';
import { cycleTool, getTool, TOOL_GROUPS } from '@/tools';
import { api, setTool, toolId } from '@/composables/useEditor';

const groups = computed(() => TOOL_GROUPS.map((group) => ({
  ...group,
  tools: group.tools.map((id) => getTool(id)).filter(Boolean),
})));

/** 组内已选中的工具 id */
function activeInGroup(toolIds: string[]): string {
  return toolIds.includes(toolId.value) ? toolId.value : toolIds[0]!;
}

/** 点击：同组内已有第二个工具时循环切换 */
function onClick(tool: string, group: string): void {
  setTool(tool);
  api.status(`${getTool(tool)?.name??tool}工具`);
  void group;
}
const flyout=ref<{tools:string[];x:number;y:number}|null>(null);let pressTimer:ReturnType<typeof setTimeout>|null=null;
function press(event:PointerEvent,group:string[]){pressTimer=setTimeout(()=>{flyout.value={tools:group,x:event.clientX+12,y:event.clientY};},500);}
function release(){if(pressTimer)clearTimeout(pressTimer);pressTimer=null;}
onBeforeUnmount(release);
</script>

<template>
  <aside class="cmp-toolbar">
    <div v-for="group in groups" :key="group.id" class="tool-group">
      <button
        v-for="tool in group.tools"
        :key="tool!.id"
        class="tool-button"
        :class="{ active: toolId === tool!.id }"
        :title="`${tool!.name}（${tool!.shortcut}）`"
        @pointerdown="press($event,group.tools.map(t=>t!.id))" @pointerup="release" @pointerleave="release"
        @click="!flyout&&onClick(tool!.id, group.id)"
      >
        <span class="icon">{{ tool!.icon }}</span>
        <span class="shortcut">{{ tool!.shortcut }}</span>
      </button>
    </div>
    <div v-if="flyout" class="tool-flyout" role="menu" :style="{left:flyout.x+'px',top:flyout.y+'px'}" @mouseleave="flyout=null"><button v-for="id in flyout.tools" :key="id" @click="setTool(id);flyout=null">{{getTool(id)?.name}}</button></div>
  </aside>
</template>

<style scoped>
.cmp-toolbar {
  width: 52px;
  flex: 0 0 52px;
  min-height: 0;
  overflow-x: hidden;
  scrollbar-width: thin;
  background: var(--cmp-panel);
  border-right: 1px solid var(--cmp-border);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 4px 0;
  gap: 2px;
  overflow-y: auto;
}

.tool-group {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 6px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--cmp-border-soft);
}

.tool-button {
  width: 42px;
  height: 34px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--cmp-text);
  cursor: pointer;
  position: relative;
  font-size: 15px;
}

.tool-button:hover {
  background: var(--cmp-border-soft);
}

.tool-button.active {
  background: var(--cmp-active);
  border-color: #38bdf8;
  color: #fff;
}

.shortcut {
  position: absolute;
  right: 3px;
  bottom: 1px;
  font-size: 9px;
  opacity: 0.65;
}
</style>

<style scoped>.tool-flyout{position:fixed;z-index:3000;display:grid;background:var(--cmp-panel);border:1px solid var(--cmp-border);padding:5px}.tool-flyout button{background:transparent;color:var(--cmp-text);border:0;padding:8px;cursor:pointer}</style>
