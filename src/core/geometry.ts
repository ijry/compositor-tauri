/**
 * 几何与变换
 * ---------------------------------------------------------------
 * 图层在文档空间的映射统一用 3x3 齐次矩阵表示：
 *  - 无扭曲时是仿射矩阵（移动/缩放/旋转/翻转）；
 *  - 有扭曲时是四点单应矩阵（自由变换）。
 * 合成时逐像素做逆变换采样，因此非破坏性缩放到 5% 也不会丢像素。
 */
import type { LayerTransform, Point, Rect } from '@/types/document';

export type Matrix = number[]; // 9 个元素，行优先 [a,b,c,d,e,f,g,h,i]

export const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function multiplyMatrix(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[3] + m[2] * n[6],
    m[0] * n[1] + m[1] * n[4] + m[2] * n[7],
    m[0] * n[2] + m[1] * n[5] + m[2] * n[8],
    m[3] * n[0] + m[4] * n[3] + m[5] * n[6],
    m[3] * n[1] + m[4] * n[4] + m[5] * n[7],
    m[3] * n[2] + m[4] * n[5] + m[5] * n[8],
    m[6] * n[0] + m[7] * n[3] + m[8] * n[6],
    m[6] * n[1] + m[7] * n[4] + m[8] * n[7],
    m[6] * n[2] + m[7] * n[5] + m[8] * n[8],
  ];
}

export function applyMatrix(m: Matrix, x: number, y: number): Point {
  const w = m[6] * x + m[7] * y + m[8];
  const iw = w === 0 ? 1 : 1 / w;
  return { x: (m[0] * x + m[1] * y + m[2]) * iw, y: (m[3] * x + m[4] * y + m[5]) * iw };
}

/** 求逆矩阵（奇异时返回单位阵） */
export function invertMatrix(m: Matrix): Matrix {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return [...IDENTITY];
  const id = 1 / det;
  return [
    (e * i - f * h) * id, (c * h - b * i) * id, (b * f - c * e) * id,
    (f * g - d * i) * id, (a * i - c * g) * id, (c * d - a * f) * id,
    (d * h - e * g) * id, (b * g - a * h) * id, (a * e - b * d) * id,
  ];
}

export function translation(tx: number, ty: number): Matrix {
  return [1, 0, tx, 0, 1, ty, 0, 0, 1];
}

export function scaling(sx: number, sy: number): Matrix {
  return [sx, 0, 0, 0, sy, 0, 0, 0, 1];
}

export function rotation(degrees: number): Matrix {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [cos, -sin, 0, sin, cos, 0, 0, 0, 1];
}

/** 由四点对应关系求单应矩阵（src -> dst） */
export function homography(src: [Point, Point, Point, Point], dst: [Point, Point, Point, Point]): Matrix {
  // 解 8 元线性方程组（A x = b），x 为 [a,b,c,d,e,f,g,h]，i 固定为 1
  const A: number[][] = [];
  const b: number[] = [];
  for (let k = 0; k < 4; k += 1) {
    const { x, y } = src[k];
    const { x: X, y: Y } = dst[k];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  const n = 8;
  const m = A.map((row, index) => [...row, b[index]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return [...IDENTITY];
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const diag = m[col][col];
    for (let k = col; k <= n; k += 1) m[col][k] /= diag;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = m[row][col];
      if (factor === 0) continue;
      for (let k = col; k <= n; k += 1) m[row][k] -= factor * m[col][k];
    }
  }
  const h = m.map((row) => row[n]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/**
 * 由图层变换构造「局部像素坐标 -> 文档坐标」的矩阵。
 * 局部坐标以图层自身像素尺寸为准（0,0 到 width,height）。
 */
export function layerMatrix(transform: LayerTransform, pixelWidth: number, pixelHeight: number): Matrix {
  const { origin, size, rotation: angle, flipX, flipY, warp } = transform;
  let m: Matrix = translation(origin[0], origin[1]);
  m = multiplyMatrix(m, translation(size[0] / 2, size[1] / 2));
  m = multiplyMatrix(m, rotation(angle));
  const sx = (flipX ? -1 : 1) * (size[0] / Math.max(1e-6, pixelWidth));
  const sy = (flipY ? -1 : 1) * (size[1] / Math.max(1e-6, pixelHeight));
  m = multiplyMatrix(m, scaling(sx, sy));
  m = multiplyMatrix(m, translation(-pixelWidth / 2, -pixelHeight / 2));
  if (warp && warp.length === 4) {
    // 扭曲点以图层框的分数表示，需要先换算成局部像素坐标
    const corners: [Point, Point, Point, Point] = [
      { x: warp[0].x * pixelWidth, y: warp[0].y * pixelHeight },
      { x: warp[1].x * pixelWidth, y: warp[1].y * pixelHeight },
      { x: warp[2].x * pixelWidth, y: warp[2].y * pixelHeight },
      { x: warp[3].x * pixelWidth, y: warp[3].y * pixelHeight },
    ];
    const dst: [Point, Point, Point, Point] = [
      { x: 0, y: 0 },
      { x: pixelWidth, y: 0 },
      { x: pixelWidth, y: pixelHeight },
      { x: 0, y: pixelHeight },
    ];
    m = multiplyMatrix(m, homography(dst, corners));
  }
  return m;
}

/** 变换后的包围盒（对 4 个角取极值，足够覆盖仿射与单应情形） */
export function transformedBounds(m: Matrix, width: number, height: number): Rect {
  const points = [applyMatrix(m, 0, 0), applyMatrix(m, width, 0), applyMatrix(m, width, height), applyMatrix(m, 0, height)];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 矩形相交 */
export function intersectRect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

export function normalizeRect(rect: Rect): Rect {
  return {
    x: rect.width < 0 ? rect.x + rect.width : rect.x,
    y: rect.height < 0 ? rect.y + rect.height : rect.y,
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
}

/** 线段与轴对齐矩形是否相交 */
export function segmentIntersectsRect(p0: Point, p1: Point, rect: Rect): boolean {
  const inside = (p: Point): boolean => p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height;
  if (inside(p0) || inside(p1)) return true;
  const corners: Point[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  for (let i = 0; i < 4; i += 1) {
    if (segmentsIntersect(p0, p1, corners[i], corners[(i + 1) % 4])) return true;
  }
  return false;
}

export function segmentsIntersect(a0: Point, a1: Point, b0: Point, b1: Point): boolean {
  const d = (a1.x - a0.x) * (b1.y - b0.y) - (a1.y - a0.y) * (b1.x - b0.x);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((b0.x - a0.x) * (b1.y - b0.y) - (b0.y - a0.y) * (b1.x - b0.x)) / d;
  const u = ((b0.x - a0.x) * (a1.y - a0.y) - (b0.y - a0.y) * (a1.x - a0.x)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** 变换的逆：文档坐标 -> 局部像素坐标 */
export function inverseLayerMatrix(transform: LayerTransform, pixelWidth: number, pixelHeight: number): Matrix {
  return invertMatrix(layerMatrix(transform, pixelWidth, pixelHeight));
}

/** 计算在给定缩放下的显示包围盒 */
export function scaledRect(rect: Rect, scale: number): Rect {
  return { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale };
}
