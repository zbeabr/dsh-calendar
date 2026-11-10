/**
 * 账号 / 密码 / 区域入口的纯规则用例。跑法：node credentials-cases.mjs
 *
 * 这几条规则单独拎出来测，是因为它们出错时都「不报错」：
 * 大小写没归一 → 钥匙串里两条，GUI 读到错的那条；
 * 40 位设备密码当 App 专用密码存进去 → 覆盖掉好密码，登录一路 401；
 * 区域入口没换 → 中国大陆账号永远认证不过。
 *
 * 不碰真钥匙串，不联网。
 */

import { appPasswordFormat, alternateIcloudBase, isIcloudHost, normalizeAccount } from './src/credentials.mjs';

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass += 1;
  } catch (error) {
    failures.push(`${name}：${error.message}`);
  }
}

function expect(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label ?? ''} 期望 ${expected}，实际 ${actual}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ── 账号归一化 ───────────────────────────────────────────
check('Apple ID 归一化：去空白 + 转小写', () => {
  expect(normalizeAccount('  User@Example.COM '), 'user@example.com');
  expect(normalizeAccount('user@example.com'), 'user@example.com');
});

check('Apple ID 归一化：空值不炸', () => {
  expect(normalizeAccount(undefined), '');
  expect(normalizeAccount(null), '');
  expect(normalizeAccount(0), '0');
});

check('Apple ID 归一化：非 ASCII 原样保留（不猜也不丢）', () => {
  expect(normalizeAccount(' 用户@例子.中国 '), '用户@例子.中国');
});

// ── App 专用密码格式 ─────────────────────────────────────
check('App 专用密码：标准 16 位带连字符', () => {
  const result = appPasswordFormat('abcd-efgh-ijkl-mnop');
  expect(result.ok, true, '是否通过');
  expect(result.compact, 'abcdefghijklmnop', '去连字符后的形态');
});

check('App 专用密码：大写、空格、无连字符都接受', () => {
  expect(appPasswordFormat('ABCDEFGHIJKLMNOP').ok, true, '无连字符');
  expect(appPasswordFormat(' abcd efgh ijkl mnop ').ok, true, '空格分隔');
  expect(appPasswordFormat('abcd-efgh-ijkl-mnop').ok, true, '连字符');
});

check('App 专用密码：40 位设备密码必须被拒，且报出实际长度', () => {
  const result = appPasswordFormat('a'.repeat(40));
  expect(result.ok, false, '是否通过');
  expect(result.reason, 'length', '拒绝原因');
  expect(result.length, 40, '报给用户的长度');
});

check('App 专用密码：15 位 / 空串 / 非法字符分别有不同的原因', () => {
  expect(appPasswordFormat('abcdefghijklmno').reason, 'length', '15 位');
  expect(appPasswordFormat('').reason, 'empty', '空串');
  expect(appPasswordFormat('abcd-efgh-ijkl-mno!').reason, 'charset', '含符号');
  expect(appPasswordFormat('abcd-efgh-ijkl-mnop'.replace(/-/gu, '')).length, 16, '合法密码的长度');
});

// ── 区域入口 ─────────────────────────────────────────────
check('国际区入口能换到中国区入口', () => {
  expect(alternateIcloudBase('https://caldav.icloud.com/'), 'https://caldav.icloud.com.cn/');
  expect(alternateIcloudBase('https://caldav.icloud.com'), 'https://caldav.icloud.com.cn/');
});

check('中国区入口能换回国际区入口（反方向也要通）', () => {
  expect(alternateIcloudBase('https://caldav.icloud.com.cn/'), 'https://caldav.icloud.com/');
  expect(alternateIcloudBase('https://caldav.icloud.com.cn'), 'https://caldav.icloud.com/');
});

check('分片主机不瞎换区（分片号在两个区不一定对应）', () => {
  expect(alternateIcloudBase('https://p33-caldav.icloud.com/'), undefined);
  expect(alternateIcloudBase('https://p33-caldav.icloud.com.cn/'), undefined);
});

check('自定义 CalDAV 与非法地址不换区', () => {
  expect(alternateIcloudBase('https://dav.example.com/'), undefined);
  expect(alternateIcloudBase('not a url'), undefined);
  expect(alternateIcloudBase(undefined), undefined);
});

// ── iCloud 主机判断 ──────────────────────────────────────
check('iCloud 主机判断：主入口与分片都算', () => {
  expect(isIcloudHost('caldav.icloud.com'), true, '.com');
  expect(isIcloudHost('p33-caldav.icloud.com'), true, '.com 分片');
  expect(isIcloudHost('caldav.icloud.com.cn'), true, '.com.cn');
  expect(isIcloudHost('p33-caldav.icloud.com.cn'), true, '.com.cn 分片');
});

check('iCloud 主机判断：钓鱼域名不算', () => {
  expect(isIcloudHost('evil-icloud.com'), false, 'evil-icloud.com');
  expect(isIcloudHost('icloud.com.evil.com'), false, 'icloud.com.evil.com');
  expect(isIcloudHost('dav.example.com'), false, '自定义域名');
  expect(isIcloudHost(''), false, '空值');
});

// ── 汇总 ─────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`✓ ${pass} 条账号/区域用例全部通过`);
} else {
  console.log(`✗ ${pass} 条通过，${failures.length} 条失败：`);
  for (const line of failures) console.log(`  ✗ ${line}`);
  process.exitCode = 1;
}
