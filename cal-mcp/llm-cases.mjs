/**
 * 模型兜底的人工检查表（需要本地 ollama 在跑：`ollama serve` + `dsh-cal llm --warm`）。
 *
 * 跑法：node llm-cases.mjs
 * 作用：逐句打印「规则读成什么 / 模型读成什么」，用来判断模型到底有没有兜住。
 * 和 parse-cases.mjs 的区别：那个是纯规则的断言回归（不需要模型），这个是看模型表现的对照。
 */
import { parseEvent } from './src/nlp.mjs';
import { needsRefine, refineWithModel } from './src/llm.mjs';

const NOW = new Date('2026-11-05T12:30:00+08:00');
const CASES = [
  '中午我想要十二点半到十三点洗个澡，在澡堂',
  '明天下午三点在星巴克跟老王聊一下那个项目的事情',
  '下午我得去趟三教201交个作业',
  '晚上八点在宿舍楼下拿快递',
  '周五中午跟导师在食堂吃个饭',
  '明早八点到八点四十在华东理工大学图书馆学高数',
  '半小时后提醒我喝水',
  '明天下午三点到四点开会',
  // 模型容易把「吃什么」的宾语当地点：标题只剩一个「吃」
  '明天中午吃半个小时杨国福麻辣烫#生活',
  '明天中午喝星巴克',
  // 反过来，真正的地点（没有「在」也要认）不能被误伤
  '明天上午十点体检 校医院',
];

for (const text of CASES) {
  let p;
  try {
    p = parseEvent(text, NOW);
  } catch (error) {
    console.log(`\n【${text}】\n规则 → 解析不了：${error.message}`);
    continue;
  }
  // 跟生产保持一致：现在只由 needsRefine 决定（脏标题 / 量词残渣 / 残留时间词 /
  // 有介词却没认出地点）。「没写地点」本身不再触发模型，否则每句话都白调一次。
  const need = needsRefine(text, p);
  const stamp = `${p.start.getMonth() + 1}/${p.start.getDate()} ${p.start.toTimeString().slice(0, 5)}`;
  let line = `规则 → 「${p.title}」 @${p.location ?? '无'}  ${stamp}`;
  if (need) {
    const r = await refineWithModel(text, { title: p.title, location: p.location, local: stamp }, { force: true });
    line += r
      ? `\n模型 → 「${r.title ?? p.title}」 @${r.location ?? '无'}`
      : '\n模型 → 没兜住（回落规则）';
  } else {
    line += '\n模型 → 未触发（规则已干净）';
  }
  console.log(`\n【${text}】\n${line}`);
}
