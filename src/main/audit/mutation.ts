/**
 * `mutation.ts` —— 突变读数（`pnpm test:mutations`）的**纯逻辑**（无 IO，可内存测）。
 *
 * 缘起（C4 计划 P5）：机械化"有牙"——把**已知的高价值判据**逐点注入外科突变（文本级替换），
 * 跑**聚焦测试子集**；测试仍绿 ⇒ 突变存活＝该点无牙（红）。读数（杀伤率）入挂牌表。
 *
 * 口径（v1，偏差已写回计划件 §2/§4）：
 *  - **未引 Stryker**：其 command runner 与我们的 dist 测试链不匹配（每突变需重编译/全链复跑），
 *    且新增依赖须走依赖白名单＋`HANDOVER §3.4` 同步上报——v1 用"外科突变清单"（每点＝一条真实判据
 *    ＋其聚焦测试）；v2 若引 Stryker，先做依赖上报；
 *  - **注入点＝dist 编译产物**（`src/main/**` 映射 `dist/src/main/**.js`；与源码逐字近似）——跑器先校验
 *    `find` 在目标文件**恰出现 1 次**（0 次/多次＝setup-error，如实报，不静默）；注入 → 跑聚焦测试 →
 *    `finally` 还原；**突变不落库、不提交**；
 *  - 判据：聚焦测试非 0 退出＝**killed**（有牙）；0 退出＝**survived**（无牙，红）。
 */
export interface MutationPoint {
  id: string;
  /** 源码路径（仓库相对，人读用）；跑器映射到 dist。 */
  file: string;
  find: string;
  replace: string;
  /** 聚焦测试（dist 相对路径；跑器用 node --test 直跑）。 */
  tests: readonly string[];
  ref: string;
  note: string;
}

export const MUTATION_POINTS: readonly MutationPoint[] = [
  {
    id: 'brk2-illegal-event',
    file: 'src/main/agent/unavailable-executor.ts',
    // 注：`event: 'error',` 在兜底执行器有两处（planning / work_item）；带 work_item 作用域才唯一。
    // 多行缩进按 dist 口径（tsc 输出 16 空格）；再漂移时 setup-error 会响，先修本目录。
    find: "scope: 'work_item',\n                id: workItemId,\n                event: 'error',",
    replace: "scope: 'work_item',\n                id: workItemId,\n                event: 'work_item_failed',",
    tests: ['dist/test/unavailable-executor.test.js'],
    ref: 'BRK2 回归点',
    note: '兜底执行器改回非法事件名 ⇒ 真引擎必抛、失败面断——该点必须"有牙"（聚焦测试红）',
  },
  {
    id: 'aggregation-guard',
    file: 'src/main/engine/loop.ts',
    find: "(outcome.to === 'done' || outcome.to === 'submitted') && task && task.state === 'executing'",
    replace: "(outcome.to === 'done' || outcome.to === 'submitted') && task && task.state === 'planning'",
    tests: ['dist/test/planning-session.test.js'],
    ref: '聚合守卫（FLOWS §3.1.2 联动）',
    note: '件完成不再聚合 ⇒ 任务永停 executing——"牙"应来自 L0/L1 全链用例',
  },
  {
    id: 'audit-ui-passthrough',
    file: 'src/main/audit/chain-audit.ts',
    find: 'producers: hits.length + (viaUiTable ? 1 : 0),',
    replace: 'producers: hits.length,',
    tests: ['dist/test/chain-audit.test.js'],
    ref: 'audit:chain 探测器自身（UI 表透传）',
    note: 'UI 表 implemented 透传不再计入生产 ⇒ BRK17 类误报孤儿；链审计单测应抓',
  },
  {
    id: 'invariants-i1',
    file: 'src/main/audit/invariants.ts',
    find: "cur.pendingActions === 0 && cur.wiStates.length > 0 && cur.taskState === 'executing'",
    replace: "cur.pendingActions === 0 && cur.wiStates.length > 0 && cur.taskState === 'paused'",
    tests: ['dist/test/invariants.test.js'],
    ref: 'test:invariants I1 条件',
    note: '卡死判据改错状态 ⇒ BRK4 签名不再被报；不变量单测应抓',
  },
  {
    id: 'timeout-fail-closed',
    file: 'src/main/engine/statemachine.ts',
    // 注：dist 里 tsc 把单行 `if (...) return 'blocked';` 折成两行——find 用单行条件串（唯一）。
    find: 'if (!TIMEOUT_AUTO_ACTIONS.includes(defaultAction))',
    replace: 'if (false)',
    tests: ['dist/test/b6-timeout-default-action.test.js'],
    ref: 'B6 超时 fail-closed 白名单',
    note: '白名单外悄悄放行（fail-open，方向错）——超时/权限用例应有牙',
  },
];

export interface MutationApplyResult {
  ok: boolean;
  mutated: string;
  count: number;
}

/** 注入（`find` 必须恰出现 1 次；否则 ok=false, count 如实）。 */
export function applyMutation(text: string, point: MutationPoint): MutationApplyResult {
  const count = text.split(point.find).length - 1;
  return { ok: count === 1, mutated: count === 1 ? text.replace(point.find, point.replace) : text, count };
}

export interface MutationOutcome {
  point: MutationPoint;
  verdict: 'killed' | 'survived' | 'setup-error';
  detail: string;
}

export interface MutationScore {
  killed: number;
  survived: number;
  setupErrors: number;
  /** 杀伤率＝killed/(killed+survived)；无可判点＝null（不臆造 0）。 */
  score: number | null;
}

export function mutationScore(outcomes: readonly MutationOutcome[]): MutationScore {
  const killed = outcomes.filter((o) => o.verdict === 'killed').length;
  const survived = outcomes.filter((o) => o.verdict === 'survived').length;
  const setupErrors = outcomes.filter((o) => o.verdict === 'setup-error').length;
  const gradeable = killed + survived;
  return { killed, survived, setupErrors, score: gradeable > 0 ? killed / gradeable : null };
}
