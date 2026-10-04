/**
 * 工具注册表
 * ---------------------------------------------------------------
 * 工具栏按 groups 顺序显示，同一组内可长按或按 Tab 循环选择。
 */
import { brushTool, cloneTool, eraserTool, healingTool, liquifyTool, smudgeTool } from '@/tools/paint';
import { blurTool } from '@/tools/paint';
import { lassoTool, marqueeTool, objectSelectTool, wandTool } from '@/tools/selection';
import { cropTool, eyedropperTool, gradientTool, handTool, moveTool, shapeTool, typeTool, zoomTool } from '@/tools/transform';
import type { ToolDefinition } from '@/tools/types';

/** 工具栏分组（顺序即显示顺序） */
export const TOOL_GROUPS: { id: string; label: string; tools: string[] }[] = [
  { id: 'move', label: '移动 / 变换', tools: ['move'] },
  { id: 'marquee', label: '框选', tools: ['marquee'] },
  { id: 'lasso', label: '套索', tools: ['lasso'] },
  { id: 'magic', label: '魔棒 / 对象选择', tools: ['wand', 'objectSelect'] },
  { id: 'crop', label: '裁剪', tools: ['crop'] },
  { id: 'paint', label: '画笔 / 渐变', tools: ['brush', 'gradient'] },
  { id: 'erase', label: '橡皮擦', tools: ['eraser'] },
  { id: 'retouch', label: '修复 / 仿制 / 滤镜工具', tools: ['healing', 'clone', 'blur', 'smudge', 'liquify'] },
  { id: 'draw', label: '形状 / 文字', tools: ['shape', 'type'] },
  { id: 'sample', label: '吸管', tools: ['eyedropper'] },
  { id: 'view', label: '抓手 / 缩放', tools: ['hand', 'zoom'] },
];

/** 全部工具 */
export const TOOLS: ToolDefinition[] = [
  moveTool, marqueeTool, lassoTool, wandTool, objectSelectTool, cropTool,
  brushTool, gradientTool, eraserTool, healingTool, cloneTool, blurTool, smudgeTool, liquifyTool,
  shapeTool, typeTool, eyedropperTool, handTool, zoomTool,
];

const toolMap = new Map(TOOLS.map((tool) => [tool.id, tool]));

/** 按 id 取工具 */
export function getTool(id: string): ToolDefinition | undefined {
  return toolMap.get(id);
}

/** 同组内的下一个工具（Tab 循环） */
export function cycleTool(toolId: string, direction: 1 | -1): string {
  const tool = toolMap.get(toolId);
  if (!tool) return toolId;
  const group = TOOL_GROUPS.find((item) => item.tools.includes(toolId));
  if (!group || group.tools.length < 2) return toolId;
  const index = group.tools.indexOf(toolId);
  const next = (index + direction + group.tools.length) % group.tools.length;
  return group.tools[next]!;
}

/** 快捷键 -> 工具 id（与上游 Photoshop 风格一致） */
export const TOOL_SHORTCUTS: Record<string, string> = {
  v: 'move',
  m: 'marquee',
  l: 'lasso',
  w: 'wand',
  c: 'crop',
  b: 'brush',
  g: 'gradient',
  e: 'eraser',
  j: 'healing',
  s: 'clone',
  r: 'blur',
  u: 'shape',
  t: 'type',
  i: 'eyedropper',
  h: 'hand',
  z: 'zoom',
};

/** 同一快捷键下的其它工具（Tab 循环） */
export function alternateTools(shortcutTool: string): string[] {
  const tool = toolMap.get(shortcutTool);
  if (!tool) return [];
  const group = TOOL_GROUPS.find((item) => item.tools.includes(shortcutTool));
  if (!group || group.tools.length < 2) return [];
  return group.tools.filter((id) => id !== shortcutTool);
}
