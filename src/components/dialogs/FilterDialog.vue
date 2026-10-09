<script setup lang="ts">
/** 滤镜编辑/原图对照/取消确认分离，源文件在确认前保持不变。 */
import { computed, ref } from 'vue';
import AdjustmentControls from '@/components/controls/AdjustmentControls.vue';
import RawControls from '@/components/controls/RawControls.vue';
import ImagePreview from '@/components/controls/ImagePreview.vue';
import { filterPreview, FILTER_FIELDS, type FilterSession } from '@/composables/filterSession';
import { closeDialog } from '@/composables/useEditor';
const props=defineProps<{session:FilterSession}>();
const previewEnabled=ref(true),adjustment=ref(props.session.adjustment),raw=ref(props.session.raw),values=ref({...props.session.values});
const output=computed(()=>filterPreview({...props.session,adjustment:adjustment.value,raw:raw.value,values:values.value}));
function apply(){props.session.apply(output.value);closeDialog();}
</script>
<template><el-dialog :model-value="true" :title="session.title" width="720px" @close="closeDialog"><div class="filter-editor">
 <label><input v-model="previewEnabled" type="checkbox"/>实时预览（取消勾选对照原图）</label><ImagePreview :buffer="previewEnabled?output:session.source"/>
 <AdjustmentControls v-if="adjustment" v-model="adjustment" :source="session.source"/><RawControls v-else-if="session.kind==='cameraRaw'" v-model="raw"/>
 <template v-else><label v-for="[key,title,min,max,step] in FILTER_FIELDS[session.kind]??[]" :key="key">{{title}}<input v-model.number="values[key]" type="number" :min="min" :max="max" :step="step??1"/></label><p v-if="session.kind==='contentAwareFill'">根据当前选区，从周边像素重建选中内容。关闭对话框会保留原图。</p></template>
 </div><template #footer><el-button @click="closeDialog">取消</el-button><el-button type="primary" @click="apply">应用</el-button></template></el-dialog></template>
<style scoped>.filter-editor{max-height:70vh;overflow:auto}.filter-editor>label{display:flex;justify-content:space-between;align-items:center;margin:8px 0}input[type=number]{width:100px;color:var(--cmp-text);background:var(--cmp-panel-2);border:1px solid var(--cmp-border)}</style>
