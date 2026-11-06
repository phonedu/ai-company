/**
 * B1 · 首发内置技能包（M3-N-3）。
 *
 * 三个内置技能随软件发：幕僚长的「公司管理」、通用「事实核查清单」、通用「变更审查要点」。
 * 口径：
 *  - 内容**内联**（打包安全：不依赖 asar 外资源）；启动时写 `<userData>/skills/builtin/<name>/SKILL.md`；
 *  - `skills.source='builtin'`，**不可删**（可停用）；重装/升级时保留老板的 enabled 选择；
 *  - 新库（幕僚长 skills 为空）自动勾给幕僚长；已有配置不动（不臆造/不覆盖）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getSkillByName, upsertSkill, type SkillRow } from '../db/skills.js';
import type { SqliteDb } from '../db/open.js';

export interface BuiltinSkillDef {
  name: string;
  description: string;
  content: string;
}

export const BUILTIN_SKILLS: readonly BuiltinSkillDef[] = [
  {
    name: 'company-management',
    description: '管理公司员工、技能与 MCP：何时招募/改档/停用、任务派发边界、审批与权限口径。',
    content: `---
name: company-management
description: 管理公司员工、技能与 MCP：何时招募/改档/停用、任务派发边界、审批与权限口径。
---

# 公司管理

- 先看现状再做决定：员工名单、角色、在跑任务、技能/MCP 分配；不要凭印象编人。
- 招募：先判断是"缺一个持续角色"还是"这一单需要多一个人"。后者用工作项拆解/改派，不轻易加人。
- 改档：能力档（sandbox/standard/trusted）只升到任务真正需要的级别；对外/花钱动作永远逐次批准。
- 技能：按"手艺"分配，不按"人缘"分配；一个技能只给需要它的员工/项目，避免全员上下文膨胀。
- MCP：先确认 server 可用与工具性质；含对外动作的调用必须走审批，不把凭据写进项目文件。
- 停用员工前先处理在跑/排队工作项；停用不是删除，历史保留。
- 任何"代签/代答/代批"都不得扩大对方权限；拿不准就升级给老板。`,
  },
  {
    name: 'fact-check',
    description: '事实核查清单：结论要附可复现证据，区分事实/推断/未知，不编来源与数字。',
    content: `---
name: fact-check
description: 事实核查清单：结论要附可复现证据，区分事实/推断/未知，不编来源与数字。
---

# 事实核查清单

1. **把断言拆小**：每个数字、日期、人名、因果关系单独核对。
2. **证据优先级**：本机可复现命令/测试 > 项目内文件 > 官方文档/原始数据 > 二手摘要。二手资料只作线索。
3. **每条结论标类型**：事实（有证据）/ 推断（说明依据与置信度）/ 未知（说清缺什么才能确认）。
4. **不编来源**：没有链接/文件/命令输出就不写"据某某"；引用要能指到具体位置。
5. **时间敏感项**：写明截至日期；版本号与命令一起给。
6. **反例检查**：至少找一个能推翻结论的证据；找不到也要说明查过什么。
7. **交付格式**：结论 → 证据 → 未决问题。没有证据的"已完成"不算完成。`,
  },
  {
    name: 'change-review',
    description: '变更审查要点：先看范围与无关改动，再看正确性/测试/回滚，最后给可执行的通过或打回意见。',
    content: `---
name: change-review
description: 变更审查要点：先看范围与无关改动，再看正确性/测试/回滚，最后给可执行的通过或打回意见。
---

# 变更审查要点

- **范围**：变更是否只碰该工作项声明的路径？有没有顺手改无关文件、格式化噪音、生成物入库？
- **正确性**：对照验收标准逐条检查；边界/空态/错误路径是否有处理；有没有把空态伪装成 0。
- **证据**：测试/构建/真机命令是否真跑过，读数是否与结论一致；未跑就写未验证。
- **兼容与迁移**：schema/接口/配置变更是否可回退；旧数据是否会被破坏。
- **安全**：凭据/密钥是否进仓库或日志；外部动作是否走审批；路径是否越界。
- **可回滚**：出问题能否只回滚本次改动（不覆盖后续同文件工作）？
- **结论**：通过 → 列出证据；打回 → 指出具体文件/行为与期望，不用"感觉不对"代替理由。`,
  },
];

export const BUILTIN_SKILL_NAMES: readonly string[] = BUILTIN_SKILLS.map((s) => s.name);

/**
 * 写内置技能文件并登记（幂等）。保留既有 enabled；新行默认启用。
 * 返回本次确保在场的行（含已存在行）。
 */
export function ensureBuiltinSkills(
  db: SqliteDb,
  installRoot: string,
  now: number = Date.now(),
): SkillRow[] {
  const rows: SkillRow[] = [];
  for (const def of BUILTIN_SKILLS) {
    const existing = getSkillByName(db, def.name);
    // 不覆盖老板已有的非内置同名技能（旧库/手工注册）：跳过并响亮留痕，内置可改名后再装。
    if (existing && existing.source !== 'builtin') {
      console.error(`[skills] 内置技能 ${def.name} 与已有 ${existing.source} 技能重名——保留现有、跳过内置`);
      rows.push(existing);
      continue;
    }
    const dir = join(installRoot, 'builtin', def.name);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'SKILL.md');
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (current !== def.content) writeFileSync(target, def.content, 'utf8');
    rows.push(
      upsertSkill(db, {
        name: def.name,
        description: def.description,
        source: 'builtin',
        path: target,
        version: '1',
        enabled: existing ? existing.enabled === 1 : true,
        now,
      }),
    );
  }
  return rows;
}

/**
 * 新库默认把内置技能勾给幕僚长（仅在 `employees.skills` 为空数组时；已有配置不动）。
 * 返回是否写入。
 */
export function assignBuiltinSkillsToAssistantIfEmpty(db: SqliteDb): boolean {
  const row = db.prepare('SELECT skills FROM employees WHERE id = 0 AND is_assistant = 1').get() as
    | { skills?: string | null }
    | undefined;
  if (!row) return false;
  let refs: unknown = [];
  try {
    refs = JSON.parse(row.skills ?? '[]');
  } catch {
    refs = [];
  }
  if (Array.isArray(refs) && refs.length > 0) return false;
  db.prepare('UPDATE employees SET skills = ? WHERE id = 0 AND is_assistant = 1').run(
    JSON.stringify([...BUILTIN_SKILL_NAMES]),
  );
  return true;
}
