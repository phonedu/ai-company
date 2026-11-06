/**
 * E-16 幕僚长卡片测试：三张卡的 payload 结构＋去重＋选项控件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import {
  sendRecruitCard,
  sendProfileChangeCard,
  sendSkillProposalCard,
  isMultiSelectOptions,
} from '../src/main/agent/assistant-cards.js';

const AT = 1_800_000_000_000;

function setup() {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO projects(id,name,root_dir,created_at) VALUES(1,'P','D:/r',?)").run(AT);
  db.prepare("INSERT INTO employees(id,name,role,is_assistant,active,created_at) VALUES(0,'幕僚长','assistant',1,1,?)").run(AT);
  db.prepare("INSERT INTO employees(id,name,role,is_assistant,active,created_at) VALUES(7,'执行','dev',0,1,?)").run(AT);
  db.prepare(`INSERT INTO tasks(id,short_id,project_id,title,goal,acceptance,state,priority,risk_level,owner_id,origin,archived,created_at,updated_at) VALUES(1,'T-1001',1,'测试','g','[]','executing',0,0,7,'boss',0,?,?)`).run(AT, AT);
  return db;
}

test('E-16 招募卡：默认非阻塞通知卡（kind=notification），payload 含员工档案', () => {
  const db = setup();
  try {
    sendRecruitCard(db, {
      employeeId: 99,
      employeeName: '小林',
      role: '数据分析师',
      persona: '擅长数据清洗与可视化，注重准确性。',
      model: '跟随默认',
      skills: ['数据清洗', '图表规范'],
      tier: 'standard',
      taskId: 1,
      taskShortId: 'T-1001',
      blocking: false,
    });
    const reports = db.prepare("SELECT * FROM reports WHERE kind='notification'").all() as Array<{ payload: string }>;
    assert.equal(reports.length, 1, '应产生 1 张通知卡');
    const payload = JSON.parse(reports[0]!.payload) as { title: string; card: string; employeeName: string; options?: unknown };
    assert.match(payload.title, /已招募「小林」/);
    assert.equal(payload.card, 'recruit');
    assert.equal(payload.employeeName, '小林');
    assert.equal(payload.options, undefined, '非阻塞模式无选项按钮');
  } finally { db.close(); }
});

test('E-16 招募卡（阻塞模式）：kind=ask，含三选项（确认/调整/撤销）', () => {
  const db = setup();
  try {
    sendRecruitCard(db, {
      employeeId: 99, employeeName: '小林', role: '数据分析师',
      persona: 'x', model: '跟随默认', skills: [], tier: 'standard',
      taskId: 1, taskShortId: 'T-1001', blocking: true,
    });
    const reports = db.prepare("SELECT * FROM reports WHERE kind='ask'").all() as Array<{ payload: string }>;
    assert.equal(reports.length, 1, '应产生 1 张决策卡');
    const payload = JSON.parse(reports[0]!.payload) as { options: Array<{ key: string }> };
    assert.ok(payload.options.some(o => o.key === 'confirm'), '应有「确认入职」');
    assert.ok(payload.options.some(o => o.key === 'adjust'), '应有「调整档案」');
  } finally { db.close(); }
});

test('E-16 档案变更卡：notification 卡含变更明细', () => {
  const db = setup();
  try {
    sendProfileChangeCard(db, {
      employeeId: 7,
      employeeName: '执行',
      changes: [
        { field: '模型', oldValue: '跟随默认', newValue: 'deepseek-flash' },
        { field: '技能', oldValue: '', newValue: '数据清洗' },
      ],
      changedBy: 'boss',
      taskId: 1,
    });
    const reports = db.prepare("SELECT * FROM reports WHERE kind='notification'").all() as Array<{ payload: string }>;
    assert.equal(reports.length, 1);
    const payload = JSON.parse(reports[0]!.payload) as { title: string; body: string; card: string; changes: unknown[] };
    assert.match(payload.title, /员工档案已更新「执行」/);
    assert.equal(payload.card, 'profile-change');
    assert.equal(payload.changes.length, 2);
    assert.match(payload.body, /deepseek-flash/);
  } finally { db.close(); }
});

test('E-16 技能提议卡：ask 卡含描述＋内容摘要＋两选项', () => {
  const db = setup();
  try {
    sendSkillProposalCard(db, {
      name: '反爬策略',
      description: '处理常见反爬机制的步骤和注意事项',
      content: '# 反爬策略\n\n## 步骤\n1. 检查 robots.txt\n2. 设置合理的请求间隔\n3. 处理验证码',
      sourceTaskId: 1,
      sourceTaskShortId: 'T-1001',
    });
    const reports = db.prepare("SELECT * FROM reports WHERE kind='ask'").all() as Array<{ payload: string }>;
    assert.equal(reports.length, 1);
    const payload = JSON.parse(reports[0]!.payload) as { title: string; card: string; options: Array<{ key: string }> };
    assert.match(payload.title, /提议新技能「反爬策略」/);
    assert.equal(payload.card, 'skill-proposal');
    assert.ok(payload.options.some(o => o.key === 'approve'), '应有「批准入库」');
    assert.ok(payload.options.some(o => o.key === 'deny'), '应有「不需要」');
  } finally { db.close(); }
});

test('E-16 去重：同员工同任务的招募卡只发一张', () => {
  const db = setup();
  try {
    const data = {
      employeeId: 99, employeeName: '小林', role: '数据分析师',
      persona: 'x', model: '跟随默认', skills: [], tier: 'standard',
      taskId: 1, taskShortId: 'T-1001', blocking: false,
    };
    sendRecruitCard(db, data);
    sendRecruitCard(db, data); // 重复调用
    const reports = db.prepare("SELECT COUNT(*) n FROM reports WHERE kind='notification'").get() as { n: number };
    assert.equal(reports.n, 1, '去重后只有 1 张');
  } finally { db.close(); }
});

test('E-16 多选控件判别：isMultiSelectOptions 正确区分单选/多选', () => {
  assert.ok(isMultiSelectOptions({ options: { multi: true, options: [{ key: 'a', label: 'A' }] } }));
  assert.ok(!isMultiSelectOptions({ options: [{ key: 'approve', label: '批准' }] }));
  assert.ok(!isMultiSelectOptions({}));
});
