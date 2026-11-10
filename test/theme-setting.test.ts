/**
 *  · 主题设置（ui.theme）：白名单/枚举校验 + settings:set 立即应用到 nativeTheme 注入面。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isKnownSettingKey, validateSettingValue } from '../src/main/db/settings.js';
import { handleSettingsSet } from '../src/main/ipc/ipc.js';

test('ui.theme：白名单 + 只接受 light/dark/system；null 可清空', () => {
  assert.equal(isKnownSettingKey('ui.theme'), true);
  for (const value of ['light', 'dark', 'system']) {
    assert.deepEqual(validateSettingValue('ui.theme', value), { ok: true });
  }
  assert.equal(validateSettingValue('ui.theme', 'blue').ok, false);
  assert.equal(validateSettingValue('ui.theme', '').ok, false);
  assert.equal(validateSettingValue('ui.theme', 1).ok, false);
  assert.deepEqual(validateSettingValue('ui.theme', null), { ok: true });
});

test('settings:set(ui.theme)：写库后调用 setTheme；非法值不写不调', () => {
  const writes: Array<{ key: string; value: unknown }> = [];
  const themes: string[] = [];
  const deps = {
    repo: {
      setSetting: (row: { key: string; value: unknown }) => writes.push(row),
    },
    setTheme: (theme: string) => themes.push(theme),
  } as never;

  const ok = handleSettingsSet(deps, { key: 'ui.theme', value: 'dark' });
  assert.deepEqual(ok, { ok: true, value: 'dark' });
  assert.deepEqual(writes, [{ key: 'ui.theme', value: 'dark' }]);
  assert.deepEqual(themes, ['dark']);

  const bad = handleSettingsSet(deps, { key: 'ui.theme', value: 'blue' });
  assert.equal(bad.ok, false);
  assert.equal(writes.length, 1);
  assert.deepEqual(themes, ['dark']);
});
