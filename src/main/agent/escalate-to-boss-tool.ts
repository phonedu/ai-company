/**
 * `escalate_to_boss` customTool（R2-2/G9）——员工把**需要老板拍板**的事升级到人。
 *
 * ⚠️ **只做信号**：真正的落库（`reports.kind='ask'` 的 AskCard ＋ `task_events`）与任务状态
 * （`escalate` → `needs_decision`）由宿主（`employee-executor.ts` 观察 tool_call 结果）完成——
 * 复用「通知/待我处理」同一套人话通道，**不开第二条**。
 *
 * 与 `ask_colleague` 的分工：问同事走 mailbox（不进人类频道）；**升级**是给人看的（进「待我处理」）。
 * ESM/CJS 约束同 `report-progress-tool.ts`：异步工厂内动态 `import()`。
 */
export async function createEscalateToBossTool() {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'escalate_to_boss',
    label: 'Escalate To Boss',
    description:
      '把需要老板拍板/授权的事升级到人（进「待我处理」，任务转 needs_decision）。question = 一句话说清要什么决定；发起后等老板回复，不要自己猜着做。' +
      '**只承诺你工具能力内做得到的动作**（读写项目根内文件、跑白名单命令等）；改项目根/改设置/装环境/动项目外的路径都不在你的能力里——' +
      '这类问题请明确说「请在设置/文件管理器中处理」，不要写「我来改/我换到那里执行」之类你做不到的选项。',
    parameters: Type.Object({
      question: Type.String({ description: '要老板决定什么（一句话；带上选项更好）' }),
      // RW-21 泛化（M5 真机 S9）：结构化选项直通决策卡按钮（此前只有 question 文本——老板没有可点的裁定通路）。
      options: Type.Optional(
        Type.Array(
          Type.Object({
            key: Type.String({ description: '选项键（英文短词；cancel 保留＝取消任务）' }),
            label: Type.String({ description: '选项人话（一句话，如「改用普通文件工具重跑」）' }),
          }),
          { description: '给老板的可点选项（2–4 个；每个都必须是你能力内做得到的动作）' },
        ),
      ),
      // 多选（老板 2026-10-28 指令）：选项可同时勾选多项（如挑多个文件清理）时声明 multi；缺省 single。
      selection: Type.Optional(
        Type.Union([Type.Literal('single'), Type.Literal('multi')], {
          description: '选项模式：single＝单选（缺省）／multi＝多选（老板可勾多项后一次提交）',
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: 'text', text: '已升级给老板（进「待我处理」；任务转 needs_decision，等回复）。' }],
        details: params,
      };
    },
  });
}
