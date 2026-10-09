<script setup lang="ts">
/** 调整层与破坏性滤镜共用的参数编辑器，所有变化向上抛出完整快照。 */
import { computed } from 'vue';
import CurveEditor from './CurveEditor.vue';
import { autoLevelsRange } from '@/core/filters/adjust';
import type { AdjustmentRecord, PixelBuffer } from '@/types/document';
const props=defineProps<{modelValue:AdjustmentRecord;source?:PixelBuffer}>();
const emit=defineEmits<{ 'update:modelValue':[value:AdjustmentRecord] }>();
const channels=['RGB','Red','Green','Blue'] as const,channelLabels=['RGB','红','绿','蓝'];
function set(path:string,value:unknown){const next=JSON.parse(JSON.stringify(props.modelValue));const keys=path.split('.');let target=next;for(const key of keys.slice(0,-1))target=target[key];target[keys.at(-1)!]=value;emit('update:modelValue',next);}
function get(path:string):any{return path.split('.').reduce((v,k)=>v?.[k],props.modelValue as any);}
const kinds:Record<string,Array<[string,string,number,number,number?]>>={
 'Hue/Saturation':[['hue','色相',-180,180],['saturation','饱和度',-100,100],['lightness','明度',-100,100]],
 Exposure:[['exposureSettings.exposure','曝光',-5,5,.05],['exposureSettings.offset','偏移',-.5,.5,.01],['exposureSettings.gamma','伽马',.01,10,.01]],
 Grain:[['grainSettings.amount','数量',0,100],['grainSettings.size','大小',.1,10,.1],['grainSettings.roughness','粗糙度',0,100],['grainSettings.colorAmount','彩色颗粒',0,100],['grainSettings.seed','随机种子',0,1000000]],
 'Black & White':[['reds','红色',-200,300],['yellows','黄色',-200,300],['greens','绿色',-200,300],['cyans','青色',-200,300],['blues','蓝色',-200,300],['magentas','洋红',-200,300]].map(([k,l,min,max])=>['blackWhiteSettings.'+k,l,min,max]) as any,
 'Color Balance':(['shadow','mid','highlight'] as const).flatMap((tone,i)=>(['CyanRed','MagentaGreen','YellowBlue'] as const).map((axis,j)=>['colorBalanceSettings.'+tone+axis,['阴影','中间调','高光'][i]+' '+['青—红','洋红—绿','黄—蓝'][j],-100,100] as [string,string,number,number])),
 'Gaussian Blur':[['blurRadius','半径',.1,250,.5]],'Motion Blur':[['motionAngle','角度',-180,180],['motionDistance','距离',1,2000]],'Add Noise':[['noiseAmount','数量',0,400,.1],['noiseSeed','随机种子',0,1000000]],
};
const fields=computed(()=>kinds[props.modelValue.kind]??[]);
const channel=computed(()=>channels.indexOf(props.modelValue.kind==='Levels'?props.modelValue.levels.channel:props.modelValue.curves.channel));
const flags=computed(()=>props.modelValue.kind==='Hue/Saturation'?[['colorize','着色']]:props.modelValue.kind==='Black & White'?[['blackWhiteSettings.tintEnabled','着色']]:props.modelValue.kind==='Color Balance'?[['colorBalanceSettings.preserveLuminosity','保持亮度']]:props.modelValue.kind==='Add Noise'?[['noiseGaussian','高斯分布'],['noiseMonochromatic','单色']]:[]);
const colorValue=(v:number[])=>'#'+v.map(c=>Math.round(c).toString(16).padStart(2,'0')).join('');
const color=(s:string)=>[1,3,5].map(i=>parseInt(s.slice(i,i+2),16));
function auto(){if(props.source)set('levels.ranges.'+channel.value,autoLevelsRange(props.source,props.modelValue.levels.channel));}
</script>
<template><div class="adjustment-controls">
 <template v-if="modelValue.kind==='Levels'||modelValue.kind==='Curves'"><label>通道<select :value="get(modelValue.kind==='Levels'?'levels.channel':'curves.channel')" @change="set(modelValue.kind==='Levels'?'levels.channel':'curves.channel',($event.target as HTMLSelectElement).value)"><option v-for="(c,i) in channels" :key="c" :value="c">{{channelLabels[i]}}</option></select></label></template>
 <template v-if="modelValue.kind==='Levels'"><label v-for="([key,title],i) in [['black','输入黑点'],['gamma','中间调'],['white','输入白点'],['outputBlack','输出黑点'],['outputWhite','输出白点']]" :key="key">{{title}}<input type="number" :min="i===1?.01:0" :max="i===1?10:255" :step="i===1?.01:1" :value="get('levels.ranges.'+channel+'.'+key)" @input="set('levels.ranges.'+channel+'.'+key,Number(($event.target as HTMLInputElement).value))"/></label><button type="button" :disabled="!source" @click="auto">自动色阶</button></template>
 <CurveEditor v-if="modelValue.kind==='Curves'" :model-value="modelValue.curves.channels[channel]!.points" @update:model-value="set('curves.channels.'+channel+'.points',$event)"/>
 <template v-if="modelValue.kind==='Gradient Map'"><label v-for="(key,i) in ['shadows','mids','highlights']" :key="key">{{['阴影','中间调','高光'][i]}}<input type="color" :value="colorValue(get('gradientMapSettings.'+key))" @input="set('gradientMapSettings.'+key,color(($event.target as HTMLInputElement).value))"/></label><label><input type="checkbox" :checked="modelValue.gradientMapSettings.reversed" @change="set('gradientMapSettings.reversed',($event.target as HTMLInputElement).checked)"/>反向</label></template>
 <label v-for="[path,title,min,max,step] in fields" :key="path">{{title}}<input type="number" :min="min" :max="max" :step="step??1" :value="get(path)" @input="set(path,Math.min(max,Math.max(min,Number(($event.target as HTMLInputElement).value))))"/></label>
 <label v-for="[key,title] in flags" :key="key"><input type="checkbox" :checked="get(key!)" @change="set(key!,($event.target as HTMLInputElement).checked)"/>{{title}}</label>
 <label v-if="modelValue.kind==='Black & White'&&modelValue.blackWhiteSettings.tintEnabled">着色色彩<input type="color" :value="colorValue(modelValue.blackWhiteSettings.tintColor)" @input="set('blackWhiteSettings.tintColor',color(($event.target as HTMLInputElement).value))"/></label>
 <p v-if="modelValue.kind==='Invert'">反相没有额外参数，可通过图层不透明度控制强度。</p>
</div></template>
<style scoped>.adjustment-controls{display:grid;gap:6px;font-size:12px}.adjustment-controls>label{display:flex;align-items:center;justify-content:space-between;gap:8px}input[type=number]{width:85px}input,select,button{color:var(--cmp-text);background:var(--cmp-panel-2);border:1px solid var(--cmp-border);border-radius:3px;padding:3px}input[type=color]{width:70px;height:26px}</style>
