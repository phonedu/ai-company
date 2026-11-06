/**
 * P3（M3-R-7）· 命令级语义预检：在名字/参数粗判之前，把 shell 包裹拆开再按语义规则拦。
 *
 * 为什么需要：`tool_call` 闸门原先只看工具名 + `JSON.stringify(args)` 做正则；
 * `bash -c 'rm -rf /'`、`python -c "...rmtree('/')"`、`cmd /c del ...` 等包裹命令可绕过
 * 只对裸命令写的黑名单。本模块只做**保守的默认拒绝/询问**，不执行任何命令：
 *  - deny：根/家目录递归删除、磁盘破坏、关机/重启、注册表 HKLM、已知凭据库；
 *  - ask：一般递归删除、远程脚本管道、内联代码里的危险调用、`.env` 读取；
 *  - 规则可分发：`COMMAND_PRECHECK_RULES` 是唯一清单（新增规则只改这里）。
 *
 * 边界：这是**启发式**，不是沙箱；真正隔离仍靠权限层/后续 `OPT-AI-15`。命中 deny 的
 * 命令不会执行；命中 ask 的走既有审批/grant。
 */
import type { GateResult, ToolCall } from './gate.js';

export type PrecheckRule = {
  id: string;
  decision: 'deny' | 'ask';
  reason: string;
  re: RegExp;
};

/** 规则清单（唯一可分发真源；顺序＝先 deny 后 ask）。 */
export const COMMAND_PRECHECK_RULES: readonly PrecheckRule[] = [
  {
    id: 'command_precheck:destructive_root',
    decision: 'deny',
    reason: '递归删除根/家目录/盘符根',
    re: /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\s+(?:\/|~|\$HOME|[a-z]:[\\/])(?:\s|$)/i,
  },
  {
    id: 'command_precheck:disk',
    decision: 'deny',
    reason: '磁盘/分区破坏命令',
    re: /\b(?:mkfs(?:\.\w+)?|fdisk|diskpart|format(?:\.com)?)\b/i,
  },
  {
    id: 'command_precheck:dd',
    decision: 'deny',
    reason: 'dd 写块设备',
    re: /\bdd\b[^\n]*\bof\s*=\s*\/dev\//i,
  },
  {
    id: 'command_precheck:power',
    decision: 'deny',
    reason: '关机/重启/停机命令',
    re: /\b(?:shutdown|reboot|halt)\b/i,
  },
  {
    id: 'command_precheck:registry',
    decision: 'deny',
    reason: '删除系统注册表/引导配置',
    re: /\b(?:reg\s+delete\s+HKLM|bcdedit)\b/i,
  },
  {
    id: 'command_precheck:credentials',
    decision: 'deny',
    reason: '访问已知凭据库（SSH/AWS/公司 secrets/系统影子文件）',
    re: /(?:\.ssh[\\/](?:id_rsa|id_ed25519|authorized_keys|config)|\.aws[\\/](?:credentials|config)|\.aico[\\/]secrets|(?:^|[\\/])\.npmrc\b|(?:^|[\\/])id_rsa\b|\/etc\/shadow\b|cookies\b|login\s+data)/i,
  },
  {
    id: 'command_precheck:env_file',
    decision: 'ask',
    reason: '读取 .env（可能含密钥）',
    re: /(?:^|[\s"'/\\])\.env(?:\.[\w-]+)?\b/i,
  },
  {
    id: 'command_precheck:recursive_delete',
    decision: 'ask',
    reason: '递归删除（非根目录仍需确认）',
    re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|\bdel\s+\/[a-z]*[sq]/i,
  },
  {
    id: 'command_precheck:remote_code',
    decision: 'ask',
    reason: '远程内容直接管道执行',
    re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|zsh|python|node)\b|\bbase64\s+(?:-d|--decode)\b[^\n|]*\|\s*(?:sh|bash|zsh)\b/i,
  },
  {
    id: 'command_precheck:inline_rmtree',
    decision: 'deny',
    reason: '内联脚本调用 rmtree/rmSync 删除根/家目录',
    re: /\b(?:shutil\.rmtree|rmSync|rmdirSync|os\.rmdir|fs\.rm)\s*\(\s*['"](?:\/|~|[a-z]:[\\/])/i,
  },
  {
    id: 'command_precheck:inline_system',
    decision: 'deny',
    reason: '内联脚本调用 os.system/subprocess 执行破坏命令',
    re: /\b(?:os\.system|subprocess\.(?:run|call|Popen))\s*\(\s*['"][^'"]*(?:rm\s+-rf|mkfs|format|shutdown)/i,
  },
];

/** 取命令文本（兼容 `command` / `cmd` / `script` / `args[]`；没有则 null）。 */
export function commandTextOf(call: ToolCall): string | null {
  const args = call.args ?? {};
  for (const key of ['command', 'cmd', 'script', 'code']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  const argv = args['args'];
  if (Array.isArray(argv) && argv.every((x) => typeof x === 'string')) return argv.join(' ');
  return null;
}

/** 去掉两端成对引号（保留内部内容）。 */
function unquote(text: string): string {
  let s = text.trim().replace(/\\"/g, '"').replace(/\\'/g, "'");
  for (let i = 0; i < 3; i += 1) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1).trim();
    } else break;
  }
  return s;
}

/**
 * 递归拆 shell/解释器包裹（有限 3 层，防构造嵌套绕过）。
 * 例：`bash -lc "python -c 'import shutil; shutil.rmtree(\"/\")'"` → 内联 python 代码。
 */
export function unwrapCommand(raw: string): string {
  let s = unquote(raw);
  for (let depth = 0; depth < 3; depth += 1) {
    const shell = /^(?:bash|sh|zsh|dash|fish|powershell|pwsh|cmd(?:\.exe)?)\s+(?:[-/][a-z]*c(?:ommand)?)\s+([\s\S]+)$/i.exec(s);
    const python = /^(?:python(?:3(?:\.\d+)?)?|py)\s+-c\s+([\s\S]+)$/i.exec(s);
    const node = /^node(?:\.exe)?\s+(?:-e|--eval)\s+([\s\S]+)$/i.exec(s);
    const next = shell?.[1] ?? python?.[1] ?? node?.[1];
    if (!next) break;
    s = unquote(next);
  }
  return s;
}

/** 命令语义预检；无命中返回 null（交回既有权限判定）。 */
export function precheckCommand(call: ToolCall): GateResult | null {
  const raw = commandTextOf(call);
  if (!raw) return null;
  const text = unwrapCommand(raw);
  if (text.length === 0) return null;
  for (const rule of COMMAND_PRECHECK_RULES) {
    if (rule.re.test(text)) {
      return { decision: rule.decision, reason: rule.reason, rule: rule.id };
    }
  }
  return null;
}
