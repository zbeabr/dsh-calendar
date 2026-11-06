/**
 * CalDAV 行为用例。跑法：node caldav-cases.mjs
 *
 * 起一个本机的假 CalDAV 服务端，验证这些只能在真实 HTTP 往返里暴露的事：
 *   1. 同一个 uid 重复写不会变成两条（补发幂等）
 *   2. 改时间只动 VEVENT，不会写坏前面的 VTIMEZONE
 *   3. 服务端文件名和 UID 不一致时，按 uid 也能改、能删
 *   4. 重定向到别的域名时，凭据不许跟过去
 *   5. 服务端不回应时，请求会超时而不是一直挂着
 *
 * 不碰真日历，不需要账号，也不联网。
 */

// 和 parse-cases.mjs 一样固定 +08:00 才可复现：E-2 的样例 ICS 写死了
// TZID=Asia/Shanghai，用例的 from/to 与期望值也用本机时区构造，
// nextOccurrence 还按本机本地小时重建发生时刻。机器时区不同会差 8 小时、
// 甚至让 RECURRENCE-ID 的去重失效（CI 的 UTC runner 上实测挂 2 条）。
// 注意：这只保证测试环境自洽，**不代表「机器时区 ≠ 日历时区」的组合已验证**。
process.env.TZ = 'Asia/Shanghai';

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CalDav, CalDavError, parseVevents } from './src/caldav.mjs';

let pass = 0;
const failures = [];

async function check(name, fn) {
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ── 假的 CalDAV 服务端 ────────────────────────────────────
// stored: path → { body, etag }
const stored = new Map();
let etagSeq = 0;
// 有些服务端会忽略 UID 过滤器、把整个日历都回给你，客户端必须自己核对 UID
let ignoreUidFilter = false;
let port = 0;
// 打开后多返回一个「坏日历」：列表时它所在的 REPORT 会返 500。
// 关着时服务端行为和原来完全一致，前面 16 条用例不受影响。
let brokenCalendar = null;
// 打开后服务端在日历属性里带上颜色，用来验证业务层没有把 color 丢掉。
let calendarColor = null;

const escapeXmlText = (text) => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
const unescapeXmlText = (text) => text.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&');

/** 从一份 ics 里取 UID。 */
const uidOf = (ics) => /^UID:(.*)$/imu.exec(ics)?.[1]?.trim();

const PRINCIPAL = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:"><d:response>
  <d:href>/</d:href>
  <d:propstat><d:prop>
    <d:current-user-principal><d:href>/principals/u/</d:href></d:current-user-principal>
  </d:prop></d:propstat>
</d:response></d:multistatus>`;

const HOME = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response>
  <d:href>/principals/u/</d:href>
  <d:propstat><d:prop>
    <c:calendar-home-set><d:href>/u/</d:href></c:calendar-home-set>
  </d:prop></d:propstat>
</d:response></d:multistatus>`;

const CALENDARS = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response>
  <d:href>/u/cal/</d:href>
  <d:propstat><d:prop>
    <d:displayname>测试</d:displayname>
    <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
    <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
    <d:current-user-privilege-set><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>
  </d:prop></d:propstat>
</d:response></d:multistatus>`;

/** 打开 brokenCalendar 时，在日历列表里额外塞一个会返 500 的日历。 */
const calendarsXml = (broken, color) => {
  const colorProp = color
    ? `<cs:calendar-color xmlns:cs="http://calendarserver.org/ns/">${color}</cs:calendar-color>`
    : '';
  // 只给第一个日历加颜色属性；既有用例在 color 为 null 时拿到的响应与原来完全一致。
  const base = CALENDARS.replace('<d:current-user-privilege-set>', `${colorProp}<d:current-user-privilege-set>`);
  if (!broken) return base;
  const extra = `<d:response>
  <d:href>/u/broken/</d:href>
  <d:propstat><d:prop>
    <d:displayname>${escapeXmlText(broken)}</d:displayname>
    <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
    <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
    <d:current-user-privilege-set><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>
  </d:prop></d:propstat>
</d:response>`;
  return base.replace('</d:multistatus>', `${extra}</d:multistatus>`);
};

const server = createServer(async (req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  let body = '';
  for await (const chunk of req) body += chunk;

  const sendXml = (xml, status = 207) => {
    res.writeHead(status, { 'content-type': 'application/xml; charset=utf-8' });
    res.end(xml);
  };

  if (path === '/bounce') {
    // 典型的开放重定向：把客户端踢到别的域名
    res.writeHead(302, { location: 'https://evil.example.com/collect' });
    res.end();
    return;
  }
  if (path === '/slow') return; // 永远不回应，测超时

  if (req.method === 'PROPFIND') {
    if (path === '/') return sendXml(PRINCIPAL);
    if (path === '/principals/u/') return sendXml(HOME);
    if (path === '/u/') return sendXml(calendarsXml(brokenCalendar, calendarColor));
  }

  if (req.method === 'REPORT') {
    if (brokenCalendar && path === '/u/broken/') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
      return;
    }
    // 真实服务端会按 calendar-query 里的过滤器挑，这里只实现 UID 过滤这一条
    const asked = /<(?:\w+:)?text-match[^>]*>([^<]*)/iu.exec(body)?.[1];
    const uid = asked ? unescapeXmlText(asked).trim() : undefined;
    const items = [];
    for (const [key, record] of stored) {
      if (!key.startsWith('/u/cal/')) continue;
      if (uid && !ignoreUidFilter && uidOf(record.body) !== uid) continue;
      items.push(`<d:response><d:href>${key}</d:href><d:propstat><d:prop>`
        + `<d:getetag>${record.etag}</d:getetag>`
        + `<c:calendar-data>${escapeXmlText(record.body)}</c:calendar-data>`
        + '</d:prop></d:propstat></d:response>');
    }
    return sendXml(`<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${items.join('')}</d:multistatus>`);
  }

  if (req.method === 'PUT') {
    const ifNone = req.headers['if-none-match'];
    const ifMatch = req.headers['if-match'];
    // if-none-match: * 是「只新建」；if-match 是「按版本覆盖」。以前这里一律 412，
    // 于是「读出来改完写回去」根本没法测。
    if (ifNone === '*' && stored.has(path)) {
      res.writeHead(412, { 'content-type': 'text/plain' });
      res.end('precondition failed');
      return;
    }
    if (ifMatch && (!stored.has(path) || ifMatch !== stored.get(path).etag)) {
      res.writeHead(412, { 'content-type': 'text/plain' });
      res.end('precondition failed');
      return;
    }
    const existed = stored.has(path);
    stored.set(path, { body, etag: `"v${(etagSeq += 1)}"` });
    res.writeHead(existed ? 204 : 201);
    res.end();
    return;
  }

  if (req.method === 'GET') {
    const record = stored.get(path);
    if (!record) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/calendar', etag: record.etag });
    res.end(record.body);
    return;
  }

  if (req.method === 'DELETE') {
    if (!stored.delete(path)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
port = server.address().port;

const client = new CalDav({
  baseUrl: `http://127.0.0.1:${port}/`,
  username: 'u',
  password: 'p',
  timeZone: 'Asia/Shanghai',
  timeoutMs: 800,
});

const event = {
  calendar: '测试',
  title: '补发测试',
  start: new Date(2026, 10, 7, 15, 0),
  end: new Date(2026, 10, 7, 16, 0),
};

// ── 1. 同一个 uid 写两次 ──────────────────────────────────
await check('首次写入成功', async () => {
  const result = await client.createEvent({ ...event, uid: 'fixed-uid-1@dsh-cal' });
  expect(result.exists, undefined, 'exists');
  expect(stored.size, 1, '服务端条数');
});

await check('同一 uid 再写一次：不新增，返回 exists', async () => {
  const result = await client.createEvent({ ...event, uid: 'fixed-uid-1@dsh-cal' });
  expect(result.exists, true, 'exists');
  expect(stored.size, 1, '服务端条数');
});

await check('不同 uid 才会新增', async () => {
  await client.createEvent({ ...event, uid: 'fixed-uid-2@dsh-cal' });
  expect(stored.size, 2, '服务端条数');
});

await check('按 uid 删除', async () => {
  const result = await client.deleteEvent({ uid: 'fixed-uid-1@dsh-cal', calendar: '测试' });
  expect(result.deleted, true, 'deleted');
  expect(stored.size, 1, '服务端条数');
});

// ── 2. 改时间：只能改 VEVENT，不能改到 VTIMEZONE ──────────
const timed = { start: new Date(2026, 10, 7, 15, 0), end: new Date(2026, 10, 7, 16, 0) };
const pathOf = (uid) => [...stored.keys()].find((key) => key.endsWith(`${uid}.ics`));
const eventOf = (path) => parseVevents(stored.get(path).body, 'Asia/Shanghai')[0];

await check('建一条带 VTIMEZONE 的定时日程', async () => {
  await client.createEvent({ calendar: '测试', title: '组会', ...timed, uid: 'zone-uid@dsh-cal' });
  const ics = stored.get(pathOf('zone-uid@dsh-cal')).body;
  assert(/BEGIN:VTIMEZONE/u.test(ics), '定时事件应该带 VTIMEZONE');
  assert(/DTSTART:19700101T000000/u.test(ics), 'VTIMEZONE 里应有一个固定的 DTSTART');
});

await check('改时间：事件真的挪了，VTIMEZONE 没被动', async () => {
  const path = pathOf('zone-uid@dsh-cal');
  const moved = { start: new Date(2026, 10, 7, 18, 0), end: new Date(2026, 10, 7, 19, 0) };
  const result = await client.updateEvent({ uid: 'zone-uid@dsh-cal', ...moved });
  expect(result.updated, true, 'updated');
  const ics = stored.get(path).body;
  assert(/DTSTART:19700101T000000/u.test(ics), 'VTIMEZONE 的 DTSTART 被改坏了');
  expect(ics.match(/^DTSTART[:;]/gmu).length, 2, 'DTSTART 行数（VTIMEZONE + 事件）');
  const event = eventOf(path);
  expect(new Date(event.start).getTime(), moved.start.getTime(), '事件开始时间');
  expect(new Date(event.end).getTime(), moved.end.getTime(), '事件结束时间');
});

await check('只改开始时间：结束时间按原时长平移，不留非法区间', async () => {
  const path = pathOf('zone-uid@dsh-cal');
  const later = new Date(2026, 10, 7, 20, 0);
  await client.updateEvent({ uid: 'zone-uid@dsh-cal', start: later });
  const event = eventOf(path);
  expect(new Date(event.start).getTime(), later.getTime(), '开始时间');
  expect(new Date(event.end).getTime(), later.getTime() + 3600000, '结束时间应按原 1 小时平移');
});

await check('改标题不会弄丢重复规则和提醒', async () => {
  await client.createEvent({
    calendar: '测试', title: '早读', ...timed, repeat: 'FREQ=WEEKLY;BYDAY=SA', alarmMinutes: 10, uid: 'repeat-uid@dsh-cal',
  });
  const path = pathOf('repeat-uid@dsh-cal');
  await client.updateEvent({ uid: 'repeat-uid@dsh-cal', title: '早读（改）' });
  const ics = stored.get(path).body;
  assert(/RRULE:FREQ=WEEKLY;BYDAY=SA/u.test(ics), 'RRULE 丢了');
  assert(/TRIGGER:-PT10M/u.test(ics), 'VALARM 丢了');
  assert(/SUMMARY:早读（改）/u.test(ics), '标题没改成');
});

// ── 3. 文件名 ≠ UID：苹果里建的、导入的、第三方同步的事件都这样 ──
const importedPath = '/u/cal/imported-9f3.ics';
const importedUid = 'apple-uid-1@icloud.com';

await check('按 uid 改：服务端文件名和 UID 不一样也能改', async () => {
  stored.set(importedPath, {
    etag: '"v900"',
    body: [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iOS 17//EN',
      'BEGIN:VEVENT', `UID:${importedUid}`, 'DTSTAMP:20261101T000000Z',
      'DTSTART;TZID=Asia/Shanghai:20261108T090000',
      'DTEND;TZID=Asia/Shanghai:20261108T100000',
      'SUMMARY:苹果里建的课', 'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n'),
  });
  const result = await client.updateEvent({ uid: importedUid, title: '改过的课' });
  expect(result.updated, true, 'updated');
  assert(/SUMMARY:改过的课/u.test(stored.get(importedPath).body), '内容没写回原文件');
});

await check('按 uid 删：服务端文件名和 UID 不一样也能删', async () => {
  const result = await client.deleteEvent({ uid: importedUid });
  expect(result.deleted, true, 'deleted');
  assert(!stored.has(importedPath), '服务端文件还在');
});

await check('服务端忽略 UID 过滤时，也不会改错文件', async () => {
  await client.createEvent({ calendar: '测试', title: '别的日程', ...timed, uid: 'other-uid@dsh-cal' });
  const decoy = '/u/cal/apple-photo-77.ics';
  stored.set(decoy, {
    etag: '"v901"',
    body: [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 14//EN',
      'BEGIN:VEVENT', 'UID:orphan-uid@icloud.com', 'DTSTAMP:20261101T000000Z',
      'DTSTART;TZID=Asia/Shanghai:20261109T090000',
      'DTEND;TZID=Asia/Shanghai:20261109T100000',
      'SUMMARY:原始标题', 'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n'),
  });
  ignoreUidFilter = true;
  try {
    const result = await client.updateEvent({ uid: 'orphan-uid@icloud.com', title: '挑对了' });
    expect(result.updated, true, 'updated');
  } finally {
    ignoreUidFilter = false;
  }
  assert(/SUMMARY:挑对了/u.test(stored.get(decoy).body), '改错了文件');
  assert(!/SUMMARY:挑对了/u.test(stored.get(pathOf('other-uid@dsh-cal')).body), '把别的日程也改了');
});

await check('列表里的每条日程都带服务端地址', async () => {
  const events = await client.listEvents({ from: new Date(2026, 10, 1), to: new Date(2026, 10, 30) });
  assert(events.length > 0, '应该有日程');
  assert(
    events.every((event) => /^http:\/\/127\.0\.0\.1:\d+\/u\/cal\//u.test(event.url ?? '')),
    '有日程没带 href，按文件名找会 404',
  );
});

// ── 4. 重定向到外域 ──────────────────────────────────────
await check('跳到外域时拒绝发送凭据', async () => {
  let error;
  try {
    await client.request(`http://127.0.0.1:${port}/bounce`);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof CalDavError, '应该抛 CalDavError');
  assert(/不受信任/u.test(error.message), `错误信息没说明原因：${error.message}`);
  assert(!error.network, '这不该被当成网络错误，否则会被塞进离线队列反复重试');
});

// ── 5. 服务端不回应 ──────────────────────────────────────
await check('服务端不回应时按超时处理', async () => {
  let error;
  const started = Date.now();
  try {
    await client.request(`http://127.0.0.1:${port}/slow`);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof CalDavError, '应该抛 CalDavError');
  assert(/超时/u.test(error.message), `错误信息没说明原因：${error.message}`);
  assert(error.network, '超时应当是可以离线排队的网络类错误');
  assert(Date.now() - started < 5000, '没有在超时时间内返回');
});

// ── 6. RECURRENCE-ID：改过单次的重复日程不该出现两行 ──────
// 服务端把「整条重复规则」和「被改过的那一次」当作两份 VEVENT 返回，UID 相同。
// 主事件折到区间里的下一次发生时必须跳过被覆盖的那一天，否则同一实例出现两行。
const vevent = (...lines) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
  'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');
const putIcs = (path, body) => stored.set(path, { etag: `"v${(etagSeq += 1)}"`, body });

const overrideUid = 'recur-override@example.com';
putIcs('/u/cal/override-master.ics', vevent(
  `UID:${overrideUid}`, 'DTSTAMP:20261101T000000Z',
  'DTSTART;TZID=Asia/Shanghai:20261107T090000',
  'DTEND;TZID=Asia/Shanghai:20261107T100000',
  'RRULE:FREQ=WEEKLY;BYDAY=SA',
  'SUMMARY:每周组会',
));
putIcs('/u/cal/override-instance.ics', vevent(
  `UID:${overrideUid}`, 'DTSTAMP:20261101T000000Z',
  'RECURRENCE-ID;TZID=Asia/Shanghai:20261107T090000',
  'DTSTART;TZID=Asia/Shanghai:20261108T140000',
  'DTEND;TZID=Asia/Shanghai:20261108T150000',
  'SUMMARY:改到周日的组会',
));

await check('改过单次的重复日程只出一行，且保留覆盖版本', async () => {
  const events = await client.listEvents({ from: new Date(2026, 10, 7, 0, 0), to: new Date(2026, 10, 9, 0, 0) });
  const rows = events.filter((item) => item.uid === overrideUid);
  expect(rows.length, 1, '同一 uid 的行数');
  expect(rows[0].title, '改到周日的组会', '保留的版本');
  expect(new Date(rows[0].start).getTime(), new Date(2026, 10, 8, 14, 0).getTime(), '覆盖后的开始时间');
});

// 全天日程的 RECURRENCE-ID 是日期型（20261111）而不是时间型，
// new Date(raw) 会解析不出或按 UTC 跑偏，必须走 parseIcsDate。
const allDayUid = 'allday-override@example.com';
putIcs('/u/cal/allday-master.ics', vevent(
  `UID:${allDayUid}`, 'DTSTAMP:20261101T000000Z',
  'DTSTART;VALUE=DATE:20261111',
  'DTEND;VALUE=DATE:20261112',
  'RRULE:FREQ=DAILY;COUNT=1',
  'SUMMARY:全天值班',
));
putIcs('/u/cal/allday-instance.ics', vevent(
  `UID:${allDayUid}`, 'DTSTAMP:20261101T000000Z',
  'RECURRENCE-ID;VALUE=DATE:20261111',
  'DTSTART;VALUE=DATE:20261112',
  'DTEND;VALUE=DATE:20261113',
  'SUMMARY:值班改到次日',
));

await check('全天重复日程的日期型 RECURRENCE-ID 也能去掉重复行', async () => {
  const events = await client.listEvents({ from: new Date(2026, 10, 11, 0, 0), to: new Date(2026, 10, 13, 0, 0) });
  const rows = events.filter((item) => item.uid === allDayUid);
  expect(rows.length, 1, '同一 uid 的行数');
  expect(rows[0].title, '值班改到次日', '保留的版本');
  expect(new Date(rows[0].start).getTime(), new Date(2026, 10, 12, 0, 0).getTime(), '覆盖后的开始日期');
});

// ── 7. 某个日历读取失败时不能静默少数据 ───────────────────
const TOOLS_URL = new URL('./src/tools.mjs', import.meta.url).href;
const STORE_URL = new URL('./src/store.mjs', import.meta.url).href;

function runNode(code, home, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], {
      env: { ...process.env, HOME: home, DSH_CAL_PASSWORD: 'p' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (status) => resolve({ code: status, out: out.trim(), err }));
  });
}

await check('一个日历返 500 时返回 partial/failed，好日历数据照常给', async () => {
  brokenCalendar = '坏日历';
  try {
    const events = await client.listEvents({ from: new Date(2026, 10, 1), to: new Date(2026, 10, 30) });
    const failed = events.failed ?? [];
    expect(events.partial, true, 'partial');
    expect(failed.length, 1, '失败日历条数');
    expect(failed[0].name, '坏日历', '失败日历名');
    expect(failed[0].status, 500, '失败状态码');
    assert(events.length > 0, '好日历的日程不该被一起丢掉');
  } finally {
    brokenCalendar = null;
  }
});

await check('全部日历读取成功时 partial 为 false', async () => {
  const events = await client.listEvents({ from: new Date(2026, 10, 1), to: new Date(2026, 10, 30) });
  expect(events.partial, false, 'partial');
  expect((events.failed ?? []).length, 0, '失败日历条数');
});

await check('tools 层的 summary 会提示日历读取失败', async () => {
  brokenCalendar = '坏日历';
  const home = mkdtempSync(join(tmpdir(), 'dsh-partial-'));
  try {
    const res = await runNode(`import { writeConfig } from ${JSON.stringify(STORE_URL)};
import { listEvents } from ${JSON.stringify(TOOLS_URL)};
const port = process.argv[1];
writeConfig({ baseUrl: 'http://127.0.0.1:' + port + '/', username: 'u', timeZone: 'Asia/Shanghai' });
const result = await listEvents({ from: new Date(2026, 10, 1), to: new Date(2026, 10, 30) });
console.log(JSON.stringify({ partial: result.partial, failed: result.failed, summary: result.summary }));`, home, [String(port)]);
    if (res.code !== 0) throw new Error(`子进程退出 ${res.code}：${res.err}`);
    const data = JSON.parse(res.out);
    expect(data.partial, true, 'tools 层的 partial');
    if (!data.summary.includes('1 个日历读取失败，结果可能不全')) {
      throw new Error(`summary 没有提示：${data.summary}`);
    }
  } finally {
    brokenCalendar = null;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 8. 日历颜色不能停在业务层 ─────────────────────────────
const toolsCalsCode = `import { writeConfig } from ${JSON.stringify(STORE_URL)};
import { listCalendars } from ${JSON.stringify(TOOLS_URL)};
const port = process.argv[1];
writeConfig({ baseUrl: 'http://127.0.0.1:' + port + '/', username: 'u', timeZone: 'Asia/Shanghai' });
const result = await listCalendars();
console.log(JSON.stringify({ calendars: result.calendars }));`;

await check('listCalendars 把服务端的日历颜色透传给 CLI/MCP', async () => {
  calendarColor = '#FF3B30FF';
  const home = mkdtempSync(join(tmpdir(), 'dsh-color-'));
  try {
    const res = await runNode(toolsCalsCode, home, [String(port)]);
    if (res.code !== 0) throw new Error(`子进程退出 ${res.code}：${res.err}`);
    const data = JSON.parse(res.out);
    expect(data.calendars.length, 1, '日历条数');
    expect(data.calendars[0].name, '测试', '日历名');
    expect(data.calendars[0].color, '#FF3B30FF', '日历颜色');
  } finally {
    calendarColor = null;
    rmSync(home, { recursive: true, force: true });
  }
});

await check('服务端不给颜色时 listCalendars 仍返回 color: null', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-nocolor-'));
  try {
    const res = await runNode(toolsCalsCode, home, [String(port)]);
    if (res.code !== 0) throw new Error(`子进程退出 ${res.code}：${res.err}`);
    const data = JSON.parse(res.out);
    expect(data.calendars.length, 1, '日历条数');
    expect(Object.prototype.hasOwnProperty.call(data.calendars[0], 'color'), true, 'color 字段是否存在');
    expect(data.calendars[0].color, null, '无颜色时的 color');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 汇总 ─────────────────────────────────────────────────
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));

if (failures.length === 0) {
  console.log(`✓ ${pass} 条 CalDAV 用例全部通过`);
} else {
  console.log(`✗ ${pass} 条通过，${failures.length} 条失败：`);
  for (const line of failures) console.log(`  ✗ ${line}`);
  process.exitCode = 1;
}
