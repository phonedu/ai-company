// B1-1 生成质量基线（内部 59 §2）：四类任务各 2 条，直连模型生成 → 同一模型按 rubric 打分。
//
// 运行：`pnpm eval:gen`（Electron 主进程；从应用 userData 解 OSCrypt 读取真实 DeepSeek Key，
// 只用 env/内存传递，不打印、不落盘）。成本受 maxTokens 约束（约 $0.01/轮）。
// 产物：`out/eval/generation-<stamp>.json`（明细；gitignored）＋控制台分类汇总。
const { app, safeStorage } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');

const REPO = join(__dirname, '..', '..');
const BASE = 'https://api.deepseek.com';
const MODEL = 'deepseek-flash';
const PRICE = { input: 0.3 / 1e6, output: 1.2 / 1e6 }; // USD / token（pi 目录价）
const OUT_DIR = join(REPO, 'out', 'eval');

// 复用应用 profile 的 OSCrypt 密钥：**必须在 app ready 之前**把 userData 指到副本
// （ready 之后 OSCrypt 已按默认 profile 初始化）。应用在跑时直接共用同一 profile 会被锁。
const APP_PROFILE = join(process.env.APPDATA || '', 'ai-company');
const TMP_PROFILE = mkdtempSync(join(tmpdir(), 'aico-genbench-'));
copyFileSync(join(APP_PROFILE, 'Local State'), join(TMP_PROFILE, 'Local State'));
app.setPath('userData', TMP_PROFILE);

const SYSTEM = {
  conversation: '你是一名专业的中文商务顾问。回答直接、具体、语气专业，不空泛。',
  brainstorm: '你是资深产品/增长顾问。先发散再收敛，点子要具体可执行，并说明取舍。',
  planning: '你是项目经理。输出可执行的里程碑与依赖，标注风险与应对，不写套话。',
  devfix: '你是资深工程师。先指出根因，再给可直接运行的修复代码/ SQL，并给能暴露问题的用例。',
};

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function call(messages, maxTokens, target = { base: BASE, model: MODEL, key: process.env.DEEPSEEK_API_KEY }) {
  const res = await fetch(`${target.base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${target.key}` },
    body: JSON.stringify({
      model: target.model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.3,
      // DeepSeek V3.2：显式关思考（否则推理会吃掉 max_tokens，content 为空）。
      thinking: { type: 'disabled' },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  const choice = json.choices?.[0] ?? {};
  const content = String(choice.message?.content ?? '');
  if (content.trim().length === 0) {
    throw new Error(`空输出（finish_reason=${choice.finish_reason ?? '?'}）`);
  }
  return { content, usage: json.usage ?? { prompt_tokens: 0, completion_tokens: 0 } };
}

function parseJudge(raw, n) {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    const scores = Array.isArray(obj.scores) ? obj.scores.map((x) => (x === 1 || x === true ? 1 : 0)) : null;
    if (!scores || scores.length !== n) return null;
    const reasons = Array.isArray(obj.reasons) ? obj.reasons.map(String) : [];
    // 证据闸：给 1 但没引用原文 → 降为 0（严格评审协议）。
    const strict = scores.map((sc, i) => (sc === 1 && !/[「"]/.test(reasons[i] ?? '') ? 0 : sc));
    return { scores: strict, reasons };
  } catch {
    return null;
  }
}

async function main() {
  const pk = await import(pathToFileURL(join(REPO, 'dist/src/main/agent/provider-keys.js')).href);
  pk.setProviderKeyCodec({
    stable: true,
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (payload) => safeStorage.decryptString(Buffer.from(payload, 'base64')),
  });
  const cred = pk.resolveProviderKey('deepseek');
  const xCred = pk.resolveProviderKey('xiaomi');
  if (!cred) throw new Error('DeepSeek Key 未配置（先在设置里填写）');
  const provider = (process.env.GEN_PROVIDER ?? 'deepseek').trim().toLowerCase();
  const genTarget =
    provider === 'xiaomi' && xCred
      ? { base: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-flash', key: xCred.key, label: 'mimo-v2.6-flash' }
      : { base: BASE, model: MODEL, key: cred.key, label: MODEL };
  if (provider === 'xiaomi' && !xCred) throw new Error('GEN_PROVIDER=xiaomi 但 Xiaomi Key 未配置');
  // 跨模型评审（生成方 ≠ 评审方）以降低自我偏袒；缺另一家则回落同模型并如实标注。
  const judge =
    genTarget.label === MODEL && xCred
      ? { base: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-flash', key: xCred.key, label: 'mimo-v2.6-flash' }
      : genTarget.label !== MODEL
        ? { base: BASE, model: MODEL, key: cred.key, label: MODEL }
        : { base: BASE, model: MODEL, key: cred.key, label: `${MODEL}（同模型）` };
  console.log(`[gen] provider=${genTarget.label} judge=${judge.label}`);
  const set = JSON.parse(readFileSync(join(REPO, 'scripts/eval/generation-cases.json'), 'utf8'));
  const rows = [];
  let inTok = 0;
  let outTok = 0;
  const limit = Number(process.env.GEN_LIMIT ?? '0');
  const REPEAT = Math.max(1, Math.min(Number(process.env.GEN_REPEAT ?? '1') || 1, 5));
  const baseCases = limit > 0 ? set.cases.slice(0, limit) : set.cases;
  // 多次重复：同一臂内每例跑 REPEAT 次（降低单次波动；成本×REPEAT）。
  const cases = Array.from({ length: REPEAT }, () => baseCases).flat();
  for (const c of cases) {
    const started = Date.now();
    try {
    const gen = await call(
      [
        { role: 'system', content: SYSTEM[c.category] ?? '' },
        { role: 'user', content: c.prompt },
      ],
      Math.max(c.maxTokens, 4000),
      genTarget,
    );
    inTok += gen.usage.prompt_tokens ?? 0;
    outTok += gen.usage.completion_tokens ?? 0;
    const judgePrompt =
      `你是严格的质量评审。对「待评输出」逐条判断是否满足评分标准：满足=1，不满足=0（宁可低分，不吝啬扣分）。\n` +
      `评分必须引用输出原文作为证据（用「」括起原句）；引不出原文的条目一律记 0。\n` +
      `只输出 JSON：{"scores":[0/1,...],"reasons":["每条一句话并带「原文引用」"]}\n` +
      `评分标准：\n${c.rubric.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\n待评输出：\n${gen.content}`;
    // 评审用 cross-judge（生成方≠评审方）；失败回落同模型。给足 token（推理+JSON）。
    let verdict;
    try {
      verdict = await call([{ role: 'user', content: judgePrompt }], 2000, judge);
    } catch (error) {
      if (judge.label === MODEL) throw error;
      console.log(`[gen] ${c.id} judge 回落（${String(error && error.message ? error.message : error).slice(0, 80)}）`);
      verdict = await call([{ role: 'user', content: judgePrompt }], 2000, { base: BASE, model: MODEL, key: cred.key, label: MODEL });
    }
    inTok += verdict.usage.prompt_tokens ?? 0;
    outTok += verdict.usage.completion_tokens ?? 0;
    const judged = parseJudge(verdict.content, c.rubric.length);
    const score = judged ? judged.scores.reduce((a, b) => a + b, 0) : null;
    rows.push({
      id: c.id,
      category: c.category,
      ms: Date.now() - started,
      chars: gen.content.length,
      score,
      max: c.rubric.length,
      reasons: judged?.reasons ?? [],
      output: gen.content,
    });
    console.log(
      `[gen] ${c.id} (${c.category}) score=${score ?? '解析失败'}/${c.rubric.length} chars=${gen.content.length} ${Date.now() - started}ms`,
    );
    } catch (error) {
      // 单条失败不拖垮整轮（限流/网络/空输出都如实记录）。
      rows.push({ id: c.id, category: c.category, ms: Date.now() - started, chars: 0, score: null, max: c.rubric.length, reasons: [], error: String(error && error.message ? error.message : error) });
      console.log(`[gen] ${c.id} (${c.category}) ERROR ${String(error && error.message ? error.message : error).slice(0, 120)}`);
    }
  }
  // 每例均值（跨重复次数）：分数与满分。
  const perCase = Object.values(
    rows.reduce((acc, r) => {
      const b = (acc[r.id] ??= { id: r.id, category: r.category, runs: 0, got: 0, max: 0 });
      b.runs += 1;
      if (r.score != null) {
        b.got += r.score;
        b.max += r.max;
      }
      return acc;
    }, {}),
  ).map((b) => ({ ...b, mean: b.max > 0 ? Number((b.got / b.max).toFixed(3)) : null }));
  const byCat = {};
  for (const r of rows) {
    const b = (byCat[r.category] ??= { n: 0, got: 0, max: 0 });
    b.n += 1;
    if (r.score != null) {
      b.got += r.score;
      b.max += r.max;
    }
  }
  const usd = inTok * PRICE.input + outTok * PRICE.output;
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, `generation-${genTarget.label.replace(/[^a-z0-9.-]/gi, '_')}-${stamp()}.json`);
  writeFileSync(
    out,
    JSON.stringify(
      { model: genTarget.label, judge: judge.label, repeat: REPEAT, at: new Date().toISOString(), tokens: { in: inTok, out: outTok }, usd, byCat, perCase, rows },
      null,
      2,
    ) + '\n',
  );
  console.log('\n[gen] 分类汇总（rubric 得分）：');
  for (const [cat, b] of Object.entries(byCat)) {
    const pct = b.max > 0 ? ((b.got / b.max) * 100).toFixed(1) : '—';
    console.log(`  ${cat}: ${b.got}/${b.max}（${pct}%）`);
  }
  console.log('[gen] 每例均值：' + perCase.map((b) => `${b.id}=${b.mean == null ? '—' : (b.mean * 100).toFixed(0) + '%'}`).join(' '));
  console.log(`[gen] tokens in=${inTok} out=${outTok} ≈ $${usd.toFixed(4)}（repeat=${REPEAT}）`);
  console.log(`[gen] 明细=${out}`);
  try {
    rmSync(TMP_PROFILE, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
  } catch {
    /* 进程仍持有 profile 文件：留给系统临时目录清理，不影响结果 */
  }
  app.exit(0);
}

app.whenReady().then(main).catch((error) => {
  console.error('[gen] 失败：' + (error && error.message ? error.message : String(error)));
  app.exit(1);
});
