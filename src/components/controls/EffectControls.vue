<script setup lang="ts">
/** 图层效果参数，内部角度使用偏移方向，工程边界负责与上游光源角互转。 */
import type { LayerEffects } from '@/types/document';
const props=defineProps<{modelValue:LayerEffects}>(),emit=defineEmits<{'update:modelValue':[value:LayerEffects]}>();
const labels:Record<string,string>={stroke:'描边',shadow:'投影',colorOverlay:'颜色叠加',innerShadow:'内阴影',outerGlow:'外发光',innerGlow:'内发光'};
const fields:Record<string,[string,number,number,number?]>={size:['大小',0,500],opacity:['不透明度',0,1,.01],angle:['方向',-180,180],distance:['距离',0,2000],blur:['模糊',0,250]};
function set(key:string,field:string,value:unknown){const next=JSON.parse(JSON.stringify(props.modelValue));next[key][field]=value;emit('update:modelValue',next);}
const hex=(c:number[])=>'#'+c.map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
</script>
<template><div class="effect-controls"><fieldset v-for="(effect,key) in modelValue" :key="key"><legend>{{labels[key]}}</legend>
 <label>颜色<input type="color" :value="hex(effect!.color)" @input="set(key,'color',[1,3,5].map(i=>parseInt(($event.target as HTMLInputElement).value.slice(i,i+2),16)))"/></label>
 <template v-for="([label,min,max,step],field) in fields" :key="field"><label v-if="field in effect!">{{label}}<input type="number" :min="min" :max="max" :step="step??1" :value="(effect as any)[field]" @input="set(key,field,Math.max(min,Math.min(max,Number(($event.target as HTMLInputElement).value))))"/></label></template>
 <label v-if="key==='stroke'"><input type="checkbox" :checked="modelValue.stroke!.inside" @change="set(key,'inside',($event.target as HTMLInputElement).checked)"/>内部描边</label>
</fieldset></div></template>
<style scoped>fieldset{border:1px solid var(--cmp-border);margin:8px 0;padding:6px}legend{color:var(--cmp-text-dim)}label{display:flex;align-items:center;justify-content:space-between;margin:5px 0}input{width:80px;color:var(--cmp-text);background:var(--cmp-panel-2);border:1px solid var(--cmp-border)}input[type=color]{height:25px}input[type=checkbox]{width:auto}</style>
