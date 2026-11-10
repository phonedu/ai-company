/**
 * 安全扫描消解的可执行守卫（2026-11-10）。
 *
 * 背景：外部静态扫描对 44 条 advisory 只给到「不确定」（调用图被动态派发打断），无法产出
 * 「通过/不通过」；逐条人工消解后，把其中两条「设计如此」的边界落成**可执行守卫**，防将来改坏：
 *   A. 验收命令 `check` 不能被「人话验收」通道带进来（UI/幕僚长/IM 都只写 `{text}` 或 string）；
 *   B. 验收命令在任务详情里对使用者可见（`$ <check>`），不是静默执行。
 * 另有 git push 分支注入的守卫在 `b3-7-push-export.test.ts`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAcceptanceChecks } from '../src/main/agent/acceptance-checks.js';

test('验收命令注入：人话验收写不进 shell check（string / {text} 都被解析器丢掉）', () => {
  // 旧格式（纯字符串）与 UI 现在的写法（{text}）都不产生机器检查。
  assert.deepEqual(parseAcceptanceChecks(['验收一句话']), []);
  assert.deepEqual(parseAcceptanceChecks([{ text: '验收一句话' }]), []);
  assert.deepEqual(parseAcceptanceChecks([{ text: '空 check', check: '   ' }]), []);
  // 只有显式 check 才执行（宿主门）——保留能力本身。
  const withCheck = parseAcceptanceChecks([{ text: '跑测试', check: 'pnpm test' }]);
  assert.equal(withCheck.length, 1);
  assert.equal(withCheck[0]?.check, 'pnpm test');
  // 坏 JSON / 非数组不抛、也不产生检查。
  assert.deepEqual(parseAcceptanceChecks('not json'), []);
  assert.deepEqual(parseAcceptanceChecks(null), []);
});

test('验收命令注入：三个写入面都不会把 check 带进来（UI / 幕僚长 / IM）', () => {
  const store = readFileSync('src/renderer/store.ts', 'utf8');
  assert.match(store, /acceptance: opts\.acceptance\.map\(\(text\) => \(\{ text \}\)\)/, 'UI 只映射为 {text}');
  const assistant = readFileSync('src/main/agent/assistant-command-tools.ts', 'utf8');
  assert.match(
    assistant,
    /params\.acceptance\.filter\(\(a\): a is string => typeof a === 'string'/,
    '幕僚长工具只收 string[]（对象/带 check 的项被过滤）',
  );
  const ipc = readFileSync('src/main/ipc/ipc.ts', 'utf8');
  // IM/频道直通建任务只传 goal（不带 acceptance 字段）。
  const directive = ipc.slice(ipc.indexOf('parseCreateTaskDirective'), ipc.indexOf('parseCreateTaskDirective') + 2000);
  assert.ok(!/acceptance/.test(directive), 'IM 直通建任务不带 acceptance');
});

test('验收命令可见性：任务详情显示 $ <check>', () => {
  const detail = readFileSync('src/renderer/components/TaskDetail.tsx', 'utf8');
  assert.match(detail, /\$ \{item\.check\}/, '任务详情渲染 $ <check>');
});
