/**
 * Windows toast AUMID（2026-10-29， 未验证收口）：
 *
 * 旧实现 `app.setAppUserModelId(process.execPath)`——开发态 AUMID 是 electron.exe 的绝对路径，
 * 安装态随安装目录变化，注册表/开始菜单快捷方式无法稳定登记同一 ID，Windows 会把 toast 静默丢弃。
 * 改成固定 ID 后，安装器/快捷方式/注册表都能按同一 ID 登记；真机已证 Windows 真正收到通知
 * （wpndatabase 里出现「测试通知」payload），只是本机横幅呈现受限无法截图。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync('src/main/index.ts', 'utf8');

test('toast AUMID 是稳定常量，不随安装路径变化', () => {
  assert.match(main, /app\.setAppUserModelId\(AICO_APP_USER_MODEL_ID\)/);
  assert.doesNotMatch(main, /setAppUserModelId\(process\.execPath\)/);
  const m = /AICO_APP_USER_MODEL_ID\s*=\s*'([^']+)'/.exec(main);
  assert.ok(m, '缺少 AUMID 常量');
  assert.ok(m[1].length > 0 && m[1].length <= 128, 'AUMID 长度需在 1..128');
  assert.doesNotMatch(m[1], /[\\/]/, 'AUMID 不得含路径分隔符（否则注册表无法稳定登记）');
});
