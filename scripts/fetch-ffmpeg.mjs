#!/usr/bin/env node
/**
 * 取内置 ffmpeg（老板 2026-11-09 裁决 6：「不大就内置在我们的软件里面」）。
 *
 * 为什么不在仓库里存 79MB 二进制：公开仓克隆体积会被永久拖大；改为**构建时取**——
 * 固定版本 + 固定 sha256 与体积（.gz 与解压后 exe **都校验**），不符就红。
 * 源：npmmirror 的 ffmpeg-static b6.1.1（Gyan 6.1.1 essentials 构建；国内可直连）。
 *
 * 产物：vendor/ffmpeg/ffmpeg.exe（.gitignore 忽略）＋ vendor/ffmpeg/LICENSE.txt（随包分发用）。
 * 用法：node scripts/fetch-ffmpeg.mjs [--force]
 *
 * 独立验收 P3-11（2026-11-09）：已有文件也复核指纹——「存在即信任」会让被替换/截断的二进制混进安装包。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, 'vendor', 'ffmpeg');
const OUT_EXE = join(OUT_DIR, 'ffmpeg.exe');
const OUT_LICENSE = join(OUT_DIR, 'LICENSE.txt');
const OUT_GPL = join(OUT_DIR, 'UPSTREAM-LICENSE.txt');

/** 固定版本（改版本必须同时改下面四个指纹；--force 才强制重下）。 */
const SOURCE_URL = 'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-win32-x64.gz';
const EXPECT_GZ_BYTES = 29581307;
const EXPECT_GZ_SHA256 = '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77';
const EXPECT_EXE_BYTES = 82797568;
const EXPECT_EXE_SHA256 = '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00';
/** 上游随包许可证（GPL-3.0 全文，独立验收 S13：只给 URL 不算随包分发合规）。 */
const GPL_URL = 'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/win32-x64.LICENSE';
const EXPECT_GPL_BYTES = 35147;

const LICENSE_TEXT = `ffmpeg (bundled binary)
=======================

Binary: ffmpeg.exe (FFmpeg 6.1.1-essentials_build, Gyan builds — https://www.gyan.dev/ffmpeg/builds/)
License: GNU General Public License v3 (GPL-3.0)
Full license text: https://www.gnu.org/licenses/gpl-3.0.txt
Corresponding source: https://github.com/FFmpeg/FFmpeg (tag n6.1.1) and https://github.com/GyanD/codexffmpeg (build scripts)

This product includes software developed by the FFmpeg project (https://ffmpeg.org/).
Licensees may obtain the complete corresponding source code from the URLs above.
`;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 已有 exe 是否可信（体积＋sha256 双重校验）。 */
function existingExeIsValid() {
  if (!existsSync(OUT_EXE)) return false;
  const buf = readFileSync(OUT_EXE);
  return buf.length === EXPECT_EXE_BYTES && sha256(buf) === EXPECT_EXE_SHA256;
}

/** 取上游 GPL-3.0 全文（随包分发用；已存在且体积对就跳过）。 */
async function ensureGpl() {
  if (existsSync(OUT_GPL) && statSync(OUT_GPL).size === EXPECT_GPL_BYTES) return;
  const resp = await fetch(GPL_URL);
  if (!resp.ok) throw new Error(`取上游许可证失败 HTTP ${resp.status}（${GPL_URL}）`);
  const text = Buffer.from(await resp.arrayBuffer());
  if (text.length !== EXPECT_GPL_BYTES) throw new Error(`上游许可证体积不符：${text.length} ≠ ${EXPECT_GPL_BYTES}`);
  writeFileSync(OUT_GPL, text);
  console.log(`[ffmpeg] 已取上游 GPL-3.0 全文：${OUT_GPL}`);
}

async function main() {
  const force = process.argv.includes('--force');
  if (!force && existingExeIsValid()) {
    console.log(`[ffmpeg] 已有 ${OUT_EXE}（${(statSync(OUT_EXE).size / 1048576).toFixed(1)} MB，指纹复核通过），跳过下载`);
    if (!existsSync(OUT_LICENSE)) writeFileSync(OUT_LICENSE, LICENSE_TEXT, 'utf8');
    await ensureGpl();
    return;
  }
  if (!force && existsSync(OUT_EXE)) {
    console.warn('[ffmpeg] 已有文件指纹不符（被替换/截断？）→ 重新下载');
  }
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[ffmpeg] 下载 ${SOURCE_URL}`);
  const resp = await fetch(SOURCE_URL);
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}（源不可用时手动放置 ${OUT_EXE} 亦可）`);
  const gz = Buffer.from(await resp.arrayBuffer());
  if (gz.length !== EXPECT_GZ_BYTES) throw new Error(`gz 体积不符：${gz.length} ≠ ${EXPECT_GZ_BYTES}（源文件变了，需重核指纹）`);
  const gzSha = sha256(gz);
  if (gzSha !== EXPECT_GZ_SHA256) throw new Error(`gz sha256 不符：${gzSha}（拒绝使用未核实的下载）`);
  const exe = gunzipSync(gz);
  if (exe.length !== EXPECT_EXE_BYTES) throw new Error(`exe 体积不符：${exe.length} ≠ ${EXPECT_EXE_BYTES}`);
  const exeSha = sha256(exe);
  if (exeSha !== EXPECT_EXE_SHA256) throw new Error(`exe sha256 不符：${exeSha}（解压产物与预期不同，拒绝写入）`);
  if (exe.subarray(0, 2).toString('latin1') !== 'MZ') throw new Error('解压结果不是 PE 可执行文件');
  writeFileSync(OUT_EXE, exe);
  writeFileSync(OUT_LICENSE, LICENSE_TEXT, 'utf8');
  await ensureGpl();
  console.log(`[ffmpeg] 完成：${OUT_EXE}（${(exe.length / 1048576).toFixed(1)} MB，指纹通过）＋ LICENSE.txt`);
}

main().catch((error) => {
  console.error(`[ffmpeg] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
