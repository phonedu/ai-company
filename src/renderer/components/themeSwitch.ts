/**
 *  主题开关（2026-10-28 指示：两个状态别用下拉，做成左右滑动开关＋日/夜图标）。
 *
 * 语义保留「跟随系统」作为**初始默认**：设置值仍是 `system` 时，开关按当前实际生效的
 * 深浅显示，旁边小字提示「跟随系统」；用户一动开关就固定为 light/dark（不再跟系统）。
 */
export type ThemePref = 'light' | 'dark' | 'system';
export type ThemeExplicit = 'light' | 'dark';

/** 当前该显示为「夜间」吗（设置值 system 时按实际生效深浅）。 */
export function themeSwitchChecked(pref: ThemePref, systemPrefersDark: boolean): boolean {
  if (pref === 'dark') return true;
  if (pref === 'light') return false;
  return systemPrefersDark;
}

/** 点击开关后的目标值：取当前的相反态（system 时以实际生效态为当前）。 */
export function themeSwitchTarget(pref: ThemePref, systemPrefersDark: boolean): ThemeExplicit {
  return themeSwitchChecked(pref, systemPrefersDark) ? 'light' : 'dark';
}

/** 是否仍处于「跟随系统」（用于小字提示）。 */
export function isFollowingSystem(pref: ThemePref): boolean {
  return pref === 'system';
}
