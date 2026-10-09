import { copyPixels, pixelDepth } from '@/core/pixelFormat';
import { createBuffer } from '@/core/pixels';
/**
 * 内容感知操作
 * ---------------------------------------------------------------
 * 1. contentAwareFill：基于「快速数字图像修补」的优先级队列算法，
 *    从选区边界逐圈向内推进，每一步都在已知区域搜索最相似的补丁来填充；
 * 2. spotHeal：污点修复画笔，在半径范围内搜索最匹配的补丁并羽化混合；
 * 3. cloneSample：仿制图章采样，支持单层与「所有图层」。
 * 这些算法都是真实的像素运算，不依赖任何外部模型。
 */
import { cloneBuffer } from '@/core/pixels';
import type { PixelBuffer } from '@/types/document';

export interface InpaintOptions {
  /** 补丁半径（像素），越大越能带走纹理 */
  patchRadius: number;
  /** 搜索半径（像素） */
  searchRadius: number;
  /** 最大迭代步数，防止超大选区卡死 */
  maxIterations: number;
}

/**
 * 内容识别填充。
 * @param buffer 目标像素缓冲
 * @param hole 0/1 数组，1 表示需要填充
 */
export function inpaint(buffer: PixelBuffer, hole: Uint8Array, options: InpaintOptions): void {
  const { width, height } = buffer;
  const patch = Math.max(1, Math.round(options.patchRadius));
  const search = Math.max(patch + 1, Math.round(options.searchRadius));
  const data = buffer.data;
  const confidence = new Float32Array(width * height);
  for (let i = 0; i < confidence.length; i += 1) confidence[i] = hole[i] ? 0 : 1;

  // 修补缓冲：从未知像素的最近已知邻居取值作为初值
  const filled = copyPixels(data);
  const seedQueue: number[] = [];
  const isHole = (x: number, y: number): boolean => (x < 0 || y < 0 || x >= width || y >= height) ? true : hole[y * width + x] === 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!hole[y * width + x]) continue;
      let r = 0; let g = 0; let b = 0; let a = 0; let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const sx = x + dx; const sy = y + dy;
          if (isHole(sx, sy)) continue;
          const si = (sy * width + sx) * 4;
          r += data[si]; g += data[si + 1]; b += data[si + 2]; a += data[si + 3];
          count += 1;
        }
      }
      const di = (y * width + x) * 4;
      if (count > 0) {
        filled[di] = r / count; filled[di + 1] = g / count; filled[di + 2] = b / count; filled[di + 3] = a / count;
      }
      seedQueue.push(y * width + x);
    }
  }
  data.set(filled);
  // 优先级：置信度高、离已知区域近的先处理（简化版用队列 + 置信度传播）
  const queue: number[] = seedQueue;
  let head = 0;
  let iterations = 0;
  const patchCost = (targetX: number, targetY: number, sourceX: number, sourceY: number): number => {
    let cost = 0;
    let samples = 0;
    for (let dy = -patch; dy <= patch; dy += 2) {
      for (let dx = -patch; dx <= patch; dx += 2) {
        const tx = targetX + dx;
        const ty = targetY + dy;
        if (isHole(tx, ty)) continue;
        // 越界按夹取处理，允许从画布外取样（支持超出图像边缘的填充）
        const sx = Math.max(0, Math.min(width - 1, sourceX + dx));
        const sy = Math.max(0, Math.min(height - 1, sourceY + dy));
        const ti = (Math.max(0, Math.min(height - 1, ty)) * width + Math.max(0, Math.min(width - 1, tx))) * 4;
        const si = (sy * width + sx) * 4;
        cost += Math.abs(data[ti] - data[si]) + Math.abs(data[ti + 1] - data[si + 1]) + Math.abs(data[ti + 2] - data[si + 2]);
        samples += 1;
      }
    }
    return samples === 0 ? Number.POSITIVE_INFINITY : cost / samples;
  };
  while (head < queue.length && iterations < options.maxIterations) {
    const index = queue[head];
    head += 1;
    iterations += 1;
    const x = index % width;
    const y = (index / width) | 0;
    const confidenceHere = confidence[index];
    const neighbors: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of neighbors) {
      const nx = x + dx;
      const ny = y + dy;
      if (!isHole(nx, ny)) continue;
      // 在已知区域搜索与当前位置最相似的补丁
      let bestCost = Number.POSITIVE_INFINITY;
      let bestX = nx;
      let bestY = ny;
      for (let sy = Math.max(patch, ny - search); sy <= Math.min(height - patch - 1, ny + search); sy += 2) {
        for (let sx = Math.max(patch, nx - search); sx <= Math.min(width - patch - 1, nx + search); sx += 2) {
          if (hole[sy * width + sx]) continue;
          const cost = patchCost(nx, ny, sx, sy);
          if (cost < bestCost) {
            bestCost = cost;
            bestX = sx; bestY = sy;
          }
        }
      }
      const ni = ny * width + nx;
      const di = ni * 4;
      const si = (bestY * width + bestX) * 4;
      data[di] = data[si];
      data[di + 1] = data[si + 1];
      data[di + 2] = data[si + 2];
      data[di + 3] = data[si + 3];
      confidence[ni] = confidenceHere;
      queue.push(ni);
      hole[ni] = 0; // 标记为已处理，避免重复入队
      // 同步更新 hole 的副本不影响调用方（调用方传的是副本）
    }
  }
  void search;
}

/**
 * 内容识别填充（面向图层操作）：
 * 选区内的像素被邻近内容替换；sample 用于从其他图层取样（为空则用本层）。
 */
export function contentAwareFill(
  target: PixelBuffer,
  selection: Uint8Array,
  sample?: PixelBuffer | null,
  options?: Partial<InpaintOptions>,
): void {
  const hole = new Uint8Array(selection.length);
  for (let i = 0; i < hole.length; i += 1) hole[i] = selection[i] > 8 ? 1 : 0;
  const working = cloneBuffer(target);
  if (sample) {
    // 把取样图层按不透明度合成进工作缓冲，供补丁搜索使用
    for (let i = 0; i < working.data.length; i += 4) {
      const as = sample.data[i + 3] / 255;
      if (as <= 0 || hole[i / 4] === 0) continue;
      working.data[i] = working.data[i] * (1 - as) + sample.data[i] * as;
      working.data[i + 1] = working.data[i + 1] * (1 - as) + sample.data[i + 1] * as;
      working.data[i + 2] = working.data[i + 2] * (1 - as) + sample.data[i + 2] * as;
      working.data[i + 3] = Math.max(working.data[i + 3], sample.data[i + 3]);
    }
  }
  const area = hole.reduce((sum, value) => sum + value, 0);
  const scaling = Math.sqrt(area / 4000);
  inpaint(working, hole, {
    patchRadius: Math.max(1, Math.round(2 * Math.min(3, scaling))),
    searchRadius: Math.max(6, Math.round(Math.min(24, 6 * Math.min(3, scaling)))),
    maxIterations: Math.max(200, area * 2),
  });
  // 只把选区内的结果写回
  for (let i = 0; i < target.data.length; i += 4) {
    const k = selection[i / 4] / 255;
    if (k <= 0) continue;
    target.data[i] = target.data[i] * (1 - k) + working.data[i] * k;
    target.data[i + 1] = target.data[i + 1] * (1 - k) + working.data[i + 1] * k;
    target.data[i + 2] = target.data[i + 2] * (1 - k) + working.data[i + 2] * k;
    target.data[i + 3] = target.data[i + 3] * (1 - k) + working.data[i + 3] * k;
  }
}

/**
 * 污点修复：在以 (x, y) 为中心、半径 radius 的范围内，
 * 从周围环形区域里搜索最匹配的补丁来替换，并用羽化混合消除接缝。
 */
export function spotHeal(buffer: PixelBuffer, x: number, y: number, radius: number, searchRadius = 40): void {
  const { width, height } = buffer;
  const size = Math.max(1, Math.round(radius * 2));
  const patch = Math.max(1, Math.round(radius));
  const sampleBest = (sx: number, sy: number): number => {
    let cost = 0;
    let count = 0;
    for (let dy = -patch; dy <= patch; dy += 2) {
      for (let dx = -patch; dx <= patch; dx += 2) {
        // 只比较环带上的已知像素（中心是需要修复的区域）
        const distance = Math.hypot(dx, dy);
        if (distance < patch * 0.6) continue;
        const tx = Math.round(x + dx);
        const ty = Math.round(y + dy);
        if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
        const ti = (ty * width + tx) * 4;
        const ui = (Math.min(height - 1, Math.max(0, ty + sy)) * width + Math.min(width - 1, Math.max(0, tx + sx))) * 4;
        cost += Math.abs(buffer.data[ti] - buffer.data[ui])
          + Math.abs(buffer.data[ti + 1] - buffer.data[ui + 1])
          + Math.abs(buffer.data[ti + 2] - buffer.data[ui + 2]);
        count += 1;
      }
    }
    return count === 0 ? Number.POSITIVE_INFINITY : cost / count;
  };
  let bestX = 0;
  let bestY = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let sy = -searchRadius; sy <= searchRadius; sy += 2) {
    for (let sx = -searchRadius; sx <= searchRadius; sx += 2) {
      if (Math.hypot(sx, sy) < patch) continue;
      const cost = sampleBest(sx, sy);
      if (cost < bestCost) { bestCost = cost; bestX = sx; bestY = sy; }
    }
  }
  const snapshot = cloneBuffer(buffer);
  for (let dy = 0; dy < size; dy += 1) {
    for (let dx = 0; dx < size; dx += 1) {
      const px = Math.round(x - radius + dx);
      const py = Math.round(y - radius + dy);
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const distance = Math.hypot(px - x, py - y);
      if (distance > radius) continue;
      // 边缘羽化：中心完全替换，边缘过渡
      const feather = Math.max(0, Math.min(1, (radius - distance) / Math.max(1, radius * 0.35)));
      const sx = Math.max(0, Math.min(width - 1, px + bestX));
      const sy = Math.max(0, Math.min(height - 1, py + bestY));
      const si = (sy * width + sx) * 4;
      const ti = (py * width + px) * 4;
      buffer.data[ti] = snapshot.data[ti] * (1 - feather) + buffer.data[si] * feather;
      buffer.data[ti + 1] = snapshot.data[ti + 1] * (1 - feather) + buffer.data[si + 1] * feather;
      buffer.data[ti + 2] = snapshot.data[ti + 2] * (1 - feather) + buffer.data[si + 2] * feather;
      buffer.data[ti + 3] = snapshot.data[ti + 3] * (1 - feather) + buffer.data[si + 3] * feather;
    }
  }
}

/** 内容感知缩放（用于「图像大小」时保护主体，简单实现为内容识别填充的扩展） */
export function contentAwareExtend(buffer: PixelBuffer, margin: { top: number; right: number; bottom: number; left: number }): PixelBuffer {
  const { width, height } = buffer;
  const newWidth = width + margin.left + margin.right;
  const newHeight = height + margin.top + margin.bottom;
  if (newWidth <= width && newHeight <= height) return buffer;
  const out = createBuffer(newWidth,newHeight,undefined,pixelDepth(buffer));
  for (let y = 0; y < newHeight; y += 1) {
    for (let x = 0; x < newWidth; x += 1) {
      const sx = Math.min(width - 1, Math.max(0, x - margin.left));
      const sy = Math.min(height - 1, Math.max(0, y - margin.top));
      const si = (sy * width + sx) * 4;
      const di = (y * newWidth + x) * 4;
      out.data[di] = buffer.data[si];
      out.data[di + 1] = buffer.data[si + 1];
      out.data[di + 2] = buffer.data[si + 2];
      out.data[di + 3] = buffer.data[si + 3];
    }
  }
  const hole = new Uint8Array(newWidth * newHeight);
  for (let y = 0; y < newHeight; y += 1) {
    for (let x = 0; x < newWidth; x += 1) {
      const outside = x < margin.left || y < margin.top || x >= newWidth - margin.right || y >= newHeight - margin.bottom;
      if (outside) hole[y * newWidth + x] = 1;
    }
  }
  inpaint(out, hole, { patchRadius: 3, searchRadius: 30, maxIterations: hole.length });
  return out;
}
