/**
 * Credential and preference storage.
 * The CalDAV password lives in the macOS Keychain (service `dsh-cal`);
 * only non-secret preferences sit in ~/.config/dsh-cal/config.json (0600).
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
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
  // 默认跟本机走：解析用的是机器时区，写入和文字显示也用同一时区，三者才不会错位。
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
 *             location?: string, calendar?: string, description?: string, createdAt: string,
 *             uid?: string, attempts?: number, lastError?: string }} PendingEvent
 */

const DEAD_PATH = join(CONFIG_DIR, 'pending.dead.json');
const LOCK_PATH = `${QUEUE_PATH}.lock`;
/** 拿锁最多等多久。临界区只是读几 KB 再写回去，正常几十毫秒。 */
const LOCK_WAIT_MS = 5000;
/** 锁文件超过这个年龄就当持有者已经崩了，抢过来。 */
const LOCK_STALE_MS = 15000;

/** 队列文件读不出来时抛这个。调用方据此决定是「报错」还是「另存后重建」。 */
export class QueueCorruptError extends Error {
  constructor(path, detail) {
    super(`待发队列 ${path} 读不出来（${detail}）。文件没有被删除，修好或改名后重试即可。`);
    this.name = 'QueueCorruptError';
    this.queuePath = path;
  }
}

/** 同步睡一会儿。队列的临界区是同步代码，用不了 await。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return;
  } catch {
    /* 不支持 SharedArrayBuffer 的环境退化成忙等 */
  }
  const until = Date.now() + ms;
  while (Date.now() < until) { /* spin */ }
}

/**
 * 用「创建独占文件」当跨进程互斥锁。
 *
 * 以前是读-改-写三步无保护，App、CLI、MCP 同时跑时，两个进程读到同一份快照，
 * 后写的把先写的整个覆盖掉 —— 8 个并发入队只剩 1 条就是这么来的。
 * 锁文件带 pid 和时间戳：持有者崩了（超过 LOCK_STALE_MS 没动）就抢过来，
 * 免得一次崩溃把队列永久锁死。
 */
function withQueueLock(fn) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  let tries = 0;
  for (;;) {
    tries += 1;
    let fd;
    try {
      fd = openSync(LOCK_PATH, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // 抢不到就退避。固定间隔的紧循环会让几十个进程互相把 CPU 抢光，
      // 结果谁都前进不了（实测 30 个并发有 12 个等到超时）。
      // 改指数退避 + 抖动，等待方几乎不占 CPU，临界区就能一条条过。
      try {
        if (Date.now() - statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(LOCK_PATH);
          continue;
        }
      } catch {
        continue; // 锁刚被释放，立刻重试
      }
      if (Date.now() - startedAt > LOCK_WAIT_MS) {
        throw new Error('待发队列正被另一个进程占用（App / CLI / MCP 可能同时在跑），请稍后再试。');
      }
      const backoff = Math.min(40, 2 * tries) * (0.5 + Math.random());
      sleepSync(backoff);
      continue;
    }
    // 抢到了。写 pid 失败也不能把锁留下，所以这段单独兜住。
    try {
      writeFileSync(fd, `${process.pid} ${startedAt}`);
    } catch {
      /* 写不进 pid 不影响互斥语义 */
    } finally {
      closeSync(fd);
    }
    break;
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      /* 已经被清理过 */
    }
  }
}

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖。
 *
 * rename 在同一文件系统里是原子的，所以别的进程任何时刻读到的要么是旧内容、
 * 要么是完整的新内容，不会读到写了一半的半个 JSON。以前直接 writeFileSync
 * 覆盖，进程中途被杀就留下一个坏文件，而坏文件又会被当成「没有待发日程」。
 *
 * 不做 fsync：它只保证掉电后不丢最后一次写，而 rename 已经保证「不会读到半个文件」。
 * 每次入队都 fsync 会把并发入队的吞吐拖到百毫秒级，几十个进程同时入队就排队超时。
 */
function writeQueueFile(path, items) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify({ version: 2, items }, null, 2)}\n`;
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
  try {
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 尽力清理 */ }
    throw error;
  }
}

/**
 * 读队列。
 * 解析失败**不再**返回空数组：那会让「文件坏了」看起来像「没有待发日程」，
 * 而接下来任何一次入队都会把坏文件覆盖掉，待发数据就真的没了。
 */
export function readQueue() {
  if (!existsSync(QUEUE_PATH)) return [];
  let raw;
  try {
    raw = readFileSync(QUEUE_PATH, 'utf8');
  } catch (error) {
    throw new QueueCorruptError(QUEUE_PATH, `读不动：${error.code ?? error.message}`);
  }
  if (raw.trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new QueueCorruptError(QUEUE_PATH, error.message);
  }
  // 最早的版本存的是纯数组，后来的版本是 { items: [...] }
  const items = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(items)) throw new QueueCorruptError(QUEUE_PATH, '文件结构不对，没有 items 数组');
  return items.filter((item) => item && typeof item === 'object');
}

/** 死信：试满次数仍然发不出去的条目，挪到这里，不再堵住后面的。 */
export function readDeadLetter() {
  if (!existsSync(DEAD_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(DEAD_PATH, 'utf8'));
    const items = Array.isArray(parsed) ? parsed : parsed?.items;
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

export function writeQueue(items) {
  return withQueueLock(() => {
    writeQueueFile(QUEUE_PATH, items);
    return items;
  });
}

/**
 * 入队。整个过程在锁里完成，所以并发入队不会互相覆盖。
 * 队列文件损坏时：先原样另存一份（不删），再建新队列，并把这件事挂在这条的 warnings 上。
 */
export function enqueueEvent(event) {
  return withQueueLock(() => {
    let items;
    const warnings = [];
    try {
      items = readQueue();
    } catch (error) {
      if (!(error instanceof QueueCorruptError)) throw error;
      const backup = `${QUEUE_PATH}.corrupt-${Date.now()}`;
      renameSync(QUEUE_PATH, backup);
      warnings.push(`原来的待发队列读不出来，已原样另存为 ${backup}，这条日程先记进新队列。`);
      items = [];
    }
    const entry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      ...event,
      attempts: 0,
    };
    if (warnings.length > 0) entry.warnings = warnings;
    items.push(entry);
    writeQueueFile(QUEUE_PATH, items);
    return entry;
  });
}

export function dequeueEvent(id) {
  return withQueueLock(() => {
    const items = readQueue().filter((item) => item.id !== id);
    writeQueueFile(QUEUE_PATH, items);
    return items;
  });
}

/** 同一条最多试几次，够了就进死信（还能在 pending 里看到，不会凭空消失）。 */
export const MAX_ATTEMPTS = 3;

/**
 * 记一次失败：次数 +1、记下错误和时刻。
 * 次数够了就挪进死信 —— 否则一条永久失败的条目会一直排在队头，
 * 后面的日程永远发不出去（以前的补发是「一条失败整轮停」）。
 */
export function markAttempt(id, errorMessage) {
  return withQueueLock(() => {
    let attempts = 0;
    let dead = false;
    const items = [];
    for (const item of readQueue()) {
      if (item.id !== id) {
        items.push(item);
        continue;
      }
      attempts = (Number(item.attempts) || 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        dead = true;
        const deadItems = readDeadLetter();
        deadItems.push({
          ...item,
          attempts,
          lastError: errorMessage,
          deadAt: new Date().toISOString(),
        });
        writeQueueFile(DEAD_PATH, deadItems);
        continue; // 从待发队列里移走
      }
      items.push({ ...item, attempts, lastError: errorMessage, lastAttemptAt: new Date().toISOString() });
    }
    writeQueueFile(QUEUE_PATH, items);
    return { attempts, dead };
  });
}

export function queuePath() {
  return QUEUE_PATH;
}

export function deadLetterPath() {
  return DEAD_PATH;
}
