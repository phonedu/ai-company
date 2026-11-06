/**
 * `answer_colleague` customTool（BRK12，D-8 真互答）。
 *
 * 只做信号：被问员工在【同事提问】里拿到 `askDedupeKey`，调用本工具作答；
 * 宿主（employee-executor）校验「这条 ask 确实是问我的」后调 `engine/mailbox.answerAsk`
 * （via='employee'），并在阻塞式 ask 上派 `answer_received` 唤醒提问者的工作项。
 *
 * 防互问死循环：`requestAsk` 拒绝自己问自己与 A↔B 双向未结互问；本工具只能答**别人问我**的 ask。
 */
export async function createAnswerColleagueTool() {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'answer_colleague',
    label: 'Answer Colleague',
    description:
      '回答一条**点名问你**的同事提问（askDedupeKey 来自【同事提问】）。只能回答 to=你 的未结提问；答复后阻塞中的对方工作项会自动继续。',
    parameters: Type.Object({
      askDedupeKey: Type.String({ description: '同事提问的幂等键（【同事提问】里逐条给出）' }),
      answer: Type.String({ description: '一句话答复' }),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: 'text', text: '已提交答复（宿主会校验提问归属并投递）。' }],
        details: params,
      };
    },
  });
}
