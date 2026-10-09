/**
 * 快捷键表（可重映射）
 * ---------------------------------------------------------------
 * - 所有快捷键集中在这里定义，界面按 group 分组展示；
 * - 用户修改后写入宿主本地状态，启动时自动恢复；
 * - ⌘ / Ctrl 均可用（macOS 显示 ⌘，其它平台显示 Ctrl）。
 */
import { reactive } from 'vue';
import { loadState, saveState } from '@/platform/host';
import type { EditorApi } from '@/types/editor';
import { openDialog, setTool, activateShortcutTool, cycleCurrentTool, api as editorApi, toggleUi, zoomStep, actualPixels, fitCanvas } from '@/composables/useEditor';
import { commands } from '@/composables/useEditor';
import { getTool, TOOL_SHORTCUTS } from '@/tools';

/** 按键组合 */
export interface ShortcutChord {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** 一条快捷键 */
export interface ShortcutItem {
  id: string;
  /** 界面显示的命令名 */
  title: string;
  /** 分组 */
  group: string;
  /** 默认按键 */
  default: ShortcutChord;
  /** 生效的按键（可能被用户改过） */
  chord: ShortcutChord;
  /** 执行动作 */
  run: () => void;
}

const STORAGE_KEY = 'compositor.shortcuts.v1';

/** 是否 macOS（决定显示 ⌘ 还是 Ctrl） */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** 修饰键显示文本 */
function modifierText(chord: ShortcutChord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push(isMac ? '⌘' : 'Ctrl');
  if (chord.shift) parts.push(isMac ? '⇧' : 'Shift');
  if (chord.alt) parts.push(isMac ? '⌥' : 'Alt');
  return parts.join(isMac ? '' : '+');
}

/** 特殊键显示名 */
const KEY_LABELS: Record<string, string> = {
  Delete: isMac ? 'Delete' : 'Del',
  Backspace: isMac ? '⌫' : 'Backspace',
  Tab: isMac ? '⇥' : 'Tab',
  Enter: isMac ? '↩' : 'Enter',
  Escape: isMac ? '⎋' : 'Esc',
  Space: 'Space',
  ArrowUp: isMac ? '↑' : '↑',
  ArrowDown: isMac ? '↓' : '↓',
  ArrowLeft: isMac ? '←' : '←',
  ArrowRight: isMac ? '→' : '→',
  '=': isMac ? '=' : '=',
  '-': isMac ? '-' : '-',
};

/** 按键组合 -> 显示文本 */
export function chordLabel(chord: ShortcutChord): string {
  const key = KEY_LABELS[chord.key] ?? chord.key.toUpperCase();
  const modifier = modifierText(chord);
  if (!modifier) return key;
  return isMac ? modifier + key : `${modifier}+${key}`;
}

/** 由键盘事件生成按键组合（用于匹配与录制） */
export function chordFromEvent(event: KeyboardEvent): ShortcutChord {
  let key = ({':':';','{':'[','}':']','+':'=','_':'-'} as Record<string,string>)[event.key]??event.key;
  if (key === ' ') key = 'Space';
  if (key.length === 1) key = key.toLowerCase();
  return {
    key,
    ctrl: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
  };
}

/** 两个组合是否相同 */
function sameChord(a: ShortcutChord, b: ShortcutChord): boolean {
  return a.key === b.key && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt;
}

/** 构建默认快捷键表 */
function buildDefaults(): ShortcutItem[] {
  const items: ShortcutItem[] = [];
  const push = (id: string, group: string, title: string, key: string, modifiers: Partial<ShortcutChord>, run: () => void): void => {
    const chord: ShortcutChord = { key, ctrl: false, shift: false, alt: false, ...modifiers };
    items.push({ id, group, title, default: chord, chord: { ...chord }, run });
  };

  /* 工具（单键，无修饰） */
  for (const [key, tool] of Object.entries(TOOL_SHORTCUTS)) {
    push(`tool.${tool}`, '工具', `${getTool(tool)?.name??tool}工具`, key, {}, () => activateShortcutTool(tool));
  }

  /* 文件 */
  push('file.new', '文件', '新建画布', 'n', { ctrl: true }, () => commands.run('newCanvas'));
  push('file.newLayer', '文件', '新建图层', 'n', { ctrl: true, shift: true }, () => commands.run('newLayer'));
  push('file.open', '文件', '打开 .comp 工程', 'o', { ctrl: true }, () => commands.run('openComp'));
  push('file.save', '文件', '保存工程', 's', { ctrl: true }, () => commands.run('saveComp'));
  push('file.saveAs', '文件', '另存为…', 's', { ctrl: true, shift: true }, () => commands.run('saveCompAs'));
  push('file.exportPng', '文件', '导出 PNG', 'e', { ctrl: true, shift: true }, () => openDialog('exportDialog', { format: 'png' }));
  push('file.exportJpeg', '文件', '导出 JPEG', 's', { ctrl: true, alt: true, shift:true }, () => openDialog('exportDialog', { format: 'jpeg' }));
  push('file.close', '文件', '关闭文档', 'w', { ctrl: true }, () => commands.run('closeDocument'));

  /* 编辑 */
  push('edit.undo', '编辑', '撤销', 'z', { ctrl: true }, () => commands.run('undo'));
  push('edit.redo', '编辑', '重做', 'z', { ctrl: true, shift: true }, () => commands.run('redo'));
  push('edit.cut', '编辑', '剪切', 'x', { ctrl: true }, () => commands.run('cut'));
  push('edit.copy', '编辑', '复制', 'c', { ctrl: true }, () => commands.run('copy'));
  push('edit.copyMerged', '编辑', '复制合并', 'c', { ctrl: true, shift: true }, () => commands.run('copyMerged'));
  push('edit.paste', '编辑', '粘贴', 'v', { ctrl: true }, () => commands.run('paste'));
  push('edit.fillForeground', '编辑', '填充前景色', 'Delete', { alt: true }, () => commands.run('fillForeground'));
  push('edit.fillBackground', '编辑', '填充背景色', 'Delete', { ctrl: true }, () => commands.run('fillBackground'));
  push('edit.clear', '编辑', '清除选区内容', 'Delete', {ctrl:true,shift: true}, () => commands.run('clearSelection'));
  push('edit.contentAware', '编辑', '内容识别填充', 'Delete', {shift:true}, () => commands.run('openFilter','contentAwareFill'));

  /* 画布 */
  push('canvas.size', '画布', '画布大小…', 'c', { ctrl: true, alt: true }, () => openDialog('canvasSize'));
  push('canvas.imageSize', '画布', '图像大小…', 'i', { ctrl: true, alt: true }, () => openDialog('imageSize'));

  /* 选择 */
  push('select.all', '选择', '全选', 'a', { ctrl: true }, () => commands.run('selectAll'));
  push('select.deselect', '选择', '取消选择', 'd', { ctrl: true }, () => commands.run('deselect'));
  push('select.inverse', '选择', '反选', 'i', { ctrl: true, shift: true }, () => commands.run('inverseSelection'));
  push('select.subject', '选择', '选择主体', 'a', { ctrl: true, alt: true }, () => commands.run('selectSubject'));

  /* 调整 */
  push('adjust.curves', '调整', '曲线调整层', 'm', { ctrl: true }, () => commands.run('openFilter','Curves'));
  push('adjust.levels', '调整', '色阶调整层', 'l', { ctrl: true }, () => commands.run('openFilter','Levels'));
  push('adjust.hueSaturation', '调整', '色相/饱和度调整层', 'u', { ctrl: true }, () => commands.run('openFilter','Hue/Saturation'));
  push('adjust.invertPixels', '调整', '反相像素 / 蒙版', 'i', { ctrl: true }, () => commands.run('invertPixels'));
  push('layer.transform', '图层', '自由变换', 't', {ctrl:true},()=>setTool('move'));

  /* 图层 */
  push('layer.duplicate', '图层', '复制图层', 'j', { ctrl: true }, () => commands.run('duplicateLayer'));
  push('layer.clipping', '图层', '创建剪贴蒙版', 'g', { ctrl: true, alt: true }, () => commands.run('toggleClipping'));
  push('layer.group', '图层', '编组', 'g', { ctrl: true }, () => commands.run('group'));
  push('layer.ungroup', '图层', '取消编组', 'g', { ctrl: true, shift: true }, () => commands.run('ungroup'));
  push('layer.up', '图层', '上移一层', ']', { ctrl: true }, () => commands.run('moveLayerUp'));
  push('layer.down', '图层', '下移一层', '[', { ctrl: true }, () => commands.run('moveLayerDown'));
  push('layer.mergeDown', '图层', '向下合并', 'e', { ctrl: true }, () => commands.run('mergeDown'));

  /* 视图 */
  push('view.fit', '视图', '适配画布', '0', { ctrl: true }, () => fitCanvas());
  push('view.actual', '视图', '实际像素', '1', { ctrl: true }, () => actualPixels());
  push('view.zoomIn', '视图', '放大', '=', { ctrl: true }, () => zoomStep(1));
  push('view.zoomOut', '视图', '缩小', '-', { ctrl: true }, () => zoomStep(-1));
  push('view.rulers', '视图', '显示标尺', 'r', { ctrl: true }, () => toggleUi('rulers'));
  push('view.grid', '视图', '显示网格', "'", { ctrl: true }, () => toggleUi('grid'));
  push('view.guides', '视图', '显示参考线', ';', { ctrl: true }, () => toggleUi('guides'));
  push('view.snap', '视图', '吸附设置…', ';', { ctrl: true, shift: true }, () => openDialog('snapSettings'));
  push('view.transformControls', '视图', '显示变换控件', 'h', { ctrl: true }, () => toggleUi('transformControls'));

  /* 画笔大小 / 硬度 */
  push('brush.smaller', '工具选项', '减小画笔大小', '[', {}, () => nudgeBrush(-1));
  push('brush.bigger', '工具选项', '增大画笔大小', ']', {}, () => nudgeBrush(1));
  push('brush.softer', '工具选项', '减小画笔硬度', '[', { shift: true }, () => nudgeHardness(-10));
  push('brush.harder', '工具选项', '增大画笔硬度', ']', { shift: true }, () => nudgeHardness(10));
  push('tool.swapColors', '工具选项', '交换前景/背景色', 'x', {}, () => swapColors());
  push('tool.resetColors', '工具选项', '复位颜色', 'd', {}, () => resetColors());

  /* 帮助 */
  push('help.shortcuts', '帮助', '键盘快捷键…', 'k', { ctrl: true }, () => openDialog('shortcuts'));

  push('view.commandPalette','视图','搜索命令','f',{ctrl:true},()=>openDialog('commandPalette'));
  push('view.canvasOnly','视图','仅画布','f',{},()=>{editorApi.ui.canvasOnly=!editorApi.ui.canvasOnly;editorApi.invalidate();});
  push('view.lockGuides','视图','锁定参考线',';',{ctrl:true,alt:true},()=>{editorApi.doc.guidesLocked=!editorApi.doc.guidesLocked;editorApi.invalidate();});
  push('tool.cycle','工具','循环工具模式','Tab',{},()=>cycleCurrentTool());
  push('tool.cycleBack','工具','反向循环工具模式','Tab',{shift:true},()=>cycleCurrentTool(-1));
  push('shape.cycle','工具','循环形状','u',{shift:true},()=>{setTool('shape');cycleCurrentTool();});
  push('layer.delete','图层','删除目标','Delete',{},()=>commands.run('deleteLayer'));
  push('blend.previous','图层','上一个混合模式','-',{shift:true},()=>commands.run('cycleBlend',-1));
  push('blend.next','图层','下一个混合模式','=',{shift:true},()=>commands.run('cycleBlend',1));

  return items;
}

/** 调整当前工具的画笔大小 */
function nudgeBrush(direction: number): void {
  const api = getApi();
  if (!api) return;
  const current = api.option<number>('size', 40);
  const step = direction > 0 ? Math.max(1, Math.round(current * 0.1)) : -Math.max(1, Math.round(current * 0.1));
  api.setToolOption('size', Math.max(1, current + step));
  api.status(`画笔大小：${Math.max(1, current + step)} px`);
}

/** 调整画笔硬度 */
function nudgeHardness(delta: number): void {
  const api = getApi();
  if (!api) return;
  const current = api.option<number>('hardness', 0.7);
  api.setToolOption('hardness', Math.max(0, Math.min(1, current + delta/100)));
  api.status(`画笔硬度：${Math.round(Math.max(0,Math.min(1,current+delta/100))*100)}%`);
}

/** 交换前景 / 背景色 */
function swapColors(): void {
  const api = getApi();
  if (!api) return;
  const foreground = api.foreground;
  api.setForeground(api.background);
  api.setBackground(foreground);
}

/** 复位颜色 */
function resetColors(): void {
  const api = getApi();
  if (!api) return;
  api.setForeground([0, 0, 0]);
  api.setBackground([255, 255, 255]);
}

/** 由 useEditor 注入的编辑器接口（避免循环依赖） */
let injectedApi: EditorApi | null = null;

/** 注入编辑器接口 */
export function bindShortcuts(api: EditorApi): void {
  injectedApi = api;
}

/** 取编辑器接口 */
function getApi(): EditorApi | null {
  return injectedApi;
}

/** 快捷键表（响应式） */
export const shortcutItems = reactive<ShortcutItem[]>(buildDefaults());

/** 分组顺序 */
export const SHORTCUT_GROUPS = ['文件', '编辑', '画布', '选择', '调整', '图层', '视图', '工具', '工具选项', '帮助'];

/** 读取持久化的自定义按键 */
export async function loadShortcutOverrides(): Promise<void> {
  const saved = await loadState<Record<string, ShortcutChord>>(STORAGE_KEY, {});
  for (const item of shortcutItems) {
    const chord = saved[item.id];
    if (chord && typeof chord.key === 'string') item.chord = { ...chord };
  }
}

/** 保存自定义按键 */
function persist(): void {
  const map: Record<string, ShortcutChord> = {};
  for (const item of shortcutItems) {
    if (!sameChord(item.chord, item.default)) map[item.id] = { ...item.chord };
  }
  void saveState(STORAGE_KEY, map);
}

/**
 * 修改某条快捷键。
 * @returns 与其它命令冲突的命令名；没有冲突返回 null
 */
export function setShortcut(id: string, chord: ShortcutChord): string | null {
  const target = shortcutItems.find((item) => item.id === id);
  if (!target) return null;
  const conflict = shortcutItems.find((item) => item.id !== id && sameChord(item.chord, chord));
  if(conflict)return conflict.title;
  target.chord = { ...chord };
  persist();
  return null;
}

/** 恢复单条默认 */
export function resetShortcut(id: string): void {
  const target = shortcutItems.find((item) => item.id === id);
  if (!target) return;
  target.chord = { ...target.default };
  persist();
}

/** 恢复全部默认 */
export function resetAllShortcuts(): void {
  for (const item of shortcutItems) item.chord = { ...item.default };
  persist();
}

/** 按按键组合查找命令 */
export function findShortcut(chord: ShortcutChord): ShortcutItem | null {
  return shortcutItems.find((item) => sameChord(item.chord, chord)) ?? null;
}

/** 某条快捷键是否被用户改过 */
export function isOverridden(id: string): boolean {
  const item = shortcutItems.find((entry) => entry.id === id);
  return item ? !sameChord(item.chord, item.default) : false;
}

/** 按分组整理（界面用） */
export function groupedShortcuts(): { group: string; items: ShortcutItem[] }[] {
  return SHORTCUT_GROUPS
    .map((group) => ({ group, items: shortcutItems.filter((item) => item.group === group) }))
    .filter((entry) => entry.items.length > 0);
}
