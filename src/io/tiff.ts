/**
 * 最小 TIFF 解码器
 * ---------------------------------------------------------------
 * 用于导入相机 TIFF 与普通 TIFF 文件：
 * 支持 II/MM 字节序、8/16 位、无压缩 / PackBits / LZW、条带(Strip)与分块(Tile)、
 * 以及常见 photometric（灰度、RGB、调色板）。
 * 输出统一转换为 8 位 RGBA 缓冲。
 */
import { createBuffer } from '@/core/pixels';
import type { PixelBuffer } from '@/types/document';

interface TiffEntry {
  tag: number;
  type: number;
  count: number;
  valueOffset: number;
  inlineValue: number;
}

const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/** 解码 TIFF，返回 RGBA 缓冲 */
export async function decodeTiff(data: Uint8Array): Promise<PixelBuffer | null> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.byteLength < 8) return null;
  const little = view.getUint16(0, false) === 0x4949;
  const magic = view.getUint16(2, little);
  if (magic !== 42) return null; // 只支持经典 TIFF（BigTIFF 交给 RAW 模块）
  const ifdOffset = view.getUint32(4, little);
  const entries = readIfd(view, ifdOffset, little);
  const tag = (id: number): TiffEntry | undefined => entries.find((entry) => entry.tag === id);

  const width = readScalar(view, tag(256), little) ?? 0;
  const height = readScalar(view, tag(257), little) ?? 0;
  const bitsPerSample = readArray(view, tag(258), little);
  const samples = readScalar(view, tag(277), little) ?? 1;
  const compression = readScalar(view, tag(259), little) ?? 1;
  const photometric = readScalar(view, tag(262), little) ?? 1;
  const tiles = !!tag(324);
  const stripOffsets = readArray(view, tag(tiles ? 324 : 273), little);
  const stripCounts = readArray(view, tag(tiles ? 325 : 279), little);
  const rowsPerStrip = readScalar(view, tag(278), little) ?? height;
  const planarConfig = readScalar(view, tag(284), little) ?? 1;
  const predictor = readScalar(view, tag(317), little) ?? 1;
  const sampleFormat = readScalar(view, tag(339), little) ?? 1;
  const palette = readArray(view, tag(320), little);
  const paletteCount = readScalar(view, tag(321), little) ?? 0;

  if (width <= 0 || height <= 0 || stripOffsets.length === 0) return null;
  const bits = bitsPerSample.length > 0 ? bitsPerSample[0]! : 8;
  const bytesPerSample = Math.max(1, Math.ceil(bits / 8));
  const rowBytes = Math.ceil((width * samples * bits) / 8);

  if(width*height>100_000_000 || ![8,16].includes(bits) || planarConfig!==1 || sampleFormat!==1)throw new Error('TIFF尺寸、位深或分平面布局暂不支持');
  if(![1,5,8,32946,32773].includes(compression))throw new Error(`不支持的TIFF压缩方式：${compression}`);
  const raw = new Uint8Array(rowBytes * height);
  const tileWidth=tiles?(readScalar(view,tag(322),little)??0):width;
  const tileHeight=tiles?(readScalar(view,tag(323),little)??0):rowsPerStrip;
  if(tileWidth<1||tileHeight<1||tileWidth*tileHeight*samples*bytesPerSample>512_000_000)throw new Error('TIFF分块尺寸无效');
  const columns=Math.ceil(width/tileWidth),unitRowBytes=tileWidth*samples*bytesPerSample;
  const units=tiles?columns*Math.ceil(height/tileHeight):Math.ceil(height/rowsPerStrip);
  if(stripOffsets.length<units||stripCounts.length<units)throw new Error('TIFF条带/分块数据缺失');
  for(let unit=0;unit<units;unit++) {
    const x=tiles?(unit%columns)*tileWidth:0,y=tiles?Math.floor(unit/columns)*tileHeight:unit*rowsPerStrip;
    const rows=tiles?tileHeight:Math.min(rowsPerStrip,height-y),expected=unitRowBytes*rows;
    const start=stripOffsets[unit]!,count=stripCounts[unit]!;
    if(start<0||count<1||start+count>data.length)throw new Error('TIFF数据范围无效');
    const chunk=data.subarray(start,start+count);
    let decoded=compression===1?new Uint8Array(chunk):compression===5?decodeLzw(chunk,expected):compression===32773?decodePackBits(chunk,expected):await inflate(chunk,expected);
    if(decoded.length<expected)throw new Error('TIFF像素数据不完整');
    // 预测器在每块的每行重新开始，不能跨块继续累加。
    if(predictor===2)applyHorizontalPredictor(decoded,tileWidth,samples,bytesPerSample,unitRowBytes,rows,little);
    else if(predictor!==1)throw new Error('TIFF预测器暂不支持');
    for(let row=0;row<rows&&y+row<height;row++) {
      const length=Math.min(tileWidth,width-x)*samples*bytesPerSample;
      raw.set(decoded.subarray(row*unitRowBytes,row*unitRowBytes+length),(y+row)*rowBytes+x*samples*bytesPerSample);
    }
  }

  const out = createBuffer(width, height,undefined,bits===16?16:8);
  const maxValue = (1 << Math.min(16, bits)) - 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const di = (y * width + x) * 4;
      if (samples === 1) {
        const value = readSample(raw, (y * rowBytes) + x * bytesPerSample, bytesPerSample, little, sampleFormat, maxValue);
        if (photometric === 3 && palette.length > 0) {
          const base = value * 3;
          out.data[di] = palette[base] ?? 0;
          out.data[di + 1] = palette[base + 1] ?? 0;
          out.data[di + 2] = palette[base + 2] ?? 0;
        } else if (photometric === 0) {
          out.data[di] = out.data[di + 1] = out.data[di + 2] = 255 - value;
        } else {
          out.data[di] = out.data[di + 1] = out.data[di + 2] = value;
        }
        out.data[di + 3] = 255;
      } else {
        const base = (y * rowBytes) + x * samples * bytesPerSample;
        out.data[di] = readSample(raw, base, bytesPerSample, little, sampleFormat, maxValue);
        out.data[di + 1] = readSample(raw, base + bytesPerSample, bytesPerSample, little, sampleFormat, maxValue);
        out.data[di + 2] = readSample(raw, base + bytesPerSample * 2, bytesPerSample, little, sampleFormat, maxValue);
        out.data[di + 3] = samples >= 4
          ? readSample(raw, base + bytesPerSample * 3, bytesPerSample, little, sampleFormat, maxValue)
          : 255;
      }
    }
  }
  void paletteCount;
  return out;
}

function readIfd(view: DataView, offset: number, little: boolean): TiffEntry[] {
  const count = view.getUint16(offset, little);
  const entries: TiffEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = offset + 2 + i * 12;
    const tag = view.getUint16(base, little);
    const type = view.getUint16(base + 2, little);
    const countValue = view.getUint32(base + 4, little);
    const size = (TYPE_SIZES[type] ?? 1) * countValue;
    entries.push({
      tag,
      type,
      count: countValue,
      valueOffset: size <= 4 ? base + 8 : view.getUint32(base + 8, little),
      inlineValue: size <= 4 ? view.getUint32(base + 8, little) : 0,
    });
  }
  return entries;
}

function readScalar(view: DataView, entry: TiffEntry | undefined, little: boolean): number | null {
  if (!entry) return null;
  switch (entry.type) {
    case 3: return view.getUint16(entry.valueOffset, little);
    case 4: return view.getUint32(entry.valueOffset, little);
    case 1: return view.getUint8(entry.valueOffset);
    case 8: return view.getInt16(entry.valueOffset, little);
    case 9: return view.getInt32(entry.valueOffset, little);
    default: return null;
  }
}

function readArray(view: DataView, entry: TiffEntry | undefined, little: boolean): number[] {
  if (!entry) return [];
  const values: number[] = [];
  const size = TYPE_SIZES[entry.type] ?? 1;
  for (let i = 0; i < entry.count; i += 1) {
    const position = entry.valueOffset + i * size;
    if (entry.type === 3) values.push(view.getUint16(position, little));
    else if (entry.type === 4) values.push(view.getUint32(position, little));
    else if (entry.type === 1) values.push(view.getUint8(position));
    else if (entry.type === 2) values.push(view.getUint8(position));
    else values.push(view.getUint32(position, little));
  }
  return values;
}

function readSample(raw: Uint8Array, offset: number, bytes: number, little: boolean, sampleFormat: number, maxValue: number): number {
  if (offset < 0 || offset + bytes > raw.length) return 0;
  let value = 0;
  if (bytes === 1) value = raw[offset]!;
  else if (bytes === 2) value = little ? raw[offset]! | (raw[offset + 1]! << 8) : (raw[offset]! << 8) | raw[offset + 1]!;
  else value = raw[offset]!;
  if (sampleFormat === 2) value = 255 - value;
  if (maxValue === 255) return value;
  return bytes===2?(value/maxValue)*255:Math.round((value / maxValue) * 255);
}

/** TIFF水平差分按像素的同一通道还原，16位进位与文件字节序必须一起处理。 */
function applyHorizontalPredictor(raw:Uint8Array,width:number,samples:number,bytes:number,rowBytes:number,height:number,little:boolean):void {
  const view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
  for(let y=0;y<height;y++)for(let x=1;x<width;x++)for(let channel=0;channel<samples;channel++) {
    const current=y*rowBytes+(x*samples+channel)*bytes,previous=current-samples*bytes;
    if(bytes===1)raw[current]=(raw[current]!+raw[previous]!)&255;
    else view.setUint16(current,(view.getUint16(current,little)+view.getUint16(previous,little))&65535,little);
  }
}

function decodePackBits(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let offset = 0;
  let writeIndex = 0;
  while (offset < input.length && writeIndex < expected) {
    const header = (input[offset]! << 24) >> 24;
    offset += 1;
    if (header >= 0) {
      const count = header + 1;
      for (let i = 0; i < count && writeIndex < expected; i += 1) {
        out[writeIndex] = input[offset] ?? 0;
        offset += 1;
        writeIndex += 1;
      }
    } else if (header !== -128) {
      const count = 1 - header;
      const value = input[offset] ?? 0;
      offset += 1;
      for (let i = 0; i < count && writeIndex < expected; i += 1) {
        out[writeIndex] = value;
        writeIndex += 1;
      }
    }
  }
  return out;
}

/** TIFF 使用的 LZW 解码 */
function decodeLzw(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  const dictionary: Uint8Array[] = [];
  const resetDictionary = (): void => {
    dictionary.length = 0;
    for (let i = 0; i < 256; i += 1) dictionary.push(new Uint8Array([i]));
    dictionary.push(new Uint8Array([])); // 256 清码
    dictionary.push(new Uint8Array([])); // 257 EOI
  };
  resetDictionary();
  let codeWidth = 9;
  let bitBuffer = 0;
  let bitCount = 0;
  let writeIndex = 0;
  let previous: Uint8Array | null = null;
  for (let i = 0; i + 1 < input.length && writeIndex < expected; i += 1) {
    bitBuffer = (bitBuffer << 8) | input[i]!;
    bitCount += 8;
    while (bitCount >= codeWidth) {
      const code = (bitBuffer >> (bitCount - codeWidth)) & ((1 << codeWidth) - 1);
      bitCount -= codeWidth;
      if (code === 257) return out;
      if (code === 256) {
        resetDictionary();
        codeWidth = 9;
        previous = null;
        continue;
      }
      let entry: Uint8Array;
      if (code < dictionary.length && dictionary[code]) entry = dictionary[code]!;
      else if (previous) {
        entry = new Uint8Array(previous.length + 1);
        entry.set(previous);
        entry[previous.length] = previous[0]!;
      } else {
        return out;
      }
      for (let k = 0; k < entry.length && writeIndex < expected; k += 1) {
        out[writeIndex] = entry[k]!;
        writeIndex += 1;
      }
      if (previous) {
        const added = new Uint8Array(previous.length + 1);
        added.set(previous);
        added[previous.length] = entry[0]!;
        dictionary.push(added);
      }
      previous = entry;
      if (dictionary.length + 1 >= (1 << codeWidth) && codeWidth < 12) codeWidth += 1;
    }
  }
  return out;
}

/** 使用浏览器内置 DecompressionStream 解 zlib/deflate 数据（TIFF 方式 8/32946） */
async function inflate(input: Uint8Array, expected: number): Promise<Uint8Array> {
  const format = 'deflate' as CompressionFormat;
  if (typeof DecompressionStream === 'undefined') {
    const fallback = new Uint8Array(expected);
    fallback.set(input.subarray(0, Math.min(input.length, expected)));
    return fallback;
  }
  const stream = new Blob([input as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  const buffer = await new Response(stream).arrayBuffer();
  const out = new Uint8Array(expected);
  out.set(new Uint8Array(buffer).subarray(0, Math.min(expected, buffer.byteLength)));
  return out;
}

/** 判断是否是 TIFF 文件 */
export function isTiff(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42 && bytes[3] === 0)
    || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 42);
}
