<script setup lang="ts">
/** 以版本号丢弃过期编码结果；旧objectURL及时释放，预览不写入文件。 */
import { ref, watch, onBeforeUnmount } from 'vue';
import { encodeImage } from '@/io/imageIO';
import type { PixelBuffer } from '@/types/document';
const props=withDefaults(defineProps<{buffer:PixelBuffer;format?:'png'|'jpeg'|'webp';quality?:number;scale?:number}>(),{format:'png',quality:1,scale:1});
const url=ref(''),size=ref(0),error=ref('');let version=0;
watch(()=>[props.buffer,props.format,props.quality,props.scale],async()=>{const epoch=++version;try{const blob=await encodeImage(props.buffer,{format:props.format,quality:props.quality,scale:props.scale,background:[255,255,255]});if(epoch!==version)return;const next=URL.createObjectURL(blob);if(url.value)URL.revokeObjectURL(url.value);url.value=next;size.value=blob.size;error.value='';}catch(e){if(epoch===version)error.value=String(e);}},{immediate:true});
onBeforeUnmount(()=>{version++;if(url.value)URL.revokeObjectURL(url.value);});
</script>
<template><figure class="preview"><img v-if="url" :src="url" alt="实时预览"/><figcaption>{{error||`${Math.round(buffer.width*scale)} × ${Math.round(buffer.height*scale)} · ${(size/1024).toFixed(1)} KB`}}</figcaption></figure></template>
<style scoped>.preview{margin:10px 0;text-align:center;background:#202020}.preview img{width:100%;height:220px;max-width:100%;object-fit:contain}.preview figcaption{padding:5px;color:#ddd;font-size:11px}</style>
