/**
 * 常用地点：记住用户写过的地方，长句里即使没有「在 / 去」也能把地点从标题里剥出来。
 *
 * 刻意放在解析层之后，不进 nlp.mjs：那是零 import 的纯函数，塞持久化进去会把
 * 386 条蓝本和三时区语义一起拖下水。这里只认「词典里已有的词」，绝不猜新地点；
 * 边界不满足就原样放过，宁可把地点留在标题里，也不把「图书馆学导论」切成「学导论」。
 */
import { readConfig, writeConfig } from './store.mjs';

const MAX_PLACES = 20;
const PREPOSITION = /(?:在|去|到|@|于)\s*$/u;
// 地点后面紧跟这些才算「说完了这个地点」，否则不剥。
const AFTER_BOUNDARY = /^(?:[\s，,。;；!！?？、]|里|内|学习|复习|开会|见面|写作业|看书|吃饭|等)/u;

/** 去重、去空、去首尾空格，新的排前面，最多留 20 个。 */
export function normalizePlaces(list) {
  const seen = new Set();
  const result = [];
  for (const raw of list ?? []) {
    if (typeof raw !== 'string') continue;
    const place = raw.trim();
    if (!place || seen.has(place)) continue;
    seen.add(place);
    result.push(place);
  }
  return result.slice(0, MAX_PLACES);
}

/** 注入 read/write 是为了用例不碰用户真实配置。 */
export function learnPlaces(newOnes = [], { read = readConfig, write = writeConfig } = {}) {
  const config = read() ?? {};
  const merged = normalizePlaces([...newOnes, ...(config.recentPlaces ?? [])]);
  if (merged.length === (config.recentPlaces ?? []).length
      && merged.every((place, index) => place === config.recentPlaces[index])) return merged;
  write({ ...config, recentPlaces: merged });
  return merged;
}

export function knownPlaces({ read = readConfig } = {}) {
  return normalizePlaces((read() ?? {}).recentPlaces ?? []);
}

/**
 * 从标题里剥出一个已知地点。命中返回 { title, location }，否则 null。
 * 三种安全情形：前面有介词 / 地点在开头且后面是边界 / 地点在末尾且前面有介词。
 */
export function extractKnownPlace(title, places) {
  if (typeof title !== 'string' || !title.trim() || !Array.isArray(places) || places.length === 0) return null;
  const sorted = [...new Set(places)].filter((p) => typeof p === 'string' && p.trim() !== '')
    .sort((a, b) => b.length - a.length);

  for (const place of sorted) {
    const at = title.indexOf(place);
    if (at < 0) continue;
    const before = title.slice(0, at);
    const after = title.slice(at + place.length);
    const hasPreposition = PREPOSITION.test(before);
    const boundary = after === '' || AFTER_BOUNDARY.test(after);
    if (!boundary) continue;
    if (!hasPreposition && at !== 0) continue;

    const cleaned = `${before.replace(PREPOSITION, '')}${after}`.trim();
    if (!cleaned) continue; // 别把标题剥成空字符串
    return { title: cleaned, location: place };
  }
  return null;
}
