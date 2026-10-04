/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

/** otools 注入的插件 UUID（由 vite define 提供） */
declare const __OTOOLS_PLUGIN_UUID__: string;
