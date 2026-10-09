import { userErrorMessage } from '@/core/userMessage';
import { pixelDepth, documentDepth, convertBufferDepth } from '@/core/pixelFormat';
import { createBuffer } from '@/core/pixels';
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
import { exportPsd, importPsd, planPsdExport } from '@/io/psd';
import {
  confirmMessage, downloadInBrowser, fileName, joinPath, loadState, pickDirectory, pickFiles, pickSavePath,
  saveBytes, saveState, showMessage, isOtoolsHost, isTauriHost,
} from '@/platform/host';
import type { EditorApi } from '@/types/editor';
import type { CompDocument } from '@/types/document';
import type { ExportFormat } from '@/io/imageIO';

/** 读取最近工程列表（启动页与菜单共用） */
export async function loadRecentProjects(): Promise<string[]> {
  return loadState<string[]>(RECENT_KEY, []);
}
export interface ReloadGuard { target: CompDocument; revision: number; isCurrent?: () => boolean }
export type ReloadResult = 'reloaded' | 'kept' | 'retry' | 'closed';

/** 依赖：由 useEditor 注入的宿主函数 */
export interface IoDependencies {
  openDocument(document: CompDocument): void;
  reloadDocument(document: CompDocument, guard?: ReloadGuard): Promise<ReloadResult>;
  findOpenProject(path: string): CompDocument | undefined;
  documentRevision(document: CompDocument): number;
  canReloadDocument(document: CompDocument): boolean;
  currentHistory(): { undo(): string | null; redo(): string | null; clear(): void } | null;
  closeCurrent(): Promise<boolean>;
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

/** 每个文档独立监视，关闭一个标签不会停止另一个标签的监视器。 */
const watchers = new Map<string, CompWatcher>();
export function stopWatchingDocument(id: string): void {
  watchers.get(id)?.stop();
  watchers.delete(id);
}

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

  const clone=<T>(value:T):T=>{if(value instanceof Float32Array)return new Float32Array(value) as T;if(value instanceof Uint8ClampedArray)return new Uint8ClampedArray(value) as T;if(value instanceof Uint8Array)return new Uint8Array(value) as T;if(Array.isArray(value))return value.map(clone) as T;if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clone(v)])) as T;return value;};
  type ImportState={layers:CompDocument['layers'];activeLayerId:string|null;width:number;height:number;bitDepth?:8|16};
  const captureImport=(d:CompDocument):ImportState=>clone({layers:d.layers,activeLayerId:d.activeLayerId,width:d.width,height:d.height,bitDepth:d.bitDepth});
  const restoreImport=(d:CompDocument,state:ImportState)=>{Object.assign(d,clone(state));deps.invalidate();};
  const imports=new Map<string,{target:CompDocument;before:ImportState;dirty:boolean;committed:boolean}>();
  function recordImport(target:CompDocument,before:ImportState,label:string){const after=captureImport(target);api.pushHistory(label,()=>restoreImport(target,before),()=>restoreImport(target,after));}
  function stageRaw(raw:import('@/types/document').RawImage):void {
    let target:CompDocument;try{target=api.doc;}catch{target=createDocument(raw.width,raw.height,'相机RAW',pixelDepth(raw.data));deps.openDocument(target);}
    const before=captureImport(target),dirty=target.dirty,layer=createPixelLayer(`RAW · ${raw.cameraModel}`,developRawImage(raw,raw.settings));
    insertLayer(target,layer);if(pixelDepth(layer.pixels!)===16)target.bitDepth=16;(layer as unknown as {rawData:unknown}).rawData=raw;
    const transaction={target,before,dirty,committed:false};imports.set(layer.id,transaction);
    deps.openDialog('rawDevelop',{layerId:layer.id,onCancel:()=>{if(!transaction.committed){restoreImport(target,before);target.dirty=dirty;}imports.delete(layer.id);}});deps.invalidate();
  }

  const run = async (name: string, payload?: unknown): Promise<void> => {
    switch (name) {
      /* ---------------- 新建 ---------------- */
      case 'newCanvas': {
        if(!payload){deps.openDialog('newCanvas');break;}
        const options = (payload as { width?: number; height?: number; name?: string; resolution?: number; bitDepth?:8|16 } | undefined) ?? {};
        const document = createDocument(
          Math.max(1, Math.round(options.width ?? 1920)),
          Math.max(1, Math.round(options.height ?? 1080)),
          options.name ?? '未命名',
          options.bitDepth===16?16:8,
        );
        document.resolution = options.resolution ?? 72;
        // 背景层：白色不透明，方便直接作画
        const background = createPixelLayer('背景', createBuffer(document.width,document.height,[255,255,255,255],document.bitDepth));
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
        let target:CompDocument;try{target=api.doc;}catch{target=createDocument(1,1,'导入图片');deps.openDocument(target);}
        const before=captureImport(target);
        await importFiles(files,target);
        if(target.layers.length!==before.layers.length)recordImport(target,before,'导入图片');
        break;
      }

      /* ---------------- 导入 PSD ---------------- */
      case 'openPsd': {
        const files = await pickFiles([{ name: 'Photoshop', extensions: ['psd', 'psb'] }], '导入 Photoshop 文档');
        const file = files[0];
        if (!file) break;
        const result = importPsd(file.data, file.name.replace(/\.[^.]+$/, ''));
        deps.openDialog('psdReport', { report: result.report, apply:()=>{deps.openDocument(result.document);deps.fitCanvas();} });
        break;
      }

      /* ---------------- 导入相机 RAW ---------------- */
      case 'openRaw': {
        const files = await pickFiles([{ name: '相机 RAW', extensions: ['dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'pef', 'srw'] }], '导入相机 RAW');
        const file = files[0];
        if (!file) break;
        try {
          const raw = decodeRaw(file.data);
          stageRaw(raw);
        } catch (error) {
          await showMessage(`无法解码该 RAW 文件：${userErrorMessage(error)}`, 'warning');
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
        const stamp=deps.documentRevision(target);
        try {
          const result=await exportCompProject(target,target.packagePath);
          if(result){await watchers.get(target.id)?.acknowledge();if(deps.documentRevision(target)===stamp)target.dirty=false;await rememberRecent(result);api.status(`已保存到 ${result}`);}
          else api.status('保存失败：旧工程未替换，请检查宿主目录权限');
        } catch(error){api.status(`保存失败：${userErrorMessage(error)}`);}
        finally{target.saving=false;deps.invalidate();}
        break;
      }
      case 'saveCompAs': {
        const target=api.doc;const directory=await pickDirectory('保存 .comp 工程包');
        if(!directory || target.saving)break;
        target.saving=true;deps.invalidate();const stamp=deps.documentRevision(target);
        try {
          const result=await exportCompProject(target,directory);
          if(result){if(target.packagePath!==result)stopWatchingDocument(target.id);else await watchers.get(target.id)?.acknowledge();target.packagePath=result;target.name=fileName(result);if(deps.documentRevision(target)===stamp)target.dirty=false;await rememberRecent(result);api.status(`已保存到 ${result}`);}
          else api.status('另存失败，原工程路径保持不变');
        }catch(error){api.status(`保存失败：${userErrorMessage(error)}`);}
        finally{target.saving=false;deps.invalidate();}
        break;
      }
      case 'watchComp': {
        const target = api.doc, path = target.packagePath;
        if (!path) break;
        stopWatchingDocument(target.id);
        const watcher = watchCompProject(path, async () => {
          const current = deps.findOpenProject(path);
          if (watchers.get(target.id) !== watcher || !current || current.id !== target.id) return true;
          if (!deps.canReloadDocument(current)) return false;
          const dirty = current.dirty;
          const guard = { target: current, revision: deps.documentRevision(current),
            isCurrent: () => watchers.get(target.id) === watcher && current.dirty === dirty };
          try {
            const reloaded = await importCompProject(path);
            // stop 发生在异步读取期间时，迟到结果不能再替换文档。
            if (watchers.get(target.id) !== watcher) return true;
            const result = await deps.reloadDocument(reloaded, guard);
            if (result === 'reloaded') api.status('工程已从磁盘重新载入');
            else if (result === 'kept') api.status('已保留本地内容，未重新载入');
            return result !== 'retry';
          } catch {
            api.status('检测到工程变化，但文件尚不可用（可能仍在写入）');
            return false;
          }
        }, () => undefined);
        watchers.set(target.id, watcher);
        break;
      }
      case 'unwatchComp': {
        stopWatchingDocument(api.doc.id);
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
        // 提示与编码共享同一快照；等待用户确认期间切换标签/继续编辑不会导错工程。
        const snapshot=clone(api.doc),plan=planPsdExport(snapshot);
        if(plan.warning&&!await confirmMessage(plan.warning,'PSD 导出兼容性确认')) {
          api.status('已取消 PSD 导出，原工程未修改');break;
        }
        const data=exportPsd(snapshot,{rasterizeAdjustments:plan.mode==='visible-composite'});
        const defaultName=`${snapshot.name}.psd`;
        const path=await pickSavePath(defaultName,[{name:'Photoshop',extensions:['psd']}],'导出 PSD');
        const suffix=plan.mode==='visible-composite'?'（调整效果已合并栅格化；可编辑工程请保留.comp）':'';
        if(path){
          const ok=await saveBytes(path,new Uint8Array(data),'image/vnd.adobe.photoshop');
          api.status(ok?`已导出 ${path}${suffix}`:'导出失败');
        }else if(isOtoolsHost()||isTauriHost()){
          // 原生保存对话框取消不是浏览器降级请求，不能再私自下载一份文件。
          api.status('已取消 PSD 导出，未写入文件');
        }else{
          downloadInBrowser(defaultName,new Uint8Array(data),'image/vnd.adobe.photoshop');
          api.status(`已导出 ${defaultName}${suffix}`);
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
        await deps.closeCurrent();
        break;
      }
      case 'applyRawDevelop': {
        const options=payload as {layerId:string;raw:import('@/types/document').RawImage;settings:import('@/types/document').CameraRawSettings};
        const transaction=imports.get(options.layerId),target=transaction?.target??api.doc,layer=target.layers.find(l=>l.id===options.layerId);
        if(!layer||layer.kind!=='pixel')break;
        const before=api.snapshotLayer(layer.id);layer.pixels=developRawImage(options.raw,options.settings);layer.transform.size=[layer.pixels.width,layer.pixels.height];layer.contentKey++;api.markLayerDirty(layer.id);
        if(transaction){transaction.committed=true;recordImport(target,transaction.before,'导入相机RAW');}
        else{const after=api.snapshotLayer(layer.id);api.pushHistory('相机RAW显影',()=>{if(before)api.restoreLayer(layer.id,before);},()=>{if(after)api.restoreLayer(layer.id,after);});}
        deps.invalidate();break;
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
      await showMessage(`打开工程失败：${userErrorMessage(error)}`, 'warning');
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
          stageRaw(raw);
        } catch (error) {
          await showMessage(`无法解码 ${name}：${userErrorMessage(error)}`, 'warning');
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
        await showMessage(`无法导入 ${name}：${userErrorMessage(error)}`, 'warning');
      }
    }
    deps.invalidate();
  };

  return { run, recentProjects };
}

export { defaultRawSettings, joinPath };
