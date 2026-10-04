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
  invertLayerMask, maskFromSelection, mergeDown as mergeDownCore, mergeGroup as mergeGroupCore,
  mergeLayers as mergeLayersCore, flattenVisible as flattenCore, nudgeLayerOrder, removeLayers as removeLayersCore,
  resizeCanvas, resizeImage, rotateCanvas, trimDocument, ungroupLayers as ungroupCore, uuid,
} from '@/core/document';
import { contentAwareFill } from '@/core/filters/contentAware';
import {
  applyBloom, applyDenoise, applyDither, applyLensCorrection, applySharpen, applyTonalContrast, applyVignette, removeBackground,
} from '@/core/filters/creative';
import { applyAddNoise } from '@/core/filters/adjust';
import { compositeDocument, compositeInto, flattenDocument } from '@/core/engine/compositor';
import { createBuffer } from '@/core/pixels';
import { combineSelection, createSelection, gaussianBlurMask, invertSelection } from '@/core/selection';
import { applyColorRange, applySelectionOperation, transformSelectionOutline } from '@/tools/selection';
import { magicWand, selectSubject } from '@/core/ops/selectionOps';
import { importPsd } from '@/io/psd';




import { createIoCommands } from '@/composables/commands-io';
import { actualPixels, closeCurrent, currentHistory, fitCanvas, invalidate, openDialog, openDocument, toggleUi, zoomStep } from '@/composables/useEditor';
import type { EditorApi } from '@/types/editor';
import type { AdjustmentKind, CompDocument, Layer, PixelBuffer } from '@/types/document';

/** 剪贴板（内部实现） */
const clipboard: { pixels: PixelBuffer | null; document: Layer | null } = { pixels: null, document: null };

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
  /** 记录一条「图层集合」类操作的历史 */
  /** 图层结构快照：只记录 id 顺序与父级，避免把像素写进历史 */
  interface Structure {
    ids: string[];
    parents: Record<string, string | null>;
  }

  /** 捕获当前图层结构 */
  const captureStructure = (): Structure => ({
    ids: doc.layers.map((layer) => layer.id),
    parents: Object.fromEntries(doc.layers.map((layer) => [layer.id, layer.parentId ?? null])),
  });

  /** 结构是否相同 */
  const sameStructure = (a: Structure, b: Structure): boolean => {
    if (a.ids.length !== b.ids.length) return false;
    for (let i = 0; i < a.ids.length; i += 1) if (a.ids[i] !== b.ids[i]) return false;
    for (const id of a.ids) if ((a.parents[id] ?? null) !== (b.parents[id] ?? null)) return false;
    return true;
  };

  /** 按结构重排图层；drop 中的图层会被移出数组（撤销新增 / 重做删除） */
  const applyStructure = (structure: Structure, drop: Set<string>): void => {
    const map = new Map(doc.layers.map((layer) => [layer.id, layer]));
    const known = new Set(structure.ids);
    const next: Layer[] = [];
    for (const id of structure.ids) {
      if (drop.has(id)) continue;
      const layer = map.get(id);
      if (!layer) continue;
      layer.parentId = structure.parents[id] ?? null;
      next.push(layer);
    }
    // 快照里没有的图层（例如被撤销的新增图层）保持原样放回末尾，避免丢失数据
    for (const layer of doc.layers) {
      if (known.has(layer.id) || drop.has(layer.id)) continue;
      next.push(layer);
    }
    doc.layers = next;
    if (!doc.layers.some((layer) => layer.id === doc.activeLayerId)) {
      doc.activeLayerId = doc.layers[doc.layers.length - 1]?.id ?? null;
    }
    api.invalidate();
  };

  /**
   * 结构类操作的历史：撤销/重做只重排 id 与 parentId，
   * 对比旧的 JSON 快照可以避免把像素数据写进历史（那会导致内存爆炸）。
   */
  const pushStructureHistory = (label: string, before: Structure, after: Structure, bytes = 512): void => {
    if (sameStructure(before, after)) return;
    const droppedInBefore = new Set(before.ids.filter((id) => !after.ids.includes(id)));
    const addedInBefore = new Set(after.ids.filter((id) => !before.ids.includes(id)));
    api.pushHistory(
      label,
      () => applyStructure(before, addedInBefore),
      () => applyStructure(after, droppedInBefore),
      bytes,
    );
  };

  /** 破坏性滤镜：作用在当前像素层，受选区限制 */
  const applyToActiveLayer = (label: string, apply: (pixels: PixelBuffer, layer: Layer) => void): void => {
    const layer = api.activeLayer();
    if (!layer) {
      setStatusSafe('请先选择一个图层');
      return;
    }
    if (layer.kind !== 'pixel') {
      setStatusSafe('该滤镜需要作用在像素图层上');
      return;
    }
    const before = api.snapshotLayer(layer.id);
    if (!before?.pixels) return;
    apply(layer.pixels, layer);
    layer.contentKey += 1;
    api.markLayerDirty(layer.id);
    const after = api.snapshotLayer(layer.id);
    if (!after) return;
    api.pushHistory(
      label,
      () => { if (before) api.restoreLayer(layer.id, before); },
      () => { if (after) api.restoreLayer(layer.id, after); },
      (before.pixels?.data.length ?? 0) * 2,
    );
  };

  const setStatusSafe = (message: string): void => {
    api.status(message);
  };

  /** 选区覆盖率数组（供滤镜使用） */
  const selectionCoverage = (): Uint8Array | null => {
    const selection = api.doc.selection;
    if (!selection || isEmpty(selection)) return null;
    return selection.data;
  };

  const isEmpty = (selection: { data: Uint8Array<ArrayBuffer> }): boolean => {
    for (let i = 0; i < selection.data.length; i += 1) if (selection.data[i]! > 0) return false;
    return true;
  };

  const run = (name: string, payload?: unknown): void => {
    // 注意：这里不再取 api.doc，由顶部的惰性代理在真正访问时才解析（newCanvas 时还没有文档）
    switch (name) {
      /* ---------------- 图层 ---------------- */
      case 'newLayer': {
        const beforeStructure = captureStructure();
        const layer = createBlankLayer(doc, '图层');
        insertLayerCore(doc, layer);
        pushStructureHistory('新建图层', beforeStructure, captureStructure());
        break;
      }
      case 'duplicateLayer': {
        const layer = api.activeLayer();
        if (!layer) break;
        const beforeStructure = captureStructure();
        const copy = duplicateLayerCore(layer);
        const index = doc.layers.findIndex((item) => item.id === layer.id);
        doc.layers.splice(index + 1, 0, copy);
        doc.activeLayerId = copy.id;
        pushStructureHistory('复制图层', beforeStructure, captureStructure());
        break;
      }
      case 'deleteLayer': {
        const ids = (payload as string[] | undefined) ?? (doc.activeLayerId ? [doc.activeLayerId] : []);
        if (ids.length === 0) break;
        const beforeStructure = captureStructure();
        const beforeActive = doc.activeLayerId;
        // \u5220\u9664\u9700\u8981\u4fdd\u7559\u88ab\u5220\u56fe\u5c42\u5bf9\u8c61\uff0c\u5426\u5219\u64a4\u9500\u65f6\u50cf\u7d20\u4f1a\u4e22\u5931
        const removed = removeLayersCore(doc, ids);
        const afterStructure = captureStructure();
        const removedIds = removed.map((item) => item.id);
        api.pushHistory(
          '删除图层',
          () => {
            for (const layer of removed) {
              if (!doc.layers.some((item) => item.id === layer.id)) doc.layers.push(layer);
            }
            applyStructure(beforeStructure, new Set());
            doc.activeLayerId = beforeActive;
            api.invalidate();
          },
          () => {
            removeLayersCore(doc, removedIds);
            applyStructure(afterStructure, new Set());
            api.invalidate();
          },
          256,
        );
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
        for (const layer of working) layer.parentId = parentId;
        doc.layers.splice(Math.max(0, Math.min(doc.layers.length, insertIndex)), 0, ...working);
        doc.activeLayerId = working[working.length - 1]?.id ?? doc.activeLayerId;

        pushStructureHistory(options.duplicate ? '复制图层（拖拽）' : options.position === 'inside' ? '移动图层到组内' : '移动图层', beforeStructure, captureStructure());
        setStatusSafe(options.position === 'inside' ? `已移入组「${doc.layers.find((item) => item.id === parentId)?.name ?? ''}」` : '已调整图层顺序');
        break;
      }
      case 'toggleVisibility': {
        const layer = api.activeLayer();
        if (!layer) break;
        const before = layer.isVisible;
        layer.isVisible = !before;
        api.pushHistory(
          before ? '显示图层' : '隐藏图层',
          () => { layer.isVisible = before; api.invalidate(); },
          () => { layer.isVisible = !before; api.invalidate(); },
          16,
        );
        break;
      }
      case 'toggleLock': {
        const layer = api.activeLayer();
        if (!layer) break;
        const before = layer.locked;
        layer.locked = !before;
        break;
      }
      case 'toggleClipping': {
        const layer = api.activeLayer();
        if (!layer) break;
        const before = layer.clipping;
        layer.clipping = !before;
        api.pushHistory(
          '剪贴蒙版',
          () => { layer.clipping = before; api.invalidate(); },
          () => { layer.clipping = !before; api.invalidate(); },
          16,
        );
        break;
      }
      case 'group': {
        const ids = (payload as string[] | undefined) ?? doc.layers.filter((item) => item.parentId === doc.activeLayerId && item.isVisible).slice(-3).map((item) => item.id);
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
        const layer = api.activeLayer();
        if (!layer) break;
        const beforeStructure = captureStructure();
        mergeDownCore(doc, layer.id);
        pushStructureHistory('向下合并', beforeStructure, captureStructure());
        break;
      }
      case 'mergeSelection': {
        const ids = (payload as string[] | undefined) ?? (doc.activeLayerId ? [doc.activeLayerId] : []);
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
        const before = layer.mask ? api.snapshotLayer(layer.id) : null;
        addLayerMask(layer);
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
        const layer = api.activeLayer();
        if (!layer || !doc.selection) break;
        const before = api.snapshotLayer(layer.id);
        maskFromSelection(layer, doc.selection.data, doc.width, doc.height);
        if (layer.mask) layer.mask.target = 'mask';
        const after = api.snapshotLayer(layer.id);
        api.pushHistory(
          '从选区生成蒙版',
          () => { if (before) api.restoreLayer(layer.id, before); },
          () => { if (after) api.restoreLayer(layer.id, after); },
          512,
        );
        break;
      }
      case 'applyMask': {
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
      case 'invertMask': {
        const layer = api.activeLayer();
        if (!layer?.mask) break;
        const before = api.snapshotLayer(layer.id);
        invertLayerMask(layer);
        const after = api.snapshotLayer(layer.id);
        api.pushHistory(
          '反相蒙版',
          () => { if (before) api.restoreLayer(layer.id, before); },
          () => { if (after) api.restoreLayer(layer.id, after); },
          512,
        );
        break;
      }
      case 'toggleMask': {
        const layer = api.activeLayer();
        if (!layer?.mask) break;
        layer.mask.enabled = !layer.mask.enabled;
        break;
      }
      case 'maskTarget': {
        const layer = api.activeLayer();
        if (!layer?.mask) break;
        layer.mask.target = layer.mask.target === 'mask' ? 'image' : 'mask';
        api.invalidate();
        break;
      }

      /* ---------------- 调整层 ---------------- */
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
        for (let y = 0; y < doc.height; y += 1) {
          for (let x = 0; x < doc.width; x += 1) {
            const mx = Math.min(layer.mask.pixels.width - 1, Math.floor((x / Math.max(1, doc.width)) * layer.mask.pixels.width));
            const my = Math.min(layer.mask.pixels.height - 1, Math.floor((y / Math.max(1, doc.height)) * layer.mask.pixels.height));
            selection.data[y * doc.width + x] = layer.mask.pixels.data[my * layer.mask.pixels.width + mx]!;
          }
        }
        const before = api.selectionSnapshot();
        api.setSelection(selection, 'replace');
        pushSelectionHistory(before, api.selectionSnapshot(), '由蒙版建立选区');
        break;
      }

      /* ---------------- 填充 / 编辑 ---------------- */
      case 'fillForeground':
      case 'fillBackground': {
        const color = name === 'fillForeground' ? api.foreground : api.background;
        const layer = api.activeLayer();
        if (!layer) break;
        const snapshot = api.snapshotLayer(layer.id);
        applyFill(layer, doc, color);
        const after = api.snapshotLayer(layer.id);
        api.pushHistory(
          '填充',
          () => { if (snapshot) api.restoreLayer(layer.id, snapshot); },
          () => { if (after) api.restoreLayer(layer.id, after); },
          (snapshot?.pixels?.data.length ?? 0) * 2,
        );
        break;
      }
      case 'clearSelection': {
        const layer = api.activeLayer();
        if (!layer || layer.kind !== 'pixel' || !layer.pixels) break;
        const snapshot = api.snapshotLayer(layer.id);
        const selection = doc.selection;
        const pixels = layer.pixels;
        for (let y = 0; y < pixels.height; y += 1) {
          for (let x = 0; x < pixels.width; x += 1) {
            const dx = Math.round(x + layer.transform.origin[0]);
            const dy = Math.round(y + layer.transform.origin[1]);
            const coverage = selection
              ? (dx < 0 || dy < 0 || dx >= selection.width || dy >= selection.height ? 0 : selection.data[dy * selection.width + dx]! / 255)
              : 1;
            if (coverage <= 0) continue;
            const i = (y * pixels.width + x) * 4;
            pixels.data[i] = pixels.data[i]! * (1 - coverage);
            pixels.data[i + 1] = pixels.data[i + 1]! * (1 - coverage);
            pixels.data[i + 2] = pixels.data[i + 2]! * (1 - coverage);
            pixels.data[i + 3] = pixels.data[i + 3]! * (1 - coverage);
          }
        }
        layer.contentKey += 1;
        api.markLayerDirty(layer.id);
        const after = api.snapshotLayer(layer.id);
        api.pushHistory(
          '清除',
          () => { if (snapshot) api.restoreLayer(layer.id, snapshot); },
          () => { if (after) api.restoreLayer(layer.id, after); },
          (snapshot?.pixels?.data.length ?? 0) * 2,
        );
        break;
      }
      case 'contentAwareFill': {
        const layer = api.activeLayer();
        if (!layer || layer.kind !== 'pixel' || !layer.pixels) break;
        const selection = doc.selection;
        const hole = new Uint8Array(layer.pixels.width * layer.pixels.height);
        for (let y = 0; y < layer.pixels.height; y += 1) {
          for (let x = 0; x < layer.pixels.width; x += 1) {
            const dx = Math.round(x + layer.transform.origin[0]);
            const dy = Math.round(y + layer.transform.origin[1]);
            const value = selection && dx >= 0 && dy >= 0 && dx < selection.width && dy < selection.height
              ? selection.data[dy * selection.width + dx]!
              : 255;
            hole[y * layer.pixels.width + x] = value > 8 ? 1 : 0;
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
          (snapshot?.pixels?.data.length ?? 0) * 2,
        );
        break;
      }
      case 'copy': {
        const composite = compositeDocument(doc, doc.width, doc.height, { scale: 1, limitAdjustmentsBySelection: false }).buffer;
        clipboard.pixels = cropToSelection(composite, doc);
        setStatusSafe('已复制像素');
        break;
      }
      case 'copyMerged': {
        clipboard.pixels = flattenDocument(doc);
        setStatusSafe('已复制合并像素');
        break;
      }
      case 'copyLayer': {
        const layer = api.activeLayer();
        if (layer) clipboard.document = layer;
        break;
      }
      case 'cut': {
        commands.run('copy');
        commands.run('clearSelection');
        break;
      }
      case 'paste': {
        if (clipboard.document) {
          const beforeStructure = captureStructure();
          const copy = duplicateLayerCore(clipboard.document);
          insertLayerCore(doc, copy);
          pushStructureHistory('粘贴图层', beforeStructure, captureStructure());
        } else if (clipboard.pixels) {
          const beforeStructure = captureStructure();
          const layer = createPixelLayer('粘贴的像素', clipboard.pixels);
          insertLayerCore(doc, layer);
          pushStructureHistory('粘贴', beforeStructure, captureStructure());
        }
        break;
      }
      case 'flattenClipboard': break;

      /* ---------------- 画布 ---------------- */
      case 'canvasSize': {
        const options = (payload as { width: number; height: number; anchor: import('@/core/document').Anchor }) ?? { width: doc.width, height: doc.height, anchor: 'top-left' as const };
        const snapshotLayers = doc.layers.map((layer) => ({ id: layer.id, transform: { ...layer.transform, origin: [...layer.transform.origin] as [number, number] } }));
        const beforeSelection = api.selectionSnapshot();
        resizeCanvas(doc, options.width, options.height, options.anchor);
        recordCanvasHistory('画布大小', snapshotLayers, beforeSelection);
        break;
      }
      case 'imageSize': {
        const options = (payload as { width: number; height: number }) ?? { width: doc.width, height: doc.height };
        const snapshotLayers = doc.layers.map((layer) => ({ id: layer.id, transform: { ...layer.transform, origin: [...layer.transform.origin] as [number, number] } }));
        const beforeSelection = api.selectionSnapshot();
        resizeImage(doc, options.width, options.height);
        recordCanvasHistory('图像大小', snapshotLayers, beforeSelection);
        break;
      }
      case 'rotateCanvasAll': {
        const degrees = Number(payload ?? 90);
        const snapshotLayers = doc.layers.map((layer) => ({ id: layer.id, transform: { ...layer.transform, origin: [...layer.transform.origin] as [number, number], size: [...layer.transform.size] as [number, number] } }));
        rotateCanvas(doc, degrees);
        recordCanvasHistory('旋转画布', snapshotLayers, api.selectionSnapshot());
        break;
      }
      case 'flipCanvasH': {
        const snapshotLayers = doc.layers.map((layer) => ({ id: layer.id, transform: { ...layer.transform, origin: [...layer.transform.origin] as [number, number] } }));
        flipCanvas(doc, true, false);
        recordCanvasHistory('水平翻转画布', snapshotLayers, api.selectionSnapshot());
        break;
      }
      case 'flipCanvasV': {
        const snapshotLayers = doc.layers.map((layer) => ({ id: layer.id, transform: { ...layer.transform, origin: [...layer.transform.origin] as [number, number] } }));
        flipCanvas(doc, false, true);
        recordCanvasHistory('垂直翻转画布', snapshotLayers, api.selectionSnapshot());
        break;
      }
      case 'trim': {
        const tolerance = Number((payload as { tolerance?: number })?.tolerance ?? 10);
        const rect = trimDocument(doc, tolerance, api.background);
        if (!rect) {
          setStatusSafe('四周没有可修边的边');
          break;
        }
        const snapshotLayers = doc.layers.map((layer) => ({ id: layer.id, transform: { ...layer.transform, origin: [...layer.transform.origin] as [number, number] } }));
        const { cropDocument } = require('@/core/document') as typeof import('@/core/document');
        cropDocument(doc, rect);
        recordCanvasHistory('修边', snapshotLayers, api.selectionSnapshot());
        break;
      }

      /* ---------------- 滤镜（破坏性） ---------------- */
      case 'filterAddNoise':
        applyToActiveLayer('添加杂色', (pixels) => {
          const coverage = selectionCoverage();
          applyAddNoise(pixels, Number((payload as { amount?: number })?.amount ?? 10), true, false, 7, coverage);
        });
        break;
      case 'filterVignette':
        applyToActiveLayer('渐晕', (pixels) => {
          applyVignette(pixels, {
            amount: Number((payload as { amount?: number })?.amount ?? -40),
            midpoint: 50, roundness: 0, feather: 60,
            color: api.background,
            blendMode: 'Multiply',
          }, selectionCoverage());
        });
        break;
      case 'filterBloom':
        applyToActiveLayer('辉光', (pixels) => {
          applyBloom(pixels, { radius: 12, intensity: 40, threshold: 65, color: [255, 240, 220], blendMode: 'Screen' }, selectionCoverage());
        });
        break;
      case 'filterTonalContrast':
        applyToActiveLayer('色调反差', (pixels) => {
          applyTonalContrast(pixels, { shadows: 40, highlights: -30, color: true, protectMidtones: true }, selectionCoverage());
        });
        break;
      case 'filterLensCorrection':
        applyToActiveLayer('镜头校正', (pixels) => {
          applyLensCorrection(pixels, { distortion: 20, chromaticAberration: 30, vignette: 0, correction: true });
        });
        break;
      case 'filterRemoveBackground': {
        const layer = api.activeLayer();
        if (!layer || layer.kind !== 'pixel' || !layer.pixels) break;
        const snapshot = api.snapshotLayer(layer.id);
        layer.pixels = removeBackground(layer.pixels, Number((payload as { sensitivity?: number })?.sensitivity ?? 50));
        layer.contentKey += 1;
        api.markLayerDirty(layer.id);
        const after = api.snapshotLayer(layer.id);
        api.pushHistory(
          '移除背景',
          () => { if (snapshot) api.restoreLayer(layer.id, snapshot); },
          () => { if (after) api.restoreLayer(layer.id, after); },
          (snapshot?.pixels?.data.length ?? 0) * 2,
        );
        break;
      }
      case 'filterSharpen':
        applyToActiveLayer('USM 锐化', (pixels) => {
          applySharpen(pixels, { amount: 80, radius: 1.2, threshold: 0 }, selectionCoverage());
        });
        break;
      case 'filterDenoise':
        applyToActiveLayer('降噪', (pixels) => {
          applyDenoise(pixels, { luminance: 30, color: 40, radius: 1 }, selectionCoverage());
        });
        break;
      case 'filterDither':
        applyToActiveLayer('抖动', (pixels) => {
          applyDither(pixels, 6, 11);
        });
        break;

      default: {
        // 文件与视图类命令在 commands-io 中实现
        void ioCommands.run(name, payload);
        break;
      }
    }
  };

  /** 记录画布级操作 */
  function recordCanvasHistory(
    label: string,
    transforms: { id: string; transform: import('@/types/document').LayerTransform }[],
    beforeSelection: ReturnType<typeof api.selectionSnapshot>,
  ): void {
    const afterTransforms = transforms.map((item) => {
      const layer = doc.layers.find((candidate) => candidate.id === item.id);
      return { id: item.id, transform: layer ? { ...layer.transform, origin: [...layer.transform.origin] as [number, number] } : item.transform };
    });
    const beforeWidth = doc.width;
    const beforeHeight = doc.height;
    const afterWidth = doc.width;
    const afterHeight = doc.height;
    const applyTransforms = (list: typeof transforms): void => {
      for (const item of list) {
        const layer = doc.layers.find((candidate) => candidate.id === item.id);
        if (layer) layer.transform = JSON.parse(JSON.stringify(item.transform));
      }
      api.invalidate();
    };
    api.pushHistory(
      label,
      () => {
        doc.width = beforeWidth;
        doc.height = beforeHeight;
        applyTransforms(transforms);
        api.restoreSelection(beforeSelection);
      },
      () => {
        doc.width = afterWidth;
        doc.height = afterHeight;
        applyTransforms(afterTransforms);
      },
      512,
    );
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

  /** 填充当前图层（受选区限制） */
  function applyFill(layer: Layer, document: typeof api.doc, color: [number, number, number]): void {
    if (layer.kind !== 'pixel' || !layer.pixels) return;
    const selection = document.selection;
    const pixels = layer.pixels;
    for (let y = 0; y < pixels.height; y += 1) {
      for (let x = 0; x < pixels.width; x += 1) {
        const dx = Math.round(x + layer.transform.origin[0]);
        const dy = Math.round(y + layer.transform.origin[1]);
        const coverage = selection
          ? (dx < 0 || dy < 0 || dx >= selection.width || dy >= selection.height ? 0 : selection.data[dy * selection.width + dx]! / 255)
          : 1;
        if (coverage <= 0) continue;
        const i = (y * pixels.width + x) * 4;
        pixels.data[i] = pixels.data[i]! * (1 - coverage) + color[0] * coverage;
        pixels.data[i + 1] = pixels.data[i + 1]! * (1 - coverage) + color[1] * coverage;
        pixels.data[i + 2] = pixels.data[i + 2]! * (1 - coverage) + color[2] * coverage;
        pixels.data[i + 3] = Math.min(255, pixels.data[i + 3]! + coverage * 255);
      }
    }
    layer.contentKey += 1;
    api.markLayerDirty(layer.id);
  }

  /** 按选区裁剪复制内容 */
  function cropToSelection(buffer: PixelBuffer, document: typeof api.doc): PixelBuffer {
    const selection = document.selection;
    if (!selection) return buffer;
    const out = createBuffer(selection.width, selection.height);
    for (let i = 0; i < selection.data.length; i += 1) {
      const coverage = selection.data[i]! / 255;
      out.data[i * 4] = buffer.data[i * 4]!;
      out.data[i * 4 + 1] = buffer.data[i * 4 + 1]!;
      out.data[i * 4 + 2] = buffer.data[i * 4 + 2]!;
      out.data[i * 4 + 3] = Math.round(buffer.data[i * 4 + 3]! * coverage);
    }
    return out;
  }

  const ioCommands = createIoCommands(api, {
    openDocument,
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

