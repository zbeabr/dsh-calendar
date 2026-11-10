/**
 * 标签归属的「闭集决策层」—— 纯函数、零依赖、确定性。
 *
 * 分工（2026-11-10 拍板）：本地模型负责语义判断，这一层负责边界。
 * 任何进入 CalDAV 的日历名都必须先过这里；无论模型说了什么、
 * 用户在句子里写了什么，输出只能是「库内确实存在的名字」或 undefined。
 *
 * 不放在 nlp.mjs 里是刻意的：parseEvent 是「忠实解析用户原文」的纯解析层，
 * 它的输出被 parse-corpus.snapshot.txt 逐行冻住（只许追加）。
 * 把闭集投影塞进去会让 378 行旧蓝本跟着变，也会把「解析」和「决策」混在一起。
 * 独立成层后，蓝本零变化，而这条层可以用 mock 模型输出写死断言，结果不漂移。
 */

/** 自动归属只允许这两个标签（用户当前只需要它们），第三个状态是「未指定」。 */
export const AUTO_CANDIDATES = ['学习', '生活'];
export const UNSPECIFIED = '未指定';

function normalizeName(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 精确匹配库内名字：全等（英文允许大小写不敏感），**绝不用 includes**。
 *
 * 旧 caldav.findCalendar 用 includes 做宽松匹配，'课表' 会静默落到
 * 「课表-数学」—— 不报错但写错日历，比直接报「找不到」更危险。
 * 库为空时返回 undefined：此时无法验证，交给写入层的真实服务端列表兜底。
 */
export function exactCalendarMatch(name, known = []) {
  const wanted = normalizeName(name);
  if (!wanted || !Array.isArray(known) || known.length === 0) return undefined;
  const lower = wanted.toLocaleLowerCase();
  const hit = known.find((candidate) => {
    if (typeof candidate !== 'string') return false;
    const value = candidate.trim();
    return value === wanted || value.toLocaleLowerCase() === lower;
  });
  return normalizeName(hit);
}

/**
 * 把模型的自由输出投影到闭集。提示词约束只是「软」的：
 * 实测 qwen3:8b 在不给候选时会吐「饮食」「运动」「健康」「医疗」「作业」「休闲」，
 * 全是库外名字。所以这里必须用代码再卡一次。
 *
 * @returns 候选名 / '未指定' / undefined（脏值一律丢弃）
 */
export function projectModelTag(raw, candidates = AUTO_CANDIDATES) {
  const value = normalizeName(raw);
  if (!value) return undefined;
  if (value === UNSPECIFIED) return UNSPECIFIED;
  const list = Array.isArray(candidates) ? candidates : [];
  const lower = value.toLocaleLowerCase();
  const hit = list.find((candidate) => {
    if (typeof candidate !== 'string') return false;
    const name = candidate.trim();
    return name === value || name.toLocaleLowerCase() === lower;
  });
  return normalizeName(hit);
}

/**
 * 决定一条日程最终写进哪个日历。
 *
 * 优先级：显式标签（用户写明的 #X / 手动选的日历） > 模型建议 > 默认日历。
 * 硬不变量：返回值 ∈ known ∪ {undefined}；known 为空时标 unverified，
 * 表示「本机还不知道库」，此时不擅自丢弃用户写明的名字，由写入层校验。
 *
 * 显式标签在库外时**不让模型顶替**：用户明确写过一个标签，系统不该
 * 悄悄替他换成另一个。只记进 rejected，回落默认日历并给出提示。
 *
 * @param {{ explicit?: string, suggested?: string, known?: string[],
 *           fallback?: string, candidates?: string[] }} [input]
 * @returns {{ calendar?: string, source: 'explicit'|'model'|'fallback'|null,
 *             rejected: string[], unverified: boolean }}
 */
export function resolveCalendar({ explicit, suggested, known = [], fallback, candidates = AUTO_CANDIDATES } = {}) {
  const library = Array.isArray(known)
    ? known.filter((name) => typeof name === 'string' && name.trim() !== '')
    : [];
  const unverified = library.length === 0;
  const rejected = [];
  const fallbackName = unverified
    ? normalizeName(fallback)
    : exactCalendarMatch(fallback, library);

  const explicitName = normalizeName(explicit);
  if (explicitName) {
    const hit = unverified ? explicitName : exactCalendarMatch(explicitName, library);
    if (hit) return { calendar: hit, source: 'explicit', rejected, unverified };
    rejected.push(explicitName);
    return { calendar: fallbackName, source: fallbackName ? 'fallback' : null, rejected, unverified };
  }

  const suggestion = projectModelTag(suggested, candidates);
  if (suggestion && suggestion !== UNSPECIFIED) {
    const hit = unverified ? suggestion : exactCalendarMatch(suggestion, library);
    if (hit) return { calendar: hit, source: 'model', rejected, unverified };
    // 候选名本身不在库里：绝不返回，记下来后回落
    rejected.push(suggestion);
  }

  return { calendar: fallbackName, source: fallbackName ? 'fallback' : null, rejected, unverified };
}
