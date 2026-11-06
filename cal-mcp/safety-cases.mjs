/**
 * 安全与数据正确性用例。跑法：node safety-cases.mjs
 *
 * 这里锁的都是「改坏了不会报错、但会静默出事」的行为：
 *   1. Basic 凭据能跟着重定向跑到哪些主机
 *   2. 按标题删日程，命中多条时会不会连坐
 *   3. 补发用的 uid 是不是稳定的
 */

import { isTrustedHop, newEventUid } from './src/caldav.mjs';
import { deleteEvent } from './src/tools.mjs';

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass += 1;
  } catch (error) {
    failures.push(`${name}：${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
  } catch (error) {
    failures.push(`${name}：${error.message}`);
  }
}

function expect(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label ?? ''} 期望 ${expected}，实际 ${actual}`);
}

// ── 1. 重定向：凭据只发给同域 ──────────────────────────────
const BASE = 'https://caldav.icloud.com/';

check('同主机可以发凭据', () => expect(isTrustedHop(BASE, 'https://caldav.icloud.com/123/calendars/'), true));
check('iCloud 分片主机可以发凭据', () => expect(isTrustedHop(BASE, 'https://p33-caldav.icloud.com/123/'), true));
check('外域不许发凭据', () => expect(isTrustedHop(BASE, 'https://evil.example.com/steal'), false));
check('http 降级不许发凭据', () => expect(isTrustedHop(BASE, 'http://caldav.icloud.com/'), false));
check('后缀伪装的域名不许发凭据', () => expect(isTrustedHop(BASE, 'https://caldav.icloud.com.evil.com/'), false));
check('本机调试允许 http', () => expect(isTrustedHop('http://127.0.0.1:5232/', 'http://127.0.0.1:5232/x'), true));
check('本机不许跳到公网', () => expect(isTrustedHop('http://127.0.0.1:5232/', 'https://evil.example.com/'), false));
check('非法 URL 一律拒绝', () => expect(isTrustedHop(BASE, 'not a url'), false));

// ── 2. 按标题删除：命中多条必须先确认 ──────────────────────
const iso = (day, hour) => new Date(2026, 10, day, hour, 0).toISOString();

function fakeClient(events) {
  return {
    deleted: [],
    async listEvents() {
      return events;
    },
    async deleteEvent({ uid }) {
      this.deleted.push(uid);
      return { deleted: true, uid };
    },
  };
}

const twin = [
  { uid: 'uid-a', title: '组会', start: iso(7, 14), end: iso(7, 16), calendar: '学习' },
  { uid: 'uid-b', title: '开会讨论', start: iso(8, 9), end: iso(8, 10), calendar: '学习' },
];

await checkAsync('命中多条且未确认时不删', async () => {
  const client = fakeClient(twin);
  const result = await deleteEvent({ title: '会', client });
  expect(result.needsConfirm, true, 'needsConfirm');
  expect(result.ok, false, 'ok');
  expect(client.deleted.length, 0, '实际删除条数');
  expect(result.candidates.length, 2, '候选条数');
});

await checkAsync('确认后才删，且逐条记账', async () => {
  const client = fakeClient(twin);
  const result = await deleteEvent({ title: '会', confirm: true, client });
  expect(client.deleted.length, 2, '实际删除条数');
  expect(result.deleted.length, 2, '回执条数');
  expect(result.ok, true, 'ok');
});

await checkAsync('dryRun 不删只报', async () => {
  const client = fakeClient(twin);
  const result = await deleteEvent({ title: '会', dryRun: true, client });
  expect(client.deleted.length, 0, '实际删除条数');
  expect(result.dryRun, true, 'dryRun');
});

await checkAsync('命中单条直接删', async () => {
  const client = fakeClient([twin[1]]);
  const result = await deleteEvent({ title: '讨论', client });
  expect(client.deleted.length, 1, '实际删除条数');
  expect(result.deleted[0], 'uid-b', '删掉的 uid');
});

await checkAsync('超过上限时拒绝，即使带 confirm', async () => {
  const many = Array.from({ length: 11 }, (_, index) => ({
    uid: `uid-${index}`,
    title: '开会',
    start: iso(7, 9),
    end: iso(7, 10),
    calendar: '学习',
  }));
  const client = fakeClient(many);
  const result = await deleteEvent({ title: '开会', confirm: true, client });
  expect(client.deleted.length, 0, '实际删除条数');
  expect(result.needsConfirm, true, 'needsConfirm');
});

await checkAsync('按 uid 删不受确认限制', async () => {
  const client = fakeClient([]);
  const result = await deleteEvent({ uid: 'uid-x', client });
  expect(client.deleted[0], 'uid-x', '删掉的 uid');
  expect(result.ok, true, 'ok');
});

// ── 3. 补发 uid 稳定性 ────────────────────────────────────
check('uid 每次都不同', () => expect(newEventUid() === newEventUid(), false));
check('uid 带项目后缀，便于在 iCloud 上认出来', () => {
  if (!newEventUid().endsWith('@dsh-cal')) throw new Error('缺少 @dsh-cal 后缀');
});

// ── 汇总 ─────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`✓ ${pass} 条安全用例全部通过`);
} else {
  console.log(`✗ ${pass} 条通过，${failures.length} 条失败：`);
  for (const line of failures) console.log(`  ✗ ${line}`);
  process.exitCode = 1;
}
