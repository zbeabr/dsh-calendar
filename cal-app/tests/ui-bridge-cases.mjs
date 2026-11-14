// 三项 UI 功能的「接线」契约：纯读源码文本，验证数据层 → 原生桥接 → 网页控件
// 真的连起来了，避免只改了半边（例如网页有按钮、Swift 没有对应 case）。
// 跑法：node cal-app/tests/ui-bridge-cases.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const swift = readFileSync(join(root, 'cal-app', 'App.swift'), 'utf8');
const html = readFileSync(join(root, 'cal-app', 'web', 'skeuo.html'), 'utf8');
const cli = readFileSync(join(root, 'cal-mcp', 'cli.mjs'), 'utf8');
const tools = readFileSync(join(root, 'cal-mcp', 'src', 'tools.mjs'), 'utf8');

const results = [];
function check(name, ok, why) {
  results.push({ name, ok, why });
}

// ① 过去日程小盒子的数据来源
check('CLI 有 past 命令能取过去的日程', /case 'past'/u.test(cli), '小盒子没有数据源');
check('推送给网页的状态里带 past', /"past"/u.test(swift), 'state 里没有过去日程');
check('网页的 dshRender 消费 state.past', /state\.past/u.test(html), '数据到了网页没人接');
check('网页里有小盒子 DOM', /id="memoryBox"/u.test(html), '没有可点开的盒子');

// ② 界面编辑 + 只删/只改这一次
check('原生桥接有 update 分支', /case "update":/u.test(swift), '编辑卡保存后没人处理');
check('删除分支把 scope 传下去', /--scope/u.test(swift) && /"scope"/u.test(swift), '二选一按钮形同虚设');
check('网页有编辑卡 DOM', /id="editCard"/u.test(html), '点木板没地方改');
check('删除确认有单次/系列二选一', /data-scope/u.test(html), '没有「只删这一次」的入口');
check('日程列表带 recurring 标记', /recurring/u.test(tools) && /recurring/u.test(swift),
  '非重复日程不该出现「只删这一次」');
const pushBlock = swift.slice(swift.indexOf('private func pushSkeuoState()'),
  swift.indexOf('// MARK: JS → 原生'));
check('推送给网页的日程带完整字段',
  /"title"/u.test(pushBlock) && /"start"/u.test(pushBlock) && /"location"/u.test(pushBlock),
  '编辑卡填不回原值');

// ③ 离线队列状态
check('设置页读取待同步数量', /pendingText/u.test(swift), '看不到小本本');
check('设置页有立即补发按钮', /syncPendingTapped/u.test(swift), '看到也补发不了');

// 防回归：木板保持不透明（所有者 2026-11-13 拍板）
check(' liquid 模式没有把木板改成半透明',
  !/html\.liquid-bg[^{]*\.plank\s*\{[^}]*opacity/u.test(html), '木板必须不透明');

let failed = 0;
console.log(`UI 接线契约 ${results.length} 条`);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `  ← ${r.why}`}`);
  if (!r.ok) failed += 1;
}
console.log(`${results.length - failed}/${results.length} 通过${failed ? `，${failed} 条失败` : ''}`);
process.exit(failed ? 1 : 0);
