/**
 * D-5 员工视图（纯展示）——2026-10-17 工位批改版：**两视图拆分**后按模式断言。
 *   ops（看活）＝当前在跑/最近任务/累计成本/指路注；config（改人）＝五 tab（人设与提示词/技能/MCP/记忆/定时）
 *   ＋偏好可改（M2 尾写入口）＋五层预览。
 * 口径不变：空态不伪装 / 未实现如实 disabled＋理由 / 无 id 不白屏（含"有牙"）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { EmployeePane, type EmployeePaneProps, type EmployeeTab } from '../src/renderer/components/EmployeePane.js';
import type { EmployeeDetailDTO } from '../src/renderer/types.js';

const AT = 1_800_000_000_000;

const FULL: EmployeeDetailDTO = {
  employee: {
    id: 5,
    name: '小雅',
    role: '内容运营',
    avatar: null,
    persona: '你是内容运营，写东西先给结论。',
    model: null,
    thinking: 'medium',
    skills: [
      { id: '1', name: 'writer' },
      { id: '9', name: null },
    ],
    mcps: [{ id: '7', name: null }],
    capabilityTier: 'trusted',
    isAssistant: false,
    active: true,
    createdAt: AT,
  },
  memory: [
    { projectId: 11, projectName: '记账系统', memory: '[任务 T-1001] 写周报', updatedAt: AT + 100 },
    { projectId: 0, projectName: null, memory: '[通用] 偏好：先结论', updatedAt: AT + 50 },
  ],
  currentWork: [{ workItemId: 3, taskId: 42, taskShortId: 'T-1001', taskTitle: '写周报', state: 'running' }],
  recentTasks: [{ id: 42, shortId: 'T-1001', title: '写周报', state: 'executing', updatedAt: AT + 200 }],
  cost: { usd: 0.25, tokensIn: 100, tokensOut: 50, rows: 1 },
};

function render(detail: EmployeeDetailDTO | null, over: Partial<EmployeePaneProps> = {}): string {
  return renderToStaticMarkup(
    createElement(EmployeePane, { detail, loading: false, error: null, onBack: () => {}, ...over }),
  );
}

function renderConfig(detail: EmployeeDetailDTO | null, tab?: EmployeeTab): string {
  return render(detail, {
    mode: 'config',
    onUpdateEmployee: async () => ({ ok: true }),
    ...(tab ? { initialTab: tab } : {}),
  });
}

test('ops（看活）：当前在跑/最近任务/成本/指路注 在场；嵌入大厅右栏（无页头/返回）；不含改人分区', () => {
  const html = render(FULL);
  assert.match(html, /data-testid="employee-view"[^>]*data-mode="ops"/);
  // 2026-10-17（双栏改版）：ops 只以嵌入态出现在大厅右栏——页头/返回由大厅页承担。
  assert.equal(html.includes('employee-back'), false, 'ops 不再有页头返回');
  assert.match(html, /data-testid="employee-name"[^>]*>小雅/);
  assert.match(html, /能力档：受信/);
  assert.match(html, /data-testid="employee-current-item"/);
  assert.match(html, /data-testid="employee-current-open"[^>]*>打开任务 ▸/);
  assert.equal(
    html.includes('<button type="button" data-testid="employee-current-task"'),
    false,
    '短号不得再是第二个“打开任务”按钮（只留一个入口）',
  );
  assert.match(html, /data-testid="employee-current-state"[^>]*data-tone="accent"/, '执行中状态用色标而非灰色小字');
  assert.match(html, /执行中/, '工作项状态中文（running → 执行中）');
  assert.match(html, /data-testid="employee-recent-task"/);
  assert.match(html, /\$0\.2500/, '成本如实（4 位小数）');
  assert.match(html, /data-testid="employee-ops-note"[^>]*>[\s\S]*?设置 · 员工/, '看活的指路＝改人去设置');
  // 有牙：看活不出现改人面（偏好下拉/五层预览/技能 tab）。
  assert.equal(html.includes('employee-model-select'), false);
  assert.equal(html.includes('employee-tab-persona'), false);
});

test('config（改人）：五 tab；偏好可改（M2 尾写入口）＋人设可编辑＋保存可点＋五层预览', () => {
  const html = renderConfig(FULL);
  assert.match(html, /data-testid="employee-view"[^>]*data-mode="config"/);
  assert.match(html, /员工设置/);
  assert.match(html, /data-testid="employee-back"[^>]*aria-label="返回设置 · 员工"[^>]*>←</);
  assert.ok(html.indexOf('employee-back') < html.indexOf('员工设置'), '箭头在标题之前');
  for (const key of ['persona', 'skills', 'mcps', 'memory', 'schedule']) {
    assert.ok(html.includes(`data-testid="employee-tab-${key}"`), `缺 tab ${key}`);
  }
  assert.match(html, /data-testid="employee-persona"/, '缺省 tab＝人设与提示词');
  assert.match(html, /你是内容运营，写东西先给结论。/);
  // M2 尾：偏好写入口已接——模型输入可编辑（真字段现值），思考强度下拉可改。
  assert.doesNotMatch(html, /data-testid="employee-model-select"[^>]*disabled/);
  assert.match(html, /data-testid="employee-model-select"[^>]*placeholder="例如 deepseek\/deepseek-flash；空＝跟随"/);
  assert.doesNotMatch(html, /data-testid="employee-thinking-select"[^>]*disabled/);
  assert.match(html, /当前生效：模型 跟随全局默认 · 思考强度 medium/);
  // UG-11：能力档可写；停用/启用按钮在场（幕僚长禁用；有在跑件由主进程 F8 拒）。
  assert.match(html, /data-testid="employee-capability-select"/);
  assert.match(html, /data-testid="employee-active-toggle"/);
  assert.match(html, /停用员工/);
  assert.doesNotMatch(html, /data-testid="employee-active-toggle"[^>]*disabled/, '非幕僚长可停用');
  // 保存人设/偏好：接线在场 ⇒ 可点（不再 NI disabled）。
  assert.doesNotMatch(html, /data-testid="employee-persona-save"[^>]*disabled/);
  assert.match(html, /保存人设与偏好/);
  // 五层预览（①②纪律层只读口径）。
  assert.match(html, /data-testid="emp-layer-1"[^>]*>① 公司纪律（只读 · 不可改）/);
  assert.match(html, /data-testid="emp-layer-2"[^>]*>② 平台纪律（只读 · 不可改）/);
  assert.match(html, /data-testid="emp-layer-4"[^>]*>④ 任务上下文（按任务自动拼装 · 只读）/);
  // CTX1-7：不冒充「完整拼装文本」——标题与说明都必须是「层与来源」口径。
  assert.match(html, /提示词分层（只读 · 层与来源）/);
  assert.match(html, /这里只列层与来源，不是完整拼装文本/);
  assert.doesNotMatch(html, /看最终提示词|最终提示词预览/, '不得再用会让人误以为整段拼装可见的旧标题');
  // 有牙：改人不出现看活的在跑/最近/成本。
  assert.equal(html.includes('employee-current-item'), false);
  assert.equal(html.includes('employee-cost-line'), false);
});

test('config 分 tab：技能/MCP 未登记如实；记忆分区；定时＝NI 空态', () => {
  const skills = renderConfig(FULL, 'skills');
  assert.match(skills, /writer/, '登记过的技能显示名字');
  assert.match(skills, /#9（未登记）/, '未登记如实标注');
  const mcps = renderConfig(FULL, 'mcps');
  assert.match(mcps, /#7（未登记）/);
  const memory = renderConfig(FULL, 'memory');
  assert.match(memory, /记账系统/, '记忆按项目分区显示项目名');
  assert.match(memory, /通用记忆/, 'project_id=0 → 「通用记忆」');
  const schedule = renderConfig(FULL, 'schedule');
  assert.match(schedule, /data-testid="employee-schedule-empty"[^>]*>[\s\S]*?未实现（NI）/);
});

test('空态不伪装（两模式各管各的）：ops 在跑/最近/成本如实；config 人设/技能/记忆空态如实＋未实现注', () => {
  const empty: EmployeeDetailDTO = {
    ...FULL,
    employee: { ...FULL.employee, persona: '', skills: [], mcps: [], model: 'anthropic/claude', thinking: null },
    memory: [],
    currentWork: [],
    recentTasks: [],
    cost: { usd: null, tokensIn: 0, tokensOut: 0, rows: 0 },
  };
  const ops = render(empty);
  assert.match(ops, /data-testid="employee-current-empty"/);
  assert.match(ops, /data-testid="employee-recent-empty"/);
  assert.match(ops, /成本 —（暂无成本记录）/, '无成本行 → —（不写假 0）');

  const cfg = renderConfig(empty);
  assert.match(cfg, /data-testid="employee-persona-input"[^>]*placeholder="填写员工人设（空＝平台默认）"/, '人设为可编辑 textarea（空态给占位）');
  assert.match(cfg, /anthropic\/claude/, 'model 有值 → 输入框回显现值');
  assert.match(cfg, /当前生效：模型 anthropic\/claude · 思考强度 —/, '未设 thinking → —（不编默认值）');
  assert.match(cfg, /未实现/, '停用/记忆编辑等仍未实现（如实标注）');
  assert.match(renderConfig(empty, 'skills'), /data-testid="employee-skills-empty"/);
  assert.match(renderConfig(empty, 'memory'), /data-testid="employee-memory-empty"/);
  // 有牙：满数据里不得出现空态的"未配置"文案（证明两组文案真的来自数据分支）。
  assert.doesNotMatch(renderConfig(FULL, 'skills'), /data-testid="employee-skills-empty"/);
  assert.doesNotMatch(render(FULL), /成本 —/);
});

test('detail=null 不白屏（config 给返回口；ops 嵌入态给如实说明）；error 如实呈现', () => {
  const missing = render(null, { mode: 'config' });
  assert.match(missing, /data-testid="employee-missing"/);
  assert.match(missing, /员工不存在/);
  assert.match(missing, /data-testid="employee-back"/, 'config 永远给得出返回口（不困住用户）');
  // 2026-10-17（双栏改版）：ops 嵌入大厅右栏——返回口＝左列名单本身（不另设页头钮）。
  const missingOps = render(null, { mode: 'ops' });
  assert.match(missingOps, /data-testid="employee-missing"/);
  assert.match(missingOps, /员工不存在/);
  const errored = render(null, { error: 'IPC 断线' });
  assert.match(errored, /data-testid="employee-error"[^>]*>IPC 断线/);
});
