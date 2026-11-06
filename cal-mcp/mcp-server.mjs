#!/usr/bin/env node
/**
 * dsh-cal MCP server (stdio, newline-delimited JSON-RPC 2.0).
 * Compatible with 豆包「自定义连接器」的 STDIO 模式、Claude Desktop、Cursor 等。
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  addEvent, createCalendar, deleteEvent, listCalendars, listEvents, pendingEvents, syncQueue,
} from './src/tools.mjs';

const PROTOCOL_VERSION = '2024-11-05';
// 版本号只有一个来源（package.json）。以前这里硬编码 1.0.0，项目到 1.1.1 了
// 宿主看到的还是 1.0.0，出问题时排查都从版本开始对不上。
const PKG = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const SERVER_INFO = { name: 'dsh-cal', version: PKG.version };

const TOOLS = [
  {
    name: 'calendar_add_event',
    description: [
      '添加一个日历日程。优先直接传 text：一句中文即可，例如「明天下午三点到四点开会」「今晚六点半到八点半调试 MacBook」「下周一上午十点评审一小时」。',
      '工具会自己解析日期、时间、时长和标题。也可以用 title/start/end 显式指定（ISO 8601，本地时间如 2026-11-04T18:30）。',
      '用户说到「标签」「日历」时，可以传 calendar 参数（例如「学习」）；也可以把标签直接写在 text 里，例如「明天三点开会 #学习」或「明天三点开会，加到工作日历」，工具会自动识别。',
      '要建全天日程就在 text 里带上 #全天（例如「明天 交作业 #全天」）：该日程不设时间，句子里就算写了钟点也按全天算。',
      '断网时不会失败：会先把日程存在本机队列里，回复里会说明「已暂存本地」，联网后自动补发（也可调用 calendar_sync_pending 立刻补发）。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '自然语言描述，包含时间，例如「明天下午三点到四点开会」' },
        title: { type: 'string', description: '事件标题；给了 text 时可省略' },
        start: { type: 'string', description: '开始时间，ISO 8601，例如 2026-11-04T18:30' },
        end: { type: 'string', description: '结束时间，ISO 8601' },
        calendar: { type: 'string', description: '写入哪个日历，例如「学习」；省略则用默认日历' },
        all_day: { type: 'boolean', description: '是否全天事件（等价的写法：在 text 里带 #全天）' },
        location: { type: 'string', description: '地点' },
        description: { type: 'string', description: '备注' },
      },
      required: [],
    },
  },
  {
    name: 'calendar_list_events',
    description: '列出未来一段时间的日程。默认 7 天。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '往后查几天，默认 7' },
        calendar: { type: 'string', description: '只看某个日历' },
        from: { type: 'string', description: '起始时间，ISO 8601' },
        to: { type: 'string', description: '结束时间，ISO 8601' },
      },
      required: [],
    },
  },
  {
    name: 'calendar_list_calendars',
    description: '列出账号下所有日历及其是否可写。用户提到某个「标签」时，可先用它确认名称。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'calendar_delete_event',
    description: '删除日程。传 uid 精确删除；或传 title（标题里的一段字），工具会在未来 30 天里找标题包含它的日程。'
      + '命中 1 条直接删；命中多条时**不会删**，只返回候选和 needsConfirm，此时要先把候选念给用户、确认后再带 confirm=true 调一次，或者改用其中某条的 uid。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '日程标题里的一段文字，例如「调试macbook」' },
        uid: { type: 'string', description: '日程 uid（可选，精确删除时用）' },
        calendar: { type: 'string', description: '在哪个日历里找' },
        days: { type: 'number', description: '按标题查找时往后找几天，默认 30' },
        confirm: { type: 'boolean', description: '按标题命中多条时，确认要全部删除才传 true' },
        dryRun: { type: 'boolean', description: '只看会删除哪些，不真的删' },
      },
      required: [],
    },
  },
  {
    name: 'calendar_sync_pending',
    description: '把断网期间暂存在本机的日程补发到日历服务器。返回补发了几条、还剩几条。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'calendar_pending',
    description: '查看本机还压着几条没同步的日程（断网时写入的）。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'calendar_create_calendar',
    description: '新建一个日历（例如用户想有一个「学习」日历）。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '日历名称' } },
      required: ['name'],
    },
  },
];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function textResult(payload) {
  const text = typeof payload === 'string' ? payload : payload.summary ?? JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}

/**
 * 模型填的参数不一定是布尔：常见是字符串 "true"/"false"。
 * 严格转换，不让 "false" 这种非空字符串被当成真值 —— 删除确认就是栽在这上面。
 */
function asBool(value) {
  if (value === true || value === false) return value;
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false' || text === '') return false;
  return undefined;
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'calendar_add_event':
      return textResult(await addEvent({
        text: args.text,
        title: args.title,
        start: args.start,
        end: args.end,
        calendar: args.calendar,
        allDay: asBool(args.all_day),
        location: args.location,
        description: args.description,
      }));
    case 'calendar_list_events':
      return textResult(await listEvents({ days: args.days, calendar: args.calendar, from: args.from, to: args.to, includeUid: true }));
    case 'calendar_list_calendars':
      return textResult(await listCalendars());
    case 'calendar_delete_event':
      return textResult(await deleteEvent({
        uid: args.uid,
        title: args.title,
        calendar: args.calendar,
        days: args.days,
        confirm: asBool(args.confirm) === true,
        dryRun: asBool(args.dryRun) === true,
      }));
    case 'calendar_sync_pending':
      return textResult(await syncQueue());
    case 'calendar_pending':
      return textResult(pendingEvents());
    case 'calendar_create_calendar':
      return textResult(await createCalendar({ name: args.name }));
    default:
      throw new Error(`未知工具：${name}`);
  }
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const result = await callTool(params?.name, params?.arguments ?? {});
      return reply(id, result);
    } catch (error) {
      return reply(id, { content: [{ type: 'text', text: `✗ ${error.message}` }], isError: true });
    }
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'prompts/list') return reply(id, { prompts: [] });
  if (method === 'resources/list') return reply(id, { resources: [] });
  if (id === undefined) return undefined; // notification: nothing to answer
  return replyError(id, -32601, `不支持的方法：${method}`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stderr.write(`dsh-cal: 无法解析的输入 ${trimmed.slice(0, 120)}\n`);
    return;
  }
  // Serialise handlers so PUT/REPORT requests never interleave.
  queue = queue.then(() => handle(message)).catch((error) => {
    process.stderr.write(`dsh-cal: ${error.stack ?? error.message}\n`);
  });
});

rl.on('close', () => {
  queue.finally(() => process.exit(0));
});
