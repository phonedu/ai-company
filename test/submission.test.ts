import test from 'node:test';
import assert from 'node:assert/strict';

import { validateSubmission } from '../src/main/agent/submission.js';

// ── OPT-AI-7（M2-C）· 结构化提交的校验：单一真源（工具侧抛回模型 / 宿主侧兜底共用） ──

test('OPT-AI-7 校验：合法提交 → 归一化（trim；可选数组缺省＝空数组）；契约外字段进 extra（审计可见）', () => {
  const ok = validateSubmission({
    summary: '  修好了对账脚本  ',
    artifacts: ['scripts/reconcile.py'],
    unknownField: 42,
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.summary, '修好了对账脚本', 'summary 去空白');
    assert.deepEqual(ok.value.artifacts, ['scripts/reconcile.py']);
    assert.deepEqual(ok.value.evidence, [], '缺省＝空数组（不臆造）');
    assert.deepEqual(ok.value.assumptions, []);
    assert.deepEqual(ok.value.unclosed, []);
    assert.deepEqual(ok.value.extra, { unknownField: 42 }, '契约外字段保留在 extra（审计），不外泄为规范字段');
  }
});

test('OPT-AI-7 校验「有牙」：每类非法都按名报对（summary 缺失/空/超长 · 数组类型 · 元素非串 · 条数超限）', () => {
  const cases: Array<{ name: string; input: unknown; expect: string }> = [
    { name: 'summary 缺失', input: {}, expect: 'summary 必填' },
    { name: 'summary 空白', input: { summary: '   ' }, expect: 'summary 必填' },
    { name: 'summary 超长', input: { summary: 'x'.repeat(501) }, expect: 'summary 超过 500 字' },
    { name: 'artifacts 非数组', input: { summary: 's', artifacts: 123 }, expect: 'artifacts 必须是字符串数组' },
    { name: 'elements 非字符串', input: { summary: 's', evidence: [1] }, expect: 'evidence[0] 必须是非空字符串' },
    { name: '元素空白', input: { summary: 's', unclosed: [' '] }, expect: 'unclosed[0] 必须是非空字符串' },
    { name: '条数超限', input: { summary: 's', assumptions: Array.from({ length: 51 }, (_, i) => `a${i}`) }, expect: 'assumptions 最多 50 条' },
    { name: '整体非对象', input: 'just a string', expect: '提交必须是一个对象' },
    { name: '数组当对象', input: [1], expect: '提交必须是一个对象' },
  ];
  for (const c of cases) {
    const res = validateSubmission(c.input);
    assert.equal(res.ok, false, `${c.name} 应非法`);
    if (!res.ok) {
      assert.ok(
        res.errors.some((e) => e.includes(c.expect)),
        `${c.name}：错误信息应含「${c.expect}」，实际 ${JSON.stringify(res.errors)}`,
      );
    }
  }
});

test('MiMo 实测：单条字符串 / {text} 对象 → 归一为字符串数组（不丢数据）', () => {
  const single = validateSubmission({ summary: 's', evidence: 'echo 15*3 = 45' });
  assert.equal(single.ok, true);
  if (single.ok) assert.deepEqual(single.value.evidence, ['echo 15*3 = 45']);
  const objects = validateSubmission({ summary: 's', evidence: [{ text: 'pytest: 3 passed' }] });
  assert.equal(objects.ok, true);
  if (objects.ok) assert.deepEqual(objects.value.evidence, ['pytest: 3 passed']);
  const bad = validateSubmission({ summary: 's', evidence: [{ note: 'no text' }] });
  assert.equal(bad.ok, false);
});

test('OPT-AI-7 工具侧：真 SDK 工厂 —— 非法提交**抛错**（模型可据此重交）；合法提交返回归一化 details', async () => {
  const { createSubmitWorkItemTool } = await import('../src/main/agent/submit-work-item-tool.js');
  const tool = await createSubmitWorkItemTool();
  const exec = (
    tool as unknown as { execute: (id: string, params: unknown) => Promise<{ content: Array<{ text?: string }>; details?: unknown }> }
  ).execute;

  await assert.rejects(() => exec('c1', {}), /submit_work_item 校验失败：summary 必填/, '非法 → 抛错且说明原因');
  await assert.rejects(() => exec('c2', { summary: 's', evidence: [123] }), /evidence\[0\]/, '元素非串 → 抛错点名');

  const out = await exec('c3', { summary: '  结论  ', artifacts: ['a.py'] });
  assert.ok(
    (out.content[0]?.text ?? '').includes('已提交工作项：结论'),
    '合法 → 回执用归一化 summary（trim）',
  );
  assert.deepEqual((out.details as { artifacts: string[] }).artifacts, ['a.py']);
});

// ── BRK24（2026-10-16·狗粮批）：产物项形状——只放路径/URL/文件名，含空白逐条拒 ──

test('BRK24：产物项含空白/控制字符 → 逐条拒且**人话点名**（狗粮「commit 86b8890」场景）；合法项不受牵连', () => {
  const res = validateSubmission({
    summary: 's',
    artifacts: ['commit 86b8890', 'docs/report.md'],
  });
  assert.equal(res.ok, false, '含空白项必须拒（此前只校验"非空字符串"⇒ 提交号被当文件列出）');
  if (!res.ok) {
    assert.ok(
      res.errors.some((e) => e.includes('artifacts[0]') && e.includes('commit 86b8890') && e.includes('只放路径/URL')),
      `错误须点名该项并给人话指引；实际：${res.errors.join('｜')}`,
    );
  }
});

test('BRK24：路径/URL/文件名形状放行（含 URL 与子路径）；evidence 等散文数组不受影响', () => {
  const ok = validateSubmission({
    summary: 's',
    artifacts: ['scripts/reconcile.py', 'out/result.json', 'https://example.com/a.md'],
    evidence: ['node --test 全绿（见输出）', '手工跑通 2 个样例'],
  });
  assert.equal(ok.ok, true, '路径/URL 合法项 + evidence 散文均放行');
  if (ok.ok) {
    assert.deepEqual(ok.value.artifacts, ['scripts/reconcile.py', 'out/result.json', 'https://example.com/a.md']);
    assert.deepEqual(ok.value.evidence, ['node --test 全绿（见输出）', '手工跑通 2 个样例'], 'evidence 保持散文语义');
  }
});

test('BRK24：控制字符（换行/制表）同拒', () => {
  const res = validateSubmission({ summary: 's', artifacts: ['a\tb'] });
  assert.equal(res.ok, false);
});
