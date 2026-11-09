#!/usr/bin/env node
/**
 * 取内置 ffmpeg（老板 2026-11-09 裁决 6：「不大就内置在我们的软件里面」）。
 *
 * 为什么不在仓库里存 79MB 二进制：公开仓克隆体积会被永久拖大；改为**构建时取**——
 * 固定版本 + 固定 sha256，取不到/校验不过就**红**（不静默降级，否则打出来的包没 ffmpeg）。
 * 源：npmmirror 的 ffmpeg-static b6.1.1（Gyan 6.1.1 essentials 构建；国内可直连）。
 *
 * 产物：vendor/ffmpeg/ffmpeg.exe（.gitignore 忽略）＋ vendor/ffmpeg/LICENSE.txt（随包分发用）。
 * 用法：node scripts/fetch-ffmpeg.mjs [--force]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, 'vendor', 'ffmpeg');
const OUT_EXE = join(OUT_DIR, 'ffmpeg.exe');
const OUT_LICENSE = join(OUT_DIR, 'LICENSE.txt');

/** 固定版本（改版本必须同时改 sha256 与体积；--force 才重下）。 */
const SOURCE_URL = 'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-win32-x64.gz';
const EXPECT_BYTES = 29581307; // .gz 体积（2026-11-09 实测）
const EXPECT_SHA256 = '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77';

/** GPL-3.0 随包声明（完整 GPL 正文见 THIRD_PARTY_NOTICES.md 指向的官方链接）。 */
const LICENSE_TEXT = `ffmpeg (bundled binary)
=======================

Binary: ffmpeg.exe (FFmpeg 6.1.1-essentials_build, Gyan builds — https://www.gyan.dev/ffmpeg/builds/)
License: GNU General Public License v3 (GPL-3.0)
Full license text: https://www.gnu.org/licenses/gpl-3.0.txt
Corresponding source: https://github.com/FFmpeg/FFmpeg (tag n6.1.1) and https://github.com/GyanD/codexffmpeg (build scripts)

This product includes software developed by the FFmpeg project (https://ffmpeg.org/).
Licensees may obtain the complete corresponding source code from the URLs above.
`;

async function main() {
  const force = process.argv.includes('--force');
  if (!force && existsSync(OUT_EXE)) {
    const st = await import('node:fs').then((m) => m.statSync(OUT_EXE));
    console.log(`[ffmpeg] 已有 ${OUT_EXE}（${(st.size / 1048576).toFixed(1)} MB），跳过下载（--force 可重下）`);
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[ffmpeg] 下载 ${SOURCE_URL}`);
  const resp = await fetch(SOURCE_URL);
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}（源不可用时手动放置 ${OUT_EXE} 亦可）`);
  const gz = Buffer.from(await resp.arrayBuffer());
  if (gz.length !== EXPECT_BYTES) throw new Error(`体积不符：${gz.length} ≠ ${EXPECT_BYTES}（源文件变了，需重核 sha256）`);
  const sha = createHash('sha256').update(gz).digest('hex');
  if (sha !== EXPECT_SHA256) throw new Error(`sha256 不符：${sha}（拒绝使用未核实的二进制）`);
  const exe = gunzipSync(gz);
  if (exe.subarray(0, 2).toString('latin1') !== 'MZ') throw new Error('解压结果不是 PE 可执行文件');
  writeFileSync(OUT_EXE, exe);
  writeFileSync(OUT_LICENSE, LICENSE_TEXT, 'utf8');
  console.log(`[ffmpeg] 完成：${OUT_EXE}（${(exe.length / 1048576).toFixed(1)} MB）＋ LICENSE.txt`);
}

main().catch((error) => {
  console.error(`[ffmpeg] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
