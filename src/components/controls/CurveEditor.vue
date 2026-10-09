<script setup lang="ts">
/** 可拖动控制点的曲线编辑器；通过值更新而非访问编辑器单例，供调整层和RAW共用。 */
import { computed, ref } from 'vue';
import { buildCurveLut } from '@/core/filters/adjust';
const props=defineProps<{modelValue:[number,number][]}>();
const emit=defineEmits<{ 'update:modelValue':[value:[number,number][]] }>();
const selected=ref(0),svg=ref<SVGSVGElement|null>(null);
const points=computed(()=>props.modelValue);
const path=computed(()=>Array.from(buildCurveLut(points.value),(y,x)=>`${x},${255-y}`).join(' '));
function update(index:number,x:number,y:number){const next=points.value.map(p=>[...p] as [number,number]);next[index]=[Math.max(index?next[index-1]![0]+1:0,Math.min(index<next.length-1?next[index+1]![0]-1:255,Math.round(x))),Math.max(0,Math.min(255,Math.round(y)))];emit('update:modelValue',next);}
function drag(event:PointerEvent,index:number){selected.value=index;const target=event.currentTarget as Element;target.setPointerCapture(event.pointerId);const move=(e:PointerEvent)=>{const r=svg.value!.getBoundingClientRect();update(index,(e.clientX-r.left)/r.width*255,255-(e.clientY-r.top)/r.height*255);};const end=()=>{target.removeEventListener('pointermove',move as EventListener);target.removeEventListener('pointerup',end);};target.addEventListener('pointermove',move as EventListener);target.addEventListener('pointerup',end);}
function add(){if(points.value.length>=16)return;const copy=points.value.map(p=>[...p] as [number,number]);let i=0;for(let j=1;j<copy.length-1;j++)if(copy[j+1]![0]-copy[j]![0]>copy[i+1]![0]-copy[i]![0])i=j;copy.splice(i+1,0,[Math.round((copy[i]![0]+copy[i+1]![0])/2),Math.round((copy[i]![1]+copy[i+1]![1])/2)]);selected.value=i+1;emit('update:modelValue',copy);}
</script>
<template><div class="curve-editor">
 <svg ref="svg" viewBox="0 0 255 255" aria-label="曲线编辑器"><path d="M0 255L255 0 M64 0V255 M128 0V255 M192 0V255 M0 64H255 M0 128H255 M0 192H255" class="grid"/><polyline :points="path" fill="none" stroke="var(--cmp-accent,#38bdf8)" stroke-width="2"/><circle v-for="([x,y],i) in points" :key="i" :cx="x" :cy="255-y" r="5" @pointerdown.prevent="drag($event,i)"/></svg>
 <div class="row"><label>控制点<select v-model.number="selected"><option v-for="(_,i) in points" :key="i" :value="i">{{i+1}}</option></select></label><button type="button" @click="add">添加点</button><button type="button" :disabled="selected===0||selected>=points.length-1" @click="emit('update:modelValue',points.filter((_,i)=>i!==selected));selected=0">删除点</button></div>
 <div v-if="points[selected]" class="row"><label>输入<input type="number" min="0" max="255" :value="points[selected]![0]" @change="update(selected,Number(($event.target as HTMLInputElement).value),points[selected]![1])"/></label><label>输出<input type="number" min="0" max="255" :value="points[selected]![1]" @change="update(selected,points[selected]![0],Number(($event.target as HTMLInputElement).value))"/></label></div>
</div></template>
<style scoped>.curve-editor svg{width:100%;max-width:250px;aspect-ratio:1;background:var(--cmp-panel-2);border:1px solid var(--cmp-border);touch-action:none}.grid{stroke:#7775;stroke-width:1;fill:none}circle{fill:#fff;cursor:move}.row{display:flex;gap:6px;align-items:center;margin:5px 0}label{display:flex;gap:4px;align-items:center}input{width:55px}button,select,input{background:var(--cmp-panel-2);color:var(--cmp-text);border:1px solid var(--cmp-border);border-radius:3px}</style>
