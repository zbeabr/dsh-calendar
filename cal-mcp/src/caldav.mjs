/**
 * Minimal CalDAV client: principal discovery, calendar listing, event CRUD.
 * No dependencies — plain fetch + regex XML scraping, tuned for iCloud.
 */

const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;

const PROPFIND_HOME = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>`;

const PROPFIND_CALENDARS = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:resourcetype/><d:displayname/>
    <c:supported-calendar-component-set/>
    <cs:calendar-color/>
    <d:current-user-privilege-set/>
  </d:prop>
</d:propfind>`;

/**
 * VALARM 的 TRIGGER 时长：整天用 -P1D，整小时用 -PThH，其余用 -PTnM。
 * 三种写法都合法，但 Apple 日历对 -P1D 的展示最直观（「1 天前」）。
 */
function triggerDuration(minutes) {
  const value = Math.round(minutes);
  if (value % 1440 === 0) return `-P${value / 1440}D`;
  if (value % 60 === 0) return `-PT${value / 60}H`;
  return `-PT${value}M`;
}

export class CalDavError extends Error {
  constructor(message, { status, url, network = false, code } = {}) {
    super(message);
    this.name = 'CalDavError';
    this.status = status;
    this.url = url;
    this.network = network;
    this.code = code;
  }
}

/** 把 fetch 的底层错误翻译成能看懂的中文，并标记为「网络类」错误（可离线排队）。 */
function networkMessage(code) {  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ENETUNREACH':
      return '连不上网络（DNS 解析失败），日程会先存在本地';
    case 'ECONNREFUSED':
    case 'ECONNRESET':
      return '网络连接被中断，日程会先存在本地';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
      return '网络超时，日程会先存在本地';
    default:
      return '网络不可用，日程会先存在本地';
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

/**
 * 这个跳转目标能不能收下 Basic 凭据。
 * iCloud 会把请求踢到 p33-caldav.icloud.com 这类同域分片主机，所以不能只比 host 全等；
 * 但也没有任何理由放宽到「任意 https」。http 一律拒绝（明文发密码）。
 * @param {string} baseUrl 用户配置的 CalDAV 根地址
 * @param {string} target 这一跳的目标地址
 */
export function isTrustedHop(baseUrl, target) {
  let base;
  let next;
  try {
    base = new URL(baseUrl);
    next = new URL(target);
  } catch {
    return false;
  }
  const isLocal = (host) => host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  // 本机调试（假的 CalDAV 服务器）允许 http，但不能从本机跳到公网
  if (isLocal(base.hostname) || isLocal(next.hostname)) return isLocal(base.hostname) && isLocal(next.hostname);
  if (next.protocol !== 'https:') return false;
  if (next.hostname === base.hostname) return true;
  const labels = base.hostname.split('.');
  // baseUrl 本身就是一级/二级域名（或 IP）时不放宽，只认全等
  if (labels.length <= 2 || /^\d+\.\d+\.\d+\.\d+$/u.test(base.hostname)) return false;
  return next.hostname.endsWith(`.${labels.slice(-2).join('.')}`);
}

/** 事件 uid：同一件事从头到尾用它，补发时才不会复制出一条新的。 */
export function newEventUid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}@dsh-cal`;
}

export class CalDav {
  /**
   * @param {{ baseUrl?: string, username: string, password: string, timeZone?: string, timeoutMs?: number }} options
   */
  constructor({ baseUrl = 'https://caldav.icloud.com/', username, password, timeZone = 'Asia/Shanghai', timeoutMs = 20000 }) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.username = username;
    this.password = password;
    this.timeZone = timeZone;
    this.timeoutMs = timeoutMs;
    this.auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    this.home = undefined;
  }

  async request(url, { method = 'PROPFIND', body, headers = {}, redirects = 3 } = {}) {
    let target = url;
    for (let hop = 0; hop <= redirects; hop += 1) {
      // 凭据只发给同域（含 iCloud 的 p33-caldav 这类分片主机）或本机调试地址。
      // 以前每一跳都无条件带 Authorization，一个开放重定向或恶意服务端
      // 就能把 App 专用密码骗到任意主机，而且 http 降级也照发不误。
      if (!isTrustedHop(this.baseUrl, target)) {
        throw new CalDavError(`重定向到不受信任的地址，已拒绝发送凭据：${hostOf(target)}`, { url: target });
      }
      let res;
      try {
        res = await fetch(target, {
          method,
          headers: {
            authorization: this.auth,
            ...(body === undefined ? {} : { 'content-type': 'application/xml; charset=utf-8' }),
            ...headers,
          },
          body,
          redirect: 'manual',
          // 没有超时的 fetch 会一直挂着，界面就永远停在「加载中」。
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          throw new CalDavError(`请求超时（${Math.round(this.timeoutMs / 1000)} 秒没有响应），日程会先存在本地`, {
            url: target,
            network: true,
            code: 'ETIMEDOUT',
          });
        }
        const code = error?.cause?.code ?? error?.cause?.cause?.code ?? error?.cause?.errors?.[0]?.code ?? error?.code;
        throw new CalDavError(networkMessage(code), { url: target, network: true, code });
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location) throw new CalDavError('redirect without Location', { status: res.status, url: target });
        target = new URL(location, target).href;
        continue;
      }
      if (res.status === 401) throw new CalDavError('认证失败：Apple ID 或 App 专用密码不正确', { status: 401, url: target });
      return { res, text: await res.text(), url: target };
    }
    throw new CalDavError('重定向次数过多', { url: target });
  }

  /** Resolve calendar-home-set, cached after the first call. */
  async discover() {
    if (this.home) return this.home;

    const principalRes = await this.request(this.baseUrl, {
      body: PROPFIND_PRINCIPAL,
      headers: { depth: '0' },
    });
    if (principalRes.res.status >= 400) {
      throw new CalDavError(`principal 查询失败 HTTP ${principalRes.res.status}`, {
        status: principalRes.res.status,
        url: principalRes.url,
      });
    }
    const principal = firstHref(principalRes.text, 'current-user-principal');
    if (!principal) throw new CalDavError('服务端未返回 current-user-principal', { url: principalRes.url });

    const homeRes = await this.request(new URL(principal, principalRes.url).href, {
      body: PROPFIND_HOME,
      headers: { depth: '0' },
    });
    const home = firstHref(homeRes.text, 'calendar-home-set');
    if (!home) throw new CalDavError('服务端未返回 calendar-home-set', { url: homeRes.url });

    this.home = { href: home, url: new URL(home, homeRes.url).href };
    return this.home;
  }

  /** All calendars under the home set, with display name and write access. */
  async listCalendars() {
    const home = await this.discover();
    const { res, text } = await this.request(home.url, {
      body: PROPFIND_CALENDARS,
      headers: { depth: '1' },
    });
    if (res.status >= 400) throw new CalDavError(`日历列表查询失败 HTTP ${res.status}`, { status: res.status, url: home.url });

    const calendars = [];
    for (const block of splitResponses(text)) {
      if (!/<(?:\w+:)?calendar\b/u.test(block)) continue;
      if (/VEVENT/u.test(block) === false && /supported-calendar-component-set/u.test(block)) continue;
      const href = firstHref(block, undefined, ['href']);
      if (!href) continue;
      const name = tagText(block, 'displayname') ?? '(未命名)';
      const writable = /<(?:d:)?write\b/u.test(block) || !/current-user-privilege-set/u.test(block);
      // 日历颜色（#RRGGBB 或 #RRGGBBAA），界面用来给每条日程配左侧色条
      const color = tagText(block, 'calendar-color');
      calendars.push({ href, name, url: new URL(href, home.url).href, writable, color: color ?? null });
    }
    return calendars;
  }

  /** Find a calendar by display name (exact, then case-insensitive, then substring). */
  async findCalendar(name, { create = false } = {}) {
    const calendars = await this.listCalendars();
    if (!name) return calendars[0];
    const exact = calendars.find((calendar) => calendar.name === name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    const loose = calendars.find((calendar) => calendar.name.toLowerCase() === lower)
      ?? calendars.find((calendar) => calendar.name.toLowerCase().includes(lower));
    if (loose) return loose;
    if (create) return this.createCalendar(name);
    throw new CalDavError(`找不到名为「${name}」的日历。现有：${calendars.map((c) => c.name).join('、')}`);
  }

  /** MKCALENDAR — create a new VEVENT calendar. */
  async createCalendar(name) {
    const home = await this.discover();
    const href = `${home.href.replace(/\/$/u, '')}/${encodeURIComponent(name)}/`;
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set><d:prop>
    <d:displayname>${escapeXml(name)}</d:displayname>
    <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
  </d:prop></d:set>
</c:mkcalendar>`;
    const { res } = await this.request(new URL(href, home.url).href, { method: 'MKCALENDAR', body });
    if (res.status >= 400 && res.status !== 405) {
      throw new CalDavError(`创建日历失败 HTTP ${res.status}`, { status: res.status });
    }
    return { href, name, url: new URL(href, home.url).href, writable: true };
  }

  /**
   * Create a VEVENT; returns its uid and href.
   * repeat 是 RRULE 片段（FREQ=WEEKLY;BYDAY=WE），alarmMinutes 是提前几分钟提醒——
   * 提醒写进 VALARM 由系统日历负责弹，App 自己不需要通知权限。
   */
  async createEvent({ calendar, title, start, end, description, location, allDay = false, repeat, alarmMinutes, uid: givenUid }) {
    const target = await this.findCalendar(calendar, { create: false });
    if (!target.writable) throw new CalDavError(`日历「${target.name}」是只读的`);

    // uid 可以由调用方给（离线队列补发时复用入队时那一枚）。
    // 以前每次 PUT 都现生成，于是「服务端写成功但响应超时」→ 重试 → 多出一条重复日程。
    const uid = givenUid || newEventUid();
    const stamp = toIcsStamp(new Date());
    const zone = this.timeZone || 'Asia/Shanghai';
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//dsh-cal//CalDAV//CN',
      'CALSCALE:GREGORIAN',
      ...(allDay ? [] : vtimezone(zone, start)),
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      ...(allDay
        ? [`DTSTART;VALUE=DATE:${toIcsDate(start, zone)}`, `DTEND;VALUE=DATE:${toIcsDate(end ?? addDays(start, 1), zone)}`]
        : [`DTSTART;TZID=${zone}:${toIcsZoned(start, zone)}`, `DTEND;TZID=${zone}:${toIcsZoned(end, zone)}`]),
      `SUMMARY:${escapeIcs(title)}`,
      ...(description ? [`DESCRIPTION:${escapeIcs(description)}`] : []),
      ...(location ? [`LOCATION:${escapeIcs(location)}`] : []),
      ...(repeat ? [`RRULE:${repeat}`] : []),
      ...(alarmMinutes ? [
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${escapeIcs(title)}`,
        `TRIGGER:${triggerDuration(alarmMinutes)}`,
        'END:VALARM',
      ] : []),
      'END:VEVENT',
      'END:VCALENDAR',
    ];

    const href = `${target.href.replace(/\/$/u, '')}/${uid}.ics`;
    const { res } = await this.request(new URL(href, target.url).href, {
      method: 'PUT',
      body: `${lines.join('\r\n')}\r\n`,
      headers: { 'content-type': 'text/calendar; charset=utf-8', 'if-none-match': '*' },
    });
    if (res.status === 412) {
      // 带着 if-none-match: * 却撞上 412，说明这个 uid 已经写进去了
      // （上一次 PUT 成功但响应丢了）。视为已存在，不要当失败重试。
      return { uid, href, calendar: target.name, exists: true };
    }
    if (res.status >= 400) throw new CalDavError(`写入事件失败 HTTP ${res.status}`, { status: res.status });
    return { uid, href, calendar: target.name };
  }

  /** Events in [from, to), across the given calendar or all writable ones. */
  async listEvents({ from, to, calendar }) {
    const zone = this.timeZone || 'Asia/Shanghai';
    const targets = calendar ? [await this.findCalendar(calendar)] : await this.listCalendars();
    const range = `<c:time-range start="${toIcsStamp(from)}" end="${toIcsStamp(to)}"/>`;
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">${range}</c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;

    // 查全部日历时每个日历发一次 REPORT。串行做 17 个日历要 9 秒多，
    // 日程列表刷新根本等不起，所以开 6 个并发一起去问。
    const events = [];
    const queue = [...targets];
    const worker = async () => {
      while (queue.length > 0) {
        const target = queue.shift();
        const { res, text } = await this.request(target.url, { method: 'REPORT', body, headers: { depth: '1' } });
        if (res.status >= 400) continue;
        for (const block of splitResponses(text)) {
          const data = /<(?:\w+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:\w+:)?calendar-data>/u.exec(block)?.[1];
          if (!data) continue;
          const unescaped = unescapeXml(data);
          for (const event of parseVevents(unescaped, zone)) events.push({ ...event, calendar: target.name });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));

    // 重复日程在服务端只会以「系列起点」回来，折到区间里才有正确的日期。
    const resolved = events
      .map((event) => (event.rrule && !event.recurrenceId ? nextOccurrence(event, from, to) : event))
      .filter(Boolean);
    return resolved.sort((a, b) => a.start.localeCompare(b.start));
  }

  /** Delete one event by uid; searches the given calendar or all of them. */
  async deleteEvent({ uid, calendar }) {
    const targets = calendar ? [await this.findCalendar(calendar)] : await this.listCalendars();
    for (const target of targets) {
      const href = `${target.href.replace(/\/$/u, '')}/${uid}.ics`;
      const { res } = await this.request(new URL(href, target.url).href, { method: 'DELETE' });
      // 404 说明这条不在这个日历里，继续问下一个。以前这里直接 return deleted:false，
      // 于是不在默认日历里的事件永远删不掉（第一条 404 就把整个循环掐断了）。
      if (res.status < 400) return { deleted: true, uid, calendar: target.name };
      if (res.status === 404) continue;
      return { deleted: false, uid, calendar: target.name, status: res.status };
    }
    return { deleted: false, uid };
  }

  /**
   * 原地改写一条日程：只替换传进来的字段，其余（RRULE、VALARM、DESCRIPTION）原样保留。
   * 先 GET 拿原 ics 再 PUT 回去，所以重复日程和提醒不会被改坏。
   */
  async updateEvent({ uid, calendar, title, start, end, location, allDay }) {
    const targets = calendar ? [await this.findCalendar(calendar)] : await this.listCalendars();
    const zone = this.timeZone || 'Asia/Shanghai';

    for (const target of targets) {
      const href = new URL(`${target.href.replace(/\/$/u, '')}/${uid}.ics`, target.url).href;
      const { res, text } = await this.request(href, { method: 'GET' });
      if (res.status >= 400) continue;

      let body = text.replace(/\r\n[ \t]/gu, ''); // 展开折行
      const etag = res.headers.get('etag');

      const rewrite = (key, value) => {
        const pattern = new RegExp(`^${key}([^:\\r\\n]*):.*$`, 'imu');
        if (!pattern.test(body)) return;
        body = body.replace(pattern, (_line, params) => `${key}${params}:${value}`);
      };
      const paramsOf = (key) => new RegExp(`^${key}([^:\\r\\n]*):`, 'imu').exec(body)?.[1] ?? `;TZID=${zone}`;
      const stampFor = (params, date) => (/VALUE=DATE/iu.test(params) ? toIcsDate(date, zone) : toIcsZoned(date, zone));

      if (title) rewrite('SUMMARY', escapeIcs(title));
      if (start) rewrite('DTSTART', stampFor(paramsOf('DTSTART'), start));
      if (end) rewrite('DTEND', stampFor(paramsOf('DTEND'), end));
      if (location !== undefined) {
        if (/^LOCATION[^:]*:/imu.test(body)) {
          rewrite('LOCATION', escapeIcs(location));
        } else {
          body = body.replace(/^(SUMMARY[^\r\n]*)\r?\n/imu, (line) => `${line}\r\nLOCATION:${escapeIcs(location)}`);
        }
      }

      const { res: putRes } = await this.request(href, {
        method: 'PUT',
        body: `${body.replace(/\r?\n/gu, '\r\n').replace(/\r\n+$/u, '')}\r\n`,
        headers: {
          'content-type': 'text/calendar; charset=utf-8',
          ...(etag ? { 'if-match': etag } : {}),
        },
      });
      if (putRes.status < 400) return { updated: true, uid, calendar: target.name };
      throw new CalDavError(`改写日程失败 HTTP ${putRes.status}`, { status: putRes.status, url: href });
    }
    return { updated: false, uid };
  }
}

/* ---------------------------------------------------------------- helpers */

function splitResponses(xml) {
  return xml.split(/<(?:\w+:)?response\b/u).slice(1);
}

function firstHref(block, tag, anyTag = []) {
  if (tag) {
    const scoped = new RegExp(`<(?:\\w+:)?${tag}\\b[\\s\\S]*?<(?:(?:\\w+):)?href[^>]*>([^<]+)</`, 'iu').exec(block);
    if (scoped) return scoped[1].trim();
  }
  for (const candidate of anyTag) {
    const match = new RegExp(`<(?:(?:\\w+):)?${candidate}[^>]*>([^<]+)</`, 'iu').exec(block);
    if (match) return match[1].trim();
  }
  return undefined;
}

function tagText(block, tag) {
  const match = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'iu').exec(block);
  return match ? unescapeXml(match[1]).trim() : undefined;
}

function unescapeXml(text) {
  return text
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

function escapeXml(text) {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function escapeIcs(text) {
  return text.replace(/\\/gu, '\\\\').replace(/;/gu, '\\;').replace(/,/gu, '\\,').replace(/\n/gu, '\\n');
}

function unescapeIcs(text) {
  return text.replace(/\\n/gu, '\n').replace(/\\,/gu, ',').replace(/\\;/gu, ';').replace(/\\\\/gu, '\\');
}

export function toIcsStamp(date) {
  return `${date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}/u, '')}`;
}

/**
 * 全天日程的日期戳（YYYYMMDD）。
 *
 * 必须按**事件所在时区**取年月日。start 是本地零点（2026-11-06T00:00+08:00），
 * 换算成 UTC 就成了前一天 16:00，直接切 ISO 字符串会把「明天」的全天日程写成今天。
 */
function toIcsDate(date, timeZone) {
  if (!timeZone) return date.toISOString().slice(0, 10).replace(/-/gu, '');
  const parts = tzParts(date, timeZone);
  const pad = (value) => String(value).padStart(2, '0');
  return `${parts.year}${pad(parts.month)}${pad(parts.day)}`;
}

/** Wall-clock parts of an instant in a given IANA time zone. */
function tzParts(date, timeZone) {
  const parts = {};
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  for (const { type, value } of formatter.formatToParts(date)) parts[type] = value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function tzOffsetMs(date, timeZone) {
  const p = tzParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function formatOffset(ms) {
  const sign = ms < 0 ? '-' : '+';
  const total = Math.round(Math.abs(ms) / 60000);
  return `${sign}${String(Math.floor(total / 60)).padStart(2, '0')}${String(total % 60).padStart(2, '0')}`;
}

/**
 * Wall-clock stamp in `timeZone`, e.g. 20261104T183000.
 * iCloud/Calendar renders an event in its own zone, so writing bare UTC makes
 * them show as "(10:30 GMT)" — always write the local zone instead.
 */
export function toIcsZoned(date, timeZone) {
  const p = tzParts(date, timeZone);
  const pad = (value) => String(value).padStart(2, '0');
  return `${p.year}${pad(p.month)}${pad(p.day)}T${pad(p.hour)}${pad(p.minute)}${pad(p.second)}`;
}

/** Turn a wall time in `timeZone` back into a real instant. */
export function zonedToUtc(year, month, day, hour, minute, second = 0, timeZone) {
  const base = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = base;
  for (let i = 0; i < 3; i += 1) {
    const next = base - tzOffsetMs(new Date(guess), timeZone);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/** Minimal VTIMEZONE: one fixed-offset component matching the event date. */
function vtimezone(timeZone, date) {
  const offset = formatOffset(tzOffsetMs(date, timeZone));
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(date).find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${timeZone}`,
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    `TZOFFSETFROM:${offset}`,
    `TZOFFSETTO:${offset}`,
    `TZNAME:${name}`,
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

/**
 * 解析 ICS 里的时间值。
 *
 * 全天日程的 `DTSTART;VALUE=DATE:20261106` 只有日期，没有 TZID，
 * 直接 `new Date('2026-11-06T00:00:00')` 取的是**进程所在时区**——
 * 换个时区的机器跑就会整体偏一天。所以把日历的时区当兜底传进来。
 */
function parseIcsDate(value, timeZone) {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/u.exec(value.trim());
  if (!match) return undefined;
  const [, y, mo, d, h = '00', mi = '00', s = '00', utc] = match;
  if (!utc && timeZone) return zonedToUtc(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s), timeZone);
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${utc ? 'Z' : ''}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** RRULE 拆成键值对：「FREQ=WEEKLY;COUNT=16;BYDAY=MO」→ { FREQ: 'WEEKLY', … }。 */
function parseRrule(text) {
  const out = {};
  for (const part of String(text).split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    out[part.slice(0, at).toUpperCase()] = part.slice(at + 1);
  }
  return out;
}

const WEEKDAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** 某天所在那一周的周一零点。算「隔几周」必须用同一把尺子。 */
function mondayOf(date) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day;
}

/**
 * 把一条重复日程折到 [from, to) 里的**下一次**发生。
 *
 * 服务端按 time-range 命中「整条重复事件」后返回的 DTSTART 是系列起点——
 * 课表里的课从 9 月开学那天算起，直接显示就成了「09/21 周一 高等数学」
 * 挂在今天的日程里，看着像时间错乱。
 *
 * 只取一次、不把区间内所有发生都铺开：列表里每一行都按 uid 删除 / 改时间，
 * 同一条重复事件铺成好几行时，点任意一行都会把整个系列删掉。
 *
 * 返回 undefined 表示这个系列在区间内已经没有发生（上完了 / 已过期）。
 */
function nextOccurrence(event, from, to) {
  const rrule = parseRrule(event.rrule);
  const freq = String(rrule.FREQ ?? '').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return event;

  const interval = Math.max(1, Number(rrule.INTERVAL ?? 1) || 1);
  const byday = rrule.BYDAY
    ? rrule.BYDAY.split(',').map((day) => WEEKDAY_INDEX[day.trim().toUpperCase()]).filter((day) => day !== undefined)
    : [];
  const bymonthday = rrule.BYMONTHDAY ? Number(String(rrule.BYMONTHDAY).split(',')[0]) : undefined;
  const count = rrule.COUNT ? Number(rrule.COUNT) : undefined;
  const until = rrule.UNTIL ? parseIcsDate(rrule.UNTIL, undefined) : undefined;

  const seriesStart = new Date(event.start);
  const duration = new Date(event.end).getTime() - seriesStart.getTime();
  const skip = new Set((event.exdate ?? []).map((iso) => new Date(iso).getTime()));

  const firstDay = new Date(seriesStart);
  firstDay.setHours(0, 0, 0, 0);
  // 有 COUNT 时必须从系列起点数起来；没有的话直接从区间前一周开始扫，别白扫几个月。
  const cursor = count === undefined
    ? new Date(Math.max(firstDay.getTime(), from.getTime() - 7 * 86400000))
    : new Date(firstDay);
  cursor.setHours(0, 0, 0, 0);
  const baseMonday = mondayOf(seriesStart).getTime();
  const limit = to.getTime() + 86400000;
  let seen = 0;

  for (let guard = 0; guard < 4000 && cursor.getTime() <= limit; guard += 1) {
    const dayGap = Math.round((cursor.getTime() - firstDay.getTime()) / 86400000);
    let hit = false;
    if (freq === 'DAILY') {
      hit = dayGap % interval === 0;
    } else if (freq === 'WEEKLY') {
      const weeks = Math.round((mondayOf(cursor).getTime() - baseMonday) / (7 * 86400000));
      const wanted = byday.length > 0 ? byday : [seriesStart.getDay()];
      hit = weeks % interval === 0 && wanted.includes(cursor.getDay());
    } else if (freq === 'MONTHLY') {
      const months = (cursor.getFullYear() - seriesStart.getFullYear()) * 12 + (cursor.getMonth() - seriesStart.getMonth());
      hit = months % interval === 0 && cursor.getDate() === (bymonthday ?? seriesStart.getDate());
    } else {
      const years = cursor.getFullYear() - seriesStart.getFullYear();
      hit = years % interval === 0 && cursor.getMonth() === seriesStart.getMonth() && cursor.getDate() === seriesStart.getDate();
    }

    if (hit) {
      const occurrence = new Date(cursor);
      occurrence.setHours(seriesStart.getHours(), seriesStart.getMinutes(), seriesStart.getSeconds(), 0);
      if (occurrence.getTime() >= seriesStart.getTime()) {
        if (until && occurrence.getTime() > until.getTime()) return undefined;
        seen += 1;
        if (count !== undefined && seen > count) return undefined;
        if (!skip.has(occurrence.getTime())) {
          if (occurrence.getTime() >= from.getTime()) {
            if (occurrence.getTime() >= to.getTime()) return undefined;
            return {
              ...event,
              start: occurrence.toISOString(),
              end: new Date(occurrence.getTime() + duration).toISOString(),
              recurring: true,
            };
          }
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return undefined;
}

/** Parse unfolded VEVENT blocks from one calendar-data payload. */
export function parseVevents(ics, timeZone) {
  const unfolded = ics.replace(/\r\n[ \t]/gu, '');
  const events = [];
  for (const chunk of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const body = chunk.split('END:VEVENT')[0] ?? '';
    const field = (key) => {
      const match = new RegExp(`^${key}([^:\\r\\n]*):(.*)$`, 'imu').exec(body);
      if (!match) return undefined;
      const tzid = /TZID=([^;:]+)/iu.exec(match[1])?.[1];
      return { value: match[2].trim(), tzid };
    };
    const startField = field('DTSTART');
    const endField = field('DTEND');
    const start = startField ? parseIcsDate(startField.value, startField.tzid ?? timeZone) : undefined;
    if (!start) continue;
    const end = endField
      ? parseIcsDate(endField.value, endField.tzid ?? timeZone)
      : new Date(start.getTime() + 3600000);
    const text = (key) => {
      const found = field(key);
      return found ? unescapeIcs(found.value) : undefined;
    };
    const exdateField = field('EXDATE');
    const exdates = exdateField
      ? exdateField.value.split(',').map((raw) => parseIcsDate(raw, exdateField.tzid ?? timeZone)).filter(Boolean).map((date) => date.toISOString())
      : [];
    events.push({
      uid: (field('UID')?.value ?? '').replace(/\.ics$/u, ''),
      title: text('SUMMARY') ?? '(无标题)',
      start: start.toISOString(),
      end: (end ?? start).toISOString(),
      location: text('LOCATION'),
      description: text('DESCRIPTION'),
      rrule: text('RRULE'),
      exdate: exdates,
      recurrenceId: text('RECURRENCE-ID'),
    });
  }
  return events;
}
