/**
 * 打包插件为 .oplg（与 otools/scripts/plugin_pack.py 产出格式一致）
 * ---------------------------------------------------------------
 * .oplg 是一个 ZIP，内含 plugin.json、logo.svg 与 dist/（可选 lib/）。
 * 这里不依赖第三方库：直接用 zlib 的 deflateRaw 手写 ZIP 结构，
 * 这样 CI 只需要 node 就能打包，不必额外安装依赖。
 *
 * 用法：node scripts/pack-plugin.mjs [--out dist] [--version 0.1.0]
 */
import { deflateRawSync, crc32 } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();

/** 读取命令行参数 */
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** 递归收集目录下的文件 */
function walk(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...walk(full, base));
    else if (stat.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** DOS 时间戳（ZIP 规范要求） */
function dosTime(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

/** 组装 ZIP */
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = dosTime(new Date());
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);   // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 名称标志
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, payload);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(now.time, 12);
    dir.writeUInt16LE(now.day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(0, 42);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

/** 主流程 */
function main() {
  const manifestPath = path.join(root, 'plugin.json');
  if (!fs.existsSync(manifestPath)) throw new Error('缺少 plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = arg('version', manifest.version);
  const packid = manifest.packid || manifest.uuid;
  const outDir = path.join(root, arg('out', 'dist-pack'));
  fs.mkdirSync(outDir, { recursive: true });

  // 覆盖版本号，保证包内 plugin.json 与文件名一致
  manifest.version = version;
  const entries = [{ name: 'plugin.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') }];

  for (const logo of ['logo.svg', 'logo.png']) {
    const full = path.join(root, logo);
    if (fs.existsSync(full)) entries.push({ name: logo, data: fs.readFileSync(full) });
  }
  for (const name of ['dist', 'lib']) {
    const dir = path.join(root, name);
    if (!fs.existsSync(dir)) continue;
    for (const relative of walk(dir)) {
      entries.push({ name: `${name}/${relative}`, data: fs.readFileSync(path.join(dir, relative)) });
    }
  }

  // 校验 entry 指向的文件确实在包里
  const entryFile = String(manifest.entry || '').replace(/^\.?\//, '');
  if (entryFile && !entries.some((item) => item.name === entryFile)) {
    throw new Error(`manifest.entry 指向的文件不在包内：${entryFile}（请先执行 pnpm build）`);
  }
  if (!entries.some((item) => item.name === 'logo.svg')) {
    throw new Error('插件市场要求根目录提供 logo.svg');
  }

  const output = path.join(outDir, `${packid}-${version}.oplg`);
  fs.writeFileSync(output, zip(entries));
  const meta = { packid, uuid: manifest.uuid, version, output, entries: entries.length };
  fs.writeFileSync(path.join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(meta)}\n`);
}

main();
