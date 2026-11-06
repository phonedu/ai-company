# 贡献指南

## 环境

- Node.js **22+**（见 `.node-version`）
- pnpm **9**
- Windows（当前主要发布平台；代码尽量保持跨平台）

```bash
pnpm install
pnpm test        # 隐私/公开面门禁 + tsc + 单元测试
pnpm build       # 生产构建（out/）
```

## 提交前

1. 跑 `pnpm test` 与 `pnpm build`，全绿；
2. 不提交任何真实密钥、个人路径、真实用户数据；测试用合成数据；
3. `pnpm check:privacy` 与 `pnpm check:public-face` 必须通过（CI 也会跑）；
4. 一个提交一个意图；提交信息说明「为什么」，不要只写「fix」。

## PR

- 先开 Issue 描述问题/动机（小改动可直接 PR）；
- PR 描述里写明 CLA 同意（见 `CLA.md`）；
- 不改与 PR 无关的文件；不引入新的闭源依赖；
- 新增依赖需说明用途与许可证（必须与 GPL-3.0 兼容）。

## 行为

见 `CODE_OF_CONDUCT.md`。安全问题不要开公开 Issue，见 `SECURITY.md`。
