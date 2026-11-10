/**
 * Chinese natural-language time parsing for calendar events.
 * Handles: 今天/明天/后天/周X/下周X/11月8号/今晚, 六点半/18:30/下午3点,
 * ranges (到/至/-), durations (一小时/半小时/90分钟), and strips the time
 * expression from the title.
 */

const CN_NUM = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 七: 7 };
const ICS_DAY = { 1: 'MO', 2: 'TU', 3: 'WE', 4: 'TH', 5: 'FR', 6: 'SA', 7: 'SU' };
const REVERSE_DAY = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };
const PERIOD_HOUR = {
  凌晨: 5, 早上: 8, 早晨: 8, 上午: 9, 中午: 12, 正午: 12, 午后: 14, 下午: 14, 傍晚: 18, 晚上: 19,
  夜里: 21, 夜间: 21, 今晚: 19, 今早: 8, 明晚: 19, 明早: 8, 明晨: 8,
};

const PERIOD = '(?:凌晨|早上|早晨|上午|中午|正午|午后|下午|傍晚|晚上|夜里|夜间|今晚|今早|明晚|明早|明晨)';

/**
 * 口语里的单字缩略时段词：「晚八点」「早八点」「午十二点」「夜十点」。
 * 它们只在**后面紧跟钟点**时才算时间词 —— 「晚饭」「早点」「夜宵」「午后」
 * 都是普通词，绝不能把「晚」当成 19:00 削掉。
 * 所以单独定义 CLOCK_PERIOD 给钟点解析用，不塞进 PERIOD（PERIOD 还负责裸时段词
 * 和标题清洗，加单字会误伤「明天晚饭」）。
 */
const SHORT_PERIOD = '(?:晚|早|午|夜)';
const CLOCK_NUM = '(?:\\d{1,2}|[零一二两三四五六七八九十]{1,3})';
const CLOCK_PERIOD = `(?:${PERIOD}|${SHORT_PERIOD}(?=\\s*${CLOCK_NUM}\\s*[点时:：]))`;
/** 单字时段词归一化成同义的完整词，直接复用 applyPeriod / NIGHT_PERIOD 的既有规则。 */
const PERIOD_ALIAS = { 晚: '晚上', 早: '早上', 午: '中午', 夜: '夜里' };
function normalizePeriod(period) {
  return PERIOD_ALIAS[period] ?? period;
}

/**
 * 分钟：阿拉伯数字、半、一刻、三刻，以及中文数字（四十、四十五、零五）。
 * 「半/一刻/三刻」必须排在中文数字前面，「一刻」否则会被读成 1。
 */
const MINUTE = '(?:\\d{1,2}|半|一刻|三刻|[零一二两三四五六七八九十]{1,3})';

function cnToNumber(text) {
  if (/^\d+(?:\.\d+)?$/u.test(text)) return Number(text);
  // 「十点零五」→ 零五 → 五；「零点」→ 0
  if (text === '零') return 0;
  if (/^零./u.test(text)) return cnToNumber(text.slice(1));
  if (text === '十') return 10;
  if (text.startsWith('十')) return 10 + (CN_NUM[text[1]] ?? 0);
  if (text.endsWith('十')) return (CN_NUM[text[0]] ?? 0) * 10;
  if (text.includes('十')) {
    const [tens, ones] = text.split('十');
    return (CN_NUM[tens] ?? 1) * 10 + (CN_NUM[ones] ?? 0);
  }
  return CN_NUM[text];
}

function normalize(text) {
  return text
    .replace(/[０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[：]/gu, ':')
    .replace(/[＃]/gu, '#')
    .replace(/[．]/gu, '.')
    .trim();
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** 某年某月（monthIndex 从 0 开始，可越界）有多少天。 */
function monthLength(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * 明确写了年月日、但那天根本不存在时，报错而不是挪到月末。
 *
 * 以前「2月30号」会被夹成 2 月 28 号、「11月31号」夹成 11 月 30 号。
 * 用户说的是哪一天，程序却悄悄改成另一天写进日历 —— 这比报错危险得多，
 * README 里也是这么承诺的（「日期错了比报错严重得多」）。
 */
function assertRealDay(year, monthIndex, day, label) {
  const last = monthLength(year, monthIndex);
  if (day > last) {
    throw new Error(`${label}没有 ${day} 号（那个月只有 ${last} 天），换个日期吧。`);
  }
}

/**
 * Resolve the date part of a phrase.
 * @returns {{ date: Date, matched: string, evening: boolean }}
 */
function parseDate(text, now) {
  let match;

  if ((match = /(今天|今日|今儿|今早|今晚)/u.exec(text))) {
    return { date: startOfDay(now), matched: match[0], evening: match[0] === '今晚' };
  }
  if ((match = /(明天|明日|明儿|明早|明晨|明晚)/u.exec(text))) {
    const date = startOfDay(new Date(now.getTime() + 86400000));
    return { date, matched: match[0], evening: match[0] === '明晚' };
  }
  if ((match = /大后天/u.exec(text))) {
    return { date: startOfDay(new Date(now.getTime() + 3 * 86400000)), matched: match[0], evening: false };
  }
  if ((match = /后天/u.exec(text))) {
    return { date: startOfDay(new Date(now.getTime() + 2 * 86400000)), matched: match[0], evening: false };
  }

  // 三天后 / 3 天后 / 两周后 / 两个星期后 / 一个月后
  // 必须排在「大后天」「后天」之后：「三天后」里没有「后天」这个子串（是「天后」），
  // 但「一天后」会被「后天」误伤？——不会，字符顺序相反。
  if ((match = /(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(天|日|周|个?\s*(?:星期|礼拜)|个?月)\s*(?:以)?后/u.exec(text))) {
    const amount = cnToNumber(match[1]);
    const unit = match[2];
    let date;
    if (/天|日/u.test(unit)) {
      date = new Date(now.getTime() + amount * 86400000);
    } else if (/月/u.test(unit)) {
      date = new Date(now.getFullYear(), now.getMonth() + amount, now.getDate());
    } else {
      date = new Date(now.getTime() + amount * 7 * 86400000);
    }
    return { date: startOfDay(date), matched: match[0], evening: false };
  }

  // 周末 / 这周末 / 下周末 → 默认按周六算
  if ((match = /(?<![\d一二两三四五六七八九十])(下下个?|下个?|这个?|本)?\s*(?:周|星期|礼拜)\s*末/u.exec(text))) {
    const prefix = match[1] ?? '';
    const today = startOfDay(now);
    const currentDay = today.getDay() === 0 ? 7 : today.getDay();
    // 距「本周六」还有几天：周六 0、周日 6、周一 5 …
    let delta = (6 - currentDay + 7) % 7;
    if (prefix.startsWith('下下')) {
      delta += 14;
    } else if (prefix.startsWith('下')) {
      delta += 7;
    } else if (delta > 0 && currentDay === 7 && /^(?:这|本)/u.test(prefix)) {
      // 周日说「这周末」：本周的周末只剩今天，不该算到下周六
      delta = 0;
    }
    return { date: new Date(today.getTime() + delta * 86400000), matched: match[0], evening: false };
  }

  // 月底 / 这个月底 / 下个月底：取那个月的最后一天
  // 「11月底」这种带月份的写法要先吃掉，否则只剩「月底」会被当成本月。
  if ((match = /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*月\s*(?:底|末)/u.exec(text))) {
    const month = cnToNumber(match[1]);
    const year = month < now.getMonth() + 1 ? now.getFullYear() + 1 : now.getFullYear();
    return { date: new Date(year, month, 0), matched: match[0], evening: false };
  }
  if ((match = /(下下个?|下个?|这个?|本)?\s*月\s*(?:底|末)/u.exec(text))) {
    const prefix = match[1] ?? '';
    const offset = prefix.startsWith('下下') ? 2 : prefix.startsWith('下') ? 1 : 0;
    // 「下个月的第 0 天」就是本月最后一天
    const date = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
    return { date: startOfDay(date), matched: match[0], evening: false };
  }

  // 下周三 / 下下周一 / 下下周周五 / 本周一 / 周三 / 星期四
  // 「下」前不能是数词，否则「记一下周六」「等一下周报」里的「下」会被吃成「下周六」。
  // 「周」可以叠写（「下下周周五」和「下下周五」是一回事），所以第二段「周」是可选的。
  // 第二组允许「周一三五」这种连写的多天：没有「每」就不生成重复规则，
  // 但整段都要从标题里剔掉，否则「三五」会粘在标题上（「三五健身」）。
  // 日期仍按第一个星期几算，语义与「只认带每的写法」的取舍一致。
  // 多天之间只认连写或「和/、」，不跨空格：否则「下周三 一点」里的「一」会被连着吃掉。
  // 连写的第二个字后面若紧跟「点/时/:」，它其实是钟点数字（「下周三七点」的「七」），
  // 不是星期几 —— 吞掉它整句会掉成全天日程，带时长时甚至直接报错。
  if ((match = /(?<![\d一二两三四五六七八九十])(下下个?|下个?|本|这|这个)?\s*(?:周|星期|礼拜)\s*(?:周|星期|礼拜)?\s*([一二三四五六日天七](?:(?:和|、|,|，)?(?:周|星期|礼拜)?[一二三四五六日天七](?!\s*[点时:：]))*)/u.exec(text))) {
    const prefix = match[1] ?? '';
    const targetDay = WEEKDAY[match[2][0]];
    const today = startOfDay(now);
    const currentDay = today.getDay() === 0 ? 7 : today.getDay();
    // 以「本周一」为原点数周，而不是在「距今天几天」上打补丁。
    // 以前下下周五做的事是 delta += 14 - (delta > 0 ? 7 : 0)，周三说「下下周五」
    // 得到的是 7 天后 —— 和「下周五」同一天，等于把「下下」整个吞掉了。
    const weekOffset = prefix.startsWith('下下') ? 2 : prefix.startsWith('下') ? 1 : 0;
    let delta = targetDay - currentDay + weekOffset * 7;
    if (weekOffset === 0 && delta < 0) delta += 7;
    // bareWeekday：「周三」这种没带任何限定词的写法。周三晚上说「周三九点」，
    // 指的一定是还没到的那个周三，不是今天上午那个（见下面的 +7 天规则）。
    // 「这周三 / 本周三」带了限定词，就按字面留在本周，不标。
    const bareWeekday = prefix === '';
    return {
      date: new Date(today.getTime() + delta * 86400000),
      matched: match[0],
      evening: false,
      bareWeekday,
    };
  }

  // 下个月5号 / 下下个月5号 / 这个月15号
  // 必须排在「11月8号」前面，「下个月」里没有数字，但「这个月15号」会被后面的
  // 8号规则吃掉「15号」而丢掉月份前缀。
  if ((match = /(下下个?月|下个?月|这个月|本月|这月)\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[日号]/u.exec(text))) {
    const prefix = match[1];
    const offset = /下下/u.test(prefix) ? 2 : /下/u.test(prefix) ? 1 : 0;
    const day = cnToNumber(match[2]);
    const monthIndex = now.getMonth() + offset;
    const year = now.getFullYear() + Math.floor(monthIndex / 12);
    const realMonth = ((monthIndex % 12) + 12) % 12;
    // 以前这里取 min(day, 月末)，把「下个月31号」悄悄变成 30 号
    assertRealDay(year, realMonth, day, `${realMonth + 1} 月`);
    return {
      date: new Date(year, realMonth, day),
      matched: match[0],
      evening: false,
    };
  }

  // 2027年3月15号 / 明年3月15号 / 今年12月1号
  // 必须排在「3月15号」前面：否则年份没被吃掉，标题里会剩一个「2027年」。
  if ((match = /(?:(\d{4})\s*年|(明年|后年|今年))\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*月\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[日号]/u.exec(text))) {
    const baseYear = now.getFullYear();
    const year = match[1] ? Number(match[1]) : /后年/u.test(match[2]) ? baseYear + 2 : /明年/u.test(match[2]) ? baseYear + 1 : baseYear;
    const month = cnToNumber(match[3]);
    const day = cnToNumber(match[4]);
    if (!(month >= 1 && month <= 12)) throw new Error(`月份「${match[3]}」超出范围了，应该是 1 到 12。`);
    if (!(day >= 1 && day <= 31)) throw new Error(`日期「${match[4]}」超出范围了，应该是 1 到 31。`);
    assertRealDay(year, month - 1, day, `${year} 年 ${month} 月`);
    return { date: new Date(year, month - 1, day), matched: match[0], evening: false };
  }

  // 11月8号 / 十一月八号 / 11月8日
  if ((match = /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*月\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[日号]/u.exec(text))) {
    const month = cnToNumber(match[1]);
    const day = cnToNumber(match[2]);
    // 以前 13月、32号 会被 Date 悄悄溢出成下一年/下个月，写进去就是错的日期
    if (!(month >= 1 && month <= 12)) throw new Error(`月份「${match[1]}」超出范围了，应该是 1 到 12。`);
    if (!(day >= 1 && day <= 31)) throw new Error(`日期「${match[2]}」超出范围了，应该是 1 到 31。`);
    const year = month < now.getMonth() + 1 ? now.getFullYear() + 1 : now.getFullYear();
    // 2月30号 / 11月31号：那天根本不存在，报错让用户重说
    assertRealDay(year, month - 1, day, `${month} 月`);
    return { date: new Date(year, month - 1, day), matched: match[0], evening: false };
  }

  // 8号 / 八号（本月，已经过了就顺到下个月）
  // 排除「三号楼」「一号线」这种量词用法。
  if ((match = /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[日号](?![楼线院馆室门车机床位窗仓栋])/u.exec(text))) {
    const day = cnToNumber(match[1]);
    // 0 号 / 32 号 会被 Date 解析成上月末、下月初，宁可让用户重说
    if (!(day >= 1 && day <= 31)) throw new Error(`日期「${match[1]}」超出范围了，应该是 1 到 31。`);
    let date;
    if (day > monthLength(now.getFullYear(), now.getMonth())) {
      // 「31号」在 11 月说，指的是下个月 31 号（12 月）；下个月也没有就报错
      assertRealDay(now.getFullYear(), now.getMonth() + 1, day, `${now.getMonth() + 2} 月`);
      date = new Date(now.getFullYear(), now.getMonth() + 1, day);
    } else {
      date = new Date(now.getFullYear(), now.getMonth(), day);
      if (day < now.getDate()) date = new Date(now.getFullYear(), now.getMonth() + 1, day);
    }
    return { date, matched: match[0], evening: false };
  }

  // 单字缩略：今 / 明 / 后 / 大后（「明，下午一点半」「明下午三点」）
  // 必须带边界：前面得是开头或分隔符，后面得是分隔符或时间词，
  // 否则「明确」「然后」「今年」这种普通词会被误认成日期。
  const abbr = /(?:^|[\s，,。；;、:：])(大后|明|后|今)(儿)?(?=[\s，,。；;、:：]|(?:凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|\d|[一二两三四五六七八九十]{1,3}\s*[点时]))/u.exec(text);
  if (abbr) {
    const days = { 大后: 3, 明: 1, 后: 2, 今: 0 }[abbr[1]];
    return {
      date: startOfDay(new Date(now.getTime() + days * 86400000)),
      matched: abbr[1] + (abbr[2] ?? ''),
      evening: false,
    };
  }

  return { date: startOfDay(now), matched: '', evening: false };
}

const WEEKDAY_CHAR = '[一二三四五六日天七]';
/** 「三和周五」「二、四」「一三五」里的连接符 */
const DAY_SEP = '(?:、|，|,|和|与|及|以及|跟|/|／)';
/** 「周一到周五」里的区间符 */
const DAY_RANGE = '(?:到|至|-|~|—|–)';

/**
 * 把一段「星期几」文字展开成数字数组。
 * 「一三五」→ [1,3,5]，「三和周五」→ [3,5]，「一到周五」→ [1,2,3,4,5]。
 */
function expandDayChunk(chunk) {
  const compact = chunk.replace(/\s+/gu, '').replace(/星期|礼拜/gu, '');
  const range = new RegExp(`^(${WEEKDAY_CHAR})${DAY_RANGE}(?:周)?(${WEEKDAY_CHAR})$`, 'u').exec(compact);
  if (range) {
    const from = WEEKDAY[range[1]];
    const to = WEEKDAY[range[2]];
    const days = [];
    let day = from;
    // 最多绕一周，防止 from/to 相同导致死循环
    for (let step = 0; step < 7; step += 1) {
      days.push(day);
      if (day === to) break;
      day = (day % 7) + 1;
    }
    return days;
  }
  return [...new Set([...compact].map((char) => WEEKDAY[char]).filter(Boolean))].sort((a, b) => a - b);
}

/**
 * 重复规则：「每天」「每周三」「每周三和周五」「每周一到周五」「每个工作日」
 * 「每月8号」「每两周」「每周三次」。
 *
 * 只认带「每」的写法——「周三」是单次安排，不该被读成重复。
 * 「每周一次」里的「一」是频率不是星期一，用负向断言排掉。
 */
function parseRepeat(text) {
  let match;

  if ((match = /每(?:一)?(?:个)?工作日/u.exec(text))) {
    return { freq: 'WEEKLY', byday: ['MO', 'TU', 'WE', 'TH', 'FR'], days: [1, 2, 3, 4, 5], matched: match[0] };
  }
  if ((match = /(?:每天|每日|天天)/u.exec(text))) {
    return { freq: 'DAILY', days: [], matched: match[0] };
  }
  // 「每两天」：DAILY + INTERVAL。必须早于「每N周」判断，互斥不冲突，但顺序更清楚。
  if ((match = /每\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:个)?\s*天/u.exec(text))) {
    const interval = cnToNumber(match[1]);
    if (interval >= 2) return { freq: 'DAILY', days: [], interval, matched: match[0] };
  }
  // 「每两周」「每两个星期」「每 2 周」：WEEKLY + INTERVAL
  // 这里不再用负向断言把「每两周一」挡掉：那样「每两周一次」也会被挡住，
  // 整句反而报「找不到时间」。间隔后面的「星期几」交给下面统一解析。
  if ((match = /每\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:个)?\s*(?:周|星期|礼拜)/u.exec(text))) {
    const interval = cnToNumber(match[1]);
    if (interval >= 2) {
      // 「每两周周一和周三」：间隔后面的星期几也得一起认。
      // 以前只返回 INTERVAL，BYDAY 丢掉，「周一和周三」还留在标题里。
      const rest = text.slice(match.index + match[0].length);
      // 星期字符后面紧跟钟点标记时是「每两周周三七点」的「七」（钟点），不是星期几。
      const chunkRe = new RegExp(`^\\s*(?:的|个)?\\s*((?:周|星期|礼拜)?\\s*${WEEKDAY_CHAR}(?:(?:\\s*(?:${DAY_SEP}|${DAY_RANGE})\\s*(?:周|星期|礼拜)?\\s*)?${WEEKDAY_CHAR}(?!\\s*[点时:：]))*)`, 'u');
      const chunkMatch = chunkRe.exec(rest);
      let days = [];
      let extra = '';
      if (chunkMatch) {
        const tail = rest.slice(chunkMatch[0].length);
        const unit = /^\s*(?:次|回|遍)/u.exec(tail);
        if (unit) {
          // 「每两周一次」：这里的「一」是次数，不是星期一
          extra = `${chunkMatch[0].trim()}${unit[0].trim()}`;
        } else {
          days = expandDayChunk(chunkMatch[1]);
          if (days.length) extra = chunkMatch[0].trim();
        }
      }
      return {
        freq: 'WEEKLY',
        days,
        ...(days.length ? { byday: days.map((day) => ICS_DAY[day]) } : {}),
        interval,
        matched: match[0] + extra,
      };
    }
  }
  if ((match = /每(?:个)?月\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[日号]/u.exec(text))) {
    const day = cnToNumber(match[1]);
    if (day >= 1 && day <= 31) return { freq: 'MONTHLY', bymonthday: day, days: [], matched: match[0] };
  }
  // 「每周三次」「每星期两回」：只说了频率没说是哪几天。
  // 「每周一次」就是每周，没问题；三次以上 RRULE 表达不了（它只认「哪天」），
  // 以前是静默降级成每周一次 —— 用户以为是三次，日历里只出现一次，属于「悄悄少写」。
  // 宁可让他补一句「每周一三五」，也不要在他的日历里写一条不对的规则。
  if ((match = /每(?:个)?\s*(?:周|星期|礼拜)\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:次|回|遍)/u.exec(text))) {
    const times = cnToNumber(match[1]);
    if (times > 1) {
      throw new Error(`「${match[0]}」还没法精确表达（日历的重复规则只认「哪天」，不认「几次」）。请指明哪几天，比如「每周一三五」。`);
    }
    return { freq: 'WEEKLY', days: [], matched: match[0] };
  }
  // 「每周末」：周六和周日两天。必须排在「每周X」之前，否则「每周」先吃掉、「末」留在标题里。
  if ((match = /每(?:个)?\s*(?:周|星期|礼拜)\s*末/u.exec(text))) {
    return { freq: 'WEEKLY', byday: ['SA', 'SU'], days: [6, 7], matched: match[0] };
  }
  // 「每周三和周五」「每周二、四」「每周一到周五」「每周一三五」
  // 同样要挡住「每周三七点」：「七」是钟点，不能被读成「周三 + 周日」。
  const chunk = `${WEEKDAY_CHAR}(?:(?:\\s*(?:${DAY_SEP}|${DAY_RANGE})\\s*(?:周|星期|礼拜)?\\s*)?${WEEKDAY_CHAR}(?!\\s*[点时:：]))*`;
  if ((match = new RegExp(`每(?:个)?\\s*(?:周|星期|礼拜)\\s*(${chunk})`, 'u').exec(text))) {
    const days = expandDayChunk(match[1]);
    if (days.length) {
      return { freq: 'WEEKLY', byday: days.map((day) => ICS_DAY[day]), days, matched: match[0] };
    }
  }
  // 「每周」没点明星期几：就按第一次发生的那个星期几重复
  if ((match = /每(?:个)?\s*(?:周|星期|礼拜)(?![一二三四五六日天七])/u.exec(text))) {
    return { freq: 'WEEKLY', days: [], matched: match[0] };
  }
  return undefined;
}

/** 重复日程的第一次发生在哪天。 */
function repeatStartDate(repeat, now) {
  const today = startOfDay(now);
  if (repeat.freq === 'DAILY') return today;
  if (repeat.freq === 'MONTHLY') {
    // 「每月31号」：31 号不是每个月都有。以前直接 new Date(y, m, 31)，
    // 在 11 月会溢出成 12 月 1 号 —— 第一次就错了一天。
    // 按 RFC 5545 的 BYMONTHDAY 语义，没有这一天的月份直接跳过。
    const day = repeat.bymonthday;
    for (let offset = 0; offset <= 12; offset += 1) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      const last = monthLength(monthStart.getFullYear(), monthStart.getMonth());
      if (day > last) continue;
      const candidate = new Date(monthStart.getFullYear(), monthStart.getMonth(), day);
      if (candidate.getTime() >= today.getTime()) return candidate;
    }
    throw new Error(`「每月 ${day} 号」在任何月份都对不上，换个日期吧。`);
  }
  if (!repeat.days.length) return today;
  const currentDay = today.getDay() === 0 ? 7 : today.getDay();
  const delta = repeat.days.map((day) => (day - currentDay + 7) % 7).sort((a, b) => a - b)[0];
  return new Date(today.getTime() + delta * 86400000);
}

/** 把 RRULE 片段拼成 RFC 5545 的写法。 */
export function toRrule(repeat) {
  if (!repeat) return undefined;
  const parts = [`FREQ=${repeat.freq}`];
  if (repeat.interval && repeat.interval > 1) parts.push(`INTERVAL=${repeat.interval}`);
  if (repeat.byday?.length) parts.push(`BYDAY=${repeat.byday.join(',')}`);
  if (repeat.bymonthday) parts.push(`BYMONTHDAY=${repeat.bymonthday}`);
  return parts.join(';');
}

/**
 * 在原文里给每个片段找到位置，供界面做「识别高亮」。
 *
 * 片段是解析时临时插了空格的（「明晚 七点到九点」），原句里没有空格，
 * 所以按「字与字之间允许空白」去匹配；长片段先占位，避免短片段抢走它的开头。
 */
function locateSpans(text, pieces) {
  const used = new Uint8Array(text.length);
  const spans = [];
  const ordered = [...pieces].sort((a, b) => b.text.length - a.text.length);

  for (const piece of ordered) {
    const chars = piece.text.replace(/\s+/gu, '').split('');
    if (!chars.length) continue;
    const pattern = new RegExp(chars.map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'gu');
    let hit;
    while ((hit = pattern.exec(text)) !== null) {
      let free = true;
      for (let index = hit.index; index < hit.index + hit[0].length; index += 1) {
        if (used[index]) { free = false; break; }
      }
      if (free) {
        for (let index = hit.index; index < hit.index + hit[0].length; index += 1) used[index] = 1;
        spans.push({ start: hit.index, end: hit.index + hit[0].length, kind: piece.kind });
        break;
      }
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** Convert a period word + hour into a 0–23 hour. */
function applyPeriod(hour, period) {
  if (!period) return hour;
  if (/凌晨/u.test(period)) return hour === 12 ? 0 : hour;
  if (/早上|早晨|上午/u.test(period)) return hour === 12 ? 0 : hour;
  if (/中午|正午|午后/u.test(period)) return hour < 11 ? hour + 12 : hour;
  if (/下午|傍晚|晚上|夜里|夜间|今晚|明晚/u.test(period)) return hour < 12 ? hour + 12 : hour;
  return hour;
}

/**
 * 「晚上十二点」「今晚十二点」是当天的 24:00，也就是**第二天**的 0 点。
 * applyPeriod 只换钟点，日期得靠这里多带一天；否则会变成当天中午 12:00。
 * 「下午十二点」是正午，不算，别一起推。
 */
const NIGHT_PERIOD = /(?:晚上|今晚|明晚|夜里|夜间|深夜)/u;

function parseClock(text) {
  const match = new RegExp(`(${CLOCK_PERIOD})?\\s*(\\d{1,2}|[零一二两三四五六七八九十]{1,3})\\s*(?:点|时|:)\\s*(${MINUTE})?\\s*[分整]?`, 'u').exec(text);
  if (!match) return undefined;
  // 「晚十二点」归一化成「晚上十二点」，才能命中 NIGHT_PERIOD 推到次日零点；
  // 「早八点」「午十二点」「夜十点」同理走 applyPeriod 的既有分支。
  const period = normalizePeriod(match[1]);
  let hour = cnToNumber(match[2]);
  if (hour === undefined || Number.isNaN(hour)) return undefined;

  let minute = 0;
  const rawMinute = match[3];
  if (rawMinute === '半') minute = 30;
  else if (rawMinute === '一刻') minute = 15;
  else if (rawMinute === '三刻') minute = 45;
  else if (rawMinute !== undefined) {
    minute = cnToNumber(rawMinute);
    if (Number.isNaN(minute)) minute = 0;
  }
  // "六点半" / "18:30" — a bare 4-digit clock like 1830 is not supported on purpose.
  // 分钟越界以前是直接 return undefined，于是「3点75分开会」整句掉成一条全天日程，
  // 而「3点75分」还烂在标题里。这里改成明确报错。
  if (minute > 59) throw new Error(`「${match[0].replace(/\s+/gu, '')}」里的分钟超出 0–59 了，换个时间说吧。`);
  if (hour > 24) throw new Error(`钟点「${match[2]}点」超出范围了，应该是 0 到 24 点。`);

  let dayOffset = 0;
  if (hour === 24) {
    // 「24点」= 次日零点
    hour = 0;
    dayOffset = 1;
  } else if (hour === 12 && NIGHT_PERIOD.test(period ?? '')) {
    hour = 0;
    dayOffset = 1; // 那一夜跨到第二天零点
  } else {
    hour = applyPeriod(hour, period);
  }
  if (hour > 23) throw new Error(`钟点「${match[2]}点」超出范围了，应该是 0 到 24 点。`);
  // 没有分钟时，别把后面那个「分」当成时间吃掉（「三点分析」→ 标题留下「析」）
  const matched = rawMinute === undefined ? match[0].replace(/\s*分$/u, '') : match[0];
  return { hour, minute, matched, dayOffset };
}

/** 时长里的数字：阿拉伯数字或三位以内的中文数字（四十五、二十、十）。 */
const DUR_NUM = '(\\d+(?:\\.\\d+)?|[一两二三四五六七八九十]{1,3})';
/**
 * 「用时十分钟」「大概半小时」「需要一小时二十分钟」——时长前面的状语说的是时长本身，
 * 不属于日程标题，所以要和数字一起认掉（matched 带上前缀，标题里才不会剩「用时」）。
 * 用重复分组是为了兼容「用时约二十分钟」这种叠着写的。
 */
const DURATION_LEAD = '(?:(?:用时|用了|需要用|需要|花费|花了|总共|一共|共计|大概|大约|预计|差不多|约|用|花)\\s*){0,3}';

function parseDuration(text) {
  let match;
  // 「一小时二十分钟」先合成一个总数，否则只会读到「一小时」
  if ((match = new RegExp(`${DURATION_LEAD}${DUR_NUM}\\s*个?\\s*(?:小时|钟头)\\s*(?:又|零)?\\s*${DUR_NUM}\\s*分钟`, 'u').exec(text))) {
    const hours = cnToNumber(match[1]);
    const minutes = cnToNumber(match[2]);
    if (hours && Number.isFinite(minutes)) return { minutes: hours * 60 + minutes, matched: match[0] };
  }
  // 一个半小时 → 90 分钟（必须排在「一个小时」前面判断）
  if ((match = new RegExp(`${DURATION_LEAD}${DUR_NUM}\\s*个\\s*半\\s*(?:小时|钟头)`, 'u').exec(text))) {
    const hours = cnToNumber(match[1]);
    if (hours) return { minutes: hours * 60 + 30, matched: match[0] };
  }
  if ((match = new RegExp(`${DURATION_LEAD}${DUR_NUM}\\s*个?\\s*(?:小时|钟头)`, 'u').exec(text))) {
    const hours = cnToNumber(match[1]);
    if (hours) return { minutes: hours * 60, matched: match[0] };
  }
  if ((match = new RegExp(`${DURATION_LEAD}半\\s*个?\\s*(?:小时|钟头)`, 'u').exec(text))) {
    return { minutes: 30, matched: match[0] };
  }
  // 「一刻钟」= 15 分钟，「三刻钟」= 45 分钟
  if ((match = new RegExp(`${DURATION_LEAD}(\\d{1,2}|[一两二三四])?\\s*刻钟`, 'u').exec(text))) {
    const quarters = match[1] ? cnToNumber(match[1]) : 1;
    if (quarters) return { minutes: quarters * 15, matched: match[0] };
  }
  // 「十分钟」「四十五分钟」：中文数字以前完全认不出，整句会退化成默认一小时
  // 英文单位：「30min」「1.5h」「2 hours」。不认的话会静默按默认一小时算，
  // 而那截「30min」还会留在标题里。
  if ((match = new RegExp(`${DURATION_LEAD}(\\d+(?:\\.\\d+)?)\\s*(min(?:ute)?s?|hrs?|hours?|h)\\b`, 'iu').exec(text))) {
    const value = Number(match[1]);
    const isMinute = /^min/iu.test(match[2]);
    const minutes = Math.round(isMinute ? value : value * 60);
    if (minutes > 0) return { minutes, matched: match[0] };
  }
  if ((match = new RegExp(`${DURATION_LEAD}${DUR_NUM}\\s*分钟`, 'u').exec(text))) {
    const minutes = cnToNumber(match[1]);
    if (Number.isFinite(minutes) && minutes > 0) return { minutes, matched: match[0] };
  }
  return undefined;
}

const FILLERS = /^(?:帮我|请|麻烦|给我|我想要|我想|我要|想要|提醒我|提醒|叫我|添加|新增|加个|加一个|建个|安排|记一下|记个|创建一个|现在|马上|一会儿|待会儿|一个|个)\s*/u;
// 「的」不在这里清：它常是结构助词（「吃点好的」「我的生日」），砍掉会改掉意思。
// 时间片段被剔走后真正悬空的「的」，由 LEADING 和 DANGLING_DE 处理。
const TRAILING = /(?:吧|呀|啊|呢|哦|，|,|。|\.|、|\s)+$/u;
const LEADING = /^[的，,。.、:：\s]+/u;
/**
 * 时间/时长片段被剔走后，动词和宾语之间常留下一截悬空的助词：
 * 「吃个半小时的麻辣烫」→「吃个的麻辣烫」，「吃半小时的麻辣烫」→「吃的麻辣烫」。
 * 用 lookbehind 限定前面是动作动词，免得把「我的生日」砍成「我生日」；
 * 只清「个/了/过 + 的」这类残渣，正常的「洗个澡」里没有「的」，不受影响。
 */
const DANGLING_DE = /(?<=[吃喝买点做逛看玩打约聊谈见取送拿办找学考洗剪寄借还换练读背写画刷修])(?:个|了|过)?的(?=\S)/gu;

function cleanTitle(text) {
  let title = text.replace(LEADING, '');
  for (let i = 0; i < 4; i += 1) {
    title = title.replace(FILLERS, '').replace(LEADING, '');
  }
  // 「日程/会议/安排」一般是噪声前缀（「帮我安排个…」），但整句就剩它一个词时
  // （「3:00 会议」），它就是标题本身，剥掉会得到空标题。
  // 必须独立成词（后面是空白或句尾）才剥：「会议室」里的「会议」不是噪声，
  // 否则「周五下午两点 会议室 周会」会被削成「室周会」。
  const noise = /^(?:帮我|请|麻烦)?\s*(?:日程|会议|安排)(?=\s|$)/u.exec(title);
  if (noise && title.slice(noise[0].length).replace(LEADING, '').trim()) {
    title = title.slice(noise[0].length);
  }
  // 括号里的时间被剔走后会剩一对空括号：「吃麻辣烫（半小时）」→「吃麻辣烫（）」。
  // 连只有单边的残骸（「（」「）」）一起清掉。
  title = title.replace(/[（(【\[「『]\s*[）)】\]」』]/gu, '');
  title = title.replace(/[\s，,、]?[（(【\[「『]+\s*$/u, '').replace(/^[\s，,、]*[）)】\]」』]+/u, '');
  title = title.replace(LEADING, '').replace(TRAILING, '');
  // 地点被剔掉后常剩下悬空的「，在」「、到」这类碎片，一并清掉。
  title = title.replace(/[\s，,、;；:：]+[在到去于]$/u, '').replace(/[\s，,、;；:：]+$/u, '');
  // strip() 用空格占位，纯中文标题里不该留这些空格（英文/数字标题要保留）
  if (!/[A-Za-z0-9]/u.test(title)) title = title.replace(/\s+/gu, '');
  title = title.replace(DANGLING_DE, '');
  title = title.replace(/\s{2,}/gu, ' ').trim();
  return title;
}

const PLACE = '[^\\s，,。；;、]+';

/**
 * 地名尾巴。用来在没有「地点：」前缀时，给「在 X 学习」切出地点的右边界。
 * 靠 landmarkEnd() 逐个位置试，不依赖这里的排列顺序。
 */
const LANDMARKS = [
  '图书馆', '教学楼', '实验楼', '体育馆', '办公楼', '会议室', '报告厅', '实验室', '办公室',
  '教室', '食堂', '宿舍', '操场', '礼堂', '活动中心', '服务中心', '医务室', '医院', '超市',
  '咖啡厅', '咖啡馆', '书店', '公园', '车站', '机场', '酒店', '餐厅', '门口', '大门', '楼下',
  '校区', '校园', '学校', '大学', '学院', '中心', '楼', '馆', '厅', '室', '店',
  '澡堂', '澡堂子', '浴室', '游泳馆', '洗衣房', '卫生间', '洗手间', '厕所',
  // 常去的店：不加这些就得靠模型兜，而模型隔着网络才知道「星巴克」是地点
  '星巴克', '麦当劳', '肯德基', '瑞幸', '便利店', '健身房', '自习室', '打印店', '快递站', '驿站',
  // 口语里最高频的几个泛地点。少了它们，「在万达」「去公司开会」会把整截话留在标题里
  '公司', '单位', '家里', '万达', '海底捞', '银行', '影院', '电影院', '菜市场', '地铁站',
];
/**
 * 在「华东理工大学图书馆学习」里找地名的右边界。
 *
 * 逐个字符位置试，同一位置取**最短**的地名（「八号楼」而不是「八号楼上」），
 * 整体取**起点最靠后**的位置（「华东理工大学图书馆」不会停在中间的「大学」）。
 */
function landmarkEnd(phrase) {
  let bestEnd = 0;   // 多字地名（图书馆 / 食堂 / 楼下）
  let singleEnd = 0; // 单字地名（楼 / 馆 / 厅），只在没有多字地名时兜底
  for (let index = 0; index < phrase.length; index += 1) {
    for (const word of LANDMARKS) {
      if (!phrase.startsWith(word, index)) continue;
      const end = index + word.length;
      if (word.length === 1) {
        // 单字地名不能在开头自成地名，得挂在「三号楼」这种前缀后面
        if (index > 0 && end > singleEnd) singleEnd = end;
      } else if (end > bestEnd) {
        bestEnd = end;
      }
    }
  }
  return bestEnd > singleEnd ? bestEnd : singleEnd;
}

/** 「教三」「三教」「八号楼」这类校园建筑名，后面通常还跟着房间号。 */
const CAMPUS_BUILDING = /^(?:教[一二三四五六七八九十\d]{1,2}|[一二三四五六七八九十\d]{1,3}教|[一二三四五六七八九十\d]{1,3}号?楼)/u;

/**
 * 地名后面紧跟门牌号时并进地点：「学院楼302」「教三201」「八号楼3-201」。
 *
 * 排除「食堂3楼」这种楼层写法，否则地点会变成「食堂3」、标题里剩一个「楼」。
 */
function extendRoom(phrase, end) {
  const room = /^([A-Za-z]?\d{1,4}(?:[-－]\d{1,4})?)(?![楼层栋号室])/u.exec(phrase.slice(end));
  return room ? end + room[1].length : end;
}

/**
 * 「在华东理工大学图书馆学习高等数学」→ 地点「华东理工大学图书馆」。
 *
 * 「在/到/去」后面紧跟时间（到十点…）不算地点，用负向断言跳过；
 * 多个候选时取最靠右的那个，因为真正的介词短语通常在时间后面。
 */
function parseInlinePlace(text) {
  // 负向断言必须含冒号：否则「…到9:30在图书馆里…」里的「到9:30」会被当成
  // 介词引出的地点，整段被读成「9:30在图书馆」。冒号式钟点以前漏在 [点时] 之外。
  const re = /(?:在|到|去)\s*(?![\d一二两三四五六七八九十]{1,3}\s*[点时:：])([^，,。；;、\s]{2,30})/gu;
  const hits = [];
  let found;
  while ((found = re.exec(text)) !== null) hits.push(found);

  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const match = hits[i];
    const phrase = match[1];
    let end = landmarkEnd(phrase);
    // 「在教三201交作业」：LANDMARKS 里没有「教三」，靠校园建筑写法补上
    if (end < 2) {
      const building = CAMPUS_BUILDING.exec(phrase);
      if (building) end = building[0].length;
    }
    if (end < 2) continue;
    end = extendRoom(phrase, end);
    const prefix = match[0].length - phrase.length;
    return { location: phrase.slice(0, end), matched: match[0].slice(0, prefix + end) };
  }
  return undefined;
}

/** Pull an explicit place out of the sentence: "地点写XX"、"地址：XX"、"@XX"、以及「在XX开会」。 */
function parseLocation(text) {
  // ① 带分隔符或动词：「地点：图书馆」「地点写图书馆」「地址在图书馆」
  let match = new RegExp(`(?:地点|地址|位置)\\s*(?:[:：]|写|设|是|为|在)\\s*[:：]?\\s*(${PLACE})`, 'u').exec(text);
  if (match) return { location: match[1].trim(), matched: match[0] };

  // ② @图书馆。PLACE 是贪婪的，「@大学#生活」会把后面的标签一起吞进地点，
  //    变成「大学#生活」；按地名词表切右边界，剩下的留给标签识别。
  match = new RegExp(`@\\s*(${PLACE})`, 'u').exec(text);
  if (match) {
    const phrase = match[1].trim();
    let end = landmarkEnd(phrase);
    if (end < 2) {
      const building = CAMPUS_BUILDING.exec(phrase);
      if (building) end = building[0].length;
    }
    if (end >= 2) {
      const prefix = match[0].length - phrase.length;
      return { location: phrase.slice(0, end), matched: match[0].slice(0, prefix + end) };
    }
    return { location: phrase, matched: match[0] };
  }

  // ③ 不带分隔符（「地点图书馆」）。这里必须真的是地名，
  //    否则「测试地点识别」这种标题里的「地点」会被当成前缀，把「识别」读成地点。
  match = /(?:地点|地址|位置)\s*([^，,。；;、\s]{2,30})/u.exec(text);
  if (match) {
    const phrase = match[1];
    const end = landmarkEnd(phrase);
    if (end >= 2) {
      const prefix = match[0].length - phrase.length;
      return { location: phrase.slice(0, end), matched: match[0].slice(0, prefix + end) };
    }
  }

  // ④ 带房间号的教学楼 / 楼号：「三教201交作业」「八号楼302 开会」。
  //    句首或句中都认（「明天下午三点 教三201 交作业」以前会把地点烂在标题里）。
  //    必须带门牌号，否则「三教活动」「八号楼开会」这种普通名词会被误当地点。
  match = /(?:^|[，,、\s])((?:教[一二三四五六七八九十\d]{1,2}|[一二三四五六七八九十\d]{1,3}教|[一二三四五六七八九十\d]{1,3}号?楼)\s*([A-Za-z]?\d{2,4}(?:[-－]\d{1,4})?))/u.exec(text);
  if (match) {
    return { location: match[1].replace(/\s+/gu, ''), matched: match[1] };
  }

  return parseInlinePlace(text);
}

/**
 * 方位词后缀：「在图书馆里学习」的「里」是状语的一部分，既不是地名也不是标题。
 * 返回该从标题里剔掉的那截，没有则空串。
 *
 * 「上」后面接「课/班/网…」时是动词（上课/上班），不是方位词；
 * 「中文 / 内部 / 下午」同理。用负向断言挡住，免得削掉半个词。
 */
const PLACE_TAIL = new RegExp(
  '^(?:'
    + '里(?:面|边|头)?'
    + '|中(?:间)?(?!文|国|心|午|年|央|医|药|学|考|秋|旬|级|层|途|止|奖)'
    + '|内(?!部|容|心|衣|科|行|政|陆|地|存|外)'
    + '|外(?:面|边|头)?'
    + '|旁边|旁'
    + '|这儿|这里|那儿|那里|这边|那边'
    + '|上面|上边|上头|上(?!课|班|网|学|线|门|车|山|楼|床|台|岗|进|任|市|映|诉|访|述|升|涨|海|午|座|厕|机|船|菜|货|架|锁|弦|香|供|报|当|辈|面|边|头)'
    + '|下面|下边|下头|下(?!午|班|课|楼|车|雨|雪|单|载|降|棋|来|去|面|边|头)'
    + ')', 'u');

function placeTail(rest, location = '') {
  // 地名本身以方位词收尾（「家里」「楼下」）时，后面再跟「面/边/头」
  // 是同一个方位词的下半截：「家里面」不该把「面」留在标题里。
  if (/[里上中内外下]$/u.test(location)) {
    const half = /^(?:面|边|头)/u.exec(rest);
    if (half) return half[0];
  }
  return PLACE_TAIL.exec(rest)?.[0] ?? '';
}

/**
 * 把地点短语后面（或显式地点串内部）的方位词并进 matched，供 strip 一起删掉。
 *
 * ① 「地点：图书馆里自习」「@图书馆里自习」：PLACE 贪婪把动作也吞进了 location，
 *    要把 location 切回「图书馆」、matched 截到方位词为止，把「自习」还给标题。
 * ② 「在图书馆里学习」：方位词紧跟在原文地点片段之后，直接加进 matched。
 */
function refineLocation(text, part) {
  const end = landmarkEnd(part.location);
  if (end >= 2 && end < part.location.length) {
    const tail = placeTail(part.location.slice(end), part.location.slice(0, end));
    if (tail) {
      const keep = end + tail.length;
      part.matched = part.matched.slice(0, part.matched.length - (part.location.length - keep));
      part.location = part.location.slice(0, end);
      return;
    }
  }
  const chars = part.matched.replace(/\s+/gu, '').split('')
    .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!chars.length) return;
  const hit = new RegExp(chars.join('\\s*'), 'u').exec(text);
  if (!hit) return;
  const tail = placeTail(text.slice(hit.index + hit[0].length), part.location);
  if (tail) part.matched += tail;
}

/**
 * Pull a calendar / tag name out of the sentence.
 *
 * 支持的写法（`names` 是已知日历名，用于「裸名字」识别）：
 *   「明天三点开会 #工作」      → 工作
 *   「明天三点开会 标签：工作」  → 工作
 *   「明天三点开会，加到工作日历」→ 工作
 *   「明天三点开会 工作」        → 工作（仅当「工作」确实是你的日历名）
 */
export function parseCalendarTag(text, names = []) {
  const known = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  const STOP = new Set(['日历', '日程', '我的', '默认', '这个', '那个', '它', '列表']);

  // #标签。必须排除 @ / ＠：「@大学」是地点语法，紧贴在标签后面时
  // （「#学习@大学」）不能被当成日历名的一部分，否则会写一个不存在的日历。
  let match = /#\s*([^\s#@＠，,。;；:：]+)/u.exec(text);
  if (match) {
    const raw = match[1];
    // 「#学习半个小时」「#工作明天」：标签后面没空格、直接跟了时长/时间词时，
    // 那截不属于日历名。整个吞掉会写到「学习半个小时」这个不存在的日历上去。
    // 已知日历名优先按前缀精确切；未知名字按常见时长/时间词兜着切。
    let name = raw;
    const exact = known.find((candidate) => raw.startsWith(candidate) && raw.length > candidate.length);
    if (exact) name = exact;
    else {
      const tail = /(?:半|[一两二三四五六七八九十]{1,3}|\d+(?:\.\d+)?)\s*个?\s*(?:小时|钟头|分钟)|用时|用了|花费|大概|大约|预计|约|提前|提醒|明天|今日|今天|后天|晚上|下午|上午|早上|中午/u.exec(raw);
      if (tail && tail.index > 0) name = raw.slice(0, tail.index);
    }
    // matched 保持原文整段：那截时长本来也不该留在标题里，strip 会一起删掉。
    return { calendar: name, matched: match[0] };
  }

  // 标签：工作 / 分类: 工作（同样不能把后面的「@地点」吞进名字）
  match = /(?:标签|分类|类别)\s*[:：]?\s*([^\s@＠，,。;；]{1,12})/u.exec(text);
  if (match && !STOP.has(match[1])) return { calendar: match[1], matched: match[0] };

  // 加到 X 日历 / 放进 X 日历 / 记到 X 日历
  const verb = '(?:添加|加|放|记|写|存|归|同步|保存|塞)(?:到|进|在|入)';
  match = new RegExp(`${verb}\\s*([^\\s，,。;；:：]{1,12})\\s*日历`, 'u').exec(text);
  if (match && !STOP.has(match[1])) return { calendar: match[1], matched: match[0] };

  // 名称直接跟「日历」：「工作日历」——只认已知名字，避免把标题里的字吃掉
  match = /([^\s，,。;；:：]{1,12})\s*日历/u.exec(text);
  if (match && known.includes(match[1])) return { calendar: match[1], matched: match[0] };

  // 已知日历名作为独立词出现：结尾的「学习」、括号里的「（工作）」
  for (const name of known) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s，,、:：]|到|进|在)(${escaped})(?=$|[\\s，,、。;；)）])`, 'u');
    const hit = re.exec(text);
    if (hit) return { calendar: name, matched: hit[1] };
  }

  return undefined;
}

/**
 * 相对时间：「半小时后」「20 分钟后」「一个半小时后」。
 * 和「学习一小时」这种时长要分开——只认后面带「后 / 之后 / 以后」的写法。
 */
function parseRelative(text) {
  const match = /(半|\d{1,3}|[一二两三四五六七八九十]{1,3})\s*个?\s*(半)?\s*(小时|钟头|分钟)\s*(?:之后|以后|后)/u.exec(text);
  if (!match) return undefined;
  const count = match[1] === '半' ? 0.5 : cnToNumber(match[1]);
  if (!Number.isFinite(count) || count <= 0) return undefined;
  const minutes = match[3] === '分钟' ? count : count * 60;
  return { minutes: minutes + (match[2] ? 30 : 0), matched: match[0] };
}

/**
 * 提醒：「提前半小时提醒我」「提前 10 分钟」。
 *
 * 写进 ics 的 VALARM，响铃交给系统日历——App 没签名，自己发通知大概率不生效。
 */
export function parseAlarm(text) {
  // 整天级别的提醒：「提前一天」「提前两天提醒」
  // 「提醒我」可能在前面（「提醒我提前十分钟」）也可能在后面（「提前十分钟提醒我」），两边都吃
  const LEAD = '(?:(?:提醒我|提醒|叫我|记得|别忘了|别忘)\\s*)?';
  const days = new RegExp(`${LEAD}提前\\s*(半|\\d{1,3}|[一二两三四五六七八九十]{1,3})\\s*个?\\s*(天|日)\\s*(?:提醒我|提醒|叫我)?`, 'u').exec(text);
  if (days) {
    const count = days[1] === '半' ? 0.5 : cnToNumber(days[1]);
    if (Number.isFinite(count) && count > 0) {
      return { minutes: Math.round(count * 24 * 60), matched: days[0] };
    }
  }

  // 连「提醒/叫我」一起吃掉，否则标题尾巴会剩一个「提醒」
  const match = new RegExp(`${LEAD}提前\\s*(半|\\d{1,3}|[一二两三四五六七八九十]{1,3})\\s*个?\\s*(小时|钟头|分钟)\\s*(?:提醒我|提醒|叫我)?`, 'u').exec(text);
  if (!match) return undefined;
  const count = match[1] === '半' ? 0.5 : cnToNumber(match[1]);
  if (!Number.isFinite(count) || count <= 0) return undefined;
  const minutes = match[2] === '分钟' ? count : count * 60;
  return { minutes, matched: match[0] };
}

/**
 * 「#全天」——唯一能明确要求「建一条全天日程」的写法。
 *
 * 为什么用 # 前缀而不是直接认「全天」两个字：
 *   1) 「全天」是个普通词，混在句子里（「全天班」「全天候」）容易误伤；
 *   2) 它和日历标签是同一套语法，写在一句话里就能和 #生活 并列；
 *   3) 带 # 的写法在界面上会被当成一个独立片段标出来，用户能看见自己确实说过。
 *
 * 后面紧跟汉字的（#全天会议）不算：那是一个叫「全天会议」的日历名。
 */
const ALL_DAY_TAG = /#[ \t]*全天(?![^\s，,。;；:：、）)】\]」』])/u;

/**
 * Parse a sentence into event fields.
 * @param {string} input
 * @param {Date} [now]
 * @param {{ calendarNames?: string[] }} [options]
 * @returns {{ title: string, start: Date, end: Date, allDay: boolean, matched: string[], durationAssumed: boolean, location?: string, calendar?: string }}
 */
export function parseEvent(input, now = new Date(), options = {}) {
  const text = normalize(input);
  // 每一段识别结果都带上类型，界面据此给原文上色（date / time / location / tag / repeat / allday）
  const pieces = [];
  let repeatInfo;

  // #全天 要先摘出来：否则它会被下面的标签识别读成一个叫「全天」的日历名，
  // 写进去时会报「日历不存在」，碰上同名日历则更糟——静默落到别的日历里。
  const allDayTag = ALL_DAY_TAG.exec(text);
  const forcedAllDay = Boolean(allDayTag);
  if (allDayTag) pieces.push({ text: allDayTag[0], kind: 'allday' });
  const tagText = allDayTag ? text.replace(ALL_DAY_TAG, ' ') : text;

  const calPart = parseCalendarTag(tagText, options.calendarNames ?? []);
  if (calPart) {
    pieces.push({ text: calPart.matched, kind: 'tag' });
    // 一句话挂多个标签时，第一个当日历，剩下的也得剔出标题，
    // 否则「吃麻辣烫 #生活 #吃饭」会剩下「吃麻辣烫#吃饭」。
    if (calPart.matched.startsWith('#')) {
      for (const extra of text.matchAll(/#\s*([^\s#@＠，,。;；:：]+)/gu)) {
        if (extra[0] !== calPart.matched && !pieces.some((piece) => piece.text === extra[0])) {
          pieces.push({ text: extra[0], kind: 'tag' });
        }
      }
    }
  }
  const calendar = calPart?.calendar;

  const locPart = parseLocation(text);
  if (locPart) {
    // 方位词「里/上/中/内」是地点状语的尾巴，不是标题也不是地名：
    // 并进 matched 让 strip 一起删掉，显式地点串里被吞掉的动作还给标题。
    refineLocation(text, locPart);
    pieces.push({ text: locPart.matched, kind: 'location' });
  }
  const location = locPart?.location;

  const alarm = parseAlarm(text);
  if (alarm) pieces.push({ text: alarm.matched, kind: 'alarm' });

  // 三个出口（相对时间 / 全天 / 常规）共用；调用时 pieces 已经填满
  const finish = (fields) => {
    let title = cleanTitle(strip(text, pieces.map((piece) => piece.text)));
    let place = location;
    // 「后天 去银行」「九点四十五 到公司」：介词短语本身就是整件事，
    // 切成地点后标题就空了。把那段原文还回标题，别建一条没有名字的日程。
    // 只管「在/到/去」这种介词短语：显式写的「地点：X」「@X」按既有规格保持空标题。
    if (!title && place && locPart && /^(?:在|到|去)/u.test(locPart.matched)) {
      title = cleanTitle(locPart.matched);
      place = undefined;
    }
    // 「每两周复查一次」结尾的「一次」说的是频率，不是要做的事。
    // 只在有重复规则时才清，免得把「买一次菜」这种正常标题砍掉。
    const trimmed = repeatInfo ? title.replace(/\s*(?:一|两|二|三|\d{1,2})\s*(?:次|回|遍)\s*$/u, '').trim() : title;
    return {
      title: trimmed || title,
      matched: pieces.map((piece) => piece.text),
      spans: locateSpans(text, pieces),
      location: place,
      calendar,
      repeat: repeatInfo,
      alarmMinutes: alarm?.minutes ?? null,
      ...fields,
    };
  };

  // 相对时间（「半小时后」「20 分钟后」）直接以当前时刻为基准，不再走日期/钟点那套。
  const relative = parseRelative(text);
  if (relative) {
    pieces.push({ text: relative.matched, kind: 'time' });
    const relStart = new Date(now.getTime() + relative.minutes * 60000);
    // 「2小时后开会」说的是**什么时候开始**，不是「开多久」。
    // 以前直接拿这个偏移当长度，于是 2 小时后的会真的开了两小时。
    // 只有句子里另说了长度（「2小时后开会，用半小时」）才按它算。
    const rest = text.replace(relative.matched, ' '.repeat(relative.matched.length));
    const relDuration = parseDuration(rest);
    if (relDuration) pieces.push({ text: relDuration.matched, kind: 'duration' });
    const length = relDuration?.minutes ?? 60;
    const relEnd = new Date(relStart.getTime() + length * 60000);
    return finish({ start: relStart, end: relEnd, allDay: false, durationAssumed: !relDuration, rolled: false });
  }

  // 重复规则要先于普通日期判断：「每周三」里的「周三」本来会被读成本周三
  const repeat = parseRepeat(text);
  let datePart;
  if (repeat) {
    repeatInfo = {
      freq: repeat.freq,
      byday: repeat.byday ?? null,
      bymonthday: repeat.bymonthday ?? null,
      interval: repeat.interval ?? 1,
      text: repeat.matched,
    };
    datePart = { date: repeatStartDate(repeat, now), matched: repeat.matched, evening: false };
    pieces.push({ text: repeat.matched, kind: 'repeat' });
  } else {
    datePart = parseDate(text, now);
    if (datePart.matched) {
      // 「周五前交作业」「周五之前交作业」：截止日前的「前/之前」也算时间词，
      // 不然标题里会剩一个孤零零的「前」。
      const escaped = datePart.matched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const deadline = new RegExp(`${escaped}(之?前)`, 'u').exec(text);
      if (deadline) datePart = { ...datePart, matched: deadline[0] };
      pieces.push({ text: datePart.matched, kind: 'date' });
    }
  }

  // 「整天 / 一整天 / 全天」是修饰语，不该留在标题里。
  // 但「全天候」「全天班」「全日制」是词的一部分，剔掉会剩下半个词。
  // 在 tagText 上找：#全天 已经被挖空，否则会把自己这个标记也当成修饰语再剔一次。
  const wholeDay = /(?:一整天|整天|全天(?!候|班|制))/u.exec(tagText);
  if (wholeDay) pieces.push({ text: wholeDay[0], kind: 'time' });

  // 日期后面补个空格再找钟点：「下周二十点」不会被读成「二十点」，
  // 同时保住「明晚」这类自带时段的写法（时段要靠它判断上下午）。
  // 提醒片段先挖掉，否则「提前半小时提醒」里的「半小时」会被当成长度。
  let timeText = datePart.matched ? text.replace(datePart.matched, `${datePart.matched} `) : text;
  if (alarm) timeText = timeText.replace(alarm.matched, '　'.repeat(alarm.matched.length));

  // 时长先认出来（「用时十分钟」「大概半小时」）。它有两个用处：
  //   1) 单点时刻的结束时间；
  //   2) 即使区间已经给了结束时间，这截话也得从标题里删掉，不然会留下「，用时十分钟」。
  const duration = parseDuration(timeText);
  if (duration) pieces.push({ text: duration.matched, kind: 'duration' });

  // Range first ("六点半到八点半"), then a single clock plus duration.
  // 结束侧允许带日期词（「今晚十点到明天凌晨一点」），否则整段区间认不出来，
  // 结束时间会退化成默认 1 小时、标题里还留一截「到明天一点」。
  const rangeRe = new RegExp(
    `(${CLOCK_PERIOD})?\\s*(\\d{1,2}|[零一二两三四五六七八九十]{1,3})\\s*(?:点|时|:)\\s*(${MINUTE})?\\s*[分整]?\\s*(?:到|至|-|~|—|–)\\s*(明天|明日|明早|明晚|后天|次日|翌日|今天|今日|今晚)?\\s*(${CLOCK_PERIOD})?\\s*(\\d{1,2}|[零一二两三四五六七八九十]{1,3})\\s*(?:点|时|:)?\\s*(${MINUTE})?`,
    'u',
  );
  const range = rangeRe.exec(timeText);

  let start;
  let end;
  let durationAssumed = false;
  // 起点是不是被「晚上十二点」推到了第二天零点的
  let startDayOffset = 0;

  // 「现在到明天中午 赶论文」不是「两个钟点」的区间：单点解析会只抓到
  // 「十点」那一个时刻，把起点丢掉。所以必须抢在 range / 单点之前处理。
  const fromNow = /(?:从|自)?\s*(?:现在|此刻|这会儿)\s*(?:到|至|-|~|—|–)\s*(今天|今日|明天|明日|后天|次日)?\s*(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|夜间)?\s*(?:(\d{1,2}|[零一二两三四五六七八九十]{1,3})\s*[点时:：]\s*(半|一刻|三刻|\d{1,2})?)?/u.exec(text);
  if (fromNow && (fromNow[2] || fromNow[3])) {
    const dayShift = !fromNow[1] ? 0 : /后天|次日/u.test(fromNow[1]) ? 2 : /明天|明日/u.test(fromNow[1]) ? 1 : 0;
    const hour = fromNow[3]
      ? applyPeriod(cnToNumber(fromNow[3]), fromNow[2])
      : PERIOD_HOUR[fromNow[2]];
    const rawMinute = fromNow[4];
    const minute = rawMinute === '半' ? 30
      : rawMinute === '一刻' ? 15
        : rawMinute === '三刻' ? 45
          : rawMinute ? cnToNumber(rawMinute) : 0;
    if (Number.isFinite(hour) && hour >= 0 && hour <= 23) {
      const day = startOfDay(now);
      day.setDate(day.getDate() + dayShift);
      let until = new Date(day);
      until.setHours(hour, Number.isFinite(minute) ? minute : 0, 0, 0);
      // 「现在到十点」在晚上说，指的是今晚十点而不是明早十点
      if (until <= now && hour >= 1 && hour <= 11) {
        const later = new Date(until.getTime() + 12 * 3600000);
        if (later > now) until = later;
      }
      if (until <= now) until = new Date(until.getTime() + 86400000);
      pieces.push({ text: fromNow[0].replace(/\s+/gu, ''), kind: 'time' });
      start = new Date(now.getTime());
      start.setSeconds(0, 0);
      end = until;
    }
  }

  if (!start && range) {
    // 「从三点到五点」连前面的「从/自」一起吃掉，否则标题会剩一个孤零零的「从」
    const lead = /[从自]\s*$/u.test(timeText.slice(0, range.index)) ? timeText[range.index - 1] : '';
    pieces.push({ text: `${lead}${range[0]}`, kind: 'time' });
    const startClock = parseClock(`${range[1] ?? ''}${range[2]}点${range[3] ?? ''}`);
    const endClock = parseClock(`${range[6]}点${range[7] ?? ''}`);
    // 结束侧的日期词：写了「到明天」就按明天算，别再靠「往后找一小时」猜。
    // 偏移必须相对**句首日期**换算：「明天下午三点到明天五点」是同一天，
    // 一看到「明天」就再加一天会推到后天。
    const endDay = range[4] ?? '';
    const shiftOf = (word) => {
      if (!word) return null;
      if (/后天/u.test(word)) return 2;
      if (/明天|明日|次日|翌日|明早|明晚/u.test(word)) return 1;
      if (/今天|今日|今晚/u.test(word)) return 0;
      return null;
    };
    const explicitShift = shiftOf(endDay) ?? shiftOf(range[5]);
    const baseShift = Math.round((startOfDay(datePart.date) - startOfDay(now)) / 86400000);
    const endDayOffset = explicitShift == null ? 0 : explicitShift - baseShift;

    // 「晚上十二点到…」的起点属于第二天零点
    const base = new Date(datePart.date);
    if (startClock?.dayOffset) {
      base.setDate(base.getDate() + startClock.dayOffset);
      startDayOffset = startClock.dayOffset;
    }
    if (startClock) {
      start = new Date(base);
      start.setHours(startClock.hour, startClock.minute, 0, 0);
    }
    if (endClock && start) {
      // 结束时间以「今天」为原点算，独立于起点被推到了哪天
      const at = (dayOffset, hour) => {
        const date = new Date(datePart.date);
        date.setDate(date.getDate() + dayOffset);
        date.setHours(hour, endClock.minute, 0, 0);
        return date;
      };
      if (range[5]) {
        // An explicit end period wins: "晚上11点到凌晨1点".
        // 结束侧也可能是单字缩略（「晚八点到晚十点」），照样归一化。
        const periodHour = applyPeriod(endClock.hour, normalizePeriod(range[5]));
        end = at(endDayOffset, periodHour);
        if (end <= start) end = at(endDayOffset + 1, periodHour);
      } else {
        // 没有结束时间前缀：在「今天/明天 × 该钟点(±12)」里挑最短且不超过 12 小时的那个。
        // 上限很重要，否则「八点到八点四十」会被挑成次日 20:00。
        // 写了「到明天」就只在明天这一档里挑，不回头挑今天。
        const dayBase = explicitShift != null ? endDayOffset : startDayOffset;
        const candidates = [];
        for (const dayOffset of [dayBase, dayBase + 1]) {
          for (const hour of [endClock.hour, endClock.hour + 12]) {
            const candidate = at(dayOffset, hour);
            const gap = candidate.getTime() - start.getTime();
            if (gap > 0 && gap <= 12 * 3600000) candidates.push(candidate);
          }
        }
        candidates.sort((left, right) => left - right);
        end = candidates[0];
      }
    }
  } else if (!start) {
    const clock = parseClock(timeText);
    if (clock) {
      pieces.push({ text: clock.matched, kind: 'time' });
      start = new Date(datePart.date);
      if (clock.dayOffset) {
        start.setDate(start.getDate() + clock.dayOffset);
        startDayOffset = clock.dayOffset;
      }
      start.setHours(clock.hour, clock.minute, 0, 0);
    }
    // 时长在上一步已经认过并从标题里剔掉了，这里只负责用它算结束时间
    if (duration && start) end = new Date(start.getTime() + duration.minutes * 60000);
  }

  // 没紧跟钟点的裸时段词（「中午我想要十二点半…」里的「中午」）同样是时间信息，
  // 已经有钟点时就从标题里剥掉，不然它会和「我想要」一起留在标题开头。
  if (start) {
    for (const found of text.matchAll(new RegExp(PERIOD, 'gu'))) {
      if (!pieces.some((piece) => piece.text.includes(found[0]))) pieces.push({ text: found[0], kind: 'period' });
    }
  }

  if (!start) {
    // 只说了「周五中午」这种时段、没给具体钟点：按时段给个默认钟点。
    // 否则「中午」会掉成当天 00:00 的全天事件。
    const periodHit = new RegExp(PERIOD, 'u').exec(text);
    const periodHour = PERIOD_HOUR[periodHit?.[0] ?? ''];
    if (periodHour !== undefined) {
      if (periodHit) pieces.push({ text: periodHit[0], kind: 'period' });
      start = new Date(datePart.date);
      start.setHours(periodHour, 0, 0, 0);
      // 「中午吃麻辣烫，用半小时」：时段定起点，时长定终点。
      // 以前这里不认识 duration，半小时被认掉了却仍按一小时算。
      if (duration) {
        end = new Date(start.getTime() + duration.minutes * 60000);
        durationAssumed = false;
      } else {
        end = new Date(start.getTime() + 3600000);
        durationAssumed = true;
      }
    }
  }

  // 写了 #全天：不管句子里有没有钟点，都按「那天 00:00 到次日 00:00」建一条全天日程。
  // 钟点和时长这时只剩一个作用——被上面那些分支认出来、从标题里剔掉，
  // 所以「明天下午三点开会 #全天」得到的是「明天 · 全天 · 开会」，不是 15:00 的会议。
  if (forcedAllDay) {
    if (!datePart.matched) {
      throw new Error('全天日程也要说清是哪一天，例如「明天 交作业 #全天」');
    }
    const dayStart = new Date(datePart.date);
    return finish({
      start: dayStart,
      end: new Date(dayStart.getTime() + 86400000),
      allDay: true,
      durationAssumed: false,
      rolled: false,
    });
  }

  if (!start) {
    if (!datePart.matched) throw new Error('没能从这句话里找到时间，请说清楚日期和时间，例如「明天下午三点到四点开会」');
    // 只说了「20 分钟」却没说几点开始：以前按全天 24 小时写进去，用户明说的时长
    // 被静默吞掉。宁可让他补一句钟点，也不猜一个起点（和「每周三次」直接报错同理）。
    if (duration) {
      throw new Error('说了时长却没说几点开始，请补一句钟点，例如「明天上午九点 开会 20分钟」。');
    }
    // 没说钟点、只说了日期：整天都算，做成全天日程。
    start = new Date(datePart.date);
    const nextDay = new Date(start.getTime() + 86400000);
    return finish({ start, end: nextDay, allDay: true, durationAssumed: false, rolled: false });
  }

  if (datePart.evening && !startDayOffset && start.getHours() < 12) {
    start.setHours(start.getHours() + 12);
  }

  // 先把结束时间定下来，才能判断这个时段是不是整个过去了
  if (end && end.getTime() <= start.getTime()) {
    end = new Date(start.getTime() + 3600000);
    durationAssumed = true;
  }
  if (!end) {
    end = new Date(start.getTime() + 3600000);
    durationAssumed = true;
  }

  // 12 小时制消歧：下午四点说「六点到十点」，说的是今晚 18:00–22:00，
  // 不是「明天早上六点」。以前一律按早上算，再因为整段已过就顺延到明天，全错。
  //
  // 只有这几条同时成立才敢往下午推：
  //   没说哪一天（说了「今天」「明天」就照字面来）、不是重复日程、
  //   句子里没有「早上/下午/晚上」这类时段词（有就说明用户自己讲清楚了）、
  //   钟点在 1–11（12 点是中午、0 点是午夜，都不该动）、
  //   整段今天已经过完，但 +12 小时之后那一段还没走完，且刚开始不超过半小时
  //   （说明是「正要去做 / 刚开始」的事，不是「几小时前那档」）。
  // 为什么允许半小时：18:05 说「六点到十点」，18:00 刚过去五分钟，事情正在进行中；
  // 而 20:48 说「八点到十点」，20:00 已经过去四十八分钟，指的应该是明早，不是今晚。
  // 早上固定作息（上课、晨跑、站会…）不能往下午推：「8:40 上课」在晚上八点说，
  // 指的是明早的课，不是今晚八点四十上课。
  // 写成 24 小时制的（10:00 到 11:00）一个字都不许动：用户已经说得很精确了。
  const MORNING_HINT = /(上课|早课|早读|升旗|晨跑|站会|起床|早餐|早饭)/u;
  const LATE_GRACE = 30 * 60 * 1000;
  // 用 CLOCK_PERIOD 而不是 PERIOD：说了「晚八点」就是明说了时段，不该再被
  // 12 小时制消歧 / 凌晨兜底推走；「晚饭」则不算，避免把普通词当成明说时段。
  const saidPeriod = new RegExp(CLOCK_PERIOD, 'u').test(timeText);
  const explicitClock = /\d{1,2}\s*:\s*\d{2}/u.test(timeText);
  if (!datePart.matched && !repeatInfo && !saidPeriod && !explicitClock && !startDayOffset
    && !MORNING_HINT.test(text)) {
    const hour = start.getHours();
    const shifted = new Date(start.getTime() + 12 * 3600000);
    const shiftedEnd = new Date(end.getTime() + 12 * 3600000);
    if (
      hour >= 1 && hour <= 11
      && end.getTime() <= now.getTime()
      && shiftedEnd.getTime() > now.getTime()
      && now.getTime() - shifted.getTime() <= LATE_GRACE
    ) {
      start = shifted;
      end = shiftedEnd;
    }
  }

  // 「我不可能安排凌晨的日程」：钟点落在 0–5 点、句子里又没有「凌晨/半夜」这类词时，
  // 一律当成下午的同名钟点（三点 → 15:00）。上一段只能救「+12 之后还没到」的情形；
  // 下午六点说「三点到四点」，+12 得到的 15:00 也已经过去，会被一路顺延成
  // 「明天凌晨三点」—— 这不是常人会安排的日程。
  // 明说过 0 点/24 点、或者写成 3:00 这种 24 小时制时，尊重字面，不动。
  const saidNight = saidPeriod
    // 「早上五点」「上午五点」是用户自己讲清楚的钟点，不能按「没人凌晨安排日程」去推成下午。
    // 以前这份清单里只有「凌晨/半夜」这类词，于是早上五点被推到 17:00。
    || /(凌晨|半夜|深夜|午夜|夜里|夜间|一早|清晨|早上|早晨|上午)/u.test(text)
    || /(零点|24\s*点|0\s*点)/u.test(timeText);
  // 「晚上十二点」已经把起点推到第二天零点了，那是明说的午夜，别再推到中午
  const nightShifted = !saidNight && !explicitClock && !startDayOffset && start.getHours() < 6;
  if (nightShifted) {
    start = new Date(start.getTime() + 12 * 3600000);
    end = new Date(end.getTime() + 12 * 3600000);
  }

  // 没说哪天、而这个时段今天已经过完了 → 顺延。单次顺延到明天，
  // 重复日程顺延到它的下一个发生日（周四说「每周三下午三点」，从下周三算起）。
  // 还在进行中的（「晚上八点到十点」在 20:48 说）不算过完，留在今天。
  // 凌晨被纠正成下午的，若那一刻也已过去，同样要顺延到下一天，
  // 不然会生成一条「今天下午三点」的过期日程。
  let rolled = false;
  if (start.getTime() <= now.getTime() && end.getTime() <= now.getTime()) {
    const bump = (date) => {
      const next = new Date(date);
      if (repeatInfo?.freq === 'WEEKLY') {
        // 「每个工作日」在周四晚上说：下一个发生日是周五，不是下周四
        const days = (repeatInfo.byday ?? []).map((code) => REVERSE_DAY[code]).filter(Boolean);
        if (days.length) {
          for (let step = 1; step <= 7; step += 1) {
            const candidate = new Date(date);
            candidate.setDate(candidate.getDate() + step);
            const weekday = candidate.getDay() === 0 ? 7 : candidate.getDay();
            if (days.includes(weekday)) return candidate;
          }
        }
        next.setDate(next.getDate() + 7 * (repeatInfo.interval ?? 1));
      } else if (repeatInfo?.freq === 'MONTHLY') {
        next.setMonth(next.getMonth() + 1);
      } else {
        // DAILY：「每两天」的下一次是后天，不是明天
        next.setDate(next.getDate() + (repeatInfo?.interval ?? 1));
      }
      return next;
    };
    if (repeatInfo) {
      start = bump(start);
      end = bump(end);
      rolled = true;
    } else if (datePart.bareWeekday) {
      // 「周三上午九点答辩」在周三晚上说：字面解析出的是今天 09:00，已经过去了。
      // 说话人指的显然是还没到的那个周三，直接 +7 天，而不是留一条今天的过期日程。
      // 只影响裸写的周几；「今天上午九点」「这周三下午三点」这类明确指今天的照旧。
      start = new Date(start.getTime() + 7 * 86400000);
      end = new Date(end.getTime() + 7 * 86400000);
      rolled = true;
    } else if (!datePart.matched || nightShifted) {
      start = new Date(start.getTime() + 86400000);
      end = new Date(end.getTime() + 86400000);
      rolled = true;
    }
  }

  return finish({ start, end, allDay: false, durationAssumed, rolled });
}

function strip(text, fragments) {
  let result = text;
  // 片段是解析时临时插了空格的（「明晚 七点到九点」），
  // 原句里却没有空格，所以按「字与字之间可以有空白」来删。
  const list = fragments
    .filter(Boolean)
    .map((item) => item.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const fragment of list) {
    const chars = fragment.replace(/\s+/gu, '').split('');
    if (chars.length === 0) continue;
    const pattern = new RegExp(chars.map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'u');
    result = result.replace(pattern, ' ');
  }
  return result;
}
