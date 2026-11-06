/**
 * CalDAV 行为用例。跑法：node caldav-cases.mjs
 *
 * 起一个本机的假 CalDAV 服务端，验证三件只能在真实 HTTP 往返里暴露的事：
 *   1. 同一个 uid 重复写不会变成两条（补发幂等）
 *   2. 重定向到别的域名时，凭据不许跟过去
 *   3. 服务端不回应时，请求会超时而不是一直挂着
 *
 * 不碰真日历，不需要账号，也不联网。
 */

import { createServer } from 'node:http';
import { CalDav, CalDavError } from './src/caldav.mjs';

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
const stored = new Map();
let port = 0;

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
    if (path === '/u/') return sendXml(CALENDARS);
  }

  if (req.method === 'PUT') {
    if (stored.has(path)) {
      res.writeHead(412, { 'content-type': 'text/plain' });
      res.end('precondition failed');
      return;
    }
    stored.set(path, body);
    res.writeHead(201);
    res.end();
    return;
  }

  if (req.method === 'GET') {
    if (!stored.has(path)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/calendar', etag: '"v1"' });
    res.end(stored.get(path));
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

// ── 2. 重定向到外域 ──────────────────────────────────────
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

// ── 3. 服务端不回应 ──────────────────────────────────────
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
