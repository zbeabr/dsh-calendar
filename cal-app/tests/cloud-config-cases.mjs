// 云端 API 图形配置入口回归。跑法：node cal-app/tests/cloud-config-cases.mjs
//
// 用户 2026-11-15：「你说现在可以配置云端 api，但是我没看到配置入口啊」。
// 排查结论：配置只存在于终端 `dsh-cal llm --setup --key -`，App 的「设置…」里
// 只有一个「标签识别」开关和一行状态文字，没有端点 / 模型 / 密钥的输入框。
// 用户选择「补图形入口」，于是旧规格「设置页不碰密钥」升级为：
//   密钥可以输入，但**只能经 stdin 管道**交给 `llm --key -` 进钥匙串 ——
//   不进 argv、不回显、不回填、不落盘、不写日志。
//
// 这里锁的就是这条边界，以及配置区真的挂进了设置页。纯静态契约，不碰用户配置。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const root = join(HERE, '..', '..');
const app = readFileSync(join(root, 'cal-app', 'App.swift'), 'utf8');
const cli = readFileSync(join(root, 'cal-mcp', 'cli.mjs'), 'utf8');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, detail: error.message.split('\n')[0] }); }
}

/** 取一个 Swift 函数的函数体。函数结尾的 `}` 缩进 4 空格，内部嵌套缩进更深。 */
function bodyOf(signature) {
  const start = app.indexOf(signature);
  if (start < 0) return '';
  const end = app.indexOf('\n    }', start);
  return end < 0 ? app.slice(start) : app.slice(start, end);
}

// ── A. 入口真的存在，且只出现在「设置…」页 ──────────────────────────
check('设置页有云端 API 配置区：端点 / 模型 / 密钥 + 三个动作', () => {
  assert.match(app, /func buildCloudSection/u);
  assert.match(app, /cloudBaseField/u);
  assert.match(app, /cloudModelField/u);
  assert.match(app, /cloudKeyField/u);
  assert.match(app, /NSSecureTextField/u, '密钥框必须是安全输入框，不能明文回显');
  assert.match(app, /saveCloudSettings/u);
  assert.match(app, /clearCloudKey/u);
  assert.match(app, /useLocalOllama/u);
});

check('配置区只在「设置…」页出现，首次连接页不受影响', () => {
  assert.match(app, /if showsAppearance \{\s*buildCloudSection\(in: root\)/u,
    '配置区必须挂在 showsAppearance 分支里，不能塞进首次连接页');
});

// ── B. 密钥的四条边界 ──────────────────────────────────────────────
check('端点 / 模型从 --status 预填，密钥框永不回填', () => {
  const body = bodyOf('func refreshModelStatus');
  assert.match(body, /cloudBaseField\?\.stringValue/u);
  assert.match(body, /cloudModelField\?\.stringValue/u);
  assert.ok(!/cloudKeyField\?\.stringValue\s*=/u.test(body),
    '状态刷新时不许把已存的密钥填回输入框');
  assert.match(body, /cloudKeyField\?\.placeholderString/u,
    '只能改占位符来提示「已存钥匙串」');
});

check('密钥只以 --key - 出现，且只经 stdin 传入后端', () => {
  const save = bodyOf('func saveCloudSettings');
  assert.match(save, /"--key", "-"/u, '保存时要用 --key - 走 stdin');
  assert.match(save, /Engine\.call\(args, stdin:/u, '没有把 stdin 接上 Engine.call');
  // 全文件里每一处 "--key" 后面都必须紧跟 "-"：不许把明文密钥拼进 argv。
  const uses = [...app.matchAll(/"--key",\s*([^\]\n]*)/gu)];
  assert.ok(uses.length > 0, '找不到 --key 用法');
  for (const m of uses) {
    assert.match(m[1], /^"-"/u, `出现了把值拼进 argv 的 --key：${m[1].slice(0, 40)}`);
  }
  assert.ok(!/args\.append\("--key"\)|"--key", key|"--key", secret/u.test(save),
    '密钥被拼进了子进程参数');
});

check('Engine 有 stdin 通道，写完立即关闭，且不写进调试日志', () => {
  assert.match(app, /stdin: String\? = nil/u);
  assert.match(app, /standardInput = inPipe/u);
  assert.match(app, /inPipe\.fileHandleForWriting\.closeFile\(\)/u,
    '不关管道的话 Node 的 readline 会一直等 EOF');
  const sync = bodyOf('static func callSync');
  assert.match(sync, /Data\(\(text \+ "\\n"\)\.utf8\)/u, 'stdin 要写成一行文本');
  const runLine = sync.split('\n').filter((line) => line.includes('RUN ')).join('\n');
  assert.ok(!/stdin|text/u.test(runLine), '调试日志里出现了 stdin 内容');
});

check('保存成功后立刻清空密钥框', () => {
  assert.match(bodyOf('func saveCloudSettings'), /cloudKeyField\?\.stringValue = ""/u);
});

check('缺密钥时提示指向上面的输入框，不再把用户打发去终端', () => {
  const status = bodyOf('func refreshModelStatus');
  assert.ok(!/终端跑|--key -（隐藏输入）/u.test(status),
    '状态行还在叫用户去终端配密钥，与刚加的图形入口矛盾');
  assert.match(status, /云端还缺密钥/u);
  const save = bodyOf('func saveCloudSettings');
  assert.match(save, /hasKey/u,
    '保存回调要看后端报的 hasKey，不能没密钥也一律说「已保存」');
});

check('清除密钥 / 切回本地都走 CLI，且不带任何密钥', () => {
  const clear = bodyOf('func clearCloudKey');
  assert.match(clear, /"llm", "--clear-key", "--json"/u);
  assert.ok(!/--key/u.test(clear));
  const local = bodyOf('func useLocalOllama');
  assert.match(local, /"--provider", "ollama"/u);
  assert.ok(!/--key/u.test(local));
});

// ── C. 后端仍守住老规格 ────────────────────────────────────────────
check('后端 --key - 仍从 stdin 读，密钥只进钥匙串', () => {
  assert.match(cli, /flags\.key === '-'/u);
  assert.match(cli, /readLlmKeyFromStdin/u);
  assert.match(cli, /saveLlmApiKey\(key\)/u);
  assert.match(cli, /writeLlmConfig\(next\)/u);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `  ← ${r.detail}`}`);
  if (!r.ok) failed += 1;
}
console.log(`${results.length - failed}/${results.length} 通过${failed ? `，${failed} 条失败` : ''}`);
process.exit(failed ? 1 : 0);
