/**
 * MP1-F19 · 只读命令快速通道（保守解析器；**这是安全边界放宽，宁可漏放、不可错放**）。
 *
 * 理念对齐（W1 写边界）：边界管**写**不管读——`ls/find/grep` 这类只读探索不应逐次打扰老板；
 * 但读也可能外泄（`cat ~/.ssh/id_rsa`），所以读同样圈在**已授权根**（项目根/工作目录）内。
 *
 * 已知限制（如实声明）：路径关是**词法**包含，不解析符号链接——根内软链指向根外时 `cat 链接名` 可越根读
 * （与 TOCTOU 同类，静态无法判定）；风险随「项目根内存在指向外部的软链」出现，由项目目录自身的内容担保。
 *
 * 三关全过才放行（任何一关不过 → 调用方回落原有门禁，不让这条通道做任何「兜底放行」）：
 *  ① 结构关：无重定向（`>` `<`）、无命令替换（`$(`、反引号）、无后台 `&`、无换行；
 *  ② 命令关：按 `;` `&&` `||` `|` 切段后，每段首词必须是白名单内的**裸命令名**（含 `/`、`\`、盘符
 *     的一律出局——堵 `sh -c`、绝对路径可执行）；`find` 的破坏性参数（-delete、-exec、-ok、-fprint 系）出局；
 *  ③ 路径关：每个非选项参数解析后必须落在授权根内（`..` 穿越、`~`、根外绝对路径出局）。
 */
import { isAbsolute, resolve, sep } from 'node:path';

/** 白名单（唯一清单；新增即扩大攻击面，逐个评审）。`git` 不入——写子命令多。 */
export const READONLY_BASH_BINARIES: ReadonlySet<string> = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'fd', 'cd',
  'pwd', 'echo', 'stat', 'file', 'du', 'tree', 'which',
]);

/**
 * 破坏性/执行型/外读型参数（第二层防御；第一层是下面的正向旗标白名单）：
 * find 的 -delete/-exec 系；fd 的 -x/-X/--exec 系；rg 的 --pre 系（预处理器＝经 shell 执行任意命令）。
 */
const DESTRUCTIVE_FLAGS = /^-+(delete|exec|execdir|exec-batch|ok|okdir|fprint|fprintf|fls|x|X|pre|pre-command)(?:=|[^a-z-]|$)/i;

/**
 * MP1-F19 二次加固（D4 复核抓到「短选项附加值」族：`fd -xrm`、`rg -f/etc/passwd`、`tree -ofile`）：
 * 选项参数改**正向白名单**——逐命令枚举安全旗标，未知名形态一律回落原有门禁。
 *  - `short`：无值/文本值短旗标的**字母集合**（捆绑 `-lah` 逐字母检查；值为路径的旗标一概不入，
 *    如 grep/rg 的 `-f`、tree 的 `-o`——附加值形态因此被构造性堵死）；
 *  - `long`：无值长旗标精确匹配（`--opt=value` 含 `=` 已全局出局）；
 *  - `words`：find 原语（单划线多字符词；其值为下一 token 位置参数，照走路径关）。
 */
const SAFE_FLAGS: Record<string, { short: string; long: string[]; words: string[] }> = {
  ls: { short: 'la1htSrFpid', long: ['all', 'almost-all', 'human-readable', 'reverse', 'time', 'size', 'classify', 'inode', 'directory', 'literal', 'color'], words: [] },
  dir: { short: '', long: [], words: [] },
  cat: { short: 'n', long: ['number', 'show-nonprinting'], words: [] },
  type: { short: '', long: [], words: [] },
  head: { short: 'nqv', long: ['quiet', 'silent', 'verbose', 'lines', 'bytes'], words: [] },
  tail: { short: 'nqvf', long: ['quiet', 'silent', 'verbose', 'follow', 'lines', 'bytes', 'retry'], words: [] },
  wc: { short: 'clwmL', long: ['bytes', 'chars', 'lines', 'words', 'max-line-length'], words: [] },
  grep: { short: 'invcHhrwlsoqEFGP', long: ['ignore-case', 'invert-match', 'count', 'line-number', 'no-filename', 'with-filename', 'extended-regexp', 'fixed-strings', 'basic-regexp', 'recursive', 'word-regexp', 'only-matching', 'quiet', 'color'], words: [] },
  rg: { short: 'invcHhlwSoqS', long: ['ignore-case', 'invert-match', 'count', 'line-number', 'no-filename', 'with-filename', 'fixed-strings', 'word-regexp', 'only-matching', 'quiet', 'smart-case', 'case-sensitive', 'pretty', 'with-line-number'], words: [] },
  find: { short: '', long: [], words: ['name', 'iname', 'type', 'maxdepth', 'mindepth', 'size', 'mtime', 'newer', 'empty', 'print', 'not', 'and', 'or'] },
  fd: { short: 'HIiah', long: ['hidden', 'no-ignore', 'absolute-path'], words: [] },
  cd: { short: 'L', long: [], words: [] }, // cd -L（不解析符号链接）；路径参数照走路径关
  pwd: { short: 'LP', long: ['logical', 'physical'], words: [] },
  echo: { short: 'n', long: ['no-newline'], words: [] },
  stat: { short: '', long: [], words: [] }, // stat -c/-f 的格式值形态跨平台歧义——一律不带旗标（裸 stat 放行）
  file: { short: 'bi', long: ['brief', 'mime', 'mime-type'], words: [] },
  du: { short: 'shacb', long: ['summarize', 'human-readable', 'all', 'apparent-size', 'total'], words: [] },
  tree: { short: 'adfh', long: ['noreport', 'dirsfirst'], words: [] },
  which: { short: 'a', long: ['all'], words: [] },
};

/** 选项 token 是否在命令的安全旗标白名单内（`--`＝位置参数分隔符，全局安全）。 */
function isSafeOption(bin: string, token: string): boolean {
  if (token === '--') return true;
  const safe = SAFE_FLAGS[bin] ?? { short: '', long: [], words: [] };
  if (DESTRUCTIVE_FLAGS.test(token)) return false;
  if (token.startsWith('--')) return safe.long.includes(token.slice(2).toLowerCase());
  if (token.startsWith('-') && token.length > 1) {
    const body = token.slice(1);
    // find 原语：`-name` 等单词形态
    if (safe.words.includes(body.toLowerCase())) return true;
    // 短旗标（含捆绑）：每个字符都必须**精确（大小写敏感）**在该命令的字母集合内——
    // CLI 旗标大小写异义（grep -r 不跟随/-R 跟随；rg -l 文件名/-L 跟随软链），折叠会误放跟随类
    for (const ch of body) {
      if (!safe.short.includes(ch)) return false;
    }
    return true;
  }
  return false;
}

/** 引号感知的保守分词（引号不配对 → null，调用方一律不放行）。 */
function tokenize(segment: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of segment) {
    if (quote != null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote != null) return null;
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function containedInRoot(p: string, root: string): boolean {
  const rp = resolve(p);
  const rr = resolve(root);
  const norm = (s: string) => s.toLowerCase().replace(/\\/g, '/');
  const a = norm(rp);
  const b = norm(rr);
  return a === b || a.startsWith(`${b}/`);
}

/** 三关判定：全过 → true（可走只读快速通道）。任何解析疑点 → false（回落原有门禁）。 */
export function isReadOnlyBashCommand(
  command: string,
  roots: { projectRoot?: string | null; cwd?: string | null },
): boolean {
  const text = command.trim();
  if (text.length === 0) return false;
  // ① 结构关
  if (/[>`<]|\$\(|\r|\n/.test(text)) return false;
  // && 链允许（每段都要过白名单——`cd 项目根 && ls -la` 是模型最常用形态，D5 复核实机
  // 2026-10-26 抓到一刀切拒 && 把良性只读链全打回 strict 问一次）。残余单 &（后台）与
  // 引号内藏的结构符由下方 token 级检查兜底。
  const authorized = [roots.projectRoot, roots.cwd].filter((r): r is string => typeof r === 'string' && r.length > 0);
  if (authorized.length === 0) return false;
  // ② 命令关＋③ 路径关（逐段）
  const segments = text.split(/;|\|\||&&|\|/);
  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (segment.length === 0) continue;
    const tokens = tokenize(segment);
    if (tokens == null || tokens.length === 0) return false;
    const [bin, ...args] = tokens;
    // 裸命令名：白名单内的简单词（含 / \ : 盘符/路径的一律出局）
    if (!/^[A-Za-z0-9_.-]+$/.test(bin)) return false;
    if (!READONLY_BASH_BINARIES.has(bin.toLowerCase())) return false;
    const binLower = bin.toLowerCase();
    for (const arg of args) {
      // 结构符兜底：切分后仍残留的 & ;（后台运算符/引号内藏的管道分号）——一律出局
      if (/[&;]/.test(arg)) return false;
      if (DESTRUCTIVE_FLAGS.test(arg)) return false;
      // shell 变量（$VAR/$HOME）与 ~ 展开（含 ~user）不赌——字面 containment 过了也会被 shell 展开出根
      if (arg.includes('$')) return false;
      if (arg.startsWith('~')) return false;
      if (arg.startsWith('-')) {
        // 选项走正向白名单（未知名形态/含 = 或路径字符一律出局——回落原有门禁）
        if (arg.includes('=')) return false;
        if (/[\\/]/.test(arg)) return false;
        if (!isSafeOption(binLower, arg)) return false;
        continue;
      }
      // 路径参数：解析后必须落在任一授权根内（.. 穿越、根外绝对路径出局）
      const abs = isAbsolute(arg) ? arg : resolve(roots.cwd ?? roots.projectRoot ?? '.', arg);
      if (!authorized.some((root) => containedInRoot(abs, root))) return false;
    }
  }
  return true;
}
