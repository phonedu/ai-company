/**
 * 项目模型白名单——**单一判据**。
 *
 * `task:create.model` / `模型` 命令 / `employee:update` / `company.json apply` 共用；
 * 任何入口都不得复制第二份，否则 company.json 可以绕过项目白名单。
 */
import type { ProjectDTO } from '../ipc/ports.js';

/** 模型串的供应商标记（`provider/model` → `provider`；无 `/` 时整串视为供应商）。 */
export function providerOfModel(model: string): string {
  const trimmed = model.trim();
  const slash = trimmed.indexOf('/');
  return slash > 0 ? trimmed.slice(0, slash) : trimmed;
}

/** `allowed_providers` 非空时，模型供应商必须落在白名单内；返回人话错误或 null。 */
export function modelWhitelistError(input: {
  model: string;
  allowedProviders: readonly string[];
  projectLabel?: string | null;
}): string | null {
  if (input.allowedProviders.length === 0) return null;
  const provider = providerOfModel(input.model);
  if (input.allowedProviders.includes(provider)) return null;
  return (
    `模型 ${input.model} 的供应商「${provider}」不在项目${input.projectLabel ? `「${input.projectLabel}」` : ''}白名单内` +
    `（允许：${input.allowedProviders.join(' / ')}；EMPLOYEES §10.3）——请改选白名单内模型`
  );
}

/** 员工被哪些项目引用（编制/负责人）→ 逐个查白名单；未引用任何白名单项目 → 通过。 */
export function employeeModelWhitelistError(
  projects: readonly ProjectDTO[],
  employeeId: number | null,
  model: string,
): string | null {
  for (const project of projects) {
    if (project.allowedProviders.length === 0) continue;
    const referenced =
      employeeId != null && (project.defaultOwnerId === employeeId || project.defaultEmployeeIds.includes(employeeId));
    if (!referenced) continue;
    const error = modelWhitelistError({
      model,
      allowedProviders: project.allowedProviders,
      projectLabel: project.name,
    });
    if (error) return error;
  }
  return null;
}
