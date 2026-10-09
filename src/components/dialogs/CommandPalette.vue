<script setup lang="ts">
/** 命令面板复用真实菜单和工具注册表，不维护另一份容易失同步的动作。 */
import { computed, ref, nextTick, onMounted } from 'vue';
import { TOOLS } from '@/tools';
import { closeDialog, setTool } from '@/composables/useEditor';
const props=defineProps<{menus:{label:string;items:{label?:string;run?:()=>unknown}[]}[]}>();
const query=ref(''),selected=ref(0),input=ref<HTMLInputElement|null>(null);
const all=computed(()=>[...props.menus.flatMap(group=>group.items.filter(i=>i.run&&i.label).map(i=>({title:group.label+' / '+i.label!,run:i.run!}))),...TOOLS.map(tool=>({title:'工具 / '+tool.name,run:()=>setTool(tool.id)}))]);
const results=computed(()=>all.value.filter(i=>i.title.toLowerCase().includes(query.value.toLowerCase())));
function run(index:number){const item=results.value[index];if(!item)return;closeDialog();item.run();}
onMounted(async()=>{await nextTick();input.value?.focus();});
</script>
<template><el-dialog :model-value="true" title="搜索命令" width="600px" @close="closeDialog"><div class="command-palette"><input ref="input" v-model="query" type="search" aria-label="搜索菜单命令和工具" placeholder="搜索菜单命令或工具…" @input="selected=0" @keydown.down.prevent="selected=Math.min(results.length-1,selected+1)" @keydown.up.prevent="selected=Math.max(0,selected-1)" @keydown.enter.prevent="run(selected)"/><ul role="listbox"><li v-for="(item,i) in results" :key="item.title"><button :class="{selected:i===selected}" @click="run(i)">{{item.title}}</button></li></ul></div></el-dialog></template>
<style scoped>input{width:100%;box-sizing:border-box;padding:12px;color:var(--cmp-text);background:var(--cmp-panel-2);border:1px solid var(--cmp-border)}ul{list-style:none;padding:0;margin:8px 0;max-height:400px;overflow:auto}button{width:100%;text-align:left;border:0;background:transparent;color:var(--cmp-text);padding:9px;cursor:pointer}.selected,button:hover{background:var(--cmp-accent);color:white}</style>
