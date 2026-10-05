/**
 * 编辑器对外接口
 * ---------------------------------------------------------------
 * 工具、面板与对话框都通过这个接口操作文档，
 * 好处是：所有修改都会经过统一的历史记录、重绘与脏标记流程。
 */
import type { PixelBuffer, Point, Rect } from '@/types/document';

/** 图层快照（撤销用） */
export interface LayerSnapshot {
  pixels: PixelBuffer | null;
  mask: { width: number; height: number; data: Uint8Array<ArrayBuffer> } | null;
  transform: Layer['transform'];
  opacity: number;
  blendMode: Layer['blendMode'];
  text: Layer['text'];
  shape: Layer['shape'];
  effects: Layer['effects'];
  adjustment: Layer['adjustment'];
}

/** 打开对话框的请求 */
export interface DialogRequest {
  name: string;
  payload?: unknown;
}

/** 编辑器 API */
export interface EditorApi {
  /** 当前文档（响应式） */
  doc: import('@/types/document').CompDocument;
  /** 当前工具 id */
  toolId: string;
  /** 当前工具选项 */
  toolOptions: Record<string, unknown>;
  /** 视口 */
  viewport: import('@/core/engine/renderer').Viewport;
  /** 是否显示标尺 / 网格 / 参考线 */
  ui: {
    rulers: boolean;
    grid: boolean;
    guides: boolean;
    transformControls: boolean;
    selection: boolean;
  };

  /** 当前指针的文档坐标（画笔类工具用于绘制笔尖光标） */
  pointer: Point | null;

  /* --- 基础操作 --- */
  /** 请求重绘 */
  invalidate(): void;
  /** 更新视口 */
  setViewport(patch: Partial<import('@/core/engine/renderer').Viewport>): void;
  /** 写入状态栏消息 */
  status(message: string): void;
  /** 打开对话框 */
  openDialog(name: string, payload?: unknown): void;
  /** 标记文档已修改 */
  touch(label?: string): void;

  /* --- 历史 --- */
  pushHistory(label: string, undo: () => void, redo: () => void, bytes?: number, mergeKey?: string): void;
  /** 交互开始：记录当前状态，结束时可提交为一条历史 */
  beginInteraction(label: string): void;
  /** 交互结束：提交历史 */
  endInteraction(commit?: boolean): void;

  /* --- 图层 --- */
  activeLayer(): Layer | null;
  findLayer(id: string): Layer | null;
  snapshotLayer(id: string): LayerSnapshot | null;
  restoreLayer(id: string, snapshot: LayerSnapshot): void;
  /** 图层内容已变化（触发重绘并使缓存失效） */
  markLayerDirty(id: string): void;

  /* --- 选区 --- */
  selectionSnapshot(): import('@/types/document').SelectionMask | null;
  restoreSelection(selection: import('@/types/document').SelectionMask | null): void;
  setSelection(selection: import('@/types/document').SelectionMask | null, mode?: 'replace' | 'add' | 'subtract' | 'intersect'): void;

  /* --- 颜色 --- */
  foreground: [number, number, number];
  background: [number, number, number];
  setForeground(color: [number, number, number]): void;
  setBackground(color: [number, number, number]): void;

  /* --- 合成 --- */
  /** 当前文档的全分辨率合成（用于魔棒、吸管、对象选择、全图层仿制） */
  composite(): PixelBuffer;
  /** 画布屏幕尺寸 */
  stageSize(): { width: number; height: number };
  /** 文档坐标 -> 屏幕坐标 */
  toScreen(point: Point): Point;
  /** 屏幕坐标 -> 文档坐标 */
  toDoc(point: Point): Point;

  /* --- 工具选项 --- */
  setToolOption(key: string, value: unknown): void;
  option<T>(key: string, fallback: T): T;

  /* --- 常用命令（供工具与菜单共用） --- */
  /** 在当前绘制目标上落笔 */
  command(name: string, payload?: unknown): void;
}

type Layer = import('@/types/document').Layer;

/** 工具覆盖层常用的矩形绘制 */
export function strokeRect(ctx: CanvasRenderingContext2D, rect: Rect, color = '#38bdf8', width = 1): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash([]);
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width, rect.height);
  ctx.restore();
}
