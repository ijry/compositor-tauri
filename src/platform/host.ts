/**
 * 宿主运行环境适配层
 * ---------------------------------------------------------------
 * 插件可能运行在三种环境：
 *  1. otools 宿主（window.otools 提供 dialog / readHostFile / writeHostFile / listHostDir）
 *  2. Tauri 宿主（@tauri-apps/api 的 invoke 与 dialog 插件）
 *  3. 纯浏览器（开发预览，input[type=file] 与下载回退）
 * 业务代码只调用这里导出的函数，不需要判断运行时。
 */

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface OpenFileResult {
  /** 宿主路径，浏览器模式下为空 */
  path: string;
  name: string;
  data: ArrayBuffer;
}

export interface HostDirEntry {
  name: string;
  path: string;
  kind: string;
  size: number;
  lastModified?: number | null;
}

/** 是否运行在 otools 宿主中 */
export function isOtoolsHost(): boolean {
  return typeof window !== 'undefined' && Boolean(window.otools);
}

/** 是否运行在 Tauri 宿主中 */
export function isTauriHost(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

/** 宿主平台标识 */
export function platformName(): string {
  const api = window.otools;
  if (api?.platform) return String(api.platform);
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')) return 'macos';
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Win')) return 'windows';
  return 'linux';
}

/** 路径分隔符 */
export function pathSeparator(): string {
  return platformName() === 'windows' ? '\\' : '/';
}

/** 拼接路径 */
export function joinPath(base: string, ...parts: string[]): string {
  const separator = pathSeparator();
  const cleaned = parts
    .filter((part) => part.length > 0)
    .map((part, index) => (index === 0 ? part.replace(/[/\\]+$/, '') : part.replace(/^[/\\]+|[/\\]+$/g, '')));
  return [base.replace(/[/\\]+$/, ''), ...cleaned].join(separator);
}

/* ------------------------------ 对话框 ------------------------------ */

/** 打开文件（宿主优先，浏览器回退到 input） */
export async function pickFiles(filters: FileFilter[], title = '选择文件'): Promise<OpenFileResult[]> {
  const api = window.otools;
  if (api?.dialog?.open) {
    const result = await api.dialog.open({ title, multiple: true, filters });
    const paths = normalizeDialogPaths(result);
    const files: OpenFileResult[] = [];
    for (const path of paths) {
      const data = await readFile(path);
      if (data) files.push({ path, name: fileName(path), data });
    }
    return files;
  }
  return pickFilesInBrowser(filters);
}

/** 打开单个文件 */
export async function pickFile(filters: FileFilter[], title = '选择文件'): Promise<OpenFileResult | null> {
  const files = await pickFiles(filters, title);
  return files[0] ?? null;
}

/** 保存文件（返回宿主路径；浏览器模式返回空串） */
export async function pickSavePath(defaultName: string, filters: FileFilter[], title = '保存'): Promise<string | null> {
  const api = window.otools;
  if (api?.dialog?.save) {
    return api.dialog.save({ title, defaultPath: defaultName, filters });
  }
  return null;
}

/** 选择目录 */
export async function pickDirectory(title = '选择文件夹'): Promise<string | null> {
  const api = window.otools;
  if (api?.dialog?.open) {
    const result = await api.dialog.open({ title, directory: true, multiple: false });
    const paths = normalizeDialogPaths(result);
    return paths[0] ?? null;
  }
  return null;
}

/** 消息框 */
export async function showMessage(text: string, kind: 'info' | 'warning' | 'error' = 'info', title = '合成器'): Promise<void> {
  const api = window.otools;
  if (api?.dialog?.message) {
    await api.dialog.message(text, { title, kind });
    return;
  }
  if (typeof window !== 'undefined') window.alert(text);
}

/** 确认框 */
export async function confirmMessage(text: string, title = '合成器'): Promise<boolean> {
  const api = window.otools;
  if (api?.dialog?.confirm) return api.dialog.confirm(text, { title });
  if (typeof window !== 'undefined') return window.confirm(text);
  return false;
}

function normalizeDialogPaths(result: unknown): string[] {
  if (Array.isArray(result)) {
    return result
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'path' in item) return String((item as { path: unknown }).path);
        return '';
      })
      .filter((item) => item.length > 0);
  }
  if (typeof result === 'string' && result) return [result];
  if (result && typeof result === 'object' && 'path' in result) return [String((result as { path: unknown }).path)];
  return [];
}

/* ------------------------------ 文件读写 ------------------------------ */

/** 读取文件为 ArrayBuffer */
export async function readFile(path: string): Promise<ArrayBuffer | null> {
  const api = window.otools;
  if (api?.readHostFile) {
    try {
      const payload = await api.readHostFile(path);
      return base64ToArrayBuffer(payload.dataBase64);
    } catch (error) {
      console.error('读取文件失败：', path, error);
      return null;
    }
  }
  return null;
}

/** 读取文件为文本（manifest.json 等） */
export async function readTextFile(path: string): Promise<string | null> {
  const buffer = await readFile(path);
  if (!buffer) return null;
  return new TextDecoder().decode(buffer);
}

/** 写入文件 */
export async function writeFile(path: string, data: ArrayBuffer | Uint8Array): Promise<boolean> {
  const api = window.otools;
  const buffer = (data instanceof Uint8Array ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data) as ArrayBuffer;
  if (api?.writeHostFile) {
    try {
      await api.writeHostFile({ path, dataBase64: arrayBufferToBase64(buffer) });
      return true;
    } catch (error) {
      console.error('写入文件失败：', path, error);
      return false;
    }
  }
  return false;
}

/** 使用宿主已注册的重命名接口提交临时工程；不支持时拒绝覆盖旧工程。 */
export function canRenameHostEntry(): boolean {
  return typeof window.otools?.invokeNativeRaw === 'function';
}
export async function renameHostEntry(from: string, to: string): Promise<void> {
  const invoke = window.otools?.invokeNativeRaw;
  if (!invoke) throw new Error('当前宿主不支持安全工程保存，请升级宿主');
  await invoke('tools_webview_rename_entry', { request: { from, to } });
}
/** 仅供清理本次保存生成的临时/备份目录，不清理用户源工程。 */
export async function removeTemporaryEntry(path: string): Promise<void> {
  const invoke = window.otools?.invokeNativeRaw;
  if (invoke) await invoke('tools_webview_remove_entry', { path, recursive: true });
}

/** 写入文本 */
export async function writeTextFile(path: string, text: string): Promise<boolean> {
  return writeFile(path, new TextEncoder().encode(text));
}

/** 列举目录 */
export async function listDirectory(path: string): Promise<HostDirEntry[]> {
  const api = window.otools;
  if (!api?.listHostDir) return [];
  try {
    return await api.listHostDir(path);
  } catch (error) {
    console.error('列举目录失败：', path, error);
    return [];
  }
}

/** 删除文件（若宿主支持） */
export async function deleteFile(path: string): Promise<boolean> {
  const api = window.otools;
  const invoker = (api as unknown as { invokeNativeRaw?: <T>(method: string, payload?: unknown) => Promise<T> })?.invokeNativeRaw;
  if (!invoker) return false;
  try {
    await invoker('deleteFile', { path });
    return true;
  } catch {
    return false;
  }
}

/** 在文件管理器中定位 */
export function showInFolder(path: string): void {
  const api = window.otools;
  if (api?.shellShowItemInFolder) api.shellShowItemInFolder(path);
  else if (api?.shell?.showItemInFolder) api.shell.showItemInFolder(path);
}

/* ------------------------------ 浏览器回退 ------------------------------ */

function pickFilesInBrowser(filters: FileFilter[]): Promise<OpenFileResult[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    const accept = filters.flatMap((filter) => filter.extensions.map((extension) => `.${extension}`)).join(',');
    if (accept) input.accept = accept;
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      const results: OpenFileResult[] = [];
      for (const file of files) {
        results.push({ path: '', name: file.name, data: await file.arrayBuffer() });
      }
      resolve(results);
    };
    input.click();
  });
}

/** 浏览器模式下触发下载 */
export function downloadInBrowser(name: string, data: BlobPart | Uint8Array | ArrayBuffer, mime: string): void {
  const blob = new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 通用保存：优先写宿主，浏览器则下载 */
export async function saveBytes(pathOrName: string, data: ArrayBuffer | Uint8Array, mime: string): Promise<string | null> {
  const ok = await writeFile(pathOrName, data);
  if (ok) return pathOrName;
  downloadInBrowser(pathOrName.split(/[/\\]/).pop() ?? pathOrName, data, mime);
  return null;
}

/* ------------------------------ 本地状态 ------------------------------ */

/** 读取插件本地状态（偏好设置、最近工程等） */
export async function loadState<T>(key: string, fallback: T): Promise<T> {
  const api = window.otools;
  if (!api) return fallback;
  try {
    const value = await api.getPluginLocalStateValue?.<T>(undefined, key) ?? null;
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/** 保存插件本地状态 */
export async function saveState<T>(key: string, value: T): Promise<void> {
  const api = window.otools;
  if (!api?.savePluginLocalStateValue) return;
  try {
    await api.savePluginLocalStateValue(undefined, key, value);
  } catch (error) {
    console.warn('保存本地状态失败：', key, error);
  }
}

/* ------------------------------ 工具函数 ------------------------------ */

/** 取文件名（含扩展名） */
export function fileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

/** 取扩展名（不含点，小写） */
export function fileExtension(path: string): string {
  const name = fileName(path);
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
