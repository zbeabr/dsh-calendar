/**
 * 模型层「属性测试」—— 只断言性质，不断言具体答案。
 *
 * 为什么单独一层：模型换版本 / 换量化 / 温度微调，具体标签可能变，
 * 把它的结果写死进断言或 parse-corpus 快照会让「只许追加」闸门天天被刷爆。
 * 这里只守一条永远该成立的性质：**模型的输出必须落在闭集里**。
 *
 * 本机没开模型 / ollama 没起时整体跳过并明确打印，不假装测过。
 * 确定性的闭集断言（59 条）在 calendar-policy-cases.mjs，永远跑、永不跳过。
 */
import { inferCalendarTag, llmConfig } from './src/llm.mjs';
import {
  AUTO_CANDIDATES, exactCalendarMatch, resolveCalendar,
} from './src/calendar-policy.mjs';

const KNOWN = ['学习', '生活', '家庭', '特别事件', '课表-数学'];
const CASES = [
  '明天晚上写作业',
  '下周三交高数论文',
  '明天下午在图书馆看第三章',
  '明天晚上吃火锅',
  '明天中午在宿舍里睡觉',
  '明天取快递',
  '明天下午打球',
  '明天三点开组会',
  '明天去体检',
  '随便干点啥',
  '明天晚上写作业#临时',
  '明天晚上写作业#学习@大学',
];

let passed = 0;
let failed = 0;

function check(label, ok) {
  if (ok) { passed += 1; return; }
  failed += 1;
  console.log(`✗ ${label}`);
}

const config = llmConfig();
if (!config.enabled) {
  console.log('⚠ 本地模型未启用（llm.enabled=false），属性测试跳过；确定性闭集断言见 calendar-policy-cases.mjs');
  process.exit(0);
}

// 先探一次：模型连不上就整体跳过，别让 12 句每句都等 6 秒超时。
const probe = await inferCalendarTag('明天晚上写作业', { known: KNOWN });
if (!probe) {
  console.log(`⚠ 本地模型不可用（${config.provider}/${config.model}），属性测试跳过；确定性闭集断言仍已跑过`);
  process.exit(0);
}

for (const text of CASES) {
  const result = await inferCalendarTag(text, { known: KNOWN });
  const tag = result?.tag;
  // 性质 ①：模型要么不给答案，要么给的一定是自动归属候选且确实在库里
  check(`模型输出落在闭集：${text}`,
    tag === undefined || (AUTO_CANDIDATES.includes(tag) && Boolean(exactCalendarMatch(tag, KNOWN))));
  // 性质 ②：无论模型说什么，决策层的最终输出都逃不出标签库
  const decision = resolveCalendar({ suggested: tag, known: KNOWN, fallback: '学习' });
  check(`决策层输出 ∈ 库：${text}`, decision.calendar === undefined || KNOWN.includes(decision.calendar));
  // 性质 ③：显式标签（哪怕库外）不许被模型顶替
  const explicit = resolveCalendar({ explicit: '临时', suggested: tag, known: KNOWN, fallback: '学习' });
  check(`显式标签不被模型顶替：${text}`, explicit.calendar === '学习');
}

console.log(`✓ ${passed}/${passed + failed} 条模型属性通过（${config.provider}/${config.model}，${CASES.length} 句）`);
if (failed) process.exitCode = 1;
