/**
 * Credential and preference storage.
 * The CalDAV password lives in the macOS Keychain (service `dsh-cal`);
 * only non-secret preferences sit in ~/.config/dsh-cal/config.json (0600).
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const KEYCHAIN_SERVICE = 'dsh-cal';
const CONFIG_DIR = join(homedir(), '.config', 'dsh-cal');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const CACHE_PATH = join(CONFIG_DIR, 'calendars.json');
const QUEUE_PATH = join(CONFIG_DIR, 'pending.json');

export const DEFAULTS = {
  baseUrl: 'https://caldav.icloud.com/',
  username: '',
  calendar: '',
  timeZone: 'Asia/Shanghai',
  llm: {
    enabled: false,
    provider: 'ollama',
    model: 'qwen3:8b',
    baseUrl: 'http://127.0.0.1:11434',
    apiKey: '',
    timeoutMs: 25000,
  },
};

export function readConfig() {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS, llm: { ...DEFAULTS.llm } };
  try {
    const file = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULTS, ...file, llm: { ...DEFAULTS.llm, ...(file.llm ?? {}) } };
  } catch {
    return { ...DEFAULTS, llm: { ...DEFAULTS.llm } };
  }
}

export function writeConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* best effort */
  }
  return CONFIG_PATH;
}

/** Read the password from the Keychain, falling back to an env var for headless runs. */
export function readPassword(username) {
  if (process.env.DSH_CAL_PASSWORD) return process.env.DSH_CAL_PASSWORD;
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', username, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return undefined;
  }
}

/**
 * 写入（或覆盖）钥匙串里的密码。
 *
 * 密码只能走 `security -w <密码>` 这一条路：`security` 的交互式提示读的是
 * /dev/tty 而不是 stdin，没有终端时它会一直挂着（实测被 SIGTERM 杀掉），
 * 所以没法改成从管道喂进去。argv 里那个几十毫秒的窗口只能靠「本机没人
 * 同时 ps」兜着，README 里写明了。
 *
 * 但**错误消息**这条泄漏必须堵：execFileSync 失败时 Node 会把整条 argv 拼进
 * error.message（形如 `Command failed: security add-generic-password … -w 密码`），
 * 而 cli 会把它打到 stderr 和 --json 输出、App 会写进日志。钥匙串被锁、
 * 授权被拒、沙箱拦截任何一次，密码就落到了滚屏和日志里。所以这里一律
 * 换成不含命令行的错误，并且再过一遍脱敏。
 */
export function savePassword(username, password) {
  try {
    execFileSync('security', [
      'add-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', username,
      '-l', `dsh-cal CalDAV (${username})`,
      '-w', password,
      '-U',
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch (error) {
    throw new Error(redact(`写入钥匙串失败（${error?.status ?? error?.code ?? '未知原因'}），密码没有保存。`
      + '请解锁「钥匙串访问」后重试，或用 DSH_CAL_PASSWORD 环境变量临时提供密码。', password));
  }
}

/**
 * 把可能混进文本里的密码换成 ***。
 * 兜底用：任何要展示给用户或写进日志的字符串都过一遍。
 * @param {string} text
 * @param {string} [secret]
 */
export function redact(text, secret) {
  let out = String(text ?? '');
  if (secret && secret.length >= 4) out = out.split(secret).join('***');
  // 顺手抹掉 `-w <值>` 这种形态，即使不知道具体密码
  return out.replace(/(-w\s+)(\S{4,})/gu, '$1***');
}

export function deletePassword(username) {
  try {
    execFileSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', username], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function hasPassword(username) {
  return readPassword(username) !== undefined;
}

export function configPath() {
  return CONFIG_PATH;
}

// MARK: - 日历列表缓存（离线也能选标签、也能识别标签）

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/**
 * @returns {{ names: string[], updatedAt?: string }}
 */
export function readCalendarCache() {
  const cache = readJson(CACHE_PATH, { names: [] });
  return { names: Array.isArray(cache.names) ? cache.names : [], updatedAt: cache.updatedAt };
}

export function writeCalendarCache(names) {
  const unique = [...new Set(names.filter(Boolean))];
  return writeJson(CACHE_PATH, { names: unique, updatedAt: new Date().toISOString() });
}

/** 缓存里的日历名，用来在纯离线状态下识别「加到学习」这类标签。 */
export function cachedCalendarNames() {
  return readCalendarCache().names;
}

// MARK: - 离线待发队列

/**
 * @typedef {{ id: string, title: string, start: string, end: string, allDay: boolean,
 *             location?: string, calendar?: string, description?: string, createdAt: string }} PendingEvent
 */

/** @returns {PendingEvent[]} */
export function readQueue() {
  const queue = readJson(QUEUE_PATH, { items: [] });
  return Array.isArray(queue.items) ? queue.items : [];
}

export function writeQueue(items) {
  return writeJson(QUEUE_PATH, { items });
}

export function enqueueEvent(event) {
  const items = readQueue();
  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    ...event,
  };
  items.push(entry);
  writeQueue(items);
  return entry;
}

export function dequeueEvent(id) {
  const items = readQueue().filter((item) => item.id !== id);
  writeQueue(items);
  return items;
}

export function queuePath() {
  return QUEUE_PATH;
}
