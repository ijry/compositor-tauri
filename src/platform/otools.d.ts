/**
 * otools 宿主注入的 API（与 vendor/otools-plugin-sdk 的 otools-globals 保持一致）。
 * 这里只声明本插件实际用到的部分，便于独立开发时类型提示。
 */
export {};

declare global {
  interface OtoolsDialogFilterLocal {
    name: string;
    extensions: string[];
  }

  interface OtoolsApiLocal {
    dialog?: {
      open(options?: { directory?: boolean; multiple?: boolean; title?: string; defaultPath?: string; filters?: OtoolsDialogFilterLocal[] }): Promise<string | string[] | null>;
      save(options?: { title?: string; defaultPath?: string; filters?: OtoolsDialogFilterLocal[] }): Promise<string | null>;
      message(text: string, options?: unknown): Promise<void>;
      confirm(text: string, options?: unknown): Promise<boolean>;
    } | null;
    shell?: { showItemInFolder?(path: string): Promise<void> } | null;
    readHostFile?(path: string): Promise<{ dataBase64: string }>;
    writeHostFile?(request: { path: string; dataBase64: string }): Promise<void>;
    listHostDir?(path: string): Promise<{ name: string; path: string; kind: string; size: number; lastModified?: number | null }[]>;
    getPluginLocalStateValue?<T>(plugin?: string, key?: string, scheme?: string | null): Promise<T | null>;
    savePluginLocalStateValue?(plugin?: string, key?: string, value?: unknown, scheme?: string | null): Promise<void>;
    shellShowItemInFolder?(path: string): void;
    platform?: string;
  }

  interface Window {
    otools?: OtoolsApiLocal;
  }
}
