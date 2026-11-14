#!/usr/bin/env node
/**
 * dsh-cal CLI — 用自然语言增删查日历，走 CalDAV（默认 iCloud）。
 *
 *   node cli.mjs login                    配置一次账号（密码进钥匙串）
 *   node cli.mjs login --user a@b.com --calendar 学习   非交互配置，密码从 DSH_CAL_PASSWORD 读
 *   node cli.mjs cals [--json]            列出所有日历
 *   node cli.mjs add "明天下午三点到四点开会" [--calendar 学习] [--location 地点] [--json]
 *   node cli.mjs add "明天 交作业 #全天"      # 全天日程：不设时间（见 src/nlp.mjs 的 ALL_DAY_TAG）
 *   node cli.mjs ls [--days 7] [--json]
 *   node cli.mjs rm <uid> | --title 关键字
 *   node cli.mjs doctor [--json]
 *   node cli.mjs parse "周一上午十点评审"  只解析不写入
 *
 * 所有命令加 --json 都会输出一行机器可读的 JSON（成功 {ok:true,...}，失败 {ok:false,error}）。
 */

import { createInterface } from 'node:readline';
import { AUTO_CANDIDATES, exactCalendarMatch, pickDefaultCalendar, resolveCalendar } from './src/calendar-policy.mjs';
import { appPasswordFormat, isIcloudHost, normalizeAccount } from './src/credentials.mjs';
import { inferCalendarTag, llmConfig, llmLastError, needsRefine, probeModel, refineWithModel } from './src/llm.mjs';
import { apply as applyHolidayPhrase } from './src/holidays.mjs';
import { parseEvent } from './src/nlp.mjs';
import { extractKnownPlace, knownPlaces } from './src/places.mjs';
import { cachedCalendarNames, configPath, KEYCHAIN_SERVICE, readConfig, redact, savePassword, writeConfig } from './src/store.mjs';
import {
  addEvent, createCalendar, deleteEvent, doctor, formatRange, listCalendars, listEvents,
  pendingEvents, syncQueue, updateEvent, verifyCredentials,
} from './src/tools.mjs';

let jsonMode = false;

function out(payload) {
  console.log(JSON.stringify(payload));
}

function fail(message) {
  // 兜底：任何错误文本在打到终端 / --json 之前先抹掉像密码的片段
  const text = redact(message);
  if (jsonMode) out({ ok: false, error: text });
  else console.error(`✗ ${text}`);
  process.exitCode = 1;
}

function argv() {
  const args = process.argv.slice(2);
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      rest.push(args[i]);
    }
  }
  return { command: rest[0], rest: rest.slice(1), flags };
}

function ask(prompt, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = function writeToOutput(chunk) {
        if (chunk.includes(prompt)) rl.output.write(chunk);
        else rl.output.write('*');
      };
    }
    rl.question(prompt, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

/**
 * 密码格式的问题说明；没问题返回 undefined。
 * 只对 iCloud 生效 —— 自定义 CalDAV 服务端没有「16 位」这条规矩。
 */
function appPasswordProblem(password, baseUrl) {
  let host = '';
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    /* 地址本身有问题时交给连接阶段报错 */
  }
  if (!isIcloudHost(host)) return undefined;
  const format = appPasswordFormat(password);
  if (format.ok) return undefined;
  if (format.reason === 'charset') {
    return 'App 专用密码只由字母和数字组成（可以带连字符），这串里有别的字符。';
  }
  if (format.reason === 'length') {
    return `这看起来不是 App 专用密码：它是 16 位（形如 xxxx-xxxx-xxxx-xxxx），你给的是 ${format.length} 位。`
      + '别用 Apple ID 登录密码或设备密码 —— 去 account.apple.com →「登录与安全」→「App 专用密码」生成一个。';
  }
  return undefined;
}

/** 连上之后把日历列出来，登录成功/失败都复用这一个格式。 */
function calendarLines(calendars) {
  return calendars.map((calendar) => `· ${calendar.name}${calendar.writable ? '' : '（只读）'}`).join('\n');
}

/** Config with --user + DSH_CAL_PASSWORD: no prompts, usable from a GUI. */
async function loginHeadless(flags) {
  const account = normalizeAccount(flags.user);
  if (!account) return fail('需要 Apple ID');
  const password = (process.env.DSH_CAL_PASSWORD || (await ask('App 专用密码（输入时不显示）: ', { hidden: true }))).trim();
  if (!password) return fail('需要 App 专用密码');

  const current = readConfig();
  const problem = appPasswordProblem(password, current.baseUrl);
  if (problem) return fail(problem);

  // 顺序很重要：先验证，验证通过才写钥匙串。
  // 以前是先 savePassword 再 listCalendars —— 密码打错时，错的那个已经
  // 覆盖掉原来的正确密码，用户从「能用」直接掉到「401」，旧密码还找不回来。
  let verified;
  try {
    verified = await verifyCredentials({ username: account, password, baseUrl: current.baseUrl });
  } catch (error) {
    return fail(`${error.message}\n（这次没有写入钥匙串，原来的密码仍然有效。）`);
  }

  const writable = verified.calendars.filter((calendar) => calendar.writable).map((calendar) => calendar.name);
  const pick = pickDefaultCalendar({ requested: flags.calendar, current: current.calendar, writable });
  if (pick.error) {
    return fail(`${pick.error}。可选：${writable.join('、') || '（这个账号没有可写日历）'}`
      + '\n（这次没有写入钥匙串，原来的密码仍然有效。）');
  }

  savePassword(account, password);
  writeConfig({ ...readConfig(), username: account, baseUrl: verified.baseUrl, calendar: pick.calendar ?? '' });

  if (jsonMode) {
    return out({
      ok: true,
      username: account,
      baseUrl: verified.baseUrl,
      switchedRegion: verified.switched,
      calendar: pick.calendar ?? '',
      // App 靠这个字段把「连上了但还没默认日历」和「连上且已选好」分开处理，
      // 而不是自己拿列表第一个顶上。
      needsCalendar: pick.calendar ? undefined : writable,
      calendars: verified.calendars.map((calendar) => calendar.name),
    });
  }
  console.log(`✓ 已连接 ${account}${verified.switched ? '（账号在中国区，已改用 caldav.icloud.com.cn）' : ''}`);
  console.log(calendarLines(verified.calendars));
  if (pick.calendar) {
    console.log(`✓ 默认日历「${pick.calendar}」`);
  } else {
    console.log('! 还没有默认日历：你的列表里没有「学习」。用 `dsh-cal config --calendar 名字` 指定一个；');
    console.log('  在指定之前，新增日程会直接报错，不会替你随便挑一个日历写进去。');
  }
  return undefined;
}

async function cmdLogin(flags) {
  if (flags.user) return loginHeadless(flags);

  console.log('配置 CalDAV（iCloud）。密码用「App 专用密码」，不是 Apple ID 登录密码。');
  console.log('生成地址：https://account.apple.com → 登录与安全 → App 专用密码\n');

  const current = readConfig();
  const typed = (await ask(`Apple ID 邮箱${current.username ? ` [${current.username}]` : ''}: `)) || current.username;
  const account = normalizeAccount(typed);
  if (!account) return fail('需要 Apple ID');

  const password = (await ask('App 专用密码（输入时不显示）: ', { hidden: true })).trim();
  if (!password) return fail('需要 App 专用密码');
  const problem = appPasswordProblem(password, current.baseUrl);
  if (problem) return fail(problem);

  console.log('正在连接 CalDAV…');
  let verified;
  try {
    verified = await verifyCredentials({ username: account, password, baseUrl: current.baseUrl });
  } catch (error) {
    return fail(`${error.message}\n密码没有保存 —— 钥匙串里原来那个仍然有效。`);
  }

  savePassword(account, password);
  writeConfig({ ...readConfig(), username: account, baseUrl: verified.baseUrl });
  console.log(`✓ 密码已存入钥匙串（service=${KEYCHAIN_SERVICE}, account=${account}）`);
  if (verified.switched) console.log('  账号在中国区，已自动改用 https://caldav.icloud.com.cn/ 并记进配置');
  console.log(`  配置文件：${configPath()}\n`);
  console.log(calendarLines(verified.calendars));

  const names = verified.calendars.filter((calendar) => calendar.writable).map((calendar) => calendar.name);
  if (names.length > 0) {
    const suggestion = pickDefaultCalendar({ current: current.calendar, writable: names }).calendar;
    const prompt = suggestion ? `[${suggestion}]` : `[可选：${names.join('、')}]`;
    const answer = (await ask(`\n默认写入哪个日历？${prompt}: `)).trim();
    const picked = answer || suggestion;
    if (!picked) {
      console.log('! 没有选默认日历。用 `dsh-cal config --calendar 名字` 指定；在那之前新增日程会直接报错。');
    } else if (!names.includes(picked)) {
      console.log(`! 「${picked}」不在可写日历里（可选：${names.join('、')}），本次没有保存。`);
    } else {
      writeConfig({ ...readConfig(), calendar: picked });
      console.log(`✓ 默认日历已设为「${picked}」`);
    }
    if (!names.includes('学习')) {
      console.log('\n注意：列表里没有「学习」。如果它是「我的 Mac 上」的本地日历，它不在 iCloud 里，');
      console.log('      本工具读不到。解法：在日历 App 里把它拖到 iCloud 分组下，或新建一个 iCloud 的「学习」。');
    }
  }
  console.log('\n完成。之后运行 node cli.mjs add "明天下午三点开会" 即可。');
  return undefined;
}

function printDoctor(report) {
  if (jsonMode) return out({ ok: report.checks.every((check) => check.ok), ...report });
  for (const check of report.checks) {
    console.log(`  ${check.ok ? '✓' : '✗'} ${check.name}：${check.detail}`);
  }
  for (const warning of report.warnings ?? []) console.log(`  ⚠ ${warning}`);
  return undefined;
}

async function cmdAdd(text, flags) {
  if (!text) return fail('用法：node cli.mjs add "明天下午三点到四点开会" [--location 地点] [--calendar 学习]');
  const result = await addEvent({
    text,
    calendar: typeof flags.calendar === 'string' ? flags.calendar : undefined,
    location: typeof flags.location === 'string' ? flags.location : undefined,
    // --fast：不调模型（模型还没加载好时用它，避免写入卡住）
    noModel: Boolean(flags.fast),
  });
  if (jsonMode) return out(result);
  console.log(`${result.queued ? '◷' : '✓'} ${result.summary}`);
  if (!result.queued && result.uid) console.log(`  uid: ${result.uid}`);
  return undefined;
}

function nameList(flags) {
  if (typeof flags.cals !== 'string' || flags.cals.trim() === '') return cachedCalendarNames();
  return flags.cals.split(',').map((name) => name.trim()).filter(Boolean);
}

/**
 * 只判断标签归属，不算时间、不写日历。
 * App 在输入停顿 2 秒后调一次，结果再用 App 侧的白名单复核一遍。
 */
async function cmdTag(text, flags) {
  if (!text) return fail('用法：node cli.mjs tag "明天晚上写作业" [--cals 学习,生活]');
  const known = nameList(flags);
  const candidates = AUTO_CANDIDATES.filter((name) => exactCalendarMatch(name, known));
  const result = candidates.length
    ? await inferCalendarTag(text, { known, candidates, force: Boolean(flags.llm) })
    : undefined;
  const payload = {
    ok: true,
    text,
    tag: result?.tag ?? null,
    source: result ? 'model' : 'unavailable',
    candidates,
    model: result?.model ?? null,
    note: result ? null : (llmLastError.message ?? '模型未就绪或标签库里没有候选，回落默认日历'),
  };
  if (jsonMode) return out(payload);
  console.log(result ? `标签：${result.tag}（本地模型）` : `标签：未指定（${payload.note}）`);
  return undefined;
}

/**
 * 解析但不写入。
 *
 * 默认行为：规则解析 → 如果漏了地点且模型开着，再让模型补（`--fast` 跳过模型，`--llm` 强制用模型）。
 */
async function cmdParse(text, flags) {
  if (!text) return fail('用法：node cli.mjs parse "明天下午三点到四点 组会 #工作" [--fast|--llm]');
  // 和 addEvent 用同一套节日替换：App 的预览就是走这条命令，两边不能不一致。
  text = applyHolidayPhrase(text, new Date());
  const calendarNames = nameList(flags);
  const parsed = parseEvent(text, new Date(), { calendarNames });
  // 与 addEvent 用同一套常用地点词典，预览和写入才不会一个显示地点、一个不显示。
  if (!parsed.location) {
    const hit = extractKnownPlace(parsed.title, knownPlaces());
    if (hit) { parsed.title = hit.title; parsed.location = hit.location; }
  }

  let refined;
  const useModel = Boolean(flags.llm) || (!flags.fast && llmConfig().enabled);
  // 只由 needsRefine 决定：脏标题、量词残渣、残留时间词、有介词却没认出地点。
  // 以前还加了「!parsed.location」，结果几乎每句话都白调一次模型——
  // 没写地点不等于需要模型，规则本来就能给出完整的日程。
  const modelNeeded = needsRefine(text, parsed);
  const modelAsked = useModel && (modelNeeded || Boolean(flags.llm));
  if (modelAsked) {
    // 只报本次调用的结果，别把上一次残留的错误原因带出来。
    llmLastError.message = undefined;
    refined = await refineWithModel(
      text,
      { title: parsed.title, location: parsed.location, local: formatRange(parsed.start, parsed.end) },
      { calendarNames, force: Boolean(flags.llm) },
    );
  }

  // parseEvent 忠实反映「用户原文里写了什么」，但给界面/写入用的 calendar
  // 必须过闭集投影：库外标签（#临时）不能被当成已选中的日历显示出去。
  // hasExplicitTag 保留纯解析事实，App 据此判断「用户写过标签，模型别顶替」。
  // --tag 是 App 在「输入停顿 2 秒」后补发的一次解析：同一进程里顺带问一次
  // 本地模型做标签归属，模型输出仍要过 resolveCalendar 的白名单。
  let suggested;
  if (flags.tag && !parsed.calendar) {
    const candidates = AUTO_CANDIDATES.filter((name) => exactCalendarMatch(name, calendarNames));
    suggested = candidates.length
      ? (await inferCalendarTag(text, { known: calendarNames, candidates }))?.tag
      : undefined;
  }
  const decision = resolveCalendar({
    explicit: parsed.calendar,
    suggested,
    known: calendarNames,
    fallback: undefined,
  });

  const payload = {
    ok: true,
    title: refined?.title ?? parsed.title,
    start: parsed.start.toISOString(),
    end: parsed.end.toISOString(),
    allDay: parsed.allDay,
    location: refined?.location ?? parsed.location ?? null,
    calendar: decision.calendar ?? null,
    hasExplicitTag: Boolean(parsed.calendar),
    calendarSource: decision.source,
    local: formatRange(parsed.start, parsed.end),
    defaultDuration: parsed.durationAssumed,
    rolled: Boolean(parsed.rolled),
    byModel: refined ? `${refined.provider}:${refined.model}` : null,
    // 界面据此给原文上色：每段识别结果在句子里的位置和类别
    spans: parsed.spans,
    repeat: parsed.repeat,
    alarmMinutes: parsed.alarmMinutes,
    // 规则结果可疑（脏标题 / 量词残渣 / 残留时间词 / 有介词却没地点）→ App 据此决定要不要再问一次模型
    needsModel: modelNeeded,
    // 问过模型却没采纳时，把原因说出来（护栏拦下、超时、没连上…），不再静默失败。
    modelNote: modelAsked && !refined ? (llmLastError.message ?? '模型没兜住，已回落规则结果') : null,
  };
  if (jsonMode) return out(payload);
  const { ok, ...rest } = payload;
  void ok;
  console.log(JSON.stringify(rest, null, 2));
  return undefined;
}

/** 只改本地偏好（账号 / 默认日历），不动钥匙串里的密码。App 的「设置…」面板用。 */
function cmdConfig(flags) {
  const patch = {};
  if (typeof flags.user === 'string' && flags.user.trim() !== '') patch.username = flags.user.trim();
  if (typeof flags.calendar === 'string' && flags.calendar.trim() !== '') patch.calendar = flags.calendar.trim();
  if (Object.keys(patch).length === 0) return fail('用法：config [--user 邮箱] [--calendar 默认日历]');

  const next = { ...readConfig(), ...patch };
  writeConfig(next);
  if (jsonMode) return out({ ok: true, username: next.username, calendar: next.calendar });
  console.log(`✓ 已保存：账号 ${next.username}，默认日历「${next.calendar}」`);
  return undefined;
}

/** 「这周还有什么」「下周有几节课」——把问题翻译成一次范围查询。 */
function resolveQueryRange(text, now) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const offset = (days) => new Date(today.getTime() + days * 86400000);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));

  if (/下周/u.test(text)) {
    return { from: new Date(monday.getTime() + 7 * 86400000), to: new Date(monday.getTime() + 14 * 86400000), label: '下周' };
  }
  if (/周末/u.test(text)) {
    let saturday = new Date(monday.getTime() + 5 * 86400000);
    if (saturday.getTime() < today.getTime()) saturday = new Date(saturday.getTime() + 7 * 86400000);
    return { from: saturday, to: new Date(saturday.getTime() + 2 * 86400000), label: '周末' };
  }
  if (/这周|本周/u.test(text)) return { from: today, to: new Date(monday.getTime() + 7 * 86400000), label: '这周' };
  if (/下个?月/u.test(text)) {
    return { from: new Date(now.getFullYear(), now.getMonth() + 1, 1), to: new Date(now.getFullYear(), now.getMonth() + 2, 1), label: '下个月' };
  }
  if (/这个?月|本月/u.test(text)) {
    return { from: today, to: new Date(now.getFullYear(), now.getMonth() + 1, 1), label: '这个月' };
  }
  if (/明天|明日/u.test(text)) return { from: offset(1), to: offset(2), label: '明天' };
  if (/后天/u.test(text)) return { from: offset(2), to: offset(3), label: '后天' };
  if (/今天|今日/u.test(text)) return { from: today, to: offset(1), label: '今天' };
  return { from: today, to: offset(7), label: '接下来一周' };
}

const QUERY_NOISE = /(?:这周|本周|下周|下个?月|这个?月|本月|周末|今天|今日|明天|明日|后天|接下来|最近|还有|有什么|有啥|有多少|有没有|几条|几节|几件|几个|安排|日程|事件|空不空|是什么|什么|在哪|哪里|哪儿|吗|呢|的话|帮我|看看|查查|一下|我|都|要|会|有|的|？|\?|，|。)/gu;

/** 问题里剩下的实词才当检索词，太短就不当关键词（「几节课」的「课」） */
function extractKeyword(text) {
  const cleaned = String(text).replace(QUERY_NOISE, '').replace(/\s+/gu, '').trim();
  return cleaned.length >= 2 ? cleaned : undefined;
}

async function cmdQuery(text, flags) {
  if (!text) return fail('用法：node cli.mjs query "这周还有什么"');
  const { from, to, label } = resolveQueryRange(text, new Date());
  const keyword = extractKeyword(text);

  const result = await listEvents({ from, to, calendar: flags.calendar });
  const matched = keyword
    ? result.events.filter((event) => event.title.includes(keyword) || String(event.location ?? '').includes(keyword))
    : result.events;
  // 关键词没命中就当它没说过，把这段时间的安排整体给出来，比「没有」有用
  const hits = matched.length > 0 || !keyword ? matched : result.events;
  const note = keyword && matched.length === 0 ? `（没找到含「${keyword}」的，以下是${label}全部安排）` : '';

  const partialNote = result.partial ? `\n⚠ ${result.failed.length} 个日历读取失败，结果可能不全` : '';
  const payload = {
    ok: true,
    range: { from: from.toISOString(), to: to.toISOString(), label },
    keyword: keyword && matched.length > 0 ? keyword : null,
    count: hits.length,
    partial: result.partial,
    failed: result.failed,
    events: hits,
    summary: (hits.length === 0
      ? `${label}没有安排。`
      : `${label}${note}有 ${hits.length} 条：\n${hits.map((event) => `· ${event.when} ${event.title}${event.location ? ` @${event.location}` : ''}`).join('\n')}`) + partialNote,
  };
  if (jsonMode) return out(payload);
  console.log(payload.summary);
  return undefined;
}

async function cmdUpdate(uid, flags) {
  if (!uid) return fail('用法：node cli.mjs update <uid> [--title 新标题] [--start ISO] [--end ISO] [--location 地点]');
  const result = await updateEvent({
    uid,
    title: typeof flags.title === 'string' ? flags.title : undefined,
    start: typeof flags.start === 'string' ? flags.start : undefined,
    end: typeof flags.end === 'string' ? flags.end : undefined,
    location: typeof flags.location === 'string' ? flags.location : undefined,
    calendar: flags.calendar,
    scope: flags.scope,
    occurrence: flags.occurrence,
  });
  if (jsonMode) return out(result);
  console.log(result.summary);
  return undefined;
}

/** `dsh-cal llm` —— 看看模型通不通；给一句话就看规则和模型各自读成什么。 */
async function cmdLlm(text, flags) {
  const current = llmConfig();

  if (flags.warm) {
    const started = Date.now();
    const warmed = await refineWithModel('明天上午十点在图书馆开会', { title: '在图书馆开会' }, { force: true });
    const ms = Date.now() - started;
    if (jsonMode) return out({ ok: Boolean(warmed), ms, error: warmed ? null : llmLastError.message });
    console.log(warmed ? `✓ 模型已加载并常驻（${ms}ms）` : `✗ 预热失败（${ms}ms）：${llmLastError.message}`);
    return undefined;
  }

  if (flags.on || flags.off) {
    const enabled = Boolean(flags.on);
    writeConfig({ ...readConfig(), llm: { ...current, enabled } });
    const probe = await probeModel();
    if (jsonMode) return out({ ok: true, enabled, detail: probe.detail });
    console.log(`✓ 模型兜底已${enabled ? '开启' : '关闭'}（${current.provider}/${current.model}）`);
    if (enabled) console.log(`  ${probe.ok ? '✓' : '✗'} ${probe.detail}`);
    return undefined;
  }

  if (!text) {
    const probe = await probeModel();
    if (jsonMode) {
      return out({ ok: probe.ok, enabled: current.enabled, provider: current.provider, model: current.model, detail: probe.detail });
    }
    console.log(`${probe.ok ? '✓' : '✗'} ${current.provider} / ${current.model}：${probe.detail}`);
    console.log(`  兜底开关：${current.enabled ? '已开启' : '未开启'}（开启：dsh-cal llm --on）`);
    return undefined;
  }

  const calendarNames = cachedCalendarNames();
  text = applyHolidayPhrase(text, new Date());
  const parsed = parseEvent(text, new Date(), { calendarNames });
  const refined = await refineWithModel(
    text,
    { title: parsed.title, location: parsed.location, local: formatRange(parsed.start, parsed.end) },
    { calendarNames, force: true },
  );

  if (jsonMode) {
    return out({
      ok: Boolean(refined),
      rule: { title: parsed.title, location: parsed.location ?? null, local: formatRange(parsed.start, parsed.end) },
      model: refined ? { title: refined.title ?? null, location: refined.location ?? null, provider: refined.provider, name: refined.model } : null,
      error: refined ? null : (llmLastError.message ?? '未知原因'),
    });
  }
  console.log(`规则：标题「${parsed.title}」 地点「${parsed.location ?? '无'}」 ${formatRange(parsed.start, parsed.end)}`);
  if (refined) {
    console.log(`模型：标题「${refined.title ?? parsed.title}」 地点「${refined.location ?? '无'}」（${refined.provider}:${refined.model}）`);
  } else {
    console.log(`模型：没有结果 —— ${llmLastError.message ?? '未知原因'}`);
  }
  return undefined;
}

async function main() {
  const { command, rest, flags } = argv();

  jsonMode = Boolean(flags.json);
  switch (command) {
    case 'login': return cmdLogin(flags);
    case 'llm': return cmdLlm(rest.join(' '), flags);
    case 'cals': {

      const result = await listCalendars();
      if (jsonMode) {
        return out({
          ok: true,
          offline: result.offline ?? false,
          cachedAt: result.cachedAt,
          default: result.default,
          calendars: result.calendars,
        });
      }
      console.log(result.summary);
      return undefined;
    }
    case 'add': return cmdAdd(rest.join(' '), flags);
    case 'tag': return cmdTag(rest.join(' '), flags);
    case 'update': return cmdUpdate(rest[0], flags);
    case 'query': return cmdQuery(rest.join(' '), flags);
    case 'past': {
      // 给拟物界面的「过去日程小盒子」用：只取已经过去的一段，默认 30 天。
      const days = Math.max(1, Number(flags.days) || 30);
      const to = new Date();
      const from = new Date(to.getTime() - days * 86400000);
      const result = await listEvents({ from, to, calendar: flags.calendar, includeUid: true });
      const payload = {
        ok: true,
        days,
        count: result.count,
        events: result.events,
        partial: result.partial,
        summary: result.summary,
      };
      if (jsonMode) return out(payload);
      console.log(result.summary);
      return undefined;
    }
    case 'ls': {
      // --from today 表示从今天 00:00 起算，这样早上已经过的日程也会出现在列表里（界面要按天分组）
      let from;
      if (typeof flags.from === 'string') {
        if (flags.from === 'today') {
          const start = new Date();
          start.setHours(0, 0, 0, 0);
          from = start;
        } else {
          from = flags.from;
        }
      }
      const result = await listEvents({ days: flags.days ?? 7, calendar: flags.calendar, from });
      if (jsonMode) return out(result);
      console.log(result.summary);
      return undefined;
    }
    case 'rm': {
      const result = await deleteEvent({
        uid: rest[0],
        title: flags.title,
        calendar: flags.calendar,
        days: flags.days,
        confirm: flags.confirm === true || flags.confirm === 'true',
        dryRun: flags['dry-run'] === true || flags['dry-run'] === 'true',
        scope: flags.scope,
        occurrence: flags.occurrence,
      });
      if (jsonMode) return out(result);
      console.log(result.summary);
      // 命中多条、等用户确认时，用非零退出码，脚本里能判断「没删成」
      if (result.needsConfirm) process.exitCode = 1;
      return undefined;
    }
    case 'new-cal': {
      const result = await createCalendar({ name: rest.join(' ') });
      if (jsonMode) return out(result);
      console.log(result.summary);
      return undefined;
    }
    case 'doctor': {
      const report = await doctor();
      const model = llmConfig();
      const probe = await probeModel();
      report.checks.push({
        name: '语言模型',
        ok: !model.enabled || probe.ok,
        detail: model.enabled
          ? `${model.provider}/${model.model} — ${probe.detail}`
          : '未开启，只用规则解析',
      });
      return printDoctor(report);
    }
    case 'parse': return cmdParse(rest.join(' '), flags);
    case 'config': return cmdConfig(flags);
    case 'sync': {
      const result = await syncQueue();
      if (jsonMode) return out(result);
      console.log(result.summary);
      return undefined;
    }
    case 'pending': {
      const result = pendingEvents();
      if (jsonMode) return out(result);
      console.log(result.summary);
      return undefined;
    }
    default:
      console.log(`dsh-cal — 自然语言日历

  login              配置账号（密码存钥匙串，只需一次）
  cals               列出日历
  add "<一句话>"      添加日程，可加 --calendar 学习 / --location 地点
                     句子里写 #工作 或「加到学习日历」也能指定标签
  ls [--days 7] [--from today]  查看近期日程
  query "这周还有什么"   自然语言查日程（下周 / 周末 / 这个月…）
  update <uid>       修改日程：--title 新标题 --start ISO --end ISO --location 地点
  sync               把离线暂存的日程补发出去
  pending            看看本地还压着几条没同步
  rm <uid>           删除日程（也可 --title 关键字）
  new-cal <名称>      新建日历
  doctor             体检
  parse "<一句话>"    只解析，不写入（--cals 学习,工作 用于识别裸标签名）
  config             只改账号/默认日历，不动密码（--user 邮箱 --calendar 学习）
  llm ["一句话"]      模型兜底：看连通状态、--on/--off 开关、给句子对比规则与模型

  所有命令加 --json 输出机器可读 JSON。`);
      return undefined;
  }
}

main().catch((error) => {
  fail(error.message);
});
