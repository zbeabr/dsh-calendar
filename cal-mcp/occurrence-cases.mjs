// 重复日程「只删这一次 / 只改这一次」的工具层契约。
// 全部注入假 client，不连日历服务器。跑法：node occurrence-cases.mjs
//
// 设计取舍：不新增 RECURRENCE-ID 覆盖实例（要复制整块 VEVENT、容易写坏 RRULE），
// 而是「EXDATE 排除这一次」+「按新时间另建一条单次」。系列本身的 ICS 只改一行。
import assert from 'node:assert/strict';
import { deleteEvent, updateEvent } from './src/tools.mjs';
import { addExdateToVevent } from './src/caldav.mjs';

const OCC = '2026-11-16T10:00:00+08:00';
const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, detail: error.message.split('\n')[0] }); }
}

function fakeClient() {
  const calls = [];
  return {
    calls,
    deleteEvent: async (args) => { calls.push(['deleteEvent', args]); return { deleted: true }; },
    updateEvent: async (args) => { calls.push(['updateEvent', args]); return { updated: true, calendar: '学习' }; },
    skipOccurrence: async (args) => { calls.push(['skipOccurrence', args]); return { skipped: true, uid: args.uid, calendar: '学习' }; },
  };
}
const names = (client) => client.calls.map(([name]) => name);

await check('只删这一次：走 EXDATE 排除，不删整个系列', async () => {
  const client = fakeClient();
  const result = await deleteEvent({ uid: 'u1', scope: 'this', occurrence: OCC, client });
  assert.equal(result.ok, true, '应返回成功');
  assert.equal(result.scope, 'this');
  assert.deepEqual(result.skipped, [OCC]);
  assert.ok(names(client).includes('skipOccurrence'), '必须调用 skipOccurrence');
  assert.ok(!names(client).includes('deleteEvent'), '绝不能把整个系列删掉');
});

await check('只删这一次却没给是哪一次：必须报错，不能瞎删', async () => {
  const client = fakeClient();
  await assert.rejects(
    () => deleteEvent({ uid: 'u1', scope: 'this', client }),
    /这次|occurrence|开始时间/u,
  );
  assert.deepEqual(names(client), [], '报错前不能碰服务端');
});

await check('删整个系列：仍走原来的 deleteEvent', async () => {
  const client = fakeClient();
  const result = await deleteEvent({ uid: 'u1', scope: 'series', client });
  assert.equal(result.ok, true);
  assert.ok(names(client).includes('deleteEvent'));
  assert.ok(!names(client).includes('skipOccurrence'));
});

await check('只改这一次：先排除、再另建一条，不改系列', async () => {
  const client = fakeClient();
  const created = [];
  const result = await updateEvent({
    uid: 'u1', scope: 'this', occurrence: OCC,
    title: '组会改到下午', start: '2026-11-16T15:00:00+08:00',
    end: '2026-11-16T16:00:00+08:00',
    client,
    create: async (payload) => { created.push(payload); return { uid: 'new-u1', ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'this');
  assert.ok(names(client).includes('skipOccurrence'), '先排除原系列里的这一次');
  assert.equal(created.length, 1, '再新建一条单次日程');
  assert.equal(created[0].title, '组会改到下午');
  assert.ok(!names(client).includes('updateEvent'), '不能去改整个系列');
});

await check('只改这一次却没给是哪一次：必须报错', async () => {
  const client = fakeClient();
  await assert.rejects(
    () => updateEvent({ uid: 'u1', scope: 'this', title: '新标题', client, create: async () => ({}) }),
    /这次|occurrence|开始时间/u,
  );
  assert.deepEqual(names(client), []);
});

await check('改整个系列：仍走原来的 updateEvent', async () => {
  const client = fakeClient();
  const result = await updateEvent({ uid: 'u1', title: '新标题', client });
  assert.equal(result.ok, true);
  assert.ok(names(client).includes('updateEvent'));
  assert.ok(!names(client).includes('skipOccurrence'));
});

// ICS 层：EXDATE 只加一行，不动 RRULE / DTSTART，也不重复叠加。
const SERIES = [
  'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:u1',
  'DTSTART;TZID=Asia/Shanghai:20261116T100000',
  'DTEND;TZID=Asia/Shanghai:20261116T110000',
  'SUMMARY:组会', 'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

await check('EXDATE 用 UTC 戳写这一次，RRULE 与 DTSTART 原样', async () => {
  const out = addExdateToVevent(SERIES, OCC, 'Asia/Shanghai');
  assert.match(out, /EXDATE:20261116T020000Z/u);
  assert.match(out, /RRULE:FREQ=WEEKLY;BYDAY=MO/u);
  assert.match(out, /DTSTART;TZID=Asia\/Shanghai:20261116T100000/u);
});
await check('同一时刻排除两次不会写出两行 EXDATE', async () => {
  const once = addExdateToVevent(SERIES, OCC, 'Asia/Shanghai');
  const twice = addExdateToVevent(once, OCC, 'Asia/Shanghai');
  assert.equal((twice.match(/EXDATE/gu) ?? []).length, 1);
});
await check('全天重复日程用 VALUE=DATE，按事件时区取日期', async () => {
  const ics = [
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:u2',
    'DTSTART;VALUE=DATE:20261116', 'DTEND;VALUE=DATE:20261117',
    'SUMMARY:全天', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  assert.match(addExdateToVevent(ics, '2026-11-16T00:00:00+08:00', 'Asia/Shanghai'),
    /EXDATE;VALUE=DATE:20261116/u);
});

console.log(`重复日程单次操作 ${results.length} 条`);
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `  ← ${r.detail}`}`);
  if (!r.ok) failed += 1;
}
console.log(`${results.length - failed}/${results.length} 通过${failed ? `，${failed} 条失败` : ''}`);
process.exit(failed ? 1 : 0);
