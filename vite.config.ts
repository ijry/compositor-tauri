import UnoCSS from '@unocss/vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 本插件既可以独立开发（pnpm dev / pnpm build），
 * 也可以整体拷贝到 `D:\Repos\xyito\otools\otools\plugins\otools-compositor` 下，
 * 由 otools 仓库自带的 `createOtoolsPluginSdkViteConfig` 提供统一的
 * 别名、依赖兜底与快速开发（quickDev）能力。
 * 因此这里需要探测宿主脚本是否存在，再决定使用哪套配置。
 */
const otoolsSdkConfigPath = path.resolve(here, '../../scripts/otools-plugin-vite-config-sdk.ts');
const hasOtoolsSdk = fs.existsSync(otoolsSdkConfigPath);

const DEV_PORT = 5191;

export default defineConfig(async () => {
  if (hasOtoolsSdk) {
    const mod = await import(/* @vite-ignore */ otoolsSdkConfigPath);
    return mod.createOtoolsPluginSdkViteConfig({ port: DEV_PORT, extraPlugins: [UnoCSS()] });
  }

  return {
    plugins: [vue(), UnoCSS()],
    define: {
      __OTOOLS_PLUGIN_UUID__: JSON.stringify('otools-compositor'),
    },
    resolve: {
      alias: { '@': path.resolve(here, 'src') },
    },
    server: { host: '127.0.0.1', port: DEV_PORT, strictPort: true },
    base: './',
    build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 4096 },
  };
});
