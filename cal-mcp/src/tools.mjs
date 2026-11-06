/**
 * Shared calendar operations used by the CLI and the MCP server.
 * All user-facing text is Chinese; ISO timestamps are used for machine fields.
 */

import { CalDav, CalDavError } from './caldav.mjs';
import { needsRefine, refineWithModel } from './llm.mjs';
import { parseEvent, toRrule } from './nlp.mjs';
import {
  cachedCalendarNames, dequeueEvent, enqueueEvent, readCalendarCache, readConfig, readPassword,
  readQueue, writeCalendarCache,
} from './store.mjs';

export class NotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotConfiguredError';
  }
}

export function getClient() {
  const config = readConfig();
  if (!config.username) {
    throw new NotConfiguredError('还没有配置账号。先运行：node cli.mjs login');
  }
  const password = readPassword(config.username);
  if (!password) {
    throw new NotConfiguredError(`钥匙串里没有 ${config.username} 的密码。重新运行：node cli.mjs login`);
  }
  return {
    client: new CalDav({
      baseUrl: config.baseUrl,
      username: config.username,
      password,
      timeZone: config.timeZone,
    }),
    config,
  };
}

/** Accepts "2026-11-04 18:30", ISO strings, or Date. */
export function toDate(value, label = 'time') {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const normalized = value.trim().replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/u, '$1T$2');
    const date = new Date(normalized);
    if (!Number.isNaN(date.getTime())) return date;
  }
  throw new Error(`${label} 无法识别：${String(value)}`);
}

export function formatRange(start, end) {
  const day = (date) => new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', weekday: 'short', timeZone: 'Asia/Shanghai',
  }).format(date);
  const time = (date) => new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai',
  }).format(date);
  // 全天事件是「当天 00:00 到次日 00:00」，直接说「全天」比列两个 00:00 清楚
  const allDay = time(start) === '00:00'
    && time(end) === '00:00'
    && end.getTime() - start.getTime() === 86400000;
  if (allDay) return `${day(start)} 全天`;
  const sameDay = day(start) === day(end);
  return sameDay ? `${day(start)} ${time(start)}–${time(end)}` : `${day(start)} ${time(start)} → ${day(end)} ${time(end)}`;
}

/**
 * Add an event. Either pass natural-language `text`, or explicit title/start/end.
 *
 * 日历（标签）优先级：显式传入的 `calendar` > 句子里的标签 > 配置里的默认日历。
 * 断网时不会失败，而是把事件存进本地待发队列，返回 `queued: true`。
 */
export async function addEvent(input = {}) {
  const { client, config } = getClient();
  let { title, start, end, allDay, location, calendar, repeat, alarmMinutes } = input;
  calendar = typeof calendar === 'string' && calendar.trim() !== '' ? calendar.trim() : undefined;
  let tag;

  if (typeof input.text === 'string' && input.text.trim() !== '') {
    const calendarNames = cachedCalendarNames();
    const parsed = parseEvent(input.text, new Date(), { calendarNames });
    let refined;
    // 规则结果可疑（脏标题、缺地点、残留时间词）就让模型兜一次；模型只出标题和地点，时间仍用规则的
    if (!input.location && !input.noModel && (needsRefine(input.text, parsed) || !parsed.location)) {
      refined = await refineWithModel(
        input.text,
        { title: parsed.title, location: parsed.location, local: formatRange(parsed.start, parsed.end) },
        { calendarNames },
      );
    }
    title = title ?? refined?.title ?? parsed.title;
    start = start ?? parsed.start;
    end = end ?? parsed.end;
    allDay = allDay ?? parsed.allDay;
    location = location ?? refined?.location ?? parsed.location;
    tag = parsed.calendar;
    calendar = calendar ?? tag;
    repeat = repeat ?? (parsed.repeat ? toRrule(parsed.repeat) : undefined);
    alarmMinutes = alarmMinutes ?? parsed.alarmMinutes ?? undefined;
  }

  if (!title || String(title).trim() === '') throw new Error('缺少事件标题，请补充一句话描述，例如「明天下午三点到四点开会」');
  if (start === undefined) throw new Error('缺少开始时间');

  const startDate = toDate(start, '开始时间');
  const endDate = end === undefined
    ? new Date(startDate.getTime() + (allDay ? 86400000 : 3600000))
    : toDate(end, '结束时间');
  if (endDate <= startDate) throw new Error('结束时间必须晚于开始时间');

  const calendarName = calendar ?? config.calendar ?? undefined;
  const trimmedTitle = String(title).trim();
  const payload = {
    calendar: calendarName,
    title: trimmedTitle,
    start: startDate,
    end: endDate,
    description: input.description,
    location,
    allDay: Boolean(allDay),
    repeat,
    alarmMinutes,
  };

  // 重复和提醒要一路带到返回值和离线队列里，否则「每周三」离线建的那条补发后会变成单次
  const extras = {
    ...(repeat ? { repeat } : {}),
    ...(alarmMinutes ? { alarmMinutes } : {}),
  };

  let result;
  try {
    result = await client.createEvent(payload);
  } catch (error) {
    // 只有「网络类」错误才排队；密码错、权限错要立刻报出来
    if (!(error instanceof CalDavError) || !error.network) throw error;
    const entry = enqueueEvent({
      title: trimmedTitle,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      allDay: Boolean(allDay),
      location: location ?? undefined,
      calendar: calendarName,
      description: input.description,
      ...extras,
    });
    return {
      ok: true,
      queued: true,
      pending: readQueue().length,
      id: entry.id,
      title: trimmedTitle,
      calendar: calendarName ?? '',
      location: location ?? undefined,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      allDay: Boolean(allDay),
      tag: tag ?? undefined,
      ...extras,
      summary: `已暂存本地（${error.message}）：${trimmedTitle} ${formatRange(startDate, endDate)}${location ? ` @ ${location}` : ''}，联网后自动同步`,
    };
  }

  return {
    ok: true,
    queued: false,
    uid: result.uid,
    title: trimmedTitle,
    calendar: result.calendar,
    location: location ?? undefined,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    allDay: Boolean(allDay),
    tag: tag ?? undefined,
    ...extras,
    summary: `已添加到「${result.calendar}」：${trimmedTitle} ${formatRange(startDate, endDate)}${location ? ` @ ${location}` : ''}`,
  };
}

export async function listEvents({ days = 7, calendar, from, to, includeUid = false } = {}) {
  const { client } = getClient();
  const start = from ? toDate(from, 'from') : new Date();
  const end = to
    ? toDate(to, 'to')
    : new Date(start.getTime() + Math.max(1, Number(days) || 7) * 86400000);
  // 默认查**全部**日历。以前默认只查 config.calendar（「学习」），
  // 于是加到「生活」「课表-*」的日程在列表里根本不出现——看着像没写进去。
  // 需要只看某一个日历时用 --calendar。
  const events = await client.listEvents({ from: start, to: end, calendar: calendar ?? undefined });
  return {
    ok: true,
    range: { from: start.toISOString(), to: end.toISOString() },
    count: events.length,
    events: events.map((event) => ({
      ...event,
      when: formatRange(new Date(event.start), new Date(event.end)),
    })),
    summary: events.length === 0
      ? '这段时间没有日程。'
      : events.map((event) => `· ${formatRange(new Date(event.start), new Date(event.end))} ${event.title}${event.calendar ? `（${event.calendar}）` : ''}${includeUid ? ` uid=${event.uid}` : ''}`).join('\n'),
  };
}

export async function listCalendars() {
  const { client, config } = getClient();
  try {
    const calendars = await client.listCalendars();
    writeCalendarCache(calendars.map((calendar) => calendar.name));
    return {
      ok: true,
      offline: false,
      default: config.calendar || undefined,
      count: calendars.length,
      calendars: calendars.map((calendar) => ({ name: calendar.name, writable: calendar.writable })),
      summary: calendars.map((calendar) => `· ${calendar.name}${calendar.writable ? '' : '（只读）'}${calendar.name === config.calendar ? ' ← 默认' : ''}`).join('\n'),
    };
  } catch (error) {
    if (!(error instanceof CalDavError) || !error.network) throw error;
    const cache = readCalendarCache();
    if (cache.names.length === 0) {
      throw new Error('现在连不上网络，本机也还没有日历缓存。联网后先跑一次 `dsh-cal cals` 就会缓存下来。');
    }
    const when = cache.updatedAt ? new Date(cache.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '上次';
    return {
      ok: true,
      offline: true,
      cachedAt: cache.updatedAt,
      default: config.calendar || undefined,
      count: cache.names.length,
      calendars: cache.names.map((name) => ({ name, writable: true })),
      summary: `（离线，用 ${when} 的缓存）\n${cache.names.map((name) => `· ${name}${name === config.calendar ? ' ← 默认' : ''}`).join('\n')}`,
    };
  }
}

/** 把离线队列里的日程补发到服务器。 */
export async function syncQueue() {
  const items = readQueue();
  if (items.length === 0) {
    return { ok: true, synced: 0, remaining: 0, summary: '没有待同步的日程。' };
  }

  const { client, config } = getClient();
  const synced = [];
  const problems = [];
  let stop = false;

  for (const item of items) {
    if (stop) break;
    try {
      const result = await client.createEvent({
        calendar: item.calendar ?? config.calendar ?? undefined,
        title: item.title,
        start: new Date(item.start),
        end: new Date(item.end),
        allDay: Boolean(item.allDay),
        location: item.location,
        description: item.description,
        repeat: item.repeat,
        alarmMinutes: item.alarmMinutes,
      });
      dequeueEvent(item.id);
      synced.push({ title: item.title, calendar: result.calendar, uid: result.uid });
    } catch (error) {
      problems.push({ title: item.title, error: error.message, network: Boolean(error.network) });
      // 断网就整体停下，等下次；其它错误也只停这一轮，条目保留在队列里
      stop = true;
    }
  }

  const remaining = readQueue().length;
  const lines = [];
  if (synced.length > 0) lines.push(`✓ 已补发 ${synced.length} 条：${synced.map((item) => item.title).join('、')}`);
  if (problems.length > 0) lines.push(`✗ 还留在本地 ${remaining} 条（${problems[0].error}）`);
  if (lines.length === 0) lines.push('没有变化。');

  return {
    ok: problems.length === 0,
    synced: synced.length,
    remaining,
    events: synced,
    problems,
    summary: lines.join('\n'),
  };
}

export function pendingEvents() {
  const items = readQueue();
  return {
    ok: true,
    count: items.length,
    events: items.map((item) => ({ title: item.title, start: item.start, end: item.end, calendar: item.calendar })),
    summary: items.length === 0
      ? '本地没有待同步的日程。'
      : items.map((item) => `· ${formatRange(new Date(item.start), new Date(item.end))} ${item.title}（${item.calendar ?? '默认日历'}）`).join('\n'),
  };
}

/** Delete by uid, or by title substring within the next `days` days. */
export async function deleteEvent({ uid, title, calendar, days = 30 } = {}) {
  if (!uid && !title) throw new Error('需要 uid 或日程标题');
  const { client } = getClient();
  // 删除时**不**退回默认日历：事件可能在「生活」「课表-*」里，
  // 只去「学习」找会直接报「没找到 uid」，界面上的删除按钮等于失效。
  const target = calendar ?? undefined;

  if (!uid) {
    const start = new Date();
    const end = new Date(start.getTime() + Math.max(1, Number(days) || 30) * 86400000);
    const events = await client.listEvents({ from: start, to: end, calendar: target });
    const needle = String(title).trim();
    const hits = events.filter((event) => event.title.includes(needle));
    if (hits.length === 0) {
      return { ok: false, deleted: [], summary: `未来 ${days} 天里没找到标题包含「${needle}」的日程。` };
    }
    for (const event of hits) {
      await client.deleteEvent({ uid: event.uid, calendar: target });
    }
    return {
      ok: true,
      deleted: hits.map((event) => event.uid),
      summary: `已删除 ${hits.length} 个日程：\n${hits.map((event) => `· ${formatRange(new Date(event.start), new Date(event.end))} ${event.title}`).join('\n')}`,
    };
  }

  const result = await client.deleteEvent({ uid, calendar: target });
  return {
    ok: result.deleted,
    uid,
    summary: result.deleted ? `已删除日程 ${uid}` : `没找到 uid 为 ${uid} 的日程`,
  };
}

/**
 * 改一条已存在的日程，只传要改的字段。
 * 底层先读原 ics 再写回，所以重复规则和提醒不会因为改个时间就丢掉。
 */
export async function updateEvent({ uid, title, start, end, location, calendar } = {}) {
  if (!uid) throw new Error('需要 uid 才能修改日程');
  const { client } = getClient();
  // 同删除：按 uid 改的时候得在所有日历里找，不能只看默认日历。
  const target = calendar ?? undefined;

  const patch = {};
  if (typeof title === 'string' && title.trim() !== '') patch.title = title.trim();
  if (start !== undefined) patch.start = toDate(start, '开始时间');
  if (end !== undefined) patch.end = toDate(end, '结束时间');
  if (location !== undefined) patch.location = location ?? '';
  if (Object.keys(patch).length === 0) throw new Error('没有要修改的字段');

  const result = await client.updateEvent({ uid, calendar: target, ...patch });
  if (!result.updated) return { ok: false, uid, summary: `没找到 uid 为 ${uid} 的日程` };

  const parts = [];
  if (patch.title) parts.push(`标题「${patch.title}」`);
  if (patch.start) {
    const stop = patch.end ?? new Date(patch.start.getTime() + 3600000);
    parts.push(`时间 ${formatRange(patch.start, stop)}`);
  }
  if (patch.location !== undefined) parts.push(`地点「${patch.location || '已清空'}」`);
  return { ok: true, uid, calendar: result.calendar, summary: `已修改：${parts.join('，')}` };
}

/**
 * 从已有日程里挑出与 [start, end) 重叠的那些。
 * 纯函数，App 和 CLI 用同一套判定，免得两边对「冲突」的理解不一样。
 * 首尾相接不算冲突（09:00–10:00 和 10:00–11:00 可以并存）。
 */
export function findConflicts(events, start, end) {
  const from = start.getTime();
  const to = end.getTime();
  return (events ?? []).filter((event) => {
    const eventStart = new Date(event.start).getTime();
    const eventEnd = new Date(event.end).getTime();
    return eventStart < to && eventEnd > from;
  });
}

export async function createCalendar({ name } = {}) {
  if (!name) throw new Error('需要日历名称');
  const { client } = getClient();
  const created = await client.createCalendar(name);
  return { ok: true, name: created.name, summary: `已创建日历「${created.name}」` };
}

/** Probe the connection and report what is usable. */
export async function doctor() {
  const config = readConfig();
  const report = { config: { path: undefined, baseUrl: config.baseUrl, username: config.username, calendar: config.calendar }, checks: [] };
  if (!config.username) {
    report.checks.push({ name: '账号', ok: false, detail: '未配置，运行 node cli.mjs login' });
    return report;
  }
  const password = readPassword(config.username);
  report.checks.push({ name: '密码', ok: Boolean(password), detail: password ? '已保存在钥匙串' : '钥匙串中没有密码' });
  if (!password) return report;

  try {
    const client = new CalDav({ baseUrl: config.baseUrl, username: config.username, password });
    const calendars = await client.listCalendars();
    report.checks.push({ name: 'CalDAV 连接', ok: true, detail: `读到 ${calendars.length} 个日历` });
    report.checks.push({
      name: '日历列表',
      ok: calendars.length > 0,
      detail: calendars.map((calendar) => `${calendar.name}${calendar.writable ? '' : '(只读)'}`).join('、'),
    });
    if (config.calendar) {
      const target = calendars.find((calendar) => calendar.name === config.calendar);
      report.checks.push({
        name: '默认日历',
        ok: Boolean(target?.writable),
        detail: target ? `${target.name}${target.writable ? ' 可写' : ' 只读'}` : `「${config.calendar}」不在列表里`,
      });
    }
    return report;
  } catch (error) {
    report.checks.push({
      name: 'CalDAV 连接',
      ok: false,
      detail: error instanceof CalDavError ? `${error.message}${error.status ? ` (HTTP ${error.status})` : ''}` : error.message,
    });
    return report;
  }
}
