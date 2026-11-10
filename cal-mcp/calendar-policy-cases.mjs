/**
 * 标签归属「闭集」契约 —— 确定性硬断言，npm test 每次都跑。
 *
 * 这里只测纯逻辑：显式标签投影、模型输出投影、优先级、回落、禁子串模糊。
 * 模型结果一律用 mock 字符串注入，绝不连 ollama，保证结果不随模型版本漂移。
 * 真实模型的「输出必 ∈ 闭集」属性测试另见 calendar-model-cases.mjs（不进必修链）。
 */
process.env.TZ = 'Asia/Shanghai';

import { CalDav } from './src/caldav.mjs';
import {
  AUTO_CANDIDATES, UNSPECIFIED, exactCalendarMatch, pickDefaultCalendar, projectModelTag, resolveCalendar,
} from './src/calendar-policy.mjs';

const LIB = ['学习', '生活', '家庭', '特别事件', '课表-数学', '课表-体育'];
const DEFAULT = '学习';

let passed = 0;
let failed = 0;

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed += 1; return; }
  failed += 1;
  console.log(`✗ ${label}\n    实际 ${a}\n    期望 ${e}`);
}

async function shouldThrow(label, fn) {
  try {
    const value = await fn();
    failed += 1;
    console.log(`✗ ${label}\n    期望抛错，实际返回 ${JSON.stringify(value)}`);
  } catch { passed += 1; }
}

// ── 1. 精确匹配：库内命中、库外拒绝、绝不用 includes 子串 ──
eq('精确命中库内名字', exactCalendarMatch('学习', LIB), '学习');
eq('首尾空白应裁掉', exactCalendarMatch('  生活  ', LIB), '生活');
eq('库外名字一律拒绝', exactCalendarMatch('临时', LIB), undefined);
eq('禁子串模糊：课表不能命中课表-数学', exactCalendarMatch('课表', LIB), undefined);
eq('禁子串模糊：数学不能命中课表-数学', exactCalendarMatch('数学', LIB), undefined);
eq('英文大小写可放宽但必须全等', exactCalendarMatch('STUDY', ['Study']), 'Study');
eq('空名字不命中', exactCalendarMatch('', LIB), undefined);
eq('库为空时返回 undefined（无法验证）', exactCalendarMatch('学习', []), undefined);

// ── 2. 模型输出投影：任意脏值都只能落到候选集或「未指定」──
eq('模型给学习', projectModelTag('学习'), '学习');
eq('模型给生活', projectModelTag(' 生活 '), '生活');
eq('模型给未指定', projectModelTag('未指定'), UNSPECIFIED);
for (const dirty of [
  '饮食', '运动', '健康', '医疗', '作业', '休闲', '临时', '不存在的标签',
  '学习@大学', '课表-数学', '家庭', '{"tag":"生活"}', '', null, undefined, 42,
]) {
  eq(`模型脏值被丢弃：${String(dirty)}`, projectModelTag(dirty), undefined);
}
// 属性：无论输入什么，返回值都必须在闭集内
for (const dirty of ['饮食', '学习 ', '未指定', '', null, undefined, 42, '#学习']) {
  const value = projectModelTag(dirty);
  eq(`闭集属性：${String(dirty)}`, value === undefined
    || value === UNSPECIFIED
    || AUTO_CANDIDATES.includes(value), true);
}
eq('自动归属候选只有两个', AUTO_CANDIDATES, ['学习', '生活']);

// ── 3. 优先级：显式 > 模型 > 默认，且输出永远在库内 ──
eq('显式标签赢过模型', resolveCalendar({ explicit: '家庭', suggested: '生活', known: LIB, fallback: DEFAULT }).calendar, '家庭');
eq('显式赢过模型时标 source', resolveCalendar({ explicit: '家庭', suggested: '生活', known: LIB, fallback: DEFAULT }).source, 'explicit');
eq('显式库外：模型不许顶替，回落默认', resolveCalendar({ explicit: '临时', suggested: '生活', known: LIB, fallback: DEFAULT }).calendar, DEFAULT);
eq('显式库外被记进 rejected', resolveCalendar({ explicit: '临时', known: LIB, fallback: DEFAULT }).rejected, ['临时']);
eq('无显式时模型生效', resolveCalendar({ suggested: '生活', known: LIB, fallback: DEFAULT }).calendar, '生活');
eq('模型生效标 source', resolveCalendar({ suggested: '生活', known: LIB, fallback: DEFAULT }).source, 'model');
eq('模型给未指定则回落默认', resolveCalendar({ suggested: '未指定', known: LIB, fallback: DEFAULT }).calendar, DEFAULT);
eq('模型给库外词则回落默认', resolveCalendar({ suggested: '饮食', known: LIB, fallback: DEFAULT }).calendar, DEFAULT);
eq('模型给库内但非候选的名字不算自动归属', resolveCalendar({ suggested: '家庭', known: LIB, fallback: DEFAULT }).calendar, DEFAULT);
eq('候选名不在库里时绝不返回', resolveCalendar({ suggested: '生活', known: ['学习', '家庭'], fallback: '学习' }).calendar, '学习');
eq('默认日历也必须过库校验', resolveCalendar({ known: LIB, fallback: '不存在的日历' }).calendar, undefined);
eq('库和默认都为空时不硬造名字', resolveCalendar({ known: LIB }).calendar, undefined);
eq('库为空时不误伤显式标签（交给写入层校验）', resolveCalendar({ explicit: '学习', known: [], fallback: '学习' }).calendar, '学习');
eq('库为空时标 unverified', resolveCalendar({ explicit: '学习', known: [], fallback: '学习' }).unverified, true);

// 不变量：任何组合的输出都必须 ∈ 库 ∪ {undefined}
for (const c of [
  { explicit: '临时', suggested: '饮食', known: LIB, fallback: '随便写' },
  { explicit: '课表', suggested: '运动', known: LIB, fallback: '生活' },
  { suggested: '家庭', known: LIB, fallback: DEFAULT },
  { explicit: '学习', suggested: '生活', known: LIB, fallback: DEFAULT },
  {},
]) {
  const value = resolveCalendar(c).calendar;
  eq(`输出必在库内：${JSON.stringify(c)}`, value === undefined || c.known?.includes(value) || (c.known?.length === 0), true);
}

// ── 4. 写入路径禁子串模糊：findCalendar 的 exactOnly ──
const mock = Object.create(CalDav.prototype);
mock.listCalendars = async () => LIB.map((name) => ({ name, writable: true }));
await shouldThrow('写入路径：课表 不应静默命中课表-数学', () => mock.findCalendar('课表', { create: false, exactOnly: true }));
await shouldThrow('写入路径：库外名必须抛错', () => mock.findCalendar('临时', { create: false, exactOnly: true }));
eq('写入路径：精确名字仍可用', (await mock.findCalendar('学习', { create: false, exactOnly: true })).name, '学习');
// 非写入路径（ls / rm / update）保留原来的容错，不被这次改动带坏
eq('查询路径：旧的模糊容错保留', (await mock.findCalendar('课表', { create: false })).name, '课表-数学');

// ── 5. 登录时的默认日历：绝不静默挑第一个 ──
// 「学习」不在 iCloud 可写列表里时，旧逻辑会静默选中列表第一个（实测是「哔哩哔哩HD」），
// 之后每句话都写进那个日历，而用户看不出任何变化。
const IC = ['哔哩哔哩HD', '个人', '工作'];
eq('默认日历：指定了且存在 → 用它', pickDefaultCalendar({ requested: '工作', current: '个人', writable: IC }).calendar, '工作');
eq('默认日历：指定了但不存在 → 报错，不退而求其次', Boolean(pickDefaultCalendar({ requested: '学习', writable: IC }).error), true);
eq('默认日历：指定了但不存在 → 不返回任何日历', pickDefaultCalendar({ requested: '学习', writable: IC }).calendar, undefined);
eq('默认日历：没指定 → 沿用配置里那个（还在的话）', pickDefaultCalendar({ current: '个人', writable: IC }).calendar, '个人');
eq('默认日历：配置里那个已不在 → 不拿列表第一个顶上', pickDefaultCalendar({ current: '学习', writable: IC }).calendar, undefined);
eq('默认日历：都没指定但库里有「学习」→ 用「学习」', pickDefaultCalendar({ writable: ['个人', '学习'] }).calendar, '学习');
eq('默认日历：返回可写列表，供 UI 提示用户挑', pickDefaultCalendar({ writable: IC }).writable, IC);
eq('默认日历：库为空时返回空，不抛错', pickDefaultCalendar({ writable: [] }).calendar, undefined);

console.log(`${passed}/${passed + failed} 通过`);
if (failed) process.exitCode = 1;
