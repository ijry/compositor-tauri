/**
 * 模糊与采样类滤镜内核
 * ---------------------------------------------------------------
 * 提供 RGBA 缓冲的高斯模糊、盒式模糊与动感模糊，
 * 供「高斯模糊/动感模糊调整层」「模糊工具」「镜头模糊」等复用。
 */
import { createBuffer } from '@/core/pixels';
import type { PixelBuffer } from '@/types/document';

/** 分离式高斯模糊（RGB 与 A 一起处理） */
export function gaussianBlurBuffer(buffer: PixelBuffer, radius: number): PixelBuffer {
  if (radius <= 0.05) return buffer;
  const { width, height } = buffer;
  const src = new Float32Array(buffer.data);
  // 三次盒式模糊逼近高斯，速度与质量折中
  const boxes = 3;
  const boxRadius = Math.max(1, Math.round(Math.sqrt((12 * radius * radius) / 3 + 1) - 0.5));
  let current = src;
  let next = new Float32Array(src.length);
  for (let pass = 0; pass < boxes; pass += 1) {
    boxBlurRgbaH(current, next, width, height, boxRadius);
    boxBlurRgbaV(next, current, width, height, boxRadius);
  }
  const out = createBuffer(width, height);
  out.data.set(current);
  return out;
}

/** 高斯模糊到已有缓冲（原地） */
export function gaussianBlurInto(target: PixelBuffer, radius: number): void {
  const blurred = gaussianBlurBuffer(target, radius);
  target.data.set(blurred.data);
}

function boxBlurRgbaH(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number): void {
  const window = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const sums = [0, 0, 0, 0];
    for (let c = 0; c < 4; c += 1) {
      let sum = 0;
      for (let i = -radius; i <= radius; i += 1) sum += src[(row + Math.min(width - 1, Math.max(0, i))) * 4 + c];
      sums[c] = sum;
    }
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        dst[(row + x) * 4 + c] = sums[c] / window;
        const addIndex = (row + Math.min(width - 1, x + radius + 1)) * 4 + c;
        const subIndex = (row + Math.max(0, x - radius)) * 4 + c;
        sums[c] += src[addIndex] - src[subIndex];
      }
    }
  }
}

function boxBlurRgbaV(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number): void {
  const window = radius * 2 + 1;
  for (let x = 0; x < width; x += 1) {
    const sums = [0, 0, 0, 0];
    for (let c = 0; c < 4; c += 1) {
      let sum = 0;
      for (let i = -radius; i <= radius; i += 1) sum += src[(Math.min(height - 1, Math.max(0, i)) * width + x) * 4 + c];
      sums[c] = sum;
    }
    for (let y = 0; y < height; y += 1) {
      for (let c = 0; c < 4; c += 1) {
        dst[(y * width + x) * 4 + c] = sums[c] / window;
        const addIndex = (Math.min(height - 1, y + radius + 1) * width + x) * 4 + c;
        const subIndex = (Math.max(0, y - radius) * width + x) * 4 + c;
        sums[c] += src[addIndex] - src[subIndex];
      }
    }
  }
}

/** 动感模糊：按角度与距离做线性核采样 */
export function motionBlurBuffer(buffer: PixelBuffer, angleDegrees: number, distance: number): PixelBuffer {
  if (distance <= 0.05) return buffer;
  const { width, height } = buffer;
  const out = createBuffer(width, height);
  const angle = (angleDegrees * Math.PI) / 180;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const steps = Math.max(2, Math.min(128, Math.round(distance)));
  const weights = new Float32Array(steps);
  let total = 0;
  for (let i = 0; i < steps; i += 1) {
    // 权重取高斯形，让中心更实
    const t = steps === 1 ? 0 : i / (steps - 1) * 2 - 1;
    weights[i] = Math.exp(-t * t * 2);
    total += weights[i];
  }
  for (let i = 0; i < steps; i += 1) weights[i] /= total;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let i = 0; i < steps; i += 1) {
        const t = (i / (steps - 1) - 0.5) * distance;
        const sx = Math.round(x + dx * t);
        const sy = Math.round(y + dy * t);
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const si = (sy * width + sx) * 4;
        const w = weights[i];
        r += buffer.data[si] * w;
        g += buffer.data[si + 1] * w;
        b += buffer.data[si + 2] * w;
        a += buffer.data[si + 3] * w;
      }
      const di = (y * width + x) * 4;
      out.data[di] = r; out.data[di + 1] = g; out.data[di + 2] = b; out.data[di + 3] = a;
    }
  }
  return out;
}

/** 镜头模糊：半径随距离线性增长的圆形核 */
export function lensBlurBuffer(buffer: PixelBuffer, amount: number): PixelBuffer {
  if (amount <= 0.05) return buffer;
  const { width, height } = buffer;
  const out = createBuffer(width, height);
  const maxRadius = Math.min(40, Math.max(1, Math.round(amount)));
  const cx = width / 2;
  const cy = height / 2;
  const maxDistance = Math.hypot(cx, cy);
  const samples = 16;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const distance = Math.hypot(x - cx, y - cy) / maxDistance;
      const radius = Math.round(distance * maxRadius);
      if (radius <= 0) {
        const si = (y * width + x) * 4;
        out.data[si] = buffer.data[si];
        out.data[si + 1] = buffer.data[si + 1];
        out.data[si + 2] = buffer.data[si + 2];
        out.data[si + 3] = buffer.data[si + 3];
        continue;
      }
      let r = 0; let g = 0; let b = 0; let a = 0; let count = 0;
      for (let s = 0; s < samples; s += 1) {
        const angle = (s / samples) * Math.PI * 2;
        const sx = Math.round(x + Math.cos(angle) * radius);
        const sy = Math.round(y + Math.sin(angle) * radius);
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const si = (sy * width + sx) * 4;
        r += buffer.data[si]; g += buffer.data[si + 1]; b += buffer.data[si + 2]; a += buffer.data[si + 3];
        count += 1;
      }
      const di = (y * width + x) * 4;
      out.data[di] = count ? r / count : 0;
      out.data[di + 1] = count ? g / count : 0;
      out.data[di + 2] = count ? b / count : 0;
      out.data[di + 3] = count ? a / count : 0;
    }
  }
  return out;
}

/** 单像素盒式模糊（模糊工具用，半径较大时更快） */
export function boxBlurRegion(
  buffer: PixelBuffer,
  rect: { x: number; y: number; width: number; height: number },
  radius: number,
): void {
  const {width,height}=buffer;
  if(!Number.isFinite(radius) || radius<=0 || width<=0 || height<=0)return;
  const x0=Math.max(0,Math.floor(rect.x)),y0=Math.max(0,Math.floor(rect.y));
  const x1=Math.min(width,Math.ceil(rect.x+rect.width)),y1=Math.min(height,Math.ceil(rect.y+rect.height));
  if(x1<=x0 || y1<=y0)return;
  const r=Math.min(Math.max(width,height),Math.max(1,Math.round(radius))),size=r*2+1;
  const rw=x1-x0,rh=y1-y0;
  // 只分配编辑区域及上下 halo；横向读取全图，纵向只使用局部行号。
  const temp=new Float32Array(rw*(rh+2*r)*4);
  const clampX=(x:number)=>Math.max(0,Math.min(width-1,x));
  for(let ty=0;ty<rh+2*r;ty++) {
    const y=Math.max(0,Math.min(height-1,y0-r+ty));
    for(let c=0;c<4;c++) {
      const channel=(x:number)=>{const i=(y*width+clampX(x))*4;return c===3?buffer.data[i+3]:buffer.data[i+c]*buffer.data[i+3]/255;};
      let sum=0;for(let k=-r;k<=r;k++)sum+=channel(x0+k);
      for(let x=0;x<rw;x++) {
        temp[(ty*rw+x)*4+c]=sum/size;
        if(x+1<rw)sum+=channel(x0+x+r+1)-channel(x0+x-r);
      }
    }
  }
  for(let x=0;x<rw;x++) {
    const sums=[0,0,0,0];
    for(let y=0;y<size;y++)for(let c=0;c<4;c++)sums[c]+=temp[(y*rw+x)*4+c];
    for(let y=0;y<rh;y++) {
      const i=((y+y0)*width+x+x0)*4,alpha=sums[3]/size;
      // 滤波阶段使用预乘颜色，写回时还原非预乘，透明邻域不染黑边。
      for(let c=0;c<3;c++)buffer.data[i+c]=alpha>0?(sums[c]/size)*255/alpha:0;
      buffer.data[i+3]=alpha;
      if(y+1<rh)for(let c=0;c<4;c++)sums[c]+=temp[((y+size)*rw+x)*4+c]-temp[(y*rw+x)*4+c];
    }
  }
}
