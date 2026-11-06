/**
 * 安全与数据正确性用例。跑法：node safety-cases.mjs
 *
 * 这里锁的都是「改坏了不会报错、但会静默出事」的行为：
 *   1. Basic 凭据能跟着重定向跑到哪些主机（含公共后缀陷阱）
 *   2. 按标题删日程，命中多条时会不会连坐（含 confirm 传字符串的绕过）
 *   3. 补发用的 uid 是不是稳定的
 *   4. 钥匙串写入失败时，密码会不会跟着错误消息跑出来
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTrustedHop, newEventUid } from './src/caldav.mjs';
import { deleteEvent } from './src/tools.mjs';
import { redact, savePassword } from './src/store.mjs';

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

// ── 1b. 公共后缀：末两段相同 ≠ 同一家人 ────────────────────
// 旧实现按「末两段」判断，于是下面这几条全被放行，凭据真的会发出去。
const suffixCases = [
  ['https://foo.bar.co.uk/', 'https://evil.co.uk/', false, 'co.uk 下是两个不同注册人'],
  ['https://me.github.io/', 'https://attacker.github.io/', false, 'github.io 下是两个不同人'],
  ['https://a.com.cn/', 'https://b.com.cn/', false, 'com.cn 下是两个不同人'],
  ['https://co.uk/', 'https://evil.co.uk/', false, 'base 本身是公共后缀'],
  ['https://caldav.icloud.com/', 'https://evil.icloud.com/', true, '同一服务商的分片仍放行'],
  ['https://example.com/', 'https://cal.example.com/', true, '子域算同一方'],
  ['https://cal.example.com/', 'https://example.com/', true, '退回父域算同一方'],
  ['http://caldav.icloud.com/', 'https://caldav.icloud.com/', false, 'base 是明文 http'],
  ['https://example.com/', 'https://example.com.evil.io/', false, '后缀追加式伪装'],
];
for (const [base, target, expected, label] of suffixCases) {
  check(label, () => expect(isTrustedHop(base, target), expected));
}

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

// ── 2b. confirm 只有布尔 true 才算确认 ────────────────────
// MCP 的参数是模型填的，传字符串 "false" 时以前 `!confirm` 判成假 → 命中多条照删。
await checkAsync('confirm 传字符串 "false" 不许删', async () => {
  const client = fakeClient(twin);
  const result = await deleteEvent({ title: '会', confirm: 'false', client });
  expect(client.deleted.length, 0, '实际删除条数');
  expect(result.needsConfirm, true, 'needsConfirm');
});

await checkAsync('confirm 传 1 或非空对象也不许删', async () => {
  for (const bad of [1, 'yes', {}, []]) {
    const client = fakeClient(twin);
    const result = await deleteEvent({ title: '会', confirm: bad, client });
    expect(client.deleted.length, 0, `confirm=${JSON.stringify(bad)} 时删除条数`);
    expect(result.needsConfirm, true, `confirm=${JSON.stringify(bad)} 的 needsConfirm`);
  }
});

await checkAsync('dryRun 传字符串 "false" 不是预览，照常删单条', async () => {
  const client = fakeClient([twin[1]]);
  await deleteEvent({ title: '讨论', dryRun: 'false', client });
  expect(client.deleted.length, 1, '实际删除条数');
});

// ── 4. 密码不许跟着错误消息跑出来 ─────────────────────────
// execFileSync 失败时 Node 会把整条 argv 拼进 error.message，
// 而 cli 会把它打到 stderr / --json、App 会写进日志。这里用假 security 复现。
check('redact 会抹掉 -w 后面的值', () => {
  const dirty = 'Command failed: security add-generic-password -s dsh-cal -w abcd-efgh-ijkl-mnop';
  const clean = redact(dirty);
  if (clean.includes('abcd-efgh-ijkl-mnop')) throw new Error(`没抹干净：${clean}`);
});

await checkAsync('钥匙串写入失败时，错误消息里没有密码', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sec-'));
  const fake = join(dir, 'security');
  writeFileSync(fake, '#!/bin/sh\nexit 1\n', 'utf8');
  chmodSync(fake, 0o755);
  const originalPath = process.env.PATH;
  const secret = 'abcd-efgh-ijkl-mnop';
  process.env.PATH = dir;
  try {
    let caught;
    try {
      savePassword('u@example.com', secret);
    } catch (error) {
      caught = error;
    }
    if (!caught) throw new Error('假 security 退出 1，却没有抛错');
    if (caught.message.includes(secret)) throw new Error(`错误消息里带着密码：${caught.message}`);
    if (!/写入钥匙串失败/u.test(caught.message)) throw new Error(`错误消息不是预期文案：${caught.message}`);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
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
