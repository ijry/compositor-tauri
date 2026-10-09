<script setup lang="ts">
/** 文字输入仅覆盖编辑中的文字框，输入实时生成像素并进入撤销历史。 */
import { computed, nextTick, ref, watch } from 'vue';
import { api, currentDocument } from '@/composables/useEditor';
import { textToolState, updateTextLayer } from '@/tools/transform';
const input=ref<HTMLTextAreaElement|null>(null);
const layer=computed(()=>api.toolId==='type' ? currentDocument.value?.layers.find(item=>item.id===textToolState.editingId && item.text) : null);
const style=computed(()=>{
  const item=layer.value;if(!item?.text)return {};
  const point=api.toScreen({x:item.transform.origin[0],y:item.transform.origin[1]});const z=api.viewport.zoom;
  return {left:`${point.x}px`,top:`${point.y}px`,width:`${Math.max(140,item.transform.size[0]*z)}px`,height:`${Math.max(48,item.transform.size[1]*z)}px`,fontSize:`${Math.max(12,item.text.fontSize*z)}px`,fontFamily:item.text.fontName};
});
watch(()=>textToolState.editingId,async()=>{await nextTick();input.value?.focus();input.value?.select();});
function change(event: Event) {
  const item=layer.value;if(!item)return;
  const content=(event.target as HTMLTextAreaElement).value;
  api.setToolOption('content',content);updateTextLayer(api,item.id,{content});
}
function textKeys(event:KeyboardEvent){
  const item=layer.value;if(!item?.text||!event.altKey||!event.key.startsWith('Arrow'))return;
  event.preventDefault();const horizontal=event.key==='ArrowLeft'||event.key==='ArrowRight',key=horizontal?'tracking':'lineSpacing',direction=event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:1;
  updateTextLayer(api,item.id,{[key]:item.text[key]+direction*(event.shiftKey?10:1)});
}
function finish(){textToolState.editingId=null;}
</script>
<template>
  <textarea v-if="layer" ref="input" class="cmp-inline-text" aria-label="编辑画布文字" :style="style" :value="layer.text?.content" @input="change" @blur="finish" @pointerdown.stop @pointermove.stop @pointerup.stop @dblclick.stop @keydown.stop="textKeys" @keydown.ctrl.enter.prevent="finish" @keydown.meta.enter.prevent="finish" @keydown.esc.prevent="finish" />
</template>
<style scoped>
.cmp-inline-text { position:absolute;z-index:5;box-sizing:border-box;max-width:100%;max-height:100%;padding:4px;resize:none;overflow:auto;line-height:1.2;border:1px solid var(--cmp-accent);background:var(--cmp-panel);color:var(--cmp-text);outline:none; }
</style>
