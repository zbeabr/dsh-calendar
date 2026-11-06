/**
 * 可选的语言模型兜底。
 *
 * 规则解析（nlp.mjs）是主路径：快、离线可用、时间算得准。
 * 但它只会认「地点：X」「@X」这类明确写法。遇到「在医院复查」「在华东理工大学图书馆学习高等数学」
 * 这种自然句子，规则可能漏掉地点，或者把介词短语留在标题里 —— 这时再问一次模型。
 *
 * 模型只负责两件事：location、title。时间永远由规则计算，避免模型编造日期。
 *
 * 支持两个 provider：
 *   ollama  —— 本地模型，http://127.0.0.1:11434，不用 key
 *   openai  —— 任何 OpenAI 兼容接口（豆包 Ark、DeepSeek、OpenAI），需要 apiKey
 */

import { readConfig } from './store.mjs';

export const LLM_DEFAULTS = {
  enabled: false,
  provider: 'ollama',
  model: 'qwen3:8b',
  baseUrl: 'http://127.0.0.1:11434',
  apiKey: '',
  timeoutMs: 25000,
};

export function llmConfig() {
  return { ...LLM_DEFAULTS, ...(readConfig().llm ?? {}) };
}

/** 上一次调用失败的原因，给 doctor / 调试用。 */
export const llmLastError = { message: undefined, at: undefined };

function remember(error) {
  llmLastError.message = String(error?.message ?? error);
  llmLastError.at = new Date().toISOString();
  if (process.env.DSH_CAL_DEBUG) console.error(`[llm] ${llmLastError.message}`);
}

const SYSTEM_PROMPT = `你是日历助手的「理解层」。用户会用很口语的方式说一件事，你要提炼两样东西：

1) title：这件事叫什么。只保留描述「做什么」的词，把日期、时间、时段、地点、语气词和口头禅都去掉。
2) location：地点，必须是原句里连续出现过的文字；没有就是 null。

输出一个 JSON 对象，不要解释、不要代码块：
{"title":"...","location":"..."} 或 {"title":"...","location":null}

硬性规则：
- 只删不改：title 的每一个字都必须按原顺序出现在原句里，不许换词、缩写、补充、加括号。
- title 里不能有时间表达（明天/下午/十二点半/半小时/中午…）。
- title 不能以「在/到/去」开头，也不能带逗号句号。
- title 要是一个读得通的短语：把「去趟」「在」「的」这类连接用的字一起删掉，别留下孤零零的「趟」「个」。
- 宁可留得多，也不要改写得漂亮：保持用户自己的说法。
- 原句里没有地点，location 就给 null，不要猜。
- 地点要回答「在哪」。动词的宾语不是地点：「吃杨国福麻辣烫」「喝星巴克」「买杯奶茶」里的那个名字
  是吃什么/喝什么/买什么，location 仍然给 null，title 把整个说法都留着。

例子：
「中午我想要十二点半到十三点洗个澡，在澡堂」→ {"title":"洗个澡","location":"澡堂"}
「明天下午三点在星巴克跟老王聊一下那个项目的事情」→ {"title":"跟老王聊一下那个项目的事情","location":"星巴克"}
「明早八点到八点四十在华东理工大学图书馆学高数」→ {"title":"学高数","location":"华东理工大学图书馆"}
「下周三下午两点到三点半在会议室开组会」→ {"title":"开组会","location":"会议室"}
「下午我得去趟三教201交个作业」→ {"title":"交作业","location":"三教201"}
「晚上八点在宿舍楼下拿快递」→ {"title":"拿快递","location":"宿舍楼下"}
「晚上九点到十点在华东理工大学图书馆学习高等数学，标签家庭」→ {"title":"学习高等数学","location":"华东理工大学图书馆"}
「半小时后提醒我喝水」→ {"title":"喝水","location":null}
「明天中午吃杨国福麻辣烫」→ {"title":"吃杨国福麻辣烫","location":null}
「晚上去食堂吃麻辣烫」→ {"title":"吃麻辣烫","location":"食堂"}`;

function userPrompt(text, ruleResult) {
  // 只告诉模型「时间已经算好了」，不给规则标题——脏标题会把模型带偏。
  return [
    `原句：${text}`,
    `（时间已经单独算好：${ruleResult.local || '未知'}。你只输出 title 和 location，不要复述时间。）`,
  ].join('\n');
}

async function callOllama(config, messages, signal) {
  const response = await fetch(`${config.baseUrl.replace(/\/+$/u, '')}/api/chat`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: false,
      format: 'json',
      think: false,
      options: { temperature: 0, num_ctx: 4096 },
      keep_alive: '30m',
    }),
  });
  if (!response.ok) throw new Error(`ollama HTTP ${response.status}：${(await response.text()).slice(0, 160)}`);
  const payload = await response.json();
  return payload?.message?.content ?? '';
}

async function callOpenAI(config, messages, signal) {
  const base = config.baseUrl.replace(/\/+$/u, '');
  const url = /\/chat\/completions$/u.test(base) ? base : `${base}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });
  if (!response.ok) throw new Error(`模型接口 HTTP ${response.status}：${(await response.text()).slice(0, 160)}`);
  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content ?? '';
}

/** 从模型回复里抠出 JSON（有些模型仍会包一层 ```）。 */
function extractJson(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(raw);
  const text = (fenced ? fenced[1] : raw).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * 判断模型给的地点是否可信：必须是原句里真实出现过的片段。
 * 模型很容易把「华东理工大学」写成「华东理工大学（徐汇校区）」这种原文没有的东西。
 */
function verifyLocation(location, text) {
  if (typeof location !== 'string') return undefined;
  const value = location.trim().replace(/^[在到去]\s*/u, '');
  if (value.length < 2 || value.length > 40) return undefined;
  return text.includes(value) ? value : undefined;
}

/**
 * 标题里不该再有时间表达——时间已经由规则单独算好了。
 * 出现了就说明模型没听清要求，这个标题作废。
 */
const TIME_WORD = /(?:凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|昨天|今天|明天|后天|大后天|下周|下下周|本周|这周|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}\s*[点时]|[零一二两三四五六七八九十]{1,3}\s*[点时])/u;

/**
 * 模型给的标题是否是原句的「子序列」——即只删字、没换字。
 * 这是防幻觉最硬的一道闸：8B 模型很爱把「聊一下那个项目的事情」美化成「聊项目」。
 */
function isSubsequence(needle, haystack) {
  if (!needle) return false;
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

function verifyTitle(title, fallback, text) {
  if (typeof title !== 'string') return undefined;
  const value = title
    .trim()
    .replace(/^[在到去\s]+/u, '')
    .replace(/[，,。.、;；\s]+$/u, '')
    .replace(/\s{2,}/gu, ' ')
    .trim();
  if (value.length < 2 || value.length > 40) return undefined;
  if (/^(?:null|无|未知)$/iu.test(value)) return undefined;
  if (TIME_WORD.test(value)) return undefined;          // 不该再有时间
  // 介词残渣：「跟导师在 吃个饭」这种把地点挖掉后留下孤零零的「在」
  if (/在[\s，,、；;]/u.test(value) || /[\s，,、；;]在$/u.test(value)) return undefined;
  if (!isSubsequence(value, String(text ?? ''))) return undefined; // 只删不改
  return value === fallback ? undefined : value;
}

/** 规则结果里这些痕迹说明它没吃干净，值得让模型再看一眼。 */
const WEAK_TITLE = /(?:^[在到去于]|^[楼上下里外对旁]|我想要|我想|我要|帮我|麻烦|那个|这个|一下$|[，,、；;。])/u;
/**
 * 动作动词。用来判断模型给的地点是不是「动词的宾语」：
 * 「吃杨国福麻辣烫」「喝星巴克」「买杯奶茶」——那是吃什么，不是在哪。
 */
const VERB_OBJECT = /[吃喝买点做逛看玩打约聊谈见取送拿办找学考洗剪寄借还换练读背写画刷修]$/u;

/**
 * 标题本身有没有问题（不考虑缺地点）。
 *
 * 拆出来是为了让「标题已经干净、只是没地点」这种情形能单独处理：
 * 那时模型只许补地点，不许动标题——不然它会把「复查」顺手写成「复查一次」。
 */
function titleNeedsWork(title) {
  const value = String(title ?? '');
  if (!value.trim()) return true;
  if (WEAK_TITLE.test(value)) return true;
  if (TIME_WORD.test(value)) return true;
  if (value.replace(/\s/gu, '').length > 16) return true;
  return false;
}

/**
 * 什么时候该问模型。
 *
 * 以前只有「规则没认出地点」才问，于是规则一被补全，模型就再没出场机会——
 * 用户说得再口语化，兜底也不会发生。现在改成「规则结果可疑就问」。
 */
export function needsRefine(text, ruleResult = {}) {
  const title = String(ruleResult.title ?? '');
  if (titleNeedsWork(title)) return true;
  // 句子里有介词结构，却没解析出地点。「到」后跟钟点（三点到四点）不算介词。
  if (!ruleResult.location && /(?:在|去)|到(?![一二两三四五六七八九十\d])/u.test(String(text ?? ''))) return true;
  return false;
}

/**
 * 用模型补全规则漏掉的地点 / 标题。
 * 任何失败（没开、没装、超时、模型乱答）都返回 undefined，调用方继续用规则结果。
 *
 * @param {string} text 原句
 * @param {{ title?: string, location?: string, local?: string }} ruleResult
 * @param {{ calendarNames?: string[], force?: boolean }} [options]
 */
export async function refineWithModel(text, ruleResult, options = {}) {
  const config = llmConfig();
  if (!config.enabled && !options.force) return undefined;
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  if (!config.model) return undefined;
  if (config.provider !== 'ollama' && !config.apiKey) {
    remember('没有配置 apiKey');
    return undefined;
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt(text, ruleResult) },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(config.timeoutMs) || 25000));

  try {
    const raw = config.provider === 'ollama'
      ? await callOllama(config, messages, controller.signal)
      : await callOpenAI(config, messages, controller.signal);
    const parsed = extractJson(raw);
    if (!parsed) {
      remember('模型没返回可解析的 JSON');
      return undefined;
    }

    const location = verifyLocation(parsed.location, text) ?? ruleResult.location;
    const base = ruleResult.title ?? '';

    // 模型有时会把动词的宾语当地点：「明天中午吃杨国福麻辣烫」
    // 被切成 title「吃」+ location「杨国福麻辣烫」，于是日程主题只剩一个「吃」。
    // 「杨国福麻辣烫」确实是家店，但它在这句里回答的是「吃什么」，不是「在哪」。
    // 判据（都很便宜）：规则本来就没认出地点 + 模型给的地点正好是规则标题的结尾
    // + 它前面紧挨着一个动作动词。命中就整条放弃模型结果，让规则标题原样留下。
    const objectAsLocation = Boolean(location)
      && !ruleResult.location
      && base.endsWith(location)
      && VERB_OBJECT.test(base.slice(0, base.length - location.length));
    if (objectAsLocation) {
      remember(`模型把「${location}」当地点，其实是动词宾语，已忽略`);
      return undefined;
    }
    // 规则这一遍已经处理干净（只是碰巧没地点）时锁住标题：模型只负责补地点。
    // 否则它会把「复查」写成「复查一次」，把已经对的东西改坏。
    // 用 needsRefine 而不是单看标题，是为了保住「我得去趟三教201交作业」这类
    // 「标题看着还行、其实吞了地点」的句子——那种仍然允许模型重写。
    const lockTitle = Boolean(base) && !needsRefine(text, ruleResult);

    // 模型标题优先：它看的是整句结构，比「规则切完再补刀」干净。
    // 但必须通过三道闸（子序列 / 无时间词 / 长度），否则一律不认。
    let title = lockTitle ? undefined : verifyTitle(parsed.title, base, text);

    // 标题里要是还粘着地点，剔掉。
    if (title && location && title.includes(location)) {
      const trimmed = title.replace(location, ' ').replace(/\s{2,}/gu, ' ').trim();
      if (trimmed.length >= 2) title = trimmed;
    }

    // 模型没给出可用标题时，退回老办法：从规则标题里剔掉地点、去掉开头的介词。
    if (!title && location && base.includes(location)) {
      const cleaned = base
        .replace(location, ' ')
        .replace(/^[在到去]\s*/u, '')
        .replace(/\s{2,}/gu, ' ')
        .trim();
      if (cleaned && cleaned !== base) title = cleaned;
    }

    if (!location && !title) {
      remember('模型没给出新信息');
      return undefined;
    }
    return {
      location,
      title,
      provider: config.provider,
      model: config.model,
      raw,
    };
  } catch (error) {
    remember(error?.name === 'AbortError' ? `等了 ${config.timeoutMs}ms 没回，已放弃` : error.message);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** 探活：App 设置页和 doctor 用来判断模型到底连不连得上。 */
export async function probeModel() {
  const config = llmConfig();
  const base = config.baseUrl.replace(/\/+$/u, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const url = config.provider === 'ollama' ? `${base}/api/tags` : `${base}/models`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: config.provider === 'ollama' ? {} : { authorization: `Bearer ${config.apiKey}` },
    });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    const payload = await response.json();
    const models = config.provider === 'ollama'
      ? (payload.models ?? []).map((item) => item.name)
      : (payload.data ?? []).map((item) => item.id);
    const ready = models.some((name) => name === config.model || name?.startsWith(`${config.model}:`));
    return {
      ok: ready,
      detail: ready
        ? `已连接，${config.model} 可用`
        : `服务在跑，但没有 ${config.model}。现有：${models.slice(0, 5).join('、') || '空'}`,
    };
  } catch (error) {
    return { ok: false, detail: error?.name === 'AbortError' ? '连接超时' : error.message };
  } finally {
    clearTimeout(timer);
  }
}
