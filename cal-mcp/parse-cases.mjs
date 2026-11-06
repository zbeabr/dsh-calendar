/**
 * 解析回归用例。跑法：node parse-cases.mjs
 *
 * 固定「现在」为 2026-11-04（周三）20:48，所以「今天下午一点半」这种
 * 已经过去的时刻应该被顺延到明天。
 */
// 用例是按中国时区的口语习惯写的（「下午三点」「20:48 已过就顺延」），
// 所以在任何机器上都固定成 +08:00 才可复现。不固定的话 CI（UTC）会挂 21 条。
process.env.TZ = 'Asia/Shanghai';

import { parseEvent } from './src/nlp.mjs';

// 必须用「本地时间」构造：解析器全程按本地时钟取年月日（getHours/getFullYear），
// 写成 '2026-11-04T20:48:00+08:00' 这种绝对时刻的话，在 UTC 的 CI 上换算出来是 12:48，
// 预期值会整体错位（实测 UTC 112/133、纽约 96/133）。用本地构造后，任何时区都是 20:48。
const NOW = new Date(2026, 10, 4, 20, 48);
const EVENING = new Date(2026, 10, 5, 18, 20);
const SUNDAY = new Date(2026, 10, 8, 10, 0);
const NAMES = ['学习', '家庭', '特别事件'];

const pad = (n) => String(n).padStart(2, '0');
const stamp = (date) => `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
const span = (start, end) => `${stamp(start)}-${pad(end.getHours())}:${pad(end.getMinutes())}`;

/** [句子, 期望标题, 期望地点, 期望标签, 期望时间, 是否顺延, 期望重复] */
const CASES = [
  ['明早八点到八点四十在华东理工大学图书馆学高数#学习', '学高数', '华东理工大学图书馆', '学习', '11-05 08:00-08:40', false],
  ['明天八点到八点四十在图书馆学高数', '学高数', '图书馆', undefined, '11-05 08:00-08:40', false],
  ['明，下午一点半 开会', '开会', undefined, undefined, '11-05 13:30-14:30', false],
  ['后，下午三点 开会', '开会', undefined, undefined, '11-06 15:00-16:00', false],
  ['大后 上午十点 体检', '体检', undefined, undefined, '11-07 10:00-11:00', false],
  ['今，晚上九点到十点 复盘', '复盘', undefined, undefined, '11-04 21:00-22:00', false],
  ['明天下午三点到四点开会', '开会', undefined, undefined, '11-05 15:00-16:00', false],
  ['明天上午九点半到十一点 组会', '组会', undefined, undefined, '11-05 09:30-11:00', false],
  ['明晚七点到九点 家教', '家教', undefined, undefined, '11-05 19:00-21:00', false],
  ['下周三晚上七点 在体育馆打球', '打球', '体育馆', undefined, '11-11 19:00-20:00', false],
  ['下下周一 上午九点 例会', '例会', undefined, undefined, '11-16 09:00-10:00', false],
  ['下周二十点 开会', '开会', undefined, undefined, '11-10 10:00-11:00', false],
  // 「下下」以前被吞掉：周三说「下下周五」得到的是 11-13，和「下周五」同一天。
  // 现在以「本周一」为原点数周：本周 11-02，下周 11-09，下下周 11-16。
  ['下下周五 开会', '开会', undefined, undefined, '11-20 00:00-00:00', false],
  ['下下周五 下午三点 组会', '组会', undefined, undefined, '11-20 15:00-16:00', false],
  ['下下周三 下午两点 答辩', '答辩', undefined, undefined, '11-18 14:00-15:00', false],
  // 「下下周周五」把「周」叠写了，意思和「下下周五」一样，不能退化成下周五
  ['下下周周五 下午三点 开会', '开会', undefined, undefined, '11-20 15:00-16:00', false],
  ['下下个周一 上午九点 例会', '例会', undefined, undefined, '11-16 09:00-10:00', false],
  // 说了「早上」就是早上。以前「早上五点」被「没人凌晨安排日程」的启发式推到 17:00
  ['明天早上五点 跑步', '跑步', undefined, undefined, '11-05 05:00-06:00', false],
  ['明天上午五点 赶火车', '赶火车', undefined, undefined, '11-05 05:00-06:00', false],
  // 24 点 = 次日零点
  ['明天24点 睡觉', '睡觉', undefined, undefined, '11-06 00:00-01:00', false],
  // 年份要一起吃掉，否则标题里剩一个「2027年」
  ['2027年3月15号 上午九点 开会', '开会', undefined, undefined, '03-15 09:00-10:00', false],
  ['明年3月15号 交材料', '交材料', undefined, undefined, '03-15 00:00-00:00', false],
  // 「2小时后」说的是开始时刻，不是持续时长（以前会开成两小时的会）
  ['2小时后 开会', '开会', undefined, undefined, '11-04 22:48-23:48', false],
  ['2小时后 开会 用半小时', '开会', undefined, undefined, '11-04 22:48-23:18', false],
  // 间隔后面的星期几也要进 BYDAY
  ['每两周周一和周三 健身', '健身', undefined, undefined, '11-04 00:00-00:00', false, 'WEEKLY INTERVAL=2 MO,WE'],
  ['每两周一次 复查', '复查', undefined, undefined, '11-04 00:00-00:00', false, 'WEEKLY INTERVAL=2'],
  // 「每月31号」在只有 30 天的月份要跳过，不能落在 12-01
  ['每月31号交房租', '交房租', undefined, undefined, '12-31 00:00-00:00', false, 'MONTHLY 31'],
  ['三号上午十点 复查', '复查', undefined, undefined, '12-03 10:00-11:00', false],
  ['十一月八号上午九点 答辩', '答辩', undefined, undefined, '11-08 09:00-10:00', false],
  ['11月8号下午两点 答辩', '答辩', undefined, undefined, '11-08 14:00-15:00', false],
  ['十点零五 交作业', '交作业', undefined, undefined, '11-04 22:05-23:05', false],
  // 不会安排凌晨的日程：没写时段词的三点/一点，一律按下午同名钟点算
  ['三点整 开会', '开会', undefined, undefined, '11-05 15:00-16:00', true],
  ['三点一刻 开会', '开会', undefined, undefined, '11-05 15:15-16:15', true],
  ['八点一刻到九点三刻 考试', '考试', undefined, undefined, '11-05 08:15-09:45', true],
  ['8:40到10:00 上课', '上课', undefined, undefined, '11-05 08:40-10:00', true],
  ['下午一点半 开会', '开会', undefined, undefined, '11-05 13:30-14:30', true],
  ['八点到十点 复盘', '复盘', undefined, undefined, '11-05 08:00-10:00', true],
  ['晚上八点到十点 复盘', '复盘', undefined, undefined, '11-04 20:00-22:00', false],
  ['北京时间下午一点半 开会', '北京时间开会', undefined, undefined, '11-05 13:30-14:30', true],
  ['今晚八点在图书馆三楼自习一小时', '自习', '图书馆三楼', undefined, '11-04 20:00-21:00', false],
  ['今天晚上九点到十点在华东理工大学图书馆学习高等数学，标签家庭。', '学习高等数学', '华东理工大学图书馆', '家庭', '11-04 21:00-22:00', false],
  ['明天三点 测试地点识别', '测试地点识别', undefined, undefined, '11-05 15:00-16:00', false],
  ['明天上午十点在八号楼上课', '上课', '八号楼', undefined, '11-05 10:00-11:00', false],
  ['明天三点 地点：图书馆', '', '图书馆', undefined, '11-05 15:00-16:00', false],
  ['中午我想要十二点半到十三点洗个澡，在澡堂', '洗个澡', '澡堂', undefined, '11-05 12:30-13:00', true],
  ['帮我记一下周六上午十点去校医院体检', '体检', '校医院', undefined, '11-07 10:00-11:00', false],
  ['等一下周六下午三点开会', '等一下开会', undefined, undefined, '11-07 15:00-16:00', false],

  // 重复日程（NOW 是周三 20:48）
  ['每周三下午三点到四点组会 #学习', '组会', undefined, '学习', '11-11 15:00-16:00', true, 'WEEKLY WE'],
  ['每天早上七点跑步', '跑步', undefined, undefined, '11-05 07:00-08:00', true, 'DAILY'],
  ['每周一三五晚上八点健身', '健身', undefined, undefined, '11-04 20:00-21:00', false, 'WEEKLY MO,WE,FR'],
  ['每个工作日早上九点站会', '站会', undefined, undefined, '11-05 09:00-10:00', true, 'WEEKLY MO,TU,WE,TH,FR'],
  ['每月8号交房租', '交房租', undefined, undefined, '11-08 00:00-00:00', false, 'MONTHLY 8'],

  // 常去的店也要能当地点，不必等模型
  ['明天下午三点在星巴克跟老王聊项目', '跟老王聊项目', '星巴克', undefined, '11-05 15:00-16:00', false],
  ['周五在麦当劳吃饭', '吃饭', '麦当劳', undefined, '11-06 00:00-00:00', false],

  // 12 小时制消歧：下午说「六点到十点」是今晚，不是明天早上（NOW 换成 11-05 16:46 周四下午）
  ['六点到十点学高数在图书馆', '学高数', '图书馆', undefined, '11-05 18:00-22:00', false, undefined, new Date('2026-11-05T16:46:00+08:00')],
  ['六点半到八点半 打球', '打球', undefined, undefined, '11-05 18:30-20:30', false, undefined, new Date('2026-11-05T16:46:00+08:00')],
  // 但已经过去的钟点仍按早上顺延，不会被推成「今晚八点」
  ['八点到十点 复盘', '复盘', undefined, undefined, '11-05 08:00-10:00', true, undefined, new Date('2026-11-04T20:48:00+08:00')],

  // 凌晨兜底（NOW = 11-05 18:05 周四傍晚）：说「三点」不会变成「明天凌晨三点」
  ['三点到四点 开会', '开会', undefined, undefined, '11-06 15:00-16:00', true, undefined, new Date('2026-11-05T18:05:00+08:00')],
  ['一点到两点 午休', '午休', undefined, undefined, '11-06 13:00-14:00', true, undefined, new Date('2026-11-05T18:05:00+08:00')],
  ['三点开会', '开会', undefined, undefined, '11-06 15:00-16:00', true, undefined, new Date('2026-11-05T18:05:00+08:00')],
  // 明说了「凌晨」就照字面走
  ['凌晨三点 看球', '看球', undefined, undefined, '11-06 03:00-04:00', true, undefined, new Date('2026-11-05T18:05:00+08:00')],
  // 写成 24 小时制也算明说，不动
  ['3:00到4:00 会议', '会议', undefined, undefined, '11-06 03:00-04:00', true, undefined, new Date('2026-11-05T18:05:00+08:00')],
  // 18:05 说「六点到十点」：18:00 刚过 5 分钟，仍算今晚
  ['六点到十点学高数在图书馆', '学高数', '图书馆', undefined, '11-05 18:00-22:00', false, undefined, new Date('2026-11-05T18:05:00+08:00')],

  // 早九点说「五点看网课」是今天下午五点，不是明天
  ['五点看网课', '看网课', undefined, undefined, '11-05 17:00-18:00', false, undefined, new Date('2026-11-05T09:00:00+08:00')],
  ['五点到六点 看网课', '看网课', undefined, undefined, '11-05 17:00-18:00', false, undefined, new Date('2026-11-05T09:00:00+08:00')],
  ['四点 开会', '开会', undefined, undefined, '11-05 16:00-17:00', false, undefined, new Date('2026-11-05T09:00:00+08:00')],
  // 早九点说「八点到十点」时那段还在进行中，留在今天，不推成今晚
  ['八点到十点 学高数', '学高数', undefined, undefined, '11-05 08:00-10:00', false, undefined, new Date('2026-11-05T09:00:00+08:00')],

  // 以下是 11-05 周四 18:20 语境
  // 「晚上十二点」= 当天 24:00，即第二天的 0 点（不能变成中午 12:00）
  ['晚上十二点睡觉', '睡觉', undefined, undefined, '11-06 00:00-01:00', false, undefined, EVENING],
  ['今晚十二点抢票', '抢票', undefined, undefined, '11-06 00:00-01:00', false, undefined, EVENING],
  ['明天晚上十二点睡觉', '睡觉', undefined, undefined, '11-07 00:00-01:00', false, undefined, EVENING],
  ['晚上十二点半 睡觉', '睡觉', undefined, undefined, '11-06 00:30-01:30', false, undefined, EVENING],
  ['下午十二点吃饭', '吃饭', undefined, undefined, '11-06 12:00-13:00', true, undefined, EVENING],

  // 写成 24 小时制就别再猜上下午
  ['10:00到11:00 开会', '开会', undefined, undefined, '11-06 10:00-11:00', true, undefined, EVENING],

  // 下个月 / 这个月 + N 号
  ['下个月5号交房租', '交房租', undefined, undefined, '12-05 00:00-00:00', false, undefined, EVENING],
  ['这个月15号交房租', '交房租', undefined, undefined, '11-15 00:00-00:00', false, undefined, EVENING],

  // 截止日 / 起点词不该留在标题里
  ['周五前交作业', '交作业', undefined, undefined, '11-06 00:00-00:00', false, undefined, EVENING],
  ['周五之前交作业', '交作业', undefined, undefined, '11-06 00:00-00:00', false, undefined, EVENING],
  ['从三点到五点开会', '开会', undefined, undefined, '11-06 15:00-17:00', true, undefined, EVENING],

  // 整天级别的提醒
  ['提前一天提醒 明天下午三点开会', '开会', undefined, undefined, '11-06 15:00-16:00', false, undefined, EVENING, 1440],
  ['提前两天提醒 周三上午九点答辩', '答辩', undefined, undefined, '11-11 09:00-10:00', false, undefined, EVENING, 2880],

  // 裸写的周几落在「今天」且时刻已过 → 说话人指的是下一个同名日（+7 天）
  // 现在是 11-04 周三 20:48
  ['周三上午九点答辩', '答辩', undefined, undefined, '11-11 09:00-10:00', true],
  ['周三下午三点开会', '开会', undefined, undefined, '11-11 15:00-16:00', true],
  // 但明确说了「今天」「这周三」的，按字面留在今天（过期也认，用户自己定的）
  ['今天上午九点交材料', '交材料', undefined, undefined, '11-04 09:00-10:00', false],
  ['这周三下午三点开会', '开会', undefined, undefined, '11-04 15:00-16:00', false],
  // 周四 18:20 说「周四晚上八点」：20:00 还没到，就是今晚，不能推到下周
  ['周四晚上八点 看电影', '看电影', undefined, undefined, '11-05 20:00-21:00', false, undefined, EVENING],

  // ---- B 组：周末 / 月底 / N 天后 ----
  ['周末下午两点到四点 自习', '自习', undefined, undefined, '11-07 14:00-16:00', false, undefined, EVENING],
  ['这周末打球', '打球', undefined, undefined, '11-07 00:00-00:00', false, undefined, EVENING],
  ['下周末 去爬山', '去爬山', undefined, undefined, '11-14 00:00-00:00', false, undefined, EVENING],
  ['月底交报告', '交报告', undefined, undefined, '11-30 00:00-00:00', false, undefined, EVENING],
  ['这个月底 对账', '对账', undefined, undefined, '11-30 00:00-00:00', false, undefined, EVENING],
  ['下个月底 结账', '结账', undefined, undefined, '12-31 00:00-00:00', false, undefined, EVENING],
  ['11月底 对账', '对账', undefined, undefined, '11-30 00:00-00:00', false, undefined, EVENING],
  ['三天后上午十点 答辩', '答辩', undefined, undefined, '11-08 10:00-11:00', false, undefined, EVENING],
  ['两周后 复查', '复查', undefined, undefined, '11-19 00:00-00:00', false, undefined, EVENING],
  ['两个月后 述职', '述职', undefined, undefined, '01-05 00:00-00:00', false, undefined, EVENING],

  // ---- C 组：多天重复 / 区间 / 间隔 ----
  ['每周三和周五下午两点 健身', '健身', undefined, undefined, '11-06 14:00-15:00', false, 'WEEKLY WE,FR', EVENING],
  ['每周二、四上课', '上课', undefined, undefined, '11-05 00:00-00:00', false, 'WEEKLY TU,TH', EVENING],
  ['每周一到周五早上八点跑步', '跑步', undefined, undefined, '11-06 08:00-09:00', true, 'WEEKLY MO,TU,WE,TH,FR', EVENING],
  ['每周末 上午十点 打球', '打球', undefined, undefined, '11-07 10:00-11:00', false, 'WEEKLY SA,SU', EVENING],
  // 今天这一刻已经过了 → 顺延到下一次发生（间隔要一起算，别退化成 +7 / +1）
  ['每两周复查一次 下午三点', '复查', undefined, undefined, '11-19 15:00-16:00', true, 'WEEKLY INTERVAL=2', EVENING],
  ['每两天吃药 早上八点', '吃药', undefined, undefined, '11-07 08:00-09:00', true, 'DAILY INTERVAL=2', EVENING],
  // 「每周三次」不再静默降级成每周一次：RRULE 只认「哪天」，三次表达不了。
  // 见下面的 ERRORS —— 让用户补一句「每周一三五」比在他日历里写错规则好。
  // 周日（11-08）说周末：光说「周末」是下周六，「这周末」是今天，「下周末」再往后一周
  ['周末 打球', '打球', undefined, undefined, '11-14 00:00-00:00', false, undefined, SUNDAY],
  ['这周末 打球', '打球', undefined, undefined, '11-08 00:00-00:00', false, undefined, SUNDAY],
  ['下周末 打球', '打球', undefined, undefined, '11-21 00:00-00:00', false, undefined, SUNDAY],

  // ---- 跨天区间 / 「现在到…」 ----
  ['今晚十点到明天凌晨一点 写代码', '写代码', undefined, undefined, '11-05 22:00-01:00', false, undefined, EVENING],
  ['明天下午三点到明天五点 开会', '开会', undefined, undefined, '11-06 15:00-17:00', false, undefined, EVENING],
  ['现在到明天中午 赶论文', '赶论文', undefined, undefined, '11-05 18:20-12:00', false, undefined, EVENING],
  ['现在到十点 写代码', '写代码', undefined, undefined, '11-05 18:20-22:00', false, undefined, EVENING],

  // ---- 地点：教学楼房间号要并进地点，别甩进标题 ----
  ['明天上午十点在教三201交作业', '交作业', '教三201', undefined, '11-06 10:00-11:00', false, undefined, EVENING],
  ['明天下午两点到三点 和导师开会 在学院楼302', '和导师开会', '学院楼302', undefined, '11-06 14:00-15:00', false, undefined, EVENING],
  ['明天上午十点在八号楼3-201上课', '上课', '八号楼3-201', undefined, '11-06 10:00-11:00', false, undefined, EVENING],

  // ---- 时长：以前只认阿拉伯数字，中文数字和「用时」这半句整段漏掉 ----
  ['明天早上九点交一下编程作业，用时十分钟', '交一下编程作业', undefined, undefined, '11-06 09:00-09:10', false, undefined, EVENING],
  ['明天九点开组会，用时半小时', '开组会', undefined, undefined, '11-06 09:00-09:30', false, undefined, EVENING],
  ['明天九点写代码 大概四十分钟', '写代码', undefined, undefined, '11-06 09:00-09:40', false, undefined, EVENING],
  ['下周一上午九点 例会 需要二十分钟', '例会', undefined, undefined, '11-09 09:00-09:20', false, undefined, EVENING],
  ['明天九点交作业 用时一刻钟', '交作业', undefined, undefined, '11-06 09:00-09:15', false, undefined, EVENING],
  ['明天九点交作业 用时两小时三十分钟', '交作业', undefined, undefined, '11-06 09:00-11:30', false, undefined, EVENING],
  // 区间已经定了结束时间：时长只负责从标题里删掉，不能反过来改结束时间
  ['明晚八点到九点半 看剧，用时一小时', '看剧', undefined, undefined, '11-06 20:00-21:30', false, undefined, EVENING],
  // 只说了时段、没给钟点：「中午」定起点，时长定终点。
  // 以前 duration 只在「单点钟点」分支里生效，这条会被按默认一小时算，标题还留个「用」。
  ['明天中午吃麻辣烫，用半小时，#生活', '吃麻辣烫', undefined, '生活', '11-05 12:00-12:30', false],
  ['明天中午吃麻辣烫 用半小时', '吃麻辣烫', undefined, undefined, '11-05 12:00-12:30', false],
  ['明天中午吃麻辣烫半小时', '吃麻辣烫', undefined, undefined, '11-05 12:00-12:30', false],
  // 店家名是「吃什么」的宾语，不该被切出去当地点，标题别只剩一个「吃」
  ['明天中午吃半个小时杨国福麻辣烫#生活', '吃杨国福麻辣烫', undefined, '生活', '11-05 12:00-12:30', false],
  // 「吃个半小时的 X」：时长被剔走后，动词和宾语之间会剩一截悬空的「个的」（或单剩「的」）。
  // 脏标题还会让模型兜底的「动词宾语不是地点」护栏判不出来，最终把店名切成地点、标题只剩「吃个的」。
  ['下下周三中午吃个半小时的张亮麻辣烫', '吃张亮麻辣烫', undefined, undefined, '11-18 12:00-12:30', false],
  ['明天中午吃半小时的张亮麻辣烫', '吃张亮麻辣烫', undefined, undefined, '11-05 12:00-12:30', false],
  // 小数时长：以前「0.5 小时」被读成 5 小时，还在标题里剩个「0」
  ['明天中午吃麻辣烫 0.5 小时', '吃麻辣烫', undefined, undefined, '11-05 12:00-12:30', false],
  // 一句话挂多个标签：第一个当日历，其余只从标题里剔掉
  ['明天中午吃麻辣烫 #生活 #吃饭', '吃麻辣烫', undefined, '生活', '11-05 12:00-13:00', false],
  ['明天中午吃麻辣烫 ＃生活', '吃麻辣烫', undefined, '生活', '11-05 12:00-13:00', false],
  // 「午后 / 正午」以前不是时段词，标题会剩下「午后开会」
  ['明天午后两点开会', '开会', undefined, undefined, '11-05 14:00-15:00', false],
  ['明天正午交作业', '交作业', undefined, undefined, '11-05 12:00-13:00', false],
  // 英文单位：以前整段不认，静默按一小时算，标题里还留着「30min」
  ['明天中午 12:00 吃麻辣烫 30min', '吃麻辣烫', undefined, undefined, '11-05 12:00-12:30', false],
  ['明天中午吃麻辣烫 1.5h', '吃麻辣烫', undefined, undefined, '11-05 12:00-13:30', false],
  // 括号里的时间被剔走后，别留一对空括号
  ['明天中午吃麻辣烫（半小时）', '吃麻辣烫', undefined, undefined, '11-05 12:00-12:30', false],
  // 「提醒我」放在「提前十分钟」前面时，以前只吃掉后半截，标题剩「，提醒我」
  ['明天中午吃麻辣烫，用半小时，提醒我提前十分钟', '吃麻辣烫', undefined, undefined, '11-05 12:00-12:30', false, undefined, undefined, 10],

  // ---- #全天：只有写了 #全天 才建全天日程，而且不再被当成一个叫「全天」的日历 ----
  // （时间两端都是 00:00，allDay 必须为 true；断言在下面统一检查）
  ['明天交作业 #全天', '交作业', undefined, undefined, '11-06 00:00-00:00', false, undefined, EVENING],
  ['#全天 明天 洗衣服', '洗衣服', undefined, undefined, '11-06 00:00-00:00', false, undefined, EVENING],
  // 写了钟点也照全天走：钟点只从标题里剔掉，不设时间
  ['明天下午三点开会 #全天', '开会', undefined, undefined, '11-06 00:00-00:00', false, undefined, EVENING],
  ['明天下午三点到四点 #全天 组会', '组会', undefined, undefined, '11-06 00:00-00:00', false, undefined, EVENING],
  // 时长同样只当噪声剔掉，别据此算出 12:30 的会议
  ['明天中午吃麻辣烫，用半小时 #全天 #生活', '吃麻辣烫', undefined, '生活', '11-06 00:00-00:00', false, undefined, EVENING],
  // 全天日程是按天算的：今天 18:20 说「今天 #全天」，不该因为「已经过了」被顺延到明天
  ['今天 交作业 #全天', '交作业', undefined, undefined, '11-05 00:00-00:00', false, undefined, EVENING],
  // 全天 + 重复
  ['每周三 交作业 #全天', '交作业', undefined, undefined, '11-11 00:00-00:00', false, 'WEEKLY WE', EVENING],
  // 紧跟汉字的不是这个标记，而是一个叫「全天会议」的日历
  ['明天 #全天会议 准备材料', '准备材料', undefined, '全天会议', '11-06 00:00-00:00', false, undefined, EVENING],
  // 全角井号、井号后带空格都能认
  ['明天交作业 ＃全天', '交作业', undefined, undefined, '11-06 00:00-00:00', false, undefined, EVENING],
  ['明天交作业 # 全天', '交作业', undefined, undefined, '11-06 00:00-00:00', false, undefined, EVENING],
  // 「全天班」是词的一部分，不能把「全天」当修饰语剔掉，只剩一个「班」
  ['明天全天班 #全天', '全天班', undefined, undefined, '11-06 00:00-00:00', false, undefined, EVENING],
  // 不写 #全天 时行为不变：有钟点就是定时日程
  ['明天下午三点开会', '开会', undefined, undefined, '11-06 15:00-16:00', false, undefined, EVENING],

  // ---- 295 条生活口语蓝本里挖出来的问题（2026-11-07）----
  // 尾部「的」是结构助词（吃点好的），不是语气词，别顺手砍掉
  ['今天中午吃点好的', '吃点好的', undefined, undefined, '11-04 12:00-13:00', false],
  // 「周一三五」没有「每」不该变重复，但也不能把「三五」烂在标题里
  ['周一三五 下午四点 健身', '健身', undefined, undefined, '11-09 16:00-17:00', false],
  // 介词短语在句末：地点要切出来，别粘在标题上
  ['明天 看电影 在万达', '看电影', '万达', undefined, '11-05 00:00-00:00', false],
  ['明天 去公司 开会', '开会', '公司', undefined, '11-05 00:00-00:00', false],
  // 带房间号的教学楼 / 楼号出现在句中（不是句首）也要认
  ['明天下午三点 教三201 交作业', '交作业', '教三201', undefined, '11-05 15:00-16:00', false],
  ['明天 八号楼302 开会', '开会', '八号楼302', undefined, '11-05 00:00-00:00', false],
  // 介词短语就是整件事时，别把它切成地点、留一个空标题
  ['后天 去银行', '去银行', undefined, undefined, '11-06 00:00-00:00', false],
  ['九点四十五 到公司', '到公司', undefined, undefined, '11-04 21:45-22:45', false],
];

/**
 * 这些句子应该直接报错，而不是猜一个日期写进日历。
 * 越界的月/日以前会被 Date 悄悄溢出成下个月甚至下一年。
 */
const ERRORS = [
  '13月1号 交材料',
  '0号 交材料',
  '32号 交材料',
  // 说了 #全天 却没说是哪天：宁可让他重说，也别默认塞到今天
  '#全天 洗衣服',
  // 2 月没有 30 号。以前会夹到 2 月 28 号，用户以为写对了，实际差了两天
  '2月30号 交材料',
  '4月31号 开会',
  // 钟点越界以前整句掉成全天，而「25点」还烂在标题里
  '明天25点 开会',
  '明天3点75分 开会',
  // 「每周三次」RRULE 表达不了，不猜
  '每周三次 下午四点 健身',
  // 说了时长却没说几点开始：以前静默按全天 24 小时写进去，用户说的 20 分钟被吞掉
  '明天 开个会 20分钟',
  '明天 看电影 用时约两小时',
  '明天 组会 用时一小时',
];

let failed = 0;
for (const [text, title, place, calendar, time, rolled, repeat, when, alarm] of CASES) {
  const result = parseEvent(text, when ?? NOW, { calendarNames: NAMES });
  const actual = {
    title: result.title,
    place: result.location || undefined,
    calendar: result.calendar || undefined,
    time: span(result.start, result.end),
    // 不设时间 ⇔ 全天：两端都是 00:00 才允许 allDay，反过来也不许标着全天却排了钟点
    allDay: Boolean(result.allDay),
    rolled: Boolean(result.rolled),
    repeat: result.repeat
      ? [
          result.repeat.freq,
          result.repeat.interval > 1 ? `INTERVAL=${result.repeat.interval}` : null,
          result.repeat.byday?.join(','),
          result.repeat.bymonthday,
        ].filter(Boolean).join(' ')
      : undefined,
    alarm: result.alarmMinutes ?? undefined,
  };
  const expected = { title, place, calendar, time, allDay: time.endsWith('00:00-00:00'), rolled, repeat, alarm };
  const ok = Object.keys(expected).every((key) => expected[key] === actual[key]);
  // 片段得落在原文范围内，否则界面按它上色会错位
  const badSpan = result.spans.find((item) => item.start < 0 || item.end > text.length || item.end <= item.start);
  if (!ok || badSpan) {
    failed += 1;
    console.log(`✗ ${text}`);
    for (const key of Object.keys(expected)) {
      if (expected[key] !== actual[key]) console.log(`    ${key}: 期望「${expected[key]}」实际「${actual[key]}」`);
    }
    if (badSpan) console.log(`    片段越界：${JSON.stringify(badSpan)}`);
  } else {
    console.log(`✓ ${text}  →  ${actual.time}${actual.rolled ? '（顺延）' : ''}${actual.repeat ? ` [${actual.repeat}]` : ''}`);
  }
}

for (const text of ERRORS) {
  let threw = false;
  try {
    parseEvent(text, NOW, { calendarNames: NAMES });
  } catch {
    threw = true;
  }
  if (threw) {
    console.log(`✓ ${text}  →  按预期报错`);
  } else {
    failed += 1;
    console.log(`✗ ${text}  →  期望报错，却解析出了结果`);
  }
}

const total = CASES.length + ERRORS.length;
console.log(`\n${total - failed}/${total} 通过`);
process.exit(failed === 0 ? 0 : 1);
