// 项目要求 Node >= 22.19（Pi SDK 的 engines 约束）。
// 在 Node 20 下运行会得到清晰的切换提示，而不是难以理解的报错。
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 19)) {
  console.error(`
[ai-company] 当前 Node 为 ${process.version}，本项目需要 >= 22.19。切换方式（本机默认无 bash）：
  PowerShell  : . .\\scripts\\env.ps1            （或: .\\scripts\\with-node22.ps1 <命令>）
  cmd         : call scripts\\env.cmd            （或: scripts\\with-node22.cmd <命令>）
  Git Bash    : source scripts/env.sh            （或: scripts/with-node22.sh <命令>）
`);
  process.exit(1);
}
