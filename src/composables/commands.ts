import { documentDepth } from '@/core/pixelFormat';
/**
 * 命令层
 * ---------------------------------------------------------------
 * 菜单项、快捷键、面板按钮与对话框最终都调用这里，
 * 保证「同一个操作在任何入口下行为一致」，并且都会写入历史。
 */
import {
  addLayerMask, applyLayerMask, createAdjustmentLayer, createBlankLayer, createGroupLayer, createPixelLayer,
  descendantsOf,
  duplicateLayer as duplicateLayerCore, flipCanvas, groupLayers as groupLayersCore, insertLayer as insertLayerCore,
  maskFromSelection, mergeDown as mergeDownCore, mergeGroup as mergeGroupCore,
  mergeLayers as mergeLayersCore, flattenVisible as flattenCore, nudgeLayerOrder, removeLayers as removeLayersCore,
  cropDocument, resizeCanvas, resizeImage, rotateCanvas, trimDocument, ungroupLayers as ungroupCore, uuid,
} from '@/core/document';
import { contentAwareFill } from '@/core/filters/contentAware';
import {
  applyBloom, applyDenoise, applyDither, applyLensCorrection, applySharpen, applyTonalContrast, applyVignette, removeBackground,
} from '@/core/filters/creative';
import { applyAddNoise } from '@/core/filters/adjust';
import { compositeDocument, compositeInto, flattenDocument } from '@/core/engine/compositor';
import { createBuffer, cloneBuffer } from '@/core/pixels';
import { captureClipboard, pasteClipboard, type ClipboardPayload } from '@/core/clipboard';
import { resolveEditTarget, fillEditTarget, projectEditSelection, blendFilterResult, invertEditTarget } from '@/core/engine/editTarget';
import { createMaskSampler } from '@/core/engine/maskGeometry';
import { combineSelection, createSelection, gaussianBlurMask, invertSelection } from '@/core/selection';
import { applyColorRange, applySelectionOperation, transformSelectionOutline } from '@/tools/selection';
import { magicWand, selectSubject } from '@/core/ops/selectionOps';
import { importPsd } from '@/io/psd';




import { createFilterSession } from '@/composables/filterSession';
import { createIoCommands } from '@/composables/commands-io';
import { actualPixels, closeCurrent, currentHistory, fitCanvas, hasDocument, invalidate, openDialog, openDocument, reloadDocument, findOpenProject, documentRevision, canReloadDocument, toggleUi, zoomStep } from '@/composables/useEditor';
import type { EditorApi } from '@/types/editor';
import { BLEND_MODES } from '@/types/document';
import type { AdjustmentKind, CompDocument, Layer, PixelBuffer } from '@/types/document';

/** 剪贴板（内部实现） */
let clipboard: ClipboardPayload | null = null;

/** 命令实现 */
export function createCommands(api: EditorApi) {
  /**
   * 当前文档（延迟解析）
   * ---------------------------------------------------------------
   * 模块初始化时可能还没有打开任何文档，因此用代理把 doc 的读写
   * 转发到「调用时的当前文档」，避免初始化阶段就抛错。
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
  /** 结构历史保留独立快照，防止画布/像素历史交错后污染先前记录。 */
  interface Structure {
    bitDepth?:8|16;
    layers: Layer[];
    parents: Record<string, string | null>;
    activeLayerId: string | null;
  }
  const captureStructure = (): Structure => ({
    bitDepth:doc.bitDepth,
    layers: cloneCanvasValue(doc.layers),
    parents: Object.fromEntries(doc.layers.map(layer => [layer.id, layer.parentId ?? null])),
    activeLayerId: doc.activeLayerId,
  });
  const sameStructure = (a: Structure, b: Structure): boolean =>
    a.layers.length === b.layers.length && a.activeLayerId === b.activeLayerId &&
    a.layers.every((layer, index) => layer.id === b.layers[index]?.id && a.parents[layer.id] === b.parents[layer.id]);

  const pushStructureHistory = (label: string, before: Structure, after: Structure): void => {
    if (sameStructure(before, after)) return;
    // 捕获所属文档，异步切换标签或后续操作不会改变历史的目标。
    const target = api.doc;
    const apply = (snapshot: Structure): void => {
      target.bitDepth=snapshot.bitDepth;
      target.layers = cloneCanvasValue(snapshot.layers);
      for (const layer of target.layers) layer.parentId = snapshot.parents[layer.id] ?? null;
      target.activeLayerId = snapshot.activeLayerId;
      api.invalidate();
    };
    const retained = new Set([...before.layers, ...after.layers]);
    const bytes = [...retained].reduce((sum, layer) => sum + (layer.pixels?.data.byteLength ?? 0) + (layer.mask?.pixels.data.byteLength ?? 0) + 256, 0);
    api.pushHistory(label, () => apply(before), () => apply(after), bytes);
  };

  /** 标量属性历史按所属文档和 ID 回放，结构快照替换对象后仍然有效。 */
  function recordLayerProperty<T>(label:string,layer:Layer,before:T,after:T,write:(target:Layer,value:T)=>void):void {
    const document=api.doc,id=layer.id;
    const apply=(value:T)=>{const current=document.layers.find(item=>item.id===id);if(!current)return;write(current,value);current.contentKey+=1;api.invalidate();};
    apply(after);api.pushHistory(label,()=>apply(before),()=>apply(after),64);
  }

  /** 所有破坏性滤镜先计算完整结果，再统一按目标选区混合，不让各内核自行猜测坐标。 */
  const applyToActiveLayer = (label:string,apply:(pixels:PixelBuffer,layer:Layer)=>PixelBuffer|void):void => {
    const target=resolveEditTarget(api.activeLayer());
    if(!target || target.onMask){setStatusSafe('该滤镜需要未锁定的图像像素目标');return;}
    const coverage=projectEditSelection(api.doc,target);
    if(coverage && !coverage.some(value=>value>0))return;
    const layer=target.layer,before=api.snapshotLayer(layer.id);
    if(!before)return;
    const working=cloneBuffer(target.buffer),result=apply(working,layer)??working;
    if(!blendFilterResult(target,result,coverage))return;
    api.markLayerDirty(layer.id);
    const after=api.snapshotLayer(layer.id);
    api.pushHistory(label,()=>{api.restoreLayer(layer.id,before);},()=>{if(after)api.restoreLayer(layer.id,after);},
      ((before.pixels?.data.byteLength??0)+(before.mask?.data.byteLength??0))*2);
  };
  const setStatusSafe = (message: string): void => {
    api.status(message);
  };

  /** 这些命令在没有打开文档时也能执行（启动页可用） */
  const DOCUMENT_FREE = new Set(['newCanvas', 'openImage', 'openPsd', 'openRaw', 'openComp', 'openRecent', 'recentList', 'shortcuts', 'about', 'setTheme', 'sample']);

  const run = async (name: string, payload?: unknown): Promise<void> => {
    if (!hasDocument() && !DOCUMENT_FREE.has(name)) {
      setStatusSafe('请先新建或打开一个画布');
      return;
    }
    // 注意：这里不再取 api.doc，由顶部的惰性代理在真正访问时才解析（newCanvas 时还没有文档）
    switch (name) {
      case 'snapSettings': api.openDialog('snapSettings'); break;
      case 'cycleBlend': {const layer=api.activeLayer();if(!layer)break;const at=BLEND_MODES.indexOf(layer.blendMode),next=BLEND_MODES[(at+Number(payload)+BLEND_MODES.length)%BLEND_MODES.length]!;recordLayerProperty('切换混合模式',layer,layer.blendMode,next,(l,v)=>{l.blendMode=v;});break;}
      case 'clearGuides': {const before=doc.guides.map(g=>({...g})),target=api.doc;target.guides=[];api.pushHistory('清除参考线',()=>{target.guides=before.map(g=>({...g}));},()=>{target.guides=[];});break;}
      case 'openFilter':{const session=createFilterSession(api,String(payload));if(session)api.openDialog('filterDialog',session);else api.status('请选择未锁定的像素图层');break;}
      /* ---------------- 图层 ---------------- */
      case 'newLayer': {
        const beforeStructure = captureStructure();
        const layer = createBlankLayer(doc, '图层');
        insertLayerCore(doc, layer);
        pushStructureHistory('新建图层', beforeStructure, captureStructure());
        break;
      }
      case 'duplicateLayer': {
        if(doc.selection){const captured=captureClipboard(doc,api.activeLayer());if(captured){const before=captureStructure();pasteClipboard(doc,captured);pushStructureHistory('通过拷贝新建图层',before,captureStructure());}break;}
        const layer = api.activeLayer();
        if (!layer) break;
        const beforeStructure = captureStructure();
        const included = new Set([layer.id, ...descendantsOf(doc, layer.id).map(child => child.id)]);
        const originals = doc.layers.filter(item => included.has(item.id));
        const copies = originals.map(item => duplicateLayerCore(item, item.id === layer.id ? ' 副本' : ''));
        const mapping = new Map(originals.map((item, index) => [item.id, copies[index]!.id]));
        for (const copy of copies){copy.parentId = copy.parentId ? mapping.get(copy.parentId) ?? copy.parentId : null;if(copy.maskSourceId)copy.maskSourceId=mapping.get(copy.maskSourceId)??copy.maskSourceId;}
        const index = doc.layers.findIndex(item => item.id === layer.id);
        doc.layers.splice(index + 1, 0, ...copies);
        doc.activeLayerId = mapping.get(layer.id)!;
        pushStructureHistory('复制图层', beforeStructure, captureStructure());
        break;
      }
      case 'deleteLayer': {
        if(api.activeLayer()?.mask?.target==='mask'){await run('deleteMask');break;}
        const ids = (payload as string[] | undefined) ?? (doc.selectedLayerIds?.length ? doc.selectedLayerIds : doc.activeLayerId?[doc.activeLayerId]:[]);
        if (ids.length === 0) break;
        const beforeStructure = captureStructure();
        removeLayersCore(doc, ids);
        pushStructureHistory('删除图层', beforeStructure, captureStructure());
        break;
      }
      case 'moveLayerUp':
      case 'moveLayerDown': {
        const layer = api.activeLayer();
        if (!layer) break;
        const beforeStructure = captureStructure();
        nudgeLayerOrder(doc, layer.id, name === 'moveLayerUp' ? 1 : -1);
        pushStructureHistory('调整图层顺序', beforeStructure, captureStructure());
        break;
      }

      /** 图层面板拖放：排序 + 嵌套进组 + Option 拖拽复制 */
      case 'moveLayerTo': {
        const options = payload as {
          ids: string[];
          referenceId: string | null;
          position: 'above' | 'below' | 'inside';
          duplicate?: boolean;
        };
        if (!options || options.ids.length === 0) break;
        const beforeStructure = captureStructure();
        // 收集被拖动的图层及其子孙（子树在数组中必须连续）
        let picked: Layer[] = [];
        for (const id of options.ids) {
          const layer = doc.layers.find((item) => item.id === id);
          if (!layer) continue;
          const subTree = [layer, ...descendantsOf(doc, id)];
          for (const item of subTree) if (!picked.includes(item)) picked.push(item);
        }
        if (picked.length === 0) break;
        const pickedIds = new Set(picked.map((item) => item.id));
        // 目标位置不能落在被拖动的子树内部（否则等于没动）
        if (options.referenceId && pickedIds.has(options.referenceId)) break;

        // 保持子树原有顺序（复制时副本沿用原图层顺序）
        const order = new Map(doc.layers.map((item, index) => [item.id, index]));
        const entries = picked
          .map((layer) => ({ source: layer, order: order.get(layer.id) ?? 0 }))
          .sort((a, b) => a.order - b.order);
        const working: Layer[] = options.duplicate
          ? entries.map((entry) => duplicateLayerCore(entry.source, ' 副本'))
          : entries.map((entry) => entry.source);
        const workingIds = new Set(working.map((item) => item.id));
        // 校验：目标父级不能是被拖动图层的子孙，避免形成环
        let parentId: string | null = null;
        if (options.position === 'inside') {
          const group = doc.layers.find((item) => item.id === options.referenceId);
          if (!group || group.kind !== 'group' || workingIds.has(group.id)) break;
          parentId = group.id;
        } else if (options.referenceId) {
          const reference = doc.layers.find((item) => item.id === options.referenceId);
          parentId = reference?.parentId ?? null;
        }
        const wouldCycle = (candidate: string | null): boolean => {
          let cursor = candidate;
          let guard = 0;
          while (cursor && guard < 64) {
            guard += 1;
            if (workingIds.has(cursor)) return true;
            cursor = doc.layers.find((item) => item.id === cursor)?.parentId ?? null;
          }
          return false;
        };
        if (wouldCycle(parentId)) break;

        // Option 复制时原图层留在原位；移动时先把子树从数组中摘出
        if (!options.duplicate) doc.layers = doc.layers.filter((item) => !pickedIds.has(item.id));
        // 计算插入位置
        let insertIndex: number;
        if (options.position === 'inside' && parentId) {
          // 插到该组子树的末尾（视觉上位于组内最上方）
          const groupIndex = doc.layers.findIndex((item) => item.id === parentId);
          let last = groupIndex;
          for (let i = groupIndex + 1; i < doc.layers.length; i += 1) {
            let cursor: string | null = doc.layers[i]!.parentId;
            let guard = 0;
            while (cursor && guard < 64) {
              guard += 1;
              if (cursor === parentId) { last = i; break; }
              cursor = doc.layers.find((item) => item.id === cursor)?.parentId ?? null;
            }
            if (last === i) continue;
            break;
          }
          insertIndex = last + 1;
        } else if (options.referenceId) {
          const referenceIndex = doc.layers.findIndex((item) => item.id === options.referenceId);
          if (referenceIndex < 0) break;
          // 面板自上而下显示，视觉「上方」对应数组中更靠后
          insertIndex = options.position === 'above' ? referenceIndex + 1 : referenceIndex;
        } else {
          // 拖到空白区域 = 移动到根层最底部
          parentId = null;
          insertIndex = doc.layers.length;
        }
        // working 已按原数组顺序排好，直接设置父级并插入
        const remap=new Map(entries.map((entry,i)=>[entry.source.id,working[i]!.id]));
        // 只有选中子树的根换父组；后代继续引用子树内原父级/副本父级。
        for(let i=0;i<working.length;i++) {
          const source=entries[i]!.source,originalParent=beforeStructure.parents[source.id];
          working[i]!.parentId=originalParent&&pickedIds.has(originalParent)?(options.duplicate?remap.get(originalParent)!:originalParent):parentId;
          if(working[i]!.maskSourceId && remap.has(working[i]!.maskSourceId!))working[i]!.maskSourceId=remap.get(working[i]!.maskSourceId!)!;
        }
        doc.layers.splice(Math.max(0, Math.min(doc.layers.length, insertIndex)), 0, ...working);
        doc.activeLayerId = working[working.length - 1]?.id ?? doc.activeLayerId;

        pushStructureHistory(options.duplicate ? '复制图层（拖拽）' : options.position === 'inside' ? '移动图层到组内' : '移动图层', beforeStructure, captureStructure());
        setStatusSafe(options.position === 'inside' ? `已移入组「${doc.layers.find((item) => item.id === parentId)?.name ?? ''}」` : '已调整图层顺序');
        break;
      }
      case 'toggleVisibility': {
        const layer=api.activeLayer();if(!layer)break;
        recordLayerProperty(layer.isVisible?'隐藏图层':'显示图层',layer,layer.isVisible,!layer.isVisible,(target,value)=>{target.isVisible=value;});
        break;
      }      case 'toggleLock': {
        const layer = api.activeLayer();
        if (!layer) break;
        const before = layer.locked;
        layer.locked = !before;
        break;
      }
      case 'toggleClipping': {
        const layer=api.activeLayer();if(!layer)break;
        recordLayerProperty('剪贴蒙版',layer,layer.clipping,!layer.clipping,(target,value)=>{target.clipping=value;});
        break;
      }      case 'group': {
        const ids = (payload as string[] | undefined) ?? (doc.selectedLayerIds?.length ? doc.selectedLayerIds : doc.activeLayerId?[doc.activeLayerId]:[]);
        if (ids.length === 0) break;
        const beforeStructure = captureStructure();
        groupLayersCore(doc, ids);
        pushStructureHistory('编组', beforeStructure, captureStructure());
        break;
      }
      case 'ungroup': {
        const layer = api.activeLayer();
        if (!layer || layer.kind !== 'group') break;
        const beforeStructure = captureStructure();
        ungroupCore(doc, layer.id);
        pushStructureHistory('取消编组', beforeStructure, captureStructure());
        break;
      }
      case 'mergeDown': {
        if((doc.selectedLayerIds?.length??0)>1){await run('mergeSelection',doc.selectedLayerIds);break;}
        const layer = api.activeLayer();
        if (!layer) break;
        const beforeStructure = captureStructure();
        mergeDownCore(doc, layer.id);
        pushStructureHistory('向下合并', beforeStructure, captureStructure());
        break;
      }
      case 'mergeSelection': {
        const ids = (payload as string[] | undefined) ?? (doc.selectedLayerIds?.length ? doc.selectedLayerIds : doc.activeLayerId?[doc.activeLayerId]:[]);
        if (ids.length < 2) break;
        const beforeStructure = captureStructure();
        mergeLayersCore(doc, ids);
        pushStructureHistory('合并图层', beforeStructure, captureStructure());
        break;
      }
      case 'mergeGroup': {
        const layer = api.activeLayer();
        if (!layer) break;
        const beforeStructure = captureStructure();
        mergeGroupCore(doc, layer.id);
        pushStructureHistory('合并组', beforeStructure, captureStructure());
        break;
      }
      case 'flatten': {
        const beforeStructure = captureStructure();
        flattenCore(doc);
        pushStructureHistory('合并所有图层', beforeStructure, captureStructure());
        break;
      }
      case 'newGroup': {
        const beforeStructure = captureStructure();
        const group = createGroupLayer('组');
        insertLayerCore(doc, group);
        pushStructureHistory('新建组', beforeStructure, captureStructure());
        break;
      }

      /* ---------------- 蒙版 ---------------- */
      case 'addMask': {
        const layer = api.activeLayer();
        if (!layer) break;
        const before = api.snapshotLayer(layer.id);
        addLayerMask(layer, doc.width, doc.height,documentDepth(doc));
        if (layer.mask) layer.mask.target = 'mask';
        const after = api.snapshotLayer(layer.id);
        api.pushHistory(
          '添加图层蒙版',
          () => { if (before) api.restoreLayer(layer.id, before); },
          () => { if (after) api.restoreLayer(layer.id, after); },
          512,
        );
        break;
      }
      case 'maskFromSelection': {
        const layer=api.activeLayer();if(!layer || layer.locked || !doc.selection)break;
        const before=api.snapshotLayer(layer.id),selection=api.selectionSnapshot();
        maskFromSelection(layer,doc.selection.data,doc.width,doc.height,documentDepth(doc));
        api.setSelection(null);api.markLayerDirty(layer.id);
        const after=api.snapshotLayer(layer.id);
        api.pushHistory('从选区生成蒙版',()=>{if(before)api.restoreLayer(layer.id,before);api.restoreSelection(selection);},
          ()=>{if(after)api.restoreLayer(layer.id,after);api.restoreSelection(null);},
          (before?.pixels?.data.byteLength??0)+(before?.mask?.data.byteLength??0)+(after?.pixels?.data.byteLength??0)+(after?.mask?.data.byteLength??0)+(selection?.data.length??0));
        break;
      }      case 'applyMask': {
        const layer = api.activeLayer();
        if (!layer?.mask) break;
        const before = api.snapshotLayer(layer.id);
        applyLayerMask(layer);
        const after = api.snapshotLayer(layer.id);
        api.pushHistory(
          '应用蒙版',
          () => { if (before) api.restoreLayer(layer.id, before); },
          () => { if (after) api.restoreLayer(layer.id, after); },
          512,
        );
        break;
      }
      case 'deleteMask': {
        const layer = api.activeLayer();
        if (!layer?.mask) break;
        const before = api.snapshotLayer(layer.id);
        layer.mask = null;
        const after = api.snapshotLayer(layer.id);
        api.pushHistory(
          '删除蒙版',
          () => { if (before) api.restoreLayer(layer.id, before); },
          () => { if (after) api.restoreLayer(layer.id, after); },
          512,
        );
        break;
      }
      case 'toggleMask': {
        const layer=api.activeLayer();if(!layer?.mask)break;
        recordLayerProperty(layer.mask.enabled?'禁用蒙版':'启用蒙版',layer,layer.mask.enabled,!layer.mask.enabled,(target,value)=>{if(target.mask)target.mask.enabled=value;});
        break;
      }      case 'maskTarget': {
        const layer = api.activeLayer();
        if (!layer?.mask) break;
        layer.mask.target = layer.mask.target === 'mask' ? 'image' : 'mask';
        api.invalidate();
        break;
      }

      /* ---------------- 反相 ---------------- */
      case 'invertMask':
      case 'invertPixels': {
        const target=resolveEditTarget(api.activeLayer(),name==='invertMask'?'mask':'auto');
        if(!target){api.status('当前目标不可反相，请检查图层锁定和蒙版状态');break;}
        const before=api.snapshotLayer(target.layer.id);
        if(!before || !invertEditTarget(api.doc,target))break;
        api.markLayerDirty(target.layer.id);
        const after=api.snapshotLayer(target.layer.id),id=target.layer.id;
        api.pushHistory(target.onMask?'反相蒙版':'反相像素',()=>{api.restoreLayer(id,before);},()=>{if(after)api.restoreLayer(id,after);},
          ((before.pixels?.data.byteLength??0)+(before.mask?.data.byteLength??0))*2);
        break;
      }      /* ---------------- 调整层 ---------------- */
      case 'addAdjustment': {
        const kind = payload as AdjustmentKind;
        const beforeStructure = captureStructure();
        const layer = createAdjustmentLayer(kind, doc);
        insertLayerCore(doc, layer);
        pushStructureHistory(`新建调整层：${layer.name}`, beforeStructure, captureStructure());
        break;
      }

      /* ---------------- 选区 ---------------- */
      case 'selectAll': {
        const before = api.selectionSnapshot();
        api.setSelection(createSelection(doc.width, doc.height, 255), 'replace');
        pushSelectionHistory(before, api.selectionSnapshot(), '全选');
        break;
      }
      case 'deselect': {
        const before = api.selectionSnapshot();
        api.setSelection(null, 'replace');
        pushSelectionHistory(before, null, '取消选择');
        break;
      }
      case 'inverseSelection': {
        const before = api.selectionSnapshot();
        if (doc.selection) api.setSelection(invertSelection(doc.selection), 'replace');
        else api.setSelection(createSelection(doc.width, doc.height, 255), 'replace');
        pushSelectionHistory(before, api.selectionSnapshot(), '反选');
        break;
      }
      case 'selectSubject': {
        const composite = compositeDocument(doc, doc.width, doc.height, { scale: 1 }).buffer;
        const selection = selectSubject(composite, Number((payload as { sensitivity?: number })?.sensitivity ?? 50));
        const before = api.selectionSnapshot();
        api.setSelection(selection, 'replace');
        pushSelectionHistory(before, api.selectionSnapshot(), '选择主体');
        break;
      }
      case 'selectColorRange': {
        const options = (payload as { hue: number; hueRange: number; saturation: number; saturationRange: number; feather: number })
          ?? { hue: 0, hueRange: 60, saturation: 50, saturationRange: 60, feather: 10 };
        applyColorRange(api, options);
        break;
      }
      case 'wandSelect': {
        const options = (payload as { x: number; y: number; tolerance: number; contiguous: boolean }) ?? { x: doc.width / 2, y: doc.height / 2, tolerance: 32, contiguous: true };
        const composite = compositeDocument(doc, doc.width, doc.height, { scale: 1 }).buffer;
        const selection = magicWand(composite, options.x, options.y, {
          tolerance: options.tolerance,
          contiguous: options.contiguous,
          sampleAllLayers: true,
          feather: 0,
        });
        const before = api.selectionSnapshot();
        api.setSelection(selection, 'replace');
        pushSelectionHistory(before, api.selectionSnapshot(), '魔棒选区');
        break;
      }
      case 'selectionExpand': applySelectionOperation(api, 'expand', Number(payload ?? 8)); break;
      case 'selectionContract': applySelectionOperation(api, 'contract', Number(payload ?? 8)); break;
      case 'selectionBoundary': applySelectionOperation(api, 'boundary', 0); break;
      case 'selectionFeather': {
        const selection = doc.selection;
        if (!selection) break;
        const before = api.selectionSnapshot();
        const radius = Number((payload as { radius?: number } | undefined)?.radius ?? 8);
        const data = gaussianBlurMask(selection.data, selection.width, selection.height, radius);
        const next = { ...selection, data, outline: null };
        api.setSelection(next, 'replace');
        pushSelectionHistory(before, api.selectionSnapshot(), '羽化选区');
        break;
      }
      case 'transformSelection': {
        const offset = (payload as { x: number; y: number } | undefined) ?? { x: 1, y: 0 };
        transformSelectionOutline(api, offset);
        break;
      }
      case 'loadLayerPixelsAsSelection': {
        const layer = api.activeLayer();
        if (!layer) break;
        const composite = compositeDocument(doc, doc.width, doc.height, { scale: 1, onlyLayers: new Set([layer.id]) }).buffer;
        const selection = createSelection(doc.width, doc.height, 0);
        for (let i = 0; i < selection.data.length; i += 1) selection.data[i] = composite.data[i * 4 + 3]!;
        const before = api.selectionSnapshot();
        api.setSelection(selection, 'replace');
        pushSelectionHistory(before, api.selectionSnapshot(), '由图层像素建立选区');
        break;
      }
      case 'loadMaskAsSelection': {
        const layer = api.activeLayer();
        if (!layer?.mask) break;
        const selection = createSelection(doc.width, doc.height, 0);
        // 加载的是蒙版覆盖率，而非当前开关状态；不把小蒙版拉伸到整张文档。
        const sample=createMaskSampler({...layer,mask:{...layer.mask,enabled:true}});
        for(let y=0;y<doc.height;y++)for(let x=0;x<doc.width;x++)selection.data[y*doc.width+x]=Math.round(sample(x+0.5,y+0.5)*255);
        const before = api.selectionSnapshot();
        api.setSelection(selection, 'replace');
        pushSelectionHistory(before, api.selectionSnapshot(), '由蒙版建立选区');
        break;
      }

      /* ---------------- 填充 / 编辑 ---------------- */
      case 'fillForeground':
      case 'fillBackground':
      case 'clearSelection': {
        const target=resolveEditTarget(api.activeLayer());
        if(!target){api.status('当前目标不可编辑，请检查锁定状态和蒙版是否启用');break;}
        const layer=target.layer,before=api.snapshotLayer(layer.id);
        const color=name==='fillForeground'?api.foreground:api.background;
        if(!fillEditTarget(api.doc,target,color,name==='clearSelection' && !target.onMask))break;
        api.markLayerDirty(layer.id);
        const after=api.snapshotLayer(layer.id);
        api.pushHistory(name==='clearSelection'?'清除':'填充',
          ()=>{if(before)api.restoreLayer(layer.id,before);},()=>{if(after)api.restoreLayer(layer.id,after);},
          ((before?.pixels?.data.byteLength??0)+(before?.mask?.data.byteLength??0))*2);
        break;
      }
      case 'contentAwareFill': {
        const layer = api.activeLayer();
        if (!layer || layer.kind !== 'pixel' || !layer.pixels || layer.locked || layer.mask?.target === 'mask') break;
        const selection = doc.selection;
        const hole = new Uint8Array(layer.pixels.width * layer.pixels.height);
        for (let y = 0; y < layer.pixels.height; y += 1) {
          for (let x = 0; x < layer.pixels.width; x += 1) {
            const dx = Math.round(x + layer.transform.origin[0]);
            const dy = Math.round(y + layer.transform.origin[1]);
            const value = selection && dx >= 0 && dy >= 0 && dx < selection.width && dy < selection.height
              ? selection.data[dy * selection.width + dx]!
              : 255;
            hole[y * layer.pixels.width + x] = value;
          }
        }
        const snapshot = api.snapshotLayer(layer.id);
        contentAwareFill(layer.pixels, hole);
        layer.contentKey += 1;
        api.markLayerDirty(layer.id);
        const after = api.snapshotLayer(layer.id);
        api.pushHistory(
          '内容识别填充',
          () => { if (snapshot) api.restoreLayer(layer.id, snapshot); },
          () => { if (after) api.restoreLayer(layer.id, after); },
          (snapshot?.pixels?.data.byteLength ?? 0) * 2,
        );
        break;
      }
      case 'copy':
      case 'copyLayer':
      case 'copyMerged': {
        const captured=captureClipboard(api.doc,api.activeLayer(),name==='copyMerged');
        if(captured){clipboard=captured;setStatusSafe('已复制');}
        else setStatusSafe('当前目标或选区没有可复制内容');
        break;
      }
      case 'cut': {
        if(!doc.selection)break;
        const captured=captureClipboard(api.doc,api.activeLayer());
        if(!captured)break;
        clipboard=captured;
        await run('clearSelection');
        break;
      }
      case 'pastePayload':
      case 'paste': {
        const data=name==='pastePayload'?payload as ClipboardPayload:clipboard;
        if(!data)break;
        const before=captureStructure();
        pasteClipboard(api.doc,data);
        pushStructureHistory('粘贴',before,captureStructure());
        break;
      }
      case 'flattenClipboard': {const captured=captureClipboard(doc,api.activeLayer(),true);if(captured)clipboard=captured;break;}

      /* ---------------- 画布 ---------------- */
      case 'canvasSize': {
        const options = (payload as { width: number; height: number; anchor: import('@/core/document').Anchor }) ?? { width: doc.width, height: doc.height, anchor: 'top-left' as const };
        const before = captureCanvas();
        resizeCanvas(doc, options.width, options.height, options.anchor);
        recordCanvasHistory('画布大小', before);
        break;
      }
      case 'imageSize': {
        const options = (payload as { width: number; height: number }) ?? { width: doc.width, height: doc.height };
        const before = captureCanvas();
        resizeImage(doc, options.width, options.height);
        recordCanvasHistory('图像大小', before);
        break;
      }
      case 'rotateCanvasAll': {
        const degrees = Number(payload ?? 90);
        const before = captureCanvas();
        rotateCanvas(doc, degrees);
        recordCanvasHistory('旋转画布', before);
        break;
      }
      case 'flipCanvasH': {
        const before = captureCanvas();
        flipCanvas(doc, true, false);
        recordCanvasHistory('水平翻转画布', before);
        break;
      }
      case 'flipCanvasV': {
        const before = captureCanvas();
        flipCanvas(doc, false, true);
        recordCanvasHistory('垂直翻转画布', before);
        break;
      }
      case 'trim': {
        const tolerance = Number((payload as { tolerance?: number })?.tolerance ?? 10);
        const rect = trimDocument(doc, tolerance, api.background);
        if (!rect) {
          setStatusSafe('四周没有可修边的边');
          break;
        }
        const before = captureCanvas();
        cropDocument(doc, rect);
        recordCanvasHistory('修边', before);
        break;
      }

      /* ---------------- 滤镜（破坏性） ---------------- */
      case 'filterAddNoise':
        applyToActiveLayer('添加杂色', (pixels) => {

          applyAddNoise(pixels, Number((payload as { amount?: number })?.amount ?? 10), true, false, 7);
        });
        break;
      case 'filterVignette':
        applyToActiveLayer('渐晕', (pixels) => {
          applyVignette(pixels, {
            amount: Number((payload as { amount?: number })?.amount ?? -40),
            midpoint: 50, roundness: 0, feather: 60,
            color: api.background,
            blendMode: 'Multiply',
          });
        });
        break;
      case 'filterBloom':
        applyToActiveLayer('辉光', (pixels) => {
          applyBloom(pixels, { radius: 12, intensity: 40, threshold: 65, color: [255, 240, 220], blendMode: 'Screen' });
        });
        break;
      case 'filterTonalContrast':
        applyToActiveLayer('色调反差', (pixels) => {
          applyTonalContrast(pixels, { shadows: 40, highlights: -30, color: true, protectMidtones: true });
        });
        break;
      case 'filterLensCorrection':
        applyToActiveLayer('镜头校正', (pixels) => {
          applyLensCorrection(pixels, { distortion: 20, chromaticAberration: 30, vignette: 0, correction: true });
        });
        break;
      case 'filterRemoveBackground':
        applyToActiveLayer('移除背景',pixels=>removeBackground(pixels,Number((payload as {sensitivity?:number})?.sensitivity??50)));
        break;      case 'filterSharpen':
        applyToActiveLayer('USM 锐化', (pixels) => {
          applySharpen(pixels, { amount: 80, radius: 1.2, threshold: 0 });
        });
        break;
      case 'filterDenoise':
        applyToActiveLayer('降噪', (pixels) => {
          applyDenoise(pixels, { luminance: 30, color: 40, radius: 1 });
        });
        break;
      case 'filterDither':
        applyToActiveLayer('抖动', (pixels) => {
          applyDither(pixels, 6, 11);
        });
        break;

      default: {
        // 文件与视图类命令在 commands-io 中实现
        await ioCommands.run(name, payload);
        break;
      }
    }
  };

  /** 深复制文档数据，保留图层 ID、像素、蒙版、选区、尺寸和参考线。 */
  function cloneCanvasValue<T>(value: T): T {
    if (value instanceof Float32Array) return new Float32Array(value) as T;
  if (value instanceof Uint8ClampedArray) return new Uint8ClampedArray(value) as T;
    if (value instanceof Uint8Array) return new Uint8Array(value) as T;
    if (Array.isArray(value)) return value.map(cloneCanvasValue) as T;
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,cloneCanvasValue(v)])) as T;
    return value;
  }
  function captureCanvas() {
    return cloneCanvasValue({bitDepth:doc.bitDepth,width:doc.width,height:doc.height,layers:doc.layers,selection:doc.selection,guides:doc.guides,activeLayerId:doc.activeLayerId});
  }
  function recordCanvasHistory(label: string, before: ReturnType<typeof captureCanvas>): void {
    const after = captureCanvas();
    const target = api.doc;
    const apply = (snapshot: typeof before): void => { Object.assign(target, cloneCanvasValue(snapshot)); api.touch(); api.invalidate(); };
    const bytes = [...before.layers,...after.layers].reduce((n,l)=>n+(l.pixels?.data.byteLength??0)+(l.mask?.pixels.data.byteLength??0),512);
    api.pushHistory(label,()=>apply(before),()=>apply(after),bytes);
    api.touch();
  }

  /** 选区历史 */
  function pushSelectionHistory(
    before: ReturnType<typeof api.selectionSnapshot>,
    after: ReturnType<typeof api.selectionSnapshot>,
    label: string,
  ): void {
    api.pushHistory(
      label,
      () => { api.restoreSelection(before); },
      () => { api.restoreSelection(after); },
      (before?.data.length ?? 0) + (after?.data.length ?? 0),
    );
    api.touch();
  }

  const ioCommands = createIoCommands(api, {
    openDocument,
    reloadDocument,
    findOpenProject,
    documentRevision,
    canReloadDocument,
    currentHistory,
    closeCurrent,
    setViewport: (patch) => api.setViewport(patch),
    fitCanvas,
    actualPixels,
    zoomStep,
    toggleUi,
    openDialog,
    invalidate,
  });

  const commands = { run };
  return commands;
}

