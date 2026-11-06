/**
 * `ask_colleague` customTool（EMPLOYEES §2 五工具之一；OPT-AI-1 接入结构化 mailbox）。
 *
 * ⚠️ **只做信号**：真正的投递（`task_events` `question_asked` + `notifications`）由宿主
 * （`employee-executor.ts` 观察 tool_call 结果）调 `engine/mailbox.ts` 的 `requestAsk` 完成。
 * **非阻塞**（blocking 本里程碑不支持，PLAN §G-6 / DEV）。
 *
 * ESM/CJS 约束同 `report-progress-tool.ts`：异步工厂内动态 `import()`。
 */
export async function createAskColleagueTool() {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'ask_colleague',
    label: 'Ask Colleague',
    description:
      '向同事实体提问（走结构化 mailbox，不进人类频道）。to = 员工 id；question = 一句话问题。blocking=true 时本工作项会暂停（等答复后自动继续）；缺省 false＝投递后继续。**真互答（BRK12）**：被问员工在下次会话看到点名问，可用 `answer_colleague` 作答；阻塞式答复到达后本工作项自动继续。不能问自己；A↔B 已有未结互问时反向提问会被拒（防互问死循环）。',
    parameters: Type.Object({
      to: Type.Number({ description: '目标员工 id' }),
      question: Type.String({ description: '要问的问题（一句话）' }),
      blocking: Type.Optional(Type.Boolean({ description: 'true = 等答复（工作项暂停，答复后自动继续）；false/缺省 = 异步投递' })),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [
          {
            type: 'text',
            text:
              params.blocking === true
                ? `已投递给员工 #${params.to}（阻塞式：本工作项会暂停，答复到达后自动继续）；被问员工可在下次会话用 answer_colleague 作答。`
                : `已投递给员工 #${params.to}（结构化 mailbox，非阻塞）；被问员工可在下次会话用 answer_colleague 作答。`,
          },
        ],
        details: params,
      };
    },
  });
}
