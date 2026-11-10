import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import {
  ASSISTANT_EMPLOYEE_ID,
  ensureAssistantSeeded,
  insertEmployee,
  listEmployees,
} from '../src/main/db/employees.js';

// ── 引导名册（要求：只补幕僚长）──
// 口径：**空表才补、只补幕僚长(id=0,is_assistant=1)、幂等、非空绝不插、不臆造其它员工**。

test('引导名册：空表 → 只补幕僚长(id=0, is_assistant=1)；重复调用幂等', () => {
  const db = openMemoryDatabase();
  runMigrations(db);

  assert.equal(ensureAssistantSeeded(db, 100).seeded, true);
  const emps = listEmployees(db);
  assert.equal(emps.length, 1, '只应有幕僚长一人');
  assert.equal(emps[0].id, ASSISTANT_EMPLOYEE_ID);
  assert.equal(emps[0].name, '幕僚长');
  assert.equal(emps[0].is_assistant, 1);

  // 幂等：第二次不插、人数不变
  assert.equal(ensureAssistantSeeded(db, 200).seeded, false);
  assert.equal(listEmployees(db).length, 1);
  db.close();
});

test('引导名册：非空 → 绝不插（不覆盖、不追加、不臆造）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 7, name: '张三', role: 'writer', now: 1 });

  assert.equal(ensureAssistantSeeded(db, 100).seeded, false);
  const emps = listEmployees(db);
  assert.equal(emps.length, 1);
  assert.equal(emps[0].id, 7);
  assert.ok(!emps.some((e) => e.id === ASSISTANT_EMPLOYEE_ID), '非空时不得补幕僚长');
  db.close();
});
