/**
 * 混合模式
 * ---------------------------------------------------------------
 * 24 种模式按 Photoshop 顺序排列：
 * 分离式（Multiply / Screen / Overlay 等）直接作用于 unpremultiplied 颜色分量；
 * 非分离式（Hue / Saturation / Color / Luminosity）遵循 W3C compositing-1 公式。
 */
import type { BlendMode } from '@/types/document';

/** 8 位分量的乘除查表（Photoshop 用 0-255 的整数近似，能避免浮点色差） */
const MULTIPLY_TABLE = new Uint8ClampedArray(256 * 256);
for (let a = 0; a < 256; a += 1) {
  for (let b = 0; b < 256; b += 1) {
    MULTIPLY_TABLE[a * 256 + b] = Math.round((a * b) / 255);
  }
}

function multiply(a: number, b: number): number {
  return MULTIPLY_TABLE[a * 256 + b];
}

function divide(a: number, b: number): number {
  return b === 0 ? 255 : Math.min(255, a * 255 / b);
}

function burn(base: number, blend: number): number {
  return blend === 0 ? 0 : 255 - Math.min(255, (255 - base) * 255 / blend);
}

function dodge(base: number, blend: number): number {
  return base === 0 ? 0 : Math.min(255, base * 255 / (255 - blend));
}

/** 非分离式辅助：SetLum / SetSat */
function setLum(rgb: [number, number, number], lum: number): [number, number, number] {
  const d = lum - (0.3 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2]);
  return [rgb[0] + d, rgb[1] + d, rgb[2] + d];
}

function sat(rgb: [number, number, number]): number {
  return Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
}

function setSat(rgb: [number, number, number], s: number): [number, number, number] {
  const indexOfMax = rgb.indexOf(Math.max(rgb[0], rgb[1], rgb[2]));
  const indexOfMin = rgb.indexOf(Math.min(rgb[0], rgb[1], rgb[2]));
  const others = [0, 1, 2].filter((i) => i !== indexOfMax && i !== indexOfMin) as [number, number];
  const result: [number, number, number] = [rgb[0], rgb[1], rgb[2]];
  if (indexOfMax === indexOfMin) return result;
  result[others[0]] = (rgb[others[0]] - rgb[indexOfMin]) * s / (rgb[indexOfMax] - rgb[indexOfMin]);
  result[others[1]] = (rgb[others[1]] - rgb[indexOfMin]) * s / (rgb[indexOfMax] - rgb[indexOfMin]);
  result[indexOfMin] = 0;
  result[indexOfMax] = s;
  return result;
}

/**
 * 计算一个分离式/非分离式混合结果。
 * @param cb 底色（下方合成结果，unpremultiplied 0-255）
 * @param cs 源色（上层图层，unpremultiplied 0-255）
 * @param mode 混合模式
 */
export function blendPixel(cb: [number, number, number], cs: [number, number, number], mode: BlendMode): [number, number, number] {
  const b0 = cb[0]; const b1 = cb[1]; const b2 = cb[2];
  const s0 = cs[0]; const s1 = cs[1]; const s2 = cs[2];
  let r0 = b0; let g0 = b1; let b00 = b2;
  switch (mode) {
    case 'Darken': r0 = Math.min(b0, s0); g0 = Math.min(b1, s1); b00 = Math.min(b2, s2); break;
    case 'Multiply': r0 = multiply(b0, s0); g0 = multiply(b1, s1); b00 = multiply(b2, s2); break;
    case 'Color Burn': r0 = burn(b0, s0); g0 = burn(b1, s1); b00 = burn(b2, s2); break;
    case 'Linear Burn': r0 = b0 + s0 - 255; g0 = b1 + s1 - 255; b00 = b2 + s2 - 255; break;
    case 'Lighten': r0 = Math.max(b0, s0); g0 = Math.max(b1, s1); b00 = Math.max(b2, s2); break;
    case 'Screen': r0 = 255 - multiply(255 - b0, 255 - s0); g0 = 255 - multiply(255 - b1, 255 - s1); b00 = 255 - multiply(255 - b2, 255 - s2); break;
    case 'Color Dodge': r0 = dodge(b0, s0); g0 = dodge(b1, s1); b00 = dodge(b2, s2); break;
    case 'Linear Dodge (Add)': r0 = b0 + s0; g0 = b1 + s1; b00 = b2 + s2; break;
    case 'Overlay': {
      const overlay = (b: number, s: number) => b <= 127.5 ? 2*b*s/255 : 255-2*(255-b)*(255-s)/255;
      r0=overlay(b0,s0); g0=overlay(b1,s1); b00=overlay(b2,s2); break;
    }
    case 'Hard Light': {
      const hard = (b: number, s: number) => s <= 127.5 ? 2*b*s/255 : 255-2*(255-b)*(255-s)/255;
      r0=hard(b0,s0); g0=hard(b1,s1); b00=hard(b2,s2); break;
    }
    case 'Soft Light': {
      const soft = (b: number, s: number): number => {
        const sn = s / 255;
        const bn = b / 255;
        const d = bn <= 0.25 ? ((16 * bn - 12) * bn + 4) * bn : Math.sqrt(bn);
        const result = sn <= 0.5 ? bn - (1 - 2*sn)*bn*(1-bn) : bn + (2*sn-1)*(d-bn);
        return result * 255;
      };
      r0 = soft(b0, s0); g0 = soft(b1, s1); b00 = soft(b2, s2);
      break;
    }
    case 'Vivid Light': {
      const vivid = (b: number, s: number): number => (s <= 127 ? (s === 0 ? 0 : 255 - Math.min(255, (255 - b) * 255 / (2 * s))) : (s === 255 ? 255 : Math.min(255, b * 255 / (2 * (255 - s)))));
      r0 = vivid(b0, s0); g0 = vivid(b1, s1); b00 = vivid(b2, s2);
      break;
    }
    case 'Linear Light': r0 = b0 + 2 * s0 - 255; g0 = b1 + 2 * s1 - 255; b00 = b2 + 2 * s2 - 255; break;
    case 'Pin Light': {
      const pin = (b:number,s:number) => s < 127.5 ? Math.min(b,2*s) : Math.max(b,2*s-255);
      r0=pin(b0,s0); g0=pin(b1,s1); b00=pin(b2,s2); break;
    }
    case 'Hard Mix': r0 = (b0 + s0 >= 255 ? 255 : 0); g0 = (b1 + s1 >= 255 ? 255 : 0); b00 = (b2 + s2 >= 255 ? 255 : 0); break;
    case 'Difference': r0 = Math.abs(b0 - s0); g0 = Math.abs(b1 - s1); b00 = Math.abs(b2 - s2); break;
    case 'Exclusion': r0 = b0 + s0 - 2 * multiply(b0, s0); g0 = b1 + s1 - 2 * multiply(b1, s1); b00 = b2 + s2 - 2 * multiply(b2, s2); break;
    case 'Subtract': r0 = b0 - s0; g0 = b1 - s1; b00 = b2 - s2; break;
    case 'Divide': r0 = divide(b0, s0); g0 = divide(b1, s1); b00 = divide(b2, s2); break;
    case 'Hue': {
      const set = setLum(setSat([s0, s1, s2], sat([b0, b1, b2])), 0.3 * b0 + 0.59 * b1 + 0.11 * b2);
      r0 = set[0]; g0 = set[1]; b00 = set[2];
      break;
    }
    case 'Saturation': {
      const set = setLum(setSat([b0, b1, b2], sat([s0, s1, s2])), 0.3 * b0 + 0.59 * b1 + 0.11 * b2);
      r0 = set[0]; g0 = set[1]; b00 = set[2];
      break;
    }
    case 'Color': {
      const set = setLum([s0, s1, s2], 0.3 * b0 + 0.59 * b1 + 0.11 * b2);
      r0 = set[0]; g0 = set[1]; b00 = set[2];
      break;
    }
    case 'Luminosity': {
      const set = setLum([b0, b1, b2], 0.3 * s0 + 0.59 * s1 + 0.11 * s2);
      r0 = set[0]; g0 = set[1]; b00 = set[2];
      break;
    }
    default: r0 = s0; g0 = s1; b00 = s2; break;
  }
  return [r0, g0, b00];
}

/** 是否为非分离式（作用在颜色而非分量） */
export function isNonSeparable(mode: BlendMode): boolean {
  return mode === 'Hue' || mode === 'Saturation' || mode === 'Color' || mode === 'Luminosity';
}

/**
 * 把一个图层区域混合进目标缓冲。
 * 公式：Co = [ab*(1-as)*Cb + as*((1-ab)*Cs + ab*B(Cb,Cs))] / ao
 * 这里 as 已经乘上蒙版/不透明度/剪贴蒙版覆盖率。
 */
export function compositeRegion(
  dst: Uint8ClampedArray,
  dstWidth: number,
  src: Uint8ClampedArray,
  count: number,
  blend: (cb: [number, number, number], cs: [number, number, number]) => [number, number, number],
): void {
  void dstWidth;
  for(let i=0;i<count;i++)compositePixel(dst,i*4,src,i*4,1,blend);
}

/** 生成某个混合模式的混合函数 */
export function blendFunction(mode: BlendMode): (cb: [number, number, number], cs: [number, number, number]) => [number, number, number] {
  if (mode === 'Normal') return (_cb, cs) => cs;
  return (cb, cs) => blendPixel(cb, cs, mode);
}
/** 8 位非预乘 RGBA 的 W3C 源覆盖合成；颜色混合仅作用于双方重叠部分。 */
export function compositePixel(
  dst: Uint8ClampedArray, di: number, src: ArrayLike<number>, si: number, opacity = 1,
  blend?: (cb:[number,number,number],cs:[number,number,number])=>[number,number,number],
): void {
  const as=src[si+3]/255*Math.max(0,Math.min(1,opacity));
  if(as<=0)return;
  const ab=dst[di+3]/255;
  if(ab<=0 || (!blend && as>=1)) {
    for(let c=0;c<3;c++)dst[di+c]=src[si+c];
    dst[di+3]=as*255;return;
  }
  const outA=as+ab*(1-as);
  const mixed=blend?.([dst[di],dst[di+1],dst[di+2]],[src[si],src[si+1],src[si+2]]);
  for(let c=0;c<3;c++) {
    const source=src[si+c],backdrop=dst[di+c];
    const blended=mixed?Math.max(0,Math.min(255,mixed[c])):source;
    dst[di+c]=(backdrop*ab*(1-as)+as*((1-ab)*source+ab*blended))/outA;
  }
  dst[di+3]=outA*255;
}
