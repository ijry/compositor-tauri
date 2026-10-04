/**
 * 工具框架类型
 * ---------------------------------------------------------------
 * 工具只描述「怎么响应指针事件、怎么画覆盖层」，
 * 所有对文档的修改都必须通过 EditorApi（见 src/types/editor.ts），
 * 以便统一进入历史记录并触发重绘。
 */
import type { Viewport } from '@/core/engine/renderer';
import type { PixelBuffer, Point } from '@/types/document';
import type { EditorApi } from '@/types/editor';

/** 指针事件（坐标已转换为文档空间） */
export interface ToolPointerEvent {
  doc: Point;
  screen: Point;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  /** 0 左键 / 1 中键 / 2 右键 */
  button: number;
  pressure: number;
}

/** 覆盖层绘制上下文 */
export interface ToolOverlayContext {
  ctx: CanvasRenderingContext2D;
  editor: EditorApi;
  viewport: Viewport;
  width: number;
  height: number;
  /** 文档像素 -> 屏幕像素 */
  toScreen: (p: Point) => Point;
  /** 屏幕像素 -> 文档像素 */
  toDoc: (p: Point) => Point;
}

/** 工具选项的描述（工具选项头据此自动生成界面） */
export type ToolOptionType = 'number' | 'select' | 'boolean' | 'color' | 'slider';

export interface ToolOptionSpec {
  key: string;
  label: string;
  type: ToolOptionType;
  min?: number;
  max?: number;
  step?: number;
  /** select 类型的候选项 */
  options?: { value: string | number; label: string }[];
  /** 单位后缀 */
  unit?: string;
}

export interface ToolDefinition {
  id: string;
  name: string;
  /** Photoshop 风格快捷键 */
  shortcut: string;
  /** 工具栏分组（同一组内可用 Tab 循环） */
  group: string;
  icon: string;
  cursor?: string;
  /** 默认选项值 */
  defaults: Record<string, unknown>;
  /** 选项描述 */
  specs: ToolOptionSpec[];
  /** 按下 */
  onDown?(editor: EditorApi, event: ToolPointerEvent): void;
  /** 拖动 */
  onMove?(editor: EditorApi, event: ToolPointerEvent): void;
  /** 松开 */
  onUp?(editor: EditorApi, event: ToolPointerEvent): void;
  /** 双击（提交当前操作，如裁剪、文字） */
  onDblClick?(editor: EditorApi, event: ToolPointerEvent): void;
  /** 键盘（工具内） */
  onKeyDown?(editor: EditorApi, event: KeyboardEvent): boolean;
  /** 覆盖层绘制 */
  drawOverlay?(context: ToolOverlayContext): void;
  /** 切换到该工具时 */
  activate?(editor: EditorApi): void;
  /** 离开该工具时 */
  deactivate?(editor: EditorApi): void;
  /** 需要覆盖层持续重绘 */
  animate?(editor: EditorApi): boolean;
}

/** 从合成结果采样颜色（魔棒、吸管、对象选择共用） */
export function sampleComposite(buffer: PixelBuffer, x: number, y: number): [number, number, number, number] {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= buffer.width || py >= buffer.height) return [0, 0, 0, 0];
  const i = (py * buffer.width + px) * 4;
  return [buffer.data[i]!, buffer.data[i + 1]!, buffer.data[i + 2]!, buffer.data[i + 3]!];
}
