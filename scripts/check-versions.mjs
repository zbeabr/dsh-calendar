#!/usr/bin/env node
/**
 * 版本号一致性检查：`cal-mcp/package.json` ↔ `cal-app/Info.plist` ↔ `CHANGELOG.md`。
 *
 * 为什么需要它：v1.2.x 时期出现过「包里写着 1.2.0、About 面板写着 1.0、远端 tag 是 v1.1.0」
 * 三处各说各话，用户装完之后无法判断自己跑的是哪版。发版脚本只核 Info.plist 与参数，
 * 不核 package.json，所以缺口在中间这一段。这里补上，并由 `npm run verify` 调用。
 *
 * 退出码：0 = 一致；1 = 有不一致（信息打在 stderr）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const problems = [];
const notes = [];

// ── 1. package.json ──────────────────────────────────────────
let pkgVersion = null;
try {
  pkgVersion = JSON.parse(read('cal-mcp/package.json')).version ?? null;
} catch (err) {
  problems.push(`读不到 cal-mcp/package.json 的 version：${err.message}`);
}
if (pkgVersion && !/^\d+\.\d+\.\d+$/.test(pkgVersion)) {
  problems.push(`cal-mcp/package.json 的 version「${pkgVersion}」不是 x.y.z 形式`);
}

// ── 2. Info.plist ────────────────────────────────────────────
const plist = read('cal-app/Info.plist');
const pick = (key) => {
  const m = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return m ? m[1].trim() : null;
};
const plistVersion = pick('CFBundleShortVersionString');
const buildNumber = pick('CFBundleVersion');

if (!plistVersion) {
  problems.push('cal-app/Info.plist 里没有 CFBundleShortVersionString');
} else if (pkgVersion && plistVersion !== pkgVersion) {
  problems.push(
    `版本号不一致：cal-mcp/package.json 是 ${pkgVersion}，cal-app/Info.plist 是 ${plistVersion}`,
  );
}

if (!buildNumber) {
  problems.push('cal-app/Info.plist 里没有 CFBundleVersion');
} else if (!/^\d+$/.test(buildNumber)) {
  problems.push(`CFBundleVersion「${buildNumber}」必须是纯数字（App Store 与签名都要求）`);
} else {
  notes.push(`build ${buildNumber}`);
}

// ── 3. CHANGELOG 是否记了这一版 ──────────────────────────────
// 只提示不阻断：CHANGELOG 允许在发版前一刻补写。
if (pkgVersion) {
  let changelog = '';
  try {
    changelog = read('CHANGELOG.md');
  } catch {
    notes.push('没有 CHANGELOG.md');
  }
  if (changelog && !changelog.includes(pkgVersion)) {
    notes.push(`CHANGELOG.md 里还没出现 ${pkgVersion}（发版前记得补）`);
  }
}

// ── 输出 ─────────────────────────────────────────────────────
if (problems.length > 0) {
  console.error('✗ 版本号检查失败：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const suffix = notes.length > 0 ? `（${notes.join('；')}）` : '';
console.log(`✓ 版本号一致：${pkgVersion}${suffix}`);
