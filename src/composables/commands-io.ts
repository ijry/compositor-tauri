/**
 * 文件与视图命令
 * ---------------------------------------------------------------
 * 新建/打开/保存工程包、导入图片与 PSD、相机 RAW、导出 PNG/JPEG/WebP/PSD，
 * 以及撤销重做、缩放视图、主题与最近工程。
 */
import { createBlankLayer, createDocument, createPixelLayer, insertLayer } from '@/core/document';
import { compositeDocument } from '@/core/engine/compositor';
import { decodeImageBytes, encodeImage, IMAGE_OPEN_FILTERS, IMAGE_SAVE_FILTERS, type ExportOptions } from '@/io/imageIO';
import { isRawExtension, loadCompProject as importCompProject, saveCompProject as exportCompProject, watchCompProject, type CompWatcher } from '@/io/compProject';
import { decodeRaw, defaultRawSettings, developRawImage } from '@/io/raw';
import { buildSample } from '@/io/samples';
import { setTheme, themeLabel } from '@/composables/useTheme';
import { exportPsd, importPsd } from '@/io/psd';
import {
  confirmMessage, downloadInBrowser, fileName, joinPath, loadState, pickDirectory, pickFiles, pickSavePath,
  saveBytes, saveState, showMessage,
} from '@/platform/host';
import type { EditorApi } from '@/types/editor';
import type { CompDocument } from '@/types/document';
import type { ExportFormat } from '@/io/imageIO';

/** 读取最近工程列表（启动页与菜单共用） */
export async function loadRecentProjects(): Promise<string[]> {
  return loadState<string[]>(RECENT_KEY, []);
}
/** 依赖：由 useEditor 注入的宿主函数 */
export interface IoDependencies {
  openDocument(document: CompDocument): void;
  reloadDocument(document: CompDocument): void;
  currentHistory(): { undo(): string | null; redo(): string | null; clear(): void } | null;
  closeCurrent(): void;
  setViewport(patch: { zoom?: number; centerX?: number; centerY?: number }): void;
  fitCanvas(): void;
  actualPixels(): void;
  zoomStep(direction: 1 | -1): void;
  toggleUi(key: 'rulers' | 'grid' | 'guides' | 'transformControls'): void;
  openDialog(name: string, payload?: unknown): void;
  invalidate(): void;
}

/** 最近工程（保存在宿主本地状态里） */
const RECENT_KEY = 'compositor.recent';

/** 当前打开工程的监视器 */
let watcher: CompWatcher | null = null;

export function createIoCommands(api: EditorApi, deps: IoDependencies) {
  /** 记录最近工程 */
  const rememberRecent = async (path: string): Promise<void> => {
    const list = await loadState<string[]>(RECENT_KEY, []);
    const next = [path, ...list.filter((item) => item !== path)].slice(0, 12);
    await saveState(RECENT_KEY, next);
  };

  /** 打开最近工程列表 */
  const recentProjects = loadRecentProjects;

  /**
   * 当前文档（延迟解析）
   * ---------------------------------------------------------------
   * newCanvas 在还没有文档时就会被调用，因此这里用代理把 doc
   * 的读写转发到「调用时的当前文档」。
   */
  const doc = new Proxy({} as CompDocument, {
    get(_target, key) {
      const document = api.doc;
      return document[key as keyof CompDocument];
    },
    set(_target, key, value) {
      const document = api.doc;
      (document as unknown as Record<string, unknown>)[key as string] = value;
      return true;
    },
  });

  const run = async (name: string, payload?: unknown): Promise<void> => {
    switch (name) {
      /* ---------------- 新建 ---------------- */
      case 'newCanvas': {
        const options = (payload as { width?: number; height?: number; name?: string; resolution?: number } | undefined) ?? {};
        const document = createDocument(
          Math.max(1, Math.round(options.width ?? 1920)),
          Math.max(1, Math.round(options.height ?? 1080)),
          options.name ?? '未命名',
        );
        document.resolution = options.resolution ?? 72;
        // 背景层：白色不透明，方便直接作画
        const background = createPixelLayer('背景', {
          width: document.width,
          height: document.height,
          data: (() => {
            const data = new Uint8ClampedArray(document.width * document.height * 4);
            for (let i = 0; i < data.length; i += 4) {
              data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
            }
            return data;
          })(),
        });
        document.layers.push(background);
        document.activeLayerId = background.id;
        deps.openDocument(document);
        deps.fitCanvas();
        break;
      }

      /* ---------------- 导入图片 ---------------- */
      case 'openImage': {
        const files = await pickFiles(IMAGE_OPEN_FILTERS, '导入图片');
        if (files.length === 0) break;
        await importFiles(files, doc);
        break;
      }

      /* ---------------- 导入 PSD ---------------- */
      case 'openPsd': {
        const files = await pickFiles([{ name: 'Photoshop', extensions: ['psd', 'psb'] }], '导入 Photoshop 文档');
        const file = files[0];
        if (!file) break;
        const result = importPsd(file.data, file.name.replace(/\.[^.]+$/, ''));
        deps.openDocument(result.document);
        deps.fitCanvas();
        deps.openDialog('psdReport', { report: result.report });
        break;
      }

      /* ---------------- 导入相机 RAW ---------------- */
      case 'openRaw': {
        const files = await pickFiles([{ name: '相机 RAW', extensions: ['dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'pef', 'srw'] }], '导入相机 RAW');
        const file = files[0];
        if (!file) break;
        try {
          const raw = decodeRaw(file.data);
          const preview = developRawImage(raw, raw.settings);
          // RAW 作为一个「可再次显影」的特殊图层进入文档
          const layer = createPixelLayer(`RAW ${raw.cameraModel}`, preview);
          layer.text = null;
          layer.name = `RAW · ${raw.cameraModel}`;
          insertLayer(doc, layer);
          (layer as unknown as { rawData: unknown }).rawData = raw;
          deps.openDialog('rawDevelop', { layerId: layer.id });
          deps.invalidate();
        } catch (error) {
          await showMessage(`无法解码该 RAW 文件：${(error as Error).message}`, 'warning');
        }
        break;
      }

      /* ---------------- 工程包 ---------------- */
      case 'openComp': {
        const directory = await pickDirectory('选择 .comp 工程包文件夹');
        if (!directory) break;
        await openCompDirectory(directory);
        break;
      }
      case 'openRecent': {
        const path = String(payload ?? '');
        if (path) await openCompDirectory(path);
        break;
      }
      case 'saveComp': {
        const target=api.doc;
        if (target.saving) return;
        if (!target.packagePath) {await run('saveCompAs');return;}
        target.saving=true;deps.invalidate();
        const stamp=target.updatedAt;
        try {
          const result=await exportCompProject(target,target.packagePath);
          if(result){if(target.updatedAt===stamp)target.dirty=false;await rememberRecent(result);api.status(`已保存到 ${result}`);}
          else api.status('保存失败：旧工程未替换，请检查宿主目录权限');
        } catch(error){api.status(`保存失败：${(error as Error).message}`);}
        finally{target.saving=false;deps.invalidate();}
        break;
      }
      case 'saveCompAs': {
        const target=api.doc;const directory=await pickDirectory('保存 .comp 工程包');
        if(!directory || target.saving)break;
        target.saving=true;deps.invalidate();const stamp=target.updatedAt;
        try {
          const result=await exportCompProject(target,directory);
          if(result){target.packagePath=result;target.name=fileName(result);if(target.updatedAt===stamp)target.dirty=false;await rememberRecent(result);api.status(`已保存到 ${result}`);}
          else api.status('另存失败，原工程路径保持不变');
        }catch(error){api.status(`保存失败：${(error as Error).message}`);}
        finally{target.saving=false;deps.invalidate();}
        break;
      }
      case 'watchComp': {
        const path = doc.packagePath;
        if (!path) break;
        watcher?.stop();
        watcher = watchCompProject(path, async () => {
          try {
            const reloaded = await importCompProject(path);
            deps.reloadDocument(reloaded);
            api.status('工程已从磁盘重新载入');
          } catch {
            api.status('检测到工程变化，但文件尚不可用（可能仍在写入）');
          }
        }, () => undefined);
        break;
      }
      case 'unwatchComp': {
        watcher?.stop();
        watcher = null;
        break;
      }

      /* ---------------- 导出 ---------------- */
      case 'exportImage': {
        const options = (payload as ExportOptions) ?? { format: 'png' as ExportFormat, quality: 0.92, scale: 1, background: [255, 255, 255] as [number, number, number] };
        const composite = compositeDocument(doc, Math.max(1, Math.round(doc.width * options.scale)), Math.max(1, Math.round(doc.height * options.scale)), { scale: options.scale, limitAdjustmentsBySelection: false }).buffer;
        const blob = await encodeImage(composite, options);
        const extension = options.format === 'jpeg' ? 'jpg' : options.format;
        const defaultName = `${doc.name}.${extension}`;
        const path = await pickSavePath(defaultName, IMAGE_SAVE_FILTERS, '导出图片');
        if (path) {
          const ok = await saveBytes(path, new Uint8Array(await blob.arrayBuffer()), blob.type);
          api.status(ok ? `已导出 ${path}` : '导出失败');
        } else {
          downloadInBrowser(defaultName, new Uint8Array(await blob.arrayBuffer()), blob.type);
          api.status(`已导出 ${defaultName}`);
        }
        break;
      }
      case 'exportPsd': {
        const data = exportPsd(doc);
        const defaultName = `${doc.name}.psd`;
        const path = await pickSavePath(defaultName, [{ name: 'Photoshop', extensions: ['psd'] }], '导出 PSD');
        if (path) {
          const ok = await saveBytes(path, new Uint8Array(data), 'image/vnd.adobe.photoshop');
          api.status(ok ? `已导出 ${path}` : '导出失败');
        } else {
          downloadInBrowser(defaultName, new Uint8Array(data), 'image/vnd.adobe.photoshop');
          api.status(`已导出 ${defaultName}`);
        }
        break;
      }

      /* ---------------- 示例工程 ---------------- */
      case 'sample': {
        const sample = buildSample(String(payload ?? ''));
        if (!sample) break;
        deps.openDocument(sample);
        deps.fitCanvas();
        api.status(`已打开示例：${sample.name}`);
        break;
      }

      /* ---------------- 主题 ---------------- */
      case 'setTheme': {
        const mode = (payload as 'dark' | 'light' | 'system') ?? 'dark';
        setTheme(mode);
        api.status(`主题已切换为：${themeLabel[mode]}`);
        break;
      }
      /* ---------------- 历史 ---------------- */
      case 'undo': {
        const history = deps.currentHistory();
        const label = history?.undo();
        api.status(label ? `撤销：${label}` : '没有可撤销的操作');
        deps.invalidate();
        break;
      }
      case 'redo': {
        const history = deps.currentHistory();
        const label = history?.redo();
        api.status(label ? `重做：${label}` : '没有可重做的操作');
        deps.invalidate();
        break;
      }

      /* ---------------- 视图 ---------------- */
      case 'zoomIn': deps.zoomStep(1); break;
      case 'zoomOut': deps.zoomStep(-1); break;
      case 'fitCanvas': deps.fitCanvas(); break;
      case 'actualPixels': deps.actualPixels(); break;
      case 'toggleRulers': deps.toggleUi('rulers'); break;
      case 'toggleGrid': deps.toggleUi('grid'); break;
      case 'toggleGuides': deps.toggleUi('guides'); break;
      case 'toggleTransformControls': deps.toggleUi('transformControls'); break;
      case 'gridSettings': deps.openDialog('gridSettings'); break;
      case 'shortcuts': deps.openDialog('shortcuts'); break;
      case 'about': deps.openDialog('about'); break;
      case 'recentList': deps.openDialog('recent', { items: await recentProjects() }); break;
      case 'closeDocument': {
        if (doc.dirty) {
          const ok = await confirmMessage(`「${doc.name}」有未保存的修改，确定关闭吗？`, '关闭文档');
          if (!ok) break;
        }
        watcher?.stop();
        watcher = null;
        deps.closeCurrent();
        break;
      }
      case 'applyRawDevelop': {
        const options = payload as { layerId: string; raw: import('@/types/document').RawImage; settings: import('@/types/document').CameraRawSettings };
        const layer = doc.layers.find((item) => item.id === options.layerId);
        if (!layer || layer.kind !== 'pixel') break;
        const before = api.snapshotLayer(layer.id);
        layer.pixels = developRawImage(options.raw, options.settings);
        layer.transform.size = [layer.pixels.width, layer.pixels.height];
        layer.contentKey += 1;
        api.markLayerDirty(layer.id);
        const after = api.snapshotLayer(layer.id);
        api.pushHistory(
          '相机 RAW 显影',
          () => { if (before) api.restoreLayer(layer.id, before); },
          () => { if (after) api.restoreLayer(layer.id, after); },
          (before?.pixels?.data.length ?? 0) * 2,
        );
        deps.invalidate();
        break;
      }
      default:
        break;
    }
  };

  /** 打开 .comp 工程目录 */
  const openCompDirectory = async (directory: string): Promise<void> => {
    try {
      const document = await importCompProject(directory);
      deps.openDocument(document);
      await rememberRecent(directory);
      deps.fitCanvas();
      api.status(`已打开工程 ${document.name}`);
    } catch (error) {
      await showMessage(`打开工程失败：${(error as Error).message}`, 'warning');
    }
  };

  /** 导入一批图片文件 */
  const importFiles = async (files: { name: string; data: ArrayBuffer }[], document: CompDocument): Promise<void> => {
    for (const file of files) {
      const name = file.name;
      if (/\.psd$/i.test(name) || /\.psb$/i.test(name)) {
        const result = importPsd(file.data, name.replace(/\.[^.]+$/, ''));
        deps.openDocument(result.document);
        deps.openDialog('psdReport', { report: result.report });
        continue;
      }
      if (isRawExtension(name)) {
        try {
          const raw = decodeRaw(file.data);
          const layer = createPixelLayer(`RAW ${raw.cameraModel}`, developRawImage(raw, raw.settings));
          insertLayer(document, layer);
          deps.openDialog('rawDevelop', { layerId: layer.id });
        } catch (error) {
          await showMessage(`无法解码 ${name}：${(error as Error).message}`, 'warning');
        }
        continue;
      }
      try {
        const pixels = await decodeImageBytes(file.data);
        const layer = createPixelLayer(name.replace(/\.[^.]+$/, ''), pixels);
        if (document.layers.length === 0 && document.width > 0) {
          // 第一张图片作为画布底图：调整画布尺寸
          document.width = pixels.width;
          document.height = pixels.height;
        }
        layer.transform.origin = [Math.round((document.width - pixels.width) / 2), Math.round((document.height - pixels.height) / 2)];
        insertLayer(document, layer);
      } catch (error) {
        await showMessage(`无法导入 ${name}：${(error as Error).message}`, 'warning');
      }
    }
    deps.invalidate();
  };

  return { run, recentProjects };
}

export { defaultRawSettings, joinPath };
