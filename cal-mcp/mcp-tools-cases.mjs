// MCP 工具表回归：真起一个 stdio 子进程走 JSON-RPC，不碰日历服务器。
// 跑法：node mcp-tools-cases.mjs
// 这些是规格，不是对当前实现的描述 —— 新增工具前它就应该失败。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, 'mcp-server.mjs')], {
  cwd: here, stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const done = pending.get(msg.id);
    if (done) { pending.delete(msg.id); done(msg); }
  }
});
child.stderr.on('data', () => {});

let nextId = 0;
function request(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时未响应：${method}`)), 6000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
}

try {
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const list = await request('tools/list');
  const tools = list.result?.tools ?? [];
  const update = tools.find((tool) => tool.name === 'calendar_update_event');

  check('工具表里列出 calendar_update_event', Boolean(update),
    `当前只有 ${tools.map((t) => t.name).join(', ')}`);
  check('update 工具把 uid 列为必填', Array.isArray(update?.inputSchema?.required)
    && update.inputSchema.required.includes('uid'),
    '没有 uid 就该拒绝，不能让模型瞎猜改哪一条');

  // 缺 uid 时不能写日历，且错误要说清是 uid 的问题，而不是「未知工具」。
  const missing = await request('tools/call', { name: 'calendar_update_event', arguments: { title: '改个标题' } });
  const message = String(missing.error?.message ?? missing.result?.content?.[0]?.text ?? '');
  check('缺 uid 时报的是 uid 错误', /uid/i.test(message) && !/未知工具/.test(message),
    `实际返回：${message.slice(0, 120)}`);
} catch (error) {
  check('stdio 协议能跑通', false, error.message);
} finally {
  child.kill();
}

console.log(`MCP 工具契约 ${results.length} 条`);
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `  ← ${r.detail}`}`);
  if (!r.ok) failed += 1;
}
console.log(`${results.length - failed}/${results.length} 通过${failed ? `，${failed} 条失败` : ''}`);
process.exit(failed ? 1 : 0);
