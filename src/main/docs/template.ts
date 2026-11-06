/**
 * M3-DOC-1 · 项目文档骨架模板（产品能力）。
 *
 * 口径：
 *  - 文档根＝`<项目根>/.aico/docs`（不藏软件私有目录；项目根由老板选）；
 *  - 模板只在新项目初始化时生成；`applyDocsTemplate` 对**已存在文件逐个跳过**，绝不覆盖；
 *  - 模板自身必须能通过 `src/main/docs/check.ts` 的默认策略（入口/头注/索引/引用/体量）；
 *  - 不替用户决定体系：模板可改、可关（新建项目表单的复选框）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DocsTemplateFile {
  /** 相对文档根的路径（`/` 分隔）。 */
  path: string;
  content: string;
}

export interface DocsTemplateResult {
  /** 相对项目根的文档根（固定 `.aico/docs`）。 */
  docRoot: string;
  created: string[];
  skipped: string[];
}

/** 模板文件（纯函数；项目名只进标题，不做路径/命令插值）。 */
export function docsTemplateFiles(projectName: string): DocsTemplateFile[] {
  const title = projectName.trim() || '项目';
  return [
    {
      path: 'README.md',
      content: `# ${title} · 文档入口

> 本文件是项目文档树的入口（由 ai-company 初始化，可改）。文档根＝\`.aico/docs\`。

## 先读

- [00-项目宪章](00-项目宪章.md) —— 这个项目为什么存在、什么算完成、谁说了算。
- [05-状态与计划](05-状态与计划.md) —— 唯一状态源：现在做到哪、下一步做什么。
- [naming](naming.md) —— 文件命名与头注三行约定。

## 一次改动该动哪些文档

| 改动 | 至少更新 |
|---|---|
| 目标/范围/停止条件变化 | 00-项目宪章 |
| 任务状态/计划/验收结果变化 | 05-状态与计划 |
| 新增或重命名文档 | 本 README 的索引 |

## 检查

项目概览 →「文档健康」→「检查文档」。检查只读，不会改文件；悬空引用、缺头注、区索引缺口、超线会如实列出。
`,
    },
    {
      path: '00-项目宪章.md',
      content: `# ${title} · 项目宪章

> **头注**｜状态：草案（由 ai-company 初始化）｜规范的家：本文件｜关闭时处置：项目结束时归档

## 1. 这个项目为什么存在

（一句话目标：要解决谁的什么问题。）

## 2. 什么算完成（停止条件）

- 可验收的结果：
- 明确不做：
- 什么时候停下来问老板：

## 3. 谁说了算

- 老板决定：要不要做、做到什么算好、花多少钱、最终验收。
- 幕僚长决定：怎么拆、谁来干、何时汇报。
- 员工决定：技术细节；对外动作/花大钱仍过老板。

## 4. 事实与证据

读数必须能指到来源；没有数据写 \`—\`，不写假 \`0\`。
`,
    },
    {
      path: '05-状态与计划.md',
      content: `# ${title} · 状态与计划

> **头注**｜状态：在办（初始化模板）｜规范的家：本文件｜关闭时处置：项目结束时归档

## 1. 当前状态

- 未开工（新建项目初始态）。
- 最近一次验收：—

## 2. 计划

1. 明确目标与停止条件（回填 00-项目宪章）。
2. 拆出第一件可验收的任务。
3. 每完成一件，在这里更新状态与证据路径。

## 3. 不能误判的状态

- 没跑过的门禁不写「通过」；写「未验证」。
- 空态不伪装；无数据用 \`—\`。
`,
    },
    {
      path: 'naming.md',
      content: `# 文档命名与头注约定

> **头注**｜状态：在办（模板）｜规范的家：本文件｜关闭时处置：随项目归档

## 1. 命名

- 入口固定为 \`README.md\`。
- 编号文档用两位前缀（如 \`00-\`、\`05-\`），按阅读顺序排。
- 同一目录 ≥2 份文档时，必须有 \`README.md\` 逐个点名。

## 2. 头注三行

每份非 README 文档开头写：

\`\`\`text
> **头注**｜状态：<在办/待审/已收口>｜规范的家：<本文件/指针>｜关闭时处置：<归档/并入哪里>
\`\`\`

## 3. 引用

- 相对链接必须指向真实文件/目录；归档区（\`history/\`）不进活文档检查。
`,
    },
  ];
}

/**
 * 把模板写进 `<rootDir>/.aico/docs`。
 * - 已存在文件：跳过并回报（**不覆盖**）；
 * - 写入用 `wx`（文件已存在即失败）兜住并发竞态；
 * - 只创建模板目录与被跳过的文件之外的新文件。
 */
export function applyDocsTemplate(rootDir: string, projectName: string): DocsTemplateResult {
  const docsRootAbs = join(rootDir, '.aico', 'docs');
  mkdirSync(docsRootAbs, { recursive: true });
  const created: string[] = [];
  const skipped: string[] = [];
  for (const file of docsTemplateFiles(projectName)) {
    const abs = join(docsRootAbs, ...file.path.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    if (existsSync(abs)) {
      skipped.push(file.path);
      continue;
    }
    try {
      writeFileSync(abs, file.content, { encoding: 'utf8', flag: 'wx' });
      created.push(file.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        skipped.push(file.path);
        continue;
      }
      throw error;
    }
  }
  return { docRoot: '.aico/docs', created, skipped };
}
