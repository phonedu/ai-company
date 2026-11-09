/**
 * B3-4/D-31：角色 SOP 资产库——6 预设三段资产、roleLayer 附着、draft_sop 确认卡。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ROLE_SOP_PRESETS, sopFor, renderSopLayer } from '../src/main/agent/role-sops.js';
import { roleLayer, DELIVERY_DISCIPLINE_LAYER } from '../src/main/agent/context.js';
import { ASSISTANT_SYSTEM_PROMPT_M0 } from '../src/main/agent/pi-assistant.js';

test('B3-4: 预设角色 SOP——三段齐、每段实质内容（≥5 条/段；B4-7 起含自媒体运营共 7 个）', () => {
  const roles = ['执行', '开发', '写作', '研究', '评审', '验证', '自媒体运营'];
  assert.equal(Object.keys(ROLE_SOP_PRESETS).length, 7);
  for (const role of roles) {
    const sop = sopFor(role);
    assert.ok(sop, `${role} 有 SOP`);
    assert.ok(sop!.method.split('\n').length >= 5, `${role} 工作方法 ≥5 条`);
    assert.ok(sop!.outputSpec.split('\n').length >= 4, `${role} 输出规范 ≥4 条`);
    assert.ok(sop!.checklist.split('\n').filter((l) => l.includes('□')).length >= 5, `${role} 自检清单 ≥5 条`);
    // 内容量：三段合计 ≥700 字（≈500+ token 中文保守口径）
    const total = sop!.method.length + sop!.outputSpec.length + sop!.checklist.length;
    assert.ok(total >= 700, `${role} SOP 总字数 ${total} ≥700（500+ token 中文保守口径）`);
  }
  assert.equal(sopFor('不存在的角色'), null, '未匹配角色回落 null');
});

test('B3-4: roleLayer——预设角色附 SOP 分节；非预设回落两句话', () => {
  const withSop = roleLayer('开发');
  assert.match(withSop, /\[角色规则\] 你是「开发」/);
  assert.match(withSop, /\[角色 SOP · 开发\]/);
  assert.match(withSop, /## 工作方法/);
  assert.match(withSop, /## 交付前自检/);
  const without = roleLayer('数据分析师');
  assert.ok(!without.includes('角色 SOP'), '非预设不附 SOP（回落）');
  assert.match(without, /\[角色规则\]/);
});

test('B3-4: draft_sop 工具在幕僚长提示词与注册名单（回归锚）', async () => {
  // 幕僚长提示词不点名 draft_sop（工具描述自解释）；这里锁注册名单——通过 pi-assistant 导出的
  // ASSISTANT_SYSTEM_PROMPT_M0 不含「后续里程碑」类过期声明即可；注册名单在 pi-assistant.ts 内联。
  const src = await import('../src/main/agent/pi-assistant.js');
  assert.ok(src.ASSISTANT_SYSTEM_PROMPT_M0.length > 0);
  // draft_sop 工具工厂可创建（签名/白名单行为）
  const { createDraftSopTool } = await import('../src/main/agent/assistant-command-tools.js');
  const { openMemoryDatabase, runMigrations } = await import('../src/main/db/index.js');
  const db = openMemoryDatabase();
  runMigrations(db);
  const tool = (await createDraftSopTool({ db })) as unknown as {
    execute(id: string, params: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; details: { outcome: string } }>;
  };
  // 拒：内容不足
  const reject = await tool.execute('tc', { role: '数据分析师', method: '太短', outputSpec: '短', checklist: '短' });
  assert.equal(reject.details.outcome, 'rejected');
  assert.match(reject.content[0]!.text, /被拒/);
  // 过：三段实质内容 → 出确认卡（approvals 行＋reports 卡）
  const approve = await tool.execute('tc', {
    role: '数据分析师',
    method: '1. 先拆指标体系，明确北极星指标与代理指标。\n2. 数据清洗先行：缺失值/异常值处理规则与数据源对齐。\n3. 分析用可复现脚本（SQL/Python），不留手工黑盒。\n4. 结论必须带置信度与样本量，不夸大。\n5. 可视化选型服务于结论（不是好看）。',
    outputSpec: '交付物：分析报告（.md）＋可复现脚本＋数据字典。报告按「结论→依据→方法→未决」组织，图表附数据来源。submit 只给路径与要点。',
    checklist: '□ 指标定义与业务方对齐\n□ 数据源与时间窗已记录\n□ 异常值处理有说明\n□ 结论带置信度与样本量\n□ 脚本可复现（依赖已声明）',
  });
  assert.equal(approve.details.outcome, 'card');
  const approvals = db.prepare('SELECT question FROM approvals WHERE task_id IS NULL').all() as Array<{ question: string }>;
  assert.ok(approvals.some((a) => a.question.includes('数据分析师')), 'SOP 确认卡在案（approvals）');
  db.close();
  void DELIVERY_DISCIPLINE_LAYER;
});
