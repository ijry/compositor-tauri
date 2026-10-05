/**
 * 文档数据模型
 * ---------------------------------------------------------------
 * 与上游 Compositor 的 .comp v11 清单结构一一对应：
 *  - 图层自下而上排列，最后一个绘制在最上层；
 *  - 组用 parentId 表达，数组顺序即同级兄弟顺序；
 *  - 蒙版是可编辑的灰度资产，剪贴蒙版用 clipping 标记；
 *  - 调整层没有像素，只有 adjustment 记录。
 */

/** 采样方式（与 .comp 的 sampling 字段取值一致） */
export type SamplingMode = 'High quality' | 'Smooth' | 'Nearest';

/** 24 种混合模式，顺序即 Photoshop 的排列顺序 */
export type BlendMode =
  | 'Normal'
  | 'Darken'
  | 'Multiply'
  | 'Color Burn'
  | 'Linear Burn'
  | 'Lighten'
  | 'Screen'
  | 'Color Dodge'
  | 'Linear Dodge (Add)'
  | 'Overlay'
  | 'Soft Light'
  | 'Hard Light'
  | 'Vivid Light'
  | 'Linear Light'
  | 'Pin Light'
  | 'Hard Mix'
  | 'Difference'
  | 'Exclusion'
  | 'Subtract'
  | 'Divide'
  | 'Hue'
  | 'Saturation'
  | 'Color'
  | 'Luminosity';

export const BLEND_MODES: BlendMode[] = [
  'Normal', 'Darken', 'Multiply', 'Color Burn', 'Linear Burn',
  'Lighten', 'Screen', 'Color Dodge', 'Linear Dodge (Add)',
  'Overlay', 'Soft Light', 'Hard Light', 'Vivid Light', 'Linear Light', 'Pin Light', 'Hard Mix',
  'Difference', 'Exclusion', 'Subtract', 'Divide',
  'Hue', 'Saturation', 'Color', 'Luminosity',
];


/** 混合模式的中文显示名（内部存储仍用英文，保持与 .comp / PSD 一致） */
export const BLEND_MODE_LABELS: Record<BlendMode, string> = {
  Normal: '正常',
  Darken: '变暗',
  Multiply: '正片叠底',
  'Color Burn': '颜色加深',
  'Linear Burn': '线性加深',
  Lighten: '变亮',
  Screen: '滤色',
  'Color Dodge': '颜色减淡',
  'Linear Dodge (Add)': '线性减淡（添加）',
  Overlay: '叠加',
  'Soft Light': '柔光',
  'Hard Light': '强光',
  'Vivid Light': '亮光',
  'Linear Light': '线性光',
  'Pin Light': '点光',
  'Hard Mix': '实色混合',
  Difference: '差值',
  Exclusion: '排除',
  Subtract: '减去',
  Divide: '划分',
  Hue: '色相',
  Saturation: '饱和度',
  Color: '颜色',
  Luminosity: '明度',
};

/** 采样方式的中文显示名 */
export const SAMPLING_LABELS: Record<SamplingMode, string> = {
  'High quality': '高质量',
  Smooth: '平滑',
  Nearest: '邻近',
};
/** 矩形（文档像素坐标） */
export interface Rect { x: number; y: number; width: number; height: number }

/** 点的简写 */
export interface Point { x: number; y: number }

/** 图层变换：origin 为左上角，size 为尺寸，rotation 为顺时针角度 */
export interface LayerTransform {
  origin: [number, number];
  size: [number, number];
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  sampling: SamplingMode;
  /** 自由扭曲的四个源角点（局部坐标），为空表示未扭曲 */
  warp?: [Point, Point, Point, Point] | null;
}

/** 像素缓冲：始终为 8 位 RGBA，非预乘 */
export interface PixelBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** 灰度蒙版：8 位，白=显示，黑=隐藏 */
export interface MaskBuffer {
  width: number;
  height: number;
  data: Uint8Array<ArrayBuffer>;
}

/** 图层蒙版信息 */
export interface LayerMask {
  pixels: MaskBuffer;
  enabled: boolean;
  /** 是否跟随图层变换；false 时使用自己的 maskPlacement */
  linked: boolean;
  /** 未链接蒙版在文档空间的矩形 */
  placement: Rect | null;
  /** 会话内选择的目标：图像像素还是蒙版 */
  target: 'image' | 'mask';
  inverted: boolean;
}

/** 文字图层元数据（像素是显示与导出兜底，元数据用于再次编辑） */
export interface TextMeta {
  content: string;
  fontName: string;
  fontSize: number;
  color: [number, number, number];
  align: 'left' | 'center' | 'right';
  tracking: number;
  lineSpacing: number;
  boxSize: [number, number] | null;
  bold: boolean;
  italic: boolean;
  /** 局部彩色区间（UTF-16 下标） */
  colorRuns?: { location: number; length: number; color: [number, number, number] }[];
  /** 局部字体区间 */
  fontRuns?: { location: number; length: number; fontName: string }[];
}

/** 形状图层元数据：像素是兜底，元数据用于按参数重绘 */
export interface ShapeMeta {
  kind: 'rectangle' | 'roundedRectangle' | 'ellipse' | 'line';
  color: [number, number, number];
  cornerRadius: number;
  fillEnabled: boolean;
  strokeWidth: number;
  strokeColor: [number, number, number];
  /** 直线端点，值为图层框的分数 */
  start: [number, number];
  end: [number, number];
}

/** 色阶区间（输入黑点/gamma/输入白点/输出黑点/输出白点） */
export interface LevelRange {
  black: number; gamma: number; white: number; outputBlack: number; outputWhite: number;
}

export interface LevelsSettings {
  channel: 'RGB' | 'Red' | 'Green' | 'Blue';
  /** RGB、红、绿、蓝共 4 组 */
  ranges: LevelRange[];
}

export interface CurveChannel {
  /** 点按 x 递增，x/y 均为 0-255 */
  points: [number, number][];
}
export interface CurvesSettings {
  channel: 'RGB' | 'Red' | 'Green' | 'Blue';
  /** RGB、红、绿、蓝共 4 条 */
  channels: CurveChannel[];
}

export interface GradientMapStop {
  position: number;
  color: [number, number, number];
}
export interface GradientMapSettings {
  shadows: [number, number, number];
  mids: [number, number, number];
  highlights: [number, number, number];
  reversed: boolean;
  customStops?: GradientMapStop[];
}

export interface GrainSettings {
  amount: number;
  size: number;
  roughness: number;
  colorAmount: number;
  seed: number;
}

export interface BlackWhiteSettings {
  reds: number; yellows: number; greens: number; cyans: number;
  blues: number; magentas: number; tintEnabled: boolean; tintColor: [number, number, number];
}

export interface ColorBalanceSettings {
  shadowCyanRed: number; shadowMagentaGreen: number; shadowYellowBlue: number;
  midCyanRed: number; midMagentaGreen: number; midYellowBlue: number;
  highlightCyanRed: number; highlightMagentaGreen: number; highlightYellowBlue: number;
  preserveLuminosity: boolean;
}

/** 调整层的 12 种类型 */
export type AdjustmentKind =
  | 'Hue/Saturation' | 'Levels' | 'Curves' | 'Exposure' | 'Gradient Map'
  | 'Grain' | 'Black & White' | 'Color Balance' | 'Invert'
  | 'Gaussian Blur' | 'Motion Blur' | 'Add Noise';

export interface AdjustmentRecord {
  kind: AdjustmentKind;
  /** 色相 -360..360，饱和度/明度 -100..100 */
  hue: number;
  saturation: number;
  lightness: number;
  colorize: boolean;
  levels: LevelsSettings;
  curves: CurvesSettings;
  exposureSettings: { exposure: number; offset: number; gamma: number };
  gradientMapSettings: GradientMapSettings;
  grainSettings: GrainSettings;
  blackWhiteSettings: BlackWhiteSettings;
  colorBalanceSettings: ColorBalanceSettings;
  /** 以下三个为 v9 起的邻域采样类调整 */
  blurRadius: number;
  motionAngle: number;
  motionDistance: number;
  noiseAmount: number;
  noiseGaussian: boolean;
  noiseMonochromatic: boolean;
  noiseSeed: number;
}

export interface StrokeEffect {
  enabled?: boolean;
  size: number;
  color: [number, number, number];
  opacity: number;
  inside: boolean;
}

export interface ShadowEffect {
  enabled?: boolean;
  angle: number;
  distance: number;
  blur: number;
  color: [number, number, number];
  opacity: number;
}

export interface ColorOverlayEffect {
  enabled?: boolean;
  color: [number, number, number];
  opacity: number;
}

export interface GlowEffect {
  enabled?: boolean;
  size: number;
  color: [number, number, number];
  opacity: number;
}

export interface LayerEffects {
  stroke?: StrokeEffect;
  shadow?: ShadowEffect;
  colorOverlay?: ColorOverlayEffect;
  innerShadow?: ShadowEffect;
  outerGlow?: GlowEffect;
  innerGlow?: GlowEffect;
}

/** 图层基类字段 */
export interface LayerBase {
  id: string;
  name: string;
  isVisible: boolean;
  opacity: number;
  blendMode: BlendMode;
  transform: LayerTransform;
  /** 组父级，null 表示根层 */
  parentId: string | null;
  /** 剪贴蒙版：以紧邻的下方图层为基础 */
  clipping: boolean;
  mask: LayerMask | null;
  effects: LayerEffects | null;
  /** 会话内状态，不写入工程 */
  expanded: boolean;
  locked: boolean;
  /** 像素/蒙版内容版本号：像素变化时自增，供渲染缓存判断 */
  contentKey: number;
}

export interface PixelLayer extends LayerBase {
  kind: 'pixel';
  pixels: PixelBuffer;
  text: TextMeta | null;
  shape: ShapeMeta | null;
  adjustment: null;
}

export interface AdjustmentLayer extends LayerBase {
  kind: 'adjustment';
  pixels: null;
  text: null;
  shape: null;
  adjustment: AdjustmentRecord;
}

export interface GroupLayer extends LayerBase {
  kind: 'group';
  pixels: null;
  text: null;
  shape: null;
  adjustment: null;
}

export type Layer = PixelLayer | AdjustmentLayer | GroupLayer;

/** 选区：与文档同尺寸的 8 位覆盖率蒙版 */
export interface SelectionMask {
  width: number;
  height: number;
  data: Uint8Array<ArrayBuffer>;
  /** 矢量工具留下的轮廓点（多边形套索等），便于再次编辑 */
  outline: Point[] | null;
}

export interface Guide {
  id: string;
  axis: 'horizontal' | 'vertical';
  position: number;
}

export interface GridSettings {
  enabled: boolean;
  spacing: number;
  subdivisions: number;
  showBorder: boolean;
  color: string;
}

/** 吸附目标开关 */
export interface SnapSettings {
  guides: boolean;
  grid: boolean;
  layers: boolean;
  document: boolean;
}

export interface DocumentStats {
  width: number;
  height: number;
  layers: number;
  /** 估算占用字节 */
  memory: number;
}

export interface CameraRawSettings {
  exposure: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  vibrance: number;
  clarity: number;
  dehaze: number;
  curvePoints: [number, number][];
  colorMixer: { hue: number; saturation: number; luminance: number; red: number; orange: number; yellow: number; green: number; aqua: number; blue: number; purple: number; magenta: number }[];
  colorGrading: { shadows: [number, number, number]; mids: [number, number, number]; highlights: [number, number, number] };
  sharpening: number;
  radius: number;
  detail: number;
  denoise: number;
  vignette: number;
  grain: number;
  removeCA: number;
  distortion: number;
  defringe: number;
  cropLeft: number;
  cropTop: number;
  cropRight: number;
  cropBottom: number;
}

/** 一个工程标签页（一个文档） */
export interface CompDocument {
  id: string;
  name: string;
  width: number;
  height: number;
  resolution: number;
  layers: Layer[];
  activeLayerId: string | null;
  selection: SelectionMask | null;
  guides: Guide[];
  grid: GridSettings;
  snap: SnapSettings;
  /** 前景色 / 背景色 */
  foreground: [number, number, number];
  background: [number, number, number];
  dirty: boolean;
  /** 工程包路径（.comp 目录） */
  packagePath: string | null;
  saving: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 浮动选区：选区内被抠出的像素，可移动/复制/落地 */
export interface FloatingSelection {
  pixels: PixelBuffer;
  mask: MaskBuffer;
  /** 在文档空间的左上角 */
  x: number;
  y: number;
}

/** 相机 RAW 原始数据（解码后） */
export interface RawImage {
  /** 去马赛克后的线性 RGB */
  data: PixelBuffer;
  width: number;
  height: number;
  cameraModel: string;
  settings: CameraRawSettings;
}
