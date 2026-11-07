/**
 * 生成发行包里的 package.json：去掉只在源码仓库才有意义的 test* 脚本。
 *
 * 源码的 package.json 里 `npm test` 会跑 parse-cases.mjs / safety-cases.mjs /
 * caldav-cases.mjs / llm-guard-cases.mjs / parse-corpus.mjs，这些文件按设计不进发行包，
 * 直接拷过去会让包内 `npm test` 报「找不到模块」。改成一个能正常退出、并说明原因的脚本。
 *
 * build.sh（App 内嵌 engine）与 make-release.sh（发行目录 cal-mcp）都调用本文件，
 * 保证两份内容完全一致；make-release.sh 的逐字节校验也拿它生成期望值。
 *
 * 用法：node scripts/release-package-json.mjs <源 package.json> <目标 package.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('用法: node scripts/release-package-json.mjs <源 package.json> <目标 package.json>');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(src, 'utf8'));
const scripts = Object.fromEntries(
  Object.entries(pkg.scripts ?? {}).filter(([name]) => name !== 'test' && !name.startsWith('test:')),
);
scripts.test = 'node -e "console.log(\'发行包不含测试脚本；请在源码仓库跑 npm test\')"';
writeFileSync(dst, `${JSON.stringify({ ...pkg, scripts }, null, 2)}\n`);
