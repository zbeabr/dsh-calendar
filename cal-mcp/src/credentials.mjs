/**
 * 账号与凭据的纯规则：归一化、格式校验、区域服务器地址。
 *
 * 刻意不 import 任何东西：
 * - 不碰钥匙串（那是 store.mjs 的事），否则用例一 import 就会真的去问系统钥匙串；
 * - 不发请求（那是 caldav.mjs 的事），否则这些规则没法离线断言。
 *
 * 这些规则本身很细（大小写、16 位、.com 与 .com.cn），出错的方式又都很安静
 * （登录失败、密码被覆盖、写进错的日历），所以必须能被用例逐条钉住。
 */

/** 国际区 iCloud CalDAV 入口。 */
export const ICLOUD_INTL = 'https://caldav.icloud.com/';
/** 中国大陆区（云上贵州 iCloud）CalDAV 入口。两套是不同的后端分区。 */
export const ICLOUD_CN = 'https://caldav.icloud.com.cn/';

/**
 * Apple ID 不区分大小写，钥匙串的 acct 字段区分。
 * 不做归一化就会出现「User@x.com 一条、user@x.com 一条」，
 * 而 App 与 CLI 可能各自读到不同那条 —— 症状是「命令行诊断正常、GUI 还是 401」。
 */
export function normalizeAccount(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** 是不是 iCloud 的 CalDAV 主机（含 p33-caldav.icloud.com 这类分片）。 */
export function isIcloudHost(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  return host === 'icloud.com' || host.endsWith('.icloud.com')
    || host === 'icloud.com.cn' || host.endsWith('.icloud.com.cn');
}

/**
 * Apple 的 App 专用密码是 16 位（写作 xxxx-xxxx-xxxx-xxxx）。
 * 用户最容易错的是把设备密码或 Apple ID 主密码（常见 40 位十六进制那种）粘进来，
 * 那种东西永远不会通过认证，但会先被写进钥匙串，把好密码覆盖掉。
 *
 * @returns {{ ok: true, compact: string } | { ok: false, reason: 'empty'|'length'|'charset', compact: string, length: number }}
 */
export function appPasswordFormat(password) {
  const compact = String(password ?? '').replace(/[\s-]/gu, '');
  if (compact === '') return { ok: false, reason: 'empty', compact, length: 0 };
  if (!/^[a-z0-9]+$/iu.test(compact)) return { ok: false, reason: 'charset', compact, length: compact.length };
  if (compact.length !== 16) return { ok: false, reason: 'length', compact, length: compact.length };
  return { ok: true, compact, length: 16 };
}

/**
 * 同一份 iCloud 账号在另一个区的入口地址；不是 iCloud 主入口就返回 undefined。
 *
 * 只认两个精确主机名：`p33-caldav.icloud.com` 这种分片地址没法可靠地换区
 * （分片号在两个区不一定对应），瞎换只会给出更奇怪的报错。
 */
export function alternateIcloudBase(baseUrl) {
  let host;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host === 'caldav.icloud.com') return ICLOUD_CN;
  if (host === 'caldav.icloud.com.cn') return ICLOUD_INTL;
  return undefined;
}
