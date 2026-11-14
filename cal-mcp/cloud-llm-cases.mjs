// 云端模型配置回归。跑法：node cloud-llm-cases.mjs
//
// 背景：src/llm.mjs 早就支持 openai-compatible provider（callOpenAI 已实现），
// 但 dsh-cal llm 只有 --on/--off/--warm，没有设置 provider/baseUrl/model/apiKey
// 的入口；而且 apiKey 明文存在 ~/.config/dsh-cal/config.json 里。
// 结果就是「没装本地模型的人」想用云端，只能手改配置文件、还得把密钥写成明文。
//
// 本用例覆盖：配置入口、密钥不落盘、假云端能真的给出标签、闭集与失败回落不变。
process.env.TZ = 'Asia/Shanghai';

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const llm = readFileSync(join(HERE, 'src', 'llm.mjs'), 'utf8');
const store = readFileSync(join(HERE, 'src', 'store.mjs'), 'utf8');
const cli = readFileSync(join(HERE, 'cli.mjs'), 'utf8');
const policy = readFileSync(join(HERE, 'src', 'calendar-policy.mjs'), 'utf8');
const app = readFileSync(join(HERE, '..', 'cal-app', 'App.swift'), 'utf8');

const results = [];
async function check(name, fn) {
  try {
    // await 而不是同步调用：运行时用例要真的等 inferCalendarTag 回来，
    // 否则断言失败会变成 rejected Promise 被静默吞掉（假通过）。
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message.split('\n')[0] });
  }
}

// ── A. 保住已有能力：云端分支与闭集约束都不许被改坏 ──────────────────
await check('callOpenAI 云端分支仍在', () => {
  assert.match(llm, /async function callOpenAI/u);
  assert.match(llm, /authorization: `Bearer /u);
});
await check('inferCalendarTag 仍支持非 ollama provider', () => {
  assert.match(llm, /config\.provider !== 'ollama'/u);
});
await check('闭集投影仍在（输出只能是库内名字）', () => {
  assert.match(policy, /export function projectModelTag/u);
  assert.match(llm, /projectModelTag\(parsed\.tag/u);
});

// ── B. 配置入口（旧代码完全没有） ────────────────────────────────────
await check('CLI 有 --setup 配置入口', () => {
  assert.match(cli, /flags\.setup/u);
});
await check('CLI 能设 provider / base-url / model', () => {
  assert.match(cli, /flags\.provider/u);
  assert.match(cli, /flags\['base-url'\]/u);
  assert.match(cli, /flags\.model/u);
});
await check('CLI 能写入 / 清除密钥', () => {
  assert.match(cli, /flags\.key|flags\['key'\]/u);
  assert.match(cli, /flags\['clear-key'\]/u);
});

// ── C. 密钥安全（旧代码明文落盘） ────────────────────────────────────
await check('store 提供 LLM 密钥的读写删', () => {
  assert.match(store, /export function readLlmApiKey/u);
  assert.match(store, /export function saveLlmApiKey/u);
  assert.match(store, /export function deleteLlmApiKey/u);
});
await check('llmConfig 从钥匙串读密钥，不再直接吃 config.json', () => {
  assert.match(llm, /readLlmApiKey\(/u);
});
await check('llmConfig 支持 headless 环境变量兜底', () => {
  assert.match(store, /DSH_CAL_LLM_KEY/u);
});
await check('写/删密钥会同步更新进程内缓存，不会读到旧值', () => {
  // cmdLlm 开头 llmConfig() 已经把旧密钥读进缓存；--setup --key 写完新密钥，
  // 同一进程再读必须拿到新值，否则界面会误报「还缺密钥」。
  assert.match(store, /cachedLlmKey = value/u);
  assert.match(store, /cachedLlmKey = ''/u);
});
await check('CLI 支持隐藏输入密钥，不必写进 shell history', () => {
  assert.match(cli, /readLlmKeyFromStdin/u);
  assert.match(cli, /flags\.key === '-'/u);
  assert.match(cli, /hidden: true/u);
});
await check('CLI 有轻量 --status，不发网络探测', () => {
  assert.match(cli, /flags\.status/u);
  const block = cli.slice(cli.indexOf('if (flags.status)'), cli.indexOf('if (flags.warm)'));
  assert.ok(block.length > 0, '找不到 status 分支');
  assert.ok(!/probeModel\(/u.test(block), 'status 分支不该调用 probeModel');
});
await check('设置页有标签识别开关且只读状态不碰密钥', () => {
  assert.match(app, /settingsModelChanged/u);
  assert.match(app, /"llm", "--status", "--json"/u);
  assert.ok(!/saveLlmApiKey|"--key"/u.test(app), '设置页不该出现密钥写入或 --key 参数');
});
await check('设置页开关会同步到 --status 的真实值', () => {
  // 自检快照实测：强制设置页路径没跑 refreshConfig，开关按内存旧值画成「关」，
  // 而 CLI 报 enabled=true。现在刷新状态时必须把开关也拨过来。
  assert.match(app, /modelToggle\?\.on = enabled/u);
});

// ── D. 运行时：临时 HOME + 假云端，全程不碰用户真实配置与钥匙串 ──────
const KEY = 'sk-cloud-probe-0123456789';
const llmUrl = pathToFileURL(join(HERE, 'src', 'llm.mjs')).href;

function makeHome(config) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cloud-'));
  const dir = join(home, '.config', 'dsh-cal');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
  return { home, cfg: join(dir, 'config.json') };
}
// 假云端必须跟 inferCalendarTag 跑在**同一个进程**：沙箱会掐掉子进程发往
// 父进程本地服务的 fetch（实测 "This operation was aborted"、服务端一次没收到）。
// store.mjs 在模块加载时用 homedir() 固定 CONFIG_PATH，所以先改 HOME，
// 再用带 query 的动态 import 让它重新求值，读临时配置而不是用户真实配置。
let seen = [];
let replyTag = '学习';
let failNext = false;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    seen.push({ auth: req.headers.authorization, body: JSON.parse(raw || '{}') });
    if (failNext) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('probe-down');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tag: replyTag }) } }] }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const main = makeHome({ llm: {
  enabled: true, provider: 'openai', model: 'probe-model',
  baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 3000,
} });
process.env.HOME = main.home;
process.env.DSH_CAL_LLM_KEY = KEY;
const { inferCalendarTag } = await import(`${llmUrl}?cloud-cases=1`);
const { resolveCalendar } = await import(`${pathToFileURL(join(HERE, 'src', 'calendar-policy.mjs')).href}?cloud-cases=1`);

await check('假云端：环境变量注入密钥就能拿到标签', async () => {
  const r = await inferCalendarTag('明天晚上写作业', { known: ['学习', '生活'] });
  assert.equal(r?.tag, '学习', `实际 ${JSON.stringify(r ?? null)}`);
  assert.equal(r?.source, 'model');
});
await check('假云端：Authorization 带上了注入的密钥', () => {
  assert.ok(seen.length > 0, '云端没收到请求');
  assert.equal(seen.at(-1).auth, `Bearer ${KEY}`);
});
await check('假云端：模型吐库外标签时闭集挡住', async () => {
  replyTag = '饮食';
  try {
    const r = await inferCalendarTag('明天晚上写作业', { known: ['学习', '生活'] });
    assert.equal(r, undefined, `库外标签必须被丢弃，实际 ${JSON.stringify(r ?? null)}`);
  } finally { replyTag = '学习'; }
});
await check('云端标签经闭集决策层真的落到库内日历', async () => {
  // 只验「模型能回一个 tag」还不够：没装本地模型的人最终要的是「这句话写进学习」。
  const r = await inferCalendarTag('明天晚上写作业', { known: ['学习', '生活'] });
  const d = resolveCalendar({
    explicit: undefined, suggested: r?.tag, known: ['学习', '生活'], fallback: undefined,
  });
  assert.equal(d.calendar, '学习', `实际 ${JSON.stringify(d)}`);
  assert.equal(d.source, 'model');
});
await check('云端报错时安静返回 undefined，不抛错', async () => {
  failNext = true;
  try {
    const r = await inferCalendarTag('明天晚上写作业', { known: ['学习', '生活'] });
    assert.equal(r, undefined);
    const d = resolveCalendar({
      explicit: undefined, suggested: r?.tag, known: ['学习', '生活'], fallback: undefined,
    });
    assert.equal(d.calendar, undefined, '失败时不该猜一个标签出来');
  } finally { failNext = false; }
});

await check('--setup 会清掉旧配置里遗留的明文密钥，且不再写回', () => {
  // 模拟老用户：config.json 里原本明文存着 apiKey。
  const legacy = { llm: {
    enabled: true, provider: 'openai', model: 'probe-model',
    baseUrl: 'http://127.0.0.1:1', timeoutMs: 3000, apiKey: KEY,
  } };
  const { home, cfg } = makeHome(legacy);
  execFileSync(process.execPath, [
    'cli.mjs', 'llm', '--setup', '--provider', 'openai',
    '--base-url', 'http://127.0.0.1:1234', '--model', 'probe-model', '--json',
  ], {
    cwd: HERE, encoding: 'utf8',
    env: { ...process.env, HOME: home, DSH_CAL_LLM_KEY: KEY, TZ: 'Asia/Shanghai' },
    timeout: 15000,
  });
  const raw = readFileSync(cfg, 'utf8');
  assert.ok(!raw.includes(KEY), 'config.json 里出现了明文密钥');
  const parsed = JSON.parse(raw);
  assert.ok(!parsed.llm?.apiKey, `config.json 仍带 apiKey 字段：${JSON.stringify(parsed.llm)}`);
  assert.equal(parsed.llm?.provider, 'openai');
  assert.equal(parsed.llm?.baseUrl, 'http://127.0.0.1:1234');
});

// 端到端验隐藏输入：用 PATH 前置的假 `security` 顶替钥匙串，
// 绝不写用户的真实钥匙串（项目红线：测试不许碰用户凭据）。
await check('--key - 隐藏输入端到端：密钥只进钥匙串、不进 config.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-keyprobe-'));
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  const kc = join(dir, 'kc.log');
  mkdirSync(join(home, '.config', 'dsh-cal'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  const fake = join(bin, 'security');
  writeFileSync(fake, `#!/bin/sh
LOG="$DSH_FAKE_KC_LOG"
case "$1" in
  add-generic-password)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-w" ]; then shift; printf '%s' "$1" > "$LOG"; break; fi
      shift
    done
    exit 0 ;;
  find-generic-password) [ -f "$LOG" ] && cat "$LOG"; exit 0 ;;
  delete-generic-password) : > "$LOG"; exit 0 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  chmodSync(fake, 0o755);
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    DSH_FAKE_KC_LOG: kc,
    // 必须清掉上面运行时段注入的环境变量，否则它会盖过假钥匙串，
    // 让「密钥确实进了钥匙串」变成假通过。
    DSH_CAL_LLM_KEY: '',
    TZ: 'Asia/Shanghai',
  };
  const key = 'sk-hidden-probe-9876';
  const run = (args, input) => execFileSync(process.execPath, ['cli.mjs', ...args], {
    cwd: HERE, encoding: 'utf8', env, input, timeout: 15000,
  }).trim().split('\n').at(-1);

  const setup = JSON.parse(run([
    'llm', '--setup', '--provider', 'openai', '--base-url', 'http://127.0.0.1:1234',
    '--model', 'probe-model', '--key', '-', '--json',
  ], `${key}\n`));
  assert.equal(setup.ok, true, JSON.stringify(setup));
  assert.equal(setup.hasKey, true, '同一次 --setup 里读到了缓存的旧密钥');
  assert.equal(readFileSync(kc, 'utf8'), key, '密钥没写进钥匙串');

  const cfgPath = join(home, '.config', 'dsh-cal', 'config.json');
  const raw = readFileSync(cfgPath, 'utf8');
  assert.ok(!raw.includes(key), 'config.json 里出现了明文密钥');
  assert.equal(JSON.parse(raw).llm?.apiKey, undefined);

  // 换一个新进程读：证明密钥是从钥匙串取回的，不是只在同进程缓存里。
  const status = JSON.parse(run(['llm', '--status', '--json'], ''));
  assert.equal(status.hasKey, true, '新进程读不到钥匙串里的密钥');
  assert.equal(status.provider, 'openai');
});

await new Promise((resolve) => server.close(resolve));

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `  ← ${r.detail}`}`);
  if (!r.ok) failed += 1;
}
console.log(`${results.length - failed}/${results.length} 通过${failed ? `，${failed} 条失败` : ''}`);
process.exit(failed ? 1 : 0);
