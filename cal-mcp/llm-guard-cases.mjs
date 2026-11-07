/**
 * 模型兜底的脱机断言用例。跑法：node llm-guard-cases.mjs（已纳入 npm test）
 *
 * 和 llm-cases.mjs 的分工：那份是「需要本地 ollama 的人工对照表」，逐句打印规则/模型各读成什么，
 * 不进 CI；这份锁的是复盘文档里那类静默事故——模型确实被调用了，却给出比规则更差的答案并被采纳。
 * 以前只有在本地模型真的在跑、还碰巧说了那句坏话时才能发现。
 *
 * 做法：临时把 globalThis.fetch 换成一条假回复（模型返回的 JSON 由用例给定），
 * 于是触发判断、护栏、质量闸全都能在无网络、无固定权重的机器上复现。
 * 时间仍由规则算，模型只出 title / location，所以假回复只要两个字段就够。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { llmLastError, needsRefine, refineWithModel } from './src/llm.mjs';

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

async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
  } catch (error) {
    failures.push(`${name}：${error.message}`);
  }
}

function expect(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label ?? ''} 期望 ${expected}，实际 ${actual}`);
}

/** 把模型这一层换成一句假回复；其余链路（配置、超时、JSON 解析、护栏）都照常跑。 */
async function withModelAnswer(answer, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ message: { content: JSON.stringify(answer) } }),
  });
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const TEXT = '下下周三中午吃个半小时的张亮麻辣烫';
const DIRTY = { title: '吃个的张亮麻辣烫', location: undefined, local: '11/18周三 12:00–12:30' };

// ── 1. 触发：规则不能单方面宣布自己「已经干净」 ──────────────────
check('悬空的「个的」残渣要让模型再兜一次', () => {
  expect(needsRefine(TEXT, DIRTY), true, 'needsRefine');
});
check('已经干净的标题不该再白调一次模型', () => {
  expect(needsRefine(TEXT, { title: '吃张亮麻辣烫', location: undefined }), false, 'needsRefine');
});
check('「吃点好的」是正常标题，不是残渣', () => {
  expect(needsRefine('今天中午吃点好的', { title: '吃点好的', location: undefined }), false, 'needsRefine');
});
check('「我的生日」是正常标题，不是残渣', () => {
  expect(needsRefine('明天我的生日', { title: '我的生日', location: undefined }), false, 'needsRefine');
});
check('句里有介词却没解析出地点，仍然要问模型', () => {
  expect(needsRefine('明天在医院复查', { title: '复查', location: undefined }), true, 'needsRefine');
});

// ── 2. 护栏：动词和宾语之间隔了量词/助词，也不能把宾语搬去当地点 ──
await checkAsync('模型把店名切成地点、标题只剩「吃个的」时整条拒绝', async () => {
  const result = await withModelAnswer({ title: '吃个的', location: '张亮麻辣烫' }, () =>
    refineWithModel(TEXT, DIRTY, { force: true }));
  expect(result, undefined, '兜底结果');
});

await checkAsync('换一家店、动词后仍隔了「个的」，护栏照样要拦', async () => {
  const text = '明天中午吃个半小时的汉堡王';
  const result = await withModelAnswer({ title: '吃个的', location: '汉堡王' }, () =>
    refineWithModel(text, { title: '吃个的汉堡王', location: undefined, local: '11/08周日 12:00–12:30' }, { force: true }));
  expect(result, undefined, '兜底结果');
});

// ── 3. 兜底真的要能修好脏标题，而不只是「不出错」 ─────────────────
await checkAsync('规则标题有残渣时，模型给的干净标题要被采纳', async () => {
  const result = await withModelAnswer({ title: '吃张亮麻辣烫', location: null }, () =>
    refineWithModel(TEXT, DIRTY, { force: true }));
  expect(result?.title, '吃张亮麻辣烫', '修好后的标题');
  expect(result?.location ?? null, null, '地点');
});

// ── 4. 质量闸：模型只把标题砍短、没带来任何新信息，不许盖掉规则答案 ──
await checkAsync('模型只截短标题又没补地点时拒绝', async () => {
  const text = '明天下午三点在星巴克跟老王聊一下那个项目的事情';
  const result = await withModelAnswer({ title: '跟老王', location: null }, () =>
    refineWithModel(text, { title: '跟老王聊一下那个项目的事情', location: undefined, local: '11/08周日 15:00–16:00' }, { force: true }));
  expect(result, undefined, '兜底结果');
});

// ── 5. 拒绝不再静默 ──────────────────────────────────────────────
await checkAsync('拒绝原因要落到 llmLastError，不再是静默失败', async () => {
  llmLastError.message = undefined;
  await withModelAnswer({ title: '吃个的', location: '张亮麻辣烫' }, () =>
    refineWithModel(TEXT, DIRTY, { force: true }));
  if (!String(llmLastError.message ?? '').includes('宾语')) {
    throw new Error(`期望记录「宾语」相关拒绝原因，实际 ${llmLastError.message ?? '空'}`);
  }
});

// ── 6. 保护：正常补地点的路径不能被新护栏误杀 ──────────────────────
await checkAsync('「在星巴克」确实是地点，模型补出来要采纳', async () => {
  const text = '明天下午三点在星巴克跟老王聊项目';
  const result = await withModelAnswer({ title: null, location: '星巴克' }, () =>
    refineWithModel(text, { title: '跟老王聊项目', location: undefined, local: '11/08周日 15:00–16:00' }, { force: true }));
  expect(result?.location, '星巴克', '模型补出的地点');
});

await checkAsync('规则标题里含地点但原句有「在」时，也不算动词宾语', async () => {
  const text = '明天下午三点在图书馆看书';
  const result = await withModelAnswer({ title: '看书', location: '图书馆' }, () =>
    refineWithModel(text, { title: '在图书馆看书', location: undefined, local: '11/08周日 15:00–16:00' }, { force: true }));
  expect(result?.location, '图书馆', '地点');
  expect(result?.title, '看书', '标题');
});

await checkAsync('「去食堂吃麻辣烫」里食堂是地点，不被宾语护栏误拒', async () => {
  const text = '晚上去食堂吃麻辣烫';
  const result = await withModelAnswer({ title: null, location: '食堂' }, () =>
    refineWithModel(text, { title: '吃麻辣烫', location: undefined, local: '11/07周六 20:00–21:00' }, { force: true }));
  expect(result?.location, '食堂', '地点');
});

// ── 7. CLI：干净标题不该因为「没写地点」而报 needsModel ─────────────
check('干净的一句话不再因为缺地点而白白触发模型', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-llmguard-'));
  try {
    const res = spawnSync(process.execPath, ['cli.mjs', 'parse', '明天下午三点开会', '--fast', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
    expect(res.status, 0, '子进程退出码');
    const payload = JSON.parse(res.stdout.trim());
    expect(payload.needsModel, false, 'needsModel');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 8. 深度分析补漏：上一轮修复引入的四个边界问题 ──────────────────
check('「这个的/整个的」是所有格，不是残渣，不该触发模型', () => {
  expect(needsRefine('明天下午三点看这个的设计稿', { title: '看这个的设计稿', location: undefined }), false, 'needsRefine');
});

await checkAsync('模型给的所有格标题要被采纳，不能被残渣判据误拒', async () => {
  const text = '明天下午三点在图书馆看这个的设计稿';
  const result = await withModelAnswer({ title: '看这个的设计稿', location: '图书馆' }, () =>
    refineWithModel(text, { title: '在图书馆看这个的设计稿', location: undefined, local: '11/08周日 15:00–16:00' }, { force: true }));
  expect(result?.title, '看这个的设计稿', '修好后的标题');
  expect(result?.location, '图书馆', '地点');
});

await checkAsync('规则已有地点时，模型只截短标题也要整条拒绝', async () => {
  const text = '明天下午三点在星巴克跟老王聊一下那个项目的事情';
  const result = await withModelAnswer({ title: '跟老王', location: null }, () =>
    refineWithModel(text, { title: '跟老王聊一下那个项目的事情', location: '星巴克', local: '11/08周日 15:00–16:00' }, { force: true }));
  expect(result, undefined, '兜底结果');
});

await checkAsync('无介词的真实地点「校医院」，模型补出来要采纳', async () => {
  const text = '明天上午十点体检 校医院';
  const result = await withModelAnswer({ title: '体检', location: '校医院' }, () =>
    refineWithModel(text, { title: '体检校医院', location: undefined, local: '11/08周日 10:00–11:00' }, { force: true }));
  expect(result?.location, '校医院', '地点');
});

await checkAsync('无介词的真实地点「食堂」，模型补出来要采纳', async () => {
  const text = '明天 食堂 聚餐';
  const result = await withModelAnswer({ title: '聚餐', location: '食堂' }, () =>
    refineWithModel(text, { title: '食堂聚餐', location: undefined, local: '11/08周日 00:00–00:00' }, { force: true }));
  expect(result?.location, '食堂', '地点');
});

check('「14:00 到 16:00」是时间区间，不是介词短语', () => {
  expect(needsRefine('下周三 14:00 到 16:00 培训', { title: '培训', location: undefined }), false, 'needsRefine');
});

// ── 汇总 ─────────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`✓ ${pass} 条模型兜底用例全部通过`);
} else {
  console.log(`✗ ${pass} 条通过，${failures.length} 条失败：`);
  for (const line of failures) console.log(`  ✗ ${line}`);
  process.exitCode = 1;
}
