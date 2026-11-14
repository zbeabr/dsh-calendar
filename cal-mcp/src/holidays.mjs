/**
 * 节假日 / 农历短语 → 具体公历日期。纯函数、零依赖、完全离线。
 *
 * 设计：不碰 nlp.mjs。它 1197 行纯解析、零 import，给它塞节日表会把时区语义和
 * 152+ 条用例一起拖下水。这里只做「文本预处理」：把「中秋前一天」换成
 * 「2027年9月14日」，剩下的时间、标题、地点照旧交给原解析器。
 *
 * 数据表来源：2026 / 2027 / 2028 三年的传统节日公历日期按公开万年历核对
 * （多来源一致）。农历不推算、不猜，只查表 —— 每年更新一次这张表即可。
 * 超出收录年份一律报错，不静默降级成「算个大概」。
 */

const FIXED = {
  元旦: [1, 1],
  劳动节: [5, 1], 五一: [5, 1],
  国庆节: [10, 1], 国庆: [10, 1],
  圣诞节: [12, 25], 圣诞: [12, 25],
  儿童节: [6, 1], 教师节: [9, 10], 建军节: [8, 1],
};

const LUNAR = {
  2026: {
    腊八: [1, 26], 除夕: [2, 16], 春节: [2, 17], 元宵节: [3, 3],
    清明节: [4, 5], 端午节: [6, 19], 七夕节: [8, 19], 中元节: [8, 27],
    中秋节: [9, 25], 重阳节: [10, 18], 冬至: [12, 22],
  },
  2027: {
    腊八: [1, 15], 除夕: [2, 5], 春节: [2, 6], 元宵节: [2, 20],
    清明节: [4, 5], 端午节: [6, 9], 七夕节: [8, 8], 中元节: [8, 16],
    中秋节: [9, 15], 重阳节: [10, 8],
  },
  2028: {
    腊八: [1, 4], 除夕: [1, 25], 春节: [1, 26], 元宵节: [2, 9],
    清明节: [4, 4], 端午节: [5, 28], 七夕节: [8, 26], 中元节: [9, 3],
    中秋节: [10, 3], 重阳节: [10, 26],
  },
};

const ALIAS = {
  过年: '春节', 大年初一: '春节', 年三十: '除夕', 年夜: '除夕',
  中秋: '中秋节', 端午: '端午节', 元宵: '元宵节', 清明: '清明节',
  重阳: '重阳节', 七夕: '七夕节', 中元: '中元节', 鬼节: '中元节',
  腊八节: '腊八', 冬至节: '冬至',
};

const YEARS = Object.keys(LUNAR).map(Number).sort((a, b) => a - b);
const FIRST_YEAR = YEARS[0];
const LAST_YEAR = YEARS[YEARS.length - 1];

const NAMES = [...new Set([
  ...Object.keys(FIXED), ...Object.keys(ALIAS),
  ...Object.values(LUNAR).flatMap((table) => Object.keys(table)),
])].sort((a, b) => b.length - a.length);
const NAME_RE = new RegExp(`(${NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})`, 'u');

const CN_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function toNumber(raw) {
  if (/^\d+$/u.test(raw)) return Number(raw);
  if (raw === '十') return 10;
  if (raw.startsWith('十')) return 10 + (CN_DIGITS[raw.slice(1)] ?? 0);
  if (raw.endsWith('十')) return (CN_DIGITS[raw.slice(0, -1)] ?? 0) * 10;
  return CN_DIGITS[raw] ?? 1;
}

/** UTC 正午当「某一天」的锚点，避免 +08/-05 换算时串到前一天。 */
function dayOf(year, month, date) {
  return new Date(Date.UTC(year, month - 1, date, 12));
}
function todayOf(now) {
  return dayOf(now.getFullYear(), now.getMonth() + 1, now.getDate());
}
function shift(date, days) {
  const out = new Date(date.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}
function isWeekend(date) {
  const weekday = date.getUTCDay();
  return weekday === 0 || weekday === 6;
}
/** 只跳周六周日。法定调休各年不同、且要联网查，刻意不猜（写进已知限制）。 */
function nearestWorkday(date, direction) {
  let cursor = shift(date, direction === '前' ? -1 : 1);
  while (isWeekend(cursor)) cursor = shift(cursor, direction === '前' ? -1 : 1);
  return cursor;
}

function dateFor(name, year) {
  if (FIXED[name]) return dayOf(year, FIXED[name][0], FIXED[name][1]);
  const canonical = ALIAS[name] ?? name;
  const table = LUNAR[year];
  if (!table || !table[canonical]) return undefined;
  return dayOf(year, table[canonical][0], table[canonical][1]);
}

function readModifier(tail) {
  const workday = /^(前|后)(第一个|最后一个)工作日/u.exec(tail);
  if (workday) return { direction: workday[1], workday: true, offset: 0, consumed: workday[0].length };
  const days = /^(前|后)([0-9一二三四五六七八九十两]+)天/u.exec(tail);
  if (days) return { direction: days[1], workday: false, offset: toNumber(days[2]), consumed: days[0].length };
  const same = /^(当天|那天|这天|当日)/u.exec(tail);
  if (same) return { direction: null, workday: false, offset: 0, consumed: same[0].length };
  return { direction: null, workday: false, offset: 0, consumed: 0 };
}

function compute(name, modifier, now) {
  const today = todayOf(now);
  for (let year = Math.max(now.getFullYear(), FIRST_YEAR); year <= LAST_YEAR; year += 1) {
    const base = dateFor(name, year);
    if (!base) continue;
    let result = base;
    if (modifier.workday) result = nearestWorkday(base, modifier.direction);
    else if (modifier.offset) result = shift(base, (modifier.direction === '前' ? -1 : 1) * modifier.offset);
    if (result >= today) return result;
  }
  throw new Error(`节假日表只收录到 ${LAST_YEAR} 年，且没找到还没到的「${name}」；请更新 src/holidays.mjs 里的年份表`);
}

/**
 * 找出句子里的节日短语。命中返回 { date, name, from, to, text }，否则 null。
 * text 是替换掉短语之后的整句话，可以直接喂给 parseEvent。
 */
export function resolve(text, now = new Date()) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const match = NAME_RE.exec(text);
  if (!match) return null;
  const from = match.index;
  const name = match[1];
  const tail = text.slice(from + name.length);
  const modifier = readModifier(tail);
  const to = from + name.length + modifier.consumed;
  const date = compute(name, modifier, now);
  const stamp = `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
  return { date, name, phrase: text.slice(from, to), from, to, text: `${text.slice(0, from)}${stamp}${text.slice(to)}` };
}

/** 只返回替换后的句子；没命中就原样返回。 */
export function apply(text, now = new Date()) {
  return resolve(text, now)?.text ?? text;
}
