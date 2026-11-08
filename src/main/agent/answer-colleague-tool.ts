/**
 * `answer_colleague` customTool（BRK12，D-8 真互答）。
 *
 * 只做信号：被问员工在【同事提问】里拿到 `askDedupeKey`，调用本工具作答；
 * 宿主（employee-executor）校验「这条 ask 确实是问我的」后调 `engine/mailbox.answerAsk`
 * （via='employee'），并在阻塞式 ask 上派 `answer_received` 唤醒提问者的工作项。
 *
 * 防互问死循环：`requestAsk` 拒绝自己问自己与 A↔B 双向未结互问；本工具只能答**别人问我**的 ask。
 */
/**
 * B2-5：结构化答复组装——结论＋依据＋产物引用＋追问（人话分节；无字段不注空节）。
 * 旧单句 answer 完全兼容（无结构化字段 → 原样返回）。宿主把组装结果投递给提问方。
 */
export interface StructuredAnswerInput {
  answer: string;
  conclusion?: string;
  evidence?: string[];
  artifacts?: string[];
  followup?: string;
}

export function formatStructuredAnswer(input: StructuredAnswerInput): string {
  const answer = input.answer.trim();
  const conclusion = (input.conclusion ?? '').trim();
  const evidence = (input.evidence ?? []).map((e) => String(e).trim()).filter((e) => e.length > 0);
  const artifacts = (input.artifacts ?? []).map((a) => String(a).trim()).filter((a) => a.length > 0);
  const followup = (input.followup ?? '').trim();
  if (conclusion.length === 0 && evidence.length === 0 && artifacts.length === 0 && followup.length === 0) {
    return answer;
  }
  const sections: string[] = [];
  if (conclusion.length > 0) sections.push(`【结论】${conclusion}`);
  if (evidence.length > 0) sections.push(`【依据】${evidence.map((e) => `- ${e}`).join('\n')}`);
  if (artifacts.length > 0) sections.push(`【产物引用】${artifacts.map((a) => `- ${a}`).join('\n')}`);
  if (answer.length > 0 && conclusion !== answer) sections.push(`【答复】${answer}`);
  if (followup.length > 0) sections.push(`【追问】${followup}`);
  return sections.join('\n');
}

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
      answer: Type.String({ description: '一句话答复（结论与 answer 二选一时优先把结论放 conclusion）' }),
      conclusion: Type.Optional(Type.String({ description: 'B2-5 结构化：结论（一段话）' })),
      evidence: Type.Optional(Type.Array(Type.String(), { description: 'B2-5 结构化：依据（命令输出/数据来源/计算过程，逐条）' })),
      artifacts: Type.Optional(Type.Array(Type.String(), { description: 'B2-5 结构化：产物引用（文件路径，相对项目根）' })),
      followup: Type.Optional(Type.String({ description: 'B2-5 结构化：追问（需要对方进一步给什么）' })),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: 'text', text: '已提交答复（宿主会校验提问归属并投递）。' }],
        details: params,
      };
    },
  });
}
